import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { assertRealtimeUrl, Atmark, createEventDeduper, parseRealtimeFrame, type RealtimeEvent, type UnknownRealtimeEvent, type WebSocketLike } from '../src/index.js';

const TOKEN = 'atk_agent_realtimesecret';
const AGENT = 'a'.repeat(32);
const MESSAGE_ID = '11111111-2222-4333-8444-555555555555';

class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { readonly code?: number; readonly reason?: string }) => void) | null = null;

  constructor(
    readonly url: string,
    readonly protocols?: unknown,
    readonly options?: unknown,
  ) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closedWith = { ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) };
    this.readyState = 3;
  }

  // ---- test driver ----
  serverOpen(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  serverSend(frame: unknown): void {
    this.onmessage?.({ data: typeof frame === 'string' ? frame : JSON.stringify(frame) });
  }

  serverClose(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code, reason: '' });
  }
}

/** A `ws`-package-like constructor: has prototype.ping, takes (url, protocols, { headers }). */
class FakeWsPackageSocket extends FakeSocket {
  ping(): void {}
}

const envelope = (type: string, data: Record<string, unknown>, id = '0b9f3c7e-5d2a-4c1b-9e8f-7a6b5c4d3e2f') => ({
  id,
  type,
  api_version: '2026-10-08',
  created_at: '2026-10-08T09:00:00.000Z',
  agent_id: AGENT,
  data,
});

function discoveryFetch(url = 'wss://realtime.atmark.ai') {
  return vi.fn(async () => new Response(JSON.stringify({ realtime: { url, protocol: 'websocket' } }), { status: 200 }));
}

async function flush(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
}

beforeEach(() => {
  FakeSocket.instances = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('realtime auth', () => {
  it('resolves the URL from discovery and uses the subprotocol for browser-style constructors (token never in the URL)', async () => {
    const fetch = discoveryFetch();
    const client = new Atmark({ token: TOKEN, fetch, WebSocket: FakeSocket });
    const connection = client.realtime.connect({ onEvent: () => undefined });
    await flush();
    const socket = FakeSocket.instances[0]!;
    expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe('https://api.atmark.ai/.well-known/atmark.json');
    expect(socket.url).toBe('wss://realtime.atmark.ai');
    expect(socket.url).not.toContain(TOKEN);
    expect(socket.protocols).toEqual(['atmark.v1', `bearer.${TOKEN}`]);
    connection.close();
  });

  it('uses the Authorization header with ws-package-style constructors', async () => {
    const client = new Atmark({ token: TOKEN, fetch: discoveryFetch(), WebSocket: FakeWsPackageSocket });
    client.realtime.connect({ onEvent: () => undefined }).close();
    await flush();
    const connection = client.realtime.connect({ onEvent: () => undefined });
    await flush();
    const socket = FakeSocket.instances.at(-1)!;
    expect(socket.protocols).toEqual(['atmark.v1']);
    expect(socket.options).toEqual({ headers: { Authorization: `Bearer ${TOKEN}` } });
    connection.close();
  });

  it('uses the init form ({ protocols, headers }) when told to (Node 22 global WebSocket)', async () => {
    const client = new Atmark({ token: TOKEN, fetch: discoveryFetch(), WebSocket: FakeSocket });
    const connection = client.realtime.connect({ onEvent: () => undefined, authMode: 'init', url: 'wss://example.test/ws' });
    await flush();
    expect(FakeSocket.instances[0]!.protocols).toEqual({ protocols: ['atmark.v1'], headers: { Authorization: `Bearer ${TOKEN}` } });
    connection.close();
  });

  it('refuses a URL that contains the token', async () => {
    const errors: Error[] = [];
    const client = new Atmark({ token: TOKEN, fetch: discoveryFetch(`wss://realtime.atmark.ai/?token=${TOKEN}`), WebSocket: FakeSocket });
    const connection = client.realtime.connect({ onEvent: () => undefined, onError: (e) => errors.push(e) });
    await flush();
    expect(FakeSocket.instances).toHaveLength(0);
    expect(errors[0]?.message).toMatch(/token in the realtime URL/);
    connection.close();
  });

  it('refuses to send the token to a non-Atmark or non-wss URL from the API', async () => {
    for (const url of ['wss://evil.example', 'ws://realtime.atmark.ai', 'https://realtime.atmark.ai', 'wss://realtime.atmark.ai.evil.example', 'wss://abc.execute-api.us-east-1.amazonaws.com']) {
      FakeSocket.instances = [];
      const errors: Error[] = [];
      const client = new Atmark({ token: TOKEN, fetch: discoveryFetch(url), WebSocket: FakeSocket });
      const connection = client.realtime.connect({ onEvent: () => undefined, onError: (e) => errors.push(e) });
      await flush();
      expect(FakeSocket.instances, url).toHaveLength(0);
      expect(errors[0]?.message, url).toMatch(/refusing to send the token/);
      connection.close();
    }
    expect(() => assertRealtimeUrl('wss://realtime.atmark.ai', 'api')).not.toThrow();
    expect(() => assertRealtimeUrl('wss://a1b2c3.execute-api.ap-northeast-2.amazonaws.com/prod', 'api')).not.toThrow();
    expect(() => assertRealtimeUrl('wss://mine.example', 'api', ['mine.example'])).not.toThrow();
    expect(() => assertRealtimeUrl('wss://user:pw@realtime.atmark.ai', 'api')).toThrow(/credentials/);
    // An explicit caller URL is trusted for its host but must be wss (ws only on loopback).
    expect(() => assertRealtimeUrl('wss://anything.example', 'caller')).not.toThrow();
    expect(() => assertRealtimeUrl('ws://127.0.0.1:9000', 'caller')).not.toThrow();
    expect(() => assertRealtimeUrl('ws://anything.example', 'caller')).toThrow(/wss/);
  });

  it('requires a token and a WebSocket implementation', () => {
    expect(() => new Atmark({ fetch: discoveryFetch(), WebSocket: FakeSocket }).realtime.connect({ onEvent: () => undefined })).toThrow(/token/);
    const g = globalThis as { WebSocket?: unknown };
    const saved = g.WebSocket;
    g.WebSocket = undefined;
    try {
      expect(() => new Atmark({ token: TOKEN, fetch: discoveryFetch() }).realtime.connect({ onEvent: () => undefined })).toThrow(/No WebSocket/);
    } finally {
      g.WebSocket = saved;
    }
  });
});

describe('realtime events', () => {
  it('emits typed events (fields under data and flattened), drops control frames, duplicates and garbage', async () => {
    const events: RealtimeEvent[] = [];
    const unknown: UnknownRealtimeEvent[] = [];
    const client = new Atmark({ token: TOKEN, fetch: discoveryFetch(), WebSocket: FakeSocket });
    const connection = client.realtime.connect({ onEvent: (e) => events.push(e), onUnknownEvent: (e) => unknown.push(e) });
    await flush();
    const socket = FakeSocket.instances[0]!;
    socket.serverOpen();
    const received = envelope('message.received', { message_id: MESSAGE_ID, thread_id: 't', received_at: '2026-10-08T08:59:59.000Z', risk: { level: 'risk' }, extra: 1 });
    socket.serverSend(received);
    socket.serverSend(received); // duplicate id
    socket.serverSend({ type: 'pong' });
    socket.serverSend('not json');
    socket.serverSend(envelope('approval.resolved', { approval_id: 'ap', decision: 'approved', resolved_at: 'x', message_ids: [MESSAGE_ID] }, 'e2'));
    socket.serverSend(envelope('message.sent', { message_id: MESSAGE_ID, sent_at: 'x' }, 'e3'));
    socket.serverSend(envelope('message.bounced', { message_id: MESSAGE_ID, bounced_at: 'x', bounce_type: 'permanent' }, 'e4'));
    socket.serverSend(envelope('agent.enrolled', { agent_id: 'b' }, 'e5'));
    expect(events.map((e) => e.type)).toEqual(['message.received', 'approval.resolved', 'message.sent', 'message.bounced']);
    const first = events[0]!;
    if (first.type !== 'message.received') throw new Error('narrowing');
    expect(first.message_id).toBe(MESSAGE_ID);
    expect(first.data.message_id).toBe(MESSAGE_ID);
    expect(first.risk.level).toBe('risk');
    expect(first.event_id).toBe(first.id);
    expect(first['extra']).toBe(1);
    expect(unknown.map((e) => e.type)).toEqual(['agent.enrolled']);
    connection.close();
  });

  it('accepts a flat event shape and reads unknown risk levels as block', () => {
    const parsed = parseRealtimeFrame(JSON.stringify({ event_id: 'e', type: 'message.received', agent_id: AGENT, message_id: MESSAGE_ID, thread_id: 't', received_at: 'x', risk: { level: '??' } }));
    expect(parsed?.kind).toBe('event');
    if (parsed?.kind !== 'event' || parsed.event.type !== 'message.received') throw new Error('expected event');
    expect(parsed.event.id).toBe('e');
    expect(parsed.event.message_id).toBe(MESSAGE_ID);
    expect(parsed.event.risk.level).toBe('block');
    expect(parseRealtimeFrame(JSON.stringify({ type: 'message.received' }))?.kind).toBe('unknown');
    expect(parseRealtimeFrame('[]')).toBeNull();
  });

  it('a throwing onEvent is reported to onError and does not break the connection', async () => {
    const errors: Error[] = [];
    const client = new Atmark({ token: TOKEN, fetch: discoveryFetch(), WebSocket: FakeSocket });
    const connection = client.realtime.connect({
      onEvent: () => {
        throw new Error('handler bug');
      },
      onError: (e) => errors.push(e),
    });
    await flush();
    FakeSocket.instances[0]!.serverOpen();
    FakeSocket.instances[0]!.serverSend(envelope('message.sent', { message_id: MESSAGE_ID, sent_at: 'x' }));
    expect(errors.map((e) => e.message)).toEqual(['handler bug']);
    expect(FakeSocket.instances[0]!.closedWith).toBeNull();
    connection.close();
  });
});

describe('E envelope (dedupe_key · truncated approvals)', () => {
  it('drops a second push of the same fact by dedupe_key even with a different id; exposes dedupeKey and truncation', async () => {
    const events: RealtimeEvent[] = [];
    const client = new Atmark({ token: TOKEN, fetch: discoveryFetch(), WebSocket: FakeSocket });
    const connection = client.realtime.connect({ onEvent: (e) => events.push(e), url: 'wss://example.test' });
    await flush();
    const socket = FakeSocket.instances[0]!;
    socket.serverOpen();
    const data = { message_id: MESSAGE_ID, thread_id: 't', received_at: 'x', risk: { level: 'none' } };
    socket.serverSend({ ...envelope('message.received', data, 'id-1'), dedupe_key: `message.received:${MESSAGE_ID}` });
    socket.serverSend({ ...envelope('message.received', data, 'id-2'), dedupe_key: `message.received:${MESSAGE_ID}` });
    socket.serverSend({ ...envelope('approval.resolved', { approval_id: 'ap', decision: 'approved', resolved_at: 'x', message_ids: [MESSAGE_ID], message_count: 120, truncated: true }, 'id-3'), dedupe_key: 'approval.resolved:ap' });
    expect(events.map((e) => e.dedupeKey)).toEqual([`message.received:${MESSAGE_ID}`, 'approval.resolved:ap']);
    const approval = events[1]!;
    if (approval.type !== 'approval.resolved') throw new Error('narrowing');
    expect([approval.message_count, approval.truncated, approval.data.message_ids.length]).toEqual([120, true, 1]);
    expect(approval.dedupe_key).toBe('approval.resolved:ap');
    connection.close();
  });

  it('dedupe_key falls back to id; createEventDeduper forgets beyond its window', () => {
    const parsed = parseRealtimeFrame(JSON.stringify(envelope('message.sent', { message_id: MESSAGE_ID, sent_at: 'x' }, 'only-id')));
    if (parsed?.kind !== 'event') throw new Error('expected event');
    expect(parsed.event.dedupeKey).toBe('only-id');
    const isNew = createEventDeduper(2);
    expect([isNew({ dedupe_key: 'a' }), isNew({ dedupe_key: 'a' }), isNew({ id: 'b' }), isNew({ id: 'c' }), isNew({ dedupe_key: 'a' }), isNew({})]).toEqual([true, false, true, true, true, true]);
  });

  it('resolves the URL with GET /v1/agents/{id}/realtime when the client has an agentId, else discovery', async () => {
    const fetch = vi.fn(async (url: string) =>
      url.endsWith('/realtime') ? new Response(JSON.stringify({ url: 'wss://agent.example' }), { status: 200 }) : new Response(JSON.stringify({ realtime: { url: 'wss://discovery.example' } }), { status: 200 }),
    );
    const client = new Atmark({ token: TOKEN, agentId: AGENT, fetch, WebSocket: FakeSocket, realtimeHosts: ['agent.example'] });
    const connection = client.realtime.connect({ onEvent: () => undefined });
    await flush();
    expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe(`https://api.atmark.ai/v1/agents/${AGENT}/realtime`);
    expect(FakeSocket.instances[0]!.url).toBe('wss://agent.example');
    connection.close();
    const failing = vi.fn(async (url: string) =>
      url.endsWith('/realtime') ? new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }) : new Response(JSON.stringify({ realtime: { url: 'wss://discovery.example' } }), { status: 200 }),
    );
    const fallback = new Atmark({ token: TOKEN, agentId: AGENT, fetch: failing, WebSocket: FakeSocket });
    await expect(fallback.realtime.resolveUrl()).resolves.toBe('wss://discovery.example');
  });
});

describe('realtime upkeep', () => {
  it('pings every 5 minutes while open', async () => {
    const client = new Atmark({ token: TOKEN, fetch: discoveryFetch(), WebSocket: FakeSocket });
    const connection = client.realtime.connect({ onEvent: () => undefined });
    await flush();
    const socket = FakeSocket.instances[0]!;
    socket.serverOpen();
    vi.advanceTimersByTime(5 * 60_000);
    expect(socket.sent).toEqual([JSON.stringify({ action: 'ping' })]);
    vi.advanceTimersByTime(5 * 60_000);
    expect(socket.sent).toHaveLength(2);
    connection.close();
    vi.advanceTimersByTime(10 * 60_000);
    expect(socket.sent).toHaveLength(2);
  });

  it('reconnects with backoff after a drop and reports reconnected: true', async () => {
    const opens: boolean[] = [];
    const closes: boolean[] = [];
    const client = new Atmark({ token: TOKEN, fetch: discoveryFetch(), WebSocket: FakeSocket });
    const connection = client.realtime.connect({ onEvent: () => undefined, onOpen: (i) => opens.push(i.reconnected), onClose: (i) => closes.push(i.willReconnect), url: 'wss://example.test' });
    await flush();
    FakeSocket.instances[0]!.serverOpen();
    FakeSocket.instances[0]!.serverClose(1006);
    expect(closes).toEqual([true]);
    expect(FakeSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeSocket.instances).toHaveLength(2);
    // A handshake that fails grows the backoff ceiling (2 s next).
    FakeSocket.instances[1]!.serverClose(1006);
    await vi.advanceTimersByTimeAsync(1_000);
    const countAfter1s = FakeSocket.instances.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeSocket.instances.length).toBeGreaterThanOrEqual(countAfter1s);
    expect(FakeSocket.instances).toHaveLength(3);
    FakeSocket.instances[2]!.serverOpen();
    expect(opens).toEqual([false, true]);
    connection.close();
  });

  it('opens a fresh connection before the 2-hour limit and closes the old one only after the new one is open', async () => {
    const events: RealtimeEvent[] = [];
    const client = new Atmark({ token: TOKEN, fetch: discoveryFetch(), WebSocket: FakeSocket });
    const connection = client.realtime.connect({ onEvent: (e) => events.push(e), url: 'wss://example.test' });
    await flush();
    const old = FakeSocket.instances[0]!;
    old.serverOpen();
    await vi.advanceTimersByTimeAsync(115 * 60_000);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(old.closedWith).toBeNull();
    const fresh = FakeSocket.instances[1]!;
    fresh.serverOpen();
    expect(old.closedWith).toEqual({ code: 1000, reason: 'rotated' });
    // The same event on both sockets is delivered once.
    const frame = envelope('message.sent', { message_id: MESSAGE_ID, sent_at: 'x' }, 'same');
    fresh.serverSend(frame);
    fresh.serverSend(frame);
    expect(events).toHaveLength(1);
    connection.close();
  });

  it('close() and an aborted signal stop everything (no reconnect)', async () => {
    const controller = new AbortController();
    const client = new Atmark({ token: TOKEN, fetch: discoveryFetch(), WebSocket: FakeSocket });
    const connection = client.realtime.connect({ onEvent: () => undefined, signal: controller.signal, url: 'wss://example.test' });
    await flush();
    FakeSocket.instances[0]!.serverOpen();
    controller.abort();
    expect(connection.closed).toBe(true);
    expect(FakeSocket.instances[0]!.closedWith).toEqual({ code: 1000, reason: 'client closed' });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('closing while the handshake is pending closes the pending socket', async () => {
    const client = new Atmark({ token: TOKEN, fetch: discoveryFetch(), WebSocket: FakeSocket });
    const connection = client.realtime.connect({ onEvent: () => undefined, url: 'wss://example.test' });
    await flush();
    connection.close();
    expect(FakeSocket.instances[0]!.closedWith?.code).toBe(1000);
  });

  it('discovery failure is reported and retried', async () => {
    const errors: Error[] = [];
    let calls = 0;
    const fetch = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? new Response('{}', { status: 200 }) : new Response(JSON.stringify({ realtime: { url: 'wss://r.test' } }), { status: 200 });
    });
    const client = new Atmark({ token: TOKEN, fetch, WebSocket: FakeSocket, realtimeHosts: ['r.test'] });
    const connection = client.realtime.connect({ onEvent: () => undefined, onError: (e) => errors.push(e) });
    await flush();
    expect(errors[0]?.message).toMatch(/realtime.url/);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeSocket.instances[0]?.url).toBe('wss://r.test');
    connection.close();
  });
});
