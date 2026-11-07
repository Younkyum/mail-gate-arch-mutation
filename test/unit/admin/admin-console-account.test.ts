/**
 * 계정 블록(2026-09-30 진윤겸 — Vercel·Linear·Supabase 처럼 사이드바 왼쪽 아래). 상단 바의 테마·언어·계정 아바타를 여기로 옮겼다.
 *
 *   - 상단 바에는 스위처만 남는다(테마 버튼 · 언어 링크 · 계정 버튼 없음). 계정 블록은 사이드바 아래(`.side-foot`)에 접기 버튼과 함께.
 *   - 블록은 아바타 · 주소 · 역할. 누르면 메뉴가 위로 열린다: 주소 · 역할 · 설정 링크 둘 · 테마 칸 · 언어 칸 · 로그아웃 둘(빨강 아님).
 *   - 메뉴 버튼 규약은 스위처와 같다: `aria-haspopup=menu` · `aria-expanded` · ↓ 로 열림 · Esc 로 닫히며 버튼으로 복귀.
 *   - 테마 칸(`sbt-*`)은 고르면 곧바로 적용되고 메뉴는 열린 채, 설정 › 화면의 칸도 따라간다. 언어 칸은 지금 경로를 이어 가는 두 링크.
 *   - 레일(접힌 사이드바)에서도 블록은 아바타로 남아 메뉴를 연다 — 이름은 시각적으로만 숨고(접근 가능한 이름은 그대로), 메뉴는 오른쪽으로.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { SIDEBAR, TOP_BAR } from '../../../src/admin/ui/console/markup/shell';
import { type Lang } from '../../../src/admin/ui/index';
import { SIDE_STORAGE_KEY, THEME_STORAGE_KEY } from '../../../src/admin/ui/page';
import { ADMIN_UI_CSS } from '../../../src/admin/ui/styles';
import { boot, type FakeEvent, me, OVERRIDE, t } from './console-harness';

afterEach(() => OVERRIDE.clear());


/** 바깥 규칙 하나의 본문(선택자 그대로 · 첫 번째 것). */
function rule(css: string, selector: string): string {
  const i = css.indexOf(`${selector}{`);
  if (i < 0) return '';
  return css.slice(i + selector.length + 1, css.indexOf('}', i));
}
/** `@container side (max-width:120px){…}` 블록(레일) 전체. */
function railBlock(css: string): string {
  const start = css.indexOf('@container side (max-width:120px){');
  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(start, i + 1);
  }
  return '';
}

describe('자리 — 상단 바에서 사이드바 아래로', () => {
  it('상단 바에는 스위처만 · 계정 블록 · 테마 · 언어는 사이드바 아래(접기 버튼과 한 줄)', () => {
    for (const gone of ['id="acct', 'id="th-btn"', 'id="th-menu"', 'id="lang-wrap"', 'id="sbt-', 'class="top-r"']) expect(TOP_BAR, gone).not.toContain(gone);
    expect(TOP_BAR).toContain('id="sw-org"');
    const foot = SIDEBAR.slice(SIDEBAR.indexOf('<div class="side-foot">'));
    expect(foot.indexOf('id="acct-btn"')).toBeGreaterThan(0);
    expect(foot.indexOf('id="acct-btn"')).toBeLessThan(foot.indexOf('id="side-toggle"'));
    for (const id of ['acct-menu', 'owner', 'me-role', 'acct-set', 'acct-org', 'sbt-system', 'sbt-light', 'sbt-dark', 'acct-ko', 'acct-en', 'logout', 'logout-all'])
      expect(foot, id).toContain(`id="${id}"`);
  });

  it('트리거는 메뉴 버튼 · 메뉴의 항목 역할 · 로그아웃은 빨강이 아니다(위험 표시 없음)', () => {
    expect(SIDEBAR).toMatch(/<button type="button" class="acct-b" id="acct-btn" aria-haspopup="menu" aria-expanded="false" aria-controls="acct-menu">/);
    expect(SIDEBAR).toContain('<ul class="mlist" role="menu" aria-labelledby="acct-btn">');
    expect(SIDEBAR).toMatch(/role="menuitemradio" class="aseg-i" id="sbt-light"/);
    expect(SIDEBAR).toMatch(/role="menuitemradio" class="aseg-i" href="\?lang=en" hreflang="en" lang="en" id="acct-en"/);
    expect(SIDEBAR).toContain('<button type="button" role="menuitem" class="mi" id="logout">');
    expect(SIDEBAR).toContain('<button type="button" role="menuitem" class="mi" id="logout-all">');
  });
});

describe.each<Lang>(['ko', 'en'])('계정 블록 (%s)', (lang) => {
  it('블록에 주소 · 역할이 보이고, 누르면 메뉴가 열린다(aria-expanded) · 다시 누르면 닫힌다', async () => {
    OVERRIDE.set('/api/me', me('admin'));
    const w = await boot(lang, '#/overview');
    const b = w.el('acct-btn');
    expect(w.el('acct-email').textContent).toBe('me@example.com');
    expect(w.el('acct-email').title).toBe('me@example.com');
    expect(w.el('acct-role').textContent).toBe(t(lang, '관리자'));
    expect(w.el('me-role').textContent).toBe(t(lang, '관리자'));
    expect(w.el('acct-menu').hidden).toBe(true);
    b.dispatch('click');
    expect(w.el('acct-menu').hidden).toBe(false);
    expect(b.getAttribute('aria-expanded')).toBe('true');
    b.dispatch('click');
    expect(w.el('acct-menu').hidden).toBe(true);
    expect(b.getAttribute('aria-expanded')).toBe('false');
  });

  it('↓ 가 메뉴를 열고 · Esc 는 닫으며 포커스를 계정 블록으로 돌려준다 · 다른 메뉴를 열면 닫힌다', async () => {
    const w = await boot(lang, '#/overview');
    const b = w.el('acct-btn');
    const ev: FakeEvent = {
      target: b,
      key: 'ArrowDown',
      defaultPrevented: false,
      preventDefault() {
        ev.defaultPrevented = true;
      },
    };
    for (const fn of b.listeners.get('keydown') ?? []) fn.call(b, ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(w.el('acct-menu').hidden).toBe(false);
    w.doc('keydown', { target: w.el('sbt-light'), key: 'Escape' });
    expect(w.el('acct-menu').hidden).toBe(true);
    expect(b.getAttribute('aria-expanded')).toBe('false');
    expect(w.active()).toBe(b);
    b.dispatch('click');
    w.el('sw-org').dispatch('click');
    expect(w.el('acct-menu').hidden).toBe(true);
    expect(w.el('sw-org-menu').hidden).toBe(false);
  });

  it('테마 칸 — 고르면 적용 · 이 브라우저에 저장 · 설정 칸이 따라가고 메뉴는 열린 채. 설정 링크(.mi)를 고르면 닫힌다', async () => {
    const w = await boot(lang, '#/overview');
    w.el('acct-btn').dispatch('click');
    w.el('sbt-light').dispatch('click');
    w.el('acct-menu').dispatch('click', w.el('sbt-light'));
    expect(w.root.getAttribute('data-theme')).toBe('light');
    expect(w.storage?.get(THEME_STORAGE_KEY)).toBe('light');
    expect(['sbt-system', 'sbt-light', 'sbt-dark'].map((i) => w.el(i).getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    expect(w.el('th-light').getAttribute('aria-checked')).toBe('true');
    expect(w.el('acct-menu').hidden).toBe(false);
    w.el('sbt-system').dispatch('click');
    expect(w.root.getAttribute('data-theme')).toBeNull();
    expect(w.storage?.has(THEME_STORAGE_KEY)).toBe(false);
    w.el('acct-menu').dispatch('click', w.el('acct-set'));
    expect(w.el('acct-menu').hidden).toBe(true);
    expect(w.el('acct-set').getAttribute('href')).toBe('#/settings/session');
  });

  it('언어 칸 — 두 링크가 지금 경로를 이어 가고, 지금 언어가 체크된 칸', async () => {
    const w = await boot(lang, '#/agents/a1/tokens');
    expect(w.el('acct-ko').href).toBe('?lang=ko#/agents/a1/tokens');
    expect(w.el('acct-en').href).toBe('?lang=en#/agents/a1/tokens');
    expect(w.el(`acct-${lang}`).getAttribute('aria-checked')).toBe('true');
    expect(w.el(`acct-${lang === 'ko' ? 'en' : 'ko'}`).getAttribute('aria-checked')).toBe('false');
    expect(w.el('acct-ko').getAttribute('role')).toBe('menuitemradio');
  });

  it('레일 — ≥1150 에서 접으면 레일이 되고(저장), 계정 블록은 그대로 메뉴를 열고 Esc 로 돌아온다', async () => {
    const w = await boot(lang, '#/overview', { wide: true });
    w.el('side-toggle').dispatch('click');
    expect(w.root.getAttribute('data-side')).toBe('rail');
    expect(w.storage?.get(SIDE_STORAGE_KEY)).toBe('rail');
    expect(w.el('side-toggle').getAttribute('aria-expanded')).toBe('false');
    const b = w.el('acct-btn');
    b.dispatch('click');
    expect(w.el('acct-menu').hidden).toBe(false);
    expect(w.body.classList.contains('nav-open')).toBe(false);
    w.doc('keydown', { target: w.el('logout'), key: 'Escape' });
    expect(w.el('acct-menu').hidden).toBe(true);
    expect(w.active()).toBe(b);
    // 다시 펼쳐도 그대로.
    w.el('side-toggle').dispatch('click');
    expect(w.root.getAttribute('data-side')).toBeNull();
    b.dispatch('click');
    expect(w.el('acct-menu').hidden).toBe(false);
  });
});

describe('모양 — 위로 열림 · 레일은 아바타만 · 흑백', () => {
  it('펼침: 메뉴는 블록 위로(bottom) 열린다 · 블록은 사이드바 항목처럼 한 줄 전체', () => {
    expect(rule(ADMIN_UI_CSS, '.acct .menu')).toContain('bottom:calc(100% + 8px)');
    expect(rule(ADMIN_UI_CSS, '.acct .menu')).toContain('top:auto');
    expect(rule(ADMIN_UI_CSS, '.acct-b')).toContain('width:100%');
    expect(rule(ADMIN_UI_CSS, '.acct')).toContain('flex:1');
  });

  it('레일: 이름은 시각적으로만 숨고(display:none 아님 — 버튼 이름이 남는다) · 아바타만 · 메뉴는 오른쪽으로', () => {
    const rail = railBlock(ADMIN_UI_CSS);
    expect(rail).toContain('.acct-t{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)');
    expect(rail).toContain('.acct-b>.ico{display:none}');
    expect(rail).toContain('.acct .menu{left:calc(100% + 16px);bottom:0');
    expect(rail).toContain('.side-foot{flex-direction:column');
  });

  it('계정 블록 · 메뉴 칸의 규칙에 색이 없다(빨강·파랑·주황 토큰 없음)', () => {
    const lines = ADMIN_UI_CSS.split('\n').filter((l) => /\.acct|\.aseg|\.mrow/.test(l));
    expect(lines.length).toBeGreaterThan(5);
    for (const l of lines) expect(l, l).not.toMatch(/--(red|blue|amber|orange|green)|#[0-9a-f]{3,6}\b/i);
  });
});
