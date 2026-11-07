/** 통합 globalSetup 정리 조건 넷 — 조건마다 하나씩 어긋나게 해 거절을 고정한다. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { REPO_ROOT } from '../../modules';
import { CLEANUP_ENV, cleanupRefusal, databaseNameRefusal, PRODUCTION_TUNNEL_PORT } from '../../support/integration-global-setup';

const LOCAL = 'postgres://me@localhost:5432/atmark_v2';

function env(overrides: Record<string, string | undefined>): Record<string, string | undefined> {
  return { [CLEANUP_ENV]: '1', TEST_MIGRATION_DATABASE_URL: LOCAL, ...overrides };
}

describe('integration globalSetup — 정리 조건(N6)', () => {
  it('넷이 다 맞으면 돈다 — 로컬 호스트 셋 · 포트 생략(5432)', () => {
    expect(cleanupRefusal(env({}))).toBeNull();
    for (const url of ['postgres://me@127.0.0.1:5432/atmark_v2', 'postgres://me@[::1]:5432/atmark_v2', 'postgres://me@localhost/atmark_test']) {
      expect(cleanupRefusal(env({ TEST_MIGRATION_DATABASE_URL: url })), url).toBeNull();
    }
    for (const name of ['atmark_v2', 'atmark_v13', 'atmark_test', 'atmark_test_x2', 'atmark_testrun']) {
      expect(databaseNameRefusal(name), name).toBeNull();
    }
  });

  it('① ATMARK_TEST_DB_CLEANUP 가 정확히 1 이 아니면 돌지 않는다', () => {
    for (const value of [undefined, '', '0', 'true', 'yes', ' 1']) {
      expect(cleanupRefusal(env({ [CLEANUP_ENV]: value })), String(value)).toMatch(CLEANUP_ENV);
    }
  });

  it('URL 이 없거나 읽을 수 없으면 돌지 않는다', () => {
    expect(cleanupRefusal(env({ TEST_MIGRATION_DATABASE_URL: undefined }))).not.toBeNull();
    expect(cleanupRefusal(env({ TEST_MIGRATION_DATABASE_URL: '   ' }))).not.toBeNull();
    expect(cleanupRefusal(env({ TEST_MIGRATION_DATABASE_URL: 'not a url' }))).not.toBeNull();
  });

  it('② 로컬이 아닌 호스트면 돌지 않는다', () => {
    for (const host of ['db.example.com', 'atmark.abc.ap-northeast-2.rds.amazonaws.com', '10.0.0.5', 'localhost.evil.com']) {
      expect(cleanupRefusal(env({ TEST_MIGRATION_DATABASE_URL: `postgres://me@${host}:5432/atmark_v2` })), host).toMatch(/로컬이 아니다/);
    }
  });

  it('③ 로컬이어도 포트 15432(운영 터널)면 돌지 않는다', () => {
    expect(PRODUCTION_TUNNEL_PORT).toBe(15432);
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      expect(cleanupRefusal(env({ TEST_MIGRATION_DATABASE_URL: `postgres://me@${host}:15432/atmark_v2` })), host).toMatch(/15432/);
    }
    // 이웃 포트는 운영 표지가 아니다.
    expect(cleanupRefusal(env({ TEST_MIGRATION_DATABASE_URL: 'postgres://me@localhost:15433/atmark_v2' }))).toBeNull();
  });

  it('④ current_database() 가 테스트 DB 이름 규칙에 맞지 않으면 돌지 않는다', () => {
    for (const name of ['atmark', 'atmark_verify', 'atmark_v', 'atmark_vx', 'atmark_prod', 'postgres', 'atmark_v2_old', 'xatmark_v2', 'atmark_test-1', '']) {
      expect(databaseNameRefusal(name), name).not.toBeNull();
    }
  });

  it('통합을 돌리는 스크립트(test:int · test:coverage · test:mod · test:changed)가 ATMARK_TEST_DB_CLEANUP=1 을 켠다', () => {
    const scripts = (JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;
    for (const name of ['test:int', 'test:coverage', 'test:mod', 'test:changed']) {
      expect(scripts[name], name).toMatch(new RegExp(`(^|\\s)${CLEANUP_ENV}=1\\s`));
    }
  });
});
