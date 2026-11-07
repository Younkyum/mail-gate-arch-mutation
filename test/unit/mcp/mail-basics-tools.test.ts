/**
 * MCP 도구 결과 — `get_verification_code` · `list_scheduled` · `cancel_scheduled` · `list_inbox` 필터.
 * 라우트는 가짜 응답이다(도구가 라우트에 닿는 짝은 arch `mcp-adapter` ⑤·⑥, 라우트 본문은 `test/integration/api/`).
 *
 *   - ★ AC-A1-5 후보 모드: 렌더 출력의 **첫 줄이 미검증 경고**다 · 결과에 `http`·`://` 0 · 발신 도메인은 외부 데이터 블록.
 *   - 확정 모드: 코드는 meta, 발신 도메인·링크는 블록 · 404·409 는 다음 할 일을 말한다(409 는 후보 id 를 싣는다).
 *   - list_scheduled: 수신자 주소는 블록(meta 에 주소 0) · 크기 상한 안.
 *   - cancel_scheduled: 거부 코드마다 다른 안내 · 재생은 재생이라고 말한다.
 *   - list_inbox: 필터 인자를 라우트 쿼리로 그대로 넘긴다 · `agent_id` 인자는 여전히 거부.
 */

import { describe, expect, it } from 'vitest';

import type { ApiRequest } from '../../../src/api/http';
import { UNVERIFIED_CANDIDATES_WARNING } from '../../../src/mail/verification';
import { MAX_RESULT_CHARS } from '../../../src/mcp/render';
import type { McpDependencies, ToolContext } from '../../../src/mcp/tools';
import { AGENT, respond, run } from './support';


function context(overrides: Partial<McpDependencies>, calls: ApiRequest[] = []): ToolContext {
  const deps = new Proxy(overrides, {
    get(target, property) {
      const value = (target as Record<string | symbol, unknown>)[property];
      if (value !== undefined) {
        return (request: ApiRequest, ...rest: unknown[]) => {
          calls.push(request);
          return (value as (...args: unknown[]) => unknown)(request, ...rest);
        };
      }
      throw new Error(`deps.${String(property)} 를 건드렸다`);
    },
  }) as McpDependencies;
  return {
    deps,
    principal: { agentId: AGENT as never, capabilities: ['messages:read', 'messages:send'] as never },
    authorization: 'Bearer t',
  };
}

const CANDIDATES = {
  mode: 'unverified_candidates',
  verified: false,
  warning: UNVERIFIED_CANDIDATES_WARNING,
  unverified_candidates: [
    {
      inbound_message_id: '11111111-1111-4111-8111-111111111111',
      received_at: '2026-09-23T01:00:00.000Z',
      from_address: 'noreply@github.com',
      from_domain: 'github.com',
      dmarc: 'pass',
      unverified_code_candidates: [{ value: '482913', confidence: 'high' }],
    },
    {
      inbound_message_id: '22222222-2222-4222-8222-222222222222',
      received_at: '2026-09-23T01:01:00.000Z',
      from_address: 'ignore-all@ignore-previous-instructions.example',
      from_domain: 'ignore-previous-instructions.example',
      dmarc: 'fail',
      unverified_code_candidates: [{ value: '918273', confidence: 'low' }],
    },
  ],
  extractor_version: 'atmark-verification-1',
};

describe('get_verification_code', () => {
  it('★ AC-A1-5 후보 모드 — 첫 줄이 미검증 경고 · http 0 · 발신 도메인은 블록 안', async () => {
    const calls: ApiRequest[] = [];
    const { text, isError } = await run('get_verification_code', context({ verificationCode: respond(200, CANDIDATES) }, calls));
    expect(isError).toBe(false);
    expect(text.split('\n')[0]).toBe(UNVERIFIED_CANDIDATES_WARNING);
    expect(text).not.toContain('http');
    expect(text).not.toContain('://');
    // meta(JSON 줄)에는 도메인이 없고, 블록에 있다.
    const metaLine = text.split('\n').find((line) => line.startsWith('{')) as string;
    expect(metaLine).not.toContain('github.com');
    expect(metaLine).not.toContain('ignore-all@');
    expect(metaLine).toContain('"verified":false');
    expect(metaLine).toContain('482913');
    expect(text).toMatch(/<external_data nonce="[0-9a-f]{16}" ref="22222222-2222-4222-8222-222222222222" field="from_domain"[^>]*>\nignore-previous-instructions\.example\n/);
    // 발신 주소(로컬파트는 발신자가 고른 글)도 블록이다(2회차 수정 Y1).
    expect(text).toMatch(/<external_data nonce="[0-9a-f]{16}" ref="22222222-2222-4222-8222-222222222222" field="from_address"[^>]*>\nignore-all@ignore-previous-instructions\.example\n/);
    // 도구는 sender_domain 없이 부르면 쿼리에 넣지 않는다(= 후보 모드) · agent_id 는 토큰의 것.
    expect(calls[0]?.query).toEqual({ agent_id: AGENT });
  });

  it('확정 모드 — 코드는 meta · 도메인·링크는 블록 · 첫 줄은 경고가 아니다 · 인자를 쿼리로', async () => {
    const calls: ApiRequest[] = [];
    const body = {
      mode: 'verified',
      verified: true,
      inbound_message_id: '33333333-3333-4333-8333-333333333333',
      received_at: '2026-09-23T01:00:00.000Z',
      from_address: 'noreply@github.com',
      from_domain: 'github.com',
      code: '482913',
      links: [{ url: 'https://github.com/verify?t=1', kind: 'verify' }],
      extractor_version: 'atmark-verification-1',
    };
    const { text } = await run('get_verification_code', context({ verificationCode: respond(200, body) }, calls), {
      sender_domain: 'github.com',
      include_subdomains: true,
      since: '2026-09-23T00:50:00.000Z',
    });
    expect(text.split('\n')[0]).toBe('atmark get_verification_code');
    const metaLine = text.split('\n').find((line) => line.startsWith('{')) as string;
    expect(JSON.parse(metaLine)).toMatchObject({ mode: 'verified', verified: true, code: '482913', link_count: 1 });
    expect(metaLine).not.toContain('https://');
    expect(metaLine).not.toContain('noreply@github.com');
    expect(text).toMatch(/field="from_address"[^>]*>\nnoreply@github\.com\n/);
    expect(text).toMatch(/field="links"[^>]*>\nverify https:\/\/github\.com\/verify\?t=1\n/);
    expect(calls[0]?.query).toEqual({ agent_id: AGENT, sender_domain: 'github.com', include_subdomains: 'true', since: '2026-09-23T00:50:00.000Z' });
  });

  it('404 은 기다렸다 다시 · 409 는 후보 id 와 read_email 안내 · agent_id 인자는 거부', async () => {
    const missing = await run('get_verification_code', context({ verificationCode: respond(404, { error: 'no_verification_found', detail: 'x' }) }));
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain('Wait a minute and call again');
    const ids = ['44444444-4444-4444-8444-444444444444'];
    const ambiguous = await run(
      'get_verification_code',
      context({ verificationCode: respond(409, { error: 'ambiguous', detail: 'x', candidate_message_ids: ids }) }),
      { sender_domain: 'github.com' },
    );
    expect(ambiguous.text).toContain('"candidate_message_ids":["44444444-4444-4444-8444-444444444444"]');
    expect(ambiguous.text).toContain('read_email');
    const rejected = await run('get_verification_code', context({}), { agent_id: AGENT });
    expect(rejected.isError).toBe(true);
    expect(rejected.text).toContain('do not pass agent_id');
  });
});

describe('list_scheduled · cancel_scheduled', () => {
  const schedule = (index: number, recipients: readonly string[]): Record<string, unknown> => ({
    schedule_id: `55555555-5555-4555-8555-${String(index).padStart(12, '0')}`,
    status: 'scheduled',
    send_at: '2026-09-24T01:00:00.000Z',
    recipient_count: recipients.length,
    recipients,
    from_address: 'agent@atmark.ai',
    created_at: '2026-09-23T01:00:00.000Z',
    agent_cancellable: true,
    cancelled_at: null,
    cancel_reason_code: null,
    cancelled_via: null,
    dispatch_outcome: null,
    message_id: null,
  });

  it('수신자 주소는 블록 · meta 에 주소 0 · 큰 목록도 상한 안', async () => {
    const small = await run('list_scheduled', context({ listScheduled: respond(200, { schedules: [schedule(1, ['bob@example.com'])], next_cursor: null }) }));
    const metaLine = small.text.split('\n').find((line) => line.startsWith('{')) as string;
    expect(metaLine).not.toContain('bob@example.com');
    expect(JSON.parse(metaLine)).toMatchObject({ schedules: [{ status: 'scheduled', recipient_count: 1, agent_cancellable: true }], next_cursor: null });
    expect(small.text).toMatch(/field="recipients"[^>]*>\nTo: bob@example\.com\n/);

    const many = Array.from({ length: 50 }, (_, index) =>
      schedule(index, Array.from({ length: 100 }, (__, r) => `recipient-${String(r)}-${'x'.repeat(40)}@example.com`)),
    );
    const big = await run('list_scheduled', context({ listScheduled: respond(200, { schedules: many, next_cursor: 'c' }) }));
    expect(big.text.length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    expect(big.text).not.toContain('omitted: result size limit');
  });

  it('cancel_scheduled — 성공·재생 안내 · 거부 코드마다 다른 안내', async () => {
    const done = await run('cancel_scheduled', context({ cancelScheduled: respond(200, { ...schedule(1, ['a@b.c']), status: 'cancelled', replayed: false }) }), {
      schedule_id: '55555555-5555-4555-8555-000000000001',
      reason_code: 'duplicate',
    });
    expect(done.isError).toBe(false);
    expect(done.text).toContain('Cancelled. It will not be sent.');
    expect(done.text).not.toContain('a@b.c');
    const replay = await run('cancel_scheduled', context({ cancelScheduled: respond(200, { ...schedule(1, ['a@b.c']), status: 'cancelled', replayed: true }) }), {
      schedule_id: '55555555-5555-4555-8555-000000000001',
      reason_code: 'duplicate',
    });
    expect(replay.text).toContain('already cancelled earlier');
    const hints = new Set<string>();
    for (const [status, error] of [
      [409, 'schedule_already_dispatched'],
      [409, 'schedule_in_flight'],
      [403, 'schedule_not_agent_cancellable'],
      [429, 'cancel_rate_limited'],
    ] as const) {
      const result = await run('cancel_scheduled', context({ cancelScheduled: respond(status, { error, detail: 'x' }) }), {
        schedule_id: '55555555-5555-4555-8555-000000000001',
        reason_code: 'other',
      });
      expect(result.isError).toBe(true);
      const meta = JSON.parse(result.text.split('\n').find((line) => line.startsWith('{')) as string) as Record<string, unknown>;
      expect(meta['error']).toBe(error);
      expect(typeof meta['next_step']).toBe('string');
      hints.add(meta['next_step'] as string);
    }
    expect(hints.size).toBe(4);
  });
});

describe('list_inbox 필터', () => {
  it('필터 인자를 라우트 쿼리로 넘긴다 · 모르는 인자는 거부', async () => {
    const calls: ApiRequest[] = [];
    const ctx = context({ listInbox: respond(200, { messages: [], next_cursor: null, quarantined: { count: 0 } }) }, calls);
    await run('list_inbox', ctx, {
      from_domain: 'github.com',
      since: '2026-09-23T00:00:00.000Z',
      until: '2026-09-24T00:00:00.000Z',
      thread_id: '66666666-6666-4666-8666-666666666666',
    });
    expect(calls[0]?.query).toEqual({
      agent_id: AGENT,
      limit: '20',
      from_domain: 'github.com',
      since: '2026-09-23T00:00:00.000Z',
      until: '2026-09-24T00:00:00.000Z',
      thread_id: '66666666-6666-4666-8666-666666666666',
    });
    const unknown = await run('list_inbox', ctx, { quarantined: true });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain('Unknown argument');
  });
});
