/**
 * Realtime client (WebSocket). Events are hints — "go and read" — delivered best-effort, at most once. Events missed
 * while disconnected are not replayed: after a reconnect (`onOpen({ reconnected: true })`) catch up with
 * `messages.inbound.list({ since: <last received_at you saw> })`. Use webhooks when you need guaranteed delivery.
 *
 * Auth: the token is NEVER put in the URL (the server refuses token-like query parameters).
 *   - WebSocket implementations that accept headers (the `ws` package, Node 22's global WebSocket): `Authorization: Bearer …`
 *     with subprotocol `atmark.v1`.
 *   - Browsers (no custom headers): subprotocols `['atmark.v1', 'bearer.<token>']`.
 *
 * Connection upkeep: `{"action":"ping"}` every 5 minutes (the server's idle limit is 10), a fresh connection before the
 * server's 2-hour limit (the old one closes once the new one is open; duplicates are dropped by `dedupe_key`), and
 * reconnects with exponential backoff and full jitter (1 s → 60 s).
 */

import type { RiskLevel } from './types.js';

export const REALTIME_SUBPROTOCOL = 'atmark.v1';
const BEARER_PREFIX = 'bearer.';

/** Minimal WebSocket surface the client needs (browser / Node 22 / `ws`). */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { readonly code?: number; readonly reason?: string }) => void) | null;
}

export type WebSocketConstructor = new (url: string, protocols?: unknown, options?: unknown) => WebSocketLike;

/**
 * How to pass the token:
 *   - `ws`: `new WebSocket(url, ['atmark.v1'], { headers })` (the `ws` package),
 *   - `init`: `new WebSocket(url, { protocols: ['atmark.v1'], headers })` (Node 22's global WebSocket / undici),
 *   - `subprotocol`: `new WebSocket(url, ['atmark.v1', 'bearer.<token>'])` (browsers).
 * Default: detected (`ws` if the constructor has `prototype.ping`, `init` for Node's global WebSocket, else `subprotocol`).
 */
export type RealtimeAuthMode = 'ws' | 'init' | 'subprotocol';

interface EnvelopeBase<T extends string, D> {
  /** Event id — de-duplicate on it. */
  readonly id: string;
  /** Same as `id`. */
  readonly event_id: string;
  readonly type: T;
  readonly api_version: string | null;
  readonly created_at: string | null;
  readonly agent_id: string;
  /** Stable key for the underlying fact (`<type>:<entity id>`) — the same mail pushed twice has the same key. Falls back to `id`. */
  readonly dedupe_key: string;
  /** Same as `dedupe_key`. */
  readonly dedupeKey: string;
  readonly data: D;
}

export interface MessageReceivedData {
  readonly message_id: string;
  readonly thread_id: string;
  readonly received_at: string;
  /** Fetch the email by `message_id`; its content is external data. `risk` / `block`: treat as hostile. */
  readonly risk: { readonly level: RiskLevel };
  readonly [key: string]: unknown;
}

export interface ApprovalResolvedData {
  readonly approval_id: string;
  readonly decision: 'approved' | 'rejected';
  readonly resolved_at: string;
  /** At most 50 ids; when `truncated`, fetch the rest with `approvals.get(approval_id)`. */
  readonly message_ids: readonly string[];
  /** Total number of messages the approval covered (may exceed `message_ids.length`). */
  readonly message_count?: number;
  readonly truncated?: boolean;
  readonly [key: string]: unknown;
}

export interface MessageSentData {
  readonly message_id: string;
  readonly sent_at: string;
  readonly [key: string]: unknown;
}

export interface MessageBouncedData {
  readonly message_id: string;
  readonly bounced_at: string;
  readonly recipient_positions?: readonly number[];
  readonly bounce_type?: 'permanent' | 'transient' | 'undetermined';
  readonly [key: string]: unknown;
}

/** Each event carries its fields both under `data` and flattened at the top level. */
export type MessageReceivedEvent = EnvelopeBase<'message.received', MessageReceivedData> & MessageReceivedData;
export type ApprovalResolvedEvent = EnvelopeBase<'approval.resolved', ApprovalResolvedData> & ApprovalResolvedData;
export type MessageSentEvent = EnvelopeBase<'message.sent', MessageSentData> & MessageSentData;
export type MessageBouncedEvent = EnvelopeBase<'message.bounced', MessageBouncedData> & MessageBouncedData;
export type RealtimeEvent = MessageReceivedEvent | ApprovalResolvedEvent | MessageSentEvent | MessageBouncedEvent;

/** An event type this SDK version does not know (delivered to `onUnknownEvent`). */
export interface UnknownRealtimeEvent {
  readonly id: string | null;
  readonly dedupe_key: string | null;
  readonly type: string;
  readonly agent_id: string | null;
  readonly data: Readonly<Record<string, unknown>>;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface RealtimeConnectOptions {
  readonly onEvent: (event: RealtimeEvent) => void;
  readonly onUnknownEvent?: (event: UnknownRealtimeEvent) => void;
  readonly onError?: (error: Error) => void;
  /** Called on every successful open; `reconnected` is true after the first one — catch up then. */
  readonly onOpen?: (info: { readonly reconnected: boolean }) => void;
  readonly onClose?: (info: { readonly code: number | null; readonly reason: string; readonly willReconnect: boolean }) => void;
  readonly signal?: AbortSignal;
  /**
   * Override the URL. Default: `GET /v1/agents/{agentId}/realtime` when the client has an `agentId` (falls back to
   * `/.well-known/atmark.json` → `realtime.url`). Must not carry the token.
   */
  readonly url?: string;
  readonly WebSocket?: WebSocketConstructor;
  readonly authMode?: RealtimeAuthMode;
  readonly pingIntervalMs?: number;
  /** Open a fresh connection after this long (default 1 h 55 min — the server limit is 2 h). */
  readonly maxConnectionAgeMs?: number;
  readonly reconnect?: { readonly initialDelayMs?: number; readonly maxDelayMs?: number };
}

export interface RealtimeConnection {
  close(): void;
  readonly closed: boolean;
}

export interface RealtimeDeps {
  readonly token: string | null;
  /** Extra hosts allowed for API-provided URLs (besides the built-in ones). */
  readonly realtimeHosts?: readonly string[];
  readonly WebSocket: WebSocketConstructor | undefined;
  readonly resolveUrl: () => Promise<string>;
  readonly random: () => number;
  readonly setTimeout: (fn: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
  readonly setInterval: (fn: () => void, ms: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
}

const OPEN = 1;
const KNOWN_TYPES = new Set(['message.received', 'approval.resolved', 'message.sent', 'message.bounced']);
const CONTROL_TYPES = new Set(['pong', 'subscribed', 'error']);
const DEDUPE_WINDOW = 1024;
const ENVELOPE_KEYS = ['id', 'event_id', 'type', 'api_version', 'created_at', 'agent_id', 'dedupe_key'];

/**
 * Drop duplicate events (redeliveries, late verdicts, overlapping connections during a renewal). Returns a function that
 * answers true the first time it sees an event's `dedupe_key` (or `id`) and false afterwards; remembers the last
 * `windowSize` keys. The realtime client already applies one; use your own when you merge events from several sources
 * (for example realtime + webhooks + a catch-up list).
 */
export function createEventDeduper(windowSize: number = DEDUPE_WINDOW): (event: { readonly dedupe_key?: string | null; readonly id?: string | null }) => boolean {
  const order: string[] = [];
  const seen = new Set<string>();
  return (event) => {
    const key = event.dedupe_key ?? event.id ?? null;
    if (key === null) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    order.push(key);
    if (order.length > windowSize) seen.delete(order.shift() as string);
    return true;
  };
}
const STABLE_AFTER_MS = 60_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Parse one frame. Accepts the envelope `{id, type, api_version, created_at, agent_id, data:{…}}` and also a flat shape
 * (`{event_id, type, agent_id, message_id, …}`). Extra fields are kept. Returns null for control frames and garbage.
 */
export function parseRealtimeFrame(text: string): { kind: 'event'; event: RealtimeEvent } | { kind: 'unknown'; event: UnknownRealtimeEvent } | { kind: 'control'; frame: Record<string, unknown> } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  const type = record === null ? null : str(record['type']);
  if (record === null || type === null) return null;
  if (CONTROL_TYPES.has(type)) return { kind: 'control', frame: record };
  const id = str(record['id']) ?? str(record['event_id']);
  const nested = asRecord(record['data']);
  const data: Record<string, unknown> = nested ?? Object.fromEntries(
    Object.entries(record).filter(([key]) => !ENVELOPE_KEYS.includes(key)),
  );
  const dedupeKey = str(record['dedupe_key']);
  if (!KNOWN_TYPES.has(type) || id === null) {
    return { kind: 'unknown', event: { id, dedupe_key: dedupeKey ?? id, type, agent_id: str(record['agent_id']), data, raw: record } };
  }
  if (type === 'message.received') {
    const risk = asRecord(data['risk']);
    const level = str(risk?.['level']);
    // Unknown or missing levels read as `block` (fail closed).
    data['risk'] = { ...(risk ?? {}), level: level === 'none' || level === 'risk' || level === 'block' ? level : 'block' };
  }
  const event = {
    ...data,
    id,
    event_id: id,
    type,
    api_version: str(record['api_version']),
    created_at: str(record['created_at']),
    agent_id: str(record['agent_id']) ?? '',
    dedupe_key: dedupeKey ?? id,
    dedupeKey: dedupeKey ?? id,
    data,
  } as unknown as RealtimeEvent;
  return { kind: 'event', event };
}

function detectAuthMode(ctor: WebSocketConstructor): RealtimeAuthMode {
  const proto = (ctor as unknown as { prototype?: Record<string, unknown> }).prototype;
  if (proto !== undefined && typeof proto['ping'] === 'function') return 'ws';
  const isNode = typeof (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node === 'string';
  const isBrowserLike = typeof (globalThis as { window?: unknown }).window !== 'undefined';
  if (isNode && !isBrowserLike && ctor === (globalThis as { WebSocket?: unknown }).WebSocket) return 'init';
  return 'subprotocol';
}

const BUILTIN_REALTIME_HOST = 'realtime.atmark.ai';
const EXECUTE_API_HOST = /^[a-z0-9]+\.execute-api\.ap-northeast-2\.amazonaws\.com$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Where the token may go. A URL that came from the API (connection info / discovery) must be `wss://` on
 * `realtime.atmark.ai`, `*.execute-api.ap-northeast-2.amazonaws.com` or a host in `extraHosts`. A URL the caller passed
 * explicitly is trusted for its host but must still be `wss://` (or `ws://` on a loopback host, for local tests).
 */
export function assertRealtimeUrl(url: string, source: 'api' | 'caller', extraHosts: readonly string[] = []): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`realtime URL is not a URL: ${url}`);
  }
  const host = parsed.hostname.toLowerCase();
  const loopbackWs = source === 'caller' && parsed.protocol === 'ws:' && LOOPBACK.has(host);
  if (parsed.protocol !== 'wss:' && !loopbackWs) throw new Error(`refusing to send the token: realtime URL must be wss:// (got ${parsed.protocol})`);
  if (parsed.username !== '' || parsed.password !== '') throw new Error('refusing to send the token: realtime URL carries credentials');
  if (source === 'caller') return;
  const allowed = host === BUILTIN_REALTIME_HOST || EXECUTE_API_HOST.test(host) || extraHosts.some((extra) => extra.toLowerCase() === host);
  if (!allowed) throw new Error(`refusing to send the token: realtime host ${host} is not an Atmark host (pass realtimeHosts to allow it)`);
}

function assertNoTokenInUrl(url: string, token: string): void {
  if (token !== '' && url.includes(token)) throw new Error('refusing to put the token in the realtime URL');
}

export function openSocket(ctor: WebSocketConstructor, url: string, token: string, mode: RealtimeAuthMode): WebSocketLike {
  assertNoTokenInUrl(url, token);
  const headers = { Authorization: `Bearer ${token}` };
  if (mode === 'ws') return new ctor(url, [REALTIME_SUBPROTOCOL], { headers });
  if (mode === 'init') return new ctor(url, { protocols: [REALTIME_SUBPROTOCOL], headers });
  return new ctor(url, [REALTIME_SUBPROTOCOL, `${BEARER_PREFIX}${token}`]);
}

export function connectRealtime(deps: RealtimeDeps, options: RealtimeConnectOptions): RealtimeConnection {
  const ctor = options.WebSocket ?? deps.WebSocket;
  if (ctor === undefined) throw new Error('No WebSocket implementation: pass { WebSocket } (for example from the "ws" package on Node 20).');
  if (deps.token === null) throw new Error('A token is required for realtime connections.');
  const token = deps.token;
  const mode = options.authMode ?? detectAuthMode(ctor);
  const pingInterval = options.pingIntervalMs ?? 300_000;
  const maxAge = options.maxConnectionAgeMs ?? 115 * 60_000;
  const initialDelay = options.reconnect?.initialDelayMs ?? 1_000;
  const maxDelay = options.reconnect?.maxDelayMs ?? 60_000;

  let stopped = false;
  let opens = 0;
  let failures = 0;
  let reconnectTimer: unknown = null;
  let current: { socket: WebSocketLike; ping: unknown; age: unknown; openedAt: number | null } | null = null;
  const pending = new Set<WebSocketLike>();
  const isNew = createEventDeduper();

  const report = (error: unknown): void => {
    options.onError?.(error instanceof Error ? error : new Error(String(error)));
  };

  const teardown = (entry: NonNullable<typeof current>, code: number, reason: string): void => {
    deps.clearInterval(entry.ping);
    deps.clearTimeout(entry.age);
    entry.socket.onclose = null;
    entry.socket.onmessage = null;
    entry.socket.onerror = null;
    entry.socket.onopen = null;
    try {
      entry.socket.close(code, reason);
    } catch {
      // already closed
    }
  };

  const scheduleReconnect = (): void => {
    if (stopped || reconnectTimer !== null) return;
    const ceiling = Math.min(maxDelay, initialDelay * 2 ** Math.min(failures, 16));
    failures += 1;
    reconnectTimer = deps.setTimeout(() => {
      reconnectTimer = null;
      void open(false);
    }, Math.floor(deps.random() * ceiling));
  };

  const open = async (rotation: boolean): Promise<void> => {
    if (stopped) return;
    let url: string;
    try {
      url = options.url ?? (await deps.resolveUrl());
    } catch (error) {
      report(error);
      scheduleReconnect();
      return;
    }
    if (stopped) return;
    let socket: WebSocketLike;
    try {
      assertRealtimeUrl(url, options.url === undefined ? 'api' : 'caller', deps.realtimeHosts ?? []);
      socket = openSocket(ctor, url, token, mode);
    } catch (error) {
      report(error);
      scheduleReconnect();
      return;
    }
    const entry: NonNullable<typeof current> = { socket, ping: null, age: null, openedAt: null };
    pending.add(socket);

    socket.onopen = () => {
      pending.delete(socket);
      if (stopped) {
        teardown(entry, 1000, 'closed');
        return;
      }
      const previous = current;
      current = entry;
      entry.openedAt = Date.now();
      if (previous !== null && previous !== entry) teardown(previous, 1000, 'rotated');
      entry.ping = deps.setInterval(() => {
        if (entry.socket.readyState === OPEN) entry.socket.send(JSON.stringify({ action: 'ping' }));
      }, pingInterval);
      entry.age = deps.setTimeout(() => void open(true), maxAge);
      const reconnected = opens > 0;
      opens += 1;
      options.onOpen?.({ reconnected });
    };

    socket.onmessage = (message) => {
      const text = typeof message.data === 'string' ? message.data : message.data instanceof Uint8Array ? new TextDecoder().decode(message.data) : String(message.data);
      const parsed = parseRealtimeFrame(text);
      if (parsed === null || parsed.kind === 'control') return;
      if (parsed.kind === 'unknown') {
        if (!isNew(parsed.event)) return;
        options.onUnknownEvent?.(parsed.event);
        return;
      }
      if (!isNew(parsed.event)) return;
      try {
        options.onEvent(parsed.event);
      } catch (error) {
        report(error);
      }
    };

    socket.onerror = () => {
      // A close always follows; reconnect is decided there.
    };

    socket.onclose = (event) => {
      pending.delete(socket);
      deps.clearInterval(entry.ping);
      deps.clearTimeout(entry.age);
      const wasCurrent = current === entry;
      if (wasCurrent) current = null;
      if (entry.openedAt !== null && Date.now() - entry.openedAt >= STABLE_AFTER_MS) failures = 0;
      // A rotation attempt that failed while the old connection is still up: retry later, the old one keeps serving.
      if (!wasCurrent && rotation && current !== null) {
        entry.socket.onclose = null;
        deps.setTimeout(() => void open(true), Math.floor(deps.random() * maxDelay));
        return;
      }
      if (!wasCurrent && current !== null) return;
      const willReconnect = !stopped;
      options.onClose?.({ code: event.code ?? null, reason: event.reason ?? '', willReconnect });
      if (willReconnect) scheduleReconnect();
    };
  };

  const close = (): void => {
    if (stopped) return;
    stopped = true;
    if (reconnectTimer !== null) deps.clearTimeout(reconnectTimer);
    reconnectTimer = null;
    for (const socket of pending) {
      socket.onclose = null;
      try {
        socket.close(1000, 'client closed');
      } catch {
        // not open yet
      }
    }
    pending.clear();
    if (current !== null) {
      const entry = current;
      current = null;
      teardown(entry, 1000, 'client closed');
      options.onClose?.({ code: 1000, reason: 'client closed', willReconnect: false });
    }
  };

  if (options.signal?.aborted === true) {
    stopped = true;
  } else {
    options.signal?.addEventListener('abort', close, { once: true });
    void open(false);
  }

  return {
    close,
    get closed() {
      return stopped;
    },
  };
}
