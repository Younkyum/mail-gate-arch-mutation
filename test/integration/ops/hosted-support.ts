/**
 * 호스팅 ops 통합 테스트 도우미(W-APP) — 진짜 로컬 DB(`atmark_v2`, 0500·0510 적용)에 **`atmark_ops` 로 로그인한 풀**로 라우터를 돈다.
 *
 * - **직렬화**: `ops_settings`(콘솔 열림)는 DB 전체 한 행이라, ops 통합 파일은 소유자 연결의 세션 advisory lock(`OPS_TEST_LOCK`)을 쥐고 돈다
 *   (W-DB 의 ops 통합 테스트와 같은 키).
 * - **메일 없음**: 코드 메일은 보내지 않는다. login-mailer 대신 소유자 롤이 도전에 다이제스트를 적고(`ops_mailer_set_digest` — 같은 함수)
 *   `sent` 로 표시한다. 코드는 테스트가 고른다.
 * - 테스트 주소는 `ops-it-<난수>@example.com`, 요청자 IP 는 파일마다 난수(요청자 상한이 파일끼리 섞이지 않게).
 */

import { randomBytes } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { createPool } from '../../../src/db/client';
import { OPS_COOKIES, OPS_CSRF_HEADER, OPS_DOMAIN_NAME, OPS_ORIGIN } from '../../../src/ops/contract';
import { handleOpsRequest, type HostedDeps } from '../../../src/ops/hosted/app';
import type { OpsHttpEvent, OpsHttpResult } from '../../../src/ops/hosted/http';
import { createOpsKeys } from '../../../src/ops/hosted/keys';
import { parseHmacKeyring } from '../../../src/security/hmac-keyring';
import { neutralizeRejectHistory } from './db-support';

export const OWNER_URL = process.env['TEST_MIGRATION_DATABASE_URL'] ?? '';
export const APP_URL = process.env['TEST_DATABASE_URL'] ?? '';

/** `atmark_ops` 접속 — `TEST_OPS_DATABASE_URL` 이 없으면 앱 URL 의 사용자만 바꾼다(로컬 trust). */
export function opsUrl(): string {
  const explicit = process.env['TEST_OPS_DATABASE_URL'];
  if (explicit !== undefined && explicit.trim() !== '') return explicit;
  if (APP_URL.trim() === '') return '';
  const url = new URL(APP_URL);
  url.username = 'atmark_ops';
  url.password = '';
  return url.toString();
}

/** ops 통합 파일 직렬화 키(W-DB 와 공유). */
export const OPS_TEST_LOCK = 'atmark.test.ops-settings';

export const suffix = (): string => randomBytes(4).toString('hex');
export const testEmail = (): string => `ops-it-${suffix()}@example.com`;

export interface OpsHarness {
  readonly owner: Pool;
  readonly ops: Pool;
  readonly deps: HostedDeps;
  readonly kicks: { n: number };
  close(): Promise<void>;
}

let lockClient: PoolClient | null = null;
let savedSettings: { console_enabled: boolean; hard_locked: boolean } | null = null;

export async function openHarness(options: { readonly opsPoolOptions?: Record<string, unknown> } = {}): Promise<OpsHarness> {
  const owner = createPool(OWNER_URL, { max: 4 });
  const ops = createPool(opsUrl(), { max: 1, ...(options.opsPoolOptions ?? {}) });
  const kicks = { n: 0 };
  const keys = createOpsKeys(parseHmacKeyring(`o1:${randomBytes(32).toString('base64url')}`, 'test'));
  return {
    owner,
    ops,
    kicks,
    deps: {
      pool: ops,
      keys,
      kickMailer: async () => {
        kicks.n += 1;
      },
      now: () => new Date(),
    },
    async close() {
      await ops.end().catch(() => undefined);
      await owner.end().catch(() => undefined);
    },
  };
}

/** 직렬화 잠금 + 콘솔 열기(이전 값은 `releaseOps` 가 되돌린다). 조용한 상한이 테스트 주소를 막지 않게 지난 테스트 흔적을 치운다. */
export async function lockOps(owner: Pool): Promise<void> {
  lockClient = await owner.connect();
  await lockClient.query('SELECT pg_advisory_lock(hashtext($1))', [OPS_TEST_LOCK]);
  const row = await lockClient.query<{ console_enabled: boolean; hard_locked: boolean }>('SELECT console_enabled, hard_locked FROM ops_settings');
  savedSettings = row.rows[0] ?? null;
  await lockClient.query('UPDATE ops_settings SET console_enabled = true, hard_locked = false');
  // 접근 요청 전역 시간당 5 · 대기 5 — 지난 실행의 테스트 흔적만 치운다(소유자 롤).
  await lockClient.query(`DELETE FROM ops_login_challenges WHERE email LIKE 'ops-it-%@example.com'`);
  await lockClient.query(`UPDATE ops_operators SET status = 'expired' WHERE status = 'requested' AND email LIKE 'ops-it-%@example.com'`);
}

export async function releaseOps(): Promise<void> {
  if (lockClient === null) return;
  if (savedSettings !== null) {
    await lockClient.query('UPDATE ops_settings SET console_enabled = $1, hard_locked = $2', [savedSettings.console_enabled, savedSettings.hard_locked]).catch(() => undefined);
  }
  await lockClient.query('SELECT pg_advisory_unlock(hashtext($1))', [OPS_TEST_LOCK]).catch(() => undefined);
  lockClient.release();
  lockClient = null;
}

export async function setConsole(owner: Pool, enabled: boolean): Promise<void> {
  await owner.query('UPDATE ops_settings SET console_enabled = $1', [enabled]);
}

/** CLI 가 하는 것처럼 소유자 롤로 활성 운영자를 더한다(`origin = 'cli'`). */
export async function addCliOperator(owner: Pool, email: string = testEmail()): Promise<{ id: string; email: string }> {
  const row = await owner.query<{ id: string }>(`INSERT INTO ops_operators (email, status, origin) VALUES ($1, 'active', 'cli') RETURNING id`, [email]);
  return { id: (row.rows[0] as { id: string }).id, email };
}

/** login-mailer 대신 — 가장 최근 발송 전 도전에 다이제스트를 적고 `sent` 로. 코드는 호출자가 고른다. */
export async function deliverCode(owner: Pool, where: { readonly email?: string; readonly purpose?: string; readonly operatorId?: string }, code: string): Promise<string> {
  const row = await owner.query<{ id: string }>(
    `SELECT id FROM ops_login_challenges
      WHERE status = 'pending' AND ($1::text IS NULL OR email = $1) AND ($2::text IS NULL OR purpose = $2) AND ($3::uuid IS NULL OR operator_id = $3)
      ORDER BY created_at DESC LIMIT 1`,
    [where.email ?? null, where.purpose ?? null, where.operatorId ?? null],
  );
  const id = row.rows[0]?.id;
  if (id === undefined) throw new Error(`도전이 없다: ${JSON.stringify(where)}`);
  const set = await owner.query<{ r: string }>('SELECT ops_mailer_set_digest($1, ops_code_digest($1, $2)) AS r', [id, code]);
  if (set.rows[0]?.r !== 'ok') throw new Error('digest not ok');
  await owner.query(`UPDATE ops_login_challenges SET status = 'sent', sent_at = now(), settled_at = now() WHERE id = $1`, [id]);
  return id;
}

export const randomIp = (): string => `10.${String(randomBytes(1)[0])}.${String(randomBytes(1)[0])}.${String(randomBytes(1)[0])}`;

/** 쿠키를 들고 다니는 브라우저 한 대. 요청자 상한이 테스트끼리 섞이지 않게 IP 는 브라우저마다 난수. */
export class Browser {
  readonly jar = new Map<string, string>();
  csrf = '';

  constructor(
    private readonly harness: OpsHarness,
    private readonly userAgent = 'Mozilla/5.0 ops-it',
    readonly ip: string = randomIp(),
  ) {}

  async call(method: 'GET' | 'POST', path: string, body?: unknown, extra: { readonly csrf?: string | null; readonly origin?: string; readonly query?: string } = {}): Promise<{ status: number; json: Record<string, unknown>; raw: OpsHttpResult }> {
    const headers: Record<string, string> = { host: OPS_DOMAIN_NAME, 'user-agent': this.userAgent, 'sec-fetch-site': 'same-origin' };
    if (method === 'POST') {
      headers['origin'] = extra.origin ?? OPS_ORIGIN;
      headers['content-type'] = 'application/json';
      const csrf = extra.csrf === undefined ? this.csrf : extra.csrf;
      if (csrf !== null && csrf !== '') headers[OPS_CSRF_HEADER] = csrf;
    }
    const event: OpsHttpEvent = {
      rawPath: path,
      ...(extra.query === undefined ? {} : { rawQueryString: extra.query }),
      headers,
      cookies: [...this.jar].map(([k, v]) => `${k}=${v}`),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      requestContext: { requestId: `it-${suffix()}`, domainName: OPS_DOMAIN_NAME, http: { method, sourceIp: this.ip, userAgent: this.userAgent } },
    };
    const raw = await handleOpsRequest(this.harness.deps, event);
    for (const cookie of raw.cookies ?? []) {
      const [pair = ''] = cookie.split(';');
      const index = pair.indexOf('=');
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      if (/Max-Age=0/.test(cookie) || value === '') this.jar.delete(name);
      else this.jar.set(name, value);
    }
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(raw.body) as Record<string, unknown>;
    } catch {
      json = {};
    }
    return { status: raw.statusCode, json, raw };
  }

  /** 이메일 → 코드 → 세션(로그인이면 CSRF 까지). */
  async login(email: string, owner: Pool, code = '246810'): Promise<Record<string, unknown>> {
    const requested = await this.call('POST', '/api/auth/request', { email });
    if (requested.status !== 202) throw new Error(`request ${String(requested.status)} ${JSON.stringify(requested.json)}`);
    await deliverCode(owner, { email }, code);
    const verified = await this.call('POST', '/api/auth/verify', { code });
    if (verified.status !== 200) throw new Error(`verify ${String(verified.status)} ${JSON.stringify(verified.json)}`);
    if (typeof verified.json['csrf'] === 'string') this.csrf = verified.json['csrf'];
    return verified.json;
  }

  get hasSession(): boolean {
    return this.jar.has(OPS_COOKIES.session);
  }

  /** step-up 요청 → 코드 배달 → 검증. 대상 참조를 돌려준다. */
  async stepUp(owner: Pool, operatorId: string, action: string, target: { readonly org?: string; readonly operator?: string }, code = '135790'): Promise<{ requested: string; verified: string }> {
    const requested = await this.call('POST', '/api/auth/step-up', { action, ...target });
    if (requested.status !== 200) throw new Error(`step-up ${String(requested.status)} ${JSON.stringify(requested.json)}`);
    await deliverCode(owner, { purpose: 'step_up', operatorId }, code);
    const verified = await this.call('POST', '/api/auth/step-up/verify', { code });
    if (verified.status !== 200) throw new Error(`step-up verify ${String(verified.status)} ${JSON.stringify(verified.json)}`);
    return { requested: String(requested.json['targetRef']), verified: String(verified.json['targetRef']) };
  }
}

/** 가입 조직(pending_review, 에이전트 없음). */
export async function pendingOrg(owner: Pool, name = `검토 ${suffix()}`): Promise<{ id: string; name: string }> {
  const row = await owner.query<{ id: string }>(
    `INSERT INTO organizations (name, owner_email, review_status, signup_source) VALUES ($1, $2, 'pending_review', 'self_signup') RETURNING id`,
    [name, `owner-${suffix()}@example.com`],
  );
  return { id: (row.rows[0] as { id: string }).id, name };
}

/** 한 연결(바깥 트랜잭션 안) 위의 풀 흉내 — 백엔드의 BEGIN/COMMIT/ROLLBACK 을 SAVEPOINT 로 바꾼다(바깥이 끝나면 전부 롤백). */
function savepointPool(client: PoolClient): Pool {
  const map = (text: string): string => {
    const t = text.trim();
    if (t === 'BEGIN') return 'SAVEPOINT ops_it_write';
    if (t === 'COMMIT') return 'RELEASE SAVEPOINT ops_it_write';
    if (t === 'ROLLBACK') return 'ROLLBACK TO SAVEPOINT ops_it_write';
    return text;
  };
  const query = (text: string, values?: unknown[]) => client.query(map(text), values);
  return { query, connect: async () => ({ query, release: () => undefined }), on: () => undefined } as unknown as Pool;
}

/**
 * **롤백되는** 한 트랜잭션에서 `atmark_ops`(session_user)로 라우터를 돈다 — 전역 상한(거절 하루 10)을 소모하는 행위를 결정적으로 시험한다(CR-M2).
 * 트랜잭션 안에서만 오늘 커밋된 거절 티켓을 되감아(W-DB `neutralizeRejectHistory`, 가드를 끈 채) 상한을 비운다 — 밖에서는 아무것도 바뀌지 않는다.
 * `run` 이 받는 `harness` 의 풀은 이 트랜잭션 하나다. 세션 · step-up 허가는 밖에서 커밋한 것이 그대로 보인다.
 */
export async function inRolledBackOps<T>(h: OpsHarness, run: (harness: OpsHarness, client: PoolClient) => Promise<T>): Promise<T> {
  const client = await h.owner.connect();
  try {
    await client.query('BEGIN');
    await neutralizeRejectHistory(client);
    await client.query('SET LOCAL SESSION AUTHORIZATION atmark_ops');
    return await run({ ...h, deps: { ...h.deps, pool: savepointPool(client) } }, client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}
