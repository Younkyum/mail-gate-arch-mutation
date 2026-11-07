/**
 * src/notify/domain-notice-template.ts — **고객 도메인 알림 메일의 고정 템플릿**(ADR-0014 단계 4 M3b · 계획 §3.11 M14). 순수 함수 하나(보내지 않는다).
 *
 * 종류 다섯(`domain_notices.kind`): 정지(사유별 — 소유 확인 상실 · DKIM 실패 · 평판 · 운영자 · 요금제) · 제거 3일 전 예고 · 제거됨 · 등록 만료 예고(30일 · 7일) ·
 * 확인 완료(첫 확인 · 자동 복귀는 문구가 따로 — 제목에 도메인 이름).
 * **한 통에 한 언어**(2026-10-10) — 받는 사람(owner · admin)마다 그 사용자의 설정(`users.mail_locale` → 'en'), 알림기가 고른다. 공용 틀 `mail-layout.ts`
 * (text/plain + text/html 이 한 구조에서). 링크는 콘솔의 도메인 설정 하나(상수). 문구는 `DOMAIN_NOTICE_COPY.<locale>` 에만 있다.
 *
 * 들어가는 값:
 *   - **도메인 이름** — `custom_domains.domain`(DB CHECK: 소문자 LDH · 100자 — 사람이 고른 글자지만 모양이 닫혀 있다). 모노로만 싣는다.
 *   - (2026-10-10 개편부터) 대표 주소를 쓰던 에이전트 목록 · 레코드 이름 · 사유의 자세한 설명은 싣지 않는다 — 콘솔에서 본다. 입력의 `primaryAgents` 는
 *     알림기와의 계약이라 남겨 둔다. 이 메일은 **그 조직의 owner · admin 에게만** 간다(수신자는 DB 정의자 함수 `atmark_claim_domain_notice`).
 *   - 만료 예고의 날 수(`d30` · `d7` — 사건 키에서) · 정지 사유(닫힌 유니온).
 * 문구 구조: 지금 상황(1~2문장) → 할 일(1문장) → 버튼 하나. 과장 금지(copy-guard) — 상태와 할 일만 말한다.
 */

import type { CustomDomainSuspendedReason, DomainNoticeKind } from '../domains/contract';
import type { MailCopyDictionary, MailLocale } from '../i18n/locales';
import { renderMail, type MailInline, type MailLine, type RenderedMail } from './mail-layout';

/** 콘솔의 도메인 화면(상수 — 주입 불가 · 2026-10 콘솔 최상위 경로 — 옛 `#/settings/domains` 는 이리로 넘긴다). 메일 링크 모양(`assertMailLink`)을 지난다. */
export const DOMAIN_SETTINGS_URL = 'https://console.atmark.ai/app#/domains';
/** 본문에 이름을 싣는 에이전트 수 상한 — 나머지는 수로만. */
export const MAX_AGENTS_SHOWN = 5;
/** 에이전트 이름 한 개의 글자 상한. */
export const AGENT_NAME_MAX = 40;

export interface DomainNoticeView {
  readonly kind: DomainNoticeKind;
  readonly domain: string;
  /** `suspended` 만 — 정지 사유(그 밖에는 `null`). */
  readonly suspendedReason: CustomDomainSuspendedReason | null;
  /** `expiry_warning` 만 — 남은 날(30 · 7). */
  readonly daysLeft: number | null;
  /** `verified` 만 — 정지(ownership_lost · dkim_failed)에서 자동 복귀한 회차(사건 키 `recovered:…`). 없으면 첫 확인. */
  readonly recovered?: boolean;
  /** 그 도메인 주소를 대표로 쓰는 에이전트(이름 · 주소). 전체 수는 `primaryAgentCount`. */
  readonly primaryAgents: readonly { readonly name: string; readonly address: string }[];
  readonly primaryAgentCount: number;
}

/**
 * 제어 · 보이지 않는 문자(양방향 제어 포함)를 지우고 공백을 하나로 접고, **링크 · 주소가 살아 있지 않게 끊고**(적대 검증 D2-J029/J030 — 이름은 에이전트가 고를 수
 * 있다: 자가 등록) 자른다. 끊기는 승인 알림(`neutralizeAgentText`)과 같은 규칙이다 — `http` → `hxxp` · `://` → `[:]//` · 글자 사이 `.` → `[.]` · `@` → `[at]`.
 * 모든 알림(도메인 · 격리 · 위험 · 가입 · 자가 등록)이 이 함수로 이름을 싣는다.
 */
export function cleanAgentName(name: string): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex -- 제어 문자를 지우는 것이 목적이다.
    .replace(/[\u0000-\u001f\u007f-\u009f­​-‏‪-‮⁠-⁤⁦-⁩﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(h)tt(p)/giu, '$1xx$2')
    .replace(/:\/\//gu, '[:]//')
    .replace(/(?<=[\p{L}\p{N}])\.(?=[\p{L}\p{N}])/gu, '[.]')
    .replace(/@/gu, '[at]');
  const chars = [...cleaned];
  const cut = chars.length > AGENT_NAME_MAX ? `${chars.slice(0, AGENT_NAME_MAX - 1).join('')}…` : cleaned;
  return cut === '' ? '—' : cut;
}

/** 유효 대표 주소 모양 — 맞으면 본문에 모노로 싣고, 아니면 이름을 끊어서(`cleanAgentName`). 승인 · 감시 알림이 함께 쓴다. */
export const AGENT_ADDRESS_SHAPE = /^[a-z0-9._+-]{1,64}@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * 제목의 짧은 이름 — 모양을 검사한 주소의 로컬파트(`[a-z0-9._+-]` 뿐, 32자까지). 에이전트가 고른 표시 이름은 제목에 싣지 않는다:
 * 수신함 목록 한 줄은 가장 속이기 쉬운 자리다.
 */
export function subjectLocalPart(address: string): string {
  const local = address.slice(0, address.indexOf('@'));
  return local.length > 32 ? `${local.slice(0, 31)}…` : local;
}

const DOMAIN_SHAPE = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** 알림 한 종류의 문구 — 제목 · 본문 한 문단(지금 상황 → 할 일 · 기한). 도메인 이름을 받는다(모노). */
export interface DomainNoticeKindCopy {
  /** 제목 — 호스트 이름이 먼저(긴 이름은 잘라 대략 45자 안). */
  readonly subject: string;
  /** 머리 — 일어난 일(도메인 이름은 본문 첫 문장에). */
  readonly heading: string;
  /** 숨은 미리보기 — 종류마다 본문에 없는 사실 하나. */
  readonly preheader: string;
  readonly body: (domain: MailInline) => MailLine;
}

export interface DomainNoticeCopy {
  /** 종류 · 사유별 문구 — 닫힌 유니온을 받는다. */
  readonly notice: (view: DomainNoticeView) => DomainNoticeKindCopy;
  readonly buttonLabel: string;
}

// ===========================================================================
// ✎ 도메인 알림 문구 — 문구 작성자가 고치는 곳(종류 · 사유 분기는 `notice` 안에 있다). `?` 를 쓰지 않는다.
//   2026-10-10 개편: 한 문단 — 지금 상황 → 할 일(기한은 남긴다). 확인 방식 · 레코드 이름 · 에이전트 목록은 콘솔에.
//   콘솔과 같은 낱말 — "소유 확인"(소유 증명 아님) · 발신은 "stopped"(paused 아님). 한국어는 "<도메인> 도메인" 으로 써 조사가 이름에 붙지 않게.
// ===========================================================================

/** 제목에 싣는 호스트 이름 — 24자를 넘으면 앞 23자 + "…"(제목이 대략 45자 안에 들게). 모양은 렌더 함수가 이미 봤다. */
function subjectHost(domain: string): string {
  return domain.length > 24 ? `${domain.slice(0, 23)}…` : domain;
}

function koNotice(view: DomainNoticeView): DomainNoticeKindCopy {
  const days = String(view.daysLeft ?? 0);
  const h = subjectHost(view.domain);
  switch (view.kind) {
    case 'suspended':
      switch (view.suspendedReason) {
        case 'ownership_lost':
          return {
            subject: `${h} 정지: 소유 확인 실패`,
            heading: '도메인을 정지했습니다',
            preheader: '지금은 이 도메인으로 메일을 주고받을 수 없습니다.',
            body: (d) => [d, ' 도메인의 소유를 확인하지 못해 정지했습니다. 14일 안에 콘솔에서 DNS 설정을 고치지 않으면 도메인이 제거됩니다.'],
          };
        case 'dkim_failed':
          return {
            subject: `${h} 정지: DNS 설정 확인 필요`,
            heading: '도메인을 정지했습니다',
            preheader: '지금은 이 도메인으로 메일을 보낼 수 없습니다.',
            body: (d) => [d, ' 도메인의 발신 설정을 확인하지 못해 정지했습니다. 콘솔에서 DNS 설정을 고쳐 주세요.'],
          };
        case 'reputation':
          return {
            subject: `${h} 발신 중지`,
            heading: '발신을 멈췄습니다',
            preheader: '받는 메일은 그대로 받습니다.',
            body: (d) => [d, ' 도메인에서 보낸 메일의 반송과 스팸 신고가 많아 발신을 멈췄습니다. 다시 열려면 support@atmark.ai로 문의해 주세요.'],
          };
        case 'operator':
          return {
            subject: `${h} 발신 중지`,
            heading: '발신을 멈췄습니다',
            preheader: '받는 메일은 그대로 받습니다.',
            body: (d) => ['Atmark 운영팀이 ', d, ' 도메인의 발신을 멈췄습니다. 자세한 내용은 support@atmark.ai로 문의해 주세요.'],
          };
        case 'plan_limit':
        case null:
          return {
            subject: `${h} 발신 중지: 요금제 한도`,
            heading: '발신을 멈췄습니다',
            preheader: '받는 메일은 그대로 받습니다.',
            body: (d) => ['요금제에서 쓸 수 있는 도메인 수를 넘어 ', d, ' 도메인의 발신을 멈췄습니다. 콘솔에서 요금제를 바꾸거나 다른 도메인을 제거해 주세요.'],
          };
      }
      break;
    case 'removal_d3':
      return {
        subject: `${h} 3일 뒤 제거`,
        heading: '3일 뒤 도메인이 제거됩니다',
        preheader: '제거되면 도메인을 처음부터 다시 추가해야 합니다.',
        body: (d) => [d, ' 도메인의 소유를 아직 확인하지 못해 3일 뒤 제거됩니다. 계속 쓰려면 콘솔에서 DNS 설정을 고쳐 주세요.'],
      };
    case 'removed':
      return {
        subject: `${h} 제거됨`,
        heading: '도메인이 제거되었습니다',
        preheader: '다시 쓰려면 도메인을 처음부터 추가해 주세요.',
        body: (d) => [d, ' 도메인이 제거되어 이 주소로는 메일을 주고받을 수 없습니다. 콘솔에서 해당 에이전트의 주소를 새로 골라 주세요.'],
      };
    case 'verified':
      if (view.recovered === true) {
        // 복귀 — ownership_lost 복귀는 DKIM 성공을 조건으로 하지 않으므로 "DKIM 을 확인했다" 고 말하지 않는다(리뷰 LOW).
        return {
          subject: `${h} 다시 사용 가능`,
          heading: '도메인을 다시 쓸 수 있습니다',
          preheader: '메일을 다시 주고받을 수 있습니다.',
          body: (d) => [d, ' 도메인이 다시 확인되어 다시 쓸 수 있습니다. 필요한 주소는 콘솔에서 다시 만들어 주세요.'],
        };
      }
      return {
        subject: `${h} 확인 완료`,
        heading: '도메인 확인이 끝났습니다',
        preheader: '이제 에이전트 주소를 만들 수 있습니다.',
        body: (d) => [d, ' 도메인 확인이 끝나 바로 쓸 수 있습니다.'],
      };
    case 'expiry_warning':
      return {
        subject: `${h} 등록 약 ${days}일 뒤 만료`,
        heading: '도메인 등록 만료 예정',
        preheader: '갱신하면 주소를 그대로 쓸 수 있습니다.',
        body: (d) => [d, ` 도메인 등록이 약 ${days}일 뒤 만료됩니다. 정지되지 않도록 도메인 등록 업체에서 갱신해 주세요.`],
      };
  }
  throw new Error(`알 수 없는 알림 종류: ${String(view.kind)}`);
}

function enNotice(view: DomainNoticeView): DomainNoticeKindCopy {
  const days = String(view.daysLeft ?? 0);
  const h = subjectHost(view.domain);
  switch (view.kind) {
    case 'suspended':
      switch (view.suspendedReason) {
        case 'ownership_lost':
          return {
            subject: `${h} suspended: ownership check failed`,
            heading: 'Domain suspended',
            preheader: "Its addresses can't send or receive mail right now.",
            body: (d) => ["We couldn't confirm you own ", d, ", so it's suspended. Fix its DNS settings in the console within 14 days or it will be removed."],
          };
        case 'dkim_failed':
          return {
            subject: `${h} suspended: DNS settings need a fix`,
            heading: 'Domain suspended',
            preheader: "Its addresses can't send mail right now.",
            body: (d) => ["We couldn't confirm the sending settings for ", d, ", so it's suspended. Fix its DNS settings in the console."],
          };
        case 'reputation':
          return {
            subject: `${h}: sending stopped`,
            heading: 'Sending stopped',
            preheader: 'Incoming mail still arrives.',
            body: (d) => ['Too many emails from ', d, ' bounced or were marked as spam, so we stopped sending from it. Contact support@atmark.ai to reopen it.'],
          };
        case 'operator':
          return {
            subject: `${h}: sending stopped`,
            heading: 'Sending stopped',
            preheader: 'Incoming mail still arrives.',
            body: (d) => ['The Atmark team stopped sending from ', d, '. Contact support@atmark.ai for details.'],
          };
        case 'plan_limit':
        case null:
          return {
            subject: `${h}: sending stopped (plan limit)`,
            heading: 'Sending stopped',
            preheader: 'Incoming mail still arrives.',
            body: (d) => ['Your plan now allows fewer domains, so we stopped sending from ', d, '. Change your plan or remove a domain in the console.'],
          };
      }
      break;
    case 'removal_d3':
      return {
        subject: `${h} will be removed in 3 days`,
        heading: 'Domain removal in 3 days',
        preheader: "After removal, you'll need to add the domain again from the start.",
        body: (d) => ["We still can't confirm you own ", d, ', so it will be removed in 3 days. Fix its DNS settings in the console to keep it.'],
      };
    case 'removed':
      return {
        subject: `${h} was removed`,
        heading: 'Domain removed',
        preheader: 'To use it again, add the domain from the start.',
        body: (d) => [d, ' was removed, so its addresses no longer send or receive mail. Choose new addresses for the affected agents in the console.'],
      };
    case 'verified':
      if (view.recovered === true) {
        return {
          subject: `${h} can be used again`,
          heading: 'Domain back in use',
          preheader: 'Sending and receiving work again.',
          body: (d) => [d, ' passed its check and can be used again. Create the addresses you need again in the console.'],
        };
      }
      return {
        subject: `${h} is verified`,
        heading: 'Domain verified',
        preheader: "Create agent addresses on it now.",
        body: (d) => [d, ' is verified and ready to use.'],
      };
    case 'expiry_warning':
      return {
        subject: `${h} expires in about ${days} days`,
        heading: 'Registration expiring',
        preheader: 'Renewing keeps every address working.',
        body: (d) => ['The registration for ', d, ` expires in about ${days} days. Renew it with your domain registrar so it isn't suspended.`],
      };
  }
  throw new Error(`unknown notice kind: ${String(view.kind)}`);
}

export const DOMAIN_NOTICE_COPY: MailCopyDictionary<DomainNoticeCopy> = {
  en: {
    notice: enNotice,
    buttonLabel: 'Open domain settings',
  },
  ko: {
    notice: koNotice,
    buttonLabel: '도메인 설정 열기',
  },
};

// ===========================================================================

/**
 * 도메인 알림 한 통 — 한 언어. 링크는 콘솔 도메인 설정 하나. 대표 주소를 쓰던 에이전트 목록(`primaryAgents`)은 2026-10-10 개편부터 본문에 싣지 않는다
 * (자세한 내용은 콘솔) — 입력 모양은 알림기와의 계약이라 그대로 둔다.
 */
export function renderDomainNotice(view: DomainNoticeView, locale: MailLocale): RenderedMail {
  if (!DOMAIN_SHAPE.test(view.domain) || view.domain.length > 100) throw new Error('도메인 모양이 아니다');
  const copy = DOMAIN_NOTICE_COPY[locale];
  const notice = copy.notice(view);
  return renderMail({
    subject: notice.subject,
    preheader: notice.preheader,
    link: DOMAIN_SETTINGS_URL,
    section: {
      lang: locale,
      lead: [notice.heading],
      paragraphs: [[notice.body({ mono: view.domain })]],
      buttonLabel: copy.buttonLabel,
      notes: [],
    },
  });
}
