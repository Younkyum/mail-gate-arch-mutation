/**
 * src/gate/forwarded.ts — `forwarded_from_human_mailbox` 판정식 (계획 §11B **B2③**, AC-b3 의 유일한 근거).
 *
 * "이 수신 메일은 대표의 사람 메일함이 **전달해서** 에이전트에게 온 것인가."
 *
 * 1–7일차(관측)에는 이 판정이 센 건수의 **감소 추세**가 AC-b3 다. 8–14일차(증명)에는 이 판정이
 * **1건이라도** 나오면 "전달 규칙이 실제로 꺼지지 않았다" 로 게이트가 재시작된다. 즉 이 함수의
 * 미탐은 두 곳에서 공허한 통과를 만든다 — 1일차가 0건이면 추세가 공허하고(B2① 최소 표본이 막는다),
 * 증명 구간의 누수가 안 보이면 "규칙 OFF" 가 거짓이어도 통과한다.
 *
 * ===========================================================================
 * ## 판정식
 * ===========================================================================
 *
 *   forwarded ⇔ envelope sender 가 사람 메일함 주소의 **전달 형태**이고
 *               AND 헤더 From 이 사람 메일함 주소가 **아니다**
 *
 * Gmail 자동 전달(필터 전달·전체 전달 모두)은 봉투 발신자(SMTP MAIL FROM = SES `mail.source`
 * = Return-Path)를 **전달자 주소**로 재작성하고 헤더 From 은 원 발신자 그대로 둔다. 그래서
 * "Return-Path == 창업자 주소 AND From == 제3자" 가 계획이 적은 실질 판정식이다.
 *
 * ===========================================================================
 * ## ⚠ `+caf_=` 꼬리 — **실측 아님.** 실측이 오면 `isForwardedFormOf` 하나를 교체한다
 * ===========================================================================
 *
 * Gmail 은 봉투 발신자를 `owner+caf_=agent=atmark.ai@gmail.com` 꼴로 바꾼다고 **알려져 있다**
 * (전달 대상 `agent@atmark.ai` 의 `@` 를 `=` 로 바꿔 `+caf_=` 뒤에 붙인 모양). 2026-09-23 현재
 * **우리가 받아 본 적은 없다** — `inbound_messages.envelope_sender` 에 실측 행이 0건이다.
 * 문자열 동일 비교(`envelope == owner`)는 이 꼬리 때문에 **항상 실패**한다.
 *
 * 그래서:
 *   - 가정은 **`isForwardedFormOf` 한 함수**에만 산다. 다른 코드는 `classifyForwarded` 의 결과만 본다.
 *   - 판정은 저장하지 않는다. `pnpm check:ac0` 가 매번 `inbound_messages` 원자료(정규화하지 않은
 *     `envelope_sender`)에 다시 적용한다 — 실측 후 이 함수를 바꾸면 **과거 행에도 소급**된다.
 *   - 실측 절차(확인 메일 + 첫 전달 메일, 볼 컬럼과 SQL)는 `docs/runbooks/ac0-shadow-log.md` §4.
 *   - 실측 전까지는 **넓게** 잡는다: 꼬리의 **대상 부분(`agent=atmark.ai`)은 검사하지 않는다.**
 *     대상 인코딩이 가정과 다르면 좁은 판정은 전부 미탐이 되고, 미탐은 위에 적은 공허 통과의 방향이다.
 *     오탐의 방향(전달이 아닌데 전달로 셈)은 게이트를 **막는** 쪽이라 안전하다.
 *
 * ===========================================================================
 * ## 경계 사례 — 판정 결과를 테스트로 고정했다 (`test/unit/gate/forwarded.test.ts`)
 * ===========================================================================
 *
 *   - 대표가 에이전트에게 **직접** 쓴 메일: envelope = 대표 주소, From = 대표 → **전달 아님**(owner_authored).
 *   - 대표가 Gmail "다른 주소에서 메일 보내기" 별칭으로 직접 쓴 메일: envelope = Gmail 계정, From = 별칭 →
 *     별칭이 게이트의 사람 메일함 목록에 **있으면** 전달 아님, **없으면 오탐**(전달로 셈). 그래서 런북이
 *     별칭 전부를 `--human-mailbox` 로 넣으라고 한다.
 *   - Google Workspace **사용자 수준** 전달(Gmail 설정 화면): Gmail 과 같은 재작성 → 전달(같은 판정).
 *   - Google Workspace **관리자 라우팅**(수신 경로 변경·수신자 추가): 봉투 발신자가 **원 발신자 그대로**다 →
 *     **미탐.** 이 판정식으로는 볼 수 없다. 런북이 관리자 라우팅을 금지한다.
 *   - 필터 전달 vs 전체 전달: 봉투 모양이 같다 → **구분하지 않는다**(둘 다 전달). 전체 전달은 런북이 금지한다.
 *   - Gmail 전달 주소 확인 메일(`forwarding-noreply@google.com`): 전달이 아니라 Google 이 보낸 메일 → 전달 아님.
 *   - 반송(널 발신자 `<>`): envelope 없음 → 전달 아님.
 *   - `X-Forwarded-For`/`X-Forwarded-To`: **발신자가 쓸 수 있는 헤더**라 단독 근거가 아니다. 봉투가 전달
 *     형태가 아닌데 이 헤더가 사람 메일함/에이전트 주소를 가리키면 `auxiliarySignal` 로 표시만 한다 —
 *     `pnpm check:ac0` 가 "판정식 불일치 의심" 으로 보여 주고, 그것이 실측 교체의 신호다.
 */

import { normalizeAddress } from '../policy/policy-loader';

/** 판정 입력 — `inbound_messages` 의 원자료 컬럼 그대로. */
export interface ForwardedEvidence {
  /** `envelope_sender`. 정규화하지 않은 값. 널 발신자면 `null`. */
  readonly envelopeSender: string | null;
  /** `from_address`(소문자). */
  readonly fromAddress: string;
  /** `forwarded_for_header` 원문. */
  readonly forwardedForHeader: string | null;
  /** `forwarded_to_header` 원문. */
  readonly forwardedToHeader: string | null;
  /** `envelope_recipient` — 이 메일을 받은 에이전트 주소. */
  readonly envelopeRecipient: string;
}

export type ForwardedVerdict =
  | {
      readonly forwarded: true;
      /** `caf_rewrite` = `+caf_=` 꼬리가 있는 형태. `mailbox_itself` = 사람 메일함 주소 그대로(꼬리 없음). */
      readonly basis: 'caf_rewrite' | 'mailbox_itself';
      readonly mailbox: string;
    }
  | {
      readonly forwarded: false;
      readonly reason: 'no_envelope_sender' | 'owner_authored' | 'envelope_not_human_mailbox';
      /** 봉투는 아니라는데 `X-Forwarded-*` 가 사람 메일함/에이전트를 가리킨다 — 판정식 불일치 의심. */
      readonly auxiliarySignal: boolean;
    };

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/** Gmail 계정 동일성 — 로컬파트의 점 무시, `googlemail.com` = `gmail.com`. 다른 도메인은 그대로. */
function gmailAccount(local: string, rawDomain: string): { readonly local: string; readonly domain: string } {
  const domain = rawDomain === 'googlemail.com' ? 'gmail.com' : rawDomain;
  return { local: GMAIL_DOMAINS.has(domain) ? local.replace(/\./g, '') : local, domain };
}

/** `<a@b>`·공백·대소문자를 벗긴 `local@domain`. 모양이 아니면 `null`. */
function bareAddress(value: string): string | null {
  const trimmed = value.trim().replace(/^<|>$/g, '').trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at === trimmed.length - 1 || /\s/.test(trimmed)) return null;
  return trimmed;
}

interface CanonicalAddress {
  /** `+` 앞의 로컬파트(Gmail 이면 점 제거). */
  readonly base: string;
  /** `+` 뒤(없으면 `null`). */
  readonly tag: string | null;
  /** 도메인(`googlemail.com` → `gmail.com`). */
  readonly domain: string;
}

/** 주소의 비교형(`gmailAccount`). `+` 뒤는 모든 도메인에서 떼어 둔다 — Workspace 등은 점이 의미가 있다. */
function canonical(address: string): CanonicalAddress | null {
  const bare = bareAddress(address);
  if (bare === null) return null;
  const at = bare.lastIndexOf('@');
  const local = bare.slice(0, at);
  const plus = local.indexOf('+');
  const { local: base, domain } = gmailAccount(plus === -1 ? local : local.slice(0, plus), bare.slice(at + 1));
  return { base, tag: plus === -1 ? null : local.slice(plus + 1), domain };
}

function sameMailbox(a: CanonicalAddress, b: CanonicalAddress): boolean {
  return a.base === b.base && a.domain === b.domain;
}

/**
 * ★ **실측 대기 중인 가정이 사는 유일한 함수.** 봉투 발신자가 사람 메일함 `mailbox` 의 전달 형태인가.
 *
 * 현재 가정: 같은 메일함(비교형 동일) 이고, 꼬리가 없거나 `caf_=` 로 시작하는 꼬리다.
 *   - `owner+caf_=agent=atmark.ai@gmail.com` → `caf_rewrite`   (Gmail·Workspace 사용자 수준 전달, 알려진 형태)
 *   - `owner@gmail.com`                      → `mailbox_itself` (계획 B2③ 의 원형 `Return-Path == 창업자 주소`)
 *   - `owner+news@gmail.com`                 → 전달 형태 아님   (다른 꼬리는 전달 흔적이 아니다)
 *
 * 실측이 이 가정과 다르면 **이 함수만** 바꾸고, `test/unit/gate/forwarded.test.ts` 의 "실측 대기" 절 기대값을
 * 실측값으로 교체한다.
 */
export function isForwardedFormOf(
  envelopeSender: string,
  mailbox: string,
): 'caf_rewrite' | 'mailbox_itself' | null {
  const envelope = canonical(envelopeSender);
  const human = canonical(mailbox);
  if (envelope === null || human === null || !sameMailbox(envelope, human)) return null;
  if (envelope.tag === null) return 'mailbox_itself';
  return envelope.tag.startsWith('caf_=') ? 'caf_rewrite' : null;
}

/**
 * 상대 식별 키 — AC-0 이 "서로 다른 상대" 를 셀 때 쓴다(관측 표본의 외부 발신자, 활동 분모의 신규 외부 상대).
 *
 * `+태그` 절단은 **`normalizeAddress`(정책 로더 — 저장소의 정규화 유일 지점)** 를 그대로 쓰고, Gmail 계정의
 * 동일성(로컬파트 점 무시, `googlemail.com` = `gmail.com`)만 여기서 더한다. 그래서 `bob+1@x`~`bob+5@x` 와
 * `b.o.b@gmail.com` 은 각각 한 상대다(V3 H2②). 주소 모양이 아니면 소문자 원문을 그대로 돌려준다.
 */
export function contactKey(address: string): string {
  const normalized = normalizeAddress(address.trim().replace(/^<|>$/g, ''));
  const at = normalized.lastIndexOf('@');
  if (at <= 0) return normalized;
  const { local, domain } = gmailAccount(normalized.slice(0, at), normalized.slice(at + 1));
  return `${local}@${domain}`;
}

/** `address` 가 사람 메일함 중 하나인가(별칭·Gmail 점·`+태그` 무시). */
export function isHumanMailbox(address: string, humanMailboxes: readonly string[]): boolean {
  const candidate = canonical(address);
  if (candidate === null) return false;
  return humanMailboxes.some((mailbox) => {
    const human = canonical(mailbox);
    return human !== null && sameMailbox(candidate, human);
  });
}

/** 헤더 값에서 주소 모양 토큰을 뽑는다(`X-Forwarded-For: a@x b@y`). */
function addressTokens(header: string | null): string[] {
  if (header === null) return [];
  return header.split(/[\s,;]+/).filter((token) => token.includes('@'));
}

function auxiliarySignal(evidence: ForwardedEvidence, humanMailboxes: readonly string[]): boolean {
  const forHuman = addressTokens(evidence.forwardedForHeader).some((token) => isHumanMailbox(token, humanMailboxes));
  const recipient = canonical(evidence.envelopeRecipient);
  const toAgent =
    recipient !== null &&
    addressTokens(evidence.forwardedToHeader).some((token) => {
      const parsed = canonical(token);
      return parsed !== null && sameMailbox(parsed, recipient);
    });
  return forHuman || toAgent;
}

/** 판정. 순서가 의미다 — 봉투 없음 → 대표가 쓴 메일 → 봉투의 전달 형태. */
export function classifyForwarded(evidence: ForwardedEvidence, humanMailboxes: readonly string[]): ForwardedVerdict {
  if (evidence.envelopeSender === null || bareAddress(evidence.envelopeSender) === null) {
    return { forwarded: false, reason: 'no_envelope_sender', auxiliarySignal: auxiliarySignal(evidence, humanMailboxes) };
  }
  // 대표가 에이전트에게 직접 쓴 메일(또는 자기 메일을 자기에게 전달한 것)은 "상대가 옛 주소로 보낸 메일" 이 아니다.
  if (isHumanMailbox(evidence.fromAddress, humanMailboxes)) {
    return { forwarded: false, reason: 'owner_authored', auxiliarySignal: false };
  }
  for (const mailbox of humanMailboxes) {
    const basis = isForwardedFormOf(evidence.envelopeSender, mailbox);
    if (basis !== null) return { forwarded: true, basis, mailbox };
  }
  return {
    forwarded: false,
    reason: 'envelope_not_human_mailbox',
    auxiliarySignal: auxiliarySignal(evidence, humanMailboxes),
  };
}
