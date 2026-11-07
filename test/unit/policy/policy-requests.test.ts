/**
 * 에이전트의 정책 변경 요청(ADR-0007 2026-10-13) — 순수 규칙(`src/policy/policy-requests.ts`): 닫힌 어휘 · 값 모양 · 이유 · 지문(이유 제외) · 상태 읽기.
 */

import { describe, expect, it } from 'vitest';

import {
  effectivePolicyRequestStatus,
  parsePolicyRequest,
  policyRequestChangeBody,
  policyRequestChangeOf,
  policyRequestHash,
  PolicyRequestInputError,
  POLICY_REQUEST_REASON_MAX,
  POLICY_REQUEST_TTL_DAYS,
  POLICY_REQUESTS_PENDING_MAX,
  POLICY_REQUESTS_PER_DAY,
} from '../../../src/policy/policy-requests';

function codeOf(body: Record<string, unknown>): string {
  try {
    parsePolicyRequest(body);
  } catch (error) {
    if (error instanceof PolicyRequestInputError) return error.code;
    throw error;
  }
  return 'ok';
}

const REASON = 'Owner asked me to reach the partner.';

describe('정책 변경 요청 — 입력', () => {
  it('목록 항목 · 모드 — 값은 저장형(소문자 · trim)으로', () => {
    expect(parsePolicyRequest({ action: 'add_rule', direction: 'outbound', list: 'allow', value: '  Boss+Team@Partner.Example ', reason: ` ${REASON} ` })).toEqual({
      change: { action: 'add_rule', direction: 'outbound', list: 'allow', value: 'boss+team@partner.example' },
      reason: REASON,
    });
    expect(parsePolicyRequest({ action: 'remove_rule', direction: 'inbound', list: 'block', value: '*.Spam.Example', reason: REASON }).change).toEqual({
      action: 'remove_rule',
      direction: 'inbound',
      list: 'block',
      value: '*.spam.example',
    });
    expect(parsePolicyRequest({ action: 'set_mode', direction: 'inbound', mode: 'none', reason: REASON }).change).toEqual({ action: 'set_mode', direction: 'inbound', mode: 'none' });
  });

  it('★ 요청할 수 없는 것 — 모르는 칸 · 모르는 동작 · 레거시 모드 · 목록 밖 이름은 거부(조용히 버리지 않는다)', () => {
    const base = { action: 'set_mode', direction: 'outbound', mode: 'all', reason: REASON };
    for (const key of ['emergency_stop', 'risk_hold', 'risk_handling', 'send_approval', 'trusted_senders', 'scopes', 'capabilities', 'webhooks', 'self_enroll', 'limits', 'per_minute', 'agent_id']) {
      expect(codeOf({ ...base, [key]: 'x' }), key).toBe('invalid_request');
    }
    for (const action of ['suspend', 'resume', 'set_risk_hold', 'add_trusted_sender', 'grant_scope', 'set_limit', '', 'ADD_RULE']) {
      expect(codeOf({ ...base, action }), action).toBe('invalid_action');
    }
    for (const mode of ['approval_required', 'reply_only', 'legacy', 'unrestricted', 'allowlist_only', 'ALL', '']) {
      expect(codeOf({ ...base, mode }), mode).toBe('invalid_mode');
    }
    expect(codeOf({ action: 'add_rule', direction: 'outbound', list: 'trusted', value: 'a@b.example', reason: REASON })).toBe('invalid_list');
    expect(codeOf({ action: 'add_rule', direction: 'both', list: 'allow', value: 'a@b.example', reason: REASON })).toBe('invalid_direction');
    expect(codeOf({ action: 'add_rule', direction: 'outbound', list: 'allow', value: 'a@b.example', mode: 'all', reason: REASON })).toBe('invalid_request');
    expect(codeOf({ action: 'set_mode', direction: 'outbound', mode: 'all', list: 'allow', reason: REASON })).toBe('invalid_request');
    expect(codeOf({ action: 'add_rule', direction: 'outbound', list: 'allow', reason: REASON })).toBe('invalid_rule_value');
    expect(codeOf({ action: 1, direction: 'outbound', reason: REASON })).toBe('invalid_request');
  });

  it('값 — 연락처 규칙 모양(관리 연산과 같은 검사) · 발신 allow 의 atmark.ai 도메인은 rule_platform_domain(차단 쪽은 된다)', () => {
    for (const value of ['"q"@b.example', 'bad@b.example.', 'a b@c.example', 'ㅎ@b.example', '@b.example', 'b', '*.']) {
      expect(codeOf({ action: 'add_rule', direction: 'outbound', list: 'allow', value, reason: REASON }), value).toBe('invalid_rule_value');
    }
    for (const value of ['atmark.ai', '*.atmark.ai', 'x.atmark.ai']) {
      expect(codeOf({ action: 'add_rule', direction: 'outbound', list: 'allow', value, reason: REASON }), value).toBe('rule_platform_domain');
      expect(codeOf({ action: 'add_rule', direction: 'outbound', list: 'block', value, reason: REASON }), value).toBe('ok');
    }
    expect(codeOf({ action: 'add_rule', direction: 'outbound', list: 'allow', value: 'friend@atmark.ai', reason: REASON })).toBe('ok');
  });

  it('이유 — 필수 · 500자 · 한 줄(제어 문자 없음)', () => {
    const base = { action: 'set_mode', direction: 'outbound', mode: 'none' };
    expect(codeOf(base)).toBe('reason_required');
    expect(codeOf({ ...base, reason: '   ' })).toBe('reason_required');
    expect(codeOf({ ...base, reason: 'x'.repeat(POLICY_REQUEST_REASON_MAX) })).toBe('ok');
    expect(codeOf({ ...base, reason: 'x'.repeat(POLICY_REQUEST_REASON_MAX + 1) })).toBe('reason_too_long');
    expect(codeOf({ ...base, reason: '한'.repeat(POLICY_REQUEST_REASON_MAX) })).toBe('ok');
    for (const reason of ['a\nb', 'a\tb', 'a\u0007b', 'a\u007fb']) expect(codeOf({ ...base, reason }), JSON.stringify(reason)).toBe('invalid_request');
  });

  it('상수 — 7일 · pending 5 · 하루 20(DB 정의자 함수 · CHECK 와 같은 값)', () => {
    expect([POLICY_REQUEST_TTL_DAYS, POLICY_REQUESTS_PENDING_MAX, POLICY_REQUESTS_PER_DAY, POLICY_REQUEST_REASON_MAX]).toEqual([7, 5, 20, 500]);
  });
});

describe('정책 변경 요청 — 지문 · 모양 · 상태', () => {
  it('★ 지문은 변경만 본다 — 이유가 달라도 같다 · 값의 철자(대소문자 · 공백)는 저장형으로 접힌 뒤라 같다 · 다른 변경은 다르다', () => {
    const a = parsePolicyRequest({ action: 'add_rule', direction: 'outbound', list: 'allow', value: 'A@B.example', reason: 'one' });
    const b = parsePolicyRequest({ action: 'add_rule', direction: 'outbound', list: 'allow', value: ' a@b.example', reason: 'two' });
    expect(policyRequestHash(a.change)).toBe(policyRequestHash(b.change));
    expect(policyRequestHash(a.change)).toMatch(/^[0-9a-f]{64}$/);
    const others = [
      { action: 'remove_rule', direction: 'outbound', list: 'allow', value: 'a@b.example' },
      { action: 'add_rule', direction: 'inbound', list: 'allow', value: 'a@b.example' },
      { action: 'add_rule', direction: 'outbound', list: 'block', value: 'a@b.example' },
      { action: 'add_rule', direction: 'outbound', list: 'allow', value: 'a+x@b.example' },
    ] as const;
    for (const other of others) expect(policyRequestHash(other), JSON.stringify(other)).not.toBe(policyRequestHash(a.change));
    expect(policyRequestHash({ action: 'set_mode', direction: 'outbound', mode: 'all' })).not.toBe(policyRequestHash({ action: 'set_mode', direction: 'inbound', mode: 'all' }));
  });

  it('DB 행 → 변경(모양이 틀리면 null) · 에이전트 표면 모양', () => {
    expect(policyRequestChangeOf({ action: 'set_mode', direction: 'outbound', list: null, value: null, mode: 'blocklist' })).toEqual({ action: 'set_mode', direction: 'outbound', mode: 'blocklist' });
    expect(policyRequestChangeOf({ action: 'set_mode', direction: 'outbound', list: null, value: null, mode: 'legacy' })).toBeNull();
    expect(policyRequestChangeOf({ action: 'add_rule', direction: 'outbound', list: 'allow', value: null, mode: null })).toBeNull();
    expect(policyRequestChangeOf({ action: 'drop', direction: 'outbound', list: 'allow', value: 'a@b.example', mode: null })).toBeNull();
    expect(policyRequestChangeBody({ action: 'add_rule', direction: 'inbound', list: 'block', value: 'x.example' })).toEqual({ action: 'add_rule', direction: 'inbound', list: 'block', value: 'x.example' });
  });

  it('지난 pending 은 expired 로 읽는다 · 결정된 것은 그대로', () => {
    const now = new Date('2026-10-13T00:00:00Z');
    expect(effectivePolicyRequestStatus('pending', new Date('2026-10-12T23:59:59Z'), now)).toBe('expired');
    expect(effectivePolicyRequestStatus('pending', now, now)).toBe('expired');
    expect(effectivePolicyRequestStatus('pending', new Date('2026-10-13T00:00:01Z'), now)).toBe('pending');
    expect(effectivePolicyRequestStatus('approved', new Date('2026-10-01T00:00:00Z'), now)).toBe('approved');
  });
});
