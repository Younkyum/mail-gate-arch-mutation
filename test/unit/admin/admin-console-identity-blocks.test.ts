/**
 * 콘솔 신원 화면 — US-013 변경 이력 블록(`GET /api/agents/{id}/identity-blocks` — 체크포인트 배지 · 블록마다 포함 증명 · 불일치 표시 ·
 * 내려받기). 가짜 DOM 위에서 실제 앱 스크립트를 돌린다(`console-harness.ts`). v4 에서 카드 뒷면·"NFT처럼 보기"(수집 카드)는 없어졌고
 * (카드 · 무늬 · 오른쪽 정보는 `admin-console-v4.test.ts` Ⓘ), 이 파일은 블록과 문구 규칙만 본다.
 *
 * 금지 문구(두 언어): 블록체인 신원 · blockchain identity · NFT · mint · 민팅 · 독립 검증 · independently verifiable · 변조 불가 ·
 * tamper-proof. v4 부터 "NFT" 라는 낱말은 화면에 없다(체인 발행 없음 — 창업자: UI 만).
 *
 * 되돌려서 빨개지는지 확인한 것(보고서 되돌림 표): `blockNode` 의 `if(c.matches===false)…` 를 빼면 → Ⓑ-2.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { MESSAGES } from '../../../src/admin/ui/i18n';
import { renderAppPage } from '../../../src/admin/ui/index';
import { LOGO } from '../../../src/admin/ui/page';

import { blocks, boot, type FakeNode, HANGUL, IDENTITY_BLOCKS, inlined, KEY_FP, OVERRIDE, t } from './console-harness';

afterEach(() => OVERRIDE.clear());

const LANGS = ['ko', 'en'] as const;
const find = (root: FakeNode, pred: (n: FakeNode) => boolean): FakeNode[] => root.all().filter(pred);
const hasClass = (n: FakeNode, c: string): boolean => n.className.split(/\s+/).includes(c);
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

describe.each(LANGS)('Ⓑ 신원 변경 이력 블록 (%s)', (lang) => {
  it('Ⓑ-1 블록 — seq 순서 그대로 · 종류 라벨 · 체크포인트 배지(대기 포함) · prev → hash · 포함 증명 단추는 체크포인트에 든 블록만', async () => {
    const w = await boot(lang, '#/agents/a1/identity');
    expect(w.calls.some((c) => c.method === 'GET' && c.url === '/api/agents/a1/identity-blocks')).toBe(true);
    const items = w.el('ib-list').children;
    expect(items).toHaveLength(IDENTITY_BLOCKS.blocks.length);
    expect(items.map((li) => find(li, (n) => hasClass(n, 'blk-k'))[0]?.textContent)).toEqual(
      [t(lang, '생성'), t(lang, '키 연결'), t(lang, '주소 연결'), t(lang, '정보 변경')],
    );
    expect(items.map((li) => find(li, (n) => hasClass(n, 'blk-seq'))[0]?.textContent)).toEqual([3, 4, 5, 6].map((n) => t(lang, '순번 {n}').replace('{n}', String(n))));
    expect(items[0]?.textContent).toContain(t(lang, '체크포인트 #{e}').replace('{e}', '1830'));
    expect(items[3]?.textContent).toContain(t(lang, '체크포인트 대기'));
    const hash = find(items[1] as FakeNode, (n) => hasClass(n, 'blk-hash'))[0];
    expect(hash?.textContent).toBe('aaaaaaaa…aaaa → bbbbbbbb…bbbb');
    expect(hash?.title).toBe('b'.repeat(64));
    const proofs = find(w.el('ib-list'), (n) => n.tagName === 'BUTTON' && hasClass(n, 'blk-proof'));
    expect(proofs).toHaveLength(3);
    expect(proofs.every((b) => b.textContent === t(lang, '증명'))).toBe(true);
    // 주소의 '@' 는 .at(글자색) · 공개키 지문은 줄인 모노 + 전체는 title.
    const addressDd = find(items[2] as FakeNode, (n) => n.tagName === 'DD')[0];
    expect(find(addressDd as FakeNode, (n) => hasClass(n, 'at')).map((n) => n.textContent)).toEqual(['@']);
    const keyDd = find(items[1] as FakeNode, (n) => n.tagName === 'DD')[0];
    expect(keyDd?.textContent).toBe(`${KEY_FP.slice(0, 8)}…${KEY_FP.slice(-4)}`);
    expect(keyDd?.title).toBe(KEY_FP);
    expect(w.el('ib-empty').hidden).toBe(true);
    expect(w.el('ib-dl').disabled).toBe(false);
    if (lang === 'en') expect(HANGUL.test(w.el('ib-list').textContent)).toBe(false);
  });

  it('Ⓑ-2 불일치(matches:false)는 그 칸 옆에 "기록과 다름" — 일치·알 수 없음(null)은 표시 없음 · 상태 코드는 라벨로', async () => {
    const tampered = structuredClone(IDENTITY_BLOCKS);
    const address = tampered.blocks[2];
    if (address !== undefined) address.changes = [{ field: 'address', value: 'forged@atmark.ai', matches: false }, { field: 'primary', value: true, matches: true }];
    OVERRIDE.set('/api/agents/a1/identity-blocks', { status: 200, json: tampered });
    const w = await boot(lang, '#/agents/a1/identity');
    const items = w.el('ib-list').children;
    const differs = (li: FakeNode | undefined): number => find(li as FakeNode, (n) => n.textContent === t(lang, '기록과 다름') && hasClass(n, 'pill')).length;
    expect(items.map(differs)).toEqual([0, 0, 1, 0]);
    expect(items[2]?.textContent).toContain('forged@atmark.ai');
    // 상태 코드 → 라벨(에이전트 상태 표) · 대표 주소 → 예/아니오.
    expect(items[0]?.textContent).toContain(t(lang, '준비 중'));
    expect(items[3]?.textContent).toContain(t(lang, '활성'));
    expect(items[2]?.textContent).toContain(t(lang, '예'));
  });

  it('Ⓑ-3 블록마다 포함 증명 — 기존 엔드포인트(inclusion-proof?entry=)를 atmark-inclusion-<id>.json으로 저장 · 블록 파일 내려받기', async () => {
    const w = await boot(lang, '#/agents/a1/identity');
    const proof = find(w.el('ib-list'), (n) => n.tagName === 'BUTTON' && hasClass(n, 'blk-proof'))[1];
    proof?.dispatch('click');
    await settle();
    expect(w.calls.some((c) => c.method === 'GET' && c.url === '/api/logs/inclusion-proof?entry=902')).toBe(true);
    expect(w.downloads.map((d) => d.download)).toEqual(['atmark-inclusion-902.json']);
    expect(w.el('ib-msg').className).toBe('msg ok');
    w.el('ib-dl').dispatch('click');
    await settle();
    expect(w.downloads.map((d) => d.download)).toEqual(['atmark-inclusion-902.json', 'atmark-identity-blocks-a1.json']);
    // M4 — 내려받는 파일은 블록마다 포함 증명 + 서명 체크포인트 닻을 싣는다(pnpm log:verify --key 가 "증명" 으로 통과시킨다).
    expect(w.calls.some((c) => c.method === 'GET' && c.url === '/api/agents/a1/identity-blocks?proofs=1')).toBe(true);
  });

  it('Ⓑ-2b 서열 대기(pending:true)는 "기록 대기" · 빠진 블록(missing — source.missing)은 seq 자리에 "빠진 블록" 항목으로(L3 · L4)', async () => {
    const x = structuredClone(IDENTITY_BLOCKS);
    const last = x.blocks[3];
    if (last !== undefined) last.changes = [{ field: 'status', value: 'active', matches: null, pending: true } as never];
    x.missing = [
      { entryId: '950', seq: 5, at: '2026-09-21T01:00:00.000000Z', table: 'passport_documents', reason: 'not_found', leaf: '{}', leafHash: 'f'.repeat(64), checkpoint: { state: 'pending' } },
    ];
    // 빠진 블록은 seq 순서로 끼운다 — seq 5 인 주소 블록 뒤, seq 6 앞.
    OVERRIDE.set('/api/agents/a1/identity-blocks', { status: 200, json: x });
    const w = await boot(lang, '#/agents/a1/identity');
    const items = w.el('ib-list').children;
    expect(items).toHaveLength(5);
    const pending = (li: FakeNode | undefined): number => find(li as FakeNode, (n) => n.textContent === t(lang, '기록 대기') && hasClass(n, 'pill')).length;
    const differs = (li: FakeNode | undefined): number => find(li as FakeNode, (n) => n.textContent === t(lang, '기록과 다름') && hasClass(n, 'pill')).length;
    expect(pending(items[4])).toBe(1);
    expect(differs(items[4])).toBe(0);
    const miss = items[3] as FakeNode;
    expect(hasClass(miss, 'blk-miss')).toBe(true);
    expect(find(miss, (n) => hasClass(n, 'blk-k'))[0]?.textContent).toBe(t(lang, '빠진 블록'));
    expect(miss.textContent).toContain(t(lang, '원천 행 없음'));
    expect(miss.textContent).toContain(t(lang, '패스포트'));
    if (lang === 'en') expect(HANGUL.test(w.el('ib-list').textContent)).toBe(false);
  });

  it('Ⓑ-4 빈 상태 · 속도 제한(429) · 다른 에이전트의 응답은 그리지 않는다', async () => {
    OVERRIDE.set('/api/agents/a1/identity-blocks', { status: 200, json: { ...IDENTITY_BLOCKS, blocks: [] } });
    const e = await boot(lang, '#/agents/a1/identity');
    expect(e.el('ib-empty').hidden).toBe(false);
    expect(inlined(renderAppPage(lang))).toContain(`<p class="small muted" id="ib-empty" hidden>${t(lang, '변경 이력이 없습니다.')}</p>`);
    expect(e.el('ib-dl').disabled).toBe(true);
    OVERRIDE.set('/api/agents/a1/identity-blocks', { status: 429, json: { error: 'rate_limited' } });
    // 429 인 GET 은 두 번 더 보낸 뒤(백오프 — `core.ts` NET) 그래도 429 면 오류를 그린다.
    const r = await boot(lang, '#/agents/a1/identity', { timers: 'fast' });
    expect(r.calls.filter((c) => c.url === '/api/agents/a1/identity-blocks')).toHaveLength(3);
    expect(r.el('ib-msg').className).toBe('msg err');
    expect(r.el('ib-msg').textContent).toBe(t(lang, '요청이 너무 잦습니다. 잠시 뒤 다시 시도하세요.'));
    expect(r.el('ib-list').children).toHaveLength(0);
    expect(r.el('ib-empty').hidden).toBe(true);
  });

});

describe.each(LANGS)('Ⓑ 정적 — 문구 규칙 (%s)', (lang) => {
  const html = inlined(renderAppPage(lang));
  const script = blocks(html, 'script').at(-1) ?? '';
  const pane = /<div class="pane" id="t-identity"[\s\S]*?<\/section><\/div>/.exec(html)?.[0] ?? '';

  it('Ⓑ-7 금지 문구 0 · "NFT"는 어느 언어에도 없다(v4) · 블록 ⓘ 는 체인 규칙과 검증 명령을 말한다', () => {
    expect(pane.length).toBeGreaterThan(1000);
    const everything = `${html}\n${script}`;
    // `\bmint(ed|ing|s)?\b` — 낱말만(스크립트의 `minTurns` 같은 식별자는 아니다).
    expect(everything).not.toMatch(/블록체인 신원|blockchain identity|NFT|\bmint(ed|ing|s)?\b|민팅|독립 검증|independently verifiable|변조 불가|tamper-proof|수집 카드|collectible/i);
    expect(html).not.toContain('id="ai-v-clt"');
    expect(html).not.toContain('id="ai-flip"');
    const blocksTip = /<div class="tip-pop" id="tip-blocks" hidden>([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '';
    expect(blocksTip).toContain('SHA-256');
    expect(blocksTip).toContain('<code>pnpm log:verify</code>');
  });

  it('Ⓑ-8 문구는 사전 두 벌에 · 영어 화면에 한글 없음 · 상시 설명 없이 ⓘ 뒤로(R2) · 번호 라벨 없음 · .at 은 @ 하나', () => {
    const NEW = ['패스포트', 'JWS 지문', '에이전트 ID', '변경 이력', '변경 이력 설명', '변경 이력이 없습니다.', '생성', '정보 변경', '주소 연결', '키 연결', '정지한 쪽', '대표 주소', '알고리즘', '체크포인트 #{e}', '체크포인트 대기', '증명', '기록과 다름'];
    for (const k of NEW) {
      expect(MESSAGES.ko[k], k).toBe(k);
      expect(MESSAGES.en[k], k).toBeTruthy();
      expect(HANGUL.test(MESSAGES.en[k] ?? ''), k).toBe(false);
    }
    if (lang === 'en') expect(HANGUL.test(pane)).toBe(false);
    const visible = pane.replace(/<div class="tip-pop"[^>]*>[\s\S]*?<\/div>/g, '');
    expect(visible).not.toContain('SHA-256');
    expect(visible).not.toMatch(/class="n"|>0[1-9]</);
    // 카드의 로고는 SVG 가로 조합 하나(`src/ui/brand.ts` — 2026-09-30, currentColor) · 옛 글자 로고(`.at` + mark)는 없다 · 카드 SVG 에 색 속성 없음(색은 스타일시트의 카드 토큰).
    expect(pane.split(LOGO)).toHaveLength(2);
    expect(pane).not.toContain('<span class="at">@</span>mark');
    expect(pane).not.toMatch(/<svg class="idc-svg"[^>]*\b(fill|stroke|style)=/);
  });
});
