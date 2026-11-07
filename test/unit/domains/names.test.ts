/**
 * 고객 도메인 이름 판정(`src/domains/names.ts` · ADR-0014 결정 1 · 계획 §3.1) — 단계 0 수용 기준의 표.
 *
 *   - v1 허용 = 등록 가능 apex(PSL ICANN + PRIVATE)가 있고 입력이 그 apex 가 아니다 · apex 가 atmark.ai·공용 메일 도메인이 아니다.
 *   - 입력은 공백 제거 + 소문자화만. 끝 점 · `_` · IP · R-LDH(`xn--`) · 긴 라벨 · 한 라벨 거부.
 *   - PSL 알고리즘: 와일드카드(`*.ck`) · 예외(`!www.ck`) · PRIVATE 절(`github.io`) · 기본 규칙 `*`.
 *   - 스냅샷 메타(원문 해시 · 규칙 수)가 생성 파일 머리와 맞다(손으로 고친 흔적이 없다) · 스냅샷이 120일을 넘지 않았다(신선도).
 */

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { CUSTOM_DOMAIN_MAX_LENGTH } from '../../../src/domains/contract';
import { judgeCustomDomain, normalizeDomainInput, type DomainNameRejection } from '../../../src/domains/names';
import { publicSuffixOf, registrableDomainOf } from '../../../src/domains/psl';
import { PSL_ICANN_RULES, PSL_PRIVATE_RULES, PSL_SOURCE } from '../../../src/domains/psl-data';
import { parsePublicSuffixList, renderPslData } from '../../../scripts/update-psl';

const reasonOf = (raw: string): DomainNameRejection | 'ok' => {
  const verdict = judgeCustomDomain(raw);
  return verdict.ok ? 'ok' : verdict.reason;
};

describe('judgeCustomDomain — 수용 기준 표(계획 §5 단계 0)', () => {
  it.each([
    ['agents.customer.com', 'customer.com'],
    ['agents.foo.github.io', 'foo.github.io'],
    ['agents.younkyum.me', 'younkyum.me'],
    ['mail.bots.example.co.kr', 'example.co.kr'],
    ['  Agents.Customer.COM  ', 'customer.com'],
  ] as const)('%s 는 통과한다', (raw, registrable) => {
    const verdict = judgeCustomDomain(raw);
    expect(verdict).toEqual({ ok: true, domain: normalizeDomainInput(raw), registrable });
  });

  it.each([
    ['customer.com', 'registrable_apex'],
    // PSL 에 없는 TLD — 기본 규칙 `*` 로 `a.b` 가 apex 다(서브도메인이 아니다).
    ['a.b', 'registrable_apex'],
    ['foo.github.io', 'registrable_apex'],
    ['co.kr', 'public_suffix'],
    ['github.io', 'public_suffix'],
    ['com', 'single_label'],
    ['agents.atmark.ai', 'platform_domain'],
    ['deep.agents.atmark.ai', 'platform_domain'],
    ['atmark.ai', 'platform_domain'],
    ['x.gmail.com', 'shared_mailbox_domain'],
    ['bots.naver.com', 'shared_mailbox_domain'],
    ['xn--pple-43d.customer.com', 'idn_label'],
    ['agents.xn--pple-43d.com', 'idn_label'],
    ['ab--cd.customer.com', 'idn_label'],
    ['agents.customer.com.', 'trailing_dot'],
    ['10.0.0.1', 'ip_address'],
    ['agents.10.0.0.1', 'ip_address'],
    ['[::1]', 'invalid_label'],
    ['agents_1.customer.com', 'invalid_label'],
    ['-agents.customer.com', 'invalid_label'],
    ['agents-.customer.com', 'invalid_label'],
    ['agents..customer.com', 'invalid_label'],
    ['agents customer.com', 'invalid_label'],
    ['에이전트.customer.com', 'invalid_label'],
    [`${'a'.repeat(64)}.customer.com`, 'invalid_label'],
    [`${'a.'.repeat(126)}customer.com`, 'too_long'],
    ['', 'empty'],
    ['   ', 'empty'],
  ] as const)('%s 는 %s 로 거부한다', (raw, reason) => {
    expect(reasonOf(raw)).toBe(reason);
  });

  it('63자 라벨은 받는다(경계) · 전체 100자까지 받고 101자는 too_long(RFC 의 253 이 아니다 — 정책 크기, ADR-0014)', () => {
    expect(reasonOf(`${'a'.repeat(63)}.customer.com`)).toBe('ok');
    const exactly = `${'a'.repeat(40)}.${'b'.repeat(46)}.customer.com`;
    expect(exactly).toHaveLength(100);
    expect(exactly).toHaveLength(CUSTOM_DOMAIN_MAX_LENGTH);
    expect(reasonOf(exactly)).toBe('ok');
    expect(reasonOf(`b${exactly}`)).toBe('too_long');
  });
});

describe('PSL 알고리즘(ICANN + PRIVATE)', () => {
  it.each([
    ['agents.customer.com', 'com', 'customer.com'],
    ['a.b.example.co.uk', 'co.uk', 'example.co.uk'],
    ['bots.foo.github.io', 'github.io', 'foo.github.io'],
    ['x.y.kawasaki.jp', 'y.kawasaki.jp', 'x.y.kawasaki.jp'],
    ['www.ck', 'ck', 'www.ck'],
    ['a.b.ck', 'b.ck', 'a.b.ck'],
    ['agents.example.unknowntld', 'unknowntld', 'example.unknowntld'],
  ] as const)('%s → 접미사 %s · 등록 가능 %s', (host, suffix, registrable) => {
    expect(publicSuffixOf(host)).toBe(suffix);
    expect(registrableDomainOf(host)).toBe(registrable);
  });

  it('접미사 자체는 등록 가능 도메인이 없다', () => {
    expect(registrableDomainOf('co.kr')).toBeNull();
    expect(registrableDomainOf('github.io')).toBeNull();
    expect(registrableDomainOf('y.kawasaki.jp')).toBeNull(); // 와일드카드 `*.kawasaki.jp` 가 만든 접미사
    expect(registrableDomainOf('com')).toBeNull();
  });
});

describe('PSL 스냅샷(생성 파일)', () => {
  it('머리의 규칙 수 = 실제 규칙 수 · ICANN·PRIVATE 가 둘 다 크다 · ASCII 뿐', () => {
    const icann = PSL_ICANN_RULES.split('\n');
    const privateRules = PSL_PRIVATE_RULES.split('\n');
    expect(icann).toHaveLength(PSL_SOURCE.icannRules);
    expect(privateRules).toHaveLength(PSL_SOURCE.privateRules);
    expect(icann.length).toBeGreaterThan(5000);
    expect(privateRules.length).toBeGreaterThan(1000);
    for (const rule of [...icann, ...privateRules]) expect(rule, rule).toMatch(/^(?:\*\.|!)?[a-z0-9-]+(?:\.[a-z0-9-]+)*$/);
    expect(PSL_SOURCE.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(icann).toContain('co.kr');
    expect(privateRules).toContain('github.io');
  });

  it('스냅샷이 120일보다 오래되지 않았다(critic minor 12 — 분기마다 `pnpm psl:update`, 런북)', () => {
    const ageDays = (Date.now() - Date.parse(`${PSL_SOURCE.fetchedAt}T00:00:00Z`)) / 86_400_000;
    expect(Number.isFinite(ageDays)).toBe(true);
    expect(ageDays, `PSL 스냅샷 ${PSL_SOURCE.fetchedAt} — pnpm psl:update`).toBeLessThanOrEqual(120);
  });

  it('생성기: 절 표지를 읽고 · ASCII 아닌 규칙은 세어서 빼고 · 같은 입력이면 같은 파일을 쓴다', () => {
    const filler = (prefix: string): string => Array.from({ length: 500 }, (_, index) => `${prefix}${String(index)}.test`).join('\n');
    const text = [
      '// ===BEGIN ICANN DOMAINS===',
      'com',
      '*.ck',
      '!www.ck',
      '한국',
      filler('i'),
      '// ===END ICANN DOMAINS===',
      '// ===BEGIN PRIVATE DOMAINS===',
      'github.io  // comment after whitespace',
      filler('p'),
      '// ===END PRIVATE DOMAINS===',
    ].join('\n');
    const parsed = parsePublicSuffixList(text);
    expect(parsed.icann.slice(0, 3)).toEqual(['com', '*.ck', '!www.ck']);
    expect(parsed.privateRules[0]).toBe('github.io');
    expect(parsed.skippedNonAscii).toBe(1);
    const sha = createHash('sha256').update(text).digest('hex');
    expect(renderPslData(parsed, sha, '2026-09-29', 'x')).toBe(renderPslData(parsed, sha, '2026-09-29', 'x'));
    expect(() => parsePublicSuffixList('com\nnet')).toThrow(/절 표지/);
  });
});
