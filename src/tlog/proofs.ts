/**
 * src/tlog/proofs.ts — **소유자용 증명·검증 번들**(ADR-0008 §2.5·§2.6). admin 롤(`atmark_admin`, 읽기만)로 돈다.
 *
 * ★ **조직 범위는 이 파일의 SQL 이 정한다** — 모든 조회는 `tlog_logs.organization_id = <세션 조직>` 에서 출발한다. 다른 조직의 잎 id·
 * 에폭 번호를 넣어도 "없음"(`TlogProofNotFoundError`)이다. 에폭 트리의 다른 조직 헤드는 **형제 해시로만** 응답에 들어간다(원래 값 없음).
 *
 * 증명 셋:
 *   ① 잎 → 조직 헤드(RFC 9162 §2.1.3) ② 조직 헤드 → 에폭 루트 ③ 에폭 잎 → 전역 체크포인트(공개 타일로도 검증된다)
 *   + 조직 헤드 i → j · 전역 체크포인트 i → j 일관성(§2.1.4).
 * 번들(`atmark-tlog-bundle/v2`)은 **닫힌 범위** [from, to] 의 체크포인트·헤드·증명과 그 범위의 잎 — 시작 크기(from 헤드)부터 **to 헤드
 * 크기까지**(가장자리 frontier 로 시작 크기를 넘긴다, 체크포인트 밖 꼬리 잎은 싣지 않는다) — 원천 행(대조용 — 소유자 자신의 데이터),
 * 조직 솔트 키, 앵커 영수증을 담는다. 범위가 크면(에폭 168 · 잎 5000 초과) to 를 줄여 싣고 `continuation` 으로 다음 페이지를 알린다
 * (Lambda 응답 6 MB). `since`(소유자가 지난번에 저장한 에폭)를 주면 그 체크포인트·헤드에서 이 범위까지의 일관성 증명(`link`)을 싣는다 —
 * 검증기는 저장한 상태와 이어지지 않는 번들을 통과시키지 않는다. 검증기는 `pnpm log:verify`(`scripts/log-verify.ts`) — `src/**` 를
 * import 하지 않는 독립 구현이다.
 * 신원 잎(US-013) 적대적 검증 반영: 번들은 `identity_since`(신원 잎 도입 시각 — 신원 원천 창의 시작, M2)와 `min_verifier_version`(L6)을 싣고,
 * `agents` 행은 조직 전체를 싣는다(M3 — 검증기의 대기 검사가 다음 번들에서 그 행을 다시 본다).
 */

import type { Queryable } from '../db/client';
import { TLOG_ORIGIN, type TlogSourceTable } from './constants';
import { epochTreeLeaf } from './leaf';
import { consistencyProof, frontierOf, inclusionProof, leafHash } from './merkle';
import { instantSql } from './time';

/** 포함 증명 응답의 형식 — `pnpm log:verify <file>` 가 이 값으로 번들과 가른다(`scripts/tlog-verify/verifier.ts` `verifyInclusionProof`). */
export const INCLUSION_FORMAT = 'atmark-tlog-inclusion/v1';
/** v2 — 에폭 트리 잎에 에폭 번호(`GLOBAL_LEAF_VERSION` 2) · 닫힌 범위 · `link` · `continuation`. */
export const BUNDLE_FORMAT = 'atmark-tlog-bundle/v2';
/** 번들 한 페이지의 에폭 상한(7일). 넘으면 to 를 줄이고 `continuation` 을 싣는다. */
export const MAX_BUNDLE_EPOCHS = 24 * 7;
/** 번들 한 페이지의 잎 상한 — 잎·원천 행이 Lambda 응답 6 MB 안에 머문다. 넘으면 to 를 줄이고 `continuation` 을 싣는다. */
export const MAX_BUNDLE_LEAVES = 5000;
/**
 * 원천 창의 가장자리 여유 — 창 = [from 마감 + 여유, to 마감 − 여유]. 에폭 마감 틱은 outbox 를 비운 **직후** 닫으므로, 그 틈에 커밋된 행이나
 * 긴 트랜잭션의 행(created_at 은 트랜잭션 시작 시각)은 다음 에폭의 잎을 얻는다 — 가장자리 행을 "잎 없는 행" 으로 잘못 보고하지 않게 뺀다.
 */
export const SOURCE_WINDOW_SKEW_MS = 60 * 1000;
/**
 * 이 번들을 읽으려면 필요한 검증기 판(`scripts/tlog-verify/verifier.ts` `VERIFIER_VERSION`). 2 = 신원 원천 대조(US-013) · `identity_since`(M2) ·
 * `agents.updated_at` 미래·대기 검사(M3). 옛 검증기는 신원 원천 행을 모르는 표로 거부하므로 소유자가 검증기를 갱신해야 한다(런북 deploy §19).
 * 3 = 요금제 원천 `org_entitlements` · 잎 `billing.entitlement`(202609250300, ADR-0011) — 판 2 검증기는 그 행을 모르는 표로 거부한다(런북 deploy §20).
 * 4 = tlog v4(202609270115, ADR-0013 2차) — `billing.entitlement` 9/11칸 · 별칭 폐기 잎 `identity.address_retired` · 주소 행의 `retired_at`.
 *     판 3 검증기는 11칸 잎의 새 칸을 모르고 폐기 잎을 주소 행의 `kind` 불일치로 거부한다 → 소유자가 검증기를 갱신한다(런북 deploy §23).
 */
export const MIN_VERIFIER_VERSION = 4;
/**
 * 5 = 고객 도메인(ADR-0014 단계 3) — 잎 `domain.status` · 원천 `custom_domains`, 그리고 대표 주소 선택 잎 `identity.primary_set` · 원천
 * `agent_primary_changes`(ADR-0014 개정). **번들에 그 잎이나 원천 행이 있을 때만** 요구한다(리드 결정 2026-10-02): 고객 도메인·대표 주소 변경이
 * 없는 조직(= 지금 운영 전부)의 번들은 계속 판 4 를 요구하므로 소유자가 검증기를 갱신하지 않아도 된다. 판 4 검증기는 그 잎·행을 모르는 표로
 * 거부하므로(`row_leaf_mismatch … table` · `row_without_leaf` · `leaf_without_row`) 5 를 싣는 것은 친절한 `verifier_outdated` 를 위한 것이다 —
 * 서버가 4 로 낮춰 실어도 판 4 가 그 잎을 통과시키지는 않는다.
 */
export const DOMAIN_MIN_VERIFIER_VERSION = 5;
/**
 * 6 = 운영자 · 시스템 행위자(202610131610 — `owner.action` 잎의 `c.operator` · 원천 행 `actor: 'operator'`). **번들에 그 행이 있을 때만** 요구한다
 * (판 5 와 같은 규율): 운영자 CLI 가 그 조직에 손대지 않았고 플랫폼이 그 조직을 얼리지 않았으면 판 4 · 5 그대로 읽힌다. 판 5 검증기는 그 행을
 * 행위자 종류 불일치(`row_leaf_mismatch … actor`)로 거부하므로 6 을 싣는 것은 친절한 `verifier_outdated` 를 위한 것이다.
 */
export const OPERATOR_MIN_VERIFIER_VERSION = 6;

export class TlogProofNotFoundError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'TlogProofNotFoundError';
    this.code = code;
  }
}

export class TlogProofRangeError extends Error {
  readonly code: string;
  readonly status: 400 | 413;

  constructor(code: string, status: 400 | 413 = 400) {
    super(code);
    this.name = 'TlogProofRangeError';
    this.code = code;
    this.status = status;
  }
}

const hex = (bytes: Buffer): string => bytes.toString('hex');
const hexes = (list: readonly Buffer[]): string[] => list.map(hex);

interface OrgLog {
  readonly log: Buffer;
  readonly saltKey: Buffer | null;
}

async function orgLogOf(db: Queryable, organizationId: string): Promise<OrgLog | null> {
  const result = await db.query<{ org_log_id: Buffer; salt_key: Buffer | null }>(
    `SELECT l.org_log_id, k.salt_key FROM tlog_logs l JOIN tlog_salt_keys k ON k.org_log_id = l.org_log_id WHERE l.organization_id = $1`,
    [organizationId],
  );
  const row = result.rows[0];
  return row === undefined ? null : { log: row.org_log_id, saltKey: row.salt_key };
}

async function requireOrgLog(db: Queryable, organizationId: string): Promise<OrgLog> {
  const found = await orgLogOf(db, organizationId);
  if (found === null) throw new TlogProofNotFoundError('log_not_started');
  return found;
}

async function orgLeafHashes(db: Queryable, log: Buffer): Promise<Buffer[]> {
  return (await db.query<{ leaf_hash: Buffer }>('SELECT leaf_hash FROM tlog_leaves WHERE org_log_id = $1 ORDER BY seq', [log])).rows.map(
    (row) => row.leaf_hash,
  );
}

async function globalLeafHashes(db: Queryable, upTo: number): Promise<Buffer[]> {
  return (
    await db.query<{ global_leaf_hash: Buffer }>('SELECT global_leaf_hash FROM tlog_epochs WHERE epoch <= $1 ORDER BY epoch', [upTo])
  ).rows.map((row) => row.global_leaf_hash);
}

interface HeadRow {
  readonly epoch: number;
  readonly size: number;
  readonly root: Buffer;
  readonly position: number;
}

async function headOf(db: Queryable, log: Buffer, epoch: number): Promise<HeadRow | null> {
  const row = (
    await db.query<{ tree_size: string; root: Buffer; position: number }>(
      'SELECT tree_size::text AS tree_size, root, position FROM tlog_org_heads WHERE org_log_id = $1 AND epoch = $2',
      [log, epoch],
    )
  ).rows[0];
  return row === undefined ? null : { epoch, size: Number(row.tree_size), root: row.root, position: row.position };
}

/** 에폭 트리 안에서 이 헤드의 포함 증명. */
async function epochTreeProof(db: Queryable, epoch: number, position: number): Promise<{ readonly size: number; readonly proof: string[] }> {
  const heads = (
    await db.query<{ org_log_id: Buffer; tree_size: string; root: Buffer }>(
      'SELECT org_log_id, tree_size::text AS tree_size, root FROM tlog_org_heads WHERE epoch = $1 ORDER BY position',
      [epoch],
    )
  ).rows;
  const hashes = heads.map((row) => leafHash(Buffer.from(epochTreeLeaf(epoch, hex(row.org_log_id), Number(row.tree_size), hex(row.root)), 'utf8')));
  return { size: hashes.length, proof: hexes(inclusionProof(hashes, position)) };
}

interface EpochRow {
  readonly epoch: number;
  readonly closedAt: string;
  readonly checkpoint: string;
  readonly globalLeaf: string;
  readonly published: boolean;
}

type EpochSqlRow = { epoch: string; closed_at: string; checkpoint: string; global_leaf: string; published: boolean };
const EPOCH_ROW_SQL = `SELECT epoch::text AS epoch, ${instantSql('closed_at')} AS closed_at, checkpoint, global_leaf, published_at IS NOT NULL AS published
                         FROM tlog_epochs`;
const toEpochRow = (row: EpochSqlRow): EpochRow => ({
  epoch: Number(row.epoch),
  closedAt: row.closed_at,
  checkpoint: row.checkpoint,
  globalLeaf: row.global_leaf,
  published: row.published,
});

async function epochRow(db: Queryable, epoch: number): Promise<EpochRow | null> {
  const row = (await db.query<EpochSqlRow>(`${EPOCH_ROW_SQL} WHERE epoch = $1`, [epoch])).rows[0];
  return row === undefined ? null : toEpochRow(row);
}

/** 범위 [from, to] 의 에폭 행 — 번들이 에폭마다 따로 묻지 않게 한 번에. */
async function epochRowsBetween(db: Queryable, from: number, to: number): Promise<Map<number, EpochRow>> {
  const rows = (await db.query<EpochSqlRow>(`${EPOCH_ROW_SQL} WHERE epoch BETWEEN $1 AND $2`, [from, to])).rows.map(toEpochRow);
  return new Map(rows.map((row) => [row.epoch, row]));
}

async function latestEpoch(db: Queryable): Promise<number | null> {
  const row = (await db.query<{ epoch: string | null }>('SELECT max(epoch)::text AS epoch FROM tlog_epochs')).rows[0];
  return row?.epoch === null || row?.epoch === undefined ? null : Number(row.epoch);
}

/**
 * 체크포인트 키(vkey) — **그 에폭을 실제로 서명한 키**(`tlog_epochs.key_id`). `tlog_keys` 의 최신 행이 아니다: 키 행은 쓰기 롤이 넣을 수 있는
 * 표라 "가장 최근에 넣은 키" 는 표시·번들을 오염시킬 수 있다(202609241800 이 목적별 삽입을 막지만, 표시는 서명 사실에서만 고른다).
 * `epoch` 를 주지 않으면 최신 에폭.
 */
async function checkpointKey(db: Queryable, epoch?: number): Promise<string | null> {
  const row = (
    epoch === undefined
      ? await db.query<{ key_id: string }>('SELECT key_id FROM tlog_epochs ORDER BY epoch DESC LIMIT 1')
      : await db.query<{ key_id: string }>('SELECT key_id FROM tlog_epochs WHERE epoch = $1', [epoch])
  ).rows[0];
  return row?.key_id ?? null;
}

/** 로그 origin — 서명된 체크포인트의 첫 줄(= 서명 키 이름). 에폭이 없으면 코드 상수. */
async function logOrigin(db: Queryable): Promise<string> {
  const row = (await db.query<{ checkpoint: string }>('SELECT checkpoint FROM tlog_epochs ORDER BY epoch DESC LIMIT 1')).rows[0];
  return row === undefined ? TLOG_ORIGIN : (row.checkpoint.split('\n')[0] ?? TLOG_ORIGIN);
}

/** ② 조직 헤드 → 에폭 루트 · ③ 에폭 잎 → 전역 체크포인트 — 포함 증명 응답과 신원 블록 닻이 같은 모양으로 싣는다. */
async function epochAndGlobalProofs(
  db: Queryable,
  head: HeadRow,
  row: EpochRow,
): Promise<Pick<CheckpointAnchor, 'epochTree' | 'global'>> {
  const epochProof = await epochTreeProof(db, row.epoch, head.position);
  const globals = await globalLeafHashes(db, row.epoch);
  return {
    epochTree: {
      position: head.position,
      size: epochProof.size,
      epochRoot: (JSON.parse(row.globalLeaf) as { epoch_root: string }).epoch_root,
      proof: epochProof.proof,
    },
    global: { index: row.epoch, treeSize: row.epoch + 1, globalLeaf: row.globalLeaf, proof: hexes(inclusionProof(globals, row.epoch, row.epoch + 1)) },
  };
}

// ---------------------------------------------------------------------------
// 무결성 패널
// ---------------------------------------------------------------------------

export interface IntegritySummary {
  readonly origin: string;
  readonly started: boolean;
  readonly log: string | null;
  readonly orgTreeSize: number;
  /** 마지막 체크포인트 뒤에 쌓인(아직 체크포인트되지 않은) 잎 수. */
  readonly uncheckpointedLeaves: number;
  readonly latest: {
    readonly epoch: number;
    readonly closedAt: string;
    readonly globalTreeSize: number;
    readonly orgHeadSize: number | null;
    readonly published: boolean;
  } | null;
  readonly vkey: string | null;
  readonly shredded: boolean;
  /** 대상(엔드포인트)마다 가장 최근 앵커. */
  readonly anchors: readonly {
    readonly epoch: number;
    readonly target: string;
    readonly endpoint: string;
    readonly state: string;
    readonly confirmedAt: string | null;
  }[];
}

export async function integritySummary(db: Queryable, organizationId: string): Promise<IntegritySummary> {
  const org = await orgLogOf(db, organizationId);
  const latest = await latestEpoch(db);
  const vkey = await checkpointKey(db);
  const anchors = (
    await db.query<{ epoch: string; target: string; endpoint: string; state: string; confirmed_at: string | null }>(
      `SELECT DISTINCT ON (target, endpoint) epoch, target, endpoint, state, ${instantSql('confirmed_at')} AS confirmed_at
         FROM tlog_anchors ORDER BY target, endpoint, epoch DESC`,
    )
  ).rows.map((row) => ({ epoch: Number(row.epoch), target: row.target, endpoint: row.endpoint, state: row.state, confirmedAt: row.confirmed_at }));
  let orgTreeSize = 0;
  let orgHeadSize: number | null = null;
  if (org !== null) {
    orgTreeSize = Number(
      (await db.query<{ n: string }>('SELECT count(*)::text AS n FROM tlog_leaves WHERE org_log_id = $1', [org.log])).rows[0]?.n ?? 0,
    );
    if (latest !== null) orgHeadSize = (await headOf(db, org.log, latest))?.size ?? null;
  }
  const row = latest === null ? null : await epochRow(db, latest);
  return {
    origin: await logOrigin(db),
    started: org !== null,
    log: org === null ? null : hex(org.log),
    orgTreeSize,
    uncheckpointedLeaves: orgTreeSize - (orgHeadSize ?? 0),
    latest:
      row === null
        ? null
        : { epoch: row.epoch, closedAt: row.closedAt, globalTreeSize: row.epoch + 1, orgHeadSize, published: row.published },
    vkey,
    shredded: org !== null && org.saltKey === null,
    anchors,
  };
}

// ---------------------------------------------------------------------------
// 포함 · 일관성 증명
// ---------------------------------------------------------------------------

export interface InclusionProofResponse {
  readonly format: typeof INCLUSION_FORMAT;
  readonly origin: string;
  readonly vkey: string | null;
  readonly entry: { readonly id: string; readonly seq: number; readonly leaf: string; readonly leafHash: string };
  readonly org: { readonly log: string; readonly epoch: number; readonly treeSize: number; readonly root: string; readonly proof: string[] };
  readonly epochTree: { readonly position: number; readonly size: number; readonly epochRoot: string; readonly proof: string[] };
  readonly global: { readonly index: number; readonly treeSize: number; readonly globalLeaf: string; readonly proof: string[] };
  readonly checkpoint: string;
}

/** 잎(로그 항목 id) 하나의 포함 증명 — `epoch` 를 주지 않으면 그 잎을 담은 가장 최근 에폭. */
export async function inclusionProofFor(
  db: Queryable,
  organizationId: string,
  entryId: string,
  epoch?: number,
): Promise<InclusionProofResponse> {
  const org = await requireOrgLog(db, organizationId);
  const entry = (
    await db.query<{ seq: string; leaf_json: string; leaf_hash: Buffer }>(
      'SELECT seq, leaf_json, leaf_hash FROM tlog_leaves WHERE id = $1::bigint AND org_log_id = $2',
      [entryId, org.log],
    )
  ).rows[0];
  if (entry === undefined) throw new TlogProofNotFoundError('entry_not_found');
  const seq = Number(entry.seq);
  const target = epoch ?? (await latestEpoch(db));
  if (target === null) throw new TlogProofNotFoundError('no_checkpoint_yet');
  const head = await headOf(db, org.log, target);
  if (head === null) throw new TlogProofNotFoundError('epoch_not_found');
  if (seq >= head.size) throw new TlogProofNotFoundError('entry_not_yet_checkpointed');
  const row = await epochRow(db, target);
  if (row === null) throw new TlogProofNotFoundError('epoch_not_found');
  const leaves = await orgLeafHashes(db, org.log);
  const { epochTree, global } = await epochAndGlobalProofs(db, head, row);
  return {
    format: INCLUSION_FORMAT,
    origin: await logOrigin(db),
    vkey: await checkpointKey(db, target),
    entry: { id: entryId, seq, leaf: entry.leaf_json, leafHash: hex(entry.leaf_hash) },
    org: { log: hex(org.log), epoch: target, treeSize: head.size, root: hex(head.root), proof: hexes(inclusionProof(leaves, seq, head.size)) },
    epochTree,
    global,
    checkpoint: row.checkpoint,
  };
}

/**
 * 신원 블록 파일(US-013 · 적대적 검증 M4)의 **공통 닻** — 최신 에폭의 서명된 체크포인트 → 전역 잎 포함 → 이 조직 헤드의 에폭 트리 포함. 블록마다
 * 조직 트리 포함 증명(`org.treeSize` 기준)을 붙이면 검증기가 고정한 vkey 로 블록 잎이 체크포인트에 있음을 본다. 에폭이 없거나 이 조직 헤드가
 * 없으면 null(모든 블록이 체크포인트 전). `leafHashes` = 헤드 크기까지의 조직 잎 해시(블록 증명 계산용).
 */
export interface CheckpointAnchor {
  readonly origin: string;
  readonly vkey: string | null;
  readonly checkpoint: string;
  readonly org: { readonly log: string; readonly epoch: number; readonly treeSize: number; readonly root: string };
  readonly epochTree: { readonly position: number; readonly size: number; readonly epochRoot: string; readonly proof: string[] };
  readonly global: { readonly index: number; readonly treeSize: number; readonly globalLeaf: string; readonly proof: string[] };
}

export async function checkpointAnchorFor(db: Queryable, log: Buffer): Promise<{ readonly anchor: CheckpointAnchor; readonly leafHashes: Buffer[] } | null> {
  const target = await latestEpoch(db);
  if (target === null) return null;
  const head = await headOf(db, log, target);
  const row = await epochRow(db, target);
  if (head === null || row === null) return null;
  const leafHashes = (
    await db.query<{ leaf_hash: Buffer }>('SELECT leaf_hash FROM tlog_leaves WHERE org_log_id = $1 AND seq < $2 ORDER BY seq', [log, head.size])
  ).rows.map((leaf) => leaf.leaf_hash);
  const { epochTree, global } = await epochAndGlobalProofs(db, head, row);
  return {
    anchor: {
      origin: await logOrigin(db),
      vkey: await checkpointKey(db, target),
      checkpoint: row.checkpoint,
      org: { log: hex(log), epoch: target, treeSize: head.size, root: hex(head.root) },
      epochTree,
      global,
    },
    leafHashes,
  };
}

/**
 * 콘솔 로그 상세의 "포함 증명" 단추 — 원천 행(들)의 잎 가운데 **최신 체크포인트에 든 가장 최근 잎**의 id(`inclusion-proof?entry=`).
 *   - 조직 범위: `tlog_logs.organization_id = <세션 조직>` 의 잎만 본다(호출자가 이미 조직 범위로 고른 행의 id 를 준다 — 두 겹).
 *   - `entryId` null + `pending` true = 잎은 있으나 아직 체크포인트 전(다음 정시 에폭 뒤에 생긴다). 둘 다 비면 잎이 없다(서열 전 ·
 *     로그 도입 전 행 · 로그 대상이 아닌 행). outbox 는 admin 롤이 읽지 못한다 — 서열 전 행은 "잎 없음" 으로 보인다.
 *   - 발신 한 건은 감사 행 여럿(시도마다)·수정 잎(rev)을 가질 수 있다 — 가장 큰 seq(= 가장 최근 상태)를 고른다.
 */
export interface TlogEntryRef {
  readonly entryId: string | null;
  readonly pending: boolean;
}

export async function tlogEntryRefFor(
  db: Queryable,
  organizationId: string,
  source: { readonly table: TlogSourceTable; readonly ids: readonly string[] },
): Promise<TlogEntryRef> {
  if (source.ids.length === 0) return { entryId: null, pending: false };
  const rows = (
    await db.query<{ id: string; seq: string; head_size: string | null }>(
      `SELECT l.id::text AS id, l.seq::text AS seq,
              (SELECT h.tree_size::text FROM tlog_org_heads h
                WHERE h.org_log_id = g.org_log_id AND h.epoch = (SELECT max(e.epoch) FROM tlog_epochs e)) AS head_size
         FROM tlog_logs g
         JOIN tlog_leaves l ON l.org_log_id = g.org_log_id
        WHERE g.organization_id = $1 AND l.source_table = $2 AND l.source_id = ANY($3::text[])
        ORDER BY l.seq DESC`,
      [organizationId, source.table, [...source.ids]],
    )
  ).rows;
  const covered = rows.filter((row) => row.head_size !== null && Number(row.seq) < Number(row.head_size));
  return { entryId: covered[0]?.id ?? null, pending: covered.length < rows.length };
}

export interface ConsistencyProofResponse {
  readonly origin: string;
  readonly vkey: string | null;
  readonly org: { readonly log: string; readonly from: { readonly epoch: number; readonly treeSize: number; readonly root: string }; readonly to: { readonly epoch: number; readonly treeSize: number; readonly root: string }; readonly proof: string[] } | null;
  readonly global: { readonly fromCheckpoint: string; readonly toCheckpoint: string; readonly proof: string[] };
}

export async function consistencyProofFor(db: Queryable, organizationId: string, from: number, to: number): Promise<ConsistencyProofResponse> {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from) throw new TlogProofRangeError('invalid_epoch_range');
  const org = await requireOrgLog(db, organizationId);
  const fromRow = await epochRow(db, from);
  const toRow = await epochRow(db, to);
  if (fromRow === null || toRow === null) throw new TlogProofNotFoundError('epoch_not_found');
  const globals = await globalLeafHashes(db, to);
  const fromHead = await headOf(db, org.log, from);
  const toHead = await headOf(db, org.log, to);
  let orgPart: ConsistencyProofResponse['org'] = null;
  if (fromHead !== null && toHead !== null) {
    const leaves = await orgLeafHashes(db, org.log);
    orgPart = {
      log: hex(org.log),
      from: { epoch: from, treeSize: fromHead.size, root: hex(fromHead.root) },
      to: { epoch: to, treeSize: toHead.size, root: hex(toHead.root) },
      proof: hexes(consistencyProof(leaves, fromHead.size, toHead.size)),
    };
  }
  return {
    origin: await logOrigin(db),
    vkey: await checkpointKey(db, to),
    org: orgPart,
    global: { fromCheckpoint: fromRow.checkpoint, toCheckpoint: toRow.checkpoint, proof: hexes(consistencyProof(globals, from + 1, to + 1)) },
  };
}

// ---------------------------------------------------------------------------
// 검증 번들
// ---------------------------------------------------------------------------

export interface BundleOptions {
  readonly fromEpoch?: number;
  readonly toEpoch?: number;
  /** 소유자가 지난번 검증에서 저장한 에폭 — 그 체크포인트·조직 헤드에서 이 범위까지의 일관성 증명(`link`)을 싣는다. */
  readonly sinceEpoch?: number;
  readonly now: Date;
}

type SourceRow = Record<string, unknown> & { readonly t: string; readonly id: string };

/** 표가 있는가 — 새 코드가 마이그레이션보다 먼저 배포된 사이(런북 deploy §19)에는 그 원천을 싣지 않는다(42P01 없음). */
async function tableExists(db: Queryable, table: string): Promise<boolean> {
  return (await db.query<{ ok: boolean }>('SELECT to_regclass($1) IS NOT NULL AS ok', [`public.${table}`])).rows[0]?.ok === true;
}

/**
 * 신원 잎 도입 시각(202609242300 `tlog_identity_since`, M2) — µs 문자열. 표가 없으면(새 코드가 마이그레이션보다 먼저 배포된 사이, 런북 deploy §19)
 * null = 신원 잎이 아직 없다 → 번들에 신원 원천 행을 싣지 않는다(잎 없는 행으로 거짓 경보를 내지 않게).
 */
async function identitySince(db: Queryable): Promise<string | null> {
  if (!(await tableExists(db, 'tlog_identity_since'))) return null;
  return (await db.query<{ since: string }>(`SELECT ${instantSql('since')} AS since FROM tlog_identity_since`)).rows[0]?.since ?? null;
}

async function sourceRows(
  db: Queryable,
  organizationId: string,
  referenced: ReadonlyMap<string, ReadonlySet<string>>,
  windowStart: string,
  windowEnd: string,
  identityWindowStart: string | null,
): Promise<SourceRow[]> {
  const ids = (table: string): string[] => [...(referenced.get(table) ?? [])];
  const rows: SourceRow[] = [];
  const audit = await db.query<Record<string, unknown> & { id: string }>(
    `SELECT a.id, a.agent_id, a.message_id, a.decision::text AS decision, a.reasons, a.policy_version, a.approval_id,
            ${instantSql('a.evaluated_at')} AS evaluated_at, ${instantSql('a.resolved_at')} AS resolved_at, a.resolution_reason,
            ${instantSql('a.created_at')} AS created_at, m.message_id_header AS rfc822_id,
            CASE WHEN a.message_id IS NULL THEN NULL
                 ELSE coalesce((SELECT array_agg(r.address ORDER BY r.address) FROM outbound_recipients r WHERE r.message_id = a.message_id), ARRAY[]::text[])
            END AS recipients
       FROM audit_logs a JOIN agents g ON g.id = a.agent_id AND g.organization_id = $1
       LEFT JOIN messages m ON m.id = a.message_id
      WHERE a.id = ANY ($2::uuid[]) OR (a.created_at >= $3::timestamptz AND a.created_at <= $4::timestamptz)
      ORDER BY a.created_at, a.id`,
    [organizationId, ids('audit_logs'), windowStart, windowEnd],
  );
  rows.push(...audit.rows.map((row) => ({ ...row, t: 'audit_logs' })));
  const actions = await db.query<Record<string, unknown> & { id: string }>(
    `SELECT id, action, target_id, ${instantSql('created_at')} AS created_at,
            CASE WHEN operator_actor IS NOT NULL THEN 'operator' WHEN org_api_key_id IS NULL THEN 'session' ELSE 'api_key' END AS actor
       FROM owner_actions
      WHERE organization_id = $1 AND (id = ANY ($2::uuid[]) OR (created_at >= $3::timestamptz AND created_at <= $4::timestamptz))
      ORDER BY created_at, id`,
    [organizationId, ids('owner_actions'), windowStart, windowEnd],
  );
  rows.push(...actions.rows.map((row) => ({ ...row, t: 'owner_actions' })));
  const versions = await db.query<Record<string, unknown> & { id: string }>(
    `SELECT v.id, v.agent_id, v.version, v.outbound_mode::text AS outbound_mode, v.inbound_mode::text AS inbound_mode, v.snapshot,
            ${instantSql('v.created_at')} AS created_at
       FROM policy_versions v JOIN agents g ON g.id = v.agent_id AND g.organization_id = $1
      WHERE v.id = ANY ($2::uuid[]) OR (v.created_at >= $3::timestamptz AND v.created_at <= $4::timestamptz)
      ORDER BY v.created_at, v.id`,
    [organizationId, ids('policy_versions'), windowStart, windowEnd],
  );
  rows.push(...versions.rows.map((row) => ({ ...row, t: 'policy_versions' })));
  const inbound = await db.query<Record<string, unknown> & { id: string }>(
    `SELECT i.id, i.agent_id, i.quarantined, i.quarantine_reason, i.policy_reason, i.from_authenticated, i.from_address,
            i.message_id_header, ${instantSql('i.received_at')} AS received_at, ${instantSql('i.created_at')} AS created_at
       FROM inbound_messages i JOIN agents g ON g.id = i.agent_id AND g.organization_id = $1
      WHERE i.id = ANY ($2::uuid[]) OR (i.created_at >= $3::timestamptz AND i.created_at <= $4::timestamptz)
      ORDER BY i.created_at, i.id`,
    [organizationId, ids('inbound_messages'), windowStart, windowEnd],
  );
  rows.push(...inbound.rows.map((row) => ({ ...row, t: 'inbound_messages' })));
  // 신원 원천(US-013, 202609242200). 도입 전이면(null) 싣지 않는다. 창의 시작은 도입 시각 + 여유로 자른다(M2 — 도입 전 행은 잎이 없다).
  if (identityWindowStart === null) return rows;
  const identityStart = identityWindowStart;
  // `agents` 는 변경 가능한 행이다 — `updated_at` 을 싣고, 이 조직의 에이전트 행을 **전부** 싣는다(조직당 에이전트 수만큼 — 작다). M3: 창 끝 뒤에
  // 바뀐 행은 검증기가 접기 대조를 미루고 저장 상태에 대기로 남긴다 — 다음 번들이 그 행을 다시 대조하거나 뒤의 agent_updated 잎을 보여야
  // 하므로 행이 늘 있어야 한다. 창 밖에서 만든 행은 잎이 없어도 검증기가 "잎 없는 행" 으로 보지 않는다(창 = 생성 시각).
  const agents = await db.query<Record<string, unknown> & { id: string }>(
    `SELECT g.id::text AS id, g.name, g.status::text AS status, g.suspended_by,
            ${instantSql('g.created_at')} AS created_at, ${instantSql('g.updated_at')} AS updated_at
       FROM agents g
      WHERE g.organization_id = $1
      ORDER BY g.created_at, g.id`,
    [organizationId],
  );
  rows.push(...agents.rows.map((row) => ({ ...row, t: 'agents' })));
  // tlog v4 — 폐기 시각(`retired_at`)을 싣고, 창 안에서 **폐기된** 행도 싣는다(오래전에 만든 별칭을 창 안에서 폐기했는데 잎이 없으면 검증기가
  // 잡는다). 칸은 행 JSON 에서 꺼낸다 — 202609270110 전 스키마에서도 NULL 로 돈다(새 코드가 마이그레이션보다 먼저 배포된 사이).
  const addresses = await db.query<Record<string, unknown> & { id: string }>(
    `SELECT d.id, d.agent_id, d.address, d.is_primary, ${instantSql('d.created_at')} AS created_at,
            ${instantSql(`(to_jsonb(d) ->> 'retired_at')::timestamptz`)} AS retired_at
       FROM agent_addresses d JOIN agents g ON g.id = d.agent_id AND g.organization_id = $1
      WHERE d.id = ANY ($2::uuid[]) OR (d.created_at >= $3::timestamptz AND d.created_at <= $4::timestamptz)
         OR ((to_jsonb(d) ->> 'retired_at')::timestamptz >= $3::timestamptz AND (to_jsonb(d) ->> 'retired_at')::timestamptz <= $4::timestamptz)
      ORDER BY d.created_at, d.id`,
    [organizationId, ids('agent_addresses'), identityStart, windowEnd],
  );
  rows.push(...addresses.rows.map((row) => ({ ...row, t: 'agent_addresses' })));
  const keypairs = await db.query<Record<string, unknown> & { id: string }>(
    `SELECT k.agent_id::text AS id, k.agent_id, k.public_key, k.algorithm::text AS algorithm, ${instantSql('k.created_at')} AS created_at
       FROM agent_keypairs k JOIN agents g ON g.id = k.agent_id AND g.organization_id = $1
      WHERE k.agent_id::text = ANY ($2::text[]) OR (k.created_at >= $3::timestamptz AND k.created_at <= $4::timestamptz)
      ORDER BY k.created_at, k.agent_id`,
    [organizationId, ids('agent_keypairs'), identityStart, windowEnd],
  );
  rows.push(...keypairs.rows.map((row) => ({ ...row, t: 'agent_keypairs' })));
  const documents = await db.query<Record<string, unknown> & { id: string }>(
    `SELECT d.passport_id AS id, p.agent_id, p.version, p.status::text AS status, p.content_hash, ${instantSql('d.created_at')} AS created_at
       FROM passport_documents d JOIN passports p ON p.id = d.passport_id JOIN agents g ON g.id = p.agent_id AND g.organization_id = $1
      WHERE d.passport_id = ANY ($2::uuid[]) OR (d.created_at >= $3::timestamptz AND d.created_at <= $4::timestamptz)
      ORDER BY d.created_at, d.passport_id`,
    [organizationId, ids('passport_documents'), identityStart, windowEnd],
  );
  rows.push(...documents.rows.map((row) => ({ ...row, t: 'passport_documents' })));
  rows.push(...(await entitlementRows(db, organizationId)));
  return rows;
}

/**
 * 요금제 원천(202609250300, ADR-0011) — 조직당 한 행(없을 수 있다). 변경 가능한 행이라 `agents` 처럼 **늘 싣는다**: 검증기는 창 안의
 * `updated_at` 에 잎이 있는지(없으면 `row_without_leaf`), 마지막 잎의 값·버전이 행과 같은지 본다. 표가 아직 없으면(새 코드가 마이그레이션보다
 * 먼저 배포된 사이) 싣지 않는다. 금액·고객 id 칸은 표에 없다. tlog v4 의 두 칸은 행 JSON 에서 꺼낸다(칸이 없는 옛 스키마·백필 전 = null —
 * 검증기 판 4 는 null 칸 ↔ 9칸 잎, 값 ↔ 11칸 잎으로 대조한다).
 */
async function entitlementRows(db: Queryable, organizationId: string): Promise<SourceRow[]> {
  if (!(await tableExists(db, 'org_entitlements'))) return [];
  const result = await db.query<Record<string, unknown> & { id: string }>(
    `SELECT e.organization_id::text AS id, e.plan_code, e.cause, e.version::int AS version, e.max_agents, e.org_daily_recipients,
            e.agent_per_day_max, e.agent_per_minute_max, e.recipients_per_message_max, e.tokens_per_agent_max,
            e.webhook_endpoints_per_agent_max, e.org_api_keys_max, e.inbound_storage_bytes::float8 AS inbound_storage_bytes,
            (to_jsonb(e) ->> 'aliases_per_agent_max')::int AS aliases_per_agent_max,
            (to_jsonb(e) ->> 'attachment_bytes_total_max')::int AS attachment_bytes_total_max,
            ${instantSql('e.grace_until')} AS grace_until, ${instantSql('e.created_at')} AS created_at, ${instantSql('e.updated_at')} AS updated_at
       FROM org_entitlements e
      WHERE e.organization_id = $1`,
    [organizationId],
  );
  return result.rows.map((row) => ({ ...row, t: 'org_entitlements' }));
}

/**
 * 고객 도메인 원천(202609291130, ADR-0014) — 조직의 `custom_domains` 가운데 **removed 가 아닌 행 전부**(보안 리뷰 M3 — 범위에 잎이 없어도 행이 실려야
 * 검증기가 저장 상태의 마지막 잎으로 접어 "잎 없이 바뀐 상태" 를 잡는다) + 범위 잎이 가리키는 행 + 창 안에서 만들어지거나 제거된 행. 그래서 도메인을
 * 가진 조직의 번들은 늘 판 5 를 요구한다(그 조직만 — 행이 0 이면 그대로 4). 도메인 이름을 싣는다(소유자 자신의 데이터 — 커밋 `c.domain` 을 여는
 * 재료). 표가 없으면 싣지 않는다.
 */
async function domainRows(
  db: Queryable,
  organizationId: string,
  referenced: ReadonlyMap<string, ReadonlySet<string>>,
  windowStart: string,
  windowEnd: string,
): Promise<SourceRow[]> {
  if (!(await tableExists(db, 'custom_domains'))) return [];
  const result = await db.query<Record<string, unknown> & { id: string }>(
    `SELECT d.id::text AS id, d.domain, d.status, d.suspended_reason, d.inbound_mx_status,
            ${instantSql('d.created_at')} AS created_at, ${instantSql('d.updated_at')} AS updated_at, ${instantSql('d.removed_at')} AS removed_at
       FROM custom_domains d
      WHERE d.organization_id = $1
        AND (d.status <> 'removed'
             OR d.id::text = ANY ($2::text[])
             OR (d.created_at >= $3::timestamptz AND d.created_at <= $4::timestamptz)
             -- 창 시작 뒤에 제거된 행은 **상한 없이** 싣는다 — 마지막 체크포인트 뒤의 정상 제거는 removed 잎이 아직 열린 에폭에 있어 범위 밖이다. 행을
             -- 빼면 검증기가 domain_row_missing(오탐)을 낸다. 실으면 검증기가 창 뒤 변화로 대기(domain_fold_deferred)로 두고 다음 번들의 잎이 푼다.
             OR d.removed_at >= $3::timestamptz)
      ORDER BY d.created_at, d.id`,
    [organizationId, [...(referenced.get('custom_domains') ?? [])], windowStart, windowEnd],
  );
  return result.rows.map((row) => ({ ...row, t: 'custom_domains' }));
}

/**
 * 대표 주소 선택 원천(`agent_primary_changes`, ADR-0014 개정 — 표는 M3a 마이그레이션). **이 범위에 그 잎이 있을 때만** 읽는다(리드 결정): 잎이
 * 가리키는 행과 신원 창 안에서 만든 이 조직의 행. 표가 없으면 읽지 않는다(42P01 없음). append-only 라 변경 칸이 없다.
 */
async function primaryChangeRows(
  db: Queryable,
  organizationId: string,
  referenced: ReadonlyMap<string, ReadonlySet<string>>,
  windowStart: string,
  windowEnd: string,
): Promise<SourceRow[]> {
  const ids = [...(referenced.get('agent_primary_changes') ?? [])];
  if (ids.length === 0) return [];
  if (!(await tableExists(db, 'agent_primary_changes'))) return [];
  const result = await db.query<Record<string, unknown> & { id: string }>(
    `SELECT p.id::text AS id, p.agent_id, p.address, p.cause, ${instantSql('p.created_at')} AS created_at
       FROM agent_primary_changes p JOIN agents g ON g.id = p.agent_id AND g.organization_id = $1
      WHERE p.id::text = ANY ($2::text[]) OR (p.created_at >= $3::timestamptz AND p.created_at <= $4::timestamptz)
      ORDER BY p.created_at, p.id`,
    [organizationId, ids, windowStart, windowEnd],
  );
  return result.rows.map((row) => ({ ...row, t: 'agent_primary_changes' }));
}

interface HeadSizeRow {
  readonly epoch: number;
  readonly size: number;
}

/** 범위 [from, to] 안의 조직 헤드(에폭 순) — 페이지 끝 계산과 번들 헤드가 같은 한 번의 조회를 쓴다. */
async function headsBetween(db: Queryable, log: Buffer, from: number, to: number): Promise<HeadRow[]> {
  return (
    await db.query<{ epoch: string; tree_size: string; root: Buffer; position: number }>(
      `SELECT epoch::text AS epoch, tree_size::text AS tree_size, root, position FROM tlog_org_heads
        WHERE org_log_id = $1 AND epoch BETWEEN $2 AND $3 ORDER BY epoch`,
      [log, from, to],
    )
  ).rows.map((row) => ({ epoch: Number(row.epoch), size: Number(row.tree_size), root: row.root, position: row.position }));
}

/**
 * 한 페이지의 끝 에폭 — 요청한 to 에서 에폭 상한(168)·잎 상한(5000)을 넘지 않는 가장 큰 에폭. from 한 에폭 뒤의 잎만으로도 상한을 넘으면
 * 한 페이지로 나눌 수 없다(413 — 한 조직이 한 시간에 5000건을 넘겼다. 런북 §8).
 */
export function bundlePageEnd(from: number, requestedTo: number, startSize: number, sizes: readonly HeadSizeRow[]): number {
  let to = Math.min(requestedTo, from + MAX_BUNDLE_EPOCHS - 1);
  const sizeAt = (epoch: number): number => sizes.filter((row) => row.epoch <= epoch).at(-1)?.size ?? startSize;
  while (to > from && sizeAt(to) - startSize > MAX_BUNDLE_LEAVES) to -= 1;
  // to = from 인데 더 요청했다면 from 다음 에폭 하나가 상한을 넘은 것이다 — 빈 페이지와 같은 continuation 을 되풀이하지 않는다.
  if (sizeAt(to) - startSize > MAX_BUNDLE_LEAVES || (to === from && requestedTo > from && sizeAt(from + 1) - startSize > MAX_BUNDLE_LEAVES)) {
    throw new TlogProofRangeError('epoch_too_large_for_bundle', 413);
  }
  return to;
}

export async function buildVerificationBundle(db: Queryable, organizationId: string, options: BundleOptions): Promise<Record<string, unknown>> {
  const org = await requireOrgLog(db, organizationId);
  const latest = await latestEpoch(db);
  if (latest === null) throw new TlogProofNotFoundError('no_checkpoint_yet');
  const requestedTo = options.toEpoch ?? latest;
  const from = options.fromEpoch ?? Math.max(0, requestedTo - 23);
  const since = options.sinceEpoch;
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(requestedTo) || from < 0 || requestedTo < from || requestedTo > latest) {
    throw new TlogProofRangeError('invalid_epoch_range');
  }
  if (since !== undefined && (!Number.isSafeInteger(since) || since < 0 || since > latest)) throw new TlogProofRangeError('invalid_since_epoch');

  const leafHashes = await orgLeafHashes(db, org.log);
  const rangeHeads = await headsBetween(db, org.log, from, requestedTo);
  const fromHead = rangeHeads.find((head) => head.epoch === from) ?? null;
  const startSize = fromHead?.size ?? 0;
  const to = bundlePageEnd(from, requestedTo, startSize, rangeHeads);
  const pageHeads = rangeHeads.filter((head) => head.epoch <= to);
  const toHead = pageHeads.find((head) => head.epoch === to) ?? null;
  // 닫힌 범위: to 헤드까지의 잎만(체크포인트 밖 꼬리는 검증할 수 없다 — 싣지 않는다).
  const endSize = toHead?.size ?? startSize;

  const leaves = (
    await db.query<{ id: string; seq: string; leaf_json: string; source_table: string | null; source_id: string | null }>(
      `SELECT id, seq, leaf_json, source_table, source_id FROM tlog_leaves
        WHERE org_log_id = $1 AND seq >= $2 AND seq < $3 ORDER BY seq`,
      [org.log, startSize, endSize],
    )
  ).rows;

  const heads = [];
  for (const head of pageHeads) {
    const proof = await epochTreeProof(db, head.epoch, head.position);
    heads.push({ epoch: head.epoch, size: head.size, root: hex(head.root), position: head.position, epoch_size: proof.size, epoch_proof: proof.proof });
  }
  const globals = await globalLeafHashes(db, Math.max(to, since ?? to));
  const epochRows = await epochRowsBetween(db, from, to);
  const checkpoints = [];
  for (let epoch = from; epoch <= to; epoch += 1) {
    const row = epochRows.get(epoch);
    if (row === undefined) throw new TlogProofNotFoundError('epoch_not_found');
    checkpoints.push({ epoch, note: row.checkpoint, global_leaf: row.globalLeaf, inclusion: hexes(inclusionProof(globals, epoch, epoch + 1)) });
  }
  const globalConsistency = [];
  for (let epoch = from; epoch < to; epoch += 1) {
    globalConsistency.push({ from: epoch + 1, to: epoch + 2, proof: hexes(consistencyProof(globals, epoch + 1, epoch + 2)) });
  }
  const lastHead = heads.at(-1);
  const orgConsistency =
    fromHead !== null && lastHead !== undefined
      ? { from_size: fromHead.size, to_size: lastHead.size, proof: hexes(consistencyProof(leafHashes, fromHead.size, lastHead.size)) }
      : null;

  // 저장한 상태(since)와의 연결 — 범위 앞이면 since → from, 범위 뒤면 to → since. 범위 안이면 번들의 체크포인트·헤드가 곧 연결이다.
  let link: Record<string, unknown> | null = null;
  if (since !== undefined && (since < from || since > to)) {
    const sinceHead = await headOf(db, org.log, since);
    const forward = since < from;
    const [globalFrom, globalTo] = forward ? [since + 1, from + 1] : [to + 1, since + 1];
    let orgLink: Record<string, unknown> | null = null;
    if (sinceHead !== null) {
      const [orgFrom, orgTo] = forward ? [sinceHead.size, startSize] : [toHead?.size ?? 0, sinceHead.size];
      orgLink = { from_size: orgFrom, to_size: orgTo, proof: hexes(consistencyProof(leafHashes, orgFrom, orgTo)) };
    }
    link = {
      epoch: since,
      direction: forward ? 'forward' : 'backward',
      global: { from_size: globalFrom, to_size: globalTo, proof: hexes(consistencyProof(globals, globalFrom, globalTo)) },
      org: orgLink,
    };
  }

  const referenced = new Map<string, Set<string>>();
  for (const leaf of leaves) {
    if (leaf.source_table === null || leaf.source_id === null) continue;
    const set = referenced.get(leaf.source_table) ?? new Set<string>();
    set.add(leaf.source_id);
    referenced.set(leaf.source_table, set);
  }
  // 원천 창 = [from 마감(또는 로그 시작) + 여유, to 마감 − 여유] — 이 창의 행은 모두 범위 안의 잎을 가져야 한다.
  const fromRow = epochRows.get(from);
  const toRow = epochRows.get(to);
  const logCreated = (
    await db.query<{ created_at: Date }>('SELECT created_at FROM tlog_logs WHERE org_log_id = $1', [org.log])
  ).rows[0]?.created_at ?? new Date(0);
  const opened = fromHead === null ? logCreated.getTime() : Math.max(Date.parse(fromRow?.closedAt ?? ''), logCreated.getTime());
  const windowStart = new Date(opened + SOURCE_WINDOW_SKEW_MS);
  const windowEnd = new Date(Date.parse(toRow?.closedAt ?? '') - SOURCE_WINDOW_SKEW_MS);
  // 신원 원천의 창은 도입 시각 + 여유에서 시작한다(M2) — 검증기도 같은 규칙으로 도입 전 행을 "잎 없는 행" 에서 뺀다.
  const identityIntroduced = await identitySince(db);
  const identityWindowStart =
    identityIntroduced === null
      ? null
      : new Date(Math.max(windowStart.getTime(), Date.parse(`${identityIntroduced.slice(0, 23)}Z`) + SOURCE_WINDOW_SKEW_MS)).toISOString();
  const sources = [
    ...(await sourceRows(db, organizationId, referenced, windowStart.toISOString(), windowEnd.toISOString(), identityWindowStart)),
    ...(await domainRows(db, organizationId, referenced, windowStart.toISOString(), windowEnd.toISOString())),
    ...(await primaryChangeRows(db, organizationId, referenced, identityWindowStart ?? windowStart.toISOString(), windowEnd.toISOString())),
  ];
  const v5Sources: ReadonlySet<string> = new Set(['custom_domains', 'agent_primary_changes']);
  const hasV5Events = leaves.some((leaf) => leaf.source_table !== null && v5Sources.has(leaf.source_table)) || sources.some((row) => v5Sources.has(row.t));
  // 판 6 — 운영자 · 시스템 행위자의 감사 행(원천 행의 `actor` 로 안다 — 잎 쪽은 그 행의 잎이다).
  const hasOperatorActions = sources.some((row) => row.t === 'owner_actions' && row['actor'] === 'operator');

  const anchors = (
    await db.query<{ epoch: string; target: string; endpoint: string; state: string; digest: Buffer; receipt: Buffer | null; upgraded: Buffer | null }>(
      `SELECT epoch, target, endpoint, state, digest, receipt, upgraded FROM tlog_anchors
        WHERE epoch BETWEEN $1 AND $2 ORDER BY epoch, target, endpoint`,
      [from, to],
    )
  ).rows.map((row) => ({
    epoch: Number(row.epoch),
    target: row.target,
    endpoint: row.endpoint,
    state: row.state,
    digest: hex(row.digest),
    receipt: row.receipt?.toString('base64') ?? null,
    upgraded: row.upgraded?.toString('base64') ?? null,
  }));
  // 정보용 — 검증기는 앵커 키를 번들이 아니라 고정 채널에서 받는다(`--anchor-key`).
  const anchorKeys = (await db.query<{ public_key: Buffer }>(`SELECT public_key FROM tlog_keys WHERE purpose = 'anchor' ORDER BY created_at`)).rows.map(
    (row) => row.public_key.toString('base64'),
  );
  const vkey = await checkpointKey(db, to);
  if (vkey === null) throw new TlogProofNotFoundError('no_checkpoint_yet');

  return {
    format: BUNDLE_FORMAT,
    min_verifier_version: hasOperatorActions ? OPERATOR_MIN_VERIFIER_VERSION : hasV5Events ? DOMAIN_MIN_VERIFIER_VERSION : MIN_VERIFIER_VERSION,
    origin: await logOrigin(db),
    vkey,
    exported_at: options.now.toISOString(),
    identity_since: identityIntroduced,
    org: { log: hex(org.log), salt_key: org.saltKey === null ? null : hex(org.saltKey), shredded: org.saltKey === null },
    range: { from_epoch: from, to_epoch: to },
    continuation: to < requestedTo ? { from_epoch: to, to_epoch: requestedTo } : null,
    start: { size: startSize, frontier: frontierOf(leafHashes, startSize).map((node) => ({ height: node.height, hash: hex(node.hash) })) },
    leaves: leaves.map((leaf) => ({ id: leaf.id, seq: Number(leaf.seq), leaf: leaf.leaf_json })),
    heads,
    checkpoints,
    global_consistency: globalConsistency,
    org_consistency: orgConsistency,
    link,
    sources: { window_start: windowStart.toISOString(), window_end: windowEnd.toISOString(), rows: sources },
    anchors,
    anchor_keys: anchorKeys,
  };
}
