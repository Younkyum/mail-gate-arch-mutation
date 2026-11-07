/**
 * 콘솔 앱 스크립트를 **가짜 DOM 위에서 실제로 돌리는** 하네스 — `admin-console-*.test.ts` 가 같이 쓴다. 가짜 API 는 v4 계약
 * (`.omc/handoffs/console-v4-api.md` — 토큰 목록·발급·폐기·이름, 통계, 신원 키 지문, 목록의 신원 상태)까지 흉내 낸다.
 *
 * 마크업의 `id` 가 있는 요소만 만든다(스크립트는 `getElementById` 로만 찾는다). 처음 상태는 마크업에서 읽는다: `hidden`, `class`,
 * 그리고 `aria-*`·`type` 같은 속성(ⓘ 토글팁이 `aria-controls` 로 팝오버를 찾는다). 문서 수준 리스너(`document.addEventListener` —
 * ⓘ 의 위임 click · Esc keydown · 바깥 pointerdown · focusout)는 `World.doc()` 으로 쏜다. 레이아웃은 없다(`window.innerWidth` 가
 * 없어 팝오버 좌표 계산은 건너뛴다 — 좌표는 실제 Chrome 확인에서 본다).
 */

import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

import { MESSAGES } from '../../../src/admin/ui/i18n';
import { adminUiAsset, renderAppPage, type AdminUiPage, type Lang } from '../../../src/admin/ui/index';
import { dnsRecordsFor } from '../../../src/domains/contract';

export const HANGUL = /[가-힣]/;
/** 한국어 원문 → 그 언어의 화면 문구(영어 사전에 없으면 눈에 띄는 자리표시). */
export const t = (lang: Lang, ko: string): string => (lang === 'ko' ? ko : (MESSAGES.en[ko] ?? `(없는 키 ${ko})`));

/** 콘솔 UI 원문 폴더와 그 안의 모든 .ts — B0 분할 뒤 원문을 읽는 테스트가 쓴다(`app.ts` 한 파일이 아니다). */
export const UI_DIR = join(__dirname, '../../../src/admin/ui');
export function uiSources(dir = UI_DIR): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? uiSources(p) : name.endsWith('.ts') ? [p] : [];
  });
}

/** 서빙되는 페이지가 싣는 외부 자산 두 모양(`src/admin/ui/page.ts` `buildPage`) — 이 모양 그대로만 되돌린다. */
export const STYLESHEET_TAG = /<link rel="stylesheet" href="(\/_assets\/[0-9a-f]{16}\/console\.css)" integrity="(sha384-[A-Za-z0-9+/]+={0,2})">/g;
export const SCRIPT_TAG = /<script src="(\/_assets\/[0-9a-f]{16}\/page\.js)" integrity="(sha384-[A-Za-z0-9+/]+={0,2})"><\/script>/g;

/** 자산 본문 — 백엔드가 내는 그 함수(`adminUiAsset`)로 찾고, SRI 를 본문에서 **직접** 잰다(모듈이 알려 준 값을 믿지 않는다). */
/** CSP 안의 자산 URL — 운영 콘솔 출처 + 정확한 자산 경로(`buildCsp`). 외부 호스트가 없다는 단언이 이 두 URL 만 빼고 본다. */
export const CSP_ASSET_URL = /https:\/\/console\.atmark\.ai\/_assets\/[0-9a-f]{16}\/(?:page\.js|console\.css)/g;

export function assetBody(path: string, integrity: string): string {
  const asset = adminUiAsset(path);
  if (asset === undefined) throw new Error(`자산 없음: ${path}`);
  const sri = `sha384-${createHash('sha384').update(asset.body, 'utf8').digest('base64')}`;
  if (sri !== integrity) throw new Error(`SRI 불일치: ${path}`);
  return asset.body;
}

/**
 * 페이지의 외부 자산(스타일시트·페이지 스크립트)을 본문으로 되돌려 끼운 HTML — 자산을 빼기 전의 인라인 HTML 과 같은 문자열이다.
 * 스크립트·스타일 **내용**을 보는 테스트는 이것을 쓴다(서빙 HTML 에는 내용이 없어 `not.toMatch` 가 공허하게 통과한다).
 * 서빙 모양(CSP·태그)을 보는 테스트는 `page.html` 을 그대로 본다.
 */
export function inlined(page: AdminUiPage | string): string {
  const html = typeof page === 'string' ? page : page.html;
  return html
    .replace(STYLESHEET_TAG, (_m, path: string, integrity: string) => `<style>${assetBody(path, integrity)}</style>`)
    .replace(SCRIPT_TAG, (_m, path: string, integrity: string) => `<script>${assetBody(path, integrity)}</script>`);
}

export function blocks(html: string, tag: 'script' | 'style'): string[] {
  return [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi'))].map((m) => m[1] ?? '');
}

type Listener = (this: FakeNode, ev: FakeEvent) => void;
export interface FakeEvent {
  target: FakeNode;
  key?: string | undefined;
  relatedTarget?: FakeNode | null;
  preventDefault(): void;
  defaultPrevented: boolean;
}

/** 포커스가 옮겨 갈 때 문서의 `activeElement` 를 고친다(부팅 때 연결). */
let onFocus: (node: FakeNode) => void = () => undefined;
/** 요소의 `.click()`(스크립트가 부르는 것 — 파일 저장 링크) — 부팅 때 연결. */
let onClick: (node: FakeNode) => void = () => undefined;
/** 지금 포커스(문서의 `activeElement`) — 모달 `<dialog>` 가 열 때 기억했다가 닫을 때 돌려준다(부팅 때 연결). */
let getActive: () => FakeNode | null = () => null;

export class FakeNode {
  readonly tagName: string;
  readonly children: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  id = '';
  hidden = false;
  disabled = false;
  checked = false;
  value = '';
  type = '';
  title = '';
  placeholder = '';
  href = '';
  download = '';
  open = false;
  className = '';
  onclick: (() => void) | null = null;
  onchange: (() => void) | null = null;
  onclose: (() => void) | null = null;
  /** CSSOM — `el.style.width=` 대입과 `style.setProperty('--h', …)`(신원 카드 색) 둘 다 받는다. */
  readonly style: Record<string, unknown> & { setProperty(k: string, v: string): void; removeProperty(k: string): void } = Object.assign(Object.create(null) as Record<string, unknown>, {
    setProperty(this: Record<string, unknown>, k: string, v: string) {
      this[k] = v;
    },
    removeProperty(this: Record<string, unknown>, k: string) {
      delete this[k];
    },
  });
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Listener[]>();
  private text = '';

  constructor(tag: string, text?: string) {
    this.tagName = tag.toUpperCase();
    if (text !== undefined) this.text = text;
  }

  get classList() {
    const set = () => new Set(this.className.split(/\s+/).filter(Boolean));
    return {
      contains: (c: string) => set().has(c),
      add: (c: string) => {
        const s = set();
        s.add(c);
        this.className = [...s].join(' ');
      },
      remove: (c: string) => {
        const s = set();
        s.delete(c);
        this.className = [...s].join(' ');
      },
      toggle: (c: string, on?: boolean) => {
        const s = set();
        const want = on === undefined ? !s.has(c) : on;
        if (want) s.add(c);
        else s.delete(c);
        this.className = [...s].join(' ');
        return want;
      },
    };
  }
  get firstChild(): FakeNode | null {
    return this.children[0] ?? null;
  }
  get textContent(): string {
    return this.tagName === '#TEXT' ? this.text : this.text + this.children.map((c) => c.textContent).join('');
  }
  set textContent(v: string) {
    for (const c of this.children) c.parentNode = null;
    this.children.length = 0;
    this.text = String(v);
  }
  appendChild(child: FakeNode): FakeNode {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  removeChild(child: FakeNode): FakeNode {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    child.parentNode = null;
    return child;
  }
  setAttribute(k: string, v: string): void {
    this.attributes.set(k, String(v));
  }
  getAttribute(k: string): string | null {
    return this.attributes.get(k) ?? null;
  }
  removeAttribute(k: string): void {
    this.attributes.delete(k);
  }
  /** `.class` 선택자 하나만(ⓘ 위임이 쓰는 모양). */
  closest(selector: string): FakeNode | null {
    if (!selector.startsWith('.')) throw new Error(`하네스는 .class 선택자만 안다: ${selector}`);
    for (let n: FakeNode | null = this; n; n = n.parentNode) if (n.classList.contains(selector.slice(1))) return n;
    return null;
  }
  contains(other: FakeNode | null): boolean {
    for (let n = other; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  addEventListener(type: string, fn: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  dispatch(type: string, target: FakeNode = this): FakeEvent {
    const ev: FakeEvent = {
      target,
      defaultPrevented: false,
      preventDefault() {
        ev.defaultPrevented = true;
      },
    };
    for (const fn of this.listeners.get(type) ?? []) fn.call(this, ev);
    return ev;
  }
  focus(): void {
    onFocus(this);
  }
  click(): void {
    onClick(this);
    this.dispatch('click');
  }
  reset(): void {}
  /** 브라우저의 모달 `<dialog>` 처럼: 여는 순간의 포커스를 기억했다가, 닫을 때(`close` 이벤트보다 먼저) 그 요소로 돌려준다. */
  private returnFocus: FakeNode | null = null;
  showModal(): void {
    if (!this.open) this.returnFocus = getActive();
    this.open = true;
  }
  close(): void {
    if (!this.open) return;
    this.open = false;
    const back = this.returnFocus;
    this.returnFocus = null;
    if (back) onFocus(back);
    this.onclose?.();
    this.dispatch('close');
  }
  /** Esc — 브라우저처럼 모달에 `cancel` 을 쏘고, 막히지 않았으면(`preventDefault`) 닫는다. */
  esc(): void {
    if (!this.open) return;
    if (!this.dispatch('cancel').defaultPrevented) this.close();
  }
  /** 보이는 글자(자식 포함) — 탭이 그려졌는지 볼 때. */
  all(): FakeNode[] {
    return [this, ...this.children.flatMap((c) => c.all())];
  }
}

export interface ApiCall {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
  readonly csrf: string | undefined;
}

export const TOKEN = 'atk_agent_T0kenValue-9Zx.abc';
/** 토큰처럼 생긴 것 — 발급 토큰 접두어 `atk_` 뒤에 영숫자. */
export const TOKEN_LIKE = /atk_[A-Za-z0-9]/;

export const AGENT = {
  id: 'a1',
  name: 'founder-agent',
  address: 'founder@atmark.ai',
  status: 'active',
  suspendedBy: null,
  outboundMode: 'allowlist',
  inboundMode: 'all',
  activeTokens: 1,
  createdAt: '2026-09-20T01:00:00Z',
  identityStatus: 'published',
  keyFingerprint: '3f9a0c1d2e4b5a6978c0d1e2f3a4b5c6d7e8f90112233445566778899aabbccd',
};
export const RULE = { id: 'r1', kind: 'domain', value: 'partner.example', createdAt: '2026-09-21T01:00:00Z' };
export const POLICY = {
  outbound: { mode: 'allowlist', legacyMode: null, allow: [RULE], block: [] },
  inbound: { mode: 'all', allow: [], block: [] },
  limits: { per_minute: 10, per_hour: 100, per_day: 500, recipients_per_message: 10 },
  version: 4,
  ruleLimit: 1000,
};
export const OUT_LOG = {
  id: 'm-1',
  at: '2026-09-24T02:00:00Z',
  agentId: 'a1',
  agentName: 'founder-agent',
  from: 'founder@atmark.ai',
  recipients: ['ceo@partner.example'],
  recipientCount: 1,
  subject: 'Quarterly numbers',
  decision: 'denied',
  reasons: ['recipient_not_allowlisted'],
  policyVersion: 4,
};
export const PUBLISHED_IDENTITY = {
  status: 'published',
  did: 'did:web:id.atmark.ai:agents:a1',
  version: 2,
  publishedAt: '2026-09-22T00:00:00Z',
  didDocumentUrl: 'https://id.atmark.ai/agents/a1/did.json',
  passportUrl: 'javascript:alert(1)',
  passportJwsUrl: null,
  contentHash: 'ab'.repeat(32),
  pending: null,
  lastResult: null,
  keyFingerprint: '3f9a0c1d2e4b5a6978c0d1e2f3a4b5c6d7e8f90112233445566778899aabbccd',
  keyAlgorithm: 'ed25519',
};

/** 신원 변경 이력 블록(US-013 — `GET /api/agents/{id}/identity-blocks` 모양). 해시는 모양만 맞춘 값이다(검증은 통합 테스트가 실제 잎으로 한다). */
const H = (c: string): string => c.repeat(64);
export const KEY_FP = '3f9a0c1d2e4b5a6978c0d1e2f3a4b5c6d7e8f90112233445566778899aabbccd';
export const IDENTITY_BLOCKS = {
  format: 'atmark-identity-blocks/v1',
  agentId: 'a1',
  chain: { rule: 'sha256(prev_block_hash || leaf_hash)', genesis: H('0') },
  started: true,
  shredded: false,
  truncated: false,
  missing: [] as { entryId: string; seq: number; at: string; table: string; reason: string | null; leaf: string; leafHash: string; checkpoint: { state: string } }[],
  blocks: [
    { entryId: '901', seq: 3, at: '2026-09-20T01:00:00.000000Z', kind: 'identity.agent_created', changes: [{ field: 'name', value: 'founder-agent', matches: true }, { field: 'status', value: 'provisioning', matches: null }], leaf: '{}', leafHash: H('1'), prevBlockHash: H('0'), blockHash: H('a'), checkpoint: { state: 'checkpointed', epoch: 1830 } },
    { entryId: '902', seq: 4, at: '2026-09-20T01:00:00.000000Z', kind: 'identity.key_bound', changes: [{ field: 'key', value: KEY_FP, matches: true }, { field: 'algorithm', value: 'ed25519', matches: true }], leaf: '{}', leafHash: H('2'), prevBlockHash: H('a'), blockHash: H('b'), checkpoint: { state: 'checkpointed', epoch: 1830 } },
    { entryId: '903', seq: 5, at: '2026-09-20T01:00:00.000000Z', kind: 'identity.address_assigned', changes: [{ field: 'address', value: 'founder@atmark.ai', matches: true }, { field: 'primary', value: true, matches: true }], leaf: '{}', leafHash: H('3'), prevBlockHash: H('b'), blockHash: H('c'), checkpoint: { state: 'checkpointed', epoch: 1830 } },
    { entryId: '904', seq: 6, at: '2026-09-20T01:00:00.000000Z', kind: 'identity.agent_updated', changes: [{ field: 'status', value: 'active', matches: true }], leaf: '{}', leafHash: H('4'), prevBlockHash: H('c'), blockHash: H('d'), checkpoint: { state: 'pending' } },
  ],
  lastCheckpoint: { epoch: 1834, closedAt: '2026-09-24T02:00:00.000000Z' },
  card: { keyFingerprint: KEY_FP, keyAlgorithm: 'ed25519', did: 'did:web:id.atmark.ai:agents:a1', passport: { status: 'published', version: 2, jwsSha256: H('e') }, issuedAt: '2026-09-20T01:00:00Z' },
};

/** 무결성 패널(US-010 메모 모양). 시각은 부팅 시점 기준 — 상대 시각 문구가 흔들리지 않게 분 경계에서 30초 떨어뜨린다. */
export function integrity(now = Date.now()): Record<string, unknown> {
  const ago = (min: number): string => new Date(now - min * 60000).toISOString();
  return {
    origin: 'id.atmark.ai/log/v1',
    started: true,
    log: 'ab12',
    orgTreeSize: 418,
    uncheckpointedLeaves: 6,
    latest: { epoch: 1834, closedAt: ago(12.5), globalTreeSize: 1835, orgHeadSize: 412, published: true },
    vkey: 'id.atmark.ai/log+1a2b3c4d+AR8kT0mJ3sQ9vW2xY5zA7bC1dE4fG6hI8jK0lM2nO4pQ',
    shredded: false,
    anchors: [
      { epoch: 1830, target: 'opentimestamps', endpoint: 'https://a.example', state: 'confirmed', confirmedAt: ago(200) },
      { epoch: 1833, target: 'opentimestamps', endpoint: 'https://b.example', state: 'submitted', confirmedAt: null },
      { epoch: 1834, target: 'rekor', endpoint: 'https://rekor.example', state: 'confirmed', confirmedAt: ago(9.5) },
    ],
  };
}
export const BUNDLE_NAME = 'atmark-log-bundle-1811-1834.json';

/** 토큰(v4 계약 §1 TokenView) — 활성 둘 · 옛 토큰(이름·힌트 없음) 하나 폐기됨. */
export const TOKENS = [
  { id: '3b1f0c52-9d7e-4a51-a1a8-3f4d1c0e2b77', label: 'prod-mcp', hint: 'x7Qa', capabilities: ['messages:send', 'messages:read', 'audit:read', 'agent:read_self'], createdAt: '2026-09-24T05:02:00.000Z', expiresAt: null, lastUsedAt: '2026-09-25T05:59:00.000Z', revokedAt: null, status: 'active' },
  { id: '5c2e1d63-0e8f-4b62-b2b9-4a5e2d1f3c88', label: 'laptop', hint: '9kLm', capabilities: ['messages:send', 'messages:read'], createdAt: '2026-09-25T01:00:00.000Z', expiresAt: '2026-12-24T01:00:00.000Z', lastUsedAt: null, revokedAt: null, status: 'active' },
  { id: '7d3f2e74-1f90-4c73-83ca-5b6f3e2a4d99', label: null, hint: null, capabilities: ['messages:send'], createdAt: '2026-09-22T01:00:00.000Z', expiresAt: null, lastUsedAt: '2026-09-23T01:00:00.000Z', revokedAt: '2026-09-24T01:00:00.000Z', status: 'revoked' },
];
export const NEW_TOKEN = 'atk_agent_N3wT0kenValueForTheIssueFlow-abcdefghijkl';
/** 통계(v4 계약 §4) — 조직 · 에이전트. */
export const STATS = {
  days: 7,
  since: '2026-09-18T06:00:00.000Z',
  agentId: null,
  outbound: { total: 140, sent: 128, denied: 5, pending: 0, failed: 2, sending: 0, queued: 5 },
  inbound: { total: 350, delivered: 336, quarantined: 6, rejected: 8 },
  byAgent: [{ agentId: 'a1', sent: 42, received: 118 }],
};

type Mocked = { status: number; json: unknown; headers?: Record<string, string> };
/**
 * 테스트마다 덮어쓰는 응답(`"METHOD url"` 또는 `url`). 각 테스트 파일이 `afterEach` 로 비운다.
 * 배열이면 호출마다 앞에서 하나씩 쓰고 마지막 것은 남는다(503 → 200 같은 순서 — 재시도 테스트). `undefined` 칸은 기본 응답이다.
 */
export const OVERRIDE = new Map<string, Mocked | (Mocked | undefined)[]>();

/** 멤버·초대(P1 §3.3) — 테스트가 고칠 수 있게 내보낸다(`resetTeam()` 이 처음 값으로 되돌린다). */
export const TEAM = {
  members: [] as { userId: string; email: string; role: string; joinedAt: string; primary: boolean; you: boolean }[],
  invites: [] as { id: string; email: string; role: string; createdAt: string; expiresAt: string; status: string }[],
  keys: [] as Record<string, unknown>[],
  aliases: [] as { id: string; address: string; primary: boolean; status: 'active' | 'retired'; createdAt: string; retiredAt: string | null }[],
  webhooks: [] as WebhookRow[],
  deliveries: [] as DeliveryRow[],
  webhookRegistrationsToday: 0,
};
export const ORG_KEY = 'atk_org_Org4piKeyValueForTheIssueFlow-0123456789abcdef';
export const MEMBERS = [
  { userId: 'u1', email: 'owner@example.com', role: 'owner', joinedAt: '2026-09-20T01:00:00Z', primary: true, you: true },
  { userId: 'u2', email: 'ops@example.com', role: 'admin', joinedAt: '2026-09-22T01:00:00Z', primary: false, you: false },
  { userId: 'u3', email: 'viewer@example.com', role: 'member', joinedAt: '2026-09-24T01:00:00Z', primary: false, you: false },
];
export const INVITES = [{ id: 'i1', email: 'new@example.com', role: 'member', createdAt: '2026-09-25T01:00:00Z', expiresAt: '2026-10-02T01:00:00Z', status: 'pending' }];
export const ORG_KEYS = [
  { id: 'k1', label: 'github-actions', hint: 'Q7xa', capabilities: ['agents:read', 'agents:create'], createdAt: '2026-09-24T01:00:00Z', expiresAt: null, lastUsedAt: '2026-09-25T05:00:00Z', revokedAt: null, status: 'active', createdBy: { email: 'owner@example.com' } },
  { id: 'k2', label: 'old-ci', hint: 'Zz09', capabilities: ['agents:read'], createdAt: '2026-09-20T01:00:00Z', expiresAt: null, lastUsedAt: null, revokedAt: '2026-09-23T01:00:00Z', status: 'revoked', createdBy: null },
];
/** 주소 절(메일 기본기 2차 A6) — 대표 · 활성 별칭 · 폐기한 별칭. `GET /api/agents/a1/aliases` 가 이 목록과 아래 한도를 낸다. */
export const ALIASES = [
  { id: 'd1', address: 'founder@atmark.ai', primary: true, status: 'active' as const, createdAt: '2026-09-20T01:00:00Z', retiredAt: null },
  { id: 'd2', address: 'sales@atmark.ai', primary: false, status: 'active' as const, createdAt: '2026-09-24T01:00:00Z', retiredAt: null },
  { id: 'd3', address: 'old-desk@atmark.ai', primary: false, status: 'retired' as const, createdAt: '2026-09-21T01:00:00Z', retiredAt: '2026-09-25T01:00:00Z' },
];
function aliasView(): { items: typeof TEAM.aliases; aliases: Record<string, unknown> } {
  const alias = TEAM.aliases.filter((a) => !a.primary);
  const active = alias.filter((a) => a.status === 'active').length;
  const max = PLAN.limits.aliasesPerAgentMax;
  return { items: TEAM.aliases, aliases: { active, activeMax: max, issued: alias.length, issuedMax: 20, overLimit: active > max } };
}
// --- 웹훅 탭(2026-09-30) — `GET|POST /api/agents/a1/webhooks` · 교체 · 삭제 · 전달 기록(커서 두 쪽) · 다시 보내기. 계약은 `src/admin/routes/webhooks.ts`
//     (`AdminWebhookItem` · `AdminWebhookDeliveryItem`). 미리보기(`scripts/ui/fake-api.ts`)는 백엔드 작업자의 예시 데이터를 먼저 쓴다 — 여기는 유닛 테스트용.
/** 구독 가능한 이벤트 전부(서버 `WEBHOOK_EVENT_TYPES`). 앞의 넷이 기본(서버 `LEGACY_EVENT_TYPES`). */
export const WEBHOOK_EVENT_TYPES = ['approval.resolved', 'approval.expired', 'message.sent', 'message.received', 'message.delivered', 'message.bounced', 'message.complained'];
/** 발급 직후 한 번만 보이는 서명 비밀값 — 토큰 모양(`atk_…`)이 아니다. */
export const WEBHOOK_SECRET = 'whsec_Q2hyb25vc3Rhc2lzLXdlYmhvb2stc2VjcmV0LTE';
export const WEBHOOK_SECRET_ROTATED = 'whsec_Um90YXRlZC13ZWJob29rLXNlY3JldC12YWx1ZS0y';
export interface WebhookRow {
  id: string;
  url: string;
  eventTypes: string[];
  createdAt: string;
  status: string;
  secretVersion: number;
  rotatedAt: string | null;
  previousValidUntil: string | null;
  /** 인증 헤더(202610141400) — 있음 · 힌트뿐(값은 서버가 돌려주지 않는다). 옛 예시 행은 생략(= 없음). */
  hasAuthorization?: boolean;
  authorizationHint?: string | null;
  lastDelivery: { status: string; at: string; httpStatus: number | null } | null;
}
export interface DeliveryRow {
  id: string;
  webhookId: string;
  eventType: string;
  status: string;
  attempts: number;
  httpStatus: number | null;
  createdAt: string;
  lastAttemptAt: string | null;
  deliveredAt: string | null;
}
export const WEBHOOKS: WebhookRow[] = [
  {
    id: 'w1',
    url: 'https://hooks.example.com/atmark/events',
    eventTypes: ['approval.resolved', 'approval.expired', 'message.sent', 'message.received'],
    createdAt: '2026-09-24T02:00:00Z',
    status: 'active',
    secretVersion: 2,
    rotatedAt: '2026-09-29T02:00:00Z',
    previousValidUntil: '2026-09-30T02:00:00Z',
    lastDelivery: { status: 'delivered', at: '2026-09-30T01:58:00Z', httpStatus: 200 },
  },
  {
    id: 'w2',
    url: 'https://api.partner.example/v1/integrations/atmark/mail-events?source=founder-agent',
    eventTypes: ['message.received', 'message.delivered', 'message.bounced', 'message.complained'],
    createdAt: '2026-09-27T05:00:00Z',
    status: 'active',
    secretVersion: 1,
    rotatedAt: null,
    previousValidUntil: null,
    hasAuthorization: true,
    authorizationHint: 'Bearer …9f2c',
    lastDelivery: { status: 'failed', at: '2026-09-30T01:40:00Z', httpStatus: 500 },
  },
];
export const DELIVERIES: DeliveryRow[] = [
  { id: 'v6', webhookId: 'w1', eventType: 'message.sent', status: 'delivered', attempts: 1, httpStatus: 200, createdAt: '2026-09-30T01:58:00Z', lastAttemptAt: '2026-09-30T01:58:00Z', deliveredAt: '2026-09-30T01:58:01Z' },
  { id: 'v5', webhookId: 'w2', eventType: 'message.bounced', status: 'dead', attempts: 8, httpStatus: 500, createdAt: '2026-09-29T09:10:00Z', lastAttemptAt: '2026-09-30T01:40:00Z', deliveredAt: null },
  { id: 'v4', webhookId: 'w2', eventType: 'message.received', status: 'failed', attempts: 3, httpStatus: 503, createdAt: '2026-09-30T00:20:00Z', lastAttemptAt: '2026-09-30T01:20:00Z', deliveredAt: null },
  { id: 'v3', webhookId: 'w1', eventType: 'approval.resolved', status: 'delivered', attempts: 2, httpStatus: 204, createdAt: '2026-09-29T22:00:00Z', lastAttemptAt: '2026-09-29T22:01:00Z', deliveredAt: '2026-09-29T22:01:00Z' },
  { id: 'v2', webhookId: 'w1', eventType: 'message.received', status: 'pending', attempts: 0, httpStatus: null, createdAt: '2026-09-30T02:00:00Z', lastAttemptAt: null, deliveredAt: null },
  { id: 'v1', webhookId: 'w1', eventType: 'message.sent', status: 'delivered', attempts: 1, httpStatus: 200, createdAt: '2026-09-28T03:00:00Z', lastAttemptAt: '2026-09-28T03:00:00Z', deliveredAt: '2026-09-28T03:00:01Z' },
];
/** 전달 기록 한 쪽의 크기 — 기본 여섯 건이 두 쪽(4 + 2)으로 나뉘어 `더 보기` 가 한 번 보인다. */
const DELIVERY_PAGE = 4;
/** 서버 `webhookAuthorizationHint` 와 같은 모양(방식 + 끝 4글자, 16자 이상이고 Basic · Digest 가 아닐 때만). */
function authHint(value: string): string {
  const match = /^([A-Za-z][A-Za-z0-9._~+-]{0,19}) +(\S.*)$/.exec(value);
  const credential = match?.[2] ?? value;
  const hideTail = match?.[1] !== undefined && /^(basic|digest)$/i.test(match[1]);
  const tail = !hideTail && credential.length >= 16 ? credential.slice(-4) : '';
  return match?.[1] === undefined ? `…${tail}` : `${match[1]} …${tail}`;
}
function webhookView(): Record<string, unknown> {
  const active = TEAM.webhooks.filter((w) => w.status === 'active');
  return {
    items: active,
    limits: { active: active.length, activeMax: PLAN.limits.webhookEndpointsPerAgentMax, registrationsToday: TEAM.webhookRegistrationsToday, registrationsMax: 10 },
    availableEventTypes: WEBHOOK_EVENT_TYPES,
  };
}
function webhooksRoute(method: string, url: string, body: unknown): Mocked | null {
  if (url === '/api/agents/a1/webhooks' && method === 'GET') return { status: 200, json: webhookView() };
  if (url === '/api/agents/a1/webhooks' && method === 'POST') {
    const b = (body ?? {}) as { url?: unknown; eventTypes?: unknown; authorization?: unknown };
    const target = typeof b.url === 'string' ? b.url : '';
    if (!/^https:\/\/[^\s/?#@]+/.test(target)) return { status: 400, json: { error: 'invalid_webhook_url' } };
    if (TEAM.webhooks.filter((w) => w.status === 'active').length >= PLAN.limits.webhookEndpointsPerAgentMax) return { status: 409, json: { error: 'webhook_endpoint_limit' } };
    if (TEAM.webhookRegistrationsToday >= 20) return { status: 409, json: { error: 'webhook_endpoint_registration_limit' } };
    const eventTypes = Array.isArray(b.eventTypes) ? b.eventTypes.filter((t): t is string => typeof t === 'string') : WEBHOOK_EVENT_TYPES.slice(0, 4);
    const auth = typeof b.authorization === 'string' ? b.authorization : null;
    const item: WebhookRow = {
      id: `w${String(TEAM.webhooks.length + 1)}`,
      url: target,
      eventTypes,
      createdAt: '2026-09-30T03:00:00Z',
      status: 'active',
      secretVersion: 1,
      rotatedAt: null,
      previousValidUntil: null,
      hasAuthorization: auth !== null,
      authorizationHint: auth === null ? null : authHint(auth),
      lastDelivery: null,
    };
    TEAM.webhooks = [...TEAM.webhooks, item];
    TEAM.webhookRegistrationsToday += 1;
    return { status: 201, json: { item, secret: WEBHOOK_SECRET } };
  }
  const auth = /^\/api\/agents\/a1\/webhooks\/(w[0-9]+)\/authorization$/.exec(url);
  if (auth !== null) {
    const found = TEAM.webhooks.find((w) => w.id === auth[1] && w.status === 'active');
    if (found === undefined) return { status: 404, json: { error: 'webhook_not_found' } };
    if (method === 'POST') {
      const value = (body as { authorization?: unknown } | null)?.authorization;
      if (typeof value !== 'string' || !/^[\x20-\x7E]{1,2048}$/.test(value)) return { status: 400, json: { error: 'invalid_authorization' } };
      const item = { ...found, hasAuthorization: true, authorizationHint: authHint(value) };
      TEAM.webhooks = TEAM.webhooks.map((w) => (w.id === found.id ? item : w));
      return { status: 200, json: { item } };
    }
    if (method === 'DELETE') {
      const item = { ...found, hasAuthorization: false, authorizationHint: null };
      TEAM.webhooks = TEAM.webhooks.map((w) => (w.id === found.id ? item : w));
      return { status: 200, json: { item } };
    }
    return null;
  }
  const one = /^\/api\/agents\/a1\/webhooks\/(w[0-9]+)(\/rotate)?$/.exec(url);
  if (one !== null) {
    const found = TEAM.webhooks.find((w) => w.id === one[1] && w.status === 'active');
    if (found === undefined) return { status: 404, json: { error: 'webhook_not_found' } };
    if (one[2] === '/rotate' && method === 'POST') {
      const item = { ...found, secretVersion: found.secretVersion + 1, rotatedAt: '2026-09-30T03:00:00Z', previousValidUntil: '2026-10-01T03:00:00Z' };
      TEAM.webhooks = TEAM.webhooks.map((w) => (w.id === found.id ? item : w));
      return { status: 200, json: { item, secret: WEBHOOK_SECRET_ROTATED, previousValidUntil: item.previousValidUntil } };
    }
    if (one[2] === undefined && method === 'DELETE') {
      const item = { ...found, status: 'deleted' };
      TEAM.webhooks = TEAM.webhooks.map((w) => (w.id === found.id ? item : w));
      return { status: 200, json: { item } };
    }
    return null;
  }
  const list = /^\/api\/agents\/a1\/webhooks\/deliveries(?:\?(.*))?$/.exec(url);
  if (list !== null && method === 'GET') {
    const q = new URLSearchParams(list[1] ?? '');
    const wanted = q.get('webhookId');
    const rows = TEAM.deliveries.filter((d) => wanted === null || d.webhookId === wanted);
    const start = Number(q.get('cursor') ?? '0') || 0;
    const page = rows.slice(start, start + DELIVERY_PAGE);
    return { status: 200, json: { items: page, nextCursor: start + DELIVERY_PAGE < rows.length ? String(start + DELIVERY_PAGE) : null } };
  }
  const re = /^\/api\/agents\/a1\/webhooks\/deliveries\/([^/]+)\/redeliver$/.exec(url);
  if (re !== null && method === 'POST') {
    // 서버와 같다 — 재시도가 끝난(dead) 전달만 · 새 전달 행(같은 이벤트, pending)을 돌려준다.
    const found = TEAM.deliveries.find((d) => d.id === re[1]);
    if (found === undefined) return { status: 404, json: { error: 'delivery_not_found' } };
    if (found.status !== 'dead') return { status: 409, json: { error: 'delivery_not_dead' } };
    const item = { ...found, id: `v${String(TEAM.deliveries.length + 1)}`, status: 'pending', attempts: 0, httpStatus: null, createdAt: '2026-09-30T03:00:00Z', lastAttemptAt: null, deliveredAt: null };
    TEAM.deliveries = [item, ...TEAM.deliveries];
    return { status: 202, json: { item } };
  }
  return null;
}
export function resetTeam(): void {
  TEAM.aliases = ALIASES.map((a) => ({ ...a }));
  TEAM.webhooks = WEBHOOKS.map((w) => ({ ...w, eventTypes: [...w.eventTypes] }));
  TEAM.deliveries = DELIVERIES.map((d) => ({ ...d }));
  TEAM.webhookRegistrationsToday = 1;
  TEAM.members = MEMBERS.map((m) => ({ ...m }));
  TEAM.invites = INVITES.map((i) => ({ ...i }));
  TEAM.keys = ORG_KEYS.map((k) => ({ ...k }));
}
resetTeam();
/** 요금제 요약(`/api/me.plan`, ADR-0011) — beta(도입 전 한도 그대로): 에이전트 분모 10 · 초과 없음. */
export const PLAN_BRIEF = { code: 'beta', basis: 'row', maxAgents: 10, overLimit: [] as string[] };
/**
 * 고객 도메인 두 개(ADR-0014 M4) — 사용 중 하나 · 확인 대기 하나. 한 개 보기는 레코드를 붙인다 — 계약 `dnsRecordsFor` 를 그대로 불러(2026-10
 * one-shot: 확인 대기도 DKIM 까지 **전부** · `recordsReady:true`). "준비 중"(DKIM 토큰 전)은 테스트가 `preparingDetail` 로 덮어 쓴다.
 */
export const DOMAINS = [
  { id: 'dm1', domain: 'agents.example.com', registrableDomain: 'example.com', status: 'verified', suspendedReason: null, pendingReason: null, dkimStatus: 'success', mailFromStatus: 'success', inboundMxStatus: 'ses', createdAt: '2026-09-20T01:00:00.000Z', verifiedAt: '2026-09-20T03:00:00.000Z', suspendedAt: null, removedAt: null, lastCheckedAt: '2026-09-27T00:00:00.000Z', nextCheckAt: '2026-09-27T06:00:00.000Z', expiresAt: null, removalDueAt: null, registrationExpiresAt: null },
  { id: 'dm2', domain: 'mail.example.org', registrableDomain: 'example.org', status: 'pending', suspendedReason: null, pendingReason: null, dkimStatus: 'not_started', mailFromStatus: 'not_started', inboundMxStatus: 'unknown', createdAt: '2026-09-26T01:00:00.000Z', verifiedAt: null, suspendedAt: null, removedAt: null, lastCheckedAt: null, nextCheckAt: '2026-09-27T01:30:00.000Z', expiresAt: '2026-09-29T01:00:00.000Z', removalDueAt: null, registrationExpiresAt: null },
];
export function domainDetail(d: (typeof DOMAINS)[number] | undefined): Record<string, unknown> {
  const x = d ?? DOMAINS[0];
  return {
    ...x,
    records: dnsRecordsFor(x?.domain ?? '', 'tok', ['k1', 'k2', 'k3']),
    recordsReady: true,
    primaryAgents: x?.status === 'verified' ? 1 : 0,
    liveAddresses: x?.status === 'verified' ? 2 : 0,
  };
}
/** "레코드를 준비하고 있습니다" — DKIM 토큰을 아직 받지 못한 확인 대기 도메인(즉시 실행이 `waiting`/`busy`). */
export function preparingDetail(d: (typeof DOMAINS)[number] | undefined): Record<string, unknown> {
  const x = d ?? DOMAINS[1];
  return { ...domainDetail(x), records: dnsRecordsFor(x?.domain ?? '', 'tok', []), recordsReady: false };
}
/** `GET /api/plan` 한 벌(`PlanUsageView`). */
export const PLAN = {
  plan: { code: 'beta', basis: 'row', rowCode: 'beta', source: 'default', version: 1, graceUntil: null, updatedAt: '2026-09-25T00:00:00.000Z' },
  limits: {
    maxAgents: 10,
    orgDailyRecipients: 1000,
    agentPerDayMax: 10000,
    agentPerMinuteMax: 9999,
    recipientsPerMessageMax: 50,
    tokensPerAgentMax: 5,
    webhookEndpointsPerAgentMax: 10,
    orgApiKeysMax: 5,
    inboundStorageBytes: 10737418240,
    agentsTotalMax: 30,
    aliasesPerAgentMax: 5,
    attachmentBytesTotalMax: 26214400,
  },
  usage: { agents: 1, agentsTotal: 1, orgKeys: 2, agentsOverTokenLimit: 0, recipientsLastDay: 12, dailyCap: 1000, dailyCapReason: 'warmup_daily_cap', warmupCap: 1000 },
  overLimit: [] as string[],
  upgradeAvailable: false,
  features: { addressAliases: true, customDomains: true },
};

// --- 감시 탭(2026-10-08) — 계약은 `src/admin/routes/watch.ts` · `src/admin/ops/watch.ts`. 미리보기(`scripts/ui/fake-api.ts`)도 이 응답을 쓴다. ---
export interface HeldRow {
  id: string;
  agentId: string;
  agentName: string;
  level: 'block' | 'risk';
  reason: 'injection_risk' | 'scanner_error' | 'risk_hold';
  families: string[];
  injectionRisk: string | null;
  senderDomain: string;
  senderAuthenticated: boolean;
  receivedAt: string;
  releasable: boolean;
}
/** 보류된 메일 다섯 — 차단(인젝션 의심 · 인증 안 됨) · 위험 보류(서술형) · 차단(검사 실패 — 풀 수 없음) · 위험 보류(숨긴 글자) · 차단(계열 셋). */
export const HELD: HeldRow[] = [
  { id: '0b6f1d2e-1111-4a51-a1a8-3f4d1c0e2b01', agentId: 'a1', agentName: 'founder-agent', level: 'block', reason: 'injection_risk', families: ['exfiltration', 'override'], injectionRisk: 'high', senderDomain: 'invoice-update.example', senderAuthenticated: false, receivedAt: '2026-10-08T02:41:00.000Z', releasable: true },
  { id: '0b6f1d2e-2222-4a51-a1a8-3f4d1c0e2b02', agentId: 'a1', agentName: 'founder-agent', level: 'risk', reason: 'risk_hold', families: ['narrative'], injectionRisk: 'low', senderDomain: 'partner.example', senderAuthenticated: true, receivedAt: '2026-10-08T01:12:00.000Z', releasable: true },
  { id: '0b6f1d2e-3333-4a51-a1a8-3f4d1c0e2b03', agentId: 'a1', agentName: 'founder-agent', level: 'block', reason: 'scanner_error', families: [], injectionRisk: null, senderDomain: 'bulk-mailer.example', senderAuthenticated: false, receivedAt: '2026-10-07T22:05:00.000Z', releasable: false },
  { id: '0b6f1d2e-4444-4a51-a1a8-3f4d1c0e2b04', agentId: 'a1', agentName: 'founder-agent', level: 'risk', reason: 'risk_hold', families: ['agent_action', 'concealment'], injectionRisk: 'low', senderDomain: 'newsletter.example', senderAuthenticated: true, receivedAt: '2026-10-07T09:30:00.000Z', releasable: true },
  { id: '0b6f1d2e-5555-4a51-a1a8-3f4d1c0e2b05', agentId: 'a1', agentName: 'founder-agent', level: 'block', reason: 'injection_risk', families: ['jailbreak', 'prompt_leak', 'role_spoof'], injectionRisk: 'medium', senderDomain: 'helpdesk-alerts.example', senderAuthenticated: false, receivedAt: '2026-10-06T15:48:00.000Z', releasable: true },
];
export const SIGNUPS = [
  { agentId: 'a1', agentName: 'founder-agent', serviceDomain: 'accounts.devtools.example', kind: 'verification', firstSeenAt: '2026-10-08T01:58:00.000Z', lastSeenAt: '2026-10-08T02:01:00.000Z', messageCount: 2 },
  { agentId: 'a1', agentName: 'founder-agent', serviceDomain: 'billingly.example', kind: 'welcome', firstSeenAt: '2026-10-06T04:10:00.000Z', lastSeenAt: '2026-10-06T04:10:00.000Z', messageCount: 1 },
  { agentId: 'a1', agentName: 'founder-agent', serviceDomain: 'calendar-app.example', kind: 'account_created', firstSeenAt: '2026-10-02T08:00:00.000Z', lastSeenAt: '2026-10-05T08:00:00.000Z', messageCount: 3 },
];
const TRUSTED0 = [
  { kind: 'address' as const, value: 'billing@vendor.example', createdAt: '2026-10-08T00:30:00.000Z' },
  { kind: 'domain' as const, value: 'partner.example', createdAt: '2026-10-07T03:00:00.000Z' },
];
/** 서버와 같은 공용 메일 도메인 판정(`src/watch/settings.ts`) — 하네스는 몇 개만 안다. */
const FREEMAIL_FAKE = new Set(['gmail.com', 'outlook.com', 'naver.com', 'atmark.ai']);
export const WATCH = {
  trusted: [] as { kind: 'address' | 'domain'; value: string; createdAt: string }[],
  org: { agentSelfEnroll: false, enrollDailyCap: 5, notifyOnEnroll: true, notifyOnSignup: true },
  agents: {} as Record<string, { riskHandling: 'deliver' | 'hold'; riskNotify: boolean; sendApproval: 'auto' | 'always' }>,
  held: [] as HeldRow[],
};
export function resetWatch(): void {
  WATCH.trusted = TRUSTED0.map((t) => ({ ...t }));
  WATCH.org = { agentSelfEnroll: false, enrollDailyCap: 5, notifyOnEnroll: true, notifyOnSignup: true };
  WATCH.agents = {};
  WATCH.held = HELD.map((h) => ({ ...h, families: [...h.families] }));
}
resetWatch();
function watchSettingsView(): Record<string, unknown> {
  return { trustedSenders: WATCH.trusted, maxTrustedSenders: 200, ...WATCH.org, maxEnrollDailyCap: 20, updatedAt: '2026-10-08T00:30:00.000Z' };
}
/** 에이전트 하나의 감시 설정 — 처음 보는 에이전트는 기본값(바로 전달 · 알림 켬 · 자동). 미리보기를 위해 a3 · a5 는 다르게 시작한다. */
function agentWatch(id: string): { riskHandling: 'deliver' | 'hold'; riskNotify: boolean; sendApproval: 'auto' | 'always' } {
  WATCH.agents[id] ??= id === 'a3' ? { riskHandling: 'hold', riskNotify: true, sendApproval: 'always' } : id === 'a5' ? { riskHandling: 'deliver', riskNotify: false, sendApproval: 'always' } : { riskHandling: 'deliver', riskNotify: true, sendApproval: 'auto' };
  return WATCH.agents[id];
}
/** 감시 API 한 벌(커서 = 다음 시작 위치). 모르는 경로는 `null`. */
export function watchRoute(method: string, url: string, body: unknown): Mocked | null {
  if (url === '/api/watch/settings' && method === 'GET') return { status: 200, json: watchSettingsView() };
  if (url === '/api/watch/settings' && method === 'PATCH') {
    const b = (body ?? {}) as Record<string, unknown>;
    if (Array.isArray(b['trustedSenders'])) {
      const next: typeof WATCH.trusted = [];
      for (const raw of b['trustedSenders'] as unknown[]) {
        const v = String(raw).trim().toLowerCase();
        if (!/^[^\s@]+@[a-z0-9.-]+\.[a-z]{2,}$|^[a-z0-9.-]+\.[a-z]{2,}$/.test(v)) return { status: 400, json: { error: 'invalid_trusted_sender' } };
        const kind = v.includes('@') ? 'address' : 'domain';
        if (kind === 'domain' && FREEMAIL_FAKE.has(v)) return { status: 400, json: { error: 'trusted_sender_freemail_domain' } };
        next.push(WATCH.trusted.find((t) => t.value === v) ?? { kind, value: v, createdAt: '2026-10-08T03:00:00.000Z' });
      }
      WATCH.trusted = next;
      return { status: 200, json: { ...watchSettingsView(), changed: true, added: 1, removed: 0 } };
    }
    WATCH.org = { ...WATCH.org, ...(b as Partial<typeof WATCH.org>) };
    return { status: 200, json: { ...watchSettingsView(), changed: true } };
  }
  const aw = /^\/api\/agents\/([^/?]+)\/watch$/.exec(url);
  if (aw) {
    const id = aw[1] ?? '';
    if (method === 'GET') return { status: 200, json: { agentId: id, ...agentWatch(id), updatedAt: null } };
    if (method === 'PATCH') {
      WATCH.agents[id] = { ...agentWatch(id), ...(body as object) };
      return { status: 200, json: { agentId: id, ...agentWatch(id), updatedAt: '2026-10-08T03:00:00.000Z', changed: true, sendApprovalChanged: 'sendApproval' in (body as object) } };
    }
  }
  const page = (rows: unknown[], query: string): Mocked => {
    const q = new URLSearchParams(query);
    const limit = Number(q.get('limit') ?? '50') || 50;
    const start = Number(q.get('cursor') ?? '0') || 0;
    return { status: 200, json: { items: rows.slice(start, start + limit), nextCursor: start + limit < rows.length ? String(start + limit) : null } };
  };
  const held = /^\/api\/watch\/held(?:\?(.*))?$/.exec(url);
  if (held && method === 'GET') {
    const agent = new URLSearchParams(held[1] ?? '').get('agentId');
    return page(WATCH.held.filter((h) => agent === null || h.agentId === agent), held[1] ?? '');
  }
  const rel = /^\/api\/watch\/held\/([^/]+)\/release$/.exec(url);
  if (rel && method === 'POST') {
    const found = WATCH.held.find((h) => h.id === rel[1]);
    if (!found) return { status: 404, json: { error: 'message_not_found' } };
    if (!found.releasable) return { status: 409, json: { error: 'release_not_scanned' } };
    WATCH.held = WATCH.held.filter((h) => h.id !== found.id);
    return { status: 200, json: { id: found.id, agentId: found.agentId, releasedAt: '2026-10-08T03:00:00.000Z', releasedFrom: found.reason === 'risk_hold' ? 'risk_hold' : 'injection_risk', level: found.level, replayed: false } };
  }
  const su = /^\/api\/watch\/signups(?:\?(.*))?$/.exec(url);
  if (su && method === 'GET') {
    const agent = new URLSearchParams(su[1] ?? '').get('agentId');
    return page(SIGNUPS.filter((x) => agent === null || x.agentId === agent), su[1] ?? '');
  }
  return null;
}

/** 다른 조직 멤버십이 있는 `/api/me`(P0 §3.2) — 조직 둘 · 역할을 바꿔 부팅할 때. */
export function me(role = 'owner', extra: Record<string, unknown> = {}): Mocked {
  return {
    status: 200,
    json: {
      user: { id: 'u1', email: 'me@example.com' },
      organization: { id: 'o1', name: 'Chronostasis', ownerEmail: 'owner@example.com', reviewStatus: 'active', role },
      orgKillSwitch: { ownerPaused: false, platformFrozen: false },
      plan: PLAN_BRIEF,
      csrf: 'csrf-1',
      memberships: [
        { organizationId: 'o1', name: 'Chronostasis', role, reviewStatus: 'active' },
        { organizationId: 'o2', name: 'Kairos Labs', role: 'member', reviewStatus: 'pending_review' },
      ],
      ...extra,
    },
  };
}

export function mockApi(method: string, rawUrl: string, body: unknown): Mocked {
  // R-5 채널 경로 — email 은 옛 경로와 같은 응답(서버의 별칭과 같다). 다른 채널은 404.
  const ch = /^(\/api\/agents\/[^/]+)\/channels\/([^/]+)\/(policy|rules.*)$/.exec(rawUrl);
  if (ch && ch[2] !== 'email') return { status: 404, json: { error: 'channel_not_found' } };
  const url = ch ? `${ch[1] ?? ''}/${ch[3] ?? ''}` : rawUrl;
  // R-9 페이지 목록 — 옛 테스트가 `/api/agents` 로 건 응답(배열)은 페이지 URL 에도 쓴다(콘솔은 배열·봉투 둘 다 읽는다).
  const agentsList = method === 'GET' && /^\/api\/agents\?/.test(url);
  const found = OVERRIDE.get(`${method} ${rawUrl}`) ?? OVERRIDE.get(rawUrl) ?? OVERRIDE.get(`${method} ${url}`) ?? OVERRIDE.get(url) ?? (agentsList ? OVERRIDE.get('/api/agents') : undefined);
  const override = Array.isArray(found) ? (found.length > 1 ? found.shift() : found[0]) : found;
  if (override !== undefined) return override;
  if (url === '/api/logs/integrity') return { status: 200, json: integrity() };
  if (url.startsWith('/api/logs/bundle'))
    return { status: 200, json: { range: { from_epoch: 1811, to_epoch: 1834 } }, headers: { 'content-disposition': `attachment; filename="${BUNDLE_NAME}"` } };
  if (url.startsWith('/api/logs/inclusion-proof')) return { status: 200, json: { entry: { id: '4182' } } };
  if (url === '/api/me')
    return {
      status: 200,
      json: {
        organization: { id: 'o1', name: 'Chronostasis', ownerEmail: 'owner@example.com', reviewStatus: 'active' },
        orgKillSwitch: { ownerPaused: false, platformFrozen: false },
        plan: PLAN_BRIEF,
        csrf: 'csrf-1',
        memberships: [{ organizationId: 'o1', name: 'Chronostasis', role: 'owner' }],
      },
    };
  if (url === '/api/plan') return { status: 200, json: PLAN };
  // --- 개인 설정 — 시스템 메일 언어(202610101000). PATCH 는 받은 값을 그대로 돌려준다(등록부 밖이면 400 — 서버와 같다).
  if (url === '/api/me/preferences' && method === 'GET') return { status: 200, json: { mailLocale: 'en', chosen: false, supported: ['en', 'ko'] } };
  if (url === '/api/me/preferences' && method === 'PATCH') {
    const mailLocale = (body as { mailLocale?: unknown }).mailLocale;
    return mailLocale === 'en' || mailLocale === 'ko'
      ? { status: 200, json: { mailLocale, chosen: true, supported: ['en', 'ko'] } }
      : { status: 400, json: { error: 'invalid_mail_locale' } };
  }
  // --- 고객 도메인(ADR-0014 M4) — 목록 · 한 개(레코드) · 지금 확인 · 추가 · 제거 ---
  if (url === '/api/domains' && method === 'GET') return { status: 200, json: { enabled: true, limit: 3, pendingMax: 2, live: DOMAINS.length, items: DOMAINS } };
  if (url === '/api/domains' && method === 'POST') return { status: 201, json: { item: { ...domainDetail(DOMAINS[1]), id: 'dm9', domain: String((body as { domain?: unknown }).domain ?? '') } } };
  const dom = /^\/api\/domains\/([^/]+)(\/check|\/connect)?$/.exec(url);
  if (dom) {
    const d = DOMAINS.find((x) => x.id === dom[1]);
    if (!d) return { status: 404, json: { error: 'domain_not_found' } };
    // Domain Connect — 기본은 꺼짐(`supported:false`). 테스트가 `OVERRIDE.set('/api/domains/dm2/connect', …)` 로 켠다.
    if (dom[2] === '/connect' && method === 'GET') return { status: 200, json: { supported: false } };
    if (dom[2] && method === 'POST') return { status: 202, json: { id: d.id, nextCheckAt: '2026-09-27T01:00:00.000Z' } };
    if (method === 'DELETE') return { status: 200, json: { item: { ...d, status: 'removed' }, replayed: false, primaryAgents: 1, releasedAddresses: 0 } };
    return { status: 200, json: { item: domainDetail(d) } };
  }
  if (url.startsWith('/api/stats')) {
    const agent = /[?&]agent=([^&]+)/.exec(url)?.[1];
    return { status: 200, json: agent ? { ...STATS, agentId: agent, outbound: { ...STATS.outbound, sent: 42, denied: 3 }, inbound: { ...STATS.inbound, delivered: 116, quarantined: 2 }, byAgent: undefined } : STATS };
  }
  if (url === '/api/agents/a1/tokens?status=all' || url === '/api/agents/a1/tokens?status=active')
    return { status: 200, json: { tokens: url.endsWith('all') ? TOKENS : TOKENS.filter((t) => t.status === 'active'), activeCount: 2, maxActive: 5 } };
  if (url === '/api/agents/a1/tokens' && method === 'POST') {
    const b = body as { label: string; expiresDays?: number };
    return { status: 201, json: { token: NEW_TOKEN, item: { ...TOKENS[0], id: '9e5a4b85-2a01-4d84-94db-6c7a4f3b5eaa', label: b.label, hint: 'ijkl', lastUsedAt: null } } };
  }
  const rev = /^\/api\/agents\/a1\/tokens\/([0-9a-f-]+)\/revoke$/.exec(url);
  if (rev && method === 'POST') {
    const t = TOKENS.find((x) => x.id === rev[1]);
    return t ? { status: 200, json: { item: { ...t, status: 'revoked', revokedAt: '2026-09-25T06:00:00.000Z' } } } : { status: 404, json: { error: 'token_not_found' } };
  }
  const rot = /^\/api\/agents\/a1\/tokens\/([0-9a-f-]+)\/rotate$/.exec(url);
  if (rot && method === 'POST') {
    const t = TOKENS.find((x) => x.id === rot[1]);
    return t
      ? { status: 201, json: { token: NEW_TOKEN, item: { ...t, id: '0c1d2e3f-4a5b-4c6d-8e7f-8091a2b3c4d5', hint: 'ijkl', lastUsedAt: null }, revoked: { ...t, status: 'revoked', revokedAt: '2026-09-25T06:00:00.000Z' } } }
      : { status: 404, json: { error: 'token_not_found' } };
  }
  const ren = /^\/api\/agents\/a1\/tokens\/([0-9a-f-]+)$/.exec(url);
  if (ren && method === 'PATCH') {
    const t = TOKENS.find((x) => x.id === ren[1]);
    return t ? { status: 200, json: { item: { ...t, label: (body as { label: string }).label } } } : { status: 404, json: { error: 'token_not_found' } };
  }
  // --- 메일 기본기 2차 A6: 주소(별칭) ---
  if (url === '/api/agents/a1/aliases' && method === 'GET') return { status: 200, json: aliasView() };
  if (url === '/api/agents/a1/aliases' && method === 'POST') {
    const lp = String((body as { localPart?: unknown }).localPart ?? '');
    if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(lp)) return { status: 400, json: { error: 'invalid_character' } };
    const address = `${lp}@atmark.ai`;
    if (TEAM.aliases.some((a) => a.address === address)) return { status: 409, json: { error: 'address_taken' } };
    const item = { id: `d${String(TEAM.aliases.length + 1)}`, address, primary: false, status: 'active' as const, createdAt: '2026-09-27T01:00:00Z', retiredAt: null };
    TEAM.aliases = [...TEAM.aliases, item];
    return { status: 201, json: { item } };
  }
  const aliasRet = /^\/api\/agents\/a1\/aliases\/([^/]+)\/retire$/.exec(url);
  if (aliasRet && method === 'POST') {
    const found = TEAM.aliases.find((a) => a.id === aliasRet[1]);
    if (!found) return { status: 404, json: { error: 'not_found' } };
    if (found.primary) return { status: 400, json: { error: 'address_primary_not_retirable' } };
    const replayed = found.status === 'retired';
    TEAM.aliases = TEAM.aliases.map((a) => (a.id === found.id && !replayed ? { ...a, status: 'retired' as const, retiredAt: '2026-09-27T02:00:00Z' } : a));
    return { status: 200, json: { item: TEAM.aliases.find((a) => a.id === found.id), replayed } };
  }
  const hook = webhooksRoute(method, url, body);
  if (hook !== null) return hook;
  const watch = watchRoute(method, url, body);
  if (watch !== null) return watch;
  if (url === '/api/agents' || agentsList) return { status: 200, json: agentsList ? { items: [AGENT], nextCursor: null } : [AGENT] };
  if (url === '/api/agents/a1' && method === 'GET') return { status: 200, json: AGENT };
  // --- P0/P1: 세션 전환 · 새 조직 · 멤버 · 초대 · 조직 키 ---
  if (url === '/api/session/org' && method === 'POST') {
    const id = (body as { organizationId?: string }).organizationId;
    return id === 'o2' ? { status: 200, json: { csrf: 'csrf-2', organization: { id: 'o2', name: 'Kairos Labs', role: 'member', reviewStatus: 'pending_review' } } } : { status: 404, json: { error: 'organization_not_found' } };
  }
  if (url === '/api/organizations' && method === 'POST') return { status: 201, json: { csrf: 'csrf-3', organization: { id: 'o3', name: (body as { name: string }).name, role: 'owner', reviewStatus: 'pending_review' } } };
  if (url === '/api/members' && method === 'GET') return { status: 200, json: { members: TEAM.members, invites: TEAM.invites, limits: { maxMembers: 5, pendingInvites: TEAM.invites.length, maxPendingInvites: 10 } } };
  if (url === '/api/members/invites' && method === 'POST') {
    const b = body as { email: string; role: string };
    const invite = { id: `i${String(TEAM.invites.length + 2)}`, email: b.email, role: b.role, createdAt: '2026-09-25T06:00:00Z', expiresAt: '2026-10-02T06:00:00Z', status: 'pending' };
    TEAM.invites = [...TEAM.invites, invite];
    return { status: 201, json: { invite } };
  }
  const invRev = /^\/api\/members\/invites\/([^/]+)\/revoke$/.exec(url);
  if (invRev && method === 'POST') {
    TEAM.invites = TEAM.invites.filter((i) => i.id !== invRev[1]);
    return { status: 200, json: { invite: { id: invRev[1], status: 'revoked' } } };
  }
  if (url === '/api/members/leave' && method === 'POST') return { status: 204, json: null };
  const mem = /^\/api\/members\/([^/]+)$/.exec(url);
  if (mem && method === 'PATCH') {
    const m = TEAM.members.find((x) => x.userId === mem[1]);
    if (!m) return { status: 404, json: { error: 'member_not_found' } };
    m.role = (body as { role: string }).role;
    return { status: 200, json: { member: m } };
  }
  if (mem && method === 'DELETE') {
    TEAM.members = TEAM.members.filter((x) => x.userId !== mem[1]);
    return { status: 204, json: null };
  }
  if (url === '/api/org-keys?status=all' && method === 'GET') return { status: 200, json: { keys: TEAM.keys, activeCount: TEAM.keys.filter((k) => k.status === 'active').length, maxActive: 5 } };
  if (url === '/api/org-keys' && method === 'POST') {
    const b = body as { label: string; capabilities: string[] };
    const item = { ...ORG_KEYS[0], id: `k${String(TEAM.keys.length + 1)}`, label: b.label, capabilities: b.capabilities, hint: 'cdef', lastUsedAt: null };
    TEAM.keys = [item, ...TEAM.keys];
    return { status: 201, json: { key: ORG_KEY, item } };
  }
  const okAct = /^\/api\/org-keys\/([^/]+)(?:\/(revoke|rotate))?$/.exec(url);
  if (okAct && method === 'POST' && okAct[2] === 'revoke') {
    TEAM.keys = TEAM.keys.map((k) => (k.id === okAct[1] ? { ...k, status: 'revoked', revokedAt: '2026-09-25T06:00:00Z' } : k));
    return { status: 200, json: { item: TEAM.keys.find((k) => k.id === okAct[1]) } };
  }
  if (okAct && method === 'POST' && okAct[2] === 'rotate') {
    const old = TEAM.keys.find((k) => k.id === okAct[1]);
    const item = { ...old, id: 'k9', hint: 'cdef' };
    TEAM.keys = [item, ...TEAM.keys.map((k) => (k.id === okAct[1] ? { ...k, status: 'revoked' } : k))];
    return { status: 201, json: { key: ORG_KEY, item, revoked: { ...old, status: 'revoked' } } };
  }
  if (okAct && method === 'PATCH' && okAct[2] === undefined) {
    TEAM.keys = TEAM.keys.map((k) => (k.id === okAct[1] ? { ...k, label: (body as { label: string }).label } : k));
    return { status: 200, json: { item: TEAM.keys.find((k) => k.id === okAct[1]) } };
  }
  if (url === '/api/agents/a1/policy' && method === 'GET') return { status: 200, json: POLICY };
  if (url === '/api/agents/a1/policy' && method === 'PATCH') {
    const b = body as { outbound?: { mode: string } };
    return { status: 200, json: { ...POLICY, outbound: { ...POLICY.outbound, mode: b.outbound?.mode ?? 'allowlist' }, version: 5 } };
  }
  if (url === '/api/agents/a1/rules' && method === 'POST') return { status: 201, json: { rule: RULE, policy: POLICY } };
  if (url === '/api/agents/a1/token') return { status: 200, json: { revoked: 1, token: TOKEN } };
  if (url.startsWith('/api/logs/')) return { status: 200, json: { ...OUT_LOG, resolution: null } };
  if (url.startsWith('/api/logs')) return { status: 200, json: { items: url.includes('type=outbound') ? [OUT_LOG] : [], next: null } };
  if (url.startsWith('/api/senders')) return { status: 200, json: [] };
  if (url === '/api/agents/a1/identity') return { status: 200, json: PUBLISHED_IDENTITY };
  if (url === '/api/agents/a1/identity-blocks' || url === '/api/agents/a1/identity-blocks?proofs=1') return { status: 200, json: IDENTITY_BLOCKS };
  if (url.startsWith('/api/gate')) return { status: 200, json: { gates: [], report: null, ambiguous: false } };
  // AI 의심 메일 감시(ADR-0017) — 기본은 허용 목록에 있고 꺼진 조직. PATCH 는 본문 그대로 켜고 끈다.
  if (url === '/api/settings/ai-watch' && method === 'GET') return { status: 200, json: { feature: true, enabled: false } };
  if (url === '/api/settings/ai-watch' && method === 'PATCH') return { status: 200, json: { feature: true, enabled: (body as { enabled?: unknown }).enabled === true, changed: true } };
  return { status: 404, json: { error: 'route_not_found' } };
}

/** 스크립트가 누른 파일 저장 링크 하나 — 누를 때의 href·download·문서에 붙어 있었는지. */
export interface Download {
  readonly href: string;
  readonly download: string;
  readonly attached: boolean;
  readonly node: FakeNode;
}

export interface FakeChannel {
  readonly name: string;
  onmessage: ((ev: { data: unknown }) => void) | null;
  readonly posted: unknown[];
}

export interface World {
  readonly el: (id: string) => FakeNode;
  /** 스크립트가 연 BroadcastChannel(이름 · onmessage · 보낸 메시지). */
  readonly channels: FakeChannel[];
  /** `<a download>` 클릭(파일 저장) 기록 · 만든/지운 object URL · 만든 Blob. */
  readonly downloads: Download[];
  readonly objectUrls: { created: unknown[]; revoked: string[] };
  /** `clipboard` 로 부팅했을 때 `navigator.clipboard.writeText` 에 넘어온 글(실패하는 클립보드도 시도는 적는다). */
  readonly clipboard: string[];
  readonly calls: ApiCall[];
  readonly location: { hash: string; search: string; replaced: string[]; href?: string | undefined };
  readonly body: FakeNode;
  /** `<html>` — 테마 전환이 `data-theme` 을 적는 곳. */
  readonly root: FakeNode;
  /** 가짜 localStorage 의 내용(`null` 이면 접근이 던지는 저장소). */
  readonly storage: Map<string, string> | null;
  /** 가짜 sessionStorage(탭 저장소 — 세션 만료 뒤 가던 화면, 비평 R7-05). */
  readonly session: Map<string, string>;
  /** window 수준 리스너에 이벤트 하나(storage 등). */
  win(type: string, ev?: unknown): void;
  readonly active: () => FakeNode | null;
  /** 문서 수준 리스너에 이벤트 하나(click · keydown · pointerdown · focusout). */
  doc(type: string, init: { target: FakeNode; key?: string; relatedTarget?: FakeNode | null }): FakeEvent;
  go(hash: string): Promise<void>;
  /** 동시에 떠 있던 요청 수의 최댓값 — `latency` 로 부팅했을 때만 뜻이 있다(응답이 한 틱 뒤에 온다). */
  readonly peak: () => number;
  /** `timers: 'fast'` 로 부팅했을 때 스크립트가 건 `setTimeout` 지연(ms) — 실제로는 0 으로 돈다. */
  readonly delays: number[];
  /** 앱 스크립트와 같은 전역에서 코드 한 줄(`api(...)` 를 직접 부를 때). */
  script(code: string): unknown;
}

export const settle = async (): Promise<void> => {
  for (let i = 0; i < 12; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

/** 마크업에서 `id` 가 있는 요소의 태그 · hidden · class · 속성. */
function markupElements(html: string): Map<string, { tag: string; hidden: boolean; checked: boolean; className: string; attrs: Map<string, string> }> {
  const out = new Map<string, { tag: string; hidden: boolean; checked: boolean; className: string; attrs: Map<string, string> }>();
  for (const m of html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*)\bid="([^"]+)"([^>]*)>/g)) {
    const raw = `${m[2] ?? ''} ${m[4] ?? ''}`;
    const attrs = new Map<string, string>();
    for (const a of raw.matchAll(/\b([a-z][a-z0-9-]*)="([^"]*)"/g)) {
      const name = a[1] ?? '';
      if (name !== 'class' && name !== 'id') attrs.set(name, a[2] ?? '');
    }
    const bare = raw.replace(/="[^"]*"/g, '=""');
    out.set(m[3] ?? '', { tag: m[1] ?? 'div', hidden: /(^|\s)hidden(\s|$)/.test(bare), checked: /(^|\s)checked(\s|$)/.test(bare), className: /\bclass="([^"]*)"/.exec(raw)?.[1] ?? '', attrs });
  }
  return out;
}

/**
 * `latency`: 응답이 다음 매크로태스크에 온다 — 그동안 요청이 "떠 있다"(`peak()`). `timers: 'fast'`: 스크립트의 `setTimeout` 을 지연
 * 없이 돌리고 요청한 지연만 적는다(재시도 백오프 400·1200ms 를 실제로 기다리지 않는다 — 복사 문구 되돌리기도 곧바로 돈다).
 */
export async function boot(
  lang: Lang,
  hash = '',
  init: {
    readonly storage?: Map<string, string> | null;
    readonly session?: Map<string, string>;
    readonly latency?: boolean;
    readonly timers?: 'fast';
    readonly broadcast?: false;
    readonly wide?: boolean;
    readonly clipboard?: 'ok' | 'fail';
    /** 주소의 쿼리(`?dc=1&d=dm2` — DNS 업체에서 돌아올 때). */
    readonly search?: string;
  } = {},
): Promise<World> {
  // 자산(스크립트)을 되돌려 끼운 HTML — SRI 가 맞는 본문만 돈다(`inlined`).
  const html = inlined(renderAppPage(lang));
  // 머리의 테마 부트(US-014)와 본문 끝의 앱 스크립트 — 브라우저처럼 문서 순서대로 같은 전역에서 돈다.
  const scripts = blocks(html, 'script');
  const initial = markupElements(html);
  const elements = new Map<string, FakeNode>();
  const el = (id: string): FakeNode => {
    let found = elements.get(id);
    if (found === undefined) {
      const meta = initial.get(id);
      if (meta === undefined) throw new Error(`스크립트가 마크업에 없는 id를 찾는다: ${id}`);
      found = new FakeNode(meta.tag);
      found.id = id;
      found.hidden = meta.hidden;
      found.checked = meta.checked;
      if (meta.attrs.has('value')) found.value = meta.attrs.get('value') ?? '';
      found.className = meta.className;
      for (const [k, v] of meta.attrs) found.attributes.set(k, v);
      if (meta.attrs.has('type')) found.type = meta.attrs.get('type') ?? '';
      elements.set(id, found);
    }
    return found;
  };
  const calls: ApiCall[] = [];
  const downloads: Download[] = [];
  const objectUrls = { created: [] as unknown[], revoked: [] as string[] };
  // 클립보드 — 기본은 없다(예전 테스트의 "직접 선택해 복사" 길). `clipboard: 'ok' | 'fail'` 이면 writeText 가 받거나 거부한다.
  const clipboard: string[] = [];
  const navigator =
    init.clipboard === undefined
      ? {}
      : {
          clipboard: {
            writeText: (text: string) => {
              clipboard.push(String(text));
              return init.clipboard === 'ok' ? Promise.resolve() : Promise.reject(new Error('NotAllowedError'));
            },
          },
        };
  // Blob — 스크립트가 만든 글 조각과 type 만 지닌다(`objectUrls.created` 로 테스트가 꺼내 본다).
  class Blob {
    readonly parts: unknown[];
    readonly type: string;
    constructor(parts: unknown[], opts?: { type?: string }) {
      this.parts = [...parts];
      this.type = opts?.type ?? '';
    }
  }
  const location = {
    hash,
    pathname: '/app',
    search: init.search ?? '',
    replaced: [] as string[],
    replace: (to: string) => location.replaced.push(to),
    reload: () => location.replaced.push('reload'),
    // 다른 출처로 떠나기(Domain Connect 적용 URL · 결제) — 스크립트가 `location.href` 에 적는다. 가짜는 값만 남긴다.
    href: undefined as string | undefined,
  };
  // BroadcastChannel(P0 §4-1 — 다른 탭에 조직 전환 알림). 테스트가 `channels[0].onmessage` 로 다른 탭의 메시지를 흉내 낸다.
  const channels: FakeChannel[] = [];
  class BroadcastChannel implements FakeChannel {
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    readonly posted: unknown[] = [];
    constructor(readonly name: string) {
      channels.push(this);
    }
    postMessage(data: unknown): void {
      this.posted.push(data);
    }
    close(): void {}
  }
  const body = new FakeNode('body');
  const root = new FakeNode('html');
  // localStorage — `null` 이면 접근 자체가 던진다(사생활 모드·차단). 기본은 빈 저장소.
  const storage = init.storage === undefined ? new Map<string, string>() : init.storage;
  const localStorage = {
    getItem: (k: string) => {
      if (storage === null) throw new Error('SecurityError');
      return storage.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (storage === null) throw new Error('SecurityError');
      storage.set(k, String(v));
    },
    removeItem: (k: string) => {
      if (storage === null) throw new Error('SecurityError');
      storage.delete(k);
    },
  };
  const session = init.session ?? new Map<string, string>();
  const sessionStorage = {
    getItem: (k: string) => session.get(k) ?? null,
    setItem: (k: string, v: string) => void session.set(k, String(v)),
    removeItem: (k: string) => void session.delete(k),
  };
  const windowListeners = new Map<string, Array<() => void>>();
  const docListeners = new Map<string, Array<(ev: FakeEvent) => void>>();
  let activeElement: FakeNode | null = body;
  onFocus = (node) => {
    activeElement = node;
  };
  getActive = () => activeElement;
  onClick = (node) => {
    if (node.tagName === 'A') downloads.push({ href: node.href, download: node.download, attached: body.contains(node), node });
  };
  const document = {
    getElementById: el,
    createElement: (tag: string) => new FakeNode(tag),
    // 수집 카드 그림(US-013) — SVG 자식은 마크업의 <svg> 네임스페이스로 만든다. 가짜 DOM 은 태그만 본다.
    createElementNS: (_namespace: unknown, tag: string) => new FakeNode(tag),
    createTextNode: (text: string) => new FakeNode('#text', text),
    addEventListener: (type: string, fn: (ev: FakeEvent) => void) => docListeners.set(type, [...(docListeners.get(type) ?? []), fn]),
    get activeElement() {
      return activeElement;
    },
    body,
    documentElement: root,
  };
  let inFlight = 0;
  let peak = 0;
  const latency = init.latency === true;
  const delays: number[] = [];
  const scriptTimeout = init.timers === 'fast'
    ? (fn: () => void, ms?: number) => {
        delays.push(ms ?? 0);
        return setTimeout(fn, 0);
      }
    : setTimeout;
  const fetch = (url: string, req: { method: string; headers: Record<string, string>; body?: string }) => {
    const parsed = req.body === undefined ? undefined : (JSON.parse(req.body) as unknown);
    calls.push({ method: req.method, url, body: parsed, csrf: req.headers['x-atmark-csrf'] });
    const r = mockApi(req.method, url, parsed);
    inFlight++;
    peak = Math.max(peak, inFlight);
    const arrive = latency
      ? new Promise<void>((resolve) => setTimeout(() => {
          inFlight--;
          resolve();
        }, 0))
      : Promise.resolve().then(() => {
          inFlight--;
        });
    return arrive.then(() => ({
      ok: r.status < 400,
      status: r.status,
      headers: { get: (name: string) => r.headers?.[name.toLowerCase()] ?? null },
      json: () => Promise.resolve(r.json),
      blob: () => Promise.resolve({ blobOf: r.json }),
    }));
  };
  const context = vm.createContext({
    document,
    location,
    history: {
      back: () => location.replaced.push('back'),
      // v3 경로 리다이렉트(§2.3)가 한 번 부른다 — 주소창만 고치고 hashchange 는 없다(브라우저와 같다).
      // 경로 · 쿼리가 든 주소(`/app#/domains/x` — Domain Connect 복귀가 쿼리를 지운다)면 쿼리 · 조각을 나눠 적는다.
      replaceState: (_s: unknown, _t: string, to: string) => {
        location.replaced.push(`replace:${to}`);
        const at = to.indexOf('#');
        if (to.startsWith('/')) {
          const head = at < 0 ? to : to.slice(0, at);
          location.search = head.includes('?') ? head.slice(head.indexOf('?')) : '';
          location.hash = at < 0 ? '' : to.slice(at);
        } else location.hash = to;
      },
    },
    navigator,
    Blob,
    window: {
      addEventListener: (type: string, fn: () => void) => windowListeners.set(type, [...(windowListeners.get(type) ?? []), fn]),
      scrollTo: () => undefined,
      // `wide`: 창이 ≥1150 인 것처럼(사이드바 접기 = 레일 ↔ 펼침). 없으면 matchMedia 도 없다(겹침·서랍 쪽).
      ...(init.wide === true ? { matchMedia: (q: string) => ({ matches: q.includes('min-width:1150px') }) } : {}),
    },
    fetch,
    URL: {
      createObjectURL: (blob: unknown) => {
        objectUrls.created.push(blob);
        return `blob:console/${String(objectUrls.created.length)}`;
      },
      revokeObjectURL: (url: string) => objectUrls.revoked.push(url),
    },
    setTimeout: scriptTimeout,
    clearTimeout,
    ...(init.broadcast === false ? {} : { BroadcastChannel }),
    Promise,
    Date,
    localStorage,
    sessionStorage,
  });
  for (const script of scripts) vm.runInContext(script, context);
  await settle();
  return {
    el,
    channels,
    downloads,
    objectUrls,
    clipboard,
    calls,
    location,
    body,
    root,
    storage,
    session,
    win(type, ev) {
      for (const fn of windowListeners.get(type) ?? []) (fn as (e?: unknown) => void)(ev);
    },
    active: () => activeElement,
    doc(type, init) {
      const ev: FakeEvent = {
        target: init.target,
        key: init.key,
        relatedTarget: init.relatedTarget ?? null,
        defaultPrevented: false,
        preventDefault() {
          ev.defaultPrevented = true;
        },
      };
      for (const fn of docListeners.get(type) ?? []) fn(ev);
      return ev;
    },
    async go(next: string) {
      location.hash = next;
      for (const fn of windowListeners.get('hashchange') ?? []) fn();
      await settle();
    },
    peak: () => peak,
    delays,
    script: (code) => vm.runInContext(code, context) as unknown,
  };
}

/** 에이전트 스코프 화면(= 스코프 사이드바 항목, 뒤로 항목 제외) · 조직 스코프 화면(사이드바 다섯 — 조직 로그도 1단 항목 비평 R10-11 · 도메인 2026-10-05). */
export const TABS = ['overview', 'connect', 'email', 'logs', 'identity', 'tokens'] as const;
export const TOP = ['overview', 'agents', 'domains', 'watch', 'settings', 'logs'] as const;
/** 조직 사이드바 순서(2026-10-05 진윤겸 · 감시 2026-10-08) — 개요 · 에이전트 · 도메인 · 감시 · 로그 · 설정. */
export const NAV_ORG = ['overview', 'agents', 'domains', 'watch', 'logs', 'settings'] as const;
const VIEWS = ['v-overview', 'v-agents', 'v-domains', 'v-watch', 'v-logs', 'v-settings', 'v-agent'];
export function visibleView(w: World): string[] {
  return VIEWS.filter((id) => !w.el(id).hidden);
}
export function visiblePanes(w: World): string[] {
  return TABS.map((t) => `t-${t}`).filter((id) => !w.el(id).hidden);
}
