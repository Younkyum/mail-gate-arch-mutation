/**
 * 정책 v2 — 방향별 4모드 + 연락처 목록 (계약 `.omc/handoffs/v2-contract.md` §1 · ADR-0007).
 *
 * ① 발신: 모드(6) × 목록 소속(4: 없음 · allow · block · 둘 다) **전수** — 판정과 사유가 표와 같다.
 * ② 모든 모드 공통 층: "전체"·"블랙리스트" 도 Stage 0(킬스위치·정지·동결·검토·billing)·신원·억제·한도·예산·내용을 통과해야 한다.
 * ③ 목록 매칭: 대소문자 · `+tag`(허용은 정확히, 차단은 넓게) · 도메인(정확 / `*.` 하위만 / 경계).
 * ④ 값 모양(`contactRuleKindOf`) — 콘솔·CLI·DB 가 같은 규칙.
 * ⑤ 수신 판정: 모드(4) × 소속 × 인증.
 * ⑥ 스냅샷 모양 · 콘솔 모드 이름 매핑.
 */

import { describe, expect, it } from 'vitest';

import type { ContactRuleRow, InboundMode } from '../../../src/db/schema';
import { evaluate } from '../../../src/policy/engine';
import {
  anyContactRuleMatches,
  contactRuleKindOf,
  contactRuleMatches,
  domainRuleCovers,
  normalizeContactRuleValue,
} from '../../../src/policy/contact-rules';
import { evaluateInboundPolicy, resolveInboundPolicy, type InboundPolicy } from '../../../src/policy/inbound-policy';
import {
  CONSOLE_INBOUND_MODES,
  CONSOLE_MODES,
  CONSOLE_OUTBOUND_MODES,
  consoleInboundModeOf,
  consoleOutboundModeOf,
} from '../../../src/policy/mode-names';
import { comparableAddress, normalizeAddress, PolicyShapeError, resolveOutboundRules } from '../../../src/policy/policy-loader';
import { policySnapshotOf } from '../../../src/policy/policy-snapshot';
import { INBOUND_MODES, OUTBOUND_MODES, type OutboundMode } from '../../../src/policy/types';
import { AGENT_ID, ALLOWED_RECIPIENT, contextWith, NOW, policyWith, STRANGER_RECIPIENT } from './fixtures';

// ---------------------------------------------------------------------------
// ① 발신 — 모드 × 목록 소속 전수
// ---------------------------------------------------------------------------

const MEMBERSHIPS = ['none', 'allow', 'block', 'both'] as const;
type Membership = (typeof MEMBERSHIPS)[number];

function listsFor(membership: Membership): { allowlist: string[]; blocklist: string[] } {
  return {
    allowlist: membership === 'allow' || membership === 'both' ? [ALLOWED_RECIPIENT] : [],
    blocklist: membership === 'block' || membership === 'both' ? [ALLOWED_RECIPIENT] : [],
  };
}

/** 표를 보지 않고 적은 기대값(계약 v2 §1 표 · 마이그레이션 202609241010 머리말의 "모드와 목록"). */
function expectedOutbound(mode: OutboundMode, membership: Membership): { verdict: string; reasons: readonly string[] } {
  const blocked = membership === 'block' || membership === 'both';
  switch (mode) {
    case 'disabled':
      return { verdict: 'denied', reasons: ['outbound_disabled'] };
    case 'unrestricted':
      // 전체 — 목록을 읽지 않는다(차단 목록에 있어도 나간다: ADR-0007 "전체" 의 위험).
      return { verdict: 'allowed', reasons: ['unrestricted_mode'] };
    case 'blocklist_only':
      return blocked ? { verdict: 'denied', reasons: ['recipient_blocklisted'] } : { verdict: 'allowed', reasons: ['not_blocklisted'] };
    case 'allowlist_only':
      if (blocked) return { verdict: 'denied', reasons: ['recipient_blocklisted'] };
      return membership === 'allow'
        ? { verdict: 'allowed', reasons: ['allowlist_match'] }
        : { verdict: 'denied', reasons: ['recipient_not_allowlisted'] };
    case 'approval_required':
    case 'reply_only':
      // 레거시 — 차단 목록은 여전히 이긴다. 목록 밖(관계 없음)은 승인 대기(reply_only 는 grace 중).
      if (blocked) return { verdict: 'denied', reasons: ['recipient_blocklisted'] };
      return {
        verdict: 'pending_approval',
        reasons: mode === 'reply_only' ? ['new_recipient', 'bootstrap_grace'] : ['new_recipient'],
      };
  }
}

describe('① 발신 — 모드(6) × 목록 소속(4) 전수', () => {
  const cases = OUTBOUND_MODES.flatMap((mode) => MEMBERSHIPS.map((membership) => ({ mode, membership })));

  it('24 케이스 — 축이 조용히 줄지 않는다', () => {
    expect(cases).toHaveLength(24);
  });

  for (const { mode, membership } of cases) {
    it(`${mode} × ${membership}`, () => {
      const decision = evaluate(contextWith({}), policyWith({ outboundMode: mode, ...listsFor(membership) }));
      const expected = expectedOutbound(mode, membership);
      expect(decision.verdict).toBe(expected.verdict);
      expect([...decision.reasons]).toEqual(expected.reasons);
    });
  }

  it('화이트리스트는 **승인 경로가 없다** — 목록 밖은 pending 이 아니라 거부(진윤겸 결정 ①)', () => {
    const decision = evaluate(contextWith({ attempt: { recipients: [STRANGER_RECIPIENT] } }), policyWith({ outboundMode: 'allowlist_only' }));
    expect(decision.verdict).toBe('denied');
    expect(decision.reasons).toEqual(['recipient_not_allowlisted']);
  });

  it('화이트리스트의 빈 목록은 아무도 허용하지 않는다(새 에이전트 기본값 — 결정 ②)', () => {
    const decision = evaluate(contextWith({}), policyWith({ outboundMode: 'allowlist_only', allowlist: [], blocklist: [] }));
    expect(decision.reasons).toEqual(['recipient_not_allowlisted']);
  });

  it('화이트리스트의 도메인 규칙 — `example.com` 은 정확히 그 도메인만, `*.example.com` 은 하위만', () => {
    const at = (recipient: string, allowlist: string[]) =>
      evaluate(contextWith({ attempt: { recipients: [recipient] } }), policyWith({ outboundMode: 'allowlist_only', allowlist })).verdict;
    expect(at('a@example.com', ['example.com'])).toBe('allowed');
    expect(at('a@mail.example.com', ['example.com'])).toBe('denied');
    expect(at('a@mail.example.com', ['*.example.com'])).toBe('allowed');
    expect(at('a@example.com', ['*.example.com'])).toBe('denied');
    expect(at('a@badexample.com', ['example.com', '*.example.com'])).toBe('denied');
  });

  it('수신자 여럿 — 한 명이라도 목록 밖이면 메시지 전체가 거부(부분 발송 없음)', () => {
    const decision = evaluate(
      contextWith({ attempt: { recipients: [ALLOWED_RECIPIENT, STRANGER_RECIPIENT] } }),
      policyWith({ outboundMode: 'allowlist_only', allowlist: [ALLOWED_RECIPIENT] }),
    );
    expect(decision.reasons).toEqual(['recipient_not_allowlisted']);
  });
});

// ---------------------------------------------------------------------------
// ② 모든 모드 공통 층
// ---------------------------------------------------------------------------

describe('② 모든 모드 공통 층 — "전체"·"블랙리스트" 도 Stage 0~6 을 지나야 한다', () => {
  const OPEN_MODES = ['unrestricted', 'blocklist_only', 'allowlist_only'] as const;
  const axes = [
    ['조직 결제 정지', contextWith({ organization: { billingStatus: 'suspended' } }), 'org_billing_blocked'],
    ['운영자 동결', contextWith({ organization: { abuseFreeze: true } }), 'org_abuse_freeze'],
    ['소유자 정지', contextWith({ organization: { ownerPaused: true } }), 'org_owner_paused'],
    ['검토 전 조직', contextWith({ organization: { reviewStatus: 'pending_review' } }), 'org_pending_review'],
    ['에이전트 정지', contextWith({ agent: { status: 'suspended' } }), 'agent_not_active'],
    ['from 위조', contextWith({ attempt: { fromAddress: 'someone@atmark.ai' } }), 'from_forgery'],
    ['억제 목록', contextWith({ suppressedRecipients: [ALLOWED_RECIPIENT] }), 'suppression_list'],
    ['분당 한도', contextWith({ counters: { agentLastMinute: 10 } }), 'rate_limit_per_minute'],
    ['예산', contextWith({ budget: { monthToDateSpentCents: 10_000 } }), 'budget_exhausted'],
    ['첨부 MIME', contextWith({ attempt: { attachments: [{ filename: 'x.exe', mimeType: 'application/x-msdownload', bytes: 1 }] } }), 'mime_type_not_allowed'],
  ] as const;

  for (const mode of OPEN_MODES) {
    for (const [name, ctx, reason] of axes) {
      it(`${mode} × ${name} → ${reason}`, () => {
        const decision = evaluate(ctx, policyWith({ outboundMode: mode }));
        expect(decision.verdict).toBe('denied');
        expect(decision.reasons).toContain(reason);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// ③ 목록 매칭
// ---------------------------------------------------------------------------

function rule(direction: ContactRuleRow['direction'], list: ContactRuleRow['list'], value: string): ContactRuleRow {
  return {
    id: `${direction}-${list}-${value}`,
    agent_id: AGENT_ID,
    direction,
    list,
    kind: value.includes('@') ? 'address' : 'domain',
    value,
    created_at: NOW,
    created_by: null,
    removed_at: null,
    removed_by: null,
  };
}

describe('③ 목록 매칭 — 대소문자 · +tag · 도메인', () => {
  it('주소 규칙은 정확 일치 — 비교형은 호출자가 맞춘다(허용 = 소문자·+tag 보존, 차단 = +tag 절단)', () => {
    const { allowlist, blocklist } = resolveOutboundRules([
      rule('outbound', 'allow', 'Sales+EU@Corp.com'),
      rule('outbound', 'block', 'Victim+x@Gmail.com'),
    ], []);
    // 허용: `sales+eu@` 만. `sales@`·다른 태그는 열지 않는다.
    expect(anyContactRuleMatches(allowlist, comparableAddress('SALES+EU@corp.com'))).toBe(true);
    expect(anyContactRuleMatches(allowlist, comparableAddress('sales@corp.com'))).toBe(false);
    expect(anyContactRuleMatches(allowlist, comparableAddress('sales+us@corp.com'))).toBe(false);
    // 차단: 태그를 바꿔 비껴가지 못한다.
    expect(anyContactRuleMatches(blocklist, normalizeAddress('victim+newsletter@gmail.com'))).toBe(true);
    expect(anyContactRuleMatches(blocklist, normalizeAddress('VICTIM@GMAIL.COM'))).toBe(true);
  });

  it('도메인 규칙 — 정확 · `*.` 하위만 · 접미사 경계 · 빈 도메인', () => {
    expect(domainRuleCovers('example.com', 'example.com')).toBe(true);
    expect(domainRuleCovers('example.com', 'mail.example.com')).toBe(false);
    expect(domainRuleCovers('*.example.com', 'mail.example.com')).toBe(true);
    expect(domainRuleCovers('*.example.com', 'a.b.example.com')).toBe(true);
    expect(domainRuleCovers('*.example.com', 'example.com')).toBe(false);
    expect(domainRuleCovers('*.example.com', 'notexample.com')).toBe(false);
    expect(domainRuleCovers('*.', 'x.com')).toBe(false);
    expect(domainRuleCovers('example.com', '')).toBe(false);
    expect(contactRuleMatches('example.com', 'no-at-sign')).toBe(false);
    expect(contactRuleMatches('a@example.com', 'a@example.com')).toBe(true);
    expect(anyContactRuleMatches([], 'a@example.com')).toBe(false);
  });

  it('발신 정책에 수신 규칙이 섞이면 던진다 · 수신 정책에 발신 규칙이 섞여도 던진다', () => {
    expect(() => resolveOutboundRules([rule('inbound', 'allow', 'a@example.com')], [])).toThrow(PolicyShapeError);
    expect(() => resolveInboundPolicy('all', [rule('outbound', 'allow', 'a@example.com')], 1)).toThrow(PolicyShapeError);
  });
});

// ---------------------------------------------------------------------------
// ④ 값 모양
// ---------------------------------------------------------------------------

describe('④ 값 모양 — contactRuleKindOf (DB atmark_contact_rule_kind 와 같은 정규식)', () => {
  it.each([
    ['a@example.com', 'address'],
    ['first.last+tag@sub.example.co.kr', 'address'],
    ["o'brien@example.ie", 'address'],
    ['example.com', 'domain'],
    ['*.example.com', 'domain'],
    ['xn--bcher-kva.example', 'domain'],
  ] as const)('%s → %s', (value, kind) => {
    expect(contactRuleKindOf(value)).toBe(kind);
  });

  it.each([
    '',
    '@example.com',
    'a@',
    'a@localhost',
    'localhost',
    'a b@example.com',
    'a@exa mple.com',
    'Example.com',
    'bücher.example',
    '한글@example.com',
    '*example.com',
    'a.*.example.com',
    '-bad.example.com',
    'a@@example.com',
    `${'a'.repeat(65)}@example.com`,
    `${'a'.repeat(250)}.com`,
  ])('%j → 거부(null)', (value) => {
    expect(contactRuleKindOf(value)).toBeNull();
  });

  it('입력 정규화는 trim + 소문자 — 대문자 입력도 저장형이 된다', () => {
    expect(normalizeContactRuleValue('  Partner.Example ')).toBe('partner.example');
    expect(contactRuleKindOf(normalizeContactRuleValue(' A@Example.COM '))).toBe('address');
  });
});

// ---------------------------------------------------------------------------
// ⑤ 수신 판정
// ---------------------------------------------------------------------------

describe('⑤ 수신 — 모드(4) × 소속 × 인증', () => {
  const SENDER = 'bob+news@partner.example';
  function policyOf(mode: InboundMode, allow: string[], block: string[]): InboundPolicy {
    return resolveInboundPolicy(
      mode,
      [...allow.map((value) => rule('inbound', 'allow', value)), ...block.map((value) => rule('inbound', 'block', value))],
      7,
    );
  }

  it('모드 4개가 전부 분기를 갖는다(열거형 전수)', () => {
    expect(INBOUND_MODES).toEqual(['all', 'allowlist_only', 'blocklist_only', 'disabled']);
  });

  it('all — 목록·인증과 무관하게 보인다', () => {
    for (const authenticated of [true, false]) {
      expect(evaluateInboundPolicy(policyOf('all', [], [SENDER]), { address: SENDER, authenticated })).toEqual({ kind: 'deliver' });
    }
  });

  it('disabled — 전부 격리(inbound_disabled)', () => {
    expect(evaluateInboundPolicy(policyOf('disabled', [SENDER], []), { address: SENDER, authenticated: true })).toEqual({
      kind: 'quarantine',
      reason: 'inbound_disabled',
    });
  });

  it('blocklist_only — 차단(주소 +tag 절단 · 도메인)이면 격리, **인증 여부와 무관**', () => {
    for (const authenticated of [true, false]) {
      expect(evaluateInboundPolicy(policyOf('blocklist_only', [], ['bob@partner.example']), { address: SENDER, authenticated })).toEqual({
        kind: 'quarantine',
        reason: 'sender_blocklisted',
      });
      expect(evaluateInboundPolicy(policyOf('blocklist_only', [], ['*.example']), { address: SENDER, authenticated }).kind).toBe('quarantine');
      expect(evaluateInboundPolicy(policyOf('blocklist_only', [], ['other.example']), { address: SENDER, authenticated })).toEqual({
        kind: 'deliver',
      });
    }
  });

  it('allowlist_only — 인증된 발신자가 목록에 있을 때만 · 인증 실패는 목록 밖 · 차단이 이긴다', () => {
    const allowExact = policyOf('allowlist_only', [SENDER], []);
    expect(evaluateInboundPolicy(allowExact, { address: SENDER, authenticated: true })).toEqual({ kind: 'deliver' });
    expect(evaluateInboundPolicy(allowExact, { address: SENDER, authenticated: false })).toEqual({
      kind: 'quarantine',
      reason: 'sender_not_allowlisted',
    });
    // 허용은 좁게 — 태그 없는 주소는 `bob+news@` 규칙에 맞지 않는다.
    expect(evaluateInboundPolicy(allowExact, { address: 'bob@partner.example', authenticated: true }).kind).toBe('quarantine');
    const byDomain = policyOf('allowlist_only', ['partner.example'], []);
    expect(evaluateInboundPolicy(byDomain, { address: SENDER, authenticated: true })).toEqual({ kind: 'deliver' });
    const both = policyOf('allowlist_only', ['partner.example'], ['bob@partner.example']);
    expect(evaluateInboundPolicy(both, { address: SENDER, authenticated: true })).toEqual({ kind: 'quarantine', reason: 'sender_blocklisted' });
  });

  it('열거형 밖 모드(DB 가 넘긴 이상값)는 격리 — 열리는 쪽으로 떨어지지 않는다', () => {
    const rogue = { mode: 'nope' as unknown as InboundMode, allow: [SENDER], block: [], version: 1 };
    expect(evaluateInboundPolicy(rogue, { address: SENDER, authenticated: true }).kind).toBe('quarantine');
  });
});

// ---------------------------------------------------------------------------
// ⑥ 스냅샷 · 콘솔 이름
// ---------------------------------------------------------------------------

describe('⑥ 스냅샷 모양 · 콘솔 모드 이름', () => {
  it('스냅샷은 모드 둘 · 한도 · config · 목록 전문(방향→목록→값 순, 입력 순서와 무관)', () => {
    const rules = [rule('outbound', 'block', 'z.example'), rule('inbound', 'allow', 'a@x.example'), rule('outbound', 'allow', 'b@y.example')];
    const snapshot = policySnapshotOf({ outboundMode: 'allowlist_only', inboundMode: 'all', limits: { per_minute: 5 }, configJson: {}, rules });
    expect(snapshot).toEqual({
      outbound_mode: 'allowlist_only',
      inbound_mode: 'all',
      limits: { per_minute: 5 },
      config_json: {},
      contact_rules: [
        { id: 'inbound-allow-a@x.example', direction: 'inbound', list: 'allow', kind: 'address', value: 'a@x.example' },
        { id: 'outbound-allow-b@y.example', direction: 'outbound', list: 'allow', kind: 'address', value: 'b@y.example' },
        { id: 'outbound-block-z.example', direction: 'outbound', list: 'block', kind: 'domain', value: 'z.example' },
      ],
    });
    expect(policySnapshotOf({ outboundMode: 'allowlist_only', inboundMode: 'all', limits: {}, configJson: {}, rules: [...rules].reverse() })).toEqual(
      policySnapshotOf({ outboundMode: 'allowlist_only', inboundMode: 'all', limits: {}, configJson: {}, rules }),
    );
  });

  it('콘솔 이름 ↔ enum 은 왕복한다 · 레거시 발신은 legacy', () => {
    for (const name of CONSOLE_MODES) {
      expect(consoleOutboundModeOf(CONSOLE_OUTBOUND_MODES[name])).toBe(name);
      expect(consoleInboundModeOf(CONSOLE_INBOUND_MODES[name])).toBe(name);
    }
    expect(consoleOutboundModeOf('approval_required')).toBe('legacy');
    expect(consoleOutboundModeOf('reply_only')).toBe('legacy');
    // 발신 enum 은 전부 이름이 있다(레거시 포함) — 표가 enum 과 갈라지지 않는다.
    for (const mode of OUTBOUND_MODES) expect(consoleOutboundModeOf(mode)).toMatch(/^(all|allowlist|blocklist|none|legacy)$/);
    expect(() => consoleInboundModeOf('nope' as unknown as InboundMode)).toThrow();
  });
});
