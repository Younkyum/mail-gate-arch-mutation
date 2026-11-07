/**
 * 콘솔(가짜 DOM) — 웹훅 탭 `#/agents/{id}/webhooks`(2026-09-30).
 *   Ⓦ 목록: 주소 탭 뒤의 사이드바 항목 · URL(전체 값은 title) · 이벤트 칩 · 마지막 전달 · 비밀값 버전 · 한도 한 줄 · 빈 상태(추가 버튼 하나).
 *   Ⓐ 추가: 버튼 → 대화상자(https 만 · 기본 넷이 켜진 이벤트 · 하나도 없으면 잠김) → 비밀값은 한 번만 보이는 창(복사 · 닫으면 지움).
 *   Ⓡ 교체(확인 · 빨갛지 않다 → 같은 비밀값 창 + 이전 값 시각) · 삭제(빨간 확인 → DELETE).
 *   Ⓓ 전달 기록: 커서 `더 보기` · 웹훅 필터 · 실패/포기한 행만 `다시 보내기`(확인 없음 · 누르는 동안 잠김 · 토스트).
 *   Ⓜ member 는 읽기 전용 · Ⓣ 토큰 권한 `webhooks:manage`(기본 꺼짐) · Ⓚ 마크업.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { renderAppPage } from '../../../src/admin/ui/index';

import { AGENT, boot, type FakeNode, HANGUL, inlined, me, OVERRIDE, resetTeam, settle, t, WEBHOOK_SECRET, WEBHOOK_SECRET_ROTATED, type World } from './console-harness';

afterEach(() => {
  OVERRIDE.clear();
  resetTeam();
});

const LANGS = ['ko', 'en'] as const;
const WH = '#/agents/a1/webhooks';
const buttons = (root: FakeNode | undefined): FakeNode[] => (root?.all() ?? []).filter((n) => n.tagName === 'BUTTON');
const posts = (w: World, url: string): unknown[] => w.calls.filter((c) => c.method === 'POST' && c.url === url).map((c) => c.body);
const rows = (w: World, id: string): FakeNode[] => w.el(id).children;
/** URL 칸 바로 아래의 오류 한 줄(스크립트가 만드는 노드 — 마크업에 없어 `el()` 로는 못 찾는다. 가짜 DOM 에서는 body 에 붙는다). */
const fieldMsg = (w: World): string | undefined => w.body.all().find((n) => n.id === 'wh-url-err')?.textContent;
const boxes = (w: World): FakeNode[] => w.el('wa-evts').all().filter((n) => n.tagName === 'INPUT');
/** 행의 ⋯ 메뉴에서 항목 하나를 누른다. */
function menuPick(row: FakeNode | undefined, label: string): void {
  const item = row?.all().find((n) => n.getAttribute('role') === 'menuitem' && n.textContent === label);
  if (item === undefined) throw new Error(`메뉴 항목이 없다: ${label}`);
  item.dispatch('click');
}

describe.each(LANGS)('Ⓦ 목록 (%s)', (lang) => {
  it('Ⓦ-1 사이드바의 웹훅은 주소 뒤 · 두 웹훅 · URL 전체 값은 title · 이벤트 칩 · 마지막 전달 · 비밀값 버전 · 한도 한 줄', async () => {
    const w = await boot(lang, WH);
    const html = inlined(renderAppPage(lang));
    expect([...html.matchAll(/<a href="#\/agents" id="na-([a-z]+)">/g)].map((m) => m[1])).toEqual(['overview', 'connect', 'email', 'addresses', 'webhooks', 'logs', 'identity', 'tokens']);
    expect(w.el('na-webhooks').href).toBe('#/agents/a1/webhooks');
    expect(w.el('na-webhooks').getAttribute('aria-current')).toBe('page');
    expect(w.el('t-webhooks').hidden).toBe(false);
    expect(w.el('t-addresses').hidden).toBe(true);
    expect(w.calls.some((c) => c.method === 'GET' && c.url === '/api/agents/a1/webhooks')).toBe(true);

    const list = rows(w, 'wh-body');
    expect(list).toHaveLength(2);
    const long = 'https://api.partner.example/v1/integrations/atmark/mail-events?source=founder-agent';
    const url = list[1]?.all().find((n) => n.className === 'mono whurl');
    expect(url?.textContent).toBe(long);
    expect(url?.title).toBe(long);
    // 칩은 URL 아래 — 넷까지는 전부, 다섯 이상은 셋 + "+n"(전체 목록은 title).
    const caps = list[1]?.all().find((n) => n.className === 'caps');
    expect(caps?.children.map((c) => c.textContent)).toEqual(['message.received', 'message.delivered', 'message.bounced', 'message.complained']);
    expect(caps?.title).toBe('message.received, message.delivered, message.bounced, message.complained');
    expect(list[0]?.textContent).toContain(t(lang, '전달됨'));
    expect(list[1]?.textContent).toContain(t(lang, '실패'));
    expect(list[1]?.textContent).toContain('HTTP 500');
    expect(list[0]?.textContent).toContain(lang === 'ko' ? 'v22026.09.29 교체' : 'v2rotated Sep 29, 2026');
    expect(list[1]?.textContent).toContain('v1');
    // 사용량은 제목 옆 n / N(F37), 24시간 등록 수는 title.
    expect(w.el('wh-lim').textContent).toBe('2 / 10');
    expect(w.el('wh-lim').title).toBe(lang === 'ko' ? '활성 2 / 10 · 24시간 등록 1 / 10' : 'Active 2 / 10 · Registered in 24 h 1 / 10');
    expect(w.el('wh-add').hidden).toBe(false);
    expect(w.el('wh-add').disabled).toBe(false);
    expect(w.el('wh-empty').hidden).toBe(true);
    if (lang === 'en') expect(HANGUL.test(w.el('wh-body').textContent + w.el('wd-body').textContent)).toBe(false);
  });

  it('Ⓦ-1b 다섯 가지 이상 구독하면 칩 셋 + "+n" · 삭제한(활성 아닌) 웹훅은 목록에 없다 · 마지막 전달이 없으면 없음', async () => {
    const all = ['approval.resolved', 'approval.expired', 'message.sent', 'message.received', 'message.delivered', 'message.bounced', 'message.complained'];
    const base = { createdAt: '2026-09-24T02:00:00Z', secretVersion: 1, rotatedAt: null, previousValidUntil: null, lastDelivery: null };
    OVERRIDE.set('GET /api/agents/a1/webhooks', {
      status: 200,
      json: {
        items: [
          { ...base, id: 'w7', url: 'https://hooks.example.com/all', eventTypes: all, status: 'active' },
          { ...base, id: 'w8', url: 'https://hooks.example.com/gone', eventTypes: all, status: 'deleted' },
        ],
        limits: { active: 1, activeMax: 10, registrationsToday: 2, registrationsMax: 20 },
        availableEventTypes: all,
      },
    });
    const w = await boot(lang, WH);
    const list = rows(w, 'wh-body');
    expect(list).toHaveLength(1);
    const caps = list[0]?.all().find((n) => n.className === 'caps');
    expect(caps?.children.map((c) => c.textContent)).toEqual(['approval.resolved', 'approval.expired', 'message.sent', '+4']);
    expect(caps?.title).toBe(all.join(', '));
    expect(list[0]?.textContent).toContain('—'); // 빈 값은 — 하나(2026-10-15 F16), 뜻은 title
    expect(list[0]?.all().some((n) => n.title === t(lang, '아직 전달하지 않았습니다'))).toBe(true);
  });

  it('Ⓦ-2 빈 상태 — 한 줄 설명 + 추가 버튼 하나(머리의 추가는 숨는다) · 한도가 차면 추가가 잠기고 이유는 title', async () => {
    OVERRIDE.set('GET /api/agents/a1/webhooks', { status: 200, json: { items: [], limits: { active: 0, activeMax: 10, registrationsToday: 0, registrationsMax: 20 }, availableEventTypes: [] } });
    const w = await boot(lang, WH);
    expect(w.el('wh-empty').hidden).toBe(false);
    expect(w.el('wh-tbl').hidden).toBe(true);
    expect(w.el('wh-add').hidden).toBe(true);
    expect(w.el('wh-add-empty').hidden).toBe(false);
    w.el('wh-add-empty').dispatch('click');
    expect(w.el('dlg-webhook').open).toBe(true);
    // 서버가 목록을 주지 않으면 알려진 일곱 가지로 그린다.
    expect(boxes(w).map((b) => b.value)).toHaveLength(7);

    OVERRIDE.set('GET /api/agents/a1/webhooks', { status: 200, json: { items: [], limits: { active: 0, activeMax: 10, registrationsToday: 20, registrationsMax: 20 }, availableEventTypes: [] } });
    const full = await boot(lang, WH);
    expect(full.el('wh-add-empty').disabled).toBe(true);
    expect(full.el('wh-add-empty').title).toBe(t(lang, '24시간 동안 등록할 수 있는 웹훅 수를 넘었습니다. 나중에 다시 시도하세요.'));
    full.el('wh-add-empty').dispatch('click');
    expect(full.el('dlg-webhook').open).toBe(false);
  });
});

describe.each(LANGS)('Ⓐ 추가 (%s)', (lang) => {
  it('Ⓐ-1 버튼 → 대화상자 · 기본 넷만 켜짐 · http 는 칸 아래 오류 · 성공하면 비밀값 창(한 번만) → 닫으면 지우고 제목으로', async () => {
    const w = await boot(lang, WH);
    w.el('wh-add').dispatch('click');
    expect(w.el('dlg-webhook').open).toBe(true);
    expect(w.active()).toBe(w.el('wh-url'));
    const bs = boxes(w);
    expect(bs.map((b) => b.value)).toEqual(['approval.resolved', 'approval.expired', 'message.sent', 'message.received', 'message.delivered', 'message.bounced', 'message.complained']);
    expect(bs.map((b) => b.checked)).toEqual([true, true, true, true, false, false, false]);
    expect(w.el('wa-evts').textContent).toContain(t(lang, '보낸 메일이 반송됨'));
    expect(w.el('wa-active').textContent).toBe('2 / 10');
    expect(w.el('wa-today').textContent).toBe('1 / 10');

    w.el('wh-url').value = 'http://hooks.example.com/x';
    w.el('wa-form').dispatch('submit');
    await settle();
    expect(w.el('wh-url').getAttribute('aria-invalid')).toBe('true');
    expect(fieldMsg(w)).toBe(t(lang, 'https://로 시작하는 주소만 됩니다.'));
    expect(posts(w, '/api/agents/a1/webhooks')).toEqual([]);

    bs[5]!.checked = true;
    w.el('wh-url').value = ' https://hooks.example.com/new ';
    w.el('wa-form').dispatch('submit');
    await settle();
    expect(posts(w, '/api/agents/a1/webhooks')).toEqual([{ url: 'https://hooks.example.com/new', eventTypes: ['approval.resolved', 'approval.expired', 'message.sent', 'message.received', 'message.bounced'] }]);
    expect(w.el('dlg-webhook').open).toBe(false);
    expect(w.el('dlg-whsecret').open).toBe(true);
    expect(w.el('ws-secret').textContent).toBe(WEBHOOK_SECRET);
    expect(w.el('ws-url').textContent).toBe('https://hooks.example.com/new');
    expect(w.el('ws-kicker').textContent).toBe(t(lang, '새 웹훅'));
    expect(w.el('ws-prev').hidden).toBe(true);
    expect(w.active()).toBe(w.el('ws-copy'));
    expect(rows(w, 'wh-body')).toHaveLength(3);
    expect(w.el('toasts').textContent).toContain(t(lang, '웹훅을 추가했습니다.'));

    w.el('ws-close').dispatch('click');
    expect(w.el('dlg-whsecret').open).toBe(false);
    expect(w.el('ws-secret').textContent).toBe('');
    expect(w.active()?.id).toBe('h-ag-wh');
  });

  it('Ⓐ-2 이벤트를 전부 끄면 추가가 잠기고 한 줄 · 요청 없음 · 서버의 invalid_webhook_url 은 칸 오류', async () => {
    OVERRIDE.set('POST /api/agents/a1/webhooks', { status: 400, json: { error: 'invalid_webhook_url' } });
    const w = await boot(lang, WH);
    w.el('wh-add').dispatch('click');
    for (const b of boxes(w)) b.checked = false;
    boxes(w)[0]?.dispatch('change');
    expect(w.el('wa-go').disabled).toBe(true);
    expect(w.el('wa-none').hidden).toBe(false);
    w.el('wh-url').value = 'https://hooks.example.com/x';
    w.el('wa-form').dispatch('submit');
    await settle();
    expect(posts(w, '/api/agents/a1/webhooks')).toEqual([]);

    boxes(w)[2]!.checked = true;
    boxes(w)[2]?.dispatch('change');
    expect(w.el('wa-go').disabled).toBe(false);
    w.el('wh-url').value = 'https://10.0.0.1/hook';
    w.el('wa-form').dispatch('submit');
    await settle();
    expect(posts(w, '/api/agents/a1/webhooks')).toEqual([{ url: 'https://10.0.0.1/hook', eventTypes: ['message.sent'] }]);
    expect(w.el('dlg-webhook').open).toBe(true);
    expect(fieldMsg(w)).toBe(t(lang, '등록할 수 없는 주소입니다. 공개된 https 주소인지 확인하세요.'));
    expect(w.el('dlg-whsecret').open).toBe(false);
  });

  it('Ⓐ-3 보내는 중에는 Esc·취소가 닫지 않는다 · 다른 에이전트로 옮기면 대화상자가 닫히고 옛 제출은 보내지 않는다', async () => {
    const busy = await boot(lang, WH, { latency: true });
    await settle();
    busy.el('wh-add').dispatch('click');
    busy.el('wh-url').value = 'https://hooks.example.com/slow';
    busy.el('wa-form').dispatch('submit');
    expect(busy.el('wa-go').classList.contains('busy')).toBe(true);
    expect(busy.el('dlg-webhook').dispatch('cancel').defaultPrevented).toBe(true);
    busy.el('wa-cancel').dispatch('click');
    expect(busy.el('dlg-webhook').open).toBe(true);
    await settle();
    expect(busy.el('dlg-webhook').open).toBe(false);
    expect(busy.el('dlg-whsecret').open).toBe(true);

    OVERRIDE.set('/api/agents', { status: 200, json: [AGENT, { ...AGENT, id: 'a2', name: 'research-bot', address: 'research@atmark.ai' }] });
    const w = await boot(lang, WH);
    w.el('wh-add').dispatch('click');
    w.el('wh-url').value = 'https://hooks.example.com/x';
    await w.go('#/agents/a2/webhooks');
    expect(w.el('dlg-webhook').open).toBe(false);
    w.el('wa-form').dispatch('submit');
    await settle();
    expect(posts(w, '/api/agents/a1/webhooks')).toEqual([]);
  });
});

describe.each(LANGS)('Ⓗ 인증 헤더 (%s)', (lang) => {
  const errOf = (w: World, id: string): string | undefined => w.body.all().find((n) => n.id === `${id}-err`)?.textContent;

  it('Ⓗ-1 표의 비밀값 칸 아래 힌트만 · 추가 대화상자의 가린 칸 · 비우면 보내지 않고 · 넣으면 본문에 · 위험 글자는 칸 오류(요청 없음) · 닫으면 지운다', async () => {
    const w = await boot(lang, WH);
    const secretCell = (row: FakeNode | undefined): string | undefined => row?.all().find((n) => n.className === 'whsv num')?.textContent;
    expect(secretCell(rows(w, 'wh-body')[1])).toContain(lang === 'ko' ? '인증 헤더 Bearer …9f2c' : 'Authorization header Bearer …9f2c');
    expect(secretCell(rows(w, 'wh-body')[0])).not.toContain('…');
    w.el('wh-add').dispatch('click');
    expect(w.el('wh-auth').getAttribute('type')).toBe('password');
    expect(w.el('wh-auth').getAttribute('autocomplete')).toBe('off');
    w.el('wh-url').value = 'https://hooks.example.com/auth';
    w.el('wh-auth').value = 'Bearer abc\tdef';
    w.el('wa-form').dispatch('submit');
    await settle();
    expect(posts(w, '/api/agents/a1/webhooks')).toEqual([]);
    expect(errOf(w, 'wh-auth')).toBe(t(lang, '줄바꿈·탭·한글 같은 글자 없이 영문·숫자·기호만 넣으세요.'));
    w.el('wh-auth').value = 'Authorization: Bearer x';
    w.el('wa-form').dispatch('submit');
    await settle();
    expect(errOf(w, 'wh-auth')).toBe(t(lang, '“Authorization:” 없이 값만 넣으세요.'));
    w.el('wh-auth').value = '  Bearer gw_0123456789abcdefWXYZ ';
    w.el('wa-form').dispatch('submit');
    await settle();
    expect(posts(w, '/api/agents/a1/webhooks')).toEqual([
      { url: 'https://hooks.example.com/auth', eventTypes: ['approval.resolved', 'approval.expired', 'message.sent', 'message.received'], authorization: 'Bearer gw_0123456789abcdefWXYZ' },
    ]);
    expect(w.el('wh-auth').value).toBe('');
    expect(rows(w, 'wh-body')[2]?.textContent).toContain('Bearer …WXYZ');
    expect(rows(w, 'wh-body')[2]?.textContent).not.toContain('gw_0123');
  });

  it('Ⓗ-2 ⋯ 메뉴: 설정(없을 때) · 교체(있을 때) → 대화상자 → POST …/authorization · 삭제(확인) → DELETE · 서버 invalid_authorization 은 칸 오류', async () => {
    const w = await boot(lang, WH);
    expect(() => menuPick(rows(w, 'wh-body')[0], t(lang, '인증 헤더 삭제'))).toThrow();
    menuPick(rows(w, 'wh-body')[0], t(lang, '인증 헤더 설정'));
    expect(w.el('dlg-whauth').open).toBe(true);
    expect(w.el('wz-title').textContent).toBe(t(lang, '인증 헤더 설정'));
    expect(w.el('wz-cur').hidden).toBe(true);
    w.el('wz-auth').value = '';
    w.el('wz-form').dispatch('submit');
    await settle();
    expect(posts(w, '/api/agents/a1/webhooks/w1/authorization')).toEqual([]);
    w.el('wz-auth').value = 'Bearer new_0123456789abcdefQRST';
    w.el('wz-form').dispatch('submit');
    await settle();
    expect(posts(w, '/api/agents/a1/webhooks/w1/authorization')).toEqual([{ authorization: 'Bearer new_0123456789abcdefQRST' }]);
    expect(w.el('dlg-whauth').open).toBe(false);
    expect(w.el('wz-auth').value).toBe('');
    expect(w.el('toasts').textContent).toContain(t(lang, '인증 헤더를 저장했습니다. 다음 전달부터 실립니다.'));
    expect(rows(w, 'wh-body')[0]?.textContent).toContain('Bearer …QRST');

    menuPick(rows(w, 'wh-body')[1], t(lang, '인증 헤더 교체'));
    expect(w.el('wz-cur').hidden).toBe(false);
    expect(w.el('wz-cur').textContent).toBe('Bearer …9f2c');
    OVERRIDE.set('POST /api/agents/a1/webhooks/w2/authorization', { status: 400, json: { error: 'invalid_authorization' } });
    w.el('wz-auth').value = 'Bearer ok';
    w.el('wz-form').dispatch('submit');
    await settle();
    expect(w.el('dlg-whauth').open).toBe(true);
    expect(errOf(w, 'wz-auth')).toBe(t(lang, '인증 헤더 값은 영문·숫자·기호 2048자까지이고, 줄바꿈이나 “Authorization:” 없이 값만 넣습니다.'));
    w.el('wz-cancel').dispatch('click');

    menuPick(rows(w, 'wh-body')[1], t(lang, '인증 헤더 삭제'));
    expect(w.el('dc-title').textContent).toBe(t(lang, '인증 헤더를 삭제할까요?'));
    w.el('dc-ok').onclick?.();
    await settle();
    expect(w.calls.some((c) => c.method === 'DELETE' && c.url === '/api/agents/a1/webhooks/w2/authorization')).toBe(true);
    expect(w.el('toasts').textContent).toContain(t(lang, '인증 헤더를 삭제했습니다.'));
    expect(rows(w, 'wh-body')[1]?.textContent).not.toContain('…9f2c');
  });
});

describe.each(LANGS)('Ⓡ 교체 · 삭제 (%s)', (lang) => {
  it('Ⓡ-1 비밀값 교체 — 확인(빨갛지 않다 · 24시간) → POST rotate → 같은 비밀값 창 + 이전 값 시각', async () => {
    const w = await boot(lang, WH);
    menuPick(rows(w, 'wh-body')[0], t(lang, '비밀값 교체'));
    expect(w.el('dlg-confirm').open).toBe(true);
    expect(w.el('dc-head').className).toBe('dh');
    expect(w.el('dc-ok').className).toBe('btn');
    expect(w.el('dc-ok').textContent).toBe(t(lang, '교체'));
    expect(w.el('dc-body').textContent).toContain(lang === 'ko' ? '24시간' : '24 hours');
    expect(w.el('dc-body').textContent).toContain('https://hooks.example.com/atmark/events');
    // 지난 교체의 유예가 이미 끝났다 — "바로 끊깁니다" 줄은 없다.
    expect(w.el('dc-body').textContent).not.toContain(lang === 'ko' ? '바로 끊깁니다' : 'stops working right away');
    w.el('dc-ok').onclick?.();
    await settle();
    expect(posts(w, '/api/agents/a1/webhooks/w1/rotate')).toHaveLength(1);
    expect(w.el('dlg-whsecret').open).toBe(true);
    expect(w.el('ws-secret').textContent).toBe(WEBHOOK_SECRET_ROTATED);
    expect(w.el('ws-kicker').textContent).toBe(t(lang, '비밀값 교체'));
    expect(w.el('ws-prev').hidden).toBe(false);
    expect(w.el('ws-prev').textContent).toBe(lang === 'ko' ? '2026.10.01 12:00 KST까지 통합니다' : 'Works until Oct 1, 2026, 12:00 KST');
    expect(rows(w, 'wh-body')[0]?.textContent).toContain('v3');
    w.el('ws-close').dispatch('click');
    expect(w.el('ws-secret').textContent).toBe('');
  });

  it('Ⓡ-1b 지난 교체의 이전 비밀값이 아직 통하면 — 다시 교체하면 그 값이 바로 끊긴다고 한 줄 더', async () => {
    OVERRIDE.set('GET /api/agents/a1/webhooks', {
      status: 200,
      json: {
        items: [{ id: 'w1', url: 'https://hooks.example.com/atmark/events', eventTypes: ['message.sent'], createdAt: '2026-09-24T02:00:00Z', status: 'active', secretVersion: 3, rotatedAt: '2026-09-30T02:00:00Z', previousValidUntil: '2999-01-01T00:00:00Z', lastDelivery: null }],
        limits: { active: 1, activeMax: 10, registrationsToday: 0, registrationsMax: 20 },
        availableEventTypes: ['message.sent'],
      },
    });
    const w = await boot(lang, WH);
    menuPick(rows(w, 'wh-body')[0], t(lang, '비밀값 교체'));
    expect(w.el('dc-body').textContent).toContain(lang === 'ko' ? '지난 교체 전의 비밀값(2999.01.01 09:00 KST까지)은 바로 끊깁니다.' : 'The secret from before the last rotation (valid until Jan 1, 2999, 09:00 KST) stops working right away.');
  });

  it('Ⓡ-2 삭제 — 빨간 확인(되돌릴 수 없음) · 취소면 요청 없음 · 확인하면 DELETE · 목록에서 빠지고 포커스는 제목', async () => {
    const w = await boot(lang, WH);
    menuPick(rows(w, 'wh-body')[1], t(lang, '삭제'));
    expect(w.el('dc-head').className).toBe('dh hatch');
    expect(w.el('dc-ok').className).toBe('btn danger solid');
    expect(w.el('dc-title').textContent).toBe(t(lang, '이 웹훅을 삭제할까요?'));
    expect(w.el('dc-body').textContent).toContain(t(lang, '삭제는 되돌릴 수 없습니다. 다시 받으려면 새로 추가하고 새 비밀값을 받아야 합니다.'));
    w.el('dc-cancel').onclick?.();
    await settle();
    expect(w.calls.some((c) => c.method === 'DELETE')).toBe(false);

    menuPick(rows(w, 'wh-body')[1], t(lang, '삭제'));
    w.el('dc-ok').onclick?.();
    await settle();
    expect(w.calls.some((c) => c.method === 'DELETE' && c.url === '/api/agents/a1/webhooks/w2')).toBe(true);
    expect(rows(w, 'wh-body')).toHaveLength(1);
    expect(w.el('toasts').textContent).toContain(t(lang, '웹훅을 삭제했습니다.'));
    expect(w.active()?.id).toBe('h-ag-wh');
  });
});

describe.each(LANGS)('Ⓓ 전달 기록 (%s)', (lang) => {
  it('Ⓓ-1 첫 쪽 넷 · 더 보기(커서) · 재시도가 끝난(dead) 행만 다시 보내기 · 상태 글자', async () => {
    const w = await boot(lang, WH);
    expect(rows(w, 'wd-body')).toHaveLength(4);
    expect(w.el('wd-more').hidden).toBe(false);
    w.el('wd-more').dispatch('click');
    await settle();
    expect(w.calls.filter((c) => c.url.startsWith('/api/agents/a1/webhooks/deliveries')).map((c) => c.url)).toEqual([
      '/api/agents/a1/webhooks/deliveries',
      '/api/agents/a1/webhooks/deliveries?cursor=4',
    ]);
    const all = rows(w, 'wd-body');
    expect(all).toHaveLength(6);
    expect(w.el('wd-more').hidden).toBe(true);
    // 서버는 dead 만 다시 보낸다(409 delivery_not_dead) — v5(dead)만 버튼, v4(failed = 재시도 예정)는 없다.
    expect(all.map((r) => buttons(r).map((b) => b.textContent))).toEqual([[], [t(lang, '다시 보내기')], [], [], [], []]);
    expect(all[1]?.textContent).toContain(t(lang, '재시도 끝남'));
    expect(all[2]?.textContent).toContain(t(lang, '실패'));
    expect(all[1]?.textContent).toContain('500');
    expect(all[4]?.textContent).toContain(t(lang, '대기 중'));
    expect(buttons(all[1])[0]?.getAttribute('aria-label')).toBe(lang === 'ko' ? 'message.bounced 다시 보내기' : 'Redeliver message.bounced');
  });

  it('Ⓓ-2 다시 보내기 — 확인 없이 POST · 누르는 동안 잠김 · 토스트 · 서버가 준 새 전달 행(대기 중)이 맨 위에 · 원래 행은 기록으로 남는다', async () => {
    const w = await boot(lang, WH, { latency: true });
    await settle();
    const b = buttons(rows(w, 'wd-body')[1])[0];
    b?.dispatch('click');
    expect(b?.disabled).toBe(true);
    expect(w.el('dlg-confirm').open).toBe(false);
    await settle();
    expect(posts(w, '/api/agents/a1/webhooks/deliveries/v5/redeliver')).toHaveLength(1);
    expect(w.el('toasts').textContent).toContain(t(lang, '다시 보내도록 요청했습니다.'));
    const list = rows(w, 'wd-body');
    expect(list).toHaveLength(5);
    expect(list[0]?.textContent).toContain('message.bounced');
    expect(list[0]?.textContent).toContain(t(lang, '대기 중'));
    expect(buttons(list[0])).toEqual([]);
    expect(list[2]?.textContent).toContain(t(lang, '재시도 끝남'));
    expect(w.active()?.id).toBe('h-wd');
  });

  it('Ⓓ-3 웹훅 필터 — 고르면 webhookId 로 처음부터 다시 읽는다', async () => {
    const w = await boot(lang, WH);
    const f = w.el('wd-f');
    // 첫 칸("모든 웹훅")은 마크업 — 가짜 DOM 은 스크립트가 붙인 것만 자식으로 본다.
    expect(f.children.map((o) => o.value)).toEqual(['w1', 'w2']);
    f.value = 'w2';
    f.dispatch('change');
    await settle();
    expect(w.calls.at(-1)?.url).toBe('/api/agents/a1/webhooks/deliveries?webhookId=w2');
    expect(rows(w, 'wd-body')).toHaveLength(2);
    expect(w.el('wd-more').hidden).toBe(true);
  });
});

describe.each(LANGS)('Ⓜ member 읽기 전용 (%s)', (lang) => {
  it('Ⓜ-1 추가 버튼 · 행 메뉴 · 다시 보내기가 없다 — 목록과 전달 기록은 보인다', async () => {
    OVERRIDE.set('/api/me', me('member'));
    const w = await boot(lang, WH);
    expect(rows(w, 'wh-body')).toHaveLength(2);
    expect(w.el('wh-add').hidden).toBe(true);
    expect(w.el('wh-add-empty').hidden).toBe(true);
    expect(rows(w, 'wh-body').flatMap(buttons)).toEqual([]);
    expect(rows(w, 'wd-body')).toHaveLength(4);
    expect(rows(w, 'wd-body').flatMap(buttons)).toEqual([]);
    w.el('wh-add').dispatch('click');
    expect(w.el('dlg-webhook').open).toBe(false);
  });
});

describe.each(LANGS)('Ⓣ 토큰 권한 webhooks:manage (%s)', (lang) => {
  it('Ⓣ-1 새 토큰 대화상자에 다섯째 권한 — 기본 꺼짐 · 한 줄 설명 · 켜면 capabilities 에 들어간다 · 행의 칩 이름', async () => {
    const html = inlined(renderAppPage(lang));
    expect(html).toMatch(/id="nt-cap-4" value="webhooks:manage"><span>/);
    expect(html).toContain(`${t(lang, '웹훅 관리')} <code>webhooks:manage</code><small class="caphint">${t(lang, '에이전트가 자기 웹훅을 추가·삭제하고 비밀값을 교체할 수 있습니다.')}</small>`);
    const w = await boot(lang, '#/agents/a1/tokens');
    w.el('tk-new').dispatch('click');
    expect([0, 1, 2, 3, 4].map((i) => w.el(`nt-cap-${String(i)}`).checked)).toEqual([true, true, true, true, false]);
    w.el('nt-label').value = 'hooks';
    w.el('nt-cap-4').checked = true;
    w.el('nt-form').dispatch('submit');
    await settle();
    expect(posts(w, '/api/agents/a1/tokens')).toEqual([{ label: 'hooks', capabilities: ['messages:send', 'messages:read', 'audit:read', 'agent:read_self', 'webhooks:manage', 'policy:request'] }]);
    // 다시 열면 기본값으로 돌아간다.
    w.el('tk-new').dispatch('click');
    expect(w.el('nt-cap-4').checked).toBe(false);
  });
});

describe.each(LANGS)('Ⓚ 마크업 (%s)', (lang) => {
  it('Ⓚ-1 대화상자 둘은 anyDialog 가 안다 · 라우트가 바뀌면 추가 대화상자는 닫히고 비밀값 창은 닫히지 않는다 · 추가 버튼은 대화상자를 연다고 알린다', () => {
    const html = inlined(renderAppPage(lang));
    expect(html).toMatch(/<dialog id="dlg-webhook" aria-labelledby="wa-title"><form id="wa-form" novalidate>/);
    const dlgs = /var DLGS=\[([^\]]*)\]/.exec(html)?.[1] ?? '';
    for (const id of ['dlg-webhook', 'dlg-whsecret']) expect(dlgs).toContain(`'${id}'`);
    const route = /var ROUTE_DLGS=\[([^\]]*)\]/.exec(html)?.[1] ?? '';
    expect(route).toContain("'dlg-webhook'");
    expect(route).not.toContain("'dlg-whsecret'");
    for (const id of ['wh-add', 'wh-add-empty']) expect(html).toMatch(new RegExp(`id="${id}" aria-haspopup="dialog"`));
    expect(html).toContain(t(lang, '이벤트 본문에는 ID와 시각만 담깁니다. 메일 주소·제목·본문은 담기지 않습니다.'));
    expect(html).toContain(t(lang, '이 비밀값은 다시 볼 수 없습니다.'));
  });

  it('Ⓚ-2 비밀값 창은 라우트가 바뀌는 사이에 응답이 와도 뜬다(다시 볼 수 없는 값)', async () => {
    const w = await boot(lang, WH, { latency: true });
    await settle();
    menuPick(rows(w, 'wh-body')[0], t(lang, '비밀값 교체'));
    w.el('dc-ok').onclick?.();
    await w.go('#/agents/a1/tokens');
    await settle();
    expect(w.el('dlg-whsecret').open).toBe(true);
    expect(w.el('ws-secret').textContent).toBe(WEBHOOK_SECRET_ROTATED);
  });
});
