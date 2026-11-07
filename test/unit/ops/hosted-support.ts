/**
 * 호스팅 ops 단위 테스트 도우미 — 가짜 풀(문장을 순서대로 적고 정규식으로 답한다) · 이벤트 · 의존성.
 */

import type { Pool } from 'pg';

import { OPS_COOKIES, OPS_CSRF_HEADER, OPS_DOMAIN_NAME, OPS_ORIGIN } from '../../../src/ops/contract';
import type { HostedDeps } from '../../../src/ops/hosted/app';
import type { OpsHttpEvent } from '../../../src/ops/hosted/http';
import { createOpsKeys, type OpsKeys } from '../../../src/ops/hosted/keys';
import { parseHmacKeyring } from '../../../src/security/hmac-keyring';

export const KEYRING = `o1:${Buffer.alloc(32, 7).toString('base64url')}`;
export const keys: OpsKeys = createOpsKeys(parseHmacKeyring(KEYRING, 'test'));

export const ORG = '11111111-2222-4333-8444-555555555555';
export const OPERATOR = '99999999-2222-4333-8444-555555555555';
export const ME = '88888888-2222-4333-8444-555555555555';
export const TOKEN = 'T'.repeat(43);
export const NONCE = 'N'.repeat(43);

export interface Responder {
  readonly match: RegExp;
  readonly rows?: readonly Record<string, unknown>[];
  readonly error?: { readonly code: string; readonly detail?: string; readonly message?: string };
}

export interface FakePool {
  readonly pool: Pool;
  readonly sql: string[];
  readonly params: unknown[][];
  released: number;
  /** `release(err)` 로 버린 연결(ROLLBACK 실패). */
  readonly destroyed: unknown[];
}

function dbError(spec: NonNullable<Responder['error']>): Error {
  return Object.assign(new Error(spec.message ?? `db ${spec.code}`), { code: spec.code, detail: spec.detail });
}

/** 응답은 위에서부터 첫 일치. 없으면 빈 행. `BEGIN`/`COMMIT`/`ROLLBACK` 은 늘 성공. */
export function fakePool(responders: readonly Responder[]): FakePool {
  const state: FakePool = { pool: undefined as unknown as Pool, sql: [], params: [], released: 0, destroyed: [] };
  const query = async (text: string, values: unknown[] = []) => {
    state.sql.push(text.trim());
    state.params.push(values);
    const tx = responders.find((r) => r.match.test(text) && /^(BEGIN|COMMIT|ROLLBACK)$/.test(text.trim()));
    if (tx?.error !== undefined) throw dbError(tx.error);
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text.trim())) return { rows: [], rowCount: 0 };
    const hit = responders.find((r) => r.match.test(text));
    if (hit?.error !== undefined) throw dbError(hit.error);
    const rows = hit?.rows ?? [];
    return { rows, rowCount: rows.length };
  };
  const pool = {
    query,
    connect: async () => ({
      query,
      release: (error?: unknown) => {
        state.released += 1;
        if (error !== undefined) state.destroyed.push(error);
      },
    }),
    on: () => pool,
  };
  (state as { pool: Pool }).pool = pool as unknown as Pool;
  return state;
}

export const TOUCH_OK: Responder = {
  match: /ops_session_touch/,
  rows: [{ operator_id: ME, session_id: 'aaaaaaaa-2222-4333-8444-555555555555', email: 'jin@example.com', expires_at: new Date('2026-09-28T20:00:00Z') }],
};

export function deps(fake: FakePool, kicks: { n: number } = { n: 0 }): HostedDeps {
  return {
    pool: fake.pool,
    keys,
    kickMailer: async () => {
      kicks.n += 1;
    },
    now: () => new Date('2026-09-28T12:00:00Z'),
  };
}

export interface EventInput {
  readonly method?: string;
  readonly path: string;
  readonly query?: string;
  readonly body?: unknown;
  readonly host?: string;
  readonly origin?: string | null;
  readonly site?: string;
  readonly cookies?: Readonly<Record<string, string>>;
  readonly csrf?: string | null;
  readonly domainName?: string;
}

/** 기본: 호스트 · 출처 정상, 세션 쿠키 · CSRF 가 맞다. */
export function event(input: EventInput): OpsHttpEvent {
  const method = input.method ?? (input.body === undefined ? 'GET' : 'POST');
  const headers: Record<string, string> = { host: input.host ?? OPS_DOMAIN_NAME, 'user-agent': 'Mozilla/5.0 test', 'sec-fetch-site': input.site ?? 'same-origin' };
  const origin = input.origin === undefined ? (method === 'POST' ? OPS_ORIGIN : undefined) : input.origin;
  if (origin !== null && origin !== undefined) headers['origin'] = origin;
  if (input.body !== undefined) headers['content-type'] = 'application/json';
  const cookies = input.cookies ?? { [OPS_COOKIES.session]: TOKEN };
  const csrf = input.csrf === undefined ? keys.csrf(cookies[OPS_COOKIES.session] ?? TOKEN) : input.csrf;
  if (csrf !== null && method === 'POST') headers[OPS_CSRF_HEADER] = csrf;
  return {
    rawPath: input.path,
    ...(input.query === undefined ? {} : { rawQueryString: input.query }),
    headers,
    cookies: Object.entries(cookies).map(([k, v]) => `${k}=${v}`),
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    requestContext: {
      requestId: 'req-1',
      domainName: input.domainName ?? input.host ?? OPS_DOMAIN_NAME,
      http: { method, sourceIp: '203.0.113.7', userAgent: 'Mozilla/5.0 test' },
    },
  };
}
