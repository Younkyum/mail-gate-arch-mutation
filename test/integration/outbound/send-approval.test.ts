/**
 * 소유자 발신 승인(`send_approval = always`, ADR-0016 2026-10-08) — **관문을 지나는 모든 발송 경로가 따른다.** 정책 행 `require_approval`(또는 스냅샷
 * `require_approval`)이 참이면 목록에 있는 상대에게도 발송은 승인 대기(202 · `owner_requires_approval`)이고 전송단은 0회다. 초안 보내기도 같은 관문이다.
 */

import { describe, expect, it } from 'vitest';

import { handleSendDraft } from '../../../src/api/routes/draft-send';
import { handleSend } from '../../../src/api/routes/send';
import type { ApiRequest } from '../../../src/api/http';
import { AGENT_ADDRESS, AGENT_ID, ALLOWED_RECIPIENT, fakeReplyTargets, harness, issuedToken, policyRow, policyVersionRow, sourceResult } from './support/fakes';
import { DRAFT_ID, fakeDraft } from './support/draft-fakes';
import { forwardSource } from './support/forward-fakes';

function sendRequest(token: string, key: string): ApiRequest {
  return {
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': key },
    query: {},
    body: { agent_id: AGENT_ID, from: AGENT_ADDRESS, to: [ALLOWED_RECIPIENT], subject: 'hello', text: '안녕하세요' },
  };
}

const ALWAYS_BY_ROW = sourceResult({ policy: policyRow({ require_approval: true }) });
const ALWAYS_BY_SNAPSHOT = sourceResult({
  policyVersion: { ...policyVersionRow(), snapshot: { ...policyVersionRow().snapshot, require_approval: true } },
});

describe('발신 승인 always — 목록 안 상대도 승인 대기 · 전송단 0회', () => {
  it.each([
    ['정책 행', ALWAYS_BY_ROW],
    ['스냅샷', ALWAYS_BY_SNAPSHOT],
  ])('send (%s)', async (_label, result) => {
    const test = harness(result);
    const token = issuedToken();
    const response = await handleSend({ tokens: token.store, service: test.service, transport: test.transport }, sendRequest(token.plaintext, 'k-1'));
    expect(response.status).toBe(202);
    expect((response.body['decision'] as { reasons: string[] }).reasons).toEqual(['owner_requires_approval']);
    expect(test.transport.calls()).toBe(0);
    expect(test.audit.rows[0]?.decision.verdict).toBe('pending_approval');
  });

  it('draft send — 같은 관문 · 같은 사유', async () => {
    const test = harness(ALWAYS_BY_ROW);
    const token = issuedToken();
    const response = await handleSendDraft(
      {
        tokens: token.store,
        service: test.service,
        transport: test.transport,
        ...fakeDraft(AGENT_ID, { from: AGENT_ADDRESS, to: [ALLOWED_RECIPIENT], subject: 'hello', text: '안녕하세요' }),
        replyTargets: fakeReplyTargets(),
        artifacts: forwardSource().artifacts,
      },
      { headers: { authorization: `Bearer ${token.plaintext}`, 'idempotency-key': 'd-1' }, query: {}, body: { agent_id: AGENT_ID } },
      { draftId: DRAFT_ID },
    );
    expect(response.status).toBe(202);
    expect((response.body['decision'] as { reasons: string[] }).reasons).toEqual(['owner_requires_approval']);
    expect(test.transport.calls()).toBe(0);
  });

  it('auto(기본)는 오늘 동작 그대로 — 목록 안 상대에게 나간다', async () => {
    const test = harness();
    const token = issuedToken();
    const response = await handleSend({ tokens: token.store, service: test.service, transport: test.transport }, sendRequest(token.plaintext, 'k-2'));
    expect(response.status).toBe(200);
    expect(test.transport.calls()).toBe(1);
  });
});
