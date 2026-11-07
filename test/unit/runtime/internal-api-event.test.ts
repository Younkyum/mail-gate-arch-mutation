/**
 * 콘솔 웹훅 시크릿 받기(보안 M1) — admin λ → api λ 내부 이벤트. AWS·DB 호출 0(가짜 클라이언트·가짜 조립).
 *
 *   - ★ `parseInternalApiEvent` 는 정확한 키 집합의 평범한 객체만 받는다 — API Gateway HTTP 이벤트(본문에 같은 JSON 을 실어도)·키가 더하거나 빠진
 *     객체·모양이 틀린 id 는 `null`(HTTP 경로).
 *   - ★ api 핸들러: 내부 이벤트는 라우터를 지나지 않고 처리 · 조립 실패는 `{ok:false, error:'unavailable'}`(던지지 않는다) · HTTP 이벤트는 그대로.
 *   - ★ `createWebhookSecretIssuer`: RequestResponse · 대상 ARN · 입력 모양 · 결과 해석 · 거절·함수 오류·시간 초과는 `WebhookSecretIssueError` ·
 *     활성 kid 캐시.
 *   - 인증 헤더 봉인(202610141400): `webhook.sealAuthorization` 은 봉인만(DB 0) · 규칙 위반 · URL 거부는 이유 코드 · 결과 · 로그에 값 없음.
 *   - admin 조립(보안 L4): `ATMARK_API_FUNCTION_ARN` 이 없거나 틀려도 기동한다 — `deps.webhookSecrets` 없음. 웹훅 키링 비밀을 읽지 않는다.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import type { InvokeCommand } from '@aws-sdk/client-lambda';
import { afterEach, describe, expect, it } from 'vitest';

import { resetLogSink, setLogSink } from '../../../src/observability/logger';
import { composeAdmin, type ComposedAdmin } from '../../../src/runtime/admin-composition';
import { RUNTIME_ENV } from '../../../src/runtime/config';
import { createApiHandler } from '../../../src/runtime/handlers/api';
import { INTERNAL_EVENT_SOURCE, parseInternalApiEvent, type InternalApiEvent } from '../../../src/runtime/internal-api-event';
import type { LambdaContext } from '../../../src/runtime/lambda';
import { createWebhookSecretIssuer, WebhookSecretIssueError, type LambdaInvokeClient } from '../../../src/runtime/lambda-invoke';
import type { ApiDependencies, HttpApiEvent } from '../../../src/runtime/router';
import { parseHmacKeyring } from '../../../src/security/hmac-keyring';

const AGENT = 'a'.repeat(32);
const ENDPOINT = '0f3c9a52-6b1e-4d7a-9c2f-5e8b1a4d7c01';
const ORG = '1b2c3d4e-0000-4a00-8000-00000000000a';
const OTHER_ORG = '1b2c3d4e-0000-4a00-8000-00000000000b';
const API_ARN = 'arn:aws:lambda:ap-northeast-2:123456789012:function:atmark-api';
const ISSUE: InternalApiEvent = { source: INTERNAL_EVENT_SOURCE, kind: 'webhook.issueSecret', agentId: AGENT, endpointId: ENDPOINT };

afterEach(() => resetLogSink());

function httpEvent(body?: string): HttpApiEvent {
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: '/healthz',
    rawQueryString: '',
    headers: { 'content-type': 'application/json' },
    requestContext: { requestId: 'req-1', stage: '$default', http: { method: 'POST', path: '/healthz', sourceIp: '198.51.100.1' } },
    ...(body === undefined ? {} : { body }),
    isBase64Encoded: false,
  } as unknown as HttpApiEvent;
}

describe('parseInternalApiEvent — 모양을 엄격하게', () => {
  it('정확한 두 모양만 받는다', () => {
    expect(parseInternalApiEvent({ source: INTERNAL_EVENT_SOURCE, kind: 'webhook.activeKid' })).toEqual({ source: INTERNAL_EVENT_SOURCE, kind: 'webhook.activeKid' });
    expect(parseInternalApiEvent({ ...ISSUE })).toEqual(ISSUE);
  });

  it('★ HTTP 이벤트는 본문에 같은 JSON 을 실어도 내부 이벤트가 아니다 · 키가 더하거나 빠지거나 값 모양이 틀리면 null', () => {
    expect(parseInternalApiEvent(httpEvent(JSON.stringify(ISSUE)))).toBeNull();
    expect(parseInternalApiEvent({ ...ISSUE, requestContext: {} })).toBeNull();
    expect(parseInternalApiEvent({ ...ISSUE, body: '' })).toBeNull();
    expect(parseInternalApiEvent({ source: INTERNAL_EVENT_SOURCE, kind: 'webhook.issueSecret', agentId: AGENT })).toBeNull();
    expect(parseInternalApiEvent({ source: INTERNAL_EVENT_SOURCE, kind: 'webhook.activeKid', extra: 1 })).toBeNull();
    expect(parseInternalApiEvent({ ...ISSUE, source: 'atmark.kick' })).toBeNull();
    expect(parseInternalApiEvent({ ...ISSUE, kind: 'webhook.rotate' })).toBeNull();
    expect(parseInternalApiEvent({ ...ISSUE, agentId: 'A'.repeat(32) })).toBeNull();
    expect(parseInternalApiEvent({ ...ISSUE, endpointId: `${ENDPOINT}x` })).toBeNull();
    expect(parseInternalApiEvent(Object.assign(Object.create({ inherited: true }) as object, ISSUE))).toBeNull();
    for (const value of [null, undefined, 'x', 1, [ISSUE]]) expect(parseInternalApiEvent(value)).toBeNull();
  });
});

describe('api 핸들러 — 내부 이벤트', () => {
  const context = (): LambdaContext => ({ awsRequestId: 'a', invokedFunctionArn: API_ARN, callbackWaitsForEmptyEventLoop: true });
  const RING = parseHmacKeyring(`w7:${randomBytes(32).toString('base64url')}`, 'TEST');

  it('★ activeKid 는 라우터를 지나지 않고 키 묶음의 활성 kid 를 돌려준다(DB 0)', async () => {
    const deps = { webhookEndpoints: { keyring: RING, db: { query: () => Promise.reject(new Error('DB 에 닿으면 안 된다')) } } } as unknown as ApiDependencies;
    const handler = createApiHandler(() => Promise.resolve({ deps, pool: {} as never }));
    await expect(handler({ source: INTERNAL_EVENT_SOURCE, kind: 'webhook.activeKid' }, context())).resolves.toEqual({ ok: true, kid: 'w7' });
  });

  it('★ issueSecret: 60초 안의 콘솔 행이 아니면(DB 0행) not_eligible · DB 오류는 unavailable · 조립 실패도 unavailable(던지지 않는다)', async () => {
    const empty = { webhookEndpoints: { keyring: RING, db: { query: () => Promise.resolve({ rows: [] }) } } } as unknown as ApiDependencies;
    await expect(createApiHandler(() => Promise.resolve({ deps: empty, pool: {} as never }))(ISSUE, context())).resolves.toEqual({ ok: false, error: 'not_eligible' });
    const broken = { webhookEndpoints: { keyring: RING, db: { query: () => Promise.reject(new Error('boom')) } } } as unknown as ApiDependencies;
    await expect(createApiHandler(() => Promise.resolve({ deps: broken, pool: {} as never }))(ISSUE, context())).resolves.toEqual({ ok: false, error: 'unavailable' });
    await expect(createApiHandler(() => Promise.reject(new Error('no secrets')))(ISSUE, context())).resolves.toEqual({ ok: false, error: 'unavailable' });
  });

  it('issueSecret: DB 가 (kid, 버전)을 돌려주면 그 시크릿을 파생한다', async () => {
    const deps = {
      webhookEndpoints: { keyring: RING, db: { query: () => Promise.resolve({ rows: [{ r_secret_kid: 'w7', r_secret_version: 2 }] }) } },
    } as unknown as ApiDependencies;
    const result = await createApiHandler(() => Promise.resolve({ deps, pool: {} as never }))(ISSUE, context());
    expect(result).toMatchObject({ ok: true });
    expect((result as { secret: string }).secret).toMatch(/^whsec_/);
  });
});

interface Sent {
  readonly input: InvokeCommand['input'];
}

function fakeClient(respond: (payload: unknown) => Promise<{ StatusCode?: number; Payload?: Uint8Array; FunctionError?: string }>) {
  const sent: Sent[] = [];
  const client: LambdaInvokeClient = {
    send(command) {
      sent.push({ input: command.input });
      return respond(JSON.parse(new TextDecoder().decode(command.input.Payload as Uint8Array)));
    },
  };
  return { client, sent };
}

const reply = (value: unknown) => Promise.resolve({ StatusCode: 200, Payload: new TextEncoder().encode(JSON.stringify(value)) });

describe('createWebhookSecretIssuer — admin λ 쪽', () => {
  it('★ RequestResponse · 대상 = api ARN · 입력은 내부 이벤트 모양 그대로 · 시크릿을 돌려준다 · 활성 kid 는 캐시한다', async () => {
    let now = 0;
    const fake = fakeClient((payload) => reply((payload as { kind: string }).kind === 'webhook.activeKid' ? { ok: true, kid: 'w1' } : { ok: true, secret: 'whsec_AAAA' }));
    const issuer = createWebhookSecretIssuer({ client: fake.client, functionArn: API_ARN, clock: () => now });
    expect(await issuer.activeKid()).toBe('w1');
    now += 60_000;
    expect(await issuer.activeKid()).toBe('w1');
    expect(await issuer.issue(AGENT, ENDPOINT)).toBe('whsec_AAAA');
    expect(fake.sent.map((s) => [s.input.FunctionName, s.input.InvocationType])).toEqual([
      [API_ARN, 'RequestResponse'],
      [API_ARN, 'RequestResponse'],
    ]);
    const payloads = fake.sent.map((s) => parseInternalApiEvent(JSON.parse(new TextDecoder().decode(s.input.Payload as Uint8Array))));
    expect(payloads).toEqual([{ source: INTERNAL_EVENT_SOURCE, kind: 'webhook.activeKid' }, ISSUE]);
  });

  it('★ 거절·함수 오류·모양 틀림·시간 초과는 WebhookSecretIssueError(이유 포함)', async () => {
    const cases: Array<[() => Promise<{ StatusCode?: number; Payload?: Uint8Array; FunctionError?: string }>, string]> = [
      [() => reply({ ok: false, error: 'not_eligible' }), 'not_eligible'],
      [() => reply({ ok: false, error: 'unavailable' }), 'unavailable'],
      [() => Promise.resolve({ StatusCode: 200, FunctionError: 'Unhandled', Payload: new Uint8Array() }), 'function_error'],
      [() => reply({ ok: true, secret: 'nope' }), 'malformed'],
      [() => Promise.resolve({ StatusCode: 200, Payload: new TextEncoder().encode('{') }), 'malformed'],
      [() => Promise.reject(new Error('AccessDenied')), 'invoke_failed'],
      [() => new Promise(() => undefined), 'timeout'],
    ];
    for (const [respond, reason] of cases) {
      const issuer = createWebhookSecretIssuer({ client: fakeClient(respond).client, functionArn: API_ARN, timeoutMs: 30 });
      const error = await issuer.issue(AGENT, ENDPOINT).then(() => null, (thrown: unknown) => thrown);
      expect(error, reason).toBeInstanceOf(WebhookSecretIssueError);
      expect((error as WebhookSecretIssueError).reason, reason).toBe(reason);
    }
  });
});

// ---------------------------------------------------------------------------
// admin 조립 — 보안 L4(웹훅 설정이 틀려도 기동) · 키링 없음
// ---------------------------------------------------------------------------

const CA_DIR = mkdtempSync(join(tmpdir(), 'atmark-ca-'));
const CA_FILE = join(CA_DIR, 'ca-cert.pem');
writeFileSync(CA_FILE, '-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----\n');
const LOGIN_SECRET = 'arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:atmark/owner-login-keys';
const ADMIN_DB_SECRET = 'arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:atmark/db/admin';
const WEBHOOK_KEYS = 'arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:atmark/webhook-secret-keys';
const MAILER_ARN = 'arn:aws:lambda:ap-northeast-2:123456789012:function:atmark-login-mailer';
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

describe('admin 조립 — 콘솔 웹훅 시크릿(보안 M1·L4)', () => {
  const composed: ComposedAdmin[] = [];
  afterEach(async () => {
    await Promise.all(composed.splice(0).map((c) => c.pool.end()));
  });
  const read: string[] = [];
  const secrets = {
    readSecretString: (id: string) => {
      read.push(id);
      return SECRETS[id] === undefined ? Promise.reject(new Error(`no ${id}`)) : Promise.resolve(SECRETS[id]);
    },
  };

  it('★ api 함수 ARN 이 없거나 틀려도 기동한다 — webhookSecrets 없음(등록·회전만 503) · 웹훅 키링은 읽지 않는다(변수가 있어도)', async () => {
    for (const arn of [undefined, 'arn:aws:lambda:ap-northeast-2:123456789012:function:atmark-admin', `${API_ARN}:1`]) {
      read.length = 0;
      const admin = await composeAdmin({
        env: adminEnv({ [RUNTIME_ENV.apiFunctionArn]: arn, [RUNTIME_ENV.webhookSecretKeysSecretArn]: WEBHOOK_KEYS }),
        invokedFunctionArn: 'arn:aws:lambda:ap-northeast-2:123456789012:function:atmark-admin',
        clients: { secrets },
      });
      composed.push(admin);
      expect(admin.deps.webhookSecrets, String(arn)).toBeUndefined();
      expect(read).not.toContain(WEBHOOK_KEYS);
    }
  });

  it('api 함수 ARN 이 맞으면 webhookSecrets 가 그 ARN 을 RequestResponse 로 부른다', async () => {
    const fake = fakeClient(() => reply({ ok: true, kid: 'w1' }));
    const admin = await composeAdmin({
      env: adminEnv({ [RUNTIME_ENV.apiFunctionArn]: API_ARN }),
      invokedFunctionArn: 'arn:aws:lambda:ap-northeast-2:123456789012:function:atmark-admin',
      clients: { secrets, lambda: fake.client },
    });
    composed.push(admin);
    expect(await admin.deps.webhookSecrets?.activeKid()).toBe('w1');
    expect(fake.sent.map((s) => [s.input.FunctionName, s.input.InvocationType])).toEqual([[API_ARN, 'RequestResponse']]);
  });
});

describe('webhook.sealAuthorization — 콘솔의 인증 헤더 봉인(202610141400)', () => {
  const SEAL: InternalApiEvent = {
    source: INTERNAL_EVENT_SOURCE,
    kind: 'webhook.sealAuthorization',
    agentId: AGENT,
    organizationId: ORG,
    endpointId: ENDPOINT,
    url: 'https://hooks.example.com/atmark',
    purpose: 'register',
    authorization: 'Bearer seal_0123456789abcdefWXYZ',
  };
  const context = (): LambdaContext => ({ awsRequestId: 'a', invokedFunctionArn: API_ARN, callbackWaitsForEmptyEventLoop: true });
  const RING = parseHmacKeyring(`w7:${randomBytes(32).toString('base64url')}`, 'TEST');
  /** 가짜 DB — 에이전트 행(조직 · 상태)과 엔드포인트 행(없으면 []). */
  const fakeDb = (agent: { organization_id: string; status: string } | null, endpoint: { agent_id: string; url: string; disabled: boolean } | null) =>
    ({
      webhookEndpoints: {
        keyring: RING,
        db: {
          query: (sql: string) =>
            Promise.resolve({ rows: sql.includes('FROM agents') ? (agent === null ? [] : [agent]) : endpoint === null ? [] : [endpoint] }),
        },
      },
    }) as unknown as ApiDependencies;
  const noDb = fakeDb({ organization_id: ORG, status: 'active' }, null);

  it('정확한 모양만 · 키 더하기 · 빼기 · 값 모양 틀림은 null', () => {
    expect(parseInternalApiEvent({ ...SEAL })).toEqual(SEAL);
    expect(parseInternalApiEvent({ ...SEAL, extra: 1 })).toBeNull();
    const { authorization: _omitted, ...missing } = SEAL as Extract<InternalApiEvent, { kind: 'webhook.sealAuthorization' }>;
    expect(parseInternalApiEvent(missing)).toBeNull();
    expect(parseInternalApiEvent({ ...SEAL, authorization: 7 })).toBeNull();
    expect(parseInternalApiEvent({ ...SEAL, authorization: 'x'.repeat(9000) })).toBeNull();
    expect(parseInternalApiEvent({ ...SEAL, agentId: 'nope' })).toBeNull();
    expect(parseInternalApiEvent({ ...SEAL, purpose: 'other' })).toBeNull();
    expect(parseInternalApiEvent({ ...SEAL, endpointId: 'x' })).toBeNull();
    expect(parseInternalApiEvent({ ...SEAL, organizationId: 'x' })).toBeNull();
  });

  it('★ 봉인만 한다(DB 0) · 정규화 URL · 힌트 · 봉인값에 평문 없음 · 결과 · 로그에 값 없음', async () => {
    const lines: string[] = [];
    setLogSink((line) => lines.push(line));
    const result = (await createApiHandler(() => Promise.resolve({ deps: noDb, pool: {} as never }))({ ...SEAL, url: 'https://HOOKS.example.com/atmark' }, context())) as Record<
      string,
      unknown
    >;
    expect(result).toMatchObject({ ok: true, url: 'https://hooks.example.com/atmark', kid: 'w7', hint: 'Bearer …WXYZ' });
    expect(JSON.stringify(result)).not.toContain('seal_0123');
    expect(lines.join('\n')).not.toContain('seal_0123');
  });

  it('★ 보안 리뷰 L3 — 봉인 전 대상 확인: 조직 · 삭제 · 엔드포인트 있음/없음 · 에이전트 · URL · 켜짐이 맞지 않으면 not_eligible', async () => {
    const url = 'https://hooks.example.com/atmark';
    const own = { agent_id: AGENT, url, disabled: false };
    const cases: Array<[ApiDependencies, Record<string, unknown>, boolean]> = [
      [fakeDb(null, null), {}, false],
      [fakeDb({ organization_id: OTHER_ORG, status: 'active' }, null), {}, false],
      [fakeDb({ organization_id: ORG, status: 'disabled' }, null), {}, false],
      [fakeDb({ organization_id: ORG, status: 'active' }, own), {}, false],
      [fakeDb({ organization_id: ORG, status: 'active' }, null), { purpose: 'replace' }, false],
      [fakeDb({ organization_id: ORG, status: 'active' }, own), { purpose: 'replace' }, true],
      [fakeDb({ organization_id: ORG, status: 'active' }, { ...own, disabled: true }), { purpose: 'replace' }, false],
      [fakeDb({ organization_id: ORG, status: 'active' }, { ...own, agent_id: 'b'.repeat(32) }), { purpose: 'replace' }, false],
      [fakeDb({ organization_id: ORG, status: 'active' }, { ...own, url: 'https://other.example.com/atmark' }), { purpose: 'replace' }, false],
    ];
    for (const [deps, override, ok] of cases) {
      const result = (await createApiHandler(() => Promise.resolve({ deps, pool: {} as never }))({ ...SEAL, ...override }, context())) as Record<string, unknown>;
      if (ok) expect(result).toMatchObject({ ok: true });
      else expect(result, JSON.stringify(override)).toEqual({ ok: false, error: 'not_eligible' });
    }
  });

  it('규칙 위반 → invalid_authorization · URL 거부 → invalid_url', async () => {
    const handler = createApiHandler(() => Promise.resolve({ deps: noDb, pool: {} as never }));
    await expect(handler({ ...SEAL, authorization: 'Bearer x\r\nHost: evil' }, context())).resolves.toEqual({ ok: false, error: 'invalid_authorization' });
    await expect(handler({ ...SEAL, url: 'http://hooks.example.com/' }, context())).resolves.toEqual({ ok: false, error: 'invalid_url' });
    await expect(handler({ ...SEAL, url: 'https://10.0.0.1/' }, context())).resolves.toEqual({ ok: false, error: 'invalid_url' });
  });

  it('issuer.sealAuthorization — 입력 모양 · 결과 해석 · 거절 이유', async () => {
    const sealed = `v1.${'A'.repeat(16)}.${'B'.repeat(40)}`;
    const ok = fakeClient(() => reply({ ok: true, url: 'https://hooks.example.com/atmark', kid: 'w1', sealed, hint: 'Bearer …WXYZ', generation: 2 }));
    const issuer = createWebhookSecretIssuer({ client: ok.client, functionArn: API_ARN });
    const target = { agentId: AGENT, organizationId: ORG, endpointId: ENDPOINT, url: 'https://hooks.example.com/atmark', purpose: 'replace' as const };
    expect(await issuer.sealAuthorization(target, 'Bearer t')).toEqual({
      url: 'https://hooks.example.com/atmark',
      kid: 'w1',
      sealed,
      hint: 'Bearer …WXYZ',
      generation: 2,
    });
    expect(parseInternalApiEvent(JSON.parse(new TextDecoder().decode(ok.sent[0]?.input.Payload as Uint8Array)))).toMatchObject({ kind: 'webhook.sealAuthorization' });
    for (const [body, reason] of [
      [{ ok: false, error: 'invalid_authorization' }, 'invalid_authorization'],
      [{ ok: false, error: 'invalid_url' }, 'invalid_url'],
      [{ ok: false, error: 'not_eligible' }, 'not_eligible'],
      [{ ok: true, url: 'x', kid: 'w1', sealed: 'plain', hint: 'h', generation: 1 }, 'malformed'],
      [{ ok: true, url: 'x', kid: 'w1', sealed: `v1.${'A'.repeat(16)}.${'B'.repeat(40)}`, hint: 'h', generation: 0 }, 'malformed'],
    ] as const) {
      const failing = createWebhookSecretIssuer({ client: fakeClient(() => reply(body)).client, functionArn: API_ARN });
      const error = await failing.sealAuthorization(target, 'Bearer t').then(() => null, (thrown: unknown) => thrown);
      expect((error as WebhookSecretIssueError).reason, reason).toBe(reason);
    }
  });
});
