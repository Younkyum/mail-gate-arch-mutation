/**
 * `summaryBody`/`detailBody` — 응답에 `received_at_address`(이 메일을 받은 에이전트 자신의 주소, 기본 주소 또는 별칭)가 실린다.
 * 값은 저장소가 읽은 `envelope_recipient` 그대로다(`inbound-read-store.ts` `toSummary`).
 */
import { describe, expect, it } from 'vitest';

import { detailBody, summaryBody, type InboundBody } from '../../../src/api/inbound-view';
import type { VisibleInboundDetail, VisibleInboundSummary } from '../../../src/db/repositories/inbound-read-store';
import type { AgentId } from '../../../src/db/schema';

const AGENT = 'a'.repeat(32) as AgentId;

const summary: VisibleInboundSummary = {
  id: '33333333-3333-4333-8333-333333333333',
  agentId: AGENT,
  threadId: '22222222-2222-4222-8222-222222222222',
  receivedAtAddress: 'alias@atmark.ai',
  fromAddress: 'sender@customer.example',
  fromAuthenticated: true,
  subject: 'hello',
  receivedAt: new Date('2026-09-28T00:00:00.000Z'),
  attachmentCount: 0,
  injectionRisk: 'none',
  senderTrust: null,
  authVerdicts: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
  aiWatch: null,
};

describe('summaryBody — received_at_address', () => {
  it('저장소의 receivedAtAddress 를 그대로 싣는다', () => {
    expect(summaryBody(summary)).toMatchObject({ received_at_address: 'alias@atmark.ai' });
  });

  it('기본 주소로 받은 메일은 기본 주소를 싣는다', () => {
    expect(summaryBody({ ...summary, receivedAtAddress: 'agent@atmark.ai' })).toMatchObject({ received_at_address: 'agent@atmark.ai' });
  });
});

describe('detailBody — received_at_address', () => {
  it('목록과 같은 값을 상세에도 싣는다', () => {
    const detail: VisibleInboundDetail = {
      ...summary,
      parsedStorageKey: 'k',
      messageIdHeader: null,
      inReplyTo: null,
      headerDate: null,
      attachments: [],
    };
    const body: InboundBody = {
      text: 'hi',
      textSource: 'plain',
      htmlText: null,
      from: { address: 'sender@customer.example', name: null },
      to: [],
      cc: [],
      replyTo: [],
      subject: 'hello',
      date: null,
    };
    expect(detailBody(detail, body)).toMatchObject({ received_at_address: 'alias@atmark.ai' });
  });
});
