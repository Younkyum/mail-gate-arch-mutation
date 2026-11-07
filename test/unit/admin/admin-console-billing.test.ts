/**
 * 콘솔 결제(WP-2 — 계획 §3-8 · 진윤겸 결정 D-5 owner + admin) — 가짜 DOM 위에서 앱 스크립트를 실제로 돌린다(`console-harness.ts`).
 *
 *   ① 잠김: `/api/billing` 을 읽지 못하거나 스위치 꺼짐이면 지금과 같은 잠긴 단추 · ⓘ "결제 준비 중" · 결제 관리 없음.
 *      잠금 사유(beta · 검토 전 · 구독 있음 · 지배 요금제 없음 · 샌드박스)는 ⓘ 한 줄로.
 *   ② 열림(owner·admin): 고를 수 있는 요금제만 · 누르면 `POST /api/billing/checkout {plan}`(CSRF) → 돌아온 URL 이 `https://pay.atmark.ai/?_ptxn=txn_…`
 *      모양일 때만 그 주소로 옮긴다 · 모양 밖이면 옮기지 않고 오류 · 서버 거부 코드는 사전 문구.
 *   ③ member: 결제 단추·결제 관리가 없고 "결제는 소유자·관리자가 합니다" 한 줄.
 *   ④ 구독 표시: 결제 실패 배너(유예 끝 시각) · 해지 예정 · 다음 결제 · 결제 관리 → 포털(Paddle 호스트만).
 *   ⑤ 결제에서 돌아오면(`?billing=return`) 5초 간격 최대 6번 다시 읽고, 구독이 active 가 되면 멈춘다. 그동안 업그레이드는 잠기고 ⓘ 는 "처리 중"
 *      (서버가 열려 있다고 해도 두 번째 결제를 만들지 않는다 — M-8).
 *   ⑥ 페이지: 결제 스크립트(Paddle.js)·결제 호스트를 CSP·마크업에 싣지 않는다 · 결제 오류 코드는 두 언어 사전에 있다.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { BILLING_ERROR_CODES } from '../../../src/admin/ops/billing';
import { MESSAGES } from '../../../src/admin/ui/i18n';
import { renderAppPage } from '../../../src/admin/ui/index';

import { boot, CSP_ASSET_URL, inlined, me, OVERRIDE, settle, t, type World } from './console-harness';

afterEach(() => OVERRIDE.clear());

const LANGS = ['ko', 'en'] as const;
const TXN_URL = `https://pay.atmark.ai/?_ptxn=txn_${'a1'.repeat(13)}`;
const PORTAL = 'https://sandbox-customer-portal.paddle.com/cpl_01abc?token=pga_x';

/** `GET /api/billing` 한 벌(열림 — owner). */
const BILLING = {
  enabled: true,
  environment: 'sandbox',
  canManage: true,
  upgradeAvailable: true,
  lockedReason: null as string | null,
  plans: [
    { code: 'pro', available: false },
    { code: 'team', available: true },
    { code: 'scale', available: true },
  ],
  subscription: null as Record<string, unknown> | null,
  portalAvailable: false,
};

const href = (w: World): string | undefined => (w.location as unknown as { href?: string }).href;
const pickOptions = (w: World): string[] => w.el('bl-pick').children.map((o) => (o as unknown as { value: string }).value);

describe.each(LANGS)('콘솔 결제 (%s)', (lang) => {
  describe('① 잠김', () => {
    it('/api/billing을 읽지 못하면(404) · 스위치 꺼짐이면 지금과 같은 잠긴 단추 + ⓘ 결제 준비 중 · 결제 관리 없음', async () => {
      for (const response of [undefined, { status: 200, json: { ...BILLING, enabled: false, upgradeAvailable: false, lockedReason: 'disabled' } }]) {
        if (response !== undefined) OVERRIDE.set('/api/billing', response);
        const w = await boot(lang, '#/settings/plan');
        expect(w.el('pl-upgrade').disabled).toBe(true);
        expect(w.el('pl-upgrade').hidden).toBe(false);
        expect(w.el('bl-pick-w').hidden).toBe(true);
        expect(w.el('bl-why').textContent).toBe(t(lang, '결제 준비 중입니다. 요금제를 바꾸려면 운영자에게 요청하세요.'));
        expect(w.el('bl-portal').hidden).toBe(true);
        expect(w.el('bl-member').hidden).toBe(true);
        expect(w.el('bl-due').hidden).toBe(true);
        // 잠긴 단추는 눌러도 아무것도 보내지 않는다.
        w.el('pl-upgrade').click();
        await settle();
        expect(w.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
      }
    });

    it.each([
      ['beta', '베타 기간에는 결제가 열리지 않습니다. 베타 요금제는 무료입니다.'],
      ['not_active', '운영자 검토가 끝난 조직만 결제할 수 있습니다.'],
      ['subscription_exists', '이미 구독이 있습니다. 결제 관리에서 확인하세요.'],
      ['no_higher_plan', '지금 한도보다 모든 항목이 넓은 요금제가 없습니다. 한도를 바꾸려면 운영자에게 요청하세요.'],
      ['sandbox_not_allowed', '이 조직은 시험 결제 대상이 아닙니다.'],
      ['not_configured', '결제 준비 중입니다. 요금제를 바꾸려면 운영자에게 요청하세요.'],
      ['something_new', '결제 준비 중입니다. 요금제를 바꾸려면 운영자에게 요청하세요.'],
    ])('잠금 사유 %s → 잠긴 단추 + ⓘ 한 줄', async (reason, ko) => {
      OVERRIDE.set('/api/billing', { status: 200, json: { ...BILLING, upgradeAvailable: false, lockedReason: reason } });
      const w = await boot(lang, '#/settings/plan');
      expect(w.el('pl-upgrade').disabled).toBe(true);
      expect(w.el('bl-pick-w').hidden).toBe(true);
      expect(w.el('bl-why').textContent).toBe(t(lang, ko));
    });

    it('열려 있다고 해도 고를 수 있는 요금제가 없으면 잠김(지배 요금제 없음)', async () => {
      OVERRIDE.set('/api/billing', { status: 200, json: { ...BILLING, plans: BILLING.plans.map((p) => ({ ...p, available: false })) } });
      const w = await boot(lang, '#/settings/plan');
      expect(w.el('pl-upgrade').disabled).toBe(true);
      expect(w.el('bl-why').textContent).toBe(t(lang, '지금 한도보다 모든 항목이 넓은 요금제가 없습니다. 한도를 바꾸려면 운영자에게 요청하세요.'));
    });
  });

  describe('② 열림 — owner·admin', () => {
    it.each(['owner', 'admin'])('%s: 고를 수 있는 요금제만 · 누르면 checkout(CSRF) → pay.atmark.ai로 옮긴다', async (role) => {
      OVERRIDE.set('/api/me', me(role));
      OVERRIDE.set('/api/billing', { status: 200, json: BILLING });
      OVERRIDE.set('POST /api/billing/checkout', { status: 200, json: { url: TXN_URL } });
      const w = await boot(lang, '#/settings/plan');
      expect(w.el('pl-upgrade').disabled).toBe(false);
      expect(w.el('bl-pick-w').hidden).toBe(false);
      expect(pickOptions(w)).toEqual(['team', 'scale']);
      expect(w.el('bl-why').textContent).toBe(t(lang, '가격은 결제 화면에서 확인합니다. 결제는 pay.atmark.ai에서 Paddle이 처리하고, 끝나면 이 화면으로 돌아옵니다.'));
      w.el('bl-pick').value = 'scale';
      w.el('pl-upgrade').click();
      await settle();
      const post = w.calls.filter((c) => c.method === 'POST');
      expect(post).toEqual([{ method: 'POST', url: '/api/billing/checkout', body: { plan: 'scale' }, csrf: 'csrf-1' }]);
      expect(href(w)).toBe(TXN_URL);
      expect(w.el('bl-msg').textContent).toBe(t(lang, '결제 화면으로 이동합니다.'));
    });

    it('돌아온 URL이 결제 페이지 모양이 아니면 옮기지 않는다(다른 호스트 · 거래 id 없음 · 자바스크립트 URL)', async () => {
      for (const url of ['https://evil.example/?_ptxn=txn_x', 'https://pay.atmark.ai.evil.example/?_ptxn=txn_' + 'a'.repeat(26), 'https://pay.atmark.ai/', 'javascript:alert(1)', 42]) {
        OVERRIDE.set('/api/billing', { status: 200, json: BILLING });
        OVERRIDE.set('POST /api/billing/checkout', { status: 200, json: { url } });
        const w = await boot(lang, '#/settings/plan');
        w.el('pl-upgrade').click();
        await settle();
        expect(href(w), String(url)).toBeUndefined();
        expect(w.el('bl-msg').className).toBe('msg err');
        expect(w.el('bl-msg').textContent).toContain(t(lang, '지금은 결제를 열 수 없습니다. 잠시 뒤 다시 시도하세요.'));
        OVERRIDE.clear();
      }
    });

    it.each([
      ['billing_beta_locked', 409, '베타 기간에는 결제가 열리지 않습니다.'],
      ['billing_plan_not_higher', 409, '이 요금제는 지금 한도보다 좁은 항목이 있어 결제할 수 없습니다.'],
      ['billing_subscription_exists', 409, '이미 구독이 있습니다. 결제 관리에서 확인하세요.'],
      ['billing_org_not_active', 403, '운영자 검토가 끝난 조직만 결제할 수 있습니다.'],
      ['billing_provider_error', 502, '결제 서비스에 닿지 못했습니다. 잠시 뒤 다시 시도하세요.'],
      ['billing_checkout_busy', 409, '다른 창에서 결제를 준비하고 있습니다. 잠시 뒤 다시 시도하세요.'],
      ['billing_checkout_limit', 429, '오늘은 결제 화면을 더 열 수 없습니다. 내일 다시 시도하거나 운영자에게 문의하세요.'],
      ['forbidden_role', 403, '내 역할로는 할 수 없는 작업입니다. 조직 소유자에게 역할을 요청하세요.'],
    ])('서버 거부 %s → 사전 문구(서버 detail은 덧붙이지 않는다) · 옮기지 않는다', async (code, status, ko) => {
      OVERRIDE.set('/api/billing', { status: 200, json: BILLING });
      OVERRIDE.set('POST /api/billing/checkout', { status, json: { error: code, detail: '서버 내부 설명' } });
      const w = await boot(lang, '#/settings/plan');
      w.el('pl-upgrade').click();
      await settle();
      expect(href(w)).toBeUndefined();
      expect(w.el('bl-msg').textContent).toBe(t(lang, ko));
      expect(w.el('pl-upgrade').disabled).toBe(false);
    });
  });

  describe('③ member', () => {
    it('결제 단추·결제 관리가 없고 안내 한 줄 — 서버가 canManage를 잘못 줘도 스크립트가 역할로 한 번 더 막는다', async () => {
      OVERRIDE.set('/api/me', me('member'));
      OVERRIDE.set('/api/billing', { status: 200, json: { ...BILLING, canManage: true, portalAvailable: true } });
      const w = await boot(lang, '#/settings/plan');
      expect(w.el('pl-upgrade').hidden).toBe(true);
      expect(w.el('pl-upgrade').disabled).toBe(true);
      expect(w.el('tipb-upgrade').hidden).toBe(true);
      expect(w.el('bl-pick-w').hidden).toBe(true);
      expect(w.el('bl-portal').hidden).toBe(true);
      expect(w.el('bl-member').hidden).toBe(false);
      expect(inlined(renderAppPage(lang))).toContain(`<p class="small muted" id="bl-member" hidden>${t(lang, '결제는 소유자·관리자가 합니다.')}</p>`);
      w.el('pl-upgrade').click();
      w.el('bl-portal').click();
      await settle();
      expect(w.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    });
  });

  describe('④ 구독 표시 · 결제 관리', () => {
    it('결제 실패(past_due) → 배너에 유예 끝 · 구독 줄 · 결제 관리 → 포털(Paddle 호스트)', async () => {
      OVERRIDE.set('/api/billing', {
        status: 200,
        json: {
          ...BILLING,
          upgradeAvailable: false,
          lockedReason: 'subscription_exists',
          portalAvailable: true,
          subscription: { status: 'past_due', plan: 'team', currentPeriodEnd: '2026-11-01T00:00:00Z', scheduledChange: null, graceUntil: '2026-10-15T00:00:00Z' },
        },
      });
      OVERRIDE.set('POST /api/billing/portal', { status: 200, json: { url: PORTAL } });
      const w = await boot(lang, '#/settings/plan');
      expect(w.el('bl-due').hidden).toBe(false);
      expect(w.el('bl-due-d').textContent).toContain(lang === 'ko' ? '까지 결제 수단을 고치지 않으면 Free로 바뀝니다.' : 'Update your payment method by ');
      expect(w.el('bl-sub').hidden).toBe(false);
      expect(w.el('bl-sub').textContent.startsWith(`Team · ${t(lang, '결제 실패')} · `)).toBe(true);
      expect(w.el('bl-portal').hidden).toBe(false);
      w.el('bl-portal').click();
      await settle();
      expect(w.calls.filter((c) => c.method === 'POST')).toEqual([{ method: 'POST', url: '/api/billing/portal', body: undefined, csrf: 'csrf-1' }]);
      expect(href(w)).toBe(PORTAL);
    });

    it('포털이 공유 고객이라 409 billing_portal_shared_customer → 사전 문구 · 옮기지 않는다', async () => {
      OVERRIDE.set('/api/billing', { status: 200, json: { ...BILLING, upgradeAvailable: false, lockedReason: 'subscription_exists', portalAvailable: true } });
      OVERRIDE.set('POST /api/billing/portal', { status: 409, json: { error: 'billing_portal_shared_customer', detail: '서버 내부 설명' } });
      const w = await boot(lang, '#/settings/plan');
      w.el('bl-portal').click();
      await settle();
      expect(href(w)).toBeUndefined();
      expect(w.el('bl-msg').textContent).toBe(t(lang, '이 결제 계정에는 다른 조직의 구독도 있어 여기서 결제 관리를 열 수 없습니다. 운영자에게 문의하세요.'));
    });

    it('해지 예정이면 그 시각 · 포털 URL이 Paddle 호스트가 아니면 옮기지 않는다', async () => {
      OVERRIDE.set('/api/billing', {
        status: 200,
        json: {
          ...BILLING,
          upgradeAvailable: false,
          lockedReason: 'subscription_exists',
          portalAvailable: true,
          subscription: { status: 'active', plan: 'pro', currentPeriodEnd: '2026-11-01T00:00:00Z', scheduledChange: { action: 'cancel', at: '2026-11-01T00:00:00Z' }, graceUntil: null },
        },
      });
      OVERRIDE.set('POST /api/billing/portal', { status: 200, json: { url: 'https://paddle.com.evil.example/x' } });
      const w = await boot(lang, '#/settings/plan');
      expect(w.el('bl-due').hidden).toBe(true);
      expect(w.el('bl-sub').textContent).toContain(`Pro · ${t(lang, '구독 중')} · `);
      expect(w.el('bl-sub').textContent).toContain(lang === 'ko' ? '해지 예정: ' : 'Cancels on ');
      w.el('bl-portal').click();
      await settle();
      expect(href(w)).toBeUndefined();
      expect(w.el('bl-msg').className).toBe('msg err');
    });
  });

  describe('⑤ 결제에서 돌아오면', () => {
    it('?billing=return → 5초 간격으로 다시 읽고 구독이 active가 되면 멈춘다 · 최대 6번', async () => {
      const waiting = { status: 200, json: BILLING };
      const active = { status: 200, json: { ...BILLING, upgradeAvailable: false, lockedReason: 'subscription_exists', subscription: { status: 'active', plan: 'team', currentPeriodEnd: null, scheduledChange: null, graceUntil: null } } };
      OVERRIDE.set('/api/billing', [waiting, waiting, waiting, active]);
      const w = await boot(lang, '#/overview', { timers: 'fast' });
      (w.location as unknown as { search: string }).search = '?billing=return';
      await w.go('#/settings/plan');
      for (let i = 0; i < 6; i++) await settle();
      expect(w.calls.filter((c) => c.url === '/api/billing')).toHaveLength(4);
      // 구독이 보이면 처리 중이 풀리고 서버의 잠금 사유(구독 있음)가 보인다.
      expect(w.el('bl-why').textContent).toBe(t(lang, '이미 구독이 있습니다. 결제 관리에서 확인하세요.'));
      expect(w.delays.filter((ms) => ms === 5000)).toHaveLength(3);
      expect(w.el('bl-sub').hidden).toBe(false);

      OVERRIDE.set('/api/billing', { status: 200, json: BILLING });
      const never = await boot(lang, '#/overview', { timers: 'fast' });
      (never.location as unknown as { search: string }).search = '?billing=return';
      await never.go('#/settings/plan');
      for (let i = 0; i < 10; i++) await settle();
      expect(never.calls.filter((c) => c.url === '/api/billing')).toHaveLength(7);
      expect(never.delays.filter((ms) => ms === 5000)).toHaveLength(6);
      // 구독이 보이기 전 — 서버는 열려 있다고 하지만 업그레이드는 잠기고 "처리 중" · 눌러도 보내지 않는다.
      expect(never.el('pl-upgrade').disabled).toBe(true);
      expect(never.el('bl-pick-w').hidden).toBe(true);
      expect(never.el('bl-why').textContent).toBe(t(lang, '결제를 처리하는 중입니다. 반영되면 이 화면에 나타납니다.'));
      never.el('pl-upgrade').click();
      await settle();
      expect(never.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    });

    it('쿼리가 없으면 다시 읽지 않는다', async () => {
      const w = await boot(lang, '#/settings/plan', { timers: 'fast' });
      for (let i = 0; i < 3; i++) await settle();
      expect(w.calls.filter((c) => c.url === '/api/billing')).toHaveLength(1);
      expect(w.delays.filter((ms) => ms === 5000)).toHaveLength(0);
    });
  });
});

describe('⑥ 페이지 — 결제 스크립트 없음 · 사전', () => {
  it.each(LANGS)('%s: CSP는 그대로(외부 호스트 0 · connect-src self) · Paddle.js·결제 호스트를 싣지 않는다', (lang) => {
    const page = renderAppPage(lang);
    // CSP 의 절대 URL 은 폰트(사이트 출처)와 콘솔 자기 자산 둘(정확한 경로)뿐 — 결제 호스트가 없다.
    expect(page.csp.replace("font-src https://atmark.ai;", '').replace(CSP_ASSET_URL, '')).not.toMatch(/paddle|pay\.atmark|https?:/i);
    expect(page.csp).toContain("connect-src 'self'");
    const html = inlined(page);
    expect(html).not.toMatch(/cdn\.paddle\.com|paddle\.js|Paddle\.(Initialize|Checkout)/);
    // 외부 스크립트는 같은 출처의 페이지 스크립트 자산 하나뿐(자산을 되돌려 끼운 HTML 에는 하나도 없다).
    expect([...page.html.matchAll(/<script[^>]+src="([^"]*)"/g)].map((m) => m[1])).toEqual([expect.stringMatching(/^\/_assets\/[0-9a-f]{16}\/page\.js$/)]);
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/innerHTML|location\.assign|window\.open/);
  });

  it('서버의 결제 거부 코드(BILLING_ERROR_CODES)는 전부 콘솔 CODES에 문구가 있다', () => {
    for (const lang of LANGS) {
      const html = inlined(renderAppPage(lang));
      for (const code of BILLING_ERROR_CODES) expect(html, `${lang} ${code}`).toContain(`${code}:'`);
    }
  });

  it('결제 오류 코드 — 두 언어 사전에 있고 스크립트 CODES에 실린다', () => {
    const codes = [
      '고를 수 없는 요금제입니다.',
      '지금은 결제를 열 수 없습니다. 잠시 뒤 다시 시도하세요.',
      '결제 서비스에 닿지 못했습니다. 잠시 뒤 다시 시도하세요.',
      '베타 기간에는 결제가 열리지 않습니다.',
      '운영자 검토가 끝난 조직만 결제할 수 있습니다.',
      '이미 구독이 있습니다. 결제 관리에서 확인하세요.',
      '이 요금제는 지금 한도보다 좁은 항목이 있어 결제할 수 없습니다.',
      '이 조직은 시험 결제 대상이 아닙니다.',
      '결제 관리는 구독을 시작한 뒤에 열립니다.',
      '다른 창에서 결제를 준비하고 있습니다. 잠시 뒤 다시 시도하세요.',
      '오늘은 결제 화면을 더 열 수 없습니다. 내일 다시 시도하거나 운영자에게 문의하세요.',
      '이 결제 계정에는 다른 조직의 구독도 있어 여기서 결제 관리를 열 수 없습니다. 운영자에게 문의하세요.',
      '결제를 처리하는 중입니다. 반영되면 이 화면에 나타납니다.',
    ];
    for (const lang of LANGS) {
      const html = inlined(renderAppPage(lang));
      for (const ko of codes) {
        expect(MESSAGES.en[ko], ko).toBeDefined();
        const escaped = t(lang, ko).replace(/'/g, "\\'").replace(/[^\x00-\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
        expect(html, `${lang} ${ko}`).toContain(escaped);
      }
    }
  });
});
