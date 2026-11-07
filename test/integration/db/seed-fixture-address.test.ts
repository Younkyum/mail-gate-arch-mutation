/**
 * `seedFixture` 의 주소는 **공유 테스트 DB 에서 겹치지 않아야 한다** — 겹치면 CI 가 가끔 빨개진다(main CI 38411952104,
 * forward.test.ts "★ 남의 에이전트 메일 — 403" 이 `agent_addresses: address is not available` 로 실패, 재실행엔 통과).
 *
 * 원인: 로컬파트가 에이전트 id 앞 8자(32비트)뿐이었다. 한 실행에서 심는 주소가 수천 개고, 에이전트 삭제(#89)·퇴역 테스트가 남긴
 * 주소는 다른 조직에 **30일** 재발급 보류(`agent_addresses_reissue_hold`)라서 — 활성 주소만이 아니라 퇴역한 것과도 생일 충돌이 난다.
 * 충돌이 나면 보류 트리거가 값을 밝히지 않고 23505 로 거부한다(탐침 방지) — 재시도로 가릴 수도 없다. 그래서 엔트로피를 키웠다(64비트).
 *
 * 되돌리면 빨개져야 하는 것: ① 로컬파트가 id 앞 16자 이상 ② 다른 조직이 퇴역한 주소는 보류에 걸린다(충돌이 실제 위험임을 못 박는다)
 * ③ 심은 여러 픽스처의 주소는 서로 다르다.
 */

import { afterAll, describe, expect, it } from 'vitest';

import { closeTestPool, codeOf, DATABASE_AVAILABLE, provisioningPool, seedFixture, testPool } from './support/harness';

afterAll(async () => {
  if (DATABASE_AVAILABLE) await closeTestPool();
});

describe.skipIf(!DATABASE_AVAILABLE)('seedFixture 주소 — 충돌 방지', () => {
  it('로컬파트가 에이전트 id 앞 16자(64비트)를 싣는다', async () => {
    const f = await seedFixture(testPool());
    expect(f.address).toBe(`agent-${f.agentId.slice(0, 16)}@atmark.ai`);
  });

  it('여러 픽스처의 주소는 서로 다르다', async () => {
    const fixtures = await Promise.all(Array.from({ length: 8 }, () => seedFixture(testPool())));
    expect(new Set(fixtures.map((f) => f.address)).size).toBe(fixtures.length);
  });

  it('다른 조직이 퇴역한 주소는 30일 보류에 걸려 23505 로 거부된다 — 겹치면 픽스처가 깨지는 이유', async () => {
    const retiring = await seedFixture(testPool());
    const other = await seedFixture(testPool());
    const db = provisioningPool();
    const alias = `hold-${retiring.agentId.slice(0, 16)}@atmark.ai`;
    const insert = (agentId: string) =>
      db.query(`INSERT INTO agent_addresses (agent_id, address, domain, is_primary) VALUES ($1, $2, 'atmark.ai', false)`, [agentId, alias]);
    await insert(retiring.agentId);
    await db.query('UPDATE agent_addresses SET retired_at = now() WHERE address = $1', [alias]);
    expect(await codeOf(() => insert(other.agentId))).toBe('23505');
    await insert(retiring.agentId); // 같은 조직은 곧바로 다시 받는다 — 보류는 다른 조직에게만.
  });
});
