/**
 * src/domains/psl.ts — Public Suffix List 알고리즘(스냅샷 `psl-data.ts`). **PSL 스냅샷 말고 아무것도 import 하지 않는다** — 발송 서비스(DLP 의 수신자
 * 등록 도메인, ADR-0016)와 읽기 라우트(코드 지문의 출처 등록 도메인)가 쓰는데, 앞의 것은 인증 코드 추출 모듈(`src/mail/verification/**`)을 import
 * 폐포에 넣을 수 없다(arch `verification-boundary`). 판정 규칙(`names.ts`)은 그대로 이 파일을 쓴다.
 */

import { PSL_ICANN_RULES, PSL_PRIVATE_RULES } from './psl-data';

interface SuffixRules {
  readonly exact: ReadonlySet<string>;
  readonly wildcard: ReadonlySet<string>;
  readonly exception: ReadonlySet<string>;
}

let rulesCache: SuffixRules | null = null;

/** 스냅샷 → 규칙 집합(첫 호출에 한 번). */
function suffixRules(): SuffixRules {
  if (rulesCache !== null) return rulesCache;
  const exact = new Set<string>();
  const wildcard = new Set<string>();
  const exception = new Set<string>();
  for (const rule of `${PSL_ICANN_RULES}\n${PSL_PRIVATE_RULES}`.split('\n')) {
    if (rule === '') continue;
    if (rule.startsWith('!')) exception.add(rule.slice(1));
    else if (rule.startsWith('*.')) wildcard.add(rule.slice(2));
    else exact.add(rule);
  }
  rulesCache = { exact, wildcard, exception };
  return rulesCache;
}

/**
 * 호스트의 **공개 접미사 길이**(라벨 수) — PSL 알고리즘(publicsuffix.org/list "Algorithm"): 예외 규칙이 이기고, 그다음 가장 긴 규칙(평범한
 * 규칙 · 와일드카드), 없으면 기본 규칙 `*`(마지막 라벨 하나). 소문자 LDH 호스트를 받는다.
 */
function publicSuffixLabelCount(labels: readonly string[]): number {
  const { exact, wildcard, exception } = suffixRules();
  let best = 1; // 기본 규칙 `*`.
  for (let index = 0; index < labels.length; index += 1) {
    const candidate = labels.slice(index).join('.');
    const length = labels.length - index;
    if (exception.has(candidate)) return length - 1; // 예외 규칙: 가장 왼쪽 라벨을 뺀 것이 접미사다.
    if (length > best && exact.has(candidate)) best = length;
    if (index + 1 < labels.length) {
      const parent = labels.slice(index + 1).join('.');
      if (length > best && wildcard.has(parent)) best = length;
    }
  }
  return best;
}

/** 호스트의 공개 접미사(eTLD). 소문자 LDH 호스트를 받는다. */
export function publicSuffixOf(host: string): string {
  const labels = host.split('.');
  return labels.slice(labels.length - publicSuffixLabelCount(labels)).join('.');
}

/** 호스트의 **등록 가능 도메인**(eTLD+1). 호스트가 공개 접미사 자체(또는 그 위)면 `null`. */
export function registrableDomainOf(host: string): string | null {
  const labels = host.split('.');
  const suffix = publicSuffixLabelCount(labels);
  if (labels.length <= suffix) return null;
  return labels.slice(labels.length - suffix - 1).join('.');
}

