/**
 * 발송 경로의 **허용 방향** — 막히지 않을 때 무슨 일이 일어나는가.
 *
 * `deny-all-matrix.test.ts` 가 거부 축 전수를 보고, 여기서는 그 반대편을 본다:
 *   - `send` 는 실제로 전송단을 부르고 결과를 `messages` 행에 **확정한다**
 *     (관문은 반환만 하고 저장하지 않는다 — `settleSent` 를 부르는 것은 호출자다).
 *   - 같은 `Idempotency-Key` 의 재호출은 **새 평가도 새 발송도 새 audit 행도 만들지 않는다**.
 *   - 같은 키에 다른 요청이 오면 **409** 다. 최초 결과를 조용히 돌려주면 그 차이는
 *     어디에도 남지 않는다(수신자 집합은 `messages` 에 컬럼 자체가 없다).
 *   - 미구현 스텁 3종은 **관문을 지난 뒤** 501 이 된다 — 위상은 축소되지 않는다.
 */

import { describe, expect, it } from 'vitest';

import { handleForward } from '../../../src/api/routes/forward';
import { handleSend } from '../../../src/api/routes/send';
import type { ApiRequest } from '../../../src/api/http';
import { SEND_FAILED_DETAIL } from '../../../src/api/outbound-http';
import type { OutboundTransport } from '../../../src/policy/gate';
import { runScheduledSend } from '../../../src/workers/scheduled-sender';
import { FORWARD_SOURCE_ID, forwardSource } from './support/forward-fakes';
import { AGENT_ADDRESS, AGENT_ID, ALLOWED_RECIPIENT, harness, issuedToken } from './support/fakes';

interface RequestOptions {
  readonly token: string;
  readonly key: string;
  readonly subject?: string;
  readonly to?: readonly string[];
}

function request(options: RequestOptions): ApiRequest {
  return {
    headers: { authorization: `Bearer ${options.token}`, 'idempotency-key': options.key },
    query: {},
    body: {
      agent_id: AGENT_ID,
      from: AGENT_ADDRESS,
      to: [...(options.to ?? [ALLOWED_RECIPIENT])],
      subject: options.subject ?? 'hello',
      text: '본문',
    },
  };
}

describe('POST /v1/messages — 허용 경로', () => {
  it('발송되고, 결과가 messages 행에 확정되고, audit 이 해소된다', async () => {
    const test = harness();
    const token = issuedToken();

    const response = await handleSend(
      { tokens: token.store, service: test.service, transport: test.transport },
      request({ token: token.plaintext, key: 'k1' }),
    );

    expect(response.status).toBe(200);
    expect(response.body['status']).toBe('sent');
    expect(response.body['provider_message_id']).toMatch(/^fake-ses-/);
    // **관문이 아니라 우리가 확정했다.** `settled: false` 면 lease 를 잃은 것이다.
    expect(response.body['settled']).toBe(true);

    expect(test.transport.calls()).toBe(1);
    expect(test.audit.rows).toHaveLength(1);
    expect(test.audit.rows[0]?.decision.verdict).toBe('allowed');
    expect([...(test.audit.rows[0]?.decision.reasons ?? [])]).toContain('allowlist_match');
    expect(test.audit.resolutions).toEqual([{ auditId: 'audit-1', outcome: 'sent', reason: null }]);
  });

  it('Message-ID 를 전송 전에 확정하고 그 값이 응답에 그대로 나온다 (§4.5-4)', async () => {
    const test = harness();
    const token = issuedToken();

    const response = await handleSend(
      { tokens: token.store, service: test.service, transport: test.transport },
      request({ token: token.plaintext, key: 'k-msgid' }),
    );

    const header = response.body['message_id_header'];
    expect(typeof header).toBe('string');
    expect(header).toMatch(/^<[^<>\s]+@atmark\.ai>$/);
  });

  it('같은 키·같은 요청의 재호출 — SES 1회, messages 1행, audit 1행 (AC-i1)', async () => {
    const test = harness();
    const token = issuedToken();
    const deps = { tokens: token.store, service: test.service, transport: test.transport };

    const first = await handleSend(deps, request({ token: token.plaintext, key: 'same' }));
    const second = await handleSend(deps, request({ token: token.plaintext, key: 'same' }));
    const third = await handleSend(deps, request({ token: token.plaintext, key: 'same' }));

    expect(second.body['replayed']).toBe(true);
    expect(third.body['replayed']).toBe(true);
    expect(second.body['message_id']).toBe(first.body['message_id']);
    expect(test.transport.calls()).toBe(1);
    expect(test.audit.rows).toHaveLength(1);
    expect(test.store.rowsFor(AGENT_ID, 'same')).toBe(1);
  });

  it('거부된 시도의 재호출은 **최초와 같은 403** 이다 (§4.5-1)', async () => {
    const test = harness();
    const token = issuedToken();
    const deps = { tokens: token.store, service: test.service, transport: test.transport };
    const blocked = { token: token.plaintext, key: 'denied-once', to: ['stranger@example.com'] };

    const first = await handleSend(deps, request(blocked));
    const second = await handleSend(deps, request(blocked));

    expect(first.status).toBe(403);
    // **P1b 리뷰 MAJOR 3 의 회귀 테스트.** 예전에는 재호출이 202 를 받았다 —
    // §4.5-1(*"동일 키 재호출은 최초 결과를 그대로 반환"*) 위반이고, 202 를 받은
    // 클라이언트는 영원히 나가지 않을 메일을 기다렸다.
    expect(second.status).toBe(403);
    expect(second.body['error']).toBe('policy_denied');
    expect(second.body['status']).toBe('denied');
    expect(second.body['replayed']).toBe(true);
    // 판정의 *내용*(reasons·retry_after)은 audit 에 있다 — 응답이 그 자리를 가리킨다.
    expect(String(second.body['detail'])).toContain('/v1/audit');
    // 재호출은 새 평가도 새 발송도 만들지 않는다.
    expect(test.audit.rows).toHaveLength(1);
    expect(test.transport.calls()).toBe(0);
    // 행은 종단이다 — "정책이 막았다" 를 messages 가 말할 수 있게 됐다.
    const row = await test.store.messages.findById(first.body['message_id'] as string);
    expect(row?.status).toBe('denied');
  });

  it('실패로 끝난 시도의 재호출은 502 다 — 원인 문장(내부 사유)은 응답에 싣지 않고 공개 문장만 준다', async () => {
    const test = harness();
    const token = issuedToken();
    // 관문을 지난 뒤 전송단이 던지면 `failed` 로 확정된다. 던지는 문장은 내부 사유다 — 응답에 실리면 안 된다.
    const INTERNAL_CAUSE = 'transport exploded: internal detail';
    const throwing: OutboundTransport = { send: () => Promise.reject(new Error(INTERNAL_CAUSE)) };
    const deps = { tokens: token.store, service: test.service, transport: throwing };
    const first = await handleSend(deps, request({ token: token.plaintext, key: 'failed-once' }));
    const second = await handleSend(deps, request({ token: token.plaintext, key: 'failed-once' }));

    expect(first.status).toBe(502);
    expect(second.status).toBe(502);
    expect(second.body['status']).toBe('failed');
    expect(second.body['error']).toBe('send_failed');
    expect(second.body['detail']).toBe(SEND_FAILED_DETAIL);
    expect(JSON.stringify(first.body)).not.toContain(INTERNAL_CAUSE);
    expect(JSON.stringify(second.body)).not.toContain(INTERNAL_CAUSE);
    // 원인은 행에 남는다(운영자·콘솔용).
    const row = await test.store.messages.findById(second.body['message_id'] as string);
    expect(row?.failureReason).toContain(INTERNAL_CAUSE);
  });

  it('같은 키에 다른 요청이 오면 409 — 차이를 조용히 삼키지 않는다', async () => {
    const test = harness();
    const token = issuedToken();
    const deps = { tokens: token.store, service: test.service, transport: test.transport };

    await handleSend(deps, request({ token: token.plaintext, key: 'reused', subject: '첫 번째' }));
    const conflict = await handleSend(
      deps,
      request({ token: token.plaintext, key: 'reused', subject: '두 번째' }),
    );

    expect(conflict.status).toBe(409);
    expect(conflict.body['error']).toBe('idempotency_key_reused');
    // 두 번째 시도는 평가도 발송도 하지 않는다.
    expect(test.transport.calls()).toBe(1);
    expect(test.audit.rows).toHaveLength(1);
  });
});

describe('인증·인가', () => {
  it('토큰이 없으면 401 — 관문에 닿지 않는다', async () => {
    const test = harness();
    const response = await handleSend(
      { tokens: issuedToken().store, service: test.service, transport: test.transport },
      { headers: { 'idempotency-key': 'k' }, query: {}, body: {} },
    );

    expect(response.status).toBe(401);
    expect(test.audit.rows).toHaveLength(0);
  });

  it('남의 에이전트로 보내려 하면 403 — Stage 1 에 닿기도 전에 막힌다 (§47)', async () => {
    const test = harness();
    const token = issuedToken();
    const response = await handleSend(
      { tokens: token.store, service: test.service, transport: test.transport },
      {
        headers: { authorization: `Bearer ${token.plaintext}`, 'idempotency-key': 'k' },
        query: {},
        body: {
          agent_id: 'ffffffffffffffffffffffffffffffff',
          from: AGENT_ADDRESS,
          to: [ALLOWED_RECIPIENT],
          subject: 's',
          text: 't',
        },
      },
    );

    expect(response.status).toBe(403);
    expect(response.body['detail']).toBe('not_own_agent');
    expect(test.audit.rows).toHaveLength(0);
    expect(test.transport.calls()).toBe(0);
  });
});

describe('scheduled_send 워커 — 관문을 지나 실제로 보낸다', () => {
  // 남은 스텁이 없다 — `reply`(P3b)·`forward`(P3c)·`scheduled_send`(P3c)는 실경로이고, 초안 발송 스텁은 공개 라우터에서 뺐다(2026-09-28).

  it('scheduled_send 워커(P3c 실동작) — 실제로 보내고, 잡의 멱등 키가 중복 전달을 막는다', async () => {
    const test = harness();

    const first = await runScheduledSend(
      { service: test.service, transport: test.transport },
      {
        agentId: AGENT_ID,
        idempotencyKey: 'schedule-1:2026-10-15T12:00Z',
        fromAddress: AGENT_ADDRESS,
        recipients: [ALLOWED_RECIPIENT],
        subject: '예약 발송',
        text: '본문',
        html: null,
        traceId: null,
        costCents: 0,
      },
    );

    expect(first.kind).toBe('sent');
    expect(test.audit.rows).toHaveLength(1);
    expect(test.transport.calls()).toBe(1);

    // 같은 잡이 재전달됐다 — 키가 같으므로 새 행도 새 평가도 새 발송도 없다.
    const redelivered = await runScheduledSend(
      { service: test.service, transport: test.transport },
      {
        agentId: AGENT_ID,
        idempotencyKey: 'schedule-1:2026-10-15T12:00Z',
        fromAddress: AGENT_ADDRESS,
        recipients: [ALLOWED_RECIPIENT],
        subject: '예약 발송',
        text: '본문',
        html: null,
        traceId: null,
        costCents: 0,
      },
    );

    expect(redelivered.kind).toBe('replayed');
    expect(test.audit.rows).toHaveLength(1);
    expect(test.transport.calls()).toBe(1);
    expect(test.store.rowsFor(AGENT_ID, 'schedule-1:2026-10-15T12:00Z')).toBe(1);
  });
});

describe('forward (P3c) — 관문을 지나 실제로 보낸다', () => {
  function forwardRequest(token: string, key: string, extra: Record<string, unknown> = {}): ApiRequest {
    return {
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': key },
      query: {},
      body: { agent_id: AGENT_ID, from: AGENT_ADDRESS, to: [ALLOWED_RECIPIENT], ...extra },
    };
  }

  it('보이는(none) 원 메일 → 제3자 전달은 받은 메일 복사(ADR-0016 리뷰 H3) → 소유자 승인 · audit 1행 · 원 메일 본문이 전달 본문에 있다', async () => {
    const test = harness();
    const token = issuedToken();
    const response = await handleForward(
      { tokens: token.store, service: test.service, transport: test.transport, ...forwardSource({ text: 'ORIGINAL-BODY-7' }) },
      forwardRequest(token.plaintext, 'fwd-1', { text: '참고하세요' }),
      { inboundMessageId: FORWARD_SOURCE_ID },
    );
    expect(response.status).toBe(202);
    expect(response.body['forwarded_from']).toBe(FORWARD_SOURCE_ID);
    expect(test.transport.calls()).toBe(0);
    expect(test.audit.rows).toHaveLength(1);
    expect(test.audit.rows[0]?.decision.verdict).toBe('pending_approval');
    expect(test.audit.rows[0]?.decision.reasons).toContain('dlp_inbound_copy');
    const messageId = String(response.body['message_id']);
    const content = await test.service.content.load(messageId);
    expect(content.subject).toBe('Fwd: 원 메일');
    expect(content.text).toContain('참고하세요');
    expect(content.text).toContain('ORIGINAL-BODY-7');
    expect(content.html).toBeNull();
  });

  it.each(['low', 'medium', 'high'] as const)('★ injection_risk=%s 원 메일은 전달하지 않는다 — 422 · 관문 앞 · 전송 0', async (risk) => {
    const test = harness();
    const token = issuedToken();
    const response = await handleForward(
      { tokens: token.store, service: test.service, transport: test.transport, ...forwardSource({ injectionRisk: risk }) },
      forwardRequest(token.plaintext, `fwd-risk-${risk}`),
      { inboundMessageId: FORWARD_SOURCE_ID },
    );
    expect(response.status).toBe(422);
    expect(response.body['error']).toBe('forward_refused_injection_risk');
    expect(test.transport.calls()).toBe(0);
    expect(test.audit.rows).toHaveLength(0);
  });

  it('★ 저장소가 돌려주지 않는 원 메일(격리·없음) → 404 · 전송 0', async () => {
    const test = harness();
    const token = issuedToken();
    const response = await handleForward(
      { tokens: token.store, service: test.service, transport: test.transport, ...forwardSource({ hidden: true }) },
      forwardRequest(token.plaintext, 'fwd-hidden'),
      { inboundMessageId: FORWARD_SOURCE_ID },
    );
    expect(response.status).toBe(404);
    expect(test.transport.calls()).toBe(0);
  });

  it('★ 남의 에이전트 메일 → 403 · 전송 0', async () => {
    const test = harness();
    const token = issuedToken();
    const response = await handleForward(
      {
        tokens: token.store,
        service: test.service,
        transport: test.transport,
        ...forwardSource({ agentId: 'ffffffffffffffffffffffffffffffff' as typeof AGENT_ID }),
      },
      forwardRequest(token.plaintext, 'fwd-foreign'),
      { inboundMessageId: FORWARD_SOURCE_ID },
    );
    expect(response.status).toBe(403);
    expect(test.transport.calls()).toBe(0);
  });

  it('html 을 주면 400 — 조용히 버리지 않는다', async () => {
    const test = harness();
    const token = issuedToken();
    const response = await handleForward(
      { tokens: token.store, service: test.service, transport: test.transport, ...forwardSource() },
      forwardRequest(token.plaintext, 'fwd-html', { html: '<p>x</p>' }),
      { inboundMessageId: FORWARD_SOURCE_ID },
    );
    expect(response.status).toBe(400);
    expect(test.transport.calls()).toBe(0);
  });
});

describe('입력 검증 — 관문에 닿기 전에 끝나는 것들', () => {
  it('수신자 0명은 표현 불가능하다 (DB CHECK 와 같은 명제)', async () => {
    const test = harness();
    const token = issuedToken();
    const response = await handleSend(
      { tokens: token.store, service: test.service, transport: test.transport },
      {
        headers: { authorization: `Bearer ${token.plaintext}`, 'idempotency-key': 'k' },
        query: {},
        body: { agent_id: AGENT_ID, from: AGENT_ADDRESS, to: [], subject: 's', text: 't' },
      },
    );

    expect(response.status).toBe(400);
    expect(test.store.rowCount()).toBe(0);
  });

  it('음수 cost_cents 는 거부된다 — Stage 5 의 부등호를 뒤집는 값이다', async () => {
    const test = harness();
    const token = issuedToken();
    const response = await handleSend(
      { tokens: token.store, service: test.service, transport: test.transport },
      {
        headers: { authorization: `Bearer ${token.plaintext}`, 'idempotency-key': 'k' },
        query: {},
        body: {
          agent_id: AGENT_ID,
          from: AGENT_ADDRESS,
          to: [ALLOWED_RECIPIENT],
          subject: 's',
          text: 't',
          cost_cents: -1_000_000,
        },
      },
    );

    expect(response.status).toBe(400);
    expect(test.transport.calls()).toBe(0);
  });
});
