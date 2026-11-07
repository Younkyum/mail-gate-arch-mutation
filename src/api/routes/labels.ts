/**
 * 라벨(묶음 B) — `PUT /v1/messages/inbound/{id}/labels` · `GET /v1/labels`. 필터는 목록(`GET /v1/messages/inbound?label=…|unlabeled=true|read=…`).
 *
 * **이 파일은 `NON_SENDING_ENTRYPOINTS` 에 있다.** 받은 메일의 에이전트 상태 행(`inbound_message_state`) 하나를 쓸 뿐 보내지 않는다 — 관문을 import 하지
 * 않는다. 라벨은 판정의 입력이 아니다(정책 · 위험 · 승인 어디에도 쓰이지 않는다).
 *
 * - **권한은 `messages:read`** — 자기 받은편지함을 정리하는 일이다(보내지 않는다).
 * - **격리 메일은 없다.** 라벨을 붙일 수 없고(없는 메일과 같은 404) 목록에도 세지 않는다 — 저장소가 `visibleToAgent` 로 거른다.
 * - 라벨 모양: 소문자 `[a-z0-9][a-z0-9._-]{0,63}` · 메일당 20 · 에이전트당 서로 다른 200.
 * - 본문은 둘 중 하나: `{ "labels": [...] }`(그 집합으로 바꾼다) 또는 `{ "add": [...], "remove": [...] }`(더하고 뺀다).
 * - 대상 에이전트: 바꾸기는 토큰의 에이전트로 묶어 찾는다(남의 메일 id 는 없는 것과 같다), 목록은 `agent_id` 쿼리(생략 = 토큰의 에이전트).
 */

import {
  LABEL_PATTERN,
  MAX_DISTINCT_LABELS_PER_AGENT,
  MAX_LABELS_PER_MESSAGE,
  type MessageStateStore,
} from '../../db/repositories/message-state-store';
import type { AgentTokenStore } from '../../identity/agent-token';
import { authorizeAgentRequest, claimedAgentOfQuery } from '../auth';
import { errorResponse, isJsonObject, jsonResponse, UUID_PATTERN, type ApiRequest, type ApiResponse } from '../http';

export interface LabelRouteDependencies {
  readonly tokens: AgentTokenStore;
  readonly messageState: MessageStateStore;
  readonly now: () => Date;
}

const LABEL_RULE = 'lowercase letters, digits, ".", "_" or "-", 1-64 characters, starting with a letter or digit';

function labelList(value: unknown, key: string): readonly string[] | string {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return `${key} must be an array of labels.`;
  const labels = (value as string[]).map((item) => item.trim());
  const bad = labels.find((label) => !LABEL_PATTERN.test(label));
  if (bad !== undefined) return `${key} has an invalid label ${JSON.stringify(bad.slice(0, 70))}: use ${LABEL_RULE}.`;
  if (new Set(labels).size > MAX_LABELS_PER_MESSAGE) return `${key} can have at most ${String(MAX_LABELS_PER_MESSAGE)} labels.`;
  return [...new Set(labels)];
}

export async function handleSetMessageLabels(
  deps: LabelRouteDependencies,
  request: ApiRequest,
  params: { readonly inboundMessageId: string },
): Promise<ApiResponse> {
  if (!UUID_PATTERN.test(params.inboundMessageId)) return errorResponse(400, 'invalid_request', 'message id must be a lowercase uuid.');
  const body = request.body;
  if (!isJsonObject(body)) return errorResponse(400, 'invalid_request', 'The request body must be a JSON object.');
  const source = body;
  const unknown = Object.keys(source).find((key) => !['labels', 'add', 'remove', 'agent_id'].includes(key));
  if (unknown !== undefined) return errorResponse(400, 'invalid_request', `Unknown field: ${unknown.slice(0, 40)}`);
  const replacing = source['labels'] !== undefined;
  const changing = source['add'] !== undefined || source['remove'] !== undefined;
  if (replacing === changing) return errorResponse(400, 'invalid_request', 'Send either labels (the new set) or add/remove (changes), not both.');

  const access = await authorizeAgentRequest(deps.tokens, request, deps.now(), 'messages:read', null);
  if (access.kind === 'error') return access.response;
  const { agentId } = access;
  if (source['agent_id'] !== undefined && source['agent_id'] !== agentId) {
    return errorResponse(400, 'path_body_mismatch', 'agent_id in the body does not match the agent of your token.');
  }

  let change: { readonly replace?: readonly string[]; readonly add?: readonly string[]; readonly remove?: readonly string[] };
  if (replacing) {
    const labels = labelList(source['labels'], 'labels');
    if (typeof labels === 'string') return errorResponse(400, 'invalid_label', labels);
    change = { replace: labels };
  } else {
    const add = source['add'] === undefined ? [] : labelList(source['add'], 'add');
    if (typeof add === 'string') return errorResponse(400, 'invalid_label', add);
    const remove = source['remove'] === undefined ? [] : labelList(source['remove'], 'remove');
    if (typeof remove === 'string') return errorResponse(400, 'invalid_label', remove);
    change = { add, remove };
  }

  const outcome = await deps.messageState.setLabels(agentId, params.inboundMessageId, change);
  if (outcome.kind === 'not_found') return errorResponse(404, 'message_not_found', `No received email with message_id=${params.inboundMessageId}.`);
  if (outcome.kind === 'message_label_limit') {
    return errorResponse(400, 'label_limit', `An email can have at most ${String(MAX_LABELS_PER_MESSAGE)} labels.`);
  }
  if (outcome.kind === 'agent_label_limit') {
    return errorResponse(409, 'agent_label_limit', `This agent already uses ${String(MAX_DISTINCT_LABELS_PER_AGENT)} different labels. Reuse an existing label (GET /v1/labels) or remove one everywhere first.`);
  }
  return jsonResponse(200, { message_id: params.inboundMessageId, labels: [...outcome.labels] });
}

export async function handleListLabels(deps: LabelRouteDependencies, request: ApiRequest): Promise<ApiResponse> {
  // `agent_id` 생략 = 토큰의 에이전트(`auth.claimedAgentOfQuery`). 적었으면 형식 검사(400)는 인증 전, 인가는 그 값으로.
  const claimed = claimedAgentOfQuery(request);
  if (claimed.kind === 'error') return claimed.response;
  const access = await authorizeAgentRequest(deps.tokens, request, deps.now(), 'messages:read', claimed.agentId);
  if (access.kind === 'error') return access.response;
  const { agentId } = access;
  const labels = await deps.messageState.listLabels(agentId);
  return jsonResponse(200, {
    agent_id: agentId,
    labels: labels.map((entry) => ({ label: entry.label, count: entry.count, unread: entry.unread })),
    limits: { per_message: MAX_LABELS_PER_MESSAGE, per_agent: MAX_DISTINCT_LABELS_PER_AGENT },
  });
}
