/**
 * 콘솔(가짜 DOM) — 더하기는 버튼 → 대화상자, 지우기는 확인 대화상자(2026-09-29 진윤겸 피드백 4: 주소 탭의 별칭 흐름을 콘솔 전체에).
 *   Ⓢ 수신 › 신뢰 표시: 접힌 인라인 폼 대신 `표시 추가` → `dlg-sender`(칸 오류는 입력 아래 · 도메인 seen 은 확인란) · 행의 seen 표시 ·
 *     표시 해제도 확인 대화상자를 거친다(에이전트가 보는 sender_trust 가 바뀐다).
 *   Ⓛ 허용·차단 목록: 행 삭제는 확인 대화상자(되돌릴 수 있어 빨갛지 않다) · 삭제 버튼 이름에 값 · 지운 뒤 포커스는 그 목록의 추가 버튼.
 *   Ⓜ 마크업: 인라인 입력 폼(`addrow` · 접힌 `more-d`)이 없다 · 새 대화상자는 Esc 로 닫히는 네이티브 `<dialog>` 이고 anyDialog 가 안다.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { renderAppPage } from '../../../src/admin/ui/index';

import { AGENT, boot, type FakeNode, inlined, me, OVERRIDE, PLAN, POLICY, resetTeam, settle, t } from './console-harness';

afterEach(() => {
  OVERRIDE.clear();
  resetTeam();
});

const LANGS = ['ko', 'en'] as const;
const buttons = (row: FakeNode | undefined): FakeNode[] => (row?.all() ?? []).filter((n) => n.tagName === 'BUTTON');
const SENDERS = [
  { address: 'noreply@service.example', mark: 'seen', scope: 'address', markedAt: '2026-09-25T01:00:00Z' },
  { address: 'billing@vendor.example', mark: 'cleared', scope: 'address', markedAt: '2026-09-24T01:00:00Z' },
];

describe.each(LANGS)('Ⓢ 신뢰 표시 (%s)', (lang) => {
  it('Ⓢ-1 표시 추가 — 버튼 → 대화상자 · 입력에 포커스 · 모양 오류는 칸 아래 · 성공하면 POST 뒤 닫힌다', async () => {
    const w = await boot(lang, '#/agents/a1/email/inbound');
    expect(w.el('dlg-sender').open).toBe(false);
    w.el('sn-add').dispatch('click');
    expect(w.el('dlg-sender').open).toBe(true);
    expect(w.active()).toBe(w.el('sn-addr'));
    expect(w.el('sn-confirm-wrap').hidden).toBe(true);

    w.el('sn-addr').value = 'no-at-sign';
    w.el('sn-form').dispatch('submit');
    await settle();
    expect(w.el('sn-addr').getAttribute('aria-invalid')).toBe('true');
    expect(w.calls.some((c) => c.method === 'POST' && c.url === '/api/senders')).toBe(false);

    w.el('sn-addr').value = ' Alerts@Service.Example ';
    w.el('sn-form').dispatch('submit');
    await settle();
    expect(w.calls.find((c) => c.method === 'POST' && c.url === '/api/senders')?.body).toEqual({ agentId: 'a1', address: 'alerts@service.example', mark: 'seen', scope: 'address' });
    expect(w.el('dlg-sender').open).toBe(false);
  });

  it('Ⓢ-2 도메인 seen 은 확인란이 있어야 보낸다 — 없으면 대화상자 안 한 줄 · 다시 열면 주소 범위로 돌아간다', async () => {
    const w = await boot(lang, '#/agents/a1/email/inbound');
    w.el('sn-add').dispatch('click');
    w.el('sn-scope').value = 'domain';
    w.el('sn-scope').dispatch('change');
    expect(w.el('sn-confirm-wrap').hidden).toBe(false);
    w.el('sn-addr').value = 'service.example';
    w.el('sn-form').dispatch('submit');
    await settle();
    expect(w.el('sn-msg').textContent).toBe(t(lang, '도메인 스코프는 확인란을 체크해야 합니다.'));
    expect(w.calls.some((c) => c.method === 'POST' && c.url === '/api/senders')).toBe(false);
    w.el('sn-confirm').checked = true;
    w.el('sn-form').dispatch('submit');
    await settle();
    expect(w.calls.find((c) => c.method === 'POST' && c.url === '/api/senders')?.body).toEqual({ agentId: 'a1', address: 'service.example', mark: 'seen', scope: 'domain', confirmDomain: true });
    expect(w.el('dlg-sender').open).toBe(false);

    w.el('sn-add').dispatch('click');
    expect(w.el('sn-scope').value).toBe('address');
    expect(w.el('sn-confirm-wrap').hidden).toBe(true);
    expect(w.el('sn-addr').value).toBe('');
    w.el('sn-cancel').dispatch('click');
    expect(w.el('dlg-sender').open).toBe(false);
  });

  it('Ⓢ-3 행의 표시 해제 · seen 표시는 확인 대화상자 — 취소면 요청 없음 · 확인하면 POST(빨갛지 않다)', async () => {
    OVERRIDE.set('GET /api/senders?agent=a1', { status: 200, json: SENDERS });
    const w = await boot(lang, '#/agents/a1/email/inbound');
    const rows = w.el('sn-body').children;
    expect(rows).toHaveLength(2);
    buttons(rows[0])[0]?.click();
    expect(w.el('dlg-confirm').open).toBe(true);
    expect(w.el('dc-title').textContent).toBe(t(lang, '이 발신자의 표시를 해제할까요?'));
    expect(w.el('dc-ok').textContent).toBe(t(lang, '표시 해제'));
    expect(w.el('dc-ok').className).toBe('btn');
    expect(w.el('dc-body').textContent).toContain('noreply@service.example');
    w.el('dc-cancel').onclick?.();
    await settle();
    expect(w.calls.some((c) => c.method === 'POST' && c.url === '/api/senders')).toBe(false);

    buttons(w.el('sn-body').children[1])[0]?.click();
    expect(w.el('dc-title').textContent).toBe(t(lang, '이 발신자를 seen으로 표시할까요?'));
    w.el('dc-ok').onclick?.();
    await settle();
    expect(w.calls.find((c) => c.method === 'POST' && c.url === '/api/senders')?.body).toEqual({ agentId: 'a1', address: 'billing@vendor.example', mark: 'seen', scope: 'address' });
    expect(w.active()).toBe(w.el('h-trust'));
  });

  it('Ⓢ-4 member — 표시 추가는 잠기고 행 버튼은 없다', async () => {
    OVERRIDE.set('/api/me', me('member'));
    OVERRIDE.set('GET /api/senders?agent=a1', { status: 200, json: SENDERS });
    const w = await boot(lang, '#/agents/a1/email/inbound');
    expect(w.el('sn-add').disabled).toBe(true);
    w.el('sn-add').dispatch('click');
    expect(w.el('dlg-sender').open).toBe(false);
    expect(w.el('sn-body').children.flatMap(buttons)).toEqual([]);
  });
});

describe.each(LANGS)('Ⓛ 허용·차단 목록 행 삭제 (%s)', (lang) => {
  it('Ⓛ-1 제거 버튼 이름에 값 · 확인 대화상자(되돌릴 수 있어 빨갛지 않다) → DELETE · 포커스는 그 목록의 추가 버튼', async () => {
    OVERRIDE.set('DELETE /api/agents/a1/rules/r1', { status: 200, json: { policy: { ...POLICY, outbound: { ...POLICY.outbound, allow: [] } } } });
    const w = await boot(lang, '#/agents/a1/email');
    const row = w.el('o-allow-list').children[0];
    const del = buttons(row)[0];
    expect(del?.textContent).toBe(t(lang, '제거'));
    expect(del?.getAttribute('aria-label')).toBe(lang === 'ko' ? 'partner.example 제거' : 'Remove partner.example');
    del?.click();
    expect(w.el('dlg-confirm').open).toBe(true);
    expect(w.el('dc-head').className).toBe('dh');
    expect(w.el('dc-ok').className).toBe('btn');
    expect(w.el('dc-ok').textContent).toBe(t(lang, '제거'));
    w.el('dc-ok').onclick?.();
    await settle();
    expect(w.calls.some((c) => c.method === 'DELETE' && c.url === '/api/agents/a1/channels/email/rules/r1')).toBe(true);
    expect(w.el('toasts').textContent).toContain(t(lang, '제거했습니다.'));
    expect(w.active()?.id).toBe('o-allow-add');
  });
});

describe.each(LANGS)('Ⓜ 마크업 (%s)', (lang) => {
  it('Ⓜ-1 인라인 입력 폼이 없다 — 더하는 흐름은 전부 대화상자 · 새 대화상자는 anyDialog 가 안다', () => {
    const html = inlined(renderAppPage(lang));
    expect(html).not.toContain('class="addrow');
    expect(html).not.toContain('class="more-d"');
    for (const id of ['dlg-rule', 'dlg-sender', 'dlg-alias']) {
      expect(html).toMatch(new RegExp(`<dialog id="${id}" aria-labelledby="[a-z-]+"><form id="[a-z-]+" novalidate>`));
    }
    // 네 목록의 추가 버튼 · 신뢰 표시 추가 · 별칭 추가는 대화상자를 연다고 알린다.
    for (const id of ['o-allow-add', 'o-block-add', 'i-allow-add', 'i-block-add', 'sn-add', 'al-add']) expect(html).toMatch(new RegExp(`id="${id}" aria-haspopup="dialog"`));
    // Esc 가 ⓘ 보다 대화상자를 먼저 닫게(core.ts anyDialog) 새 대화상자도 목록에 있다.
    const dlgs = /var DLGS=\[([^\]]*)\]/.exec(html)?.[1] ?? '';
    for (const id of ['dlg-rule', 'dlg-sender', 'dlg-alias', 'dlg-sched-cancel']) expect(dlgs).toContain(`'${id}'`);
  });
});

describe.each(LANGS)('Ⓑ 대화상자는 연 에이전트에 묶인다 · 보내는 중에는 닫히지 않는다 (%s)', (lang) => {
  it('Ⓑ-1 라우트가 바뀌면 더하기 대화상자가 닫힌다 · 다른 에이전트로 옮긴 뒤 옛 대화상자의 제출은 보내지 않는다', async () => {
    OVERRIDE.set('/api/agents', { status: 200, json: [AGENT, { ...AGENT, id: 'a2', name: 'research-bot', address: 'research@atmark.ai' }] });
    const w = await boot(lang, '#/agents/a1/email');
    w.el('o-allow-add').dispatch('click');
    expect(w.el('dlg-rule').open).toBe(true);
    await w.go('#/agents/a1/email/inbound');
    expect(w.el('dlg-rule').open).toBe(false);

    // a1 에서 연 대화상자 · 별칭 대화상자 — a2 로 옮긴 뒤 남은 폼이 제출돼도(프로그램으로) a2 에 쓰지 않는다.
    w.el('o-allow-add').dispatch('click');
    w.el('rl-in').value = 'bob@partner.example';
    await w.go('#/agents/a2/email');
    w.el('rl-form').dispatch('submit');
    w.el('sn-form').dispatch('submit');
    await settle();
    expect(w.calls.some((c) => c.method === 'POST' && (c.url.includes('/rules') || c.url === '/api/senders'))).toBe(false);
    expect(w.el('dlg-rule').open).toBe(false);
  });

  it('Ⓑ-2 별칭 추가 — 보내는 중에는 Esc(cancel)·취소가 닫지 않는다 · 끝나면 닫힌다', async () => {
    const w = await boot(lang, '#/agents/a1/addresses', { latency: true });
    await settle();
    w.el('al-add').dispatch('click');
    w.el('al-local').value = 'desk';
    w.el('al-form').dispatch('submit');
    expect(w.el('da-go').classList.contains('busy')).toBe(true);
    expect(w.el('dlg-alias').dispatch('cancel').defaultPrevented).toBe(true);
    w.el('da-cancel').dispatch('click');
    expect(w.el('dlg-alias').open).toBe(true);
    await settle();
    expect(w.el('dlg-alias').open).toBe(false);
    expect(w.el('dlg-alias').dispatch('cancel').defaultPrevented).toBe(false);
  });

  it('Ⓑ-3 한도를 채운 추가 뒤 포커스는 별칭 제목(추가 버튼이 잠겼다) · 닫힌 조직에서 마지막 별칭을 지우면 화면 제목', async () => {
    OVERRIDE.set('GET /api/agents/a1/aliases', [
      { status: 200, json: { items: [{ id: 'd1', address: 'founder@atmark.ai', primary: true, status: 'active', createdAt: '2026-09-20T01:00:00Z', retiredAt: null }], aliases: { active: 0, activeMax: 1, issued: 0, issuedMax: 20, overLimit: false } } },
      {
        status: 200,
        json: {
          items: [
            { id: 'd1', address: 'founder@atmark.ai', primary: true, status: 'active', createdAt: '2026-09-20T01:00:00Z', retiredAt: null },
            { id: 'd5', address: 'desk@atmark.ai', primary: false, status: 'active', createdAt: '2026-09-27T01:00:00Z', retiredAt: null },
          ],
          aliases: { active: 1, activeMax: 1, issued: 1, issuedMax: 20, overLimit: false },
        },
      },
    ]);
    const w = await boot(lang, '#/agents/a1/addresses');
    w.el('al-add').dispatch('click');
    w.el('al-local').value = 'desk';
    w.el('al-form').dispatch('submit');
    await settle();
    expect(w.el('al-add').disabled).toBe(true);
    expect(w.active()?.id).toBe('h-al');
  });

  it('Ⓑ-4 닫힌 조직에서 마지막 별칭을 지우면 별칭 절이 숨고 포커스는 화면 제목', async () => {
    OVERRIDE.set('/api/plan', { status: 200, json: { ...PLAN, features: { addressAliases: false } } });
    const w = await boot(lang, '#/agents/a1/addresses');
    buttons(w.el('al-list').children[0])[0]?.click();
    w.el('dc-ok').onclick?.();
    await settle();
    expect(w.el('al-sec').hidden).toBe(true);
    expect(w.active()?.id).toBe('h-ag-addr');
  });
});

describe('Ⓔ 탭 제목 표식(`<!--복수-->`)은 텍스트 노드에만', () => {
  it('Ⓔ-1 두 언어 페이지 어느 속성 값에도 주석 표식이 없다 · 영어 페이지에는 표식 자체가 없다', () => {
    for (const lang of LANGS) {
      const html = inlined(renderAppPage(lang));
      for (const m of html.matchAll(/<[a-zA-Z][^>]*>/g)) expect(m[0], m[0]).not.toContain('<!--복수');
      for (const m of html.matchAll(/="([^"]*)"/g)) expect(m[1], m[0]).not.toContain('복수-->');
      if (lang === 'en') expect(html).not.toContain('<!--복수-->');
    }
  });
});
