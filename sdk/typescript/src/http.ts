/**
 * HTTP core: auth header, JSON, timeouts, Idempotency-Key and safe retries.
 *
 * Retry rule — a request is retried only if repeating it cannot act twice:
 *   - GET / PUT / DELETE (idempotent by HTTP semantics), or
 *   - any request carrying an Idempotency-Key (the server replays the first result).
 * Retried outcomes (never the codes in `NEVER_RETRY_CODES`): network errors, timeouts, 429, 500, 502 (except `send_failed` — nothing went out and the same key
 * would replay that failure; send again with a NEW key), 503, 504 and 409 `policy_changing`.
 * Backoff: exponential with full jitter, capped; `Retry-After` (seconds or HTTP date) wins when present.
 */

import { AtmarkConnectionError, AtmarkError, requestIdFrom } from './errors.js';
import { OPERATIONS, type OperationId } from './operations.js';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface RequestOptions {
  /** Overrides the generated Idempotency-Key (send-like calls). Reuse the same key to retry a call safely. Ignored on calls the server does not de-duplicate. */
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
}

export interface HttpConfig {
  readonly token: string | null;
  readonly origin: string;
  readonly fetch: FetchLike;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly userAgent: string;
  /** Test seam. */
  readonly sleep: (ms: number) => Promise<void>;
  readonly random: () => number;
}

export type QueryValue = string | number | boolean | null | undefined;

export interface CallInput {
  readonly path?: Readonly<Record<string, string | number>>;
  /** Query parameters; `undefined`/`null` values are left out. */
  readonly query?: object;
  readonly body?: unknown;
}

const RETRY_BASE_MS = 500;
const RETRY_CAP_MS = 20_000;
const RETRY_AFTER_CAP_MS = 60_000;

export function newIdempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}

function buildPath(template: string, params: Readonly<Record<string, string | number>> | undefined): string {
  return template.replace(/\{([A-Za-z]+)\}/g, (_, name: string) => {
    const value = params?.[name];
    if (value === undefined || value === '') throw new TypeError(`missing path parameter: ${name}`);
    return encodeURIComponent(String(value));
  });
}

function buildQuery(query: object | undefined): string {
  if (query === undefined) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query) as [string, QueryValue][]) {
    if (value === undefined || value === null) continue;
    search.append(key, String(value));
  }
  const text = search.toString();
  return text === '' ? '' : `?${text}`;
}

/** Parse `Retry-After` (delta seconds or HTTP date) into milliseconds; null if absent or unreadable. */
export function retryAfterMs(value: string | null, now: number = Date.now()): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.min(RETRY_AFTER_CAP_MS, Math.round(Number(trimmed) * 1000));
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.min(RETRY_AFTER_CAP_MS, Math.max(0, date - now));
}

export function backoffMs(attempt: number, random: () => number): number {
  const ceiling = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** attempt);
  return Math.floor(random() * ceiling);
}

/**
 * Never retried, whatever the status: self-enrollment counts every attempt toward a daily limit, and `enroll_timeout`
 * means the agent may already exist (ask the owner before calling again).
 */
export const NEVER_RETRY_CODES: ReadonlySet<string> = new Set(['send_failed', 'enroll_timeout', 'enroll_busy', 'enroll_daily_cap', 'enroll_unavailable']);

function isRetryableStatus(status: number, code: string | null): boolean {
  if (code !== null && NEVER_RETRY_CODES.has(code)) return false;
  if (status === 429 || status === 500 || status === 503 || status === 504) return true;
  if (status === 502) return true;
  if (status === 409) return code === 'policy_changing';
  return false;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function errorFields(body: unknown): { code: string | null; detail: string | null } {
  if (body === null || typeof body !== 'object') return { code: null, detail: typeof body === 'string' && body !== '' ? body : null };
  const record = body as Record<string, unknown>;
  const code = typeof record['error'] === 'string' ? record['error'] : null;
  const detail = typeof record['detail'] === 'string' ? record['detail'] : typeof record['message'] === 'string' ? record['message'] : null;
  return { code, detail };
}

export class HttpClient {
  constructor(readonly config: HttpConfig) {}

  /** Call one operation from the table. Resolves with the parsed JSON body of a 2xx response; throws `AtmarkError` otherwise. */
  async call<T>(operationId: OperationId, input: CallInput = {}, options: RequestOptions = {}): Promise<T> {
    const spec = OPERATIONS[operationId];
    const url = `${this.config.origin}${buildPath(spec.path, input.path)}${buildQuery(input.query)}`;
    // Only operations the server de-duplicates get a key — a key on any other call would make it look retry-safe when it is not.
    const idempotencyKey = 'idempotencyKey' in spec ? (options.idempotencyKey ?? newIdempotencyKey()) : null;
    const retrySafe = spec.method === 'GET' || spec.method === 'PUT' || spec.method === 'DELETE' || idempotencyKey !== null;
    const maxRetries = retrySafe ? Math.max(0, options.maxRetries ?? this.config.maxRetries) : 0;

    const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': this.config.userAgent };
    if (this.config.token !== null) headers['Authorization'] = `Bearer ${this.config.token}`;
    if (idempotencyKey !== null) headers['Idempotency-Key'] = idempotencyKey;
    let body: string | undefined;
    if (input.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(input.body);
    }

    for (let attempt = 0; ; attempt += 1) {
      const outcome = await this.once(url, spec.method, headers, body, options, idempotencyKey);
      if (outcome.kind === 'ok') return outcome.body as T;
      const retryable = outcome.kind === 'network' || isRetryableStatus(outcome.error.status, outcome.error.code);
      if (!retryable || attempt >= maxRetries || options.signal?.aborted === true) throw outcome.error;
      const hinted = outcome.kind === 'http' ? retryAfterMs(outcome.retryAfter) : null;
      await this.config.sleep(hinted ?? backoffMs(attempt, this.config.random));
    }
  }

  private async once(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: string | undefined,
    options: RequestOptions,
    idempotencyKey: string | null,
  ): Promise<
    | { kind: 'ok'; body: unknown }
    | { kind: 'http'; error: AtmarkError; retryAfter: string | null }
    | { kind: 'network'; error: AtmarkConnectionError }
  > {
    const timeoutMs = options.timeoutMs ?? this.config.timeoutMs;
    const controller = new AbortController();
    const onAbort = (): void => controller.abort(options.signal?.reason);
    const userAborted = (): boolean => options.signal?.aborted === true;
    if (userAborted()) {
      throw new AtmarkConnectionError({ code: 'aborted', detail: 'The request was aborted.', idempotencyKey });
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      // Never follow redirects: the API does not redirect, and following one could carry the token to another host.
      const init: RequestInit = { method, headers, signal: controller.signal, redirect: 'manual' };
      if (body !== undefined) init.body = body;
      const response = await this.config.fetch(url, init);
      const parsed = await readBody(response);
      if (response.ok) return { kind: 'ok', body: parsed };
      if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
        return {
          kind: 'http',
          retryAfter: null,
          error: new AtmarkError({ status: response.status, code: 'unexpected_redirect', detail: 'The API answered with a redirect; it was not followed.', idempotencyKey }),
        };
      }
      const { code, detail } = errorFields(parsed);
      return {
        kind: 'http',
        retryAfter: response.headers.get('retry-after'),
        error: new AtmarkError({
          status: response.status,
          code: code ?? 'unknown_error',
          detail,
          requestId: requestIdFrom(response.headers, detail),
          body: parsed,
          idempotencyKey,
        }),
      };
    } catch (cause) {
      if (userAborted()) {
        throw new AtmarkConnectionError({ code: 'aborted', detail: 'The request was aborted.', idempotencyKey, cause });
      }
      return {
        kind: 'network',
        error: new AtmarkConnectionError({
          code: timedOut ? 'timeout' : 'network_error',
          detail: timedOut ? `No response within ${timeoutMs} ms.` : cause instanceof Error ? cause.message : String(cause),
          idempotencyKey,
          cause,
        }),
      };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }
}
