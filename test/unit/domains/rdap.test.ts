/**
 * `src/domains/rdap.ts` — RDAP 만료일(`scripts/check-domain-expiry.ts` 에서 옮김 · domain-control `check_expiry`). **네트워크 0** — 만료 판정 ·
 * 끝점 · 오류 코드만 본다(조회 경로는 스크립트 `pnpm check:domain-expiry` 가 실물로 돈다).
 */

import { describe, expect, it } from 'vitest';

import { findExpiration, rdapOrgEndpoint, RdapError } from '../../../src/domains/rdap';

describe('RDAP', () => {
  it('만료 이벤트의 날짜만 읽는다(형식이 틀리면 null)', () => {
    expect(findExpiration({ events: [{ eventAction: 'registration', eventDate: '2020-01-01T00:00:00Z' }, { eventAction: 'expiration', eventDate: '2027-03-04T05:06:07Z' }] })?.toISOString()).toBe(
      '2027-03-04T05:06:07.000Z',
    );
    expect(findExpiration({ events: [{ eventAction: 'expiration', eventDate: 'soon' }] })).toBeNull();
    expect(findExpiration({})).toBeNull();
  });

  it('rdap.org 끝점 — 도메인은 경로 하나로 인코딩된다', () => {
    expect(rdapOrgEndpoint('example.com')).toBe('https://rdap.org/domain/example.com');
    expect(rdapOrgEndpoint('a/b')).toBe('https://rdap.org/domain/a%2Fb');
  });

  it('RdapError 는 코드를 싣는다 — domain-control 은 코드만 errorCode 로 쓴다(메시지·URL 없음)', () => {
    const error = new RdapError('rdap_timeout', '타임아웃 — https://rdap.org/domain/example.com');
    expect([error.name, error.code]).toEqual(['RdapError', 'rdap_timeout']);
  });
});
