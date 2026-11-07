/**
 * `pnpm admin:*` 의 가드 — DB 없이 판정되는 것들. **AWS 를 부르지 않는다**(SDK 는 가짜 `send`).
 *
 *   ① 운영 판정(fail closed) · 운영 TLS 가드(검증 없는 접속 거부, verify-full 로 승격)
 *   ② 운영 확인(비대화형 + `--yes` 없음 = 거부)
 *   ③ custody 선택 — 운영 DB + 로컬 custody 거부 · AWS custody 조립(KMS envelope → CreateSecret) · SDK 어댑터
 *   ④ `admin:db-env` — 파일 없이 stdout 으로만, 셸 인용이 비밀번호를 보존, 낸 URL 이 TLS 검증을 켠다
 *   ⑤ 정책 변경 파싱 — `auto_approve_verification_senders on` 은 AC-7 명시 플래그 없이 거부
 */

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { GenerateDataKeyCommand } from '@aws-sdk/client-kms';
import { CreateSecretCommand } from '@aws-sdk/client-secrets-manager';
import { describe, expect, it } from 'vitest';

import { AGENT_KEYPAIR_KEY_ALIAS } from '../../../infra/cdk/stacks/passport-stack';
import { DB_APP_SECRET_NAME, DB_OWNER_SECRET_NAME } from '../../../infra/cdk/stacks/data-stack';
import { toAgentId } from '../../../src/db/schema';
import { ssmParameterNameOf } from '../../../src/runtime/ssm-secret-names';
import { PrivateKeyMaterial, ProductionCustodyGuardError } from '../../../src/passport/custody';
import {
  AdminInputError,
  classifyTarget,
  confirmProduction,
  productionTls,
  TLS_SERVERNAME_ENV,
  type AdminIo,
} from '../../../scripts/admin/common';
import {
  kmsDataKeyGenerator,
  PASSPORT_KMS_KEY_ENV,
  secretsManagerCreator,
  selectCustody,
  type AwsCustodyPorts,
} from '../../../scripts/admin/custody';
import { DB_APP_SECRET_ID, DB_OWNER_SECRET_ID, dbEnv, PASSPORT_KEY_ALIAS, shellQuote } from '../../../scripts/admin/db-env';
import { AC7_ACK_FLAG, parseChange } from '../../../scripts/admin/policy';
import { parseCapabilities, parseExpiry } from '../../../scripts/admin/agent-token';

function fakeIo(options: { interactive?: boolean; answer?: string } = {}): AdminIo & { outLines: string[]; errLines: string[] } {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    outLines,
    errLines,
    out: (line) => outLines.push(line),
    err: (line) => errLines.push(line),
    interactive: options.interactive ?? false,
    ask: async () => options.answer ?? '',
  };
}

function pemFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'atmark-admin-ca-'));
  const path = join(dir, 'rds-global-bundle.pem');
  writeFileSync(path, '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n');
  return path;
}

/** `pg` 가 실제로 쓰는 URL 파서 — 직접 의존이 아니라서 `pg` 의 위치에서 푼다(버전이 `pg` 와 어긋나지 않게). */
const requireFromPg = createRequire(createRequire(import.meta.url).resolve('pg'));
const parseConnectionString = (requireFromPg('pg-connection-string') as { parse: (url: string) => Record<string, unknown> }).parse;

const RDS_HOST = 'atmark-db.abcdefghijkl.ap-northeast-2.rds.amazonaws.com';

// ---------------------------------------------------------------------------

describe('① 운영 판정 · TLS 가드', () => {
  it('로컬 5432 는 로컬, 터널 포트·RDS 호스트·ATMARK_ENV·servername 중 하나라도 있으면 운영이다', () => {
    expect(classifyTarget('postgres://o@localhost:5432/atmark', {}).target).toBe('local');
    expect(classifyTarget('postgres://o@localhost:15432/atmark', {}).target).toBe('production');
    expect(classifyTarget(`postgres://o@${RDS_HOST}:5432/atmark`, {}).target).toBe('production');
    expect(classifyTarget('postgres://o@localhost:5432/atmark', { ATMARK_ENV: 'production' }).target).toBe('production');
    expect(classifyTarget('postgres://o@localhost:5432/atmark', { NODE_ENV: 'production' }).target).toBe('production');
    expect(classifyTarget('postgres://o@localhost:5432/atmark', { [TLS_SERVERNAME_ENV]: RDS_HOST }).target).toBe('production');
  });

  it('운영 접속에 TLS 검증이 없으면 거부한다 — sslmode 없음·disable·require·no-verify, CA 번들 없음', () => {
    const ca = pemFile();
    const env = { [TLS_SERVERNAME_ENV]: RDS_HOST };
    for (const query of ['', '?sslmode=disable', '?sslmode=require', '?sslmode=prefer', '?sslmode=no-verify', `?sslmode=verify-ca&ssl=0&sslrootcert=${ca}`]) {
      expect(() => productionTls(`postgres://o:p@localhost:15432/atmark${query}`, env), query).toThrow(/TLS 검증 없이/);
    }
    expect(() => productionTls('postgres://o:p@localhost:15432/atmark?sslmode=verify-ca', env)).toThrow(/sslrootcert/);
    expect(() => productionTls('postgres://o:p@localhost:15432/atmark?sslmode=verify-ca&sslrootcert=/nonexistent.pem', env)).toThrow(
      /읽을 수 없다/,
    );
  });

  it('터널(localhost)은 대조할 RDS 이름이 없으면 거부 — 있으면 CA + 이름을 모두 검증하는 ssl 로 승격한다', () => {
    const ca = pemFile();
    const url = `postgres://o:p@localhost:15432/atmark?uselibpqcompat=true&sslmode=verify-ca&sslrootcert=${encodeURIComponent(ca)}`;
    expect(() => productionTls(url, {})).toThrow(new RegExp(TLS_SERVERNAME_ENV));

    const tls = productionTls(url, { [TLS_SERVERNAME_ENV]: RDS_HOST });
    // TLS 파라미터가 걷혔다 — pg 가 URL 로 ssl 을 덮어쓰지 못한다(pg 는 URL 파싱 결과를 config 위에 얹는다).
    expect(tls.connectionString).toBe('postgres://o:p@localhost:15432/atmark');
    expect(tls.ssl.rejectUnauthorized).toBe(true);
    expect(String(tls.ssl.ca)).toContain('BEGIN CERTIFICATE');
    // 이름 대조는 localhost 가 아니라 실제 엔드포인트와 한다 — 다른 이름의 인증서는 거부된다.
    const check = tls.ssl.checkServerIdentity;
    expect(check).toBeDefined();
    const cert = { subject: { CN: RDS_HOST }, subjectaltname: `DNS:${RDS_HOST}` } as unknown as Parameters<NonNullable<typeof check>>[1];
    const other = { subject: { CN: 'evil.example.com' }, subjectaltname: 'DNS:evil.example.com' } as unknown as typeof cert;
    expect(check?.('localhost', cert)).toBeUndefined();
    expect(check?.('localhost', other)).toBeInstanceOf(Error);
  });
});

describe('② 운영 확인', () => {
  const production = classifyTarget('postgres://o@localhost:15432/atmark', {});
  const local = classifyTarget('postgres://o@localhost:5432/atmark', {});

  it('로컬은 묻지 않는다', async () => {
    await expect(confirmProduction(local, 'x', false, fakeIo())).resolves.toBeUndefined();
  });
  it('운영 + 비대화형 + --yes 없음 → 거부(파이프로 흘린 명령이 운영을 조용히 바꾸지 않는다)', async () => {
    await expect(confirmProduction(production, 'x', false, fakeIo())).rejects.toThrow(/--yes/);
  });
  it('운영 + 대화형: yes 만 통과 · 그 밖은 거부', async () => {
    await expect(confirmProduction(production, 'x', false, fakeIo({ interactive: true, answer: 'yes' }))).resolves.toBeUndefined();
    await expect(confirmProduction(production, 'x', false, fakeIo({ interactive: true, answer: 'y' }))).rejects.toThrow(/취소/);
  });
  it('운영 + --yes → 통과(비대화형 실행을 막지 않는다), 대상은 stderr 에 찍힌다', async () => {
    const io = fakeIo();
    await confirmProduction(production, '조직 생성', true, io);
    expect(io.errLines.join('\n')).toMatch(/운영 DB localhost:15432\/atmark/);
    expect(io.outLines).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

interface Captured {
  readonly kms: { keyId: string; keySpec: string }[];
  readonly secrets: { name: string; secretString: string; kmsKeyId: string }[];
}

function fakePorts(): { ports: () => AwsCustodyPorts; captured: Captured; plaintextDek: Uint8Array } {
  const captured: Captured = { kms: [], secrets: [] };
  const plaintextDek = new Uint8Array(randomBytes(32));
  return {
    captured,
    plaintextDek,
    ports: () => ({
      kms: {
        async generateDataKey(input) {
          captured.kms.push({ ...input });
          return { plaintext: plaintextDek, ciphertextBlob: new Uint8Array(randomBytes(48)) };
        },
      },
      secrets: {
        async createSecret(input) {
          captured.secrets.push({ ...input });
          return { arn: `arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:${input.name}-AbCdEf` };
        },
      },
    }),
  };
}

describe('③ custody 선택 — 조립 위치는 scripts/admin/custody.ts', () => {
  const agentId = toAgentId(randomBytes(16).toString('hex'));

  it('운영 DB + 로컬 custody → 거부. 명시해도, 파일은 하나도 생기지 않는다', () => {
    const directory = mkdtempSync(join(tmpdir(), 'atmark-admin-keys-'));
    const env = { ATMARK_DEV_KEY_DIR: directory, [PASSPORT_KMS_KEY_ENV]: PASSPORT_KEY_ALIAS };
    expect(() => selectCustody('production', 'local', env, fakePorts().ports)).toThrow(/로컬 custody/);
    expect(readdirSync(directory)).toEqual([]);
  });

  it('운영 DB 기본값은 AWS custody — KMS 키가 없으면 거부', () => {
    expect(() => selectCustody('production', undefined, {}, fakePorts().ports)).toThrow(new RegExp(PASSPORT_KMS_KEY_ENV));
    expect(selectCustody('production', undefined, { [PASSPORT_KMS_KEY_ENV]: PASSPORT_KEY_ALIAS }, fakePorts().ports).kind).toBe(
      'aws-kms-secretsmanager',
    );
  });

  it('로컬 DB + AWS custody → 거부(개발 에이전트 키가 운영 계정에 남는다)', () => {
    expect(() => selectCustody('local', 'aws', { [PASSPORT_KMS_KEY_ENV]: PASSPORT_KEY_ALIAS }, fakePorts().ports)).toThrow(/운영 DB 대상에서만/);
  });

  it('로컬 DB 인데 ATMARK_ENV=production 이면 로컬 custody 가 스스로 한 번 더 던진다', () => {
    expect(() => selectCustody('local', undefined, { ATMARK_ENV: 'production' }, fakePorts().ports)).toThrow(
      ProductionCustodyGuardError,
    );
  });

  it('AWS custody: KMS GenerateDataKey(CMK) → CreateSecret(atmark/agent-keypairs/<id>, 같은 CMK) → key_ref 는 ARN 뿐', async () => {
    const { ports, captured, plaintextDek } = fakePorts();
    const custody = selectCustody('production', undefined, { [PASSPORT_KMS_KEY_ENV]: PASSPORT_KEY_ALIAS }, ports);
    const secretKey = new Uint8Array(randomBytes(48));
    const keyRef = await custody.store(agentId, new PrivateKeyMaterial(Uint8Array.from(secretKey)));

    expect(captured.kms).toEqual([{ keyId: PASSPORT_KEY_ALIAS, keySpec: 'AES_256' }]);
    expect(captured.secrets).toHaveLength(1);
    expect(captured.secrets[0]?.name).toBe(`atmark/agent-keypairs/${agentId}`);
    expect(captured.secrets[0]?.kmsKeyId).toBe(PASSPORT_KEY_ALIAS);
    expect(keyRef).toMatch(/^awssm:\/\/arn:aws:secretsmanager:.*atmark\/agent-keypairs\//);
    // 시크릿에 평문 개인키가 없다 — envelope 만.
    const stored = captured.secrets[0]?.secretString ?? '';
    expect(stored).not.toContain(Buffer.from(secretKey).toString('base64'));
    expect(JSON.parse(stored)).toMatchObject({ v: 1, alg: 'A256GCM' });
    // 평문 DEK 는 쓰고 나서 0 으로 지워졌다.
    expect([...plaintextDek].every((byte) => byte === 0)).toBe(true);
  });

  it('SDK 어댑터: GenerateDataKey·CreateSecret 명령을 그 입력 그대로 보낸다(다른 연산 없음)', async () => {
    const sent: unknown[] = [];
    const kms = kmsDataKeyGenerator({
      send: async (command) => {
        sent.push(command);
        return { Plaintext: new Uint8Array(32), CiphertextBlob: new Uint8Array(8), $metadata: {} };
      },
    });
    const secrets = secretsManagerCreator({
      send: async (command) => {
        sent.push(command);
        return { ARN: 'arn:aws:secretsmanager:x', $metadata: {} };
      },
    });
    await kms.generateDataKey({ keyId: 'alias/k', keySpec: 'AES_256' });
    await secrets.createSecret({ name: 'atmark/agent-keypairs/a', secretString: '{}', kmsKeyId: 'alias/k' });
    expect(sent[0]).toBeInstanceOf(GenerateDataKeyCommand);
    expect((sent[0] as GenerateDataKeyCommand).input).toEqual({ KeyId: 'alias/k', KeySpec: 'AES_256' });
    expect(sent[1]).toBeInstanceOf(CreateSecretCommand);
    expect((sent[1] as CreateSecretCommand).input).toMatchObject({ Name: 'atmark/agent-keypairs/a', SecretString: '{}', KmsKeyId: 'alias/k' });

    const empty = kmsDataKeyGenerator({ send: async () => ({ $metadata: {} }) });
    await expect(empty.generateDataKey({ keyId: 'k', keySpec: 'AES_256' })).rejects.toThrow(/Plaintext/);
  });
});

// ---------------------------------------------------------------------------

describe('④ admin:db-env', () => {
  const password = `p@ss'w/rd:?#$\`"x`;
  const secret = (username: string): string =>
    JSON.stringify({ engine: 'postgres', host: RDS_HOST, port: 5432, dbname: 'atmark', username, password });

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

  it('이름이 스택과 같다 — 비밀 둘 · CMK 별칭', () => {
    // 2026-10-12 비밀 → SSM 이전 — SSM 파라미터 이름 = 스택의 비밀 이름 앞에 `/`.
    expect(DB_OWNER_SECRET_ID).toBe(ssmParameterNameOf(DB_OWNER_SECRET_NAME));
    expect(DB_APP_SECRET_ID).toBe(ssmParameterNameOf(DB_APP_SECRET_NAME));
    expect(PASSPORT_KEY_ALIAS).toBe(AGENT_KEYPAIR_KEY_ALIAS);
  });

  it('stdout 은 export 줄뿐이고, eval 하면 비밀번호가 그대로 살아난다 · 낸 URL 은 CA 검증 TLS 를 켠다', async () => {
    const ca = pemFile();
    const io = fakeIo();
    const secrets = reader({ [DB_OWNER_SECRET_ID]: secret('atmark_owner'), [DB_APP_SECRET_ID]: secret('atmark_app') });
    expect(await dbEnv(['--ca-bundle', ca], { env: {}, io, secrets })).toBe(0);
    expect(secrets.asked).toEqual([DB_OWNER_SECRET_ID, DB_APP_SECRET_ID]);
    expect(io.outLines.every((line) => /^export [A-Z_]+='/.test(line))).toBe(true);
    // 파일에 쓰는 경로가 소스에 없다 — 자격증명은 stdout(→ eval → 셸 변수)으로만 나간다.
    const source = readFileSync(join(__dirname, '../../../scripts/admin/db-env.ts'), 'utf8');
    expect(source).not.toMatch(/writeFile|appendFile|createWriteStream|\.write\(/);

    const shell = spawnSync(
      'sh',
      ['-c', 'eval "$(cat)"; printf "%s\\n%s\\n%s\\n%s\\n%s" "$DATABASE_MIGRATION_URL" "$DATABASE_URL" "$ATMARK_DB_TLS_SERVERNAME" "$ATMARK_ENV" "$ATMARK_PASSPORT_KMS_KEY_ID"'],
      { input: io.outLines.join('\n'), encoding: 'utf8' },
    );
    const [ownerUrl, appUrl, servername, atmarkEnv, kmsKey] = shell.stdout.split('\n');
    expect(servername).toBe(RDS_HOST);
    expect(atmarkEnv).toBe('production');
    expect(kmsKey).toBe(PASSPORT_KEY_ALIAS);

    for (const [url, user] of [
      [ownerUrl, 'atmark_owner'],
      [appUrl, 'atmark_app'],
    ] as const) {
      const parsed = parseConnectionString(url ?? '');
      expect(parsed.user).toBe(user);
      expect(parsed.password).toBe(password);
      expect(parsed.host).toBe('localhost');
      expect(parsed.port).toBe('15432');
      // 기존 CLI(src/db/client.ts 그대로)가 이 URL 로 붙으면: TLS 필수 · RDS CA 로 검증 · 검증 끄기 없음.
      const ssl = parsed.ssl as { ca?: string; rejectUnauthorized?: boolean } | undefined;
      expect(ssl?.ca).toContain('BEGIN CERTIFICATE');
      expect(ssl?.rejectUnauthorized).not.toBe(false);
      // 관리 CLI 는 같은 URL 을 받아 verify-full 로 승격한다.
      expect(classifyTarget(url ?? '', {}).target).toBe('production');
      expect(productionTls(url ?? '', { [TLS_SERVERNAME_ENV]: RDS_HOST }).ssl.rejectUnauthorized).toBe(true);
    }
  });

  it('플레이스홀더 비밀·CA 번들 없음 → 거부하고 stdout 은 비어 있다(eval 이 아무것도 안 한다)', async () => {
    const ca = pemFile();
    const placeholder = JSON.stringify({ _unset: 'placeholder' });
    const io = fakeIo();
    await expect(
      dbEnv(['--ca-bundle', ca], { env: {}, io, secrets: reader({ [DB_OWNER_SECRET_ID]: placeholder, [DB_APP_SECRET_ID]: placeholder }) }),
    ).rejects.toThrow(/플레이스홀더/);
    await expect(dbEnv(['--ca-bundle', '/nonexistent/bundle.pem'], { env: {}, io, secrets: reader({}) })).rejects.toThrow(/CA 번들/);
    expect(io.outLines).toEqual([]);
  });

  it('셸 인용', () => {
    expect(shellQuote(`a'b`)).toBe(`'a'\\''b'`);
  });
});

// ---------------------------------------------------------------------------

describe('⑤ 정책 · 토큰 입력', () => {
  it('auto_approve_verification_senders on 은 AC-7 플래그 없이 거부 · off 는 그냥 된다', () => {
    expect(() => parseChange({ 'auto-approve-verification-senders': 'on' })).toThrow(/AC-7/);
    expect(parseChange({ 'auto-approve-verification-senders': 'on', [AC7_ACK_FLAG]: true }).verificationSenders).toBe(true);
    expect(parseChange({ 'auto-approve-verification-senders': 'off' }).verificationSenders).toBe(false);
  });

  it('레거시 모드·enum 이름·오타 모드·0 한도 거부 — 모드는 콘솔 이름(정책 v2)', () => {
    const code = (values: Parameters<typeof parseChange>[0]): string => {
      try {
        parseChange(values);
      } catch (error) {
        if (error instanceof AdminInputError) return error.code;
        throw error;
      }
      return 'accepted';
    };
    expect(code({ outbound: 'approval_required' })).toBe('legacy_mode_rejected');
    expect(code({ outbound: 'reply_only' })).toBe('legacy_mode_rejected');
    expect(code({ outbound: 'legacy' })).toBe('legacy_mode_rejected');
    // 내부 enum 이름은 받지 않는다 — 어휘는 하나(콘솔 이름).
    expect(code({ outbound: 'allowlist_only' })).toBe('invalid_mode');
    expect(code({ outbound: 'allow_list' })).toBe('invalid_mode');
    expect(code({ inbound: 'approval_required' })).toBe('invalid_mode');
    expect(code({ 'per-minute': '0' })).toBe('invalid_per_minute');
    expect(parseChange({ outbound: 'all', inbound: 'blocklist', 'per-minute': '3' })).toEqual({
      outboundMode: 'unrestricted',
      inboundMode: 'blocklist_only',
      perMinute: 3,
      verificationSenders: undefined,
    });
    expect(parseChange({ outbound: 'none', inbound: 'none' })).toMatchObject({ outboundMode: 'disabled', inboundMode: 'disabled' });
    expect(parseChange({ outbound: 'allowlist', inbound: 'allowlist' })).toMatchObject({
      outboundMode: 'allowlist_only',
      inboundMode: 'allowlist_only',
    });
  });

  it('토큰 권한 기본값 = 프로비저닝과 같은 집합 · 모르는 권한 거부 · 만료는 미래만', () => {
    expect(parseCapabilities(undefined)).toEqual(['messages:send', 'messages:read', 'audit:read', 'agent:read_self', 'policy:request']);
    expect(parseCapabilities(['messages:read'])).toEqual(['messages:read']);
    expect(() => parseCapabilities(['policy:write'])).toThrow(/알 수 없는 권한/);
    // 2026-09-25 핫픽스(fail-open): `--capabilities ""`·`,` 처럼 주었는데 빈 목록이면 기본(전권)으로 떨어지지 않고 거부한다.
    for (const empty of [[''], [','], [' , ']]) expect(() => parseCapabilities(empty)).toThrow(expect.objectContaining({ code: 'invalid_capability' }));
    const now = new Date('2026-09-23T00:00:00Z');
    expect(parseExpiry(undefined, now)).toBeNull();
    expect(parseExpiry('30d', now)?.toISOString()).toBe('2026-10-23T00:00:00.000Z');
    expect(parseExpiry('2026-12-31', now)?.toISOString()).toBe('2026-12-30T15:00:00.000Z');
    expect(() => parseExpiry('2026-01-01', now)).toThrow(/지났다/);
    expect(() => parseExpiry('soon', now)).toThrow(AdminInputError);
  });
});
