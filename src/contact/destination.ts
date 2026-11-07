/**
 * src/contact/destination.ts — **문의 전달 주소(운영자 메일함)를 비밀에서 읽는다** (US-009, ADR-0009).
 *
 * 주소는 코드·문서·테스트·공개 표면 어디에도 평문으로 두지 않는다. Secrets Manager `atmark/contact-forward-to`(Data 스택이 RETAIN
 * 자리만 만든다)에 배포 때 운영자가 `put-secret-value` 로 넣는다 — 모양은 `{"to":"<주소>"}` 하나.
 *
 * **실패는 전부 닫힌 쪽(`null`)이다** — 자리값 그대로(`{"_unset": …}`)·JSON 아님·키가 다름·주소가 아님·우리 도메인 주소(루프)·
 * 비밀을 읽지 못함. `null` 이면 전달 모듈은 **보내지 않고** 행을 그대로 둔다(다음 틱에 다시 읽는다 — 운영자가 값을 넣으면 그때부터
 * 나간다). 값은 오류·로그에 싣지 않는다.
 */

import { isPlaceholderSecret } from '../runtime/config';
import { isForwardableAddress, isOwnDomain } from './intake';

/** 비밀 문자열 → 전달 주소. 모양이 하나라도 어긋나면 `null`. */
export function parseContactDestination(raw: string): string | null {
  if (isPlaceholderSecret(raw)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== 'to') return null;
  const to = (parsed as { to?: unknown }).to;
  if (typeof to !== 'string') return null;
  const address = to.trim();
  if (!isForwardableAddress(address) || isOwnDomain(address)) return null;
  return address;
}

/**
 * 비밀을 읽어 주소를 돌려주는 로더. **유효한 값만 기억한다** — 자리값이면 매번 다시 읽는다(운영자가 값을 넣은 뒤 실행 환경을
 * 재활용하지 않아도 다음 호출에서 나간다). 읽기 실패(권한·없음)도 `null` 이다(닫힌 쪽 — 호출자가 로그를 남긴다).
 */
export function createContactDestinationLoader(read: () => Promise<string>): () => Promise<string | null> {
  let cached: string | null = null;
  return async () => {
    if (cached !== null) return cached;
    let raw: string;
    try {
      raw = await read();
    } catch {
      return null;
    }
    cached = parseContactDestination(raw);
    return cached;
  };
}
