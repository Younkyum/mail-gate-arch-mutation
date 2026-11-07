/**
 * scripts/admin/common.ts — 관리 CLI(`pnpm admin:*`) 공용: 접속 대상 판정 · 운영 TLS 가드 · 소유자 롤 풀 · 운영 확인 · exit code.
 *
 * **왜 소유자 롤인가.** `sender_marks` 처럼 앱 롤(`atmark_app`)에 쓰기 권한이 없는 표가 있고, 관리 CLI 는 에이전트
 * 토큰이 닿지 않는 표면이어야 한다(`scripts/sender-mark.ts` 머리말과 같은 판단). 그래서 `DATABASE_MIGRATION_URL`
 * 로만 붙고 `DATABASE_URL` 로 떨어지지 않는다 — 앱 롤로 붙었으면 접속 직후 거부한다.
 *
 * **운영 판정은 fail closed 다.** 셋 중 하나라도 운영을 가리키면 운영으로 본다:
 *   ① `isProductionEnvironment`(`ATMARK_ENV`/`NODE_ENV` — `src/passport/custody.ts` 의 그 판정 하나)
 *   ② 호스트가 `*.rds.amazonaws.com`
 *   ③ 포트가 SSM 터널의 로컬 포트(15432) — `docs/runbooks/admin.md` 의 포트 포워딩이 여는 자리다.
 * 운영이면: TLS 검증 없는 접속 거부 · 로컬 custody 거부 · 변경 전 확인(`--yes` 또는 대화형 `yes`).
 *
 * **운영 TLS 는 verify-full 이다.** 터널 접속은 호스트가 `localhost` 라서 `pg` 가 인증서 이름을 `localhost` 와
 * 대조하고 실패한다. 그래서 URL 의 TLS 파라미터를 걷어 내고 `ssl` 을 직접 만든다 — CA 는 `sslrootcert`(RDS 번들),
 * 이름은 **실제 RDS 엔드포인트**(`ATMARK_DB_TLS_SERVERNAME`)와 대조한다. `rejectUnauthorized: false` 로 가는 길은 없다.
 */

import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { checkServerIdentity, type ConnectionOptions, type PeerCertificate } from 'node:tls';

import type { Pool } from 'pg';

import { AdminInputError } from '../../src/admin/ops/errors';
import { createPool, DatabaseConfigError, MIGRATION_DATABASE_URL_ENV, requireDatabaseUrl } from '../../src/db/client';
import {
  classifyTarget,
  describeTarget,
  parseDbUrl,
  TLS_SERVERNAME_ENV,
  TUNNEL_LOCAL_PORT,
  type DbTarget,
  type TargetInfo,
} from '../../src/ops/core/target';

/** 접속 대상 판정은 `src/ops/core/target.ts` 로 옮겼다(운영자 화면 코어가 같이 쓴다). CLI 는 여기서 그대로 가져다 쓴다. */
export { classifyTarget, describeTarget, TLS_SERVERNAME_ENV, TUNNEL_LOCAL_PORT, type DbTarget, type TargetInfo };

/** 앱 롤 이름 — 관리 CLI 가 이 롤로 붙으면 거부한다. */
export const APP_ROLE = 'atmark_app';

/**
 * 결제 운영자 롤(`atmark_billing_operator`, WP-2 D-7)의 접속 문자열 — `pnpm admin:plan` **만** 이것으로 붙는다(`admin:db-env --billing-operator`).
 * 소유자 URL 로 떨어지지 않는다: 이 변수가 없으면 입력 오류, 다른 롤이면 접속 직후 거부.
 */
export const BILLING_OPERATOR_DATABASE_URL_ENV = 'DATABASE_BILLING_OPERATOR_URL';
export const BILLING_OPERATOR_ROLE = 'atmark_billing_operator';

/**
 * 관리 CLI 가 붙는 롤. 기본은 소유자 롤(`DATABASE_MIGRATION_URL`, 앱 롤이면 거부). `admin:plan` 은 결제 운영자 롤을 정확히 요구한다 —
 * 요금제를 바꾸는 CLI 가 DDL 을 쥔 소유자 자격으로 돌지 않게(계획 §4-1).
 */
export interface AdminRoleSpec {
  readonly urlEnv: string;
  /** 붙은 뒤 `current_user` 가 이것이어야 한다. `null` = 앱 롤만 아니면 된다(소유자 롤 — 로컬 superuser 이름이 제각각이라). */
  readonly role: string | null;
}

export const OWNER_ROLE_SPEC: AdminRoleSpec = { urlEnv: MIGRATION_DATABASE_URL_ENV, role: null };
export const BILLING_OPERATOR_ROLE_SPEC: AdminRoleSpec = { urlEnv: BILLING_OPERATOR_DATABASE_URL_ENV, role: BILLING_OPERATOR_ROLE };

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_INPUT_ERROR = 2;

/**
 * 입력·설정 오류. exit 2. 메시지에 비밀번호·토큰을 싣지 않는다. **관리 API 와 같은 클래스다**(`src/admin/ops/errors.ts`) —
 * 공유 연산(`src/admin/ops/**`)이 던지는 거부가 CLI 에서는 exit 2, API 에서는 `{error: code}` 가 된다.
 */
export { AdminInputError };

// ---------------------------------------------------------------------------
// 입출력 — 테스트가 가짜를 준다
// ---------------------------------------------------------------------------

export interface AdminIo {
  /** 결과(대표가 복사해 쓰는 값). stdout. */
  out(line: string): void;
  /** 안내·경고. stderr. */
  err(line: string): void;
  /** stdin 이 사람인가. 아니면 확인 프롬프트를 띄우지 않고 거부한다(`--yes` 필요). */
  readonly interactive: boolean;
  ask(prompt: string): Promise<string>;
}

export function processIo(): AdminIo {
  return {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    interactive: process.stdin.isTTY === true,
    async ask(prompt: string): Promise<string> {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return await rl.question(prompt);
      } finally {
        rl.close();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 접속 대상
// ---------------------------------------------------------------------------

/** `pg-connection-string` 이 TLS 로 읽는 파라미터. 운영 경로는 이걸 걷어 내고 `ssl` 을 직접 만든다. */
const TLS_PARAMS = ['ssl', 'sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'uselibpqcompat'] as const;

/**
 * 운영 접속의 TLS. **검증 없는 접속은 거부한다** — `sslmode` 가 `verify-ca`/`verify-full` 이 아니거나 CA 번들이
 * 없으면 던진다. 결과는 CA + 호스트 이름(실제 RDS 엔드포인트)을 모두 검증하는 `ssl` 이다.
 */
export function productionTls(url: string, env: NodeJS.ProcessEnv): { readonly connectionString: string; readonly ssl: ConnectionOptions } {
  const parsed = parseDbUrl(url);
  const params = parsed.searchParams;
  const mode = params.get('sslmode');
  const ssl = params.get('ssl');
  if (ssl === '0' || ssl === 'false' || ssl === 'no-verify' || (mode !== 'verify-ca' && mode !== 'verify-full')) {
    throw new AdminInputError(
      `운영 DB 에 TLS 검증 없이 붙지 않는다 (sslmode=${mode ?? '없음'}). ` +
        '`eval "$(pnpm -s admin:db-env)"` 가 내보낸 URL 을 써라 — sslmode=verify-ca + sslrootcert(RDS CA 번들).',
    );
  }
  const rootcert = params.get('sslrootcert');
  if (rootcert === null || rootcert.trim() === '') {
    throw new AdminInputError('운영 DB 접속에 sslrootcert(RDS CA 번들 경로)가 없다 — 서버 인증서를 검증할 수 없다.');
  }
  let ca: string;
  try {
    ca = readFileSync(rootcert, 'utf8');
  } catch {
    throw new AdminInputError(`sslrootcert 를 읽을 수 없다: ${rootcert}`);
  }
  if (!ca.includes('BEGIN CERTIFICATE')) throw new AdminInputError(`sslrootcert 가 PEM 인증서가 아니다: ${rootcert}`);

  const declared = env[TLS_SERVERNAME_ENV]?.trim() ?? '';
  const isLoopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
  const servername = declared !== '' ? declared : isLoopback ? '' : parsed.hostname;
  if (servername === '') {
    throw new AdminInputError(
      `터널(localhost) 접속은 인증서 이름을 대조할 RDS 엔드포인트가 필요하다 — ${TLS_SERVERNAME_ENV} 가 비어 있다.`,
    );
  }

  for (const key of TLS_PARAMS) params.delete(key);
  return {
    connectionString: parsed.toString(),
    ssl: {
      ca,
      rejectUnauthorized: true,
      // `pg` 는 SNI·이름 대조에 URL 호스트(localhost)를 쓴다. 대조 대상을 실제 엔드포인트로 바꾼다 — 끄는 것이 아니다.
      checkServerIdentity: (_host: string, cert: PeerCertificate) => checkServerIdentity(servername, cert),
    },
  };
}

export interface AdminConnection {
  readonly pool: Pool;
  readonly target: TargetInfo;
}

/** 관리 롤 풀을 연다(기본 소유자 롤). 운영이면 TLS 가드를 지난 `ssl` 로. **닫는 것은 호출자다.** */
export function openAdminConnection(env: NodeJS.ProcessEnv, spec: AdminRoleSpec = OWNER_ROLE_SPEC): AdminConnection {
  // 앱 롤 URL 로 떨어지지 않는다(`migrationDatabaseUrl` 이 아니라 `requireDatabaseUrl` 을 쓰는 이유). 결제 운영자 롤도 소유자 URL 로 떨어지지 않는다.
  const url = requireDatabaseUrl(spec.urlEnv, env);
  const target = classifyTarget(url, env);
  if (target.target === 'production') {
    const tls = productionTls(url, env);
    return { pool: createPool(tls.connectionString, { max: 2, ssl: tls.ssl }), target };
  }
  return { pool: createPool(url, { max: 2 }), target };
}

/**
 * 붙은 롤이 기대와 다르면 거부한다 — 소유자 롤은 앱 롤만 아니면(관리 표면이 앱 권한으로 반쯤 도는 상태를 만들지 않는다),
 * 결제 운영자 롤은 정확히 그 롤이어야 한다.
 */
export async function assertAdminRole(pool: Pool, spec: AdminRoleSpec): Promise<void> {
  const result = await pool.query<{ role: string }>('SELECT current_user AS role');
  const role = result.rows[0]?.role;
  if (spec.role === null) {
    if (role === APP_ROLE) throw new AdminInputError(`관리 CLI 는 소유자 롤로 붙는다 — ${spec.urlEnv} 가 앱 롤(${APP_ROLE})이다.`);
    return;
  }
  if (role !== spec.role) {
    throw new AdminInputError(`이 CLI 는 ${spec.role} 로만 붙는다 — ${spec.urlEnv} 가 ${String(role)} 이다(소유자 롤로 떨어지지 않는다).`);
  }
}

/**
 * 운영 DB 를 바꾸기 전 확인. 로컬이면 통과. `--yes` 면 통과(비대화형 실행을 막지 않는다).
 * 비대화형인데 `--yes` 가 없으면 **거부** — 파이프로 흘린 명령이 운영을 조용히 바꾸지 않는다.
 */
export async function confirmProduction(target: TargetInfo, action: string, yes: boolean, io: AdminIo): Promise<void> {
  if (target.target === 'local') return;
  io.err(`⚠ ${describeTarget(target)}`);
  io.err(`  변경: ${action}`);
  if (yes) return;
  if (!io.interactive) throw new AdminInputError('운영 DB 변경은 확인이 필요하다 — 대화형 터미널에서 실행하거나 --yes 를 준다.');
  const answer = await io.ask('계속하려면 yes 를 입력: ');
  if (answer.trim() !== 'yes') throw new AdminInputError('취소했다 — 아무것도 바꾸지 않았다.');
}

// ---------------------------------------------------------------------------
// 실행
// ---------------------------------------------------------------------------

export interface AdminDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly io: AdminIo;
}

/** 입력·설정 오류(exit 2)로 분류할 예외. 나머지(DB 거부 포함)는 exit 1. */
export function isInputError(error: unknown): boolean {
  if (error instanceof AdminInputError || error instanceof DatabaseConfigError) return true;
  // `parseArgs` 의 알 수 없는 옵션·값 누락.
  return error instanceof TypeError && /ERR_PARSE_ARGS/.test(String((error as { code?: unknown }).code));
}

/** 접속을 열고 본체를 돌리고 반드시 닫는다. 본체가 exit code 를 정한다. 기본은 소유자 롤. */
export async function withAdminConnection(
  deps: AdminDeps,
  run: (connection: AdminConnection) => Promise<number>,
  spec: AdminRoleSpec = OWNER_ROLE_SPEC,
): Promise<number> {
  const connection = openAdminConnection(deps.env, spec);
  try {
    await assertAdminRole(connection.pool, spec);
    return await run(connection);
  } finally {
    await connection.pool.end().catch(() => undefined);
  }
}

/** 프로세스 진입점. 예외를 exit code 로 바꾼다 — 스택은 찍지 않는다(비밀이 실릴 수 있는 값이 있다). */
export async function runAdminMain(main: (argv: readonly string[], deps: AdminDeps) => Promise<number>): Promise<void> {
  const io = processIo();
  let code: number;
  try {
    code = await main(process.argv.slice(2), { env: process.env, io });
  } catch (error) {
    const input = isInputError(error);
    io.err(`${input ? '입력 오류' : '실패'}: ${error instanceof Error ? error.message : String(error)}`);
    code = input ? EXIT_INPUT_ERROR : EXIT_FAILURE;
  }
  process.exitCode = code;
}

/** 이 모듈이 `tsx scripts/admin/<x>.ts` 로 직접 실행됐는가(테스트가 import 할 때는 아니다). */
export function isMain(metaUrl: string): boolean {
  const entry = process.argv[1];
  return entry !== undefined && metaUrl === pathToFileURL(entry).href;
}

/** 쉼표 목록 → 공백 제거·빈 값 제거. */
export function splitList(values: readonly string[] | undefined): string[] {
  return (values ?? []).flatMap((value) => value.split(',')).map((value) => value.trim()).filter((value) => value !== '');
}

/** `policy_versions.created_by` 등에 남길 행위자. `--by` 가 없으면 OS 사용자. */
export function actorOf(command: string, by: string | undefined, env: NodeJS.ProcessEnv): string {
  const who = by?.trim() || env['USER']?.trim() || 'unknown';
  if (who.length > 100) throw new AdminInputError('--by 는 100자 이하');
  // 행위자는 감사 칸(`created_by` · `decided_by`)과 운영 노트 한 줄에 그대로 실린다 — 제어 문자(줄바꿈 · 터미널 이스케이프)를 받지 않는다.
  // eslint-disable-next-line no-control-regex -- 제어 문자를 거부하는 것이 목적이다.
  if (/[\u0000-\u001f\u007f-\u009f]/.test(who)) throw new AdminInputError('--by 는 한 줄(제어 문자 없음)');
  return `${command}:${who}`;
}
