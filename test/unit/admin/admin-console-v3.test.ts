/**
 * 콘솔 v3(`.omc/handoffs/console-v3-design.md`) — 번호 라벨 없음 · ⓘ 토글팁 · 본문 전체 폭 · 신원 ID 카드 · 발신 상세 본문·배달 이벤트.
 *
 * 층은 v2 테스트와 같다: 렌더된 HTML(두 언어)을 정적으로 보고, 앱 스크립트 전체를 가짜 DOM(`console-harness.ts`)에서 돌린다.
 * 좌표·겹침·가로 스크롤처럼 레이아웃이 필요한 것은 여기서 볼 수 없다 — 실제 Chrome(CDP) 확인으로 본다(US-002 보고서).
 *
 * 되돌려서 빨개지는지 확인한 것(2026-09-24, US-002 보고서의 되돌림 표): 사이드바에 `<span class="n">01</span>` 을 되살리면 → Ⓥ-1 ·
 * ⓘ 를 열 때 다른 ⓘ 를 닫는 줄(`if(S.tip&&S.tip!==b)setTip(S.tip,false);`)을 빼면 → Ⓥ-5 · Esc 뒤 포커스 되돌림(`if(back)b.focus();`)을
 * 빼면 → Ⓥ-5 · `.main` 에 `max-width:1180px` 을 되살리면 → Ⓥ-7 · 발신 상세의 `bodyBlock(ex,x);eventsBlock(ex,x);` 를 빼면 → Ⓥ-11·Ⓥ-12 ·
 * ID 카드의 상태 클래스(`st-*`)를 빼면 → Ⓥ-9.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { renderAppPage } from '../../../src/admin/ui/index';
import { CLIENT_SANITIZE_JS } from '../../../src/admin/ui/client-sanitize';
import { asciiScript } from '../../../src/admin/ui/page';
import { ADMIN_UI_CSS } from '../../../src/admin/ui/styles';
import { sanitizeDisplayBlock } from '../../../src/notify/approval-notification-template';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AGENT, blocks, boot, type FakeNode, HANGUL, inlined, OUT_LOG, OVERRIDE, PUBLISHED_IDENTITY, settle, t, uiSources, type World } from './console-harness';

afterEach(() => OVERRIDE.clear());

const LANGS = ['ko', 'en'] as const;

/** 스크립트·스타일을 뺀 마크업. */
const markup = (html: string): string => html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
const strip = (html: string): string => html.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

interface Tip {
  readonly button: string;
  readonly attrs: Record<string, string>;
  readonly id: string;
  readonly popTag: string;
  readonly body: string;
}
/** 모든 ⓘ — 버튼과 **바로 뒤 형제** 팝오버(팝오버 안에는 div 가 없다 — 그래서 첫 `</div>` 가 팝오버의 끝이다). */
function tips(html: string): Tip[] {
  const m = markup(html);
  return [...m.matchAll(/<button([^>]*\bclass="tip-btn"[^>]*)>[\s\S]*?<\/button>(<div class="tip-pop" id="([^"]+)"([^>]*)>([\s\S]*?)<\/div>)?/g)].map((x) => {
    const attrs: Record<string, string> = {};
    for (const a of (x[1] ?? '').matchAll(/([a-z-]+)="([^"]*)"/g)) attrs[a[1] ?? ''] = a[2] ?? '';
    return { button: x[0], attrs, id: x[3] ?? '', popTag: x[4] ?? '', body: x[5] ?? '' };
  });
}

// ---------------------------------------------------------------------------
// ① 번호 라벨이 없다 (R10)
// ---------------------------------------------------------------------------

describe.each(LANGS)('Ⓥ 번호 라벨 (%s)', (lang) => {
  const html = inlined(renderAppPage(lang));
  const m = markup(html);

  it('Ⓥ-1 사이드바·섹션·탭·모드 카드·제목에 순번 표시(01·02·A·B)가 없다 — class="n"·.mn·counter()도 없다', () => {
    expect(m).not.toMatch(/class="(n|mn|sec-head|ph)"/);
    expect(m).not.toMatch(/<span class="n">/);
    // 내비·탭·모드 카드 제목·모든 제목(h1–h4)·범례의 보이는 글이 순번으로 시작하지 않는다.
    const texts = [
      ...[...m.matchAll(/<a href="#\/[a-z]+" id="n-[a-z]+">([\s\S]*?)<\/a>/g)].map((x) => x[1] ?? ''),
      ...[...m.matchAll(/<a href="#\/agents" (?:class="nav-back" )?id="na-[a-z]+">([\s\S]*?)<\/a>/g)].map((x) => x[1] ?? ''),
      ...[...m.matchAll(/<h([1-4])\b[^>]*>([\s\S]*?)<\/h\1>/g)].map((x) => x[2] ?? ''),
      ...[...m.matchAll(/<span class="t">([\s\S]*?)<\/span>/g)].map((x) => x[1] ?? ''),
      ...[...m.matchAll(/<legend[^>]*>([\s\S]*?)<\/legend>/g)].map((x) => x[1] ?? ''),
    ].map(strip);
    expect(texts.length).toBeGreaterThan(40);
    for (const text of texts) expect(text, text).not.toMatch(/^(0\d|\d{1,2}[.)]|[A-H][.)]?\s|[A-H]$)/);
    expect(m.match(/<a href="#\/[a-z]+" id="n-[a-z]+">/g)).toHaveLength(6); // 조직 사이드바: 개요 · 에이전트 · 도메인 · 감시 · 로그 · 설정(비평 R10-11 · 2026-10-05 · 감시 2026-10-08)
    expect(m.match(/<a href="#\/agents" id="na-[a-z]+">/g)).toHaveLength(8); // 에이전트 스코프: 개요 · 연결 · 이메일 · 주소 · 웹훅 · 로그 · 신원 · 토큰
    expect(ADMIN_UI_CSS).not.toMatch(/counter\(|counter-reset|counter-increment|decimal-leading-zero/);
    // 모드 카드의 글자 번호(A–D)를 만들던 코드가 원문에 없다.
    // v4 B0: 원문이 여러 파일로 나뉘었다 — src/admin/ui/** 전부를 읽는다.
    for (const file of uiSources()) expect(readFileSync(file, 'utf8'), file).not.toContain('String.fromCharCode(65');
  });

  it('Ⓥ-2 (§9.4-4) 상시 보이는 설명은 한 줄 — `.tip-pop`·대화상자·pre·tbody 밖의 p·small·.sub·.x 글은 ko 45자 · en 80자 이하', () => {
    const outside = m
      .replace(/<div class="tip-pop"[^>]*>[\s\S]*?<\/div>/g, '')
      .replace(/<dialog\b[\s\S]*?<\/dialog>/g, '')
      .replace(/<(pre|tbody|noscript)\b[\s\S]*?<\/\1>/g, '');
    const texts = [
      ...[...outside.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)].map((x) => x[1] ?? ''),
      ...[...outside.matchAll(/<small\b[^>]*>([\s\S]*?)<\/small>/g)].map((x) => x[1] ?? ''),
      ...[...outside.matchAll(/<span class="(?:x|sub[^"]*)"[^>]*>([\s\S]*?)<\/span>/g)].map((x) => x[1] ?? ''),
    ].map(strip);
    expect(texts.length).toBeGreaterThan(20);
    const max = lang === 'ko' ? 45 : 80;
    expect(texts.filter((x) => [...x].length > max)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ② ⓘ 토글팁 (§5 · 테스트 고정점 §5.6)
// ---------------------------------------------------------------------------

describe.each(LANGS)('Ⓥ ⓘ 토글팁 마크업 (%s)', (lang) => {
  const html = inlined(renderAppPage(lang));
  const all = tips(html);

  it('Ⓥ-3 (§5.6-1·2) 모든 .tip-btn — type=button · aria-expanded=false · aria-controls의 id를 가진 .tip-pop[hidden] 이 바로 뒤에 정확히 하나 · 비어 있지 않은 aria-label(en은 한글 없음)', () => {
    expect(all.length).toBeGreaterThanOrEqual(30);
    const ids = new Set<string>();
    for (const tip of all) {
      expect(tip.attrs['type'], tip.button).toBe('button');
      expect(tip.attrs['aria-expanded'], tip.button).toBe('false');
      expect(tip.attrs['aria-controls'], tip.button).toBe(tip.id);
      expect(tip.id, tip.button).toMatch(/^tip-[a-z-]+$/);
      expect(tip.popTag, tip.id).toBe(' hidden');
      const label = tip.attrs['aria-label'] ?? '';
      expect(label.trim().length, tip.id).toBeGreaterThan(0);
      if (lang === 'en') expect(HANGUL.test(label), `${tip.id}: ${label}`).toBe(false);
      expect(ids.has(tip.id), tip.id).toBe(false);
      ids.add(tip.id);
      // 아이콘만 있는 버튼 — 보이는 글자가 없고, 아이콘은 스크린리더에서 숨는다.
      expect(tip.button).toContain('<svg class="ico" viewBox="0 0 16 16" aria-hidden="true" focusable="false">');
    }
    // 팝오버마다 버튼이 하나(짝 없는 팝오버가 없다).
    expect([...markup(html).matchAll(/class="tip-pop"/g)]).toHaveLength(all.length);
    // 페이지 안에서 id 가 유일하다.
    const every = [...markup(html).matchAll(/\bid="([^"]+)"/g)].map((x) => x[1]);
    expect(every.length).toBe(new Set(every).size);
  });

  it('Ⓥ-4 (§5.6-4 · R5) 팝오버 안에는 링크·버튼·입력이 없다 · 짧다(문단 ≤3 · 항목 ≤5 · ko 320자 · en 520자)', () => {
    for (const tip of all) {
      expect(tip.body, tip.id).not.toMatch(/<(a|button|input|select|textarea|details|form)\b/);
      expect([...tip.body.matchAll(/<p\b/g)].length, tip.id).toBeLessThanOrEqual(3);
      expect([...tip.body.matchAll(/<(li|dt)\b/g)].length, tip.id).toBeLessThanOrEqual(5);
      const length = [...strip(tip.body)].length;
      expect(length, `${tip.id} ${length}`).toBeLessThanOrEqual(lang === 'ko' ? 320 : 520);
    }
  });
});

describe.each(LANGS)('Ⓥ ⓘ 토글팁 동작 — 앱 스크립트를 가짜 DOM에서 (%s)', (lang) => {
  const state = (w: World, id: string): [string | null, boolean] => [w.el(`tipb-${id}`).getAttribute('aria-expanded'), w.el(`tip-${id}`).hidden];
  const click = (w: World, id: string): void => {
    w.el(`tipb-${id}`).focus(); // 실제 브라우저에서 버튼 클릭은 버튼에 포커스를 준다
    w.doc('click', { target: w.el(`tipb-${id}`) });
  };

  it('Ⓥ-5 (§5.6-3) 클릭 → 열림 · 다른 ⓘ → 앞의 것 닫힘(하나만) · 다시 클릭 → 닫힘 · Esc → 닫히고 포커스는 버튼 · 바깥 pointerdown → 닫힘 · 안쪽은 유지', async () => {
    const w = await boot(lang, '#/agents/a1/outbound');
    expect(state(w, 'out-mode')).toEqual(['false', true]);
    click(w, 'out-mode');
    expect(state(w, 'out-mode')).toEqual(['true', false]);
    click(w, 'limits');
    expect(state(w, 'limits')).toEqual(['true', false]);
    expect(state(w, 'out-mode')).toEqual(['false', true]);
    click(w, 'limits');
    expect(state(w, 'limits')).toEqual(['false', true]);

    // Esc — 닫고 포커스를 버튼으로 돌려준다(포커스가 버튼·팝오버 안에 있었을 때).
    click(w, 'o-allow');
    w.el('tip-o-allow').focus(); // 포커스가 팝오버 안에 있을 때
    w.doc('keydown', { target: w.el('tip-o-allow'), key: 'Escape' });
    expect(state(w, 'o-allow')).toEqual(['false', true]);
    expect(w.active()).toBe(w.el('tipb-o-allow'));
    // 포커스가 딴 데 있으면 닫기만 하고 포커스를 빼앗지 않는다.
    click(w, 'o-allow');
    w.el('ol-edit').focus();
    w.doc('keydown', { target: w.el('ol-edit'), key: 'Escape' });
    expect(state(w, 'o-allow')).toEqual(['false', true]);
    expect(w.active()).toBe(w.el('ol-edit'));
    // Esc 가 아닌 키는 아무것도 하지 않는다.
    click(w, 'o-block');
    w.doc('keydown', { target: w.el('tipb-o-block'), key: 'Enter' });
    expect(state(w, 'o-block')).toEqual(['true', false]);

    // 팝오버 안을 누르면 유지, 바깥을 누르면 닫힘(포커스는 옮기지 않는다).
    w.doc('pointerdown', { target: w.el('tip-o-block') });
    expect(state(w, 'o-block')).toEqual(['true', false]);
    const before = w.active();
    w.doc('pointerdown', { target: w.el('o-limits') });
    expect(state(w, 'o-block')).toEqual(['false', true]);
    expect(w.active()).toBe(before);
  });

  it('Ⓥ-6 포커스 이탈(relatedTarget이 밖) → 닫힘 · relatedTarget 없음(글 선택 등) → 유지 · 라우트 변경 → 닫힘 · 대화상자가 열려 있으면 Esc는 대화상자 몫', async () => {
    const w = await boot(lang, '#/agents/a1/connect');
    click(w, 'connect-token');
    w.doc('focusout', { target: w.el('tipb-connect-token'), relatedTarget: null });
    expect(state(w, 'connect-token')).toEqual(['true', false]);
    w.doc('focusout', { target: w.el('tipb-connect-token'), relatedTarget: w.el('tip-connect-token') });
    expect(state(w, 'connect-token')).toEqual(['true', false]);
    w.doc('focusout', { target: w.el('tipb-connect-token'), relatedTarget: w.el('cm-copy') });
    expect(state(w, 'connect-token')).toEqual(['false', true]);

    click(w, 'connect-token');
    await w.go('#/agents/a1/tokens');
    expect(state(w, 'connect-token')).toEqual(['false', true]);

    click(w, 'tokens');
    w.el('tk-rotate').dispatch('click'); // 확인 대화상자가 열린다
    expect(w.el('dlg-confirm').open).toBe(true);
    w.doc('keydown', { target: w.el('dc-cancel'), key: 'Escape' });
    expect(state(w, 'tokens')).toEqual(['true', false]);
  });

  it('Ⓥ-6b 로그 ⓘ 는 종류마다 설명이 바뀐다(스크립트가 textContent로)', async () => {
    const w = await boot(lang, '#/logs');
    const out = w.el('tip-logs-t').textContent;
    await w.go('#/logs/inbound');
    const inb = w.el('tip-logs-t').textContent;
    expect(out.length).toBeGreaterThan(10);
    expect(inb).not.toBe(out);
    expect(inb).toBe(t(lang, '에이전트 주소로 온 메일. 보류된 메일은 에이전트에게 보이지 않고, 본문은 여기서도 열지 않습니다.'));
  });
});

// ---------------------------------------------------------------------------
// ③ 본문 전체 폭 (§2.3)
// ---------------------------------------------------------------------------

describe('Ⓥ 레이아웃 — 본문 전체 폭', () => {
  const rules = ADMIN_UI_CSS.replace(/@media[^{]*\{/g, '').split('}').map((chunk) => chunk.split('{')).filter((p) => p.length >= 2).map((p) => ({ selector: (p[p.length - 2] ?? '').trim(), body: p[p.length - 1] ?? '' }));

  it('Ⓥ-7 `.main` 에 최대폭이 없다(미디어 쿼리 안에서도) · 사이드바 240px · 표는 width:100% · 팝오버 폭은 요소 단위(340px)', () => {
    const main = rules.filter((r) => r.selector.split(',').map((s) => s.trim()).includes('.main'));
    expect(main.length).toBeGreaterThanOrEqual(3);
    for (const r of main) expect(r.body, r.body).not.toMatch(/max-width/);
    expect(ADMIN_UI_CSS).not.toMatch(/max-width:1180px/);
    expect(ADMIN_UI_CSS).toContain('.frame{display:grid;grid-template-columns:var(--side-w) minmax(0,1fr)');
    expect(ADMIN_UI_CSS).toContain('--side-w:240px;');
    expect(ADMIN_UI_CSS).toContain('.tbl{width:100%');
    expect(ADMIN_UI_CSS).toMatch(/\.tip-pop\{[^}]*max-width:min\(340px,calc\(100vw - 32px\)\)/);
    // 좁은 화면(≤767px)에서 팝오버는 좌표 계산 없이 제목 줄 아래에 인라인으로.
    expect(ADMIN_UI_CSS).toMatch(/@media \(max-width:767px\)\{[\s\S]*\.tip-pop\{position:static;/);
  });
});

// ---------------------------------------------------------------------------
// ④ 신원 ID 카드 (§6)
// ---------------------------------------------------------------------------

// 신원 ID 카드는 v4 에서 세로 컬러 배지 + 한 페이지로 바뀌었다 — `admin-console-v4.test.ts` Ⓘ 가 본다(조직 신원 격자는 없어졌다 · D5).

// ---------------------------------------------------------------------------
// ⑤ 발신 로그 상세 — 보낸 본문 · 배달 이벤트 (US-004 모양)
// ---------------------------------------------------------------------------

describe.each(LANGS)('Ⓥ 로그 상세 패널 (%s)', (lang) => {
  const RCPTS = ['a@partner.example', 'b@partner.example', 'c@partner.example', 'd@partner.example', 'e@partner.example', 'f@partner.example', 'g@partner.example'];
  const DETAIL = {
    ...OUT_LOG,
    decision: 'sent',
    reasons: [],
    recipients: RCPTS,
    recipientCount: RCPTS.length,
    threadId: 'thr_42',
    snippet: 'Hello team',
    body: { status: 'available', text: 'Hello team,\r\n<b>not html</b>‮\n\tBye', truncated: true, hasHtml: true },
    events: [
      { type: 'send', at: '2026-09-24T02:00:01.000000Z' },
      { type: 'delivery', at: '2026-09-24T02:00:03.000000Z' },
      { type: 'bounce', at: '2026-09-24T02:00:04.000000Z' },
      { type: 'from_the_future', at: '2026-09-24T02:00:05.000000Z' },
    ],
  };
  const find = (root: FakeNode, pred: (n: FakeNode) => boolean): FakeNode[] => root.all().filter(pred);

  it('Ⓥ-11 본문은 pre 한 칸에 textContent로(태그가 글자로 · 제어·양방향 문자 제거) · 잘림·HTML 파트 안내 · 받는 사람 전부 · 스레드 · 배달 이벤트 타임라인(모르는 종류는 코드 그대로)', async () => {
    OVERRIDE.set('/api/logs/outbound/m-1', { status: 200, json: DETAIL });
    const w = await boot(lang, '#/logs/outbound/m-1');
    expect(w.el('dlg-log').open).toBe(true);
    const ex = w.el('dl-extra');
    const pres = find(ex, (n) => n.tagName === 'PRE');
    expect(pres).toHaveLength(1);
    expect(pres[0]?.className).toBe('lbody');
    expect(pres[0]?.textContent).toBe('Hello team,\n<b>not html</b>\n\tBye');
    expect(pres[0]?.children).toHaveLength(0); // 자식 요소 없이 글자 하나 — 마크업으로 해석되지 않는다
    const text = ex.textContent;
    expect(text).toContain(t(lang, '본문이 길어 앞부분만 보입니다.'));
    expect(text).toContain(t(lang, 'HTML 파트는 콘솔에서 열지 않습니다.'));
    for (const r of RCPTS) expect(text).toContain(r);
    expect(w.el('dl-kv').textContent).toContain('thr_42');
    expect(w.el('dl-kv').textContent).toContain(t(lang, '스레드'));
    const ol = find(ex, (n) => n.tagName === 'OL' && n.className === 'tl')[0];
    expect(ol?.children).toHaveLength(4);
    const labels = (ol?.children ?? []).map((li) => li.children[1]?.textContent);
    expect(labels).toEqual([t(lang, '발송 접수'), t(lang, '배달됨'), t(lang, '반송'), 'from_the_future']);
    expect(ol?.children[2]?.className).toBe('ev-bad');
    expect(ol?.children[0]?.children[0]?.textContent).toMatch(/KST$/);
    if (lang === 'en') expect(HANGUL.test(text)).toBe(false);
  });

  it('Ⓥ-12 본문이 없는 발신 행 — 상태 문구 + 스니펫 미리보기 · 거부된 발송은 배달 절이 없다 · 수신 상세는 본문 없음(보류 메일 비노출)', async () => {
    OVERRIDE.set('/api/logs/outbound/m-1', { status: 200, json: { ...OUT_LOG, snippet: 'Short preview', body: { status: 'not_stored', text: null, truncated: false, hasHtml: null }, events: [] } });
    const w = await boot(lang, '#/logs/outbound/m-1');
    const ex = w.el('dl-extra');
    expect(ex.textContent).toContain(t(lang, '이 기록에는 본문이 저장되지 않았습니다.'));
    expect(find(ex, (n) => n.tagName === 'PRE').map((n) => n.textContent)).toEqual(['Short preview']);
    expect(ex.textContent).not.toContain(t(lang, '배달 이벤트'));

    OVERRIDE.set('/api/logs/outbound/m-1', { status: 200, json: { ...OUT_LOG, decision: 'sent', body: { status: 'unavailable', text: null, truncated: false, hasHtml: null }, events: [] } });
    const v = await boot(lang, '#/logs/outbound/m-1');
    expect(v.el('dl-extra').textContent).toContain(t(lang, '본문을 읽지 못했습니다.'));
    expect(v.el('dl-extra').textContent).toContain(t(lang, '배달 이벤트가 아직 없습니다.'));

    // 수신 — 서버가 무엇을 주든 본문 칸을 그리지 않는다.
    OVERRIDE.set('/api/logs/inbound/i-1', { status: 200, json: { id: 'i-1', at: '2026-09-24T02:00:00Z', agentId: 'a1', from: 'x@y.example', subject: 's', verdict: 'quarantined', body: { status: 'available', text: 'SECRET', truncated: false, hasHtml: false }, snippet: 'SECRET' } });
    const i = await boot(lang, '#/logs/inbound/i-1');
    const iex = i.el('dl-extra');
    expect(find(iex, (n) => n.tagName === 'PRE')).toHaveLength(0);
    expect(iex.textContent).not.toContain('SECRET');
    expect(iex.textContent).toContain(t(lang, '본문은 콘솔에서 열지 않습니다.'));
  });
});

describe('Ⓥ 여러 줄 정화 — 브라우저 `cleanBlock` 은 서버 `sanitizeDisplayBlock` 과 같다', () => {
  const context = vm.createContext({});
  vm.runInContext(asciiScript(CLIENT_SANITIZE_JS), context);
  const cleanBlock = (value: unknown, max: number): string => vm.runInContext('cleanBlock', context)(value, max) as string;

  it('Ⓥ-13 BMP 전체 + 태그·변이 선택자 평면에서 출력이 같다 · 앱 스크립트가 이 소스를 싣는다', () => {
    for (const [from, to] of [
      [0x0000, 0xd7ff],
      [0xe000, 0xffff],
      [0xe0000, 0xe01ff],
    ] as const) {
      for (let start = from; start <= to; start += 256) {
        let input = '';
        for (let cp = start; cp < Math.min(start + 256, to + 1); cp++) input += `x${String.fromCodePoint(cp)}\r\n`;
        expect(cleanBlock(input, 1_000_000)).toBe(sanitizeDisplayBlock(input));
      }
    }
    expect(cleanBlock('ab\ncd', 3)).toBe('ab\n…(잘림)');
    expect(cleanBlock(null, 5)).toBe('');
    const script = blocks(inlined(renderAppPage()), 'script').at(-1);
    expect(script).toContain(asciiScript(CLIENT_SANITIZE_JS));
  });
});

// ---------------------------------------------------------------------------
// ⑥ 접기·펼치기(GATE · 새 에이전트 · 분당 한도) — 같은 disclosure 규칙
// ---------------------------------------------------------------------------

describe.each(LANGS)('Ⓥ disclosure (%s)', (lang) => {
  it('Ⓥ-14 GATE는 기본 접힘(aria-expanded · aria-controls="gate-body") · 누르면 펼침 · 요약 줄 · 새 에이전트 · 분당 한도는 대화상자(펼치는 패널 없음 · Esc 는 닫고 버튼으로)', async () => {
    const w = await boot(lang, '#/settings/gate');
    const g = w.el('g-toggle');
    expect(g.getAttribute('aria-controls')).toBe('gate-body');
    expect(g.getAttribute('aria-expanded')).toBe('false');
    expect(w.el('gate-body').hidden).toBe(true);
    expect(w.el('g-sum').textContent).toBe(t(lang, '열린 인계 시험이 없습니다.'));
    g.dispatch('click');
    expect(w.el('gate-body').hidden).toBe(false);
    expect(g.getAttribute('aria-expanded')).toBe('true');
    expect(g.textContent).toBe(t(lang, '닫기'));

    await w.go('#/agents');
    expect(w.el('dlg-newagent').open).toBe(false);
    expect(w.el('ag-count').textContent).toBe('1 / 10');
    const na = w.el('na-open');
    expect(na.getAttribute('aria-haspopup')).toBe('dialog');
    expect(na.getAttribute('aria-expanded')).toBeNull();
    na.focus();
    na.dispatch('click');
    expect(w.el('dlg-newagent').open).toBe(true);
    expect(w.active()).toBe(w.el('na-name'));
    w.el('dlg-newagent').esc();
    expect(w.el('dlg-newagent').open).toBe(false);
    expect(w.active()).toBe(na);

    // 에이전트가 없으면 빈 상태 + 버튼 — 대화상자를 저절로 열지 않는다. 빈 상태 버튼도 같은 대화상자를 연다.
    OVERRIDE.set('/api/agents', { status: 200, json: [] });
    const e = await boot(lang, '#/agents');
    expect(e.el('dlg-newagent').open).toBe(false);
    expect(e.el('agents-empty').hidden).toBe(false);
    e.el('na-cta').dispatch('click');
    expect(e.el('dlg-newagent').open).toBe(true);
    e.el('na-cancel').dispatch('click');
    expect(e.el('dlg-newagent').open).toBe(false);

    const o = await boot(lang, '#/agents/a1/email');
    const ed = o.el('ol-edit');
    expect(ed.getAttribute('aria-haspopup')).toBe('dialog');
    expect(o.el('dlg-limit').open).toBe(false);
    ed.focus();
    ed.dispatch('click');
    expect(o.el('dlg-limit').open).toBe(true);
    expect(o.active()).toBe(o.el('ol-rate'));
    expect(o.el('ol-rate').value).toBe('10');
    o.el('dlg-limit').esc();
    expect(o.el('dlg-limit').open).toBe(false);
    expect(o.active()).toBe(ed);
    await settle();
  });
});
