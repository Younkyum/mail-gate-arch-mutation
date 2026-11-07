/**
 * `pnpm ui:ops` — 운영자 웹 화면(`scripts/ops-web/page.ts`)을 **가짜 데이터**로 띄워 보거나 찍는다. DB·AWS·터널 0 — 운영에 붙는 길이 없다
 * (이 파일은 DB 클라이언트·`admin/*`·`ops-web/server`·`ops-web/api` 를 import 하지 않는다). 페이지는 진짜 `buildOpsPage()` 그대로(같은 해시 CSP),
 * `/api/*` 만 아래 고정 데이터로 답한다(모양은 `scripts/ops-web/api.ts` 의 응답과 같다 — 예시 조직·`*.example` 주소, 실명 없음).
 *
 *   pnpm ui:ops                         # http://127.0.0.1:4176/ 에 띄운다(Ctrl-C 로 끈다)
 *   pnpm ui:ops --shots <폴더>          # 헤드리스 Chrome 으로 화면을 찍고 끝낸다(1440 · 390, 밝은·어두운). Chrome 잠금은 부르는 쪽이 잡는다.
 *
 * 쓰기(POST)는 저장하지 않고 성공 모양만 돌려준다(대화상자 흐름을 눌러 보려고).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import { pathToFileURL } from 'node:url';

import { ENTITLEMENT_CEILINGS, LIMIT_COLUMNS, PLAN_CATALOG, PLAN_CODES } from '../../src/billing/plans';
import { BOARD_MANUAL_CHECKS, BOARD_RULES, cohortRowOf, INTERNAL_ORG_IDS, ladderOf, type BoardGuardRaw } from '../../src/ops/console/board-rules';
import { buildOpsPage, HOSTED_PAGE_CONFIG } from '../../src/ops/console/page';
import { Cdp, delay, killChrome, launchChrome, type ChromeHandle } from './browser';

export const OPS_PREVIEW_PORT = 4176;
const HOST = '127.0.0.1';

const now = Date.now();
const ago = (minutes: number): string => new Date(now - minutes * 60_000).toISOString();

interface FakeOrg {
  id: string;
  name: string;
  ownerEmail: string;
  reviewStatus: 'pending_review' | 'active' | 'rejected';
  signupSource: 'self_signup' | 'operator';
  createdAt: string;
  plan: string;
  abuseFreeze: boolean;
  agents: { id: string; name: string; address: string | null; status: string; suspendedBy: string | null; activeTokens: number; createdAt: string }[];
  members: { email: string; role: string }[];
}

const hex = (seed: number): string => seed.toString(16).padStart(2, '0').repeat(16);
const uuid = (n: number): string => `${String(n).padStart(8, '0')}-4a1b-4c2d-8e3f-${String(n).padStart(12, '0')}`;

const ORGS: FakeOrg[] = [
  ['스튜디오 할로', 'jiwoo@studio-halo.example', 'pending_review', 12, [['halo-desk', 'desk@halo.atmark.example', 'provisioning']]],
  ['Northwind Labs', 'ops@northwind.example', 'pending_review', 95, [['sales-bot', 'sales@northwind.atmark.example', 'provisioning'], ['support', 'help@northwind.atmark.example', 'provisioning']]],
  ['모래시계 컴퍼니', 'founder@sandglass.example', 'pending_review', 60 * 20, []],
  ['Kairos Labs', 'hello@kairos.example', 'active', 60 * 26, [['kairos-agent', 'agent@kairos.atmark.example', 'active']]],
  ['Lumen 스튜디오', 'hq@lumen.example', 'active', 60 * 24 * 3, [['founder-agent', 'founder@lumen.atmark.example', 'active'], ['support-bot', 'support-desk@lumen.atmark.example', 'active'], ['legacy', 'legacy@lumen.atmark.example', 'suspended']]],
  ['Bluefin 데이터', 'admin@bluefin.example', 'rejected', 60 * 24 * 4, [['bf-outreach', 'outreach@bluefin.atmark.example', 'suspended']]],
  ['Orchard AI', 'team@orchard.example', 'active', 60 * 24 * 6, [['orchard', 'hi@orchard.atmark.example', 'active']]],
  ['Example Labs', 'owner@example-labs.example', 'active', 60 * 24 * 12, [['research', 'research@example.atmark.example', 'active']]],
].map(([name, email, status, minutes, agents], i) => ({
  id: uuid(i + 1),
  name: name as string,
  ownerEmail: email as string,
  reviewStatus: status as FakeOrg['reviewStatus'],
  signupSource: 'self_signup' as const,
  createdAt: ago(minutes as number),
  plan: status === 'active' ? (i === 4 ? 'team' : 'beta') : 'free',
  abuseFreeze: i === 6,
  agents: (agents as string[][]).map(([agentName, address, agentStatus], k) => ({
    id: hex(i * 16 + k + 1),
    name: agentName as string,
    address: address as string,
    status: agentStatus as string,
    suspendedBy: agentStatus === 'suspended' ? (i === 4 ? 'owner' : 'operator') : null,
    activeTokens: agentStatus === 'active' ? 1 : 0,
    createdAt: ago((minutes as number) - 5),
  })),
  members: [{ email: email as string, role: 'owner' }],
}));

/**
 * `/api/board`(주간 운영판, 202610010900)와 같은 모양 — 판정은 진짜 규칙(`board-rules.ts`)으로 만든다. 2주차 금요일 아침의 그럴듯한 숫자: 외부 발신이
 * 하한 아래(판정 불가) · 조직 하나가 가입 14일 안에 전체 모드로 바꿈(L1) · 열린 주 하나와 닫힌 주 둘.
 */
function weeklyBoard(): unknown {
  const at = new Date('2026-10-16T01:00:00.000Z');
  const guard: BoardGuardRaw = {
    externalSends: { d7: 64, d14: 118, d28: 131, newOrgD7: 21 },
    sesComplaints: 0,
    sesBounces: 1,
    systemComplaints: 0,
    systemHardBounces: 1,
    waitlistHardBounces: 1,
    gmailDailyPeak: 9,
    allModeCount: 1,
    allModeOrgs: [uuid(7)],
    dailyRecipientsTop: [{ organizationId: uuid(5), value: 6 }],
    harvestTop: [{ organizationId: uuid(4), value: 4 }],
  };
  const zero = { signedUp: 0, agent: 0, mcp: 0, inbound: 0, read: 0, deny: 0, reply: 0, retained: 0 };
  return {
    at: at.toISOString(),
    guardrail: {
      ...ladderOf(guard),
      volume: { d7: 64, d14: 118, d28: 131, floor14d: BOARD_RULES.volumeFloor14d, floor28d: BOARD_RULES.volumeFloor28d, launchFloorMet: false },
      manual: BOARD_MANUAL_CHECKS,
    },
    northStar: { global: 3, beta: 2, internalExcluded: INTERNAL_ORG_IDS.length },
    cohorts: {
      internalExcluded: INTERNAL_ORG_IDS.length,
      rows: [
        cohortRowOf({ week: '2026-W42', invited: 4, open7: 1, open14: 1, global: { ...zero, signedUp: 1, agent: 1 }, beta: zero }, at),
        cohortRowOf({ week: '2026-W41', invited: 10, open7: 5, open14: 7, global: { ...zero, signedUp: 6, agent: 5, mcp: 4, inbound: 3, read: 2, deny: 2, reply: 1 }, beta: { ...zero, signedUp: 3, agent: 3, mcp: 3, inbound: 2, read: 2, deny: 1, reply: 1 } }, at),
        cohortRowOf({ week: '2026-W36', invited: 24, open7: 0, open14: 0, global: { ...zero, signedUp: 21, agent: 18, mcp: 15, inbound: 11, read: 9, deny: 7, reply: 5, retained: 6 }, beta: zero }, at),
      ],
    },
    waitlist: { waiting: 37, invited: 8, expired: 2, joined: 10, grades: { A: 9, B: 21, hold: 3, unknown: 4 }, gradeASlaBreaches: 2 },
  };
}

/** `/api/catalog` 과 같은 모양(`scripts/ops-web/api.ts` `catalog`) — 코드 카탈로그 그대로. */
const CATALOG = {
  plans: PLAN_CODES,
  columns: LIMIT_COLUMNS.map(([key, column]) => ({ column, ceiling: ENTITLEMENT_CEILINGS[key] })),
  catalog: Object.fromEntries(PLAN_CODES.map((code) => [code, Object.fromEntries(LIMIT_COLUMNS.map(([key, column]) => [column, PLAN_CATALOG[code][key]]))])),
};

function orgDetail(org: FakeOrg): unknown {
  return {
    organization: {
      id: org.id,
      name: org.name,
      ownerEmail: org.ownerEmail,
      reviewStatus: org.reviewStatus,
      signupSource: org.signupSource,
      reviewedAt: org.reviewStatus === 'pending_review' ? null : ago(60),
      abuseFreeze: org.abuseFreeze,
      ownerPaused: false,
      billingStatus: 'trialing',
      sendingStartedAt: org.reviewStatus === 'active' ? ago(600) : null,
      createdAt: org.createdAt,
    },
    members: org.members.map((m) => ({ ...m, joinedVia: 'signup', createdAt: org.createdAt })),
    agents: org.agents,
    plan: {
      plan: { code: org.plan, basis: org.plan === 'free' ? 'missing' : 'row', rowCode: org.plan === 'free' ? null : org.plan, source: org.plan === 'free' ? null : 'operator', version: org.plan === 'free' ? null : 2, graceUntil: null },
      limits: { maxAgents: org.plan === 'team' ? 25 : 10, agentsTotalMax: 1000, orgApiKeysMax: 2, tokensPerAgentMax: 5, agentPerMinuteMax: 10, agentPerDayMax: 200, recipientsPerMessageMax: 10 },
      usage: { agents: org.agents.length, agentsTotal: org.agents.length, recipientsLastDay: org.reviewStatus === 'active' ? 37 : 0, dailyCap: 200, dailyCapReason: 'plan_daily_cap', orgKeys: 0, agentsOverTokenLimit: 0 },
      overLimit: [],
    },
    entitlementControl: org.plan === 'free' ? null : { source: 'operator', cause: 'review', releasedToProvider: false },
    billing: { subscriptions: [], betaLocked: org.plan === 'beta' },
    audit: [
      { source: 'billing', createdAt: ago(60), organizationId: org.id, organizationName: org.name, action: 'review', targetId: null, actor: 'admin:web:jin', detail: `free -> ${org.plan} v1` },
      { source: 'owner', createdAt: ago(40), organizationId: org.id, organizationName: org.name, action: 'agent.create', targetId: org.agents[0]?.id ?? null, actor: org.ownerEmail, detail: null },
    ],
  };
}

function session(): unknown {
  return { actor: 'admin:web:jin', target: { kind: 'local', where: '미리보기 — 가짜 데이터(DB 없음)' }, billingOperator: true, idleMinutes: 30, maxHours: 8 };
}

/** `--hosted`(ops.atmark.ai 화면) — 로그인 상태 하나(처음엔 로그아웃). 쿠키 없이 흉내만 낸다. */
const hostedState = { signedIn: false };

const OPERATORS = [
  { id: uuid(101), email: 'jin@atmark.example', status: 'active', origin: 'cli', requestedAt: null, decidedAt: null, createdAt: ago(60 * 24 * 30) },
  { id: uuid(102), email: 'new-ops@atmark.example', status: 'requested', origin: 'console', requestedAt: ago(42), decidedAt: null, createdAt: ago(42) },
  { id: uuid(103), email: 'helper@atmark.example', status: 'active', origin: 'console', requestedAt: ago(60 * 24 * 9), decidedAt: ago(60 * 24 * 8), createdAt: ago(60 * 24 * 9) },
  { id: uuid(104), email: 'old@atmark.example', status: 'revoked', origin: 'console', requestedAt: ago(60 * 24 * 20), decidedAt: ago(60 * 24 * 19), createdAt: ago(60 * 24 * 20) },
];

function fakeHostedApi(method: string, path: string): { status: number; body: unknown } | null {
  const parts = path.split('/').filter(Boolean).slice(1);
  const [head, id, sub] = parts;
  if (head === 'auth') {
    if (id === 'request') return { status: 202, body: { sent: true } };
    if (id === 'verify') {
      hostedState.signedIn = true;
      return { status: 200, body: { outcome: 'session', csrf: 'preview-csrf' } };
    }
    if (id === 'logout') {
      hostedState.signedIn = false;
      return { status: 200, body: { revoked: 1 } };
    }
    if (id === 'step-up' && sub === undefined) return { status: 200, body: { action: 'org.reject', targetRef: 'K7QZ' } };
    if (id === 'step-up' && sub === 'verify') return { status: 200, body: { action: 'org.reject', targetRef: 'K7QZ' } };
  }
  if (!hostedState.signedIn) return { status: 401, body: { error: 'session_invalid', detail: '로그인이 필요하다.' } };
  if (method === 'GET' && head === 'session') {
    return { status: 200, body: { email: 'jin@atmark.example', operatorId: uuid(101), expiresAt: new Date(now + 8 * 3_600_000).toISOString(), csrf: 'preview-csrf', pendingOperators: 1, idleMinutes: 30, maxHours: 8 } };
  }
  if (method === 'GET' && head === 'operators') return { status: 200, body: { items: OPERATORS, pending: 1, limit: 200 } };
  if (method === 'POST' && head === 'operators') return { status: 200, body: { operatorId: id, result: 'ok' } };
  if (head === 'plans' || head === 'killswitch') return { status: 404, body: { error: 'not_found', detail: '없는 경로다.' } };
  return null;
}

function fakeApi(method: string, path: string, hosted = false): { status: number; body: unknown } {
  const parts = path.split('/').filter(Boolean).slice(1);
  const [head, id] = parts;
  if (hosted) {
    const answer = fakeHostedApi(method, path);
    if (answer !== null) return answer;
  }
  if (method === 'POST') {
    if (head === 'orgs' && parts[2] === 'review') return { status: 200, body: { outcome: { from: 'pending_review', changed: true, suspended: [], revokedTokens: 0, plan: { granted: true, version: 1 } } } };
    if (head === 'orgs' && parts[2] === 'freeze') return { status: 200, body: { organizationId: id, abuseFreeze: true } };
    return { status: 200, body: { result: { changed: true, version: 3, fromPlan: 'beta', status: 'active' } } };
  }
  if (head === 'session') return { status: 200, body: session() };
  if (head === 'catalog') return { status: 200, body: CATALOG };
  if (head === 'dashboard') {
    const pending = ORGS.filter((o) => o.reviewStatus === 'pending_review').length;
    return {
      status: 200,
      body: {
        at: new Date(now).toISOString(),
        organizations: { pendingReview: pending, active: 128, rejected: 6, frozen: 1 },
        signups: { day: 3, week: 17 },
        agents: { active: 212, suspended: 4, provisioning: 5, total: 221 },
        recentSignups: ORGS.slice(0, 8).map((o) => ({ id: o.id, name: o.name, ownerEmail: o.ownerEmail, reviewStatus: o.reviewStatus, createdAt: o.createdAt, agents: o.agents.length })),
        sending: { day: { sent: 1284, denied: 37, failed: 2, queued: 9, received: 406 }, week: { sent: 8410, denied: 221, failed: 11, queued: 9, received: 2977 } },
      },
    };
  }
  if (head === 'board') return { status: 200, body: weeklyBoard() };
  if (head === 'review') {
    return {
      status: 200,
      body: { items: ORGS.filter((o) => o.reviewStatus === 'pending_review').map((o) => ({ id: o.id, name: o.name, ownerEmail: o.ownerEmail, createdAt: o.createdAt, agents: o.agents.length, signupSource: o.signupSource })) },
    };
  }
  if (head === 'orgs' && id === undefined) {
    return {
      status: 200,
      body: {
        limit: 200,
        items: ORGS.map((o) => ({
          id: o.id,
          name: o.name,
          ownerEmail: o.ownerEmail,
          reviewStatus: o.reviewStatus,
          signupSource: o.signupSource,
          abuseFreeze: o.abuseFreeze,
          ownerPaused: false,
          createdAt: o.createdAt,
          plan: { code: o.plan, basis: o.plan === 'free' ? 'missing' : 'row', rowCode: null, source: null, releasedToProvider: false },
          agents: { active: o.agents.filter((a) => a.status !== 'disabled').length, total: o.agents.length, max: o.reviewStatus === 'pending_review' ? 2 : 10 },
        })),
      },
    };
  }
  if (head === 'orgs' && id !== undefined) {
    const org = ORGS.find((o) => o.id === id);
    return org === undefined ? { status: 404, body: { error: 'organization_not_found', detail: '조직이 없다.' } } : { status: 200, body: orgDetail(org) };
  }
  if (head === 'plans') {
    return {
      status: 200,
      body: {
        limit: 200,
        counts: [
          { plan: 'free', organizations: 9 },
          { plan: 'beta', organizations: 112 },
          { plan: 'pro', organizations: 4 },
          { plan: 'team', organizations: 2 },
          { plan: 'scale', organizations: 0 },
          { plan: 'none', organizations: 3 },
        ],
        items: ORGS.filter((o) => o.plan !== 'free').map((o, i) => ({
          id: o.id,
          name: o.name,
          plan: o.plan,
          basis: 'row',
          rowCode: o.plan,
          source: i === 1 ? 'provider' : 'operator',
          cause: i === 1 ? 'provider_event' : 'review',
          version: 2 + i,
          graceUntil: null,
          releasedToProvider: false,
          updatedAt: ago(60 * (i + 1) * 7),
        })),
      },
    };
  }
  if (head === 'killswitch') {
    return {
      status: 200,
      body: {
        limit: 200,
        frozenOrganizations: ORGS.filter((o) => o.abuseFreeze).map((o) => ({ id: o.id, name: o.name, ownerEmail: o.ownerEmail, reviewStatus: o.reviewStatus, updatedAt: ago(180) })),
        suspendedAgents: ORGS.flatMap((o) =>
          o.agents.filter((a) => a.suspendedBy === 'operator').map((a) => ({ id: a.id, name: a.name, address: a.address, organizationId: o.id, organizationName: o.name, updatedAt: ago(60 * 30) })),
        ),
      },
    };
  }
  if (head === 'audit') {
    const items = ORGS.flatMap((o) => (orgDetail(o) as { audit: { createdAt: string }[] }).audit).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { status: 200, body: { items, limit: 200 } };
  }
  return { status: 404, body: { error: 'not_found' } };
}

export async function startOpsPreview(port: number, hosted = false): Promise<{ server: Server; port: number }> {
  const page = hosted ? buildOpsPage(HOSTED_PAGE_CONFIG) : buildOpsPage();
  const server = createServer((req, res) => {
    {
      const url = new URL(req.url ?? '/', `http://${HOST}`);
      const common = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
      if (url.pathname === '/') {
        res.writeHead(200, { ...common, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': page.csp });
        res.end(page.html);
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        const result = fakeApi(req.method ?? 'GET', url.pathname, hosted);
        res.writeHead(result.status, { ...common, 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result.body));
        return;
      }
      res.writeHead(404, common);
      res.end('not_found');
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port, host: HOST }, () => resolve());
  });
  return { server, port: (server.address() as AddressInfo).port };
}

// ---------- 찍기 ----------

interface Shot {
  readonly id: string;
  readonly hash: string;
  readonly click?: string;
  readonly themes?: readonly ('light' | 'dark')[];
  readonly widths?: readonly ('desktop' | 'mobile')[];
}

const PENDING = ORGS.find((o) => o.reviewStatus === 'pending_review')?.id ?? '';
const ACTIVE = ORGS.find((o) => o.plan === 'team')?.id ?? '';
const SHOTS: readonly Shot[] = [
  { id: 'dashboard', hash: '#/', themes: ['light', 'dark'] },
  { id: 'board', hash: '#/board', themes: ['light', 'dark'] },
  { id: 'review', hash: '#/review', themes: ['light', 'dark'] },
  { id: 'review-detail', hash: `#/review/${PENDING}`, widths: ['mobile'] },
  { id: 'review-approve', hash: `#/review/${PENDING}`, click: '.decide .btn:last-child', widths: ['desktop'] },
  { id: 'review-reject', hash: `#/review/${PENDING}`, click: '.decide .btn.danger', widths: ['desktop'] },
  { id: 'orgs', hash: '#/orgs' },
  { id: 'org', hash: `#/org/${ACTIVE}` },
  { id: 'plans', hash: '#/plans' },
  { id: 'kill', hash: '#/kill' },
  { id: 'audit', hash: '#/audit' },
];
const SIZES = { desktop: { width: 1440, height: 900, mobile: false }, mobile: { width: 390, height: 844, mobile: true } } as const;

async function takeShots(outDir: string): Promise<void> {
  mkdirSync(outDir, { recursive: true });
  const preview = await startOpsPreview(0);
  let chrome: ChromeHandle | null = null;
  const problems: string[] = [];
  try {
    chrome = await launchChrome();
    const tab = (await (await fetch(`http://127.0.0.1:${String(chrome.port)}/json/new?about:blank`, { method: 'PUT' })).json()) as { webSocketDebuggerUrl: string };
    const cdp = new Cdp();
    await cdp.connect(tab.webSocketDebuggerUrl);
    const errors: string[] = [];
    cdp.on('Runtime.exceptionThrown', (p) => errors.push(JSON.stringify(p['exceptionDetails']).slice(0, 300)));
    cdp.on('Runtime.consoleAPICalled', (p) => {
      if (p['type'] === 'error' || p['type'] === 'warning') errors.push(JSON.stringify(p['args']).slice(0, 300));
    });
    cdp.on('Log.entryAdded', (p) => {
      const entry = p['entry'] as Record<string, unknown>;
      if (entry['level'] === 'error' || entry['source'] === 'security') errors.push(String(entry['text']).slice(0, 300));
    });
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    // 세션 토큰 자리(가짜 서버는 보지 않는다) — 부트스트랩 대신.
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `try{sessionStorage.setItem('atmark.ops.token','${'x'.repeat(43)}')}catch(e){}` });
    for (const shot of SHOTS) {
      for (const width of shot.widths ?? (['desktop', 'mobile'] as const)) {
        for (const theme of shot.themes ?? (['light'] as const)) {
          errors.length = 0;
          const size = SIZES[width];
          await cdp.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: size.mobile });
          await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
          await cdp.send('Page.navigate', { url: 'about:blank' });
          await delay(100);
          const loaded = new Promise<void>((resolve) => cdp.on('Page.loadEventFired', () => resolve()));
          await cdp.send('Page.navigate', { url: `http://${HOST}:${String(preview.port)}/${shot.hash}` });
          await Promise.race([loaded, delay(8000)]);
          await delay(700);
          if (shot.click !== undefined) {
            await cdp.send('Runtime.evaluate', { expression: `(function(){var b=document.querySelector(${JSON.stringify(shot.click)});if(b)b.click();})()` });
            await delay(300);
          }
          const overflow = await cdp.send<{ result: { value: boolean } }>('Runtime.evaluate', {
            expression: 'document.scrollingElement.scrollWidth > window.innerWidth + 1',
            returnByValue: true,
          });
          const metrics = await cdp.send<{ cssContentSize: { width: number; height: number } }>('Page.getLayoutMetrics');
          const height = shot.click === undefined ? Math.max(size.height, Math.ceil(metrics.cssContentSize.height)) : size.height;
          const png = await cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: size.width, height, scale: 1 }, captureBeyondViewport: true });
          const file = `${shot.id}.${width}.${theme}.png`;
          writeFileSync(join(outDir, file), Buffer.from(png.data, 'base64'));
          const flags = [overflow.result.value ? '가로 스크롤' : '', errors.length > 0 ? `오류 ${String(errors.length)}: ${errors.join(' | ')}` : ''].filter((x) => x !== '');
          if (flags.length > 0) problems.push(`${file}: ${flags.join(' · ')}`);
          console.log(`[ui:ops] ${file}${flags.length > 0 ? ` ⚠ ${flags.join(' · ')}` : ''}`);
        }
      }
    }
    cdp.close();
  } finally {
    if (chrome !== null) killChrome(chrome);
    await new Promise<void>((resolve) => preview.server.close(() => resolve()));
  }
  writeFileSync(join(outDir, 'report.md'), problems.length === 0 ? '문제 없음\n' : `${problems.join('\n')}\n`);
  console.log(problems.length === 0 ? `[ui:ops] ${outDir} — 문제 없음` : `[ui:ops] 문제 ${String(problems.length)}건 — ${join(outDir, 'report.md')}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const index = argv.indexOf('--shots');
  if (index >= 0) {
    const out = argv[index + 1];
    if (out === undefined) throw new Error('--shots <폴더>');
    await takeShots(out);
    return;
  }
  if (argv.includes('--hosted')) {
    const { port } = await startOpsPreview(OPS_PREVIEW_PORT, true);
    console.log(`[ui:ops] http://${HOST}:${String(port)}/ — 호스팅 화면(ops.atmark.ai), 가짜 데이터. 아무 주소 · 아무 6자리로 로그인한다. Ctrl-C 로 끈다.`);
    return;
  }
  const { port } = await startOpsPreview(OPS_PREVIEW_PORT);
  console.log(`[ui:ops] http://${HOST}:${String(port)}/#/ — 가짜 데이터(DB 없음). Ctrl-C 로 끈다.`);
  console.log(`[ui:ops] 처음 한 번: http://${HOST}:${String(port)}/#t=${'x'.repeat(43)}`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
