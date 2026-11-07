/**
 * src/admin/routes/integrity.ts — 콘솔 로그 탭의 **무결성** 표면(ADR-0008 §2.5·§2.6, US-010). 전부 조직 범위 · admin 롤 읽기만.
 *
 *   - `GET /api/logs/integrity` → 무결성 패널(마지막 체크포인트 · 앵커 상태 · 체크포인트 키(vkey) · 체크포인트 전 잎 수)
 *   - `GET /api/logs/inclusion-proof?entry=<로그 항목 id>[&epoch=<n>]` → 잎 → 조직 헤드 → 에폭 루트 → 전역 체크포인트 포함 증명
 *   - `GET /api/logs/consistency-proof?from=<epoch>&to=<epoch>` → 조직 헤드·전역 체크포인트 일관성 증명
 *   - `GET /api/agents/{agentId}/identity-blocks[?proofs=1]` → 에이전트 신원 잎의 해시 체인(US-013 — `src/tlog/identity-blocks.ts`). 증명과 같은
 *     조직당 한 번에 하나(429) + 조직당 분당 30번(L1). `proofs=1` 이면 블록마다 포함 증명 + 공통 닻(M4). 한 블록만이면 위 `inclusion-proof`.
 *   - `GET /api/logs/bundle[?from=<epoch>&to=<epoch>&since=<epoch>]` → 검증 번들 JSON 내려받기(`pnpm log:verify` 입력). 닫힌 범위
 *     [from, to] — 크면 to 를 줄여 싣고 `continuation` 을 알린다. `since` = 소유자가 지난번에 저장한 에폭(검증기가 이어짐을 본다).
 *     **소유자 조직의 솔트 키가
 *     들어간다** — 번들을 받은 사람은 이 조직의 커밋(수신자·Message-ID 등)을 열 수 있다. 그래서 내려받기는 소유자 행위로 감사한다
 *     (`logs.bundle_export` — 그 감사 행도 로그의 잎이 된다).
 *
 * 조직 범위는 `src/tlog/proofs.ts` 의 SQL 이 `tlog_logs.organization_id = <세션 조직>` 에서 출발해 정한다. 다른 조직의 항목 id·
 * 없는 항목은 같은 404(`log_entry_not_found`)다.
 *
 * **조직당 속도 제한**(최종 적대적 검증 L3): 증명·번들은 요청마다 그 조직의 잎을 전부 다시 읽고 해시한다 — 한 조직이 admin 동시성(2)을
 * 다 쓰지 못하게 ① 증명 셋(포함·일관성·번들)은 조직마다 **한 번에 하나**(`pg_try_advisory_xact_lock` — 인스턴스를 넘어 DB 가 센다,
 * 기다리지 않고 429) ② 번들은 로그인·가입과 같은 창 세기로 조직당 시간당 `BUNDLE_EXPORTS_PER_HOUR` 번(감사 행 `logs.bundle_export` 를 센다).
 * 조직 트리의 타일·중간 노드를 저장해 요청당 비용 자체를 줄이는 것은 후속이다(ADR-0008 §9.3 F36).
 */

import {
  buildVerificationBundle,
  consistencyProofFor,
  inclusionProofFor,
  integritySummary,
  TlogProofNotFoundError,
  TlogProofRangeError,
} from '../../tlog/proofs';
import { identityBlocksFor } from '../../tlog/identity-blocks';
import { withTransaction, type Queryable } from '../../db/client';
import { audited, requireAgentInOrganization, sessionOf, type AdminCall } from '../context';
import { errorResponse, jsonResponse, type AdminResponse } from '../http';
import { AdminInputError } from '../ops/errors';

const EPOCH = /^(0|[1-9][0-9]{0,11})$/;
const ENTRY = /^[1-9][0-9]{0,17}$/;
/** 번들 내려받기 상한 — 조직당 시간당(연속 페이지 30장 = 에폭 5040 ≈ 210일). */
export const BUNDLE_EXPORTS_PER_HOUR = 30;
/** 신원 블록 API 상한 — 조직당 분당(적대적 검증 L1). 요청 원장 `tlog_identity_block_requests`(202609242300)를 센다. */
const IDENTITY_BLOCKS_PER_MINUTE = 30;

/** 같은 조직의 증명 계산이 이미 돌고 있다 · 번들 상한을 넘었다 — 429. 트랜잭션을 되돌리므로 감사 행도 남지 않는다. */
class ProofRateLimitedError extends Error {
  constructor() {
    super('rate_limited');
    this.name = 'ProofRateLimitedError';
  }
}

/** 조직당 증명 계산 하나 — 잠금은 트랜잭션이 끝나면 풀린다. 잡지 못하면 기다리지 않고 429. */
async function lockProofSlot(tx: Queryable, organizationId: string): Promise<void> {
  const got = await tx.query<{ ok: boolean }>(`SELECT pg_try_advisory_xact_lock(hashtextextended('tlog_proof:' || $1::text, 0)) AS ok`, [organizationId]);
  if (got.rows[0]?.ok !== true) throw new ProofRateLimitedError();
}

function perOrgProof<T>(call: AdminCall, run: (tx: Queryable, organizationId: string) => Promise<T>): Promise<T> {
  const { organizationId } = sessionOf(call);
  return withTransaction(call.deps.pool, async (client) => {
    await lockProofSlot(client, organizationId);
    return run(client, organizationId);
  });
}

function epochParam(call: AdminCall, name: string): number | undefined {
  const raw = call.request.query[name];
  if (raw === undefined) return undefined;
  if (!EPOCH.test(raw)) throw new AdminInputError(`${name} 는 0 이상 정수(에폭 번호)다.`, 'invalid_epoch');
  return Number(raw);
}

function mapProofError(error: unknown): AdminResponse {
  if (error instanceof ProofRateLimitedError) return errorResponse(429, 'rate_limited', '이 조직의 증명·번들 요청이 너무 잦다 — 잠시 뒤 다시 시도하라.');
  if (error instanceof TlogProofNotFoundError) {
    const detail: Record<string, string> = {
      log_not_started: '이 조직의 투명성 로그가 아직 시작되지 않았다(첫 감사 사건 뒤에 생긴다).',
      entry_not_found: '이 조직의 로그 항목이 아니다.',
      entry_not_yet_checkpointed: '이 항목은 아직 체크포인트에 들어가지 않았다(다음 정시 에폭 뒤에 증명이 생긴다).',
      no_checkpoint_yet: '아직 체크포인트가 없다.',
      epoch_not_found: '그 에폭이 없다.',
    };
    return errorResponse(404, error.code === 'entry_not_found' ? 'log_entry_not_found' : error.code, detail[error.code] ?? error.code);
  }
  if (error instanceof TlogProofRangeError) {
    const detail: Record<string, string> = {
      epoch_too_large_for_bundle: '한 에폭의 잎이 번들 한 페이지 상한(5000)을 넘는다 — 운영자에게 문의하라(런북 §8).',
      invalid_since_epoch: 'since 는 0 이상 최신 에폭 이하의 에폭 번호다.',
    };
    return errorResponse(error.status, error.code, detail[error.code] ?? 'from ≤ to ≤ 최신 에폭이어야 한다.');
  }
  throw error;
}

/** `GET /api/logs/integrity`. */
export async function handleIntegritySummary(call: AdminCall): Promise<AdminResponse> {
  return jsonResponse(200, await integritySummary(call.deps.pool, sessionOf(call).organizationId));
}

/** `GET /api/logs/inclusion-proof?entry=&epoch=`. */
export async function handleInclusionProof(call: AdminCall): Promise<AdminResponse> {
  const entry = call.request.query['entry'];
  if (entry === undefined || !ENTRY.test(entry)) throw new AdminInputError('entry 는 로그 항목 id(양의 정수)다.', 'invalid_entry');
  const epoch = epochParam(call, 'epoch');
  try {
    return jsonResponse(200, await perOrgProof(call, (tx, organizationId) => inclusionProofFor(tx, organizationId, entry, epoch)));
  } catch (error) {
    return mapProofError(error);
  }
}

/** `GET /api/logs/consistency-proof?from=&to=`. */
export async function handleConsistencyProof(call: AdminCall): Promise<AdminResponse> {
  const from = epochParam(call, 'from');
  const to = epochParam(call, 'to');
  if (from === undefined || to === undefined) throw new AdminInputError('from 과 to(에폭 번호)가 필요하다.', 'invalid_epoch');
  try {
    return jsonResponse(200, await perOrgProof(call, (tx, organizationId) => consistencyProofFor(tx, organizationId, from, to)));
  } catch (error) {
    return mapProofError(error);
  }
}

/**
 * 신원 블록 API 의 조직당 분당 상한(L1) — 로그인·가입과 같은 모양(요청 원장 + 창 세기, admin 롤은 적고 세기만). 증명 슬롯(조직당 advisory
 * lock) 안에서 돌므로 세기와 적기가 경합하지 않는다. 넘으면 429 — 트랜잭션이 되돌아가 원장에도 남지 않는다.
 * 원장 표가 아직 없으면(새 코드가 202609242300 보다 먼저 배포된 사이 — 런북 deploy §19) 세지 않는다.
 */
async function limitIdentityBlocks(tx: Queryable, organizationId: string): Promise<void> {
  const ready = await tx.query<{ ok: boolean }>(`SELECT to_regclass('public.tlog_identity_block_requests') IS NOT NULL AS ok`);
  if (ready.rows[0]?.ok !== true) return;
  const recent = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM tlog_identity_block_requests WHERE organization_id = $1 AND requested_at > now() - interval '1 minute'`,
    [organizationId],
  );
  if ((recent.rows[0]?.n ?? 0) >= IDENTITY_BLOCKS_PER_MINUTE) throw new ProofRateLimitedError();
  await tx.query('INSERT INTO tlog_identity_block_requests (organization_id) VALUES ($1)', [organizationId]);
}

/**
 * `GET /api/agents/{agentId}/identity-blocks[?proofs=1]` — 다른 조직의 에이전트는 없는 에이전트와 같은 404(`requireAgentInOrganization`). 잎 조회는
 * `tlog_logs.organization_id` 에서 출발한다(두 겹). 증명과 같은 조직당 슬롯(한 번에 하나 — 429) + 조직당 분당 `IDENTITY_BLOCKS_PER_MINUTE`(L1).
 * `proofs=1`(콘솔 "내려받기")이면 블록마다 포함 증명과 공통 닻(서명 체크포인트)을 싣는다(M4 — `pnpm log:verify --key` 가 "증명" 으로 통과시킨다).
 */
export async function handleIdentityBlocks(call: AdminCall): Promise<AdminResponse> {
  const agentId = await requireAgentInOrganization(call.deps.pool, sessionOf(call), call.params['agentId']);
  const proofs = call.request.query['proofs'];
  if (proofs !== undefined && proofs !== '1' && proofs !== '0') throw new AdminInputError('proofs 는 1 또는 0 이다.', 'invalid_proofs');
  try {
    return jsonResponse(
      200,
      await perOrgProof(call, async (tx, organizationId) => {
        await limitIdentityBlocks(tx, organizationId);
        return identityBlocksFor(tx, organizationId, agentId, { now: call.deps.now(), proofs: proofs === '1' });
      }),
    );
  } catch (error) {
    return mapProofError(error);
  }
}

/** `GET /api/logs/bundle?from=&to=&since=` — 첨부 파일로 내려준다. */
export async function handleVerificationBundle(call: AdminCall): Promise<AdminResponse> {
  const session = sessionOf(call);
  const from = epochParam(call, 'from');
  const to = epochParam(call, 'to');
  const since = epochParam(call, 'since');
  try {
    const bundle = await audited(
      call.deps.pool,
      session,
      'logs.bundle_export',
      async (tx) => {
        await lockProofSlot(tx, session.organizationId);
        const recent = await tx.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM owner_actions WHERE organization_id = $1 AND action = 'logs.bundle_export' AND created_at > now() - interval '1 hour'`,
          [session.organizationId],
        );
        if ((recent.rows[0]?.n ?? 0) >= BUNDLE_EXPORTS_PER_HOUR) throw new ProofRateLimitedError();
        return buildVerificationBundle(tx, session.organizationId, {
          ...(from === undefined ? {} : { fromEpoch: from }),
          ...(to === undefined ? {} : { toEpoch: to }),
          ...(since === undefined ? {} : { sinceEpoch: since }),
          now: call.deps.now(),
        });
      },
      () => null,
    );
    const range = bundle['range'] as { from_epoch: number; to_epoch: number };
    const response = jsonResponse(200, bundle);
    return {
      ...response,
      headers: {
        ...response.headers,
        'content-disposition': `attachment; filename="atmark-log-bundle-${String(range.from_epoch)}-${String(range.to_epoch)}.json"`,
      },
    };
  } catch (error) {
    return mapProofError(error);
  }
}
