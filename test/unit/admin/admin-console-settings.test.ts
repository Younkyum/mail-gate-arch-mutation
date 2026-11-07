/**
 * 설정 — 섹션마다 한 화면(진윤겸 2026-09-27: "설정의 여러 요소도 누르면 그것만 뜨는 게 낫다") — 가짜 DOM 위에서 실제 앱 스크립트를 돌린다.
 *
 *   Ⓢ-1 라우트 `#/settings/{section}` → 그 섹션 하나만 보인다 · 설정 메뉴의 그 항목만 aria-current="page"
 *   Ⓢ-2 `#/settings` · 모르는 섹션 → 첫 섹션(일반)으로 주소를 고친다(replaceState — 개요로 보내지 않는다)
 *   Ⓢ-3 섹션을 옮기면 포커스가 그 섹션 제목으로 · 메뉴 항목은 라우트 링크(마크업 · 묶음 순서 = 라우터 순서)
 *   Ⓢ-4 섹션 데이터는 그 섹션을 열 때만 읽는다 · 설정에 머무는 동안 한 번 · 떠났다 오면 다시
 *   Ⓢ-5 다른 화면·사이트에서 오는 깊은 링크(`#/settings/plan` · `#/settings/pause` · `#/settings/keys` · `#/settings/tlog`)가 그 섹션을 연다
 *
 * 되돌려서 빨개지는지 확인한 것(2026-09-27): `showSettings` 의 섹션 hidden 토글을 빼면 → Ⓢ-1 · 라우터의 settings `redirect` 를 빼면 → Ⓢ-2 ·
 * `moved` 의 `prev.section!==r.section` 을 빼면 → Ⓢ-3 · 섹션별 로드를 예전처럼 한꺼번에 하면 → Ⓢ-4.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { renderAppPage } from '../../../src/admin/ui/index';
import { SETTINGS_NAV } from '../../../src/admin/ui/console/markup/settings';
import { ROUTER_JS } from '../../../src/admin/ui/console/router';

import { boot, inlined, OVERRIDE, PLAN_BRIEF, t } from './console-harness';

afterEach(() => OVERRIDE.clear());

const LANGS = ['ko', 'en'] as const;
const SECTIONS = JSON.parse(/var SETTINGS_SECTIONS=(\[[^\]]*\]);/.exec(ROUTER_JS)?.[1]?.replace(/'/g, '"') ?? '[]') as string[];
const HEADS: Record<string, string> = { org: 'h-org', members: 'h-members', keys: 'h-keys', plan: 'h-plan', pause: 'h-pause', tlog: 'h-it', gate: 'h-gate', display: 'h-display', mail: 'h-mail', session: 'h-account' };
/** 섹션별로 그 섹션만 부르는 요청(열기 전에는 부르지 않는다). */
const LOADS: Record<string, string> = { members: '/api/members', keys: '/api/org-keys?status=all', plan: '/api/plan', tlog: '/api/logs/integrity', gate: '/api/gate?agent=a1', mail: '/api/me/preferences' };

type W = Awaited<ReturnType<typeof boot>>;
const visible = (w: W): string[] => SECTIONS.filter((s) => !w.el(`s-${s}`).hidden);
const current = (w: W): string[] => SECTIONS.filter((s) => w.el(`ns-${s}`).getAttribute('aria-current') === 'page');
const count = (w: W, url: string): number => w.calls.filter((c) => c.url === url).length;

describe('Ⓢ 설정 정적 구조', () => {
  it('Ⓢ-0 메뉴 — 묶음 셋(조직 · 운영 · 개인) · 항목 순서 = 라우터 SETTINGS_SECTIONS · 항목은 #/settings/{section} 링크 · 섹션도 같은 순서', () => {
    // 도메인은 2026-10-05 사이드바 1단 항목으로 나갔다(`#/domains` — admin-console-domains.test.ts Ⓓ-0).
    // AI 메일 감시는 2026-10-08 감시 탭으로 나갔다(`#/watch/ai` — admin-console-watch.test.ts).
    expect(SECTIONS).toEqual(['org', 'members', 'keys', 'plan', 'pause', 'tlog', 'gate', 'display', 'mail', 'session']);
    expect(SETTINGS_NAV.map(([g]) => g)).toEqual(['org', 'ops', 'me']);
    expect(SETTINGS_NAV.flatMap(([, , items]) => items.map(([s]) => s))).toEqual(SECTIONS);
    for (const lang of LANGS) {
      const html = inlined(renderAppPage(lang));
      const nav = /<nav class="snav" id="snav" aria-label="([^"]+)">([\s\S]*?)<\/nav>/.exec(html);
      expect(nav?.[1]).toBe(t(lang, '설정 메뉴'));
      expect([...(nav?.[2] ?? '').matchAll(/<a href="#\/settings\/([a-z]+)" id="ns-\1">/g)].map((m) => m[1])).toEqual(SECTIONS);
      expect([...(nav?.[2] ?? '').matchAll(/<ul aria-labelledby="sg-([a-z]+)">/g)].map((m) => m[1])).toEqual(['org', 'ops', 'me']);
      // 섹션은 처음에 전부 숨어 있다(스크립트가 하나만 연다) · 제목은 포커스를 받을 수 있다.
      expect([...html.matchAll(/<section class="spane" id="s-([a-z]+)" aria-labelledby="([a-z-]+)" hidden>/g)].map((m) => [m[1], m[2]])).toEqual(SECTIONS.map((s) => [s, HEADS[s]]));
      for (const s of SECTIONS) expect(html, s).toContain(`<h2 id="${HEADS[s] ?? ''}" tabindex="-1">`);
      // 사이드바에는 설정 하위 목록이 없다(설정 메뉴와 겹치지 않게).
      expect(html).not.toContain('id="nav-settings"');
    }
  });

  it('Ⓢ-0b 다른 화면·사이트의 설정 링크는 전부 있는 섹션을 가리킨다', () => {
    const roots = ['src/admin/ui', 'src/site'];
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSafe(dir)) {
        const p = join(dir, name);
        if (name.endsWith('.ts') && name !== 'router.ts') files.push(p); // 라우터 주석은 모르는 섹션의 예(#/settings/x)를 든다
        else if (!name.includes('.')) walk(p);
      }
    };
    roots.forEach(walk);
    const links = files.flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/#\/settings\/([a-z]+)/g)].map((m) => m[1] ?? ''));
    expect(links.length).toBeGreaterThan(3);
    for (const s of links) expect(SECTIONS, s).toContain(s);
  });
});

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

describe.each(LANGS)('Ⓢ 설정 한 화면에 한 섹션 (%s)', (lang) => {
  it.each(SECTIONS)('Ⓢ-1 #/settings/%s → 그 섹션만 보이고 메뉴의 그 항목만 현재', async (sec) => {
    const w = await boot(lang, `#/settings/${sec}`);
    expect(w.el('v-settings').hidden).toBe(false);
    // 사이드바의 설정은 '어디에 있나'(location) — 지금 페이지는 설정 메뉴의 그 섹션이다.
    expect(w.el('n-settings').getAttribute('aria-current')).toBe('location');
    expect(visible(w)).toEqual([sec]);
    expect(current(w)).toEqual([sec]);
    expect(w.location.hash).toBe(`#/settings/${sec}`);
  });

  it.each(['#/settings', '#/settings/', '#/settings/nope', '#/settings/org/x'])('Ⓢ-2 %s → 첫 섹션(일반) · 주소를 고친다 · 없는 화면 배너는 없다', async (hash) => {
    const w = await boot(lang, hash);
    expect(w.el('v-settings').hidden).toBe(false);
    expect(visible(w)).toEqual(['org']);
    expect(current(w)).toEqual(['org']);
    expect(w.location.hash).toBe('#/settings/org');
    expect(w.el('v-overview').hidden).toBe(true);
  });

  it('Ⓢ-3 섹션을 옮기면 그 섹션만 · 포커스는 그 섹션 제목 · 다른 화면에서 들어와도 섹션 제목', async () => {
    const w = await boot(lang, '#/overview');
    await w.go('#/settings/plan');
    expect(visible(w)).toEqual(['plan']);
    expect(w.active()).toBe(w.el('h-plan'));
    for (const sec of ['members', 'pause', 'display', 'org'] as const) {
      await w.go(`#/settings/${sec}`);
      expect(visible(w), sec).toEqual([sec]);
      expect(current(w), sec).toEqual([sec]);
      expect(w.active(), sec).toBe(w.el(HEADS[sec] ?? ''));
    }
    // 설정을 떠나면 메뉴 표시가 남아도 화면은 닫힌다.
    await w.go('#/agents');
    expect(w.el('v-settings').hidden).toBe(true);
    expect(w.el('n-settings').getAttribute('aria-current')).toBe(null);
  });

  it('Ⓢ-4 섹션 데이터는 그 섹션을 열 때만 · 설정에 머무는 동안 한 번 · 떠났다 오면 다시 읽는다', async () => {
    const w = await boot(lang, '#/settings/org');
    // 도메인이 설정에서 나간 뒤(2026-10-05)로는 설정을 연다고 기능 표시(/api/plan)를 읽지 않는다 — 요금제 섹션이 열 때 읽는다.
    for (const url of Object.values(LOADS)) expect(count(w, url), url).toBe(0);
    for (const [sec, url] of Object.entries(LOADS)) {
      await w.go(`#/settings/${sec}`);
      expect(count(w, url), url).toBe(1);
    }
    // 섹션 사이를 오가도 다시 부르지 않는다.
    for (const sec of Object.keys(LOADS)) await w.go(`#/settings/${sec}`);
    await w.go('#/settings/tlog');
    expect(count(w, '/api/logs/integrity')).toBe(1);
    expect(count(w, '/api/plan')).toBe(1);
    // 설정을 떠났다 오면 연 섹션만 다시 읽는다.
    await w.go('#/overview');
    await w.go('#/settings/plan');
    expect(count(w, '/api/plan')).toBe(2);
    expect(count(w, '/api/logs/integrity')).toBe(1);
  });

  it('Ⓢ-4b 읽기가 실패한 섹션은 그 자리에 오류 한 줄 · 다시 열면 다시 읽는다', async () => {
    OVERRIDE.set('/api/logs/integrity', { status: 500, json: { error: 'internal' } });
    const w = await boot(lang, '#/settings/tlog');
    expect(w.el('it-msg').className).toBe('msg err');
    OVERRIDE.clear();
    await w.go('#/settings/org');
    await w.go('#/settings/tlog');
    expect(count(w, '/api/logs/integrity')).toBe(2);
    expect(w.el('it-facts').hidden).toBe(false);
  });

  it('Ⓢ-5 깊은 링크 — 요금제 배너 · 긴급 정지 배너 · 결제 복귀가 그 섹션을 연다', async () => {
    const html = inlined(renderAppPage(lang));
    expect(html).toContain('<a href="#/settings/plan" class="more">');
    expect(html).toContain('<a href="#/settings/pause" class="more">');
    const w = await boot(lang, '#/settings/pause');
    expect(visible(w)).toEqual(['pause']);
    expect(w.el('org-kill-on').hidden).toBe(false);
    const k = await boot(lang, '#/settings/keys');
    expect(visible(k)).toEqual(['keys']);
    expect(count(k, '/api/org-keys?status=all')).toBe(1);
    expect(count(k, '/api/members')).toBe(0);
  });

  it('Ⓢ-6 세션 섹션 — 로그인한 주소 · 로그아웃 둘', async () => {
    OVERRIDE.set('/api/me', {
      status: 200,
      json: {
        organization: { id: 'o1', name: 'Chronostasis', ownerEmail: 'owner@example.com', reviewStatus: 'active' },
        orgKillSwitch: { ownerPaused: false, platformFrozen: false },
        plan: PLAN_BRIEF,
        csrf: 'csrf-1',
        user: { id: 'u1', email: 'me@example.com' },
        memberships: [{ organizationId: 'o1', name: 'Chronostasis', role: 'owner' }],
      },
    });
    const w = await boot(lang, '#/settings/session');
    expect(w.el('ss-me').textContent).toBe('me@example.com');
    expect(w.el('logout-s').hidden).toBe(false);
    expect(w.el('logout-all-s').className).toBe('btn ghost'); // 데이터·권한을 잃지 않는다 — 빨강 아님(F08)
  });
});
