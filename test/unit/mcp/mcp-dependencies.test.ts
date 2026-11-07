/**
 * MCP 가 **런타임에** 받는 의존성 — 함수뿐이다 (2026-09-23 두 번째 적대 검증 M2).
 *
 * 예전: 라우터가 `{ send: d.send, … }` 일곱 칸을 넘겼다. 타입은 좁았지만 값은 통째 객체였고, 검증자는
 * `(x as any).approve(...)`·`Object.values(deps.send)` 로 승인 저장소의 `approve`·`reject`·`expire`, 토큰 저장소의
 * `insert`·`revoke`, `send.transport` 에 닿았다. 이제 `mcpDependenciesOf(d)`(router.ts)가 클로저만 돌려준다.
 *
 * 되돌리기(★): `mcpDependenciesOf` 에 `send: d.send` 같은 객체 칸을 되살리면 "함수뿐" 단언이 빨갛다.
 * 소스 모양(키 집합·각 칸이 부르는 handle*·의존성 칸)은 `test/arch/mcp-adapter.arch.test.ts` ⑤ 가 본다.
 */

import { describe, expect, it } from 'vitest';

import { mcpDependenciesOf, type ApiDependencies } from '../../../src/runtime/router';

const MID = '11111111-2222-4333-8444-555555555555';
const AGENT = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

/** 칸마다 이름표를 단 덫 — 어떤 속성이든 읽으면 `touched <칸>.<속성>` 을 던진다. */
function trap(label: string): never {
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (property === 'then') return undefined;
        throw new Error(`touched ${label}.${String(property)}`);
      },
    },
  ) as never;
}

function trappedDeps(): ApiDependencies {
  const slots = [
    'send',
    'reply',
    'forward',
    'transitionAnnouncement',
    'audit',
    'approvalLink',
    'approvals',
    'agentPolicy',
    'webhookEndpoints',
    'inboundRead',
    'attachments',
    'scheduledMessages',
    'scheduledQueries',
    'verificationCode',
    'webhookDeliveries',
    'drafts',
    'draftSend',
    'labels',
    'agentEnroll',
    'policyRequests',
    'health',
  ] as const;
  return Object.fromEntries(slots.map((slot) => [slot, trap(slot)])) as unknown as ApiDependencies;
}

const ALLOWED = [
  'authenticate',
  'cancelScheduled',
  'createAgent',
  'createDraft',
  'createWebhook',
  'deleteWebhook',
  'discardDraft',
  'findReplyTarget',
  'forward',
  'forwardOriginal',
  'getAgentPolicy',
  'getApproval',
  'getAttachment',
  'getCapabilities',
  'getDraft',
  'getPolicyRequest',
  'getRealtimeConnection',
  'getThread',
  'listDrafts',
  'listInbox',
  'listLabels',
  'listScheduled',
  'listWebhookDeliveries',
  'listWebhooks',
  'readAttachment',
  'readEmail',
  'redeliverWebhook',
  'reply',
  'requestPolicyChange',
  'send',
  'sendDraft',
  'sendingAddresses',
  'setLabels',
  'updateDraft',
  'verificationCode',
];

const REQUEST = {
  headers: { authorization: 'Bearer atk_agent_x', 'idempotency-key': 'k-1' },
  query: { agent_id: AGENT, limit: '10' },
  body: { agent_id: AGENT },
};

describe('★ MCP 의존성은 런타임에도 함수뿐이다 (M2)', () => {
  it('★ 키 집합은 허용목록 그대로 · 값은 전부 함수 · 함수에 붙은 속성 없음 · 동결', () => {
    const ports = mcpDependenciesOf(trappedDeps()); // 만드는 것만으로는 어떤 칸도 읽지 않는다(덫이 조용하다)
    expect(Object.keys(ports).sort()).toEqual(ALLOWED);
    expect(Reflect.ownKeys(ports).length).toBe(ALLOWED.length);
    for (const [name, value] of Object.entries(ports)) {
      expect([name, typeof value]).toEqual([name, 'function']);
      // 화살표 함수 — prototype 이 없고 length·name 외 자기 속성이 없다(객체를 매달아 넘길 자리가 없다).
      expect([name, Object.getOwnPropertyNames(value).sort()]).toEqual([name, ['length', 'name']]);
    }
    expect(Object.isFrozen(ports)).toBe(true);
  });

  it('★ 검증자의 우회 두 가지가 닿을 객체가 없다 — any 캐스트·Object.values', () => {
    const ports = mcpDependenciesOf(trappedDeps()) as unknown as Record<string, Record<string, unknown> | undefined>;
    // (x as any).approve(...) — 승인 저장소·토큰 저장소·전송단이 이름으로도 없다.
    for (const name of ['approvals', 'agentPolicy', 'inboundRead', 'attachments', 'scheduledQueries', 'scheduledMessages', 'tokens', 'transport', 'service']) {
      expect([name, ports[name]]).toEqual([name, undefined]);
    }
    expect(ports['send']?.['transport']).toBeUndefined();
    expect(ports['getApproval']?.['approve']).toBeUndefined();
    // Object.values(deps…) — 나오는 것은 함수뿐, 그 함수들의 값도 비어 있다.
    const reachable = Object.values(ports).flatMap((value) => [value, ...Object.values(value ?? {})]);
    expect(reachable.every((value) => typeof value === 'function')).toBe(true);
  });

  it('라우트 칸은 정해진 의존성 칸으로 라우트를 부른다 — 부르는 순간 그 칸의 덫이 울린다', async () => {
    const ports = mcpDependenciesOf(trappedDeps());
    const cases: Record<string, [() => Promise<unknown>, string]> = {
      authenticate: [() => ports.authenticate({ authorization: 'Bearer atk_agent_x' }), 'inboundRead'],
      send: [() => ports.send(REQUEST), 'send'],
      reply: [() => ports.reply(REQUEST, { threadId: MID }), 'reply'],
      findReplyTarget: [() => ports.findReplyTarget(AGENT, MID), 'reply'],
      forward: [() => ports.forward(REQUEST, { inboundMessageId: MID }), 'forward'],
      forwardOriginal: [() => ports.forwardOriginal(AGENT as never, MID), 'forward'],
      listInbox: [() => ports.listInbox(REQUEST), 'inboundRead'],
      readEmail: [() => ports.readEmail(REQUEST, { inboundMessageId: MID }), 'inboundRead'],
      getThread: [() => ports.getThread(REQUEST, { threadId: MID }), 'inboundRead'],
      getAttachment: [() => ports.getAttachment(REQUEST, { inboundMessageId: MID, index: '0' }), 'attachments'],
      readAttachment: [() => ports.readAttachment(REQUEST, { inboundMessageId: MID, index: '0' }), 'attachments'],
      getApproval: [() => ports.getApproval(REQUEST, { approvalId: MID }), 'approvals'],
      getAgentPolicy: [() => ports.getAgentPolicy(REQUEST, { agentId: AGENT }), 'agentPolicy'],
      sendingAddresses: [() => ports.sendingAddresses(AGENT as never), 'agentPolicy'],
      verificationCode: [() => ports.verificationCode(REQUEST), 'verificationCode'],
      listScheduled: [() => ports.listScheduled(REQUEST), 'scheduledQueries'],
      cancelScheduled: [() => ports.cancelScheduled(REQUEST, { scheduleId: MID }), 'scheduledQueries'],
      // 웹훅 관리(2026-09-30) — HTTP 라우트와 같은 칸.
      listWebhooks: [() => ports.listWebhooks(REQUEST, { agentId: AGENT }), 'webhookEndpoints'],
      createWebhook: [() => ports.createWebhook(REQUEST, { agentId: AGENT }), 'webhookEndpoints'],
      deleteWebhook: [() => ports.deleteWebhook(REQUEST, { agentId: AGENT, endpointId: MID }), 'webhookEndpoints'],
      listWebhookDeliveries: [() => ports.listWebhookDeliveries(REQUEST, { agentId: AGENT }), 'webhookDeliveries'],
      redeliverWebhook: [() => ports.redeliverWebhook(REQUEST, { agentId: AGENT, deliveryId: MID }), 'webhookDeliveries'],
      // 묶음 B — 초안(`drafts` · 보내기는 `draftSend`) · 라벨 · 발견(`agentPolicy`).
      createDraft: [() => ports.createDraft(REQUEST), 'drafts'],
      listDrafts: [() => ports.listDrafts(REQUEST), 'drafts'],
      getDraft: [() => ports.getDraft(REQUEST, { draftId: MID }), 'drafts'],
      updateDraft: [() => ports.updateDraft(REQUEST, { draftId: MID }), 'drafts'],
      discardDraft: [() => ports.discardDraft(REQUEST, { draftId: MID }), 'drafts'],
      sendDraft: [() => ports.sendDraft(REQUEST, { draftId: MID }), 'draftSend'],
      setLabels: [() => ports.setLabels({ ...REQUEST, body: { labels: ['x'] } }, { inboundMessageId: MID }), 'labels'],
      listLabels: [() => ports.listLabels(REQUEST), 'labels'],
      getCapabilities: [() => ports.getCapabilities(REQUEST, { agentId: AGENT }), 'agentPolicy'],
      createAgent: [() => ports.createAgent(REQUEST), 'agentEnroll'],
      getRealtimeConnection: [() => ports.getRealtimeConnection(REQUEST, { agentId: AGENT }), 'agentPolicy'],
      // 정책 변경 요청(2026-10-13) — HTTP 라우트와 같은 칸.
      requestPolicyChange: [() => ports.requestPolicyChange(REQUEST, { agentId: AGENT }), 'policyRequests'],
      getPolicyRequest: [() => ports.getPolicyRequest(REQUEST, { agentId: AGENT, requestId: MID }), 'policyRequests'],
    };
    expect(Object.keys(cases).sort()).toEqual(ALLOWED);
    for (const [name, [call, slot]] of Object.entries(cases)) {
      // 동기로 던지는 칸(덫을 곧바로 읽는 화살표)도 같은 판정에 넣는다.
      const error = await Promise.resolve().then(call).then(
        () => null,
        (thrown: unknown) => (thrown instanceof Error ? thrown.message : String(thrown)),
      );
      expect([name, error?.startsWith(`touched ${slot}.`)]).toEqual([name, true]);
    }
  });
});
