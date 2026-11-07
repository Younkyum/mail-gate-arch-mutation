/**
 * 콘솔 v3 후속 — 새로 들어온 백엔드 기능의 화면(`.omc/handoffs/v2-contract.md` 메모):
 *   - US-007 토큰 마지막 사용(`AgentView.lastUsedAt`) — 상대 시각(두 언어 · 경계) · 토큰 탭 · 에이전트 개요 · 에이전트 목록 칸
 *   - US-008 발신 본문 `body.status = 'expired'` — "결함" 처럼 보이는 `missing` 과 다른 문구
 *   - US-010 로그 화면의 무결성 패널(`GET /api/logs/integrity`) · 검증 번들 내려받기(Blob · `<a download>` · innerHTML 없음) ·
 *     로그 상세의 포함 증명(`tlogEntryId` 가 올 때만)
 *
 * 되돌려서 빨개지는지 확인한 것(2026-09-24, 보고서 되돌림 표): `BODY_ST` 의 `expired:` 항목을 빼면 → Ⓕ-4 ·
 * `ago` 의 `if(s<3600)` 을 `if(s<=3600)` 으로 바꾸면 → Ⓕ-1 · 번들 저장의 `saveBlob(f.blob,f.name);` 을 빼면 → Ⓕ-7.
 */

import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import { afterEach, describe, expect, it } from 'vitest';

import { TIME_JS } from '../../../src/admin/ui/app';
import { localize, MESSAGES } from '../../../src/admin/ui/i18n';
import { adminUiAsset, renderAppPage, type Lang } from '../../../src/admin/ui/index';

import { AGENT, blocks, boot, BUNDLE_NAME, type FakeNode, HANGUL, inlined, integrity, OUT_LOG, OVERRIDE, t, TOKENS } from './console-harness';

afterEach(() => OVERRIDE.clear());

const LANGS = ['ko', 'en'] as const;
const find = (root: FakeNode, pred: (n: FakeNode) => boolean): FakeNode[] => root.all().filter(pred);
const isoAgo = (ms: number, now = Date.now()): string => new Date(now - ms).toISOString();

/** `TIME_JS` 를 그 언어로 번역한 뒤(운영과 같은 `localize` 경로) vm 에서 `ago` 를 꺼낸다. */
function agoIn(lang: Lang): (iso: unknown, now: number) => string {
  const context = vm.createContext({ Date, Math, String, Object, isNaN, LANG: lang });
  vm.runInContext(localize(TIME_JS, lang, 'js'), context);
  return vm.runInContext('ago', context) as (iso: unknown, now: number) => string;
}

// ---------------------------------------------------------------------------
// US-007 — 상대 시각
// ---------------------------------------------------------------------------

describe('Ⓕ 상대 시각(ago) — 두 언어 · 경계', () => {
  const NOW = Date.parse('2026-09-24T05:30:00.000Z');
  const S = 1000;
  const M = 60 * S;
  const H = 60 * M;
  const at = (ms: number): string => new Date(NOW - ms).toISOString();
  const CASES: ReadonlyArray<readonly [string, number, string, string]> = [
    ['지금', 0, '방금', 'just now'],
    ['59초', 59 * S, '방금', 'just now'],
    ['미래(이 브라우저 시계가 늦음)', -5 * M, '방금', 'just now'],
    ['60초 = 1분', 60 * S, '1분 전', '1 min ago'],
    ['119초', 119 * S, '1분 전', '1 min ago'],
    ['59분 59초', H - S, '59분 전', '59 min ago'],
    ['60분 = 1시간', H, '1시간 전', '1 hr ago'],
    ['23시간 59분', 24 * H - M, '23시간 전', '23 hr ago'],
    // 24시간부터는 KST 날짜 — 언어별 포매터 하나(비평 R9-06): ko YYYY.MM.DD · en Mon D, YYYY. 2026-09-23T05:30Z = KST 09-23 14:30.
    ['24시간 = 날짜', 24 * H, '2026.09.23', 'Sep 23, 2026'],
    ['400일', 400 * 24 * H, '2025.08.20', 'Aug 20, 2025'],
  ];

  it('Ⓕ-1 1분 미만(미래 포함) 방금 · 1시간 미만 n분 · 24시간 미만 n시간 · 그 뒤 KST 날짜 — 경계에서 올림하지 않는다', () => {
    const ko = agoIn('ko');
    const en = agoIn('en');
    for (const [name, ms, k, e] of CASES) {
      expect(ko(at(ms), NOW), `ko ${name}`).toBe(k);
      expect(en(at(ms), NOW), `en ${name}`).toBe(e);
    }
  });

  it('Ⓕ-2 KST 날짜 경계(UTC 15:00 = 다음 날 KST) · 모양이 틀린 값은 빈 글(화면은 — 로) · 영어 틀에 한글 없음', () => {
    const ko = agoIn('ko');
    const en = agoIn('en');
    expect(ko('2026-09-20T14:59:00.000Z', NOW)).toBe('2026.09.20');
    expect(ko('2026-09-20T15:00:00.000Z', NOW)).toBe('2026.09.21');
    for (const bad of [null, undefined, '', 'not-a-date', 42]) {
      expect(ko(bad, NOW)).toBe('');
      expect(en(bad, NOW)).toBe('');
    }
    expect(HANGUL.test(localize(TIME_JS, 'en', 'js'))).toBe(false);
  });
});

describe.each(LANGS)('Ⓕ 토큰 마지막 사용 — 화면 (%s)', (lang) => {
  it('Ⓕ-3 "마지막 사용" — 에이전트 개요 · 목록 칸 · 토큰 목록의 토큰마다(v4) · 정확한 시각은 title(KST) · null 이면 "—" + title "사용 기록 없음"(2026-10-15 F16)', async () => {
    const used = isoAgo(5.5 * 60000);
    const NEVER = { ...AGENT, id: 'a2', name: 'never-agent', address: 'never@atmark.ai', lastUsedAt: null };
    OVERRIDE.set('/api/agents', { status: 200, json: [{ ...AGENT, lastUsedAt: used }, NEVER] });
    OVERRIDE.set('/api/agents/a1/tokens?status=all', {
      status: 200,
      json: { tokens: [{ ...TOKENS[0], lastUsedAt: used }, { ...TOKENS[1], lastUsedAt: null }], activeCount: 2, maxActive: 5 },
    });
    const w = await boot(lang, '#/agents/a1');
    expect(w.el('ao-used').textContent).toBe(t(lang, '{n}분 전').replace('{n}', '5'));
    expect(w.el('ao-used').title).toMatch(/KST$/);

    await w.go('#/agents/a1/tokens');
    const cellOf = (tr: FakeNode | undefined, label: string): FakeNode | undefined => tr?.children.find((c) => c.getAttribute('data-label') === t(lang, label));
    const rows = w.el('tk-body').children;
    expect(cellOf(rows[0], '마지막 사용')?.textContent).toBe(t(lang, '{n}분 전').replace('{n}', '5'));
    expect(cellOf(rows[0], '마지막 사용')?.children[0]?.title).toMatch(/KST$/);
    expect(cellOf(rows[1], '마지막 사용')?.textContent).toBe('—');
    expect(cellOf(rows[1], '마지막 사용')?.children[0]?.title).toBe(t(lang, '사용 기록 없음'));

    await w.go('#/agents');
    const list = w.el('agents-body').children;
    const last = (tr: FakeNode | undefined): FakeNode | undefined => tr?.children[tr.children.length - 1];
    expect(last(list[0])?.getAttribute('data-label')).toBe(t(lang, '마지막 사용'));
    expect(last(list[0])?.textContent).toBe(t(lang, '{n}분 전').replace('{n}', '5'));
    // 빈 값은 어디서나 조용한 "—", 뜻("사용 기록 없음")은 title(비평 R4-07 · 2026-10-15 F16 — 개요 카드도 같다).
    expect(last(list[1])?.textContent).toBe('—');
    expect(last(list[1])?.children[0]?.title).toBe(t(lang, '사용 기록 없음'));

    await w.go('#/agents/a2');
    expect(w.el('ao-used').textContent).toBe('—');
    expect(w.el('ao-used').title).toBe(t(lang, '사용 기록 없음'));
    if (lang === 'en') expect(HANGUL.test(w.el('ao-used').textContent)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// US-008 — 보관 기간이 지난 본문
// ---------------------------------------------------------------------------

describe.each(LANGS)('Ⓕ 발신 본문 expired (%s)', (lang) => {
  it('Ⓕ-4 expired는 "보관 기간(1년)이 지나 본문이 삭제됐습니다" — missing 문구와 다르고, 스니펫 미리보기는 그대로', async () => {
    OVERRIDE.set('/api/logs/outbound/m-1', {
      status: 200,
      json: { ...OUT_LOG, decision: 'sent', snippet: 'Old preview', body: { status: 'expired', text: null, truncated: false, hasHtml: null }, events: [] },
    });
    const w = await boot(lang, '#/logs/outbound/m-1');
    const ex = w.el('dl-extra');
    const expired = t(lang, '보관 기간(1년)이 지나 본문이 삭제됐습니다.');
    expect(ex.textContent).toContain(expired);
    expect(ex.textContent).not.toContain(t(lang, '본문을 찾지 못했습니다.'));
    expect(find(ex, (n) => n.textContent === expired)[0]?.className).toContain('st-expired');
    expect(find(ex, (n) => n.tagName === 'PRE').map((n) => n.textContent)).toEqual(['Old preview']);
    expect(expired).not.toBe(t(lang, '본문을 찾지 못했습니다.'));

    OVERRIDE.set('/api/logs/outbound/m-1', { status: 200, json: { ...OUT_LOG, body: { status: 'missing', text: null, truncated: false, hasHtml: null }, events: [] } });
    const v = await boot(lang, '#/logs/outbound/m-1');
    expect(v.el('dl-extra').textContent).toContain(t(lang, '본문을 찾지 못했습니다.'));
    expect(v.el('dl-extra').textContent).not.toContain(expired);
  });
});

// ---------------------------------------------------------------------------
// US-010 — 무결성 패널 · 번들 · 포함 증명
// ---------------------------------------------------------------------------

describe.each(LANGS)('Ⓕ 무결성 패널 (%s)', (lang) => {
  const tpl = (ko: string, values: Record<string, string | number>): string =>
    t(lang, ko).replace(/\{([a-z]+)\}/g, (_, k: string) => String(values[k]));

  it('Ⓕ-5 가짜 API로 그린다 — 마지막 체크포인트(상대 시각 · 번호 · 전체 기록 수) · 항목 수 + 대기 · 대상별 최신 앵커 · 키 지문 · 복사', async () => {
    const w = await boot(lang, '#/settings/tlog');
    expect(w.calls.filter((c) => c.url === '/api/logs/integrity')).toHaveLength(1);
    expect(w.el('it-facts').hidden).toBe(false);
    expect(w.el('it-empty').hidden).toBe(true);
    expect(w.el('it-dl').disabled).toBe(false);
    const cp = w.el('it-cp').textContent;
    expect(cp).toContain(tpl('{n}분 전', { n: 12 }));
    expect(cp).toContain(tpl('#{e} · 전체 기록 {s}건', { e: 1834, s: '1,835' }));
    expect(w.el('it-cp').title).toMatch(/KST$/);
    expect(w.el('it-size').textContent).toBe(`418${tpl('대기 {n}건', { n: 6 })}`);
    // 오픈타임스탬프는 끝점이 둘 — 체크포인트 번호가 가장 큰(최신) 것 하나: submitted.
    expect(w.el('it-ots').textContent).toBe(`${t(lang, 'Bitcoin 기록 대기')}${tpl('체크포인트 #{e}', { e: 1833 })}`);
    expect(w.el('it-rekor').textContent).toBe(`${t(lang, 'Sigstore 기록됨')}${tpl('체크포인트 #{e} · {t}', { e: 1834, t: tpl('{n}분 전', { n: 9 }) })}`);
    const pill = find(w.el('it-rekor'), (n) => n.className.startsWith('pill'))[0];
    expect(pill?.className).toBe('pill on');
    expect(w.el('it-key').textContent).toBe('1a2b3c4d');
    expect(w.el('it-kname').textContent).toBe('id.atmark.ai/log');
    expect(w.el('it-key').title).toBe(integrity()['vkey']);
    expect(w.el('it-key-copy').hidden).toBe(false);
    if (lang === 'en') for (const id of ['it-cp', 'it-size', 'it-ots', 'it-rekor']) expect(HANGUL.test(w.el(id).textContent), id).toBe(false);

    // 설정 안에서 다른 섹션에 다녀와도 다시 부르지 않는다(설정에 머무는 동안 한 번) · 설정을 떠났다 오면 다시 읽는다 ·
    // 로그 화면(조직·에이전트)에는 패널이 없다(v4 D5 — 부르지 않는다).
    await w.go('#/settings/org');
    expect(w.calls.filter((c) => c.url === '/api/logs/integrity')).toHaveLength(1);
    await w.go('#/settings/tlog');
    expect(w.calls.filter((c) => c.url === '/api/logs/integrity')).toHaveLength(1);
    await w.go('#/overview');
    await w.go('#/settings/tlog');
    expect(w.calls.filter((c) => c.url === '/api/logs/integrity')).toHaveLength(2);
    const l = await boot(lang, '#/logs');
    expect(l.calls.some((c) => c.url === '/api/logs/integrity')).toBe(false);
    const a = await boot(lang, '#/agents/a1/logs');
    expect(a.calls.some((c) => c.url === '/api/logs/integrity')).toBe(false);
  });

  it('Ⓕ-5b F34 — 앵커 상태 = DB CHECK(202609241800)의 대상별 상태 전부에 두 언어 라벨 · OTS 끝 상태는 "주장(미검증)" · "확정"(confirmed)이 없다 · 모르는 상태는 코드 그대로', async () => {
    const migration = readFileSync(new URL('../../../src/db/migrations/202609241800_tlog_hardening.sql', import.meta.url), 'utf8');
    const shape = /tlog_anchors_state_shape CHECK \(([\s\S]*?)\) NOT VALID/.exec(migration)?.[1] ?? '';
    const statesOf = (target: string): string[] =>
      [...shape.matchAll(/WHEN '([a-z_]+)' THEN ([^\n]*)/g)].filter((m) => !/target = '/.test(m[2] ?? '') || (m[2] ?? '').includes(`target = '${target}'`)).map((m) => m[1] as string);
    expect(statesOf('opentimestamps').sort()).toEqual(['bitcoin_claimed', 'failed', 'pending', 'submitted']);
    expect(statesOf('rekor').sort()).toEqual(['confirmed', 'failed', 'pending']);
    const labels: Record<string, Record<string, [string, string]>> = {
      opentimestamps: { pending: ['대기 중', 'dim'], submitted: ['Bitcoin 기록 대기', 'dim'], bitcoin_claimed: ['Bitcoin 기록 주장(미검증)', 'on'], failed: ['기록 실패', 'dim'] },
      rekor: { pending: ['대기 중', 'dim'], confirmed: ['Sigstore 기록됨', 'on'], failed: ['기록 실패', 'dim'] },
    };
    for (const target of ['opentimestamps', 'rekor'] as const) {
      for (const state of statesOf(target)) {
        const [label, tone] = labels[target]?.[state] ?? ['?', '?'];
        OVERRIDE.set('/api/logs/integrity', { status: 200, json: { ...integrity(), anchors: [{ epoch: 9, target, endpoint: 'x', state, confirmedAt: null }] } });
        const w = await boot(lang, '#/settings/tlog');
        const cell = w.el(target === 'rekor' ? 'it-rekor' : 'it-ots');
        expect(cell.textContent, `${target}/${state}`).toBe(`${t(lang, label)}${tpl('체크포인트 #{e}', { e: 9 })}`);
        expect(find(cell, (n) => n.className.startsWith('pill'))[0]?.className, `${target}/${state}`).toBe(`pill ${tone}`);
        if (lang === 'en') expect(HANGUL.test(cell.textContent), `${target}/${state}`).toBe(false);
      }
    }
    expect(t(lang, 'Bitcoin 기록 주장(미검증)')).toBe(lang === 'ko' ? 'Bitcoin 기록 주장(미검증)' : 'Bitcoin claimed (unverified)');
    // OTS 에는 confirmed 가 없다 — 와도 "확정" 이라 부르지 않고 코드 그대로(어두운 알약).
    OVERRIDE.set('/api/logs/integrity', { status: 200, json: { ...integrity(), anchors: [{ epoch: 9, target: 'opentimestamps', endpoint: 'x', state: 'confirmed', confirmedAt: null }] } });
    const odd = await boot(lang, '#/settings/tlog');
    expect(odd.el('it-ots').textContent).toBe(`confirmed${tpl('체크포인트 #{e}', { e: 9 })}`);
  });

  it('Ⓕ-6 시작 전(started=false)은 빈 상태 한 줄 · 번들 버튼 잠김 · 체크포인트 없음 · 게시 대기 · 커밋 열쇠 폐기 · API 오류', async () => {
    OVERRIDE.set('/api/logs/integrity', { status: 200, json: { ...integrity(), started: false, latest: null, orgTreeSize: 0, anchors: [] } });
    const w = await boot(lang, '#/settings/tlog');
    expect(w.el('it-empty').hidden).toBe(false);
    expect(w.el('it-facts').hidden).toBe(true);
    expect(w.el('it-dl').disabled).toBe(true);

    const base = integrity();
    OVERRIDE.set('/api/logs/integrity', { status: 200, json: { ...base, latest: null, shredded: true, anchors: [] } });
    const v = await boot(lang, '#/settings/tlog');
    expect(v.el('it-dl').disabled).toBe(true);
    expect(v.el('it-cp').textContent).toBe(t(lang, '아직 체크포인트가 없습니다'));
    expect(v.el('it-shred').hidden).toBe(false);
    expect(v.el('it-ots').textContent).toBe('—');

    OVERRIDE.set('/api/logs/integrity', { status: 200, json: { ...base, latest: { ...(base['latest'] as object), published: false }, uncheckpointedLeaves: 0 } });
    const p = await boot(lang, '#/settings/tlog');
    expect(p.el('it-cp').textContent).toContain(t(lang, '게시 대기'));
    expect(p.el('it-size').textContent).toBe(`418${t(lang, '모두 체크포인트됨')}`);
    expect(p.el('it-shred').hidden).toBe(true);

    OVERRIDE.set('/api/logs/integrity', { status: 500, json: { error: 'internal' } });
    const e = await boot(lang, '#/settings/tlog');
    expect(e.el('it-facts').hidden).toBe(true);
    expect(e.el('it-dl').disabled).toBe(true);
    expect(e.el('it-msg').className).toBe('msg err');
  });

  it('Ⓕ-7 검증 번들 — 확인 대화상자(커밋 열쇠 경고) → GET /api/logs/bundle → Blob object URL을 <a download>로 눌러 저장(문서에 붙였다 뗀다) · 취소하면 요청 없음', async () => {
    const w = await boot(lang, '#/settings/tlog');
    w.el('it-dl').dispatch('click');
    await Promise.resolve();
    expect(w.el('dlg-confirm').open).toBe(true);
    const body = w.el('dc-body').textContent;
    expect(body).toContain(t(lang, '번들에는 이 조직의 커밋 열쇠(솔트 키)가 들어 있어 수신자·Message-ID를 열 수 있습니다. 조직 밖으로 보내지 마세요.'));
    w.el('dc-cancel').onclick?.();
    await Promise.resolve();
    expect(w.calls.some((c) => c.url.startsWith('/api/logs/bundle'))).toBe(false);
    expect(w.downloads).toHaveLength(0);

    w.el('it-dl').dispatch('click');
    await Promise.resolve();
    w.el('dc-ok').onclick?.();
    await new Promise((r) => setTimeout(r, 20));
    const call = w.calls.find((c) => c.url === '/api/logs/bundle');
    expect(call?.method).toBe('GET');
    // L4 — 번들 내려받기는 감사 행을 쓴다: 서버가 CSRF 헤더를 요구하고, 콘솔은 파일 내려받기 GET 에 세션의 CSRF 토큰을 싣는다.
    expect(call?.csrf).toBe('csrf-1');
    expect(w.calls.find((c) => c.url === '/api/logs/integrity')?.csrf).toBeUndefined();
    expect(w.downloads).toHaveLength(1);
    const dl = w.downloads[0];
    expect(dl?.href).toBe('blob:console/1');
    expect(dl?.download).toBe(BUNDLE_NAME);
    expect(dl?.attached).toBe(true); // 누를 때는 문서에 붙어 있고
    expect(dl?.node.parentNode).toBe(null); // 누른 뒤에는 뗐다
    expect(dl?.node.hidden).toBe(true);
    expect(w.objectUrls.created).toEqual([{ blobOf: { range: { from_epoch: 1811, to_epoch: 1834 } } }]);
    expect(w.el('it-msg').className).toBe('msg ok');
    expect(w.el('it-msg').textContent).toBe(t(lang, '내려받았습니다: {f}').replace('{f}', BUNDLE_NAME));
  });

  it('Ⓕ-8 파일 이름은 content-disposition의 평범한 *.json 이름만 — 경로·다른 확장자·헤더 없음은 기본 이름 · 413은 문구', async () => {
    for (const cd of ['attachment; filename="../../evil.json"', 'attachment; filename="run.sh"', '']) {
      OVERRIDE.set('/api/logs/bundle', { status: 200, json: {}, headers: cd ? { 'content-disposition': cd } : {} });
      const w = await boot(lang, '#/settings/tlog');
      w.el('it-dl').dispatch('click');
      await Promise.resolve();
      w.el('dc-ok').onclick?.();
      await new Promise((r) => setTimeout(r, 20));
      expect(w.downloads.map((d) => d.download), cd).toEqual(['atmark-log-bundle.json']);
    }
    OVERRIDE.set('/api/logs/bundle', { status: 413, json: { error: 'bundle_too_large' } });
    const e = await boot(lang, '#/settings/tlog');
    e.el('it-dl').dispatch('click');
    await Promise.resolve();
    e.el('dc-ok').onclick?.();
    await new Promise((r) => setTimeout(r, 20));
    expect(e.downloads).toHaveLength(0);
    expect(e.el('it-msg').textContent).toBe(t(lang, '번들이 너무 큽니다. 잠시 뒤 다시 시도하거나 운영자에게 문의하세요.'));
  });

  it('Ⓕ-9 로그 상세의 포함 증명 — tlogEntryId(양의 정수)가 올 때만 · 누르면 inclusion-proof를 받아 atmark-inclusion-<id>.json으로 저장', async () => {
    OVERRIDE.set('/api/logs/outbound/m-1', { status: 200, json: { ...OUT_LOG, tlogEntryId: '4182' } });
    const w = await boot(lang, '#/logs/outbound/m-1');
    const btn = find(w.el('dl-extra'), (n) => n.tagName === 'BUTTON' && n.textContent === t(lang, '포함 증명 내려받기'))[0];
    expect(btn).toBeDefined();
    btn?.dispatch('click');
    await new Promise((r) => setTimeout(r, 20));
    expect(w.calls.some((c) => c.method === 'GET' && c.url === '/api/logs/inclusion-proof?entry=4182')).toBe(true);
    expect(w.downloads.map((d) => d.download)).toEqual(['atmark-inclusion-4182.json']);

    // 잎이 체크포인트 전(tlogPending) — 단추 없이 한 줄.
    OVERRIDE.set('/api/logs/outbound/m-1', { status: 200, json: { ...OUT_LOG, tlogEntryId: null, tlogPending: true } });
    const pendingView = await boot(lang, '#/logs/outbound/m-1');
    expect(pendingView.el('dl-extra').textContent).toContain(t(lang, '다음 정시 체크포인트 뒤에 포함 증명을 내려받을 수 있습니다.'));
    expect(pendingView.el('dl-extra').textContent).not.toContain(t(lang, '포함 증명 내려받기'));

    for (const bad of [undefined, 'x1', '0', '12/../3']) {
      OVERRIDE.set('/api/logs/console/c-1', { status: 200, json: { id: 'c-1', at: '2026-09-24T02:00:00Z', action: 'logs.bundle_export', targetId: null, tlogEntryId: bad } });
      const v = await boot(lang, '#/logs/console/c-1');
      expect(v.el('dl-extra').textContent, String(bad)).not.toContain(t(lang, '포함 증명 내려받기'));
      // 새 콘솔 행위 이름도 두 언어 문구로 보인다.
      expect(v.el('dl-title').textContent).toBe(t(lang, '검증 번들 내려받기'));
    }
  });
});

// ---------------------------------------------------------------------------
// 정적 — 규율 회귀
// ---------------------------------------------------------------------------

describe.each(LANGS)('Ⓕ 정적 규율 (%s)', (lang) => {
  const page = renderAppPage(lang);
  const html = inlined(page);
  const script = blocks(html, 'script').at(-1) ?? '';

  it('Ⓕ-10 파일 저장은 object URL + <a download> 뿐 — innerHTML·data: URL·window.open 없음 · fetch는 여전히 한 곳 · CSP는 그대로(blob: 을 열지 않는다) · 해시가 맞다', () => {
    expect(script).toContain('URL.createObjectURL(blob)');
    expect(script).toContain('a.download=name');
    expect(script).toContain('URL.revokeObjectURL(u)');
    expect(script).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|data:|window\.open|msSaveBlob/);
    expect([...script.matchAll(/\bfetch\(/g)]).toHaveLength(1);
    expect(page.csp).toContain("connect-src 'self'");
    expect(page.csp).not.toMatch(/blob:|data:/);
    // 스크립트·스타일은 자산 — CSP 는 그 정확한 URL 을 싣고, 본문의 SRI 는 `inlined` 가 직접 쟀다.
    const src = /<script src="([^"]+)"/.exec(page.html)?.[1] ?? '∅';
    const href = /<link rel="stylesheet" href="([^"]+)"/.exec(page.html)?.[1] ?? '∅';
    expect(adminUiAsset(src)?.body).toBe(script);
    expect(adminUiAsset(href)?.body).toBe(blocks(html, 'style')[0]);
    expect(page.csp).toContain(` https://console.atmark.ai${src};`);
    expect(page.csp).toContain(`style-src https://console.atmark.ai${href};`);
  });

  it('Ⓕ-11 새 문구 — 사전 두 벌에 같은 키 · 무결성 ⓘ 는 금지 문구 없음 · 무결성 패널에 번호 라벨 없음', () => {
    const NEW = ['마지막 사용', '사용 기록 없음', '방금', '{n}분 전', '{n}시간 전', '보관 기간(1년)이 지나 본문이 삭제됐습니다.', '무결성', '검증 번들 내려받기', '포함 증명 내려받기'];
    for (const k of NEW) {
      expect(MESSAGES.ko[k], k).toBe(k);
      expect(MESSAGES.en[k], k).toBeTruthy();
      expect(HANGUL.test(MESSAGES.en[k] ?? ''), k).toBe(false);
    }
    const panel = /<section class="spane" id="s-tlog"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
    expect(panel.length).toBeGreaterThan(200);
    expect(panel).not.toMatch(/독립 검증|블록체인|independently verif|blockchain/i);
    expect(panel).not.toMatch(/class="n"|>0[1-9]</);
    if (lang === 'en') expect(HANGUL.test(panel)).toBe(false);
  });
});
