/**
 * 콘솔 "요금제 · 사용량"(과금 P0, ADR-0011) — 설정 행 · 한도 초과 배너 · 업그레이드 잠금 · 에이전트 분모 · 요금제 오류 문구(두 언어).
 * 결제가 열린 뒤의 동작(업그레이드 · 결제 관리 · 잠금 사유 · 역할)은 `admin-console-billing.test.ts`(WP-2).
 */

import { afterEach, describe, expect, it } from 'vitest';

import { renderAppPage } from '../../../src/admin/ui/index';

import { AGENT, boot, inlined, me, OVERRIDE, PLAN, PLAN_BRIEF, t } from './console-harness';

afterEach(() => OVERRIDE.clear());

const LANGS = ['ko', 'en'] as const;

describe.each(LANGS)('요금제 · 사용량 (%s)', (lang) => {
  it('설정 행 — 요금제 이름 · 한도 대 사용 표 · 업그레이드는 잠겨 있고 ⓘ 는 결제 준비 중', async () => {
    const html = inlined(renderAppPage(lang));
    expect(html).toContain('id="s-plan"');
    expect(html).toMatch(/<button type="button" class="btn" id="pl-upgrade" disabled>/);
    expect(html).toContain(t(lang, '결제 준비 중입니다. 요금제를 바꾸려면 운영자에게 요청하세요.'));
    const w = await boot(lang, '#/settings/plan');
    expect(w.calls.some((c) => c.url === '/api/plan')).toBe(true);
    expect(w.el('pl-name').textContent).toBe('Beta');
    const rows = w.el('pl-body').all().filter((n) => n.tagName === 'TR');
    expect(rows.length).toBe(4); // 조직 사용량 넷 — 에이전트·메일마다 한도 일곱은 따로 소표(F55)
    expect(w.el('pl-body2').all().filter((n) => n.tagName === 'TR')).toHaveLength(7);
    const first = rows[0]?.all().filter((n) => n.tagName === 'TD').map((n) => n.textContent) ?? [];
    expect(first).toEqual([t(lang, '에이전트(삭제한 것 제외)'), '1', '10']);
    expect(w.el('pl-cap').textContent).toBe(t(lang, '새 조직은 하루 발송량을 단계적으로 늘립니다(오늘 상한 수신자 {n}명). 요금제를 올려도 앞당겨지지 않습니다.').replace('{n}', '1,000'));
    // 결제 상태(`GET /api/billing`)를 읽지 못하면(여기서는 404) 지금처럼 잠겨 있다 — ⓘ 는 결제 준비 중(WP-2 · `admin-console-billing.test.ts`).
    expect(w.calls.some((c) => c.url === '/api/billing')).toBe(true);
    expect(w.el('pl-upgrade').disabled).toBe(true);
    expect(w.el('bl-why').textContent).toBe(t(lang, '결제 준비 중입니다. 요금제를 바꾸려면 운영자에게 요청하세요.'));
    expect(w.el('bl-portal').hidden).toBe(true);
    expect(w.el('pl-msg').textContent).toBe('');
    expect(w.el('pl-banner').hidden).toBe(true);
  });

  it('별칭 주소가 이 조직에 닫혀 있으면(features.addressAliases=false) 별칭 행을 숨긴다 · 없거나 true 면 보인다', async () => {
    const labels = (w: Awaited<ReturnType<typeof boot>>) =>
      w.el('pl-body2').all().filter((n) => n.tagName === 'TR').map((row) => row.all().find((n) => n.tagName === 'TD')?.textContent);
    OVERRIDE.set('/api/plan', { status: 200, json: { ...PLAN, features: { addressAliases: false } } });
    const closed = await boot(lang, '#/settings/plan');
    expect(labels(closed)).toHaveLength(6);
    expect(labels(closed)).not.toContain(t(lang, '에이전트당 별칭 주소'));
    OVERRIDE.set('/api/plan', { status: 200, json: { ...PLAN, features: { addressAliases: true } } });
    expect(labels(await boot(lang, '#/settings/plan'))).toContain(t(lang, '에이전트당 별칭 주소'));
  });

  it('행이 없는 조직(Free 기본) · 요금제가 하루 한도를 정하면 그렇게 말한다 · 한도 초과는 배너', async () => {
    OVERRIDE.set('/api/plan', {
      status: 200,
      json: {
        ...PLAN,
        plan: { ...PLAN.plan, code: 'free', basis: 'missing', rowCode: null, source: null, version: null },
        limits: { ...PLAN.limits, maxAgents: 3, orgApiKeysMax: 1, orgDailyRecipients: 100 },
        usage: { ...PLAN.usage, agents: 4, orgKeys: 2, dailyCap: 100, dailyCapReason: 'plan_daily_cap' },
        overLimit: ['agents', 'org_keys'],
      },
    });
    const w = await boot(lang, '#/settings/plan');
    expect(w.el('pl-name').textContent).toBe(`Free${t(lang, ' · 기본')}`);
    expect(w.el('pl-cap').textContent).toBe(t(lang, '오늘 하루 한도는 요금제가 정합니다.'));
    expect(w.el('pl-over').hidden).toBe(false);
    expect(w.el('pl-banner').hidden).toBe(false);
    expect(w.el('pl-over-d').textContent).toBe(`${t(lang, '에이전트')} · ${t(lang, '조직 API 키')}`);
  });

  it('/api/me의 요약만으로 — 에이전트 분모는 요금제 한도 · 초과면 부팅 때 배너(추가 요청 없음)', async () => {
    OVERRIDE.set('/api/me', me('owner', { plan: { ...PLAN_BRIEF, maxAgents: 3, overLimit: ['agents'] } }));
    OVERRIDE.set('/api/agents', { status: 200, json: [AGENT] });
    const w = await boot(lang, '#/agents');
    expect(w.el('ag-count').textContent).toBe('1 / 3');
    expect(w.el('pl-banner').hidden).toBe(false);
    expect(w.calls.some((c) => c.url === '/api/plan')).toBe(false);
  });

  it('요금제 오류 문구 — agent_limit(요금제) · agent_total_limit · plan_per_minute_limit · plan_daily_cap 사유', () => {
    const html = inlined(renderAppPage(lang));
    for (const ko of [
      '요금제의 에이전트 한도에 닿았습니다(삭제한 에이전트 제외). 쓰지 않는 에이전트를 삭제하면 자리가 납니다. 설정 › 요금제 · 사용량에서 확인하세요.',
      '요금제의 메일당 수신자 한도 초과',
      '삭제한 것을 포함한 에이전트가 한도에 닿았습니다(요금제 한도의 3배). 삭제한 에이전트도 이 수에는 계속 셉니다.',
      '분당 발송은 요금제 한도를 넘을 수 없습니다. 설정 › 요금제 · 사용량에서 확인하세요.',
      '요금제 하루 한도 초과',
    ]) {
      // 페이지 스크립트는 ASCII 밖 글자를 \uXXXX 로, 작은따옴표를 \' 로 싣는다.
      const escaped = t(lang, ko).replace(/'/g, "\\'").replace(/[^\x00-\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
      expect(html, ko).toContain(escaped);
    }
  });
});
