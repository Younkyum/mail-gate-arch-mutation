/**
 * `src/runtime/composition.ts` · `config.ts` — **운영 조립 루트의 fail-closed 와 경계.**
 *
 * AWS 호출 0: 비밀은 가짜 `SecretReader`, S3·SES 는 가짜 클라이언트(부르면 던진다). 풀은 만들기만 하고 접속하지
 * 않는다(설정만 본다). 겨냥한 방어:
 *   - ★ 운영이 아니면 · 로컬 개발 변수(평문 비밀)가 있으면 · 필수 변수·비밀이 없으면 **던진다**(조용한 기본값 없음).
 *   - ★ 풀은 TLS(`rejectUnauthorized: true`) · CA 번들 필수 · `max` 작게.
 *   - 대조 변수(Configuration Set)가 코드 상수와 다르면 던진다 · 승인 링크 호스트는 환경 변수로 들어오지 않는다.
 *   - 오류 메시지에 비밀 값이 없다.
 *   - 조립은 실행 환경당 1회(`memoize`) — 실패는 캐시하지 않는다.
 *   - ★ 조립 루트는 전송단을 **만들기만** 하고 부르지 않는다(AST) · 로컬 구현을 import 폐포에 두지 않는다.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Node, SyntaxKind, type SourceFile } from 'ts-morph';
import type { Pool } from 'pg';

import { APP_ROLE } from '../../../src/db/migrate';
import {
  composeApi,
  composeApprovalExpiry,
  composeApprovalNotifier,
  composeApprovalRelease,
  composeInboundConsumer,
  composeMigration,
  composeRoleBootstrap,
  composeScheduledSender,
  composeSesEventConsumer,
  composeWebhookDispatcher,
  DB_POOL_MAX,
  type Composed,
  type RuntimeClients,
  type RuntimePlatform,
} from '../../../src/runtime/composition';
import {
  accountIdFromFunctionArn,
  databaseUrlOf,
  FORBIDDEN_PRODUCTION_ENV,
  parseDatabaseSecret,
  readBillingEnabled,
  readPaddleEnvironment,
  requireProductionRuntime,
  RUNTIME_ENV,
  RuntimeConfigError,
} from '../../../src/runtime/config';
import { HEALTH_APP_ROLE } from '../../../src/runtime/health';
import { memoize } from '../../../src/runtime/lambda';
import { SecretNotFoundError } from '../../../src/runtime/secrets';
import { getProject, toRepoRelative } from '../../arch/support/project';

// ts-morph 프로젝트(tsconfig 전체)를 파일 첫 테스트 전에 한 번 적재한다. 적재는 동기 CPU 작업이라 수 초, 전체 unit 실행의 부하 아래서는
// 13–21s 걸렸고, 그 값을 처음 부른 테스트(승인 페이지 URL · 정적 경계 첫 건)가 제 상한(5s)으로 떠안아 거짓 빨강이 났다(2026-09-28 재현).
// 여기서 명시 상한(60s — 커버리지 실행 상한과 같다)으로 치르면 각 테스트는 캐시된 프로젝트(`getProject`)만 읽는다.
beforeAll(() => {
  getProject();
}, 60_000);

const ARN = 'arn:aws:lambda:ap-northeast-2:123456789012:function:atmark-api';
const APP_SECRET = 'arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:atmark/db/app';
const OWNER_SECRET = 'arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:atmark/db/owner';
const LINK_SECRET = 'arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:atmark/link-keys';
const HOOK_SECRET = 'arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:atmark/webhook-keys';
const LOGIN_SECRET = 'arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:atmark/owner-login-keys';
const MASTER_SECRET = 'arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:atmark/db/master';
const ADMIN_DB_SECRET = 'arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:atmark/db/admin';
const MAILER_DB_SECRET = 'arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:atmark/db/login-mailer';
const SIGNER_DB_SECRET = 'arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:atmark/db/passport-signer';
const TLOG_DB_SECRET = 'arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:atmark/db/tlog';
const TLOG_ANCHOR_DB_SECRET = 'arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:atmark/db/tlog-anchor';
const BILLING_DB_SECRET = 'arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:atmark/db/billing';
const BILLING_OPERATOR_DB_SECRET = 'arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:atmark/db/billing-operator';
const OPS_DB_SECRET = 'arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:atmark/db/ops';
const DOMAIN_TICK_DB_SECRET = 'arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:atmark/db/domain-tick';
const AI_WATCH_DB_SECRET = 'arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:atmark/db/ai-watch';
const DLP_SECRET = 'arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:atmark/dlp-keys';
/** CloudFormation `generateSecretString`(64자 영숫자)과 같은 모양 — 런타임이 kid `g1` 로 읽는다(ADR-0016). */
const DLP_GENERATED = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2W3x4Y5z6a7B8c9D0e1F2';
const PASSWORD = 'p@ss/w0rd:hunter2';
/** `infra/cdk/stacks/data-stack.ts` 의 `SECRET_PLACEHOLDER_VALUE` 와 같은 모양. */
const PLACEHOLDER = JSON.stringify({ _unset: 'placeholder - filled by migrate handler or deploy runbook' });

const CA_DIR = mkdtempSync(join(tmpdir(), 'atmark-ca-'));
const CA_FILE = join(CA_DIR, 'ca-cert.pem');
writeFileSync(CA_FILE, '-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----\n');

function keyring(): string {
  return `k1:${randomBytes(32).toString('base64url')}`;
}

const SECRETS: Readonly<Record<string, string>> = {
  [APP_SECRET]: JSON.stringify({ host: 'db.internal', port: 5432, dbname: 'atmark', username: 'atmark_app', password: PASSWORD, engine: 'postgres' }),
  [OWNER_SECRET]: JSON.stringify({ host: 'db.internal', port: '5432', dbname: 'atmark', username: 'atmark_owner', password: PASSWORD }),
  [LINK_SECRET]: keyring(),
  [HOOK_SECRET]: keyring(),
  [LOGIN_SECRET]: keyring(),
  [MASTER_SECRET]: JSON.stringify({ host: 'db.internal', port: 5432, dbname: 'atmark', username: 'atmark_master', password: PASSWORD, engine: 'postgres', dbInstanceIdentifier: 'x' }),
  [ADMIN_DB_SECRET]: JSON.stringify({ host: 'db.internal', port: 5432, dbname: 'atmark', username: 'atmark_admin', password: PASSWORD }),
  [MAILER_DB_SECRET]: JSON.stringify({ host: 'db.internal', port: 5432, dbname: 'atmark', username: 'atmark_login_mailer', password: PASSWORD }),
  [SIGNER_DB_SECRET]: JSON.stringify({ host: 'db.internal', port: 5432, dbname: 'atmark', username: 'atmark_passport_signer', password: PASSWORD }),
  [TLOG_DB_SECRET]: JSON.stringify({ host: 'db.internal', port: 5432, dbname: 'atmark', username: 'atmark_tlog', password: PASSWORD }),
  [TLOG_ANCHOR_DB_SECRET]: JSON.stringify({ host: 'db.internal', port: 5432, dbname: 'atmark', username: 'atmark_tlog_anchor', password: PASSWORD }),
  [BILLING_DB_SECRET]: JSON.stringify({ host: 'db.internal', port: 5432, dbname: 'atmark', username: 'atmark_billing', password: PASSWORD }),
  [BILLING_OPERATOR_DB_SECRET]: JSON.stringify({ host: 'db.internal', port: 5432, dbname: 'atmark', username: 'atmark_billing_operator', password: PASSWORD }),
  [OPS_DB_SECRET]: JSON.stringify({ host: 'db.internal', port: 5432, dbname: 'atmark', username: 'atmark_ops', password: PASSWORD }),
  [DOMAIN_TICK_DB_SECRET]: JSON.stringify({ host: 'db.internal', port: 5432, dbname: 'atmark', username: 'atmark_domain_tick', password: PASSWORD }),
  [AI_WATCH_DB_SECRET]: JSON.stringify({ host: 'db.internal', port: 5432, dbname: 'atmark', username: 'atmark_ai_watch', password: PASSWORD }),
  [DLP_SECRET]: DLP_GENERATED,
};

function productionEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {
    [RUNTIME_ENV.environment]: 'production',
    [RUNTIME_ENV.region]: 'ap-northeast-2',
    [RUNTIME_ENV.dbSecretArn]: APP_SECRET,
    [RUNTIME_ENV.dbMigrationSecretArn]: OWNER_SECRET,
    [RUNTIME_ENV.dbMasterSecretArn]: MASTER_SECRET,
    [RUNTIME_ENV.dbAdminSecretArn]: ADMIN_DB_SECRET,
    [RUNTIME_ENV.dbLoginMailerSecretArn]: MAILER_DB_SECRET,
    [RUNTIME_ENV.dbPassportSignerSecretArn]: SIGNER_DB_SECRET,
    [RUNTIME_ENV.dbTlogSecretArn]: TLOG_DB_SECRET,
    [RUNTIME_ENV.dbTlogAnchorSecretArn]: TLOG_ANCHOR_DB_SECRET,
    [RUNTIME_ENV.dbBillingSecretArn]: BILLING_DB_SECRET,
    [RUNTIME_ENV.dbBillingOperatorSecretArn]: BILLING_OPERATOR_DB_SECRET,
    [RUNTIME_ENV.dbOpsSecretArn]: OPS_DB_SECRET,
    [RUNTIME_ENV.dbDomainTickSecretArn]: DOMAIN_TICK_DB_SECRET,
    [RUNTIME_ENV.dbAiWatchSecretArn]: AI_WATCH_DB_SECRET,
    [RUNTIME_ENV.mailBucket]: 'atmark-mail-store',
    [RUNTIME_ENV.sesConfigurationSet]: 'atmark-default',
    [RUNTIME_ENV.approvalLinkKeysSecretArn]: LINK_SECRET,
    [RUNTIME_ENV.webhookSecretKeysSecretArn]: HOOK_SECRET,
    [RUNTIME_ENV.ownerLoginKeysSecretArn]: LOGIN_SECRET,
    [RUNTIME_ENV.dlpKeysSecretArn]: DLP_SECRET,
    [RUNTIME_ENV.extraCaCerts]: CA_FILE,
    ...overrides,
  };
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined));
}

interface FakeClients extends RuntimeClients {
  readonly reads: string[];
  readonly writes: { readonly id: string; readonly value: string }[];
}

function fakeClients(secrets: Readonly<Record<string, string>> = SECRETS): FakeClients {
  const reads: string[] = [];
  const writes: { readonly id: string; readonly value: string }[] = [];
  const refuse = (): never => {
    throw new Error('AWS 호출 금지 — 조립은 S3·SES 를 부르지 않는다');
  };
  return {
    reads,
    writes,
    secretWriter: {
      putSecretString(id: string, value: string): Promise<void> {
        writes.push({ id, value });
        return Promise.resolve();
      },
    },
    secrets: {
      readSecretString(secretId: string): Promise<string> {
        reads.push(secretId);
        const value = secrets[secretId];
        return value === undefined ? Promise.reject(new Error(`no secret ${secretId}`)) : Promise.resolve(value);
      },
    },
    s3: { send: refuse } as unknown as RuntimeClients['s3'],
    s3Attachments: { send: refuse } as unknown as RuntimeClients['s3Attachments'],
    ses: { send: refuse } as unknown as RuntimeClients['ses'],
    aiWatchQueue: { send: refuse },
    lambda: { send: refuse },
    realtime: { post: refuse },
  };
}

function platform(env: NodeJS.ProcessEnv, clients: FakeClients = fakeClients()): RuntimePlatform {
  return { env, invokedFunctionArn: ARN, clients };
}

const opened: Pool[] = [];
async function track<T>(composed: Promise<Composed<T>>): Promise<Composed<T>> {
  const result = await composed;
  opened.push(result.pool);
  return result;
}

afterEach(async () => {
  await Promise.all(opened.splice(0).map((pool) => pool.end()));
});

const ALL = [
  ['api', composeApi],
  ['inbound', composeInboundConsumer],
  ['ses-events', composeSesEventConsumer],
  ['approval-release', composeApprovalRelease],
  ['approval-notifier', composeApprovalNotifier],
  ['approval-expiry', composeApprovalExpiry],
  ['webhook-dispatcher', composeWebhookDispatcher],
  ['scheduled-sender', composeScheduledSender],
  ['migrate', composeMigration],
] as const;

// ---------------------------------------------------------------------------

describe('★ 운영 가드 — 운영이 아니거나 로컬 흔적이 있으면 기동하지 않는다', () => {
  it.each([undefined, 'development', 'prod', 'PRODUCTION '])('ATMARK_ENV=%s → 던진다', (value) => {
    expect(() => requireProductionRuntime(productionEnv({ [RUNTIME_ENV.environment]: value }))).toThrow(RuntimeConfigError);
  });

  it.each(FORBIDDEN_PRODUCTION_ENV)('%s 가 있으면 던진다 — 값은 메시지에 없다', (name) => {
    const value = 'postgres://atmark_app:hunter2@localhost/atmark';
    let message = '';
    try {
      requireProductionRuntime(productionEnv({ [name]: value }));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(name);
    expect(message).not.toContain('hunter2');
  });

  it.each(ALL)('%s — 운영이 아니면 비밀을 한 번도 읽지 않고 던진다', async (_name, compose) => {
    const clients = fakeClients();
    await expect(compose(platform(productionEnv({ [RUNTIME_ENV.environment]: undefined }), clients))).rejects.toThrow(
      RuntimeConfigError,
    );
    expect(clients.reads).toEqual([]);
  });
});

describe('★ 필수 변수·비밀이 없으면 던진다 (조용한 기본값 없음)', () => {
  const REQUIRED: readonly (readonly [string, readonly string[]])[] = [
    ['api', [RUNTIME_ENV.region, RUNTIME_ENV.dbSecretArn, RUNTIME_ENV.mailBucket, RUNTIME_ENV.sesConfigurationSet, RUNTIME_ENV.approvalLinkKeysSecretArn, RUNTIME_ENV.webhookSecretKeysSecretArn, RUNTIME_ENV.extraCaCerts]],
    ['inbound', [RUNTIME_ENV.region, RUNTIME_ENV.dbSecretArn, RUNTIME_ENV.mailBucket, RUNTIME_ENV.extraCaCerts]],
    ['ses-events', [RUNTIME_ENV.region, RUNTIME_ENV.dbSecretArn, RUNTIME_ENV.extraCaCerts]],
    ['approval-release', [RUNTIME_ENV.region, RUNTIME_ENV.dbSecretArn, RUNTIME_ENV.mailBucket, RUNTIME_ENV.sesConfigurationSet, RUNTIME_ENV.extraCaCerts]],
    ['approval-notifier', [RUNTIME_ENV.region, RUNTIME_ENV.dbSecretArn, RUNTIME_ENV.sesConfigurationSet, RUNTIME_ENV.approvalLinkKeysSecretArn, RUNTIME_ENV.extraCaCerts]],
    ['approval-expiry', [RUNTIME_ENV.region, RUNTIME_ENV.dbSecretArn, RUNTIME_ENV.extraCaCerts]],
    ['webhook-dispatcher', [RUNTIME_ENV.region, RUNTIME_ENV.dbSecretArn, RUNTIME_ENV.webhookSecretKeysSecretArn, RUNTIME_ENV.extraCaCerts]],
    ['scheduled-sender', [RUNTIME_ENV.region, RUNTIME_ENV.dbSecretArn, RUNTIME_ENV.mailBucket, RUNTIME_ENV.sesConfigurationSet, RUNTIME_ENV.extraCaCerts]],
    ['migrate', [RUNTIME_ENV.region, RUNTIME_ENV.dbMigrationSecretArn, RUNTIME_ENV.extraCaCerts]],
  ];

  it('표가 조립 함수 전부를 덮는다', () => {
    expect(REQUIRED.map(([name]) => name)).toEqual(ALL.map(([name]) => name));
  });

  for (const [name, variables] of REQUIRED) {
    const compose = ALL.find(([candidate]) => candidate === name)?.[1];
    if (compose === undefined) throw new Error(name);

    it.each(variables)(`${name} — %s 가 없으면 던지고 메시지가 그 이름을 댄다`, async (variable) => {
      await expect(compose(platform(productionEnv({ [variable]: undefined })))).rejects.toThrow(variable);
    });

    it(`${name} — 모든 변수·비밀이 있으면 조립된다(접속은 하지 않는다)`, async () => {
      const composed = await track(compose(platform(productionEnv())) as Promise<Composed<unknown>>);
      expect(composed.pool.totalCount).toBe(0);
    });
  }

  it('CA 번들 경로가 실재하지 않으면 던진다 — TLS 검증 없이 접속하지 않는다', async () => {
    await expect(
      composeSesEventConsumer(platform(productionEnv({ [RUNTIME_ENV.extraCaCerts]: join(CA_DIR, 'missing.pem') }))),
    ).rejects.toThrow(RUNTIME_ENV.extraCaCerts);
  });

  it('비밀 ARN 은 있는데 비밀이 없으면(Secrets Manager 거부) 던진다', async () => {
    await expect(composeSesEventConsumer(platform(productionEnv(), fakeClients({})))).rejects.toThrow();
  });

  it('계정 ID 를 호출 ARN 에서 읽지 못하면 버킷을 조립하지 않는다', async () => {
    await expect(
      composeInboundConsumer({ env: productionEnv(), invokedFunctionArn: 'not-an-arn', clients: fakeClients() }),
    ).rejects.toThrow(RuntimeConfigError);
  });
});

describe('대조 변수 — 설정이 아니라 코드 상수와의 대조다 · 승인 링크 호스트는 주입 불가', () => {
  it('Configuration Set 이 atmark-default 가 아니면 던진다(에이전트·알림 전송단이 갈라지지 않게)', async () => {
    await expect(
      composeApprovalRelease(platform(productionEnv({ [RUNTIME_ENV.sesConfigurationSet]: 'other-set' }))),
    ).rejects.toThrow(RUNTIME_ENV.sesConfigurationSet);
  });

  it('승인 페이지 URL 은 환경 변수로 들어올 자리가 없다 — 알림 모듈의 상수다(주입 불가)', async () => {
    // 어떤 값이 와도 조립은 그 값을 읽지 않는다: 링크 호스트는 `notify/approval-notifier.ts` 의 상수.
    const composed = await track(
      composeApprovalNotifier(platform(productionEnv({ ATMARK_APPROVAL_PAGE_URL: 'https://evil.example/approve' }))),
    );
    expect(composed.deps.notifier).toBeDefined();
    const text = source(COMPOSITION).getFullText();
    expect(text).not.toContain('ATMARK_APPROVAL_PAGE_URL');
    expect(text).not.toMatch(/\bAPPROVAL_PAGE_URL\b/);
  });
});

describe('결제 변수(WP-2) — 계약 값 정확히, 별칭·조용한 기본값 없음', () => {
  it('Paddle 환경은 sandbox | production 만 받는다', () => {
    expect(readPaddleEnvironment({ [RUNTIME_ENV.paddleEnvironment]: 'sandbox' })).toBe('sandbox');
    expect(readPaddleEnvironment({ [RUNTIME_ENV.paddleEnvironment]: 'production' })).toBe('production');
    for (const value of [undefined, '', ' ', 'Production', 'prod', 'live', 'sandbox,production']) {
      expect(() => readPaddleEnvironment({ [RUNTIME_ENV.paddleEnvironment]: value })).toThrow(RuntimeConfigError);
    }
  });

  it('결제 스위치는 true | false 만 받는다 — 오타는 꺼짐도 켜짐도 아니다', () => {
    expect(readBillingEnabled({ [RUNTIME_ENV.billingEnabled]: 'true' })).toBe(true);
    expect(readBillingEnabled({ [RUNTIME_ENV.billingEnabled]: 'false' })).toBe(false);
    for (const value of [undefined, '', '1', '0', 'TRUE', 'yes', 'ture']) {
      expect(() => readBillingEnabled({ [RUNTIME_ENV.billingEnabled]: value })).toThrow(RuntimeConfigError);
    }
  });

  it('결제 변수 이름은 서로 겹치지 않고 기존 계약과도 겹치지 않는다', () => {
    const names = Object.values(RUNTIME_ENV);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('★ DB 풀 — TLS 필수 · 작게 · 앱 롤/소유자 롤 분리', () => {
  it('앱 풀: ssl.rejectUnauthorized=true · max=DB_POOL_MAX · 앱 롤 비밀만 읽는다', async () => {
    const clients = fakeClients();
    const composed = await track(composeSesEventConsumer(platform(productionEnv(), clients)));
    const options = (composed.pool as unknown as { options: Record<string, unknown> }).options;
    expect(options['ssl']).toEqual({ rejectUnauthorized: true });
    expect(options['max']).toBe(DB_POOL_MAX);
    expect(DB_POOL_MAX).toBeLessThanOrEqual(3);
    expect(clients.reads).toEqual([APP_SECRET]);
    // 비밀번호의 특수문자가 URL 인코딩돼 호스트를 바꾸지 않는다.
    expect(String(options['connectionString'])).toContain('@db.internal:5432/atmark');
  });

  it('migrate: 소유자 롤 비밀만 읽는다 — 앱 롤 비밀은 읽지 않는다 · max=1', async () => {
    const clients = fakeClients();
    const composed = await track(composeMigration(platform(productionEnv(), clients)));
    expect(clients.reads).toEqual([OWNER_SECRET]);
    const options = (composed.pool as unknown as { options: Record<string, unknown> }).options;
    expect(options['max']).toBe(1);
    expect(options['ssl']).toEqual({ rejectUnauthorized: true });
  });

  it('API: 비밀 셋(키링 둘 + 앱 DB)을 각각 한 번씩 읽는다', async () => {
    const clients = fakeClients();
    await track(composeApi(platform(productionEnv(), clients)));
    expect([...clients.reads].sort()).toEqual([APP_SECRET, DLP_SECRET, HOOK_SECRET, LINK_SECRET].sort());
  });

  it('ADR-0016 — DLP 지문 키: 생성 형식(64자 영숫자)·키 묶음 형식을 읽는다 · 자리표시면 던진다 · 수신·발송 조립만 읽는다', async () => {
    for (const compose of [composeApi, composeApprovalRelease, composeScheduledSender, composeInboundConsumer]) {
      const clients = fakeClients();
      await track(compose(platform(productionEnv(), clients)) as Promise<Composed<unknown>>);
      expect(clients.reads, compose.name).toContain(DLP_SECRET);
    }
    for (const compose of [composeApprovalNotifier, composeApprovalExpiry, composeSesEventConsumer]) {
      const clients = fakeClients();
      await track(compose(platform(productionEnv(), clients)) as Promise<Composed<unknown>>);
      expect(clients.reads, compose.name).not.toContain(DLP_SECRET);
    }
    const ring = fakeClients({ ...SECRETS, [DLP_SECRET]: `k2:${randomBytes(32).toString('base64url')},${'g1'}:${DLP_GENERATED}` });
    const composed = await track(composeInboundConsumer(platform(productionEnv(), ring)));
    expect(composed.deps.dlpKeys.activeKid).toBe('k2');
    expect([...composed.deps.dlpKeys.keys.keys()].sort()).toEqual(['g1', 'k2']);
    const generated = await track(composeInboundConsumer(platform(productionEnv(), fakeClients())));
    expect(generated.deps.dlpKeys.activeKid).toBe('g1');
    await expect(composeInboundConsumer(platform(productionEnv(), fakeClients({ ...SECRETS, [DLP_SECRET]: PLACEHOLDER })))).rejects.toThrow(/ATMARK_DLP_KEYS_SECRET_ARN/);
  });

  it('★ H1: 발송 역할 조립(api·approval-notifier·approval-release·scheduled-sender)은 로그인 키 비밀을 읽지 않는다', async () => {
    for (const compose of [composeApi, composeApprovalNotifier, composeApprovalRelease, composeScheduledSender]) {
      const clients = fakeClients();
      await track(compose(platform(productionEnv(), clients)) as Promise<Composed<unknown>>);
      expect(clients.reads, compose.name).not.toContain(LOGIN_SECRET);
      expect(clients.reads, compose.name).not.toContain(ADMIN_DB_SECRET);
      expect(clients.reads, compose.name).not.toContain(MAILER_DB_SECRET);
    }
    // 조립 루트 파일에 로그인 키 변수·로그인 알림기가 없다(ADR-0006 — login-mailer-composition.ts 로 옮겼다).
    const text = source(COMPOSITION).getFullText();
    expect(text).not.toContain('ownerLoginKeysSecretArn');
    expect(text).not.toContain('createOwnerLoginNotifier');
  });

  it('DB 비밀 형식 오류는 던지되 비밀번호를 싣지 않는다', () => {
    const bad = JSON.stringify({ host: 'h', port: 'x', dbname: 'd', username: 'u', password: PASSWORD });
    expect(() => parseDatabaseSecret(bad, 'L')).toThrow(/port/);
    try {
      parseDatabaseSecret(bad, 'L');
    } catch (error) {
      expect((error as Error).message).not.toContain('hunter2');
    }
    expect(() => parseDatabaseSecret('not json hunter2', 'L')).toThrow(/JSON/);
    expect(() => parseDatabaseSecret(JSON.stringify({ host: 'h', port: 5432, dbname: 'd', username: 'u' }), 'L')).toThrow(/password/);
  });

  it('키링 비밀 형식 오류는 던지되 키를 싣지 않는다', async () => {
    const weak = 'k1:c2hvcnQ'; // 32바이트 미만
    await expect(
      composeWebhookDispatcher(platform(productionEnv(), fakeClients({ ...SECRETS, [HOOK_SECRET]: weak }))),
    ).rejects.toThrow(/32바이트/);
  });

  it('databaseUrlOf 는 사용자·비밀번호·DB 이름을 인코딩한다', () => {
    const url = databaseUrlOf({ host: 'h', port: 1, dbname: 'a/b', username: 'u@x', password: 'p@:/' });
    expect(url).toBe('postgres://u%40x:p%40%3A%2F@h:1/a%2Fb');
  });

  it('accountIdFromFunctionArn — 12자리 계정만', () => {
    expect(accountIdFromFunctionArn(ARN)).toBe('123456789012');
    expect(() => accountIdFromFunctionArn('arn:aws:lambda:ap-northeast-2:1234:function:x')).toThrow(RuntimeConfigError);
    expect(() => accountIdFromFunctionArn('arn:aws:s3:::bucket')).toThrow(RuntimeConfigError);
  });

  it('헬스 프로브의 앱 롤 이름은 마이그레이션의 APP_ROLE 과 같다', () => {
    expect(HEALTH_APP_ROLE).toBe(APP_ROLE);
  });
});

describe('★ placeholder 비밀 — 런타임은 거부하고, 부트스트랩만 "비었다" 로 읽는다', () => {
  it('앱 DB 비밀이 placeholder 면 조립이 던진다(부트스트랩을 먼저 하라는 문장)', async () => {
    await expect(
      composeSesEventConsumer(platform(productionEnv(), fakeClients({ ...SECRETS, [APP_SECRET]: PLACEHOLDER }))),
    ).rejects.toThrow(/placeholder/);
  });

  it('키링 비밀이 placeholder 면 조립이 던진다', async () => {
    await expect(
      composeWebhookDispatcher(platform(productionEnv(), fakeClients({ ...SECRETS, [HOOK_SECRET]: PLACEHOLDER }))),
    ).rejects.toThrow(/placeholder/);
  });

  it('부트스트랩: 롤 비밀이 placeholder 면 filled=false · 마스터 풀(max 1, TLS) · 쓰기는 조립에서 하지 않는다', async () => {
    const clients = fakeClients({
      ...SECRETS,
      [APP_SECRET]: PLACEHOLDER,
      [OWNER_SECRET]: PLACEHOLDER,
      [ADMIN_DB_SECRET]: PLACEHOLDER,
      [MAILER_DB_SECRET]: PLACEHOLDER,
      [SIGNER_DB_SECRET]: PLACEHOLDER,
      [BILLING_OPERATOR_DB_SECRET]: PLACEHOLDER,
      [OPS_DB_SECRET]: PLACEHOLDER,
      [DOMAIN_TICK_DB_SECRET]: PLACEHOLDER,
      [AI_WATCH_DB_SECRET]: PLACEHOLDER,
    });
    const composed = await track(composeRoleBootstrap(platform(productionEnv(), clients)));
    expect(composed.deps).toMatchObject({
      ownerFilled: false,
      appFilled: false,
      adminFilled: false,
      loginMailerFilled: false,
      passportSignerFilled: false,
      billingFilled: true,
      billingOperatorFilled: false,
      opsFilled: false,
      domainTickFilled: false,
      aiWatchFilled: false,
      adminSecretArn: ADMIN_DB_SECRET,
      loginMailerSecretArn: MAILER_DB_SECRET,
      passportSignerSecretArn: SIGNER_DB_SECRET,
      billingSecretArn: BILLING_DB_SECRET,
      billingOperatorSecretArn: BILLING_OPERATOR_DB_SECRET,
      opsSecretArn: OPS_DB_SECRET,
      domainTickSecretArn: DOMAIN_TICK_DB_SECRET,
      aiWatchSecretArn: AI_WATCH_DB_SECRET,
    });
    expect(composed.deps.master).toEqual({ host: 'db.internal', port: 5432, dbname: 'atmark', username: 'atmark_master' });
    expect(composed.deps).not.toHaveProperty('master.password');
    const options = (composed.pool as unknown as { options: Record<string, unknown> }).options;
    expect(options['max']).toBe(1);
    expect(options['ssl']).toEqual({ rejectUnauthorized: true });
    expect(clients.writes).toEqual([]);
  });

  it('부트스트랩: 이미 채워진(그 롤의) 비밀은 filled=true — 회전하지 않는다', async () => {
    const composed = await track(composeRoleBootstrap(platform(productionEnv())));
    expect(composed.deps).toMatchObject({
      ownerFilled: true,
      appFilled: true,
      adminFilled: true,
      loginMailerFilled: true,
      passportSignerFilled: true,
      billingFilled: true,
      billingOperatorFilled: true,
      opsFilled: true,
      domainTickFilled: true,
      aiWatchFilled: true,
    });
  });

  it('부트스트랩: 제한 롤 비밀 ARN 이 없으면 던진다 · 채워진 비밀이 다른 롤이면 던진다', async () => {
    for (const variable of [
      RUNTIME_ENV.dbAdminSecretArn,
      RUNTIME_ENV.dbLoginMailerSecretArn,
      RUNTIME_ENV.dbPassportSignerSecretArn,
      RUNTIME_ENV.dbBillingSecretArn,
      RUNTIME_ENV.dbBillingOperatorSecretArn,
      RUNTIME_ENV.dbOpsSecretArn,
      RUNTIME_ENV.dbDomainTickSecretArn,
      RUNTIME_ENV.dbAiWatchSecretArn,
    ]) {
      await expect(composeRoleBootstrap(platform(productionEnv({ [variable]: undefined })))).rejects.toThrow(variable);
    }
    // admin 비밀에 소유자 롤을 넣은 실수 — "이미 됐다" 로 넘기지 않는다(admin 이 소유자로 붙는 H2 의 재발).
    await expect(
      composeRoleBootstrap(platform(productionEnv(), fakeClients({ ...SECRETS, [ADMIN_DB_SECRET]: SECRETS[OWNER_SECRET] ?? '' }))),
    ).rejects.toThrow(RuntimeConfigError);
    // 결제 운영자 비밀에 동기화 롤을 넣은 실수 — 두 결제 롤이 서로의 자격으로 붙지 않는다(출처-롤 가드의 전제).
    await expect(
      composeRoleBootstrap(platform(productionEnv(), fakeClients({ ...SECRETS, [BILLING_OPERATOR_DB_SECRET]: SECRETS[BILLING_DB_SECRET] ?? '' }))),
    ).rejects.toThrow(RuntimeConfigError);
  });

  it('부트스트랩: 채워진 비밀이 다른 롤을 가리키면 던진다(손으로 잘못 넣은 값)', async () => {
    const wrong = JSON.stringify({ host: 'db.internal', port: 5432, dbname: 'atmark', username: 'atmark_master', password: PASSWORD });
    await expect(
      composeRoleBootstrap(platform(productionEnv(), fakeClients({ ...SECRETS, [APP_SECRET]: wrong }))),
    ).rejects.toThrow(RuntimeConfigError);
  });

  it('부트스트랩: 마스터 비밀 ARN 이 없거나 마스터 비밀이 placeholder 면 던진다', async () => {
    await expect(composeRoleBootstrap(platform(productionEnv({ [RUNTIME_ENV.dbMasterSecretArn]: undefined })))).rejects.toThrow(
      RUNTIME_ENV.dbMasterSecretArn,
    );
    await expect(
      composeRoleBootstrap(platform(productionEnv(), fakeClients({ ...SECRETS, [MASTER_SECRET]: PLACEHOLDER }))),
    ).rejects.toThrow(/placeholder/);
  });

  // 2026-10-12 비밀 → SSM 이전(배포 런북 §49) — 롤 비밀 자리가 SSM 이름(`/atmark/db/…`)일 때.
  describe('부트스트랩 × SSM 자리 — 비었고 옛 Secrets Manager 값이 있으면 재생성하지 않고 실패', () => {
    const SSM_APP = '/atmark/db/app';
    const LEGACY_APP = 'atmark/db/app';
    /** 없는 이름은 `SecretNotFoundError`(실제 reader 와 같다). */
    function ssmClients(secrets: Readonly<Record<string, string>>, broken: readonly string[] = []): FakeClients {
      const base = fakeClients(secrets);
      return {
        ...base,
        secrets: {
          readSecretString(secretId: string): Promise<string> {
            base.reads.push(secretId);
            if (broken.includes(secretId)) return Promise.reject(new Error(`AccessDenied ${secretId}`));
            const value = secrets[secretId];
            return value === undefined ? Promise.reject(new SecretNotFoundError(`no ${secretId}`)) : Promise.resolve(value);
          },
        },
      };
    }
    const env = (): NodeJS.ProcessEnv => productionEnv({ [RUNTIME_ENV.dbSecretArn]: SSM_APP });
    const { [APP_SECRET]: appValue, ...withoutApp } = SECRETS;

    it('SSM 자리에 값이 있으면 그대로 읽는다(filled) — 옛 자리는 읽지 않는다', async () => {
      const clients = ssmClients({ ...withoutApp, [SSM_APP]: appValue ?? '' });
      const composed = await track(composeRoleBootstrap(platform(env(), clients)));
      expect(composed.deps).toMatchObject({ appFilled: true, appSecretArn: SSM_APP });
      expect(clients.reads).toContain(SSM_APP);
      expect(clients.reads).not.toContain(LEGACY_APP);
    });

    it('★ SSM 자리가 없고 옛 자리에 채워진 값이 있으면 던진다 — 이전 스크립트를 먼저(비밀번호를 새로 만들지 않는다)', async () => {
      const clients = ssmClients({ ...withoutApp, [LEGACY_APP]: appValue ?? '' });
      const failure = composeRoleBootstrap(platform(env(), clients));
      await expect(failure).rejects.toThrow(RuntimeConfigError);
      await expect(composeRoleBootstrap(platform(env(), ssmClients({ ...withoutApp, [LEGACY_APP]: appValue ?? '' })))).rejects.toThrow(
        /secrets-to-ssm\.sh/,
      );
      expect(clients.writes).toEqual([]);
      // 오류 문장에 값(비밀번호)이 없다.
      await expect(failure).rejects.not.toThrow(PASSWORD);
    });

    it('SSM 자리가 없고 옛 자리도 없거나 자리표시면 비었다(filled=false) — 부트스트랩이 새로 만든다', async () => {
      for (const legacy of [{}, { [LEGACY_APP]: PLACEHOLDER }]) {
        const composed = await track(composeRoleBootstrap(platform(env(), ssmClients({ ...withoutApp, ...legacy }))));
        expect(composed.deps).toMatchObject({ appFilled: false, appSecretArn: SSM_APP });
      }
    });

    it('★ SSM 자리가 자리표시여도 옛 자리에 채워진 값이 있으면 던진다 · 옛 자리도 비었으면 비었다(filled=false)', async () => {
      await expect(
        composeRoleBootstrap(platform(env(), ssmClients({ ...withoutApp, [SSM_APP]: PLACEHOLDER, [LEGACY_APP]: appValue ?? '' }))),
      ).rejects.toThrow(/secrets-to-ssm\.sh/);
      for (const legacy of [{}, { [LEGACY_APP]: PLACEHOLDER }]) {
        const clients = ssmClients({ ...withoutApp, [SSM_APP]: PLACEHOLDER, ...legacy });
        const composed = await track(composeRoleBootstrap(platform(env(), clients)));
        expect(composed.deps).toMatchObject({ appFilled: false });
        expect(clients.reads).toContain(LEGACY_APP);
      }
    });

    it('없음이 아닌 오류(권한 등)는 그대로 던진다 — SSM 자리도 옛 자리도 fail closed', async () => {
      await expect(composeRoleBootstrap(platform(env(), ssmClients({ ...withoutApp }, [SSM_APP])))).rejects.toThrow(/AccessDenied/);
      await expect(composeRoleBootstrap(platform(env(), ssmClients({ ...withoutApp }, [LEGACY_APP])))).rejects.toThrow(/AccessDenied/);
    });

    it('ARN 자리(Secrets Manager)가 없으면 "비었다" 로 넘기지 않고 던진다 — 옛 자리 확인은 SSM 이름에만', async () => {
      await expect(composeRoleBootstrap(platform(productionEnv(), ssmClients(withoutApp)))).rejects.toThrow(SecretNotFoundError);
    });
  });

  it('쓰기 면(secretWriter)을 받는 조립은 부트스트랩 하나뿐이다', () => {
    const text = source(COMPOSITION).getFullText();
    const uses = [...text.matchAll(/secretWriter/g)].length;
    // RuntimeClients 선언 1 + composeRoleBootstrap 사용 1.
    expect(uses).toBe(2);
  });
});

describe('수명주기 — 조립은 실행 환경당 1회, 실패는 캐시하지 않는다', () => {
  it('성공한 조립은 재사용한다(비밀을 다시 읽지 않는다)', async () => {
    const clients = fakeClients();
    const compose = memoize((_: null) => track(composeSesEventConsumer(platform(productionEnv(), clients))));
    const first = await compose(null);
    const second = await compose(null);
    expect(second).toBe(first);
    expect(clients.reads).toEqual([APP_SECRET]);
  });

  it('실패한 조립은 버리고 다음 호출이 다시 시도한다', async () => {
    let attempts = 0;
    const compose = memoize(() => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(new Error('일시 장애')) : Promise.resolve('ok');
    });
    await expect(compose(undefined)).rejects.toThrow('일시 장애');
    await expect(compose(undefined)).resolves.toBe('ok');
    expect(attempts).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 정적 — 조립 루트의 경계
// ---------------------------------------------------------------------------

const COMPOSITION = 'src/runtime/composition.ts';
const TRANSPORT = 'src/mail/transport/ses-transport.ts';

function source(path: string): SourceFile {
  const found = getProject().getSourceFiles().find((file) => toRepoRelative(file.getFilePath()) === path);
  if (found === undefined) throw new Error(`${path} 를 ts-morph 가 읽지 못했다 — 이 절이 공허해진다.`);
  return found;
}

/** 런타임 import 폐포(타입 전용 import 제외). */
function runtimeClosure(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [source(entry)];
  while (queue.length > 0) {
    const file = queue.pop() as SourceFile;
    const path = toRepoRelative(file.getFilePath());
    if (seen.has(path)) continue;
    seen.add(path);
    for (const declaration of file.getImportDeclarations()) {
      if (declaration.isTypeOnly()) continue;
      const named = declaration.getNamedImports();
      if (named.length > 0 && named.every((n) => n.isTypeOnly()) && !declaration.getDefaultImport() && !declaration.getNamespaceImport()) continue;
      const target = declaration.getModuleSpecifierSourceFile();
      if (target !== undefined && toRepoRelative(target.getFilePath()).startsWith('src/')) queue.push(target);
    }
    for (const declaration of file.getExportDeclarations()) {
      const target = declaration.getModuleSpecifierSourceFile();
      if (target !== undefined && toRepoRelative(target.getFilePath()).startsWith('src/')) queue.push(target);
    }
  }
  return seen;
}

// ts-morph 전수 순회(식별자·import 폐포)는 동기 CPU 작업이다 — 적재는 파일 머리의 beforeAll 이 치르지만, 순회도 부하 아래서 5s 를 넘길 수 있다.
// arch 프로젝트·router-table 과 같은 30s 상한을 이 절에만 건다 — 비동기 대기가 있는 위 절들은 기본 5s 그대로다.
describe('★ 조립 루트의 정적 경계', { timeout: 30_000 }, () => {
  it('조립 루트가 전송단에서 가져오는 이름은 조립용뿐이다', () => {
    const imported: string[] = [];
    for (const declaration of source(COMPOSITION).getImportDeclarations()) {
      const target = declaration.getModuleSpecifierSourceFile();
      if (target === undefined || toRepoRelative(target.getFilePath()) !== TRANSPORT) continue;
      if (declaration.getNamespaceImport() || declaration.getDefaultImport()) imported.push('*');
      imported.push(...declaration.getNamedImports().map((named) => named.getName()));
    }
    expect(imported.sort()).toEqual(['SES_CONFIGURATION_SET', 'SES_REGION', 'SesSendClient', 'createSesClient', 'createSesTransport'].sort());
  });

  it('조립 루트는 어떤 .send(…) · .sendOwnerNotification(…) 도 부르지 않는다 — 만들기만 한다', () => {
    const calls = source(COMPOSITION)
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .map((call) => call.getExpression())
      .filter((callee) => Node.isPropertyAccessExpression(callee))
      .map((callee) => callee.asKindOrThrow(SyntaxKind.PropertyAccessExpression).getName())
      .filter((name) => name === 'send' || name === 'sendOwnerNotification' || name === 'notify');
    expect(calls).toEqual([]);
    // 비공허성: 이 파일에 호출식은 많다.
    expect(source(COMPOSITION).getDescendantsOfKind(SyntaxKind.CallExpression).length).toBeGreaterThan(30);
  });

  it('로컬 개발 구현·env 평문 로더를 참조하지 않는다', () => {
    const forbidden = new Set([
      'createLocalObjectStore',
      'createLocalDownloadSigner',
      'createLocalDevKeyCustody',
      'createInMemoryContentStore',
      'createAppPool',
      'requireDatabaseUrl',
      'migrationDatabaseUrl',
    ]);
    const offenders = new Set<string>();
    for (const file of getProject().getSourceFiles()) {
      const path = toRepoRelative(file.getFilePath());
      if (!path.startsWith('src/runtime/')) continue;
      for (const identifier of file.getDescendantsOfKind(SyntaxKind.Identifier)) {
        if (forbidden.has(identifier.getText())) offenders.add(`${path}: ${identifier.getText()}`);
      }
    }
    expect([...offenders]).toEqual([]);
  });

  it.each([
    'src/runtime/handlers/api.ts',
    'src/runtime/handlers/inbound.ts',
    'src/runtime/handlers/approval-release.ts',
    'src/runtime/handlers/scheduled-sender.ts',
    'src/runtime/handlers/migrate.ts',
  ])('%s 의 런타임 import 폐포에 로컬 구현 모듈이 없다', (handler) => {
    const closure = runtimeClosure(handler);
    expect(closure.has(COMPOSITION)).toBe(true); // 비공허성
    expect(closure.has('src/storage/local-object-store.ts')).toBe(false);
    expect(closure.has('src/passport/custody-local.ts')).toBe(false);
  });

  it('비밀 SDK(Secrets Manager · SSM)는 src/runtime/secrets.ts 한 파일뿐이다', () => {
    const offenders = getProject()
      .getSourceFiles()
      .filter((file) => toRepoRelative(file.getFilePath()).startsWith('src/'))
      .filter((file) =>
        file
          .getImportDeclarations()
          .some((d) => /^@aws-sdk\/client-(secrets-manager|ssm)(\/|$)/.test(d.getModuleSpecifierValue())),
      )
      .map((file) => toRepoRelative(file.getFilePath()));
    expect(offenders).toEqual(['src/runtime/secrets.ts']);
  });
});
