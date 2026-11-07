/**
 * 적대적 검증 A-3 (순수 함수 단) — 등급 계산 · 설정 값 검증 · 같은 메일의 면별 등급 일관성.
 */

import { describe, expect, it } from 'vitest';

import { agentWatchPatchOf } from '../../../src/admin/ops/watch';
import type { RuleFamily } from '../../../src/security/injection/rule-types';
import { classifyInboundLevel, isRiskFamily, type InboundLevel, type LevelInput } from '../../../src/security/levels';
import { ACTIONABLE_FAMILIES, CONCEALED_FAMILIES, classifyTaint } from '../../../src/security/taint';
import { DEFAULT_AGENT_WATCH_SETTINGS, isRiskHandling } from '../../../src/watch/settings';

const ALL_FAMILIES: RuleFamily[] = [
  'override', 'ai_addressee', 'prompt_reference', 'prompt_leak', 'role_spoof', 'jailbreak', 'concealment', 'exfiltration', 'agent_action',
  'tool_invocation', 'authority', 'encoded', 'technique', 'obfuscation', 'evasion', 'narrative', 'scan_limit',
];

const open = (extra: Partial<LevelInput>): LevelInput => ({
  quarantined: false,
  quarantineReason: null,
  injectionRisk: 'none',
  findings: [],
  trustedBypass: false,
  ...extra,
});

describe('A-3 등급 계산 — 위험 등급을 만드는 계열(보이는 low)', () => {
  it.each(ALL_FAMILIES.map((family) => [family, ACTIONABLE_FAMILIES.has(family) || CONCEALED_FAMILIES.has(family)] as const))(
    '[L-F %s] low + 완화 안 된 %s 적중 → 위험 여부 = %s, 오염 등급(본문 T2 여부)과 일치',
    (family, moving) => {
      const level = classifyInboundLevel(open({ injectionRisk: 'low', findings: [{ family, damped: false }] })).level;
      expect(level).toBe(moving ? 'risk' : 'none');
      const taint = classifyTaint({
        surface: 'message_detail',
        field: 'body',
        injectionRisk: 'low',
        findings: [{ family, damped: false }],
        auth: { spf: 'pass', dkim: 'pass', dmarc: 'pass', fromAuthenticated: true },
        senderTrust: 'approved',
      });
      expect(taint === 'T2').toBe(moving);
    },
  );
  it.each(ALL_FAMILIES.map((family) => [family] as const))('[L-D %s] low + 완화된(damped) %s 적중 → none (위험 아님)', (family) => {
    expect(classifyInboundLevel(open({ injectionRisk: 'low', findings: [{ family, damped: true }] })).level).toBe('none');
  });
  it.each(ALL_FAMILIES.map((family) => [family] as const))('[L-S %s] 제목 면 오염 등급도 같은 계열 규칙(%s)', (family) => {
    const moving = isRiskFamily(family);
    const taint = classifyTaint({
      surface: 'message_list',
      field: 'subject',
      injectionRisk: 'low',
      findings: [{ family, damped: false }],
      auth: { spf: 'pass', dkim: 'pass', dmarc: 'pass', fromAuthenticated: true },
      senderTrust: 'approved',
    });
    expect(taint === 'T2').toBe(moving);
  });
});

describe('A-3 등급 계산 — 숨김 · 풀림 · 접힘(fail closed)', () => {
  const cases: [id: string, name: string, input: LevelInput, level: InboundLevel, policyBlocked?: boolean][] = [
    ['L-001', '깨끗한 none', open({}), 'none'],
    ['L-002', 'low 적중 없음', open({ injectionRisk: 'low' }), 'none'],
    ['L-003', '보이는 medium(DB CHECK 가 막는 행) → block', open({ injectionRisk: 'medium' }), 'block'],
    ['L-004', '보이는 high → block', open({ injectionRisk: 'high' }), 'block'],
    ['L-005', '보이는 판정 없음(null) → block', open({ injectionRisk: null }), 'block'],
    ['L-006', '격리 injection_risk → block', open({ quarantined: true, quarantineReason: 'injection_risk', injectionRisk: 'high' }), 'block'],
    ['L-007', '격리 scanner_error → block', open({ quarantined: true, quarantineReason: 'scanner_error', injectionRisk: null }), 'block'],
    ['L-008', '격리 policy_blocked → none · 정책 차단', open({ quarantined: true, quarantineReason: 'policy_blocked', injectionRisk: 'high' }), 'none', true],
    ['L-009', '격리 risk_hold → risk', open({ quarantined: true, quarantineReason: 'risk_hold', injectionRisk: 'low', findings: [{ family: 'narrative', damped: false }] }), 'risk'],
    ['L-010', '격리인데 사유가 null (비정상) → block', open({ quarantined: true, quarantineReason: null, injectionRisk: 'high' }), 'block'],
    ['L-011', '풀린 injection_risk → block', open({ releasedFrom: 'injection_risk', injectionRisk: 'high' }), 'block'],
    ['L-012', '풀린 risk_hold → risk', open({ releasedFrom: 'risk_hold', injectionRisk: 'low' }), 'risk'],
    ['L-013', '풀린 injection_risk 인데 판정이 low · 적중 없음 → 여전히 block', open({ releasedFrom: 'injection_risk', injectionRisk: 'low' }), 'block'],
    ['L-014', '풀린 risk_hold 인데 판정 none → risk', open({ releasedFrom: 'risk_hold', injectionRisk: 'none' }), 'risk'],
    ['L-015', 'releasedFrom null 은 풀리지 않음', open({ releasedFrom: null }), 'none'],
    ['L-016', '우회 + 보임 → none', open({ trustedBypass: true, injectionRisk: 'high' }), 'none'],
    ['L-017', '우회 플래그 + 격리 scanner_error → block (우회가 지우지 못함)', open({ trustedBypass: true, quarantined: true, quarantineReason: 'scanner_error', injectionRisk: null }), 'block'],
    ['L-018', '우회 플래그 + 격리 risk_hold → risk', open({ trustedBypass: true, quarantined: true, quarantineReason: 'risk_hold', injectionRisk: 'low' }), 'risk'],
    ['L-019', '우회 플래그 + 풀린 injection_risk → 우회가 이긴다(none) — 두 조건은 DB 에서 동시에 설 수 없다', open({ trustedBypass: true, releasedFrom: 'injection_risk', injectionRisk: 'high' }), 'none'],
    ['L-020', 'low + 움직이는 계열 + 풀린 risk_hold → risk', open({ releasedFrom: 'risk_hold', injectionRisk: 'low', findings: [{ family: 'override', damped: false }] }), 'risk'],
    ['L-021', 'none + 움직이는 계열 적중(비정상) → none', open({ injectionRisk: 'none', findings: [{ family: 'override', damped: false }] }), 'none'],
    ['L-022', 'low + 완화·비완화 섞임: 비완화 하나면 risk', open({ injectionRisk: 'low', findings: [{ family: 'override', damped: true }, { family: 'narrative', damped: false }] }), 'risk'],
    ['L-023', 'low + scan_limit 만 → none', open({ injectionRisk: 'low', findings: [{ family: 'scan_limit', damped: false }] }), 'none'],
    ['L-024', 'low + 같은 계열 중복 적중 → 계열은 한 번', open({ injectionRisk: 'low', findings: [{ family: 'narrative', damped: false }, { family: 'narrative', damped: false }] }), 'risk'],
  ];
  it.each(cases.map((c) => [`[${c[0]}] ${c[1]}`, c] as const))('%s', (_name, c) => {
    const result = classifyInboundLevel(c[2]);
    expect(result.level).toBe(c[3]);
    expect(result.policyBlocked).toBe(c[4] === true);
  });
  it('[L-025] 계열 목록은 정렬 · 중복 없음', () => {
    const r = classifyInboundLevel(open({ injectionRisk: 'low', findings: [{ family: 'override', damped: false }, { family: 'agent_action', damped: false }, { family: 'override', damped: false }] }));
    expect(r.families).toEqual(['agent_action', 'override']);
  });
  it('[L-026] 입력 findings 가 비어 있어도 던지지 않는다', () => {
    expect(() => classifyInboundLevel(open({ findings: [] }))).not.toThrow();
  });
});

describe('A-3 설정 값 검증(에이전트 PATCH 본문)', () => {
  const bad: [id: string, name: string, body: Record<string, unknown>][] = [
    ['L-S01', '빈 본문', {}],
    ['L-S02', 'riskHandling 대문자', { riskHandling: 'DELIVER' }],
    ['L-S03', 'riskHandling drop', { riskHandling: 'drop' }],
    ['L-S04', 'riskHandling null', { riskHandling: null }],
    ['L-S05', 'riskHandling 숫자', { riskHandling: 1 }],
    ['L-S06', 'riskHandling 배열', { riskHandling: ['hold'] }],
    ['L-S07', 'riskHandling 객체', { riskHandling: { v: 'hold' } }],
    ['L-S08', 'riskHandling 불리언', { riskHandling: true }],
    ['L-S09', 'riskHandling 공백 낀 hold', { riskHandling: ' hold' }],
    ['L-S10', 'riskHandling SQL', { riskHandling: "hold'; DROP TABLE agent_watch_settings;--" }],
    ['L-S11', 'riskNotify 문자열 false', { riskNotify: 'false' }],
    ['L-S12', 'riskNotify 숫자 0', { riskNotify: 0 }],
    ['L-S13', 'riskNotify null', { riskNotify: null }],
    ['L-S14', 'riskNotify 배열', { riskNotify: [false] }],
    ['L-S15', '모르는 키 trustedBypass(설정 칸 아님)', { riskHandling: 'hold', trustedBypass: true }],
    ['L-S16', '모르는 키 agentId', { riskHandling: 'hold', agentId: 'x' }],
    ['L-S17', '모르는 키 __proto__', JSON.parse('{"riskHandling":"hold","__proto__":{"x":1},"extra":1}') as Record<string, unknown>],
    ['L-S18', 'riskNotify 만 잘못 + riskHandling 정상', { riskHandling: 'hold', riskNotify: 'no' }],
  ];
  it.each(bad.map((b) => [`[${b[0]}] ${b[1]} → 거부`, b[2]] as const))('%s', (_n, body) => {
    expect(() => agentWatchPatchOf(body)).toThrow();
  });
  it('[L-S19] 대조: hold / deliver / 불리언은 통과', () => {
    expect(agentWatchPatchOf({ riskHandling: 'hold' })).toEqual({ riskHandling: 'hold', riskNotify: null, sendApproval: null });
    expect(agentWatchPatchOf({ riskNotify: false })).toEqual({ riskHandling: null, riskNotify: false, sendApproval: null });
    // 묶음 D — 발신 승인도 같은 본문의 알려진 칸이다.
    expect(agentWatchPatchOf({ sendApproval: 'always' })).toMatchObject({ sendApproval: 'always' });
  });
  it('[L-S20] 기본값: 행이 없으면 deliver · 알림 켬', () => {
    expect(DEFAULT_AGENT_WATCH_SETTINGS).toEqual({ riskHandling: 'deliver', riskNotify: true });
  });
  it.each(['hold', 'deliver'])('[L-S21 %s] isRiskHandling 참', (v) => {
    expect(isRiskHandling(v)).toBe(true);
  });
  it.each([['Hold'], [''], ['none'], [null], [undefined], [0]])('[L-S22 %s] isRiskHandling 거짓', (v) => {
    expect(isRiskHandling(v)).toBe(false);
  });
});
