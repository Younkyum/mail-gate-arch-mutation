/**
 * 콘솔(가짜 DOM) — **에이전트 삭제**(2026-10-13 진윤겸 결정 — 별칭 삭제와 같은 소프트 삭제).
 *   Ⓓ-1 개요 맨 아래 두 번째 위험 행 `에이전트 삭제`(빨간 버튼) — member 는 잠김 · 운영자 보류는 잠김(이유 한 줄).
 *   Ⓓ-2 확인 대화상자 — 빨간 머리 · 확인란(되돌릴 수 없음) · 살아 있는 주소 전부(폐기한 별칭 제외) · 토큰 폐기 · 송수신 중단 · 기록 유지 ·
 *        30일 뒤 다른 조직(비밀번호 재설정 메일) · 같은 조직은 바로 · 취소면 요청 없음 · 확인하면 POST …/delete 뒤 목록으로.
 *   Ⓓ-3 삭제한 에이전트(딥링크 — 목록에는 없다)는 읽기 전용: 안내 한 줄 · 위험 구역 · 연결 메시지 · 편집 링크 없음 · 사이드바는 개요와 로그만 ·
 *        다른 화면 주소는 개요로 · 상태 표시는 `삭제됨`.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { renderAppPage } from '../../../src/admin/ui/index';

import { AGENT, boot, HANGUL, inlined, OVERRIDE, resetTeam, settle, t } from './console-harness';

afterEach(() => {
  OVERRIDE.clear();
  resetTeam();
});

const LANGS = ['ko', 'en'] as const;
/** 마크업 원문(작은따옴표 엔티티를 되돌린) — 가짜 DOM 은 스크립트가 쓴 글만 갖는다. */
const markupText = (lang: (typeof LANGS)[number]): string => inlined(renderAppPage(lang)).replace(/&#39;|&#x27;|&apos;/g, "'");

describe.each(LANGS)('Ⓓ 에이전트 삭제 (%s)', (lang) => {
  it('Ⓓ-1 개요 위험 구역 — 긴급 정지 아래 에이전트 삭제(빨간 버튼) · 운영자 보류면 잠김', async () => {
    const w = await boot(lang, '#/agents/a1');
    expect(w.el('dz').hidden).toBe(false);
    // 마크업의 고정 글(가짜 DOM 은 스크립트가 쓴 글만 갖는다) — 제목 · 한 줄 설명 · 버튼.
    const html = markupText(lang);
    expect(html.includes(`<h2 id="dzd-title">${t(lang, '에이전트 삭제')}</h2>`)).toBe(true);
    expect(html.includes(`<p>${t(lang, '토큰을 폐기하고 주소를 삭제해 메일을 멈춥니다. 되돌릴 수 없습니다.')}</p>`)).toBe(true);
    expect(w.el('dz-del').className).toBe('btn danger');
    expect(w.el('dz-del').disabled).toBe(false);
    expect(w.el('a-gone').hidden).toBe(true);

    OVERRIDE.set('/api/agents', { status: 200, json: [{ ...AGENT, status: 'suspended', suspendedBy: 'operator' }] });
    const held = await boot(lang, '#/agents/a1');
    expect(held.el('dz-del').disabled).toBe(true);
    expect(held.el('dzd-note').textContent).toBe(t(lang, '운영자가 보류한 에이전트는 삭제할 수 없습니다.'));
  });

  it('Ⓓ-2 확인 대화상자 → 취소면 요청 없음 · 확인(확인란)하면 POST …/delete 뒤 목록', async () => {
    const w = await boot(lang, '#/agents/a1');
    w.el('dz-del').click();
    await settle();
    expect(w.el('dlg-confirm').open).toBe(true);
    expect(w.el('dc-head').className).toBe('dh hatch');
    expect(w.el('dc-ok').className).toBe('btn danger solid');
    expect(w.el('dc-ok').textContent).toBe(t(lang, '삭제'));
    expect(w.el('dc-kicker').textContent).toBe(t(lang, '에이전트 삭제'));
    expect(w.el('dc-title').textContent).toBe(t(lang, '이 에이전트를 삭제할까요?'));
    // 되돌릴 수 없다 — 확인란을 체크하기 전에는 확인 버튼이 잠긴다.
    expect(w.el('dc-ackwrap').hidden).toBe(false);
    expect(w.el('dc-ok').disabled).toBe(true);
    const body = w.el('dc-body').textContent;
    expect(body).toContain('founder@atmark.ai');
    expect(body).toContain('sales@atmark.ai');
    expect(body).not.toContain('old-desk@atmark.ai');
    // 핵심 한 줄 + 사라지는 것 / 남는 것 두 칸 + 30일 경고 하나(2026-10-15 F46).
    expect(body).toContain(t(lang, '되돌릴 수 없습니다. 이 에이전트는 메일을 보내지도 받지도 않습니다.'));
    for (const k of ['사라지는 것', '토큰 전부', '예약 발송', '남는 것', '받은 메일', '로그 · 감사 기록']) expect(body).toContain(t(lang, k));
    expect(body).toMatch(lang === 'ko' ? /30일.*다른 조직.*비밀번호 재설정/ : /30 days.*another organization.*password reset/);
    expect(w.el('dc-body').all().filter((n) => n.className === 'warnbox')).toHaveLength(1);
    expect(w.el('dc-acktext').textContent).toBe(t(lang, '삭제하면 되돌릴 수 없는 것을 확인했습니다'));
    if (lang === 'en') expect(HANGUL.test(`${body}${w.el('dc-title').textContent}${w.el('dc-acktext').textContent}`)).toBe(false);
    w.el('dc-cancel').onclick?.();
    await settle();
    expect(w.calls.some((c) => c.method === 'POST')).toBe(false);

    OVERRIDE.set('POST /api/agents/a1/delete', {
      status: 200,
      json: { agentId: 'a1', replayed: false, addresses: ['founder@atmark.ai', 'sales@atmark.ai'], revokedTokens: 1, cancelledScheduled: 0, disabledWebhooks: 0 },
    });
    w.el('dz-del').click();
    await settle();
    w.el('dc-ack').checked = true;
    w.el('dc-ack').onchange?.();
    expect(w.el('dc-ok').disabled).toBe(false);
    w.el('dc-ok').onclick?.();
    await settle();
    expect(w.calls.some((c) => c.method === 'POST' && c.url === '/api/agents/a1/delete')).toBe(true);
    expect(w.el('toasts').textContent).toContain(t(lang, '에이전트를 삭제했습니다.'));
    expect(w.location.hash).toBe('#/agents');
  });

  it('Ⓓ-3 삭제한 에이전트(딥링크)는 읽기 전용 — 안내 · 위험 구역·연결 메시지·편집 링크 없음 · 사이드바 개요·로그만 · 다른 화면은 개요로', async () => {
    const gone = { ...AGENT, status: 'disabled', activeTokens: 0 };
    OVERRIDE.set('/api/agents', { status: 200, json: [] });
    OVERRIDE.set('GET /api/agents/a1', { status: 200, json: gone });
    const w = await boot(lang, '#/agents/a1/tokens');
    await settle();
    expect(w.el('a-body').hidden).toBe(false);
    expect(w.el('a-gone').hidden).toBe(false);
    expect(markupText(lang).includes(t(lang, '삭제한 에이전트입니다. 받은 메일과 기록은 남아 있고, 바꿀 수 없습니다.'))).toBe(true);
    expect(w.el('t-overview').hidden).toBe(false);
    expect(w.el('t-tokens').hidden).toBe(true);
    expect(w.el('dz').hidden).toBe(true);
    expect(w.el('ao-copy').hidden).toBe(true);
    expect(['ao-email-a', 'ao-tokens-a', 'ao-identity-a'].map((id) => w.el(id).hidden)).toEqual([true, true, true]);
    const nav = ['overview', 'connect', 'email', 'addresses', 'webhooks', 'logs', 'identity', 'tokens'].map((tab) => [tab, w.el(`na-${tab}`).hidden]);
    expect(nav.filter(([, hidden]) => hidden !== true).map(([tab]) => tab)).toEqual(['overview', 'logs']);
    expect(w.el('a-status').textContent).toBe(t(lang, '삭제됨'));
  });

  it('Ⓓ-4 거부 — 운영자 예약 주소 409 operator_reserved 는 위험 행 아래에 사람 말로 · 목록으로 가지 않는다', async () => {
    OVERRIDE.set('POST /api/agents/a1/delete', { status: 409, json: { error: 'operator_reserved' } });
    const w = await boot(lang, '#/agents/a1');
    w.el('dz-del').click();
    await settle();
    w.el('dc-ack').checked = true;
    w.el('dc-ack').onchange?.();
    w.el('dc-ok').onclick?.();
    await settle();
    expect(w.el('dzd-msg').textContent).toBe(t(lang, '운영자 예약 주소를 쓰는 에이전트라 삭제할 수 없습니다. 운영자에게 문의하세요.'));
    expect(w.location.hash).not.toBe('#/agents');
  });
});

