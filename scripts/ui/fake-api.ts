/**
 * scripts/ui/fake-api.ts — 로컬 미리보기 서버(`preview.ts`)가 쓰는 가짜 `/api/*` 응답.
 *
 * 진짜 DB·AWS 없이 콘솔 화면을 실제로 돌리기 위한 것이다. 되도록 새로 만들지 않고
 * `test/unit/admin/console-harness.ts` 의 `mockApi`·고정 데이터(AGENT·POLICY·TOKENS·PLAN·…)를 그대로 재사용한다 —
 * 콘솔 유닛 테스트가 이미 그 모양을 "진짜 API 계약과 같다" 고 검증해 두었으므로, 여기서 다시 베끼면 둘이 어긋날 수 있다.
 *
 * 에이전트 **목록**만 하네스보다 넓힌다(하나뿐인 `AGENT` 대신 상태가 다른 넷) — 개요·목록 화면이 덜 휑하게 보이게.
 * 목록 밖 상세 자원(정책·규칙·토큰·신원·로그)은 에이전트가 누구든 하네스의 `a1` 데이터를 그대로 돌려준다(경로의 id 를
 * `a1` 로 바꿔 `mockApi` 에 넘긴다) — a2~a4 는 목록·카드에서만 다른 모습이다. 화면을 보는 용도라 문제 없다.
 *
 * `mockApi` 가 모르는 몇 경로(`/api/billing*`)만 여기서 직접 채운다(모양은 `src/admin/ops/billing.ts`
 * `BillingOverviewView` 를 따른다). 그 밖의 안 걸리는 경로는 `preview.ts` 가 처리한다(GET 은 404, 쓰기는 `{ok:true}`).
 */

import './dirname-shim';
import { AGENT, me, mockApi, PLAN, PLAN_BRIEF, POLICY, watchRoute } from '../../test/unit/admin/console-harness';
import { agentAddressFor, agentCountFor, aliasesFor, domainFeatureOn, domainsRoute } from './fake-domains';
import { AI_WATCH_SCENARIOS, aiWatchRoute } from './fake-ai-watch';

/** `mockApi`·`me` 의 반환 모양 그대로 — 여기서 다시 정의하지 않는다(어긋나면 타입 오류로 바로 드러난다). */
export type FakeResponse = ReturnType<typeof mockApi>;

/** 목록·카드용 에이전트 넷 — 상태·모드·신원이 갈린다(디자인이 빈 상태·정지·준비 중을 볼 수 있게). 첫째는 하네스의 `AGENT` 그대로
 * (상세 하위 자원이 실제로 이 값을 본다). */
const MY_AGENTS: readonly Record<string, unknown>[] = [
  { ...AGENT },
  {
    id: 'a2',
    name: 'support-bot',
    address: 'support@atmark.ai',
    status: 'provisioning',
    suspendedBy: null,
    outboundMode: 'block',
    inboundMode: 'allowlist',
    activeTokens: 0,
    createdAt: '2026-09-25T04:00:00Z',
    identityStatus: 'draft',
    keyFingerprint: null,
  },
  {
    id: 'a3',
    name: 'sales-agent',
    address: 'sales@atmark.ai',
    status: 'suspended',
    suspendedBy: 'owner',
    outboundMode: 'allowlist',
    inboundMode: 'all',
    activeTokens: 2,
    createdAt: '2026-09-18T09:00:00Z',
    identityStatus: 'published',
    keyFingerprint: '7a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff',
  },
  {
    id: 'a4',
    name: 'legacy-agent',
    address: 'legacy@atmark.ai',
    status: 'disabled',
    suspendedBy: null,
    outboundMode: 'all',
    inboundMode: 'block',
    activeTokens: 0,
    createdAt: '2026-08-01T00:00:00Z',
    identityStatus: 'revoked',
    keyFingerprint: null,
  },
  // 비평 4회전(밀도) — "1440 에서 에이전트 10행이 스크롤 없이 한 화면" 조건을 보려고 넓힌 목록(총 16). 상태·모드·신원이 섞인
  // 실제 조직 모양 — 이름 길이도 짧은 것·긴 것을 섞었다(말줄임 확인용). a1~a4 는 위 그대로.
  ...(
    [
      ['a5', 'billing-reconciler', 'billing@atmark.ai', 'active', 'allowlist', 'allowlist', 1, 'published'],
      ['a6', 'recruiting-scheduler', 'recruiting@atmark.ai', 'active', 'all', 'allowlist', 2, 'published'],
      ['a7', 'invoice-parser', 'invoices@atmark.ai', 'active', 'blocklist', 'all', 1, 'published'],
      ['a8', 'research-assistant-long-running-nightly', 'research-nightly@atmark.ai', 'active', 'allowlist', 'all', 3, 'published'],
      ['a9', 'onboarding-concierge', 'hello@atmark.ai', 'provisioning', 'blocklist', 'allowlist', 0, 'draft'],
      ['a10', 'legal-intake', 'legal@atmark.ai', 'active', 'allowlist', 'allowlist', 1, 'published'],
      ['a11', 'ops-pager', 'ops@atmark.ai', 'suspended', 'all', 'all', 1, 'published'],
      ['a12', 'newsletter-writer', 'news@atmark.ai', 'active', 'allowlist', 'blocklist', 1, 'published'],
      ['a13', 'vendor-negotiator', 'vendors@atmark.ai', 'active', 'allowlist', 'allowlist', 2, 'published'],
      ['a14', 'qa-triage', 'qa@atmark.ai', 'disabled', 'none', 'none', 0, 'revoked'],
      ['a15', 'travel-booker', 'travel@atmark.ai', 'active', 'allowlist', 'all', 1, 'published'],
      ['a16', 'partner-liaison', 'partners@atmark.ai', 'active', 'all', 'allowlist', 1, 'draft'],
    ] as const
  ).map(([id, name, address, status, outboundMode, inboundMode, activeTokens, identityStatus], i) => ({
    id,
    name,
    address,
    status,
    suspendedBy: status === 'suspended' ? 'owner' : null,
    outboundMode,
    inboundMode,
    activeTokens,
    createdAt: `2026-09-${String(10 + i).padStart(2, '0')}T0${String(i % 10)}:00:00Z`,
    identityStatus,
    keyFingerprint: identityStatus === 'published' ? `${String(i).padStart(2, '0')}${'c0ffee'.repeat(10)}ab` : null,
  })),
];

/** 요금제 화면용(`GET /api/billing` — `BillingOverviewView`, `src/admin/ops/billing.ts`). 결제가 열려 있고 구독은 아직 없는 모양. */
const BILLING_OVERVIEW = {
  enabled: true,
  environment: 'sandbox' as const,
  canManage: true,
  upgradeAvailable: true,
  lockedReason: null,
  plans: [
    { code: 'pro', available: true },
    { code: 'team', available: true },
    { code: 'scale', available: true },
  ],
  subscription: null,
  portalAvailable: false,
};

const AGENT_SUB_ROUTE = /^\/api\/agents\/([^/?]+)(\/.*)?$/;

function agentsRoute(method: string, rawUrl: string, body: unknown): FakeResponse | null {
  if (method === 'GET' && (rawUrl === '/api/agents' || rawUrl.startsWith('/api/agents?'))) {
    const envelope = rawUrl.startsWith('/api/agents?');
    return { status: 200, json: envelope ? { items: MY_AGENTS, nextCursor: null } : MY_AGENTS };
  }
  const match = AGENT_SUB_ROUTE.exec(rawUrl);
  if (match === null) return null;
  const id = match[1] ?? '';
  const suffix = match[2];
  const known = MY_AGENTS.find((a) => a['id'] === id);
  if (known === undefined) return { status: 404, json: { error: 'agent_not_found' } };
  if (suffix === undefined || suffix === '') {
    return method === 'GET' ? { status: 200, json: known } : null;
  }
  // 하위 자원 — 어느 에이전트든 하네스의 a1 데이터를 그대로 쓴다.
  return mockApi(method, `/api/agents/a1${suffix}`, body);
}

function billingRoute(method: string, rawUrl: string): FakeResponse | null {
  if (rawUrl === '/api/billing' && method === 'GET') return { status: 200, json: BILLING_OVERVIEW };
  if (rawUrl === '/api/billing/checkout' && method === 'POST') {
    return { status: 200, json: { url: `https://pay.atmark.ai/?_ptxn=txn_${'a1b2c3d4e5f6g7h8i9j0k1l2'}`, reused: false } };
  }
  if (rawUrl === '/api/billing/portal' && method === 'POST') return { status: 200, json: { url: 'https://pay.atmark.ai/portal-preview-only' } };
  return null;
}

/** `GET /api/me` — 하네스 기본값(조직 하나)보다 넓힌다: 소유자 세션 · 다른 검토 대기 조직 하나(P0 §3.2 모양). */
function meRoute(method: string, rawUrl: string): FakeResponse | null {
  if (method !== 'GET' || rawUrl !== '/api/me') return null;
  return me('owner', { plan: PLAN_BRIEF });
}

/**
 * 콘솔 `/api/*` 요청 하나 → 가짜 응답. 순서: `/api/me`(풍부화) → 에이전트(목록·상세 넓힘) → 결제(하네스에 없음) →
 * 나머지 전부(하네스 `mockApi` 그대로 — 정책·규칙·토큰·신원·로그·발신자·게이트·통계·요금제·멤버·초대·조직 키·조직 전환).
 *
 * `scenario` 가 없거나 모르는 값이면 위 기본 동작 그대로다. 시나리오(비평 7회전 — 빈·로딩·오류 상태)는 아래 `SCENARIOS` 참고.
 */
export function fakeConsoleApi(method: string, rawUrl: string, body: unknown, scenario?: string): ScenarioResponse {
  // 감시 탭(2026-10-08) — 에이전트별 설정은 에이전트마다 따로(하네스 `watchRoute` — a1 로 바꾸지 않는다). 읽기 전용 시나리오(member)도 같은 데이터.
  if (scenario === undefined || scenario === 'member') {
    const watch = watchRoute(method, rawUrl, body);
    if (watch !== null) return watch;
  }
  // AI 의심 메일 감시(ADR-0017 — `fake-ai-watch.ts`): 기본과 `aw-*` 시나리오에서만.
  if (scenario === undefined || (AI_WATCH_SCENARIOS as readonly string[]).includes(scenario)) {
    const aw = aiWatchRoute(method, rawUrl, body, scenario);
    if (aw !== null) return aw;
    if (scenario !== undefined) return meRoute(method, rawUrl) ?? agentsRoute(method, rawUrl, body) ?? billingRoute(method, rawUrl) ?? mockApi(method, rawUrl, body);
  }
  if (scenario === undefined || scenario.startsWith('dom-')) {
    const dom = domainScenario(method, rawUrl, body, scenario);
    if (dom !== null) return dom;
    if (scenario !== undefined) return meRoute(method, rawUrl) ?? agentsRoute(method, rawUrl, body) ?? billingRoute(method, rawUrl) ?? mockApi(method, rawUrl, body);
  }
  if (scenario === 'preq') {
    const preq = policyRequestRoute(method, rawUrl);
    if (preq !== null) return preq;
    return meRoute(method, rawUrl) ?? agentsRoute(method, rawUrl, body) ?? billingRoute(method, rawUrl) ?? mockApi(method, rawUrl, body);
  }
  const scn = scenario !== undefined ? scenarioResponse(scenario, method, rawUrl, body) : null;
  if (scn !== null) return scn;
  return meRoute(method, rawUrl) ?? agentsRoute(method, rawUrl, body) ?? billingRoute(method, rawUrl) ?? mockApi(method, rawUrl, body);
}

/**
 * 고객 도메인(ADR-0014 M4 — `fake-domains.ts`): 기본(시나리오 없음)과 `dom-*` 시나리오에서만 — 문서 · 홈 스크린샷 시나리오는 그대로 둔다.
 * 요금제의 `features.customDomains` · `/api/domains*` · a1 의 주소(고객 도메인 대표 · 주소 없음) · a1 주소 목록.
 */
function domainScenario(method: string, rawUrl: string, body: unknown, scenario?: string): FakeResponse | null {
  const dom = domainsRoute(method, rawUrl, body, scenario);
  if (dom !== null) return dom;
  if (method !== 'GET') return null;
  if (rawUrl === '/api/plan') return { status: 200, json: { ...PLAN, features: { ...PLAN.features, customDomains: domainFeatureOn(scenario) } } };
  if (rawUrl === '/api/agents/a1/aliases') return { status: 200, json: aliasesFor(scenario) };
  const count = agentCountFor(scenario);
  if (count !== undefined && (rawUrl === '/api/agents' || rawUrl.startsWith('/api/agents?'))) {
    const items = MY_AGENTS.slice(0, count);
    return { status: 200, json: rawUrl.startsWith('/api/agents?') ? { items, nextCursor: null } : items };
  }
  if (count !== undefined && rawUrl === '/api/me') return me('owner', { plan: { ...PLAN_BRIEF, overLimit: [] } });
  const address = agentAddressFor(scenario);
  if (address === undefined) return null;
  const a1 = { ...AGENT, address };
  if (rawUrl === '/api/agents/a1') return { status: 200, json: a1 };
  if (rawUrl === '/api/agents' || rawUrl.startsWith('/api/agents?')) {
    const items = MY_AGENTS.map((a) => (a['id'] === 'a1' ? a1 : a));
    return { status: 200, json: rawUrl.startsWith('/api/agents?') ? { items, nextCursor: null } : items };
  }
  return null;
}

/**
 * 시나리오 `preq` — 에이전트의 정책 변경 요청(ADR-0007 2026-10-13) 둘: 위험 경고가 붙은 발신 허용 추가 · 수신 모드 변경. 승인 · 거절은 받은 것으로 친다
 * (요청 목록은 그대로 — 미리보기에는 상태가 없다).
 */
const POLICY_REQUESTS = {
  currentVersion: 4,
  items: [
    {
      id: '6f1c2d3e-4b5a-4c6d-8e7f-901a2b3c4d5e',
      agentId: 'a1',
      change: { action: 'add_rule', direction: 'outbound', list: 'allow', value: 'billing@vendor.example' },
      reason: 'You asked me to send the October invoice to the vendor billing desk.',
      status: 'pending',
      createdAt: '2026-10-13T01:12:00Z',
      expiresAt: '2026-10-20T01:12:00Z',
      decidedAt: null,
      baseVersion: 4,
      appliedVersion: null,
      staleReason: null,
      tainted: true,
      lastRiskExposureAt: '2026-10-13T00:58:00Z',
      diff: { kind: 'rule', direction: 'outbound', list: 'allow', op: 'add', value: 'billing@vendor.example', countBefore: 3, countAfter: 4, inEffect: false },
    },
    {
      id: '7a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
      agentId: 'a1',
      change: { action: 'set_mode', direction: 'inbound', mode: 'blocklist' },
      reason: 'Newsletters from many senders are filling the inbox; I only need to drop a few known spammers.',
      status: 'pending',
      createdAt: '2026-10-12T08:40:00Z',
      expiresAt: '2026-10-19T08:40:00Z',
      decidedAt: null,
      baseVersion: 3,
      appliedVersion: null,
      staleReason: null,
      tainted: false,
      lastRiskExposureAt: null,
      diff: { kind: 'mode', direction: 'inbound', before: 'all', after: 'blocklist', inEffect: false },
    },
  ],
};

function policyRequestRoute(method: string, rawUrl: string): FakeResponse | null {
  if (method === 'GET' && /^\/api\/agents\/a1\/change-requests(\?|$)/.test(rawUrl)) return { status: 200, json: POLICY_REQUESTS };
  const decided = /^\/api\/agents\/a1\/change-requests\/([0-9a-f-]+)\/(approve|reject)$/.exec(rawUrl);
  if (method === 'POST' && decided !== null) {
    const item = POLICY_REQUESTS.items.find((x) => x.id === decided[1]);
    if (item === undefined) return { status: 404, json: { error: 'policy_request_not_found' } };
    return { status: 200, json: { request: { ...item, status: decided[2] === 'approve' ? 'approved' : 'rejected', diff: null } } };
  }
  return null;
}

// ---------- 시나리오 스위치(비평 7회전 — 빈·로딩·오류 상태) ----------
//
// 콘솔 페이지를 `?_scn=<이름>` 으로 열면 `preview.ts` 가 쿠키 `SCENARIO_COOKIE` 를 심고(없으면 지운다), 그 뒤 같은 브라우저의
// `/api/*` 요청은 그 쿠키를 보고 이 시나리오를 탄다. 쿠키가 없으면 기본 데이터 그대로다(기본 샷은 달라지지 않는다).
//
//   empty     에이전트 0 · 로그 0 · 조직 키 0 · 초대 0 · 멤버 1(나) · 통계 0
//   fresh     에이전트 1(방금 만든 a1) · 토큰 0 · 규칙 0 · 로그 0 · 통계 0
//   slow      모든 API 가 6초 뒤 답한다(스켈레톤·스피너·레이아웃 흔들림 확인)
//   slowsub   /api/me·/api/agents 는 바로, 나머지 GET 은 6초 뒤
//   error500  모든 API 500
//   sub500    /api/me·/api/agents 는 성공, 나머지 GET 은 500(구역별 오류)
//   offline   모든 API 연결을 끊는다(fetch 실패 = 네트워크 오류)
//   expired   모든 API 401(세션 만료)
//   forbidden /api/me·/api/agents 는 성공, 나머지 403 forbidden_role
//   ratelimit 모든 API 429 rate_limited
//   write500  GET 은 기본, 쓰기(POST·PATCH·DELETE)는 500
//   member    역할 member(읽기 전용)
//   pending   조직 검토 대기 · rejected 가입 거절 · frozen 플랫폼 동결 · paused 소유자 정지 · over 요금제 초과(overLimit)
//   landing   홈 히어로 스크린샷(`pnpm gen:images`) — 예시 조직(Example Labs) · 에이전트 여섯 · 최근 활동이 찬 개요. 사람·회사 실명 없음
//   docs      문서 스크린샷(`pnpm gen:docs-shots`) — landing 과 같은 데이터 + 발급 직후 대화상자의 토큰·조직 키 값을 **토큰 모양이 아닌 예시 글자**로
//   docs-pending  docs 와 같고 조직이 운영자 검토 대기(검토 배너)
//   aliases   주소 탭 — 대표 + 활성 별칭 둘 + 폐기한 별칭 하나(콘솔은 폐기한 것을 올리지 않는다)
//   aw-on · aw-locked · aw-admin  AI 의심 메일 감시(`fake-ai-watch.ts`) — 켜짐 · 허용 목록 밖(잠김) · 관리자(켜기 잠김)
//   preq      에이전트의 정책 변경 요청 둘(이메일 화면 맨 위 — 위험 경고 하나 · 모드 변경 하나)
//   blog      블로그 스크린샷(`pnpm gen:blog-images`) — docs 와 같고, 첫 경험 장면만: scout 발신 허용목록에 소유자 주소 하나 · 발신 로그는
//             같은 소유자에게 간 답장 둘(위 sent, 아래 denied recipient_not_allowlisted)

export const SCENARIO_COOKIE = 'atm_ui_scn';

export type ScenarioResponse = FakeResponse & { readonly delayMs?: number; readonly drop?: boolean };

export const SCENARIOS = ['dom-none', 'dom-off', 'dom-closed', 'dom-primary', 'dom-noaddr', 'dom-noaddr-bare', 'dom-errors', 'dom-limit', 'dom-create', 'dom-dc', 'dom-preparing', 'empty', 'fresh', 'slow', 'slowsub', 'error500', 'sub500', 'offline', 'expired', 'forbidden', 'ratelimit', 'write500', 'member', 'pending', 'rejected', 'frozen', 'paused', 'over', 'landing', 'docs', 'docs-pending', 'aliases', 'blog', 'preq', ...AI_WATCH_SCENARIOS] as const;

/** 문서 스크린샷의 발급 직후 값 — 실제 토큰·키 모양(무작위 base64url)이 아니라 읽히는 예시 글자다(계획 docs-site §6 "스크린샷에 토큰 모양 문자열 없음"). */
export const DOCS_EXAMPLE_TOKEN = 'atk_agent_example-value-shown-once';
export const DOCS_EXAMPLE_ORG_KEY = 'atk_org_example-value-shown-once';

const SLOW_MS = 6000;

/** 시나리오 `aliases` — 대표 + 활성 별칭 둘 + 폐기한 별칭 하나(누적 발급 3). */
const ALIASES_TAB = {
  items: [
    { id: 'd1', address: 'founder@atmark.ai', primary: true, status: 'active', createdAt: '2026-09-20T01:00:00Z', retiredAt: null },
    { id: 'd2', address: 'sales@atmark.ai', primary: false, status: 'active', createdAt: '2026-09-24T01:00:00Z', retiredAt: null },
    { id: 'd4', address: 'support@atmark.ai', primary: false, status: 'active', createdAt: '2026-09-26T01:00:00Z', retiredAt: null },
    { id: 'd3', address: 'old-desk@atmark.ai', primary: false, status: 'retired', createdAt: '2026-09-21T01:00:00Z', retiredAt: '2026-09-25T01:00:00Z' },
  ],
  aliases: { active: 2, activeMax: 5, issued: 3, issuedMax: 20, overLimit: false },
};
const isBoot = (rawUrl: string): boolean => rawUrl === '/api/me' || rawUrl === '/api/agents' || rawUrl.startsWith('/api/agents?');

const ZERO_STATS = {
  days: 7,
  since: '2026-09-18T06:00:00.000Z',
  agentId: null,
  outbound: { total: 0, sent: 0, denied: 0, pending: 0, failed: 0, sending: 0, queued: 0 },
  inbound: { total: 0, delivered: 0, quarantined: 0, rejected: 0 },
  byAgent: [],
};

function meWith(org: Record<string, unknown>, extra: Record<string, unknown> = {}): FakeResponse {
  const base = me('owner', { plan: PLAN_BRIEF, ...extra });
  const json = base.json as Record<string, unknown>;
  return { status: 200, json: { ...json, organization: { ...(json['organization'] as Record<string, unknown>), ...org } } };
}

/** 빈 조직·갓 만든 에이전트 — 목록·하위 자원을 비운다. 나머지는 기본으로 흘린다(null). */
function emptyish(kind: 'empty' | 'fresh', method: string, rawUrl: string): FakeResponse | null {
  if (method !== 'GET') return null;
  const fresh = { ...AGENT, activeTokens: 0, createdAt: '2026-09-27T01:00:00Z' };
  if (rawUrl === '/api/me') return me('owner', { plan: { ...PLAN_BRIEF, overLimit: [] } });
  if (rawUrl === '/api/agents') return { status: 200, json: kind === 'empty' ? [] : [fresh] };
  if (rawUrl.startsWith('/api/agents?')) return { status: 200, json: { items: kind === 'empty' ? [] : [fresh], nextCursor: null } };
  if (kind === 'fresh' && rawUrl === '/api/agents/a1') return { status: 200, json: fresh };
  if (kind === 'empty' && /^\/api\/agents\/[^/?]+/.test(rawUrl)) return { status: 404, json: { error: 'agent_not_found' } };
  if (rawUrl.startsWith('/api/stats')) return { status: 200, json: ZERO_STATS };
  if (rawUrl.startsWith('/api/logs/integrity')) return null;
  if (rawUrl.startsWith('/api/logs?') || rawUrl === '/api/logs') return { status: 200, json: { items: [], next: null } };
  if (/\/tokens\?status=/.test(rawUrl)) return { status: 200, json: { tokens: [], activeCount: 0, maxActive: 5 } };
  if (/\/(channels\/email\/)?policy$/.test(rawUrl))
    return { status: 200, json: { outbound: { mode: 'allowlist', legacyMode: null, allow: [], block: [] }, inbound: { mode: 'all', allow: [], block: [] }, limits: { per_minute: 10, per_hour: 100, per_day: 500, recipients_per_message: 10 }, version: 1, ruleLimit: 1000 } };
  if (rawUrl === '/api/members') return { status: 200, json: { members: [{ userId: 'u1', email: 'me@example.com', role: 'owner', joinedAt: '2026-09-27T01:00:00Z', primary: true, you: true }], invites: [], limits: { maxMembers: 5, pendingInvites: 0, maxPendingInvites: 10 } } };
  if (rawUrl.startsWith('/api/org-keys')) return { status: 200, json: { keys: [], activeCount: 0, maxActive: 5 } };
  if (rawUrl === '/api/plan') return { status: 200, json: { ...PLAN, usage: { ...PLAN.usage, agents: kind === 'empty' ? 0 : 1, agentsTotal: kind === 'empty' ? 0 : 1, orgKeys: 0, recipientsLastDay: 0 } } };
  return null;
}

function scenarioResponse(scenario: string, method: string, rawUrl: string, body: unknown): ScenarioResponse | null {
  const get = method === 'GET';
  const base = (): FakeResponse => meRoute(method, rawUrl) ?? agentsRoute(method, rawUrl, body) ?? billingRoute(method, rawUrl) ?? mockApi(method, rawUrl, body);
  switch (scenario) {
    case 'empty':
    case 'fresh':
      return emptyish(scenario, method, rawUrl);
    case 'slow':
      return { ...base(), delayMs: SLOW_MS };
    case 'slowsub':
      return isBoot(rawUrl) ? null : { ...base(), delayMs: SLOW_MS };
    case 'error500':
      return { status: 500, json: { error: 'internal_error' } };
    case 'sub500':
      return isBoot(rawUrl) || !get ? null : { status: 500, json: { error: 'internal_error' } };
    case 'offline':
      return { status: 0, json: null, drop: true };
    case 'expired':
      return { status: 401, json: { error: 'unauthenticated' } };
    case 'forbidden':
      return isBoot(rawUrl) ? null : { status: 403, json: { error: 'forbidden_role' } };
    case 'ratelimit':
      return { status: 429, json: { error: 'rate_limited' }, headers: { 'retry-after': '30' } };
    case 'write500':
      return get ? null : { status: 500, json: { error: 'internal_error' } };
    case 'member':
      return get && rawUrl === '/api/me' ? me('member', { plan: PLAN_BRIEF }) : null;
    case 'pending':
      return get && rawUrl === '/api/me' ? meWith({ reviewStatus: 'pending_review' }) : null;
    case 'rejected':
      return get && rawUrl === '/api/me' ? meWith({ reviewStatus: 'rejected' }) : null;
    case 'frozen':
      return get && rawUrl === '/api/me' ? meWith({}, { orgKillSwitch: { ownerPaused: false, platformFrozen: true } }) : null;
    case 'paused':
      return get && rawUrl === '/api/me' ? meWith({}, { orgKillSwitch: { ownerPaused: true, platformFrozen: false } }) : null;
    case 'over':
      return get && rawUrl === '/api/me' ? me('owner', { plan: { ...PLAN_BRIEF, overLimit: ['agents'] } }) : null;
    case 'landing':
      // 홈 히어로·OG — 문서 스크린샷과 같은 예시 주소 규칙(`docsRewrite`: `…@atmark.ai` 는 예시 예약 이름만, 보안 검토 F1). 처리하지 않는 GET 도
      // 기본 데이터에 같은 규칙을 걸어 낸다(화면 어디에도 실제 서비스 주소가 고객 에이전트처럼 찍히지 않게).
      if (!get) return null;
      {
        // 예시 id(32 hex)로 들어온 요청은 a1… 로 되돌려 답한다(`docsScenario` 와 같다).
        const url = rawUrl.replace(/[0-9a-f]{32}/g, (hex) => DOCS_ID_TO_SHORT.get(hex) ?? hex);
        const r = landing(url) ?? meRoute(method, url) ?? agentsRoute(method, url, body) ?? billingRoute(method, url) ?? mockApi(method, url, body);
        return { ...r, json: docsRewrite(r.json) };
      }
    case 'aliases':
      return get && rawUrl === '/api/agents/a1/aliases' ? { status: 200, json: ALIASES_TAB } : null;
    case 'blog': {
      // 예시 id(32 hex)로 들어온 요청은 a1… 로 되돌려 본다(`docsScenario` 와 같다). 첫 경험 장면 밖은 docs 그대로.
      const own = get ? blogGet(rawUrl.replace(/[0-9a-f]{32}/g, (hex) => DOCS_ID_TO_SHORT.get(hex) ?? hex)) : null;
      if (own !== null) return { ...own, json: docsRewrite(own.json) };
      return docsScenario(false, get, rawUrl, (url) => meRoute(method, url) ?? agentsRoute(method, url, body) ?? billingRoute(method, url) ?? mockApi(method, url, body));
    }
    case 'docs':
    case 'docs-pending':
      return docsScenario(scenario === 'docs-pending', get, rawUrl, (url) => meRoute(method, url) ?? agentsRoute(method, url, body) ?? billingRoute(method, url) ?? mockApi(method, url, body));
    default:
      return null;
  }
}

// ---------- 홈 히어로 스크린샷(`landing`) ----------
//
// 홈(atmark.ai) 히어로·OG 이미지에 싣는 **실제 콘솔 화면**의 데이터(`scripts/gen-images.ts`). 조직 이름은 홈 예시 카드와 같은 `Example Labs`,
// 주소 상대는 전부 `*.example`(RFC 2606) — 실존 사람·회사가 없다. 시각은 `LANDING_NOW`(캡처 때 브라우저 시계를 이 값에 고정한다)
// 바로 앞이라 "n분 전" 이 늘 같은 글자로 찍힌다. 에이전트 수는 요금제 한도 안(6 / 10) — 넘침 배지가 광고에 찍히지 않게.
// 에이전트 이름 = 주소 로컬 파트이고, 그 이름은 전부 예시 예약(`EXAMPLE_RESERVED_LOCAL_PARTS` — 아무도 발급받을 수 없다). 상대 주소는
// 히어로 칸 너비에서 잘리지 않게 짧게 둔다.

/** 캡처 때 브라우저 시계를 멈춰 두는 시각 — 상대 시각("8분 전")이 매번 같은 글자가 되게. */
export const LANDING_NOW = '2026-09-27T03:00:00Z';

const LANDING_ORG = { id: 'o1', name: 'Example Labs', ownerEmail: 'owner@example.com', reviewStatus: 'active' };

const LANDING_AGENTS: readonly Record<string, unknown>[] = (
  [
    ['a1', 'scout', 'scout@atmark.ai', 'active', 'allowlist', 'all', 2, 'published', '2026-09-27T02:52:00Z'],
    ['a2', 'help-desk', 'help-desk@atmark.ai', 'active', 'allowlist', 'all', 1, 'published', '2026-09-27T02:41:00Z'],
    ['a3', 'invoices', 'invoices@atmark.ai', 'active', 'blocklist', 'allowlist', 1, 'published', '2026-09-27T02:30:00Z'],
    ['a4', 'recruiting', 'recruiting@atmark.ai', 'active', 'allowlist', 'all', 1, 'published', '2026-09-27T01:12:00Z'],
    ['a5', 'research', 'research@atmark.ai', 'provisioning', 'none', 'allowlist', 0, 'draft', null],
    ['a6', 'ops-pager', 'ops-pager@atmark.ai', 'suspended', 'all', 'all', 1, 'published', '2026-09-26T22:05:00Z'],
  ] as const
).map(([id, name, address, status, outboundMode, inboundMode, activeTokens, identityStatus, lastUsedAt], i) => ({
  id,
  name,
  address,
  status,
  suspendedBy: status === 'suspended' ? 'owner' : null,
  outboundMode,
  inboundMode,
  activeTokens,
  createdAt: `2026-09-${String(12 + i * 2).padStart(2, '0')}T01:00:00Z`,
  lastUsedAt,
  identityStatus,
  keyFingerprint: identityStatus === 'published' ? ['3f9a0c1d', '8b27e4f0', '5d61a9c3', 'c4e8127b', '', '71f3d0a6'][i] + '2e4b5a6978c0d1e2f3a4b5c6d7e8f90112233445566778899aabbccd' : null,
}));

const LANDING_OUT = [
  ['o4', '2026-09-27T02:52:00Z', 'a1', 'scout', 'scout@atmark.ai', 'maya@acme.example', 'Re: pilot schedule', 'sent'],
  ['o3', '2026-09-27T02:41:00Z', 'a2', 'help-desk', 'help-desk@atmark.ai', 'lee@shop.example', 'Your ticket #2291', 'sent'],
  ['o2', '2026-09-27T02:30:00Z', 'a3', 'invoices', 'invoices@atmark.ai', 'ap@vendor.example', 'Invoice 0927', 'denied'],
  ['o1', '2026-09-27T01:12:00Z', 'a4', 'recruiting', 'recruiting@atmark.ai', 'jun@lab.example', 'Interview slots', 'sent'],
].map(([id, at, agentId, agentName, from, to, subject, decision]) => ({
  id, at, agentId, agentName, from, recipients: [to], recipientCount: 1, subject, decision,
  reasons: decision === 'denied' ? ['recipient_not_allowlisted'] : [], policyVersion: 4,
}));

const LANDING_IN = [
  ['i2', '2026-09-27T02:47:00Z', 'a1', 'scout', 'maya@acme.example', 'pilot schedule', 'delivered'],
  ['i1', '2026-09-27T02:20:00Z', 'a2', 'help-desk', 'promo@ads.example', 'Limited offer', 'quarantined'],
].map(([id, at, agentId, agentName, from, subject, verdict]) => ({ id, at, agentId, agentName, from, to: [`${String(agentName)}@atmark.ai`], subject, verdict }));

function landing(rawUrl: string): FakeResponse | null {
  const agents = LANDING_AGENTS;
  if (rawUrl === '/api/me') {
    const base = me('owner', { plan: { ...PLAN_BRIEF, overLimit: [] } }).json as Record<string, unknown>;
    return { status: 200, json: { ...base, organization: { ...LANDING_ORG, role: 'owner' }, memberships: [{ organizationId: 'o1', name: LANDING_ORG.name, role: 'owner', reviewStatus: 'active' }] } };
  }
  if (rawUrl === '/api/agents') return { status: 200, json: agents };
  if (rawUrl.startsWith('/api/agents?')) return { status: 200, json: { items: agents, nextCursor: null } };
  const one = /^\/api\/agents\/([^/?]+)$/.exec(rawUrl);
  if (one !== null) {
    const found = agents.find((a) => a['id'] === one[1]);
    return found === undefined ? { status: 404, json: { error: 'agent_not_found' } } : { status: 200, json: found };
  }
  // 주소 절 — 그 에이전트의 대표 주소 하나(별칭 없음). 기본 데이터의 별칭(founder@·sales@…)이 예시 에이전트에 붙어 찍히지 않게.
  const aliases = /^\/api\/agents\/([^/?]+)\/aliases$/.exec(rawUrl);
  if (aliases !== null) {
    const found = agents.find((a) => a['id'] === aliases[1]);
    if (found === undefined) return { status: 404, json: { error: 'agent_not_found' } };
    const primary = { id: `${String(found['id'])}-d1`, address: found['address'], primary: true, status: 'active', createdAt: found['createdAt'], retiredAt: null };
    return { status: 200, json: { items: [primary], aliases: { active: 0, activeMax: PLAN.limits.aliasesPerAgentMax, issued: 0, issuedMax: 20, overLimit: false } } };
  }
  if (rawUrl.startsWith('/api/stats')) {
    return {
      status: 200,
      json: {
        days: 7,
        since: '2026-09-20T03:00:00.000Z',
        agentId: null,
        outbound: { total: 226, sent: 214, denied: 9, pending: 0, failed: 1, sending: 0, queued: 2 },
        inbound: { total: 393, delivered: 386, quarantined: 4, rejected: 3 },
        byAgent: [],
      },
    };
  }
  if (rawUrl.startsWith('/api/logs?')) {
    const type = /[?&]type=([a-z]+)/.exec(rawUrl)?.[1];
    if (type === 'outbound') return { status: 200, json: { items: LANDING_OUT, next: null } };
    if (type === 'inbound') return { status: 200, json: { items: LANDING_IN, next: null } };
  }
  if (rawUrl === '/api/plan') return { status: 200, json: { ...PLAN, usage: { ...PLAN.usage, agents: agents.length, agentsTotal: agents.length } } };
  return null;
}

/**
 * 문서 스크린샷(`docs` · `docs-pending`) — landing 데이터를 바탕으로 문서 글과 맞는 **예시 데이터만** 바꾼다(화면은 그대로):
 *   - 신원: 게시됨 · 공개 문서 세 링크(did.json · passport.json · passport.jws) · 만료일.
 *   - 로그 › 예약: 취소할 수 있는 예약 하나 · 에이전트가 취소한 예약 하나 · 보낸 예약 하나.
 *   - 발급 응답의 토큰·키 값 → 토큰 모양이 아닌 예시 글자.
 *   - **응답 속 `…@atmark.ai` 주소 전부 → 예시 예약 이름**(`EXAMPLE_RESERVED_LOCAL_PARTS` — 아무도 발급받을 수 없다, 이름 = 주소 로컬 파트).
 *     실제 서비스 주소(support@ 등)가 고객 에이전트처럼 찍히지 않게(보안 검토 F1). `test/unit/docs/docs-shots.test.ts` 가 예시 예약 이름인지 본다.
 */
function docsScenario(pending: boolean, get: boolean, requestUrl: string, base: (url: string) => FakeResponse): FakeResponse | null {
  // 화면은 예시 id(32 hex)로 요청한다 — 하네스·landing 데이터는 a1… 로 답하므로 들어올 때 되돌리고 나갈 때 바꾼다.
  const rawUrl = requestUrl.replace(/[0-9a-f]{32}/g, (hex) => DOCS_ID_TO_SHORT.get(hex) ?? hex);
  let r: FakeResponse;
  if (get) {
    r = (pending ? docsPending(rawUrl) : docsGet(rawUrl)) ?? base(rawUrl);
  } else {
    r = base(rawUrl);
    const json = r.json as Record<string, unknown> | null;
    if (json !== null && typeof json === 'object') {
      if (typeof json['token'] === 'string') r = { ...r, json: { ...json, token: DOCS_EXAMPLE_TOKEN } };
      else if (typeof json['key'] === 'string') r = { ...r, json: { ...json, key: DOCS_EXAMPLE_ORG_KEY } };
    }
  }
  return { ...r, json: docsRewrite(r.json) };
}

/** 예시 에이전트 id — 실제 id 와 같은 모양(32 hex). 문서 스크린샷의 경로(`src/docs/shots.ts`)가 이 값을 쓴다. */
export const DOCS_AGENT_IDS: Readonly<Record<string, string>> = {
  a1: '7c3e9b2a4f1d4e8b9a6c0d2e5f7a1b3c',
  a2: '2b8d4f6a1c3e4a5b8d9f0e1c2a3b4c5d',
  a3: '9e1f2a3b4c5d4e6f8a7b9c0d1e2f3a4b',
  a4: '4a5b6c7d8e9f4a0b9c1d2e3f4a5b6c7d',
  a5: '5d6e7f8a9b0c4d1e8f2a3b4c5d6e7f8a',
  a6: '6f7a8b9c0d1e4f2a9b3c4d5e6f7a8b9c',
};
const DOCS_ID_TO_SHORT = new Map(Object.entries(DOCS_AGENT_IDS).map(([short, hex]) => [hex, short]));

/**
 * 예시 주소의 로컬 파트 — landing 데이터는 이미 예시 예약 이름이다. 기본 데이터에서 새어 들어올 수 있는 이름만 예시 예약 이름으로 바꾸고,
 * 나머지는 그대로 둔다(예시 예약 밖의 이름은 캡처 검사 `screenAddressProblems` 와 단위 테스트가 막는다): 서비스 이름(support·ops)과
 * 하네스 a1 의 주소 `founder`(→ 예시 a1 `scout` — landing 이 따로 답하지 않는 요청, 예: 신원 변경 이력 `identity-blocks`).
 */
const DOCS_LOCAL_PARTS: Readonly<Record<string, string>> = { support: 'help-desk', ops: 'ops-pager', founder: 'scout' };

export function docsAddress(local: string): string {
  const l = local.toLowerCase();
  return DOCS_LOCAL_PARTS[l] ?? l;
}

const ATMARK_ADDRESS = /([a-z0-9][a-z0-9._-]*)@atmark\.ai/gi;

/** 응답 JSON 안의 글자를 전부 훑어 `…@atmark.ai` 를 예시 주소로 · 에이전트 id 를 예시 id 로. */
export function docsRewrite(value: unknown): unknown {
  if (typeof value === 'string') {
    const exactId = DOCS_AGENT_IDS[value];
    if (exactId !== undefined) return exactId;
    return value
      .replace(ATMARK_ADDRESS, (_m, local: string) => `${docsAddress(local)}@atmark.ai`)
      .replace(/(agents[:/])(a[0-9]+)\b/g, (m, pre: string, id: string) => (DOCS_AGENT_IDS[id] === undefined ? m : `${pre}${DOCS_AGENT_IDS[id]}`));
  }
  if (Array.isArray(value)) return value.map(docsRewrite);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, docsRewrite(v)]));
  return value;
}

/** 예약 발송 줄(로그 › 예약) — `LANDING_NOW` 기준 앞뒤 시각. */
const DOCS_SCHEDULED = [
  { id: 's3', at: '2026-09-27T09:00:00Z', sendAt: '2026-09-27T09:00:00Z', agentId: 'a1', agentName: 'scout', recipients: ['maya@acme.example'], recipientCount: 1, subject: 'Pilot recap', status: 'scheduled', cancelledVia: null, cancelReason: null },
  { id: 's2', at: '2026-09-27T02:00:00Z', sendAt: '2026-09-27T02:00:00Z', agentId: 'a4', agentName: 'recruiting', recipients: ['jun@lab.example'], recipientCount: 1, subject: 'Interview reminder', status: 'cancelled', cancelledVia: 'mcp', cancelReason: 'wrong_time' },
  { id: 's1', at: '2026-09-26T23:30:00Z', sendAt: '2026-09-26T23:30:00Z', agentId: 'a2', agentName: 'help-desk', recipients: ['lee@shop.example'], recipientCount: 1, subject: 'Your ticket #2291', status: 'dispatched', cancelledVia: null, cancelReason: null },
];

function docsGet(rawUrl: string): FakeResponse | null {
  const identity = /^\/api\/agents\/(a[0-9]+)\/identity$/.exec(rawUrl);
  if (identity !== null) {
    const id = identity[1] ?? 'a1';
    const base = `https://id.atmark.ai/agents/${id}`;
    return {
      status: 200,
      json: {
        status: 'published',
        did: `did:web:id.atmark.ai:agents:${id}`,
        version: 2,
        publishedAt: '2026-09-22T00:00:00Z',
        issuedAt: '2026-09-22T00:00:00Z',
        // 패스포트 유효 기간 90일.
        validUntil: '2026-12-21T00:00:00Z',
        didDocumentUrl: `${base}/did.json`,
        passportUrl: `${base}/passport.json`,
        passportJwsUrl: `${base}/passport.jws`,
        contentHash: 'ab'.repeat(32),
        pending: null,
        lastResult: null,
        keyFingerprint: '3f9a0c1d2e4b5a6978c0d1e2f3a4b5c6d7e8f90112233445566778899aabbccd',
        keyAlgorithm: 'ed25519',
      },
    };
  }
  if (rawUrl.startsWith('/api/logs?') && /[?&]type=scheduled\b/.test(rawUrl)) return { status: 200, json: { items: DOCS_SCHEDULED, next: null } };
  return landing(rawUrl);
}

/**
 * 검토 대기 조직(`docs-pending`) — 문서의 "검토 전" 설명과 맞는 **그럴듯한 데이터**: 에이전트 둘(검토 대기 상한 2) · 외부 발송 0 ·
 * 받은 메일 몇 통. 화면은 그대로이고 데이터만 다르다.
 */
function docsPending(rawUrl: string): FakeResponse | null {
  // 신원 게시는 검토 뒤라 아직 draft(키 지문 없음) · 외부 발송이 없으니 마지막 사용 없음.
  const agents = LANDING_AGENTS.slice(0, 2).map((a) => ({ ...a, lastUsedAt: null, identityStatus: 'draft', keyFingerprint: null }));
  if (rawUrl === '/api/me') {
    const r = landing(rawUrl);
    if (r === null) return null;
    const json = r.json as Record<string, unknown>;
    const organization = { ...(json['organization'] as Record<string, unknown>), reviewStatus: 'pending_review' };
    return { ...r, json: { ...json, organization, memberships: [{ organizationId: 'o1', name: LANDING_ORG.name, role: 'owner', reviewStatus: 'pending_review' }] } };
  }
  if (rawUrl === '/api/agents') return { status: 200, json: agents };
  if (rawUrl.startsWith('/api/agents?')) return { status: 200, json: { items: agents, nextCursor: null } };
  if (rawUrl.startsWith('/api/stats')) {
    return {
      status: 200,
      json: {
        days: 7,
        since: '2026-09-20T03:00:00.000Z',
        agentId: null,
        outbound: { total: 0, sent: 0, denied: 0, pending: 0, failed: 0, sending: 0, queued: 0 },
        inbound: { total: 3, delivered: 3, quarantined: 0, rejected: 0 },
        byAgent: [],
      },
    };
  }
  if (rawUrl.startsWith('/api/logs?')) {
    const type = /[?&]type=([a-z]+)/.exec(rawUrl)?.[1];
    if (type === 'outbound') return { status: 200, json: { items: [], next: null } };
    if (type === 'inbound') return { status: 200, json: { items: LANDING_IN.slice(0, 1), next: null } };
  }
  if (rawUrl === '/api/plan') return { status: 200, json: { ...PLAN, usage: { ...PLAN.usage, agents: agents.length, agentsTotal: agents.length, recipientsLastDay: 0 } } };
  return docsGet(rawUrl);
}

// ---------- 블로그 스크린샷(`blog`) ----------
//
// 블로그 1호 "Stop giving your AI agent your Gmail" 의 첫 경험 장면(`src/site/blog/shots.ts`). 예시 에이전트 scout(a1)의 소유자 주소는
// 예시 조직 소유자 `owner@example.com`(`LANDING_ORG.ownerEmail`) — 글도 이 이름을 쓴다. 시각은 `LANDING_NOW` 바로 앞.

/** 소유자가 발신 허용목록에 넣은 자기 주소 하나(새 에이전트 정책 v1 → 추가해서 v2). */
const BLOG_OWNER_RULE = { id: 'r-owner', kind: 'address', value: 'owner@example.com', createdAt: '2026-09-27T02:54:00Z' };
const BLOG_POLICY = { ...POLICY, outbound: { mode: 'allowlist', legacyMode: null, allow: [BLOG_OWNER_RULE], block: [] }, inbound: { mode: 'all', allow: [], block: [] }, version: 2 };

/** 같은 소유자에게 간 답장 둘 — 위(새것) sent · 아래(옛것) denied. */
const BLOG_REPLY = { agentId: 'a1', agentName: 'scout', from: 'scout@atmark.ai', recipients: ['owner@example.com'], recipientCount: 1, subject: 'Re: Hello from my inbox' };
const BLOG_OUT = [
  { id: 'o2', at: '2026-09-27T02:56:00Z', ...BLOG_REPLY, decision: 'sent', reasons: ['allowlist_match'], policyVersion: 2 },
  { id: 'o1', at: '2026-09-27T02:51:00Z', ...BLOG_REPLY, decision: 'denied', reasons: ['recipient_not_allowlisted'], policyVersion: 1 },
];

function blogGet(rawUrl: string): FakeResponse | null {
  if (/^\/api\/agents\/a1\/(channels\/email\/)?policy$/.test(rawUrl)) return { status: 200, json: BLOG_POLICY };
  if (rawUrl.startsWith('/api/logs?') && /[?&]type=outbound\b/.test(rawUrl)) return { status: 200, json: { items: BLOG_OUT, next: null } };
  return null;
}

/** 쿠키 머리에서 시나리오 이름 — 모르는 값·없음은 undefined(기본 동작). */
export function scenarioFromCookie(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === SCENARIO_COOKIE) {
      const v = part.slice(i + 1).trim();
      return (SCENARIOS as readonly string[]).includes(v) ? v : undefined;
    }
  }
  return undefined;
}

/** 콘솔 페이지 응답에 붙일 Set-Cookie — `?_scn=` 이 있으면 심고, 없으면 지운다(앞 대상의 시나리오가 남지 않게). */
export function scenarioSetCookie(url: URL): string {
  const v = url.searchParams.get('_scn');
  return v !== null && (SCENARIOS as readonly string[]).includes(v) ? `${SCENARIO_COOKIE}=${v}; Path=/; SameSite=Lax` : `${SCENARIO_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
}
