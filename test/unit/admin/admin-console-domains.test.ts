/**
 * 콘솔(가짜 DOM) — 고객 도메인 M4(ADR-0014 단계 4 · `docs/internal/plans/custom-domains-stage2-4.md`).
 *   Ⓓ 도메인(2026-10-05 사이드바 1단 항목): 라우트(`#/domains[/{id}]` · 예전 `#/settings/domains[/{id}]` 리다이렉트) · 사이드바 순서 ·
 *     기능이 닫힌 조직은 잠김(베타) 상태 · 목록(상태 알약 · 사용 수) · 한 도메인(DNS 레코드 표 — 형식 · 이름(앞부분 + 전체) · 콘텐츠 · 우선순위 ·
 *     TTL · 프록시 · 레코드별 상태, `checks` 가 있을 때와 없을 때) · 정지 · 확인 대기 사유(다른 조직을 밝히지 않는다) · 지금 확인(60초) ·
 *     추가(거부 사유는 칸 아래) · 제거(주소 수 · 대표 에이전트 수).
 *   Ⓞ 한 번에 설정(2026-10 one-shot): 확인 대기도 레코드 전부 · 소유 TXT 는 서브도메인 이름(ⓘ 에 apex 도 인정) · DKIM 토큰 전에는 "준비 중" 한 줄 +
 *     2초 간격 다시 읽기(30초 뒤 "새로고침") · Domain Connect 단추 하나(지원할 때만 · https 만) · 업체에서 돌아오기(`?dc=1&d=` → 지금 확인 한 번).
 *   Ⓟ 대표 주소: 새 에이전트의 주소 도메인 · 별칭 도메인 · `대표로`(워밍업 경고) · 주소 없음 · @atmark.ai 주소 켜기({anchor:true}).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { NAV_ORG as NAV_ORG_MARKUP } from '../../../src/admin/ui/console/markup/shell';
import { ROUTER_JS } from '../../../src/admin/ui/console/router';
import { MESSAGES } from '../../../src/admin/ui/i18n';
import { renderAppPage } from '../../../src/admin/ui/index';

import { AGENT, boot, domainDetail, DOMAINS, type FakeNode, HANGUL, inlined, NAV_ORG, OVERRIDE, PLAN, preparingDetail, resetTeam, settle, t, type World } from './console-harness';
import vm from 'node:vm';

afterEach(() => {
  OVERRIDE.clear();
  resetTeam();
});

const LANGS = ['ko', 'en'] as const;
const hasClass = (n: FakeNode, c: string): boolean => n.className.split(/\s+/).includes(c);
const byClass = (n: FakeNode | undefined, c: string): FakeNode[] => (n?.all() ?? []).filter((x) => hasClass(x, c));
const texts = (n: FakeNode | undefined, c: string): string[] => byClass(n, c).map((x) => x.textContent);
/** DNS 레코드 표의 행 — 무리 머리(`dgrp`) · 레코드(`drr`) · 서명 준비 중(`dprep`). */
const recRows = (n: FakeNode): FakeNode[] => n.children.filter((r) => hasClass(r, 'drr'));
const cellOf = (r: FakeNode | undefined, k: string): FakeNode | undefined => r?.children.find((c) => hasClass(c, `dk-${k}`));
const FEATURE_OFF = { ...PLAN, features: { addressAliases: true, customDomains: false } };

describe('Ⓓ-0 라우터 · 사이드바', () => {
  const ctx = vm.createContext({});
  vm.runInContext(`${ROUTER_JS};this.parse=parseRoute;this.href=routeHref;`, ctx);
  const router = ctx as unknown as { parse: (h: string) => unknown; href: (r: unknown) => string };

  it('Ⓓ-0a #/domains · #/domains/{id} 왕복 · 더 깊은 경로는 모르는 경로', () => {
    expect(router.parse('#/domains')).toEqual({ view: 'domains' });
    expect(router.parse('#/domains/dm1')).toEqual({ view: 'domains', domain: 'dm1' });
    expect(router.href({ view: 'domains' })).toBe('#/domains');
    expect(router.href({ view: 'domains', domain: 'a/b' })).toBe('#/domains/a%2Fb');
    expect(router.parse(router.href({ view: 'domains', domain: 'a/b' }))).toEqual({ view: 'domains', domain: 'a/b' });
    expect(router.parse('#/domains/dm1/x')).toEqual({ view: 'overview', unknown: true });
    expect(router.parse('#/o/o1/domains/dm1')).toEqual({ view: 'domains', domain: 'dm1', org: 'o1' });
  });

  it('Ⓓ-0b 예전 #/settings/domains[/{id}] 는 새 경로로 리다이렉트 · 설정에는 도메인 섹션이 없다', () => {
    expect(router.parse('#/settings/domains')).toEqual({ view: 'domains', redirect: true });
    expect(router.parse('#/settings/domains/dm1')).toEqual({ view: 'domains', domain: 'dm1', redirect: true });
    expect(router.parse('#/settings/domains/dm1/x')).toEqual({ view: 'settings', section: 'org', redirect: true });
    expect(router.href({ view: 'settings', section: 'domains', domain: 'dm1' })).toBe('#/settings/org');
    expect(router.parse('#/settings/plan/x')).toEqual({ view: 'settings', section: 'org', redirect: true });
  });

  it.each(LANGS)('Ⓓ-0c (%s) 사이드바 순서 — 개요 · 에이전트 · 도메인 · 감시 · 로그 · 설정, 이름은 그 언어로', (lang) => {
    expect(NAV_ORG_MARKUP.map(([v]) => v)).toEqual(['overview', 'agents', 'domains', 'watch', 'logs', 'settings']);
    expect(NAV_ORG).toEqual(['overview', 'agents', 'domains', 'watch', 'logs', 'settings']);
    const html = inlined(renderAppPage(lang));
    const side = /<div class="scope" id="nav-org"><ul class="nav">([\s\S]*?)<\/ul><\/div>/.exec(html)?.[1] ?? '';
    const items = [...side.matchAll(/<a href="#\/([a-z]+)" id="n-\1">[\s\S]*?<span>([^<]+)(?:<!--[^>]*-->)?<\/span><\/a>/g)].map((m) => [m[1], m[2]]);
    expect(items.map(([v]) => v)).toEqual(['overview', 'agents', 'domains', 'watch', 'logs', 'settings']);
    expect(items.map(([, l]) => l)).toEqual(lang === 'ko' ? ['개요', '에이전트', '도메인', '감시', '로그', '설정'] : ['Overview', 'Agents', 'Domains', 'Watch', 'Logs', 'Settings']);
    // 설정 메뉴에는 도메인이 없다.
    expect(html).not.toContain('id="ns-domains"');
    expect(html).not.toContain('id="s-domains"');
  });

  it.each(LANGS)('Ⓓ-0d (%s) 예전 경로로 열면 주소가 새 경로로 고쳐지고 도메인 화면 · 사이드바 도메인이 현재 위치', async (lang) => {
    const w = await boot(lang, '#/settings/domains/dm1');
    expect(w.location.hash).toBe('#/domains/dm1');
    expect(w.el('v-domains').hidden).toBe(false);
    expect(w.el('v-settings').hidden).toBe(true);
    expect(w.el('dm-detail').hidden).toBe(false);
    expect(w.el('n-domains').getAttribute('aria-current')).toBe('location');
    await w.go('#/domains');
    expect(w.el('n-domains').getAttribute('aria-current')).toBe('page');
    expect(w.el('n-settings').getAttribute('aria-current')).toBe(null);
  });
});

describe.each(LANGS)('Ⓓ 도메인 (%s)', (lang) => {
  it('Ⓓ-1 잠김 — features.customDomains 가 아니면 항목은 보이고 화면은 베타 · 초대 전용 상태(추가 단추 · 표 없음 · /api/domains 안 부름)', async () => {
    OVERRIDE.set('/api/plan', { status: 200, json: FEATURE_OFF });
    const w = await boot(lang, '#/domains');
    expect(w.el('n-domains').hidden).toBe(false);
    expect(w.el('v-domains').hidden).toBe(false);
    expect(w.el('dm-locked').hidden).toBe(false);
    expect(w.el('dm-list-b').hidden).toBe(true);
    expect(w.el('dm-add').hidden).toBe(true);
    expect(w.el('dm-count').textContent).toBe('');
    // 잠김 상태의 글은 마크업 그대로(정적) — 그 언어로만.
    const locked = /<div class="dlock" id="dm-locked" hidden>([\s\S]*?)<\/div>/.exec(inlined(renderAppPage(lang)))?.[1] ?? '';
    expect(locked).toContain(t(lang, '초대받은 조직에만 열려 있는 기능입니다'));
    expect(locked).not.toMatch(/sales|upgrade|구매|업그레이드/i);
    if (lang === 'en') expect(locked).not.toMatch(HANGUL);
    expect(w.calls.some((c) => c.url.startsWith('/api/domains'))).toBe(false);
    // 한 도메인 주소로 와도 목록(잠김)으로 간다.
    await w.go('#/domains/dm1');
    expect(w.location.hash).toBe('#/domains');
    expect(w.calls.some((c) => c.url.startsWith('/api/domains'))).toBe(false);
  });

  it('Ⓓ-1b /api/plan 읽기 실패 — 잠김(베타)으로 보이지 않고 오류 한 줄 · 상세 주소에서 목록으로 튕기지 않는다 · /api/domains 안 부름', async () => {
    OVERRIDE.set('/api/plan', { status: 500, json: { error: 'internal' } });
    const w = await boot(lang, '#/domains/dm1');
    expect(w.location.hash).toBe('#/domains/dm1');
    expect(w.el('dm-locked').hidden).toBe(true);
    expect(w.el('dm-list-w').hidden).toBe(false);
    expect(w.el('dm-detail').hidden).toBe(true);
    expect(w.el('dm-add').hidden).toBe(true);
    expect(w.el('dm-msg').textContent).not.toBe('');
    expect(w.el('dm-msg').className).toContain('err');
    if (lang === 'en') expect(w.el('dm-msg').textContent).not.toMatch(HANGUL);
    expect(w.calls.some((c) => c.url.startsWith('/api/domains'))).toBe(false);
    // 다시 열면 다시 읽는다(실패는 기억하지 않는다) — 이번엔 성공해 상세가 보인다.
    OVERRIDE.delete('/api/plan');
    await w.go('#/overview');
    await w.go('#/domains/dm1');
    await settle();
    expect(w.el('dm-detail').hidden).toBe(false);
    expect(w.el('dm-msg').textContent).toBe('');
  });

  it('Ⓓ-2 목록 — 사용 수 · 행(이름 · 한 줄 · 상태 알약 · 추가한 날) · 행이 그 도메인으로 간다', async () => {
    const w = await boot(lang, '#/domains');
    expect(w.el('dm-locked').hidden).toBe(true);
    expect(w.el('dm-list-b').hidden).toBe(false);
    expect(w.el('dm-list-w').hidden).toBe(false);
    expect(w.el('dm-detail').hidden).toBe(true);
    expect(w.el('dm-count').textContent).toBe('2 / 3');
    expect(w.el('dm-add').hidden).toBe(false);
    expect(w.el('dm-add').disabled).toBe(false);
    const rows = w.el('dm-body').children;
    expect(rows.map((r) => byClass(r, 'strong')[0]?.textContent)).toEqual(['agents.example.com', 'mail.example.org']);
    expect(rows.map((r) => texts(r, 'pill'))).toEqual([[lang === 'ko' ? '사용 중' : 'Active'], [t(lang, '확인 대기')]]);
    expect(texts(rows[0], 'sub')).toEqual([t(lang, '수신 · 발신 준비됨')]);
    expect(byClass(rows[1], 'strong')[0]?.href).toBe('#/domains/dm2');
  });

  it('Ⓓ-3 한 도메인(사용 중) — DNS 레코드 표: 무리 순서 · 칸(형식 · 앞부분 + 전체 이름 · 콘텐츠 · 우선순위 · TTL 자동 · 프록시 DNS 전용) · 복사 단추', async () => {
    const w = await boot(lang, '#/domains/dm1');
    expect(w.el('dm-list-w').hidden).toBe(true);
    expect(w.el('dm-detail').hidden).toBe(false);
    expect(w.el('dd-name').textContent).toBe('agents.example.com');
    expect(w.el('dd-ready').hidden).toBe(false);
    expect(w.el('dd-alert').hidden).toBe(true);
    expect(w.el('dd-steps').hidden).toBe(false);
    const html = inlined(renderAppPage(lang));
    expect(/<p class="small muted" id="dd-howto">([^<]+)<\/p>/.exec(html)?.[1]).toBe(t(lang, 'DNS 공급자(예: Cloudflare)에 아래 레코드를 그대로 추가하세요.'));
    expect([...html.matchAll(/<table class="dnst" id="dd-tbl"><thead><tr>([\s\S]*?)<\/tr>/g)][0]?.[1]?.match(/<th scope="col">([^<]+)<\/th>/g)?.map((x) => x.replace(/<[^>]+>/g, ''))).toEqual(
      ['형식', '이름', '콘텐츠', '우선순위', 'TTL', '프록시 상태', '상태'].map((k) => (k === 'TTL' ? k : t(lang, k))),
    );
    const tb = w.el('dd-recs');
    // 무리 머리 — 소유 확인 → 메일 받기 → 반송 주소(MAIL FROM) → 서명(DKIM) → DMARC(권장).
    expect(tb.children.filter((r) => hasClass(r, 'dgrp')).map((r) => r.textContent)).toEqual(['소유 확인', '메일 받기', '반송 주소(MAIL FROM)', '서명(DKIM)', 'DMARC(권장)'].map((k) => t(lang, k)));
    const rows = recRows(tb);
    expect(rows.map((r) => r.getAttribute('data-purpose'))).toEqual(['ownership', 'inbound_mx', 'mail_from_mx', 'mail_from_spf', 'dkim', 'dkim', 'dkim', 'dmarc']);
    expect(rows.map((r) => cellOf(r, 'type')?.textContent)).toEqual(['TXT', 'MX', 'MX', 'TXT', 'CNAME', 'CNAME', 'CNAME', 'TXT']);
    // 이름 — 굵은 앞부분(넣을 값, 복사 단추) + 회색 전체 이름. 받는 MX 의 앞부분은 서브도메인 라벨.
    // 소유 TXT 는 서브도메인 이름 아래(2026-10 one-shot — apex 도 인정되지만 보여 주는 것은 하나).
    expect(texts(cellOf(rows[0], 'name'), 'rel')).toEqual(['_atmark-challenge.agents']);
    expect(texts(cellOf(rows[0], 'name'), 'dfq')).toEqual(['_atmark-challenge.agents.example.com']);
    expect(texts(cellOf(rows[1], 'name'), 'rel')).toEqual(['agents']);
    expect(texts(cellOf(rows[2], 'name'), 'rel')).toEqual(['bounce.agents']);
    expect(texts(cellOf(rows[4], 'name'), 'rel')).toEqual(['k1._domainkey.agents']);
    expect(texts(cellOf(rows[7], 'name'), 'rel')).toEqual(['_dmarc.agents']);
    expect(texts(cellOf(rows[7], 'name'), 'dfq')).toEqual(['_dmarc.agents.example.com']);
    expect(texts(cellOf(rows[7], 'val'), 'dv')).toEqual(['v=DMARC1; p=none']);
    // 콘텐츠 — MX 는 호스트만(우선순위는 제 칸), 그 밖은 값 그대로.
    expect(texts(cellOf(rows[0], 'val'), 'dv')).toEqual(['atmark-domain-verification=tok']);
    expect(texts(cellOf(rows[1], 'val'), 'dv')).toEqual(['inbound-smtp.ap-northeast-2.amazonaws.com']);
    expect(texts(cellOf(rows[4], 'val'), 'dv')).toEqual(['k1.dkim.amazonses.com']);
    expect(rows.map((r) => cellOf(r, 'prio')?.textContent)).toEqual(['—', '10', '10', '—', '—', '—', '—', '—']);
    expect(new Set(rows.map((r) => cellOf(r, 'ttl')?.textContent))).toEqual(new Set([t(lang, '자동')]));
    // 프록시 — 전부 DNS 전용, 글자만(점 · 강조 없음 — 2026-10-15 F21). '!' 알약은 CNAME 확인이 실패했을 때만(Ⓓ-4b).
    expect(new Set(rows.map((r) => cellOf(r, 'proxy')?.textContent))).toEqual(new Set([t(lang, 'DNS 전용')]));
    expect(rows.map((r) => byClass(cellOf(r, 'proxy'), 'pill').length)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    // DMARC 는 권장 — 확인하지 않으므로 상태 대신 '권장'(테두리 · 무채색).
    expect(texts(cellOf(rows[7], 'st'), 'pill')).toEqual([t(lang, '권장')]);
    expect(byClass(cellOf(rows[7], 'st'), 'pill')[0]?.className).toBe('pill tag');
    // 복사 단추 — 이름 · 콘텐츠 하나씩.
    expect(byClass(rows[0], 'icon-btn').map((b) => b.getAttribute('aria-label'))).toEqual([t(lang, '이름 복사'), t(lang, '콘텐츠 복사')]);
    expect(tb.children.some((r) => hasClass(r, 'dprep'))).toBe(false);
    expect(w.el('dd-check').hidden).toBe(false);
    expect(w.el('dd-remove').hidden).toBe(false);
    if (lang === 'en') expect(w.el('dd-steps').textContent).not.toMatch(HANGUL);
  });

  it('Ⓓ-4 확인 대기 — 남은 시간 · 레코드 전부(DKIM 포함, 자리표시 없음) · checks 없음(옛 서버)이면 칸에서 접는다', async () => {
    const w = await boot(lang, '#/domains/dm2');
    expect(w.el('dd-left-w').hidden).toBe(false);
    const tb = w.el('dd-recs');
    expect(recRows(tb).map((r) => r.getAttribute('data-purpose'))).toEqual(['ownership', 'inbound_mx', 'mail_from_mx', 'mail_from_spf', 'dkim', 'dkim', 'dkim', 'dmarc']);
    expect(tb.children.some((r) => hasClass(r, 'dprep') || hasClass(r, 'dwait'))).toBe(false);
    // pending · dkim/mailFrom not_started · inboundMx unknown → 대기 중 · 확인 전 … · DMARC 는 언제나 권장.
    expect(recRows(tb).map((r) => texts(cellOf(r, 'st'), 'pill')[0])).toEqual(['대기 중', '확인 전', '확인 전', '확인 전', '확인 전', '확인 전', '확인 전', '권장'].map((k) => t(lang, k)));
    expect(w.el('dd-zone-dl').disabled).toBe(false);
  });

  it('Ⓓ-4b 레코드별 상태 — checks 가 있으면 그것을 따른다(소유 → TXT · 수신 MX · MAIL FROM 두 줄 · DKIM 세 줄) · 알약 모양', async () => {
    const d = { ...domainDetail(DOMAINS[0]), checks: { ownership: 'ok', inboundMx: 'pending', mailFrom: 'failed', dkim: 'not_checked' } };
    OVERRIDE.set('/api/domains/dm1', { status: 200, json: { item: d } });
    const w = await boot(lang, '#/domains/dm1');
    const rows = recRows(w.el('dd-recs'));
    expect(rows.map((r) => texts(cellOf(r, 'st'), 'pill')[0])).toEqual(['확인됨', '대기 중', '실패', '실패', '확인 전', '확인 전', '확인 전', '권장'].map((k) => t(lang, k)));
    // 레코드 상태도 전역 상태 알약(2026-10-15 F21) — 확인됨 = 점 · 대기 = 반점 · 실패 = ✕(빨강 — 고칠 오류) · 확인 전 = 빈 원 · 권장 = 분류 칩.
    expect(rows.map((r) => byClass(cellOf(r, 'st'), 'pill')[0]?.className)).toEqual(['pill on', 'pill wait', 'pill bad rsfail', 'pill bad rsfail', 'pill dim', 'pill dim', 'pill dim', 'pill tag']);
  });

  it.each([
    // [이름, 행 칸, 기대(소유 · 수신 MX · MAIL FROM · DKIM)]
    ['사용 중 · 전부 성공', { status: 'verified', dkimStatus: 'success', mailFromStatus: 'success', inboundMxStatus: 'ses' }, ['확인됨', '확인됨', '확인됨', '확인됨']],
    ['확인 중 · 기다림', { status: 'verifying', dkimStatus: 'pending', mailFromStatus: 'pending', inboundMxStatus: 'missing' }, ['확인됨', '대기 중', '대기 중', '대기 중']],
    ['다른 메일 서버 · 서명 실패', { status: 'verified', dkimStatus: 'failed', mailFromStatus: 'temporary_failure', inboundMxStatus: 'other' }, ['확인됨', '실패', '실패', '실패']],
    ['소유 레코드 사라짐', { status: 'suspended', suspendedReason: 'ownership_lost', dkimStatus: 'success', mailFromStatus: 'success', inboundMxStatus: 'ses' }, ['실패', '확인됨', '확인됨', '확인됨']],
  ] as const)('Ⓓ-4c checks 없이 칸에서 접기 — %s', async (_name, row, want) => {
    const d: Record<string, unknown> = { ...domainDetail(DOMAINS[0]), ...row };
    delete d['checks'];
    OVERRIDE.set('/api/domains/dm1', { status: 200, json: { item: d } });
    const w = await boot(lang, '#/domains/dm1');
    const by = (p: string): string | undefined => texts(cellOf(recRows(w.el('dd-recs')).find((r) => r.getAttribute('data-purpose') === p), 'st'), 'pill')[0];
    expect([by('ownership'), by('inbound_mx'), by('mail_from_mx'), by('dkim')]).toEqual(want.map((k) => t(lang, k)));
    expect(by('mail_from_spf')).toBe(by('mail_from_mx'));
    expect(by('dmarc')).toBe(t(lang, '권장'));
  });

  it('Ⓓ-5 확인 대기 사유 registrable_taken — 남은 TXT 를 지우라고만 말한다(다른 조직을 밝히지 않는다) · 지원 주소', async () => {
    const d = { ...domainDetail(DOMAINS[1]), pendingReason: 'registrable_taken' };
    OVERRIDE.set('/api/domains/dm2', { status: 200, json: { item: d } });
    const w = await boot(lang, '#/domains/dm2');
    expect(w.el('dd-alert').hidden).toBe(false);
    const all = `${w.el('dd-alert-t').textContent} ${w.el('dd-alert-d').textContent}`;
    expect(all).toContain('_atmark-challenge');
    expect(all).toContain('example.org');
    expect(all.toLowerCase()).not.toMatch(/organi[sz]ation|조직/);
    expect(w.el('dd-alert-a').textContent).toContain('support@atmark.ai');
  });

  it.each(['ownership_lost', 'dkim_failed', 'reputation', 'operator', 'plan_limit'])('Ⓓ-6 정지 %s — 알약에 사유 · 알림 상자', async (reason) => {
    const d = { ...domainDetail(DOMAINS[0]), status: 'suspended', suspendedReason: reason, removalDueAt: reason === 'ownership_lost' ? '2026-10-10T00:00:00.000Z' : null };
    OVERRIDE.set('/api/domains/dm1', { status: 200, json: { item: d } });
    const w = await boot(lang, '#/domains/dm1');
    expect(w.el('dd-pill').textContent.startsWith(t(lang, '정지됨'))).toBe(true);
    expect(w.el('dd-pill').className).toBe('pill bad');
    expect(w.el('dd-alert').hidden).toBe(false);
    expect(w.el('dd-alert-t').textContent).not.toBe('');
    expect(w.el('dd-due-w').hidden).toBe(reason !== 'ownership_lost');
    if (lang === 'en') expect(w.el('dd-alert').textContent).not.toMatch(HANGUL);
  });

  it('Ⓓ-6b 제거된 도메인 — 레코드 표 · 지금 확인 · 제거가 없다', async () => {
    const d = { ...domainDetail(DOMAINS[0]), status: 'removed', removedAt: '2026-10-01T00:00:00.000Z', records: [] };
    OVERRIDE.set('/api/domains/dm1', { status: 200, json: { item: d } });
    const w = await boot(lang, '#/domains/dm1');
    expect(w.el('dd-steps').hidden).toBe(true);
    expect(w.el('dd-check').hidden).toBe(true);
    expect(w.el('dd-dz').hidden).toBe(true); // 제거는 맨 아래 위험 구역(F06) — 제거된 도메인에서는 구역째 숨는다
    expect(w.el('dd-alert').hidden).toBe(false);
  });

  it('Ⓓ-7 지금 확인 — POST …/check · 60초 동안 잠기고 남은 초를 말한다', async () => {
    const w = await boot(lang, '#/domains/dm1');
    w.el('dd-check').dispatch('click');
    await settle();
    expect(w.calls.some((c) => c.method === 'POST' && c.url === '/api/domains/dm1/check')).toBe(true);
    expect(w.el('dd-check').disabled).toBe(true);
    expect(w.el('dd-cool').textContent).toMatch(/60/);
  });

  it('Ⓓ-8 추가 — 거부 사유(서버 판정 코드)는 칸 바로 아래 · 성공하면 그 도메인 화면', async () => {
    const w = await boot(lang, '#/domains');
    w.el('dm-add').dispatch('click');
    expect(w.el('dlg-domadd').open).toBe(true);
    expect(w.el('dad-n').textContent).toBe('2 / 3');
    OVERRIDE.set('POST /api/domains', { status: 400, json: { error: 'registrable_apex' } });
    w.el('dad-name').value = 'Example.com';
    w.el('dad-form').dispatch('submit');
    await settle();
    expect(w.calls.find((c) => c.method === 'POST' && c.url === '/api/domains')?.body).toEqual({ domain: 'example.com' });
    expect(w.el('dad-name').getAttribute('aria-invalid')).toBe('true');
    expect(w.el('dlg-domadd').open).toBe(true);
    OVERRIDE.delete('POST /api/domains');
    w.el('dad-name').value = 'agents.lumen.example';
    w.el('dad-form').dispatch('submit');
    await settle();
    expect(w.el('dlg-domadd').open).toBe(false);
    expect(w.location.hash).toBe('#/domains/dm9');
  });

  it('Ⓓ-9 제거 — 빨간 대화상자 · 대표 에이전트 수 · 주소 폐기는 고를 때만 · DELETE {releaseAddresses}', async () => {
    const w = await boot(lang, '#/domains/dm1');
    w.el('dd-remove').dispatch('click');
    expect(w.el('dlg-domrm').open).toBe(true);
    expect(w.el('dr-go').className).toBe('btn danger solid');
    expect(w.el('dr-primary').hidden).toBe(false);
    expect(w.el('dr-primary-t').textContent).toContain('1');
    expect(w.el('dr-release-w').hidden).toBe(false);
    expect(w.el('dr-release').checked).toBe(false);
    w.el('dr-release').checked = true;
    w.el('dr-form').dispatch('submit');
    await settle();
    expect(w.calls.find((c) => c.method === 'DELETE' && c.url === '/api/domains/dm1')?.body).toEqual({ releaseAddresses: true });
    expect(w.location.hash).toBe('#/domains');
  });

  it('Ⓓ-10 member — 추가 · 지금 확인 · 제거가 잠긴다', async () => {
    OVERRIDE.set('/api/me', {
      status: 200,
      json: { organization: { id: 'o1', name: 'Chronostasis', ownerEmail: 'owner@example.com', reviewStatus: 'active', role: 'member' }, orgKillSwitch: { ownerPaused: false, platformFrozen: false }, plan: { code: 'beta', basis: 'row', maxAgents: 10, overLimit: [] }, csrf: 'c', memberships: [{ organizationId: 'o1', name: 'Chronostasis', role: 'member' }] },
    });
    const w = await boot(lang, '#/domains');
    expect(w.el('dm-add').disabled).toBe(true);
    await w.go('#/domains/dm1');
    expect(w.el('dd-check').disabled).toBe(true);
    expect(w.el('dd-remove').disabled).toBe(true);
  });
});

const tick = async (n = 3): Promise<void> => {
  for (let i = 0; i < n; i++) await settle();
};
const prepRow = (w: World): FakeNode | undefined => w.el('dd-recs').children.find((r) => hasClass(r, 'dprep'));
const getsOf = (w: World, url: string): number => w.calls.filter((c) => c.method === 'GET' && c.url === url).length;
const CONNECT_INFO = { supported: true, providerName: 'Cloudflare' };
const CONNECT_ON = { supported: true, providerName: 'Cloudflare', applyUrl: 'https://dc.example.net/v2/domainTemplates/providers/atmark.ai/services/mail/apply?domain=example.org&sig=x', records: [] };

describe.each(LANGS)('Ⓞ 한 번에 설정 (%s)', (lang) => {
  it('Ⓞ-1 소유 TXT 안내 — 서브도메인 이름 아래 한 줄 + ⓘ 안에 "최상위 도메인 이름도 인정" · 예전 "소유 확인 뒤에 나온다" 문장이 없다', () => {
    const html = inlined(renderAppPage(lang));
    const notes = /<ul class="dnotes">([\s\S]*?)<\/ul>/.exec(html)?.[1] ?? '';
    expect(notes).toContain(t(lang, '소유 확인 TXT는 이 서브도메인 이름 아래에 넣습니다.'));
    const own = /<div class="tip-pop" id="tip-own" hidden>([\s\S]*?)<\/div>/.exec(notes)?.[1] ?? '';
    expect(own).toContain('_atmark-challenge.example.com');
    expect(own).toContain(t(lang, '최상위 도메인 이름(예: _atmark-challenge.example.com)에 같은 값을 넣어도 인정됩니다. 둘 중 하나만 있으면 됩니다.'));
    for (const gone of ['소유가 확인되면 여기에 CNAME 레코드 3개가 나타납니다.', 'DKIM 레코드는 소유 확인 뒤에 나옵니다 — 그때 파일을 한 번 더 받으세요.']) {
      expect(html).not.toContain(gone);
      expect(MESSAGES.en[gone]).toBeUndefined();
    }
    if (lang === 'en') expect(notes).not.toMatch(HANGUL);
  });

  it('Ⓞ-1b DMARC 안내 — 상시 한 줄은 "권장" · ⓘ 안에 최상위 도메인 정책 · p=none 으로 시작 · 예전 "선택" 문장이 없다', () => {
    const html = inlined(renderAppPage(lang));
    const notes = /<ul class="dnotes">([\s\S]*?)<\/ul>/.exec(html)?.[1] ?? '';
    expect(notes).toContain(t(lang, '레코드를 모두 넣으면 확인이 저절로 이어집니다. DMARC는 권장입니다.'));
    const tip = /<div class="tip-pop" id="tip-dmarc" hidden>([\s\S]*?)<\/div>/.exec(notes)?.[1] ?? '';
    expect(tip).toContain(t(lang, '최상위 도메인에 DMARC가 이미 있으면 그 정책이 적용됩니다. 처음엔 p=none으로 시작하세요.'));
    expect(tip).toContain('p=none');
    expect(html).not.toContain('DMARC 레코드는 선택입니다.');
    expect(MESSAGES.en['레코드를 모두 넣으면 확인이 저절로 이어집니다. DMARC 레코드는 선택입니다.']).toBeUndefined();
    if (lang === 'en') expect(notes).not.toMatch(HANGUL);
  });

  it('Ⓞ-2 DKIM 토큰 전 — 서명 무리에 "준비하고 있습니다" 한 줄 · 2초 간격으로 다시 읽다가 토큰이 오면 세 줄로 바뀌고 멈춘다', async () => {
    OVERRIDE.set('/api/domains/dm2', { status: 200, json: { item: preparingDetail(DOMAINS[1]) } });
    const w = await boot(lang, '#/domains/dm2', { timers: 'fast' });
    expect(recRows(w.el('dd-recs')).map((r) => r.getAttribute('data-purpose'))).toEqual(['ownership', 'inbound_mx', 'mail_from_mx', 'mail_from_spf', 'dmarc']);
    expect(prepRow(w)?.textContent).toContain(t(lang, '레코드를 준비하고 있습니다…'));
    expect(w.delays).toContain(2000);
    expect(getsOf(w, '/api/domains/dm2')).toBeGreaterThanOrEqual(2);
    // 준비되는 동안에는 Domain Connect 를 묻지 않는다(토큰이 없으면 서명할 수 없다).
    expect(w.calls.some((c) => c.url === '/api/domains/dm2/connect')).toBe(false);
    if (lang === 'en') expect(prepRow(w)?.textContent).not.toMatch(HANGUL);
    OVERRIDE.set('/api/domains/dm2', { status: 200, json: { item: domainDetail(DOMAINS[1]) } });
    await tick();
    expect(prepRow(w)).toBeUndefined();
    expect(recRows(w.el('dd-recs')).filter((r) => r.getAttribute('data-purpose') === 'dkim')).toHaveLength(3);
    const settled = getsOf(w, '/api/domains/dm2');
    await tick();
    expect(getsOf(w, '/api/domains/dm2')).toBe(settled);
  });

  it('Ⓞ-3 30초가 지나도 토큰이 없으면 — 다시 읽기를 멈추고 "새로고침" 한 줄 · 누르면 다시 읽는다', async () => {
    OVERRIDE.set('/api/domains/dm2', { status: 200, json: { item: preparingDetail(DOMAINS[1]) } });
    const w = await boot(lang, '#/domains/dm2', { timers: 'fast' });
    const real = Date.now;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => real() + 31_000);
    try {
      await tick();
      const row = prepRow(w);
      expect(row?.textContent).toContain(t(lang, '레코드가 아직 준비되지 않았습니다. 잠시 뒤 새로고침하세요.'));
      const stopped = getsOf(w, '/api/domains/dm2');
      await tick();
      expect(getsOf(w, '/api/domains/dm2')).toBe(stopped);
      const retry = row?.all().find((n) => n.tagName === 'BUTTON');
      expect(retry?.textContent).toBe(t(lang, '새로고침'));
      OVERRIDE.set('/api/domains/dm2', { status: 200, json: { item: domainDetail(DOMAINS[1]) } });
      retry?.click();
      await tick();
      expect(getsOf(w, '/api/domains/dm2')).toBe(stopped + 1);
      expect(prepRow(w)).toBeUndefined();
    } finally {
      now.mockRestore();
    }
  });

  it('Ⓞ-4 Domain Connect — 열 때는 GET(지원 여부만) · 단추 "{업체}로 연결" · 누르면 POST 로 발급받아 그 URL 로 · GET 은 도메인마다 한 번', async () => {
    OVERRIDE.set('GET /api/domains/dm2/connect', { status: 200, json: CONNECT_INFO });
    OVERRIDE.set('POST /api/domains/dm2/connect', { status: 200, json: CONNECT_ON });
    const w = await boot(lang, '#/domains/dm2');
    expect(w.el('dd-dc').hidden).toBe(false);
    expect(w.el('dd-dc-t').textContent).toBe(t(lang, '{p}로 연결').replace('{p}', 'Cloudflare'));
    // 화면을 연 것만으로는 발급하지 않는다(감사 · 횟수는 누를 때만).
    expect(w.calls.some((c) => c.method === 'POST' && c.url === '/api/domains/dm2/connect')).toBe(false);
    w.el('dd-dc').click();
    await settle();
    expect(w.calls.filter((c) => c.method === 'POST' && c.url === '/api/domains/dm2/connect')).toHaveLength(1);
    expect(w.location.href).toBe(CONNECT_ON.applyUrl);
    await w.go('#/domains/dm1');
    expect(w.el('dd-dc').hidden).toBe(true);
    await w.go('#/domains/dm2');
    expect(w.el('dd-dc').hidden).toBe(false);
    expect(getsOf(w, '/api/domains/dm2/connect')).toBe(1);
    // 사용 중 도메인은 묻지 않는다.
    expect(w.calls.some((c) => c.url === '/api/domains/dm1/connect')).toBe(false);
  });

  it.each([
    ['https 가 아닌 URL', { ...CONNECT_ON, applyUrl: 'http://dc.example.net/apply' }],
    ['URL 에 공백', { ...CONNECT_ON, applyUrl: 'https://dc.example.net/a b' }],
    ['발급 때 업체 미지원', { supported: false }],
  ] as const)('Ⓞ-5 누른 뒤 따라가지 않는다 — %s · 단추가 숨고 직접 넣으라는 한 줄', async (_name, json) => {
    OVERRIDE.set('GET /api/domains/dm2/connect', { status: 200, json: CONNECT_INFO });
    OVERRIDE.set('POST /api/domains/dm2/connect', { status: 200, json });
    const w = await boot(lang, '#/domains/dm2');
    w.el('dd-dc').click();
    await settle();
    expect(w.location.href).toBeUndefined();
    expect(w.el('dd-dc').hidden).toBe(true);
    expect(w.el('dd-msg').textContent).toBe(t(lang, '지금은 자동 입력을 쓸 수 없습니다. 아래 레코드를 직접 넣으세요.'));
  });

  it('Ⓞ-5b GET 이 지원하지 않는다고 하면 단추가 없다', async () => {
    OVERRIDE.set('GET /api/domains/dm2/connect', { status: 200, json: { supported: false } });
    const w = await boot(lang, '#/domains/dm2');
    expect(w.el('dd-dc').hidden).toBe(true);
    w.el('dd-dc').click();
    await settle();
    expect(w.calls.some((c) => c.method === 'POST' && c.url.endsWith('/connect'))).toBe(false);
  });

  it('Ⓞ-5c 누른 뒤 429(조직 시간당 상한) — 이동하지 않고 "잠시 뒤 다시" 한 줄 · 단추는 남는다', async () => {
    OVERRIDE.set('GET /api/domains/dm2/connect', { status: 200, json: CONNECT_INFO });
    OVERRIDE.set('POST /api/domains/dm2/connect', { status: 429, json: { error: 'domain_connect_rate_limited' } });
    const w = await boot(lang, '#/domains/dm2');
    w.el('dd-dc').click();
    await settle();
    expect(w.location.href).toBeUndefined();
    expect(w.el('dd-dc').hidden).toBe(false);
    expect(w.el('dd-msg').textContent).toBe(t(lang, '자동 입력을 너무 자주 눌렀습니다. 잠시 뒤 다시 시도하세요.'));
    if (lang === 'en') expect(w.el('dd-msg').textContent).not.toMatch(HANGUL);
  });

  it('Ⓞ-6 member 는 Domain Connect 를 묻지 않는다(admin 전용)', async () => {
    OVERRIDE.set('/api/me', {
      status: 200,
      json: { organization: { id: 'o1', name: 'Chronostasis', ownerEmail: 'owner@example.com', reviewStatus: 'active', role: 'member' }, orgKillSwitch: { ownerPaused: false, platformFrozen: false }, plan: { code: 'beta', basis: 'row', maxAgents: 10, overLimit: [] }, csrf: 'c', memberships: [{ organizationId: 'o1', name: 'Chronostasis', role: 'member' }] },
    });
    OVERRIDE.set('/api/domains/dm2/connect', { status: 200, json: CONNECT_ON });
    const w = await boot(lang, '#/domains/dm2');
    expect(w.el('dd-dc').hidden).toBe(true);
    expect(w.calls.some((c) => c.url === '/api/domains/dm2/connect')).toBe(false);
  });

  it.each([
    ['확인 대기 사유 subdomain_has_mail', { pendingReason: 'subdomain_has_mail' }],
    ['수신 MX 가 다른 곳(other)', { inboundMxStatus: 'other' }],
  ] as const)('Ⓞ-6b 다른 메일 서버가 있는 서브도메인(%s) — 묻지 않고 단추 대신 한 줄(보안 리뷰 M3)', async (_name, extra) => {
    OVERRIDE.set('/api/domains/dm2', { status: 200, json: { item: { ...domainDetail(DOMAINS[1]), ...extra } } });
    OVERRIDE.set('/api/domains/dm2/connect', { status: 200, json: CONNECT_ON });
    const w = await boot(lang, '#/domains/dm2');
    expect(w.el('dd-dc').hidden).toBe(true);
    expect(w.el('dd-dc-mail').hidden).toBe(false);
    expect(w.calls.some((c) => c.url === '/api/domains/dm2/connect')).toBe(false);
    const html = inlined(renderAppPage(lang));
    expect(/<p class="small muted" id="dd-dc-mail" hidden>([^<]+)<\/p>/.exec(html)?.[1]).toBe(t(lang, '이 서브도메인에는 다른 메일 서버가 있어 자동 입력을 쓸 수 없습니다.'));
  });

  it('Ⓞ-6c 서버(GET)가 409 domain_connect_existing_mail 이면 그 한 줄 · 그 밖의 오류면 조용히 단추 없음', async () => {
    OVERRIDE.set('/api/domains/dm2/connect', { status: 409, json: { error: 'domain_connect_existing_mail' } });
    const w = await boot(lang, '#/domains/dm2');
    expect(w.el('dd-dc').hidden).toBe(true);
    expect(w.el('dd-dc-mail').hidden).toBe(false);
    OVERRIDE.set('/api/domains/dm2/connect', { status: 429, json: { error: 'domain_connect_rate_limited' } });
    const limited = await boot(lang, '#/domains/dm2');
    expect(limited.el('dd-dc').hidden).toBe(true);
    expect(limited.el('dd-dc-mail').hidden).toBe(true);
    expect(limited.el('dd-msg').textContent).toBe('');
  });

  it('Ⓞ-7 업체에서 돌아오기 — /app?dc=1&d=dm2 → #/domains/dm2 · 쿼리 지움 · 지금 확인 한 번 · 60초 잠김 · 알림 · 다시 열어도 또 부르지 않는다', async () => {
    const w = await boot(lang, '', { search: '?dc=1&d=dm2' });
    expect(w.location.hash).toBe('#/domains/dm2');
    expect(w.location.search).toBe('');
    expect(w.location.replaced).toContain('replace:/app#/domains/dm2');
    const checks = () => w.calls.filter((c) => c.method === 'POST' && c.url === '/api/domains/dm2/check').length;
    expect(checks()).toBe(1);
    expect(w.el('dd-check').disabled).toBe(true);
    expect(w.el('toasts').children.map((c) => c.textContent)).toContain(t(lang, 'DNS 업체에서 레코드를 넣었습니다. 확인을 시작했습니다.'));
    await w.go('#/domains');
    await w.go('#/domains/dm2');
    expect(checks()).toBe(1);
  });

  it('Ⓞ-8 업체에서 취소하고 돌아오기(error=) — 지금 확인을 부르지 않고 직접 넣어도 된다고만 알린다', async () => {
    const w = await boot(lang, '', { search: '?dc=1&d=dm2&error=access_denied' });
    expect(w.location.hash).toBe('#/domains/dm2');
    expect(w.calls.some((c) => c.method === 'POST' && c.url === '/api/domains/dm2/check')).toBe(false);
    expect(w.el('toasts').children.map((c) => c.textContent)).toContain(t(lang, 'DNS 업체에서 연결을 마치지 않았습니다. 아래 레코드를 직접 넣어도 됩니다.'));
  });

  it('Ⓞ-9 돌아오기 쿼리가 없으면 아무것도 하지 않는다 · 엉뚱한 d 는 경로로 쓰지 않는다', async () => {
    const plain = await boot(lang, '#/domains/dm2');
    expect(plain.calls.some((c) => c.method === 'POST')).toBe(false);
    const bad = await boot(lang, '#/overview', { search: '?dc=1&d=../../x' });
    expect(bad.location.hash).toBe('#/overview');
    expect(bad.location.search).toBe('');
    expect(bad.calls.some((c) => c.method === 'POST')).toBe(false);
  });
});

describe.each(LANGS)('Ⓟ 대표 주소 (%s)', (lang) => {
  it('Ⓟ-1 새 에이전트 — 확인된 도메인이 있으면 주소 도메인 고르기 · 고르면 접미 · 안내 · POST {domain, primary:custom}', async () => {
    const w = await boot(lang, '#/agents');
    w.el('na-open').dispatch('click');
    await settle();
    // 도메인 고르기 = 접미사 자리(2026-10-15 F48) — @atmark.ai 가 두 번 보이지 않는다.
    expect(w.el('na-dom').hidden).toBe(false);
    expect(w.el('na-suf-w').hidden).toBe(true);
    expect(w.el('na-dom').children.map((o) => o.value)).toEqual(['', 'agents.example.com']);
    expect(w.el('na-dom-h').hidden).toBe(true);
    w.el('na-dom').value = 'agents.example.com';
    w.el('na-dom').dispatch('change');
    expect(w.el('na-dom-h').hidden).toBe(false);
    expect(w.el('na-dom-h').textContent).toContain('@atmark.ai');
    w.el('na-name').value = 'desk';
    w.el('na-local').value = 'desk';
    w.el('na-form').dispatch('submit');
    await settle();
    expect(w.calls.find((c) => c.method === 'POST' && c.url === '/api/agents')?.body).toEqual({ name: 'desk', localPart: 'desk', domain: 'agents.example.com', primary: 'custom' });
  });

  it('Ⓟ-2 새 에이전트 — 기능이 꺼진 조직엔 도메인 칸이 없고 본문도 예전 그대로', async () => {
    OVERRIDE.set('/api/plan', { status: 200, json: { ...PLAN, features: { addressAliases: true, customDomains: false } } });
    const w = await boot(lang, '#/agents');
    w.el('na-open').dispatch('click');
    await settle();
    expect(w.el('na-dom').hidden).toBe(true);
    expect(w.el('na-suf-w').hidden).toBe(false);
    expect(w.calls.some((c) => c.url === '/api/domains')).toBe(false);
    w.el('na-name').value = 'desk';
    w.el('na-local').value = 'desk';
    w.el('na-form').dispatch('submit');
    await settle();
    expect(w.calls.find((c) => c.method === 'POST' && c.url === '/api/agents')?.body).toEqual({ name: 'desk', localPart: 'desk' });
  });

  it('Ⓟ-3 별칭 추가 — atmark.ai + 확인된 도메인 · 고객 도메인이면 POST {localPart, domain}', async () => {
    const w = await boot(lang, '#/agents/a1/addresses');
    w.el('al-add').dispatch('click');
    expect(w.el('al-dom').hidden).toBe(false);
    expect(w.el('al-suf-w').hidden).toBe(true);
    expect(w.el('al-dom').children.map((o) => o.value)).toEqual(['atmark.ai', 'agents.example.com']);
    w.el('al-dom').value = 'agents.example.com';
    w.el('al-dom').dispatch('change');
    expect(w.el('al-suf').textContent).toBe('agents.example.com');
    w.el('al-local').value = 'billing';
    w.el('al-form').dispatch('submit');
    await settle();
    expect(w.calls.find((c) => c.method === 'POST' && c.url === '/api/agents/a1/aliases')?.body).toEqual({ localPart: 'billing', domain: 'agents.example.com' });
  });

  const WITH_CUSTOM = {
    items: [
      { id: 'd1', address: 'founder@atmark.ai', primary: true, anchor: true, status: 'active', createdAt: '2026-09-20T01:00:00Z', retiredAt: null },
      { id: 'd5', address: 'founder@agents.example.com', primary: false, anchor: false, status: 'active', createdAt: '2026-09-24T01:00:00Z', retiredAt: null },
      { id: 'd2', address: 'sales@atmark.ai', primary: false, anchor: false, status: 'active', createdAt: '2026-09-24T01:00:00Z', retiredAt: null },
    ],
    aliases: { active: 2, activeMax: 5, issued: 2, issuedMax: 20, overLimit: false },
  };

  it('Ⓟ-4 대표로 — 확인된 도메인의 별칭에만 · 확인 대화상자는 워밍업과 @atmark.ai 주소가 꺼진다는 것을 말한다 · POST {addressId}', async () => {
    OVERRIDE.set('/api/agents/a1/aliases', { status: 200, json: WITH_CUSTOM });
    OVERRIDE.set('POST /api/agents/a1/primary', { status: 200, json: { primary: { addressId: 'd5', address: 'founder@agents.example.com' }, replayed: false } });
    const w = await boot(lang, '#/agents/a1/addresses');
    const rows = w.el('al-list').children;
    // 동작이 둘이면 ⋯ 메뉴 하나(대표로 고르기 · 삭제), 하나면 글자 버튼(2026-10-15 F09).
    const labels = rows.map((r) => r.all().filter((n) => n.tagName === 'BUTTON').map((b) => b.textContent));
    expect(labels).toEqual([['⋯', t(lang, '대표로 고르기'), t(lang, '삭제')], [t(lang, '삭제')]]);
    rows[0]?.all().find((n) => n.getAttribute('role') === 'menuitem' && n.textContent === t(lang, '대표로 고르기'))?.click();
    expect(w.el('dlg-confirm').open).toBe(true);
    const body = w.el('dc-body').textContent;
    expect(body).toContain(t(lang, '새 도메인은 하루에 보낼 수 있는 양이 작게 시작해 며칠에 걸쳐 늘어납니다. 그동안은 많이 보내지 못할 수 있습니다.'));
    expect(body).toContain('founder@atmark.ai');
    w.el('dc-ok').onclick?.();
    await settle();
    expect(w.calls.find((c) => c.method === 'POST' && c.url === '/api/agents/a1/primary')?.body).toEqual({ addressId: 'd5' });
  });

  it('Ⓟ-5 주소 없음 — 상자 · 도메인 보기 · @atmark.ai 주소 켜기(ax-- 안내) → POST {anchor:true}', async () => {
    const none = { ...AGENT, address: null };
    OVERRIDE.set('/api/agents', { status: 200, json: [none] });
    OVERRIDE.set('/api/agents/a1', { status: 200, json: none });
    OVERRIDE.set('/api/agents/a1/aliases', { status: 200, json: { items: [], aliases: { active: 0, activeMax: 5, issued: 1, issuedMax: 20, overLimit: false } } });
    OVERRIDE.set('POST /api/agents/a1/primary', { status: 200, json: { primary: { addressId: 'x', address: 'ax--abcdefghijklmnopqrst@atmark.ai' }, replayed: false } });
    const w = await boot(lang, '#/agents/a1/addresses');
    expect(w.el('al-none').hidden).toBe(false);
    expect(w.el('al-primary').hidden).toBe(true);
    expect(w.el('al-none-dom').getAttribute('href')).toBe('#/domains');
    expect(w.el('sc-addr').textContent).toBe(t(lang, '대표 주소 없음'));
    // 별칭이 하나도 없으면 "메일을 주고받지 않는다".
    expect(w.el('al-none-t').textContent).toBe(t(lang, '쓸 수 있는 주소가 없습니다'));
    w.el('al-wake').dispatch('click');
    expect(w.el('dlg-confirm').open).toBe(true);
    expect(w.el('dc-body').textContent).toContain('ax‑‑');
    w.el('dc-ok').onclick?.();
    await settle();
    expect(w.calls.find((c) => c.method === 'POST' && c.url === '/api/agents/a1/primary')?.body).toEqual({ anchor: true });
  });

  it('Ⓟ-5b 대표 주소가 없어도 살아 있는 별칭이 있으면 — "대표 주소가 없습니다 · 별칭으로는 계속" (진윤겸 결정: 별칭 허용)', async () => {
    const none = { ...AGENT, address: null };
    OVERRIDE.set('/api/agents', { status: 200, json: [none] });
    OVERRIDE.set('/api/agents/a1', { status: 200, json: none });
    OVERRIDE.set('/api/agents/a1/aliases', {
      status: 200,
      json: { items: [{ id: 'n2', address: 'sales@atmark.ai', primary: false, anchor: false, status: 'active', createdAt: '2026-09-24T01:00:00Z', retiredAt: null }], aliases: { active: 1, activeMax: 5, issued: 2, issuedMax: 20, overLimit: false } },
    });
    const w = await boot(lang, '#/agents/a1/addresses');
    expect(w.el('al-none').hidden).toBe(false);
    expect(w.el('al-none-t').textContent).toBe(t(lang, '대표 주소가 없습니다'));
    expect(w.el('al-none-d').textContent).toBe(t(lang, '기본으로 보내는 주소가 없지만, 아래 별칭으로는 계속 받고 보낼 수 있습니다.'));
    expect(w.el('al-list').children).toHaveLength(1);
  });

  it('Ⓟ-6 대표가 고객 도메인이면 @atmark.ai 주소는 꺼져 있다는 한 줄 + 켜기', async () => {
    OVERRIDE.set('/api/agents/a1/aliases', {
      status: 200,
      json: { items: [{ id: 'p1', address: 'founder@agents.example.com', primary: true, anchor: false, status: 'active', createdAt: '2026-09-24T01:00:00Z', retiredAt: null }], aliases: WITH_CUSTOM.aliases },
    });
    const w = await boot(lang, '#/agents/a1/addresses');
    expect(w.el('al-anchor').hidden).toBe(false);
    expect(w.el('al-none').hidden).toBe(true);
  });

  it('Ⓟ-7 대표인 별칭 삭제 409 address_is_primary — 이유를 말한다', async () => {
    OVERRIDE.set('POST /api/agents/a1/aliases/d2/retire', { status: 409, json: { error: 'address_is_primary' } });
    const w = await boot(lang, '#/agents/a1/addresses');
    w.el('al-list').children[0]?.all().find((n) => n.tagName === 'BUTTON')?.click();
    w.el('dc-ok').onclick?.();
    await settle();
    expect(w.el('al-msg').textContent).toBe(t(lang, '지금 대표 주소인 별칭은 삭제할 수 없습니다. 먼저 다른 주소를 대표로 고르세요.'));
  });
});
