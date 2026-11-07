/**
 * src/identity/seed-contacts.ts — 프로비저닝 시 입력하는 사전 승인 상대(계획 §3.1 층 2).
 *
 * 한 목록으로 두 문제를 닫는다: ① **부트스트랩 역설** — 기본 `allowlist_only` 에이전트는 목록이 비면 첫날 아무에게도 못 보낸다.
 * ② **주소 전환 공지**(§3.2)의 발송 대상이 이 목록이다 — 별도 엔티티면 "공지는 갔는데 발송은 막히는" 상태가 생긴다.
 *
 * 저장 위치는 발신 allow 목록(`agent_contact_rules`)이고, 같은 트랜잭션에서 레거시 승인 모드가 읽는 `sender_relationships(seed)` 도 태어난다
 * (AC-a2) — 같은 입력에서 함께 태어나므로 갈라질 수 없다.
 */

import { contactRuleKindOf } from '../policy/contact-rules';
import { comparableAddress } from '../policy/policy-loader';

/** 상한은 의도적이다(§3.2) — "전부 옮기기"는 끝나지 않고 "가장 중요한 20개"는 하루면 끝난다. */
export const MAX_SEED_CONTACTS = 20;

/** `demo:p1b` 장면 ①(발송 성공)의 수신자 — 창업자 본인 주소. AC-2(placement) 시드로는 쓰지 않는다(본인 인게이지먼트가 placement 를 과대평가한다). */
export const P1B_DEMO_SEED_CONTACT = 'jinyounkyum@gmail.com';

/** seed contact 입력이 규격을 벗어남. 트랜잭션이 시작되기 전에 던진다 — fail closed. */
export class SeedContactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedContactError';
  }
}

/**
 * 입력 → allowlist·seed 관계에 넣을 주소 목록.
 *
 * 정규화는 `comparableAddress`(소문자화만, `+tag` 보존) — 허용은 좁게. 판정형(`+tag` 절단)으로 저장하면 소유자가 적은 `Sales+EU@Corp.com` 이
 * `sales@`·모든 `sales+*` 를 여는 seed 가 된다. 중복은 조용히 제거하고, 상한은 **중복 제거 뒤**에 본다.
 */
export function resolveSeedContacts(input: readonly string[]): readonly string[] {
  const resolved: string[] = [];
  const seen = new Set<string>();

  for (const raw of input) {
    if (typeof raw !== 'string') {
      throw new SeedContactError(`seed contact 는 문자열이어야 한다: ${JSON.stringify(raw)}`);
    }
    const address = comparableAddress(raw);
    // allow 목록 값 규칙을 그대로 요구한다 — 느슨하게 받으면 DB CHECK 가 트랜잭션 안에서 거부해 원인이 가려진다.
    if (contactRuleKindOf(address) !== 'address') {
      throw new SeedContactError(`seed contact 주소 형식이 아니다: ${JSON.stringify(raw)}`);
    }
    if (seen.has(address)) continue;
    seen.add(address);
    resolved.push(address);
  }

  if (resolved.length > MAX_SEED_CONTACTS) {
    throw new SeedContactError(
      `seed contact 는 최대 ${MAX_SEED_CONTACTS} 개다 (§3.1 층 2): ${resolved.length} 개가 들어왔다`,
    );
  }

  return resolved;
}
