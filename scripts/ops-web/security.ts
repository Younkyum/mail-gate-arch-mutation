/**
 * scripts/ops-web/security.ts — 운영자 웹 화면(`pnpm admin:web`)의 요청 검문. 순수 함수만 — 서버(`server.ts`)가 요청마다 부르고, 테스트가 직접 부른다.
 *
 * 위협: 이 서버는 운영 DB 소유자 롤(과 결제 운영자 롤)을 쥔 채 노트북에서 돈다. 브라우저의 **다른 탭**(아무 웹사이트)이나 같은 기계의 다른
 * 로컬 서버(127.0.0.1 의 다른 포트)가 이 포트로 요청을 보낼 수 있다(CSRF · DNS rebinding). 그래서:
 *   ① Host 가 정확히 `127.0.0.1:<포트>` — DNS rebinding(공격자 도메인이 127.0.0.1 로 풀리는 것)은 Host 가 공격자 이름이라 막힌다. `localhost` 는 받지 않는다.
 *   ② Origin 이 있으면 `http://127.0.0.1:<포트>` 와 같아야 한다 · `Sec-Fetch-Site` 가 있으면 `same-origin`(주소창 탐색은 `none` 도).
 *   ③ **앰비언트 자격 증명 0** — 쿠키를 쓰지 않는다. 쿠키는 포트를 가리지 않아(127.0.0.1 의 다른 포트 서버에도 실린다) 격리가 되지 않는다.
 *      대신 세션 토큰(실행마다 새 32바이트)을 **페이지 스크립트가 명시적으로** `x-ops-token` 헤더에 싣고, 서버는 상수 시간으로 비교한다.
 *      토큰은 부트스트랩(`/bootstrap?k=<일회용>`)이 303 `/#t=<토큰>` 으로 **한 번** 넘긴다 — fragment 는 서버·Referer 로 가지 않고, 스크립트가
 *      `sessionStorage`(오리진 = 스킴+호스트+**포트** 범위)에 옮긴 뒤 주소에서 즉시 지운다.
 *   ④ 다른 오리진은 사용자 정의 헤더를 CORS preflight 없이 못 보내고, 우리는 preflight 를 허락하지 않는다(CORS 헤더 0).
 *   ⑤ 쓰기(POST)는 Origin 이 **있어야** 한다(브라우저 fetch 는 늘 붙인다).
 * `/`(정적 페이지)는 데이터가 없으므로 ①② 검문만 받는다.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';

/** 32바이트 base64url(43자). 세션 토큰 · 부트스트랩 토큰 각각 따로. */
export function randomSecret(): string {
  return randomBytes(32).toString('base64url');
}

/** 길이가 달라도 예외 없이 거짓(값은 전부 43자라 길이 차이도 드러나지 않는다). */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

/** 바인드 주소 — 명시적으로 IPv4 루프백 하나. 와일드카드 주소로 가는 설정(옵션·환경 변수)은 없다. */
export const BIND_HOST = '127.0.0.1';

/** 받는 Host 는 하나 — `127.0.0.1:<포트>`. */
export function allowedHost(port: number): string {
  return `${BIND_HOST}:${String(port)}`;
}

/** 세션 토큰을 싣는 헤더. 사용자 정의 헤더라 다른 오리진은 preflight 없이 못 보낸다. */
export const TOKEN_HEADER = 'x-ops-token';

export interface RequestFacts {
  readonly method: string;
  readonly path: string;
  readonly host: string | undefined;
  readonly origin: string | undefined;
  readonly secFetchSite: string | undefined;
  /** `x-ops-token` 헤더. 쿠키는 보지 않는다. */
  readonly token: string | undefined;
}

export type Verdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: 400 | 401 | 403 | 405; readonly code: string };

const deny = (status: 400 | 401 | 403 | 405, code: string): Verdict => ({ ok: false, status, code });

/**
 * Host · Origin · Sec-Fetch-Site 검문 — **모든** 요청(부트스트랩 · 정적 페이지 포함)에 건다.
 * `navigation` = 주소창·링크로 온 페이지 탐색(부트스트랩 · `/`) — 이때만 `Sec-Fetch-Site: none` 을 받는다.
 */
export function checkOrigin(facts: RequestFacts, port: number, navigation: boolean): Verdict {
  const host = allowedHost(port);
  if (facts.host !== host) return deny(403, 'bad_host');
  if (facts.origin !== undefined && facts.origin !== `http://${host}`) return deny(403, 'bad_origin');
  const site = facts.secFetchSite;
  if (site !== undefined && site !== 'same-origin' && !(navigation && site === 'none')) return deny(403, 'cross_site');
  return { ok: true };
}

/**
 * 인증 — `/api/*` 는 **예외 없이** 세션 토큰 헤더(상수 시간) + 쓰기는 Origin 필수. `/api/*` 밖은 GET 만(정적 페이지 — 데이터 없음).
 * `checkOrigin` 을 지난 요청에만 부른다.
 */
export function checkAuth(facts: RequestFacts, sessionToken: string): Verdict {
  if (!facts.path.startsWith('/api/')) return facts.method === 'GET' ? { ok: true } : deny(405, 'method_not_allowed');
  if (facts.token === undefined || !safeEqual(facts.token, sessionToken)) return deny(401, 'unauthenticated');
  if (facts.method === 'POST') return facts.origin === undefined ? deny(403, 'origin_required') : { ok: true };
  return facts.method === 'GET' ? { ok: true } : deny(405, 'method_not_allowed');
}

export type BootstrapResult = 'ok' | 'mismatch' | 'used' | 'expired';

/**
 * 부트스트랩 토큰 — 한 번만. 실패(`mismatch`·`used`·`expired`)는 **탈취 신호**다 — 서버가 경고하고 스스로 닫는다(`server.ts`).
 * 다시 들어가려면 `pnpm admin:web` 을 다시 띄운다.
 */
export class BootstrapToken {
  private value: string | null;
  private readonly expiresAt: number;

  constructor(value: string, now: number, ttlMs: number) {
    this.value = value;
    this.expiresAt = now + ttlMs;
  }

  consume(candidate: string | null, now: number): BootstrapResult {
    if (this.value === null) return 'used';
    if (now > this.expiresAt) return 'expired';
    if (candidate === null || !safeEqual(candidate, this.value)) return 'mismatch';
    this.value = null;
    return 'ok';
  }

  get used(): boolean {
    return this.value === null;
  }
}

export type SessionEnd = 'idle' | 'lifetime';

/**
 * 세션 타이머 — ① 유휴: 인증된 요청마다 `touch`, `idleMs` 동안 요청이 없으면 닫는다. ② 절대 수명: 시작 뒤 `maxMs` 가 지나면 요청과 무관하게 닫는다.
 * 둘 중 먼저 오는 것 하나로 `onEnd` 한 번. 시계·타이머는 테스트가 바꾼다.
 */
export class SessionTimer {
  private last: number;
  private readonly deadline: number;
  private handle: ReturnType<typeof setTimeout> | null = null;
  private fired = false;

  constructor(
    private readonly idleMs: number,
    maxMs: number,
    private readonly onEnd: (reason: SessionEnd) => void,
    private readonly now: () => number = Date.now,
  ) {
    this.last = now();
    this.deadline = this.last + maxMs;
  }

  start(): void {
    this.schedule();
  }

  touch(): void {
    this.last = this.now();
  }

  stop(): void {
    if (this.handle !== null) clearTimeout(this.handle);
    this.handle = null;
    this.fired = true;
  }

  /** 남은 시간(ms) — 유휴·수명 중 먼저 오는 것까지. */
  remaining(): number {
    const t = this.now();
    return Math.max(0, Math.min(this.last + this.idleMs, this.deadline) - t);
  }

  private schedule(): void {
    this.handle = setTimeout(() => {
      if (this.fired) return;
      const t = this.now();
      if (t >= this.deadline) return this.end('lifetime');
      if (t >= this.last + this.idleMs) return this.end('idle');
      this.schedule();
    }, this.remaining());
  }

  private end(reason: SessionEnd): void {
    this.fired = true;
    this.handle = null;
    this.onEnd(reason);
  }
}
