/**
 * admin 조립 — Domain Connect 스위치(`ATMARK_DOMAIN_CONNECT_ENABLED`): 없음·false = `deps.domainConnect` 없음(엔드포인트 `{supported:false}`) ·
 * true + 키 ARN = 발견기 · 서명기 · true 인데 키 ARN 없음 = 기동 거부(조용히 꺼지지 않게) · 틀린 값 = 기동 거부.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { composeAdmin, type ComposedAdmin } from '../../../src/runtime/admin-composition';
import { RUNTIME_ENV } from '../../../src/runtime/config';

const CA_FILE = join(mkdtempSync(join(tmpdir(), 'atmark-dc-')), 'ca.pem');
writeFileSync(CA_FILE, '');
const LOGIN_SECRET = 'arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:atmark/owner-login-keys';
const ADMIN_DB_SECRET = 'arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:atmark/db/admin';
const ADMIN_FUNCTION_ARN = 'arn:aws:lambda:ap-northeast-2:123456789012:function:atmark-admin';
const KEY_ARN = 'arn:aws:kms:ap-northeast-2:123456789012:key/dc';
const SECRETS: Record<string, string> = {
  [LOGIN_SECRET]: `l1:${'A'.repeat(43)}`,
  [ADMIN_DB_SECRET]: JSON.stringify({ host: 'db.internal', port: 5432, dbname: 'atmark', username: 'atmark_admin', password: 'pw' }),
};

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

const secrets = { readSecretString: (id: string): Promise<string> => (SECRETS[id] === undefined ? Promise.reject(new Error('no')) : Promise.resolve(SECRETS[id])) };

describe('admin 조립 — Domain Connect 스위치', () => {
  const composed: ComposedAdmin[] = [];
  afterEach(async () => {
    await Promise.all(composed.splice(0).map((entry) => entry.pool.end()));
  });
  const compose = async (extra: Record<string, string>): Promise<ComposedAdmin> => {
    const result = await composeAdmin({ env: env(extra), invokedFunctionArn: ADMIN_FUNCTION_ARN, clients: { secrets } });
    composed.push(result);
    return result;
  };

  it('기본(없음) · false = 꺼짐 — 키 ARN 이 있어도 의존성 없음', async () => {
    expect((await compose({})).deps.domainConnect).toBeUndefined();
    expect((await compose({ [RUNTIME_ENV.domainConnectEnabled]: 'false', [RUNTIME_ENV.domainConnectKeyArn]: KEY_ARN })).deps.domainConnect).toBeUndefined();
  });

  it('true + 키 ARN = 발견기 · 서명기 · true 인데 키 없음 / 틀린 값 = 기동 거부', async () => {
    const on = await compose({ [RUNTIME_ENV.domainConnectEnabled]: 'true', [RUNTIME_ENV.domainConnectKeyArn]: KEY_ARN });
    expect(on.deps.domainConnect?.discovery).toBeDefined();
    expect(on.deps.domainConnect?.signer).toBeDefined();
    await expect(composeAdmin({ env: env({ [RUNTIME_ENV.domainConnectEnabled]: 'true' }), invokedFunctionArn: ADMIN_FUNCTION_ARN, clients: { secrets } })).rejects.toThrow(
      RUNTIME_ENV.domainConnectKeyArn,
    );
    await expect(composeAdmin({ env: env({ [RUNTIME_ENV.domainConnectEnabled]: 'TRUE' }), invokedFunctionArn: ADMIN_FUNCTION_ARN, clients: { secrets } })).rejects.toThrow();
  });
});
