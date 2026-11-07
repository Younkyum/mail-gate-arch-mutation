/**
 * `admin:db-env --billing-operator`(WP-2 D-7) — 결제 운영자 롤 URL 은 **요청할 때만** 낸다. 기본 출력(소유자·앱)은 그대로다
 * (`admin-guards.test.ts` ④ 가 본다). 낸 URL 은 같은 터널·TLS 규칙을 따르고, 운영자 비밀이 다른 호스트를 가리키면 아무것도 내지 않는다.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { BILLING_OPERATOR_DATABASE_URL_ENV, type AdminIo } from '../../../scripts/admin/common';
import { DB_APP_SECRET_ID, DB_BILLING_OPERATOR_SECRET_ID, DB_OWNER_SECRET_ID, dbEnv } from '../../../scripts/admin/db-env';

const RDS_HOST = 'atmark-db.abcdefghijkl.ap-northeast-2.rds.amazonaws.com';

function pemFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'atmark-dbenv-'));
  const file = join(dir, 'bundle.pem');
  writeFileSync(file, '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n');
  return file;
}

function fakeIo(): AdminIo & { outLines: string[] } {
  const outLines: string[] = [];
  return { outLines, out: (line) => outLines.push(line), err: () => undefined, interactive: false, ask: async () => '' };
}

const secret = (username: string, host = RDS_HOST): string =>
  JSON.stringify({ engine: 'postgres', host, port: 5432, dbname: 'atmark', username, password: 'pw' });

function reader(values: Record<string, string>) {
  const asked: string[] = [];
  return {
    asked,
    readSecretString: async (id: string) => {
      asked.push(id);
      const value = values[id];
      if (value === undefined) throw new Error(`no ${id}`);
      return value;
    },
  };
}

const BASE = { [DB_OWNER_SECRET_ID]: secret('atmark_owner'), [DB_APP_SECRET_ID]: secret('atmark_app') };

describe('admin:db-env --billing-operator', () => {
  it('비밀 이름은 SSM /atmark/db/billing-operator · 변수 이름은 DATABASE_BILLING_OPERATOR_URL', () => {
    expect(DB_BILLING_OPERATOR_SECRET_ID).toBe('/atmark/db/billing-operator');
    expect(BILLING_OPERATOR_DATABASE_URL_ENV).toBe('DATABASE_BILLING_OPERATOR_URL');
  });

  it('플래그가 없으면 운영자 비밀을 읽지도 내지도 않는다', async () => {
    const io = fakeIo();
    const secrets = reader({ ...BASE, [DB_BILLING_OPERATOR_SECRET_ID]: secret('atmark_billing_operator') });
    expect(await dbEnv(['--ca-bundle', pemFile()], { env: {}, io, secrets })).toBe(0);
    expect(secrets.asked).not.toContain(DB_BILLING_OPERATOR_SECRET_ID);
    expect(io.outLines.some((line) => line.startsWith(`export ${BILLING_OPERATOR_DATABASE_URL_ENV}=`))).toBe(false);
  });

  it('플래그가 있으면 터널 URL(운영자 롤 · localhost:15432 · verify-ca)을 하나 더 낸다', async () => {
    const io = fakeIo();
    const secrets = reader({ ...BASE, [DB_BILLING_OPERATOR_SECRET_ID]: secret('atmark_billing_operator') });
    expect(await dbEnv(['--ca-bundle', pemFile(), '--billing-operator'], { env: {}, io, secrets })).toBe(0);
    const line = io.outLines.find((candidate) => candidate.startsWith(`export ${BILLING_OPERATOR_DATABASE_URL_ENV}=`));
    expect(line).toBeDefined();
    const url = (line ?? '').replace(/^export [A-Z_]+='/, '').replace(/'$/, '');
    const parsed = new URL(url);
    expect([parsed.username, parsed.hostname, parsed.port]).toEqual(['atmark_billing_operator', 'localhost', '15432']);
    expect(url).toContain('sslmode=verify-ca');
  });

  it('운영자 비밀이 자리표시이거나 다른 호스트면 거부하고 stdout 은 비어 있다', async () => {
    const placeholder = fakeIo();
    await expect(
      dbEnv(['--ca-bundle', pemFile(), '--billing-operator'], {
        env: {},
        io: placeholder,
        secrets: reader({ ...BASE, [DB_BILLING_OPERATOR_SECRET_ID]: JSON.stringify({ _unset: 'placeholder' }) }),
      }),
    ).rejects.toThrow(/플레이스홀더/);
    expect(placeholder.outLines).toEqual([]);
    const elsewhere = fakeIo();
    await expect(
      dbEnv(['--ca-bundle', pemFile(), '--billing-operator'], {
        env: {},
        io: elsewhere,
        secrets: reader({ ...BASE, [DB_BILLING_OPERATOR_SECRET_ID]: secret('atmark_billing_operator', 'other.rds.amazonaws.com') }),
      }),
    ).rejects.toThrow(/host 가 다르다/);
    expect(elsewhere.outLines).toEqual([]);
  });
});
