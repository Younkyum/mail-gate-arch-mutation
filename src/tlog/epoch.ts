/**
 * src/tlog/epoch.ts — **에폭 마감**(ADR-0008 §2.1·§2.4) — 매시 정각 경계(Q4).
 *
 *   모든 조직 로그의 헤드(tree_size, root) → 에폭 트리(잎 = JCS({log, size, root}), org_log_id 순) → epoch_root
 *   → 전역 공개 로그에 잎 하나 `{v, kind: "epoch", epoch, closed_at, epoch_root}` → C2SP 체크포인트 → KMS Ed25519 서명.
 *
 * 두 가지를 **서명 전에** 스스로 본다(`planEpoch` — 순수 함수, 단위·arch 테스트가 직접 부른다):
 *   ① 완전성 — 헤드 수 = 로그 수, 로그마다 정확히 하나. **바뀐 조직만 담지 않는다**(빠짐 자체가 증거 — 변이 `M-epoch-skips-unchanged-org`).
 *      DB 도 커밋 때 같은 것을 본다(지연 제약 트리거 `tlog_epochs_complete`).
 *   ② 일관성 — 새 전역 루트가 직전 체크포인트와 RFC 9162 일관성 증명으로 이어진다. 조직 헤드도 직전 헤드와 이어진다.
 *      되감긴 역사에는 **서명하지 않는다**(변이 `N-inconsistent-checkpoint-signed`).
 *   ③ 게시 수위(high-water) — **공개 버킷의 `log/checkpoint`**(이미 세상에 나간 최신 체크포인트)를 읽어, 새 트리가 그 크기 이상이고 그 루트와
 *      이어지는지 본다(DB 의 잎 해시로 다시 계산). DB 만 보면 RDS PITR·다른 DB 연결 사고 뒤 **이미 게시한 크기의 분기**에 KMS 키가 서명한다 —
 *      DB 가 게시본보다 뒤면 `published_rollback`, 이어지지 않으면 `published_inconsistent` 로 멈춘다(런북 §7.1 복구 절차).
 * 받은 서명은 공개키로 한 번 더 검증한 뒤에 저장한다(KMS 가 다른 키로 서명한 사고가 공개되지 않게).
 */

import type { Pool, PoolClient } from 'pg';

import { withTransaction } from '../db/client';
import { checkpointBody, keyIdOf, openCheckpoint, signedNote, verifyEd25519, vkeyOf } from './checkpoint';
import { TLOG_ORIGIN } from './constants';
import { epochTreeLeaf, globalEpochLeaf } from './leaf';
import { consistencyProof, leafHash, rootOf, verifyConsistency } from './merkle';
import type { TlogPublishedReader } from './publisher';
import { TLOG_ADVISORY_LOCK } from './sequencer';
import type { NoteSigner } from './signing';
import { instantOf } from './time';

export class EpochIntegrityError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'EpochIntegrityError';
    this.code = code;
  }
}

export interface OrgHead {
  /** org_log_id hex32. */
  readonly log: string;
  readonly size: number;
  readonly root: Buffer;
}

export interface EpochPlanInput {
  readonly epoch: number;
  /** 마감 시각(잎의 시각 모양). */
  readonly closedAt: string;
  /** 지금 존재하는 모든 조직 로그(hex32). */
  readonly logs: readonly string[];
  /** 이번 에폭의 헤드. */
  readonly heads: readonly OrgHead[];
  /** 직전 에폭의 헤드(없으면 빈 목록). */
  readonly previousHeads: readonly OrgHead[];
  /** 지금까지의 전역 잎 해시(에폭 0..epoch-1). */
  readonly globalLeafHashes: readonly Buffer[];
  /** 직전 체크포인트의 루트(첫 에폭이면 null). */
  readonly previousRoot: Buffer | null;
  /** 조직 로그의 잎 해시 — 헤드가 바뀐 로그만 필요하다(일관성 확인용). */
  readonly leafHashesOf: (log: string) => readonly Buffer[] | undefined;
  /** 체크포인트 origin(= 서명 키 이름). 기본 `TLOG_ORIGIN`. */
  readonly origin?: string;
  /** 공개 버킷에 이미 게시된 최신 체크포인트(서명 확인 뒤) — 없으면 null. 새 트리는 이 크기 이상이고 이 루트와 이어져야 한다. */
  readonly published?: PublishedHead | null;
}

/** 이미 게시된(세상에 나간) 체크포인트의 크기·루트. */
export interface PublishedHead {
  readonly size: number;
  readonly root: Buffer;
}

export interface EpochPlan {
  readonly heads: readonly OrgHead[];
  readonly epochRoot: Buffer;
  readonly globalLeaf: string;
  readonly globalLeafHash: Buffer;
  readonly globalRoot: Buffer;
  readonly treeSize: number;
  readonly checkpointText: string;
}

/** 로그 id → 헤드. 같은 로그가 둘이면 첫 항목(배열 `find` 와 같은 결과). */
function firstByLog<T extends { readonly log: string }>(heads: readonly T[]): Map<string, T> {
  const byLog = new Map<string, T>();
  for (const head of heads) if (!byLog.has(head.log)) byLog.set(head.log, head);
  return byLog;
}

/** 서명 전 계획 — 완전성 · 일관성을 여기서 본다. 순수 함수. */
export function planEpoch(input: EpochPlanInput): EpochPlan {
  if (input.globalLeafHashes.length !== input.epoch) throw new EpochIntegrityError('epoch_gap');
  // ① 완전성 — 모든 로그에 헤드 정확히 하나.
  const heads = [...input.heads].sort((a, b) => (a.log < b.log ? -1 : a.log > b.log ? 1 : 0));
  const logs = [...input.logs].sort();
  if (heads.length !== logs.length || heads.some((head, index) => head.log !== logs[index])) {
    throw new EpochIntegrityError('epoch_incomplete');
  }
  // ② 조직 헤드 일관성 — 직전 헤드보다 작아지지 않고, 크기가 늘었으면 옛 루트와 일관성 증명으로 이어진다(로그별 조회는 맵 — 로그 수의 제곱을 피한다. 같은 로그가 겹치면 첫 항목 우선 — 옛 `find` 와 같다).
  const headOf = firstByLog(heads);
  for (const previous of input.previousHeads) {
    const head = headOf.get(previous.log);
    if (head === undefined) throw new EpochIntegrityError('epoch_incomplete');
    if (head.size < previous.size) throw new EpochIntegrityError('org_head_shrunk');
    if (head.size === previous.size) {
      if (!head.root.equals(previous.root)) throw new EpochIntegrityError('org_head_inconsistent');
      continue;
    }
    const leaves = input.leafHashesOf(head.log);
    if (leaves === undefined) throw new EpochIntegrityError('org_leaves_missing');
    if (!verifyConsistency(previous.size, head.size, previous.root, head.root, consistencyProof(leaves, previous.size, head.size))) {
      throw new EpochIntegrityError('org_head_inconsistent');
    }
  }
  const epochRoot = rootOf(heads.map((head) => leafHash(Buffer.from(epochTreeLeaf(input.epoch, head.log, head.size, head.root.toString('hex')), 'utf8'))));
  const globalLeaf = globalEpochLeaf(input.epoch, input.closedAt, epochRoot.toString('hex'));
  const globalLeafHash = leafHash(Buffer.from(globalLeaf, 'utf8'));
  const allGlobal = [...input.globalLeafHashes, globalLeafHash];
  const globalRoot = rootOf(allGlobal);
  // ② 전역 일관성 — 되감은 루트에 서명하지 않는다.
  if (input.previousRoot !== null) {
    const previousSize = input.epoch;
    if (!rootOf(allGlobal, previousSize).equals(input.previousRoot)) throw new EpochIntegrityError('checkpoint_inconsistent');
    if (!verifyConsistency(previousSize, allGlobal.length, input.previousRoot, globalRoot, consistencyProof(allGlobal, previousSize))) {
      throw new EpochIntegrityError('checkpoint_inconsistent');
    }
  }
  // ③ 게시 수위 — 이미 세상에 나간 크기보다 작거나(되감김) 그 루트와 이어지지 않는(분기) 트리에는 서명하지 않는다.
  if (input.published !== undefined && input.published !== null) {
    const published = input.published;
    if (!Number.isSafeInteger(published.size) || published.size < 1 || allGlobal.length < published.size) throw new EpochIntegrityError('published_rollback');
    if (
      !rootOf(allGlobal, published.size).equals(published.root) ||
      !verifyConsistency(published.size, allGlobal.length, published.root, globalRoot, consistencyProof(allGlobal, published.size))
    ) {
      throw new EpochIntegrityError('published_inconsistent');
    }
  }
  const treeSize = allGlobal.length;
  return {
    heads,
    epochRoot,
    globalLeaf,
    globalLeafHash,
    globalRoot,
    treeSize,
    checkpointText: checkpointBody({ origin: input.origin ?? TLOG_ORIGIN, size: treeSize, root: globalRoot }),
  };
}

export interface EpochDependencies {
  readonly db: Pool;
  readonly signer: NoteSigner;
  /** 공개 버킷의 `log/checkpoint` 읽기(게시 수위 — 머리말 ③). */
  readonly published: TlogPublishedReader;
  readonly now: () => Date;
  /** `hourly` — UTC 시 경계를 넘었을 때만(운영). `always` — 부를 때마다(테스트·수동 마감). */
  readonly cadence: 'hourly' | 'always';
}

export interface EpochResult {
  readonly closed: boolean;
  readonly epoch: number | null;
  readonly orgCount: number;
}

/** 체크포인트 키를 `tlog_keys` 에 둔다(없으면). vkey 를 돌려준다. */
export async function ensureCheckpointKey(client: Pick<PoolClient, 'query'>, signer: NoteSigner): Promise<string> {
  const publicKey = await signer.publicKey();
  const vkey = vkeyOf(signer.keyName, publicKey);
  await client.query(
    `INSERT INTO tlog_keys (key_id, purpose, public_key) VALUES ($1, 'checkpoint', $2) ON CONFLICT (key_id) DO NOTHING`,
    [vkey, publicKey],
  );
  return vkey;
}

async function closeWithin(client: PoolClient, deps: EpochDependencies): Promise<EpochResult> {
  await client.query('SELECT pg_advisory_xact_lock($1)', [TLOG_ADVISORY_LOCK]);
  const last = (
    await client.query<{ epoch: string; closed_at: Date; global_root: Buffer }>(
      'SELECT epoch, closed_at, global_root FROM tlog_epochs ORDER BY epoch DESC LIMIT 1',
    )
  ).rows[0];
  const now = deps.now();
  if (deps.cadence === 'hourly' && last !== undefined) {
    const hour = (date: Date): number => Math.floor(date.getTime() / 3_600_000);
    if (hour(now) <= hour(last.closed_at)) return { closed: false, epoch: null, orgCount: 0 };
  }
  // 마감 시각은 앞으로만(시계가 뒤로 가도 — DB 트리거가 한 번 더 본다).
  const closedAt = last !== undefined && now.getTime() <= last.closed_at.getTime() ? new Date(last.closed_at.getTime() + 1) : now;
  const epoch = last === undefined ? 0 : Number(last.epoch) + 1;

  const logs = (await client.query<{ org_log_id: Buffer }>('SELECT org_log_id FROM tlog_logs ORDER BY org_log_id')).rows.map((row) =>
    row.org_log_id.toString('hex'),
  );
  const previousHeads =
    last === undefined
      ? []
      : (
          await client.query<{ org_log_id: Buffer; tree_size: string; root: Buffer }>(
            'SELECT org_log_id, tree_size::text AS tree_size, root FROM tlog_org_heads WHERE epoch = $1',
            [last.epoch],
          )
        ).rows.map((row) => ({ log: row.org_log_id.toString('hex'), size: Number(row.tree_size), root: row.root }));
  const sizes = new Map(
    (await client.query<{ org_log_id: Buffer; size: string }>('SELECT org_log_id, count(*)::text AS size FROM tlog_leaves GROUP BY org_log_id')).rows.map(
      (row) => [row.org_log_id.toString('hex'), Number(row.size)] as const,
    ),
  );
  const leafCache = new Map<string, Buffer[]>();
  const heads: OrgHead[] = [];
  const previousOf = firstByLog(previousHeads);
  for (const log of logs) {
    const size = sizes.get(log) ?? 0;
    const previous = previousOf.get(log);
    if (previous !== undefined && previous.size === size) {
      heads.push(previous);
      continue;
    }
    const hashes = (
      await client.query<{ leaf_hash: Buffer }>('SELECT leaf_hash FROM tlog_leaves WHERE org_log_id = $1 ORDER BY seq', [Buffer.from(log, 'hex')])
    ).rows.map((row) => row.leaf_hash);
    leafCache.set(log, hashes);
    heads.push({ log, size: hashes.length, root: rootOf(hashes) });
  }
  const globalLeafHashes = (await client.query<{ global_leaf_hash: Buffer }>('SELECT global_leaf_hash FROM tlog_epochs ORDER BY epoch')).rows.map(
    (row) => row.global_leaf_hash,
  );

  const plan = planEpoch({
    origin: deps.signer.keyName,
    published: await publishedHead(deps),
    epoch,
    closedAt: instantOf(closedAt),
    logs,
    heads,
    previousHeads,
    globalLeafHashes,
    previousRoot: last?.global_root ?? null,
    leafHashesOf: (log) => leafCache.get(log),
  });

  const vkey = await ensureCheckpointKey(client, deps.signer);
  const publicKey = await deps.signer.publicKey();
  const message = Buffer.from(plan.checkpointText, 'utf8');
  const signature = await deps.signer.sign(message);
  if (!verifyEd25519(publicKey, message, signature)) throw new EpochIntegrityError('checkpoint_signature_invalid');
  const note = signedNote(plan.checkpointText, deps.signer.keyName, keyIdOf(deps.signer.keyName, publicKey), signature);

  await client.query(
    `INSERT INTO tlog_epochs (epoch, closed_at, epoch_root, org_count, global_leaf, global_leaf_hash, global_root, checkpoint, key_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [epoch, instantOf(closedAt), plan.epochRoot, plan.heads.length, plan.globalLeaf, plan.globalLeafHash, plan.globalRoot, note, vkey],
  );
  if (plan.heads.length > 0) {
    await client.query(
      `INSERT INTO tlog_org_heads (epoch, org_log_id, position, tree_size, root)
       SELECT $1, decode(h.log, 'hex'), h.position - 1, h.size, decode(h.root, 'hex')
         FROM unnest($2::text[], $3::bigint[], $4::text[]) WITH ORDINALITY AS h(log, size, root, position)`,
      [epoch, plan.heads.map((head) => head.log), plan.heads.map((head) => head.size), plan.heads.map((head) => head.root.toString('hex'))],
    );
  }
  return { closed: true, epoch, orgCount: plan.heads.length };
}

/** 게시된 최신 체크포인트를 읽어 우리 키로 연다. 읽을 수는 있는데 열리지 않으면(다른 키·다른 origin·깨진 바이트) 서명하지 않는다. */
async function publishedHead(deps: EpochDependencies): Promise<PublishedHead | null> {
  const note = await deps.published.readCheckpoint();
  if (note === null) return null;
  const publicKey = await deps.signer.publicKey();
  try {
    const checkpoint = openCheckpoint(note, { name: deps.signer.keyName, keyId: keyIdOf(deps.signer.keyName, publicKey), publicKey }, deps.signer.keyName);
    return { size: checkpoint.size, root: checkpoint.root };
  } catch {
    throw new EpochIntegrityError('published_checkpoint_unverifiable');
  }
}

export function closeEpoch(deps: EpochDependencies): Promise<EpochResult> {
  return withTransaction(deps.db, (client) => closeWithin(client, deps));
}
