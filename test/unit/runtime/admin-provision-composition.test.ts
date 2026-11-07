/**
 * admin 조립 — 고객 도메인 **즉시 실행**(2026-10 one-shot · 계약 `ProvisionDomainNow`):
 *   - `ATMARK_DOMAIN_CONTROL_FUNCTION_ARN` 이 없으면 `deps.provisionDomainNow` 없음(추가 응답 `provision:'unavailable'`) · 있으면 포트.
 *   - 포트는 부를 때마다 틱 롤 풀을 열고 **닫는다** · 조립 실패(틱 비밀 없음 · 자리표시)는 던지지 않고 `unavailable`.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';

import { unavailableDomainControlInvoker } from '../../../src/domains/contract';
import type { DomainPool } from '../../../src/domains/store';
import { composeAdmin, provisionNowOf, type ComposedAdmin, type ComposedDomainTick } from '../../../src/runtime/admin-composition';
import { RUNTIME_ENV } from '../../../src/runtime/config';

const CA_FILE = join(mkdtempSync(join(tmpdir(), 'atmark-pv-')), 'ca.pem');
writeFileSync(CA_FILE, '');
const LOGIN_SECRET = 'arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:atmark/owner-login-keys';
const ADMIN_DB_SECRET = 'arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:atmark/db/admin';
const ADMIN_FUNCTION_ARN = 'arn:aws:lambda:ap-northeast-2:123456789012:function:atmark-admin';
const DOMAIN_CONTROL_ARN = 'arn:aws:lambda:ap-northeast-2:123456789012:function:atmark-domain-control';
const SECRETS: Record<string, string> = {
  [LOGIN_SECRET]: `l1:${'A'.repeat(43)}`,
  [ADMIN_DB_SECRET]: JSON.stringify({ host: 'db.internal', port: 5432, dbname: 'atmark', username: 'atmark_admin', password: 'pw' }),
};
const secrets = { readSecretString: (id: string): Promise<string> => (SECRETS[id] === undefined ? Promise.reject(new Error('no')) : Promise.resolve(SECRETS[id])) };

function env(extra: Record<string, string>): NodeJS.ProcessEnv {
  return {
    [RUNTIME_ENV.environment]: 'production',
    [RUNTIME_ENV.region]: 'ap-northeast-2',
    [RUNTIME_ENV.dbAdminSecretArn]: ADMIN_DB_SECRET,
    [RUNTIME_ENV.ownerLoginKeysSecretArn]: LOGIN_SECRET,
    [RUNTIME_ENV.passportKmsKeyId]: 'arn:aws:kms:ap-northeast-2:123456789012:key/test',
    [RUNTIME_ENV.mailBucket]: 'atmarkstorage-mailstorebucket-test',
    [RUNTIME_ENV.extraCaCerts]: CA_FILE,
    [RUNTIME_ENV.loginMailerFunctionArn]: 'arn:aws:lambda:ap-northeast-2:123456789012:function:atmark-login-mailer',
    ...extra,
  };
}

describe('admin 조립 — 즉시 실행 포트', () => {
  const composed: ComposedAdmin[] = [];
  afterEach(async () => {
    await Promise.all(composed.splice(0).map((entry) => entry.pool.end()));
  });
  const compose = async (extra: Record<string, string>): Promise<ComposedAdmin> => {
    const result = await composeAdmin({ env: env(extra), invokedFunctionArn: ADMIN_FUNCTION_ARN, clients: { secrets } });
    composed.push(result);
    return result;
  };

  it('domain-control 배선이 없으면 포트 없음 · 있으면 포트 — 틱 비밀이 없어도 기동은 하고, 부르면 던지지 않고 unavailable', async () => {
    expect((await compose({})).deps.provisionDomainNow).toBeUndefined();
    const on = await compose({ [RUNTIME_ENV.domainControlFunctionArn]: DOMAIN_CONTROL_ARN });
    expect(typeof on.deps.provisionDomainNow).toBe('function');
    await expect(on.deps.provisionDomainNow?.('00000000-0000-4000-8000-000000000000')).resolves.toBe('unavailable');
  });

  it('provisionNowOf — 부를 때마다 풀을 열고 닫는다 · 행이 없으면 skipped · 조립이 던지면 unavailable', async () => {
    let opened = 0;
    let ended = 0;
    const fakeTick = (): Promise<ComposedDomainTick> => {
      opened += 1;
      const pool = {
        query: () => Promise.resolve({ rows: [], rowCount: 0 }),
        end: () => {
          ended += 1;
          return Promise.resolve();
        },
      } as unknown as Pool & DomainPool;
      return Promise.resolve({ pool, invoker: unavailableDomainControlInvoker });
    };
    const port = provisionNowOf(fakeTick);
    await expect(port('00000000-0000-4000-8000-000000000001')).resolves.toBe('skipped');
    await expect(port('00000000-0000-4000-8000-000000000002')).resolves.toBe('skipped');
    expect([opened, ended]).toEqual([2, 2]);
    const broken = provisionNowOf(() => Promise.reject(new Error('placeholder')));
    await expect(broken('00000000-0000-4000-8000-000000000003')).resolves.toBe('unavailable');
  });
});
