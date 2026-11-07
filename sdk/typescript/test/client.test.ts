import { describe, expect, it, vi } from 'vitest';

import { Atmark, AtmarkConnectionError, AtmarkError, isHostile, riskLevel } from '../src/index.js';
import { backoffMs, HttpClient, retryAfterMs } from '../src/http.js';

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

type Reply = Response | Error | (() => Response | Promise<Response>);

function harness(replies: Reply[], options: { agentId?: string; maxRetries?: number; timeoutMs?: number; token?: string } = {}) {
  const requests: Recorded[] = [];
  const sleeps: number[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    requests.push({
      method: init.method ?? 'GET',
      url,
      headers: init.headers as Record<string, string>,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
    });
    const next = replies.shift();
    if (next === undefined) throw new Error('no more replies');
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next() : next;
  });
  const client = new Atmark({ token: options.token ?? 'atk_agent_secret', fetch, ...options });
  // Make retries instant and deterministic.
  const http = (client.messages as unknown as { context: { http: HttpClient } }).context.http;
  Object.assign(http.config, { sleep: async (ms: number) => void sleeps.push(ms), random: () => 0.5 });
  return { client, requests, sleeps, fetch };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const SEND = { from: 'scout@atmark.ai', to: ['partner@example.com'], subject: 'Hi', text: 'Hello' };

describe('requests', () => {
  it('sends the bearer token, JSON body, default agent_id and a generated Idempotency-Key', async () => {
    const { client, requests } = harness([json(200, { status: 'sent', message_id: 'm1' })], { agentId: 'a'.repeat(32) });
    const result = await client.messages.send(SEND);
    expect(result.status).toBe('sent');
    const request = requests[0]!;
    expect(request.url).toBe('https://api.atmark.ai/v1/messages');
    expect(request.headers['Authorization']).toBe('Bearer atk_agent_secret');
    expect(request.headers['Content-Type']).toBe('application/json');
    expect(request.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(request.body).toEqual({ ...SEND, agent_id: 'a'.repeat(32) });
  });

  it('an explicit agent_id wins over the default; explicit Idempotency-Key is used as is', async () => {
    const { client, requests } = harness([json(202, { status: 'pending_approval', approval_id: 'ap' })], { agentId: 'a'.repeat(32) });
    await client.messages.send({ ...SEND, agent_id: 'b'.repeat(32) }, { idempotencyKey: 'weekly-report-1' });
    expect((requests[0]!.body as { agent_id: string }).agent_id).toBe('b'.repeat(32));
    expect(requests[0]!.headers['Idempotency-Key']).toBe('weekly-report-1');
  });

  it('GETs carry no Idempotency-Key and encode path and query values', async () => {
    const { client, requests } = harness([json(200, { address: 'x' })]);
    await client.identity.lookup('scout+x@atmark.ai');
    expect(requests[0]!.url).toBe('https://api.atmark.ai/v1/identity/scout%2Bx%40atmark.ai');
    expect(requests[0]!.headers['Idempotency-Key']).toBeUndefined();
  });

  it('strips a trailing /v1 from baseUrl', async () => {
    const fetch = vi.fn(async () => json(200, {}));
    const client = new Atmark({ baseUrl: 'http://localhost:3000/v1/', allowInsecure: true, fetch });
    await client.discovery.get();
    expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe('http://localhost:3000/.well-known/atmark.json');
  });

  it('booleans in queries become "true"/"false"; undefined values are left out', async () => {
    const { client, requests } = harness([json(200, { messages: [], next_cursor: null })], { agentId: 'a'.repeat(32) });
    await client.messages.inbound.list({ read: false, unlabeled: true, label: undefined });
    const url = new URL(requests[0]!.url);
    expect(url.searchParams.get('read')).toBe('false');
    expect(url.searchParams.get('unlabeled')).toBe('true');
    expect(url.searchParams.has('label')).toBe(false);
    expect(url.searchParams.get('agent_id')).toBe('a'.repeat(32));
  });

  it('path agentId falls back to the default, then to me (the agent of the token)', async () => {
    const { client, requests } = harness([json(200, {}), json(200, {}), json(200, {})]);
    await client.policy.get();
    await client.policy.get('b'.repeat(32));
    expect(new URL(requests[0]!.url).pathname).toBe('/v1/agents/me/policy');
    expect(new URL(requests[1]!.url).pathname).toBe(`/v1/agents/${'b'.repeat(32)}/policy`);
    const withDefault = harness([json(200, {})], { agentId: 'a'.repeat(32) });
    await withDefault.client.policy.get();
    expect(new URL(withDefault.requests[0]!.url).pathname).toBe(`/v1/agents/${'a'.repeat(32)}/policy`);
  });

  it('an explicit empty agentId is an error, not a silent fallback to me', () => {
    expect(() => harness([], { agentId: '' })).toThrow(TypeError);
    const { client, requests } = harness([]);
    expect(() => client.policy.get('')).toThrow(TypeError);
    expect(requests).toHaveLength(0);
  });

  it('query and body agent_id are left out without a default (the server uses the token agent)', async () => {
    const { client, requests } = harness([json(200, { messages: [], next_cursor: null }), json(200, { status: 'sent', message_id: 'm1' })]);
    await client.messages.inbound.list();
    expect(new URL(requests[0]!.url).searchParams.has('agent_id')).toBe(false);
    await client.messages.send(SEND);
    expect(requests[1]!.body).toEqual(SEND);
  });
});

describe('transport security', () => {
  it('baseUrl must be https; http only for loopback with allowInsecure', () => {
    const fetch = vi.fn(async () => json(200, {}));
    expect(() => new Atmark({ baseUrl: 'http://api.atmark.ai', fetch })).toThrow(/https/);
    expect(() => new Atmark({ baseUrl: 'http://localhost:3000', fetch })).toThrow(/allowInsecure/);
    expect(() => new Atmark({ baseUrl: 'http://evil.example', allowInsecure: true, fetch })).toThrow(/https/);
    expect(() => new Atmark({ baseUrl: 'ftp://api.atmark.ai', fetch })).toThrow(/https/);
    expect(() => new Atmark({ baseUrl: 'https://user:pw@api.atmark.ai', fetch })).toThrow(/credentials/);
    expect(() => new Atmark({ baseUrl: 'not a url', fetch })).toThrow(/not a URL/);
    expect(() => new Atmark({ baseUrl: 'http://127.0.0.1:8080', allowInsecure: true, fetch })).not.toThrow();
  });

  it('never follows redirects (redirect: manual) and reports 3xx as unexpected_redirect, not retried', async () => {
    const { client, requests, fetch } = harness([new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }), json(200, {})]);
    await expect(client.threads.get('t')).rejects.toMatchObject({ status: 302, code: 'unexpected_redirect' });
    expect(requests).toHaveLength(1);
    expect((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].redirect).toBe('manual');
  });
});

describe('errors', () => {
  it('maps the error body to AtmarkError (status, code, detail, requestId, body)', async () => {
    const { client } = harness([json(403, { error: 'policy_denied', message_id: 'm', decision: { verdict: 'denied', reasons: ['recipient_not_allowlisted'] } }, { 'apigw-requestid': 'req-1' })]);
    const error = await client.messages.send(SEND).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AtmarkError);
    const e = error as AtmarkError;
    expect([e.status, e.code, e.requestId]).toEqual([403, 'policy_denied', 'req-1']);
    expect((e.body as { decision: { reasons: string[] } }).decision.reasons).toEqual(['recipient_not_allowlisted']);
    expect(e.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reads the request id from a 500 detail', async () => {
    const { client } = harness([json(500, { error: 'internal_error', detail: 'The request could not be processed. Request id: abc-123=' })], { maxRetries: 0 });
    const e = (await client.threads.get('t').catch((x: unknown) => x)) as AtmarkError;
    expect(e.requestId).toBe('abc-123=');
  });

  it('non-JSON error bodies still produce an AtmarkError', async () => {
    const { client } = harness([new Response('Bad gateway', { status: 400 })]);
    const e = (await client.threads.get('t').catch((x: unknown) => x)) as AtmarkError;
    expect([e.status, e.code, e.detail]).toEqual([400, 'unknown_error', 'Bad gateway']);
  });
});

describe('retries', () => {
  it('retries a send (it has an Idempotency-Key) on 503 and network errors with the SAME key', async () => {
    const { client, requests, sleeps } = harness([json(503, { error: 'service_unavailable' }), new TypeError('fetch failed'), json(200, { status: 'sent' })]);
    expect((await client.messages.send(SEND)).status).toBe('sent');
    expect(requests).toHaveLength(3);
    expect(new Set(requests.map((r) => r.headers['Idempotency-Key'])).size).toBe(1);
    expect(sleeps).toHaveLength(2);
  });

  it('does not retry a POST without an Idempotency-Key (createDraft)', async () => {
    const { client, requests } = harness([json(503, { error: 'service_unavailable' }), json(201, { id: 'd' })]);
    await expect(client.drafts.create({ subject: 's' })).rejects.toMatchObject({ status: 503 });
    expect(requests).toHaveLength(1);
  });

  it('does not retry PATCH (updateDraft) or network errors on it', async () => {
    const { client, requests } = harness([new TypeError('fetch failed')]);
    await expect(client.drafts.update('d', { subject: 'x' })).rejects.toBeInstanceOf(AtmarkConnectionError);
    expect(requests).toHaveLength(1);
  });

  it('retries a GET on 429 honoring Retry-After seconds', async () => {
    const { client, sleeps } = harness([json(429, { message: 'Too Many Requests' }, { 'retry-after': '3' }), json(200, { id: 't' })]);
    await client.threads.get('t');
    expect(sleeps).toEqual([3000]);
  });

  it('never retries 502 send_failed (nothing went out; the same key would replay the failure)', async () => {
    const { client, requests } = harness([json(502, { error: 'send_failed', status: 'failed' }), json(200, { status: 'sent' })]);
    await expect(client.messages.send(SEND)).rejects.toMatchObject({ status: 502, code: 'send_failed' });
    expect(requests).toHaveLength(1);
  });

  it('retries 409 policy_changing but not 409 idempotency_key_reused', async () => {
    const a = harness([json(409, { error: 'policy_changing' }), json(200, { status: 'sent' })]);
    expect((await a.client.messages.send(SEND)).status).toBe('sent');
    const b = harness([json(409, { error: 'idempotency_key_reused' })]);
    await expect(b.client.messages.send(SEND)).rejects.toMatchObject({ code: 'idempotency_key_reused' });
    expect(b.requests).toHaveLength(1);
  });

  it('never retries 4xx like 400/401/403/404', async () => {
    for (const status of [400, 401, 403, 404, 422]) {
      const { client, requests } = harness([json(status, { error: 'x' }), json(200, {})]);
      await expect(client.threads.get('t')).rejects.toMatchObject({ status });
      expect(requests).toHaveLength(1);
    }
  });

  it('stops after maxRetries and throws the last error', async () => {
    const { client, requests } = harness([json(500, { error: 'internal_error' }), json(500, { error: 'internal_error' }), json(500, { error: 'internal_error' }), json(200, {})], { maxRetries: 2 });
    await expect(client.threads.get('t')).rejects.toMatchObject({ status: 500 });
    expect(requests).toHaveLength(3);
  });

  it('times out an attempt and reports AtmarkConnectionError(timeout)', async () => {
    const hang = (): Promise<Response> => new Promise(() => undefined);
    const fetch = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      void hang();
    }));
    const client = new Atmark({ token: 't', fetch, timeoutMs: 10, maxRetries: 0 });
    const e = (await client.threads.get('t').catch((x: unknown) => x)) as AtmarkConnectionError;
    expect(e).toBeInstanceOf(AtmarkConnectionError);
    expect(e.code).toBe('timeout');
  });

  it('a caller abort is not retried', async () => {
    const controller = new AbortController();
    controller.abort();
    const { client, requests } = harness([json(200, {})]);
    await expect(client.threads.get('t', { signal: controller.signal })).rejects.toMatchObject({ code: 'aborted' });
    expect(requests).toHaveLength(0);
  });

  it('backoff is capped full jitter; Retry-After accepts HTTP dates and caps at 60s', () => {
    expect(backoffMs(0, () => 0.999)).toBeLessThan(500);
    expect(backoffMs(20, () => 0.999)).toBeLessThan(20_000);
    expect(retryAfterMs('Wed, 08 Oct 2026 09:00:10 GMT', Date.parse('2026-10-08T09:00:00Z'))).toBe(10_000);
    expect(retryAfterMs('3600')).toBe(60_000);
    expect(retryAfterMs('soon')).toBeNull();
  });
});

describe('self-enrollment (agents.create)', () => {
  it('posts {name, local_part} without an Idempotency-Key and returns the one-time token', async () => {
    const { client, requests } = harness([json(201, { agent: { agent_id: 'b'.repeat(32), name: 'Helper', address: 'helper@atmark.ai' }, token: 'atk_agent_new', token_scopes: ['messages:send'], defaults: { send_approval: 'always' } })]);
    const enrolled = await client.agents.create({ name: 'Helper', local_part: 'helper' }, { idempotencyKey: 'ignored' });
    expect(enrolled.token).toBe('atk_agent_new');
    expect(enrolled.defaults.send_approval).toBe('always');
    expect(requests[0]!.url).toBe('https://api.atmark.ai/v1/agents');
    expect(requests[0]!.body).toEqual({ name: 'Helper', local_part: 'helper' });
    expect(requests[0]!.headers['Idempotency-Key']).toBeUndefined();
  });

  it('never retries enroll refusals (busy, timeout, daily cap, network)', async () => {
    for (const [status, code] of [[503, 'enroll_busy'], [503, 'enroll_timeout'], [429, 'enroll_daily_cap'], [503, 'enroll_unavailable'], [403, 'self_enroll_disabled']] as const) {
      const { client, requests } = harness([json(status, { error: code, detail: 'x' }), json(201, {})]);
      await expect(client.agents.create({ name: 'Helper' }, { idempotencyKey: 'k' })).rejects.toMatchObject({ status, code });
      expect(requests, code).toHaveLength(1);
    }
    const { client, requests } = harness([new TypeError('fetch failed'), json(201, {})]);
    await expect(client.agents.create({ name: 'Helper' })).rejects.toBeInstanceOf(AtmarkConnectionError);
    expect(requests).toHaveLength(1);
  });

  it('capabilities expose self_enroll and policy.send_approval', async () => {
    const { client } = harness([json(200, { policy: { send_approval: 'always' }, self_enroll: { available: false, scope_granted: true, enabled_by_owner: false, daily_cap: 5, used_last_24h: 0, endpoint: 'POST /v1/agents', mcp_tool: 'create_agent', defaults: {} } })], { agentId: 'a'.repeat(32) });
    const capabilities = await client.capabilities.get();
    expect(capabilities.self_enroll?.available).toBe(false);
    expect(capabilities.policy?.send_approval).toBe('always');
  });
});

describe('pagination', () => {
  it('await gives the first page; for await walks every item across pages', async () => {
    const { client, requests } = harness(
      [
        json(200, { messages: [{ id: '1' }, { id: '2' }], next_cursor: 'c1' }),
        json(200, { messages: [{ id: '3' }], next_cursor: null }),
        json(200, { messages: [{ id: '1' }], next_cursor: 'c1' }),
      ],
      { agentId: 'a'.repeat(32) },
    );
    const ids: string[] = [];
    for await (const message of client.messages.inbound.list({ limit: 2 })) ids.push(message.id);
    expect(ids).toEqual(['1', '2', '3']);
    expect(new URL(requests[1]!.url).searchParams.get('cursor')).toBe('c1');
    expect(new URL(requests[1]!.url).searchParams.get('limit')).toBe('2');
    const first = await client.messages.inbound.list();
    expect(first.next_cursor).toBe('c1');
  });

  it('webhook deliveries and scheduled lists iterate their arrays', async () => {
    const { client } = harness([json(200, { deliveries: [{ id: 'x' }], next_cursor: null }), json(200, { schedules: [{ id: 's' }], next_cursor: null })], { agentId: 'a'.repeat(32) });
    const deliveries = [];
    for await (const d of client.webhooks.deliveries.list(undefined, { status: 'dead' })) deliveries.push(d);
    expect(deliveries).toEqual([{ id: 'x' }]);
    const schedules = [];
    for await (const s of client.messages.scheduled.list()) schedules.push(s);
    expect(schedules).toEqual([{ id: 's' }]);
  });
});

describe('attachments.upload', () => {
  it('hashes the bytes, creates the upload and PUTs to the signed URL without Authorization', async () => {
    const data = new TextEncoder().encode('hello');
    const { client, requests } = harness([
      json(201, { attachment_id: 'att', upload: { method: 'PUT', url: 'https://s3.example/put?sig=1', headers: { 'content-type': 'text/plain' } } }),
      new Response(null, { status: 200 }),
    ]);
    const result = await client.attachments.upload({ agent_id: 'a'.repeat(32), filename: 'h.txt', mime_type: 'text/plain', data });
    expect(result.attachment_id).toBe('att');
    expect(requests[0]!.body).toMatchObject({ bytes: 5, sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824' });
    expect(requests[0]!.headers['Idempotency-Key']).toBeDefined();
    expect(requests[1]!.url).toBe('https://s3.example/put?sig=1');
    expect(requests[1]!.method).toBe('PUT');
    expect(requests[1]!.headers['Authorization']).toBeUndefined();
  });

  it('a failed PUT throws attachment_upload_failed', async () => {
    const { client } = harness([json(201, { attachment_id: 'att', upload: { method: 'PUT', url: 'https://s3.example/put' } }), new Response(null, { status: 403 })]);
    await expect(client.attachments.upload({ filename: 'h.txt', mime_type: 'text/plain', data: new Uint8Array([1]) })).rejects.toMatchObject({ code: 'attachment_upload_failed' });
  });
});

describe('risk', () => {
  it('only an explicit level "none" is not hostile', () => {
    expect(isHostile({ risk: { level: 'none' } })).toBe(false);
    expect(isHostile({ risk: { level: 'risk' } })).toBe(true);
    expect(isHostile({ risk: { level: 'block' } })).toBe(true);
    expect(isHostile({ risk: { level: 'surprise' } })).toBe(true);
    expect(isHostile({})).toBe(true);
    expect(isHostile(null)).toBe(true);
    expect(riskLevel({ risk: 'none' })).toBe('block');
  });
});
