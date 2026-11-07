/**
 * src/runtime/health.ts — `GET /healthz`. 배포 후 스모크(`pnpm smoke:prod`)가 두드리는 자리.
 *
 * **이 응답이 "초록" 이면 참이어야 하는 것 넷:**
 *   ① 비밀을 읽었다 — 이 프로브는 조립이 끝난 뒤에만 존재한다(비밀 없이 조립은 던진다).
 *   ② DB 에 붙었다 — 실제 왕복 1회.
 *   ③ 그 연결이 **TLS 다** — `pg_stat_ssl` 로 서버 쪽에서 확인한다. 클라이언트 설정을 믿지 않는다.
 *   ④ 앱 롤이 테이블 소유자(또는 그 멤버)가 **아니다** — 소유자는 audit 불변성 트리거를 DROP 할 수 있다
 *      (마이그레이션 4 의 단언을 운영 연결에서 한 번 더 본다).
 * 하나라도 거짓이면 503 이다. **메일을 보내지 않는다** — SES·S3 를 부르지 않는다.
 *
 * 응답에는 불리언만 싣는다 — 호스트·롤 이름·오류 메시지는 공개 엔드포인트에 나가지 않는다.
 */

import type { Pool } from 'pg';

import { log } from '../observability/logger';

/** 앱 롤 이름. `db/migrate.ts` 의 `APP_ROLE` 과 같다(테스트가 대조한다 — 그 모듈은 top-level await 라 여기서 import 하지 않는다). */
export const HEALTH_APP_ROLE = 'atmark_app';

export interface HealthReport {
  readonly ok: boolean;
  readonly checks: {
    readonly database: boolean;
    readonly tls: boolean;
    readonly appRole: boolean;
    readonly appRoleNotOwner: boolean;
  };
}

export interface HealthProbe {
  check(): Promise<HealthReport>;
}

interface HealthRow {
  role: string;
  tls: boolean | null;
  owner_member: boolean;
}

export function createHealthProbe(pool: Pool): HealthProbe {
  return {
    async check(): Promise<HealthReport> {
      try {
        const result = await pool.query<HealthRow>(
          `SELECT current_user::text AS role,
                  (SELECT s.ssl FROM pg_stat_ssl s WHERE s.pid = pg_backend_pid()) AS tls,
                  pg_has_role(current_user, c.relowner, 'MEMBER') AS owner_member
             FROM pg_class c
            WHERE c.oid = 'public.audit_logs'::regclass`,
        );
        const row = result.rows[0];
        const checks = {
          database: row !== undefined,
          tls: row?.tls === true,
          appRole: row?.role === HEALTH_APP_ROLE,
          appRoleNotOwner: row !== undefined && !row.owner_member,
        };
        return { ok: checks.database && checks.tls && checks.appRole && checks.appRoleNotOwner, checks };
      } catch (error) {
        log('error', 'runtime.health_failed', {
          route_id: 'healthz',
          error_kind: error instanceof Error ? error.name : typeof error,
        });
        return { ok: false, checks: { database: false, tls: false, appRole: false, appRoleNotOwner: false } };
      }
    },
  };
}
