/**
 * 정책 v2 보정(202609241040) — 순수 함수 층 (검증 M2·M3·L1·L2).
 *
 *   M2  발신 수신자 모양 = ASCII dot-atom(`isOutboundRecipientAddress`) — 관문 선적재가 모양 밖 수신자를 판정 전에 끊는다.
 *       규칙 값 모양도 dot-atom(`contactRuleKindOf`).
 *   M3  관문의 목록은 **버전 스냅샷**(`snapshotContactRules`) — 살아 있는 테이블이 아니다.
 *   L1  자기 주소로는 어떤 모드에서도 못 보낸다(`recipient_is_self`) · 발신 allow 의 atmark.ai 도메인 규칙은 판정에서 버린다.
 *   L2  수신 차단은 봉투 발신자·SES 가 본 From 도메인·따옴표 로컬파트까지 맞춘다.
 */

import { describe, expect, it } from 'vitest';

import { AGENT_ADDRESS_DOMAIN } from '../../../src/identity/address';
import {
  canonicalMailboxForBlock,
  contactRuleKindOf,
  isOutboundRecipientAddress,
  isPlatformDomainRule,
  PLATFORM_DOMAIN,
} from '../../../src/policy/contact-rules';
import { evaluate } from '../../../src/policy/engine';
import { evaluateInboundPolicy, resolveInboundPolicy } from '../../../src/policy/inbound-policy';
import {
  loadEvaluationInput,
  PolicyShapeError,
  resolveOutboundRules,
  snapshotContactRules,
  type PolicySource,
} from '../../../src/policy/policy-loader';
import type { SnapshotRule } from '../../../src/policy/policy-snapshot';
import { OUTBOUND_MODES } from '../../../src/policy/types';
import { AGENT_ADDRESS, AGENT_ID, baseAttempt, contextWith, NOW, policyWith } from './fixtures';

const rule = (direction: SnapshotRule['direction'], list: SnapshotRule['list'], value: string): SnapshotRule => ({
  id: `r-${direction}-${list}-${value}`,
  direction,
  list,
  kind: value.includes('@') ? 'address' : 'domain',
  value,
});

describe('M2 — 발신 수신자 모양(ASCII dot-atom)', () => {
  it.each([
    'friend@example.com',
    'Friend+Tag@Mail.Example.COM',
    "o'brien@example.ie",
    'first.last@sub.example.co.kr',
    "x!#$%&'*+/=?^_`{|}~-@example.com",
    `${'a'.repeat(64)}@example.com`,
  ])('받는다 %j', (address) => {
    expect(isOutboundRecipientAddress(address)).toBe(true);
  });

  it.each([
    '"bad"@x.com',
    '"bad@x.com"@y.com',
    'bad@x.com.',
    'bad\\@x.com',
    'b\\ad@x.com',
    '.bad@x.com',
    'bad.@x.com',
    'b..ad@x.com',
    'bad@x..com',
    'bad@.x.com',
    'bad@-x.com',
    'bad@x-.com',
    'bad@localhost',
    'u@[1.2.3.4]',
    'bäd@x.com',
    'bad@bücher.example',
    'bad@x.com​',
    'Kim@x.com',
    ' bad@x.com',
    'bad@x.com\r\nBcc: e@y.com',
    'bad(comment)@x.com',
    'a@b@c.com',
    `${'a'.repeat(65)}@example.com`,
    `a@${'b'.repeat(250)}.com`,
    '',
  ])('받지 않는다 %j', (address) => {
    expect(isOutboundRecipientAddress(address)).toBe(false);
  });

  it('규칙 값의 주소 모양도 dot-atom — 앞·뒤·연속 점·따옴표·끝 점 도메인은 목록에 들어가지 않는다', () => {
    for (const value of ['.a@x.com', 'a.@x.com', 'a..b@x.com', '"a"@x.com', 'a@x.com.', 'x.com.']) {
      expect(contactRuleKindOf(value), value).toBeNull();
    }
    expect(contactRuleKindOf('a.b@x.com')).toBe('address');
  });

  it('관문 선적재 — 모양 밖 수신자는 소스를 읽기 전에 PolicyShapeError(관문 evaluation_error · fail closed)', async () => {
    let loaded = 0;
    const source: PolicySource = {
      load: () => {
        loaded += 1;
        return Promise.reject(new Error('읽으면 안 된다'));
      },
    };
    for (const recipients of [['"bad"@x.com'], ['ok@x.com', 'bad@x.com.'], ['bad\\@x.com']]) {
      await expect(
        loadEvaluationInput(source, {
          agentId: AGENT_ID,
          now: NOW,
          traceId: null,
          thisAttemptCostCents: 0,
          release: null,
          attempt: { ...baseAttempt, recipients },
        }),
      ).rejects.toBeInstanceOf(PolicyShapeError);
    }
    expect(loaded).toBe(0);
  });
});

describe('M3 — 판정 목록은 버전 스냅샷에서', () => {
  it('contact_rules 가 없으면 빈 목록(v2 이전 모양) · 배열이 아니거나 원소 모양이 틀리면 던진다', () => {
    expect(snapshotContactRules({})).toEqual([]);
    for (const bad of [
      { contact_rules: 'friend@example.com' },
      { contact_rules: ['friend@example.com'] },
      { contact_rules: [{ id: 'x', direction: 'outbound', list: 'allow', kind: 'domain', value: 'a@b.com' }] },
      { contact_rules: [{ id: 'x', direction: 'sideways', list: 'allow', kind: 'address', value: 'a@b.com' }] },
      { contact_rules: [{ id: 'x', direction: 'outbound', list: 'maybe', kind: 'address', value: 'a@b.com' }] },
      { contact_rules: [{ direction: 'outbound', list: 'allow', kind: 'address', value: 'a@b.com' }] },
      { contact_rules: [null] },
    ]) {
      expect(() => snapshotContactRules(bad), JSON.stringify(bad)).toThrow(PolicyShapeError);
    }
    const rules = [rule('outbound', 'allow', 'a@b.com'), rule('inbound', 'block', 'evil.com')];
    expect(snapshotContactRules({ contact_rules: rules })).toEqual(rules);
  });
});

describe('L1 — 자기 주소 · 플랫폼 도메인', () => {
  // 수신자는 로더가 판정형(`+tag` 절단)으로 넘긴다 — `agent+loop@` 가 여기 오면 `agent@` 다(로더 경유 케이스는 policy-loader.test).
  it.each(OUTBOUND_MODES.filter((mode) => mode !== 'disabled'))('%s — 자기 주소로는 못 보낸다: recipient_is_self', (mode) => {
    for (const recipients of [[AGENT_ADDRESS], ['friend@example.com', AGENT_ADDRESS]]) {
      const decision = evaluate(
        contextWith({ attempt: { recipients } }),
        policyWith({ outboundMode: mode, allowlist: ['friend@example.com', AGENT_ADDRESS], blocklist: [] }),
      );
      expect([decision.verdict, decision.reasons], `${mode} ${recipients.join(',')}`).toEqual(['denied', ['recipient_is_self']]);
    }
  });

  it('같은 도메인의 **다른** 에이전트는 자기 주소가 아니다 — 모드가 정한다', () => {
    const decision = evaluate(contextWith({ attempt: { recipients: ['peer@atmark.ai'] } }), policyWith({ outboundMode: 'unrestricted' }));
    expect(decision.verdict).toBe('allowed');
  });

  it('플랫폼 도메인 판별 · 발신 allow 의 atmark.ai 도메인 규칙은 판정에서 버린다(차단 쪽·주소 규칙은 그대로)', () => {
    expect(PLATFORM_DOMAIN).toBe(AGENT_ADDRESS_DOMAIN);
    for (const value of ['atmark.ai', '*.atmark.ai', 'mail.atmark.ai']) expect(isPlatformDomainRule(value), value).toBe(true);
    for (const value of ['notatmark.ai', 'atmark.ai.evil.com', 'peer@atmark.ai', 'example.com']) expect(isPlatformDomainRule(value), value).toBe(false);
    const { allowlist, blocklist } = resolveOutboundRules([
      rule('outbound', 'allow', 'atmark.ai'),
      rule('outbound', 'allow', '*.atmark.ai'),
      rule('outbound', 'allow', 'peer@atmark.ai'),
      rule('outbound', 'allow', 'example.com'),
      rule('outbound', 'block', 'atmark.ai'),
    ], []);
    expect(allowlist).toEqual(['peer@atmark.ai', 'example.com']);
    expect(blocklist).toEqual(['atmark.ai']);
    const decision = evaluate(contextWith({ attempt: { recipients: ['other@atmark.ai'] } }), policyWith({ outboundMode: 'allowlist_only', allowlist, blocklist: [] }));
    expect(decision.reasons).toEqual(['recipient_not_allowlisted']);
  });
});

describe('L2 — 수신 차단은 봉투 발신자 · SES 의 From 도메인 · 따옴표 로컬파트까지', () => {
  const blockPolicy = (mode: 'blocklist_only' | 'allowlist_only') =>
    resolveInboundPolicy(mode, [rule('inbound', 'block', 'bad@x.com'), rule('inbound', 'block', 'evil.com'), rule('inbound', 'allow', 'friend@ok.com')], 1);

  it('차단 비교형 — 따옴표·<>·끝 점을 푼다', () => {
    expect(canonicalMailboxForBlock('"bad"@x.com')).toBe('bad@x.com');
    expect(canonicalMailboxForBlock('"b\\ad"@X.COM.')).toBe('bad@x.com');
    expect(canonicalMailboxForBlock('<Bad@X.com>')).toBe('bad@x.com');
    expect(canonicalMailboxForBlock('nope')).toBe('');
  });

  it.each(['blocklist_only', 'allowlist_only'] as const)('%s — From 이 깨끗해도 봉투·SES 도메인·따옴표 철자가 걸리면 격리', (mode) => {
    const policy = blockPolicy(mode);
    const blocked = { kind: 'quarantine', reason: 'sender_blocklisted' };
    expect(evaluateInboundPolicy(policy, { address: '"bad"@x.com', authenticated: true })).toEqual(blocked);
    expect(evaluateInboundPolicy(policy, { address: 'bad@x.com.', authenticated: true })).toEqual(blocked);
    expect(evaluateInboundPolicy(policy, { address: 'friend@ok.com', authenticated: true, envelopeSender: 'Bad+bounce@X.com' })).toEqual(blocked);
    // 도메인 규칙 `evil.com` 은 정확히 그 도메인만(하위는 `*.evil.com`) — 봉투 쪽도 같은 매칭이다.
    expect(evaluateInboundPolicy(policy, { address: 'friend@ok.com', authenticated: true, envelopeSender: 'bounce@mail.evil.com.' })).toEqual({ kind: 'deliver' });
    expect(evaluateInboundPolicy(policy, { address: 'friend@ok.com', authenticated: true, envelopeSender: 'bounce@evil.com' })).toEqual(blocked);
    expect(evaluateInboundPolicy(policy, { address: 'friend@ok.com', authenticated: true, authenticatedDomains: ['EVIL.com'] })).toEqual(blocked);
    // 대조군 — 아무것도 걸리지 않으면 모드가 정한다.
    expect(evaluateInboundPolicy(policy, { address: 'friend@ok.com', authenticated: true, envelopeSender: 'friend@ok.com', authenticatedDomains: ['ok.com'] })).toEqual({
      kind: 'deliver',
    });
  });

  it('허용은 넓히지 않는다 — 인증된 헤더 From 하나만 allow 와 맞춘다(봉투·따옴표 철자로 열리지 않는다)', () => {
    const policy = blockPolicy('allowlist_only');
    expect(evaluateInboundPolicy(policy, { address: 'stranger@else.com', authenticated: true, envelopeSender: 'friend@ok.com' })).toEqual({
      kind: 'quarantine',
      reason: 'sender_not_allowlisted',
    });
    expect(evaluateInboundPolicy(policy, { address: '"friend"@ok.com', authenticated: true })).toEqual({
      kind: 'quarantine',
      reason: 'sender_not_allowlisted',
    });
  });
});
