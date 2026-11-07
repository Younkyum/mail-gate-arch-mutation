/**
 * src/site/pricing.ts — `GET /pricing`(한국어)·`GET /en/pricing`(영어) 요금제와 한도.
 *
 * Paddle 운영 계정의 웹사이트 심사는 가격 페이지와 환불 정책 URL 이 실제로 열려 있기를 요구한다. 이 페이지가 그 가격 페이지다.
 *
 * 숫자의 출처는 둘이다. **한도는 코드 카탈로그**(`src/billing/plans.ts` 의 `PLAN_CATALOG`·`ENTITLEMENT_CEILINGS`)를 렌더할 때 그대로 읽는다 —
 * 정책 관문이 실제로 거는 값과 이 표가 어긋날 수 없다. 카탈로그는 import 가 없는 값 파일이라 홈 번들 경계(`site-bundle.test.ts`)를 넓히지
 * 않는다. **가격은 `PLAN_MONTHLY_PRICE_USD`**(`constants.ts`) — 카탈로그는 금액을 모른다.
 *
 * 문구 규칙: 제품이 지금 하는 일만 적는다. Paddle 의 AUP 심사 대상이므로 과장·순위 표시("인기" 등)·아웃리치 뉘앙스를 쓰지 않는다
 * (`pricing.test.ts` 가 금지어를 건다). Beta 는 결제로도 가입으로도 받는 요금제가 아니다 — 운영자가 초대한 조직에 직접 부여한다(2026-09-30 부터 가입은 바로 Free, `BETA_ON_ACTIVATION` 꺼짐).
 * 외부 링크는 없다 — 업그레이드 안내의 로그인 링크도 이 사이트의 `/login` 이다(콘솔로 가는 링크 금지, `site-pages.test.ts` ④).
 */

import { ENTITLEMENT_CEILINGS, MIB, PLAN_CATALOG, PLAN_CODES, type EntitlementLimits, type PlanCode } from '../billing/plans';
import { PLAN_MONTHLY_PRICE_USD, REFUND_POLICY_APPROVED, SITE_ORIGIN, type SiteLang } from './constants';
import { buildSitePage, CHROME_COPY, sitePath, type SitePage } from './page';
import { softwareNode, type OfferEntry } from './seo';

/** 표에 싣는 한도 — 정책 관문·콘솔이 적용하는 칸만. 수신 저장 용량은 아직 표시만 하는 값이라(ADR-0011 §미룬 것) 약속처럼 보이지 않게 뺀다. */
export const PRICING_LIMIT_ROWS: readonly (keyof EntitlementLimits)[] = [
  'maxAgents',
  'orgDailyRecipients',
  'agentPerDayMax',
  'recipientsPerMessageMax',
  'tokensPerAgentMax',
  'webhookEndpointsPerAgentMax',
  'orgApiKeysMax',
  // 메일 기본기 2차(ADR-0013 D6) — 별칭은 콘솔 연산이, 첨부 총량은 Stage 6 이 적용한다.
  'aliasesPerAgentMax',
  'attachmentBytesTotalMax',
];

/** 바이트 단위 칸 — 표에 "N MB" 로 쓴다(MiB 기준, 정책 기본값 10 MiB 를 "10 MB" 로 적는 관례와 같다). */
const MIB_ROWS: ReadonlySet<keyof EntitlementLimits> = new Set(['attachmentBytesTotalMax']);

/** 표 한 칸의 글자 — 개수는 천 단위 쉼표, 바이트 칸은 MB. */
export function limitCell(key: keyof EntitlementLimits, value: number): string {
  return MIB_ROWS.has(key) ? `${groupDigits(Math.floor(value / MIB))} MB` : groupDigits(value);
}

/** 요금제 이름 — 두 언어 모두 영어 이름을 쓴다(콘솔·영수증과 같은 이름). */
const PLAN_NAMES: Readonly<Record<PlanCode, string>> = { free: 'Free', beta: 'Beta', pro: 'Pro', team: 'Team', scale: 'Scale' };

type Copy = Readonly<Record<string, string>>;

/** 문구 사전. 값은 정적 마크업 조각(코드 상수 — 사용자 입력 없음). 두 언어의 키 집합이 같다(테스트). */
const COPY: Readonly<Record<SiteLang, Copy>> = {
  ko: {
    title: '요금제와 한도: Free부터 Scale까지 | Atmark',
    description: 'Atmark 요금제(Free · Beta · Pro · Team · Scale)의 월 가격과 한도. 표의 한도는 서비스가 실제로 적용하는 값입니다.',
    h1: '요금제',
    lede: '요금제에 따라 달라지는 건 한도뿐입니다. 아래 숫자는 서비스에 실제로 적용되는 값입니다.',
    plansLabel: '다섯 가지 요금제',
    per: '/월',
    agents: '에이전트 {n}개',
    freeHow: '가입하면 바로 이 요금제로 시작합니다.',
    betaPrice: '베타 기간 무료',
    betaWho: '운영자 초대 조직',
    paidHow: '매월 결제합니다. 콘솔에서 시작합니다.',
    limitsTitle: '한도 비교',
    limitCol: '한도',
    maxAgents: '에이전트 수',
    orgDailyRecipients: '조직 하루 수신자',
    agentPerDayMax: '에이전트 하루 발송',
    recipientsPerMessageMax: '메일당 수신자',
    tokensPerAgentMax: '에이전트당 토큰',
    webhookEndpointsPerAgentMax: '에이전트당 웹훅',
    orgApiKeysMax: '조직 API 키',
    aliasesPerAgentMax: '에이전트당 별칭 주소',
    attachmentBytesTotalMax: '메일당 첨부 용량',
    ceiling: '요금제로도 넘을 수 없는 상한: 조직 하루 {daily}명, 메일당 {perMessage}명.',
    warmup: '조직 하루 수신자는 첫 발송 뒤 약 2주에 걸쳐 표의 값까지 오릅니다.',
    notesTitle: '결제와 변경',
    upgradeTerm: '요금제 바꾸기',
    upgrade: '콘솔의 설정 &rsaquo; 요금제에서 바꿉니다.',
    login: '콘솔 로그인',
    betaTerm: 'Beta',
    betaNote: '운영자가 초대한 조직에 베타 기간 동안 직접 드립니다. 가입이나 결제로 받을 수는 없습니다.',
    billingTerm: '결제·세금·환불',
    billing: '결제와 세금, 환불은 Paddle이 판매자(Merchant of Record)로서 처리합니다. 가격은 미국 달러(USD) 기준이며 사는 곳에 따라 세금이 붙을 수 있습니다.',
    refund: '환불 정책',
    sendingTerm: '외부 발송',
    sending: '가입한 조직은 운영자 검토 없이 바로 활성이 되어 요금제 한도 안에서 보낼 수 있습니다. 운영자가 조직을 거절하거나 보류하면 발송이 닫힙니다.',
  },
  en: {
    title: 'Pricing and limits: Free, Pro, Team and Scale | Atmark',
    description: 'Monthly prices and limits for Atmark plans: Free, Beta, Pro, Team and Scale. The limits shown are the ones the service enforces, and Paddle handles payment.',
    h1: 'Pricing',
    lede: 'Plans differ only in their limits, and these are the limits we enforce.',
    plansLabel: 'Five plans',
    per: '/month',
    agents: '{n} agents',
    freeHow: 'You start on this plan as soon as you sign up.',
    betaPrice: 'Free during beta',
    betaWho: 'By invitation',
    paidHow: 'Billed monthly. Start from the console.',
    limitsTitle: 'Compare limits',
    limitCol: 'Limit',
    maxAgents: 'Agents',
    orgDailyRecipients: 'Recipients per organization per day',
    agentPerDayMax: 'Sends per agent per day',
    recipientsPerMessageMax: 'Recipients per message',
    tokensPerAgentMax: 'Tokens per agent',
    webhookEndpointsPerAgentMax: 'Webhooks per agent',
    orgApiKeysMax: 'Organization API keys',
    aliasesPerAgentMax: 'Alias addresses per agent',
    attachmentBytesTotalMax: 'Attachments per email',
    ceiling: 'Hard limits no plan can exceed: {daily} recipients per organization per day, {perMessage} recipients per message.',
    warmup: 'The daily recipient limit ramps up to these values over about two weeks.',
    notesTitle: 'Billing and changes',
    upgradeTerm: 'Changing plans',
    upgrade: 'In the console, go to Settings &rsaquo; Plan.',
    login: 'Log in to the console',
    betaTerm: 'Beta',
    betaNote: 'An operator grants it directly to organizations they invite during the beta. It cannot be bought or reached by signing up.',
    billingTerm: 'Payment, tax and refunds',
    billing: 'Paddle processes payments, tax and refunds as our Merchant of Record. Prices are in US dollars (USD), and tax may be added depending on where you are.',
    refund: 'Refund policy',
    sendingTerm: 'Outside email',
    sending: 'New organizations are active right away, with no operator review, and can send within their plan limits. If an operator rejects or suspends an organization, sending closes.',
  },
};

/** 천 단위 쉼표 — 두 언어 같은 모양(`1,000`). 로캘 데이터에 기대지 않는다(실행 환경마다 같은 글자). */
export function groupDigits(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

const fill = (template: string, values: Readonly<Record<string, string>>): string =>
  template.replace(/\{([a-zA-Z]+)\}/g, (whole, key: string) => values[key] ?? whole);

/**
 * 요금제 칸 맨 아래의 동작 하나(비평 R1-12) — 새 문구 없음. Free 는 가입(머리의 `시작하기` 와 같은 이름), 유료 셋은 업그레이드가 콘솔
 * 설정에서 일어나므로 이 사이트의 로그인 페이지(`결제와 변경` 의 `콘솔 로그인` 과 같은 이름). 결제 링크·금액은 싣지 않는다.
 */
function planAction(lang: SiteLang, plan: PlanCode): string {
  // Beta 는 가입으로 받지 않는다(운영자 초대) — 가입 동작이 없다.
  if (plan === 'beta') return '';
  const free = plan === 'free';
  // 가입은 대기자 명단 초대로만 — Free 칸의 동작은 대기자 명단이다.
  const href = sitePath(lang, free ? 'waitlist' : 'login');
  const label = free ? (CHROME_COPY[lang]['waitlist'] ?? '') : (COPY[lang]['login'] ?? '');
  // 다섯 칸의 동작 이름이 같지 않게 — 보이지 않는 접미사로 요금제 이름을 붙인다(비평 R6-12, 링크 목록·음성 제어).
  return `<p class="plan-go"><a class="btn sm ghost" href="${href}">${label}<span class="sr"> &middot; ${PLAN_NAMES[plan]}</span></a></p>`;
}

/**
 * 요금제 칸이 보여 주는 월 가격(USD) — 표와 구조화 데이터(SoftwareApplication 의 Offer)가 이 한 함수를 쓴다(값이 어긋날 수 없다).
 * Free 는 0, Beta 는 "베타 기간 무료" 라 0, 나머지는 `PLAN_MONTHLY_PRICE_USD`.
 */
export function planMonthlyUsd(plan: PlanCode): number {
  return plan === 'free' || plan === 'beta' ? 0 : PLAN_MONTHLY_PRICE_USD[plan];
}

/** 구조화 데이터의 Offer 목록 — 가격 표의 다섯 칸과 같은 순서·이름·금액. */
export function pricingOffers(): OfferEntry[] {
  return PLAN_CODES.map((plan) => ({ name: PLAN_NAMES[plan], price: String(planMonthlyUsd(plan)) }));
}

function planCard(lang: SiteLang, plan: PlanCode): string {
  const c = COPY[lang];
  const agents = `<p class="agents">${fill(c['agents'] ?? '', { n: groupDigits(PLAN_CATALOG[plan].maxAgents) })}</p>`;
  const name = `<h2>${PLAN_NAMES[plan]}</h2>`;
  if (plan === 'beta') {
    return (
      `<li class="plan beta">${name}` +
      // 대상 줄(`who`)은 에이전트 수 **아래** — 다섯 칸의 가격 줄·구분선·에이전트 수가 같은 높이에 서게(비평 R2-06).
      `<p class="price"><span class="amt word">${c['betaPrice'] ?? ''}</span></p>` +
      agents +
      `<p class="who">${c['betaWho'] ?? ''}</p>` +
      planAction(lang, plan) +
      '</li>'
    );
  }
  const usd = planMonthlyUsd(plan);
  return (
    `<li class="plan">${name}` +
    `<p class="price"><span class="amt">$${groupDigits(usd)}</span><span class="per">${c['per'] ?? ''}</span></p>` +
    agents +
    `<p class="how">${c[plan === 'free' ? 'freeHow' : 'paidHow'] ?? ''}</p>` +
    planAction(lang, plan) +
    '</li>'
  );
}

function limitsTable(lang: SiteLang): string {
  const c = COPY[lang];
  const head = `<tr><th scope="col">${c['limitCol'] ?? ''}</th>${PLAN_CODES.map((p) => `<th scope="col">${PLAN_NAMES[p]}</th>`).join('')}</tr>`;
  const rows = PRICING_LIMIT_ROWS.map(
    (key) => `<tr><th scope="row">${c[key] ?? ''}</th>${PLAN_CODES.map((p) => `<td>${limitCell(key, PLAN_CATALOG[p][key])}</td>`).join('')}</tr>`,
  ).join('');
  return (
    '<div class="tbl" role="region" aria-labelledby="limits-title" tabindex="0">' +
    `<table class="limits"><thead>${head}</thead><tbody>${rows}</tbody></table></div>`
  );
}

function pricingPage(lang: SiteLang): SitePage {
  const c = COPY[lang];
  const refundLink = REFUND_POLICY_APPROVED ? ` <a href="${sitePath(lang, 'refund')}">${c['refund'] ?? ''}</a>` : '';
  const note = (term: string, body: string): string => `<div><dt>${c[term] ?? ''}</dt><dd>${body}</dd></div>`;
  return buildSitePage({
    lang,
    id: 'pricing',
    title: c['title'] ?? '',
    description: c['description'] ?? '',
    structured: [softwareNode(lang, `${SITE_ORIGIN}${sitePath(lang, 'pricing')}`, pricingOffers())],
    main:
      // 격자 프레임 안의 셀들(명세 §5.7) — 머리 셀 · 요금제 격자(가장자리까지) · 한도 · 알아둘 것. `.wrap` 을 두지 않는다(격자선이 프레임 끝에 닿게).
      '<div class="pricing">' +
      '<header class="pr-head">' +
      `<h1>${c['h1'] ?? ''}</h1>` +
      `<p class="lede">${c['lede'] ?? ''}</p>` +
      '</header>' +
      `<ol class="plans" aria-label="${c['plansLabel'] ?? ''}">${PLAN_CODES.map((p) => planCard(lang, p)).join('')}</ol>` +
      '<section class="pr-sec" aria-labelledby="limits-title">' +
      `<h2 id="limits-title">${c['limitsTitle'] ?? ''}</h2>` +
      limitsTable(lang) +
      `<p class="ceil">${fill(c['ceiling'] ?? '', {
        daily: groupDigits(ENTITLEMENT_CEILINGS.orgDailyRecipients),
        perMessage: groupDigits(ENTITLEMENT_CEILINGS.recipientsPerMessageMax),
      })}</p>` +
      `<p class="aside">${c['warmup'] ?? ''}</p>` +
      '</section>' +
      '<section class="pr-sec" aria-labelledby="notes-title">' +
      `<h2 id="notes-title">${c['notesTitle'] ?? ''}</h2>` +
      '<dl class="items">' +
      note('upgradeTerm', `${c['upgrade'] ?? ''} <a href="${sitePath(lang, 'login')}">${c['login'] ?? ''}</a>`) +
      note('betaTerm', c['betaNote'] ?? '') +
      note('billingTerm', `${c['billing'] ?? ''}${refundLink}`) +
      note('sendingTerm', c['sending'] ?? '') +
      '</dl></section>' +
      '</div>',
  });
}

export const PRICING_PAGES: Readonly<Record<SiteLang, SitePage>> = { ko: pricingPage('ko'), en: pricingPage('en') };

/** 문구 사전(테스트 — 두 언어의 키 집합이 같다). */
export const PRICING_COPY = COPY;
