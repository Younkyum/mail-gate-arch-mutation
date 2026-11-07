/**
 * src/ops/core/target.ts — 관리 CLI · 운영자 화면이 붙은 **DB 접속 대상 판정**(운영 · 로컬). `scripts/admin/common.ts` 에서 옮겼다(P0,
 * `.omc/plans/ops-console.md` §3.9 — `src/**` 는 `scripts/**` 를 import 하지 못한다). 동작은 그대로다.
 *
 * **운영 판정은 fail closed 다.** 셋 중 하나라도 운영을 가리키면 운영으로 본다:
 *   ① `isProductionEnvironment`(`ATMARK_ENV`/`NODE_ENV` — `src/passport/custody.ts` 의 그 판정 하나)
 *   ② 호스트가 `*.rds.amazonaws.com`
 *   ③ 포트가 SSM 터널의 로컬 포트(15432) — `docs/runbooks/admin.md` 의 포트 포워딩이 여는 자리다.
 */

import { AdminInputError } from '../../admin/ops/errors';
import { MIGRATION_DATABASE_URL_ENV } from '../../db/client';
import { isProductionEnvironment } from '../../passport/custody';

/** SSM 포트 포워딩의 로컬 포트. 런북과 `db-env.ts` 가 같은 값을 쓴다. */
export const TUNNEL_LOCAL_PORT = 15432;

/** 터널 접속에서 인증서 이름을 대조할 실제 RDS 엔드포인트. `admin:db-env` 가 내보낸다. */
export const TLS_SERVERNAME_ENV = 'ATMARK_DB_TLS_SERVERNAME';

export type DbTarget = 'production' | 'local';

export interface TargetInfo {
  readonly target: DbTarget;
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  /** 운영으로 본 근거. 로컬이면 빈 배열. */
  readonly reasons: readonly string[];
}

export function parseDbUrl(url: string): URL {
  try {
    return new URL(url);
  } catch {
    // URL 전체를 싣지 않는다 — 비밀번호가 들어 있다.
    throw new AdminInputError(`${MIGRATION_DATABASE_URL_ENV} 가 URL 형식이 아니다.`);
  }
}

export function classifyTarget(url: string, env: NodeJS.ProcessEnv): TargetInfo {
  const parsed = parseDbUrl(url);
  const host = parsed.hostname;
  const port = parsed.port === '' ? 5432 : Number(parsed.port);
  const reasons: string[] = [];
  if (isProductionEnvironment(env)) reasons.push('ATMARK_ENV/NODE_ENV=production');
  if (/\.rds\.amazonaws\.com$/i.test(host)) reasons.push('RDS 호스트');
  if (port === TUNNEL_LOCAL_PORT) reasons.push(`SSM 터널 포트 ${String(TUNNEL_LOCAL_PORT)}`);
  const servername = env[TLS_SERVERNAME_ENV];
  if (servername !== undefined && servername.trim() !== '') reasons.push(TLS_SERVERNAME_ENV);
  return {
    target: reasons.length > 0 ? 'production' : 'local',
    host,
    port,
    database: decodeURIComponent(parsed.pathname.replace(/^\//, '')),
    user: decodeURIComponent(parsed.username),
    reasons,
  };
}

export function describeTarget(target: TargetInfo): string {
  const where = `${target.host}:${String(target.port)}/${target.database} (롤 ${target.user || '?'})`;
  return target.target === 'production' ? `운영 DB ${where} — 근거: ${target.reasons.join(', ')}` : `로컬 DB ${where}`;
}
