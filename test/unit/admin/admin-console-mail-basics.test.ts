/**
 * 콘솔(가짜 DOM) — 메일 기본기 1차 로그 화면(W1): **예약 탭**(AC-A3-7 — 취소 사유·경로가 보인다, ko/en 1:1)과 **수신 필터**(AC-A5-5 —
 * 보낸 사람·기간이 API 쿼리가 되고, 수신 탭에서만 보인다). 2회차 Y2: 예약 행의 **취소 버튼**(owner·admin · `scheduled` 행만) → 사유 필수
 * 대화상자 → `POST /api/scheduled/{id}/cancel`.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { boot, inlined, me, OVERRIDE, settle, type FakeNode } from './console-harness';
import { MESSAGES } from '../../../src/admin/ui/i18n';
import { renderAppPage } from '../../../src/admin/ui/index';

afterEach(() => OVERRIDE.clear());

const SCHEDULED = {
  id: 's-1',
  at: '2026-10-01T00:00:00.000Z',
  agentId: 'a1',
  agentName: 'Support bot',
  from: 'bot@atmark.ai',
  recipients: ['a@example.com', 'b@example.com'],
  recipientCount: 2,
  status: 'cancelled',
  sendAt: '2026-10-01T00:00:00.000Z',
  createdAt: '2026-09-26T00:00:00.000Z',
  dispatchedAt: null,
  dispatchOutcome: null,
  messageId: null,
  cancelledAt: '2026-09-26T01:00:00.000Z',
  cancelReason: 'wrong_recipient',
  cancelledVia: 'mcp',
  cancelNote: 'note from agent',
  agentCancellable: true,
};

const PENDING = { ...SCHEDULED, id: 's-2', status: 'scheduled', cancelledAt: null, cancelReason: null, cancelledVia: null, cancelNote: null, agentCancellable: false };

/** 행의 버튼들(마지막 칸 td.act). */
function rowButtons(row: FakeNode | undefined): FakeNode[] {
  return (row?.all() ?? []).filter((node) => node.tagName === 'BUTTON');
}

const T = (lang: 'ko' | 'en', ko: string): string => (lang === 'ko' ? ko : (MESSAGES.en[ko] ?? `<missing:${ko}>`));

describe.each(['ko', 'en'] as const)('로그 — 예약 탭 · 수신 필터 (%s)', (lang) => {
  it('★ AC-A3-7 예약 탭 — 취소 경로(MCP)·사유가 목록과 상세에 보인다 · 상태 필터에 취소가 있다', async () => {
    OVERRIDE.set('/api/logs?type=scheduled&limit=50', { status: 200, json: { items: [SCHEDULED], next: null } });
    OVERRIDE.set('/api/logs/scheduled/s-1', { status: 200, json: { ...SCHEDULED, tlogEntryId: null, tlogPending: false } });
    const w = await boot(lang, '#/logs/scheduled');
    expect(w.calls.some((c) => c.url === '/api/logs?type=scheduled&limit=50')).toBe(true);
    expect(w.el('lt-scheduled').getAttribute('aria-current')).toBe('page');
    const row = w.el('lg-body').children[0];
    const cells = row?.children.map((cell) => cell.textContent) ?? [];
    expect(cells[3]).toBe(T(lang, '취소됨'));
    expect(cells[4]).toBe(T(lang, 'MCP(에이전트)'));
    expect(cells[5]).toBe(T(lang, '받는 사람 잘못'));
    // 상태 필터 — 예약 · 발송 · 취소.
    expect(w.el('ld-wrap').hidden).toBe(false);
    expect(w.el('lf-dec').children.map((option) => option.value)).toEqual(['', 'scheduled', 'dispatched', 'cancelled']);
    // 수신 필터는 예약 탭에 없다.
    expect(w.el('lff-wrap').hidden).toBe(true);

    await w.go('#/logs/scheduled/s-1');
    expect(w.el('dlg-log').open).toBe(true);
    expect(w.el('dl-title').textContent).toBe(T(lang, '취소된 예약'));
    const extra = w.el('dl-extra').textContent;
    expect(extra).toContain(T(lang, 'MCP(에이전트)'));
    expect(extra).toContain('wrong_recipient');
    expect(extra).toContain('note from agent');
    expect(extra).toContain(T(lang, '에이전트가 MCP 도구로 취소했습니다. 받은 메일의 지시로 취소한 것이 아닌지 확인하세요.'));

    w.el('lf-dec').value = 'cancelled';
    w.el('lf-dec').dispatch('change');
    expect(w.calls.some((c) => c.url === '/api/logs?type=scheduled&limit=50&decision=cancelled')).toBe(true);
  });

  it('★ AC-A5-5 수신 필터 — 보낸 사람·시작일·종료일(KST, 끝 날짜 포함)이 쿼리가 된다 · 수신 탭에서만 보인다', async () => {
    const w = await boot(lang, '#/logs/inbound');
    for (const id of ['lff-wrap', 'lfs-wrap', 'lfu-wrap']) expect(w.el(id).hidden, id).toBe(false);
    w.el('lf-from').value = ' Alice@X.example ';
    w.el('lf-from').dispatch('change');
    expect(w.calls.some((c) => c.url === `/api/logs?type=inbound&limit=50&from=${encodeURIComponent('alice@x.example')}`)).toBe(true);
    w.el('lf-since').value = '2026-09-23';
    w.el('lf-since').dispatch('change');
    w.el('lf-until').value = '2026-09-24';
    w.el('lf-until').dispatch('change');
    // 앱은 동시 요청 수를 묶는다 — 앞의 요청이 끝나야 마지막 요청이 나간다.
    await settle();
    const since = encodeURIComponent('2026-09-22T15:00:00.000Z');
    const until = encodeURIComponent('2026-09-24T15:00:00.000Z');
    expect(w.calls.map((c) => c.url)).toContain(`/api/logs?type=inbound&limit=50&from=${encodeURIComponent('alice@x.example')}&since=${since}&until=${until}`);

    await w.go('#/logs/outbound');
    for (const id of ['lff-wrap', 'lfs-wrap', 'lfu-wrap']) expect(w.el(id).hidden, id).toBe(true);
    expect(w.calls.at(-1)?.url).not.toContain('from=');
  });

  it('두 언어 페이지 모두 탭·필터 라벨이 있다(영어 페이지에 한글 없음은 admin-ui가 본다)', () => {
    const html = inlined(renderAppPage(lang));
    expect(html).toContain(`id="lt-scheduled">${T(lang, '예약')}</a>`);
    for (const label of ['보낸 사람', '시작일', '종료일']) expect(html).toContain(`<span class="lbl">${T(lang, label)}</span>`);
  });

  it('★ Y2 예약 취소 — scheduled 행에만 버튼 · 사유 없이는 안 보냄 · 사유·메모로 POST · 끝나면 목록을 다시 읽는다', async () => {
    OVERRIDE.set('/api/logs?type=scheduled&limit=50', [
      { status: 200, json: { items: [PENDING, SCHEDULED], next: null } },
      { status: 200, json: { items: [{ ...PENDING, status: 'cancelled', cancelledVia: 'console', cancelReason: 'owner_request' }, SCHEDULED], next: null } },
    ]);
    OVERRIDE.set('POST /api/scheduled/s-2/cancel', { status: 200, json: { id: 's-2', status: 'cancelled', cancelReason: 'owner_request', cancelledVia: 'console', replayed: false } });
    const w = await boot(lang, '#/logs/scheduled');
    const rows = w.el('lg-body').children;
    const buttons = rowButtons(rows[0]);
    expect(buttons.map((b) => b.textContent)).toEqual([T(lang, '취소')]);
    // 취소된 행에는 버튼이 없다.
    expect(rowButtons(rows[1])).toEqual([]);
    buttons[0]?.click();
    expect(w.el('dlg-sched-cancel').open).toBe(true);
    // 버튼 클릭이 행의 상세 열기로 번지지 않는다.
    expect(w.el('dlg-log').open).toBe(false);

    w.el('sc-form').dispatch('submit');
    expect(w.el('sc-msg').textContent).toBe(T(lang, '취소 사유를 고르세요.'));
    expect(w.calls.some((c) => c.method === 'POST')).toBe(false);

    w.el('sc-reason').value = 'owner_request';
    w.el('sc-note').value = ' 다시 잡을 것 ';
    w.el('sc-form').dispatch('submit');
    await settle();
    const post = w.calls.find((c) => c.method === 'POST' && c.url === '/api/scheduled/s-2/cancel');
    expect(post?.body).toEqual({ reasonCode: 'owner_request', note: '다시 잡을 것' });
    expect(post?.csrf).toBeTruthy();
    expect(w.el('dlg-sched-cancel').open).toBe(false);
    expect(w.el('lg-msg').textContent).toBe(T(lang, '예약을 취소했습니다.'));
    // 다시 읽은 목록 — 경로 콘솔, 버튼 없음.
    const again = w.el('lg-body').children;
    expect(again[0]?.children.map((cell) => cell.textContent)[4]).toBe(T(lang, '콘솔'));
    expect(rowButtons(again[0])).toEqual([]);
  });

  it('Y2 예약 취소 — 409(이미 발송)는 대화상자 안에 사람 말로 · member 에게는 버튼이 없다', async () => {
    OVERRIDE.set('/api/logs?type=scheduled&limit=50', { status: 200, json: { items: [PENDING], next: null } });
    OVERRIDE.set('POST /api/scheduled/s-2/cancel', { status: 409, json: { error: 'schedule_already_dispatched', detail: 'x' } });
    const w = await boot(lang, '#/logs/scheduled');
    rowButtons(w.el('lg-body').children[0])[0]?.click();
    w.el('sc-reason').value = 'duplicate';
    w.el('sc-form').dispatch('submit');
    await settle();
    expect(w.el('dlg-sched-cancel').open).toBe(true);
    expect(w.el('sc-msg').textContent).toBe(T(lang, '이미 발송된 예약입니다. 나간 메일은 거둘 수 없습니다.'));

    OVERRIDE.clear();
    OVERRIDE.set('/api/me', me('member'));
    OVERRIDE.set('/api/logs?type=scheduled&limit=50', { status: 200, json: { items: [PENDING], next: null } });
    const m = await boot(lang, '#/logs/scheduled');
    expect(m.el('lg-body').children).toHaveLength(1);
    expect(rowButtons(m.el('lg-body').children[0])).toEqual([]);
  });

  it('Y2 취소 대화상자 — 사유 목록은 DB 사유 코드 일곱 개 · 두 언어 마크업', () => {
    const html = inlined(renderAppPage(lang));
    const select = /<select id="sc-reason">([\s\S]*?)<\/select>/.exec(html)?.[1] ?? '';
    expect([...select.matchAll(/value="([a-z_]*)"/g)].map((m) => m[1]).sort()).toEqual(
      ['', 'duplicate', 'no_longer_needed', 'other', 'owner_request', 'wrong_content', 'wrong_recipient', 'wrong_time'],
    );
    expect(html).toContain(`<h3 id="sc-title">${T(lang, '이 예약 발송을 취소할까요?')}</h3>`);
  });
});
