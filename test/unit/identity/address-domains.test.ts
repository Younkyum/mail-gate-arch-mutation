/**
 * 고객 도메인 주소(`src/identity/address.ts` · ADR-0014 결정 7·8 · J11).
 *
 *   - `buildAgentAddress(localPart, domain)` — 기본 도메인은 atmark.ai(기존 호출부 불변) · 고객 도메인은 모양만 본다(소유는 DB 트리거).
 *   - `reservedLocalPartsFor(domain)` — atmark.ai 는 전체 목록, 고객 도메인은 전역 목록(RFC 2142 · 인증서 검증 · mailer-daemon).
 *     전역 목록은 atmark.ai 목록의 부분 집합이다(atmark.ai 가 더 좁다). 고객 도메인에서는 `support@`·`info@`·`sales@` 를 쓸 수 있다.
 *   - `mailClaimKey` — 판정형(로컬파트 첫 `+` 앞 · 소문자) · 멱등 · 주소가 아니면 null. SQL 패리티는 통합 테스트.
 */

import { describe, expect, it } from 'vitest';

import {
  AGENT_ADDRESS_DOMAIN,
  AGENT_BRAND_RESERVED_LOCAL_PARTS,
  AgentAddressError,
  buildAgentAddress,
  GLOBAL_RESERVED_LOCAL_PARTS,
  isAgentAddressDomainShape,
  mailClaimKey,
  RESERVED_LOCAL_PARTS,
  reservedLocalPartsFor,
} from '../../../src/identity/address';

const CUSTOM = 'agents.customer.com';

function reasonOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof AgentAddressError) return error.reason;
    throw error;
  }
  return 'ok';
}

describe('reservedLocalPartsFor', () => {
  it('atmark.ai = 전체 목록 · 고객 도메인 = 전역 목록(순서까지 SQL 과 같다 — 통합 테스트)', () => {
    expect(reservedLocalPartsFor(AGENT_ADDRESS_DOMAIN)).toBe(RESERVED_LOCAL_PARTS);
    expect(reservedLocalPartsFor(CUSTOM)).toBe(GLOBAL_RESERVED_LOCAL_PARTS);
    expect([...GLOBAL_RESERVED_LOCAL_PARTS]).toEqual([
      'postmaster', 'abuse', 'hostmaster', 'webmaster', 'noc', 'security',
      'admin', 'administrator', 'root', 'ssladmin', 'ssl-admin', 'sslwebmaster',
      'mailer-daemon',
    ]);
  });

  it('전역 목록은 atmark.ai 목록의 부분 집합이다(atmark.ai 에서 더 좁게 막는다) · 중복 없음', () => {
    for (const part of GLOBAL_RESERVED_LOCAL_PARTS) expect(RESERVED_LOCAL_PARTS, part).toContain(part);
    expect(new Set(GLOBAL_RESERVED_LOCAL_PARTS).size).toBe(GLOBAL_RESERVED_LOCAL_PARTS.length);
  });
});

describe('buildAgentAddress(localPart, domain)', () => {
  it('도메인을 주지 않으면 atmark.ai(기존 호출부 불변)', () => {
    expect(buildAgentAddress('scout-bot')).toBe('scout-bot@atmark.ai');
  });

  it('고객 도메인: 전역 예약만 막는다 — support@·info@·sales@ 는 된다', () => {
    for (const part of GLOBAL_RESERVED_LOCAL_PARTS) expect(reasonOf(() => buildAgentAddress(part, CUSTOM)), part).toBe('reserved_local_part');
    for (const part of ['support', 'info', 'sales', 'billing', 'hello']) {
      expect(buildAgentAddress(part, CUSTOM)).toBe(`${part}@${CUSTOM}`);
      expect(reasonOf(() => buildAgentAddress(part)), part).toBe('reserved_local_part');
    }
  });

  it('AI 에이전트 이름 예약은 atmark.ai 전용 — 고객 도메인에서는 codex@·claude-code@ 가 된다(전역 목록에 없다)', () => {
    for (const part of AGENT_BRAND_RESERVED_LOCAL_PARTS) {
      expect(GLOBAL_RESERVED_LOCAL_PARTS, part).not.toContain(part);
      expect(buildAgentAddress(part, CUSTOM)).toBe(`${part}@${CUSTOM}`);
      expect(reasonOf(() => buildAgentAddress(part)), part).toBe('reserved_local_part');
    }
  });

  it.each(['Agents.Customer.com', 'customer', 'agents.customer.com.', 'xn--pple-43d.com', 'agents_1.customer.com', '10.0.0.1', '', `${'a'.repeat(90)}.customer.com`])(
    '고객 도메인 모양이 아니면 invalid_domain: %s',
    (domain) => {
      expect(isAgentAddressDomainShape(domain)).toBe(false);
      expect(reasonOf(() => buildAgentAddress('bot', domain))).toBe('invalid_domain');
    },
  );

  it('로컬파트 규칙은 도메인과 무관하다', () => {
    expect(reasonOf(() => buildAgentAddress('a..b', CUSTOM))).toBe('consecutive_dots');
    expect(reasonOf(() => buildAgentAddress('bot+x', CUSTOM))).toBe('invalid_character');
    expect(buildAgentAddress('  Bot  ', CUSTOM)).toBe(`bot@${CUSTOM}`);
  });
});

describe('mailClaimKey', () => {
  it.each([
    ['bob@agents.c.com', 'bob@agents.c.com'],
    ['Bob+Sales@Agents.C.com', 'bob@agents.c.com'],
    ['bob+a+b@x.com', 'bob@x.com'],
    ['a@b@c.com', 'a@b@c.com'],
    ['+tag@X.com', '+tag@x.com'], // 첫 `+` 앞이 비면 로컬파트 전체(critic 1 — 빈 키로 가입·초대가 실패하지 않게)
    ['++@x.com', '++@x.com'],
    ['no-at-sign', null],
    ['@x.com', null],
    ['bob@', null],
  ] as const)('%s → %s', (address, key) => {
    expect(mailClaimKey(address)).toBe(key);
  });

  it('멱등 — key(key(x)) = key(x)', () => {
    for (const address of ['Bob+Sales@Agents.C.com', 'x.y+z@EXAMPLE.org', 'agent@atmark.ai', '+tag@X.com']) {
      const key = mailClaimKey(address);
      expect(key === null ? null : mailClaimKey(key)).toBe(key);
    }
  });
});
