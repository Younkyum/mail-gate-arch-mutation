/**
 * 콘솔 네트워크 규율(2026-09-25 운영 버그 — 로그인 직후 `/app` 이 "서버 오류입니다" · 빈 조직 스위처).
 *
 * 원인: admin Lambda 예약 동시성 2 에서 v4 콘솔이 첫 화면에 API 를 여럿 한꺼번에 불러 `/api/me`·`/api/logs` 가 503
 * ("Lambda function is being throttled")으로 떨어졌다. 고친 것(`src/admin/ui/console/script/core.ts` 의 `api()` 한 곳):
 *
 *   Ⓠ 동시에 떠 있는 요청은 최대 2 — 나머지는 순서대로 기다린다.
 *   Ⓡ GET 이 503·429 를 받으면 두 번까지 다시 보낸다(백오프 ~400ms · ~1200ms + 작은 흔들림). 변경 요청(POST·PATCH·DELETE)은 다시
 *      보내지 않는다 — 오류를 그대로 보인다.
 *   Ⓓ 같은 경로의 GET 이 떠 있으면 새로 보내지 않고 그 응답을 같이 쓴다(끝나면 잊는다 — 캐시가 아니다).
 *   Ⓑ 부팅 — `/api/me`·`/api/agents` 가 오기 전에는 틀만 그리고, 화면 데이터는 그 뒤에 한 번만 부른다(예전에는 두 번).
 *
 * 되돌려서 빨개지는지 확인한 것(2026-09-25): `NET.max` 를 99 로 → Ⓑ-1 · Ⓠ-1 · 재시도 분기(`n<NET.back.length`)를 막으면 → Ⓡ-1~3 ·
 * `identity-blocks` Ⓑ-4 · 재시도 조건에서 `get&&` 를 빼면 → Ⓡ-4 · `NET.get[path]` 공유를 빼면 → Ⓓ-1 · `go()` 의 `if(!S.ready)return;` 을
 * 빼면 → Ⓑ-1. 서버 쪽(admin 예약 동시성 2 → 3)은 `test/unit/infra/transparency-stack.test.ts` 의 합 75 가 고정한다.
 */

import { afterEach, describe, expect, it } from 'vitest';


import { boot, OVERRIDE, settle, t } from './console-harness';

afterEach(() => OVERRIDE.clear());

const LANGS = ['ko', 'en'] as const;
const THROTTLED = { status: 503, json: { message: 'The Lambda function is being throttled' } };
const SERVER_ERROR = '서버 오류입니다. 잠시 뒤 다시 시도하세요.';

describe.each(LANGS)('콘솔 네트워크 규율 (%s)', (lang) => {
  it('Ⓑ-1 부팅: /api/me가 먼저 · 개요 데이터는 한 번씩만 · 떠 있는 요청은 2를 넘지 않는다', async () => {
    const w = await boot(lang, '#/overview', { latency: true });
    await settle();
    const urls = w.calls.map((c) => `${c.method} ${c.url}`);
    expect(urls[0]).toBe('GET /api/me');
    for (const u of ['GET /api/agents?limit=50', 'GET /api/stats?days=7', 'GET /api/logs?type=outbound&limit=6', 'GET /api/logs?type=inbound&limit=6', 'GET /api/agents/a1/channels/email/policy']) {
      expect(urls.filter((x) => x === u), u).toHaveLength(1);
    }
    expect(w.calls).toHaveLength(6);
    expect(w.peak()).toBeLessThanOrEqual(2);
    expect(w.el('org-name').textContent).toBe('Chronostasis');
    expect(w.el('st-out').textContent).toBe('128');
    expect(w.el('banner').hidden).toBe(true);
  });

  it('Ⓠ-1 첫 화면이 여러 개를 부르는 에이전트 개요도 떠 있는 요청은 최대 2', async () => {
    const w = await boot(lang, '#/agents/a1', { latency: true });
    await settle();
    await settle();
    expect(w.calls.length).toBeGreaterThanOrEqual(6);
    expect(w.peak()).toBe(2);
    expect(w.el('a-name').textContent).toBe('founder-agent');
  });

  it('Ⓡ-1 GET /api/me가 503(스로틀) 한 번 → ~400ms 뒤 다시 보내 성공 — 조직 이름·스위처가 그려지고 배너는 없다', async () => {
    OVERRIDE.set('/api/me', [THROTTLED, undefined]);
    const w = await boot(lang, '#/overview', { timers: 'fast' });
    await settle();
    expect(w.calls.filter((c) => c.url === '/api/me')).toHaveLength(2);
    expect(w.delays.filter((ms) => ms >= 400 && ms < 550)).toHaveLength(1);
    expect(w.el('org-name').textContent).toBe('Chronostasis');
    expect(w.el('swo-list').children).toHaveLength(1);
    expect(w.el('banner').hidden).toBe(true);
  });

  it('Ⓡ-2 GET 503 → 429 → 성공: 백오프 ~400ms 다음 ~1200ms', async () => {
    OVERRIDE.set('/api/stats?days=7', [THROTTLED, { status: 429, json: { error: 'rate_limited' } }, undefined]);
    const w = await boot(lang, '#/overview', { timers: 'fast' });
    await settle();
    expect(w.calls.filter((c) => c.url === '/api/stats?days=7')).toHaveLength(3);
    const backoff = w.delays.filter((ms) => ms >= 400 && ms < 1400);
    expect(backoff).toHaveLength(2);
    expect(backoff[0]).toBeLessThan(550);
    expect(backoff[1]).toBeGreaterThanOrEqual(1200);
    expect(w.el('st-out').textContent).toBe('128');
    expect(w.el('ov-stats-msg').textContent).toBe('');
  });

  it('Ⓡ-3 GET이 계속 503 이면 두 번만 더 보내고(모두 3번) 기존 오류 문구를 보인다', async () => {
    OVERRIDE.set('/api/me', THROTTLED);
    const w = await boot(lang, '#/overview', { timers: 'fast' });
    await settle();
    expect(w.calls.filter((c) => c.url === '/api/me')).toHaveLength(3);
    // 부팅 실패는 배너가 아니라 원인 한 줄 + 다시 시도가 있는 페이지 상태(비평 R7-03).
    expect(w.el('boot-err').hidden).toBe(false);
    expect(w.el('boot-err-t').textContent).toBe(t(lang, SERVER_ERROR));
    expect(w.el('v-overview').hidden).toBe(true);
  });

  it.each([503, 429])('Ⓡ-4 변경 요청은 %s 여도 다시 보내지 않는다 — POST(신원 게시 중단) · PATCH(수신 모드) 한 번씩, 오류는 그 자리에', async (status) => {
    const err = t(lang, status === 503 ? SERVER_ERROR : '요청이 너무 잦습니다. 잠시 뒤 다시 시도하세요.');
    OVERRIDE.set('POST /api/agents/a1/identity/suspend', { status, json: { error: status === 429 ? 'rate_limited' : '' } });
    const w = await boot(lang, '#/agents/a1/identity', { timers: 'fast' });
    const delays = w.delays.length;
    w.el('id-switch').dispatch('click');
    w.el('dc-ack').checked = true;
    w.el('dc-ack').onchange?.();
    w.el('dc-ok').onclick?.();
    await settle();
    expect(w.calls.filter((c) => c.method === 'POST' && c.url === '/api/agents/a1/identity/suspend')).toHaveLength(1);
    expect(w.el('ai-msg').className).toBe('msg err');
    expect(w.el('ai-msg').textContent).toBe(err);

    OVERRIDE.set('PATCH /api/agents/a1/channels/email/policy', { status, json: { error: status === 429 ? 'rate_limited' : '' } });
    await w.go('#/agents/a1/email');
    w.el('im-allowlist-i').value = 'allowlist';
    w.el('im-allowlist-i').dispatch('change');
    w.el('i-go').dispatch('click');
    w.el('dc-ok').onclick?.();
    await settle();
    expect(w.calls.filter((c) => c.method === 'PATCH' && c.url === '/api/agents/a1/channels/email/policy')).toHaveLength(1);
    expect(w.el('i-msg').className).toBe('msg err');
    expect(w.el('i-msg').textContent).toBe(err);
    expect(w.delays.slice(delays).filter((ms) => ms >= 400 && ms < 1400)).toHaveLength(0);
  });

  it('Ⓓ-1 같은 GET이 떠 있으면 하나만 보내고 응답을 같이 쓴다 · 끝나면 다시 보낸다(캐시가 아니다)', async () => {
    const w = await boot(lang, '#/overview', { latency: true });
    await settle();
    const overviewGets = ['/api/logs?type=outbound&limit=6', '/api/logs?type=inbound&limit=6', '/api/stats?days=7'];
    const before = w.calls.length;
    // 개요를 두 번 빠르게(응답 전에) — 두 번째 요청 셋은 떠 있는 첫 번째 것을 같이 쓴다.
    void w.go('#/overview');
    await w.go('#/overview');
    await settle();
    expect(w.calls.slice(before).map((c) => c.url).sort()).toEqual([...overviewGets].sort());
    expect(w.el('st-out').textContent).toBe('128');
    expect(w.el('ov-log-body').children).toHaveLength(1);
    const mid = w.calls.length;
    await w.go('#/overview');
    await settle();
    expect(w.calls.slice(mid).map((c) => c.url).sort()).toEqual([...overviewGets].sort());
  });
});
