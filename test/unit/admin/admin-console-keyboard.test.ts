/**
 * 콘솔 키보드·포커스(비평 6회전 R6-01·02·03·04·06·08) — 가짜 DOM 위에서 실제 앱 스크립트를 돌려 단언한다(`console-harness.ts`).
 *
 *   - 건너뛰기 링크: 첫 Tab 대상, 누르면 해시(= 라우트)를 건드리지 않고 `#main` 에 포커스.
 *   - 서랍·겹침 패널은 모달: 열리면 `#main`·건너뛰기·breadcrumb·로고가 `inert`, 사이드바는 `role=dialog` + `aria-modal`. 닫히면 해제.
 *   - Esc 는 포커스 위치와 무관하게 서랍을 닫고 `#menu-btn` 으로 돌려준다 — 단 열린 메뉴가 먼저 Esc 를 먹는다.
 *   - 계정 메뉴(사이드바 왼쪽 아래 계정 블록)는 스위처와 같은 메뉴 버튼(Esc 닫힘 + 버튼으로 복귀).
 *   - 하나를 고르는 세그먼트는 라디오 그룹: Tab 정지 하나(선택된 것), 화살표·Home·End 로 옮기며 고른다.
 *   - 화면 이동 뒤 포커스는 그 화면 제목(h1).
 */

import { afterEach, describe, expect, it } from 'vitest';

import { THEME_STORAGE_KEY } from '../../../src/admin/ui/page';
import { boot, OVERRIDE, type FakeEvent, type FakeNode } from './console-harness';

afterEach(() => OVERRIDE.clear());

/** 요소 자신의 keydown 리스너에 키 하나(가짜 DOM 은 버블링이 없다). */
function key(node: FakeNode, k: string): void {
  const ev: FakeEvent = {
    target: node,
    key: k,
    defaultPrevented: false,
    preventDefault() {
      ev.defaultPrevented = true;
    },
  };
  for (const fn of node.listeners.get('keydown') ?? []) fn.call(node, ev);
}

describe('건너뛰기 링크 (R6-01)', () => {
  it('누르면 #main에 포커스 · 해시(라우트)는 그대로', async () => {
    const w = await boot('ko', '#/overview');
    const ev = w.el('skip').dispatch('click');
    expect(ev.defaultPrevented).toBe(true);
    expect(w.active()).toBe(w.el('main'));
    expect(w.location.hash).toBe('#/overview');
    expect(w.el('main').getAttribute('tabindex')).toBe('-1');
  });
});

describe('서랍 · 겹침 패널은 모달 (R6-02 · R6-03)', () => {
  it('열면 뒤가 inert · 사이드바는 dialog, Esc는 포커스가 본문에 있어도 닫고 #menu-btn으로 · 닫으면 모두 해제', async () => {
    const w = await boot('ko', '#/overview');
    w.el('menu-btn').dispatch('click');
    expect(w.body.classList.contains('nav-open')).toBe(true);
    for (const id of ['main', 'skip', 'crumb', 'top-home']) expect((w.el(id) as unknown as { inert?: boolean }).inert, id).toBe(true);
    expect(w.el('side').getAttribute('role')).toBe('dialog');
    expect(w.el('side').getAttribute('aria-modal')).toBe('true');
    expect(w.active()).toBe(w.el('n-overview'));

    // 포커스가 배경막 뒤(본문)로 새어 나간 경우에도 Esc 가 닫는다.
    w.doc('keydown', { target: w.el('ov-new'), key: 'Escape' });
    expect(w.body.classList.contains('nav-open')).toBe(false);
    for (const id of ['main', 'skip', 'crumb', 'top-home']) expect((w.el(id) as unknown as { inert?: boolean }).inert, id).toBe(false);
    expect(w.el('side').getAttribute('role')).toBeNull();
    expect(w.el('side').getAttribute('aria-modal')).toBeNull();
    expect(w.active()).toBe(w.el('menu-btn'));
  });

  it('배경막을 누르거나 닫기 버튼으로 닫아도 #menu-btn으로 돌아온다', async () => {
    const w = await boot('en', '#/overview');
    w.el('menu-btn').dispatch('click');
    w.el('side-scrim').dispatch('click');
    expect(w.body.classList.contains('nav-open')).toBe(false);
    expect(w.active()).toBe(w.el('menu-btn'));
    w.el('menu-btn').dispatch('click');
    w.el('side-close').dispatch('click');
    expect(w.el('side-scrim').hidden).toBe(true);
    expect(w.active()).toBe(w.el('menu-btn'));
  });

  it('서랍 안에서 열린 메뉴가 먼저 Esc를 먹는다 — 첫 Esc는 메뉴만, 두 번째 Esc가 서랍을 닫는다', async () => {
    const w = await boot('ko', '#/overview');
    w.el('menu-btn').dispatch('click');
    w.el('acct-btn').dispatch('click');
    expect(w.el('acct-menu').hidden).toBe(false);
    w.doc('keydown', { target: w.el('logout'), key: 'Escape' });
    expect(w.el('acct-menu').hidden).toBe(true);
    expect(w.body.classList.contains('nav-open')).toBe(true);
    expect(w.active()).toBe(w.el('acct-btn'));
    w.doc('keydown', { target: w.el('acct-btn'), key: 'Escape' });
    expect(w.body.classList.contains('nav-open')).toBe(false);
  });
});

describe('계정 메뉴 = 메뉴 버튼 (R6-04)', () => {
  it('누르면 열리고 aria-expanded · Esc로 닫히며 버튼으로 복귀 · 항목(로그아웃)은 role=menuitem', async () => {
    const w = await boot('en', '#/overview');
    const b = w.el('acct-btn');
    expect(b.getAttribute('aria-haspopup')).toBe('menu');
    b.dispatch('click');
    expect(b.getAttribute('aria-expanded')).toBe('true');
    expect(w.el('acct-menu').hidden).toBe(false);
    expect(w.el('logout').getAttribute('role')).toBe('menuitem');
    expect(w.el('logout-all').getAttribute('role')).toBe('menuitem');
    w.doc('keydown', { target: w.el('logout'), key: 'Escape' });
    expect(w.el('acct-menu').hidden).toBe(true);
    expect(b.getAttribute('aria-expanded')).toBe('false');
    expect(w.active()).toBe(b);
  });
});

describe('세그먼트 = 라디오 그룹, 로빙 tabindex (R6-08)', () => {
  const TH = ['th-system', 'th-light', 'th-dark'];
  const stops = (w: Awaited<ReturnType<typeof boot>>): string[] => TH.filter((i) => w.el(i).getAttribute('tabindex') === '0');

  it('설정 › 화면의 테마 — Tab 정지는 선택된 칸 하나 · →/← /Home/End가 옮기며 고른다(끝에서 돈다) · 헤더 테마 메뉴도 따라간다', async () => {
    const w = await boot('ko', '#/settings/display');
    expect(stops(w)).toEqual(['th-system']);
    expect(w.el('th-light').getAttribute('role')).toBe('radio');
    key(w.el('th-system'), 'ArrowRight');
    expect(w.root.getAttribute('data-theme')).toBe('light');
    expect(w.storage?.get(THEME_STORAGE_KEY)).toBe('light');
    expect(stops(w)).toEqual(['th-light']);
    expect(w.active()).toBe(w.el('th-light'));
    expect(w.el('sbt-light').getAttribute('aria-checked')).toBe('true');
    key(w.el('th-light'), 'End');
    expect(w.root.getAttribute('data-theme')).toBe('dark');
    key(w.el('th-dark'), 'ArrowRight');
    expect(stops(w)).toEqual(['th-system']);
    expect(w.root.getAttribute('data-theme')).toBeNull();
    key(w.el('th-system'), 'ArrowLeft');
    expect(stops(w)).toEqual(['th-dark']);
    key(w.el('th-dark'), 'Home');
    expect(stops(w)).toEqual(['th-system']);
  });

  it('계정 메뉴의 테마 칸(2026-09-30) — 계정 블록이 메뉴를 열고, 칸(menuitemradio)을 고르면 적용 · 메뉴는 열린 채 · 설정 칸도 따라간다', async () => {
    const w = await boot('en', '#/overview');
    const b = w.el('acct-btn');
    b.dispatch('click');
    expect(w.el('acct-menu').hidden).toBe(false);
    expect(w.el('sbt-dark').getAttribute('role')).toBe('menuitemradio');
    w.el('sbt-dark').dispatch('click');
    expect(w.root.getAttribute('data-theme')).toBe('dark');
    expect(w.el('sbt-dark').getAttribute('aria-checked')).toBe('true');
    expect(w.el('sbt-system').getAttribute('aria-checked')).toBe('false');
    expect(w.el('th-dark').getAttribute('aria-checked')).toBe('true');
    // 메뉴까지 올라간 클릭(버블) — 테마 칸은 메뉴를 닫지 않는다.
    w.el('acct-menu').dispatch('click', w.el('sbt-dark'));
    expect(w.el('acct-menu').hidden).toBe(false);
    expect(b.getAttribute('aria-expanded')).toBe('true');
  });

  it('이메일 발신/수신 탭 · 토큰 활성/전체도 같은 모델', async () => {
    const w = await boot('en', '#/agents/a1/email');
    expect(w.el('em-t-outbound').getAttribute('tabindex')).toBe('0');
    key(w.el('em-t-outbound'), 'ArrowRight');
    expect(w.el('em-t-inbound').getAttribute('aria-checked')).toBe('true');
    expect(w.el('em-t-inbound').getAttribute('tabindex')).toBe('0');
    expect(w.el('em-cols').className).toContain('show-inbound');
  });
});

describe('화면 이동 뒤 포커스 = 화면 제목 (R6-06)', () => {
  it('조직 스코프 · 에이전트 스코프 안의 이동 모두 h1로', async () => {
    const w = await boot('ko', '#/overview');
    await w.go('#/agents');
    expect(w.active()).toBe(w.el('h-agents'));
    await w.go('#/agents/a1');
    expect(w.active()).toBe(w.el('a-name'));
    await w.go('#/agents/a1/email');
    expect(w.active()).toBe(w.el('h-ag-email'));
    await w.go('#/agents/a1/tokens');
    expect(w.active()).toBe(w.el('h-ag-tokens'));
  });
});
