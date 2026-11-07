/**
 * 정책 v2 연락처 목록(`agent_contact_rules`)의 값 모양과 매칭(계약 v2 §1 · ADR-0007). 순수 함수.
 * 발신 관문·수신 판정·Sender Trust·관리 입력 검증이 **이 파일 하나**를 쓴다 — 매칭 규칙이 둘이면 한쪽만 고쳐진 날 갈라진다.
 *
 * 값: `@` 가 있으면 주소, 없으면 도메인 — DB `atmark_contact_rule_kind` 와 같은 정규식이다(통합 테스트가 대조, 앱이 더 넓으면 INSERT 가 500).
 * 소문자·ASCII 만 — JS·DB 가 로캘마다 다르게 접는 문자를 키로 쓰지 않는다.
 *
 * 매칭: 주소 규칙은 정확 일치이고 비교형은 넘기는 쪽이 정한다(허용 `comparableAddress` — 좁게, 차단 `normalizeAddress` — 넓게).
 * `example.com` 은 그 도메인만, `*.example.com` 은 하위 도메인만(정점 제외).
 */

import type { ContactRuleKind } from '../db/schema';

const LABEL = '[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?';
const DOMAIN = `${LABEL}(\\.${LABEL})+`;
/** RFC 5322 dot-atom 의 atext(소문자) — 따옴표·역슬래시·공백·괄호는 없다. */
const ATEXT = "[a-z0-9!#$%&'*+/=?^_`{|}~-]";
/** 로컬파트 = dot-atom(따옴표·역슬래시·이상한 점 없음, ≤64) — "같은 메일함의 다른 철자" 가 비교를 비껴가지 못하게(검증 M2). */
const LOCAL = `(?=[^@]{1,64}@)${ATEXT}+(\\.${ATEXT}+)*`;

/** 주소 규칙의 모양 — DB `atmark_contact_rule_kind` 의 첫 정규식과 같다. */
const CONTACT_RULE_ADDRESS_SHAPE = new RegExp(`^${LOCAL}@${DOMAIN}$`);
/** 도메인 규칙의 모양(`*.` 접두 허용) — DB 함수의 두 번째 정규식과 같다. */
const CONTACT_RULE_DOMAIN_SHAPE = new RegExp(`^(\\*\\.)?${DOMAIN}$`);

const MAX_ADDRESS_LENGTH = 254;
const MAX_DOMAIN_LENGTH = 255;

/** 사람이 적은 값 → 저장형. 앞뒤 공백을 깎고 소문자로. 모양 검사는 `contactRuleKindOf`. */
export function normalizeContactRuleValue(input: string): string {
  return input.trim().toLowerCase();
}

/** 저장형 값의 종류. **`null` = 목록에 넣을 수 없는 값**(모양 밖·비 ASCII·너무 김). */
export function contactRuleKindOf(value: string): ContactRuleKind | null {
  if (value.length <= MAX_ADDRESS_LENGTH && CONTACT_RULE_ADDRESS_SHAPE.test(value)) return 'address';
  if (value.length <= MAX_DOMAIN_LENGTH && CONTACT_RULE_DOMAIN_SHAPE.test(value)) return 'domain';
  return null;
}

/** 주소의 도메인(마지막 `@` 뒤). `@` 가 없으면 빈 문자열 — 어떤 도메인 규칙과도 맞지 않는다. */
export function domainOfAddress(address: string): string {
  const at = address.lastIndexOf('@');
  return at < 0 ? '' : address.slice(at + 1);
}

/** 도메인 규칙 하나가 도메인을 덮는가. `*.x` 는 하위 도메인만, 나머지는 정확 일치. 빈 도메인은 아무것과도 맞지 않는다. */
export function domainRuleCovers(rule: string, domain: string): boolean {
  if (domain === '') return false;
  if (rule.startsWith('*.')) {
    const base = rule.slice(2);
    return base !== '' && domain.endsWith(`.${base}`);
  }
  return domain === rule;
}

/** 규칙 값 하나가 주소를 덮는가. 비교형은 호출자가 맞춘다 — 여기서 정규화하지 않는다. */
export function contactRuleMatches(rule: string, address: string): boolean {
  if (rule.includes('@')) return rule === address;
  return domainRuleCovers(rule, domainOfAddress(address));
}

/** 목록 중 하나라도 덮으면 참. 빈 목록은 아무것도 덮지 않는다. */
export function anyContactRuleMatches(rules: readonly string[], address: string): boolean {
  return rules.some((rule) => contactRuleMatches(rule, address));
}

// ---------------------------------------------------------------------------
// 발신 수신자의 모양 (202609241040 — 검증 M2)
// ---------------------------------------------------------------------------

const MIXED_LABEL = '[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?';
const MIXED_ATEXT = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]";

/**
 * 발신 수신자로 받는 주소 — **ASCII dot-atom** 만(대소문자는 원문 그대로). 따옴표 로컬파트·끝 점 도메인·역슬래시는 SES 에서 같은
 * 메일함인데 억제·차단의 문자열 비교를 비껴갔다(검증 M2). 철자를 전부 정규화하는 대신 정규형 밖을 받지 않는다. 본문 파서와
 * 관문 선적재(`loadEvaluationInput`) 모두 이 함수를 지난다.
 */
const OUTBOUND_RECIPIENT_SHAPE = new RegExp(
  `^(?=[^@]{1,64}@)${MIXED_ATEXT}+(\\.${MIXED_ATEXT}+)*@${MIXED_LABEL}(\\.${MIXED_LABEL})+$`,
);

/** 발신 수신자 모양인가(≤254자). 앞뒤 공백도 받지 않는다. */
export function isOutboundRecipientAddress(address: string): boolean {
  return address.length <= MAX_ADDRESS_LENGTH && OUTBOUND_RECIPIENT_SHAPE.test(address);
}

// ---------------------------------------------------------------------------
// 플랫폼 도메인 (202609241040 — 검증 L1)
// ---------------------------------------------------------------------------

/** 에이전트 주소의 도메인(`AGENT_ADDRESS_DOMAIN` 과 같은 값 — 단위 테스트가 대조). */
export const PLATFORM_DOMAIN = 'atmark.ai';

/** 도메인 규칙이 플랫폼 도메인을 덮는가 — 발신 allow 에 두지 않는다(그 한 줄이 플랫폼의 모든 에이전트를 연다). */
export function isPlatformDomainRule(value: string): boolean {
  if (value.includes('@')) return false;
  const base = value.startsWith('*.') ? value.slice(2) : value;
  return base === PLATFORM_DOMAIN || base.endsWith(`.${PLATFORM_DOMAIN}`);
}

// ---------------------------------------------------------------------------
// 수신 차단 비교형 (202609241040 — 검증 L2)
// ---------------------------------------------------------------------------

/**
 * 받은 메일의 주소 철자 → 차단 비교용 형태. 막는 쪽이라 넓게 편다(소문자 · `<…>` · 끝 점 · 따옴표 로컬파트 풀기).
 * `+tag` 절단은 호출자가. 모양이 아니면 빈 문자열(어떤 규칙과도 맞지 않는다).
 */
export function canonicalMailboxForBlock(raw: string): string {
  let value = raw.trim().toLowerCase();
  if (value.startsWith('<') && value.endsWith('>')) value = value.slice(1, -1).trim();
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) return '';
  let local = value.slice(0, at);
  const domain = value.slice(at + 1).replace(/\.+$/, '');
  if (local.length >= 2 && local.startsWith('"') && local.endsWith('"')) {
    local = local.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  return local === '' || domain === '' ? '' : `${local}@${domain}`;
}

/** 도메인 하나가 목록의 도메인 규칙에 걸리는가(끝 점은 떼고 본다). 도메인만 아는 근거(봉투·DMARC 도메인)용. */
export function anyDomainRuleCovers(rules: readonly string[], domain: string): boolean {
  const bare = domain.trim().toLowerCase().replace(/\.+$/, '');
  return rules.some((rule) => !rule.includes('@') && domainRuleCovers(rule, bare));
}
