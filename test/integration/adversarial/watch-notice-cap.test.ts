/**
 * 적대적 검증 A-3 보강 — “차단 등급은 항상 알린다”가 위험 알림의 조직 하루 상한(20) 소진으로 깨지는가.
 * 알림 상한은 두 종류를 합쳐 센다(알림기). 위험 알림은 기본 켬이라, 정상 뉴스레터 · 공격자의 약한 표지 메일이 상한을 채울 수 있다.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';

import { QUARANTINE_NOTICES_PER_ORG_PER_DAY } from '../../../src/notify/quarantine-notice-template';
import { createQuarantineNotifier } from '../../../src/notify/quarantine-notifier';
import { runQuarantineNotifier } from '../../../src/workers/quarantine-notifier';
import { fakeSes } from '../admin/support';
import { closeTestPool, DATABASE_AVAILABLE } from '../db/support/harness';
import { fakeScanner, INJECTION, OWNER_AVAILABLE, provisioningPool, receiveMail, RISKY, seedFixture, setAgent, testPool } from './watch-support';

afterAll(async () => {
  if (DATABASE_AVAILABLE) await closeTestPool();
});

async function drain(organizationId: string): Promise<void> {
  const ses = fakeSes();
  const now = () => new Date(Date.now() + 5_000);
  await runQuarantineNotifier({ db: testPool(), notifier: createQuarantineNotifier({ pool: testPool(), client: ses.client, now }), now }, { organizationId });
}
const makeDueAll = (agentId: string) =>
  provisioningPool().query(`UPDATE quarantine_notices SET next_attempt_at = now() - interval '1 second' WHERE agent_id = $1 AND status = 'pending'`, [agentId]);

describe.skipIf(!OWNER_AVAILABLE)('A-3 알림 상한 — 위험 알림이 차단 알림을 밀어내는가', () => {
  it('VULN: [N-001] 위험 알림이 조직 하루 상한을 채운 뒤에 온 차단(high) 메일도 소유자에게 알려진다', async () => {
    const f = await seedFixture(testPool());
    await provisioningPool().query(`UPDATE organizations SET owner_email = $2 WHERE id = $1`, [f.organizationId, `cap-${randomUUID().slice(0, 8)}@example.com`]);
    // 위험(약한 표지) 메일이 한 창씩 나가 상한(20)을 채운다.
    for (let i = 0; i < QUARANTINE_NOTICES_PER_ORG_PER_DAY; i += 1) {
      await receiveMail(f, fakeScanner('low', RISKY).scan, { from: `news${String(i)}@partner.example` });
      await makeDueAll(f.agentId);
      await drain(f.organizationId);
    }
    const sentRisk = (await provisioningPool().query(`SELECT 1 FROM quarantine_notices WHERE agent_id = $1 AND kind = 'risk' AND status = 'sent'`, [f.agentId])).rowCount;
    expect(sentRisk).toBe(QUARANTINE_NOTICES_PER_ORG_PER_DAY);
    // 이제 진짜 인젝션(high) — 차단 등급은 항상 알린다.
    await receiveMail(f, fakeScanner('high', INJECTION).scan, { from: 'mallory@evil.example' });
    await makeDueAll(f.agentId);
    await drain(f.organizationId);
    const block = (await provisioningPool().query<{ status: string }>(`SELECT status FROM quarantine_notices WHERE agent_id = $1 AND kind = 'block'`, [f.agentId])).rows[0];
    expect(block?.status).toBe('sent');
  });

  it('[N-002] 대조: 위험 알림을 끄면(risk_notify=false) 같은 홍수에도 차단 알림은 나간다', async () => {
    const f = await seedFixture(testPool());
    await provisioningPool().query(`UPDATE organizations SET owner_email = $2 WHERE id = $1`, [f.organizationId, `cap-${randomUUID().slice(0, 8)}@example.com`]);
    await setAgent(f, null, false);
    for (let i = 0; i < 3; i += 1) await receiveMail(f, fakeScanner('low', RISKY).scan, { from: `news${String(i)}@partner.example` });
    await receiveMail(f, fakeScanner('high', INJECTION).scan, { from: 'mallory@evil.example' });
    await makeDueAll(f.agentId);
    await drain(f.organizationId);
    const block = (await provisioningPool().query<{ status: string }>(`SELECT status FROM quarantine_notices WHERE agent_id = $1 AND kind = 'block'`, [f.agentId])).rows[0];
    expect(block?.status).toBe('sent');
  });
});
