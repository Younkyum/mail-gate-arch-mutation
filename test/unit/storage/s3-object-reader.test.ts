/**
 * **발신 본문 읽기 전용 리더**(US-004) — admin Lambda 가 쥐는 S3 면. 실제 AWS 호출 0(가짜 클라이언트가 명령을 가로챈다).
 *
 *   - ★ 접두사 밖 키(`inbound/raw/…`·`outbound/scheduled/…`)는 **S3 에 묻기 전에** 거부한다(명령 0).
 *   - 접두사 안 키는 GetObject 하나 — 버킷·키·`ExpectedBucketOwner` 가 실린다. 쓰기 면(`putIfAbsent`)이 없다.
 *   - ★ admin 조립: 메일 버킷 이름이 없으면 기동 거부 · 본문 리더가 `outbound/content/{id}.json` 을 이 계정 버킷에서 읽는다.
 *   - 표시 정화(`sanitizeDisplayBlock`)·스니펫(`snippetOf`) 규칙.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

import { GetObjectCommand, type GetObjectCommandOutput } from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it } from 'vitest';

import { contentKeyFor } from '../../../src/api/content-store';
import { snippetOf } from '../../../src/api/outbound-service';
import { sanitizeDisplayBlock } from '../../../src/notify/approval-notification-template';
import { composeAdmin, type ComposedAdmin } from '../../../src/runtime/admin-composition';
import { RUNTIME_ENV } from '../../../src/runtime/config';
import { OUTBOUND_CONTENT_PREFIX, ObjectKeyFormatError } from '../../../src/storage/object-store';
import { createS3ObjectReader, type S3ObjectReadClient } from '../../../src/storage/s3-object-store';

const ACCOUNT = '123456789012';
const BUCKET = 'atmarkstorage-mailstorebucket-test';

function fakeClient(objects: Readonly<Record<string, string>> = {}) {
  const commands: GetObjectCommand[] = [];
  const client: S3ObjectReadClient = {
    send: (command: GetObjectCommand): Promise<GetObjectCommandOutput> => {
      commands.push(command);
      const body = objects[command.input.Key ?? ''];
      if (body === undefined) return Promise.reject(Object.assign(new Error('Access Denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }));
      const bytes = new TextEncoder().encode(body);
      return Promise.resolve({ $metadata: {}, ContentLength: bytes.length, Body: { transformToByteArray: () => Promise.resolve(bytes) } } as unknown as GetObjectCommandOutput);
    },
  };
  return { client, commands };
}

describe('createS3ObjectReader — 읽기 전용 · 접두사 하나', () => {
  it('★ 접두사 밖 키는 S3 에 묻기 전에 거부한다', async () => {
    const fake = fakeClient();
    const reader = createS3ObjectReader({ client: fake.client, bucket: BUCKET, expectedBucketOwner: ACCOUNT, prefix: OUTBOUND_CONTENT_PREFIX });
    for (const key of ['inbound/raw/abc', 'inbound/parsed/abc.json', 'outbound/scheduled/x.json', 'outbound/contentx/a.json', 'outbound/content/../inbound/raw/a']) {
      await expect(reader.get(key, 1024), key).rejects.toBeInstanceOf(ObjectKeyFormatError);
    }
    expect(fake.commands).toHaveLength(0);
    expect('putIfAbsent' in reader).toBe(false);
  });

  it('접두사 안 키는 GetObject 하나 — 버킷·키·ExpectedBucketOwner', async () => {
    const key = `${OUTBOUND_CONTENT_PREFIX}${randomUUID()}.json`;
    const fake = fakeClient({ [key]: 'hello' });
    const reader = createS3ObjectReader({ client: fake.client, bucket: BUCKET, expectedBucketOwner: ACCOUNT, prefix: OUTBOUND_CONTENT_PREFIX });
    expect(new TextDecoder().decode(await reader.get(key, 1024))).toBe('hello');
    expect(fake.commands).toHaveLength(1);
    expect(fake.commands[0]).toBeInstanceOf(GetObjectCommand);
    expect(fake.commands[0]?.input).toEqual({ Bucket: BUCKET, Key: key, ExpectedBucketOwner: ACCOUNT });
  });

  it('설정이 틀리면 만들지 않는다(빈 버킷 · 계정 형식 · 접두사 형식)', () => {
    const { client } = fakeClient();
    expect(() => createS3ObjectReader({ client, bucket: ' ', expectedBucketOwner: ACCOUNT, prefix: OUTBOUND_CONTENT_PREFIX })).toThrow();
    expect(() => createS3ObjectReader({ client, bucket: BUCKET, expectedBucketOwner: '123', prefix: OUTBOUND_CONTENT_PREFIX })).toThrow();
    expect(() => createS3ObjectReader({ client, bucket: BUCKET, expectedBucketOwner: ACCOUNT, prefix: '' })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// admin 조립
// ---------------------------------------------------------------------------

const LOGIN_SECRET = 'arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:atmark/owner-login-keys';
const ADMIN_DB_SECRET = 'arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:atmark/db/admin';
const FUNCTION_ARN = `arn:aws:lambda:ap-northeast-2:${ACCOUNT}:function:atmark-admin`;
const CA_DIR = mkdtempSync(join(tmpdir(), 'atmark-ca-'));
const CA_FILE = join(CA_DIR, 'ca-cert.pem');
writeFileSync(CA_FILE, '-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----\n');

function adminEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const base: Record<string, string | undefined> = {
    [RUNTIME_ENV.environment]: 'production',
    [RUNTIME_ENV.region]: 'ap-northeast-2',
    [RUNTIME_ENV.dbAdminSecretArn]: ADMIN_DB_SECRET,
    [RUNTIME_ENV.ownerLoginKeysSecretArn]: LOGIN_SECRET,
    [RUNTIME_ENV.passportKmsKeyId]: 'arn:aws:kms:ap-northeast-2:123456789012:key/test',
    [RUNTIME_ENV.mailBucket]: BUCKET,
    [RUNTIME_ENV.extraCaCerts]: CA_FILE,
    [RUNTIME_ENV.loginMailerFunctionArn]: 'arn:aws:lambda:ap-northeast-2:123456789012:function:atmark-login-mailer',
    ...overrides,
  };
  return Object.fromEntries(Object.entries(base).filter(([, value]) => value !== undefined));
}

const SECRETS: Readonly<Record<string, string>> = {
  [LOGIN_SECRET]: `l1:${randomBytes(32).toString('base64url')}`,
  [ADMIN_DB_SECRET]: JSON.stringify({ host: 'db.internal', port: 5432, dbname: 'atmark', username: 'atmark_admin', password: 'pw' }),
};
const secrets = { readSecretString: (id: string) => (SECRETS[id] === undefined ? Promise.reject(new Error(id)) : Promise.resolve(SECRETS[id])) };

const opened: ComposedAdmin[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((composed) => composed.pool.end()));
});

describe('admin 조립 — 발신 본문 리더(US-004)', () => {
  it('★ 메일 버킷 이름이 없으면 기동 거부(fail-closed)', async () => {
    await expect(
      composeAdmin({ env: adminEnv({ [RUNTIME_ENV.mailBucket]: undefined }), invokedFunctionArn: FUNCTION_ARN, clients: { secrets, s3: fakeClient().client } }),
    ).rejects.toThrow(RUNTIME_ENV.mailBucket);
  });

  it('★ 본문 리더는 이 계정 메일 버킷의 outbound/content/{id}.json 만 GetObject 로 읽는다', async () => {
    const id = randomUUID();
    const fake = fakeClient({ [contentKeyFor(id)]: JSON.stringify({ v: 1, subject: 's', text: 'body', html: null, threading: null }) });
    const composed = await composeAdmin({ env: adminEnv(), invokedFunctionArn: FUNCTION_ARN, clients: { secrets, s3: fake.client } });
    opened.push(composed);
    const content = await composed.deps.outboundContent.load(id);
    expect(content).toMatchObject({ subject: 's', text: 'body', html: null });
    expect(fake.commands.map((command) => command.input)).toEqual([{ Bucket: BUCKET, Key: `outbound/content/${id}.json`, ExpectedBucketOwner: ACCOUNT }]);
    // 쓰기 면이 없다.
    expect('put' in composed.deps.outboundContent).toBe(false);
  });
});

describe('표시 정화 · 스니펫', () => {
  it('sanitizeDisplayBlock — 줄바꿈·탭은 살리고 CR·양방향·제로폭·제어 문자는 지운다', () => {
    expect(sanitizeDisplayBlock('a\r\nb\rc\u2028d\u2029e\tf\u202Eg\u200Bh\u0000i\u0085j\u{E0041}k')).toBe('a\nb\nc\nd\ne\tfghijk');
  });

  it('snippetOf — 한 줄 · 512 코드포인트 · 빈 본문은 null', () => {
    expect(snippetOf('  hello\n\n world\t! ')).toBe('hello world !');
    expect(snippetOf('\n\t ')).toBeNull();
    expect([...(snippetOf('😀'.repeat(600)) ?? '')]).toHaveLength(512);
  });
});
