/**
 * src/admin/ops/sender-marks.ts — 소유자 수동 발신자 분류(`sender_marks`, `seen`/`cleared`). **쓰기 표면은 둘 다 소유자다:**
 *   - `pnpm sender:mark`(`scripts/sender-mark.ts`) — 운영자 CLI, 소유자 DB 롤.
 *   - `POST /api/senders`(`src/admin/routes/senders.ts`) — 소유자 세션, admin Lambda(DB 롤 `atmark_admin` — INSERT 권한 있음).
 * `recordSenderMark` 를 import 하는 프로덕션 파일은 **이 파일 하나**이고, 이 파일을 import 하는 것은 위 둘뿐이다
 * (`test/arch/sender-marks-surface.arch.test.ts`). api Lambda(앱 롤·에이전트 토큰)는 여전히 불가능하다 — 앱 롤은
 * `sender_marks` 에 SELECT 만 있고(202609230020), api 번들의 import 폐포에 `src/admin/**` 가 없다(`admin-separation`).
 *
 * 검증은 두 표면 공통(주소는 소문자화만 — `+tag` 를 자르지 않는다: 올리는 신호는 좁게). 도메인 스코프 `seen` 은
 * "그 도메인의 누구든" 이라 명시 확인을 요구한다(AC-d5 와 같은 모양, DB CHECK 가 바닥).
 */

import type { Pool } from 'pg';

import type { Queryable } from '../../db/client';
import { recordSenderMark, type SenderMarkInput } from '../../db/repositories/sender-marks-store';
import { AdminInputError } from './errors';

const ADDRESS = /^[^@\s<>]+@[^@\s<>]+$/;
const DOMAIN = /^[^@\s<>]+\.[^@\s<>]+$/;
const AGENT_ID = /^[0-9a-f]{32}$/;

interface SenderMarkRequest {
  readonly agentId: string;
  readonly scope: 'address' | 'domain';
  /** 주소(`address` 스코프) 또는 도메인(`domain` 스코프 — 앞의 `@` 는 벗긴다). */
  readonly value: string;
  readonly mark: 'seen' | 'cleared';
  readonly markedBy: string;
  /** 도메인 스코프 `seen` 의 명시 확인. */
  readonly confirmDomainScope: boolean;
}

/** 두 표면 공통 검증 → 저장 입력. */
export function resolveSenderMark(request: SenderMarkRequest): SenderMarkInput {
  const agentId = request.agentId.trim();
  if (!AGENT_ID.test(agentId)) throw new AdminInputError('agent 는 에이전트 id(hex 32)여야 한다', 'invalid_agent');
  const markedBy = request.markedBy.trim();
  if (markedBy === '' || markedBy.length > 200) throw new AdminInputError('분류한 사람(by)이 필요하다(1~200자)', 'invalid_marked_by');
  if (request.mark !== 'seen' && request.mark !== 'cleared') throw new AdminInputError('mark 는 seen | cleared', 'invalid_mark');
  if (request.scope === 'address') {
    const address = request.value.trim().toLowerCase();
    if (!ADDRESS.test(address)) throw new AdminInputError('주소 모양이 아니다', 'invalid_address');
    return { agentId, scope: 'address', address, mark: request.mark, markedBy };
  }
  if (request.scope !== 'domain') throw new AdminInputError('scope 는 address | domain', 'invalid_scope');
  const domain = request.value.trim().toLowerCase().replace(/^@/, '');
  if (!DOMAIN.test(domain)) throw new AdminInputError('도메인 모양이 아니다', 'invalid_domain');
  if (request.mark === 'seen' && !request.confirmDomainScope) {
    throw new AdminInputError('도메인 스코프 seen 은 "그 도메인의 누구든" 이다 — 명시 확인이 필요하다(CLI --confirm-scope domain · API confirmDomain: true)', 'domain_scope_unconfirmed');
  }
  return { agentId, scope: 'domain', domain, mark: request.mark, markedBy, domainScopeConfirmedBy: request.mark === 'seen' ? markedBy : null };
}

/** 기록. **소유자 롤·admin 롤 풀로만 성공한다**(앱 롤은 INSERT 권한이 없다). 새 행 id. */
export async function markSenderOp(ownerPool: Pool, input: SenderMarkInput): Promise<string> {
  return recordSenderMark(ownerPool, input);
}

interface SenderMarkView {
  /** 주소 스코프는 주소, 도메인 스코프는 `@도메인`. */
  readonly address: string;
  readonly scope: 'address' | 'domain';
  readonly mark: 'seen' | 'cleared';
  readonly markedAt: string;
}

/** 에이전트의 **유효** 분류 — (스코프, 키)별 최신 행(`cleared` 포함 — 되돌린 기록도 보인다). */
export async function listSenderMarksOp(db: Queryable, agentId: string): Promise<SenderMarkView[]> {
  const result = await db.query<{ scope: 'address' | 'domain'; address: string | null; domain: string | null; mark: 'seen' | 'cleared'; marked_at: Date }>(
    `SELECT scope, address, domain, mark, marked_at FROM (
       SELECT DISTINCT ON (scope, coalesce(address, domain)) scope, address, domain, mark, marked_at
         FROM sender_marks WHERE agent_id = $1
        ORDER BY scope, coalesce(address, domain), marked_at DESC, id DESC) latest
      ORDER BY marked_at DESC`,
    [agentId],
  );
  return result.rows.map((row) => ({
    address: row.scope === 'address' ? (row.address ?? '') : `@${row.domain ?? ''}`,
    scope: row.scope,
    mark: row.mark,
    markedAt: row.marked_at.toISOString(),
  }));
}
