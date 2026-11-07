/**
 * `approval_link_uses` — **단일 사용의 집행은 DB 다.**
 *
 * 단위 테스트의 가짜 저장소는 배열이고 배열은 경합하지 않는다. 진짜 명제 — *"같은 링크가
 * 동시에 다섯 번 POST 돼도 결정은 하나"* — 는 유니크 인덱스가 참으로 만들고, 그것은 실제
 * Postgres 위에서만 확인된다. approval **상태** 조회는 가짜 맵이다 — 여기서 보는 것은 사용 기록과
 * 트랜잭션 경계뿐이다. 다만 `approval_id` 에 FK 가 걸렸으므로(202609222000) 행은 실재하는
 * `approval_requests` 를 가리켜야 한다(`realApproval`). 실제 전이까지 잇는 경로는
 * `approval-surface.test.ts` 가 본다.
 */

import { randomBytes, randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';

import {
  mintApprovalLinkToken,
  redeemApprovalLink,
  type ApprovalLinkPorts,
  type ApprovalLinkTarget,
  type ApprovalLinkUse,
} from '../../../src/approval/magic-link';
import { recordApprovalLinkUse } from '../../../src/db/repositories/approval-link-use-store';
import { parseHmacKeyring } from '../../../src/security/hmac-keyring';
import { closeTestPool, DATABASE_AVAILABLE, hex64, seedFixture, testPool } from '../db/support/harness';

const RING = parseHmacKeyring(`k1:${randomBytes(32).toString('base64url')}`, 'TEST');
const NOW = new Date();
const EXPIRES = new Date(NOW.getTime() + 3_600_000);

/** FK 를 만족하는 실재 승인 요청 하나(pending). 상태는 이 파일에서 보지 않는다. */
async function realApproval(): Promise<string> {
  const pool = testPool();
  const fixture = await seedFixture(pool);
  const id = randomUUID();
  await pool.query(
    `INSERT INTO approval_requests (id, agent_id, created_at, expires_at) VALUES ($1, $2, $3, $4)`,
    [id, fixture.agentId, new Date(EXPIRES.getTime() - 3_600_000), EXPIRES],
  );
  return id;
}

function use(approvalId: string, overrides: Partial<ApprovalLinkUse> = {}): ApprovalLinkUse {
  return {
    approvalId,
    tokenIdHash: hex64(),
    keyId: 'k1',
    decision: 'approve',
    usedAt: NOW,
    ...overrides,
  };
}

/** 실제 PG 트랜잭션 위의 포트. approval 은 가짜 맵, 사용 기록은 진짜 테이블. */
function pgPorts(targets: Map<string, ApprovalLinkTarget>, options: { readonly failResolve?: boolean } = {}): ApprovalLinkPorts {
  return {
    keyring: RING,
    findApprovalSummary: () => Promise.reject(new Error('이 파일은 미리보기를 쓰지 않는다')),
    async runInTransaction(work) {
      const client = await testPool().connect();
      try {
        await client.query('BEGIN');
        const result = await work({
          async findApprovalForUpdate(approvalId) {
            return targets.get(approvalId) ?? null;
          },
          recordUse: (entry) => recordApprovalLinkUse(client, entry),
          async resolveApproval() {
            if (options.failResolve === true) throw new Error('전이 실패');
          },
        });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

async function usesOf(approvalId: string): Promise<number> {
  const result = await testPool().query<{ count: string }>(
    'SELECT count(*)::text AS count FROM approval_link_uses WHERE approval_id = $1',
    [approvalId],
  );
  return Number(result.rows[0]?.count ?? '0');
}

afterAll(async () => {
  if (DATABASE_AVAILABLE) await closeTestPool();
});

describe.skipIf(!DATABASE_AVAILABLE)('approval_link_uses — 단일 사용을 유니크 인덱스가 집행한다', () => {
  it('같은 approval 의 두 번째 기록은 already_used 이고 행은 1개다', async () => {
    const first = use(await realApproval());
    expect(await recordApprovalLinkUse(testPool(), first)).toBe('recorded');
    // 다른 jti(재발급된 링크), 다른 결정이어도 approval 이 같으면 막힌다.
    expect(await recordApprovalLinkUse(testPool(), use(first.approvalId, { decision: 'reject' }))).toBe(
      'already_used',
    );
    expect(await usesOf(first.approvalId)).toBe(1);
  });

  it('같은 jti 는 다른 approval 로도 두 번 기록되지 않는다', async () => {
    const first = use(await realApproval());
    await recordApprovalLinkUse(testPool(), first);
    expect(await recordApprovalLinkUse(testPool(), use(await realApproval(), { tokenIdHash: first.tokenIdHash }))).toBe(
      'already_used',
    );
  });

  it('**동시** 5회 redeem → 결정 1개. 선조회였다면 여기서 다섯 다 통과한다', async () => {
    const approvalId = await realApproval();
    const targets = new Map<string, ApprovalLinkTarget>([[approvalId, { state: 'pending', expiresAt: EXPIRES }]]);
    const token = mintApprovalLinkToken(RING, { approvalId, expiresAt: EXPIRES });
    const ports = pgPorts(targets);

    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () => redeemApprovalLink(ports, { token, decision: 'approve' }, NOW)),
    );

    expect(outcomes.filter((o) => o.kind === 'redeemed')).toHaveLength(1);
    expect(outcomes.filter((o) => o.kind === 'rejected' && o.reason === 'already_used')).toHaveLength(4);
    expect(await usesOf(approvalId)).toBe(1);
  });

  it('상태 전이가 던지면 사용 기록도 롤백된다 — 그 뒤 같은 링크가 다시 통한다', async () => {
    const approvalId = await realApproval();
    const targets = new Map<string, ApprovalLinkTarget>([[approvalId, { state: 'pending', expiresAt: EXPIRES }]]);
    const token = mintApprovalLinkToken(RING, { approvalId, expiresAt: EXPIRES });

    await expect(redeemApprovalLink(pgPorts(targets, { failResolve: true }), { token, decision: 'approve' }, NOW)).rejects.toThrow();
    expect(await usesOf(approvalId)).toBe(0);
    expect((await redeemApprovalLink(pgPorts(targets), { token, decision: 'approve' }, NOW)).kind).toBe('redeemed');
    expect(await usesOf(approvalId)).toBe(1);
  });

  it('앱 롤은 사용 기록을 고치거나 지울 수 없다 — 지우면 재사용 허가가 된다', async () => {
    const entry = use(await realApproval());
    await recordApprovalLinkUse(testPool(), entry);
    await expect(
      testPool().query(`UPDATE approval_link_uses SET decision = 'reject' WHERE approval_id = $1`, [entry.approvalId]),
    ).rejects.toThrow(/permission denied/);
    await expect(testPool().query('DELETE FROM approval_link_uses WHERE approval_id = $1', [entry.approvalId])).rejects.toThrow(
      /permission denied/,
    );
  });

  it('FK — 존재하지 않는 approval 을 가리키는 사용 기록은 쓸 수 없다(쓴 적 없는 링크가 "이미 쓰임" 이 되지 않게)', async () => {
    await expect(recordApprovalLinkUse(testPool(), use(randomUUID()))).rejects.toMatchObject({ code: '23503' });
  });

  it('평문 토큰을 담을 컬럼이 없다', async () => {
    const result = await testPool().query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'approval_link_uses' ORDER BY column_name`,
    );
    expect(result.rows.map((r) => r.column_name)).toEqual([
      'approval_id',
      'decision',
      'id',
      'key_id',
      'token_id_hash',
      'used_at',
    ]);
  });
});
