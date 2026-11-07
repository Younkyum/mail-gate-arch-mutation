/**
 * src/passport/attestations.ts — Phase 1 attestation 4종 (계획 §4B.2 · §4B.3). **전부 버킷 — 수치 금지.**
 *
 * 정확한 대화 건수는 영업 물량이고, 정확한 가입 시각은 상관·핑거프린팅 벡터다(§4B.3 "비공개" 표). 그래서 이 파일은 사실(숫자)을
 * 받아 **버킷만** 돌려준다 — 숫자가 서명 문서로 가는 길이 타입에 없다(`Attestation.value` 는 불리언 또는 버킷 문자열 리터럴).
 *
 * 모든 attestation 에 `issuer` 를 병기한다(§4B.3 r3 V3): "누가 무엇을 확인했는가" 가 응답에 드러나야 ADR-0003 의 금지 문구를
 * 기계 판독 형태로 되살리지 않는다. Phase 1 의 발급자는 전부 Atmark(`did:web:id.atmark.ai`)이고, 그 사실이 곧
 * "이 passport 는 Atmark 를 믿으라는 것과 같다" 의 표기다.
 */

import { ATMARK_CONTROLLER_DID } from './did';

/** `account_age_bucket` (§4B.3). 경계는 30일·180일. */
export type AccountAgeBucket = 'lt_30d' | '30_180d' | 'gt_180d';

/** `successful_conversations_bucket` (§4B.3). */
export type ConversationsBucket = '0' | '1_9' | '10_99' | '100_plus';

export const ACCOUNT_AGE_BUCKETS = ['lt_30d', '30_180d', 'gt_180d'] as const satisfies readonly AccountAgeBucket[];
export const CONVERSATIONS_BUCKETS = ['0', '1_9', '10_99', '100_plus'] as const satisfies readonly ConversationsBucket[];

/**
 * Phase 1 에서 에이전트 주소가 속한 도메인 중 **Atmark 가 통제를 확인한 것**. 지금은 `atmark.ai` 하나다 — SES 도메인 identity
 * (DKIM)를 우리가 소유하고 검증했다. 고객 도메인은 서명 워커가 DB 판정(`atmark_agent_primary_view` — 같은 조직의 행이 verified · suspended(plan_limit))
 * 으로 `domainVerified` 를 넘긴다(ADR-0014 2026-10 개정 · F-7). 그 값이 없으면(옛 호출) 이 목록으로 판정한다.
 */
const ATMARK_VERIFIED_DOMAINS: readonly string[] = ['atmark.ai'];

/**
 * 고객 도메인 `domain_verified` 의 **근거 문구**(F-7 — 콘솔 신원 화면 · 문서가 같은 값을 쓴다). 서명 시점의 사실만 말한다 — 과장 금지(`immutable` ·
 * "누구나 검증" 류는 `test/support/copy-guard.ts`). 서명 문서에는 싣지 않는다(문서 모양은 그대로 — `domain_verified` 의 값과 `domain` 만).
 */
export const DOMAIN_VERIFIED_BASIS = {
  ko: 'Atmark가 서명 시점에 TXT 소유 증명과 DKIM을 확인했습니다.',
  en: 'Atmark verified TXT ownership and DKIM at signing time.',
} as const;

/**
 * `no_policy_violations` 를 거짓으로 만드는 거부 사유 — **진짜 위반만** (2026-09-24 재정의, ADR-0003 "no_policy_violations 의 정의").
 *
 * 위반 = 에이전트가 **어떤 소유자 설정으로도 풀리지 않는 플랫폼 불변식**을 넘으려 한 시도. 에이전트가 미리 알 수 있는 규칙이고
 * (주소·공개된 한도), 넘으려 했다는 사실이 곧 오작동·악용 신호다:
 *   - `from_forgery`(Stage 1) — 자기 것이 아닌 주소로 보내려 했다(신원 위조).
 *   - `attachment_bytes_exceeded` · `mime_type_not_allowed` · `recipient_ceiling_exceeded`(Stage 6) — 플랫폼 내용 가드(첨부 총량 ·
 *     허용 MIME · 메시지당 절대 수신자 상한 `MAX_RECIPIENTS_PER_MESSAGE`). 소유자가 바꿀 수 없는 값이다.
 *
 * **위반이 아닌 것**(세면 attestation 이 "정책이 일하는 것" 을 "나쁜 행동" 으로 공표한다):
 *   - **소유자가 설정한 정책이 제대로 막은 것** — `recipient_not_allowlisted`·`recipient_blocklisted`·`outbound_disabled`(정책 v2) ·
 *     옛 이름 `recipient_not_in_allowlist`·`blocklist`·`outbound_mode_disabled` · 레거시 `reply_only_*` · 승인 대기/거절/만료 ·
 *     소유자 한도 `recipients_per_message`. 화이트리스트 모드의 에이전트가 목록 밖에 보내려다 막히는 것은 설계된 동작이다.
 *   - **운영 제동** — Stage 0(결제·동결·소유자 정지·검토·에이전트 비활성) · 억제 목록(`suppression_list`·`ses_account_level_suppression`
 *     — 받는 쪽의 반송·불만 이력이고 에이전트는 목록 내용을 볼 수 없다) · 속도·워밍업·예산 · 평가 오류·미등록 경로·릴리스 창.
 *
 * 창(window)은 **최근 90일**이다(`POLICY_VIOLATION_WINDOW_DAYS`) — 한 번의 사고가 에이전트 평생의 공개 표지가 되지 않게. 일일 재서명
 * 스캔이 창을 벗어난 날을 잡아 새 버전을 낸다.
 *
 * 문자열 집합이다(`DenyReason` 유니온이 아니다): 서명 워커는 감사 행의 `reasons` 를 문자열로 대조한다. 새 **플랫폼 불변식** 사유를
 * 만들면 여기에 더한다(`test/unit/passport/document.test.ts` 가 목록을 고정한다).
 */
export const POLICY_VIOLATION_REASONS: readonly string[] = [
  // Stage 1 — 발신자 위조
  'from_forgery',
  // Stage 6 — 플랫폼 내용 가드
  'attachment_bytes_exceeded',
  'mime_type_not_allowed',
  'recipient_ceiling_exceeded',
];

/** `no_policy_violations` 의 창 — 최근 이 일수 안의 거부만 센다. */
export const POLICY_VIOLATION_WINDOW_DAYS = 90;

export type Attestation =
  /** `domain` = 대표 주소의 도메인. 대표 주소가 없으면(고객 도메인을 잃었다) `null` 이고 `value` 는 거짓이다(ADR-0014 2026-10 개정). */
  | { readonly type: 'domain_verified'; readonly value: boolean; readonly domain: string | null; readonly issuer: string }
  | { readonly type: 'no_policy_violations'; readonly value: boolean; readonly issuer: string }
  | { readonly type: 'account_age_bucket'; readonly value: AccountAgeBucket; readonly issuer: string }
  | { readonly type: 'successful_conversations_bucket'; readonly value: ConversationsBucket; readonly issuer: string };

/** attestation 을 만드는 사실. **숫자는 여기까지만 온다** — 출력에는 버킷뿐이다. */
export interface AttestationFacts {
  /** 대표 주소의 도메인. 대표 주소가 없으면 `null`. */
  readonly addressDomain: string | null;
  /** 서명 시점에 Atmark 가 그 도메인을 확인했는가(DB 판정). 없으면 `ATMARK_VERIFIED_DOMAINS` 로 판정한다. */
  readonly domainVerified?: boolean;
  readonly agentCreatedAt: Date;
  /** 최근 `POLICY_VIOLATION_WINDOW_DAYS` 일 안의 진짜 위반 수. */
  readonly policyViolationCount: number;
  /** 에이전트가 보낸(`sent`) 메일과 받은 메일이 **둘 다** 있는 스레드 수. */
  readonly conversationCount: number;
  readonly now: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function accountAgeBucket(createdAt: Date, now: Date): AccountAgeBucket {
  const days = (now.getTime() - createdAt.getTime()) / DAY_MS;
  if (days < 30) return 'lt_30d';
  if (days < 180) return '30_180d';
  return 'gt_180d';
}

export function conversationsBucket(count: number): ConversationsBucket {
  if (!Number.isInteger(count) || count < 0) throw new Error(`대화 수는 0 이상의 정수다: ${String(count)}`);
  if (count === 0) return '0';
  if (count < 10) return '1_9';
  if (count < 100) return '10_99';
  return '100_plus';
}

/** 4종을 **고정 순서로** 만든다 — 순서가 흔들리면 같은 사실에서 다른 JCS 가 나오고, 재서명 비교가 매번 "바뀜" 이 된다. */
export function computeAttestations(facts: AttestationFacts): readonly Attestation[] {
  const issuer = ATMARK_CONTROLLER_DID;
  const domain = facts.addressDomain === null ? null : facts.addressDomain.toLowerCase();
  const verified = domain !== null && (facts.domainVerified ?? ATMARK_VERIFIED_DOMAINS.includes(domain));
  return [
    // 순서는 고정(ADR-0003) — 대표 주소가 없어도 domain_verified 가 첫째다(값 거짓 · domain null).
    { type: 'domain_verified', value: verified, domain, issuer },
    { type: 'no_policy_violations', value: facts.policyViolationCount === 0, issuer },
    { type: 'account_age_bucket', value: accountAgeBucket(facts.agentCreatedAt, facts.now), issuer },
    { type: 'successful_conversations_bucket', value: conversationsBucket(facts.conversationCount), issuer },
  ];
}
