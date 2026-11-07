/**
 * 통합 프로젝트 globalSetup — 지난 실행이 남긴 가입 대기 조직을 치운다.
 *
 * 왜: `create_signup_organization` 은 `pending_review` 가 `pending_review_cap`(기본 200) 이상이면 거부한다. 가입 테스트는 조직을 지우지
 * 못하므로(DELETE 금지 테이블) 로컬 DB 에 쌓여 두세 번 전체 실행하면 가입 테스트가 전부 409 가 된다.
 * 10분보다 오래된 `pending_review` 를 `rejected` 로 표시만 한다(행은 그대로, 이번 실행분은 건드리지 않는다).
 *
 * 쓰기이므로 넷을 모두 만족할 때만 돈다:
 *   ① `ATMARK_TEST_DB_CLEANUP=1`(test:int·test:coverage·test:mod·test:changed 스크립트가 켠다)
 *   ② `TEST_MIGRATION_DATABASE_URL` 호스트가 로컬
 *   ③ 포트가 15432(운영 RDS SSM 터널, `docs/runbooks/admin.md`)가 아니다
 *   ④ `current_database()` 가 `^atmark_(v\d+|test\w*)$`
 */

import pg from 'pg';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** 로컬이어도 이 포트면 운영 RDS 터널이다. */
export const PRODUCTION_TUNNEL_PORT = 15432;

export const CLEANUP_ENV = 'ATMARK_TEST_DB_CLEANUP';

export const TEST_DATABASE_NAME = /^atmark_(v\d+|test\w*)$/;

/** 접속 전 조건(①~③). 돌아도 되면 `null`, 아니면 거절 사유. */
export function cleanupRefusal(env: Readonly<Record<string, string | undefined>>): string | null {
  if (env[CLEANUP_ENV] !== '1') return `${CLEANUP_ENV}=1 이 아니다`;
  const url = env['TEST_MIGRATION_DATABASE_URL']?.trim() ?? '';
  if (url === '') return 'TEST_MIGRATION_DATABASE_URL 이 없다';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'TEST_MIGRATION_DATABASE_URL 을 읽을 수 없다';
  }
  if (!LOCAL_HOSTS.has(parsed.hostname)) return `호스트 ${parsed.hostname} 는 로컬이 아니다`;
  // 포트를 적지 않으면 5432 다(`URL.port` 는 빈 문자열).
  if (parsed.port === String(PRODUCTION_TUNNEL_PORT)) return `포트 ${String(PRODUCTION_TUNNEL_PORT)} 는 운영 터널이다`;
  return null;
}

/** 접속 뒤 조건(④) — URL 경로가 아니라 서버의 `current_database()` 로 본다. */
export function databaseNameRefusal(name: string): string | null {
  return TEST_DATABASE_NAME.test(name) ? null : `DB ${name} 는 테스트 DB 이름 규칙(${TEST_DATABASE_NAME.source})에 맞지 않는다`;
}

export default async function setup(): Promise<void> {
  if (cleanupRefusal(process.env) !== null) return;
  const client = new pg.Client({ connectionString: (process.env['TEST_MIGRATION_DATABASE_URL'] ?? '').trim() });
  await client.connect();
  try {
    const database = await client.query<{ name: string }>('SELECT current_database() AS name');
    if (databaseNameRefusal(database.rows[0]?.name ?? '') !== null) return;
    const exists = await client.query<{ present: boolean }>(`SELECT to_regclass('public.organizations') IS NOT NULL AS present`);
    if (exists.rows[0]?.present !== true) return;
    await client.query(
      `UPDATE organizations SET review_status = 'rejected'
        WHERE review_status = 'pending_review' AND created_at < now() - interval '10 minutes'`,
    );
    // 롤링 24시간 상한 다섯은 실행을 거듭하면 로컬 DB 에서 찬다(행은 지울 수 없다) — 테스트 DB 에서만 올린다.
    //   상한을 보는 테스트는 롤백되는 트랜잭션 안에서 낮춘다.
    const limits = await client.query<{ present: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'signup_limits' AND column_name = 'member_org_daily_cap') AS present`,
    );
    if (limits.rows[0]?.present === true) {
      await client.query(
        `UPDATE signup_limits SET self_signup_daily_cap = greatest(self_signup_daily_cap, 1000000),
                                  waitlist_invite_daily_cap = greatest(waitlist_invite_daily_cap, 1000000),
                                  waitlist_remove_daily_cap = greatest(waitlist_remove_daily_cap, 1000000),
                                  waitlist_daily_cap = greatest(waitlist_daily_cap, 1000000),
                                  member_org_daily_cap = greatest(member_org_daily_cap, 1000000)`,
      );
    }
  } finally {
    await client.end();
  }
}
