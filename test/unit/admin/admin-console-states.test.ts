/**
 * 콘솔 빈·로딩·오류 상태(비평 7회전 R7-01·03·05·06·08·10·11) — 가짜 DOM 위에서 실제 앱 스크립트를 돌린다(`console-harness.ts`).
 *
 *   - 로딩: `/api/me`·`/api/agents` 전에는 스켈레톤 한 장, 뒤에는 화면(값 칸은 비어 있다가 숫자 — 거짓 0·거짓 "시작하기" 없음).
 *   - 부팅 실패: 원인 한 줄 + 다시 시도(배너 아님) · 다시 시도하면 회복.
 *   - 401: `/?expired=1` 로 가며 가던 화면(콘솔 해시 모양만)을 탭 저장소에 둔다 · 다시 열면 그 화면 · 다른 모양은 버린다.
 *   - 폼 오류: 틀린 칸에 `aria-invalid` + `aria-describedby`, 칸에 포커스, 고치기 시작하면 해제.
 *   - 순간 성공은 토스트(#toasts) · 폐기 뒤 포커스는 화면 제목.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { renderAppPage } from '../../../src/admin/ui/index';

import { boot, inlined, OVERRIDE, settle, type FakeNode } from './console-harness';

afterEach(() => OVERRIDE.clear());

const NEXT_KEY = 'atmark.console.next';
const ORG_KEY = 'atmark.console.org';
const find = (root: FakeNode, pred: (n: FakeNode) => boolean): FakeNode[] => root.all().filter(pred);

describe('로딩 → 데이터 (R7-01)', () => {
  it('부팅 뒤 스켈레톤은 숨고 화면이 보인다 · 통계 값 칸은 숫자로 채워진다(빈 칸 = 스켈레톤, 대시 아님)', async () => {
    const w = await boot('ko', '#/overview');
    expect(w.el('boot-skel').hidden).toBe(true);
    expect(w.el('v-overview').hidden).toBe(false);
    expect(w.el('main').getAttribute('aria-busy')).toBeNull();
    expect(w.el('st-agents').textContent).toBe('1');
    expect(w.el('st-agents').textContent).not.toBe('–');
  });

  it('에이전트가 없으면 개요는 "시작하기" 하나만 — 빈 표 블록 둘은 숨는다 (R7-08)', async () => {
    OVERRIDE.set('/api/agents', { status: 200, json: [] });
    const w = await boot('en', '#/overview');
    expect(w.el('ov-start').hidden).toBe(false);
    expect(w.el('ov-agents-b').hidden).toBe(true);
    expect(w.el('ov-log-b').hidden).toBe(true);
  });
});

describe('부팅 실패 (R7-03 · R7-04)', () => {
  it('500 이면 오류 상태(원인 한 줄 — 내부 코드는 문장 밖 title) + 다시 시도 · 누르면 회복', async () => {
    OVERRIDE.set('/api/me', { status: 500, json: { error: 'internal_error' } });
    const w = await boot('ko', '#/overview');
    expect(w.el('boot-err').hidden).toBe(false);
    expect(w.el('boot-skel').hidden).toBe(true);
    expect(w.el('v-overview').hidden).toBe(true);
    expect(w.el('boot-err-t').textContent).not.toContain('internal_error');
    expect(w.el('boot-err-t').title).toContain('internal_error');
    expect(w.active()).toBe(w.el('boot-retry'));
    OVERRIDE.clear();
    w.el('boot-retry').dispatch('click');
    await settle();
    expect(w.el('boot-err').hidden).toBe(true);
    expect(w.el('v-overview').hidden).toBe(false);
  });
});

describe('세션 만료 401 (R7-05 · 리뷰 M2 · 보안 I-1)', () => {
  // 로그인 링크는 새 탭에서 열린다 → 가던 화면은 탭 저장소가 아니라 localStorage(다른 탭도 읽음) · 15분 · 같은 조직에서만 · 한 번.
  const place = (h: string, org = 'o1', at = Date.now()): string => JSON.stringify({ h, org, at });
  const seeded = (value: string, org: string | null = 'o1'): Map<string, string> =>
    new Map([[NEXT_KEY, value], ...(org ? ([[ORG_KEY, org]] as const) : [])]);

  it('로그인으로 가며 이유(?expired=1)를 알리고, 가던 콘솔 화면을 조직 id·시각과 함께 localStorage 에 둔다', async () => {
    OVERRIDE.set('/api/me', { status: 401, json: { error: 'unauthenticated' } });
    const before = Date.now();
    const w = await boot('ko', '#/agents/a1/tokens', { storage: new Map([[ORG_KEY, 'o1']]) });
    expect(w.location.replaced).toContain('/?expired=1');
    const saved = JSON.parse(w.storage?.get(NEXT_KEY) ?? '{}') as { h?: string; org?: string; at?: number };
    expect(saved.h).toBe('#/agents/a1/tokens');
    expect(saved.org).toBe('o1');
    expect(saved.at).toBeGreaterThanOrEqual(before);
    expect(w.session.has(NEXT_KEY)).toBe(false);
  });

  it('조직을 모르면(이 브라우저에서 처음) 두지 않는다 · 콘솔 해시 모양이 아니면 두지 않는다', async () => {
    OVERRIDE.set('/api/me', { status: 401, json: { error: 'unauthenticated' } });
    const w = await boot('ko', '#/agents');
    expect(w.storage?.has(NEXT_KEY)).toBe(false);
    for (const bad of ['#/agents?x=<script>', '#//evil.example', '#https://evil.example']) {
      const x = await boot('en', bad, { storage: new Map([[ORG_KEY, 'o1']]) });
      expect(x.storage?.has(NEXT_KEY), bad).toBe(false);
    }
  });

  it('다른 탭에서 해시 없이 열면(로그인 링크) 같은 조직일 때 둔 화면으로 한 번만 돌아간다', async () => {
    const w = await boot('ko', '', { storage: seeded(place('#/agents')) });
    expect(w.location.hash).toBe('#/agents');
    expect(w.el('v-agents').hidden).toBe(false);
    expect(w.storage?.has(NEXT_KEY)).toBe(false);
    expect(w.storage?.get(ORG_KEY)).toBe('o1');
  });

  it('15분이 지났거나 · 다른 조직이거나 · 모양이 틀린 저장값은 버리고 개요를 연다', async () => {
    for (const value of [place('#/agents', 'o1', Date.now() - 16 * 60000), place('#/agents', 'o2'), place('https://evil.example/#/agents'), '#/agents', '{']) {
      const w = await boot('ko', '', { storage: seeded(value) });
      expect(w.location.hash, value).toBe('');
      expect(w.el('v-overview').hidden, value).toBe(false);
      expect(w.storage?.has(NEXT_KEY), value).toBe(false);
    }
  });

  it('주소에 이미 화면이 있으면 그 화면을 연다(저장값은 소비만)', async () => {
    const w = await boot('ko', '#/settings/plan', { storage: seeded(place('#/agents')) });
    expect(w.location.hash).toBe('#/settings/plan');
    expect(w.storage?.has(NEXT_KEY)).toBe(false);
  });

  it('로그아웃하면 둔 화면과 조직 기억을 지운다(공용 PC — 다음 사용자에게 남지 않게)', async () => {
    const w = await boot('ko', '#/overview', { storage: seeded(place('#/agents')) });
    w.storage?.set(NEXT_KEY, place('#/agents/a1'));
    w.el('logout').dispatch('click');
    await settle();
    expect(w.storage?.has(NEXT_KEY)).toBe(false);
    expect(w.storage?.has(ORG_KEY)).toBe(false);
  });
});

describe('폼 오류는 틀린 칸에 (R7-06)', () => {
  it('새 에이전트 — 빈 이름은 aria-invalid + aria-describedby + 포커스, 입력을 시작하면 해제 · 요청은 가지 않는다', async () => {
    const w = await boot('en', '#/agents');
    w.el('na-open').dispatch('click');
    w.el('na-form').dispatch('submit');
    const name = w.el('na-name');
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(name.getAttribute('aria-describedby')).toBe('na-name-err');
    expect(w.active()).toBe(name);
    expect(w.calls.some((c) => c.method === 'POST' && c.url === '/api/agents')).toBe(false);
    w.doc('input', { target: name });
    expect(name.getAttribute('aria-invalid')).toBeNull();
    expect(name.getAttribute('aria-describedby')).toBeNull();
  });
});

describe('토스트 · 폐기 뒤 포커스 (R7-11)', () => {
  it('토큰을 폐기하면 성공은 토스트로 · 조작부 옆 줄은 보이지 않는 줄 · 포커스는 화면 제목', async () => {
    const w = await boot('ko', '#/agents/a1/tokens');
    const row = w.el('tk-body').children[0] as FakeNode;
    find(row, (n) => n.className.includes('more-btn'))[0]?.dispatch('click');
    find(row, (n) => n.className.split(' ').includes('mi') && n.textContent === '폐기')[0]?.dispatch('click');
    w.el('dc-ok').onclick?.();
    await settle();
    const toasts = w.el('toasts').children;
    expect(toasts.length).toBe(1);
    expect(toasts[0]?.textContent).toBe('prod-mcp 토큰을 폐기했습니다.');
    expect(w.el('tk-msg').className).toBe('msg ok');
    expect(w.el('tk-msg').getAttribute('role')).toBeNull();
    expect(w.active()).toBe(w.el('h-ag-tokens'));
  });
});

describe('배포 전 리뷰 반영(콘솔)', () => {
  it('M1 로그 캐시 키에 스코프 — 조직 로그를 에이전트 X로 거른 뒤 X의 로그 탭으로 가면 다시 읽고 머리에 에이전트 열이 없다', async () => {
    const w = await boot('ko', '#/logs');
    w.el('lf-agent').value = 'a1';
    w.el('lf-agent').dispatch('change');
    await settle();
    const orgHead = w.el('lg-head').children.map((th) => th.getAttribute('data-k'));
    expect(orgHead).toContain('agent');
    const before = w.calls.length;
    await w.go('#/agents/a1/logs');
    expect(w.calls.length).toBeGreaterThan(before);
    expect(w.el('lg-head').children.map((th) => th.getAttribute('data-k'))).not.toContain('agent');
  });

  it('정책을 받기 전 잠금은 모드·목록 입력·저장만 — 목록 제목의 ⓘ 와 채널 전용 칸은 fieldset 밖', async () => {
    OVERRIDE.set('/api/agents/a1/policy', { status: 500, json: { error: 'internal' } });
    const w = await boot('en', '#/agents/a1/email');
    for (const id of ['o-fs', 'o-allow-fs', 'o-block-fs', 'o-save-fs']) expect(w.el(id).disabled || w.el(id).getAttribute('disabled') !== null, id).toBe(true);
    // 가짜 DOM 은 부모 사슬이 없다 — 마크업에서 각 잠금 칸이 품은 것을 본다.
    const html = inlined(renderAppPage('en'));
    const blocks = [...html.matchAll(/<fieldset class="dirfs" id="([a-z]-[a-z-]*fs)" disabled>([\s\S]*?)<\/fieldset>(?!<\/fieldset>)/g)];
    expect(blocks.map((m) => m[1])).toEqual(expect.arrayContaining(['o-fs', 'o-allow-fs', 'o-block-fs', 'o-save-fs', 'i-fs', 'i-allow-fs', 'i-block-fs', 'i-save-fs']));
    for (const m of blocks) expect(m[2], m[1]).not.toContain('tip-btn');
    // 목록 추가는 머리의 버튼 → 대화상자(2026-09-29) — 버튼은 fieldset 밖이라 정책 전에는 스스로 잠겨 있다 · 인라인 입력 칸은 없다.
    expect(html).toMatch(/<button type="button" class="btn sm ghost addbtn" id="o-allow-add" aria-haspopup="dialog" aria-label="Add to allowlist" disabled>/);
    expect(w.el('o-allow-add').disabled).toBe(true);
    expect(html).toMatch(/<fieldset class="dirfs" id="o-allow-fs" disabled><p class="msg" id="o-allow-msg"/);
    expect(html).not.toContain('class="addrow"');
  });

  it('건너뛰기 링크의 #main 은 라우트가 아니다 — 없는 화면 배너 없이 개요', async () => {
    const w = await boot('ko', '#main');
    expect(w.location.hash).toBe('#/overview');
    expect(w.el('v-overview').hidden).toBe(false);
    expect(w.el('banner').hidden).toBe(true);
  });
});
