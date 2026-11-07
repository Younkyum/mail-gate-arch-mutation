/**
 * `src/runtime/billing-composition.ts` — **결제 동기화 Lambda 의 조립**(WP-2). AWS·Paddle 호출 0(가짜 비밀). 풀은 만들기만.
 *
 *   - ★ 운영이 아니면 비밀을 한 번도 읽지 않고 던진다 · 필수 변수가 하나라도 없으면 그 이름을 대며 던진다 · 환경·스위치 값은 정확히.
 *   - ★ 읽는 비밀은 **둘뿐** — sync 키 · 자기 DB 비밀(`atmark/db/billing`). 앱·소유자·admin DB 비밀과 admin 키·웹훅 비밀은 읽지 않는다.
 *   - 풀: TLS(`rejectUnauthorized: true`) · max 1(연결 예산 — compute·transparency 테스트가 같은 상수를 import 한다).
 *   - sync 키가 자리표시면 기동은 하고 `provider: null`(설정 전 — reconcile 이 알람 없이 건너뛴다) · 모양이 틀리면 값 없이 던진다 ·
 *     DB 비밀이 자리표시면 던진다.
 *   - 조립된 어댑터는 이 λ 의 환경 호스트로만 나간다(가짜 fetch 로 확인).
 *   - 핸들러(`handlers/billing-sync.ts`): SQS · `{"action":"reconcile"}` · `sync-org` 를 가르고 모르는 입력은 던진다 · SQS 는 `failed`·`deferred` 만 재전달.
 *   - **배포 중 안전**(순서 "새 Compute → bootstrap-roles → migrate 0400"): DB 롤 비밀이 자리표시면 reconcile 틱은 알람 없이 `not_migrated`, SQS 는 던진다
 *     (배치 재전달) · 결제 표가 없으면 이벤트는 `deferred`(재전달 · 쓰기 0) · reconcile·sync-org 는 아무것도 하지 않는다(알람 메트릭 0).
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { BILLING_SANDBOX_ORG_ALLOWLIST } from '../../../src/billing/constants';
import type { PaddleFetch } from '../../../src/billing/paddle/http';
import type { Pool } from 'pg';

import { runReconcile } from '../../../src/billing/reconcile';
import { consumeBillingRecord, syncOrganization, type BillingSyncDependencies } from '../../../src/billing/sync';
import { serializeBillingQueueMessage } from '../../../src/billing/queue-message';
import { resetLogSink, setLogSink } from '../../../src/observability/logger';
import {
  BILLING_SYNC_POOL_MAX,
  BillingNotReadyError,
  composeBillingSync,
  createPaddleProviderLoader,
  currentBillingSyncDeps,
  PADDLE_KEY_ERROR_TTL_MS,
  PADDLE_KEY_TTL_MS,
  parsePaddleApiKeySecret,
  type ComposedBillingSync,
} from '../../../src/runtime/billing-composition';
import { classifyBillingSyncInput, createBillingSyncHandler } from '../../../src/runtime/handlers/billing-sync';
import type { LambdaContext } from '../../../src/runtime/lambda';
import { composeAdmin, type ComposedAdmin } from '../../../src/runtime/admin-composition';
import { RUNTIME_ENV, RuntimeConfigError } from '../../../src/runtime/config';

const SYNC_KEY_SECRET = 'arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:atmark/billing/paddle/sync-api-key';
const BILLING_DB_SECRET = 'arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:atmark/db/billing';
const PLACEHOLDER = JSON.stringify({ _unset: 'placeholder' });
/** 가짜 벡터 — 실제 키 형식이 아니다. */
const KEY = 'test-sync-key-000000000000000000000001';

const CA_DIR = mkdtempSync(join(tmpdir(), 'atmark-ca-'));
const CA_FILE = join(CA_DIR, 'ca-cert.pem');
writeFileSync(CA_FILE, '-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----\n');

const SECRETS: Readonly<Record<string, string>> = {
  [SYNC_KEY_SECRET]: JSON.stringify({ apiKey: KEY }),
  [BILLING_DB_SECRET]: JSON.stringify({ host: 'db.internal', port: 5432, dbname: 'atmark', username: 'atmark_billing', password: 'p@ss/hunter2' }),
};

/** 운영 billing-sync 함수의 환경(B 의 `compute-stack.ts` — 일곱 개 + 런타임의 AWS_REGION). */
function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const base: Record<string, string | undefined> = {
    [RUNTIME_ENV.environment]: 'production',
    [RUNTIME_ENV.region]: 'ap-northeast-2',
    [RUNTIME_ENV.paddleEnvironment]: 'sandbox',
    [RUNTIME_ENV.billingEnabled]: 'false',
    [RUNTIME_ENV.dbBillingSecretArn]: BILLING_DB_SECRET,
    [RUNTIME_ENV.paddleSyncApiKeySecretArn]: SYNC_KEY_SECRET,
    PGSSLMODE: 'require',
    [RUNTIME_ENV.extraCaCerts]: CA_FILE,
    ...overrides,
  };
  return Object.fromEntries(Object.entries(base).filter(([, value]) => value !== undefined));
}

function clients(secrets: Readonly<Record<string, string>> = SECRETS) {
  const reads: string[] = [];
  const urls: string[] = [];
  const paddleFetch: PaddleFetch = (url) => {
    urls.push(url);
    return Promise.resolve({
      status: 200,
      headers: { get: () => null },
      arrayBuffer: () => Promise.resolve(new TextEncoder().encode(JSON.stringify({ data: [], meta: { pagination: { has_more: false } } })).buffer as ArrayBuffer),
    });
  };
  return {
    reads,
    urls,
    secrets: {
      readSecretString(id: string): Promise<string> {
        reads.push(id);
        const value = secrets[id];
        return value === undefined ? Promise.reject(new Error(`no secret ${id}`)) : Promise.resolve(value);
      },
    },
    paddleFetch,
  };
}

const opened: ComposedBillingSync[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((composed) => composed.pool.end()));
});

describe('billing-sync 조립 — fail-closed · 비밀 둘뿐 · 풀 1', () => {
  it('운영이 아니면 비밀을 한 번도 읽지 않고 던진다', async () => {
    const fake = clients();
    await expect(composeBillingSync({ env: env({ [RUNTIME_ENV.environment]: undefined }), clients: fake })).rejects.toThrow(RuntimeConfigError);
    expect(fake.reads).toEqual([]);
  });

  it.each([
    RUNTIME_ENV.region,
    RUNTIME_ENV.paddleEnvironment,
    RUNTIME_ENV.billingEnabled,
    RUNTIME_ENV.dbBillingSecretArn,
    RUNTIME_ENV.paddleSyncApiKeySecretArn,
    RUNTIME_ENV.extraCaCerts,
  ])('%s 가 없으면 던지고 메시지가 그 이름을 댄다', async (variable) => {
    await expect(composeBillingSync({ env: env({ [variable]: undefined }), clients: clients() })).rejects.toThrow(variable);
  });

  it('환경·스위치 값은 정확히(별칭·대소문자 없음)', async () => {
    for (const [name, value] of [
      [RUNTIME_ENV.paddleEnvironment, 'Sandbox'],
      [RUNTIME_ENV.paddleEnvironment, 'live'],
      [RUNTIME_ENV.billingEnabled, '1'],
      [RUNTIME_ENV.billingEnabled, 'TRUE'],
    ] as const) {
      await expect(composeBillingSync({ env: env({ [name]: value }), clients: clients() }), `${name}=${value}`).rejects.toThrow(RuntimeConfigError);
    }
  });

  it('★ 읽는 비밀은 sync 키 · 자기 DB 비밀 둘뿐 — 다른 롤·admin 키·웹훅 비밀은 환경에 있어도 읽지 않는다', async () => {
    const fake = clients();
    const composed = await composeBillingSync({
      env: env({
        [RUNTIME_ENV.dbSecretArn]: 'arn:app',
        [RUNTIME_ENV.dbMigrationSecretArn]: 'arn:owner',
        [RUNTIME_ENV.dbAdminSecretArn]: 'arn:admin',
        [RUNTIME_ENV.paddleAdminApiKeySecretArn]: 'arn:admin-key',
        [RUNTIME_ENV.paddleWebhookSecretArn]: 'arn:webhook',
        [RUNTIME_ENV.billingEnabled]: 'true',
        [RUNTIME_ENV.paddleEnvironment]: 'production',
      }),
      clients: fake,
    });
    opened.push(composed);
    expect([...fake.reads].sort()).toEqual([SYNC_KEY_SECRET, BILLING_DB_SECRET].sort());
    const options = (composed.pool as unknown as { options: Record<string, unknown> }).options;
    expect(options['ssl']).toEqual({ rejectUnauthorized: true });
    expect(options['max']).toBe(BILLING_SYNC_POOL_MAX);
    expect(BILLING_SYNC_POOL_MAX).toBe(1);
    expect(composed.pool.totalCount).toBe(0);
    expect(composed.deps.environment).toBe('production');
    expect(composed.deps.enabled).toBe(true);
    expect(composed.deps.sandboxAllowlist).toBe(BILLING_SANDBOX_ORG_ALLOWLIST);
    expect(composed.deps.provider?.environment).toBe('production');
    // 어댑터는 이 환경의 호스트로만 나간다.
    await composed.deps.provider?.listSubscriptions({ statuses: ['active'] });
    expect(fake.urls.map((u) => new URL(u).origin)).toEqual(['https://api.paddle.com']);
    expect(fake.urls.join(' ')).not.toContain(KEY);
  });

  it('sync 키가 자리표시면 기동은 하고 provider 는 null(설정 전) · 모양이 틀리면 값 없이 던진다 · DB 비밀 자리표시는 던진다', async () => {
    const pending = await composeBillingSync({ env: env(), clients: clients({ ...SECRETS, [SYNC_KEY_SECRET]: PLACEHOLDER }) });
    opened.push(pending);
    expect(pending.deps.provider).toBeNull();
    for (const raw of ['plain-string-key', JSON.stringify({ key: KEY }), JSON.stringify({ apiKey: 'a b' }), JSON.stringify([KEY])]) {
      const error = await composeBillingSync({ env: env(), clients: clients({ ...SECRETS, [SYNC_KEY_SECRET]: raw }) }).catch((e: unknown) => e);
      expect(error, raw).toBeInstanceOf(RuntimeConfigError);
      expect((error as Error).message).toContain(RUNTIME_ENV.paddleSyncApiKeySecretArn);
      expect((error as Error).message).not.toContain('plain-string-key');
    }
    const notReady = composeBillingSync({ env: env(), clients: clients({ ...SECRETS, [BILLING_DB_SECRET]: PLACEHOLDER }) });
    await expect(notReady).rejects.toThrow(/bootstrap-roles/);
    await expect(composeBillingSync({ env: env(), clients: clients({ ...SECRETS, [BILLING_DB_SECRET]: PLACEHOLDER }) })).rejects.toBeInstanceOf(BillingNotReadyError);
  });

  it('M-5 키 캐시 5분 — 자리표시로 기동한 뒤 실제 키를 넣으면 5분 뒤 호출부터 어댑터가 생긴다(λ 재기동 없이) · 그 안에서는 다시 읽지 않는다', async () => {
    const values: Record<string, string> = { ...SECRETS, [SYNC_KEY_SECRET]: PLACEHOLDER };
    let now = 1_000_000;
    const fake = clients(values);
    const composed = await composeBillingSync({ env: env(), clients: { ...fake, clock: () => now } });
    opened.push(composed);
    expect(composed.deps.provider).toBeNull();
    values[SYNC_KEY_SECRET] = JSON.stringify({ apiKey: KEY });
    now += PADDLE_KEY_TTL_MS - 1;
    expect((await currentBillingSyncDeps(composed)).provider).toBeNull();
    expect(fake.reads.filter((id) => id === SYNC_KEY_SECRET)).toHaveLength(1);
    now += 1;
    const fresh = await currentBillingSyncDeps(composed);
    expect(fresh.provider?.environment).toBe('sandbox');
    expect(fake.reads.filter((id) => id === SYNC_KEY_SECRET)).toHaveLength(2);
    // 조립의 나머지는 그대로(같은 풀 · 같은 스위치).
    expect(fresh.pool).toBe(composed.deps.pool);
    // 키를 다시 자리표시로 되돌리면(철회) 5분 뒤 null.
    values[SYNC_KEY_SECRET] = PLACEHOLDER;
    now += PADDLE_KEY_TTL_MS;
    expect((await currentBillingSyncDeps(composed)).provider).toBeNull();
  });

  it('M-5 로더 — admin 과 같은 함수: 시간 제한을 어댑터에 넘기고 · 모양이 틀린 새 비밀은 값 없이 던진다', async () => {
    let now = 0;
    let raw = JSON.stringify({ apiKey: KEY });
    const signals: AbortSignal[] = [];
    const load = createPaddleProviderLoader({
      secrets: { readSecretString: () => Promise.resolve(raw) },
      secretArn: 'arn:admin-key',
      label: 'ATMARK_PADDLE_ADMIN_API_KEY_SECRET_ARN',
      environment: 'sandbox',
      timeoutMs: 5_000,
      clock: () => now,
      paddleFetch: (_url, init) => {
        signals.push(init.signal);
        return Promise.resolve({ status: 200, headers: { get: () => null }, arrayBuffer: () => Promise.resolve(new TextEncoder().encode('{"data":[]}').buffer as ArrayBuffer) });
      },
    });
    const provider = await load();
    expect(await load()).toBe(provider);
    await provider?.listSubscriptions({ statuses: ['active'] });
    expect(signals).toHaveLength(1);
    raw = 'plain-string-key';
    now += PADDLE_KEY_TTL_MS;
    const error = await load().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RuntimeConfigError);
    expect((error as Error).message).not.toContain('plain-string-key');
  });

  it('N-2/N-3 로더 — 읽기 실패는 마지막 성공 값(30초 동안 다시 읽지 않는다) · 성공한 적이 없으면 던진다 · 모양 오류는 30초 부정 캐시(옛 키로 잇지 않는다)', async () => {
    let now = 0;
    let raw: string | Error = JSON.stringify({ apiKey: KEY });
    let reads = 0;
    const load = createPaddleProviderLoader({
      secrets: {
        readSecretString: () => {
          reads += 1;
          return raw instanceof Error ? Promise.reject(raw) : Promise.resolve(raw);
        },
      },
      secretArn: 'arn:sync-key',
      label: 'ATMARK_PADDLE_SYNC_API_KEY_SECRET_ARN',
      environment: 'sandbox',
      clock: () => now,
    });
    const provider = await load();
    expect(provider?.environment).toBe('sandbox');
    // 5분 뒤 읽기 실패 → 마지막 성공 값 · 30초 동안은 다시 읽지 않는다 · 그 뒤 다시 읽고, 되살아나면 새 값.
    raw = new Error('ThrottlingException');
    now += PADDLE_KEY_TTL_MS;
    expect(await load()).toBe(provider);
    expect(reads).toBe(2);
    now += PADDLE_KEY_ERROR_TTL_MS - 1;
    expect(await load()).toBe(provider);
    expect(reads).toBe(2);
    now += 1;
    expect(await load()).toBe(provider);
    expect(reads).toBe(3);
    raw = JSON.stringify({ apiKey: KEY });
    now += PADDLE_KEY_ERROR_TTL_MS;
    const renewed = await load();
    expect(renewed).not.toBe(provider);
    expect(renewed?.environment).toBe('sandbox');
    expect(reads).toBe(4);

    // 모양 오류 → 던진다(값 없이) · 30초 동안 다시 읽지 않고 같은 오류 · 옛 키로 잇지 않는다 · 고치면 30초 뒤 첫 호출이 잡는다.
    raw = 'plain-string-key';
    now += PADDLE_KEY_TTL_MS;
    const shape = await load().catch((e: unknown) => e);
    expect(shape).toBeInstanceOf(RuntimeConfigError);
    expect((shape as Error).message).not.toContain('plain-string-key');
    expect(reads).toBe(5);
    now += PADDLE_KEY_ERROR_TTL_MS - 1;
    raw = JSON.stringify({ apiKey: KEY });
    await expect(load()).rejects.toBe(shape);
    expect(reads).toBe(5);
    // 모양 오류 뒤의 읽기 실패도 옛 키를 되살리지 않는다.
    now += 1;
    raw = new Error('ThrottlingException');
    await expect(load()).rejects.toThrow('ThrottlingException');
    expect(reads).toBe(6);
    now += PADDLE_KEY_ERROR_TTL_MS;
    raw = JSON.stringify({ apiKey: KEY });
    expect((await load())?.environment).toBe('sandbox');
    expect(reads).toBe(7);
  });

  it('N-2/N-3 로더 — 콜드 스타트 읽기 실패(성공 값 없음)는 던지고 30초 동안 다시 읽지 않는다', async () => {
    let now = 0;
    let reads = 0;
    const load = createPaddleProviderLoader({
      secrets: {
        readSecretString: () => {
          reads += 1;
          return Promise.reject(new Error('AccessDeniedException'));
        },
      },
      secretArn: 'arn:sync-key',
      label: 'X',
      environment: 'sandbox',
      clock: () => now,
    });
    await expect(load()).rejects.toThrow('AccessDeniedException');
    now += PADDLE_KEY_ERROR_TTL_MS - 1;
    await expect(load()).rejects.toThrow('AccessDeniedException');
    expect(reads).toBe(1);
    now += 1;
    await expect(load()).rejects.toThrow('AccessDeniedException');
    expect(reads).toBe(2);
  });

  it('parsePaddleApiKeySecret — 자리표시 null · {"apiKey"} 만 · 헤더를 깨는 글자 거부', () => {
    expect(parsePaddleApiKeySecret(PLACEHOLDER, 'X')).toBeNull();
    expect(parsePaddleApiKeySecret(JSON.stringify({ apiKey: KEY }), 'X')).toBe(KEY);
    for (const raw of ['', '{', JSON.stringify({ apiKey: '' }), JSON.stringify({ apiKey: `${KEY}\n` }), JSON.stringify({ apiKey: 42 })]) {
      expect(() => parsePaddleApiKeySecret(raw, 'X'), raw).toThrow(RuntimeConfigError);
    }
  });
});

const CONTEXT = { awsRequestId: 'r1', invokedFunctionArn: 'arn:aws:lambda:ap-northeast-2:123456789012:function:atmark-billing-sync', callbackWaitsForEmptyEventLoop: true } as LambdaContext;

/** 결제 표가 없는 DB(마이그레이션 0400 전) — `to_regclass` 만 답하고 다른 문장은 42P01. */
function unmigratedPool(): { pool: Pool; statements: string[] } {
  const statements: string[] = [];
  const query = (text: string): Promise<{ rows: unknown[]; rowCount: number }> => {
    statements.push(text);
    if (text.includes('to_regclass')) return Promise.resolve({ rows: [{ ok: false }], rowCount: 1 });
    return Promise.reject(Object.assign(new Error('relation does not exist'), { code: '42P01' }));
  };
  return { pool: { query, connect: () => Promise.reject(new Error('연결을 빌리지 않는다')) } as unknown as Pool, statements };
}

function captureLines(): string[] {
  const lines: string[] = [];
  setLogSink((line) => lines.push(line));
  return lines;
}
const metric = (lines: readonly string[], name: string): number => lines.filter((line) => line.includes(`"${name}":`)).length;

describe('billing-sync 핸들러 — 입력 가르기', () => {
  it('SQS · reconcile(+restart) · sync-org 만 받고 나머지는 던진다', () => {
    expect(classifyBillingSyncInput({ Records: [{ messageId: 'm1', body: '{}' }] })).toMatchObject({ kind: 'sqs' });
    expect(classifyBillingSyncInput({ action: 'reconcile' })).toEqual({ kind: 'reconcile', restart: false });
    expect(classifyBillingSyncInput({ action: 'reconcile', restart: true })).toEqual({ kind: 'reconcile', restart: true });
    const org = '0f8b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d';
    expect(classifyBillingSyncInput({ action: 'sync-org', organizationId: org })).toEqual({ kind: 'sync-org', organizationId: org });
    for (const bad of [
      null,
      'reconcile',
      [],
      {},
      { action: 'Reconcile' },
      { action: 'reconcile', restart: 'yes' },
      { action: 'reconcile', extra: 1 },
      { action: 'sync-org', organizationId: 'o1' },
      { action: 'sync-org' },
      { Records: [{ messageId: 'm1' }] },
      { Records: 'x' },
      { source: 'aws.scheduler' },
    ]) {
      expect(() => classifyBillingSyncInput(bad), JSON.stringify(bad)).toThrow(TypeError);
    }
  });
});

describe('배포 중 안전 — DB 롤 전 · 결제 표 전', () => {
  afterEach(() => resetLogSink());

  it('DB 롤 비밀이 자리표시(BillingNotReadyError) → reconcile 틱은 알람 없이 not_migrated · SQS 배치는 던진다(재전달) · 모르는 입력은 조립 전에 던진다', async () => {
    const lines = captureLines();
    let composed = 0;
    const handler = createBillingSyncHandler(() => {
      composed += 1;
      return Promise.reject(new BillingNotReadyError('placeholder'));
    });
    expect(await handler({ action: 'reconcile' }, { ...CONTEXT })).toMatchObject({ status: 'not_migrated' });
    await expect(handler({ Records: [{ messageId: 'm1', body: '{}' }] }, { ...CONTEXT })).rejects.toBeInstanceOf(BillingNotReadyError);
    await expect(handler({ action: 'bogus' }, { ...CONTEXT })).rejects.toBeInstanceOf(TypeError);
    expect(composed).toBe(2);
    expect(metric(lines, 'atmark.billing.reconcile_skipped')).toBe(1);
    expect(metric(lines, 'atmark.billing.sync_failed') + metric(lines, 'atmark.billing.provider_auth_failed')).toBe(0);
    // 다른 조립 실패(설정 오류)는 reconcile 이어도 던진다.
    const broken = createBillingSyncHandler(() => Promise.reject(new RuntimeConfigError('ATMARK_PADDLE_ENV')));
    await expect(broken({ action: 'reconcile' }, { ...CONTEXT })).rejects.toBeInstanceOf(RuntimeConfigError);
  });

  it('결제 표가 없으면 — 이벤트는 deferred(재전달 · 쓰기 0) · reconcile·sync-org 는 아무것도 하지 않는다 · 알람 메트릭 0', async () => {
    const lines = captureLines();
    const { pool, statements } = unmigratedPool();
    const provider = { environment: 'sandbox' } as unknown as BillingSyncDependencies['provider'];
    const deps: BillingSyncDependencies = { pool, environment: 'sandbox', enabled: true, provider, sandboxAllowlist: ['0f8b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d'], now: () => new Date() };
    const body = serializeBillingQueueMessage({
      v: 1,
      provider: 'paddle',
      environment: 'sandbox',
      eventId: `evt_${'a'.repeat(26)}`,
      eventType: 'subscription.updated',
      occurredAt: '2026-09-25T00:00:00.000Z',
      notificationId: null,
      payloadSha256: 'b'.repeat(64),
      subscriptionId: `sub_${'c'.repeat(26)}`,
      transactionId: null,
      customerId: null,
      diagnostic: { customDataOrganizationId: null },
      receivedAt: '2026-09-25T00:00:01.000Z',
    });
    expect(await consumeBillingRecord(deps, body)).toBe('deferred');
    expect(await runReconcile(deps)).toMatchObject({ status: 'not_migrated' });
    expect(await syncOrganization(deps, '0f8b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d')).toBe('not_migrated');
    expect(statements.every((text) => text.includes('to_regclass'))).toBe(true);

    // 핸들러: deferred 는 batchItemFailures 로 돌려준다(메시지를 잃지 않는다).
    const handler = createBillingSyncHandler(() => Promise.resolve({ deps }));
    expect(await handler({ Records: [{ messageId: 'm1', body }] }, { ...CONTEXT })).toEqual({ batchItemFailures: [{ itemIdentifier: 'm1' }] });
    for (const alarm of ['sync_failed', 'provider_auth_failed', 'unknown_price', 'unbound_subscription', 'entitlement_held', 'webhook_missed']) {
      expect(metric(lines, `atmark.billing.${alarm}`), alarm).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// admin 조립 — 결제 키 오류는 결제만 잠근다(N-2/N-3)
// ---------------------------------------------------------------------------

const ADMIN_KEY_SECRET = 'arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:atmark/billing/paddle/admin-api-key';
const LOGIN_SECRET = 'arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:atmark/owner-login-keys';
const ADMIN_DB_SECRET = 'arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:atmark/db/admin';
const ADMIN_FUNCTION_ARN = 'arn:aws:lambda:ap-northeast-2:123456789012:function:atmark-admin';

function adminEnv(): NodeJS.ProcessEnv {
  return {
    [RUNTIME_ENV.environment]: 'production',
    [RUNTIME_ENV.region]: 'ap-northeast-2',
    [RUNTIME_ENV.dbAdminSecretArn]: ADMIN_DB_SECRET,
    [RUNTIME_ENV.ownerLoginKeysSecretArn]: LOGIN_SECRET,
    [RUNTIME_ENV.passportKmsKeyId]: 'arn:aws:kms:ap-northeast-2:123456789012:key/test',
    [RUNTIME_ENV.mailBucket]: 'atmarkstorage-mailstorebucket-test',
    [RUNTIME_ENV.extraCaCerts]: CA_FILE,
    [RUNTIME_ENV.paddleEnvironment]: 'sandbox',
    [RUNTIME_ENV.billingEnabled]: 'true',
    [RUNTIME_ENV.paddleAdminApiKeySecretArn]: ADMIN_KEY_SECRET,
    [RUNTIME_ENV.loginMailerFunctionArn]: 'arn:aws:lambda:ap-northeast-2:123456789012:function:atmark-login-mailer',
  };
}

describe('admin 조립 — 결제 키 오류는 결제만 잠근다(콘솔은 정상)', () => {
  const composedAdmins: ComposedAdmin[] = [];
  afterEach(async () => {
    resetLogSink();
    await Promise.all(composedAdmins.splice(0).map((composed) => composed.pool.end()));
  });

  function adminSecrets(values: Record<string, string | Error>) {
    const reads: string[] = [];
    return {
      reads,
      secrets: {
        readSecretString(id: string): Promise<string> {
          reads.push(id);
          const value = values[id];
          if (value === undefined) return Promise.reject(new Error(`no secret ${id}`));
          return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
        },
      },
    };
  }

  const BASE: Record<string, string | Error> = {
    [LOGIN_SECRET]: `l1:${'A'.repeat(43)}`,
    [ADMIN_DB_SECRET]: JSON.stringify({ host: 'db.internal', port: 5432, dbname: 'atmark', username: 'atmark_admin', password: 'pw' }),
  };

  it('콜드 스타트 — 키 모양 오류·읽기 실패여도 조립은 된다 · loadProvider 는 null(not_configured) · 값 없는 로그', async () => {
    for (const bad of ['plain-string-key', JSON.stringify({ apiKey: 'a b' }), new Error('AccessDeniedException')]) {
      const lines = captureLines();
      const fake = adminSecrets({ ...BASE, [ADMIN_KEY_SECRET]: bad });
      const composed = await composeAdmin({ env: adminEnv(), invokedFunctionArn: ADMIN_FUNCTION_ARN, clients: { secrets: fake.secrets } });
      composedAdmins.push(composed);
      expect(composed.deps.billing?.enabled, String(bad)).toBe(true);
      expect(await composed.deps.billing?.loadProvider(), String(bad)).toBeNull();
      // 콘솔 나머지는 조립됐다(로그인 키 · 풀 · 본문 리더).
      expect(composed.deps.loginKeys).toBeDefined();
      expect(composed.deps.outboundContent).toBeDefined();
      const logged = lines.filter((line) => line.includes('"billing.admin_key_unavailable"'));
      expect(logged.length, String(bad)).toBeGreaterThan(0);
      expect(lines.join('\n')).not.toContain('plain-string-key');
      resetLogSink();
    }
  });

  it('웜 — 좋은 키로 기동한 뒤 비밀이 깨지면 5분 뒤 호출부터 null(던지지 않는다) · 읽기 실패는 마지막 성공 값 · 고치면 되살아난다', async () => {
    let now = 0;
    const values: Record<string, string | Error> = { ...BASE, [ADMIN_KEY_SECRET]: JSON.stringify({ apiKey: KEY }) };
    const fake = adminSecrets(values);
    const composed = await composeAdmin({ env: adminEnv(), invokedFunctionArn: ADMIN_FUNCTION_ARN, clients: { secrets: fake.secrets, clock: () => now } });
    composedAdmins.push(composed);
    const billing = composed.deps.billing;
    if (billing === undefined) throw new Error('결제 의존성이 없다');
    const provider = await billing.loadProvider();
    expect(provider?.environment).toBe('sandbox');
    // 읽기 실패 → 마지막 성공 값.
    values[ADMIN_KEY_SECRET] = new Error('ThrottlingException');
    now += PADDLE_KEY_TTL_MS;
    expect(await billing.loadProvider()).toBe(provider);
    // 모양 오류 → null(콘솔 요청은 not_configured 로 잠길 뿐 던지지 않는다).
    captureLines();
    values[ADMIN_KEY_SECRET] = 'plain-string-key';
    now += PADDLE_KEY_ERROR_TTL_MS;
    expect(await billing.loadProvider()).toBeNull();
    now += PADDLE_KEY_ERROR_TTL_MS - 1;
    const readsBefore = fake.reads.filter((id) => id === ADMIN_KEY_SECRET).length;
    expect(await billing.loadProvider()).toBeNull();
    expect(fake.reads.filter((id) => id === ADMIN_KEY_SECRET)).toHaveLength(readsBefore);
    // 고치면 부정 캐시(30초)가 지난 첫 호출부터 어댑터.
    values[ADMIN_KEY_SECRET] = JSON.stringify({ apiKey: KEY });
    now += 1;
    expect((await billing.loadProvider())?.environment).toBe('sandbox');
  });
});
