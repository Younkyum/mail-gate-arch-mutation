/**
 * 콘솔 v4(`.omc/handoffs/console-v4-design.md` · 팀 결정 D1–D9 · API 계약 `console-v4-api.md`) — 가짜 DOM 위에서 실제 앱 스크립트를 돌린다.
 *
 *   Ⓝ 스코프 내비 — 조직 사이드바(개요·에이전트·설정) ↔ 에이전트 사이드바(← 돌아가기 · 개요 · 연결 · 이메일 · 로그 · 신원 · 토큰) · 상단 스위처
 *   Ⓡ 옛 경로 리다이렉트(replaceState 한 번) · 예약 `#/o/{org}`
 *   Ⓔ 이메일 두 열 — 열마다 따로 저장 · 좁은 화면 세그먼트
 *   Ⓘ 신원 한 페이지 — 컬러 ID 카드(키 지문 → hue · 무늬) · 소속(콘솔에서만 보임) · 신원 공개 스위치(게시 ↔ 게시 중단)
 *   Ⓣ 토큰 목록 — 이름 · 토큰 값(접두사 + 가림 + 끝 4자) · 권한 · 필터 · 새 토큰(평문 한 번) · 행 메뉴(이름 바꾸기 · 교체 · 폐기) · 상한 5
 *   Ⓢ 통계(E10) · 최근 활동 · 설정(투명성 로그 · 화면)
 *   Ⓒ 카드 팔레트 대비 — 허용 hue 전부 · 라이트/다크 · 상태별 채도(oklch → sRGB 로 직접 잰다)
 *   Ⓦ 금지 문구 · 사전 1:1
 *
 * 되돌려서 빨개지는지 확인한 것(2026-09-25): `artHue` 의 `u+50` 을 `u` 로 → Ⓘ-1 · `saveMode` 본문을 두 방향 다 싣게 → Ⓔ-2 ·
 * `renderScope` 의 `nav-agent` hidden 토글을 빼면 → Ⓝ-1 · 옛 경로 `redirect` 처리(`history.replaceState`)를 빼면 → Ⓡ-1 ·
 * 토큰 행의 `tokenHint` 가 힌트 모양 검사 없이 값을 그대로 쓰게 → Ⓣ-1(`<script>` 힌트) · `--id-label` 라이트 L 을 60% 로 → Ⓒ-1.
 */

import vm from 'node:vm';

import { afterEach, describe, expect, it } from 'vitest';

import { ART_JS } from '../../../src/admin/ui/app';
import { MESSAGES } from '../../../src/admin/ui/i18n';
import { renderAppPage, type Lang } from '../../../src/admin/ui/index';
import { ADMIN_UI_CSS, CONSOLE_DARK, CONSOLE_LIGHT } from '../../../src/admin/ui/styles';

import { AGENT, blocks, boot, type FakeEvent, type FakeNode, HANGUL, inlined, NEW_TOKEN, OVERRIDE, POLICY, PUBLISHED_IDENTITY, settle, STATS, t, TOKENS, type World } from './console-harness';

afterEach(() => OVERRIDE.clear());

const LANGS = ['ko', 'en'] as const;
const tf = (lang: Lang, ko: string, o: Record<string, string | number>): string => t(lang, ko).replace(/\{([a-zA-Z]+)\}/g, (_, k: string) => String(o[k]));
const find = (root: FakeNode, pred: (n: FakeNode) => boolean): FakeNode[] => root.all().filter(pred);
const KEY_FP = AGENT.keyFingerprint;
const art = (() => {
  const context = vm.createContext({});
  vm.runInContext(ART_JS, context);
  return {
    hue: (hex: string): number | null => vm.runInContext('artHue', context)(hex) as number | null,
    params: (hex: string): Record<string, number> | null => vm.runInContext('artParams', context)(hex) as Record<string, number> | null,
  };
})();
/** 문서 수준 리스너가 아닌, 요소에 붙은 keydown 리스너를 부른다(메뉴 방향키). */
function key(node: FakeNode, k: string): void {
  const ev = { target: node, key: k, defaultPrevented: false, preventDefault() {} } as FakeEvent;
  for (const fn of node.listeners.get('keydown') ?? []) fn.call(node, ev);
}
const shapes = (svg: FakeNode): string[] => svg.children.map((c) => `${c.tagName}:${[...c.attributes.entries()].map(([k, v]) => `${k}=${v}`).join(',')}`);
const TWO = [AGENT, { ...AGENT, id: 'a2', name: 'research-bot', address: 'research@atmark.ai', status: 'suspended', suspendedBy: 'owner', identityStatus: 'draft', keyFingerprint: null }];

// ---------------------------------------------------------------------------
// Ⓝ 스코프 내비 · 스위처
// ---------------------------------------------------------------------------

describe.each(LANGS)('Ⓝ 스코프 내비 (%s)', (lang) => {
  const html = inlined(renderAppPage(lang));

  it('Ⓝ-0 마크업 — 조직 사이드바 다섯(로그 포함 R10-11 · 도메인 2026-10-05) · 에이전트 사이드바는 ← 돌아가기(창업자 문구, D4) + 일곱 항목(이 순서 — 주소는 이메일 뒤, 2026-09-29) · 돌아가기는 늘 #/agents', () => {
    expect([...html.matchAll(/<a href="#\/([a-z]+)" id="n-\1">/g)].map((m) => m[1])).toEqual(['overview', 'agents', 'domains', 'watch', 'logs', 'settings']);
    expect([...html.matchAll(/<a href="#\/agents" id="na-([a-z]+)">/g)].map((m) => m[1])).toEqual(['overview', 'connect', 'email', 'addresses', 'webhooks', 'logs', 'identity', 'tokens']);
    const back = /<a href="#\/agents" class="nav-back" id="na-back"><svg class="ico"[^>]*>([^]*?)<\/svg><span>([^<]+)<\/span><\/a>/.exec(html);
    expect(back?.[2]).toBe(lang === 'ko' ? '에이전트' : 'Agents'); // ← {부모 이름}(2026-10-15 F38)
    expect(back?.[1]).toBe('<path d="M13 8H3.5M7.5 4L3.5 8l4 4"/>'); // ← 화살표
    expect(html.indexOf('id="na-back"')).toBeLessThan(html.indexOf('id="na-overview"'));
    // 조직 사이드바에서 빠진 것(D5): 로그 · 신원. 에이전트 쪽에서 빠진 것(D6): 위험 구역.
    for (const gone of ['id="n-identity"', 'id="v-identity"', 'id="t-danger"', 'id="tab-danger"', 'id="side-agents"']) expect(html).not.toContain(gone);
    // 상단 바 스위처 — 버튼마다 aria-haspopup=menu · aria-expanded · aria-controls.
    // 콘솔 v5: 조직 조각 = 이름 링크(개요) + ⇅ 스위처 버튼, 에이전트 조각 = 이름 버튼(스위처).
    expect(html).toMatch(/<a class="crumb-home" id="top-home" href="#\/overview">/);
    expect(html).toMatch(new RegExp('<button type="button" class="sw-btn sw-caret" id="sw-org" aria-haspopup="menu" aria-expanded="false" aria-controls="sw-org-menu">'));
    expect(html).toMatch(new RegExp('<button type="button" class="sw-btn" id="sw-ag" aria-haspopup="menu" aria-expanded="false" aria-controls="sw-ag-menu">'));
  });

  it('Ⓝ-1 사이드바가 스코프에 따라 통째로 바뀐다 · 활성 항목 · 스코프 머리(이름 · 주소) · 상단 바의 에이전트 조각', async () => {
    const w = await boot(lang, '#/overview');
    expect(w.el('nav-org').hidden).toBe(false);
    expect(w.el('nav-agent').hidden).toBe(true);
    expect(w.el('sw-ag-w').hidden).toBe(true);
    expect(w.body.classList.contains('scope-agent')).toBe(false);
    await w.go('#/agents/a1/tokens');
    expect(w.el('nav-org').hidden).toBe(true);
    expect(w.el('nav-agent').hidden).toBe(false);
    expect(w.el('sw-ag-w').hidden).toBe(false);
    expect(w.el('sep-ag').hidden).toBe(false);
    expect(w.body.classList.contains('scope-agent')).toBe(true);
    expect(w.el('na-tokens').getAttribute('aria-current')).toBe('page');
    expect(w.el('na-overview').getAttribute('aria-current')).toBeNull();
    expect(w.el('na-identity').href).toBe('#/agents/a1/identity');
    expect(w.el('na-overview').href).toBe('#/agents/a1');
    expect(w.el('sc-name').textContent).toBe(AGENT.name);
    expect(w.el('sc-addr').textContent).toBe(AGENT.address);
    expect(w.el('sw-ag-name').textContent).toBe(AGENT.name);
    // 썸네일: 키 hue 가 CSSOM 으로 들어간다(유채색은 이 표면에만 — D1).
    expect(w.el('sc-thumb').style['--h']).toBe(String(art.hue(KEY_FP)));
    // 돌아가기 → 조직 스코프.
    await w.go('#/agents');
    expect(w.el('nav-agent').hidden).toBe(true);
    expect(w.el('n-agents').getAttribute('aria-current')).toBe('page');
  });

  it('Ⓝ-2 에이전트 스위처 — 같은 페이지로 전환(/tokens는 /tokens) · 검색 · Esc는 닫고 버튼으로 · 바깥 클릭은 닫기 · 새 에이전트는 그 자리에서 만들기 대화상자', async () => {
    OVERRIDE.set('/api/agents', { status: 200, json: TWO });
    const w = await boot(lang, '#/agents/a1/tokens');
    const btn = w.el('sw-ag');
    btn.dispatch('click');
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(w.el('sw-ag-menu').hidden).toBe(false);
    expect(w.active()).toBe(w.el('sw-q'));
    const items = (): FakeNode[] => w.el('swa-list').children.map((li) => li.children[0] as FakeNode);
    expect(items().map((a) => a.href)).toEqual(['#/agents/a1/tokens', '#/agents/a2/tokens']);
    expect(items()[0]?.getAttribute('aria-current')).toBe('true');
    expect(items()[0]?.getAttribute('role')).toBe('menuitem');
    w.el('sw-q').value = 'RESEARCH';
    w.el('sw-q').dispatch('input');
    expect(items().map((a) => a.href)).toEqual(['#/agents/a2/tokens']);
    w.el('sw-q').value = 'zzz';
    w.el('sw-q').dispatch('input');
    expect(items()).toHaveLength(0);
    expect(w.el('swa-none').hidden).toBe(false);
    w.doc('keydown', { target: w.el('sw-q'), key: 'Escape' });
    expect(w.el('sw-ag-menu').hidden).toBe(true);
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(w.active()).toBe(btn);
    // 방향키로 열기 — 닫혀 있던 메뉴가 열린다.
    key(btn, 'ArrowDown');
    expect(w.el('sw-ag-menu').hidden).toBe(false);
    w.doc('pointerdown', { target: w.el('main') });
    expect(w.el('sw-ag-menu').hidden).toBe(true);
    // 이메일 방향까지 같은 자리로.
    await w.go('#/agents/a1/email/inbound');
    btn.dispatch('click');
    expect(items().map((a) => a.href)).toEqual(['#/agents/a1/email/inbound', '#/agents/a2/email/inbound']);
    // 새 에이전트 → 화면은 그대로, 만들기 대화상자(2026-09-30 — 라이트박스). 메뉴는 닫히고 Esc 는 포커스를 스위처 버튼으로 돌려준다.
    w.el('swa-new').dispatch('click');
    expect(w.location.hash).toBe('#/agents/a1/email/inbound');
    expect(w.el('sw-ag-menu').hidden).toBe(true);
    expect(w.el('dlg-newagent').open).toBe(true);
    expect(w.active()).toBe(w.el('na-name'));
    w.el('dlg-newagent').esc();
    expect(w.el('dlg-newagent').open).toBe(false);
    expect(w.active()).toBe(btn);
  });

  it('Ⓝ-3 조직 스위처 — memberships(E11)로만 그린다: 현재 조직(역할 칩) ✓ · 조직 설정 · 새 조직 만들기 · 한 번에 메뉴 하나', async () => {
    const w = await boot(lang, '#/overview');
    w.el('sw-org').dispatch('click');
    expect(w.el('sw-org-menu').hidden).toBe(false);
    const rows = w.el('swo-list').children;
    expect(rows).toHaveLength(1);
    const cur = rows[0]?.children[0] as FakeNode;
    expect(cur.href).toBe('#/overview');
    expect(cur.getAttribute('aria-current')).toBe('true');
    expect(cur.textContent).toBe(`Chronostasis${t(lang, '소유자')}`); // ✓ 는 선 아이콘(비평 R10-06)
    expect(w.el('swo-settings').getAttribute('href')).toBe('#/settings');
    await w.go('#/agents/a1');
    w.el('sw-org').dispatch('click');
    w.el('sw-ag').dispatch('click');
    expect(w.el('sw-org-menu').hidden).toBe(true);
    expect(w.el('sw-ag-menu').hidden).toBe(false);
    w.el('swo-new').dispatch('click');
    expect(w.el('dlg-neworg').open).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Ⓡ 옛 경로 → 새 경로(한 번)
// ---------------------------------------------------------------------------

describe.each(LANGS)('Ⓡ 리다이렉트 (%s)', (lang) => {
  it.each([
    ['#/agents/a1/outbound', '#/agents/a1/email/outbound', 't-email'],
    ['#/agents/a1/inbound', '#/agents/a1/email/inbound', 't-email'],
    ['#/agents/a1/danger', '#/agents/a1', 't-overview'],
  ])('Ⓡ-1 %s → %s (replaceState 한 번 · 그 화면)', async (from, to, pane) => {
    const w = await boot(lang, from);
    expect(w.location.replaced.filter((r) => r.startsWith('replace:'))).toEqual([`replace:${to}`]);
    expect(w.location.hash).toBe(to);
    expect(w.el(pane).hidden).toBe(false);
    if (from.endsWith('/inbound')) expect(w.el('em-cols').className).toBe('em-cols show-inbound');
    if (from.endsWith('/danger')) expect(w.active()).toBe(w.el('dz-kill'));
  });

  it('Ⓡ-2 #/identity → #/agents · #/o/{현재 조직}/… → 정규 경로 · 다른 조직의 링크 → 개요 + 한 줄', async () => {
    const w = await boot(lang, '#/identity');
    expect(w.location.hash).toBe('#/agents');
    expect(w.el('v-agents').hidden).toBe(false);
    const o = await boot(lang, '#/o/o1/agents/a1/tokens');
    expect(o.location.hash).toBe('#/agents/a1/tokens');
    expect(o.el('t-tokens').hidden).toBe(false);
    const x = await boot(lang, '#/o/other-org/agents/a1/tokens');
    expect(x.el('v-overview').hidden).toBe(false);
    expect(x.el('v-agent').hidden).toBe(true);
    expect(x.el('org-other').hidden).toBe(false);
    expect(inlined(renderAppPage(lang))).toContain(`<div class="banner bar" id="org-other" role="status" hidden><span>${t(lang, '다른 조직의 링크입니다.')}</span>`);
    // 멤버십에 없는 조직이면 전환 버튼도 없다(P0 §4-3 — 전환 버튼은 멤버십이 있을 때만, 자동 전환은 없음).
    expect(x.el('org-other-go').hidden).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Ⓔ 이메일 — 발신 | 수신 두 열(채널 공통 컴포넌트)
// ---------------------------------------------------------------------------

describe.each(LANGS)('Ⓔ 이메일 두 열 (%s)', (lang) => {
  it('Ⓔ-0 마크업 — 두 열 모두 dirPanel: 네이티브 라디오 넷(글자 번호 없음) · 열 제목 발신/수신(질문형 아님) · 열마다 저장·되돌리기', () => {
    const html = inlined(renderAppPage(lang));
    for (const [dir, p] of [['outbound', 'o'], ['inbound', 'i']] as const) {
      const col = new RegExp(`<section class="dirp" id="col-${dir}" data-channel="email"[\\s\\S]*?</section>(?=<section class="dirp"|</div>)`).exec(html)?.[0] ?? '';
      expect(col.length, dir).toBeGreaterThan(500);
      expect(col).toContain(`<h2 id="h-${p}-col">${t(lang, dir === 'outbound' ? '발신' : '수신')}</h2>`);
      expect(col).toContain(`role="radiogroup" aria-labelledby="h-${p}-col"`);
      expect([...col.matchAll(/<input type="radio" name="[oi]-mode" value="([a-z]+)"/g)].map((m) => m[1])).toEqual(['all', 'allowlist', 'blocklist', 'none']);
      expect(col).toContain(`id="${p}-go" disabled`);
      expect(col).toContain(`id="${p}-cancel" disabled`);
      expect(col).not.toMatch(/누구에게 보낼 수 있나|누구의 메일을 받나/);
    }
    expect(html).toContain('<button type="button" role="radio" id="em-t-outbound" aria-controls="col-outbound" aria-checked="true" tabindex="0">');
  });

  it('Ⓔ-1 모드 한 줄 · 쓰지 않는 목록은 접힘(개수와 함께) · 좁은 화면 세그먼트(라디오 그룹)는 aria-checked와 주소(replaceState)를 같이 바꾼다', async () => {
    const w = await boot(lang, '#/agents/a1/email');
    expect(w.el('em-addr').textContent).toBe(AGENT.address);
    expect(w.el('o-mline').textContent).toBe(t(lang, '목록에 있는 상대에게만 보냅니다.'));
    expect(w.el('i-mline').textContent).toBe(t(lang, '모든 메일을 받습니다.'));
    expect(w.el('i-unused').hidden).toBe(false);
    expect(w.el('i-unused-s').textContent).toBe(`${t(lang, '쓰지 않는 목록 (')}${tf(lang, '허용 {n}', { n: 0 })} · ${tf(lang, '차단 {n}', { n: 0 })})`);
    expect(w.el('em-cols').className).toBe('em-cols show-outbound');
    w.el('em-t-inbound').dispatch('click');
    expect(w.el('em-cols').className).toBe('em-cols show-inbound');
    expect(w.el('em-t-inbound').getAttribute('aria-checked')).toBe('true');
    expect(w.el('em-t-outbound').getAttribute('aria-checked')).toBe('false');
    expect(w.location.replaced).toContain('replace:#/agents/a1/email/inbound');
    // 모드를 고르면 한 줄이 따라 바뀐다(저장 전).
    w.el('im-none-i').value = 'none';
    w.el('im-none-i').dispatch('change');
    expect(w.el('i-mline').textContent).toBe(t(lang, '모두 보류합니다.'));
    expect(w.el('i-warn-none').hidden).toBe(false);
  });

  it('Ⓔ-2 열마다 따로 저장 — 수신 저장은 {inbound}만 · 발신 저장은 {outbound}만 · 한쪽 초안이 다른 쪽 저장에 섞이지 않는다', async () => {
    const w = await boot(lang, '#/agents/a1/email');
    w.el('im-allowlist-i').value = 'allowlist';
    w.el('im-allowlist-i').dispatch('change');
    w.el('om-blocklist-i').value = 'blocklist';
    w.el('om-blocklist-i').dispatch('change');
    expect(w.el('i-go').disabled).toBe(false);
    expect(w.el('o-go').disabled).toBe(false);
    w.el('i-go').dispatch('click');
    w.el('dc-ok').onclick?.();
    await settle();
    w.el('o-go').dispatch('click');
    w.el('dc-ok').onclick?.();
    await settle();
    const patches = w.calls.filter((c) => c.method === 'PATCH' && c.url === '/api/agents/a1/channels/email/policy');
    expect(patches.map((c) => c.body)).toEqual([{ inbound: { mode: 'allowlist' } }, { outbound: { mode: 'blocklist' } }]);
    for (const c of patches) expect(c.csrf).toBe('csrf-1');
    // 되돌리기 — 그 열의 초안만 지운다.
    w.el('im-none-i').value = 'none';
    w.el('im-none-i').dispatch('change');
    w.el('i-cancel').dispatch('click');
    expect(w.el('i-go').disabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Ⓘ 신원 한 페이지
// ---------------------------------------------------------------------------

describe('Ⓘ 신원 무늬 — 순수 함수(ART_JS)', () => {
  it('Ⓘ-1 hue는 0..65535 전부에서 주황 대역 25–75° 와 파랑 대역(OKLCH) 180–295° 를 내지 않고, [0,25) ∪ [75,180) ∪ [295,360)을 빠짐없이 쓴다', () => {
    const seen = new Set<number>();
    for (let v = 0; v < 65536; v++) {
      const h = art.hue(v.toString(16).padStart(4, '0') + '0'.repeat(60));
      expect(h === null || (h >= 25 && h < 75) || h < 0 || h >= 360, String(v)).toBe(false);
      // 창업자 규칙 "파랑 0"(비평 R1-23) — 신원 표면에도 파랑·청록 hue 는 없다.
      // OKLCH hue: 순수 파랑 #0000FF ≈ 264°, 남색 #4F46E5 ≈ 277° — 이 대역 전체(180–295)를 뺀다(비평 R4-06).
      expect((h as number) >= 180 && (h as number) < 295, `blue ${String(h)}`).toBe(false);
      seen.add(h as number);
    }
    expect(seen.size).toBe(195);
    expect(Math.min(...seen)).toBe(0);
    expect(Math.max(...seen)).toBe(359);
  });

  it('Ⓘ-1b 파생 hue(h2 · h3 · h4)도 65536 입력 전부에서 주황 25–75° · 파랑 180–295° 밖 — CSS는 각도를 더하지 않는다(비평 R5-01)', () => {
    const bad = (h: number): boolean => (h >= 25 && h < 75) || (h >= 180 && h < 295) || h < 0 || h >= 360;
    for (let v = 0; v < 65536; v++) {
      const p = art.params(v.toString(16).padStart(4, '0') + '0'.repeat(60)) as Record<string, number>;
      for (const k of ['h', 'h2', 'h3', 'h4']) expect(bad(p[k] as number), `${String(v)} ${k}=${String(p[k])}`).toBe(false);
    }
    expect(ADMIN_UI_CSS).not.toMatch(/calc\(var\(--h\)/);
    // 기본값(지문이 없을 때의 카드)도 허용 집합 안.
    const base = /\.idc,\.idthumb\{([^}]*)\}/.exec(ADMIN_UI_CSS)?.[1] ?? '';
    for (const k of ['h', 'h2', 'h3', 'h4']) {
      const d = Number(new RegExp(`--${k}:(\\d+)`).exec(base)?.[1]);
      expect(Number.isFinite(d), `--${k} 기본값`).toBe(true);
      expect(bad(d), `--${k}:${String(d)}`).toBe(false);
    }
  });

  it('Ⓘ-2 결정적 — 같은 지문은 같은 값 · 지문이 아니면 null(회색 카드)', () => {
    expect(art.params(KEY_FP)).toEqual(art.params(KEY_FP));
    const p = art.params(KEY_FP) as Record<string, number>;
    expect(p['h']).toBe(art.hue(KEY_FP));
    expect(p['n']).toBeGreaterThanOrEqual(5);
    expect(p['n']).toBeLessThanOrEqual(12);
    expect(p['k']).toBeGreaterThanOrEqual(7);
    expect(p['k']).toBeLessThanOrEqual(11);
    for (const bad of ['', 'xyz', KEY_FP.toUpperCase(), `${KEY_FP}0`]) expect(art.params(bad)).toBeNull();
  });
});

describe.each(LANGS)('Ⓘ 신원 화면 (%s)', (lang) => {
  const html = inlined(renderAppPage(lang));
  const pane = /<div class="pane" id="t-identity"[\s\S]*?<\/section><\/div>/.exec(html)?.[0] ?? '';
  const ident = (over: Record<string, unknown>) => ({ status: 200, json: { ...PUBLISHED_IDENTITY, issuedAt: '2026-09-24T15:30:00Z', validUntil: '2026-12-22T15:30:00Z', ...over } });

  it('Ⓘ-3 구성 — 탭 없음 · 공개 문서 절에 신원 공개 스위치 · 왼쪽 세로 카드 · 오른쪽 정보 · 아래 변경 이력 · 소속은 "콘솔에서만 보임"', () => {
    expect(pane.length).toBeGreaterThan(2000);
    expect(pane).toContain(`<span class="idsw-l" id="id-sw-l">${t(lang, '신원 공개')}</span><button type="button" class="switch" id="id-switch" role="switch" aria-checked="false" aria-labelledby="id-sw-l" aria-describedby="id-sw-line">`);
    const lay = pane.indexOf('<div class="idlay">');
    // 신원 공개 스위치는 '공개 문서' 절 안의 한 줄(2026-10-15 F69 — 머리에 혼자 있던 것)
    expect(pane.indexOf('id="id-switch"')).toBeGreaterThan(pane.indexOf('id="h-id-docs"'));
    expect(pane.indexOf('<article class="idc" id="idc"', lay)).toBeLessThan(pane.indexOf('<div class="idinfo">', lay)); // 카드 왼쪽, 정보 오른쪽(DOM 순서)
    expect(pane.indexOf('id="ib"')).toBeGreaterThan(pane.indexOf('<div class="idinfo">'));
    const card = /<article class="idc" id="idc"[\s\S]*?<\/article>/.exec(pane)?.[0] ?? '';
    // 카드: 소속(조직 이름 + 눈 감김 + "콘솔에서만 보임") · 로고 · 무늬(role=img) · 이름 · 주소 · DID · 검증 마크 · 발급/만료/버전 · 상태 · 마이크로프린트.
    for (const id of ['idc-org', 'idc-svg', 'idc-name', 'idc-addr', 'ai-did', 'idc-seal', 'idc-issued', 'idc-until', 'idc-ver', 'idc-badge', 'idc-micro', 'ai-wm', 'ai-stamp']) expect(card, id).toContain(`id="${id}"`);
    expect(card).toContain(`<span class="sr">${t(lang, '콘솔에서만 보임')}</span>`);
    expect(card).toContain('<svg class="idc-svg" id="idc-svg" viewBox="0 0 100 100" role="img"');
    expect(card).toContain('<p class="micro" id="idc-micro" aria-hidden="true">');
    expect(card.indexOf('id="idc-org"')).toBeLessThan(card.indexOf('id="idc-svg"')); // 소속이 맨 위(사원증형 — D9)
    // 정보: 소속 + 콘솔 전용 표시 + ⓘ · 식별자 · 서명 · 공개 문서 · 기술 정보.
    expect(pane).toContain(`<span>${t(lang, '콘솔에서만 보임')}</span></span></p>`);
    expect(pane).toContain('id="tipb-id-org"');
    for (const id of ['ai-did-v', 'ai-addr', 'ai-agent', 'ai-pp', 'ai-key', 'ai-jws', 'ai-links', 'ai-at', 'ai-hash']) expect(pane, id).toContain(`id="${id}"`);
    // 없어진 것: 뷰 전환 · 뒤집기 · 뒷면 · MRZ · 게시/중단 버튼 쌍.
    for (const gone of ['ai-v-card', 'ai-v-clt', 'ai-flip', 'idc-back', 'ai-mrz', 'ai-publish', 'ai-suspend']) expect(html, gone).not.toContain(`id="${gone}"`);
  });

  it('Ⓘ-4 게시됨 — 카드 hue = 키 지문(CSSOM --h) · 소속 · 이름 · DID(짧게/전체) · 서명 마크는 JWS가 있을 때만 · 스위치 켜짐', async () => {
    OVERRIDE.set('/api/agents/a1/identity', ident({ did: 'did:web:id.atmark.ai:agents:ag_01J9Z3F0KQ', passportJwsUrl: 'https://id.atmark.ai/agents/a1/passport.jws' }));
    const w = await boot(lang, '#/agents/a1/identity');
    expect(w.el('idc').className).toBe('idc st-published');
    expect(w.el('idc').style['--h']).toBe(String(art.hue(KEY_FP)));
    expect(w.el('idc-org').textContent).toBe('Chronostasis');
    expect(w.el('ai-org').textContent).toBe('Chronostasis');
    expect(w.el('idc-name').textContent).toBe(AGENT.name);
    expect(w.el('idc-addr').textContent).toBe(AGENT.address);
    expect(w.el('ai-did').textContent).toBe('did:web:id.atmark.ai:agents:ag_0…F0KQ');
    expect(w.el('ai-did-v').textContent).toBe('did:web:id.atmark.ai:agents:ag_01J9Z3F0KQ');
    expect(w.el('idc-seal').hidden).toBe(false);
    expect(w.el('idc-issued').textContent).toBe(lang === 'en' ? 'Sep 25, 2026' : '2026.09.25');
    expect(w.el('idc-until').textContent).toBe(lang === 'en' ? 'Dec 23, 2026' : '2026.12.23');
    expect(w.el('idc-ver').textContent).toBe('v2');
    expect(w.el('idc-badge').textContent).toBe(t(lang, '게시됨'));
    expect(w.el('idc-micro').textContent).toBe(KEY_FP.toUpperCase().repeat(3));
    expect(w.el('ai-key').textContent).toBe(`Ed25519 · ${KEY_FP.slice(0, 4)} ${KEY_FP.slice(4, 8)} ${KEY_FP.slice(8, 12)} ${KEY_FP.slice(12, 16)} … ${KEY_FP.slice(-8)}`);
    expect(w.el('ai-jws-li').hidden).toBe(false);
    expect(w.el('idc-svg').getAttribute('aria-label')).toBe(tf(lang, '{n}의 신원 무늬', { n: AGENT.name }));
    expect(w.el('id-switch').getAttribute('aria-checked')).toBe('true');
    expect(w.el('id-switch').getAttribute('aria-disabled')).toBe('false');
    // 무늬: 로제트 k 겹 + 물결 테두리 + 원판 + 시질 — 클래스만(색 속성 없음), 같은 지문이면 같은 그림.
    const p = art.params(KEY_FP) as Record<string, number>;
    const drawn = shapes(w.el('idc-svg'));
    expect(drawn).toHaveLength((p['k'] ?? 0) + 3);
    for (const s of drawn) expect(s).not.toMatch(/fill=|stroke=|style=/);
    expect(shapes((await boot(lang, '#/agents/a1/identity')).el('idc-svg'))).toEqual(drawn);
    OVERRIDE.set('/api/agents/a1/identity', ident({ keyFingerprint: '0123456789abcdef'.repeat(4) }));
    const other = await boot(lang, '#/agents/a1/identity');
    expect(shapes(other.el('idc-svg'))).not.toEqual(drawn);
    expect(other.el('idc').style['--h']).toBe(String(art.hue('0123456789abcdef'.repeat(4))));
    // JWS 가 없으면 서명 마크도 없다(사실인 것만 — §3.5).
    OVERRIDE.set('/api/agents/a1/identity', ident({}));
    expect((await boot(lang, '#/agents/a1/identity')).el('idc-seal').hidden).toBe(true);
  });

  it('Ⓘ-5 스위치 끄기 = 게시 중단(문서는 남는다 — 확인 대화상자가 그렇게 말한다) → POST suspend · 켜기 = 게시 → POST publish', async () => {
    const w = await boot(lang, '#/agents/a1/identity');
    w.el('id-switch').dispatch('click');
    expect(w.el('dlg-confirm').open).toBe(true);
    expect(w.el('dc-body').textContent).toContain(t(lang, '문서는 남고 ‘게시 중단’ 상태로 바뀝니다. 다시 켜면 게시됨으로 돌아옵니다.'));
    expect(w.el('dc-ok').disabled).toBe(true); // 확인란
    w.el('dc-ack').checked = true;
    w.el('dc-ack').onchange?.();
    w.el('dc-ok').onclick?.();
    await settle();
    expect(w.calls.find((c) => c.method === 'POST' && c.url === '/api/agents/a1/identity/suspend')?.csrf).toBe('csrf-1');

    OVERRIDE.set('/api/agents/a1/identity', ident({ status: 'draft', did: null, version: 0, publishedAt: null, issuedAt: null, validUntil: null, didDocumentUrl: null, passportUrl: null }));
    const d = await boot(lang, '#/agents/a1/identity');
    expect(d.el('idc').className).toBe('idc st-draft');
    expect(d.el('ai-wm').hidden).toBe(false);
    expect(d.el('ai-did').textContent).toBe(t(lang, '게시하면 정해집니다'));
    expect(d.el('id-switch').getAttribute('aria-checked')).toBe('false');
    d.el('id-switch').dispatch('click');
    expect(d.el('dc-body').textContent).toContain(t(lang, '이름·주소·DID가 공개 문서로 게시됩니다. 조직 이름은 들어가지 않습니다.'));
    d.el('dc-ok').onclick?.();
    await settle();
    expect(d.calls.some((c) => c.method === 'POST' && c.url === '/api/agents/a1/identity/publish')).toBe(true);
  });

  it('Ⓘ-6 상태별 — 게시 중단(꺼짐 + "게시 중단됨" + 한 줄) · 폐기(잠김 · 도장 · 회색) · 키 없음(회색 · "키 준비 중")', async () => {
    OVERRIDE.set('/api/agents/a1/identity', ident({ status: 'suspended' }));
    const s = await boot(lang, '#/agents/a1/identity');
    expect(s.el('idc').className).toBe('idc st-suspended');
    expect(s.el('id-switch').getAttribute('aria-checked')).toBe('false');
    expect(s.el('id-sw-st').textContent).toBe(t(lang, '게시 중단됨'));
    expect(s.el('id-sw-line').textContent).toBe(t(lang, '공개 문서에는 ‘게시 중단’으로 표시됩니다.'));
    expect(s.el('ai-did-li').hidden).toBe(false); // 받는 쪽이 "중단"을 확인하는 경로는 남는다
    s.el('id-switch').dispatch('click');
    expect(s.el('dc-title').textContent).toBe(t(lang, '{n}의 신원을 다시 게시할까요?').replace('{n}', AGENT.name));

    OVERRIDE.set('/api/agents/a1/identity', ident({ status: 'revoked' }));
    const r = await boot(lang, '#/agents/a1/identity');
    expect(r.el('idc').className).toBe('idc st-revoked');
    expect(r.el('ai-stamp').hidden).toBe(false);
    expect(r.el('id-switch').getAttribute('aria-disabled')).toBe('true');
    expect(r.el('id-sw-line').textContent).toBe(t(lang, '폐기된 신원입니다.'));
    r.el('id-switch').dispatch('click');
    expect(r.el('dlg-confirm').open).toBe(false);

    OVERRIDE.set('/api/agents', { status: 200, json: [{ ...AGENT, keyFingerprint: null }] });
    OVERRIDE.set('/api/agents/a1/identity', ident({ keyFingerprint: null }));
    OVERRIDE.set('/api/agents/a1/identity-blocks', { status: 200, json: { blocks: [], missing: [], card: { keyFingerprint: null } } });
    const n = await boot(lang, '#/agents/a1/identity');
    expect(n.el('idc').className).toBe('idc st-published nokey');
    expect(n.el('idc').style['--h']).toBeUndefined();
    expect(n.el('ai-key').textContent).toBe(t(lang, '키 준비 중'));
    expect(shapes(n.el('idc-svg'))).toEqual(['CIRCLE:cx=50,cy=50,r=30,class=nokey']);
  });

  it('Ⓘ-7 수동 다시 서명(L4) — 게시됨일 때만 서명 정보 머리의 보조 동작 · v3 확인 문구 → POST publish · 스위치는 그대로(끄기 = 중단) · 처리 중이면 잠김', async () => {
    expect(pane).toContain(`<h2 id="h-id-sig">${t(lang, '서명 정보')}</h2></div><button type="button" class="btn sm ghost" id="ai-resign" hidden>${t(lang, '다시 서명')}</button>`);
    const w = await boot(lang, '#/agents/a1/identity');
    const rs = w.el('ai-resign');
    expect(rs.hidden).toBe(false);
    expect(rs.disabled).toBe(false);
    rs.dispatch('click');
    expect(w.el('dlg-confirm').open).toBe(true);
    expect(w.el('dc-title').textContent).toBe(t(lang, '{n}의 신원 문서를 다시 서명할까요?').replace('{n}', AGENT.name));
    expect(w.el('dc-body').textContent).toBe(
      t(lang, 'DID 문서와 패스포트를 서명해 id.atmark.ai에 게시합니다. 누구나 읽을 수 있는 공개 문서입니다.') + t(lang, '목록 내용과 수치, 조직 이름은 싣지 않습니다.'),
    );
    expect(w.el('dc-ok').textContent).toBe(t(lang, '다시 서명'));
    w.el('dc-ok').onclick?.();
    await settle();
    expect(w.calls.filter((c) => c.method === 'POST' && c.url.startsWith('/api/agents/a1/identity/')).map((c) => [c.url, c.csrf])).toEqual([
      ['/api/agents/a1/identity/publish', 'csrf-1'],
    ]);
    // 스위치는 여전히 끄기 = 게시 중단.
    w.el('id-switch').dispatch('click');
    expect(w.el('dc-title').textContent).toBe(t(lang, '{n}의 신원 게시를 중단할까요?').replace('{n}', AGENT.name));
    // 게시 전 · 게시 중단 · 폐기에는 없다.
    for (const status of ['draft', 'suspended', 'revoked']) {
      OVERRIDE.set('/api/agents/a1/identity', ident({ status }));
      expect((await boot(lang, '#/agents/a1/identity')).el('ai-resign').hidden, status).toBe(true);
    }
    // 처리 중(대기 요청)이면 잠긴다.
    OVERRIDE.set('/api/agents/a1/identity', ident({ pending: { kind: 'resign', requestedAt: '2026-09-25T00:00:00Z' } }));
    const p = await boot(lang, '#/agents/a1/identity');
    expect(p.el('ai-resign').hidden).toBe(false);
    expect(p.el('ai-resign').disabled).toBe(true);
    p.el('ai-resign').dispatch('click');
    expect(p.el('dlg-confirm').open).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Ⓣ 토큰 목록
// ---------------------------------------------------------------------------

describe.each(LANGS)('Ⓣ 토큰 (%s)', (lang) => {
  const rowsOf = (w: World): FakeNode[] => w.el('tk-body').children;
  const cellText = (tr: FakeNode | undefined, label: string): string => tr?.children.find((c) => c.getAttribute('data-label') === t(lang, label))?.textContent ?? '(없음)';
  const menuItem = (tr: FakeNode | undefined, label: string): FakeNode | undefined => find(tr as FakeNode, (n) => n.className.split(' ').includes('mi') && n.textContent === t(lang, label))[0];
  const moreBtn = (tr: FakeNode | undefined): FakeNode => find(tr as FakeNode, (n) => n.className.includes('more-btn'))[0] as FakeNode;

  it('Ⓣ-1 목록 — 한 번의 status=all 호출 · 활성 필터가 기본 · 이름 · 토큰 값 · 권한 칩 · 만든 날 · 마지막 사용 · 만료 · 개수 n / 5', async () => {
    const w = await boot(lang, '#/agents/a1/tokens');
    expect(w.calls.filter((c) => c.url.startsWith('/api/agents/a1/tokens')).map((c) => c.url)).toEqual(['/api/agents/a1/tokens?status=all']);
    expect(w.el('tk-count').textContent).toBe('2 / 5');
    expect(w.el('tk-f-endn').textContent).toBe('(1)'); // 끝난 토큰 수 — 필터는 확인란 하나(F40)
    expect(w.el('tk-f-all').checked).toBe(false);
    const rows = rowsOf(w);
    expect(rows).toHaveLength(2);
    expect(cellText(rows[0], '이름')).toBe('prod-mcp');
    expect(cellText(rows[0], '토큰 값')).toBe('atk_agent_••••••••x7Qa');
    expect(cellText(rows[0], '권한')).toBe(['보내기', '읽기', '감사', '자기 정보'].map((k) => t(lang, k)).join(''));
    expect(cellText(rows[0], '만든 날')).toBe(lang === 'en' ? 'Sep 24, 2026' : '2026.09.24');
    expect(cellText(rows[1], '마지막 사용')).toBe('—'); // 빈 값은 — 하나(2026-10-15 F16), 뜻은 title
    expect(cellText(rows[0], '만료')).toBe(t(lang, '만료 없음'));
    expect(cellText(rows[1], '만료')).toBe(lang === 'en' ? 'Dec 24, 2026' : '2026.12.24');
    expect(menuItem(rows[0], '폐기')).toBeDefined();
    expect(moreBtn(rows[0]).getAttribute('aria-label')).toBe(tf(lang, '{n} 동작', { n: 'prod-mcp' }));
    // 전체 — 옛 토큰(이름·힌트 없음)은 "이름 없음" · 끝 4자까지 가림 · 폐기됨 배지 · 흐린 행 · 동작 없음(끝난 토큰은 기록 — 이름 바꾸기도 409 token_not_active).
    w.el('tk-f-all').checked = true;
    w.el('tk-f-all').dispatch('change');
    const all = rowsOf(w);
    expect(all).toHaveLength(3);
    expect(all[2]?.className).toBe('off');
    expect(cellText(all[2], '이름')).toBe(t(lang, '이름 없음') + t(lang, '폐기됨'));
    expect(cellText(all[2], '토큰 값')).toBe('atk_agent_••••••••••••');
    expect(menuItem(all[2], '폐기')).toBeUndefined();
    expect(menuItem(all[2], '이름 바꾸기')).toBeUndefined();
    expect(find(all[2] as FakeNode, (n) => n.className.includes('more-btn'))).toHaveLength(0);
    expect(menuItem(all[1], '이름 바꾸기')).toBeDefined();
    expect(w.el('tk-gap').hidden).toBe(true);
    // 힌트가 모양이 아니면(서버 이상) 그대로 쓰지 않는다.
    OVERRIDE.set('/api/agents/a1/tokens?status=all', { status: 200, json: { tokens: [{ ...TOKENS[0], hint: '<script>' }], activeCount: 1, maxActive: 5 } });
    const bad = await boot(lang, '#/agents/a1/tokens');
    expect(cellText(rowsOf(bad)[0], '토큰 값')).toBe('atk_agent_••••••••••••');
  });

  it('Ⓣ-2 새 토큰 — 이름·만료 → POST {label, expiresDays} → 평문은 토큰 창에서만 한 번 · 닫으면 지워진다 · 목록에는 평문이 없다', async () => {
    const w = await boot(lang, '#/agents/a1/tokens');
    w.el('tk-new').dispatch('click');
    expect(w.el('dlg-newtok').open).toBe(true);
    expect(w.el('nt-exp-w').hidden).toBe(false);
    // 빈 이름은 보내지 않는다.
    w.el('nt-form').dispatch('submit');
    await settle();
    expect(w.calls.some((c) => c.method === 'POST' && c.url === '/api/agents/a1/tokens')).toBe(false);
    expect(w.el('nt-label').getAttribute('aria-invalid')).toBe('true');
    w.el('nt-label').value = '  laptop-2 ';
    w.el('nt-exp').value = '90';
    w.el('nt-form').dispatch('submit');
    await settle();
    const post = w.calls.find((c) => c.method === 'POST' && c.url === '/api/agents/a1/tokens');
    expect(post).toEqual({ method: 'POST', url: '/api/agents/a1/tokens', body: { label: 'laptop-2', capabilities: ['messages:send', 'messages:read', 'audit:read', 'agent:read_self', 'policy:request'], expiresDays: 90 }, csrf: 'csrf-1' });
    expect(w.el('dlg-newtok').open).toBe(false);
    expect(w.el('dlg-token').open).toBe(true);
    expect(w.el('dt-kicker').textContent).toBe(t(lang, '새 토큰'));
    expect(w.el('dt-token').textContent).toBe(NEW_TOKEN);
    expect(w.el('dt-msg').textContent).toContain(`ATMARK_AGENT_TOKEN=${NEW_TOKEN}`);
    expect(w.el('tk-body').textContent).not.toContain(NEW_TOKEN);
    expect(w.el('tk-msg').textContent).toBe(tf(lang, '{n} 토큰을 발급했습니다.', { n: 'laptop-2' }));
    w.el('dt-close').dispatch('click');
    expect(w.el('dt-token').textContent).toBe('');
    // 만료 없음이면 expiresDays 를 싣지 않는다.
    w.el('tk-new').dispatch('click');
    w.el('nt-label').value = 'ci';
    w.el('nt-exp').value = '';
    w.el('nt-form').dispatch('submit');
    await settle();
    expect(w.calls.filter((c) => c.method === 'POST' && c.url === '/api/agents/a1/tokens').at(-1)?.body).toEqual({ label: 'ci', capabilities: ['messages:send', 'messages:read', 'audit:read', 'agent:read_self', 'policy:request'] });
  });

  it('Ⓣ-3 상한 — 409 token_limit는 대화상자에 문구 · 활성 5개면 새 토큰 단추가 잠긴다', async () => {
    OVERRIDE.set('POST /api/agents/a1/tokens', { status: 409, json: { error: 'token_limit', detail: '에이전트당 활성 토큰은 5개까지' } });
    const w = await boot(lang, '#/agents/a1/tokens');
    w.el('tk-new').dispatch('click');
    w.el('nt-label').value = 'sixth';
    w.el('nt-form').dispatch('submit');
    await settle();
    expect(w.el('dlg-newtok').open).toBe(true);
    expect(w.el('dlg-token').open).toBe(false);
    expect(w.el('nt-msg').textContent.startsWith(t(lang, '활성 토큰이 요금제 한도에 닿았습니다. 쓰지 않는 토큰을 폐기한 뒤 다시 발급하세요.'))).toBe(true);
    OVERRIDE.set('/api/agents/a1/tokens?status=all', { status: 200, json: { tokens: TOKENS, activeCount: 5, maxActive: 5 } });
    const full = await boot(lang, '#/agents/a1/tokens');
    expect(full.el('tk-count').textContent).toBe('5 / 5');
    expect(full.el('tk-new').disabled).toBe(true);
  });

  it('Ⓣ-4 행 메뉴 — ⋯ 는 aria-haspopup 메뉴 · 폐기는 확인 뒤 그 토큰만 POST …/tokens/{id}/revoke · 이름 바꾸기는 PATCH {label}', async () => {
    const w = await boot(lang, '#/agents/a1/tokens');
    const row = rowsOf(w)[0];
    const btn = moreBtn(row);
    expect(btn.getAttribute('aria-haspopup')).toBe('menu');
    btn.dispatch('click');
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect((btn as unknown as { menuEl?: FakeNode }).menuEl?.hidden).toBe(false);
    menuItem(row, '폐기')?.dispatch('click');
    expect(w.el('dlg-confirm').open).toBe(true);
    expect(w.el('dc-title').textContent).toBe(tf(lang, '{n} 토큰을 폐기할까요?', { n: 'prod-mcp' }));
    w.el('dc-ok').onclick?.();
    await settle();
    const rev = w.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/revoke'));
    expect(rev.map((c) => [c.url, c.csrf])).toEqual([[`/api/agents/a1/tokens/${TOKENS[0]?.id}/revoke`, 'csrf-1']]);
    expect(w.el('tk-msg').textContent).toBe(tf(lang, '{n} 토큰을 폐기했습니다.', { n: 'prod-mcp' }));

    const again = rowsOf(w)[1];
    menuItem(again, '이름 바꾸기')?.dispatch('click');
    expect(w.el('dlg-newtok').open).toBe(true);
    expect(w.el('nt-title').textContent).toBe(t(lang, '이름 바꾸기'));
    expect(w.el('nt-exp-w').hidden).toBe(true);
    expect(w.el('nt-label').value).toBe('laptop');
    w.el('nt-label').value = 'laptop-home';
    w.el('nt-form').dispatch('submit');
    await settle();
    expect(w.calls.find((c) => c.method === 'PATCH')).toEqual({ method: 'PATCH', url: `/api/agents/a1/tokens/${TOKENS[1]?.id}`, body: { label: 'laptop-home' }, csrf: 'csrf-1' });
    // 전부 교체 메뉴 — v3 교체 흐름(POST /token {action:'rotate'}).
    w.el('tk-bulk').dispatch('click');
    expect(w.el('tk-bulk-menu').hidden).toBe(false);
    w.el('tk-rotate').dispatch('click');
    w.el('dc-ok').onclick?.();
    await settle();
    expect(w.calls.find((c) => c.url === '/api/agents/a1/token')?.body).toEqual({ action: 'rotate' });
  });

  it('Ⓣ-5 활성 수(activeCount)와 목록의 활성 행이 다르면 한 줄 경고(M1) · 같으면 숨김', async () => {
    OVERRIDE.set('/api/agents/a1/tokens?status=all', { status: 200, json: { tokens: TOKENS, activeCount: 3, maxActive: 5 } });
    const w = await boot(lang, '#/agents/a1/tokens');
    expect(w.el('tk-gap').hidden).toBe(false);
    expect(w.el('tk-gap').textContent).toBe(tf(lang, '활성 토큰 {n}개 중 {m}개만 보입니다. 새로고침하세요.', { n: 3, m: 2 }));
    expect(w.el('tk-count').textContent).toBe('3 / 5');
    OVERRIDE.set('/api/agents/a1/tokens?status=all', { status: 200, json: { tokens: TOKENS, activeCount: 2, maxActive: 5 } });
    const ok = await boot(lang, '#/agents/a1/tokens');
    expect(ok.el('tk-gap').hidden).toBe(true);
    expect(ok.el('tk-gap').textContent).toBe('');
  });

  it('Ⓣ-6 이름 검사 = 서버(L3) — 길이는 코드 포인트(이모지 60개는 보낸다 · 61개는 막는다) · 보이지 않는 문자(서버 정규식 그대로)는 막는다 · 409 token_not_active 문구', async () => {
    const w = await boot(lang, '#/agents/a1/tokens');
    const posts = (): number => w.calls.filter((c) => c.method === 'POST' && c.url === '/api/agents/a1/tokens').length;
    const submit = async (label: string): Promise<void> => {
      w.el('tk-new').dispatch('click');
      w.el('nt-label').value = label;
      w.el('nt-form').dispatch('submit');
      await settle();
    };
    await submit('🔑'.repeat(61));
    expect(posts()).toBe(0);
    expect(w.body.all().find((n) => n.id === 'nt-label-err')?.textContent).toBe(t(lang, '이름은 1~60자이고, 보이지 않는 문자는 쓸 수 없습니다.'));
    for (const cp of [0x200b, 0xad, 0x2060, 0xfe0f, 0xe0041, 0x07, 0x3164]) {
      await submit(`a${String.fromCodePoint(cp)}b`);
      expect(posts(), cp.toString(16)).toBe(0);
    }
    await submit('🔑'.repeat(60));
    expect(posts()).toBe(1);
    expect(w.calls.filter((c) => c.method === 'POST' && c.url === '/api/agents/a1/tokens').at(-1)?.body).toEqual({ label: '🔑'.repeat(60), capabilities: ['messages:send', 'messages:read', 'audit:read', 'agent:read_self', 'policy:request'] });
    // 마크업 maxlength 는 서버 한도와 같은 60(2026-10-15 F47 — 도움말 "60자까지"와 맞춘다). UTF-16 단위라 브라우저가 서버보다 넓게 받지 않는다.
    expect(inlined(renderAppPage(lang))).toContain('id="nt-label" maxlength="60"');

    OVERRIDE.set('PATCH /api/agents/a1/tokens/' + String(TOKENS[1]?.id), { status: 409, json: { error: 'token_not_active', detail: '폐기·만료된 토큰은 이름을 바꿀 수 없다.' } });
    const r = await boot(lang, '#/agents/a1/tokens');
    const row = rowsOf(r)[1];
    menuItem(row, '이름 바꾸기')?.dispatch('click');
    r.el('nt-label').value = 'laptop-home';
    r.el('nt-form').dispatch('submit');
    await settle();
    expect(r.el('dlg-newtok').open).toBe(true);
    expect(r.el('nt-msg').textContent.startsWith(t(lang, '폐기되거나 만료된 토큰입니다.'))).toBe(true);
  });

  it('Ⓣ-7 한 개 교체 — 활성 행 ⋯ 에만 · 확인(빨강, 폐기와 같은 규율) 뒤 그 토큰만 POST …/tokens/{id}/rotate · 평문은 토큰 창에서 한 번 · 목록 다시 읽기', async () => {
    const w = await boot(lang, '#/agents/a1/tokens');
    const row = rowsOf(w)[0];
    // 메뉴 순서: 이름 바꾸기 · 교체 · (구분선) · 폐기.
    const labels = find(row as FakeNode, (n) => n.className.split(' ').includes('mi')).map((n) => n.textContent);
    expect(labels).toEqual(['이름 바꾸기', '교체', '폐기'].map((k) => t(lang, k)));
    // 취소하면 아무것도 보내지 않는다.
    menuItem(row, '교체')?.dispatch('click');
    expect(w.el('dlg-confirm').open).toBe(true);
    expect(w.el('dc-kicker').textContent).toBe(t(lang, '토큰 교체'));
    expect(w.el('dc-title').textContent).toBe(tf(lang, '{n} 토큰을 교체할까요?', { n: 'prod-mcp' }));
    expect(w.el('dc-body').textContent).toBe(
      t(lang, '같은 이름·권한·기간으로 새 토큰을 발급하고, 지금 토큰은 바로 폐기합니다. 새 토큰은 다음 창에서 한 번만 보입니다.') + t(lang, '이 토큰을 쓰는 곳에 새 토큰을 넣어야 합니다.'),
    );
    expect(w.el('dc-ok').textContent).toBe(t(lang, '교체'));
    expect(w.el('dc-ok').className).toBe('btn danger solid');
    w.el('dc-cancel').onclick?.();
    await settle();
    expect(w.calls.some((c) => c.url.endsWith('/rotate'))).toBe(false);
    // 확인 → 본문 없는 POST · CSRF · 평문은 토큰 창에만.
    const before = w.calls.filter((c) => c.url === '/api/agents/a1/tokens?status=all').length;
    menuItem(row, '교체')?.dispatch('click');
    w.el('dc-ok').onclick?.();
    await settle();
    const rot = w.calls.filter((c) => c.url.endsWith('/rotate'));
    expect(rot.map((c) => [c.method, c.url, c.body, c.csrf])).toEqual([['POST', `/api/agents/a1/tokens/${String(TOKENS[0]?.id)}/rotate`, undefined, 'csrf-1']]);
    expect(w.el('dlg-token').open).toBe(true);
    expect(w.el('dt-kicker').textContent).toBe(t(lang, '새 토큰(이전 토큰은 폐기됨)'));
    expect(w.el('dt-token').textContent).toBe(NEW_TOKEN);
    expect(w.el('tk-body').textContent).not.toContain(NEW_TOKEN);
    expect(w.el('tk-msg').textContent).toBe(tf(lang, '{n} 토큰을 교체했습니다.', { n: 'prod-mcp' }));
    expect(w.calls.filter((c) => c.url === '/api/agents/a1/tokens?status=all').length).toBe(before + 1);
    w.el('dt-close').dispatch('click');
    expect(w.el('dt-token').textContent).toBe('');
    // 창을 닫으면 포커스는 토큰 화면 제목으로(폐기와 같다 — 연 행은 목록을 다시 그리며 사라졌을 수 있다).
    expect(w.active()?.id).toBe('h-ag-tokens');
    // 끝난 토큰에는 없다(메뉴 자체가 없다).
    w.el('tk-f-all').checked = true;
    w.el('tk-f-all').dispatch('change');
    expect(menuItem(rowsOf(w)[2], '교체')).toBeUndefined();
    // 서버가 409 token_not_active(그새 폐기됨)면 목록 아래 문구 · 토큰 창은 열리지 않는다.
    OVERRIDE.set(`POST /api/agents/a1/tokens/${String(TOKENS[1]?.id)}/rotate`, { status: 409, json: { error: 'token_not_active', detail: '폐기·만료된 토큰은 교체할 수 없다.' } });
    const r = await boot(lang, '#/agents/a1/tokens');
    menuItem(rowsOf(r)[1], '교체')?.dispatch('click');
    r.el('dc-ok').onclick?.();
    await settle();
    expect(r.el('dlg-token').open).toBe(false);
    expect(r.el('tk-msg').textContent.startsWith(t(lang, '폐기되거나 만료된 토큰입니다.'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Ⓢ 통계 · 최근 활동 · 개요 · 설정
// ---------------------------------------------------------------------------

describe.each(LANGS)('Ⓢ 개요 · 설정 (%s)', (lang) => {
  it('Ⓢ-1 조직 개요 — 7일 통계(발신 · 수신=전달+보류 · 막힘·보류=거부+보류) · 에이전트 표(신원 열 · 썸네일) · 최근 활동(발신+수신 섞음) · 전체 로그는 #/logs', async () => {
    const w = await boot(lang, '#/overview');
    expect(w.calls.some((c) => c.url === '/api/stats?days=7')).toBe(true);
    expect(w.el('st-agents').textContent).toBe('1');
    expect(w.el('st-out').textContent).toBe(String(STATS.outbound.sent));
    expect(w.el('st-in').textContent).toBe(String(STATS.inbound.delivered + STATS.inbound.quarantined));
    expect(w.el('st-bad').textContent).toBe(String(STATS.outbound.denied + STATS.inbound.quarantined));
    const row = w.el('ov-agents-body').children[0] as FakeNode;
    // 첫 칸 = 썸네일 + 이름 + 둘째 줄 주소(비평 R1-05 — 주소 열을 첫 칸으로 합쳤다).
    expect(row.children.map((c) => c.getAttribute('data-label'))).toEqual(['이름', '상태', '신원', '발신', '수신', '마지막 사용'].map((k) => t(lang, k)));
    expect(row.children[0]?.textContent).toContain('atmark.ai');
    expect(row.children[2]?.textContent).toBe(t(lang, '게시됨'));
    expect(find(row, (n) => n.className === 'idthumb')[0]?.style['--h']).toBe(String(art.hue(KEY_FP)));
    expect([...new Set(w.calls.filter((c) => c.url.startsWith('/api/logs?')).map((c) => c.url))]).toEqual(['/api/logs?type=outbound&limit=6', '/api/logs?type=inbound&limit=6']);
    const act = w.el('ov-log-body').children;
    expect(act).toHaveLength(1);
    expect(act[0]?.children[1]?.textContent).toBe(t(lang, '발신')); // 방향 화살표는 선 아이콘(비평 R10-06)
    expect(find(act[0] as FakeNode, (n) => n.tagName === 'A')[0]?.href).toBe('#/logs/outbound/m-1');
    expect(inlined(renderAppPage(lang))).toContain(`<a href="#/logs" class="more">${t(lang, '모두 보기')}<svg class="ico"`); // 목록으로 가는 링크는 '모두 보기'(F30)
    // 통계 API 가 없으면(옛 서버) 칸은 — 이고 한 줄이 이유를 말한다.
    OVERRIDE.set('/api/stats?days=7', { status: 404, json: { error: 'route_not_found' } });
    const old = await boot(lang, '#/overview');
    expect(old.el('st-out').textContent).toBe('—');
    expect(old.el('ov-stats-msg').className).toBe('msg err');
  });

  it('Ⓢ-2 에이전트 개요 — 머리(썸네일 · 신원 상태) · 통계(agent=) · 이메일/토큰/신원 요약과 그 화면 링크 · 맨 아래 정지 한 행(D6)', async () => {
    const w = await boot(lang, '#/agents/a1');
    expect(w.calls.some((c) => c.url === '/api/stats?days=7&agent=a1')).toBe(true);
    expect(w.el('ao-thumb').style['--h']).toBe(String(art.hue(KEY_FP)));
    expect(w.el('a-ident').textContent).toBe(tf(lang, '신원: {s}', { s: t(lang, '게시됨') }));
    expect([w.el('ao-st-out'), w.el('ao-st-denied'), w.el('ao-st-in'), w.el('ao-st-q')].map((n) => n.textContent)).toEqual(['42', '3', '118', '2']);
    expect(w.el('ao-out').textContent).toBe(`${t(lang, '허용 목록')} · 1`);
    expect(w.el('ao-rate').textContent).toBe(tf(lang, '분당 {n}', { n: POLICY.limits.per_minute }));
    expect(w.el('ao-ident').textContent).toBe(`${t(lang, '게시됨')} · v2`);
    expect(w.el('ao-email-a').href).toBe('#/agents/a1/email');
    expect(w.el('ao-tokens-a').href).toBe('#/agents/a1/tokens');
    expect(w.el('ao-identity-a').href).toBe('#/agents/a1/identity');
    expect(w.el('ao-logs-a').href).toBe('#/agents/a1/logs');
    expect(w.el('dz-kill').textContent).toBe(t(lang, '정지'));
    const html = inlined(renderAppPage(lang));
    const ov = /<div class="pane" id="t-overview"[\s\S]*?<\/div><\/div>(?=<div class="pane")/.exec(html)?.[0] ?? '';
    expect(ov.lastIndexOf('id="dz-kill"')).toBeGreaterThan(ov.indexOf('id="ao-log-tbl"')); // 정지는 맨 아래
    w.el('ao-copy').dispatch('click');
    await settle();
    expect(w.el('dlg-token').open).toBe(false); // 복사는 자리표시 메시지 — 토큰 창을 열지 않는다
  });

  it('Ⓢ-3 설정 — 섹션 순서(조직 · 멤버와 초대 · 조직 API 키 · 요금제·사용량 · 발송 정지 · 투명성 로그 · GATE · 화면 · 계정·세션) · #/settings/{section} · 언어 링크는 지금 경로를 잇는다', async () => {
    const html = inlined(renderAppPage(lang));
    const order = [...html.matchAll(/<section class="spane" id="s-([a-z]+)"/g)].map((m) => m[1]);
    expect(order).toEqual(['org', 'members', 'keys', 'plan', 'pause', 'tlog', 'gate', 'display', 'mail', 'session']);
    const w = await boot(lang, '#/settings/tlog');
    expect(w.el('v-settings').hidden).toBe(false);
    expect(w.el('n-settings').getAttribute('aria-current')).toBe('location');
    expect(w.calls.some((c) => c.url === '/api/logs/integrity')).toBe(true);
    expect(w.el('lg-ko').href).toBe('?lang=ko#/settings/tlog');
    expect(w.el('lg-en').href).toBe('?lang=en#/settings/tlog');
    expect(w.el(`lg-${lang}`).getAttribute('aria-current')).toBe('true');
  });
});

// ---------------------------------------------------------------------------
// Ⓒ 카드 팔레트 대비 — oklch 를 sRGB 로 바꿔 WCAG 대비를 직접 잰다
// ---------------------------------------------------------------------------

type Oklch = { L: number; C: number; dh: number };
/** 규칙 본문에서 `--id-<name>:oklch(L% calc(C * var(--cs)) <hue>)` 를 읽는다(hue 는 var(--h) 또는 calc(var(--h) ± n)). */
function idToken(body: string, name: string): Oklch | 'ink' {
  const m = new RegExp(`--id-${name}:([^;}]+)`).exec(body)?.[1] ?? '';
  if (m === 'var(--gray-1000)') return 'ink';
  const o = /^oklch\(([\d.]+)% calc\(([\d.]+) \* var\(--cs\)\) (?:var\(--h\)|calc\(var\(--h\) ([+-]) (\d+)\))/.exec(m);
  if (o === null) throw new Error(`--id-${name} 모양: ${m}`);
  return { L: Number(o[1]) / 100, C: Number(o[2]), dh: o[3] ? (o[3] === '-' ? -1 : 1) * Number(o[4]) : 0 };
}
function oklchToLinear(L: number, C: number, hDeg: number): [number, number, number] {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (v: number): number => Math.min(1, Math.max(0, v));
  return [clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s), clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s), clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)];
}
const lumLinear = ([r, g, b]: [number, number, number]): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;
function lumHex(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (c[0] ?? 0) + 0.7152 * (c[1] ?? 0) + 0.0722 * (c[2] ?? 0);
}
const ratio = (y1: number, y2: number): number => (Math.max(y1, y2) + 0.05) / (Math.min(y1, y2) + 0.05);
const ALLOWED_HUES = [...Array.from({ length: 25 }, (_, i) => i), ...Array.from({ length: 105 }, (_, i) => i + 75), ...Array.from({ length: 65 }, (_, i) => i + 295)];

describe('Ⓒ 신원 카드 팔레트 — 라이트/다크 · 허용 hue 전부 · 상태별 채도', () => {
  const base = /\.idc,\.idthumb\{([^}]*)\}/.exec(ADMIN_UI_CSS)?.[1] ?? '';
  const dark = /:root\[data-theme="dark"\] \.idc,:root\[data-theme="dark"\] \.idthumb\{([^}]*)\}/.exec(ADMIN_UI_CSS)?.[1] ?? '';
  const sysDark = /@media \(prefers-color-scheme:dark\)\{:root:not\(\[data-theme="light"\]\) \.idc,:root:not\(\[data-theme="light"\]\) \.idthumb\{([^}]*)\}\}/.exec(ADMIN_UI_CSS)?.[1] ?? '';
  const themes = [
    { name: 'light', body: base, ink: CONSOLE_LIGHT['gray-1000'] },
    { name: 'dark', body: `${base};${dark}`, ink: CONSOLE_DARK['gray-1000'] },
  ] as const;
  const last = (body: string, name: string): Oklch | 'ink' => {
    const parts = body.split(';').filter((d) => d.startsWith(`--id-${name}:`));
    return idToken(parts.at(-1) ?? '', name);
  };

  it('Ⓒ-0 시스템 다크 = 명시 다크(같은 값) · 상태 채도 배율(게시 전·폐기·키 없음 0 · 게시 중단 .4) · oklch 미지원이면 회색(C5)', () => {
    expect(dark.length).toBeGreaterThan(200);
    expect(sysDark).toBe(dark);
    expect(ADMIN_UI_CSS).toContain('.idc.st-draft,.idc.st-revoked,.idc.nokey,.idthumb.nokey{--cs:0}');
    expect(ADMIN_UI_CSS).toContain('.idc.st-suspended{--cs:.4}');
    expect(ADMIN_UI_CSS).toMatch(/@supports not \(color:oklch\(0% 0 0\)\)\{:root:not\(\.nx\) \.idc,:root:not\(\.nx\) \.idthumb\{--id-bg:var\(--background-raised\);/);
  });

  it.each(themes)('Ⓒ-1 $name — 이름·값 글자 ≥ 7:1 · 라벨 ≥ 4.5:1 · 검증 마크(비텍스트) ≥ 3:1 — 허용 hue 195개 × 채도 배율 1 · .4 · 0', ({ body, ink }) => {
    const bg = last(body, 'bg') as Oklch;
    const label = last(body, 'label') as Oklch;
    const seal = last(body, 'seal') as Oklch;
    expect(last(body, 'ink')).toBe('ink');
    let worst = { ink: 99, label: 99, seal: 99 };
    for (const cs of [1, 0.4, 0]) {
      for (const h of ALLOWED_HUES) {
        const yBg = lumLinear(oklchToLinear(bg.L, bg.C * cs, h + bg.dh));
        worst = {
          ink: Math.min(worst.ink, ratio(lumHex(ink), yBg)),
          label: Math.min(worst.label, ratio(lumLinear(oklchToLinear(label.L, label.C * cs, h + label.dh)), yBg)),
          seal: Math.min(worst.seal, ratio(lumLinear(oklchToLinear(seal.L, seal.C * cs, h + seal.dh)), yBg)),
        };
      }
    }
    expect(worst.ink, `ink ${worst.ink.toFixed(2)}`).toBeGreaterThanOrEqual(7);
    expect(worst.label, `label ${worst.label.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
    expect(worst.seal, `seal ${worst.seal.toFixed(2)}`).toBeGreaterThanOrEqual(3);
  });

  it('Ⓒ-2 주황·파랑 대역 밖 — 카드의 기본 hue(300)와 스크립트가 내는 hue는 모두 [0,25) ∪ [75,180) ∪ [295,360)', () => {
    expect(base).toContain('--h:300');
    for (const hex of [AGENT.keyFingerprint, '0'.repeat(64), 'f'.repeat(64), '0123456789abcdef'.repeat(4)]) {
      const h = art.hue(hex) as number;
      expect(h < 25 || (h >= 75 && h < 180) || h >= 295).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Ⓦ 문구 규칙
// ---------------------------------------------------------------------------

describe.each(LANGS)('Ⓦ 문구 (%s)', (lang) => {
  const html = inlined(renderAppPage(lang));
  const script = blocks(html, 'script').at(-1) ?? '';
  const decoded = `${html}\n${script}`.replace(/\\u([0-9a-f]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));

  it('Ⓦ-1 금지 — "비공개"(신원 공개 스위치는 게시/게시 중단이다 · D3) · NFT · 블록체인 · 위험 구역 탭 · 질문형 열 제목', () => {
    expect(decoded).not.toMatch(/비공개|NFT|블록체인|blockchain|위험 구역|Danger zone|누구에게 보낼 수 있나|누구의 메일을 받나|Make private|Private identity/i);
  });

  it('Ⓦ-2 v4 새 문구는 사전 두 벌에 1:1 · 영어 값에 한글 없음 · 계약의 새 감사 액션·오류 코드 라벨', () => {
    const NEW = ['이메일', '신원 공개', '소속', '콘솔에서만 보임', '서명됨', '게시 중단됨', '키 준비 중', '변경 이력', '새 토큰', '전부 교체', '이름 없음', '만료됨', '권한', '보내기', '읽기', '감사', '자기 정보', '투명성 로그', '화면', '언어', '7일 발신', '7일 수신', '막힘·보류', '최근 활동', '토큰 폐기', '토큰 이름 바꾸기', '토큰 값', '키 값', '토큰 교체', '토큰 전부 교체'];
    for (const k of NEW) {
      expect(MESSAGES.ko[k], k).toBe(k);
      expect(MESSAGES.en[k], k).toBeTruthy();
      expect(HANGUL.test(MESSAGES.en[k] ?? ''), k).toBe(false);
    }
    expect(MESSAGES.en['콘솔에서만 보임']).toBe('Visible in console only');
    for (const action of ['agent.token.issue', 'agent.token.revoke', 'agent.token.rename', 'agent.token.rotate', 'agent.token.rotate_one']) expect(script, action).toContain(`'${action}':`);
    for (const code of ['token_limit', 'token_not_found', 'token_not_active', 'invalid_label']) expect(script, code).toMatch(new RegExp(`\\b${code}:'`));
  });
});
