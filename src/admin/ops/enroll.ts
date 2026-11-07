/**
 * src/admin/ops/enroll.ts — **자가 등록 실행**(admin λ — ADR-0016 2026-10-08 개정 "자가 등록" · 이벤트 모양 `runtime/enroll-event.ts`).
 *
 * api λ 가 `POST /v1/agents` · MCP `create_agent` 를 받아 토큰 · 권한 · 입력을 한 번 본 뒤 이 연산을 내부 이벤트로 부른다. **여기서 처음부터 다시 판정한다** —
 * api λ 를 믿지 않는다:
 *   ① 토큰 원문 → sha256 → `agent_api_keys`(살아 있음 · 만료 전 · `agents:enroll`). 부른 에이전트는 그 토큰의 에이전트다.
 *   ② 슬롯 INSERT(`agent_enrollments` pending) — **DB 트리거가** 토큰 · 에이전트 active · 조직 active(검토 끝 · 소유자 정지 · 플랫폼 동결 없음) · 조직 설정 켜짐 ·
 *      지난 24시간 시도 < 하루 상한(조직 잠금 아래)을 다시 본다. 키 보관 **전**이다.
 *   ③ 프로비저닝 — 콘솔 · 조직 키와 **같은 연산**(`provisionAgentOp` — 요금제 한도 · 검토 전 상한 · 로컬파트 검증 · 예약 로컬파트 거부 · 주소 가용성 · custody).
 *      **안전 기본값 고정:** 발신 allowlist_only(빈 목록) · 수신 all · 발신 승인 always · 토큰 `messages:send`·`messages:read`·`agent:read_self` 뿐(연쇄 금지 —
 *      `agents:enroll` 은 DB 트리거가 그 에이전트에게 영영 막는다).
 *   ④ 위험 처리 `hold`(정의자 `atmark_watch_set_agent`).
 *   ⑤ 슬롯을 created(또는 쓸 수 없는 주소면 taken — 그 시도도 하루 상한에 센다)로 끝낸다 — 트리거가 `notify_on_enroll` 이면 알림 창에 넣는다.
 * 한 트랜잭션이다(②~⑤). 요금제 한도 · 입력 오류는 던져서 되돌린다(슬롯도 사라진다 — 탐침이 아니다). 감사 행 = `agent_enrollments` 한 행(append-only).
 * 토큰 원문 · 새 토큰은 로그에 싣지 않는다.
 */

import { randomBytes } from 'node:crypto';

import type { Pool } from 'pg';

import { withTransaction } from '../../db/client';
import { toAgentId } from '../../db/schema';
import { ENROLLED_AGENT_TOKEN_CAPABILITIES, hashAgentToken } from '../../identity/agent-token';
import { log } from '../../observability/logger';
import type { KeyCustody } from '../../passport/custody';
import { ENROLL_NAME_MAX, type EnrollEvent, type EnrollRefusal, type EnrollResult } from '../../runtime/enroll-event';
import { INVISIBLE_OR_CONTROL_CHARACTERS } from '../display';
import { DEFAULT_BUDGET_CENTS, provisionAgentOp } from './agents';
import { AdminInputError, sqlStateOf } from './errors';
import { transactionPool } from './transaction';

const ROUTE_ID = 'internal:agent.enroll';

/** DB 트리거의 SQLSTATE → 거절 코드(202610081101). */
const TRIGGER_REFUSALS: Readonly<Record<string, EnrollRefusal>> = {
  P0A31: 'scope_missing',
  P0A32: 'not_active',
  P0A33: 'self_enroll_disabled',
  P0A34: 'enroll_daily_cap',
  P0A35: 'chain_forbidden',
  P0A36: 'replayed',
};

/** 프로비저닝 오류 코드 → 거절 코드. */
const PROVISION_REFUSALS: Readonly<Record<string, EnrollRefusal>> = {
  agent_limit: 'agent_limit',
  agent_total_limit: 'agent_limit',
  invalid_local_part: 'invalid_local_part',
  address_probe_limit: 'address_taken',
  conflict: 'address_taken',
  invalid_request: 'invalid_name',
};

/** 동시 재생 — 요청 id UNIQUE 색인의 23505(다른 UNIQUE 와 가른다). */
function isReplayConflict(error: unknown): boolean {
  return sqlStateOf(error) === '23505' && (error as { constraint?: unknown }).constraint === 'agent_enrollments_request_id_key';
}

class Refused extends Error {
  constructor(readonly refusal: EnrollRefusal) {
    super(refusal);
    this.name = 'EnrollRefused';
  }
}

/** 에이전트가 고른 이름 — 앞뒤 공백 · 겹친 공백을 접고, 제어 · 보이지 않는 문자는 거부(알림 메일 · 콘솔에 실린다). */
export function enrollNameOf(raw: string): string | null {
  const name = raw.replace(/\s+/gu, ' ').trim();
  if (name.length < 1 || [...name].length > ENROLL_NAME_MAX || INVISIBLE_OR_CONTROL_CHARACTERS.test(name)) return null;
  return name;
}

/** 로컬파트를 주지 않았으면 — `agent-` + 난수 8 hex(예약 · 앵커 모양과 겹치지 않는다). */
export function generatedLocalPart(): string {
  return `agent-${randomBytes(4).toString('hex')}`;
}

/**
 * 콘솔이 `agents:enroll` 토큰을 줄 수 있는 에이전트인가 — 자가 등록으로 태어난 에이전트는 아니다(연쇄 금지 — DB 트리거 `agent_api_keys_no_enroll_chain` 가 같은
 * 것을 막는다; 여기서는 500 대신 409 로 답하려고 먼저 본다).
 */
export async function requireEnrollGrantable(db: Pick<Pool, 'query'>, agentId: string): Promise<void> {
  const found = await db.query('SELECT 1 FROM agent_enrollments WHERE child_agent_id = $1', [agentId]);
  if ((found.rowCount ?? 0) > 0) {
    throw new AdminInputError('자가 등록으로 만든 에이전트에는 agents:enroll 을 줄 수 없다(연쇄 금지).', 'enroll_chain_forbidden', 409);
  }
}

export async function enrollAgentOp(pool: Pool, custody: KeyCustody, event: EnrollEvent): Promise<EnrollResult> {
  const name = enrollNameOf(event.name);
  if (name === null) return { ok: false, error: 'invalid_name' };
  const localPart = event.localPart ?? generatedLocalPart();
  try {
    return await withTransaction(pool, async (client) => {
      // ① 토큰 — 해시로만 찾는다. 원문은 이 함수 밖으로 나가지 않는다.
      const found = await client.query<{ id: string; agent_id: string; organization_id: string; enroll: boolean }>(
        `SELECT k.id::text AS id, k.agent_id, a.organization_id::text AS organization_id,
                ('agents:enroll'::agent_token_capability = ANY (k.capabilities)) AS enroll
           FROM agent_api_keys k JOIN agents a ON a.id = k.agent_id
          WHERE k.token_hash = $1 AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now())`,
        [hashAgentToken(event.token)],
      );
      const key = found.rows[0];
      if (key === undefined) throw new Refused('unauthorized');
      if (!key.enroll) throw new Refused('scope_missing');

      // ② 슬롯 — 트리거가 다시 판정한다(머리말).
      const slot = await client.query<{ id: string }>(
        'INSERT INTO agent_enrollments (organization_id, parent_agent_id, parent_token_id, request_id) VALUES ($1, $2, $3::uuid, $4) RETURNING id::text AS id',
        [key.organization_id, key.agent_id, key.id, event.requestId],
      );
      const slotId = slot.rows[0]?.id;
      if (slotId === undefined) throw new Error('agent_enrollments 슬롯 id 가 없다');

      // ③ 프로비저닝 — 콘솔과 같은 연산 · 안전 기본값 고정.
      const tx = transactionPool(client);
      const outcome = await provisionAgentOp(
        tx,
        {
          organizationId: key.organization_id,
          name,
          localPart,
          seeds: [],
          budgetCents: DEFAULT_BUDGET_CENTS,
          createdBy: `agent:${key.agent_id}`,
          requireApproval: true,
          // 안전 기본값 고정 — 소유자가 만드는 에이전트의 새 기본값(전체, 2026-10-13)을 따르지 않는다.
          outboundMode: 'allowlist_only',
          tokenCapabilities: ENROLLED_AGENT_TOKEN_CAPABILITIES,
        },
        custody,
      );
      if (outcome.kind === 'taken') {
        await client.query(`UPDATE agent_enrollments SET outcome = 'taken' WHERE id = $1::uuid`, [slotId]);
        return { ok: false, error: 'address_taken' } as const;
      }
      const child = outcome.agent;
      // ④ 위험 등급 메일은 보류(소유자가 풀 때까지 숨김).
      await client.query('SELECT outcome FROM atmark_watch_set_agent($1, $2, $3, NULL, NULL)', [key.organization_id, child.id, 'hold']);
      // ⑤ 끝내기 — 트리거가 알림 창에 넣는다.
      await client.query(`UPDATE agent_enrollments SET outcome = 'created', child_agent_id = $2 WHERE id = $1::uuid`, [slotId, child.id]);
      log('info', 'agent.enrolled', { route_id: ROUTE_ID, agent_id: toAgentId(key.agent_id), outcome: 'created', detail: `child=${child.id}` });
      return {
        ok: true,
        agent: { id: child.id, name: child.name, address: child.address ?? '' },
        token: outcome.token,
        scopes: [...ENROLLED_AGENT_TOKEN_CAPABILITIES],
        policyVersion: outcome.policyVersion,
      } as const;
    });
  } catch (error) {
    const refusal =
      error instanceof Refused
        ? error.refusal
        : error instanceof AdminInputError
          ? (PROVISION_REFUSALS[error.code] ?? null)
          : isReplayConflict(error)
            ? 'replayed'
            : (TRIGGER_REFUSALS[sqlStateOf(error) ?? ''] ?? null);
    if (refusal === null) throw error;
    log('info', 'agent.enroll_refused', { route_id: ROUTE_ID, outcome: 'refused', reason: refusal });
    return { ok: false, error: refusal };
  }
}
