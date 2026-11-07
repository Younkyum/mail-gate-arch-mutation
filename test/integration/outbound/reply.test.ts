/**
 * `POST /v1/threads/:id/reply` — 라우트 계약 (P3b, 인메모리 하네스).
 *
 * 라우트는 **스레드 권한을 주지 않는다**. 그래서 여기서 보는 것은 셋이다:
 *   - 무엇에 답하는가: 에이전트 범위 조회 · 격리/없음 404 · 경로 스레드와 불일치 400 · 기본 수신자 · `Re:` 제목 · 헤더.
 *   - 관문에 **주장**으로만 간다: 소스가 스레드 사실을 주지 않으면 회신이어도 승인 대기다.
 *   - 소스가 사실을 주면(에이전트 스레드) 그때만 스레드 회신 면제가 열린다.
 * DB 까지 가는 판정(로더가 실제로 무엇을 읽는가)은 `reply-thread-policy.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import { handleReply, replySubject, type ReplyRouteDependencies } from '../../../src/api/routes/reply';
import { classifyContentShape } from '../../../src/api/outbound-service';
import type { ApiRequest } from '../../../src/api/http';
import type { ReplyTargetLookup } from '../../../src/db/repositories/reply-target-store';
import type { PolicySource, PolicySourceQuery, PolicySourceResult, ThreadSource } from '../../../src/policy/policy-loader';
import {
  AGENT_ADDRESS,
  AGENT_ID,
  ALLOWED_RECIPIENT,
  NOW,
  REPLY_INBOUND_ID,
  REPLY_THREAD_ID,
  fakeReplyTargets,
  harness,
  issuedToken,
  policyRow,
  policyVersionRow,
  sourceResult,
  type OutboundHarness,
} from './support/fakes';
import { forwardSource } from './support/forward-fakes';

const STRANGER = 'stranger@example.com';

function request(key: string, body: Record<string, unknown> = {}): ApiRequest {
  const token = TOKEN.plaintext;
  return {
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': key },
    query: {},
    body: { agent_id: AGENT_ID, from: AGENT_ADDRESS, in_reply_to: REPLY_INBOUND_ID, text: '감사합니다', ...body },
  };
}

const TOKEN = issuedToken();

/** 소스가 받은 질의를 기록한다 — 라우트가 무엇을 **주장**했는지 본다. */
function recording(result: PolicySourceResult): PolicySource & { readonly queries: PolicySourceQuery[] } {
  const queries: PolicySourceQuery[] = [];
  return {
    queries,
    load: (query) => {
      queries.push(query);
      return Promise.resolve(result);
    },
  };
}

function deps(
  test: OutboundHarness,
  source: PolicySource,
  replyTargets: ReplyTargetLookup = fakeReplyTargets(STRANGER),
): ReplyRouteDependencies {
  return {
    tokens: TOKEN.store,
    service: { ...test.service, source },
    transport: test.transport,
    replyTargets,
    artifacts: forwardSource().artifacts,
  };
}

const params = { threadId: REPLY_THREAD_ID };

/** `approval_required` 정책 — 신규 상대(STRANGER)는 관계가 없다. */
function approvalRequired(overrides: Partial<PolicySourceResult> = {}): PolicySourceResult {
  return sourceResult({
    policy: policyRow({ outbound_mode: 'approval_required' }),
    policyVersion: policyVersionRow({ outbound_mode: 'approval_required' }),
    ...overrides,
  });
}

function agentThread(startedBy: 'agent' | 'external', from = STRANGER): ThreadSource {
  return {
    thread: {
      id: REPLY_THREAD_ID,
      agent_id: AGENT_ID,
      started_by: startedBy,
      starter_address: from,
      subject_normalized: '견적 문의',
      created_at: NOW,
      last_message_at: NOW,
    },
    authenticatedSenders: [from],
    latestAuthenticatedInbound: {
      id: REPLY_INBOUND_ID,
      from_address: from,
      injection_risk: 'none',
      sender_trust: 'unknown',
      quarantined: false,
      received_at: NOW,
      attachment_count: 0,
    },
  };
}

describe('무엇에 답하는가 — 관문 앞', () => {
  it('모르는 수신 메일 id → 404, audit 0 · SES 0', async () => {
    const test = harness();
    const response = await handleReply(
      deps(test, recording(sourceResult())),
      request('r-404', { in_reply_to: '12345678-1234-4234-8234-123456789012' }),
      params,
    );
    expect(response.status).toBe(404);
    expect(response.body['error']).toBe('message_not_found');
    expect(test.audit.rows).toHaveLength(0);
    expect(test.transport.calls()).toBe(0);
  });

  it('기본 수신자(받은 From)가 발신 주소 모양이 아니면 400 invalid_recipient — 관문 전, audit 0 · SES 0 (202609241040 — 검증 M2)', async () => {
    for (const from of ['"bad"@x.com', 'bad@x.com.', 'bad\\@x.com']) {
      const test = harness();
      const response = await handleReply(deps(test, recording(sourceResult()), fakeReplyTargets(from)), request(`r-shape-${from.length}`), params);
      expect([response.status, response.body['error']], from).toEqual([400, 'invalid_recipient']);
      expect(test.audit.rows).toHaveLength(0);
      expect(test.transport.calls()).toBe(0);
    }
  });

  it('격리된 메일에는 답할 수 없다 → 404 (에이전트가 볼 수 없는 메일)', async () => {
    const test = harness();
    const response = await handleReply(
      deps(test, recording(sourceResult()), fakeReplyTargets(STRANGER, { quarantined: true })),
      request('r-q'),
      params,
    );
    expect(response.status).toBe(404);
    expect(test.audit.rows).toHaveLength(0);
  });

  it('답하는 메일의 권한용 스레드가 경로의 스레드와 다르면 400 — 어느 쪽도 고르지 않는다', async () => {
    const test = harness();
    const response = await handleReply(deps(test, recording(sourceResult())), request('r-mismatch'), {
      threadId: '88888888-8888-4888-8888-888888888888',
    });
    expect(response.status).toBe(400);
    expect(test.audit.rows).toHaveLength(0);
  });

  it('in_reply_to 가 없거나 uuid 가 아니면 400 · 경로 id 가 uuid 가 아니면 400', async () => {
    const test = harness();
    const d = deps(test, recording(sourceResult()));
    expect((await handleReply(d, request('r-a', { in_reply_to: undefined }), params)).status).toBe(400);
    expect((await handleReply(d, request('r-b', { in_reply_to: 'nope' }), params)).status).toBe(400);
    expect((await handleReply(d, request('r-c'), { threadId: 'nope' })).status).toBe(400);
    expect(test.audit.rows).toHaveLength(0);
  });

  it('받은 메일에 제목이 없고 subject 도 없으면 400 — 제목 없는 메일을 만들지 않는다', async () => {
    const test = harness();
    const response = await handleReply(
      deps(test, recording(sourceResult()), fakeReplyTargets(STRANGER, { subject: null })),
      request('r-nosubj'),
      params,
    );
    expect(response.status).toBe(400);
  });
});

describe('회신의 모양 — 기본 수신자 · 제목 · 헤더 · 스레드 주장', () => {
  it('기본 수신자 = 받은 메일의 From, 제목 = `Re: …`, 헤더는 받은 Message-ID 기준, 관문에는 스레드를 **주장**으로', async () => {
    const test = harness();
    const source = recording(sourceResult());
    const response = await handleReply(deps(test, source, fakeReplyTargets(ALLOWED_RECIPIENT)), request('r-shape'), params);

    // allowlist_only 하네스 — 수신자가 목록 안이라 나간다(스레드와 무관한 사유).
    expect(response.status).toBe(200);
    expect(test.transport.calls()).toBe(1);
    expect(source.queries[0]?.recipients).toEqual([ALLOWED_RECIPIENT]);
    expect(source.queries[0]?.threadId).toBe(REPLY_THREAD_ID);

    const messageId = response.body['message_id'] as string;
    await expect(test.content.load(messageId)).resolves.toEqual({
      subject: 'Re: 견적 문의',
      text: '감사합니다',
      html: null,
      threading: { inReplyTo: '<parent-1@partner.example>', references: ['<grand-1@atmark.ai>', '<parent-1@partner.example>'] },
    });
  });

  it('`to` 를 명시하면 그 주소로 — 라우트는 막지 않는다(판정은 정책이 한다)', async () => {
    const test = harness();
    const source = recording(approvalRequired());
    await handleReply(deps(test, source), request('r-to', { to: ['reply-to@evil.example'] }), params);
    expect(source.queries[0]?.recipients).toEqual(['reply-to@evil.example']);
  });

  it('같은 키 · 같은 요청 → replay, 같은 키 · **다른 메일에 답하면** → 409', async () => {
    const test = harness();
    const other = '99999999-9999-4999-8999-999999999999';
    const targets: ReplyTargetLookup = {
      find: (agentId, id) =>
        fakeReplyTargets(ALLOWED_RECIPIENT).find(agentId, REPLY_INBOUND_ID).then((target) =>
          target === null || (id !== REPLY_INBOUND_ID && id !== other) ? null : { ...target, inboundMessageId: id },
        ),
    };
    const d = deps(test, recording(sourceResult()), targets);
    expect((await handleReply(d, request('r-idem'), params)).status).toBe(200);
    expect((await handleReply(d, request('r-idem'), params)).body['replayed']).toBe(true);
    expect((await handleReply(d, request('r-idem', { in_reply_to: other }), params)).status).toBe(409);
    expect(test.transport.calls()).toBe(1);
  });
});

describe('관문 — 스레드 주장은 아무것도 열지 않는다', () => {
  it('★ approval_required · 소스가 스레드 사실을 주지 않음 → 회신이어도 승인 대기(SES 0)', async () => {
    const test = harness();
    const response = await handleReply(deps(test, recording(approvalRequired())), request('r-claim'), params);
    expect(response.status).toBe(202);
    expect((response.body['decision'] as { reasons: string[] }).reasons).toEqual(['new_recipient']);
    expect(test.transport.calls()).toBe(0);
  });

  it('소스가 **에이전트 스레드** 사실을 주면 → allowed `auto_approve_reply_within_thread`', async () => {
    const test = harness();
    const response = await handleReply(
      deps(test, recording(approvalRequired({ thread: agentThread('agent') }))),
      request('r-agent'),
      params,
    );
    expect(response.status).toBe(200);
    expect((response.body['decision'] as { reasons: string[] }).reasons).toEqual(['auto_approve_reply_within_thread']);
    expect(test.transport.calls()).toBe(1);
  });

  it('★ 소스가 **외부 스레드** 사실을 주면 → 승인 대기(외부 스레드는 이 규칙으로 열리지 않는다)', async () => {
    const test = harness();
    const response = await handleReply(
      deps(test, recording(approvalRequired({ thread: agentThread('external') }))),
      request('r-external'),
      params,
    );
    expect(response.status).toBe(202);
    expect(test.transport.calls()).toBe(0);
  });

  it('★ Reply-To 로 답하기(`to` = 스레드 밖 주소) → 에이전트 스레드여도 승인 대기', async () => {
    const test = harness();
    const response = await handleReply(
      deps(test, recording(approvalRequired({ thread: agentThread('agent') }))),
      request('r-replyto', { to: ['reply-to@evil.example'] }),
      params,
    );
    expect(response.status).toBe(202);
    expect(test.transport.calls()).toBe(0);
  });
});

describe('보조 함수', () => {
  it('replySubject — Re: 를 겹치지 않고, 제어문자를 지우고, 빈 제목은 null', () => {
    expect(replySubject('견적')).toBe('Re: 견적');
    expect(replySubject('RE: 견적')).toBe('RE: 견적');
    expect(replySubject('a\r\nBcc: x@y')).toBe('Re: a Bcc: x@y');
    expect(replySubject('   ')).toBeNull();
    expect(replySubject('Re:')).toBeNull();
    expect(replySubject(null)).toBeNull();
  });

  it('classifyContentShape — 짧은 코드 한 토큰만 code_only, 링크·문장·html 은 other', () => {
    expect(classifyContentShape('123456', null)).toBe('code_only');
    expect(classifyContentShape('  G-482913 \n', null)).toBe('code_only');
    expect(classifyContentShape('123456', '<b>123456</b>')).toBe('other');
    expect(classifyContentShape('https://x.example/verify?c=1', null)).toBe('other');
    expect(classifyContentShape('코드는 123456 입니다', null)).toBe('other');
    expect(classifyContentShape('abcdef', null)).toBe('other');
    expect(classifyContentShape('12', null)).toBe('other');
  });
});
