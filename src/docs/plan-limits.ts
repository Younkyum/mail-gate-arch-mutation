/**
 * src/docs/plan-limits.ts — `{{plan-limits}}` 자리표시: 요금제 한도 표. 숫자는 **카탈로그**(`src/billing/plans.ts` `PLAN_CATALOG` — import 없는
 * 값 파일)를 그대로 읽는다 — 문서가 제품과 어긋날 수 없다(계획 원칙 3). 행 이름은 가격 페이지(`src/site/pricing.ts`)와 같은 말이고
 * (테스트가 같은지 본다), 행 목록도 같다 — 다만 문서 플래그(`DOCS_FEATURES`)가 꺼진 기능의 행(별칭·첨부)은 뺀다.
 */

import { MIB, PLAN_CATALOG, PLAN_CODES, type EntitlementLimits, type PlanCode } from '../billing/plans';
import { DOCS_FEATURES, HOME_ORIGIN, type DocsFeature, type DocsLang } from './constants';

export const DOCS_LIMIT_ROWS: readonly (keyof EntitlementLimits)[] = [
  'maxAgents',
  'orgDailyRecipients',
  'agentPerDayMax',
  'recipientsPerMessageMax',
  'tokensPerAgentMax',
  'webhookEndpointsPerAgentMax',
  'orgApiKeysMax',
  'aliasesPerAgentMax',
  'attachmentBytesTotalMax',
];

/** 문서 플래그에 묶인 행. */
const ROW_FEATURE: Partial<Record<keyof EntitlementLimits, DocsFeature>> = {
  aliasesPerAgentMax: 'aliases',
  attachmentBytesTotalMax: 'attachments',
};

export const PLAN_NAMES: Readonly<Record<PlanCode, string>> = { free: 'Free', beta: 'Beta', pro: 'Pro', team: 'Team', scale: 'Scale' };

export const LIMIT_LABELS: Readonly<Record<DocsLang, Readonly<Record<string, string>>>> = {
  ko: {
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
    source: '가격과 결제는 요금제 페이지에 있습니다.',
    sourceLink: '요금제 보기',
  },
  en: {
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
    source: 'Prices and billing are on the pricing page.',
    sourceLink: 'See pricing',
  },
};

function groupDigits(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 표 한 칸 — 개수는 천 단위 쉼표, 바이트 칸은 MB(가격 페이지 `limitCell` 과 같은 규칙). */
export function docsLimitCell(key: keyof EntitlementLimits, value: number): string {
  return key === 'attachmentBytesTotalMax' ? `${groupDigits(Math.floor(value / MIB))} MB` : groupDigits(value);
}

/** 문서 플래그 값 — 사이트 빌드의 `features`(테스트·미리보기)를 따른다. 없으면 `DOCS_FEATURES`. */
type Features = Readonly<Record<DocsFeature, boolean>>;

/** 지금 보이는 행 — 꺼진 문서 플래그의 행을 뺀다. */
export function visibleLimitRows(features: Features = DOCS_FEATURES): (keyof EntitlementLimits)[] {
  return DOCS_LIMIT_ROWS.filter((key) => {
    const flag = ROW_FEATURE[key];
    return flag === undefined || features[flag];
  });
}

/** 홈 가격 페이지 — 영어는 `/pricing`(옛 `/en/…` 은 301), 한국어는 `/kr/pricing`(홈 `KO_PREFIX` — 대조는 docs-sources 테스트). */
function pricingUrl(lang: DocsLang): string {
  return `${HOME_ORIGIN}${lang === 'ko' ? '/kr' : ''}/pricing`;
}

export function planLimitsHtml(lang: DocsLang, features: Features = DOCS_FEATURES): string {
  const c = LIMIT_LABELS[lang];
  const head = `<tr><th scope="col">${c['limitCol'] ?? ''}</th>${PLAN_CODES.map((p) => `<th scope="col">${PLAN_NAMES[p]}</th>`).join('')}</tr>`;
  const rows = visibleLimitRows(features)
    .map((key) => `<tr><th scope="row">${c[key] ?? ''}</th>${PLAN_CODES.map((p) => `<td>${docsLimitCell(key, PLAN_CATALOG[p][key])}</td>`).join('')}</tr>`)
    .join('');
  return (
    `<div class="tbl" role="region" tabindex="0" aria-label="${c['limitCol'] ?? ''}"><table class="limits"><thead>${head}</thead><tbody>${rows}</tbody></table></div>` +
    `<p class="tbl-note">${c['source'] ?? ''} <a href="${pricingUrl(lang)}">${c['sourceLink'] ?? ''}</a></p>`
  );
}

export function planLimitsMarkdown(lang: DocsLang, features: Features = DOCS_FEATURES): string {
  const c = LIMIT_LABELS[lang];
  const lines = [
    `| ${c['limitCol'] ?? ''} | ${PLAN_CODES.map((p) => PLAN_NAMES[p]).join(' | ')} |`,
    `|---|${PLAN_CODES.map(() => '---').join('|')}|`,
    ...visibleLimitRows(features).map((key) => `| ${c[key] ?? ''} | ${PLAN_CODES.map((p) => docsLimitCell(key, PLAN_CATALOG[p][key])).join(' | ')} |`),
  ];
  return `${lines.join('\n')}\n\n${c['source'] ?? ''} ${pricingUrl(lang)}`;
}
