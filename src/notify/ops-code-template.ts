/**
 * src/notify/ops-code-template.ts — 호스팅 운영자 콘솔(ops.atmark.ai) **코드 메일의 고정 템플릿**. 순수 함수 하나(보내지 않는다).
 *
 * 목적 셋(`ops_login_challenges.purpose`): 로그인 · 접근 요청 확인 · step-up(특권 행위 확인). 규율은 소유자 로그인 메일(`owner-login-template.ts`)과 같다:
 *   - **누구도 고른 문자열이 없다.** 요청자가 넣은 주소·이름은 본문에 싣지 않는다. 들어가는 것은 6자리 코드 · 만료 시각 · (step-up 이면) 행위
 *     라벨(아래 고정 표)과 서버가 만든 대상 참조(base32 4자리)뿐이다.
 *   - **링크가 없다.** 코드는 요청한 브라우저에 사람이 옮겨 적는다(결속은 DB 가 본다).
 *   - **코드는 제목에도 싣는다**(2026-10-10 문구 개편 — 로그인 메일과 같다). step-up 의 행위 라벨과 대상 참조도 제목에 싣는다(화면의 값과 대조).
 *     숨은 미리보기 문장에는 코드를 넣지 않는다.
 *   - **한 통에 한 언어**(2026-10-10) — 운영자 사용자의 설정(`users.mail_locale`) → 요청 화면 언어(`ops_login_challenges.lang`) → 'en'.
 *     알림기가 고른다. 문구는 `OPS_CODE_COPY.<locale>` · 행위 라벨은 `OPS_ACTION_LABELS[action].<locale>`.
 *   - text/plain + text/html 두 파트 — 공용 틀(`mail-layout.ts`)이 한 구조에서 만든다. 링크가 없으므로 HTML 에도 `http` 가 한 글자도 없다.
 */

import type { MailCopyDictionary, MailLocale } from '../i18n/locales';
import type { OpsAction } from '../ops/contract';
import { assertMailCode, renderMail, type MailLine, type MailSection, type RenderedMail } from './mail-layout';

export type OpsCodeMailPurpose = 'login' | 'access_request' | 'step_up';

export interface OpsCodeMailView {
  readonly purpose: OpsCodeMailPurpose;
  readonly code: string;
  readonly expiresAt: Date;
  /** step-up 만 — 행위와 대상 참조. */
  readonly action?: OpsAction | null;
  readonly targetRef?: string | null;
}

/** 행위 라벨 — 고정 표(계약 `OPS_ACTIONS`). 화면(대화상자)과 같은 말이어야 한다. */
export const OPS_ACTION_LABELS: Readonly<Record<OpsAction, Readonly<Record<MailLocale, string>>>> = {
  'org.activate': { ko: '조직 활성화', en: 'Activate organization' },
  'org.reject': { ko: '조직 거절', en: 'Reject organization' },
  'org.freeze_on': { ko: '조직 긴급 정지', en: 'Freeze organization' },
  'agent.suspend': { ko: '에이전트 정지', en: 'Suspend agent' },
  'operator.approve': { ko: '운영자 요청 승인', en: 'Approve operator request' },
  'operator.deny': { ko: '운영자 요청 거절', en: 'Deny operator request' },
  'operator.revoke': { ko: '운영자 폐기', en: 'Revoke operator' },
};

const TARGET_REF_PATTERN = /^[0-9A-Z]{4}$/;

function stepUpTarget(view: OpsCodeMailView): { readonly action: OpsAction; readonly ref: string } {
  const action = view.action ?? null;
  const ref = view.targetRef ?? null;
  // `in` 이 아니라 `Object.hasOwn` — `in` 은 프로토타입 체인까지 봐서 'toString'·'__proto__' 가 통과한다.
  if (action === null || !Object.hasOwn(OPS_ACTION_LABELS, action)) throw new Error('step-up 메일에는 계약의 행위가 있어야 한다');
  if (ref === null || !TARGET_REF_PATTERN.test(ref)) throw new Error('step-up 메일의 대상 참조는 base32 4자리여야 한다');
  return { action, ref };
}

/** 코드 수명(분) — `ops_login_challenges_ttl` CHECK(≤ 10분)와 같은 값. */
const OPS_CODE_MINUTES = 10;

/** 목적 하나의 문구(제목 · 미리보기 · 머리 · 코드 이름표 · 할 일). step-up 은 행위 라벨 · 참조를 받는다. */
interface OpsPurposeCopy {
  readonly subject: (code: string) => string;
  readonly preheader: string;
  readonly lead: readonly MailLine[];
  readonly codeLabel: string;
  readonly body: (minutes: number) => readonly MailLine[];
}

export interface OpsCodeCopy {
  readonly login: OpsPurposeCopy;
  readonly accessRequest: OpsPurposeCopy;
  readonly stepUp: {
    readonly subject: (code: string, actionLabel: string, ref: string) => string;
    readonly preheader: string;
    readonly lead: readonly MailLine[];
    readonly actionLabel: string;
    readonly refLabel: string;
    readonly codeLabel: string;
    readonly body: (minutes: number) => readonly MailLine[];
  };
  readonly note: string;
}

// ===========================================================================
// ✎ 운영 콘솔 코드 메일 문구 — 문구 작성자가 고치는 곳. `?` 를 쓰지 않는다.
// ===========================================================================

export const OPS_CODE_COPY: MailCopyDictionary<OpsCodeCopy> = {
  en: {
    login: {
      subject: (code) => `${code} is your Atmark ops login code`,
      preheader: 'It works only once.',
      lead: ['Your ops console login code'],
      codeLabel: 'Code',
      body: (minutes) => [`Enter this code to log in to the ops console. It expires in ${String(minutes)} minutes.`],
    },
    accessRequest: {
      subject: (code) => `${code} confirms: ops access request`,
      preheader: 'It works only once.',
      lead: ['Confirm your ops console access request'],
      codeLabel: 'Code',
      body: (minutes) => [`Enter this code to send your request. It expires in ${String(minutes)} minutes.`],
    },
    stepUp: {
      subject: (code, actionLabel, ref) => `${code} confirms: ${actionLabel.charAt(0).toLowerCase()}${actionLabel.slice(1)} [${ref}]`,
      preheader: 'It works only once.',
      lead: ['Confirm this ops action'],
      actionLabel: 'Action',
      refLabel: 'Reference',
      codeLabel: 'Code',
      body: (minutes) => [`Enter it only if the console shows the same action and reference. It expires in ${String(minutes)} minutes.`],
    },
    note: "If you didn't request it, you can ignore this email.",
  },
  ko: {
    login: {
      subject: (code) => `${code} Atmark 운영 콘솔 로그인 코드`,
      preheader: '한 번만 쓸 수 있습니다.',
      lead: ['운영 콘솔 로그인 코드'],
      codeLabel: '코드',
      body: (minutes) => [`운영 콘솔 로그인 화면에 입력해 주세요. ${String(minutes)}분 뒤 만료됩니다.`],
    },
    accessRequest: {
      subject: (code) => `${code} Atmark 운영 콘솔 접근 요청 확인 코드`,
      preheader: '한 번만 쓸 수 있습니다.',
      lead: ['운영 콘솔 접근 요청을 확인해 주세요'],
      codeLabel: '코드',
      body: (minutes) => [`요청을 보내려면 이 코드를 입력해 주세요. ${String(minutes)}분 뒤 만료됩니다.`],
    },
    stepUp: {
      subject: (code, actionLabel, ref) => `${code} 운영 작업 확인: ${actionLabel} [${ref}]`,
      preheader: '한 번만 쓸 수 있습니다.',
      lead: ['운영 작업을 확인해 주세요'],
      actionLabel: '작업',
      refLabel: '참조',
      codeLabel: '코드',
      body: (minutes) => [`콘솔 화면의 작업과 참조가 위와 같을 때만 입력해 주세요. ${String(minutes)}분 뒤 만료됩니다.`],
    },
    note: '요청하지 않았다면 이 메일은 무시하셔도 됩니다.',
  },
};

// ===========================================================================

/** 운영 코드 메일 한 통 — 한 언어. 코드는 제목과 블록에 한 번씩, 미리보기 문장에는 없다. 링크가 없다. */
export function renderOpsCodeMail(view: OpsCodeMailView, locale: MailLocale): RenderedMail {
  const code = assertMailCode(view.code);
  const copy = OPS_CODE_COPY[locale];
  const notes = [[copy.note]];
  if (view.purpose === 'step_up') {
    const { action, ref } = stepUpTarget(view);
    const label = OPS_ACTION_LABELS[action][locale];
    const section: MailSection = {
      lang: locale,
      lead: copy.stepUp.lead,
      facts: [
        { label: copy.stepUp.actionLabel, value: label },
        { label: copy.stepUp.refLabel, value: { mono: ref } },
      ],
      code: { label: copy.stepUp.codeLabel, value: code },
      body: copy.stepUp.body(OPS_CODE_MINUTES),
      notes,
    };
    return renderMail({ subject: copy.stepUp.subject(code, label, ref), preheader: copy.stepUp.preheader, link: null, section });
  }
  const purpose = view.purpose === 'login' ? copy.login : copy.accessRequest;
  return renderMail({
    subject: purpose.subject(code),
    preheader: purpose.preheader,
    link: null,
    section: { lang: locale, lead: purpose.lead, code: { label: purpose.codeLabel, value: code }, body: purpose.body(OPS_CODE_MINUTES), notes },
  });
}
