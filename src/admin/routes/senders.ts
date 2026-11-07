/**
 * src/admin/routes/senders.ts — `GET /api/senders?agent=` · `POST /api/senders` (소유자 수동 발신자 분류).
 *
 * `sender_marks` 의 두 번째 쓰기 표면이다 — 첫째는 운영자 CLI(`pnpm sender:mark`). 둘 다 **소유자**이고 같은 검증·기록 함수
 * (`src/admin/ops/sender-marks.ts`)를 부른다. 에이전트 토큰(api Lambda, 앱 롤)에는 여전히 경로가 없다.
 */

import { markSenderOp, listSenderMarksOp, resolveSenderMark } from '../ops/sender-marks';
import { AdminInputError } from '../ops/errors';
import { actorOfSession, audited, objectBody, requireAgentInOrganization, sessionOf, type AdminCall } from '../context';
import { displayAddress } from '../display';
import { jsonResponse, type AdminResponse } from '../http';

export async function handleListSenders(call: AdminCall): Promise<AdminResponse> {
  const agentId = await requireAgentInOrganization(call.deps.pool, sessionOf(call), call.request.query['agent']);
  const marks = await listSenderMarksOp(call.deps.pool, agentId);
  // 발신자 주소는 외부가 정한 문자열이다 — 표시 규칙으로 한 번 거른다.
  return jsonResponse(200, marks.map((mark) => ({ ...mark, address: displayAddress(mark.address) })));
}

/** `{agentId, address, mark:'seen'|'cleared', scope?:'address'|'domain', confirmDomain?}` → 201 `{id}` */
export async function handleMarkSender(call: AdminCall): Promise<AdminResponse> {
  const session = sessionOf(call);
  const body = objectBody(call.request.body);
  const agentId = await requireAgentInOrganization(call.deps.pool, session, body['agentId']);
  const { address, mark, scope, confirmDomain } = body;
  if (typeof address !== 'string') throw new AdminInputError('address 는 문자열이다.', 'invalid_address');
  if (mark !== 'seen' && mark !== 'cleared') throw new AdminInputError("mark 는 'seen' | 'cleared' 다.", 'invalid_mark');
  if (scope !== undefined && scope !== 'address' && scope !== 'domain') throw new AdminInputError("scope 는 'address' | 'domain' 이다.", 'invalid_scope');
  const input = resolveSenderMark({
    agentId,
    scope: scope ?? 'address',
    value: address,
    mark,
    markedBy: actorOfSession(session),
    confirmDomainScope: confirmDomain === true,
  });
  const id = await audited(call.deps.pool, session, 'sender.mark', (tx) => markSenderOp(tx, input), (markId) => markId);
  return jsonResponse(201, { id });
}
