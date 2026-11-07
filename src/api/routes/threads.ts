/**
 * `GET /v1/threads/{id}` — **권한용 스레드**의 발신·수신을 시간순으로 (P3c, AC-4).
 *
 * **이 파일은 `NON_SENDING_ENTRYPOINTS` 에 있다.** 읽기만 하며 관문을 import 하지 않는다. (같은 접두사의
 * `POST /v1/threads/{id}/reply` 는 `reply.ts` — 발송 경로이고 매니페스트의 다른 범주다.)
 *
 * - 스레드는 `thread_id`(권한용)다. 표시용 묶음(`display_thread_id`)은 여기 쓰지 않는다 — 회신이 권한을 얻는 단위와
 *   에이전트가 보는 단위가 같아야 "이 스레드에 답한다" 가 한 뜻이 된다.
 * - **격리 수신은 항목에 없다** — 그 스레드의 격리 개수만(`quarantined.count`). 항목이 하나도 보이지 않는 스레드
 *   (격리 메일 한 통으로 열린 외부 스레드)는 **없는 스레드와 같은 404** 다: 스레드 id 자체가 격리 메일의 존재를
 *   알리는 식별자가 되지 않게.
 * - 인가는 스레드 행의 `agent_id` 로.
 */

import { authenticateRequest, authorizeRequest } from '../auth';
import { codesIn, recordExposureLevels } from '../exposure';
import { errorResponse, jsonResponse, UUID_PATTERN, type ApiRequest, type ApiResponse } from '../http';
import { riskBody, stateBody, threadBody, type InboundReadDependencies } from '../inbound-view';

export async function handleGetThread(
  deps: InboundReadDependencies,
  request: ApiRequest,
  params: { readonly threadId: string },
): Promise<ApiResponse> {
  if (!UUID_PATTERN.test(params.threadId)) {
    return errorResponse(400, 'invalid_request', 'thread id must be a lowercase uuid.');
  }
  const authentication = await authenticateRequest(deps.tokens, request, deps.now());
  if (authentication.kind === 'error') return authentication.response;

  const view = await deps.inbound.threadView(params.threadId);
  const notFound = errorResponse(404, 'thread_not_found', `No thread with thread_id=${params.threadId}.`);
  if (view === null) return notFound;
  const forbidden = authorizeRequest(authentication.principal, 'messages:read', view.agentId);
  if (forbidden !== null) return forbidden;
  if (view.entries.length === 0) return notFound;

  // ADR-0016 A — 받은 메일 항목(발신자·제목)이 보이기 **전에** 노출을 기록한다(실패 503). 제목 속 코드 후보의 지문도(배선 계약 3).
  const inbound = view.entries.filter((entry) => entry.direction === 'inbound');
  const recorded = await recordExposureLevels(
    deps.exposures,
    view.agentId,
    'thread',
    inbound.map((entry) => ({ inboundMessageId: entry.id, part: 'subject' as const, field: 'subject' as const, content: null })),
    inbound.flatMap((entry) => codesIn(entry.id, { subject: entry.subject, text: '', htmlText: null })),
  );
  if (recorded.kind === 'refused') return recorded.response;

  // 묶음 B — 받은 메일 항목마다 `risk` · 라벨 · 읽음. 노출 등급은 항목 순서다.
  const facts = await deps.messageState.riskFacts(view.agentId, inbound.map((entry) => entry.id));
  const taints = new Map(inbound.map((entry, index) => [entry.id, recorded.levels[index] ?? null]));
  const body = threadBody(view);
  const messages = (body['messages'] as readonly Record<string, unknown>[]).map((entry, index) => {
    const source = view.entries[index];
    if (source === undefined || source.direction !== 'inbound') return entry;
    return { ...entry, ...stateBody(facts.get(source.id)), risk: riskBody(facts.get(source.id), source.injectionRisk, taints.get(source.id) ?? null) };
  });
  return jsonResponse(200, { ...body, messages });
}
