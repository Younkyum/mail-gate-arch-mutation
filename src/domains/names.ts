/**
 * src/domains/names.ts — **고객 도메인 이름 판정**(ADR-0014 결정 1 · 계획 §3.1).
 *
 * v1 은 **에이전트 전용 서브도메인**만 받는다(`agents.customer.com`). 판정은 순수 함수이고 네트워크·DB·시계가 없다.
 *
 *   1. 입력은 **앞뒤 공백 제거 + 소문자화만** 한다. 그 밖의 관대함은 없다 — 끝 점(`agents.x.com.`)·`_`·IP 모양·빈 라벨·길이 초과(100자)는
 *      거부한다. IDN(유니코드·`xn--`)을 거부하는 이유는 콘솔이 한·영으로 설명한다("국제화 도메인은 v1 에서 받지 않는다").
 *   2. 라벨은 LDH ASCII(RFC 1035 · 5890 의 "LDH label")이고, **셋째·넷째 글자가 `--` 인 라벨(R-LDH — `xn--` 포함)은 거부한다**(RFC 5891
 *      §4.2.3.1). 퓨니코드 호모그래프(`xn--pple-43d.com`)를 이름 단계에서 닫는다. 계획은 `xn--` 만 적었지만 `xn--` 외의 예약 접두도 IDNA
 *      미래판이 쓸 자리라 같이 막는다(더 좁은 쪽).
 *   3. **등록 가능 도메인**(registrable, eTLD+1)은 공개 접미사 목록 **ICANN + PRIVATE** 절 전부로 계산한다(`psl-data.ts`, 와일드카드·예외
 *      규칙 준수). `foo.github.io` 처럼 PRIVATE 접미사 아래 이름도 등록 가능 apex 로 본다.
 *   4. v1 허용 = registrable 이 있고(접미사 자체가 아님) **입력이 그 apex 가 아니다**. `agents.foo.github.io` 는 통과한다(apex `foo.github.io`
 *      아래 서브도메인).
 *   5. registrable 이 `atmark.ai` 이거나 **공용 메일 도메인**(`SHARED_MAILBOX_DOMAINS` — gmail·naver …)이면 거부한다 — 누구도 그 apex 의 소유를
 *      증명할 수 없어야 하는 자리다(`x.gmail.com`).
 *
 * 같은 판정을 SQL 에 옮기지 않는다(PSL 을 SQL 로 옮기지 않는다). DB 는 앱이 채운 `registrable_domain` 을 믿고 모양·접미 관계만 CHECK 한다
 * (`202609291100_custom_domains.sql`).
 *
 * **무겁다**(PSL 약 1만 규칙). 발송·수신 경로(관문·전송단·수신 소비자)는 이 파일을 import 하지 않는다 — 판정은 도메인을 **추가할 때** 한 번이고,
 * 그 결과(`registrable_domain`)는 행에 남는다.
 */

import { SHARED_MAILBOX_DOMAINS } from '../mail/verification/public-suffix';
import { AGENT_ADDRESS_DOMAIN } from '../identity/address';
import { CUSTOM_DOMAIN_MAX_LENGTH } from './contract';
import { registrableDomainOf } from './psl';

/** 라벨 하나: LDH, 1~63자, 앞뒤 하이픈 없음. */
const LDH_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** R-LDH(셋째·넷째 글자 `--`) — `xn--` 를 포함한 IDNA 예약 접두. */
const RESERVED_LDH_LABEL = /^[a-z0-9]{2}--/;

/** 거부 사유 — 닫힌 유니온. 콘솔·API 는 이 값을 그대로 400 코드로 쓴다. */
export type DomainNameRejection =
  | 'empty'
  | 'too_long'
  | 'trailing_dot'
  | 'invalid_label'
  | 'idn_label'
  | 'ip_address'
  | 'single_label'
  | 'public_suffix'
  | 'registrable_apex'
  | 'platform_domain'
  | 'shared_mailbox_domain';

export type DomainNameVerdict =
  | { readonly ok: true; readonly domain: string; readonly registrable: string }
  | { readonly ok: false; readonly reason: DomainNameRejection };

/** 입력 정규화 — 앞뒤 공백 제거 + 소문자. 그 밖에는 아무것도 하지 않는다(§3.1). */
export function normalizeDomainInput(raw: string): string {
  return raw.trim().toLowerCase();
}

const SHARED_MAILBOX = new Set<string>(SHARED_MAILBOX_DOMAINS);

/**
 * 고객 도메인 이름 판정 — v1 허용 조건 전부(§3.1). 통과하면 정규화된 도메인과 등록 가능 apex 를 돌려준다(행의 `domain`·`registrable_domain`).
 * 소유 증명·다른 조직의 점유는 여기서 보지 않는다(DB 트리거와 확인 틱의 일).
 */
export function judgeCustomDomain(raw: string): DomainNameVerdict {
  const domain = normalizeDomainInput(raw);
  if (domain.length === 0) return { ok: false, reason: 'empty' };
  // 253(RFC 1035)이 아니라 100 — 도메인이 길면 identity policy 하나에 들어가는 주소가 줄어 발급 천장이 무너진다(ADR-0014). DB CHECK 와 같다.
  if (domain.length > CUSTOM_DOMAIN_MAX_LENGTH) return { ok: false, reason: 'too_long' };
  if (domain.endsWith('.')) return { ok: false, reason: 'trailing_dot' };
  const labels = domain.split('.');
  if (labels.some((label) => !LDH_LABEL.test(label))) return { ok: false, reason: 'invalid_label' };
  if (labels.some((label) => RESERVED_LDH_LABEL.test(label))) return { ok: false, reason: 'idn_label' };
  // TLD 는 숫자만일 수 없다 — 그런 모양은 IPv4(`10.0.0.1`)다. IPv6·`[..]` 는 LDH 에서 이미 떨어졌다.
  if (/^[0-9]+$/.test(labels[labels.length - 1] ?? '')) return { ok: false, reason: 'ip_address' };
  if (labels.length < 2) return { ok: false, reason: 'single_label' };
  const registrable = registrableDomainOf(domain);
  if (registrable === null) return { ok: false, reason: 'public_suffix' };
  if (registrable === AGENT_ADDRESS_DOMAIN) return { ok: false, reason: 'platform_domain' };
  if (SHARED_MAILBOX.has(registrable)) return { ok: false, reason: 'shared_mailbox_domain' };
  if (registrable === domain) return { ok: false, reason: 'registrable_apex' };
  return { ok: true, domain, registrable };
}
