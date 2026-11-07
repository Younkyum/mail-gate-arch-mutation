/**
 * src/db/repositories/policy-request-store.ts — 에이전트의 정책 변경 요청(202610131201, ADR-0007 2026-10-13)을 **앱 롤**로 만들고 읽는다.
 *
 * 만들기는 정의자 `atmark_policy_request_create` 하나다(표 INSERT 0) — 토큰 권한 · 에이전트 상태 · 재생 · 24시간 상한 · pending 상한 · 이미 그런 상태 ·
 * 자기 주소 · 오염 맥락(ADR-0016)을 DB 가 한 잠금 아래에서 본다. 이 모듈은 결과와 SQLSTATE 를 닫힌 결말로 옮길 뿐이다. 읽기는 앱 롤에 열린 칸만
 * (이유 · 토큰 · 지문 · 오염 칸은 콘솔 몫 — admin 롤).
 */

import { sqlStateOf, type Queryable } from '../client';
import type { PolicyRequestChange, PolicyRequestStatus } from '../../policy/policy-requests';

export interface PolicyRequestCreateInput {
  readonly agentId: string;
  /** 제시된 토큰의 sha256(`agent_api_keys.token_hash`) — 평문은 DB 에 가지 않는다. */
  readonly tokenHash: string;
  readonly change: PolicyRequestChange;
  readonly reason: string;
  readonly requestHash: string;
}

export interface PolicyRequestRecord {
  readonly id: string;
  readonly agentId: string;
  readonly action: string;
  readonly direction: string;
  readonly list: string | null;
  readonly value: string | null;
  readonly mode: string | null;
  readonly status: PolicyRequestStatus;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly decidedAt: Date | null;
  readonly appliedVersion: number | null;
  readonly staleReason: string | null;
}

/** 만들기 결말 — 거부는 SQLSTATE 에서(`202610131201` 머리말의 표). */
export type PolicyRequestCreateOutcome =
  | {
      readonly kind: 'created' | 'replayed';
      readonly id: string;
      readonly status: PolicyRequestStatus;
      readonly createdAt: Date;
      readonly expiresAt: Date;
      readonly baseVersion: number;
    }
  | { readonly kind: 'scope_missing' | 'agent_not_active' | 'daily_limit' | 'pending_limit' | 'no_change' | 'self_address' | 'recently_rejected' };

const REFUSALS: Readonly<Record<string, Exclude<PolicyRequestCreateOutcome['kind'], 'created' | 'replayed'>>> = {
  P0A51: 'scope_missing',
  P0A52: 'agent_not_active',
  P0A53: 'daily_limit',
  P0A54: 'pending_limit',
  P0A55: 'no_change',
  P0A56: 'self_address',
  // 같은 변경(request_hash)을 소유자가 24시간 안에 거절했다(202610131500 — 보안 감사 L-2).
  P0A58: 'recently_rejected',
};

export interface PolicyRequestStore {
  create(input: PolicyRequestCreateInput): Promise<PolicyRequestCreateOutcome>;
  /** 그 에이전트의 요청 하나. 남의 요청 · 없는 요청은 같은 `null`. */
  find(agentId: string, requestId: string): Promise<PolicyRequestRecord | null>;
}

interface Row {
  id: string;
  agent_id: string;
  action: string;
  direction: string;
  list: string | null;
  value: string | null;
  mode: string | null;
  status: PolicyRequestStatus;
  created_at: Date;
  expires_at: Date;
  decided_at: Date | null;
  applied_version: number | null;
  stale_reason: string | null;
}

export function createPostgresPolicyRequestStore(db: Queryable): PolicyRequestStore {
  return {
    async create(input) {
      const change = input.change;
      try {
        const result = await db.query<{
          outcome: 'created' | 'replayed';
          r_id: string;
          r_status: PolicyRequestStatus;
          r_created_at: Date;
          r_expires_at: Date;
          r_base_version: number;
        }>(
          'SELECT outcome, r_id, r_status, r_created_at, r_expires_at, r_base_version FROM atmark_policy_request_create($1, $2, $3, $4, $5, $6, $7, $8, $9)',
          [
            input.agentId,
            input.tokenHash,
            change.action,
            change.direction,
            change.action === 'set_mode' ? null : change.list,
            change.action === 'set_mode' ? null : change.value,
            change.action === 'set_mode' ? change.mode : null,
            input.reason,
            input.requestHash,
          ],
        );
        const row = result.rows[0];
        if (row === undefined || (row.outcome !== 'created' && row.outcome !== 'replayed')) {
          throw new Error('atmark_policy_request_create 가 결과를 돌려주지 않았다');
        }
        return {
          kind: row.outcome,
          id: row.r_id,
          status: row.r_status,
          createdAt: row.r_created_at,
          expiresAt: row.r_expires_at,
          baseVersion: row.r_base_version,
        };
      } catch (error) {
        const refusal = REFUSALS[sqlStateOf(error) ?? ''];
        if (refusal !== undefined) return { kind: refusal };
        throw error;
      }
    },
    async find(agentId, requestId) {
      const result = await db.query<Row>(
        `SELECT id::text AS id, agent_id, action, direction, list, value, mode, status, created_at, expires_at, decided_at, applied_version, stale_reason
           FROM policy_change_requests
          WHERE id = $1::uuid AND agent_id = $2`,
        [requestId, agentId],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      return {
        id: row.id,
        agentId: row.agent_id,
        action: row.action,
        direction: row.direction,
        list: row.list,
        value: row.value,
        mode: row.mode,
        status: row.status,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        decidedAt: row.decided_at,
        appliedVersion: row.applied_version,
        staleReason: row.stale_reason,
      };
    },
  };
}
