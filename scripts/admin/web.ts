#!/usr/bin/env tsx
/**
 * scripts/admin/web.ts — **운영자 웹 화면**(`pnpm admin:web`). `pnpm admin:*` 를 치는 대신 브라우저로 같은 일을 한다 — 검토 대기열 · 조직 ·
 * 요금제 · 킬스위치 · 감사 로그. 노트북에서만 돈다: 127.0.0.1 에 묶고, 인프라·배포·Lambda 번들 어디에도 없다(런북 admin §9).
 *
 *   eval "$(pnpm -s admin:db-env)"                     # 또는 --billing-operator(요금제 쓰기까지)
 *   pnpm admin:web [--port 0] [--idle-minutes 30] [--by <운영자>] [--no-open]
 *
 * **CLI 와 같은 권한 경로다**: 소유자 롤(`DATABASE_MIGRATION_URL` — 앱 롤이면 거부 · 운영이면 TLS verify-full)로 읽기 · 검토 · 킬스위치,
 * 결제 운영자 롤(`DATABASE_BILLING_OPERATOR_URL`, 있을 때만 — 정확히 그 롤)로 요금제 쓰기. 쓰기는 CLI 가 부르는 **같은 함수**
 * (`reviewOrganizationOp` · `setOrgPlanOp` · `releaseToProviderOp` · `setOrganizationFreezeAuditedOp` · `setAgentSuspendedOp`)다.
 * CLI 의 운영 `yes` 확인 대신 화면에서 조직 이름(되돌릴 수 없는 것은 `CONFIRM` 도)을 입력한다 — 서버가 검사한다.
 *
 * 보안(`scripts/ops-web/security.ts`): 실행마다 새 비밀 둘(세션 토큰 · 일회용 부트스트랩, 각 32바이트 base64url). 쿠키는 없다. 브라우저는
 * `http://127.0.0.1:<포트>/bootstrap?k=…` 로 열리고(한 번 쓰면 무효 · 10분 만료) 세션 토큰을 fragment 로 한 번 받는다. 부트스트랩 실패(틀림 ·
 * 재사용 · 만료)는 탈취 신호 — 경고하고 닫는다(exit 1). Host(127.0.0.1:포트 하나) · Origin · Sec-Fetch-Site 검문, 해시 CSP.
 * 비밀은 로그에 남기지 않는다 — 부트스트랩 URL 은 브라우저를 못 열었을 때만 stderr 에 한 번(일회용이라 쓰면 쓸모가 없다).
 * 모든 쓰기(성공·실패)는 stderr 한 줄 + `~/.atmark/ops-web-audit.jsonl`(0600 · 디렉터리 0700).
 * 유휴 `--idle-minutes`(기본 30) 동안 요청이 없거나 절대 수명 `--max-hours`(기본 8, 1–12)가 지나면 스스로 닫는다. Ctrl-C 로 닫는다(풀도 닫는다).
 */

import { execFile } from 'node:child_process';
import { parseArgs } from 'node:util';

import type { Pool } from 'pg';

import { MIGRATION_DATABASE_URL_ENV } from '../../src/db/client';
import { OPS } from '../../src/ops/console/api';
import { createAuditSink } from '../ops-web/audit-log';
import { randomSecret, SessionTimer } from '../ops-web/security';
import { startOpsServer } from '../ops-web/server';
import {
  actorOf,
  AdminInputError,
  assertAdminRole,
  BILLING_OPERATOR_DATABASE_URL_ENV,
  BILLING_OPERATOR_ROLE_SPEC,
  describeTarget,
  EXIT_FAILURE,
  EXIT_OK,
  isMain,
  openAdminConnection,
  OWNER_ROLE_SPEC,
  runAdminMain,
  type AdminDeps,
} from './common';

const USAGE = 'pnpm admin:web [--port <1024-65535, 기본 무작위>] [--idle-minutes <1-240, 기본 30>] [--max-hours <1-12, 기본 8>] [--by <운영자>] [--no-open]';

export const DEFAULT_IDLE_MINUTES = 30;
export const DEFAULT_MAX_HOURS = 8;
export const BOOTSTRAP_TTL_MS = 10 * 60 * 1000;

export interface WebOptions {
  readonly port: number;
  readonly idleMinutes: number;
  readonly maxHours: number;
  readonly by: string | undefined;
  readonly open: boolean;
}

export function parseWebArgs(argv: readonly string[]): WebOptions | 'help' {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      port: { type: 'string' },
      'idle-minutes': { type: 'string' },
      'max-hours': { type: 'string' },
      by: { type: 'string' },
      'no-open': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (values.help) return 'help';
  const port = values.port === undefined ? 0 : Number(values.port);
  if (!Number.isInteger(port) || (port !== 0 && (port < 1024 || port > 65535))) throw new AdminInputError(`--port 는 1024~65535(0 = 무작위). ${USAGE}`);
  const idleMinutes = values['idle-minutes'] === undefined ? DEFAULT_IDLE_MINUTES : Number(values['idle-minutes']);
  if (!Number.isInteger(idleMinutes) || idleMinutes < 1 || idleMinutes > 240) throw new AdminInputError(`--idle-minutes 는 1~240. ${USAGE}`);
  const maxHours = values['max-hours'] === undefined ? DEFAULT_MAX_HOURS : Number(values['max-hours']);
  if (!Number.isInteger(maxHours) || maxHours < 1 || maxHours > 12) throw new AdminInputError(`--max-hours 는 1~12. ${USAGE}`);
  return { port, idleMinutes, maxHours, by: values.by, open: !values['no-open'] };
}

/** 기본 브라우저로 연다(macOS `open` · 그 밖 `xdg-open`). 셸을 거치지 않는다. 실패하면 false. */
function openBrowser(url: string): Promise<boolean> {
  const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
  return new Promise((resolve) => {
    execFile(command, [url], { timeout: 10_000 }, (error) => resolve(error === null));
  });
}

/** `pnpm ops` 가 넘기는 것 — 터널이 끊기면 `abort` 로 화면을 닫는다. */
export interface WebDeps extends AdminDeps {
  /** 중단되면 서버를 닫고 exit 1 로 돌아온다(사유는 호출자가 알린다). */
  readonly abort?: AbortSignal;
}

export async function web(argv: readonly string[], deps: WebDeps): Promise<number> {
  const options = parseWebArgs(argv);
  if (options === 'help') {
    deps.io.out(USAGE);
    return EXIT_OK;
  }
  // 접속 변수가 없으면 여기서 멈춘다(CLI 와 같은 검사 — 소유자 URL 필수, 앱 롤 URL 로 떨어지지 않는다).
  if ((deps.env[MIGRATION_DATABASE_URL_ENV] ?? '').trim() === '') {
    throw new AdminInputError(`${MIGRATION_DATABASE_URL_ENV} 가 없다 — 터널을 열고 eval "$(pnpm -s admin:db-env)" 를 먼저 한다(런북 admin §2).`);
  }
  const actor = actorOf('admin:web', options.by, deps.env);

  const pools: Pool[] = [];
  const closePools = () => Promise.all(pools.map((pool) => pool.end().catch(() => undefined)));
  try {
    const owner = openAdminConnection(deps.env, OWNER_ROLE_SPEC);
    pools.push(owner.pool);
    await assertAdminRole(owner.pool, OWNER_ROLE_SPEC);
    let operator: Pool | null = null;
    if ((deps.env[BILLING_OPERATOR_DATABASE_URL_ENV] ?? '').trim() !== '') {
      const billing = openAdminConnection(deps.env, BILLING_OPERATOR_ROLE_SPEC);
      pools.push(billing.pool);
      await assertAdminRole(billing.pool, BILLING_OPERATOR_ROLE_SPEC);
      operator = billing.pool;
    }

    let finish: (code: number) => void = () => undefined;
    const done = new Promise<number>((resolve) => {
      finish = resolve;
    });
    const idle = new SessionTimer(options.idleMinutes * 60 * 1000, options.maxHours * 60 * 60 * 1000, (reason) => {
      deps.io.err(reason === 'idle' ? `유휴 ${String(options.idleMinutes)}분 — 닫는다.` : `절대 수명 ${String(options.maxHours)}시간 — 닫는다.`);
      finish(EXIT_OK);
    });
    // 쓰기 기록 파일을 준비하지 못하면 띄우지 않는다(0600 · 디렉터리 0700).
    const audit = createAuditSink((line) => deps.io.err(line));
    const ops = await startOpsServer({
      port: options.port,
      sessionToken: randomSecret(),
      bootstrap: randomSecret(),
      bootstrapTtlMs: BOOTSTRAP_TTL_MS,
      context: {
        owner: owner.pool,
        operator,
        target: owner.target,
        actor,
        audit: audit.sink,
        idleMinutes: options.idleMinutes,
        maxHours: options.maxHours,
        ops: OPS,
        now: () => new Date(),
      },
      onActivity: () => idle.touch(),
      onBootstrapAbuse: (reason) => {
        deps.io.err(`⚠ 부트스트랩 URL 이 다시 쓰였다(${reason}) — 누가 그 URL 을 가졌을 수 있다. 서버를 닫는다. 필요하면 pnpm admin:web 을 다시 띄운다.`);
        finish(EXIT_FAILURE);
      },
    });
    idle.start();
    const onAbort = () => finish(EXIT_FAILURE);
    if (deps.abort?.aborted === true) finish(EXIT_FAILURE);
    deps.abort?.addEventListener('abort', onAbort, { once: true });
    const onSignal = () => finish(EXIT_OK);
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);

    deps.io.err(`⚠ ${describeTarget(owner.target)}`);
    deps.io.err(`운영자 웹 화면: http://127.0.0.1:${String(ops.port)}/ (127.0.0.1 전용 · 행위자 ${actor} · 요금제 쓰기 ${operator === null ? '꺼짐(--billing-operator 없음)' : '켜짐'})`);
    const opened = options.open && deps.abort?.aborted !== true ? await openBrowser(ops.bootstrapUrl) : false;
    if (!opened && deps.abort?.aborted !== true) {
      // 일회용 — 한 번 열면 무효, 10분 만료. 이 줄 말고는 어디에도 비밀을 내지 않는다.
      deps.io.err(`브라우저에서 한 번 연다(일회용 · 10분): ${ops.bootstrapUrl}`);
    }
    deps.io.err(`쓰기 기록: ${audit.path}. 끝내려면 Ctrl-C.`);

    const code = await done;
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    deps.abort?.removeEventListener('abort', onAbort);
    idle.stop();
    await ops.close();
    deps.io.err('닫았다.');
    return code;
  } finally {
    await closePools();
  }
}

if (isMain(import.meta.url)) await runAdminMain(web);
