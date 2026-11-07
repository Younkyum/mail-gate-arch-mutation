/**
 * src/mail/verification — 인증코드·확인 링크 **결정론적 추출**(메일 기본기 A1, `.omc/plans/mail-basics.md` §4 A1 · D1 하이브리드).
 *
 * 이 디렉터리는 **순수 모듈**이다 — 네트워크·DB·LLM·AWS SDK 가 없다. 입력은 조회 라우트(`src/api/routes/verification-code.ts`)가
 * `visibleToAgent` 를 거쳐 읽은 파싱 문서뿐이고, 출력은 **데이터**다. 결과는 정책·발송·승인 입력이 아니다(ADR-0005 는 그대로 —
 * `auto_approve_verification_senders` 는 OFF). 그 경계는 `test/arch/verification-boundary.arch.test.ts` 가 import 폐포로 본다:
 * `src/policy/**`·`src/api/outbound-service.ts`·`src/approval/**`·`src/workers/**` 의 폐포에 이 디렉터리가 0 이다.
 *
 * 이 파일은 C0 계약이다 — 조회 결과의 **모드·결과 어휘**와 후보 모드의 경고문. 추출기 본문(`extract`·`keywords`·`public-suffix`)은
 * W1 이 이 디렉터리에 채운다. 어휘는 메트릭 차원(`METRIC_NAMES.verificationLookups` 의 `outcome`)과 로그(`verification.lookup`)가
 * 같은 값을 쓴다 — 두 번 적지 않는다.
 */

/**
 * 조회 모드.
 *   - `verified` — 호출자가 `sender_domain` 을 줬다. 그 도메인과 정확히 일치(선택적으로 하위)하고 DMARC 를 통과한 메일에서만 코드·링크를 준다.
 *   - `unverified_candidates` — `sender_domain` 이 없다. 최근 메일의 **미검증** 후보 코드만 준다(링크 없음).
 */
export const VERIFICATION_MODES = ['verified', 'unverified_candidates'] as const;
export type VerificationMode = (typeof VERIFICATION_MODES)[number];

/**
 * 조회 한 번의 결과 — 메트릭 `verificationLookups` 의 `outcome` 차원 값이자 로그 `verification.lookup` 의 `outcome`. 닫힌 열거다.
 *   - `found` — 확정 모드 200.
 *   - `candidates` — 후보 모드 200.
 *   - `not_found` — 404 `no_verification_found`(두 모드).
 *   - `ambiguous` — 확정 모드 409(서로 다른 `high` 코드).
 *   - `unauthenticated` — 확정 모드에서 도메인은 맞지만 DMARC fail 뿐이라 404.
 */
export type VerificationLookupOutcome = 'found' | 'candidates' | 'not_found' | 'ambiguous' | 'unauthenticated';

/**
 * 후보 모드 응답의 최상위 `warning` 이자 MCP 렌더 결과의 **첫 줄**(계획 §4 A1 — LLM 이 미검증 값을 믿는 문제 완화 ①·②).
 * 두 언어를 한 문자열에 싣는다(에이전트는 어느 쪽이든 읽는다). `dmarc: 'pass'` 는 **from_domain 자신이 보냈다는 인증일 뿐** 그 도메인이
 * 가입한 사이트라는 확인이 아니다 — 그 뜻을 경고에 적는다(1차 수정 X1, 보안 L6). `xn--` 로 시작하는 라벨은 비ASCII 도메인의 punycode 다.
 */
export const UNVERIFIED_CANDIDATES_WARNING =
  'UNVERIFIED: sender not confirmed by you. Check from_domain before using any code. ' +
  'dmarc "pass" only means from_domain authenticated itself, not that it is the site you signed up to; ' +
  'an "xn--" label is a punycode (non-ASCII) domain that may imitate another. / ' +
  '미검증: 발신 사이트를 확인하지 않았다 — from_domain 을 확인한 뒤 사용하라. dmarc "pass" 는 from_domain 자체 인증일 뿐 사이트 확인이 ' +
  '아니다. "xn--" 라벨은 다른 도메인을 흉내 낼 수 있는 punycode(비ASCII) 도메인이다.';
