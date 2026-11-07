/**
 * 콘솔(가짜 DOM) — 만들고 바꾸는 흐름은 전부 라이트박스(2026-09-30 진윤겸: 펼치는 패널·인라인 폼 대신 네이티브 `<dialog>`).
 *   Ⓐ 새 에이전트 `dlg-newagent`: 목록 머리 · 빈 상태 · 개요 · 스위처 네 입구가 같은 창 · 첫 칸에 포커스 · Esc 는 닫고 누른 버튼으로 ·
 *     만들면 닫히고 토큰 창이 이어서 뜬다 · 요금제 한도를 넘으면 창 대신 이유 한 줄 · 보내는 중에는 Esc 가 닫지 않는다.
 *   Ⓛ 분당 한도 `dlg-limit`: `변경` → 지금 값으로 채운 창 · 모양 오류는 칸 아래 · 같은 값이면 한 줄 · 저장하면 PATCH 뒤 닫힌다 ·
 *     라우트가 바뀌면 닫힌다.
 *   Ⓖ 인계 시험(설정): 개입 기록 `dlg-iv` · 인계 시험 시작 `dlg-gstart` — 같은 칸·ⓘ·경고 · 제출하면 확인 대화상자(위에 겹쳐)를 거쳐
 *     기록하고, 끝나면 창이 닫히고 결과는 페이지의 버튼 옆에.
 *   Ⓜ 마크업: 펼치는 패널·인라인 폼이 없다 · 새 창은 모두 `<dialog aria-labelledby><form novalidate>` · 입구 버튼은
 *     `aria-haspopup="dialog"` · Esc 순서(anyDialog)와 라우트 닫기 목록이 새 창을 안다.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { renderAppPage } from '../../../src/admin/ui/index';

import { AGENT, boot, inlined, me, OVERRIDE, PLAN, PLAN_BRIEF, resetTeam, settle, t, TOKEN } from './console-harness';

afterEach(() => {
  OVERRIDE.clear();
  resetTeam();
});

const LANGS = ['ko', 'en'] as const;

describe.each(LANGS)('Ⓐ 새 에이전트 (%s)', (lang) => {
  it('Ⓐ-1 목록 머리 · 개요의 버튼 — 대화상자 · 이름 칸에 포커스 · Esc 는 닫고 그 버튼으로 돌려준다', async () => {
    const w = await boot(lang, '#/agents');
    const na = w.el('na-open');
    na.focus();
    na.dispatch('click');
    expect(w.el('dlg-newagent').open).toBe(true);
    expect(w.active()).toBe(w.el('na-name'));
    w.el('dlg-newagent').esc();
    expect(w.el('dlg-newagent').open).toBe(false);
    expect(w.active()).toBe(na);

    await w.go('#/overview');
    const ov = w.el('ov-new');
    ov.focus();
    ov.dispatch('click');
    expect(w.location.hash).toBe('#/overview');
    expect(w.el('dlg-newagent').open).toBe(true);
    // 다시 열면 칸이 비어 있다.
    expect(w.el('na-name').value).toBe('');
    w.el('na-cancel').dispatch('click');
    expect(w.el('dlg-newagent').open).toBe(false);
    expect(w.active()).toBe(ov);
  });

  it('Ⓐ-2 만들기 — 칸 오류는 칸 아래(요청 없음) · 성공하면 창이 닫히고 토큰 창 → 연결 화면', async () => {
    const made = { ...AGENT, id: 'a9', name: 'desk-agent', address: 'desk@atmark.ai' };
    OVERRIDE.set('POST /api/agents', { status: 201, json: { agent: made, token: TOKEN } });
    const w = await boot(lang, '#/agents');
    w.el('na-open').dispatch('click');
    w.el('na-name').value = 'desk-agent';
    w.el('na-local').value = 'desk@atmark.ai';
    w.el('na-form').dispatch('submit');
    await settle();
    expect(w.el('na-local').getAttribute('aria-invalid')).toBe('true');
    expect(w.calls.some((c) => c.method === 'POST' && c.url === '/api/agents')).toBe(false);
    expect(w.el('dlg-newagent').open).toBe(true);

    w.el('na-local').value = ' Desk ';
    w.el('na-form').dispatch('submit');
    await settle();
    expect(w.calls.find((c) => c.method === 'POST' && c.url === '/api/agents')?.body).toEqual({ name: 'desk-agent', localPart: 'desk' });
    expect(w.el('dlg-newagent').open).toBe(false);
    expect(w.el('dlg-token').open).toBe(true);
    expect(w.el('dt-token').textContent).toBe(TOKEN);
    expect(w.location.hash).toBe('#/agents/a9/connect');
  });

  it('Ⓐ-3 빈 목록 — 창을 저절로 열지 않고 빈 상태의 버튼이 연다 · 스위처의 새 에이전트는 메뉴를 닫고 같은 창(Esc 는 스위처 버튼으로)', async () => {
    OVERRIDE.set('/api/agents', { status: 200, json: [] });
    const e = await boot(lang, '#/agents');
    expect(e.el('dlg-newagent').open).toBe(false);
    expect(e.el('agents-empty').hidden).toBe(false);
    e.el('na-cta').dispatch('click');
    expect(e.el('dlg-newagent').open).toBe(true);
    expect(e.active()).toBe(e.el('na-name'));
    OVERRIDE.clear();

    const w = await boot(lang, '#/agents/a1/tokens');
    w.el('sw-ag').dispatch('click');
    expect(w.el('sw-ag-menu').hidden).toBe(false);
    w.el('swa-new').dispatch('click');
    expect(w.el('sw-ag-menu').hidden).toBe(true);
    expect(w.el('dlg-newagent').open).toBe(true);
    expect(w.location.hash).toBe('#/agents/a1/tokens');
    w.el('dlg-newagent').esc();
    expect(w.active()).toBe(w.el('sw-ag'));
  });

  it('Ⓐ-4 요금제 한도 초과 — 입구 버튼이 잠겨(aria-disabled + 이유) 창 대신 맨 위 한 줄', async () => {
    const two = [AGENT, { ...AGENT, id: 'a2', name: 'research-bot', address: 'research@atmark.ai' }];
    OVERRIDE.set('/api/agents', { status: 200, json: two });
    OVERRIDE.set('/api/me', me('owner', { plan: { ...PLAN_BRIEF, maxAgents: 1 } }));
    OVERRIDE.set('/api/plan', { status: 200, json: { ...PLAN, limits: { ...PLAN.limits, maxAgents: 1 } } });
    const w = await boot(lang, '#/agents');
    expect(w.el('na-open').getAttribute('aria-disabled')).toBe('true');
    expect(w.el('na-open').getAttribute('aria-describedby')).toBe('ag-over'); // 옆의 '한도 초과' 알약(F27)
    expect(w.el('na-open').title).toBe(t(lang, '요금제의 에이전트 한도를 넘어 새로 만들 수 없습니다.'));
    const why = t(lang, '요금제 한도를 넘었습니다. 설정의 요금제에서 올릴 수 있습니다.');
    for (const id of ['na-open', 'ov-new', 'swa-new']) {
      w.el('banner').textContent = '';
      w.el(id).dispatch('click');
      expect(w.el('dlg-newagent').open, id).toBe(false);
      expect(w.el('banner').textContent, id).toBe(why);
    }
  });

  it('Ⓐ-5 보내는 중에는 Esc · 취소가 닫지 않는다', async () => {
    OVERRIDE.set('POST /api/agents', { status: 201, json: { agent: { ...AGENT, id: 'a9' }, token: TOKEN } });
    const w = await boot(lang, '#/agents', { latency: true });
    await settle();
    w.el('na-open').dispatch('click');
    w.el('na-name').value = 'desk-agent';
    w.el('na-local').value = 'desk';
    w.el('na-form').dispatch('submit');
    expect(w.el('na-go').classList.contains('busy')).toBe(true);
    w.el('dlg-newagent').esc();
    w.el('na-cancel').dispatch('click');
    expect(w.el('dlg-newagent').open).toBe(true);
    await settle();
    expect(w.el('dlg-newagent').open).toBe(false);
  });
});

describe.each(LANGS)('Ⓛ 분당 한도 (%s)', (lang) => {
  it('Ⓛ-1 변경 → 지금 값으로 채운 창 · 모양 오류는 칸 아래 · 같은 값은 한 줄 · 저장하면 PATCH 뒤 닫히고 결과는 한도 절에', async () => {
    const w = await boot(lang, '#/agents/a1/email');
    w.el('ol-edit').dispatch('click');
    expect(w.el('dlg-limit').open).toBe(true);
    const inp = w.el('ol-rate');
    expect(inp.value).toBe('10');
    w.el('ol-form').dispatch('submit');
    await settle();
    expect(w.el('lm-msg').textContent).toBe(t(lang, '바뀐 것이 없습니다.'));

    inp.value = '0';
    w.el('ol-form').dispatch('submit');
    await settle();
    expect(inp.getAttribute('aria-invalid')).toBe('true');
    expect(w.calls.some((c) => c.method === 'PATCH')).toBe(false);

    inp.value = '20';
    w.el('ol-form').dispatch('submit');
    await settle();
    expect(w.calls.find((c) => c.method === 'PATCH')?.body).toEqual({ limits: { perMinute: 20 } });
    expect(w.el('dlg-limit').open).toBe(false);
    expect(w.el('ol-msg').textContent).toBe(t(lang, '저장했습니다.'));
  });

  it('Ⓛ-2 라우트가 바뀌면 닫힌다 · member 에게는 잠겨 열리지 않는다', async () => {
    const w = await boot(lang, '#/agents/a1/email');
    w.el('ol-edit').dispatch('click');
    expect(w.el('dlg-limit').open).toBe(true);
    await w.go('#/agents/a1/tokens');
    expect(w.el('dlg-limit').open).toBe(false);

    OVERRIDE.set('/api/me', me('member'));
    const m = await boot(lang, '#/agents/a1/email');
    expect(m.el('ol-edit').disabled).toBe(true);
    m.el('ol-edit').dispatch('click');
    expect(m.el('dlg-limit').open).toBe(false);
  });
});

const GATE_ID = '11111111-1111-1111-1111-111111111111';
function gateReport(verdict: Record<string, unknown>): { status: number; json: unknown } {
  const gate = { id: GATE_ID, organizationId: 'o1', agentId: 'a1', humanMailboxes: ['founder@example.com'], createdAt: '2026-09-30T00:00:00Z' };
  return { status: 200, json: { gates: [gate], report: { gateId: GATE_ID, gate, verdict, exitCode: verdict['exitCode'] }, ambiguous: false } };
}

describe.each(LANGS)('Ⓖ 인계 시험 (%s)', (lang) => {
  it('Ⓖ-1 개입 기록 — 버튼 → 창(카테고리에 포커스) · Esc 는 버튼으로 · 빈 사유는 칸 아래 · 확인 대화상자를 거쳐 기록 → 창이 닫히고 버튼 옆 한 줄', async () => {
    OVERRIDE.set('/api/gate?agent=a1', gateReport({ status: 'observing', exitCode: 3, phase: 'observation', next: [] }));
    const w = await boot(lang, '#/settings/gate');
    const open = w.el('iv-open');
    expect(open.disabled).toBe(false);
    open.focus();
    open.dispatch('click');
    expect(w.el('dlg-iv').open).toBe(true);
    expect(w.active()).toBe(w.el('iv-cat'));
    w.el('dlg-iv').esc();
    expect(w.el('dlg-iv').open).toBe(false);
    expect(w.active()).toBe(open);

    open.dispatch('click');
    w.el('iv-form').dispatch('submit');
    expect(w.el('iv-reason').getAttribute('aria-invalid')).toBe('true');
    expect(w.el('dlg-confirm').open).toBe(false);

    w.el('iv-reason').value = 'Gmail에서 영수증 메일을 읽었다';
    w.el('iv-form').dispatch('submit');
    // 확인 대화상자가 위에 겹친다 — 취소하면 입력은 그대로 창에 남는다.
    expect(w.el('dlg-confirm').open).toBe(true);
    expect(w.el('dlg-iv').open).toBe(true);
    w.el('dc-cancel').onclick?.();
    await settle();
    expect(w.el('dlg-iv').open).toBe(true);
    expect(w.calls.some((c) => c.url === '/api/gate/intervention')).toBe(false);

    w.el('iv-form').dispatch('submit');
    w.el('dc-ok').onclick?.();
    await settle();
    expect(w.calls.find((c) => c.method === 'POST' && c.url === '/api/gate/intervention')?.body).toEqual({ gateId: GATE_ID, category: 'address_transition', reason: 'Gmail에서 영수증 메일을 읽었다' });
    expect(w.el('dlg-iv').open).toBe(false);
    expect(w.el('iv-msg').textContent).toBe(t(lang, '기록했습니다.'));
  });

  it('Ⓖ-2 인계 시험 시작 — 버튼 → 창(메일함에 포커스) · 빈 메일함은 칸 아래 · 확인란을 거쳐 POST → 창이 닫히고 버튼 옆 한 줄', async () => {
    const w = await boot(lang, '#/settings/gate');
    const open = w.el('gs-open');
    expect(open.disabled).toBe(false);
    open.focus();
    open.dispatch('click');
    expect(w.el('dlg-gstart').open).toBe(true);
    expect(w.active()).toBe(w.el('gs-mbx'));
    w.el('gs-form').dispatch('submit');
    expect(w.el('gs-mbx').getAttribute('aria-invalid')).toBe('true');

    w.el('gs-mbx').value = 'founder@gmail.com, me@company.example';
    w.el('gs-form').dispatch('submit');
    expect(w.el('dlg-confirm').open).toBe(true);
    expect(w.el('dc-ok').disabled).toBe(true);
    w.el('dc-ack').checked = true;
    w.el('dc-ack').onchange?.();
    w.el('dc-ok').onclick?.();
    await settle();
    expect(w.calls.find((c) => c.method === 'POST' && c.url === '/api/gate/start')?.body).toEqual({ agentId: 'a1', humanMailboxes: ['founder@gmail.com', 'me@company.example'] });
    expect(w.el('dlg-gstart').open).toBe(false);
    expect(w.active()).toBe(open);
    expect(w.el('gs-msg').textContent.startsWith(t(lang, '인계 시험을 열었습니다. 1일차 '))).toBe(true);
  });
});

describe.each(LANGS)('Ⓜ 마크업 (%s)', (lang) => {
  const NEW = ['dlg-newagent', 'dlg-limit', 'dlg-iv', 'dlg-gstart'];
  it('Ⓜ-1 펼치는 패널 · 인라인 폼이 없다 · 새 창은 모두 같은 모양 · 입구는 aria-haspopup="dialog" · Esc 순서와 라우트 닫기 목록이 안다', () => {
    const html = inlined(renderAppPage(lang));
    for (const gone of ['id="na-panel"', 'class="inline-edit"', 'class="create"', 'aria-controls="ol-form"', 'aria-controls="na-panel"']) expect(html).not.toContain(gone);
    for (const id of NEW) {
      const m = new RegExp(`<dialog id="${id}" aria-labelledby="([a-z-]+)"><form id="[a-z-]+" novalidate>`).exec(html);
      expect(m, id).not.toBeNull();
      expect(html).toContain(`id="${m?.[1] ?? ''}"`);
    }
    // 바닥 줄: 취소(ghost) + 주 동작(submit) — 빨간 버튼은 없다(되돌릴 수 없는 기록은 뒤따르는 확인 대화상자가 말한다).
    for (const [cancel, go] of [['na-cancel', 'na-go'], ['ol-cancel', 'ol-go'], ['di-cancel', 'iv-go'], ['dg-cancel', 'gs-go']] as const) {
      expect(html).toContain(`<div class="df"><button type="button" class="btn ghost" id="${cancel}">`);
      expect(html).toMatch(new RegExp(`<button type="submit" class="btn" id="${go}">`));
    }
    for (const id of ['na-open', 'na-cta', 'ov-new', 'swa-new', 'ol-edit', 'iv-open', 'gs-open']) expect(html).toMatch(new RegExp(`id="${id}" aria-haspopup="dialog"`));
    const dlgs = /var DLGS=\[([^\]]*)\]/.exec(html)?.[1] ?? '';
    const route = /var ROUTE_DLGS=\[([^\]]*)\]/.exec(html)?.[1] ?? '';
    for (const id of NEW) {
      expect(dlgs).toContain(`'${id}'`);
      expect(route).toContain(`'${id}'`);
    }
  });
});
