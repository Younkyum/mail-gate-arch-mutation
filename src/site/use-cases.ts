/**
 * src/site/use-cases.ts — `GET /use-cases`(영어)·`GET /kr/use-cases`(한국어) 사용 예시(2026-10-01).
 *
 * 여섯 가지 쓰임새를 순서대로(진윤겸 — 순서 고정, 실제 사용 여부를 표시하지 않는다 · 인용 없음): 상황 한 줄 · 흐름 그림 · 쓰는 기능(칩 2–3) ·
 * 문서의 시작 링크. 맨 아래 "Atmark로 하면 안 되는 일" 링크, 끝에 대기자 명단 CTA 하나. 홈의 작동 방식 절은 앞의 셋을 작은 카드로 싣는다(`homeUseCaseCards`).
 *
 * 흐름 그림은 **코드로 그리는 인라인 SVG**(블로그 그림 `src/site/blog/figures/*.svg` 와 같은 모양 — 1.5 선 · 둥근 상자 · 바깥은 점선 · 에이전트는
 * 잉크 면). 색은 `currentColor` 와 그림 클래스(`.fig-svg .ink` 등, `styles.ts`)뿐 — CSP 를 지킨다(style 속성·스크립트 없음). 넓은 화면은 가로,
 * 좁은 화면(640px 미만)은 세로 그림을 보인다(둘 다 aria-hidden — 이름은 감싼 칸의 `aria-label` 한 줄).
 *
 * 문구 규칙: 제품이 지금 하는 일만 · 시간 약속 없음 · copy-guard 금지어 없음(`test/support/copy-guard.ts`). 예시 주소는 예시 예약 이름(scout ·
 * research · help-desk · ops-pager · invoices — `src/identity/address.ts` `EXAMPLE_RESERVED_LOCAL_PARTS`)과 `*.example` 뿐이다.
 */

import { docsUrl, type SiteLang } from './constants';
import { ARROW_RIGHT_ICON, buildSitePage, esc, sitePath, type SitePage } from './page';

type NodeKind = 'ext' | 'agent' | 'you' | 'out';

interface FlowNode {
  readonly kind: NodeKind;
  readonly label: Readonly<Record<SiteLang, string>>;
  readonly sub?: Readonly<Record<SiteLang, string>>;
}

export interface UseCase {
  /** 페이지 안 앵커(`/use-cases#<id>`). */
  readonly id: string;
  readonly title: Readonly<Record<SiteLang, string>>;
  /** 상황 한 줄(페이지). */
  readonly situation: Readonly<Record<SiteLang, string>>;
  /** 더 짧은 한 줄(홈 카드 — 앞의 셋만). */
  readonly short?: Readonly<Record<SiteLang, string>>;
  readonly features: readonly Readonly<Record<SiteLang, string>>[];
  /** 문서 경로(언어 접두어 뒤) + 앵커. 앵커는 언어마다 다를 수 있다. */
  readonly docs: Readonly<Record<SiteLang, string>>;
  readonly flow: readonly FlowNode[];
}

const same = (v: string): Readonly<Record<SiteLang, string>> => ({ en: v, ko: v });

const F = {
  receiving: { en: 'Receiving', ko: '수신' },
  allowlist: { en: 'Send allowlist', ko: '발신 허용 목록' },
  scheduled: { en: 'Scheduled send', ko: '예약 발송' },
  replies: { en: 'Replies', ko: '답장' },
  webhooks: { en: 'Webhooks', ko: '웹훅' },
  attachments: { en: 'Received attachments', ko: '받은 첨부' },
  codes: { en: 'Verification codes', ko: '인증 코드' },
} as const;

const YOU: FlowNode = { kind: 'you', label: { en: 'Your inbox', ko: '내 메일함' }, sub: same('you@example.com') };

/** 여섯 가지 — 이 순서 그대로(진윤겸). 여섯째(가입)는 맨 뒤 · 담담하게(계획: 인증 코드를 앞세우지 않는다). */
export const USE_CASES: readonly UseCase[] = [
  {
    id: 'newsletter',
    title: { en: 'Your own daily newsletter', ko: '나만의 뉴스레터' },
    situation: {
      en: 'The agent gathers its sources, including newsletters it subscribes to at its own address, and writes you a personal newsletter every day.',
      ko: '에이전트가 자기 주소로 구독한 뉴스레터를 포함해 여러 출처를 모으고, 매일 나만을 위한 뉴스레터를 써서 보냅니다.',
    },
    short: { en: 'It reads its sources and writes you a newsletter every day.', ko: '출처를 읽고 매일 나만의 뉴스레터를 써 보냅니다.' },
    features: [F.receiving, F.allowlist, F.scheduled],
    docs: same('email/scheduled'),
    flow: [
      { kind: 'ext', label: { en: 'Sources', ko: '출처' }, sub: { en: 'feeds, newsletters', ko: '피드 · 뉴스레터' } },
      { kind: 'agent', label: { en: 'Agent', ko: '에이전트' }, sub: same('scout@atmark.ai') },
      { kind: 'out', label: { en: 'Daily issue', ko: '오늘의 호' }, sub: { en: 'written by the agent', ko: '에이전트가 쓴 글' } },
      { ...YOU, sub: { en: 'on its send allowlist', ko: '발신 허용 목록에 있음' } },
    ],
  },
  {
    id: 'digest',
    title: { en: 'Newsletter digest', ko: '뉴스레터 요약' },
    situation: {
      en: "Subscribe to newsletters with the agent's address. It reads them each day and sends you the highlights, so your own inbox stays clean.",
      ko: '뉴스레터를 에이전트 주소로 구독하세요. 에이전트가 매일 읽고 핵심만 추려 보내니, 내 메일함은 깨끗하게 남습니다.',
    },
    short: { en: 'Newsletters go to the agent. You get the highlights.', ko: '뉴스레터는 에이전트가 받고, 나는 핵심만 받습니다.' },
    features: [F.receiving, F.allowlist],
    docs: { en: 'email/receiving#modes', ko: 'email/receiving#modes' },
    flow: [
      { kind: 'ext', label: { en: 'Newsletters', ko: '뉴스레터' }, sub: { en: 'you subscribed', ko: '구독한 것' } },
      { kind: 'agent', label: { en: 'Agent address', ko: '에이전트 주소' }, sub: same('research@atmark.ai') },
      { kind: 'out', label: { en: 'Reads them', ko: '읽고 추림' }, sub: { en: 'picks the highlights', ko: '핵심만' } },
      { ...YOU, label: { en: 'Digest to you', ko: '나에게 요약' } },
    ],
  },
  {
    id: 'support',
    title: { en: 'First pass on a support inbox', ko: '지원 메일함 1차 응대' },
    situation: {
      en: "Mail to your support address lands in the agent's inbox. The agent reads and sorts it and drafts replies. It replies only to people on its send allowlist.",
      ko: '지원 주소로 온 메일이 에이전트 메일함에 들어옵니다. 에이전트가 읽고 분류해 답장 초안을 쓰고, 발신 허용 목록에 넣은 사람에게만 답장합니다.',
    },
    short: { en: 'It sorts support mail and drafts the replies.', ko: '지원 메일을 분류하고 답장 초안을 씁니다.' },
    features: [F.receiving, F.replies, F.allowlist],
    docs: same('email/allow-block-lists'),
    flow: [
      { kind: 'ext', label: { en: 'Customer', ko: '고객' }, sub: same('maya@acme.example') },
      { kind: 'ext', label: { en: 'Support address', ko: '지원 주소' }, sub: { en: 'forwards to the agent', ko: '에이전트로 전달' } },
      { kind: 'agent', label: { en: 'Agent', ko: '에이전트' }, sub: same('help-desk@atmark.ai') },
      { kind: 'out', label: { en: 'Draft or reply', ko: '초안 · 답장' }, sub: { en: 'allowlisted only', ko: '허용 목록에만' } },
    ],
  },
  {
    id: 'alerts',
    title: { en: 'Handle service alerts', ko: '서비스 알림 처리' },
    situation: {
      en: "Billing failures, failed deploys and monitoring alerts go to the agent's address. The agent looks into each one and reports to you or opens an issue. A webhook can notify your system when mail arrives.",
      ko: '결제 실패, 배포 실패, 모니터링 알림이 에이전트 주소로 옵니다. 에이전트가 하나씩 살펴보고 나에게 보고하거나 이슈를 엽니다. 메일이 오면 웹훅으로 내 시스템에 알릴 수도 있습니다.',
    },
    features: [F.receiving, F.webhooks, F.allowlist],
    docs: same('get-started/quickstart#route-an-alert'),
    flow: [
      { kind: 'ext', label: { en: 'Services', ko: '서비스' }, sub: { en: 'billing, CI, monitoring', ko: '결제 · CI · 모니터링' } },
      { kind: 'agent', label: { en: 'Agent', ko: '에이전트' }, sub: same('ops-pager@atmark.ai') },
      { kind: 'out', label: { en: 'Looks into it', ko: '살펴봄' }, sub: { en: 'webhook to your system', ko: '웹훅으로 알림' } },
      { ...YOU, label: { en: 'Report or issue', ko: '보고 · 이슈' }, sub: { en: 'to you or your tracker', ko: '나 또는 이슈 트래커' } },
    ],
  },
  {
    id: 'receipts',
    title: { en: 'Sort receipts and invoices', ko: '영수증·청구서 정리' },
    situation: {
      en: "Receipts and invoices go to the agent's address. It reads the attachments, puts the amount, date and vendor in a table, and sends you a summary at the end of each month.",
      ko: '영수증과 청구서를 에이전트 주소로 받습니다. 에이전트가 첨부를 읽어 금액·날짜·거래처를 표로 정리하고, 월말마다 요약을 보냅니다.',
    },
    features: [F.attachments, F.scheduled, F.allowlist],
    docs: { en: 'email/receiving#received-attachments', ko: 'email/receiving#받은-첨부-파일' },
    flow: [
      { kind: 'ext', label: { en: 'Vendors', ko: '거래처' }, sub: { en: 'receipts, invoices', ko: '영수증 · 청구서' } },
      { kind: 'agent', label: { en: 'Agent', ko: '에이전트' }, sub: same('invoices@atmark.ai') },
      { kind: 'out', label: { en: 'Table', ko: '표' }, sub: { en: 'amount, date, vendor', ko: '금액 · 날짜 · 거래처' } },
      { ...YOU, label: { en: 'Monthly summary', ko: '월말 요약' } },
    ],
  },
  {
    id: 'sign-ups',
    title: { en: 'Sign up for the tools your agent uses', ko: '에이전트 전용 계정 가입' },
    situation: {
      en: "The agent signs up with its own address and reads the verification mail itself, so your address isn't spread around.",
      ko: '에이전트가 자기 주소로 가입하고 인증 메일도 직접 읽습니다. 내 주소가 여기저기 퍼지지 않습니다.',
    },
    features: [F.receiving, F.codes],
    docs: same('email/verification-codes'),
    flow: [
      { kind: 'ext', label: { en: 'Sign-up form', ko: '가입 양식' }, sub: { en: 'a tool the agent uses', ko: '에이전트가 쓰는 도구' } },
      { kind: 'ext', label: { en: 'Verification mail', ko: '인증 메일' }, sub: { en: 'sent by the tool', ko: '도구가 보냄' } },
      { kind: 'agent', label: { en: 'Agent', ko: '에이전트' }, sub: same('scout@atmark.ai') },
      { kind: 'out', label: { en: 'Account ready', ko: '계정 준비' }, sub: { en: 'your address stays out', ko: '내 주소는 쓰지 않음' } },
    ],
  },
];

/** 페이지 문구(언어별 — 키 집합이 같다, 테스트). */
export const USE_CASES_COPY: Readonly<Record<SiteLang, Readonly<Record<string, string>>>> = {
  en: {
    title: 'Use cases: what an agent does with its own address | Atmark',
    description:
      "Six ways to put an agent's own email address to work: a daily newsletter, newsletter digests, a support inbox, service alerts, receipts and tool sign-ups.",
    h1: 'What an agent does with its own address',
    lede: 'Six setups. In each one the agent receives at its own address and writes only to people on its send allowlist.',
    flow: 'Flow',
    features: 'Features used',
    go: 'Get started',
    notFor: 'What Atmark is not for',
    notForLead: 'Every agent sends from the same domain.',
    ctaTitle: 'Create your first agent email.',
    waitlist: 'Join the waitlist',
    homeTitle: 'What agents use their address for',
    homeAll: 'See all six use cases',
  },
  ko: {
    title: '사용 예시: 에이전트 주소로 하는 일 | Atmark',
    description: '에이전트 주소로 하는 여섯 가지 일. 나만의 뉴스레터, 뉴스레터 요약, 지원 메일함, 서비스 알림, 영수증 정리, 도구 가입.',
    h1: '에이전트 주소로 하는 일',
    lede: '여섯 가지 쓰임새. 모두 에이전트가 자기 주소로 받고, 발신 허용 목록에 있는 사람에게만 보냅니다.',
    flow: '흐름',
    features: '쓰는 기능',
    go: '시작하기',
    notFor: 'Atmark로 하면 안 되는 일',
    notForLead: '모든 에이전트가 한 도메인으로 보냅니다.',
    ctaTitle: '첫 에이전트 이메일을 만들어 보세요.',
    waitlist: '대기자 명단',
    homeTitle: '에이전트 주소로 하는 일',
    homeAll: '사용 예시 여섯 가지 보기',
  },
};

// ── 흐름 그림 ────────────────────────────────────────────────────────────

/** 상자 하나 — 바깥(점선) · 에이전트(잉크 면 · 바탕색 글자) · 나(카드 면 · 굵은 선) · 결과(선). */
function nodeBox(n: FlowNode, lang: SiteLang, x: number, y: number, w: number, h: number): string {
  const cx = x + w / 2;
  const rect =
    n.kind === 'agent'
      ? `<rect x="${String(x)}" y="${String(y)}" width="${String(w)}" height="${String(h)}" rx="8" class="ink"/>`
      : n.kind === 'you'
        ? `<rect x="${String(x)}" y="${String(y)}" width="${String(w)}" height="${String(h)}" rx="8" class="paper" stroke="currentColor" stroke-width="2"/>`
        : `<rect x="${String(x)}" y="${String(y)}" width="${String(w)}" height="${String(h)}" rx="8" fill="none" stroke="currentColor" stroke-width="1.5"${n.kind === 'ext' ? ' class="dash"' : ''}/>`;
  const ink = n.kind === 'agent' ? ' inv' : '';
  const sub = n.sub === undefined ? '' : `<text x="${String(cx)}" y="${String(y + h / 2 + 15)}" class="small mid${n.kind === 'agent' ? ' inv' : ''}">${esc(n.sub[lang])}</text>`;
  const labelY = n.sub === undefined ? y + h / 2 + 5 : y + h / 2 - 3;
  return `${rect}<text x="${String(cx)}" y="${String(labelY)}" class="label bold mid${ink}">${esc(n.label[lang])}</text>${sub}`;
}

const arrowH = (x1: number, x2: number, y: number): string =>
  `<line x1="${String(x1)}" y1="${String(y)}" x2="${String(x2 - 2)}" y2="${String(y)}" stroke="currentColor" stroke-width="1.5"/>` +
  `<path d="M${String(x2 - 7)} ${String(y - 4.5)} L${String(x2)} ${String(y)} L${String(x2 - 7)} ${String(y + 4.5)}" fill="none" stroke="currentColor" stroke-width="1.5"/>`;

const arrowV = (x: number, y1: number, y2: number): string =>
  `<line x1="${String(x)}" y1="${String(y1)}" x2="${String(x)}" y2="${String(y2 - 2)}" stroke="currentColor" stroke-width="1.5"/>` +
  `<path d="M${String(x - 4.5)} ${String(y2 - 7)} L${String(x)} ${String(y2)} L${String(x + 4.5)} ${String(y2 - 7)}" fill="none" stroke="currentColor" stroke-width="1.5"/>`;

/** 가로 그림(넓은 화면) — 560 × 104(본문 칸에서 글자가 실제 13px 가까이 보이는 폭). 상자는 같은 폭, 사이 화살표. */
function flowHorizontal(flow: readonly FlowNode[], lang: SiteLang): string {
  const W = 560;
  const gap = 28;
  const h = 64;
  const y = 20;
  const w = (W - gap * (flow.length - 1)) / flow.length;
  const parts = flow.map((n, i) => {
    const x = i * (w + gap);
    return nodeBox(n, lang, x, y, w, h) + (i < flow.length - 1 ? arrowH(x + w + 4, x + w + gap - 4, y + h / 2) : '');
  });
  return `<svg class="fig-svg fh" viewBox="-1 0 ${String(W + 2)} 104" width="${String(W)}" height="104" aria-hidden="true" focusable="false">${parts.join('')}</svg>`;
}

/** 세로 그림(좁은 화면) — 폭 300. */
function flowVertical(flow: readonly FlowNode[], lang: SiteLang): string {
  const W = 300;
  const h = 54;
  const gap = 26;
  const H = flow.length * h + (flow.length - 1) * gap + 2;
  const parts = flow.map((n, i) => {
    const y = 1 + i * (h + gap);
    return nodeBox(n, lang, 1, y, W - 2, h) + (i < flow.length - 1 ? arrowV(W / 2, y + h + 4, y + h + gap - 4) : '');
  });
  return `<svg class="fig-svg fv" viewBox="0 0 ${String(W)} ${String(H)}" width="${String(W)}" height="${String(H)}" aria-hidden="true" focusable="false">${parts.join('')}</svg>`;
}

/** 흐름의 한 줄 이름(보조기술) — "출처 → 에이전트(scout@atmark.ai) → …". */
export function flowLabel(flow: readonly FlowNode[], lang: SiteLang): string {
  return flow.map((n) => (n.sub === undefined ? n.label[lang] : `${n.label[lang]} (${n.sub[lang]})`)).join(' → ');
}

function flowFigure(uc: UseCase, lang: SiteLang): string {
  return (
    `<figure class="case-fig"><div class="flow" role="img" aria-label="${esc(`${USE_CASES_COPY[lang]['flow'] ?? ''}: ${flowLabel(uc.flow, lang)}`)}">` +
    flowHorizontal(uc.flow, lang) +
    flowVertical(uc.flow, lang) +
    '</div></figure>'
  );
}

export function useCaseDocsHref(uc: UseCase, lang: SiteLang): string {
  return `${docsUrl(lang)}/${uc.docs[lang]}`;
}

// ── 페이지 ──────────────────────────────────────────────────────────────

function caseItem(uc: UseCase, lang: SiteLang): string {
  const c = USE_CASES_COPY[lang];
  return (
    `<li class="case" id="${uc.id}">` +
    '<div class="case-copy">' +
    `<h2>${esc(uc.title[lang])}</h2>` +
    `<p class="case-sit">${esc(uc.situation[lang])}</p>` +
    `<ul class="chips" aria-label="${c['features'] ?? ''}">${uc.features.map((f) => `<li>${f[lang]}</li>`).join('')}</ul>` +
    `<p class="case-go"><a href="${useCaseDocsHref(uc, lang)}">${c['go'] ?? ''} ${ARROW_RIGHT_ICON}</a></p>` +
    '</div>' +
    flowFigure(uc, lang) +
    '</li>'
  );
}

function useCasesPage(lang: SiteLang): SitePage {
  const c = USE_CASES_COPY[lang];
  const main =
    '<div class="wrap uc">' +
    '<header class="uc-head">' +
    `<h1>${c['h1'] ?? ''}</h1>` +
    `<p class="lede">${c['lede'] ?? ''}</p>` +
    '</header>' +
    `<ol class="cases">${USE_CASES.map((uc) => caseItem(uc, lang)).join('')}</ol>` +
    `<p class="uc-not">${c['notForLead'] ?? ''} <a href="${docsUrl(lang)}/get-started/not-for">${c['notFor'] ?? ''}</a></p>` +
    '</div>' +
    '<section class="cta blog-cta" aria-labelledby="start-title"><div class="cta-card">' +
    `<h2 id="start-title">${c['ctaTitle'] ?? ''}</h2>` +
    `<div class="actions center"><a class="btn" href="${sitePath(lang, 'waitlist')}">${c['waitlist'] ?? ''} ${ARROW_RIGHT_ICON}</a></div>` +
    '</div></section>';
  return buildSitePage({ lang, id: 'use-cases', title: c['title'] ?? '', description: c['description'] ?? '', main });
}

export const USE_CASES_PAGES: Readonly<Record<SiteLang, SitePage>> = { ko: useCasesPage('ko'), en: useCasesPage('en') };

// ── 홈 카드(작동 방식 절 — 앞의 셋) ──────────────────────────────────────

/** 카드의 흐름 이름표 — 처음 · 에이전트 · 끝 셋만(작은 카드에서 줄이 넘치지 않게). */
function miniFlow(flow: readonly FlowNode[]): readonly FlowNode[] {
  const first = flow[0];
  const agent = flow.find((n) => n.kind === 'agent');
  const last = flow[flow.length - 1];
  return [first, agent, last].filter((n, i, all): n is FlowNode => n !== undefined && all.indexOf(n) === i);
}

/** 홈의 작은 카드 줄 — 앞의 세 쓰임새(제목 · 짧은 한 줄 · 흐름 이름표) + "여섯 가지 보기". 카드 전체가 페이지의 그 절로 가는 링크다. */
export function homeUseCaseCards(lang: SiteLang): string {
  const c = USE_CASES_COPY[lang];
  const card = (uc: UseCase): string =>
    `<li><a class="ucard" href="${sitePath(lang, 'use-cases')}#${uc.id}">` +
    `<span class="ucard-t">${esc(uc.title[lang])}</span>` +
    `<span class="ucard-d">${esc(uc.short?.[lang] ?? uc.situation[lang])}</span>` +
    `<span class="ucard-f" aria-hidden="true">${miniFlow(uc.flow).map((n) => `<span>${esc(n.label[lang])}</span>`).join(ARROW_RIGHT_ICON)}</span>` +
    '</a></li>';
  return (
    '<div class="uc-row">' +
    '<div class="uc-row-h">' +
    `<h3 id="uses-title">${c['homeTitle'] ?? ''}</h3>` +
    `<a class="uc-all" href="${sitePath(lang, 'use-cases')}">${c['homeAll'] ?? ''} ${ARROW_RIGHT_ICON}</a>` +
    '</div>' +
    `<ul class="ucards">${USE_CASES.slice(0, 3).map(card).join('')}</ul>` +
    '</div>'
  );
}
