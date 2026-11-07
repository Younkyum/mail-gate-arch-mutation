/**
 * Errors. API errors look like `{"error": "<code>", "detail": "..."}` — branch on `code`, never on `detail`.
 * A `403 policy_denied` carries `decision` instead of `detail`; the full body is on `body`.
 */

export class AtmarkError extends Error {
  /** HTTP status, or 0 for network errors and timeouts (see `AtmarkConnectionError`). */
  readonly status: number;
  /** Machine-readable error code (`policy_denied`, `idempotency_key_reused`, ...). `unknown_error` if the body had none. */
  readonly code: string;
  /** Human-readable explanation. May change at any time. */
  readonly detail: string | null;
  /** Request id from the response (`apigw-requestid` / `x-request-id` header, or the id in a 500/503 detail). */
  readonly requestId: string | null;
  /** The parsed response body (for example `decision` on `policy_denied`). */
  readonly body: unknown;
  /** The Idempotency-Key that was sent, if any. Retry with the same key after a network error or a 5xx. */
  readonly idempotencyKey: string | null;

  constructor(init: {
    status: number;
    code: string;
    detail: string | null;
    requestId?: string | null;
    body?: unknown;
    idempotencyKey?: string | null;
    message?: string;
    cause?: unknown;
  }) {
    super(init.message ?? `${init.status === 0 ? 'request failed' : `HTTP ${init.status}`}: ${init.code}${init.detail === null ? '' : ` — ${init.detail}`}`, {
      cause: init.cause,
    });
    this.name = 'AtmarkError';
    this.status = init.status;
    this.code = init.code;
    this.detail = init.detail;
    this.requestId = init.requestId ?? null;
    this.body = init.body;
    this.idempotencyKey = init.idempotencyKey ?? null;
  }
}

/** A network failure or timeout — nothing is known about whether the server acted. Retrying with the same Idempotency-Key is safe. */
export class AtmarkConnectionError extends AtmarkError {
  constructor(init: { code: 'network_error' | 'timeout' | 'aborted'; detail: string; idempotencyKey?: string | null; cause?: unknown }) {
    super({ status: 0, ...init });
    this.name = 'AtmarkConnectionError';
  }
}

const REQUEST_ID_IN_DETAIL = /Request id: ([A-Za-z0-9=._-]+)/;

export function requestIdFrom(headers: { get(name: string): string | null }, detail: string | null): string | null {
  const fromHeader = headers.get('apigw-requestid') ?? headers.get('x-request-id') ?? headers.get('x-amzn-requestid');
  if (fromHeader !== null && fromHeader !== '') return fromHeader;
  const match = detail === null ? null : REQUEST_ID_IN_DETAIL.exec(detail);
  return match?.[1] ?? null;
}
