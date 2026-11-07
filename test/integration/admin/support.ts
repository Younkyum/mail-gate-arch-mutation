/**
 * 관리 백엔드 통합 테스트의 공용 지반 — **실제 Postgres 롤 넷**:
 *   - 소유자 롤(`TEST_MIGRATION_DATABASE_URL`) — 테스트 지반(행 심기·검사). 대부분의 라우터 호출도 이 풀로 돈다.
 *   - 앱 롤(`TEST_DATABASE_URL`) — api Lambda·워커. 로그인·세션·감사에 권한 0 임을 확인하는 데 쓴다.
 *   - 로그인 메일 롤 `atmark_login_mailer`(`TEST_LOGIN_MAILER_DATABASE_URL`, 없으면 앱 URL 의 사용자만 바꾼 것) — 로그인
 *     워커는 반드시 이 풀로 돈다(`202609230720` — 앱 롤에서는 owner_login_links 권한이 거둬졌다).
 *   - 관리 롤 `atmark_admin`(`TEST_ADMIN_DATABASE_URL`, 없으면 같은 방식) — 운영 admin Lambda 의 롤. 새 SQL 이 그 GRANT
 *     안에서 도는지 보는 테스트가 쓴다.
 * **실메일은 나가지 않는다** — SES 호출면은 호출을 기록만 하는 가짜다. AWS 호출 0.
 */

import { randomBytes, randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import type { AdminDependencies } from '../../../src/admin/context';
import { createInMemoryContentStore } from '../../../src/api/content-store';
import { LOGIN_BROWSER_COOKIE, SESSION_COOKIE, type AdminHttpEvent, type AdminHttpResult } from '../../../src/admin/http';
import { createOrganizationOp } from '../../../src/admin/ops/agents';
import type { PlanCode } from '../../../src/billing/plans';
import { afterDbNow } from '../../support/db-clock';
import { grantPlan } from '../../support/entitlements';
import { routeAdminEvent } from '../../../src/admin/router';
import { createPool } from '../../../src/db/client';
import { createOwnerLoginNotifier, type OwnerLoginNotifierDependencies } from '../../../src/notify/owner-login-notifier';
import { parseHmacKeyring, type HmacKeyring } from '../../../src/security/hmac-keyring';
import { runOwnerLoginNotifier } from '../../../src/workers/owner-login-notifier';
import { testKeyCustody } from '../../unit/identity/fixtures';

export const OWNER_URL = process.env['TEST_MIGRATION_DATABASE_URL'] ?? '';
export const APP_URL = process.env['TEST_DATABASE_URL'] ?? '';
export const AVAILABLE = OWNER_URL.trim() !== '' && APP_URL.trim() !== '';

/** 앱 URL 의 사용자만 바꾼다(비밀번호는 지운다 — 로컬 trust 인증). 명시 환경변수가 있으면 그것. */
function roleUrl(explicit: string | undefined, role: string): string {
  if (explicit !== undefined && explicit.trim() !== '') return explicit;
  if (APP_URL.trim() === '') return '';
  const url = new URL(APP_URL);
  url.username = role;
  url.password = '';
  return url.toString();
}

export const LOGIN_MAILER_URL = roleUrl(process.env['TEST_LOGIN_MAILER_DATABASE_URL'], 'atmark_login_mailer');
export const ADMIN_ROLE_URL = roleUrl(process.env['TEST_ADMIN_DATABASE_URL'], 'atmark_admin');

export const LOGIN_KEYS: HmacKeyring = parseHmacKeyring(`k1:${randomBytes(32).toString('base64url')}`, 'TEST_LOGIN');

export function ownerPool(): Pool {
  return createPool(OWNER_URL, { max: 4 });
}

export function appPool(): Pool {
  return createPool(APP_URL, { max: 4 });
}

/** 로그인 메일 워커의 롤(`atmark_login_mailer`). */
export function loginMailerPool(): Pool {
  return createPool(LOGIN_MAILER_URL, { max: 4 });
}

/** 운영 admin Lambda 의 롤(`atmark_admin`). */
export function adminRolePool(): Pool {
  return createPool(ADMIN_ROLE_URL, { max: 4 });
}

export function adminDeps(pool: Pool, overrides: Partial<AdminDependencies> = {}): AdminDependencies {
  // 본문 리더 기본값: 빈 메모리 저장소(읽으면 "없음"). 본문을 보는 테스트는 같은 저장소의 리더를 overrides 로 넣는다.
  return { pool, loginKeys: LOGIN_KEYS, custody: testKeyCustody, outboundContent: createInMemoryContentStore(), now: () => new Date(), ...overrides };
}

export const suffix = (): string => randomBytes(4).toString('hex');

/**
 * 테스트마다 **고유한** 소유자 주소의 조직 — 다른 테스트의 조직과 로그인이 섞이지 않게. `pool` 은 소유자 롤이다(조직 INSERT). 요금제는 기본
 * `beta`(ADR-0011 — 기존 활성 조직이 백필로 받은 도입 전 한도; 이 층의 테스트는 그 한도를 전제로 쓰였다) · `null` 이면 행 없음(= Free).
 */
export async function newOrganization(pool: Pool, plan: PlanCode | null = 'beta'): Promise<{ id: string; ownerEmail: string }> {
  const ownerEmail = `owner-${suffix()}@example.com`;
  const organization = await createOrganizationOp(pool, { name: `admin-api-${suffix()}`, ownerEmail });
  if (plan !== null) await grantPlan(pool, organization.id, plan);
  return { id: organization.id, ownerEmail };
}

/** 주소 → `users.id`(202609250190 부터 세션·로그인 링크 INSERT 는 user_id 를 반드시 적어야 한다 — 자동 채움 트리거가 걷혔다). */
export async function userIdOf(pool: Pool, address: string): Promise<string> {
  const row = await pool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [address]);
  const id = row.rows[0]?.id;
  if (id === undefined) throw new Error(`users 에 없다: ${address}`);
  return id;
}

export interface RequestOptions {
  readonly body?: unknown;
  readonly rawBody?: string;
  readonly cookies?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly ip?: string;
  readonly query?: string;
}

export function event(method: string, path: string, options: RequestOptions = {}): AdminHttpEvent {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  const body = options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  if (options.body !== undefined && headers['content-type'] === undefined) headers['content-type'] = 'application/json';
  return {
    rawPath: path,
    ...(options.query === undefined ? {} : { rawQueryString: options.query }),
    headers,
    cookies: Object.entries(options.cookies ?? {}).map(([name, value]) => `${name}=${value}`),
    ...(body === undefined ? {} : { body }),
    isBase64Encoded: false,
    requestContext: { requestId: `req-${randomUUID()}`, stage: '$default', http: { method, sourceIp: options.ip ?? `198.51.100.${String(Math.floor(Math.random() * 250) + 1)}` } },
  };
}

export async function call(deps: AdminDependencies, method: string, path: string, options: RequestOptions = {}): Promise<AdminHttpResult & { json: () => unknown }> {
  const result = await routeAdminEvent(deps, event(method, path, options));
  return { ...result, json: () => (result.body === '' ? null : (JSON.parse(result.body) as unknown)) };
}

/** `Set-Cookie` 목록에서 값 하나. */
export function cookieValue(result: AdminHttpResult, name: string): string | undefined {
  const line = (result.cookies ?? []).find((cookie) => cookie.startsWith(`${name}=`));
  return line?.slice(name.length + 1).split(';')[0];
}

export interface SentMail {
  readonly from: string | undefined;
  readonly to: readonly string[];
  readonly raw: string;
}

/** SES 호출면 가짜 — **기록만 한다.** */
export function fakeSes(): { readonly client: OwnerLoginNotifierDependencies['client']; readonly sent: SentMail[] } {
  const sent: SentMail[] = [];
  return {
    sent,
    client: {
      send(command) {
        const input = command.input;
        sent.push({
          from: input.FromEmailAddress,
          to: input.Destination?.ToAddresses ?? [],
          raw: Buffer.from(input.Content?.Raw?.Data ?? new Uint8Array()).toString('utf8'),
        });
        return Promise.resolve({ MessageId: `ses-${randomUUID()}`, $metadata: {} });
      },
    },
  };
}

/**
 * 로그인 워커를 **로그인 메일 롤** 풀로 한 번 돌린다(조직 범위). 링크의 `next_attempt_at` 은 `date_trunc('milliseconds', now())`
 * (src/admin/session.ts · src/admin/ops/members.ts)라 같은 시계면 µs 경합은 없다 — JS 시계가 DB 시계보다 뒤인 어긋남에 대한 방어로
 * DB 시계를 넘긴 뒤에 돌린다(`afterDbNow`).
 */
export async function drainLoginMail(mailer: Pool, organizationId: string, now: () => Date = () => new Date()): Promise<SentMail[]> {
  await afterDbNow(mailer);
  const ses = fakeSes();
  const notifier = createOwnerLoginNotifier({ pool: mailer, client: ses.client, keyring: LOGIN_KEYS, now });
  await runOwnerLoginNotifier({ db: mailer, notifier, now }, { organizationId });
  return ses.sent;
}

/**
 * 메일 본문의 text/plain 파트(base64)를 푼다. 로그인·가입·초대·운영 코드 메일은 2026-09-28 부터 `multipart/alternative`(text/plain → text/html)
 * 이므로 첫 빈 줄 뒤가 곧 본문이 아니다 — text/plain 파트 머리를 찾아 그 파트의 몸만 푼다(단일 파트 메일에도 그대로 맞는다).
 */
export function mailText(mail: SentMail): string {
  const at = mail.raw.indexOf('Content-Type: text/plain; charset=UTF-8');
  if (at < 0) throw new Error('메일에 text/plain 파트가 없다');
  const body = (mail.raw.slice(at).split('\r\n\r\n')[1] ?? '').split('\r\n--')[0] ?? '';
  return Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8');
}

/**
 * 메일 본문의 6자리 코드 — 한 줄에 6자리 숫자만 있는 줄(한 통에 한 언어 · 한 번 — 2026-10-10). 로그인 · 가입 확인 메일에는 링크가 없다(코드만).
 */
export function codeFromMail(mail: SentMail): string {
  const text = mailText(mail);
  const codes = text.split('\n').filter((line) => /^[0-9]{6}$/.test(line));
  if (codes.length !== 1 || codes[0] === undefined) throw new Error(`메일에 코드가 한 번 있어야 한다:\n${text}`);
  if (/https?:\/\/|atk_(login|signup)_/.test(text)) throw new Error(`코드 메일에 링크 · 토큰이 있다:\n${text}`);
  return codes[0];
}

/** 코드 verify 의 요청자 IP — 코드 verify 상한(쌍 15분 30회 · IP 300회)이 공유 DB 에서 다른 테스트·이전 실행과 섞이지 않게. */
export const uniqueCodeIp = (): string => `198.51.100.${String(Math.floor(Math.random() * 250))}-${suffix()}${suffix()}`;

export interface Session {
  readonly cookies: Readonly<Record<string, string>>;
  readonly csrf: string;
  readonly token: string;
}

/** 로그인 전체 흐름: 요청 → 워커(로그인 메일 롤) → 메일의 코드 → 같은 브라우저로 verify. */
export async function login(deps: AdminDependencies, mailer: Pool, organization: { id: string; ownerEmail: string }, ip?: string): Promise<Session> {
  const requested = await call(deps, 'POST', '/api/login', { body: { email: organization.ownerEmail }, ...(ip === undefined ? {} : { ip }) });
  if (requested.statusCode !== 202) throw new Error(`login ${String(requested.statusCode)} ${requested.body}`);
  const nonce = cookieValue(requested, LOGIN_BROWSER_COOKIE);
  if (nonce === undefined) throw new Error('논스 쿠키가 없다');
  const mails = await drainLoginMail(mailer, organization.id);
  const mail = mails.at(-1);
  if (mail === undefined) throw new Error('로그인 메일이 나가지 않았다');
  const verified = await call(deps, 'POST', '/api/login/verify', {
    body: { code: codeFromMail(mail) },
    cookies: { [LOGIN_BROWSER_COOKIE]: nonce },
    ip: ip ?? uniqueCodeIp(),
  });
  if (verified.statusCode !== 200) throw new Error(`verify ${String(verified.statusCode)} ${verified.body}`);
  const token = cookieValue(verified, SESSION_COOKIE);
  if (token === undefined) throw new Error('세션 쿠키가 없다');
  return { cookies: { [SESSION_COOKIE]: token }, csrf: (verified.json() as { csrf: string }).csrf, token };
}

/** 세션 + CSRF 헤더로 부른다. */
export function authed(session: Session, options: RequestOptions = {}): RequestOptions {
  return { ...options, cookies: { ...session.cookies, ...(options.cookies ?? {}) }, headers: { 'x-atmark-csrf': session.csrf, ...(options.headers ?? {}) } };
}
