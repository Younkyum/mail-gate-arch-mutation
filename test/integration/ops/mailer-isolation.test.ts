/**
 * login-mailer **운영 워커의 격리와 호환**(`.omc/plans/ops-console.md` §3.4 · M1 · H10 · 리드 결정 "키 회전 → dead"). 실제 Postgres(`atmark_login_mailer`
 * 롤로), SES 는 기록만 하는 가짜 — **실메일 0**.
 *
 * 되돌리면 빨개져야 하는 것:
 *   - 표 없음(42P01) · 권한 없음(42501) · 비밀 ARN 없음(config) · 자리표시(placeholder) · 키 형식 오류(key_invalid) → 예외 없이 건너뛰고
 *     `atmark.ops.mailer_skipped{reason}` · 도전은 그대로(다이제스트 없음, 메일 0). 그 틱의 소유자 로그인·가입·초대 워커는 돈다.
 *   - 다이제스트를 적은 **뒤에만** 보낸다 · 수신자는 보내는 순간의 운영자 주소 · 메일의 코드로 로그인된다 · 제목에 코드 없음.
 *   - 같은 키로 재시도하면 같은 코드 · 발송 실패 → 활성 키 교체 → 재시도면 `dead` 이고 메일 0통.
 *   - 운영자가 보내기 전에 비활성이 되면 obsolete(메일 0).
 */

import { randomBytes } from 'node:crypto';

import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Queryable } from '../../../src/db/client';
import { createOpsCodeNotifier } from '../../../src/notify/ops-code-notifier';
import * as logger from '../../../src/observability/logger';
import { OPS_METRIC_NAMES } from '../../../src/ops/metrics';
import { RUNTIME_ENV } from '../../../src/runtime/config';
import { runLoginMailer } from '../../../src/runtime/handlers/login-mailer';
import { createOpsNotifierLoader } from '../../../src/runtime/login-mailer-composition';
import { parseHmacKeyring } from '../../../src/security/hmac-keyring';
import { mintLoginCode } from '../../../src/security/login-code';
import { runOpsCodeMailer } from '../../../src/workers/ops-code-mailer';
import { afterDbNow } from '../../support/db-clock';
import { fakeSes, mailText } from '../signup/support';
import {
  addOperator,
  appPool,
  AVAILABLE,
  hex64,
  latestChallenge,
  lockOpsSettings,
  mailerPool,
  opsPool,
  ownerPool,
  releaseOpsSettings,
  tidy,
  type OpsSettingsLock,
} from './db-support';

const ARN = 'arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:atmark/ops-login-keys';
const keyringText = (kid: string): string => `${kid}:${randomBytes(32).toString('base64url')}`;
const PLACEHOLDER = JSON.stringify({ _unset: 'placeholder - filled by deploy runbook' });

describe.skipIf(!AVAILABLE)('login-mailer 운영 워커 — 격리 · 호환(M1)', () => {
  let owner: Pool;
  let ops: Pool;
  let mailer: Pool;
  let lock: OpsSettingsLock | undefined;
  beforeAll(async () => {
    owner = ownerPool(4);
    ops = opsPool();
    mailer = mailerPool();
    lock = await lockOpsSettings(owner);
  });
  beforeEach(async () => {
    await tidy(owner);
    // 이 파일은 DB 의 모든 기한 도전을 돌리므로, 테스트 주소 밖의 발송 전 도전(없어야 한다)이 있으면 멈춘다.
    const foreign = await owner.query(`SELECT 1 FROM ops_login_challenges WHERE status = 'pending' AND email NOT LIKE 'ops-%@example.com'`);
    expect(foreign.rowCount).toBe(0);
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await releaseOpsSettings(lock);
    await Promise.all([ops.end(), mailer.end()]);
    await owner.end();
  });

  const skippedReasons = (spy: ReturnType<typeof vi.spyOn>): unknown[] =>
    spy.mock.calls
      .map((call: unknown[]) => String(call[0]))
      .filter((line: string) => line.includes(`"${OPS_METRIC_NAMES.mailerSkipped}"`))
      .map((line: string) => (JSON.parse(line) as Record<string, unknown>)['reason']);

  async function pendingLogin(): Promise<{ id: string; email: string; operatorId: string; binding: string }> {
    const operator = await addOperator(owner);
    const binding = hex64();
    await ops.query('SELECT ops_request_code($1, $2, $3, $4)', [operator.email, binding, hex64(), 'ko']);
    const challenge = await latestChallenge(owner, { email: operator.email });
    if (challenge === null) throw new Error('no challenge');
    // next_attempt_at 은 DB now()(마이크로초)이고 워커의 `now: () => new Date()` 는 밀리초에서 잘린다 — 같은 밀리초 안에 워커가 돌면
    // 아직 기한 전({} · not_due)이 된다. 빠른 러너(자체 실행기, CI 36883729770)에서 20번 중 12번 났다(기다린 뒤 20/20). JS 시계가 DB 시계를 넘길 때까지 기다린다.
    await afterDbNow(owner);
    return { id: challenge.id, email: operator.email, operatorId: operator.id, binding };
  }

  const state = (id: string) =>
    owner
      .query<{ status: string; has_digest: boolean; attempt_count: number; last_error: string | null }>(
        'SELECT status, code_digest IS NOT NULL AS has_digest, attempt_count, last_error FROM ops_login_challenges WHERE id = $1',
        [id],
      )
      .then((r) => r.rows[0]);

  function loaderFor(env: NodeJS.ProcessEnv, secret: string | Error, client: ReturnType<typeof fakeSes>['client'], now: () => Date = () => new Date()) {
    return createOpsNotifierLoader(
      env,
      { readSecretString: () => (secret instanceof Error ? Promise.reject(secret) : Promise.resolve(secret)) },
      (keyring) => createOpsCodeNotifier({ pool: mailer, client, keyring, now }),
    );
  }

  it('표 없음(42P01) → schema · 권한 없음(42501) → permission — 예외 없이 건너뛰고 메트릭', async () => {
    const spy = vi.spyOn(logger, 'writeLine');
    const missing: Queryable = { query: (text: string, values?: unknown[]) => mailer.query(text.replace('ops_login_challenges', 'ops_login_challenges_absent'), values) } as never;
    const loader = vi.fn();
    expect(await runOpsCodeMailer({ db: missing, loadNotifier: loader, now: () => new Date() })).toEqual({ skipped: 1 });
    const app = appPool();
    try {
      expect(await runOpsCodeMailer({ db: app, loadNotifier: loader, now: () => new Date() })).toEqual({ skipped: 1 });
    } finally {
      await app.end();
    }
    expect(loader).not.toHaveBeenCalled();
    expect(skippedReasons(spy)).toEqual(['schema', 'permission']);
  });

  it('비밀 ARN 없음 · 읽기 실패 → config · 자리표시 → placeholder · 형식 오류 → key_invalid — 도전은 그대로(다이제스트 없음 · 메일 0)', async () => {
    const challenge = await pendingLogin();
    const ses = fakeSes();
    const spy = vi.spyOn(logger, 'writeLine');
    const env = { [RUNTIME_ENV.opsLoginKeysSecretArn]: ARN };
    for (const loader of [
      loaderFor({}, keyringText('o1'), ses.client),
      loaderFor(env, new Error('AccessDenied'), ses.client),
      loaderFor(env, PLACEHOLDER, ses.client),
      loaderFor(env, 'o1:short', ses.client),
    ]) {
      expect(await runOpsCodeMailer({ db: mailer, loadNotifier: loader, now: () => new Date() })).toEqual({ skipped: 1 });
    }
    expect(skippedReasons(spy)).toEqual(['config', 'config', 'placeholder', 'key_invalid']);
    expect(ses.sent).toEqual([]);
    expect(await state(challenge.id)).toEqual({ status: 'pending', has_digest: false, attempt_count: 0, last_error: null });
  });

  it('운영 워커가 건너뛰어도 같은 틱의 소유자 로그인·가입·초대 워커는 돈다(던지지 않는다)', async () => {
    const polled: string[] = [];
    const recorder = (name: string): Queryable =>
      ({
        query: () => {
          polled.push(name);
          return Promise.resolve({ rows: [], rowCount: 0 });
        },
      }) as never;
    const app = appPool();
    try {
      const notifier = { notify: () => Promise.resolve('sent' as const) };
      const counts = await runLoginMailer({
        ops: { db: app, loadNotifier: () => Promise.resolve('config'), now: () => new Date() },
        login: { db: recorder('login'), notifier, now: () => new Date() },
        signup: { db: recorder('signup'), notifier, now: () => new Date() },
        invite: { db: recorder('invite'), notifier, now: () => new Date() },
      });
      expect(counts['ops.skipped']).toBe(1);
      expect(polled).toEqual(['login', 'signup', 'invite']);
    } finally {
      await app.end();
    }
  });

  it('보낸다 — 다이제스트를 적은 뒤에만 · 수신자 = 운영자 주소 · 메일의 코드로 로그인 · 제목에 코드 없음 · 발신 login@', async () => {
    const challenge = await pendingLogin();
    const keys = keyringText('o1');
    const digestAtSend: boolean[] = [];
    const ses = fakeSes();
    const client = {
      send: async (command: Parameters<typeof ses.client.send>[0]) => {
        digestAtSend.push((await state(challenge.id))?.has_digest === true);
        return ses.client.send(command);
      },
    };
    const report = await runOpsCodeMailer({
      db: mailer,
      loadNotifier: loaderFor({ [RUNTIME_ENV.opsLoginKeysSecretArn]: ARN }, keys, client),
      now: () => new Date(),
    });
    expect(report).toEqual({ sent: 1 });
    expect(digestAtSend).toEqual([true]);
    expect(ses.sent).toHaveLength(1);
    expect(ses.sent[0]?.from).toBe('login@atmark.ai');
    expect(ses.sent[0]?.to).toEqual([challenge.email]);
    const expires = (await owner.query<{ expires_at: Date }>('SELECT expires_at FROM ops_login_challenges WHERE id = $1', [challenge.id])).rows[0]?.expires_at ?? new Date();
    const code = mintLoginCode(parseHmacKeyring(keys, 'test'), 'ops_login', { linkId: challenge.id, expiresAt: expires });
    const mail = ses.sent[0];
    expect(mail === undefined ? '' : mailText(mail)).toContain(code);
    expect(/^Subject:.*$/m.exec(mail?.raw ?? '')?.[0] ?? '').not.toContain(code);
    expect(await state(challenge.id)).toMatchObject({ status: 'sent', has_digest: true });
    const verified = await ops.query<{ outcome: string }>('SELECT outcome FROM ops_login_verify($1, $2, $3, $4, $5)', [challenge.binding, hex64(), code, hex64(), hex64()]);
    expect(verified.rows[0]?.outcome).toBe('session');
  });

  it('같은 키로 재시도하면 같은 코드 · 발송 실패 → 활성 키 교체 → 재시도는 dead(메일 0, 예외 없음)', async () => {
    const env = { [RUNTIME_ENV.opsLoginKeysSecretArn]: ARN };
    const failing = { send: () => Promise.reject(new Error('ses down')) };
    const later = (): Date => new Date(Date.now() + 20_000);

    const retried = await pendingLogin();
    const keys = keyringText('o1');
    expect(await runOpsCodeMailer({ db: mailer, loadNotifier: loaderFor(env, keys, failing as never), now: () => new Date() })).toEqual({ retry: 1 });
    expect(await state(retried.id)).toMatchObject({ status: 'pending', has_digest: true, attempt_count: 1, last_error: 'send_failed' });
    const ses = fakeSes();
    expect(await runOpsCodeMailer({ db: mailer, loadNotifier: loaderFor(env, keys, ses.client, later), now: later })).toEqual({ sent: 1 });
    const expires = (await owner.query<{ expires_at: Date }>('SELECT expires_at FROM ops_login_challenges WHERE id = $1', [retried.id])).rows[0]?.expires_at ?? new Date();
    const mail = ses.sent[0];
    expect(mail === undefined ? '' : mailText(mail)).toContain(mintLoginCode(parseHmacKeyring(keys, 'test'), 'ops_login', { linkId: retried.id, expiresAt: expires }));

    const rotated = await pendingLogin();
    expect(await runOpsCodeMailer({ db: mailer, loadNotifier: loaderFor(env, keys, failing as never), now: () => new Date() })).toEqual({ retry: 1 });
    const after = fakeSes();
    expect(await runOpsCodeMailer({ db: mailer, loadNotifier: loaderFor(env, `${keyringText('o2')},${keys}`, after.client, later), now: later })).toEqual({ dead: 1 });
    expect(after.sent).toEqual([]);
    expect(await state(rotated.id)).toMatchObject({ status: 'dead', has_digest: false, last_error: 'key_rotated' });
  });

  it('운영자가 보내기 전에 비활성이 되면 obsolete — 메일 0', async () => {
    const challenge = await pendingLogin();
    await owner.query(`UPDATE ops_operators SET status = 'revoked' WHERE id = $1`, [challenge.operatorId]);
    const ses = fakeSes();
    expect(await runOpsCodeMailer({ db: mailer, loadNotifier: loaderFor({ [RUNTIME_ENV.opsLoginKeysSecretArn]: ARN }, keyringText('o1'), ses.client), now: () => new Date() })).toEqual({
      obsolete: 1,
    });
    expect(ses.sent).toEqual([]);
    expect(await state(challenge.id)).toMatchObject({ status: 'obsolete', has_digest: false, last_error: 'operator_inactive' });
  });
});
