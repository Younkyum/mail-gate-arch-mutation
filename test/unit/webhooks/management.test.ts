/**
 * `webhooks/management.ts` — DB 없이 볼 수 있는 규칙: 웹훅 관리 권한 판정(`webhooks:manage` · 옛 토큰의 `messages:send` 전환 경로 · 일몰 ·
 * 구조화 로그) · 구독 해석 · 화면 전달 상태 · 전달 커서. 등록·회전의 DB 연산은 통합 테스트(`test/integration/webhooks/webhook-management.test.ts`).
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { WebhookDeliveryRecord } from '../../../src/db/repositories/webhook-store';
import type { AgentId } from '../../../src/db/schema';
import {
  AGENT_TOKEN_CAPABILITIES,
  DEFAULT_AGENT_TOKEN_CAPABILITIES,
  FORBIDDEN_TO_AGENT_TOKENS,
  type AgentTokenCapability,
} from '../../../src/identity/agent-token';
import { resetLogSink, setLogSink } from '../../../src/observability/logger';
import { LEGACY_EVENT_TYPES, WEBHOOK_EVENT_TYPES } from '../../../src/webhooks/events';
import {
  authorizeWebhookManage,
  decodeDeliveryCursor,
  deliveryDisplayStatus,
  deliveryLastAttemptAt,
  encodeDeliveryCursor,
  LEGACY_WEBHOOK_MANAGE_UNTIL,
  maskWebhookUrl,
  parseEventTypes,
  subscribedTypes,
  webhookUrlHost,
  type WebhookManageAction,
} from '../../../src/webhooks/management';

const SELF = 'a'.repeat(32) as AgentId;
const OTHER = 'b'.repeat(32) as AgentId;
const BEFORE_SUNSET = new Date('2026-12-31T23:59:59.999Z');
const AT_SUNSET = LEGACY_WEBHOOK_MANAGE_UNTIL;
const ACTIONS: readonly WebhookManageAction[] = ['register', 'delete', 'rotate', 'redeliver'];

function principal(capabilities: readonly AgentTokenCapability[], agentId: AgentId = SELF, webhooksLegacyEligible?: boolean) {
  return { agentId, capabilities, ...(webhooksLegacyEligible === undefined ? {} : { webhooksLegacyEligible, issuedAt: new Date('2026-09-01T00:00:00Z') }) };
}

/** webhooks:manage 전에 발급된 옛 토큰(기본 넷 · 자격 true). */
const legacyToken = (capabilities: readonly AgentTokenCapability[] = DEFAULT_AGENT_TOKEN_CAPABILITIES) => principal(capabilities, SELF, true);
const LEGACY_ACTIONS: readonly WebhookManageAction[] = ['register', 'delete', 'redeliver'];

function captureLogs(): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = [];
  setLogSink((line) => lines.push(JSON.parse(line) as Record<string, unknown>));
  return lines;
}

afterEach(() => resetLogSink());

describe('권한 — webhooks:manage 는 닫힌 유니온의 새 이름이고 기본에는 없다', () => {
  it('AGENT_TOKEN_CAPABILITIES 에 있고 특권 목록과 겹치지 않는다 · DEFAULT 에는 없다(소유자가 골라 준다)', () => {
    expect(AGENT_TOKEN_CAPABILITIES).toContain('webhooks:manage');
    expect(FORBIDDEN_TO_AGENT_TOKENS as readonly string[]).not.toContain('webhooks:manage');
    expect(DEFAULT_AGENT_TOKEN_CAPABILITIES as readonly string[]).not.toContain('webhooks:manage');
    // 2026-10-13 — 정책 변경 요청(바꾸지 않는 권한)이 기본에 더해졌다(ADR-0007 개정).
    expect([...DEFAULT_AGENT_TOKEN_CAPABILITIES]).toEqual(['messages:send', 'messages:read', 'audit:read', 'agent:read_self', 'policy:request']);
  });
});

describe('authorizeWebhookManage', () => {
  it('webhooks:manage 면 통과 — 전환 경로가 아니다(로그 0)', () => {
    const lines = captureLogs();
    for (const action of ACTIONS) {
      expect(authorizeWebhookManage(principal(['webhooks:manage']), SELF, action, AT_SUNSET)).toEqual({ kind: 'authorized', via: 'webhooks:manage' });
    }
    expect(lines).toEqual([]);
  });

  it('★ 옛 토큰(webhooks:manage 전 발급 · messages:send): 등록·삭제·재전송은 일몰 전에 통과 + 행위마다 구조화 로그(발급 시각 포함)', () => {
    const lines = captureLogs();
    for (const action of LEGACY_ACTIONS) {
      expect(authorizeWebhookManage(legacyToken(), SELF, action, BEFORE_SUNSET)).toEqual({ kind: 'authorized', via: 'legacy_messages_send' });
    }
    expect(lines.map((line) => line['route_id'])).toEqual(LEGACY_ACTIONS.map((action) => `webhooks:${action}`));
    for (const line of lines) {
      expect(line).toMatchObject({ level: 'warn', event: 'webhook.legacy_capability', agent_id: SELF, outcome: 'allowed_legacy', reason: 'messages:send' });
      expect(line['detail']).toContain('2026-09-01T00:00:00.000Z');
    }
  });

  it('★ 보안 M3 — 회전은 전환 경로가 없다 · 새로 발급된 토큰(자격 false·모름)은 전환 경로가 없다 · 등록은 messages:read 도 있어야 한다', () => {
    const lines = captureLogs();
    const denied = { kind: 'denied', reason: 'capability_not_granted' };
    expect(authorizeWebhookManage(legacyToken(), SELF, 'rotate', BEFORE_SUNSET)).toEqual(denied);
    for (const action of ACTIONS) {
      expect(authorizeWebhookManage(principal(DEFAULT_AGENT_TOKEN_CAPABILITIES, SELF, false), SELF, action, BEFORE_SUNSET), action).toEqual(denied);
      expect(authorizeWebhookManage(principal(DEFAULT_AGENT_TOKEN_CAPABILITIES), SELF, action, BEFORE_SUNSET), action).toEqual(denied);
    }
    expect(authorizeWebhookManage(legacyToken(['messages:send']), SELF, 'register', BEFORE_SUNSET)).toEqual(denied);
    expect(authorizeWebhookManage(legacyToken(['messages:send']), SELF, 'delete', BEFORE_SUNSET)).toMatchObject({ kind: 'authorized' });
    expect(lines.filter((line) => line['event'] === 'webhook.legacy_capability')).toHaveLength(1);
  });

  it('일몰(2027-01-01T00:00:00Z, 배타) 부터는 옛 토큰도 messages:send 로 통과하지 않는다 — 403 사유 capability_not_granted', () => {
    const lines = captureLogs();
    expect(AT_SUNSET.toISOString()).toBe('2027-01-01T00:00:00.000Z');
    for (const action of ACTIONS) {
      expect(authorizeWebhookManage(legacyToken(), SELF, action, AT_SUNSET)).toEqual({
        kind: 'denied',
        reason: 'capability_not_granted',
      });
    }
    expect(lines).toEqual([]);
  });

  it('messages:read 만으로는 등록도 안 된다(일몰 전에도) — 등록을 읽기 토큰에서 거두는 것이 요점', () => {
    for (const action of ACTIONS) {
      expect(authorizeWebhookManage(legacyToken(['messages:read', 'audit:read', 'agent:read_self']), SELF, action, BEFORE_SUNSET)).toEqual({
        kind: 'denied',
        reason: 'capability_not_granted',
      });
    }
  });

  it('남의 에이전트는 권한과 무관하게 not_own_agent — 소유 검사가 먼저다(전환 로그도 없다)', () => {
    const lines = captureLogs();
    expect(authorizeWebhookManage(principal([...AGENT_TOKEN_CAPABILITIES], OTHER), SELF, 'register', BEFORE_SUNSET)).toEqual({
      kind: 'denied',
      reason: 'not_own_agent',
    });
    expect(authorizeWebhookManage(principal(['messages:send', 'messages:read'], OTHER, true), SELF, 'register', BEFORE_SUNSET)).toEqual({
      kind: 'denied',
      reason: 'not_own_agent',
    });
    expect(lines).toEqual([]);
  });
});

describe('URL 가림(보안 L3)', () => {
  it('scheme://host[:port]/… + 경로 끝 4글자 · 쿼리·프래그먼트 없음 · 경로가 / 면 끝', () => {
    expect(maskWebhookUrl('https://hooks.example.com/v1/atmark?token=secret#x')).toBe('https://hooks.example.com/…mark');
    expect(maskWebhookUrl('https://hooks.example.com:8443/in/abc')).toBe('https://hooks.example.com:8443/…/abc');
    expect(maskWebhookUrl('https://hooks.example.com/')).toBe('https://hooks.example.com/');
    expect(maskWebhookUrl('https://hooks.example.com/?token=secret')).toBe('https://hooks.example.com/');
    expect(maskWebhookUrl('not a url')).toBe('…');
    expect(maskWebhookUrl('https://hooks.example.com/t0k3n-9f8e7d6c5b4a')).not.toContain('9f8e7d');
    expect(webhookUrlHost('https://Hooks.Example.com:8443/x?y=1')).toBe('hooks.example.com:8443');
  });
});

describe('parseEventTypes · subscribedTypes', () => {
  it('생략은 null(옛 4종) · 중복 제거 · 정의 순서로 정렬 · 모르는 종류·빈 배열·문자열 아님은 invalid', () => {
    expect(parseEventTypes(undefined)).toBeNull();
    expect(parseEventTypes(['message.bounced', 'message.received', 'message.bounced'])).toEqual(['message.received', 'message.bounced']);
    for (const bad of [[], ['nope'], [1], 'message.sent', null, Array.from({ length: 15 }, () => 'message.sent')]) {
      expect(parseEventTypes(bad), JSON.stringify(bad)).toBe('invalid');
    }
    expect(subscribedTypes(null)).toEqual(LEGACY_EVENT_TYPES);
    expect(subscribedTypes(['message.bounced'])).toEqual(['message.bounced']);
    expect(parseEventTypes([...WEBHOOK_EVENT_TYPES].reverse())).toEqual([...WEBHOOK_EVENT_TYPES]);
  });
});

describe('화면 전달 상태 · 마지막 시도 · 커서', () => {
  const base: WebhookDeliveryRecord = {
    id: '11111111-1111-4111-8111-111111111111',
    eventId: '22222222-2222-4222-8222-222222222222',
    eventType: 'message.sent',
    endpointId: '33333333-3333-4333-8333-333333333333',
    status: 'pending',
    attemptCount: 0,
    lastError: null,
    lastHttpStatus: null,
    redeliveryOf: null,
    createdAt: new Date('2026-09-30T00:00:00Z'),
    nextAttemptAt: new Date('2026-09-30T00:00:00Z'),
    lastAttemptAt: null,
    deliveredAt: null,
    deadAt: null,
    createdMicros: '1790000000000000',
  };

  it('pending(오류 없음) → pending · 재시도 대기(오류 있음) → failed · 종단은 그대로', () => {
    expect(deliveryDisplayStatus(base)).toBe('pending');
    expect(deliveryDisplayStatus({ ...base, attemptCount: 2, lastError: 'http_status', lastHttpStatus: 503 })).toBe('failed');
    expect(deliveryDisplayStatus({ ...base, status: 'delivered', deliveredAt: new Date() })).toBe('delivered');
    expect(deliveryDisplayStatus({ ...base, status: 'dead', deadAt: new Date(), lastError: 'http_status' })).toBe('dead');
  });

  it('마지막 시도 = last_attempt_at, 없으면(옛 행) 종단 시각, 시도 전이면 null', () => {
    const at = new Date('2026-09-30T01:00:00Z');
    expect(deliveryLastAttemptAt(base)).toBeNull();
    expect(deliveryLastAttemptAt({ ...base, lastAttemptAt: at })).toEqual(at);
    expect(deliveryLastAttemptAt({ ...base, status: 'dead', deadAt: at })).toEqual(at);
  });

  it('커서는 왕복하고, 모양이 틀리면 null', () => {
    const cursor = { createdMicros: '1790000000000000', id: base.id };
    expect(decodeDeliveryCursor(encodeDeliveryCursor(cursor))).toEqual(cursor);
    for (const bad of ['', '!!', Buffer.from('0|x').toString('base64url'), Buffer.from(`1|${base.id}|x`).toString('base64url')]) {
      expect(decodeDeliveryCursor(bad), bad).toBeNull();
    }
  });
});
