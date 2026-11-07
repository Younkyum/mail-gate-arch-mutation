/**
 * src/billing/paddle/http.ts — ★ **Paddle API 의 유일한 문**(계획 §Step 3 · `test/arch/network-egress.arch.test.ts` 허용 목록 ·
 * `billing-boundary` 층 "Paddle `fetch` 는 한 파일"). 어댑터(`adapter.ts`)는 이 파일의 `PaddleHttp` 만 받는다.
 *
 * 나가는 곳은 **환경별로 이름을 고정한 호스트** 하나다(`PADDLE_API_ORIGINS` — 계획 §0 P15). 경로는 모양을 확인한 상대 경로만 받고, 쿼리는
 * `URLSearchParams` 로만 만든다(id 가 경로·쿼리를 넘지 않게). 리다이렉트는 따르지 않는다(`redirect: 'error'`) · 10초 시간 제한 · 응답 크기 상한.
 *
 * 상태 → 오류(`../provider.ts`): 401/403 `ProviderAuthError` · 404 `ProviderNotFoundError` · 429 `ProviderRateLimitedError`(`Retry-After` 초) ·
 * 그 밖의 4xx/5xx · 시간 초과 · 연결 실패 · 크기 초과 · JSON 아님 → `ProviderUnavailableError`. **오류·로그에 키·URL·응답 본문을 싣지 않는다** —
 * 코드와 HTTP 상태 숫자뿐이다. 키는 `Authorization: Bearer` 헤더로만 나간다(계획 §0 P20).
 *
 * 테스트는 `fetchImpl` 에 가짜를 넣는다 — 테스트에서 실제 Paddle 을 부르지 않는다.
 */

import type { PaddleEnvironment } from '../constants';
import { ProviderAuthError, ProviderNotFoundError, ProviderRateLimitedError, ProviderUnavailableError } from '../provider';

/** 환경별 API 출처(계획 §0 P15) — 샌드박스 키로 운영 호스트를 부르는 길이 없게 환경이 호스트를 정한다. */
export const PADDLE_API_ORIGINS: Readonly<Record<PaddleEnvironment, string>> = {
  sandbox: 'https://sandbox-api.paddle.com',
  production: 'https://api.paddle.com',
};

export const PADDLE_HTTP_TIMEOUT_MS = 10_000;
/** 응답 크기 상한 — 목록 한 페이지(최대 200건)도 이보다 작다. 넘으면 읽지 않고 `provider_unavailable`. */
export const PADDLE_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
/** `Retry-After` 를 믿는 최대 초 — 이보다 크면 이 값으로 자른다. */
export const PADDLE_RETRY_AFTER_MAX_SECONDS = 3600;
/** Paddle API 버전 헤더(`Paddle-Version`) — 응답 모양을 고정한다. */
export const PADDLE_API_VERSION = '1';

/** 상대 경로 모양 — `/subscriptions` · `/transactions/txn_…` · `/customers/ctm_…/portal-sessions`. 점·퍼센트·쿼리·조각 없음. */
const PATH_SHAPE = /^(\/[a-z0-9_-]{1,64}){1,4}$/;
/** 키 모양 — 헤더를 깨는 글자(공백·줄바꿈·제어 문자)가 없는 인쇄 가능 ASCII. 형식 자체(`pdl_…`)는 Paddle 이 판정한다. */
export const PADDLE_API_KEY_SHAPE = /^[\x21-\x7e]{8,512}$/;

export type PaddleFetch = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
    readonly redirect: 'error';
    readonly signal: AbortSignal;
  },
) => Promise<{
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export type PaddleQuery = Readonly<Record<string, string>>;

/** Paddle API 한 벌 — 응답은 JSON 봉투(`{ data, meta }`) 그대로. 204 는 null. */
export interface PaddleHttp {
  readonly environment: PaddleEnvironment;
  get(path: string, query?: PaddleQuery): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
  patch(path: string, body: unknown): Promise<unknown>;
}

export interface PaddleHttpOptions {
  readonly environment: PaddleEnvironment;
  /** Secrets Manager 에서 읽은 키(자리표시 검사는 조립이 먼저 한다). */
  readonly apiKey: string;
  readonly fetchImpl?: PaddleFetch;
  readonly timeoutMs?: number;
}

function retryAfterSeconds(raw: string | null): number | null {
  if (raw === null || !/^\d{1,6}$/.test(raw.trim())) return null;
  return Math.min(Number(raw.trim()), PADDLE_RETRY_AFTER_MAX_SECONDS);
}

export function createPaddleHttp(options: PaddleHttpOptions): PaddleHttp {
  if (!PADDLE_API_KEY_SHAPE.test(options.apiKey)) {
    // 값은 싣지 않는다 — 모양이 틀렸다는 사실만.
    throw new ProviderAuthError();
  }
  const origin = PADDLE_API_ORIGINS[options.environment];
  const send: PaddleFetch = options.fetchImpl ?? (fetch as unknown as PaddleFetch);
  const timeoutMs = options.timeoutMs ?? PADDLE_HTTP_TIMEOUT_MS;
  const authorization = `Bearer ${options.apiKey}`;

  async function request(method: 'GET' | 'POST' | 'PATCH', path: string, query: PaddleQuery | undefined, body: unknown): Promise<unknown> {
    if (!PATH_SHAPE.test(path)) throw new ProviderUnavailableError('provider_unavailable', 'path_shape');
    const search = query === undefined ? '' : new URLSearchParams(Object.entries(query)).toString();
    const url = `${origin}${path}${search === '' ? '' : `?${search}`}`;
    const headers: Record<string, string> = {
      authorization,
      accept: 'application/json',
      'paddle-version': PADDLE_API_VERSION,
      'user-agent': 'atmark-billing/1',
    };
    const init: Parameters<PaddleFetch>[1] =
      body === undefined
        ? { method, headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) }
        : { method, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(timeoutMs) };
    let response: Awaited<ReturnType<PaddleFetch>>;
    try {
      response = await send(url, init);
    } catch {
      throw new ProviderUnavailableError('provider_unavailable', 'unreachable');
    }
    const status = response.status;
    if (status === 401 || status === 403) throw new ProviderAuthError();
    if (status === 404) throw new ProviderNotFoundError();
    if (status === 429) throw new ProviderRateLimitedError(retryAfterSeconds(response.headers.get('retry-after')));
    if (status < 200 || status >= 300) throw new ProviderUnavailableError('provider_unavailable', `http_${String(status)}`);
    if (status === 204) return null;
    const declared = response.headers.get('content-length');
    if (declared !== null && /^\d+$/.test(declared) && Number(declared) > PADDLE_MAX_RESPONSE_BYTES) {
      throw new ProviderUnavailableError('provider_unavailable', 'response_too_large');
    }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(await response.arrayBuffer());
    } catch {
      throw new ProviderUnavailableError('provider_unavailable', 'unreachable');
    }
    if (bytes.length > PADDLE_MAX_RESPONSE_BYTES) throw new ProviderUnavailableError('provider_unavailable', 'response_too_large');
    try {
      return JSON.parse(bytes.toString('utf8')) as unknown;
    } catch {
      throw new ProviderUnavailableError('provider_response_invalid', 'not_json');
    }
  }

  return {
    environment: options.environment,
    get: (path, query) => request('GET', path, query, undefined),
    post: (path, body) => request('POST', path, undefined, body),
    patch: (path, body) => request('PATCH', path, undefined, body),
  };
}
