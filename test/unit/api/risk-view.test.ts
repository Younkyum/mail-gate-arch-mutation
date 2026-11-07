/**
 * 묶음 B — 응답 `risk` 객체(`inbound-view.ts` `riskBody`)는 `classifyInboundLevel` 하나로 매긴다. 재료가 없으면 닫힌 쪽.
 */

import { describe, expect, it } from 'vitest';

import { riskBody, stateBody } from '../../../src/api/inbound-view';
import type { MessageFacts } from '../../../src/db/repositories/message-state-store';

const BASE: MessageFacts = {
  id: '11111111-1111-4111-8111-111111111111',
  quarantined: false,
  quarantineReason: null,
  injectionRisk: 'none',
  findings: [],
  trustedBypass: false,
  releasedFrom: null,
  labels: ['b', 'a'],
  firstReadAt: null,
};

describe('riskBody', () => {
  it('풀린 메일은 released 참 · 등급은 풀기 전 그대로 · 계열은 싣지 않는다', () => {
    const released = riskBody({ ...BASE, injectionRisk: 'high', releasedFrom: 'injection_risk' }, 'high', 'T2');
    expect(released).toMatchObject({ level: 'block', released: true, taint: 'T2' });
    expect(released).not.toHaveProperty('families');
  });

  it('none · risk(low + 움직이는 계열, 완화 안 됨) · block(격리) · 신뢰 발신자 우회', () => {
    expect(riskBody(BASE, 'none', 'T0')).toEqual({ level: 'none', trusted_bypass: false, released: false, untrusted_content: true, taint: 'T0' });
    const low = { ...BASE, injectionRisk: 'low' as const, findings: [{ family: 'narrative' as const, damped: false }, { family: 'authority' as const, damped: true }] };
    expect(riskBody(low, 'low', 'T2')).toMatchObject({ level: 'risk', taint: 'T2' });
    expect(riskBody({ ...low, findings: [{ family: 'narrative', damped: true }] }, 'low', null)).toMatchObject({ level: 'none' });
    expect(riskBody({ ...BASE, quarantined: true, quarantineReason: 'injection_risk', injectionRisk: 'high' }, null, null)).toMatchObject({ level: 'block' });
    expect(riskBody({ ...low, trustedBypass: true }, 'low', 'T1')).toMatchObject({ level: 'none', trusted_bypass: true });
  });

  it('재료가 없으면 닫힌 쪽 — low 이상이면 risk', () => {
    expect(riskBody(undefined, 'low', null)).toMatchObject({ level: 'risk', untrusted_content: true });
    expect(riskBody(undefined, 'none', null)).toMatchObject({ level: 'none' });
  });

  it('stateBody — 라벨 · 읽음', () => {
    expect(stateBody(BASE)).toEqual({ labels: ['b', 'a'], read: false });
    expect(stateBody({ ...BASE, firstReadAt: new Date() })).toMatchObject({ read: true });
    expect(stateBody(undefined)).toEqual({ labels: [], read: false });
  });
});
