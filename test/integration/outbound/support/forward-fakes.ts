/**
 * `forward` 를 in-memory 하네스(`fakes.ts`)로 구동하기 위한 원 메일 가짜 (P3c).
 *
 * 전달 라우트는 원 메일을 **에이전트 컨텍스트 저장소**(`findVisible`)와 파싱 결과 문서에서 읽는다. 매트릭스·멱등
 * 키 테스트는 관문 쪽을 보므로, 원 메일은 "보이고(none) 그 에이전트의 것" 인 한 통이면 된다.
 */

import type { ForwardRouteDependencies } from '../../../../src/api/routes/forward';
import type { VisibleInboundDetail } from '../../../../src/db/repositories/inbound-read-store';
import type { AgentId, InjectionRisk } from '../../../../src/db/schema';
import { AGENT_ID } from './fakes';

export const FORWARD_SOURCE_ID = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';

export interface ForwardSourceOptions {
  readonly agentId?: AgentId;
  readonly injectionRisk?: InjectionRisk;
  /** `null` = 저장소가 행을 돌려주지 않는다(없음 또는 격리 — 둘은 같다). */
  readonly hidden?: boolean;
  readonly text?: string;
}

export function forwardSource(
  options: ForwardSourceOptions = {},
): Pick<ForwardRouteDependencies, 'inbound' | 'artifacts'> {
  const detail: VisibleInboundDetail = {
    id: FORWARD_SOURCE_ID,
    agentId: options.agentId ?? AGENT_ID,
    threadId: '1e1e1e1e-1e1e-4e1e-8e1e-1e1e1e1e1e1e',
    receivedAtAddress: 'agent@atmark.ai',
    fromAddress: 'sender@example.com',
    fromAuthenticated: true,
    subject: '원 메일',
    receivedAt: new Date('2026-10-15T11:00:00.000Z'),
    attachmentCount: 0,
    injectionRisk: options.injectionRisk ?? 'none',
    senderTrust: 'unknown',
    authVerdicts: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
    aiWatch: null,
    parsedStorageKey: 'inbound/parsed/0100fake-000000.json',
    messageIdHeader: '<orig@example.com>',
    inReplyTo: null,
    headerDate: null,
    attachments: [],
  };
  const document = {
    version: 1,
    sesMessageId: '0100fake-000000',
    message: {
      text: options.text ?? '원 메일 본문',
      textSource: 'plain',
      htmlText: null,
      from: { address: 'sender@example.com', name: null },
      to: [],
      cc: [],
      replyTo: [],
      subject: '원 메일',
      date: null,
    },
  };
  return {
    inbound: { findVisible: (id) => Promise.resolve(options.hidden === true || id !== FORWARD_SOURCE_ID ? null : detail) },
    artifacts: { readParsed: () => Promise.resolve(new TextEncoder().encode(JSON.stringify(document))) },
  };
}
