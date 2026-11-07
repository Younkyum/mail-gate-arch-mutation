/**
 * **수신 전용 주소는 발신 주소가 될 수 없다**(202609301540). `abuse@`·`postmaster@atmark.ai` 는 운영자가 지원 에이전트에 붙이는 별칭이지만, 발송 전처리
 * (`prepareOutbound` · `prepareReplyOutbound` — 발송 경로 넷이 공유)가 행·audit 를 만들기 **전에** 400 `invalid` 로 끊는다(IAM Deny 는 그 뒤의 층).
 * 되돌리면 빨개진다: 의존성을 하나도 주지 않았다 — 판정이 저장소에 닿으면 던진다.
 */

import { describe, expect, it } from 'vitest';

import { prepareOutbound, prepareReplyOutbound, type OutboundSendRequest, type OutboundServiceDependencies } from '../../../src/api/outbound-service';
import { toAgentId } from '../../../src/db/schema';

const NO_DEPS = {} as OutboundServiceDependencies;

function request(fromAddress: string): OutboundSendRequest {
  return {
    routeId: 'send',
    agentId: toAgentId('3c27a1cc6afe63896a310d77df4af03a'),
    idempotencyKey: 'receive-only-1',
    fromAddress,
    recipients: ['reporter@example.com'],
    subject: 'Re: abuse report',
    text: 'thanks',
    html: null,
    isThreadReply: false,
    traceId: null,
    costCents: 0,
  };
}

describe('수신 전용 발신 주소 — 발송 전처리가 400 으로 끊는다 (202609301540)', () => {
  it.each(['abuse@atmark.ai', 'postmaster@atmark.ai', 'ABUSE@atmark.ai', ' Postmaster@Atmark.AI '])('%s → invalid(행 없음)', async (from) => {
    const prepared = await prepareOutbound(NO_DEPS, request(from));
    expect(prepared).toEqual({ kind: 'settled', outcome: { kind: 'invalid', detail: expect.stringContaining('is receive-only') } });
  });

  it('회신 경로도 같다(`from` 을 명시해도)', async () => {
    const target = { threadId: 't', inboundMessageId: 'i', threading: { inReplyTo: null, references: [] } } as unknown as Parameters<typeof prepareReplyOutbound>[2];
    const prepared = await prepareReplyOutbound(NO_DEPS, request('abuse@atmark.ai'), target);
    expect(prepared).toMatchObject({ kind: 'settled', outcome: { kind: 'invalid' } });
  });
});
