/**
 * `src/runtime/login-mailer-composition.ts` — **로그인 메일 Lambda 의 조립**(ADR-0006). AWS 호출 0(가짜 비밀·SES). 풀은 만들기만.
 *
 *   - ★ 운영이 아니면 비밀을 한 번도 읽지 않고 던진다 · 필수 변수가 하나라도 없으면 그 이름을 대며 던진다.
 *   - ★ 읽는 비밀은 **둘뿐** — 로그인 키 · 자기 DB 비밀. 앱·소유자·admin DB 비밀과 승인·웹훅 키는 읽지도 요구하지도 않는다.
 *   - 풀: TLS(`rejectUnauthorized: true`) · max 1(연결 예산 — compute-stack 테스트와 같은 상수).
 *   - placeholder 키링은 거부 · Configuration Set 은 대조값.
 *   - 핸들러는 워커 둘(`runOwnerLoginNotifier` · `runSignupMailer` — 셀프 가입)을 부르고, 한쪽이 던져도 다른 쪽은 돈다.
 *   - 입력: 틱 `{"source":"atmark.schedule"}` · 깨우기 `{"source":"atmark.kick"}`(admin 이 커밋 뒤) · 빈 객체만 받는다 — 셋 다 같은 일. 그 밖은 조립 전에 던진다.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { LOGIN_MAILER_EVENT_SOURCE, RUNTIME_ENV, RuntimeConfigError } from '../../../src/runtime/config';
import { composeLoginMailer, LOGIN_MAILER_POOL_MAX, type ComposedLoginMailer } from '../../../src/runtime/login-mailer-composition';
import { classifyLoginMailerInput, createLoginMailerHandler, runLoginMailer } from '../../../src/runtime/handlers/login-mailer';

const LOGIN_SECRET = 'arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:atmark/owner-login-keys';
const MAILER_DB_SECRET = 'arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:atmark/db/login-mailer';
const PLACEHOLDER = JSON.stringify({ _unset: 'placeholder' });

const CA_DIR = mkdtempSync(join(tmpdir(), 'atmark-ca-'));
const CA_FILE = join(CA_DIR, 'ca-cert.pem');
writeFileSync(CA_FILE, '-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----\n');

const SECRETS: Readonly<Record<string, string>> = {
  [LOGIN_SECRET]: `l1:${randomBytes(32).toString('base64url')}`,
  [MAILER_DB_SECRET]: JSON.stringify({ host: 'db.internal', port: 5432, dbname: 'atmark', username: 'atmark_login_mailer', password: 'p@ss/hunter2' }),
};

/** 운영 login-mailer 함수의 환경(`compute-stack.ts` `loginMailerEnv` + 런타임이 주는 AWS_REGION). */
function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const base: Record<string, string | undefined> = {
    [RUNTIME_ENV.environment]: 'production',
    [RUNTIME_ENV.region]: 'ap-northeast-2',
    [RUNTIME_ENV.dbLoginMailerSecretArn]: MAILER_DB_SECRET,
    [RUNTIME_ENV.ownerLoginKeysSecretArn]: LOGIN_SECRET,
    [RUNTIME_ENV.sesConfigurationSet]: 'atmark-default',
    [RUNTIME_ENV.extraCaCerts]: CA_FILE,
    ...overrides,
  };
  return Object.fromEntries(Object.entries(base).filter(([, value]) => value !== undefined));
}

function clients(secrets: Readonly<Record<string, string>> = SECRETS) {
  const reads: string[] = [];
  return {
    reads,
    secrets: {
      readSecretString(id: string): Promise<string> {
        reads.push(id);
        const value = secrets[id];
        return value === undefined ? Promise.reject(new Error(`no secret ${id}`)) : Promise.resolve(value);
      },
    },
    ses: {
      send: (): never => {
        throw new Error('AWS 호출 금지 — 조립은 SES 를 부르지 않는다');
      },
    },
  };
}

const opened: ComposedLoginMailer[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((composed) => composed.pool.end()));
});

describe('login-mailer 조립 — fail-closed · 비밀 둘뿐 · 풀 1', () => {
  it('운영이 아니면 비밀을 한 번도 읽지 않고 던진다', async () => {
    const fake = clients();
    await expect(composeLoginMailer({ env: env({ [RUNTIME_ENV.environment]: undefined }), clients: fake })).rejects.toThrow(RuntimeConfigError);
    expect(fake.reads).toEqual([]);
  });

  it.each([
    RUNTIME_ENV.region,
    RUNTIME_ENV.dbLoginMailerSecretArn,
    RUNTIME_ENV.ownerLoginKeysSecretArn,
    RUNTIME_ENV.sesConfigurationSet,
    RUNTIME_ENV.extraCaCerts,
  ])('%s 가 없으면 던지고 메시지가 그 이름을 댄다', async (variable) => {
    await expect(composeLoginMailer({ env: env({ [variable]: undefined }), clients: clients() })).rejects.toThrow(variable);
  });

  it('★ 읽는 비밀은 로그인 키 · 자기 DB 비밀 둘뿐 — 앱·소유자·admin DB 비밀은 환경에 있어도 읽지 않는다', async () => {
    const fake = clients();
    const composed = await composeLoginMailer({
      env: env({
        [RUNTIME_ENV.dbSecretArn]: 'arn:app',
        [RUNTIME_ENV.dbMigrationSecretArn]: 'arn:owner',
        [RUNTIME_ENV.dbAdminSecretArn]: 'arn:admin',
      }),
      clients: fake,
    });
    opened.push(composed);
    expect([...fake.reads].sort()).toEqual([LOGIN_SECRET, MAILER_DB_SECRET].sort());
    const options = (composed.pool as unknown as { options: Record<string, unknown> }).options;
    expect(options['ssl']).toEqual({ rejectUnauthorized: true });
    expect(options['max']).toBe(LOGIN_MAILER_POOL_MAX);
    expect(LOGIN_MAILER_POOL_MAX).toBe(1);
    expect(composed.pool.totalCount).toBe(0);
    expect(composed.deps.login.notifier).toBeDefined();
    // 가입 메일도 같은 풀·같은 조립(발송 주체를 늘리지 않는다 — 계약 §0).
    expect(composed.deps.signup.notifier).toBeDefined();
    expect(composed.deps.signup.db).toBe(composed.deps.login.db);
    // 조직 초대 메일도(202609250120).
    expect(composed.deps.invite.notifier).toBeDefined();
    expect(composed.deps.invite.db).toBe(composed.deps.login.db);
  });

  it('환영 메일(202609301510)은 기능 플래그가 켜졌을 때만 조립된다 — 기본 끔 · 같은 풀 · 비밀을 더 읽지 않는다 · 오타는 기동 거부', async () => {
    expect(RUNTIME_ENV.welcomeMailEnabled).toBe('ATMARK_WELCOME_MAIL_ENABLED');
    const off = await composeLoginMailer({ env: env(), clients: clients() });
    opened.push(off);
    expect(off.deps.welcome).toBeNull();
    const explicitOff = await composeLoginMailer({ env: env({ [RUNTIME_ENV.welcomeMailEnabled]: 'false' }), clients: clients() });
    opened.push(explicitOff);
    expect(explicitOff.deps.welcome).toBeNull();
    const fake = clients();
    const on = await composeLoginMailer({ env: env({ [RUNTIME_ENV.welcomeMailEnabled]: 'true' }), clients: fake });
    opened.push(on);
    expect(on.deps.welcome?.notifier).toBeDefined();
    expect(on.deps.welcome?.db).toBe(on.deps.login.db);
    expect([...fake.reads].sort()).toEqual([LOGIN_SECRET, MAILER_DB_SECRET].sort());
    await expect(composeLoginMailer({ env: env({ [RUNTIME_ENV.welcomeMailEnabled]: 'TRUE' }), clients: clients() })).rejects.toThrow(
      RUNTIME_ENV.welcomeMailEnabled,
    );
  });

  it('핸들러: 환영 단계는 welcome 이 있을 때만 돈다(welcome.* 결말) · 없으면(null·생략) 돌지 않는다', async () => {
    const db = { query: () => Promise.resolve({ rows: [], rowCount: 0 }) };
    const notifier = { notify: () => Promise.resolve('sent' as const) };
    const base = {
      ops: { db: db as never, loadNotifier: () => Promise.resolve('config' as const), now: () => new Date() },
      login: { db: db as never, notifier, now: () => new Date() },
      signup: { db: db as never, notifier, now: () => new Date() },
      invite: { db: db as never, notifier, now: () => new Date() },
    };
    let welcomePolled = 0;
    const welcomeDb = {
      query: () => {
        welcomePolled += 1;
        return Promise.resolve({ rows: [], rowCount: 0 });
      },
    };
    const on = await runLoginMailer({
      ...base,
      welcome: { db: welcomeDb as never, notifier: { send: () => Promise.resolve('sent' as const) }, now: () => new Date() },
    });
    expect(welcomePolled).toBe(1);
    expect(Object.keys(on).filter((key) => key.startsWith('welcome.')).sort()).toEqual(
      ['welcome.dead', 'welcome.deferred', 'welcome.not_due', 'welcome.obsolete', 'welcome.retry', 'welcome.sent', 'welcome.undeliverable'],
    );
    const off = await runLoginMailer({ ...base, welcome: null });
    expect(Object.keys(off).some((key) => key.startsWith('welcome.'))).toBe(false);
    expect(Object.keys(await runLoginMailer(base)).some((key) => key.startsWith('welcome.'))).toBe(false);
    expect(welcomePolled).toBe(1);
  });

  it('로그인 키가 placeholder 면 던진다 · DB 비밀이 placeholder 면 bootstrap-roles 를 먼저 하라고 던진다', async () => {
    await expect(composeLoginMailer({ env: env(), clients: clients({ ...SECRETS, [LOGIN_SECRET]: PLACEHOLDER }) })).rejects.toThrow(/placeholder/);
    await expect(composeLoginMailer({ env: env(), clients: clients({ ...SECRETS, [MAILER_DB_SECRET]: PLACEHOLDER }) })).rejects.toThrow(
      /bootstrap-roles/,
    );
  });

  it('Configuration Set 은 설정이 아니라 대조다 — 다르면 던진다', async () => {
    await expect(
      composeLoginMailer({ env: env({ [RUNTIME_ENV.sesConfigurationSet]: 'other-set' }), clients: clients() }),
    ).rejects.toThrow(RUNTIME_ENV.sesConfigurationSet);
  });

  it('핸들러는 로그인·가입·초대 워커를 돌리고 결말 개수만 보고한다(식별자·주소 없음)', async () => {
    const db = { query: () => Promise.resolve({ rows: [], rowCount: 0 }) };
    const handler = createLoginMailerHandler(() =>
      Promise.resolve({
        deps: {
          ops: { db: db as never, loadNotifier: () => Promise.reject(new Error('보낼 것이 없으면 키링을 읽지 않는다')), now: () => new Date() },
          login: { db: db as never, notifier: { notify: () => Promise.resolve('sent' as const) }, now: () => new Date() },
          signup: { db: db as never, notifier: { notify: () => Promise.resolve('sent' as const) }, now: () => new Date() },
          invite: { db: db as never, notifier: { notify: () => Promise.resolve('sent' as const) }, now: () => new Date() },
        },
      }),
    );
    const report = await handler({}, { awsRequestId: 'r', invokedFunctionArn: 'arn', callbackWaitsForEmptyEventLoop: true });
    expect(report.routeId).toBe('owner_login_notify');
    expect(Object.keys(report.counts).some((key) => key.startsWith('login.'))).toBe(true);
    expect(Object.keys(report.counts).some((key) => key.startsWith('signup.'))).toBe(true);
    expect(Object.keys(report.counts).some((key) => key.startsWith('invite.'))).toBe(true);
    expect(Object.values(report.counts).every((count) => count === 0)).toBe(true);
  });

  it('한 outbox 가 던져도 다른 outbox 는 돈다 — 오류는 둘 다 돈 뒤에 다시 던진다', async () => {
    const failing = { query: () => Promise.reject(new Error('db down')) };
    let signupPolled = false;
    let invitePolled = false;
    const polled = {
      query: () => {
        signupPolled = true;
        return Promise.resolve({ rows: [], rowCount: 0 });
      },
    };
    const invitePoll = {
      query: () => {
        invitePolled = true;
        return Promise.resolve({ rows: [], rowCount: 0 });
      },
    };
    const notifier = { notify: () => Promise.resolve('sent' as const) };
    await expect(
      runLoginMailer({
        ops: { db: failing as never, loadNotifier: () => Promise.resolve('config' as const), now: () => new Date() },
        login: { db: failing as never, notifier, now: () => new Date() },
        signup: { db: polled as never, notifier, now: () => new Date() },
        invite: { db: invitePoll as never, notifier, now: () => new Date() },
      }),
    ).rejects.toThrow('db down');
    expect(signupPolled).toBe(true);
    expect(invitePolled).toBe(true);
  });

  it('입력: 틱 · 깨우기 · 빈 객체만 — 셋 다 같은 일(outbox 비우기)을 한다', async () => {
    expect(classifyLoginMailerInput({ source: LOGIN_MAILER_EVENT_SOURCE.tick })).toBe('tick');
    expect(classifyLoginMailerInput({ source: LOGIN_MAILER_EVENT_SOURCE.kick })).toBe('kick');
    expect(classifyLoginMailerInput({})).toBe('tick');
    expect(LOGIN_MAILER_EVENT_SOURCE).toEqual({ tick: 'atmark.schedule', kick: 'atmark.kick' });
    const db = { query: () => Promise.resolve({ rows: [], rowCount: 0 }) };
    const notifier = { notify: () => Promise.resolve('sent' as const) };
    const handler = createLoginMailerHandler(() =>
      Promise.resolve({
        deps: {
          ops: { db: db as never, loadNotifier: () => Promise.resolve('config' as const), now: () => new Date() },
          login: { db: db as never, notifier, now: () => new Date() },
          signup: { db: db as never, notifier, now: () => new Date() },
          invite: { db: db as never, notifier, now: () => new Date() },
        },
      }),
    );
    const context = { awsRequestId: 'r', invokedFunctionArn: 'arn', callbackWaitsForEmptyEventLoop: true };
    const tick = await handler({ source: 'atmark.schedule' }, context);
    const kick = await handler({ source: 'atmark.kick' }, context);
    expect(kick).toEqual(tick);
  });

  it('★ 모르는 입력은 조립 전에 던진다(조용히 무시하지 않는다)', async () => {
    let composed = 0;
    const handler = createLoginMailerHandler(() => {
      composed += 1;
      return Promise.reject(new Error('조립되면 안 된다'));
    });
    const context = { awsRequestId: 'r', invokedFunctionArn: 'arn', callbackWaitsForEmptyEventLoop: true };
    for (const event of [
      null,
      undefined,
      'atmark.kick',
      [],
      { source: 'atmark.other' },
      { source: 'atmark.kick', email: 'someone@example.com' },
      { action: 'reconcile' },
      { 'detail-type': 'Scheduled Event', source: 'aws.events' },
    ]) {
      expect(() => classifyLoginMailerInput(event), JSON.stringify(event)).toThrow(TypeError);
      await expect(handler(event, context), JSON.stringify(event)).rejects.toThrow(TypeError);
    }
    expect(composed).toBe(0);
  });
});
