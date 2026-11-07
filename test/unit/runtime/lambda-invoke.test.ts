/**
 * `src/runtime/lambda-invoke.ts` — admin λ 의 login-mailer **깨우기**. AWS 호출 0(가짜 클라이언트).
 *
 *   - ★ 비동기 호출(`InvocationType: 'Event'`) · 대상 = 조립이 준 함수 ARN · 입력 = 고정값 `{"source":"atmark.kick"}` 하나(사용자 데이터 없음).
 *   - ★ 던지지 않는다 — SDK 오류·시간 초과·202 가 아닌 상태 모두 삼키고 로그 한 줄(결말·오류 종류만).
 *   - ★ 시간 상한 — 클라이언트가 끝나지 않아도 상한에서 풀려난다(응답 시간에 얹히는 몫이 묶인다).
 *   - admin 조립: `ATMARK_LOGIN_MAILER_FUNCTION_ARN` 이 없거나 login-mailer 가 아니면 기동 거부 · 있으면 `deps.kickLoginMailer` 가 그 ARN 을 부른다.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import type { InvokeCommand } from '@aws-sdk/client-lambda';
import { afterEach, describe, expect, it } from 'vitest';

import { resetLogSink, setLogSink } from '../../../src/observability/logger';
import { composeAdmin, type ComposedAdmin } from '../../../src/runtime/admin-composition';
import { LOGIN_MAILER_EVENT_SOURCE, RUNTIME_ENV, RuntimeConfigError } from '../../../src/runtime/config';
import { createLoginMailerKicker, LOGIN_MAILER_KICK_PAYLOAD, type LambdaInvokeClient } from '../../../src/runtime/lambda-invoke';

const MAILER_ARN = 'arn:aws:lambda:ap-northeast-2:123456789012:function:atmark-login-mailer';

interface Sent {
  readonly input: InvokeCommand['input'];
  readonly signal: AbortSignal | undefined;
}

function fakeClient(respond: () => Promise<{ StatusCode?: number }>): { client: LambdaInvokeClient; sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    client: {
      send(command, options) {
        sent.push({ input: command.input, signal: options?.abortSignal });
        return respond();
      },
    },
  };
}

function captureLogs(): string[] {
  const lines: string[] = [];
  setLogSink((line) => lines.push(line));
  return lines;
}

afterEach(() => resetLogSink());

describe('login-mailer 깨우기', () => {
  it('★ Event 호출 · 대상 ARN · 입력은 고정값 {"source":"atmark.kick"} 하나 · abort 신호를 넘긴다 · 202 면 로그 없음', async () => {
    const lines = captureLogs();
    const fake = fakeClient(() => Promise.resolve({ StatusCode: 202 }));
    await createLoginMailerKicker({ client: fake.client, functionArn: MAILER_ARN })();
    expect(fake.sent).toHaveLength(1);
    const [sent] = fake.sent;
    expect(sent?.input.FunctionName).toBe(MAILER_ARN);
    expect(sent?.input.InvocationType).toBe('Event');
    const payload = JSON.parse(new TextDecoder().decode(sent?.input.Payload as Uint8Array)) as unknown;
    expect(payload).toEqual({ source: LOGIN_MAILER_EVENT_SOURCE.kick });
    expect(LOGIN_MAILER_KICK_PAYLOAD).toBe('{"source":"atmark.kick"}');
    expect(Object.keys(sent?.input ?? {}).sort()).toEqual(['FunctionName', 'InvocationType', 'Payload']);
    expect(sent?.signal).toBeInstanceOf(AbortSignal);
    expect(lines.filter((line) => line.includes('login_mailer_kick'))).toEqual([]);
  });

  it('★ SDK 가 던져도 던지지 않는다 — 로그 한 줄(failed · 오류 종류 · 메시지 없음)', async () => {
    const lines = captureLogs();
    const error = Object.assign(new Error('AccessDeniedException: user arn:aws:iam::123:role/x'), { name: 'AccessDeniedException' });
    const fake = fakeClient(() => Promise.reject(error));
    await expect(createLoginMailerKicker({ client: fake.client, functionArn: MAILER_ARN })()).resolves.toBeUndefined();
    const logged = lines.filter((line) => line.includes('"runtime.login_mailer_kick"'));
    expect(logged).toHaveLength(1);
    const record = JSON.parse(logged[0] ?? '{}') as Record<string, unknown>;
    expect(record['outcome']).toBe('failed');
    expect(record['error_kind']).toBe('AccessDeniedException');
    expect(logged[0]).not.toContain('role/x');
  });

  it('★ 시간 상한 — 클라이언트가 끝나지 않아도 상한에서 풀려나고 abort 를 건다', async () => {
    const lines = captureLogs();
    const fake = fakeClient(() => new Promise(() => undefined));
    const started = Date.now();
    await createLoginMailerKicker({ client: fake.client, functionArn: MAILER_ARN, timeoutMs: 30 })();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(fake.sent[0]?.signal?.aborted).toBe(true);
    const logged = lines.filter((line) => line.includes('"runtime.login_mailer_kick"'));
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0] ?? '{}')).toMatchObject({ outcome: 'failed', error_kind: 'TimeoutError' });
  });

  it('202 가 아닌 상태는 unexpected_status 로 남기고 던지지 않는다', async () => {
    const lines = captureLogs();
    const fake = fakeClient(() => Promise.resolve({ StatusCode: 200 }));
    await createLoginMailerKicker({ client: fake.client, functionArn: MAILER_ARN })();
    const logged = lines.filter((line) => line.includes('"runtime.login_mailer_kick"'));
    expect(JSON.parse(logged[0] ?? '{}')).toMatchObject({ outcome: 'unexpected_status', http_status: 200 });
  });
});

// ---------------------------------------------------------------------------
// admin 조립 — 함수 ARN 은 필수 · 모양 확인 · deps.kickLoginMailer
// ---------------------------------------------------------------------------

const CA_DIR = mkdtempSync(join(tmpdir(), 'atmark-ca-'));
const CA_FILE = join(CA_DIR, 'ca-cert.pem');
writeFileSync(CA_FILE, '-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----\n');
const LOGIN_SECRET = 'arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:atmark/owner-login-keys';
const ADMIN_DB_SECRET = 'arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:atmark/db/admin';
const ADMIN_FUNCTION_ARN = 'arn:aws:lambda:ap-northeast-2:123456789012:function:atmark-admin';
const SECRETS: Readonly<Record<string, string>> = {
  [LOGIN_SECRET]: `l1:${randomBytes(32).toString('base64url')}`,
  [ADMIN_DB_SECRET]: JSON.stringify({ host: 'db.internal', port: 5432, dbname: 'atmark', username: 'atmark_admin', password: 'pw' }),
};

function adminEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const base: Record<string, string | undefined> = {
    [RUNTIME_ENV.environment]: 'production',
    [RUNTIME_ENV.region]: 'ap-northeast-2',
    [RUNTIME_ENV.dbAdminSecretArn]: ADMIN_DB_SECRET,
    [RUNTIME_ENV.ownerLoginKeysSecretArn]: LOGIN_SECRET,
    [RUNTIME_ENV.passportKmsKeyId]: 'arn:aws:kms:ap-northeast-2:123456789012:key/test',
    [RUNTIME_ENV.mailBucket]: 'atmarkstorage-mailstorebucket-test',
    [RUNTIME_ENV.extraCaCerts]: CA_FILE,
    [RUNTIME_ENV.loginMailerFunctionArn]: MAILER_ARN,
    ...overrides,
  };
  return Object.fromEntries(Object.entries(base).filter(([, value]) => value !== undefined));
}

const secrets = { readSecretString: (id: string) => (SECRETS[id] === undefined ? Promise.reject(new Error(`no ${id}`)) : Promise.resolve(SECRETS[id])) };

describe('admin 조립 — login-mailer 깨우기', () => {
  const composed: ComposedAdmin[] = [];
  afterEach(async () => {
    await Promise.all(composed.splice(0).map((c) => c.pool.end()));
  });

  it('함수 ARN 이 없으면 그 이름을 대며 기동 거부', async () => {
    await expect(
      composeAdmin({ env: adminEnv({ [RUNTIME_ENV.loginMailerFunctionArn]: undefined }), invokedFunctionArn: ADMIN_FUNCTION_ARN, clients: { secrets } }),
    ).rejects.toThrow(RUNTIME_ENV.loginMailerFunctionArn);
  });

  it('login-mailer 가 아닌 함수·한정자 붙은 ARN 은 기동 거부', async () => {
    for (const arn of [
      'arn:aws:lambda:ap-northeast-2:123456789012:function:atmark-api',
      `${MAILER_ARN}:1`,
      `${MAILER_ARN}:*`,
      'atmark-login-mailer',
    ]) {
      await expect(
        composeAdmin({ env: adminEnv({ [RUNTIME_ENV.loginMailerFunctionArn]: arn }), invokedFunctionArn: ADMIN_FUNCTION_ARN, clients: { secrets } }),
        arn,
      ).rejects.toBeInstanceOf(RuntimeConfigError);
    }
  });

  it('deps.kickLoginMailer 가 그 ARN 을 Event 로 부른다', async () => {
    const fake = fakeClient(() => Promise.resolve({ StatusCode: 202 }));
    const admin = await composeAdmin({ env: adminEnv(), invokedFunctionArn: ADMIN_FUNCTION_ARN, clients: { secrets, lambda: fake.client } });
    composed.push(admin);
    expect(fake.sent).toHaveLength(0); // 조립만으로는 부르지 않는다
    await admin.deps.kickLoginMailer?.();
    expect(fake.sent.map((s) => [s.input.FunctionName, s.input.InvocationType])).toEqual([[MAILER_ARN, 'Event']]);
  });
});
