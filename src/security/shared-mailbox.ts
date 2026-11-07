/**
 * src/security/shared-mailbox.ts — **무료·공용 메일 도메인**(누구나 주소를 받는 곳). 도메인 단위 신뢰가 무의미하다 — 같은 `gmail.com` 이라도 서로 남이다.
 * 신뢰 계산(`sender-trust.ts`)과 발신 DLP 코드 지문의 출처 도메인 제외(`dlp/codes.ts`, ADR-0016)가 쓴다. **플랫폼 도메인 상수 하나만 import 한다** —
 * DLP 쪽이 신뢰 신호 → 정책 로더 폐포를 끌어오면 정책 로더 ↔ DLP 순환이 생긴다(depcruise `no-circular`).
 */

import { AGENT_ADDRESS_DOMAIN } from '../identity/address';

/**
 * 서로 무관한 다수가 주소를 받는 도메인. 하위 도메인도 포함해 본다(`mail.yahoo.com` 등).
 * **완전하지 않다** — 머리말 "신뢰의 단위" 절.
 */
export const SHARED_MAILBOX_DOMAINS: ReadonlySet<string> = new Set([
  AGENT_ADDRESS_DOMAIN,
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'yahoo.co.jp',
  'ymail.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'pm.me',
  'gmx.com',
  'gmx.net',
  'mail.com',
  'zoho.com',
  'yandex.com',
  'yandex.ru',
  'mail.ru',
  'qq.com',
  '163.com',
  '126.com',
  'naver.com',
  'daum.net',
  'hanmail.net',
  'kakao.com',
  'nate.com',
  'fastmail.com',
  'hey.com',
  'tutanota.com',
]);

export function isSharedMailboxDomain(domain: string): boolean {
  const lower = domain.trim().toLowerCase();
  if (SHARED_MAILBOX_DOMAINS.has(lower)) return true;
  for (const shared of SHARED_MAILBOX_DOMAINS) {
    if (lower.endsWith(`.${shared}`)) return true;
  }
  return false;
}
