/**
 * §5.2 V5 — **`messages` 의 컬럼 집합은 화이트리스트의 부분집합이다.**
 *
 * 크기 상한이 아니라 화이트리스트인 이유: 40KB 평문 본문 컬럼은 어떤 크기 검사도
 * 통과하면서 PRD 제약("raw email 을 Postgres 에 저장하지 않는다")을 위반한다.
 * 그리고 이 단언은 **마이그레이션이 실제로 만든 것**을 본다 — `src/db/schema.ts` 의
 * 타입은 사람이 쓴 주장이고, 이 테스트가 그 주장과 DB 를 맞붙인다.
 */

import { afterAll, describe, expect, it } from 'vitest';

import {
  AGENT_TOKEN_CAPABILITY_VALUES,
  MESSAGES_COLUMN_WHITELIST,
  P1A_TABLES,
} from '../../../src/db/schema';
import { AGENT_TOKEN_CAPABILITIES } from '../../../src/identity/agent-token';
import { closeTestPool, DATABASE_AVAILABLE, testPool } from './support/harness';

async function columnsOf(table: string): Promise<string[]> {
  const result = await testPool().query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY column_name`,
    [table],
  );
  return result.rows.map((row) => row.column_name);
}

describe.skipIf(!DATABASE_AVAILABLE)('스키마 형태', () => {
  afterAll(closeTestPool);

  it('P1a 의 8테이블이 전부 있다', async () => {
    const result = await testPool().query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [[...P1A_TABLES]],
    );
    expect(result.rows.map((row) => row.table_name).sort()).toEqual([...P1A_TABLES].sort());
  });

  it('§5.2 V5 — messages 의 컬럼은 화이트리스트 안이다', async () => {
    const actual = await columnsOf('messages');
    expect(actual.length).toBeGreaterThan(0);
    // 본문성 컬럼이 하나라도 늘면 여기서 걸린다. 화이트리스트를 늘리려면 §5.2 V5 를 다시 읽어야 한다.
    const whitelist: readonly string[] = MESSAGES_COLUMN_WHITELIST;
    expect(actual.filter((column) => !whitelist.includes(column))).toEqual([]);
  });

  it('recipient_count 가 실재한다 — 워밍업 캡의 눈금이 여기 달려 있다', async () => {
    expect(await columnsOf('messages')).toContain('recipient_count');
  });

  it('agent_token_capability ENUM 이 TS 유니온 두 벌과 같은 집합이다', async () => {
    const result = await testPool().query<{ value: string }>(
      `SELECT e.enumlabel AS value
         FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'agent_token_capability'
        ORDER BY e.enumsortorder`,
    );
    const dbValues = result.rows.map((row) => row.value);
    expect(dbValues).toEqual([...AGENT_TOKEN_CAPABILITY_VALUES]);
    expect(dbValues).toEqual([...AGENT_TOKEN_CAPABILITIES]);
  });

  it('agent_api_keys 에 평문 컬럼이 없다', async () => {
    const columns = await columnsOf('agent_api_keys');
    expect(columns).toEqual([
      'agent_id',
      'capabilities',
      'created_at',
      'expires_at',
      // 202609301530 — 처음 쓰인 분(트리거가 한 번 적는다, 비밀 아님).
      'first_used_at',
      'hint',
      'id',
      'label',
      'last_used_at',
      'revoked_at',
      'token_hash',
      // 202609301410 — 웹훅 관리 전환 경로 자격(불리언, 비밀 아님).
      'webhooks_legacy_eligible',
    ]);
  });

  it('앱 롤은 public 스키마에 테이블을 만들 수 없다 (마이그레이션 4의 REVOKE)', async () => {
    // 만들 수 있으면 감사 밖의 저장소가 생긴다. 권한 경계가 실제로 서 있는지를
    // 앱 롤 커넥션으로 확인한다 — 소유자 롤로 붙으면 이 단언은 아무것도 증명하지 않는다.
    await expect(testPool().query('CREATE TABLE should_not_exist (id int)')).rejects.toThrow();
  });
});
