/**
 * §4.5-1 — **`kind: 'http'` 경로 전부가 `Idempotency-Key` 를 요구한다.**
 *
 * 케이스는 `buildIdempotencyKeyMatrix(OUTBOUND_ROUTES)` 가 만든다. 계획 §4.5 의 문장이
 * 그것이다 — *"이 규칙은 매니페스트 순회 테스트로 강제한다. `Idempotency-Key` 없이
 * 호출하면 400 을 반환하는 케이스가 **새 http 라우트마다 자동 생성**된다."*
 * r3 이전에는 `POST /v1/messages` 하나만 규칙 안에 있었고 나머지 넷이 규칙 밖으로 샜다.
 *
 * **타입은 선언을 막고 이 테스트는 집행을 막는다.** 매니페스트의 리터럴 타입
 * (`requiresIdempotencyKey: true`)은 "키 없는 http 경로를 **등록**" 하는 것을 컴파일에서
 * 막지만, 등록해 놓고 **핸들러가 헤더를 안 보는 것**은 막지 못한다. 그 절반이 여기다.
 */

import { describe, expect, it } from 'vitest';

import { handleSendDraft } from '../../../src/api/routes/draft-send';
import { handleForward } from '../../../src/api/routes/forward';
import { handleReply } from '../../../src/api/routes/reply';
import { handleSend, type SendRouteDependencies } from '../../../src/api/routes/send';
import { handleTransitionAnnouncement } from '../../../src/api/routes/transition-announcement';
import type { ApiRequest, ApiResponse } from '../../../src/api/http';
import { OUTBOUND_ROUTES } from '../../../src/policy/manifest';
import { buildIdempotencyKeyMatrix } from '../../arch/support/deny-all-matrix';
import { AGENT_ADDRESS, AGENT_ID, ALLOWED_RECIPIENT, fakeReplyTargets, harness, issuedToken, REPLY_THREAD_ID } from './support/fakes';
import { DRAFT_ID, fakeDraft } from './support/draft-fakes';
import { FORWARD_SOURCE_ID, forwardSource } from './support/forward-fakes';

/**
 * 캐스트가 없다. `SendRouteDependencies` 가 `OutboundRouteDependencies` 의 하위타입이고
 * 함수 인자는 반공변이므로, 스텁 핸들러들이 그대로 이 시그니처에 대입된다 — 즉
 * **네 경로가 같은 계약을 갖는다는 사실을 타입이 말한다.** 한 경로만 다른 의존성을
 * 요구하게 바뀌면 이 표가 컴파일되지 않는다.
 */
type HttpHandler = (deps: SendRouteDependencies, request: ApiRequest) => Promise<ApiResponse>;

const HTTP_HANDLERS: Readonly<Record<string, HttpHandler>> = {
  send: handleSend,
  // P3b — 회신은 답할 수신 메일 조회가 더 필요하다. 헤더 검사는 그 조회보다 **앞**이므로 닿지도 않는다.
  reply: (deps, request) =>
    handleReply({ ...deps, replyTargets: fakeReplyTargets(), artifacts: forwardSource().artifacts }, request, { threadId: REPLY_THREAD_ID }),
  // P3c — 원 메일 id 는 경로 파라미터다. 헤더 검사가 원 메일 조회보다 먼저이므로 가짜는 닿지도 않는다.
  forward: (deps, request) => handleForward({ ...deps, ...forwardSource() }, request, { inboundMessageId: FORWARD_SOURCE_ID }),
  // P2 — §4.5-1 의 http 경로. 헤더 검사는 관문 **앞**이므로 실제로 돈다.
  // 수신자는 seed 목록에서 온다(본문 `to` 가 아니다). 헤더 검사가 그보다 먼저이므로 목록은 닿지도 않는다.
  transition_announcement: (deps, request) =>
    handleTransitionAnnouncement(
      { ...deps, seeds: { listSeedContacts: () => Promise.resolve([ALLOWED_RECIPIENT]) } },
      request,
    ),
  // 묶음 B — 초안 보내기. 내용은 초안에서 온다(본문의 `to` 등은 보지 않는다). 헤더 검사는 초안 조회보다 **앞**이므로 초안 가짜는 닿지도 않는다.
  draft_send: (deps, request) =>
    handleSendDraft(
      {
        ...deps,
        ...fakeDraft(AGENT_ID, { from: AGENT_ADDRESS, to: [ALLOWED_RECIPIENT], subject: 'idempotency', text: '키 없이 호출했다' }),
        replyTargets: fakeReplyTargets(),
        artifacts: forwardSource().artifacts,
      },
      request,
      { draftId: DRAFT_ID },
    ),
};

const cases = buildIdempotencyKeyMatrix(OUTBOUND_ROUTES);

describe('§4.5-1 — Idempotency-Key 없이 호출하면 400', () => {
  it('매니페스트의 http 경로 전부에 케이스가 생성됐다', () => {
    const httpRouteIds = OUTBOUND_ROUTES.filter((route) => route.kind === 'http').map((route) => route.id);
    expect(cases.map((c) => c.routeId)).toEqual(httpRouteIds);
    expect(cases.length).toBeGreaterThan(0);
  });

  it('생성된 케이스마다 실제 핸들러가 존재한다 — 등록만 하고 구현이 없는 경로를 막는다', () => {
    for (const idempotencyCase of cases) {
      expect(Object.keys(HTTP_HANDLERS)).toContain(idempotencyCase.routeId);
    }
  });

  it.each(cases.map((c) => [c.name, c] as const))('%s', async (_name, idempotencyCase) => {
    const test = harness();
    const token = issuedToken();
    const handler = HTTP_HANDLERS[idempotencyCase.routeId];
    if (handler === undefined) throw new Error(`핸들러가 없다: ${idempotencyCase.routeId}`);

    const response = await handler(
      { tokens: token.store, service: test.service, transport: test.transport },
      {
        // **헤더가 없다.** 그것이 이 케이스의 전부다.
        headers: { authorization: `Bearer ${token.plaintext}` },
        query: {},
        body: {
          agent_id: AGENT_ID,
          from: AGENT_ADDRESS,
          to: [ALLOWED_RECIPIENT],
          subject: 'idempotency',
          text: '키 없이 호출했다',
        },
      },
    );

    expect(response.status).toBe(idempotencyCase.expect.status);
    expect(response.body['error']).toBe(idempotencyCase.expect.error);
    // 400 은 관문 **앞**에서 난다 — 평가도 발송도 없었어야 한다.
    expect(test.audit.rows).toHaveLength(0);
    expect(test.transport.calls()).toBe(0);
    expect(test.store.rowCount()).toBe(0);
  });
});
