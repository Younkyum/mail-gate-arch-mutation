/**
 * 수신 — **운영자 검토 전·거절 조직의 에이전트는 받지 않는다**(보안 검증 M3, 202609240900). 실제 Postgres(앱 롤) + 로컬 객체 저장소.
 *
 * 되돌리면 빨개져야 하는 것:
 *   - `pending_review`·`rejected` 조직의 에이전트 주소로 온 메일 → `rejected` · `inbound_rejections(reason='org_not_active')` 한 행 ·
 *     `inbound_messages` 0행 · 파싱 본문(`inbound/parsed/`)을 만들지 않는다(원문을 읽기 전에 거른다).
 *   - 한 통에 활성 조직 에이전트와 검토 전 조직 에이전트가 같이 있으면 활성 쪽만 저장하고 나머지는 결말로.
 *   - 활성화(`active`)되면 다시 받는다.
 */

import { afterAll, describe, expect, it } from 'vitest';

import { closeTestPool, DATABASE_AVAILABLE, provisioningPool, seedFixture, testPool } from '../db/support/harness';
import { consumerDeps, deliver, eml, newObjectStore, newSesMessageId, objectExists, rejectionPairs, storedCount } from './support';

afterAll(async () => {
  if (DATABASE_AVAILABLE) await closeTestPool();
});

/** 검토 상태는 소유자 롤(운영자 CLI)만 바꾼다 — 트리거 `organizations_review_guard`. */
const setReview = (organizationId: string, status: 'pending_review' | 'rejected' | 'active') =>
  provisioningPool().query('UPDATE organizations SET review_status = $2 WHERE id = $1', [organizationId, status]);

describe.skipIf(!DATABASE_AVAILABLE)('수신 — 검토 전·거절 조직의 에이전트 (M3)', () => {
  it('pending_review·rejected → rejected(org_not_active) · 행 0 · 파싱 본문 없음 · 활성화 뒤에는 저장', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const objects = newObjectStore();
    const deps = consumerDeps(pool, objects);

    for (const status of ['pending_review', 'rejected'] as const) {
      await setReview(fixture.organizationId, status);
      const sesMessageId = newSesMessageId();
      expect(await deliver(deps, eml({ from: 'verify@service.example', to: fixture.address }), { sesMessageId, recipients: [fixture.address] })).toBe(
        'rejected',
      );
      expect(await rejectionPairs(sesMessageId), status).toEqual([['org_not_active', [fixture.address]]]);
      expect(await storedCount(fixture.agentId, sesMessageId)).toBe(0);
      expect(await objectExists(objects, deps.artifacts.parsedKeyFor(sesMessageId))).toBe(false);
      // 재전달해도 결말 한 행(멱등).
      expect(await deliver(deps, null, { sesMessageId, recipients: [fixture.address] })).toBe('rejected');
      expect(await rejectionPairs(sesMessageId)).toHaveLength(1);
    }

    // 비공허: 같은 에이전트가 활성 조직이면 받는다.
    await setReview(fixture.organizationId, 'active');
    const sesMessageId = newSesMessageId();
    expect(await deliver(deps, eml({ from: 'x@example.com', to: fixture.address }), { sesMessageId, recipients: [fixture.address] })).toBe('stored');
    expect(await storedCount(fixture.agentId, sesMessageId)).toBe(1);
    expect(await rejectionPairs(sesMessageId)).toEqual([]);
  });

  it('활성 조직 에이전트 + 검토 전 조직 에이전트 + 없는 주소가 한 통 → 활성 쪽만 저장, 나머지는 각자의 결말', async () => {
    const pool = testPool();
    const active = await seedFixture(pool);
    const pending = await seedFixture(pool);
    await setReview(pending.organizationId, 'pending_review');
    const deps = consumerDeps(pool, newObjectStore());

    const sesMessageId = newSesMessageId();
    const recipients = [active.address, pending.address, 'ghost-m3@atmark.ai'];
    expect(await deliver(deps, eml({ from: 'x@example.com' }), { sesMessageId, recipients })).toBe('stored');
    expect(await storedCount(active.agentId, sesMessageId)).toBe(1);
    expect(await storedCount(pending.agentId, sesMessageId)).toBe(0);
    expect(await rejectionPairs(sesMessageId)).toEqual([
      ['org_not_active', [pending.address]],
      ['unknown_recipient', ['ghost-m3@atmark.ai']],
    ]);
  });
});
