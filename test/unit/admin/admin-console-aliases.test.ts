/**
 * 콘솔(가짜 DOM) — 메일 기본기 2차 콘솔 UI(`.omc/handoffs/mail-basics-2-console-ui.md`) · 2026-09-29 진윤겸 피드백(주소 탭 · 추가 대화상자 · 삭제).
 *   Ⓐ 주소 탭 `#/agents/{id}/addresses`(A6 별칭 — 이메일 화면에서 뺐다): 대표 주소는 늘 보인다(읽기 전용 · `대표`) · 닫힌 조직
 *     (`/api/plan` features.addressAliases ≠ true)에 별칭이 없으면(또는 GET 404) 별칭 절이 숨는다 · 닫혀도 있는 별칭은 보이고 삭제할 수
 *     있다(추가 버튼만 없다 — 보안 리뷰 L-4) · 폐기한 별칭은 목록에 없다 · 추가 = 버튼 → 대화상자(남은 수 · 재사용 불가 한 줄 · 칸 오류) ·
 *     삭제 = 서버의 폐기(위험 확인 대화상자 · 빨간 확인) · Free(activeMax 0) = 업그레이드 · 한도 초과 줄 · member 는 목록만.
 *   Ⓓ 요금제 표 두 줄(별칭 · 첨부 MB) · 한도 초과 배너의 `aliases`.
 *   Ⓘ 신원 변경 이력 잎 `identity.address_retired` 라벨 · 무결성 패널의 검증 도구 v4 안내.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { renderAppPage } from '../../../src/admin/ui/index';

import { boot, type FakeNode, HANGUL, IDENTITY_BLOCKS, inlined, me, OVERRIDE, PLAN, resetTeam, settle, t } from './console-harness';

afterEach(() => {
  OVERRIDE.clear();
  resetTeam();
});

const LANGS = ['ko', 'en'] as const;
const hasClass = (n: FakeNode, c: string): boolean => n.className.split(/\s+/).includes(c);
const buttons = (row: FakeNode | undefined): FakeNode[] => (row?.all() ?? []).filter((n) => n.tagName === 'BUTTON');
const pills = (row: FakeNode | undefined): string[] => (row?.all() ?? []).filter((n) => hasClass(n, 'pill')).map((n) => n.textContent);
const addr = (row: FakeNode | undefined): string => (row?.all() ?? []).find((n) => hasClass(n, 'addr'))?.textContent ?? '';
const ADDR = '#/agents/a1/addresses';
const PRIMARY_ONLY = {
  items: [{ id: 'd1', address: 'founder@atmark.ai', primary: true, status: 'active', createdAt: '2026-09-20T01:00:00Z', retiredAt: null }],
  aliases: { active: 0, activeMax: 5, issued: 0, issuedMax: 20, overLimit: false },
};

describe.each(LANGS)('Ⓐ 주소 탭 — 대표 + 별칭 (%s)', (lang) => {
  it('Ⓐ-1 목록 — 대표(태그 · 버튼 없음)는 따로 · 활성 별칭(삭제) · 폐기한 별칭은 나오지 않는다 · 수 · 비공개 한 줄', async () => {
    const w = await boot(lang, ADDR);
    expect(w.el('t-addresses').hidden).toBe(false);
    expect(w.el('t-email').hidden).toBe(true);
    expect(w.calls.some((c) => c.method === 'GET' && c.url === '/api/agents/a1/aliases')).toBe(true);
    const prim = w.el('al-primary').children;
    expect(prim.map(addr)).toEqual(['founder@atmark.ai']);
    expect(prim.map(pills)).toEqual([[t(lang, '대표')]]);
    expect(buttons(prim[0])).toEqual([]);
    expect(w.el('al-sec').hidden).toBe(false);
    expect(w.el('al-n').textContent).toBe('1 / 5');
    const rows = w.el('al-list').children;
    expect(rows.map(addr)).toEqual(['sales@atmark.ai']);
    expect(rows.map(pills)).toEqual([[]]);
    const del = buttons(rows[0]);
    expect(del.map((b) => b.textContent)).toEqual([t(lang, '삭제')]);
    expect(del[0]?.className).toBe('btn sm link');
    expect(del[0]?.getAttribute('aria-label')).toBe(lang === 'ko' ? 'sales@atmark.ai 삭제' : 'Delete sales@atmark.ai');
    expect(w.el('al-list').textContent).not.toContain('old-desk');
    expect(w.el('al-empty').hidden).toBe(true);
    // 활성 주소의 '@' 만 .at(글자색).
    expect([...prim, ...rows].map((r) => r.all().filter((n) => hasClass(n, 'at')).length)).toEqual([1, 1]);
    expect(w.el('al-add').hidden).toBe(false);
    expect(w.el('al-add').disabled).toBe(false);
    expect(w.el('al-up').hidden).toBe(true);
    expect(w.el('al-over').hidden).toBe(true);
    if (lang === 'en') {
      expect(HANGUL.test(w.el('al-list').textContent)).toBe(false);
      expect(del[0]?.textContent).toBe('Delete');
      expect(w.el('al-list').textContent).not.toMatch(/Retir|Revok/);
    }
  });

  it('Ⓐ-1b 이메일 화면에는 주소 절이 없다 · 별칭 목록도 부르지 않는다 · 사이드바의 주소 항목은 이메일 바로 뒤', async () => {
    const w = await boot(lang, '#/agents/a1/email');
    expect(w.calls.some((c) => c.url === '/api/agents/a1/aliases')).toBe(false);
    const html = inlined(renderAppPage(lang));
    const email = /<div class="pane" id="t-email" hidden>([\s\S]*?)<div class="pane" id="t-addresses" hidden>/.exec(html)?.[1] ?? '';
    expect(email).not.toBe('');
    expect(email).not.toContain('id="al-');
    const nav = [...html.matchAll(/<a href="#\/agents" id="na-([a-z]+)">/g)].map((m) => m[1]);
    expect(nav).toEqual(['overview', 'connect', 'email', 'addresses', 'webhooks', 'logs', 'identity', 'tokens']);
    expect(w.el('na-addresses').href).toBe('#/agents/a1/addresses');
    const label = /id="na-addresses"><svg[^>]*>[\s\S]*?<\/svg><span>([\s\S]*?)<\/span>/.exec(html)?.[1];
    expect(label?.replace(/<!--[\s\S]*?-->/g, '')).toBe(lang === 'ko' ? '주소' : 'Addresses');
  });

  it('Ⓐ-2 닫힌 조직에 별칭이 없으면(대표뿐) 별칭 절이 숨고 대표는 보인다 · GET 404(옛 서버)도 같다 · 오류 문장도 없다', async () => {
    OVERRIDE.set('/api/plan', { status: 200, json: { ...PLAN, features: { addressAliases: false } } });
    OVERRIDE.set('GET /api/agents/a1/aliases', { status: 200, json: PRIMARY_ONLY });
    const closed = await boot(lang, ADDR);
    expect(closed.calls.some((c) => c.url === '/api/agents/a1/aliases')).toBe(true);
    expect(closed.calls.some((c) => c.url === '/api/plan')).toBe(true);
    expect(closed.el('al-sec').hidden).toBe(true);
    expect(closed.el('al-primary').children.map(addr)).toEqual(['founder@atmark.ai']);
    expect(closed.el('al-msg').textContent).toBe('');

    OVERRIDE.clear();
    OVERRIDE.set('GET /api/agents/a1/aliases', { status: 404, json: { error: 'not_found' } });
    const w = await boot(lang, ADDR);
    expect(w.el('al-sec').hidden).toBe(true);
    expect(w.el('al-primary').children.map(addr)).toEqual(['founder@atmark.ai']);
    expect(w.el('al-msg').textContent).toBe('');
  });

  it('Ⓐ-2b L-4 닫힌 조직에 별칭이 있으면 — 목록과 삭제는 보이고 추가 버튼·수·한도 줄은 없다 · 삭제가 된다', async () => {
    OVERRIDE.set('/api/plan', { status: 200, json: { ...PLAN, features: { addressAliases: false } } });
    const w = await boot(lang, ADDR);
    expect(w.el('al-sec').hidden).toBe(false);
    expect(w.el('al-add').hidden).toBe(true);
    expect(w.el('al-up').hidden).toBe(true);
    expect(w.el('al-over').hidden).toBe(true);
    expect(w.el('al-n').textContent).toBe('');
    const rows = w.el('al-list').children;
    expect(rows.map(addr)).toEqual(['sales@atmark.ai']);
    buttons(rows[0])[0]?.click();
    w.el('dc-ok').onclick?.();
    await settle();
    expect(w.calls.some((c) => c.method === 'POST' && c.url === '/api/agents/a1/aliases/d2/retire')).toBe(true);
    // 마지막 별칭을 지웠고 닫힌 조직이라 절이 숨는다 — 대표는 그대로.
    expect(w.el('al-sec').hidden).toBe(true);
    expect(w.el('al-primary').children.map(addr)).toEqual(['founder@atmark.ai']);
  });

  it('Ⓐ-2c 요금제를 읽지 못하면 닫힌 것으로 본다(추가 버튼 없음) · 있는 별칭은 보인다', async () => {
    OVERRIDE.set('/api/plan', { status: 500, json: { error: 'internal' } });
    const w = await boot(lang, ADDR);
    expect(w.el('al-sec').hidden).toBe(false);
    expect(w.el('al-add').hidden).toBe(true);
    expect(w.el('al-list').children).toHaveLength(1);
  });

  it('Ⓐ-3 추가 — 버튼 → 대화상자(남은 수 · 입력에 포커스) · 소문자로 다듬어 POST {localPart} · 칸 오류는 입력 아래 · 성공하면 닫히고 목록을 다시 읽는다', async () => {
    const w = await boot(lang, ADDR);
    expect(w.el('dlg-alias').open).toBe(false);
    w.el('al-add').dispatch('click');
    expect(w.el('dlg-alias').open).toBe(true);
    expect(w.active()).toBe(w.el('al-local'));
    // 요금제 활성 한도 · 누적 발급 상한 — 목록 응답의 aliases{} 그대로(폐기 포함 발급 2).
    expect(w.el('da-active').textContent).toBe('1 / 5');
    expect(w.el('da-issued').textContent).toBe('2 / 20');

    w.el('al-local').value = 'bad@x';
    w.el('al-form').dispatch('submit');
    expect(w.el('al-local').getAttribute('aria-invalid')).toBe('true');
    expect(w.calls.some((c) => c.method === 'POST')).toBe(false);

    w.el('al-local').value = ' Sales ';
    w.el('al-form').dispatch('submit');
    await settle();
    const taken = w.calls.find((c) => c.method === 'POST' && c.url === '/api/agents/a1/aliases');
    expect(taken?.body).toEqual({ localPart: 'sales' });
    expect(taken?.csrf).toBeTruthy();
    expect(w.el('al-local').getAttribute('aria-invalid')).toBe('true');
    expect(w.el('al-local').getAttribute('aria-describedby')).toBe('al-local-err');
    const err = w.body.all().find((n) => n.id === 'al-local-err');
    expect(err?.textContent).toBe(t(lang, '이미 쓰이고 있거나 지금은 쓸 수 없는 주소입니다. 다른 주소를 고르세요.'));
    expect(w.el('da-msg').textContent).toBe('');
    expect(w.el('dlg-alias').open).toBe(true);

    w.el('al-local').value = 'support';
    w.el('al-form').dispatch('submit');
    await settle();
    expect(w.calls.filter((c) => c.method === 'POST').at(-1)?.body).toEqual({ localPart: 'support' });
    expect(w.el('dlg-alias').open).toBe(false);
    expect(w.el('al-list').children.map(addr)).toEqual(['sales@atmark.ai', 'support@atmark.ai']);
    expect(w.el('al-n').textContent).toBe('2 / 5');
    expect(w.el('toasts').textContent).toContain(t(lang, '별칭을 추가했습니다.'));

    // 다시 열면 빈 칸 · 새 수 · 취소는 요청 없이 닫힌다.
    w.el('al-add').dispatch('click');
    expect(w.el('al-local').value).toBe('');
    expect(w.el('da-active').textContent).toBe('2 / 5');
    const posts = w.calls.filter((c) => c.method === 'POST').length;
    w.el('da-cancel').dispatch('click');
    expect(w.el('dlg-alias').open).toBe(false);
    expect(w.calls.filter((c) => c.method === 'POST')).toHaveLength(posts);
  });

  it('Ⓐ-3b 대화상자 마크업 — @atmark.ai 접미(.at @) · 64자 · 남은 수 두 줄 · 재발급 규칙 한 줄(이 조직 바로 · 다른 조직 30일) · 취소 + 추가', () => {
    const html = inlined(renderAppPage(lang));
    const dlg = /<dialog id="dlg-alias"[^>]*>([\s\S]*?)<\/dialog>/.exec(html)?.[1] ?? '';
    expect(dlg).toMatch(/<input type="text" id="al-local" maxlength="64"[^>]*><b id="al-suf-w"><span class="at">@<\/span><span id="al-suf">atmark\.ai<\/span><\/b><select id="al-dom" aria-label="[^"]+" hidden><\/select>/);
    expect(dlg).toContain(`<dt>${t(lang, '사용 중<!--별칭 수-->')}</dt><dd class="num" id="da-active">`);
    expect(dlg).toContain(`<dt>${t(lang, '누적 발급(삭제 포함)')}</dt><dd class="num" id="da-issued">`);
    expect(dlg).toContain(t(lang, '삭제한 별칭은 이 조직에서 바로 다시 만들 수 있습니다. 30일이 지나면 다른 조직이 가져가 그 주소로 오는 메일을 받을 수 있습니다.'));
    if (lang === 'en') expect(dlg).toContain('A deleted alias can be re-created in this organization right away. After 30 days, another organization can take it and receive mail sent to it.');
    expect(dlg).not.toMatch(/누구도|never be used again/);
    // 별칭 설명 팁도 같은 규칙(삭제 = 수신 거부 · 이 조직 바로 · 다른 조직 30일)이다.
    expect(html).toContain(t(lang, '삭제한 별칭으로 오는 메일은 거부되고, 이 조직에서는 바로 다시 만들 수 있습니다. 하지만 30일이 지나면 다른 조직이 그 주소를 가져가 그 앞으로 오는 메일을 받을 수 있습니다. 그 주소로 가입한 서비스의 비밀번호 재설정·인증 메일도 포함됩니다. 삭제하기 전에 가입 주소를 옮기세요.'));
    expect(dlg).toMatch(new RegExp(`id="da-cancel">${t(lang, '취소')}</button><button type="submit" class="btn" id="da-go">${t(lang, '추가')}</button>`));
    if (lang === 'en') expect(HANGUL.test(dlg)).toBe(false);
  });

  it('Ⓐ-4 409 한도 오류는 대화상자 안 한 줄(칸 오류가 아니다) · 대화상자는 열린 채', async () => {
    OVERRIDE.set('POST /api/agents/a1/aliases', { status: 409, json: { error: 'alias_org_daily_limit' } });
    const w = await boot(lang, ADDR);
    w.el('al-add').dispatch('click');
    w.el('al-local').value = 'desk';
    w.el('al-form').dispatch('submit');
    await settle();
    expect(w.el('da-msg').textContent).toBe(t(lang, '오늘은 이 조직에서 별칭을 더 만들 수 없습니다. 내일 다시 시도하세요.'));
    expect(w.el('da-msg').className).toBe('msg err');
    expect(w.el('al-local').getAttribute('aria-invalid')).not.toBe('true');
    expect(w.el('dlg-alias').open).toBe(true);
  });

  it('Ⓐ-5 삭제 — 위험 확인 대화상자(빨간 확인 · 다시 만들기 전까지 수신 거부 · 이 조직 바로 · 다른 조직 30일) → 취소면 요청 없음 · 확인하면 POST …/retire 뒤 목록에서 사라진다', async () => {
    const w = await boot(lang, ADDR);
    buttons(w.el('al-list').children[0])[0]?.click();
    expect(w.el('dlg-confirm').open).toBe(true);
    expect(w.el('dc-head').className).toBe('dh hatch');
    expect(w.el('dc-ok').className).toBe('btn danger solid');
    expect(w.el('dc-ok').textContent).toBe(t(lang, '삭제'));
    expect(w.el('dc-title').textContent).toBe(t(lang, '이 별칭을 삭제할까요?'));
    expect(w.el('dc-body').textContent).toContain(t(lang, '다시 만들기 전까지 이 주소로 오는 메일은 거부됩니다. 이 조직에서는 바로 다시 만들 수 있습니다.'));
    // 30일 경고는 경고 상자 하나(2026-10-15 F45·F46과 같은 틀)
    expect(w.el('dc-body').textContent).toContain(t(lang, '30일이 지나면 다른 조직이 이 주소를 가져가 그 앞으로 오는 메일(비밀번호 재설정 · 인증 메일 포함)을 받을 수 있습니다. 삭제하기 전에 이 주소로 가입한 서비스의 주소를 바꾸세요.'));
    // 보안 리뷰 H1 — 30일 뒤 다른 조직이 받는다는 것과 비밀번호 재설정·인증 메일을 분명히 말한다.
    expect(w.el('dc-body').textContent).toMatch(lang === 'ko' ? /30일.*다른 조직.*비밀번호 재설정/ : /30 days.*another organization.*password reset/);
    expect(w.el('dc-body').textContent).not.toMatch(/누구도|Nobody/);
    expect(w.el('dc-body').textContent).toContain('sales@atmark.ai');
    if (lang === 'en') {
      expect([w.el('dc-kicker').textContent, w.el('dc-title').textContent, w.el('dc-ok').textContent]).toEqual(['Delete alias', 'Delete this alias?', 'Delete']);
      expect(w.el('dc-body').textContent).not.toMatch(/Retir|Revok/);
    }
    w.el('dc-cancel').onclick?.();
    await settle();
    expect(w.calls.some((c) => c.method === 'POST')).toBe(false);

    buttons(w.el('al-list').children[0])[0]?.click();
    w.el('dc-ok').onclick?.();
    await settle();
    expect(w.calls.some((c) => c.method === 'POST' && c.url === '/api/agents/a1/aliases/d2/retire')).toBe(true);
    expect(w.el('al-list').children).toHaveLength(0);
    expect(w.el('al-empty').hidden).toBe(false);
    expect(w.el('al-sec').hidden).toBe(false);
    expect(w.el('al-n').textContent).toBe('0 / 5');
    expect(w.el('toasts').textContent).toContain(t(lang, '별칭을 삭제했습니다.'));
    expect(w.active()).toBe(w.el('h-al'));
  });

  it('Ⓐ-6 Free(activeMax 0) — 추가 대신 업그레이드(요금제로) · 수 없음', async () => {
    OVERRIDE.set('GET /api/agents/a1/aliases', { status: 200, json: { ...PRIMARY_ONLY, aliases: { ...PRIMARY_ONLY.aliases, activeMax: 0 } } });
    const w = await boot(lang, ADDR);
    expect(w.el('al-add').hidden).toBe(true);
    expect(w.el('al-up').hidden).toBe(false);
    expect(w.el('al-up').getAttribute('href')).toBe('#/settings/plan');
    expect(w.el('al-n').textContent).toBe('');
    expect(w.el('al-empty').hidden).toBe(false);
  });

  it('Ⓐ-7 한도 초과(overLimit) — 한 줄 안내 · 추가 잠김(이유는 title) · 대화상자는 열리지 않는다 · 있는 별칭은 그대로 보인다', async () => {
    OVERRIDE.set('GET /api/agents/a1/aliases', {
      status: 200,
      json: {
        items: [
          { id: 'd1', address: 'founder@atmark.ai', primary: true, status: 'active', createdAt: '2026-09-20T01:00:00Z', retiredAt: null },
          { id: 'd2', address: 'sales@atmark.ai', primary: false, status: 'active', createdAt: '2026-09-24T01:00:00Z', retiredAt: null },
          { id: 'd4', address: 'desk@atmark.ai', primary: false, status: 'active', createdAt: '2026-09-24T02:00:00Z', retiredAt: null },
        ],
        aliases: { active: 2, activeMax: 1, issued: 2, issuedMax: 20, overLimit: true },
      },
    });
    const w = await boot(lang, ADDR);
    expect(w.el('al-over').hidden).toBe(false);
    expect(w.el('al-add').disabled).toBe(true);
    expect(w.el('al-add').title).toBe(t(lang, '요금제의 별칭 한도에 닿았습니다. 쓰지 않는 별칭을 삭제하거나 요금제를 올리세요.'));
    w.el('al-add').dispatch('click');
    expect(w.el('dlg-alias').open).toBe(false);
    expect(w.el('al-list').children).toHaveLength(2);
  });

  it('Ⓐ-8 member 는 목록만 — 추가 버튼도 삭제 버튼도 없다', async () => {
    OVERRIDE.set('/api/me', me('member'));
    const w = await boot(lang, ADDR);
    expect(w.el('al-sec').hidden).toBe(false);
    expect(w.el('al-add').hidden).toBe(true);
    expect(w.el('al-up').hidden).toBe(true);
    expect(w.el('al-list').children).toHaveLength(1);
    expect(w.el('al-list').children.flatMap(buttons)).toEqual([]);
  });

  it('Ⓐ-9 마크업 — 탭 제목(ko 주소 · en Addresses) · 별칭 절은 처음에 숨어 있다 · 비공개 한 줄 · 한도 초과 줄 · 업그레이드 링크', () => {
    const html = inlined(renderAppPage(lang));
    expect(html).toMatch(/<h1 id="h-ag-addr" tabindex="-1">(주소<!--복수-->|Addresses)<\/h1>/);
    if (lang === 'en') expect(html).toContain('<h1 id="h-ag-addr" tabindex="-1">Addresses</h1>');
    expect(html).toMatch(/<section class="alsub" id="al-sec" aria-labelledby="h-al" hidden>/);
    expect(html).toContain(`<h2 id="h-al">${t(lang, '별칭')}</h2>`);
    expect(html).toContain(`<p class="sdesc" id="al-note">${t(lang, '별칭은 패스포트와 공개 조회에 나오지 않습니다.')}</p>`);
    expect(html).toContain(`<p class="note" id="al-over" hidden>${t(lang, '한도를 넘어 새 별칭은 만들 수 없습니다. 있는 별칭은 계속 받습니다.')}</p>`);
    expect(html).toContain(`id="al-up" href="#/settings/plan" hidden>${t(lang, '업그레이드')}</a>`);
    // 절 안 하위 목록의 추가 = 절 머리 오른쪽 회색 '+ 추가'(2026-10-15 F05) — 이름은 aria-label.
    expect(html).toContain(`id="al-add" aria-haspopup="dialog" aria-label="${t(lang, '별칭 추가')}" hidden>`);
  });
});

describe.each(LANGS)('Ⓓ 요금제 표 · 한도 초과 (%s)', (lang) => {
  it('Ⓓ-1 별칭 · 첨부(MiB → MB) 두 줄', async () => {
    const w = await boot(lang, '#/settings/plan');
    const rows = w.el('pl-body2').all().filter((n) => n.tagName === 'TR').map((r) => r.all().filter((n) => n.tagName === 'TD').map((n) => n.textContent));
    expect(rows).toContainEqual([t(lang, '에이전트당 별칭 주소'), '5']);
    expect(rows).toContainEqual([t(lang, '메일당 첨부 용량'), '25 MB']);
  });

  it('Ⓓ-2 한도 초과 배너에 별칭 주소', async () => {
    OVERRIDE.set('/api/plan', { status: 200, json: { ...PLAN, overLimit: ['aliases'] } });
    const w = await boot(lang, '#/settings/plan');
    expect(w.el('pl-over').hidden).toBe(false);
    expect(w.el('pl-over-d').textContent).toBe(t(lang, '별칭 주소'));
  });
});

describe.each(LANGS)('Ⓘ 신원 이력 · 무결성 안내 (%s)', (lang) => {
  it('Ⓘ-1 잎 identity.address_retired → 주소 폐기 / Address retired', async () => {
    const blocks = structuredClone(IDENTITY_BLOCKS);
    const address = blocks.blocks[2];
    if (address !== undefined) {
      address.kind = 'identity.address_retired';
      address.changes = [{ field: 'address', value: 'old-desk@atmark.ai', matches: true }];
    }
    OVERRIDE.set('/api/agents/a1/identity-blocks', { status: 200, json: blocks });
    const w = await boot(lang, '#/agents/a1/identity');
    const kinds = w.el('ib-list').children.map((li) => li.all().find((n) => hasClass(n, 'blk-k'))?.textContent);
    expect(kinds[2]).toBe(lang === 'ko' ? '주소 폐기' : 'Address retired');
  });

  it('Ⓘ-2 무결성 패널 — 검증 도구 v4 안내 한 줄(고객 문구 — 명령 · 내부 코드 없음, 2026-10-15 F52)', () => {
    const html = inlined(renderAppPage(lang));
    const m = /<p class="small muted" id="it-ver">([\s\S]*?)<\/p>/.exec(html);
    const line = m?.[1] ?? '';
    expect(line).toBe(t(lang, '검증 도구 v4 이상에서 확인할 수 있습니다.'));
    expect(line).not.toContain('pnpm');
    expect(line).not.toContain('verifier_outdated');
    if (lang === 'en') expect(HANGUL.test(line)).toBe(false);
  });
});
