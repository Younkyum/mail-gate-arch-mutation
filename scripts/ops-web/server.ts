/**
 * scripts/ops-web/server.ts — 운영자 웹 화면의 HTTP 서버(`node:http`). **127.0.0.1 에만** 묶는다. 요청 로그를 남기지 않는다(부트스트랩 URL 에
 * 일회용 토큰이 있다). 인터넷에 배포하지 않는다 — 인프라·라우트·번들 어디에도 없다(`test/arch/ops-web-local-only.arch.test.ts`).
 *
 * 경로:
 *   GET  /bootstrap?k=<일회용>  → 303 `/#t=<세션 토큰>`(fragment — 서버·Referer 로 가지 않는다). **실패(틀림·재사용·만료)는 탈취 신호** —
 *                                  경고를 내고(`onBootstrapAbuse`) 서버를 닫는다.
 *   GET  /                      → 정적 페이지(해시 CSP · 데이터 없음). Host·Origin·Sec-Fetch 검문만.
 *   *    /api/*                 → `x-ops-token` 헤더(세션 토큰, 상수 시간) — 예외 없음 · 쓰기는 Origin 필수(`security.ts`).
 * **쿠키를 쓰지 않는다**(Set-Cookie 0 · 요청의 Cookie 는 읽지 않는다) — 앰비언트 자격 증명 0.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { AdminInputError } from '../../src/admin/ops/errors';
import { handleApi, type ApiContext } from '../../src/ops/console/api';
import { buildOpsPage } from '../../src/ops/console/page';
import { BIND_HOST, BootstrapToken, checkAuth, checkOrigin, TOKEN_HEADER, type BootstrapResult, type RequestFacts } from './security';

/** 본문 상한 — 요금제 폼이 가장 크다(1KB 남짓). */
export const MAX_BODY_BYTES = 16 * 1024;

const COMMON_HEADERS: Readonly<Record<string, string>> = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
};

export interface OpsServerOptions {
  readonly port: number;
  /** 세션 토큰 — `/api/*` 의 `x-ops-token`. 부트스트랩이 fragment 로 한 번 넘긴다. */
  readonly sessionToken: string;
  readonly bootstrap: string;
  readonly bootstrapTtlMs: number;
  readonly context: ApiContext;
  /** `/api/*` 인증을 지난 요청마다(유휴 타이머). */
  readonly onActivity?: () => void;
  /** 부트스트랩 실패(틀림·재사용·만료) — 호출자가 경고하고 닫는다. 서버는 이 뒤 새 요청을 받지 않는다. */
  readonly onBootstrapAbuse?: (reason: Exclude<BootstrapResult, 'ok'>) => void;
  readonly clock?: () => number;
}

export interface OpsServer {
  readonly server: Server;
  readonly port: number;
  /** 브라우저로 여는 일회용 URL. **로그에 남기지 않는다.** */
  readonly bootstrapUrl: string;
  close(): Promise<void>;
}

const PLAIN_CSP = "default-src 'none'; frame-ancestors 'none'";

function send(res: ServerResponse, status: number, headers: Record<string, string>, body: string): void {
  res.writeHead(status, { ...COMMON_HEADERS, ...headers });
  res.end(body);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  send(res, status, { 'content-type': 'application/json; charset=utf-8', 'content-security-policy': PLAIN_CSP }, JSON.stringify(body));
}

function plain(res: ServerResponse, status: number, text: string): void {
  send(res, status, { 'content-type': 'text/plain; charset=utf-8', 'content-security-policy': PLAIN_CSP }, text);
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const type = header(req, 'content-type') ?? '';
  if (!type.toLowerCase().startsWith('application/json')) throw new AdminInputError('content-type 은 application/json.', 'invalid_body', 400);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new AdminInputError('본문이 너무 크다.', 'body_too_large', 400);
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AdminInputError('본문이 JSON 이 아니다.', 'invalid_body', 400);
  }
}

/** 예외 → 응답. 입력 거부는 그 코드, DB 거부는 메시지만(스택·URL 없음). 서버는 아무것도 찍지 않는다. */
function errorBody(error: unknown): { status: number; body: { error: string; detail: string } } {
  if (error instanceof AdminInputError) return { status: error.status, body: { error: error.code, detail: error.message } };
  const code = (error as { code?: unknown }).code;
  const message = error instanceof Error ? error.message : String(error);
  return { status: 500, body: { error: typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? `db_${code}` : 'internal_error', detail: message.slice(0, 500) } };
}

export async function startOpsServer(options: OpsServerOptions): Promise<OpsServer> {
  const page = buildOpsPage();
  const clock = options.clock ?? Date.now;
  const bootstrap = new BootstrapToken(options.bootstrap, clock(), options.bootstrapTtlMs);
  let port = options.port;
  let closing = false;

  const server = createServer((req, res) => {
    void (async () => {
      if (closing) return plain(res, 503, 'closing');
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const method = req.method ?? 'GET';
      const facts: RequestFacts = {
        method,
        path: url.pathname,
        host: header(req, 'host'),
        origin: header(req, 'origin'),
        secFetchSite: header(req, 'sec-fetch-site'),
        token: header(req, TOKEN_HEADER),
      };
      const navigation = method === 'GET' && (url.pathname === '/' || url.pathname === '/bootstrap');
      const origin = checkOrigin(facts, port, navigation);
      if (!origin.ok) return plain(res, origin.status, origin.code);

      if (url.pathname === '/bootstrap') {
        if (method !== 'GET') return plain(res, 405, 'method_not_allowed');
        const outcome = bootstrap.consume(url.searchParams.get('k'), clock());
        if (outcome !== 'ok') {
          closing = true;
          plain(res, 410, '이 URL 은 이미 썼거나 만료됐거나 틀렸다 — 탈취 신호로 보고 서버를 닫는다. pnpm admin:web 을 다시 띄운다.');
          options.onBootstrapAbuse?.(outcome);
          return;
        }
        return send(res, 303, { location: `/#t=${options.sessionToken}`, 'content-type': 'text/plain; charset=utf-8', 'content-security-policy': PLAIN_CSP }, '');
      }

      const auth = checkAuth(facts, options.sessionToken);
      if (!auth.ok) return url.pathname.startsWith('/api/') ? json(res, auth.status, { error: auth.code }) : plain(res, auth.status, auth.code);

      if (url.pathname === '/' && method === 'GET') {
        return send(res, 200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': page.csp }, page.html);
      }
      if (!url.pathname.startsWith('/api/')) return plain(res, 404, 'not_found');
      options.onActivity?.();
      try {
        const body = method === 'POST' ? await readJson(req) : undefined;
        const result = await handleApi(options.context, method, url.pathname, url.searchParams, body);
        return json(res, result.status, result.body);
      } catch (error) {
        const failure = errorBody(error);
        return json(res, failure.status, failure.body);
      }
    })().catch(() => {
      if (!res.headersSent) plain(res, 500, 'internal_error');
      else res.destroy();
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port: options.port, host: BIND_HOST, exclusive: true }, () => {
      server.off('error', reject);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;

  return {
    server,
    port,
    bootstrapUrl: `http://${BIND_HOST}:${String(port)}/bootstrap?k=${options.bootstrap}`,
    close: () =>
      new Promise<void>((resolve) => {
        closing = true;
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
