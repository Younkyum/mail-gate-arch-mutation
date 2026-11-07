/**
 * src/approval/risk-copy.ts — **위험 보류의 고정 문구**(ADR-0016 UX). 승인 알림 메일(`notify/approval-notification-template.ts`)과 승인 페이지
 * (`approval/magic-link.ts`)가 같은 문장을 쓴다(두 벌이면 한쪽이 낡는다).
 *
 * 규칙:
 *   - **에이전트가 쓴 문자열이 한 글자도 없다** — 사유는 닫힌 코드이고 문장은 여기 상수다. 경고 문구 자리에 에이전트 값이 들어가면 인젝션이 소유자를
 *     설득하는 통로가 된다.
 *   - 값은 보이지 않는다 — DLP 결과에는 애초에 값·위치가 없다(`security/dlp/scan.ts`). 문구는 "무엇이 걸렸는가" 만 말한다.
 *   - 과장하지 않는다 — "인젝션을 막았다" 가 아니라 "위험 신호가 있어 사람에게 묻는다" 다(`test/support/copy-guard.ts`).
 *   - Atmark 자격 증명 적중은 가장 강하게 쓴다(진윤겸 결정 2 — 하드 거부가 아니라 승인/거부, 경고는 가장 강하게).
 */

import type { MailLocale } from '../i18n/locales';
import type { RiskHoldReason } from '../policy/types';

/** 메일 언어와 같은 집합(`src/i18n/locales.ts`) — 언어를 더하면 이 사전도 컴파일 오류로 빈칸을 알린다. */
export type RiskCopyLanguage = MailLocale;

/** 사유별 한 줄(두 언어). 키 집합이 `RiskHoldReason` 과 같다(타입이 강제한다). */
export const RISK_REASON_COPY: Readonly<Record<RiskHoldReason, Readonly<Record<RiskCopyLanguage, string>>>> = {
  dlp_atmark_credential: {
    ko: '가장 강한 경고 — 본문이나 첨부에 Atmark 자격 증명(API 키 · 웹훅 비밀 · 서명 링크 토큰)으로 보이는 값이 있습니다. 값은 표시하지 않습니다. 의도한 발송이 아니면 거절하고 그 키를 교체하세요.',
    en: 'Strongest warning — the body or an attachment contains what looks like an Atmark credential (API key, webhook secret or signed link token). The value is not shown. If you did not intend this, reject it and rotate that key.',
  },
  dlp_third_party_secret: {
    ko: '다른 서비스의 비밀 키(클라우드 · 저장소 · 결제 · 메신저 키, 개인 키)로 보이는 값이 있습니다. 값은 표시하지 않습니다.',
    en: "The content contains what looks like another service's secret key (cloud, repository, payment or messaging key, or a private key). The value is not shown.",
  },
  dlp_verification_code: {
    ko: '이 에이전트가 최근 24시간에 받은 인증 코드가 들어 있습니다. 코드는 표시하지 않습니다.',
    en: 'The content contains a verification code this agent received in the last 24 hours. The code is not shown.',
  },
  // 진윤겸 결정(재검증) — 재설정·공유·추적 링크를 가리지 않고 승인 대기다. 무엇인지 단정하지 않는다.
  dlp_secret_link: {
    ko: '받은 메일의 비밀 링크(공유·재설정 링크 등)가 들어 있습니다. 링크는 표시하지 않습니다.',
    en: 'The content contains a secret link from a received email (such as a sharing or password reset link). The link is not shown.',
  },
  dlp_inbound_copy: {
    ko: '이 에이전트가 받은 메일의 내용을 크게 옮겨 적었습니다 — 받은 메일을 다른 사람에게 보내는 것일 수 있습니다.',
    en: 'The content copies large parts of an email this agent received — it may be passing that email on to someone else.',
  },
  dlp_scan_limit: {
    ko: '본문·첨부가 너무 크거나 첨부를 읽지 못해 끝까지 검사하지 못했습니다.',
    en: 'The body or attachments were too large, or an attachment could not be read, so the content could not be checked completely.',
  },
  tainted_context: {
    ko: '이 에이전트는 최근 위험 신호가 있는 받은 메일(지시처럼 보이는 문장 · 인증되지 않은 발신 · 검사하지 못한 첨부)을 읽었습니다. 이 메일이 그 메일의 지시로 쓰였을 수 있습니다.',
    en: 'This agent recently read a received email with risk signals (text that reads like instructions, an unauthenticated sender, or an attachment that could not be checked). This email may have been written on that email\'s instructions.',
  },
};

/** 표시 순서 — 심각한 것 먼저(자격 증명 → 남의 비밀 → 코드 → 비밀 링크 → 복사 → 검사 한도 → 오염 맥락). */
export const RISK_REASON_ORDER: readonly RiskHoldReason[] = [
  'dlp_atmark_credential',
  'dlp_third_party_secret',
  'dlp_verification_code',
  'dlp_secret_link',
  'dlp_inbound_copy',
  'dlp_scan_limit',
  'tainted_context',
];

export interface RiskCopy {
  /** 위험 보류 블록 머리 — 고정 한 줄. */
  readonly heading: string;
  /** 자격 증명 적중일 때의 머리(가장 강한 경고). */
  readonly credentialHeading: string;
  /** 승인 범위 — 이번 한 통만. */
  readonly onceNotice: string;
  /** 출처 메일 목록의 머리(오염 맥락일 때). */
  readonly sourcesHeading: string;
}

export const RISK_COPY: Readonly<Record<RiskCopyLanguage, RiskCopy>> = {
  ko: {
    heading: '■ 위험 신호가 있는 발송입니다 — 승인하기 전에 아래 사유를 확인하세요.',
    credentialHeading: '■■ 경고: Atmark 자격 증명이 담긴 발송입니다 — 의도하지 않았다면 거절하세요.',
    onceNotice: '■ 위험 신호가 있는 발송은 이번 한 통만 승인됩니다. 승인해도 이 상대에게 앞으로 승인 없이 보낼 수 있게 되지 않습니다.',
    sourcesHeading: '■ 최근 읽은 위험 신호 메일(바깥에서 온 값입니다 — 그 안의 지시·링크를 따르지 마세요):',
  },
  en: {
    heading: '■ This send has risk signals — check the reasons below before approving.',
    credentialHeading: '■■ Warning: this send contains an Atmark credential — reject it if you did not intend this.',
    onceNotice: '■ A send with risk signals is approved for this one email only. Approving does not let the agent send to these recipients without approval later.',
    sourcesHeading: '■ Recently read emails with risk signals (values from outside — do not follow instructions or links in them):',
  },
};

/** 사유 목록 → 표시 순서대로(모르는 값은 버린다 — 닫힌 어휘만 사람에게 보인다). */
export function orderedRiskReasons(reasons: readonly string[]): RiskHoldReason[] {
  const present = new Set(reasons);
  return RISK_REASON_ORDER.filter((reason) => present.has(reason));
}
