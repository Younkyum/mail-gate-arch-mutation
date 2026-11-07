import { describe, expect, it } from 'vitest';

import { DEFAULT_AGENT_WATCH_SETTINGS, isRiskHandling, matchesTrustedSender, parseTrustedSender } from '../../../src/watch/settings';

describe('감시 설정 — 신뢰 발신자 모양 · 일치', () => {
  it('기본값은 오늘 동작(deliver) + 위험 알림 켬', () => {
    expect(DEFAULT_AGENT_WATCH_SETTINGS).toEqual({ riskHandling: 'deliver', riskNotify: true });
    expect(isRiskHandling('hold')).toBe(true);
    expect(isRiskHandling('drop')).toBe(false);
  });

  it('한 줄 → 주소 또는 도메인(소문자 · 공백 제거) · 와일드카드 · 모양 틀림은 null', () => {
    expect(parseTrustedSender(' Partner.Example ')).toEqual({ kind: 'domain', value: 'partner.example' });
    expect(parseTrustedSender('Boss@Corp.Example')).toEqual({ kind: 'address', value: 'boss@corp.example' });
    expect(parseTrustedSender('xn--9n2bp8q.example')).toEqual({ kind: 'domain', value: 'xn--9n2bp8q.example' });
    for (const bad of ['', '*.partner.example', 'localhost', '@partner.example', 'a@b@c.example', 'a b@c.example', 'partner', 'x@-bad.example', `${'a'.repeat(65)}@c.example`, 'a\u0000@c.example']) {
      expect(parseTrustedSender(bad), bad).toBeNull();
    }
  });

  it('★ DMARC 인증된 From 만 · 주소는 정확히 · 도메인은 정확히(하위 도메인 아님)', () => {
    const entries = [
      { kind: 'domain', value: 'partner.example' },
      { kind: 'address', value: 'boss@corp.example' },
    ] as const;
    expect(matchesTrustedSender(entries, { fromAddress: 'ceo@partner.example', fromAuthenticated: true })).toBe(true);
    expect(matchesTrustedSender(entries, { fromAddress: 'CEO@Partner.Example', fromAuthenticated: true })).toBe(true);
    expect(matchesTrustedSender(entries, { fromAddress: 'ceo@partner.example', fromAuthenticated: false })).toBe(false);
    expect(matchesTrustedSender(entries, { fromAddress: 'x@mail.partner.example', fromAuthenticated: true })).toBe(false);
    expect(matchesTrustedSender(entries, { fromAddress: 'x@evilpartner.example', fromAuthenticated: true })).toBe(false);
    expect(matchesTrustedSender(entries, { fromAddress: 'boss@corp.example', fromAuthenticated: true })).toBe(true);
    expect(matchesTrustedSender(entries, { fromAddress: 'intern@corp.example', fromAuthenticated: true })).toBe(false);
    expect(matchesTrustedSender([], { fromAddress: 'ceo@partner.example', fromAuthenticated: true })).toBe(false);
  });
});
