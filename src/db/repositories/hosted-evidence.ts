/**
 * src/db/repositories/hosted-evidence.ts — **Atmark 주소에 묶인 신뢰 근거의 유효 기간**(별칭 재발급 보안 리뷰 M3, ADR-0013 2026-09-29 개정).
 *
 * 폐기한 별칭은 같은 조직이 곧바로, 다른 조직은 30일 뒤 다시 받는다. 그런데 신뢰 근거 — 소유자 분류(`sender_marks`) · 관계
 * (`sender_relationships`) · 주고받은 이력(`inbound_messages`·`outbound_recipients`) · 스레드 권한의 근거 메일 — 는 **주소 문자열**로 걸려 있다.
 * 그대로 두면 새 주인이 예전 주인이 쌓은 신뢰를 물려받는다(`seen` 발신자 · 승인 없이 보내는 상대 · 기존 스레드의 회신 권한).
 *
 * 규칙: 상대 주소가 **Atmark 가 호스팅하는 주소**(`AGENT_ADDRESS_DOMAIN`)이면, 그 근거는 **그 주소의 지금 활성 행이 생긴 뒤**의 것만 센다.
 * 활성 행이 없으면(폐기 · 보류 중) 아무 근거도 세지 않는다. 같은 조직의 재발급도 새 행이라 근거가 초기화된다(다른 에이전트일 수 있다 —
 * 결정은 ADR). 다른 도메인의 상대는 그대로다(그 주소의 주인이 바뀌었는지 우리는 알 수 없고, 바뀌지 않는다고 가정해 온 대로다).
 *
 * 올리는 근거에만 건다. 막는 근거(차단 목록 · 억제 · injection 이력)는 그대로 둔다 — 넓게 막는 쪽이 안전하다.
 * 소유자가 쓴 허용·차단 규칙(`agent_contact_rules`)은 소유자의 의도라 건드리지 않는다(ADR).
 *
 * 조회는 주소 색인(`agent_addresses_address_idx`·옛 전역 UNIQUE) 한 번이다 — 한 주소의 행은 몇 개뿐이다. 폐기 칸은 행 JSON 에서 읽는다
 * (`policy-source.ts` 와 같은 규율 — 202609270110 전 스키마 · 새 코드가 마이그레이션보다 먼저 뜬 몇 분에도 42703 없이 돈다).
 */

import { AGENT_ADDRESS_DOMAIN } from '../../identity/address';

/** SQL 에 리터럴로 넣는 도메인 — 코드 상수다(입력이 아니다). 모양을 한 번 더 못박는다. */
const HOSTED_DOMAIN_LITERAL = (() => {
  if (!/^[a-z0-9.-]+$/.test(AGENT_ADDRESS_DOMAIN)) throw new Error(`AGENT_ADDRESS_DOMAIN 모양이 아니다: ${AGENT_ADDRESS_DOMAIN}`);
  return `'${AGENT_ADDRESS_DOMAIN}'`;
})();

/**
 * SQL 술어 조각 — "상대 주소 `address` 에 대해 시각 `at` 의 근거를 센다". 참 = 호스팅 주소가 아니다, 또는 그 주소의 활성 행이 `at` 이전에
 * 생겼다. `address`·`at` 은 **SQL 식**(칼럼 이름 · `$n` 자리표시자)이다 — 호출자의 상수 문자열만 넘긴다(입력을 끼워 넣지 않는다).
 * `at` 이 NULL 이면 거짓(시각 없는 근거는 세지 않는다). `address` 는 소문자 저장값과 비교한다.
 * **`at` 은 표 이름·별칭으로 한정해 넘긴다** — 조각 안의 하위 질의가 `agent_addresses` 를 보므로, 한정하지 않은 `created_at` 은 그 표의 칸으로
 * 풀려 비교가 늘 참이 된다.
 */
export function hostedEvidenceSql(address: string, at: string): string {
  // 호스팅 여부 = atmark.ai 이거나 **주소 행이 한 번이라도 있었던** 주소(재검토 LOW-2 — 고객 도메인도 우리가 발급·폐기한다).
  return `((lower(split_part(coalesce(${address}, ''), '@', 2)) <> ${HOSTED_DOMAIN_LITERAL}
       AND NOT EXISTS (SELECT 1 FROM agent_addresses hosted_any WHERE hosted_any.address = lower(${address})))
     OR EXISTS (SELECT 1 FROM agent_addresses hosted_address
                 WHERE hosted_address.address = lower(${address}) AND (to_jsonb(hosted_address) ->> 'retired_at') IS NULL
                   AND hosted_address.created_at <= ${at}))`;
}
