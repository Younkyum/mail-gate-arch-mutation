/**
 * src/tlog/identity-blocks.ts — 콘솔 신원 탭의 **변경 이력 블록**(US-013). admin 롤(`atmark_admin`, 읽기만)로 돈다.
 *
 * 블록 하나 = 투명성 로그(ADR-0008)의 `identity.*` 잎 하나다. 체인도 새로 만들지 않고 잎 해시에서 계산한다 — 가짜 해시가 없다:
 *
 *   block_hash_i = SHA-256(prev_block_hash ‖ leaf_hash_i)        prev_block_hash_0 = 0x00 × 32
 *
 * 한 에이전트의 신원 잎을 조직 로그 `seq` 순서로 잇는다(`body.agent_id` 가 그 에이전트인 잎 — 원천 행이 지워져도 잎은 남으므로 블록도
 * 사라지지 않는다). 잎 한 바이트가 바뀌면 그 블록과 뒤의 모든 블록 해시가 달라지고, 각 잎은 조직 머클 트리 → 에폭 → 서명된 체크포인트로
 * 묶인다 — 블록마다 기존 포함 증명(`GET /api/logs/inclusion-proof?entry=`)을 내려받을 수 있다. 응답은 `pnpm log:verify` 가 그대로 읽는다
 * (`scripts/tlog-verify/verifier.ts` `verifyIdentityBlocks` — 잎 해시·체인 재계산).
 *
 * **표시 값은 DB 에서 고른다**(잎에는 이름·주소가 커밋으로만 있다). 그리고 조직 솔트 키로 **커밋을 열어 DB 값과 대조**한다 — 트리거를
 * 끄고 행을 고치면 그 칸이 `matches: false` 로 보인다. 상태 코드처럼 잎에 평문으로 있는 값(그 시점의 사실)은 잎에서 읽고, 지금 행과
 * 맞는지는 가장 최근 블록에서만 본다(앞 블록은 그 뒤 사건이 바꿨을 수 있다). 솔트 키가 폐기됐으면(크립토 슈레딩) 커밋 대조는 `null`.
 *
 * 조직 범위는 두 겹이다 — 라우트가 에이전트의 조직을 세션과 대조하고(`requireAgentInOrganization`), 잎 조회는 `tlog_logs.organization_id`
 * 에서 출발한다. **B5:** DID 는 게시된 뒤에만 싣는다(`externalDidOf`).
 *
 * 적대적 검증 반영(2026-09-24):
 *   - M4 — `proofs: true`(라우트 `?proofs=1`, 콘솔 "내려받기")면 **공통 닻**(최신 서명 체크포인트 → 전역 잎 → 조직 헤드, `checkpointAnchorFor`)과
 *     블록마다 조직 트리 포함 증명(`inclusion`)을 싣는다. 검증기는 고정한 vkey 로 그것을 열 때만 "증명" 으로 통과시키고, 체인만이면 "일관성만"(종료 3).
 *   - L1 — 체인은 부분 색인(`tlog_leaves_identity_agent_idx`, 202609242300)의 `leaf_hash` 로만 잇고, 잎 JSON 은 마지막 `MAX_IDENTITY_BLOCKS` 개만
 *     SQL LIMIT 으로 읽는다.
 *   - L3 — 에이전트 행이 가장 최근 에이전트 잎보다 **뒤에** 바뀌었고(`updated_at` > 잎 `at`) 그 뒤 `IDENTITY_PENDING_GRACE_MS` 안이면, 값이
 *     잎과 달라도 `matches: null` + `pending: true`(서열 대기 — 다음 틱의 잎을 기다린다). 유예가 지나도 다르면 `false`(트리거를 끄고 바꾼 흔적).
 *   - L4 — 이 에이전트를 가리키는 `source.missing` 잎(agents · agent_keypairs = 에이전트 id · passport_documents = 이 에이전트의 passport ·
 *     agent_addresses = 지금 남은 이 에이전트의 주소 행)을 `missing` 으로 싣는다 — 콘솔 "빠진 블록". 체인에는 넣지 않는다(신원 잎이 아니다).
 *     지워진 주소 행의 `source.missing` 은 에이전트를 가릴 수 없어 여기 없다(번들 검증기의 `leaf_source_missing` 이 조직 전체로 보고한다).
 *
 * 고객 도메인(ADR-0014 단계 3 · 계획 §3.10): 이 에이전트가 주소(대표·별칭, 폐기 포함)를 가진 적 있는 고객 도메인의 `domain.status` 잎을 `domains`
 * 로 싣는다(같은 조직의 행만 · 최근 `MAX_IDENTITY_DOMAIN_EVENTS` 개). **체인 밖이다** — 도메인 잎은 조직의 사건이라 `body.agent_id` 가 없고, 체인에
 * 넣으면 같은 도메인을 쓰는 에이전트마다 블록 해시가 달라진다. 도메인 이름은 DB 에서 고르고 커밋을 열어 대조한다(`domainMatches`). 검증기 판 5 가
 * 잎 해시 · 종류 · 같은 로그 · (닻이 있으면) 포함을 본다. 에이전트 주소가 전부 `atmark.ai` 면 `custom_domains` 를 읽지 않는다(빈 배열).
 */

import { createHash } from 'node:crypto';

import type { Queryable } from '../db/client';
import { dormantAnchorSql, hasPrimaryChanges } from '../db/repositories/primary-changes-probe';
import type { PassportStatus } from '../db/schema';
import { AGENT_ADDRESS_DOMAIN } from '../identity/address';
import { externalDidOf } from '../passport/did';
import { commitmentOf, leafIdOf, saltFor } from './commit';
import { type IdentityLeafKind } from './constants';
import { publicKeyFingerprint } from './leaf';
import { inclusionProofs } from './merkle';
import { checkpointAnchorFor, type CheckpointAnchor } from './proofs';
import { instantSql } from './time';

/** 응답 형식 — `pnpm log:verify <파일>` 이 이 값으로 번들·포함 증명과 가른다. */
export const IDENTITY_BLOCKS_FORMAT = 'atmark-identity-blocks/v1';
/** 첫 블록의 이전 해시. */
export const GENESIS_BLOCK_HASH = '00'.repeat(32);
/** 한 응답의 블록 상한 — 넘으면 가장 오래된 것부터 빼고 `truncated` 를 싣는다(체인은 첫 블록의 `prevBlockHash` 에서 이어진다). */
export const MAX_IDENTITY_BLOCKS = 500;
/** L3 — 에이전트 행이 마지막 에이전트 잎 뒤에 바뀐 뒤 "서열 대기" 로 볼 시간(서열기 5분 주기 × 3). 지나면 다른 값은 불일치다. */
export const IDENTITY_PENDING_GRACE_MS = 15 * 60 * 1000;
/** 한 응답의 도메인 사건 상한 — 넘으면 가장 오래된 것부터 뺀다(체인 밖이라 잘려도 체인 검증은 그대로다). */
export const MAX_IDENTITY_DOMAIN_EVENTS = 100;
/**
 * L1 — 한 에이전트의 신원 잎 체인(seq · leaf_hash). 술어·식이 부분 색인 `tlog_leaves_identity_agent_idx`(202609242300)와 **글자 그대로** 같아야
 * 플래너가 색인만으로 읽는다(통합 테스트 ⑦ 이 이 문장의 계획을 본다). $1 = org_log_id · $2 = 에이전트 id.
 */
export const IDENTITY_CHAIN_SQL = `SELECT t.seq::text AS seq, t.leaf_hash FROM tlog_leaves t
        WHERE t.org_log_id = $1 AND t.kind LIKE 'identity.%' AND (t.leaf_json::jsonb -> 'body' ->> 'agent_id') = $2
        ORDER BY t.seq`;
/** 신원 잎의 원천 테이블 — `source.missing` 을 에이전트로 가리는 데 쓴다. */
const IDENTITY_SOURCES = ['agents', 'agent_addresses', 'agent_keypairs', 'passport_documents'] as const;

/** `SHA-256(prev ‖ leaf)` — 둘 다 hex64. */
export function blockHashOf(prevBlockHash: string, leafHash: string): string {
  return createHash('sha256').update(Buffer.from(prevBlockHash, 'hex')).update(Buffer.from(leafHash, 'hex')).digest('hex');
}

export type IdentityField = 'name' | 'status' | 'suspended_by' | 'address' | 'primary' | 'key' | 'algorithm' | 'version' | 'content_hash' | 'cause';

export interface IdentityChange {
  readonly field: IdentityField;
  readonly value: string | number | boolean | null;
  /** DB 값이 잎(커밋·평문)과 맞는가. 대조할 수 없으면(솔트 폐기 · 앞 블록의 바뀐 상태 · 서열 대기) null. */
  readonly matches: boolean | null;
  /** L3 — 행이 마지막 잎 뒤에 바뀌었고 아직 유예 안이다(서열 대기). 콘솔 "기록 대기". */
  readonly pending?: true;
}

export interface IdentityBlock {
  /** 로그 항목 id — 포함 증명(`inclusion-proof?entry=`)의 인자. */
  readonly entryId: string;
  readonly seq: number;
  readonly at: string;
  readonly kind: IdentityLeafKind;
  readonly changes: readonly IdentityChange[];
  /** 잎 JSON(JCS 그대로) — 이름·주소는 커밋뿐이다. */
  readonly leaf: string;
  readonly leafHash: string;
  readonly prevBlockHash: string;
  readonly blockHash: string;
  /** 잎이 든 첫 체크포인트(에폭) — 없으면 다음 정시 에폭을 기다린다. 표시용 주장이다 — 검증기는 `inclusion` 만 센다(M4). */
  readonly checkpoint: { readonly state: 'pending' } | { readonly state: 'checkpointed'; readonly epoch: number };
  /** M4 — `proof.org` 트리 안의 포함 증명(hex, 아래에서 위). 증명을 요청하지 않았거나 잎이 닻 체크포인트 뒤면 null. */
  readonly inclusion?: readonly string[] | null;
}

/** L4 — 이 에이전트를 가리키는 `source.missing` 잎(콘솔 "빠진 블록"). 체인 밖이다. */
export interface IdentityMissingEntry {
  readonly entryId: string;
  readonly seq: number;
  readonly at: string;
  readonly table: string;
  readonly reason: string | null;
  readonly leaf: string;
  readonly leafHash: string;
  readonly checkpoint: { readonly state: 'pending' } | { readonly state: 'checkpointed'; readonly epoch: number };
  readonly inclusion?: readonly string[] | null;
}

/** 고객 도메인 사건(`domain.status` 잎) — 체인 밖. 이 에이전트가 주소를 가진 적 있는 도메인의 상태 변화. */
export interface IdentityDomainEvent {
  readonly entryId: string;
  readonly seq: number;
  readonly at: string;
  /** DB 의 도메인 이름(잎에는 커밋뿐). */
  readonly domain: string | null;
  /** 커밋 `c.domain` 이 DB 이름으로 열리는가. 솔트 폐기면 null. */
  readonly domainMatches: boolean | null;
  readonly status: string | null;
  readonly reason: string | null;
  readonly inbound: string | null;
  readonly leaf: string;
  readonly leafHash: string;
  readonly checkpoint: { readonly state: 'pending' } | { readonly state: 'checkpointed'; readonly epoch: number };
  readonly inclusion?: readonly string[] | null;
}

export interface IdentityBlocksResponse {
  readonly format: typeof IDENTITY_BLOCKS_FORMAT;
  readonly agentId: string;
  readonly chain: { readonly rule: 'sha256(prev_block_hash || leaf_hash)'; readonly genesis: string };
  /** 조직 로그가 시작됐는가(첫 사건 뒤에 생긴다). */
  readonly started: boolean;
  readonly shredded: boolean;
  /** 앞 블록을 뺐다(상한) — 첫 블록의 `prevBlockHash` 가 뺀 블록의 해시다. */
  readonly truncated: boolean;
  readonly blocks: readonly IdentityBlock[];
  /** L4 — 빠진 블록(체인 밖, seq 순). */
  readonly missing: readonly IdentityMissingEntry[];
  /** 고객 도메인 사건(체인 밖, seq 순 — ADR-0014). */
  readonly domains: readonly IdentityDomainEvent[];
  /** M4 — 블록 증명의 공통 닻(`proofs` 를 요청했을 때만 · 체크포인트가 없으면 null). */
  readonly proof?: CheckpointAnchor | null;
  /** 가장 최근 체크포인트(전역) — 없으면 null. */
  readonly lastCheckpoint: { readonly epoch: number; readonly closedAt: string } | null;
  /** 카드 뒷면·수집 카드용(DB) — 공개키 지문 · 게시된 DID · 현재 passport · 에이전트 등록 시각. */
  readonly card: {
    readonly keyFingerprint: string | null;
    readonly keyAlgorithm: string | null;
    readonly did: string | null;
    readonly passport: { readonly status: PassportStatus; readonly version: number; readonly jwsSha256: string | null } | null;
    readonly issuedAt: string | null;
  };
}

interface LeafRow {
  id: string;
  seq: string;
  kind: IdentityLeafKind;
  source_id: string | null;
  leaf_json: string;
  leaf_hash: Buffer;
}

interface MissingRow {
  id: string;
  seq: string;
  source_table: string;
  leaf_json: string;
  leaf_hash: Buffer;
}

export interface IdentityBlocksOptions {
  /** L3 서열 대기 유예의 기준 시각. */
  readonly now: Date;
  /** M4 — 공통 닻 + 블록마다 포함 증명을 싣는다(조직 잎 해시를 읽는다 — 내려받기 때만). */
  readonly proofs?: boolean;
}

interface ParsedLeaf {
  readonly log: string;
  readonly seq: number;
  readonly at: string;
  readonly body: Readonly<Record<string, unknown>>;
  readonly c: Readonly<Record<string, string>>;
}

const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const code = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** 한 에이전트의 신원 블록. `agentId` 는 호출자가 세션 조직 안에 있음을 이미 확인했다. */
export async function identityBlocksFor(
  db: Queryable,
  organizationId: string,
  agentId: string,
  options: IdentityBlocksOptions = { now: new Date() },
): Promise<IdentityBlocksResponse> {
  const log = (
    await db.query<{ org_log_id: Buffer; salt_key: Buffer | null }>(
      `SELECT l.org_log_id, k.salt_key FROM tlog_logs l JOIN tlog_salt_keys k ON k.org_log_id = l.org_log_id WHERE l.organization_id = $1`,
      [organizationId],
    )
  ).rows[0];
  const agent = (
    await db.query<{ name: string; status: string; suspended_by: string | null; created_at: Date; updated_at: string }>(
      `SELECT name, status::text AS status, suspended_by, created_at, ${instantSql('updated_at')} AS updated_at
         FROM agents WHERE id = $1 AND organization_id = $2`,
      [agentId, organizationId],
    )
  ).rows[0];
  const keypair = (
    await db.query<{ public_key: string; algorithm: string }>('SELECT public_key, algorithm::text AS algorithm FROM agent_keypairs WHERE agent_id = $1', [agentId])
  ).rows[0];
  const passports = (
    await db.query<{ id: string; did: string; status: PassportStatus; version: number; content_hash: string | null; jws: string | null; current: boolean }>(
      `SELECT p.id, p.did, p.status, p.version, p.content_hash, d.jws, p.superseded_at IS NULL AS current
         FROM passports p LEFT JOIN passport_documents d ON d.passport_id = p.id WHERE p.agent_id = $1`,
      [agentId],
    )
  ).rows;
  const current = passports.find((row) => row.current);
  let keyFingerprint: string | null = null;
  try {
    keyFingerprint = keypair === undefined ? null : publicKeyFingerprint(keypair.public_key);
  } catch {
    keyFingerprint = null;
  }
  const card: IdentityBlocksResponse['card'] = {
    keyFingerprint,
    keyAlgorithm: keypair?.algorithm ?? null,
    did: current === undefined ? null : externalDidOf({ did: current.did, status: current.status }),
    passport:
      current === undefined
        ? null
        : { status: current.status, version: current.version, jwsSha256: current.jws === null ? null : sha256Hex(current.jws) },
    issuedAt: agent === undefined ? null : agent.created_at.toISOString(),
  };
  const latest = (
    await db.query<{ epoch: string; closed_at: string }>(`SELECT e.epoch::text AS epoch, ${instantSql('e.closed_at')} AS closed_at FROM tlog_epochs e ORDER BY e.epoch DESC LIMIT 1`)
  ).rows[0];
  const lastCheckpoint = latest === undefined ? null : { epoch: Number(latest.epoch), closedAt: latest.closed_at };
  const empty = { format: IDENTITY_BLOCKS_FORMAT, agentId, chain: { rule: 'sha256(prev_block_hash || leaf_hash)', genesis: GENESIS_BLOCK_HASH }, lastCheckpoint, card } as const;
  if (log === undefined) return { ...empty, started: false, shredded: false, truncated: false, blocks: [], missing: [], domains: [], ...(options.proofs === true ? { proof: null } : {}) };

  // L1 — 체인은 부분 색인의 leaf_hash 만으로(색인 전용 훑기), 표시할 잎 JSON 은 마지막 MAX 개만. 술어는 색인 조건(`kind LIKE 'identity.%'`)과
  // 식(`leaf_json::jsonb -> 'body' ->> 'agent_id'`)을 그대로 쓴다 — 바꾸면 플래너가 색인을 못 쓴다.
  const chainRows = (await db.query<{ seq: string; leaf_hash: Buffer }>(IDENTITY_CHAIN_SQL, [log.org_log_id, agentId])).rows;
  const leaves = (
    await db.query<LeafRow>(
      `SELECT t.id::text AS id, t.seq::text AS seq, t.kind, t.source_id, t.leaf_json, t.leaf_hash
         FROM tlog_leaves t
        WHERE t.org_log_id = $1 AND t.kind LIKE 'identity.%' AND (t.leaf_json::jsonb -> 'body' ->> 'agent_id') = $2
        ORDER BY t.seq DESC
        LIMIT $3`,
      [log.org_log_id, agentId, MAX_IDENTITY_BLOCKS],
    )
  ).rows.reverse();
  // 블록 해시 — 전체 체인에서(잘린 앞부분도 이어서 계산한다).
  const chainAt = new Map<string, { prev: string; hash: string }>();
  let running = GENESIS_BLOCK_HASH;
  for (const row of chainRows) {
    const hash = blockHashOf(running, row.leaf_hash.toString('hex'));
    chainAt.set(row.seq, { prev: running, hash });
    running = hash;
  }
  // L4 — 이 에이전트를 가리키는 source.missing 잎(원천 행이 서열 시점에 없었다 · 옮길 수 없었다).
  const addressRows = (await db.query<{ id: string; domain: string }>('SELECT id::text AS id, domain FROM agent_addresses WHERE agent_id = $1', [agentId])).rows;
  const addressIds = addressRows.map((row) => row.id);
  const missingRows = (
    await db.query<MissingRow>(
      `SELECT t.id::text AS id, t.seq::text AS seq, t.source_table, t.leaf_json, t.leaf_hash
         FROM tlog_leaves t
        WHERE t.org_log_id = $1 AND t.kind = 'source.missing' AND t.source_table = ANY ($2::text[])
          AND ((t.source_table IN ('agents', 'agent_keypairs') AND t.source_id = $3)
            OR (t.source_table = 'passport_documents' AND t.source_id = ANY ($4::text[]))
            OR (t.source_table = 'agent_addresses' AND t.source_id = ANY ($5::text[])))
        ORDER BY t.seq`,
      [log.org_log_id, [...IDENTITY_SOURCES], agentId, passports.map((row) => row.id), addressIds],
    )
  ).rows;
  // 고객 도메인 사건 — 이 에이전트가 주소를 가진 적 있는 도메인(같은 조직의 행). atmark.ai 뿐이면 custom_domains 를 읽지 않는다.
  const customDomains = [...new Set(addressRows.map((row) => row.domain.toLowerCase()).filter((domain) => domain !== AGENT_ADDRESS_DOMAIN))];
  const domainNames = new Map<string, string>();
  if (customDomains.length > 0) {
    for (const row of (
      await db.query<{ id: string; domain: string }>(
        'SELECT id::text AS id, domain FROM custom_domains WHERE organization_id = $1 AND domain = ANY ($2::text[])',
        [organizationId, customDomains],
      )
    ).rows) {
      domainNames.set(row.id, row.domain);
    }
  }
  const domainRows =
    domainNames.size === 0
      ? []
      : (
          await db.query<{ id: string; seq: string; source_id: string | null; leaf_json: string; leaf_hash: Buffer }>(
            `SELECT t.id::text AS id, t.seq::text AS seq, t.source_id, t.leaf_json, t.leaf_hash
               FROM tlog_leaves t
              WHERE t.org_log_id = $1 AND t.kind = 'domain.status' AND t.source_table = 'custom_domains' AND t.source_id = ANY ($2::text[])
              ORDER BY t.seq DESC
              LIMIT $3`,
            [log.org_log_id, [...domainNames.keys()], MAX_IDENTITY_DOMAIN_EVENTS],
          )
        ).rows.reverse();
  // 잎마다 그것을 처음 담은 에폭 — 조직 헤드 크기는 에폭을 따라 줄지 않는다(트리거) · 이분 탐색.
  const heads = (
    await db.query<{ epoch: string; tree_size: string }>(
      'SELECT h.epoch::text AS epoch, h.tree_size::text AS tree_size FROM tlog_org_heads h WHERE h.org_log_id = $1 ORDER BY h.epoch',
      [log.org_log_id],
    )
  ).rows.map((row) => ({ epoch: Number(row.epoch), size: Number(row.tree_size) }));
  const firstEpochCovering = (seq: number): number | null => {
    let lo = 0;
    let hi = heads.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((heads[mid]?.size ?? 0) > seq) hi = mid;
      else lo = mid + 1;
    }
    return heads[lo]?.epoch ?? null;
  };
  const checkpointOf = (seq: number): IdentityBlock['checkpoint'] => {
    const epoch = firstEpochCovering(seq);
    return epoch === null ? { state: 'pending' } : { state: 'checkpointed', epoch };
  };

  const addresses = new Map<string, { address: string; primary: boolean }>();
  // 주소 잎 둘(연결 · tlog v4 폐기)이 가리키는 행.
  const assignedIds = leaves
    .filter((row) => (row.kind === 'identity.address_assigned' || row.kind === 'identity.address_retired') && row.source_id !== null)
    .map((row) => row.source_id as string);
  if (assignedIds.length > 0) {
    for (const row of (
      await db.query<{ id: string; address: string; is_primary: boolean }>(
        'SELECT id, address, is_primary FROM agent_addresses WHERE agent_id = $1 AND id = ANY ($2::uuid[])',
        [agentId, assignedIds],
      )
    ).rows) {
      addresses.set(row.id, { address: row.address, primary: row.is_primary });
    }
  }
  // 대표 주소 변경 블록(`identity.primary_set`, ADR-0014 개정) — 그 잎이 있을 때만 원천 표를 읽는다(표는 M3a 마이그레이션 — 없으면 읽지 않는다, 42P01 없음).
  const primaryChanges = new Map<string, { address: string; cause: string }>();
  const primaryIds = leaves.filter((row) => row.kind === 'identity.primary_set' && row.source_id !== null).map((row) => row.source_id as string);
  const hasPrimaryTable = await hasPrimaryChanges(db, db);
  if (primaryIds.length > 0 && hasPrimaryTable) {
    for (const row of (
      await db.query<{ id: string; address: string; cause: string }>(
        'SELECT id::text AS id, address, cause FROM agent_primary_changes WHERE agent_id = $1 AND id = ANY ($2::uuid[])',
        [agentId, primaryIds],
      )
    ).rows) {
      primaryChanges.set(row.id, { address: row.address, cause: row.cause });
    }
  }
  // **잠든 앵커**(ADR-0014 2026-10 개정 — 마지막 대표 선택이 앵커가 아니다)의 주소는 블록 값으로 보여 주지 않는다(콘솔 · API 어디에도 나오지 않는다).
  // 커밋 대조(`matches`)는 그대로 한다 — 값 칸만 비운다. 선택 표가 없으면(그 마이그레이션 전) 잠든 앵커도 없다.
  const dormantAnchor = hasPrimaryTable
    ? ((await db.query<{ address: string }>(`SELECT x.address FROM agent_addresses x WHERE x.agent_id = $1 AND ${dormantAnchorSql('x')}`, [agentId])).rows[0]
        ?.address ?? null)
    : null;
  const shown = (address: string | undefined): string | null => (address === undefined || address === dormantAnchor ? null : address);
  const passportById = new Map(passports.map((row) => [row.id, row]));
  const saltKey = log.salt_key;
  const opened = (leaf: ParsedLeaf, field: string, value: unknown): boolean | null => {
    if (saltKey === null) return null;
    const committed = leaf.c[field];
    if (committed === undefined) return false;
    return commitmentOf(saltFor(saltKey, leafIdOf(leaf.log, leaf.seq), field), value) === committed;
  };
  const lastAgentLeaf = [...leaves].reverse().find((row) => row.kind === 'identity.agent_created' || row.kind === 'identity.agent_updated');
  // L3 — 행이 마지막 에이전트 잎 뒤에 바뀌었고 유예 안이면 다른 값은 "서열 대기"(null + pending). 잎 `at`(enqueue clock_timestamp) ≥ 정상 갱신의
  // updated_at(now()) 이므로, 잎보다 뒤의 updated_at 은 아직 잎이 되지 않은 사건(또는 트리거를 끈 변경 — 유예가 지나면 불일치).
  const lastAgentAt = lastAgentLeaf === undefined ? null : (JSON.parse(lastAgentLeaf.leaf_json) as ParsedLeaf).at;
  const awaitingSequencer =
    agent !== undefined &&
    lastAgentAt !== null &&
    agent.updated_at > lastAgentAt &&
    options.now.getTime() - Date.parse(`${agent.updated_at.slice(0, 23)}Z`) < IDENTITY_PENDING_GRACE_MS;
  /** 가장 최근 상태 칸 — 맞으면 true, 다르면 서열 대기 중엔 null+pending, 아니면 false. */
  const latestCheck = (field: IdentityField, value: IdentityChange['value'], match: boolean | null): IdentityChange =>
    match === false && awaitingSequencer ? { field, value, matches: null, pending: true } : { field, value, matches: match };

  const all: IdentityBlock[] = [];
  for (const row of leaves) {
    const leaf = JSON.parse(row.leaf_json) as ParsedLeaf;
    const body = leaf.body;
    const changes: IdentityChange[] = [];
    const latestState = row === lastAgentLeaf;
    switch (row.kind) {
      case 'identity.agent_created':
      case 'identity.agent_updated': {
        const changed = row.kind === 'identity.agent_created' ? ['name', 'status'] : Array.isArray(body['changed']) ? (body['changed'] as unknown[]) : [];
        if (changed.includes('name')) {
          // 지금 이름으로 커밋이 열리면 일치. 앞 블록은 뒤 사건이 이름을 바꿨을 수 있다 — 열리지 않으면 "알 수 없음"(null), 가장 최근 블록만 불일치로 본다.
          const nameMatch = agent === undefined ? false : opened(leaf, 'name', agent.name);
          if (latestState) changes.push(latestCheck('name', agent?.name ?? null, nameMatch));
          else changes.push({ field: 'name', value: agent?.name ?? null, matches: nameMatch === true ? true : null });
        }
        if (changed.includes('status')) {
          if (latestState && agent !== undefined) changes.push(latestCheck('status', code(body['status']), code(body['status']) === agent.status));
          else changes.push({ field: 'status', value: code(body['status']), matches: null });
        }
        if (changed.includes('suspended_by')) {
          if (latestState && agent !== undefined) {
            changes.push(latestCheck('suspended_by', code(body['suspended_by']), code(body['suspended_by']) === agent.suspended_by));
          } else changes.push({ field: 'suspended_by', value: code(body['suspended_by']), matches: null });
        }
        break;
      }
      case 'identity.address_assigned': {
        const found = row.source_id === null ? undefined : addresses.get(row.source_id);
        changes.push({ field: 'address', value: shown(found?.address), matches: found === undefined ? false : opened(leaf, 'address', found.address) });
        changes.push({ field: 'primary', value: body['primary'] === true, matches: found === undefined ? false : found.primary === body['primary'] });
        break;
      }
      case 'identity.address_retired': {
        // 별칭 폐기(tlog v4) — 주소 커밋이 지금 행의 주소로 열리는가. 폐기 시각은 행의 retired_at 과 잎의 at 이 같다(검증기가 본다).
        const found = row.source_id === null ? undefined : addresses.get(row.source_id);
        changes.push({ field: 'address', value: shown(found?.address), matches: found === undefined ? false : opened(leaf, 'address', found.address) });
        break;
      }
      case 'identity.primary_set': {
        // 대표 주소 선택 — 주소 커밋이 그 선택 행의 주소로 열리는가 · 원인 코드가 같은가(append-only 라 앞 블록도 그때 값 그대로다).
        const found = row.source_id === null ? undefined : primaryChanges.get(row.source_id);
        changes.push({ field: 'address', value: shown(found?.address), matches: found === undefined ? false : opened(leaf, 'address', found.address) });
        changes.push({ field: 'cause', value: code(body['cause']), matches: found === undefined ? false : found.cause === body['cause'] });
        break;
      }
      case 'identity.key_bound':
        changes.push({ field: 'key', value: code(body['key_fp']), matches: keyFingerprint === null ? false : keyFingerprint === body['key_fp'] });
        changes.push({ field: 'algorithm', value: code(body['algorithm']), matches: keypair === undefined ? false : keypair.algorithm === body['algorithm'] });
        break;
      case 'identity.passport_version': {
        const found = row.source_id === null ? undefined : passportById.get(row.source_id);
        changes.push({ field: 'version', value: typeof body['version'] === 'number' ? body['version'] : null, matches: found === undefined ? false : found.version === body['version'] });
        changes.push({ field: 'status', value: code(body['status']), matches: found === undefined ? false : found.status === body['status'] });
        changes.push({ field: 'content_hash', value: code(body['content_hash']), matches: found === undefined ? false : found.content_hash === body['content_hash'] });
        break;
      }
    }
    const leafHash = row.leaf_hash.toString('hex');
    const link = chainAt.get(row.seq) ?? { prev: GENESIS_BLOCK_HASH, hash: blockHashOf(GENESIS_BLOCK_HASH, leafHash) };
    const seq = Number(row.seq);
    all.push({
      entryId: row.id,
      seq,
      at: leaf.at,
      kind: row.kind,
      changes,
      leaf: row.leaf_json,
      leafHash,
      prevBlockHash: link.prev,
      blockHash: link.hash,
      checkpoint: checkpointOf(seq),
    });
  }
  const missing: IdentityMissingEntry[] = missingRows.map((row) => {
    const leaf = JSON.parse(row.leaf_json) as ParsedLeaf;
    const seq = Number(row.seq);
    return {
      entryId: row.id,
      seq,
      at: leaf.at,
      table: row.source_table,
      reason: code(leaf.body['reason']),
      leaf: row.leaf_json,
      leafHash: row.leaf_hash.toString('hex'),
      checkpoint: checkpointOf(seq),
    };
  });
  const domains: IdentityDomainEvent[] = domainRows.map((row) => {
    const leaf = JSON.parse(row.leaf_json) as ParsedLeaf;
    const seq = Number(row.seq);
    const name = row.source_id === null ? undefined : domainNames.get(row.source_id);
    return {
      entryId: row.id,
      seq,
      at: leaf.at,
      domain: name ?? null,
      domainMatches: name === undefined ? false : opened(leaf, 'domain', name),
      status: code(leaf.body['status']),
      reason: code(leaf.body['reason']),
      inbound: code(leaf.body['inbound']),
      leaf: row.leaf_json,
      leafHash: row.leaf_hash.toString('hex'),
      checkpoint: checkpointOf(seq),
    };
  });
  const base = { ...empty, started: true, shredded: saltKey === null, truncated: chainRows.length > leaves.length };
  if (options.proofs !== true) return { ...base, blocks: all, missing, domains };

  // M4 — 공통 닻 + 블록(·빠진 블록)마다 조직 트리 포함 증명. 닻 체크포인트 뒤의 잎은 null(검증기가 "증명 아님" 으로 센다).
  const anchored = await checkpointAnchorFor(db, log.org_log_id);
  if (anchored === null) {
    return {
      ...base,
      blocks: all.map((block) => ({ ...block, inclusion: null })),
      missing: missing.map((entry) => ({ ...entry, inclusion: null })),
      domains: domains.map((entry) => ({ ...entry, inclusion: null })),
      proof: null,
    };
  }
  const size = anchored.anchor.org.treeSize;
  const covered = [...all.map((block) => block.seq), ...missing.map((entry) => entry.seq), ...domains.map((entry) => entry.seq)].filter((seq) => seq < size);
  const paths = new Map(inclusionProofs(anchored.leafHashes, covered, size).map((path, index) => [covered[index] as number, path.map((node) => node.toString('hex'))]));
  return {
    ...base,
    blocks: all.map((block) => ({ ...block, inclusion: paths.get(block.seq) ?? null })),
    missing: missing.map((entry) => ({ ...entry, inclusion: paths.get(entry.seq) ?? null })),
    domains: domains.map((entry) => ({ ...entry, inclusion: paths.get(entry.seq) ?? null })),
    proof: anchored.anchor,
  };
}
