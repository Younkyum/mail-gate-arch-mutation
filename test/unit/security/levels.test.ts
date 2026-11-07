import { describe, expect, it } from 'vitest';

import { classifyInboundLevel, type LevelInput } from '../../../src/security/levels';

const base: LevelInput = { quarantined: false, quarantineReason: null, injectionRisk: 'none', findings: [], trustedBypass: false };

describe('classifyInboundLevel — 위험/차단 두 등급', () => {
  it('격리(인젝션 · 스캐너 오류)는 차단', () => {
    expect(classifyInboundLevel({ ...base, quarantined: true, quarantineReason: 'injection_risk', injectionRisk: 'high' }).level).toBe('block');
    expect(classifyInboundLevel({ ...base, quarantined: true, quarantineReason: 'scanner_error', injectionRisk: null }).level).toBe('block');
  });
  it('정책 차단은 인젝션 등급이 아니다', () => {
    const r = classifyInboundLevel({ ...base, quarantined: true, quarantineReason: 'policy_blocked' });
    expect(r).toMatchObject({ level: 'none', policyBlocked: true });
  });
  it('low + 움직이는 계열(서술형 포함)은 위험, 완화된 적중 · 뉴스레터형은 아니다', () => {
    expect(classifyInboundLevel({ ...base, injectionRisk: 'low', findings: [{ family: 'narrative', damped: false }] }).level).toBe('risk');
    expect(classifyInboundLevel({ ...base, injectionRisk: 'low', findings: [{ family: 'encoded', damped: false }] }).level).toBe('risk');
    expect(classifyInboundLevel({ ...base, injectionRisk: 'low', findings: [{ family: 'narrative', damped: true }] }).level).toBe('none');
    expect(classifyInboundLevel({ ...base, injectionRisk: 'low', findings: [{ family: 'ai_addressee', damped: false }] }).level).toBe('none');
  });
  it('신뢰 발신자 우회는 격리되지 않은 메일만 none 으로', () => {
    expect(classifyInboundLevel({ ...base, injectionRisk: 'low', findings: [{ family: 'narrative', damped: false }], trustedBypass: true })).toMatchObject({
      level: 'none',
      trustedBypass: true,
    });
    expect(classifyInboundLevel({ ...base, quarantined: true, quarantineReason: 'injection_risk', injectionRisk: 'high', trustedBypass: true }).level).toBe('block');
  });
  it('위험 보류(risk_hold)는 숨었어도 위험 등급 — 차단이 아니다', () => {
    const r = classifyInboundLevel({ ...base, quarantined: true, quarantineReason: 'risk_hold', injectionRisk: 'low', findings: [{ family: 'narrative', damped: false }, { family: 'ai_addressee', damped: false }] });
    expect(r).toMatchObject({ level: 'risk', families: ['narrative'] });
  });
  it('풀린 메일은 풀기 전 등급 그대로 — 보여도 block/risk', () => {
    expect(classifyInboundLevel({ ...base, injectionRisk: 'high', releasedFrom: 'injection_risk', findings: [{ family: 'override', damped: false }] })).toMatchObject({ level: 'block', families: ['override'] });
    // 스캐너가 low 로 격리한 메일도 풀린 뒤 block 이다(위험도가 아니라 무엇에서 풀렸나).
    expect(classifyInboundLevel({ ...base, injectionRisk: 'low', releasedFrom: 'injection_risk' }).level).toBe('block');
    expect(classifyInboundLevel({ ...base, injectionRisk: 'low', releasedFrom: 'risk_hold', findings: [{ family: 'narrative', damped: false }] }).level).toBe('risk');
  });
  it('★ 격리되지 않았는데 판정 없음 · medium 이상이면 block(fail closed)', () => {
    expect(classifyInboundLevel({ ...base, injectionRisk: null }).level).toBe('block');
    expect(classifyInboundLevel({ ...base, injectionRisk: 'medium' }).level).toBe('block');
  });
});
