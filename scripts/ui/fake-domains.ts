/**
 * scripts/ui/fake-domains.ts — 미리보기(`preview.ts` → `fake-api.ts`)의 고객 도메인 가짜 응답(ADR-0014 단계 4 M4).
 *
 * 모양은 서버 그대로다: 목록 `DomainListView`(`src/admin/ops/domains.ts`) · 한 개 `DomainDetailView`(+ `records` = 계약의 `dnsRecordsFor`
 * 를 **그대로 불러** 만든다 — 콘솔이 보는 레코드 이름 · 값이 운영과 같은 함수에서 나온다). 레코드별 상태 `checks` 도 서버의 `domainChecksOf` 를
 * 그대로 부른다. 상태마다 한 도메인씩 둔다 — 한 개 보기는 id 로 고른다(`#/domains/<id>`), 목록에는 여러 상태가 섞인 도메인을 올린다.
 *
 * 시나리오(`?_scn=`):
 *   기본(없음)      켜짐 · 목록 = 준비됨 · 사용 중(반송 확인 중) · 확인 중 · 정지(서명) · 확인 대기 둘 + 제거됨 하나(6 / 10 — Scale)
 *   dom-none        메뉴 켜짐 · 도메인 0(빈 상태)
 *   dom-off         허용 목록 밖 조직 — 도메인 화면이 잠김(베타 · 초대 전용, `features.customDomains:false`)
 *   dom-closed      허용 목록에서 빠졌지만 도메인이 남은 조직 — 메뉴는 보이고 추가는 없다(`enabled:false`)
 *   dom-primary     a1 의 대표 주소가 고객 도메인(founder@agents.example.com) — @atmark.ai 주소는 꺼져 있다
 *   dom-noaddr      a1 이 "대표 주소 없음" — @atmark.ai 별칭은 살아 있다(별칭으로는 계속 주고받는다)
 *   dom-noaddr-bare a1 이 "대표 주소 없음" · 별칭도 없다(메일을 주고받지 않는다)
 *   dom-errors      도메인 추가가 입력에 따라 거부 코드를 돌려준다(아래 `ADD_ERRORS`)
 *   dom-limit       한도에 닿은 조직(추가 단추 잠김)
 *   dom-create      에이전트가 한도 안(셋) — 새 에이전트 대화상자의 주소 도메인 고르기를 볼 때
 *   dom-dc          DNS 업체가 Domain Connect 를 지원한다 — 확인 전 도메인에 `Cloudflare로 연결` 단추(누르면 바깥 예시 주소로)
 *   dom-preparing   추가 직후 DKIM 토큰이 늦다 — 추가 응답 · 처음 몇 번의 상세가 "레코드를 준비하고 있습니다"(`recordsReady:false`), 그 뒤 전부
 *
 * 한 번에 설정(2026-10 one-shot): 확인 대기(pending)도 처음부터 레코드 **전부**(DKIM 포함)를 돌려준다. "준비 중" 한 개 보기는 `#/domains/pending-prep`
 * (언제나 토큰 없음 — 30초 뒤 "새로고침" 줄까지 볼 수 있다). Domain Connect 단추는 `#/domains/pending-dc`(언제나 지원) · 돌아오기는
 * `/app?dc=1&d=pending-dc#/domains`.
 */

import { domainChecksOf } from '../../src/admin/ops/domains';
import { dnsRecordsFor } from '../../src/domains/contract';

type Json = Record<string, unknown>;
export interface DomainFake {
  readonly status: number;
  readonly json: unknown;
}

/** 미리보기 시계 — 남은 시간 · 다음 확인이 "그럴듯한" 값이 되게 지금 기준으로 만든다. */
const NOW = Date.now();
const ago = (h: number): string => new Date(NOW - h * 3_600_000).toISOString();
const later = (h: number): string => new Date(NOW + h * 3_600_000).toISOString();

const TOKEN = 'q3Jx9vN0Lr8tWm2Yc5Pa7Hk1Ds4Fg6Bz0Qe8Uo2Ti3';
const DKIM = ['n4q6yzxkm2m7d3tjxw5v2cqaqhb4lk7d', 'c5a7lw2pjv3t6y4xrnq2ezk7fh3m5sgd', 'w2r6mkd4s7xq3pyh5vbn2jtz6lc4fae7'];

interface Spec {
  readonly domain?: string;
  readonly status: 'pending' | 'verifying' | 'verified' | 'suspended' | 'removed';
  readonly suspendedReason?: string;
  readonly pendingReason?: string;
  readonly dkim?: boolean;
  readonly dkimStatus?: string;
  readonly mailFromStatus?: string;
  readonly inboundMxStatus?: string;
  readonly createdH: number;
  readonly primaryAgents?: number;
  readonly liveAddresses?: number;
}

const SPECS: Readonly<Record<string, Spec>> = {
  pending: { domain: 'mail.lumen.example', status: 'pending', dkim: true, createdH: 3 },
  'pending-prep': { domain: 'desk.lumen.example', status: 'pending', dkim: false, createdH: 0.01 },
  // 업체가 Domain Connect 를 지원하는 확인 대기 도메인(시나리오 없이도 — 미리보기 쿠키가 다른 미리보기와 부딪혀도 보이게).
  'pending-dc': { domain: 'agents.harbor.example', status: 'pending', dkim: true, createdH: 0.2 },
  'pending-mail': { domain: 'team.lumen.example', status: 'pending', pendingReason: 'subdomain_has_mail', dkim: true, createdH: 20 },
  'pending-taken': { domain: 'bots.harbor.example', status: 'pending', pendingReason: 'registrable_taken', dkim: true, createdH: 30 },
  'pending-late': { domain: 'ops.lumen.example', status: 'pending', dkim: true, dkimStatus: 'pending', mailFromStatus: 'pending', createdH: 60 },
  verifying: { domain: 'helpdesk.example.com', status: 'verifying', dkim: true, dkimStatus: 'pending', mailFromStatus: 'pending', inboundMxStatus: 'missing', createdH: 5 },
  'verifying-dkim': { domain: 'helpdesk.example.com', status: 'verifying', dkim: true, dkimStatus: 'pending', mailFromStatus: 'pending', inboundMxStatus: 'ses', createdH: 8 },
  verified: { domain: 'support.example.com', status: 'verified', dkim: true, dkimStatus: 'success', mailFromStatus: 'pending', inboundMxStatus: 'ses', createdH: 240, liveAddresses: 3, primaryAgents: 0 },
  ready: { domain: 'agents.example.com', status: 'verified', dkim: true, dkimStatus: 'success', mailFromStatus: 'success', inboundMxStatus: 'ses', createdH: 400, liveAddresses: 4, primaryAgents: 2 },
  'susp-ownership': { domain: 'agents.example.com', status: 'suspended', suspendedReason: 'ownership_lost', dkim: true, dkimStatus: 'success', mailFromStatus: 'success', inboundMxStatus: 'ses', createdH: 900, liveAddresses: 4, primaryAgents: 2 },
  'susp-dkim': { domain: 'outreach.example.com', status: 'suspended', suspendedReason: 'dkim_failed', dkim: true, dkimStatus: 'failed', mailFromStatus: 'success', inboundMxStatus: 'ses', createdH: 900, liveAddresses: 4, primaryAgents: 2 },
  'susp-reputation': { domain: 'agents.example.com', status: 'suspended', suspendedReason: 'reputation', dkim: true, dkimStatus: 'success', mailFromStatus: 'success', inboundMxStatus: 'ses', createdH: 900, liveAddresses: 4, primaryAgents: 2 },
  'susp-operator': { domain: 'agents.example.com', status: 'suspended', suspendedReason: 'operator', dkim: true, dkimStatus: 'success', mailFromStatus: 'success', inboundMxStatus: 'ses', createdH: 900, liveAddresses: 4, primaryAgents: 2 },
  'susp-plan': { domain: 'agents.example.com', status: 'suspended', suspendedReason: 'plan_limit', dkim: true, dkimStatus: 'success', mailFromStatus: 'success', inboundMxStatus: 'ses', createdH: 900, liveAddresses: 4, primaryAgents: 2 },
  removed: { domain: 'old.example.com', status: 'removed', dkim: true, dkimStatus: 'success', mailFromStatus: 'success', inboundMxStatus: 'ses', createdH: 1200 },
};

function registrableOf(domain: string): string {
  return domain.split('.').slice(-2).join('.');
}

function view(id: string, s: Spec): Json {
  const domain = s.domain ?? 'agents.example.com';
  const expiry = s.status === 'pending' || s.status === 'verifying' ? new Date(NOW - s.createdH * 3_600_000 + 72 * 3_600_000).toISOString() : null;
  return {
    id,
    domain,
    registrableDomain: registrableOf(domain),
    status: s.status,
    suspendedReason: s.suspendedReason ?? null,
    pendingReason: s.pendingReason ?? null,
    dkimStatus: s.dkimStatus ?? 'not_started',
    mailFromStatus: s.mailFromStatus ?? 'not_started',
    inboundMxStatus: s.inboundMxStatus ?? (s.pendingReason === 'subdomain_has_mail' ? 'other' : 'unknown'),
    createdAt: ago(s.createdH),
    verifiedAt: s.status === 'verified' || s.status === 'suspended' ? ago(s.createdH - 2) : null,
    suspendedAt: s.status === 'suspended' ? ago(30) : null,
    removedAt: s.status === 'removed' ? ago(48) : null,
    lastCheckedAt: s.status === 'removed' ? ago(50) : ago(0.3),
    nextCheckAt: s.status === 'removed' ? null : later(s.status === 'pending' ? 0.4 : 5.5),
    expiresAt: expiry,
    removalDueAt: s.suspendedReason === 'ownership_lost' ? later(14 * 24 - 30) : null,
    registrationExpiresAt: null,
    checks: domainChecksOf({
      status: s.status,
      suspendedReason: (s.suspendedReason ?? null) as never,
      txtVerifiedAt: s.status === 'pending' ? null : new Date(NOW - (s.createdH - 1) * 3_600_000),
      dkimStatus: (s.dkimStatus ?? 'not_started') as never,
      mailFromStatus: (s.mailFromStatus ?? 'not_started') as never,
      inboundMxStatus: (s.inboundMxStatus ?? (s.pendingReason === 'subdomain_has_mail' ? 'other' : 'unknown')) as never,
    }),
  };
}

function detail(id: string, o: { readonly preparing?: boolean } = {}): Json | null {
  const s = SPECS[id];
  if (s === undefined) return null;
  const v = view(id, s);
  const domain = String(v['domain']);
  const tokens = s.dkim === true && o.preparing !== true;
  return {
    ...v,
    records: s.status === 'removed' ? [] : dnsRecordsFor(domain, TOKEN, tokens ? DKIM : []),
    recordsReady: s.status === 'removed' || tokens,
    primaryAgents: s.primaryAgents ?? 0,
    liveAddresses: s.liveAddresses ?? 0,
  };
}

/** `dom-preparing` — 추가한 도메인의 상세를 몇 번 읽어야 토큰이 온다(즉시 실행이 `busy` 였던 경우 — 콘솔은 2초 간격으로 다시 읽는다). */
const PREPARING_READS = 3;
let preparingReads = 0;

/**
 * `dom-dc` 의 적용 URL — 미리보기는 서명하지 않는다(누르면 바깥 예시 주소로 떠난다). 돌아오기 처리는 `/app?_scn=dom-dc&dc=1&d=pending#/domains` 로 본다
 * (시나리오는 쿠키라서 콘솔이 쿼리를 지워도 남는다).
 */
const DC_PREVIEW_URL = 'https://example.com/atmark-domain-connect-preview';

function list(ids: readonly string[], o: { enabled?: boolean; limit?: number } = {}): Json {
  const items = ids.map((id) => view(id, SPECS[id] as Spec));
  return { enabled: o.enabled ?? true, limit: o.limit ?? 3, pendingMax: 2, live: items.filter((x) => x['status'] !== 'removed').length, items };
}

/** 도메인 추가가 거부되는 입력(`dom-errors`) — 서버 판정 코드 그대로. 그 밖의 입력은 201(확인 대기). */
const ADD_ERRORS: ReadonlyArray<readonly [RegExp, number, string]> = [
  [/^[a-z0-9-]+\.(com|net|org|io|example)$/, 400, 'registrable_apex'],
  [/xn--/, 400, 'idn_label'],
  [/gmail\.com$|naver\.com$|outlook\.com$/, 400, 'shared_mailbox_domain'],
  [/atmark\.ai$/, 400, 'platform_domain'],
  [/^taken\./, 409, 'domain_exists'],
  [/^limit\./, 409, 'plan_custom_domains_exceeded'],
  [/^pending\./, 409, 'custom_domains_pending_exceeded'],
  [/^often\./, 429, 'domain_add_rate_limited'],
];

/** 기본 목록 — 여러 상태가 섞인 조직(준비됨 · 사용 중 · 확인 중 · 정지 · 확인 대기 둘 · 제거됨). */
const DEFAULT_LIST = ['ready', 'verified', 'verifying-dkim', 'susp-dkim', 'pending', 'pending-mail', 'removed'] as const;

/**
 * `/api/domains*` 한 요청 → 가짜 응답(없으면 `null` — 다른 경로). 시나리오별 목록 · 한 개 · 추가 · 지금 확인 · 제거.
 */
export function domainsRoute(method: string, rawUrl: string, body: unknown, scenario?: string): DomainFake | null {
  if (!rawUrl.startsWith('/api/domains')) return null;
  const path = rawUrl.split('?')[0] ?? '';
  if (path === '/api/domains' && method === 'GET') {
    if (scenario === 'dom-none') return { status: 200, json: list([]) };
    if (scenario === 'dom-off') return { status: 200, json: list([], { enabled: false }) };
    if (scenario === 'dom-closed') return { status: 200, json: list(['ready', 'removed'], { enabled: false }) };
    if (scenario === 'dom-limit') return { status: 200, json: list(['ready', 'verifying-dkim', 'pending'], { limit: 3 }) };
    if (scenario === 'dom-primary' || scenario === 'dom-noaddr' || scenario === 'dom-noaddr-bare') return { status: 200, json: list(scenario === 'dom-primary' ? ['ready'] : ['removed']) };
    return { status: 200, json: list(DEFAULT_LIST, { limit: 10 }) };
  }
  if (path === '/api/domains' && method === 'POST') {
    const domain = String((body as { domain?: unknown } | null)?.domain ?? '').trim().toLowerCase();
    if (scenario === 'dom-errors') {
      for (const [re, status, code] of ADD_ERRORS) if (re.test(domain)) return { status, json: { error: code } };
    }
    // 한 번에 설정 — 추가 응답에 레코드 전부(즉시 실행 `provisioned`). `dom-preparing` 이면 토큰 전(`waiting`) — 콘솔이 다시 읽는다.
    const preparing = scenario === 'dom-preparing';
    if (preparing) preparingReads = 0;
    const base = detail(preparing ? 'pending-prep' : 'pending') as Json;
    return {
      status: 201,
      json: {
        item: { ...base, id: preparing ? 'pending-prep' : 'pending', domain, registrableDomain: registrableOf(domain), records: dnsRecordsFor(domain, TOKEN, preparing ? [] : DKIM) },
        provision: preparing ? 'waiting' : 'provisioned',
      },
    };
  }
  const one = /^\/api\/domains\/([^/]+)(\/check|\/connect)?$/.exec(path);
  if (one === null) return { status: 404, json: { error: 'not_found' } };
  const id = decodeURIComponent(one[1] ?? '');
  // `dom-preparing` 의 추가한 도메인은 몇 번 읽은 뒤 토큰이 온다. 그 밖의 `pending-prep` 은 언제나 준비 중(30초 뒤 "새로고침" 줄).
  const ready = scenario === 'dom-preparing' && id === 'pending-prep' && one[2] === undefined && ++preparingReads > PREPARING_READS;
  const item = ready ? { ...(detail('pending') as Json), id, domain: 'desk.lumen.example', records: dnsRecordsFor('desk.lumen.example', TOKEN, DKIM) } : detail(id);
  if (item === null) return { status: 404, json: { error: 'domain_not_found' } };
  // Domain Connect — GET 은 지원 여부만(단추), POST 가 발급(누를 때만 — 운영은 감사 · 조직 시간당 10).
  if (one[2] === '/connect' && (method === 'GET' || method === 'POST')) {
    const open = (item['status'] === 'pending' || item['status'] === 'verifying') && item['recordsReady'] === true;
    if (!open) return { status: 409, json: { error: 'domain_connect_phase_unavailable' } };
    if (item['pendingReason'] === 'subdomain_has_mail' || item['inboundMxStatus'] === 'other') return { status: 409, json: { error: 'domain_connect_existing_mail' } };
    if (scenario !== 'dom-dc' && id !== 'pending-dc') return { status: 200, json: { supported: false } };
    if (method === 'GET') return { status: 200, json: { supported: true, providerName: 'Cloudflare' } };
    return { status: 200, json: { supported: true, providerName: 'Cloudflare', applyUrl: DC_PREVIEW_URL, records: item['records'] } };
  }
  if (one[2] === '/check' && method === 'POST') return { status: 202, json: { id, nextCheckAt: new Date().toISOString() } };
  if (one[2] === undefined && method === 'GET') return { status: 200, json: { item } };
  if (one[2] === undefined && method === 'DELETE') {
    return { status: 200, json: { item: { ...item, status: 'removed' }, replayed: false, primaryAgents: item['primaryAgents'], releasedAddresses: 0 } };
  }
  return { status: 405, json: { error: 'method_not_allowed' } };
}

/** `features` — 메뉴를 숨기는 시나리오(`dom-off`)만 끈다. */
export function domainFeatureOn(scenario?: string): boolean {
  return scenario !== 'dom-off';
}

/** 시나리오별 a1 주소 — `dom-primary`(고객 도메인 대표) · `dom-noaddr`(주소 없음). 그 밖은 `undefined`(하네스 그대로). */
export function agentAddressFor(scenario?: string): string | null | undefined {
  if (scenario === 'dom-primary') return 'founder@agents.example.com';
  if (scenario === 'dom-noaddr' || scenario === 'dom-noaddr-bare') return null;
  return undefined;
}

/** 시나리오 `dom-create` — 에이전트 목록을 한도 안(셋)으로 줄인다(새 에이전트 단추가 잠기지 않게). */
export function agentCountFor(scenario?: string): number | undefined {
  return scenario === 'dom-create' ? 3 : undefined;
}

/** a1 의 주소 목록(`GET /api/agents/a1/aliases`) — 대표 · 별칭이 도메인 상태를 보여 주게. */
export function aliasesFor(scenario?: string): Json | null {
  const q = { active: 3, activeMax: 5, issued: 4, issuedMax: 20, overLimit: false };
  if (scenario === 'dom-primary') {
    return {
      items: [
        { id: 'p1', address: 'founder@agents.example.com', primary: true, anchor: false, status: 'active', createdAt: ago(200), retiredAt: null },
        { id: 'p2', address: 'billing@agents.example.com', primary: false, anchor: false, status: 'active', createdAt: ago(150), retiredAt: null },
        { id: 'p3', address: 'founder-desk@atmark.ai', primary: false, anchor: false, status: 'active', createdAt: ago(120), retiredAt: null },
      ],
      aliases: q,
    };
  }
  if (scenario === 'dom-noaddr-bare') return { items: [], aliases: { ...q, active: 0, issued: 1 } };
  if (scenario === 'dom-noaddr') {
    return {
      items: [{ id: 'n2', address: 'sales@atmark.ai', primary: false, anchor: false, status: 'active', createdAt: ago(150), retiredAt: null }],
      aliases: { ...q, active: 1, issued: 3 },
    };
  }
  // 기본: @atmark.ai 대표(앵커) + 고객 도메인 별칭(대표로 고를 수 있다) + @atmark.ai 별칭.
  return {
    items: [
      { id: 'd1', address: 'founder@atmark.ai', primary: true, anchor: true, status: 'active', createdAt: ago(400), retiredAt: null },
      { id: 'd5', address: 'founder@agents.example.com', primary: false, anchor: false, status: 'active', createdAt: ago(100), retiredAt: null },
      { id: 'd2', address: 'sales@atmark.ai', primary: false, anchor: false, status: 'active', createdAt: ago(300), retiredAt: null },
    ],
    aliases: q,
  };
}
