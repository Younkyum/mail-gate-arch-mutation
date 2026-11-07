/**
 * 콘솔(가짜 DOM) — AI 의심 메일 감시(ADR-0017 · 설계 `docs/internal/plans/ai-mail-watch.md` §4.2 · §7.3).
 *
 *   Ⓐ 감시 > 메일 > AI 의심 메일(2026-10-08 설정 > 운영에서 옮김 — 예전 `#/settings/aiwatch` 는 리다이렉트): 허용 목록(`feature`)이 없으면 잠김(베타 한 장 · 스위치 없음) · 켜기는 소유자 + 확인 대화상자 한 번 ·
 *     끄기는 관리자도 · 즉시(대화상자 없음) · 관리자는 켤 수 없다 · 허용 목록에서 빠진 채 켜진 조직은 끌 수 있다 · 403 `feature_not_enabled` → 잠김.
 *   Ⓑ 수신 로그 표시: flagged(밴드 = 3칸 막대 · 소유자만) · pending · skipped("판정 없음") · clear · 키 없는 행은 아무것도 그리지 않는다 ·
 *     상세에 상태 · 강도 · 모델 버전 · 늦게 도착 + "경고일 뿐" 한 줄. 글자는 전부 textContent.
 *   Ⓒ 문구: 영어 화면에 한글 없음 · 새 문구가 copy-guard 를 지난다(막는다 · 보호한다 · 100% 류 없음).
 *
 * 되돌려서 빨개지는지 확인한 것(2026-10-06): `renderAiWatch` 의 `may` 를 `can('admin')` 하나로 바꾸면 → Ⓐ-3 · `aiwNode` 의 밴드 막대를 전부 채우면 → Ⓑ-1.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { MESSAGES } from '../../../src/admin/ui/i18n';
import { renderAppPage, type Lang } from '../../../src/admin/ui/index';
import { COPY_GUARD_BANNED, copyGuardHits, visibleText } from '../../support/copy-guard';

import { boot, type FakeNode, HANGUL, inlined, me, OVERRIDE, settle, t, type World } from './console-harness';

afterEach(() => OVERRIDE.clear());

const LANGS = ['ko', 'en'] as const;
const patches = (w: World): unknown[] => w.calls.filter((c) => c.method === 'PATCH' && c.url === '/api/settings/ai-watch').map((c) => c.body);
const hasClass = (n: FakeNode, c: string): boolean => n.className.split(/\s+/).includes(c);
const badges = (n: FakeNode): FakeNode[] => n.all().filter((x) => hasClass(x, 'aiw'));

async function as(lang: Lang, role: string, setting: { feature: boolean; enabled: boolean }): Promise<World> {
  OVERRIDE.set('/api/me', me(role));
  OVERRIDE.set('GET /api/settings/ai-watch', { status: 200, json: setting });
  return boot(lang, '#/watch/ai');
}

/** 렌더된 페이지의 설정 칸(ⓘ 팝오버 포함)의 보이는 글자. */
function section(lang: Lang): string {
  const html = inlined(renderAppPage(lang));
  return visibleText(/<section class="spane" id="w-ai"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '');
}

async function click(w: World, id: string): Promise<void> {
  w.el(id).click();
  await settle();
}

describe.each(LANGS)('Ⓐ 설정 — AI 의심 메일 감시 (%s)', (lang) => {
  it('Ⓐ-1 소유자 · 꺼짐 → 스위치를 누르면 확인 대화상자(무엇을 · 어디서 · 경고만) → 확인하면 PATCH {enabled:true} → 켜짐', async () => {
    const w = await as(lang, 'owner', { feature: true, enabled: false });
    expect(w.el('w-ai').hidden).toBe(false);
    expect(w.el('aw-open').hidden).toBe(false);
    expect(w.el('aw-locked').hidden).toBe(true);
    const sw = w.el('aw-switch');
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(sw.getAttribute('aria-disabled')).toBeNull();
    expect(w.el('aw-st').textContent).toBe(t(lang, '꺼짐'));
    await click(w, 'aw-switch');
    expect(patches(w)).toEqual([]);
    expect(w.el('dlg-confirm').open).toBe(true);
    expect(w.el('dc-title').textContent).toBe(t(lang, 'AI 의심 메일 감시를 켤까요?'));
    const body = w.el('dc-body').textContent;
    expect(body).toContain(t(lang, '에이전트를 조종하려는 지시처럼 보이면 경고를 붙입니다. 메일을 막거나 지우지 않고, 오탐도 있습니다.'));
    expect(copyGuardHits(body)).toEqual([]);
    w.el('dc-ok').onclick?.();
    await settle();
    expect(patches(w)).toEqual([{ enabled: true }]);
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(w.el('aw-st').textContent).toBe(t(lang, '켜짐'));
    expect(w.el('aw-msg').textContent).toBe(t(lang, '켰습니다. 이제부터 받는 메일에 적용됩니다.'));
  });

  it('Ⓐ-1b 확인 대화상자에서 취소하면 아무것도 보내지 않는다', async () => {
    const w = await as(lang, 'owner', { feature: true, enabled: false });
    await click(w, 'aw-switch');
    w.el('dc-cancel').onclick?.();
    await settle();
    expect(patches(w)).toEqual([]);
    expect(w.el('aw-switch').getAttribute('aria-checked')).toBe('false');
  });

  it('Ⓐ-2 켜짐 → 누르면 바로 끈다(대화상자 없음)', async () => {
    const w = await as(lang, 'owner', { feature: true, enabled: true });
    expect(w.el('aw-line').textContent).toBe(t(lang, '수신 로그에 AI 의심 표시가 붙습니다. 언제든 끌 수 있습니다.'));
    await click(w, 'aw-switch');
    expect(w.el('dlg-confirm').open).toBe(false);
    expect(patches(w)).toEqual([{ enabled: false }]);
    expect(w.el('aw-switch').getAttribute('aria-checked')).toBe('false');
  });

  it('Ⓐ-3 관리자는 켤 수 없고(잠긴 스위치 · 이유) 끌 수는 있다 · 멤버는 둘 다 못 한다', async () => {
    const off = await as(lang, 'admin', { feature: true, enabled: false });
    expect(off.el('aw-switch').getAttribute('aria-disabled')).toBe('true');
    expect(off.el('aw-line').textContent).toBe(t(lang, '소유자만 켤 수 있습니다.'));
    await click(off, 'aw-switch');
    expect(off.el('dlg-confirm').open).toBe(false);
    expect(patches(off)).toEqual([]);

    const on = await as(lang, 'admin', { feature: true, enabled: true });
    expect(on.el('aw-switch').getAttribute('aria-disabled')).toBeNull();
    await click(on, 'aw-switch');
    expect(patches(on)).toEqual([{ enabled: false }]);

    const member = await as(lang, 'member', { feature: true, enabled: true });
    expect(member.el('aw-switch').getAttribute('aria-disabled')).toBe('true');
    await click(member, 'aw-switch');
    expect(patches(member)).toEqual([]);
  });

  it('Ⓐ-4 허용 목록에 없는 조직 = 잠김(베타 한 장 · 스위치 없음) · 빠진 채 켜진 조직은 끌 수 있다(다시 켤 수는 없다)', async () => {
    const locked = await as(lang, 'owner', { feature: false, enabled: false });
    expect(locked.el('aw-locked').hidden).toBe(false);
    expect(locked.el('aw-open').hidden).toBe(true);
    expect(section(lang)).toContain(t(lang, '초대받은 조직에만 열려 있는 기능입니다'));

    const leftover = await as(lang, 'owner', { feature: false, enabled: true });
    expect(leftover.el('aw-open').hidden).toBe(false);
    await click(leftover, 'aw-switch');
    expect(patches(leftover)).toEqual([{ enabled: false }]);
  });

  it('Ⓐ-5 켜기가 403 feature_not_enabled 면(그 사이 허용 목록에서 빠짐) 잠김으로 다시 그린다', async () => {
    OVERRIDE.set('PATCH /api/settings/ai-watch', { status: 403, json: { error: 'feature_not_enabled' } });
    const w = await as(lang, 'owner', { feature: true, enabled: false });
    await click(w, 'aw-switch');
    w.el('dc-ok').onclick?.();
    await settle();
    expect(w.el('aw-locked').hidden).toBe(false);
    expect(w.el('aw-open').hidden).toBe(true);
    expect(w.el('aw-msg').textContent).toBe(t(lang, '이 조직에는 이 기능이 열려 있지 않습니다.'));
  });

  it('Ⓐ-6 섹션 글자(마크업 · ⓘ 포함) — 영어 화면에 한글 없음 · copy-guard 통과 · 설명 한 줄에 "운영자 장비에서 분석" 고지', () => {
    const text = section(lang);
    expect(text.length).toBeGreaterThan(100);
    if (lang === 'en') expect(text).not.toMatch(HANGUL);
    expect(copyGuardHits(text)).toEqual([]);
    expect(text).toContain(t(lang, '경고만 붙이고 막지 않습니다. 제목과 본문 일부를 운영자 장비에서 분석합니다.'));
    // 보안 리뷰(2026-10-06): 제목도 보낸다 · 전송 중 최대 5분 암호화 대기 — "본문은 저장하지 않습니다" 류의 부정확한 말이 돌아오지 않게.
    expect(text).toContain(t(lang, '제목과 본문 일부만 보내고 주소 · 다른 헤더 · 첨부는 보내지 않습니다. 전송 중 암호화된 채 최대 5분 기다릴 수 있고, 처리 뒤에는 보관하지 않습니다. 기본 보호(수신 정책 · 위험 보류 · 발신 검사)는 항상 켜져 있습니다.'));
    expect(text).not.toMatch(/저장하지 않습니다|not stored|헤더 · 첨부는 보내지 않고/);
  });
});

const ROWS = [
  { id: 'm1', at: '2026-10-06T02:00:00Z', agentId: 'a1', agentName: 'founder', from: 'x@partner.example', subject: 'hello', verdict: 'delivered', reason: null, policyReason: null, injectionRisk: 'none', senderTrust: 'unknown', aiWatch: { status: 'flagged', band: 'high', modelVersion: 'laya-ml-aw-2026.10.1-int8', late: false } },
  { id: 'm2', at: '2026-10-06T01:59:00Z', agentId: 'a1', agentName: 'founder', from: 'y@partner.example', subject: 'mid', verdict: 'delivered', reason: null, policyReason: null, injectionRisk: 'none', senderTrust: 'unknown', aiWatch: { status: 'flagged', band: 'mid', modelVersion: 'laya-ml-aw-2026.10.1-int8', late: true } },
  { id: 'm3', at: '2026-10-06T01:58:00Z', agentId: 'a1', agentName: 'founder', from: 'z@partner.example', subject: 'p', verdict: 'delivered', reason: null, policyReason: null, injectionRisk: 'none', senderTrust: 'unknown', aiWatch: { status: 'pending', band: null, modelVersion: null, late: false } },
  { id: 'm4', at: '2026-10-06T01:57:00Z', agentId: 'a1', agentName: 'founder', from: 'z@partner.example', subject: 's', verdict: 'delivered', reason: null, policyReason: null, injectionRisk: 'none', senderTrust: 'unknown', aiWatch: { status: 'skipped', band: null, modelVersion: null, late: false } },
  { id: 'm5', at: '2026-10-06T01:56:00Z', agentId: 'a1', agentName: 'founder', from: 'z@partner.example', subject: 'c', verdict: 'delivered', reason: null, policyReason: null, injectionRisk: 'none', senderTrust: 'unknown', aiWatch: { status: 'clear', band: 'low', modelVersion: 'laya-ml-aw-2026.10.1-int8', late: false } },
  { id: 'm6', at: '2026-10-06T01:55:00Z', agentId: 'a1', agentName: 'founder', from: 'z@partner.example', subject: 'none', verdict: 'delivered', reason: null, policyReason: null, injectionRisk: 'none', senderTrust: 'seed' },
  { id: 'm7', at: '2026-10-06T01:54:00Z', agentId: 'a1', agentName: 'founder', from: 'z@partner.example', subject: 'odd', verdict: 'delivered', reason: null, policyReason: null, injectionRisk: 'none', senderTrust: 'unknown', aiWatch: { status: '<img src=x>', band: 'high' } },
];

async function inbound(lang: Lang, hash = '#/logs/inbound'): Promise<World> {
  OVERRIDE.set('/api/me', me('owner'));
  OVERRIDE.set('GET /api/logs?type=inbound&limit=50', { status: 200, json: { items: ROWS, next: null } });
  return boot(lang, hash);
}

describe.each(LANGS)('Ⓑ 수신 로그 — AI 감시 표시 (%s)', (lang) => {
  it('Ⓑ-1 상태마다 흑백 표시 하나 · 밴드는 3칸 막대 · 키 없는 행 · 모르는 상태는 그리지 않는다', async () => {
    const w = await inbound(lang);
    const rows = w.el('lg-body').children;
    expect(rows).toHaveLength(ROWS.length);
    const marks = rows.map((r) => badges(r));
    const label = (i: number): string => marks[i]?.[0]?.all().find((n) => hasClass(n, 'aiw-t'))?.textContent ?? '';
    const ticks = (i: number): number => (marks[i]?.[0]?.all() ?? []).filter((n) => n.tagName === 'I' && hasClass(n, 'on')).length;
    expect(marks.map((m) => m.length)).toEqual([1, 1, 1, 1, 1, 0, 0]);
    expect([0, 1, 2, 3, 4].map(label)).toEqual(['AI 의심', 'AI 의심', 'AI 확인 중', '판정 없음', 'AI 표시 없음'].map((k) => t(lang, k)));
    expect(marks.slice(0, 5).map((m) => m[0]?.className)).toEqual(['aiw aiw-f', 'aiw aiw-f', 'aiw aiw-p', 'aiw aiw-s', 'aiw aiw-c']);
    expect([ticks(0), ticks(1), ticks(2), ticks(4)]).toEqual([3, 2, 0, 0]);
    // 강도는 화면 낭독기에도(숨은 글자) · 툴팁은 "경고일 뿐"
    expect(marks[0]?.[0]?.textContent).toBe(`${t(lang, 'AI 의심')}${t(lang, ' · 강도 {b}').replace('{b}', t(lang, '높음'))}`);
    expect(marks[0]?.[0]?.title).toContain(t(lang, '분류 모델이 에이전트를 조종하려는 지시처럼 보인다고 표시했습니다. 경고일 뿐, 메일은 막히지 않았습니다.'));
    expect(marks[4]?.[0]?.title).toBe(t(lang, '분류 모델이 표시하지 않았습니다. 안전하다는 판정은 아닙니다.'));
    if (lang === 'en') for (const r of rows) expect(r.textContent).not.toMatch(HANGUL);
  });

  it('Ⓑ-2 상세 — "AI 감시" 칸 · 강도 · 모델 버전 · 늦게 도착 · 경고일 뿐이라는 줄', async () => {
    OVERRIDE.set('/api/logs/inbound/m2', { status: 200, json: { item: ROWS[1] } });
    const w = await inbound(lang, '#/logs/inbound/m2');
    await settle();
    const kv = w.el('dl-kv').textContent;
    expect(kv).toContain(t(lang, 'AI 감시'));
    const extra = w.el('dl-extra').textContent;
    expect(extra).toContain(t(lang, 'AI 의심 메일 감시'));
    expect(extra).toContain(t(lang, '중간'));
    expect(extra).toContain('laya-ml-aw-2026.10.1-int8');
    expect(extra).toContain(t(lang, '마감(30초) 뒤에 늦게 도착'));
    expect(extra).toContain(t(lang, '수신 정책 · 위험 보류 · 발신 검사는 이 표시와 관계없이 따로 판정합니다.'));
    expect(copyGuardHits(extra)).toEqual([]);
  });
});

describe('Ⓒ 문구', () => {
  it('Ⓒ-1 AI 감시 사전 문구(두 언어)는 copy-guard 를 지나고, 새 금지어가 실제로 목록에 있다', () => {
    const names = COPY_GUARD_BANNED.map((item) => item.name);
    for (const name of ['AI가 막/차단/보호', 'AI blocks/protects', '100%', '완벽']) expect(names).toContain(name);
    for (const lang of LANGS) {
      const hits = Object.entries(MESSAGES[lang])
        .filter(([ko]) => /AI|분류 모델|판정 없음|운영자 장비/.test(ko))
        .flatMap(([, v]) => copyGuardHits(v).map((hit) => `${hit}: ${v}`));
      expect(hits, lang).toEqual([]);
    }
  });
});
