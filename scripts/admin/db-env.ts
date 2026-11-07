#!/usr/bin/env tsx
/**
 * scripts/admin/db-env.ts — 운영 DB 접속 환경 변수를 **stdout 으로만** 낸다. 파일에 쓰지 않는다.
 *
 *   export AWS_PROFILE=atmark            # atmark-admin + MFA
 *   eval "$(pnpm -s admin:db-env)"       # SSM 터널(localhost:15432)이 열려 있어야 쓸모가 있다 — docs/runbooks/admin.md
 *
 * SSM Parameter Store 의 `/atmark/db/owner`·`/atmark/db/app`(SecureString — migrate 핸들러가 채운 `{host,port,dbname,username,password}`,
 * 2026-10-12 Secrets Manager 에서 옮김 · 배포 런북 §49)을
 * 읽어 **터널 쪽 URL** 로 바꾼다: 호스트 `localhost`, 포트 15432, `sslmode=verify-ca` + `sslrootcert`(RDS CA 번들).
 * 비밀번호는 셸 변수에만 산다 — 셸 히스토리에는 `eval "$(…)"` 한 줄만 남는다.
 *
 * 내보내는 것:
 *   DATABASE_MIGRATION_URL   소유자 롤 — `admin:*`·`sender:mark`
 *   DATABASE_URL             앱 롤 — `ac0:*`·`check:ac0`(createAppPool)
 *   ATMARK_DB_TLS_SERVERNAME 실제 RDS 엔드포인트 — `admin:*` 는 이 이름으로 인증서를 대조한다(verify-full)
 *   ATMARK_ENV=production    로컬 custody·로컬 저장소 구현이 스스로 거부하게
 *   ATMARK_PASSPORT_KMS_KEY_ID  envelope CMK 별칭 — `admin:agent-provision` 의 AWS custody
 *   AWS_REGION
 *   DATABASE_BILLING_OPERATOR_URL  결제 운영자 롤 — `admin:plan` 전용. **`--billing-operator` 를 줄 때만** 낸다(WP-2 D-7): 요금제를 바꾸는
 *                            자격은 필요할 때만 셸에 올린다. 비밀 `/atmark/db/billing-operator`(migrate `bootstrap-roles` 가 채운다).
 *
 * **왜 URL 은 verify-ca 인가.** 터널 URL 의 호스트는 `localhost` 라서 `pg` 의 기본 이름 대조(verify-full)는 항상
 * 실패한다. `uselibpqcompat=true&sslmode=verify-ca` 는 CA(RDS 전용 루트)만 검증하는 libpq 의미다 — 기존 CLI
 * (`sender:mark`·`ac0:*`, `src/db/client.ts` 를 그대로 쓴다)가 코드 변경 없이 TLS 검증을 하며 붙는다. 관리 CLI 는
 * 그 위에 이름 대조까지 한다(`./common.ts` `productionTls`). 검증을 끄는 값(`no-verify`·`require`+libpq)은 내지 않는다.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { parseArgs } from 'node:util';

import { databaseUrlOf, parseDatabaseSecret, RuntimeConfigError } from '../../src/runtime/config';
import { createSecretReader, type SecretReader } from '../../src/runtime/secrets';
import {
  AdminInputError,
  BILLING_OPERATOR_DATABASE_URL_ENV,
  EXIT_OK,
  isMain,
  runAdminMain,
  TLS_SERVERNAME_ENV,
  TUNNEL_LOCAL_PORT,
  type AdminDeps,
} from './common';
import { DEFAULT_REGION, PASSPORT_KMS_KEY_ENV } from './custody';

/** SSM 파라미터 이름 — `infra/cdk/stacks/data-stack.ts` 의 비밀 이름 앞에 `/`(`ssmParameterNameOf`). 테스트가 대조한다(여기서 CDK 를 import 하지 않으려고 적는다). */
export const DB_OWNER_SECRET_ID = '/atmark/db/owner';
export const DB_APP_SECRET_ID = '/atmark/db/app';
/** 결제 운영자 롤 비밀(WP-2, `infra/cdk/stacks/billing-stack.ts` 의 자리 이름 앞에 `/`). */
export const DB_BILLING_OPERATOR_SECRET_ID = '/atmark/db/billing-operator';
/** `infra/cdk/stacks/passport-stack.ts` 의 `AGENT_KEYPAIR_KEY_ALIAS` 와 같다 — 테스트가 대조한다. */
export const PASSPORT_KEY_ALIAS = 'alias/atmark-agent-keypairs';

export const DEFAULT_CA_BUNDLE = join(homedir(), '.atmark', 'rds-global-bundle.pem');

const USAGE = 'eval "$(pnpm -s admin:db-env [--ca-bundle <RDS CA 번들 경로>] [--local-port 15432] [--billing-operator])"';

/** POSIX 셸 작은따옴표 인용. 값 안의 `'` 는 `'\''` 로. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** 터널 URL. 사용자·비밀번호·DB 이름 인코딩은 런타임과 같은 함수(`databaseUrlOf`). */
export function tunnelUrl(raw: string, label: string, localPort: number, caBundle: string): { url: string; host: string } {
  if (raw.includes('"_unset"')) {
    throw new AdminInputError(`${label} 이 아직 플레이스홀더다 — migrate 핸들러가 롤을 만들지 않았다(docs/runbooks/deploy.md).`);
  }
  let credentials;
  try {
    credentials = parseDatabaseSecret(raw, label);
  } catch (error) {
    if (error instanceof RuntimeConfigError) throw new AdminInputError(error.message);
    throw error;
  }
  const base = databaseUrlOf({ ...credentials, host: 'localhost', port: localPort });
  const query = `uselibpqcompat=true&sslmode=verify-ca&sslrootcert=${encodeURIComponent(caBundle)}`;
  return { url: `${base}?${query}`, host: credentials.host };
}

export interface DbEnvDeps extends AdminDeps {
  readonly secrets?: SecretReader;
}

export interface DbEnvOptions {
  /** RDS CA 번들 절대 경로(없으면 `DEFAULT_CA_BUNDLE`). */
  readonly caBundle?: string | undefined;
  readonly localPort?: number | undefined;
  /** 결제 운영자 롤 URL 까지(`DATABASE_BILLING_OPERATOR_URL`). */
  readonly billingOperator?: boolean | undefined;
}

export interface DbEnvResult {
  /** 이름·값 쌍 — **비밀번호가 들어 있다.** 출력하지 않는다(`dbEnv` 가 stdout 으로만 내고, `pnpm ops` 는 프로세스 안에서만 쓴다). */
  readonly exports: readonly (readonly [string, string])[];
  readonly localPort: number;
  /** 실제 RDS 엔드포인트(비밀 아님). */
  readonly host: string;
}

/**
 * 접속 변수를 **계산만** 한다(출력 없음). `dbEnv`(`eval "$(pnpm -s admin:db-env)"`)와 `pnpm ops`(프로세스 안 — 셸에 올리지 않는다)가 같은 함수를 쓴다.
 * 중간에 실패하면 던진다 — 반쯤 채운 결과는 없다.
 */
export async function computeDbEnv(options: DbEnvOptions, env: NodeJS.ProcessEnv, secretsReader?: SecretReader): Promise<DbEnvResult> {
  const caBundle = options.caBundle ?? DEFAULT_CA_BUNDLE;
  if (!isAbsolute(caBundle)) throw new AdminInputError(`--ca-bundle 은 절대 경로: ${caBundle}`);
  if (!existsSync(caBundle) || !readFileSync(caBundle, 'utf8').includes('BEGIN CERTIFICATE')) {
    throw new AdminInputError(
      `RDS CA 번들이 없다: ${caBundle} — docs/runbooks/admin.md §1 의 curl 로 받는다(공개 인증서다, 비밀 아님).`,
    );
  }
  const localPort = options.localPort ?? TUNNEL_LOCAL_PORT;
  if (!Number.isInteger(localPort) || localPort < 1024 || localPort > 65535) throw new AdminInputError('--local-port 는 1024~65535');

  const region = env['AWS_REGION']?.trim() || DEFAULT_REGION;
  const secrets = secretsReader ?? createSecretReader(region);
  const owner = tunnelUrl(await secrets.readSecretString(DB_OWNER_SECRET_ID), DB_OWNER_SECRET_ID, localPort, caBundle);
  const app = tunnelUrl(await secrets.readSecretString(DB_APP_SECRET_ID), DB_APP_SECRET_ID, localPort, caBundle);
  if (owner.host !== app.host) throw new AdminInputError(`두 비밀의 host 가 다르다 — ${owner.host} / ${app.host}`);
  const operator = options.billingOperator === true
    ? tunnelUrl(await secrets.readSecretString(DB_BILLING_OPERATOR_SECRET_ID), DB_BILLING_OPERATOR_SECRET_ID, localPort, caBundle)
    : null;
  if (operator !== null && operator.host !== owner.host) throw new AdminInputError(`결제 운영자 비밀의 host 가 다르다 — ${operator.host} / ${owner.host}`);

  const exports: readonly (readonly [string, string])[] = [
    ['DATABASE_MIGRATION_URL', owner.url],
    ['DATABASE_URL', app.url],
    [TLS_SERVERNAME_ENV, owner.host],
    ['ATMARK_ENV', 'production'],
    [PASSPORT_KMS_KEY_ENV, PASSPORT_KEY_ALIAS],
    ['AWS_REGION', region],
    ...(operator === null ? [] : ([[BILLING_OPERATOR_DATABASE_URL_ENV, operator.url]] as const)),
  ];
  return { exports, localPort, host: owner.host };
}

export async function dbEnv(argv: readonly string[], deps: DbEnvDeps): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      'ca-bundle': { type: 'string' },
      'local-port': { type: 'string' },
      'billing-operator': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (values.help) {
    deps.io.err(USAGE);
    return EXIT_OK;
  }
  const result = await computeDbEnv(
    {
      caBundle: values['ca-bundle'],
      localPort: values['local-port'] === undefined ? undefined : Number(values['local-port']),
      billingOperator: values['billing-operator'],
    },
    deps.env,
    deps.secrets,
  );
  // 전부 계산이 끝난 뒤에 한꺼번에 낸다 — 중간에 실패하면 stdout 은 비어 있고 eval 은 아무것도 하지 않는다.
  for (const [name, value] of result.exports) deps.io.out(`export ${name}=${shellQuote(value)}`);
  deps.io.err(
    `운영 DB 접속 변수를 냈다(비밀번호 포함 — 이 셸에서만 산다). 터널: localhost:${String(result.localPort)} → ${result.host}. ` +
      '이 셸에서 pnpm test 를 돌리지 마라(ATMARK_ENV=production).',
  );
  return EXIT_OK;
}

if (isMain(import.meta.url)) await runAdminMain(dbEnv);
