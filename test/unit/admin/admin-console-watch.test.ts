/**
 * 콘솔(가짜 DOM) — 감시 탭(2026-10-08 · 마크업 `markup/watch.ts` · 스크립트 `script/watch.ts` · API `src/admin/routes/watch.ts`).
 *
 *   Ⓦ-0 구조: 사이드바(개요 · 에이전트 · 도메인 · 감시 · 로그 · 설정) · 감시 메뉴 순서 = 라우터 `WATCH_SECTIONS` · 섹션 하나씩 · 예전 `#/settings/aiwatch` 리다이렉트.
 *   Ⓦ-1 보류된 메일: 등급 표식(차단 = 꽉 찬 · 위험 = 테두리) · 보낸 사람 도메인 + 인증 · 풀 수 없는 행의 이유 · 풀어 주기(빨간 확인 · 차단은 확인란) · 409 문구 ·
 *        멤버는 버튼 없음 · 에이전트 거르기 · 더 보기.
 *   Ⓦ-2 에이전트별 설정: 값 · 변경 대화상자 → 바뀐 칸만 PATCH · 차단 고정 한 줄 · 멤버는 버튼 없음.
 *   Ⓦ-3 신뢰 발신자: 소유자만 추가(확인란) · 공용 메일 도메인은 칸 오류(요청 없음) · 서버 거절도 칸 오류 · 제거 = 목록 통째 PATCH · 관리자는 읽기 전용.
 *   Ⓦ-4 자가 등록: 켜기는 소유자 + 확인 대화상자 · 하루 상한 대화상자(범위) · 알림 스위치 · 관리자는 잠김 · 토큰 창의 agents:enroll 은 소유자에게만.
 *   Ⓦ-5 가입한 곳: 행 · 종류 이름 · 알림 스위치.
 *   Ⓦ-6 문구: 영어 화면에 한글 없음 · copy-guard 통과.
 *
 * 되돌려서 빨개지는지 확인한 것(2026-10-08): `pgForm` 의 바뀐 칸 비교를 지우면(전부 보냄) → Ⓦ-2b · `releaseHeld` 의 ack 를 빼면 → Ⓦ-1c ·
 * `trustedParse` 뒤 공용 도메인 검사를 빼면 → Ⓦ-3b(요청이 나간다) · 토큰 창의 `NTOWN` 숨김을 빼면 → Ⓦ-4d.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MESSAGES } from '../../../src/admin/ui/i18n';
import { ADMIN_UI_CSS } from '../../../src/admin/ui/styles';
import { renderAppPage, type Lang } from '../../../src/admin/ui/index';
import { WATCH_NAV } from '../../../src/admin/ui/console/markup/watch';
import { ROUTER_JS } from '../../../src/admin/ui/console/router';
import { copyGuardHits, visibleText } from '../../support/copy-guard';

import { boot, type FakeNode, HANGUL, HELD, inlined, me, OVERRIDE, resetWatch, settle, t, WATCH, type World } from './console-harness';

beforeEach(() => resetWatch());
afterEach(() => OVERRIDE.clear());

const LANGS = ['ko', 'en'] as const;
const SECTIONS = JSON.parse(/var WATCH_SECTIONS=(\[[^\]]*\]);/.exec(ROUTER_JS)?.[1]?.replace(/'/g, '"') ?? '[]') as string[];
const calls = (w: World, method: string, url: string): unknown[] => w.calls.filter((c) => c.method === method && c.url === url).map((c) => c.body);
const has = (n: FakeNode, c: string): boolean => n.className.split(/\s+/).includes(c);
const find = (n: FakeNode, pred: (x: FakeNode) => boolean): FakeNode | undefined => n.all().find(pred);
const btn = (n: FakeNode, text: string): FakeNode | undefined => find(n, (x) => x.tagName === 'BUTTON' && x.textContent === text);
const visible = (w: World): string[] => SECTIONS.filter((s) => !w.el(`w-${s}`).hidden);

async function as(lang: Lang, role: string, hash: string): Promise<World> {
  OVERRIDE.set('/api/me', me(role));
  return boot(lang, hash);
}
async function click(w: World, n: FakeNode | undefined): Promise<void> {
  if (!n) throw new Error('누를 것이 없다');
  n.click();
  await settle();
}

describe('Ⓦ-0 구조 · 라우팅', () => {
  it('Ⓦ-0a 감시 메뉴 = 묶음 둘(메일 · 에이전트) · 항목 순서 = WATCH_SECTIONS · 섹션도 같은 순서 · 처음엔 전부 숨김', () => {
    expect(SECTIONS).toEqual(['held', 'trusted', 'ai', 'agents', 'signups', 'enroll']);
    expect(WATCH_NAV.flatMap(([, , items]) => items.map(([s]) => s))).toEqual(SECTIONS);
    for (const lang of LANGS) {
      const html = inlined(renderAppPage(lang));
      const nav = /<nav class="snav" id="wnav" aria-label="([^"]+)">([\s\S]*?)<\/nav>/.exec(html);
      expect(nav?.[1]).toBe(t(lang, '감시 메뉴'));
      expect([...(nav?.[2] ?? '').matchAll(/<a href="#\/watch\/([a-z]+)" id="nw-\1">/g)].map((m) => m[1])).toEqual(SECTIONS);
      expect([...html.matchAll(/<section class="spane" id="w-([a-z]+)" aria-labelledby="h-w-\1" hidden>/g)].map((m) => m[1])).toEqual(SECTIONS);
      expect(html).toContain('<section class="view" id="v-watch" aria-labelledby="h-watch" hidden>');
    }
  });

  it.each(LANGS)('Ⓦ-0b (%s) #/watch → 첫 섹션(보류된 메일) · 사이드바 감시는 위치 · 메뉴의 그 항목만 현재', async (lang) => {
    const w = await as(lang, 'owner', '#/watch');
    expect(w.location.hash).toBe('#/watch/held');
    expect(w.el('v-watch').hidden).toBe(false);
    expect(visible(w)).toEqual(['held']);
    expect(w.el('n-watch').getAttribute('aria-current')).toBe('location');
    expect(SECTIONS.filter((s) => w.el(`nw-${s}`).getAttribute('aria-current') === 'page')).toEqual(['held']);
    await w.go('#/watch/enroll');
    expect(visible(w)).toEqual(['enroll']);
    expect(w.active()).toBe(w.el('h-w-enroll'));
  });

  it.each(LANGS)('Ⓦ-0c (%s) 예전 #/settings/aiwatch → #/watch/ai · AI 의심 메일 섹션이 열리고 설정은 닫힌다', async (lang) => {
    const w = await as(lang, 'owner', '#/settings/aiwatch');
    expect(w.location.hash).toBe('#/watch/ai');
    expect(w.el('v-settings').hidden).toBe(true);
    expect(visible(w)).toEqual(['ai']);
    expect(w.el('aw-open').hidden).toBe(false);
    expect(calls(w, 'GET', '/api/settings/ai-watch')).toHaveLength(1);
  });

  it('Ⓦ-0d 섹션 데이터는 그 섹션을 열 때만 — 보류 목록 · 조직 설정 한 번 · 가입 목록 · 에이전트 감시', async () => {
    const w = await as('ko', 'owner', '#/overview');
    const held = '/api/watch/held?limit=50';
    expect(calls(w, 'GET', held)).toHaveLength(0);
    expect(calls(w, 'GET', '/api/watch/settings')).toHaveLength(0);
    await w.go('#/watch/held');
    expect(calls(w, 'GET', held)).toHaveLength(1);
    await w.go('#/watch/trusted');
    await w.go('#/watch/enroll');
    expect(calls(w, 'GET', '/api/watch/settings')).toHaveLength(1);
    await w.go('#/watch/signups');
    expect(calls(w, 'GET', '/api/watch/signups?limit=50')).toHaveLength(1);
    await w.go('#/watch/agents');
    expect(calls(w, 'GET', '/api/agents/a1/watch')).toHaveLength(1);
    await w.go('#/watch/held');
    expect(calls(w, 'GET', held)).toHaveLength(1); // 감시에 머무는 동안 다시 읽지 않는다
  });
});

describe.each(LANGS)('Ⓦ-1 보류된 메일 (%s)', (lang) => {
  it('Ⓦ-1a 행 다섯 — 등급 표식(차단 꽉 찬 · 위험 테두리) · 이유 + 계열 · 보낸 사람 + 인증 · 풀 수 없는 행은 이유', async () => {
    const w = await as(lang, 'owner', '#/watch/held');
    const rows = w.el('hm-body').children;
    expect(rows).toHaveLength(HELD.length);
    expect(w.el('hm-empty').hidden).toBe(true);
    expect(w.el('hm-count').textContent).toBe(t(lang, '{n}건').replace('{n}', '5'));
    const lv = rows.map((r) => find(r, (x) => has(x, 'lvl')));
    expect(lv.map((x) => x?.className)).toEqual(['lvl lvl-block', 'lvl lvl-risk', 'lvl lvl-block', 'lvl lvl-risk', 'lvl lvl-block']);
    expect(lv[0]?.textContent).toBe(t(lang, '차단'));
    expect(lv[1]?.textContent).toBe(t(lang, '위험'));
    // 이유 = 이유 · 첫 계열(+ 외 n) — 전체 계열은 title
    expect(rows[0]?.textContent).toContain(`${t(lang, '인젝션 의심')} · ${t(lang, '정보 빼내기')}${t(lang, ' 외 {n}').replace('{n}', '1')}`);
    // 보낸 사람 도메인 + 인증 표시
    const auth = rows.map((r) => find(r, (x) => has(x, 'auth')));
    expect(auth[0]?.className).toBe('auth');
    expect(auth[0]?.textContent).toBe(t(lang, '인증 안 됨'));
    expect(auth[1]?.className).toBe('auth on');
    expect(auth[1]?.textContent).toBe(t(lang, '인증됨'));
    expect(rows[1]?.textContent).toContain('partner.example');
    // 풀 수 있는 행은 버튼, 검사 실패 행은 잠긴 같은 버튼 + 이유는 title(2026-10-15 F71 — 버튼 자리에서 두 줄로 접히지 않는다)
    expect(btn(rows[0] as FakeNode, t(lang, '풀어 주기'))?.disabled).toBe(false);
    const locked = btn(rows[2] as FakeNode, t(lang, '풀어 주기'));
    expect(locked?.disabled).toBe(true);
    expect(locked?.title).toBe(t(lang, '검사를 마치지 못한 메일은 안전하게 풀 수 없습니다.'));
    expect(rows[2]?.textContent).toContain(t(lang, '풀 수 없음: 검사 실패')); // 터치에서도 보이는 한 줄(리뷰)
    if (lang === 'en') for (const r of rows) expect(r.textContent).not.toMatch(HANGUL);
  });

  it('Ⓦ-1b 위험 등급 풀어 주기 — 빨간 확인(에이전트가 본다 · 새 상대 발송은 승인) · 확인란 없음 → POST → 행이 빠지고 한 줄', async () => {
    const w = await as(lang, 'admin', '#/watch/held');
    const row = w.el('hm-body').children[1] as FakeNode;
    await click(w, btn(row, t(lang, '풀어 주기')));
    expect(w.el('dlg-confirm').open).toBe(true);
    expect(w.el('dc-head').className).toBe('dh hatch');
    expect(w.el('dc-title').textContent).toBe(t(lang, '이 메일을 풀어 줄까요?'));
    const body = w.el('dc-body').textContent;
    expect(body).toContain(t(lang, '에이전트가 이 메일을 읽으면, 그 뒤 처음 보내는 상대에게 가는 메일은 내 승인을 거칩니다.'));
    expect(body).toContain('partner.example');
    expect(body).not.toContain(t(lang, '보낸 사람이 인증되지 않았습니다. 도메인이 위조됐을 수 있습니다.'));
    expect(w.el('dc-ackwrap').hidden).toBe(true);
    w.el('dc-ok').onclick?.();
    await settle();
    expect(calls(w, 'POST', `/api/watch/held/${HELD[1]?.id ?? ''}/release`)).toHaveLength(1);
    expect(w.el('hm-body').children).toHaveLength(4);
    expect(w.el('hm-msg').textContent).toBe(t(lang, '풀어 줬습니다. 이제 에이전트에게 보입니다.'));
  });

  it('Ⓦ-1c 차단 등급은 확인란을 체크해야 풀린다 · 인증 안 된 보낸 사람은 한 줄 더 · 취소면 요청 없음', async () => {
    const w = await as(lang, 'owner', '#/watch/held');
    const row = w.el('hm-body').children[0] as FakeNode;
    await click(w, btn(row, t(lang, '풀어 주기')));
    expect(w.el('dc-ackwrap').hidden).toBe(false);
    expect(w.el('dc-acktext').textContent).toBe(t(lang, '차단 등급 메일인 것을 확인했습니다'));
    expect(w.el('dc-ok').disabled).toBe(true);
    expect(w.el('dc-body').textContent).toContain(t(lang, '보낸 사람이 인증되지 않았습니다. 도메인이 위조됐을 수 있습니다.'));
    w.el('dc-cancel').onclick?.();
    await settle();
    expect(w.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('Ⓦ-1d 409 오류는 사람 말로 · message_not_held 면 목록을 다시 읽는다', async () => {
    OVERRIDE.set(`POST /api/watch/held/${HELD[1]?.id ?? ''}/release`, { status: 409, json: { error: 'release_policy_blocked' } });
    const w = await as(lang, 'owner', '#/watch/held');
    await click(w, btn(w.el('hm-body').children[1] as FakeNode, t(lang, '풀어 주기')));
    w.el('dc-ok').onclick?.();
    await settle();
    expect(w.el('hm-msg').textContent).toBe(t(lang, '수신 정책(허용 · 차단 목록)으로 막은 메일은 풀 수 없습니다. 수신 정책을 고치세요.'));
    expect(w.el('hm-msg').className).toBe('msg err');
    OVERRIDE.set(`POST /api/watch/held/${HELD[3]?.id ?? ''}/release`, { status: 409, json: { error: 'message_not_held' } });
    await click(w, btn(w.el('hm-body').children[3] as FakeNode, t(lang, '풀어 주기')));
    w.el('dc-ok').onclick?.();
    await settle();
    expect(w.el('hm-msg').textContent).toBe(t(lang, '이미 풀렸거나 보류된 메일이 아닙니다. 새로고침하세요.'));
    expect(calls(w, 'GET', '/api/watch/held?limit=50')).toHaveLength(2);
  });

  it('Ⓦ-1e 멤버는 풀어 주기 버튼이 없다(목록은 보인다) · 빈 목록은 빈 상태 · 에이전트 거르기는 agentId 로 다시 읽는다', async () => {
    const m = await as(lang, 'member', '#/watch/held');
    expect(m.el('hm-body').children).toHaveLength(5);
    for (const r of m.el('hm-body').children) expect(btn(r, t(lang, '풀어 주기'))).toBeUndefined();
    m.el('hm-agent').value = 'a1';
    m.el('hm-agent').dispatch('change');
    await settle();
    expect(calls(m, 'GET', '/api/watch/held?limit=50&agentId=a1')).toHaveLength(1);

    OVERRIDE.set('GET /api/watch/held?limit=50', { status: 200, json: { items: [], nextCursor: null } });
    const e = await as(lang, 'owner', '#/watch/held');
    expect(e.el('hm-empty').hidden).toBe(false);
    expect(e.el('hm-tbl').hidden).toBe(true);
  });

  it('Ⓦ-1f 다음 쪽이 있으면 더 보기 → cursor 로 이어 붙인다', async () => {
    OVERRIDE.set('GET /api/watch/held?limit=50', { status: 200, json: { items: HELD.slice(0, 2), nextCursor: 'c2' } });
    OVERRIDE.set('GET /api/watch/held?limit=50&cursor=c2', { status: 200, json: { items: HELD.slice(2), nextCursor: null } });
    const w = await as(lang, 'owner', '#/watch/held');
    expect(w.el('hm-body').children).toHaveLength(2);
    expect(w.el('hm-more').hidden).toBe(false);
    expect(w.el('hm-count').textContent).toBe(t(lang, '{n}건 이상').replace('{n}', '2'));
    await click(w, w.el('hm-more'));
    expect(w.el('hm-body').children).toHaveLength(5);
    expect(w.el('hm-more').hidden).toBe(true);
  });
});

describe.each(LANGS)('Ⓦ-2 에이전트별 설정 (%s)', (lang) => {
  it('Ⓦ-2a 값 셋 · 차단 고정 한 줄(스위치 아님) · 변경 → 대화상자(지금 값으로 채움)', async () => {
    const w = await as(lang, 'admin', '#/watch/agents');
    const row = w.el('pa-body').children[0] as FakeNode;
    expect(row.textContent).toContain('founder-agent');
    expect(row.textContent).toContain(t(lang, '바로 전달'));
    expect(row.textContent).toContain(t(lang, '켜짐'));
    expect(row.textContent).toContain(t(lang, '자동'));
    const html = inlined(renderAppPage(lang));
    const sec = /<section class="spane" id="w-agents"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
    expect(sec).toContain(`<p class="wfix"><span class="lvl lvl-block">${t(lang, '차단')}</span>`);
    expect(sec).not.toContain('role="switch"');
    await click(w, btn(row, t(lang, '변경')));
    expect(w.el('dlg-wagent').open).toBe(true);
    expect(w.el('pg-title').textContent).toBe('founder-agent');
    expect(w.el('pg-rh-deliver').checked).toBe(true);
    expect(w.el('pg-notify').checked).toBe(true);
    expect(w.el('pg-sa-auto').checked).toBe(true);
  });

  it('Ⓦ-2b 바뀐 칸만 보낸다 — 보류 + 모두 내 승인 → PATCH {riskHandling, sendApproval} · 아무것도 안 바꾸면 요청 없음', async () => {
    const w = await as(lang, 'owner', '#/watch/agents');
    await click(w, btn(w.el('pa-body').children[0] as FakeNode, t(lang, '변경')));
    w.el('pg-form').dispatch('submit');
    await settle();
    expect(calls(w, 'PATCH', '/api/agents/a1/watch')).toEqual([]);
    expect(w.el('dlg-wagent').open).toBe(false);
    await click(w, btn(w.el('pa-body').children[0] as FakeNode, t(lang, '변경')));
    w.el('pg-rh-deliver').checked = false;
    w.el('pg-rh-hold').checked = true;
    w.el('pg-sa-auto').checked = false;
    w.el('pg-sa-always').checked = true;
    w.el('pg-form').dispatch('submit');
    await settle();
    expect(calls(w, 'PATCH', '/api/agents/a1/watch')).toEqual([{ riskHandling: 'hold', sendApproval: 'always' }]);
    expect(w.el('dlg-wagent').open).toBe(false);
    const row = w.el('pa-body').children[0] as FakeNode;
    expect(row.textContent).toContain(t(lang, '보류 후 확인'));
    expect(row.textContent).toContain(t(lang, '모두 내 승인'));
  });

  it('Ⓦ-2c 멤버는 변경 버튼이 없다', async () => {
    const w = await as(lang, 'member', '#/watch/agents');
    const row = w.el('pa-body').children[0] as FakeNode;
    expect(row.textContent).toContain(t(lang, '바로 전달'));
    expect(btn(row, t(lang, '변경'))).toBeUndefined();
  });
});

describe.each(LANGS)('Ⓦ-3 신뢰 발신자 (%s)', (lang) => {
  it('Ⓦ-3a 소유자 — 목록 · 수 / 최대 · 추가는 확인란을 체크해야 열린다 → PATCH 목록 통째(기존 + 새 값)', async () => {
    const w = await as(lang, 'owner', '#/watch/trusted');
    expect(w.el('wt-count').textContent).toBe('2 / 200');
    expect(w.el('wt-body').children).toHaveLength(2);
    expect(w.el('wt-owner').hidden).toBe(true);
    await click(w, w.el('wt-add'));
    expect(w.el('dlg-wtrust').open).toBe(true);
    expect(w.el('wt-go').disabled).toBe(true);
    w.el('wt-in').value = 'Alerts@Partner2.example';
    w.el('wt-ack').checked = true;
    w.el('wt-ack').dispatch('change');
    expect(w.el('wt-go').disabled).toBe(false);
    w.el('wt-form').dispatch('submit');
    await settle();
    expect(calls(w, 'PATCH', '/api/watch/settings')).toEqual([{ trustedSenders: ['billing@vendor.example', 'partner.example', 'alerts@partner2.example'] }]);
    expect(w.el('dlg-wtrust').open).toBe(false);
    expect(w.el('wt-count').textContent).toBe('3 / 200');
  });

  it('Ⓦ-3b 공용 메일 도메인은 칸 바로 아래에서 거절(요청 없음) · 서버가 거절해도 같은 자리 · 모양이 틀리면 칸 오류', async () => {
    const w = await as(lang, 'owner', '#/watch/trusted');
    await click(w, w.el('wt-add'));
    w.el('wt-ack').checked = true;
    w.el('wt-ack').dispatch('change');
    w.el('wt-in').value = 'naver.com';
    w.el('wt-form').dispatch('submit');
    await settle();
    expect(calls(w, 'PATCH', '/api/watch/settings')).toEqual([]);
    expect(w.el('wt-in').getAttribute('aria-invalid')).toBe('true');
    const line = t(lang, '{d} 도메인은 누구나 주소를 만들 수 있어 통째로 넣을 수 없습니다. 정확한 주소(name@{d})를 넣으세요.').split('{d}').join('naver.com');
    expect(w.body.all().some((n) => n.textContent === line)).toBe(true); // 칸 오류(`fieldErr` — 칸 바로 아래 한 줄)

    w.el('wt-in').value = '*.example.com';
    w.el('wt-form').dispatch('submit');
    await settle();
    expect(calls(w, 'PATCH', '/api/watch/settings')).toEqual([]);

    // 서버만 아는 공용 도메인(하네스 목록) — 서버 코드도 칸 오류
    OVERRIDE.set('PATCH /api/watch/settings', { status: 400, json: { error: 'trusted_sender_freemail_domain' } });
    w.el('wt-in').value = 'freemail.example';
    w.el('wt-form').dispatch('submit');
    await settle();
    expect(calls(w, 'PATCH', '/api/watch/settings')).toHaveLength(1);
    const line2 = t(lang, '{d} 도메인은 누구나 주소를 만들 수 있어 통째로 넣을 수 없습니다. 정확한 주소(name@{d})를 넣으세요.').split('{d}').join('freemail.example');
    expect(w.body.all().some((n) => n.textContent === line2)).toBe(true);
    expect(w.el('dlg-wtrust').open).toBe(true);
  });

  it('Ⓦ-3c 제거 — 확인 → 나머지 목록으로 PATCH', async () => {
    const w = await as(lang, 'owner', '#/watch/trusted');
    await click(w, btn(w.el('wt-body').children[1] as FakeNode, t(lang, '제거')));
    expect(w.el('dc-title').textContent).toBe(t(lang, '이 신뢰 발신자를 제거할까요?'));
    expect(w.el('dc-body').textContent).toContain('partner.example');
    w.el('dc-ok').onclick?.();
    await settle();
    expect(calls(w, 'PATCH', '/api/watch/settings')).toEqual([{ trustedSenders: ['billing@vendor.example'] }]);
    expect(WATCH.trusted.map((x) => x.value)).toEqual(['billing@vendor.example']);
  });

  it('Ⓦ-3d 관리자는 읽기 전용 — 추가 숨김 · 제거 없음 · "소유자만" 한 줄', async () => {
    const w = await as(lang, 'admin', '#/watch/trusted');
    expect(w.el('wt-body').children).toHaveLength(2);
    expect(w.el('wt-add').hidden).toBe(true);
    expect(w.el('wt-owner').hidden).toBe(false);
    for (const r of w.el('wt-body').children) expect(btn(r, t(lang, '제거'))).toBeUndefined();
  });
});

describe.each(LANGS)('Ⓦ-4 자가 등록 (%s)', (lang) => {
  it('Ⓦ-4a 소유자 — 꺼짐 → 누르면 확인 대화상자(토큰마다 · 상한 · 안전 기본값) → PATCH {agentSelfEnroll:true} → 켜짐', async () => {
    const w = await as(lang, 'owner', '#/watch/enroll');
    const sw = w.el('we-switch');
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(sw.getAttribute('aria-disabled')).toBeNull();
    expect(w.el('we-cap').textContent).toBe(t(lang, '{n}개 / 24시간').replace('{n}', '5'));
    await click(w, sw);
    expect(w.el('dlg-confirm').open).toBe(true);
    expect(w.el('dc-title').textContent).toBe(t(lang, '자가 등록을 켤까요?'));
    expect(w.el('dc-body').textContent).toContain(t(lang, '24시간에 {n}번까지 시도할 수 있고, 요금제의 에이전트 한도를 넘지 못합니다.').replace('{n}', '5'));
    w.el('dc-ok').onclick?.();
    await settle();
    expect(calls(w, 'PATCH', '/api/watch/settings')).toEqual([{ agentSelfEnroll: true }]);
    expect(sw.getAttribute('aria-checked')).toBe('true');
    // 끄기는 바로
    await click(w, sw);
    expect(calls(w, 'PATCH', '/api/watch/settings')).toEqual([{ agentSelfEnroll: true }, { agentSelfEnroll: false }]);
  });

  it('Ⓦ-4b 하루 상한 — 범위 밖이면 칸 오류(요청 없음) · 범위 안이면 PATCH {enrollDailyCap}', async () => {
    const w = await as(lang, 'owner', '#/watch/enroll');
    await click(w, w.el('we-cap-edit'));
    expect(w.el('dlg-wcap').open).toBe(true);
    expect(w.el('wc-n').value).toBe('5');
    w.el('wc-n').value = '21';
    w.el('wc-form').dispatch('submit');
    await settle();
    expect(calls(w, 'PATCH', '/api/watch/settings')).toEqual([]);
    expect(w.el('wc-n').getAttribute('aria-invalid')).toBe('true');
    w.el('wc-n').value = '12';
    w.el('wc-form').dispatch('submit');
    await settle();
    expect(calls(w, 'PATCH', '/api/watch/settings')).toEqual([{ enrollDailyCap: 12 }]);
    expect(w.el('dlg-wcap').open).toBe(false);
  });

  it('Ⓦ-4c 알림 스위치 → PATCH {notifyOnEnroll:false} · 관리자는 스위치 둘 다 잠김 · 상한 변경 숨김', async () => {
    const w = await as(lang, 'owner', '#/watch/enroll');
    await click(w, w.el('we-notify'));
    expect(calls(w, 'PATCH', '/api/watch/settings')).toEqual([{ notifyOnEnroll: false }]);
    const a = await as(lang, 'admin', '#/watch/enroll');
    expect(a.el('we-switch').getAttribute('aria-disabled')).toBe('true');
    expect(a.el('we-notify').getAttribute('aria-disabled')).toBe('true');
    expect(a.el('we-switch-line').textContent).toBe(t(lang, '소유자만 바꿀 수 있습니다.'));
    expect(a.el('we-cap-edit').hidden).toBe(true);
    await click(a, a.el('we-switch'));
    expect(a.el('dlg-confirm').open).toBe(false);
    expect(a.calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
  });

  it('Ⓦ-4d 토큰 창의 자가 등록 권한(agents:enroll) — 소유자에게만 보이고 기본은 꺼짐 · 고르면 경고 한 줄 · 관리자는 숨김', async () => {
    const o = await as(lang, 'owner', '#/agents/a1/tokens');
    await click(o, o.el('tk-new'));
    const box = o.el('nt-cap-5');
    expect(box.value).toBe('agents:enroll');
    expect(box.checked).toBe(false);
    expect(o.el('nt-cap-5-w').hidden).toBe(false);
    expect(o.el('nt-enroll-warn').hidden).toBe(true);
    box.checked = true;
    box.dispatch('change');
    expect(o.el('nt-enroll-warn').hidden).toBe(false);
    const a = await as(lang, 'admin', '#/agents/a1/tokens');
    await click(a, a.el('tk-new'));
    expect(a.el('nt-cap-5-w').hidden).toBe(true);
  });
});

describe.each(LANGS)('Ⓦ-5 가입한 곳 (%s)', (lang) => {
  it('Ⓦ-5a 행 셋(서비스 · 에이전트 · 종류 · 처음 · 마지막 · 수) · 알림 스위치 → PATCH {notifyOnSignup:false}', async () => {
    const w = await as(lang, 'owner', '#/watch/signups');
    const rows = w.el('su-body').children;
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toContain('accounts.devtools.example');
    expect(rows.map((r) => r.children[2]?.textContent)).toEqual(['인증 메일', '환영 메일', '계정 생성'].map((k) => t(lang, k)));
    expect(w.el('su-notify').getAttribute('aria-checked')).toBe('true');
    await click(w, w.el('su-notify'));
    expect(calls(w, 'PATCH', '/api/watch/settings')).toEqual([{ notifyOnSignup: false }]);
    expect(w.el('su-notify').getAttribute('aria-checked')).toBe('false');
  });
});

describe('Ⓦ-1b 보류된 메일 표가 카드 안에 맞는다(2026-10-12 — 1024·1280 폭에서 "풀어 주기" 칸이 잘렸다)', () => {
  it('표 폭(768px~)은 고정 칸 — 가변 칸(이유)은 두 줄 · 보낸 사람은 인증 표식을 아래로 · 동작 칸 폭은 버튼이 들어가는 고정값', () => {
    const block = /@media \(min-width:768px\)\{\n {2}\.wht\{table-layout:fixed\}[\s\S]*?\n\}/.exec(ADMIN_UI_CSS)?.[0] ?? '';
    expect(block).not.toBe('');
    expect(block).toContain('.wht td{overflow:hidden}');
    expect(block).toContain('.wht th:nth-child(6){width:112px}');
    expect(block).toMatch(/\.wht td:nth-child\(3\) \.cv\{[^}]*white-space:normal[^}]*-webkit-line-clamp:2/);
    expect(block).toContain('.wht .sdr{flex-direction:column');
  });
});

describe('Ⓦ-6 문구', () => {
  it.each(LANGS)('Ⓦ-6a (%s) 감시 화면 · 대화상자 글자(ⓘ 포함) — 영어 화면에 한글 없음 · copy-guard 통과 · 타사 이름 없음', (lang) => {
    const html = inlined(renderAppPage(lang));
    const view = /<section class="view" id="v-watch"[\s\S]*?<\/section><\/div><\/div><\/section>/.exec(html)?.[0] ?? '';
    const dialogs = ['dlg-wagent', 'dlg-wtrust', 'dlg-wcap'].map((id) => new RegExp(`<dialog id="${id}"[\\s\\S]*?</dialog>`).exec(html)?.[0] ?? '').join('');
    const text = visibleText(view + dialogs);
    expect(text.length).toBeGreaterThan(1500);
    if (lang === 'en') expect(text).not.toMatch(HANGUL);
    expect(copyGuardHits(text)).toEqual([]);
    expect(text).not.toMatch(/Claude|Codex|Cursor|Gmail|Outlook|ChatGPT|OpenAI|Anthropic/);
  });

  it('Ⓦ-6b 감시 사전 문구(두 언어)는 copy-guard 를 지난다', () => {
    for (const lang of LANGS) {
      const hits = Object.entries(MESSAGES[lang])
        .filter(([ko]) => /감시|보류|신뢰 발신자|자가 등록|가입|풀어|차단 등급|위험 등급|인젝션 탐지/.test(ko))
        .flatMap(([, v]) => copyGuardHits(v).map((hit) => `${hit}: ${v}`));
      expect(hits, lang).toEqual([]);
    }
  });
});
