/**
 * 고객 도메인 M3b — 알림 배출(`workers/domain-notifier` → `notify/domain-notifier`)과 비활성 조직 정리(틱 ①-b). 실제 Postgres.
 *
 *   ① 알림: 수신자 = 그 조직의 owner · admin(정의자 함수 — member · 다른 조직 · 지운 사용자 없음) · 발신 notify@atmark.ai · 받는 사람마다 그 사용자의 메일 언어 한 통(없으면 en) · 도메인 이름 ·
 *      그 도메인 주소를 대표로 쓰는 에이전트(이름 · 주소) · sent 로 닫힌다 · 다시 돌려도 두 번 가지 않는다.
 *   ② 사건이 더는 사실이 아니면 obsolete(보내지 않는다) — 정지가 풀린 뒤의 정지 알림 · 정지가 풀린 뒤의 제거 예고 · 다시 정지된 뒤의 확인 완료.
 *   ③ 조직 하루 상한(10) — 지난 24시간 보낸 알림이 10 이면 deferred(보내지 않고 미룬다). 상한은 두 칸(확인 완료 · 그 밖) — 서로의 몫을 먹지 않는다.
 *   ④ 비활성 조직(운영자 거절)의 살아 있는 행 → 틱이 removed(pending 은 제거 사가 끝 · identity 가 있던 행은 사가가 잇는다) · 알림 없음.
 */

import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runDomainTick } from '../../../src/domains/lifecycle';
import { insertNotice } from '../../../src/domains/store';
import { createPool } from '../../../src/db/client';
import { DOMAIN_NOTICES_PER_ORG_PER_DAY } from '../../../src/domains/contract';
import { createDomainNotifier } from '../../../src/notify/domain-notifier';
import { runDomainNotifier } from '../../../src/workers/domain-notifier';
import { fakeSes, mailText } from '../admin/support';
import { closeTestPool, DATABASE_AVAILABLE, provisioningPool, seedFixture, testPool, type Fixture } from '../db/support/harness';
import { addAlias, suspendDomain, verifiedCustomDomain } from '../policy/support';
import { domainState, fakeInvoker, fakeWorld, newApex, OWNER_URL, pendingDomain, tickPool } from './support';

const AVAILABLE = DATABASE_AVAILABLE && OWNER_URL.trim() !== '' && (process.env['TEST_DATABASE_URL'] ?? '').trim() !== '';

describe.skipIf(!AVAILABLE)('고객 도메인 알림 · 비활성 조직', () => {
  let app: Pool;
  let tick: Pool;

  beforeAll(() => {
    app = createPool(process.env['TEST_DATABASE_URL'] ?? '', { max: 2 });
    tick = tickPool();
  });
  afterAll(async () => {
    await Promise.all([app.end(), tick.end()]);
    await closeTestPool();
  });

  async function member(organizationId: string, role: 'owner' | 'admin' | 'member'): Promise<string> {
    const owner = provisioningPool();
    const email = `dn-${role}-${randomUUID().slice(0, 8)}@example.com`;
    const user = await owner.query<{ id: string }>('INSERT INTO users (email) VALUES ($1) RETURNING id', [email]);
    await owner.query(`INSERT INTO memberships (user_id, organization_id, role, joined_via) VALUES ($1, $2, $3, 'invite')`, [user.rows[0]?.id, organizationId, role]);
    return email;
  }

  async function notice(f: Fixture, domainId: string, kind: string, eventKey = `t:${randomUUID().slice(0, 8)}`): Promise<string> {
    const row = await provisioningPool().query<{ id: string }>(
      `INSERT INTO domain_notices (domain_id, organization_id, kind, event_key) VALUES ($1, $2, $3, $4) RETURNING id::text AS id`,
      [domainId, f.organizationId, kind, eventKey],
    );
    return row.rows[0]?.id ?? '';
  }

  async function statusOf(id: string): Promise<{ status: string; last_error: string | null }> {
    return (await provisioningPool().query<{ status: string; last_error: string | null }>('SELECT status, last_error FROM domain_notices WHERE id = $1', [id])).rows[0] ?? {
      status: '',
      last_error: null,
    };
  }

  function drain(organizationId: string, ses = fakeSes()) {
    // DB 시계(next_attempt_at DEFAULT now())가 JS 시계보다 조금 앞설 수 있다 — 2초 앞에서 돈다.
    const now = (): Date => new Date(Date.now() + 2_000);
    return {
      ses,
      run: () => runDomainNotifier({ db: app, notifier: createDomainNotifier({ pool: app, client: ses.client, now }), now }, { organizationId }),
    };
  }

  it('① owner · admin 에게만 · notify@ · 받는 사람마다 그 언어 한 통(owner=ko · admin=기본 en) · 도메인 · 대표로 쓰는 에이전트 · sent 로 닫힌다 · 두 번 가지 않는다', async () => {
    const f = await seedFixture(testPool());
    const other = await seedFixture(testPool());
    const ownerEmail = await member(f.organizationId, 'owner');
    const adminEmail = await member(f.organizationId, 'admin');
    const memberEmail = await member(f.organizationId, 'member');
    const outsider = await member(other.organizationId, 'owner');
    await provisioningPool().query(`UPDATE users SET mail_locale = 'ko' WHERE email = $1`, [ownerEmail]);
    const { id: domainId, domain } = await verifiedCustomDomain(f.organizationId);
    const custom = `sales-${randomUUID().slice(0, 6)}@${domain}`;
    await addAlias(f.agentId, custom);
    await provisioningPool().query(
      `INSERT INTO agent_primary_changes (agent_id, address_id, cause) SELECT $1, id, 'owner' FROM agent_addresses WHERE address = $2`,
      [f.agentId, custom],
    );
    await suspendDomain(domainId, 'dkim_failed');
    const id = await notice(f, domainId, 'suspended');
    const { ses, run } = drain(f.organizationId);
    expect(await run()).toMatchObject({ sent: 1 });
    expect(ses.sent.map((mail) => mail.to[0]).sort()).toEqual([adminEmail, ownerEmail].sort());
    expect(ses.sent.map((mail) => mail.to[0])).not.toContain(memberEmail);
    expect(ses.sent.map((mail) => mail.to[0])).not.toContain(outsider);
    for (const mail of ses.sent) {
      expect(mail.from).toBe('notify@atmark.ai');
      expect(mail.raw).toMatch(/^From: "Atmark" <notify@atmark\.ai>\r?$/m);
      const text = mailText(mail);
      expect(text).toContain(domain);
      // 2026-10-10 개편 — 대표로 쓰던 에이전트 목록 · 레코드 이름(DKIM)은 콘솔에(본문에 없다).
      expect(text).not.toContain(custom);
      expect(text).not.toContain('DKIM');
      expect(text).toContain('https://console.atmark.ai/app#/domains');
      if (mail.to[0] === ownerEmail) {
        expect(text.startsWith('도메인을 정지했습니다\n')).toBe(true);
        expect(text).toContain('도메인의 발신 설정을 확인하지 못해 정지했습니다');
        expect(text).not.toContain("We couldn't confirm");
      } else {
        expect(text).toContain("We couldn't confirm the sending settings for");
        expect(text).not.toMatch(/[가-힣]/);
      }
      expect(text).toContain('https://console.atmark.ai/app#/domains');
    }
    expect(await statusOf(id)).toEqual({ status: 'sent', last_error: null });
    const again = drain(f.organizationId);
    await again.run();
    expect(again.ses.sent).toEqual([]);
  });

  it('② 사건이 더는 사실이 아니면 obsolete — 풀린 뒤의 정지 알림 · 풀린 뒤의 제거 예고(보내지 않는다)', async () => {
    const f = await seedFixture(testPool());
    await member(f.organizationId, 'owner');
    const { id: domainId } = await verifiedCustomDomain(f.organizationId);
    const suspended = await notice(f, domainId, 'suspended');
    const d3 = await notice(f, domainId, 'removal_d3');
    const removed = await notice(f, domainId, 'removed');
    const { ses, run } = drain(f.organizationId);
    expect(await run()).toMatchObject({ obsolete: 2, sent: 1 });
    expect(await statusOf(suspended)).toEqual({ status: 'obsolete', last_error: 'state_changed' });
    expect(await statusOf(d3)).toEqual({ status: 'obsolete', last_error: 'state_changed' });
    expect((await statusOf(removed)).status).toBe('sent');
    expect(ses.sent).toHaveLength(1);
  });

  it('②-b 확인 완료(verified) — verified 면 보낸다(받는 사람의 언어 — 고르지 않았으면 en · 도메인) · 다시 정지됐으면 obsolete', async () => {
    const f = await seedFixture(testPool());
    await member(f.organizationId, 'owner');
    const { id: domainId, domain } = await verifiedCustomDomain(f.organizationId);
    const first = await notice(f, domainId, 'verified', 'verified:1');
    const sent = drain(f.organizationId);
    expect(await sent.run()).toMatchObject({ sent: 1 });
    expect(sent.ses.sent).toHaveLength(1);
    const text = mailText(sent.ses.sent[0] ?? { from: '', to: [], raw: '' });
    expect(text).toContain(domain);
    expect(text).toContain(`${domain} is verified and ready to use.`);
    expect(text).not.toContain('도메인 확인이 끝났습니다');
    expect(await statusOf(first)).toEqual({ status: 'sent', last_error: null });

    await suspendDomain(domainId, 'dkim_failed');
    const second = await notice(f, domainId, 'verified', 'recovered:2');
    const stale = drain(f.organizationId);
    expect(await stale.run()).toMatchObject({ obsolete: 1 });
    expect(await statusOf(second)).toEqual({ status: 'obsolete', last_error: 'state_changed' });
    expect(stale.ses.sent).toEqual([]);
  });

  it('②-b2 복귀 회차(사건 키 recovered:…) — 복귀 문구로 보낸다(DKIM 을 확인했다고 말하지 않는다)', async () => {
    const f = await seedFixture(testPool());
    await member(f.organizationId, 'owner');
    const { id: domainId } = await verifiedCustomDomain(f.organizationId);
    await notice(f, domainId, 'verified', 'recovered:1');
    const { ses, run } = drain(f.organizationId);
    expect(await run()).toMatchObject({ sent: 1 });
    const text = mailText(ses.sent[0] ?? { from: '', to: [], raw: '' });
    expect(text).toContain('can be used again');
    expect(text).not.toContain('도메인 확인이 끝났습니다');
  });

  it('②-c 만료 예고 — 틱이 적는 사건 키(d7:<만료일>)에서 남은 날을 읽는다', async () => {
    const f = await seedFixture(testPool());
    await member(f.organizationId, 'owner');
    const { id: domainId } = await verifiedCustomDomain(f.organizationId);
    await notice(f, domainId, 'expiry_warning', 'd7:20261025');
    const { ses, run } = drain(f.organizationId);
    expect(await run()).toMatchObject({ sent: 1 });
    const text = mailText(ses.sent[0] ?? { from: '', to: [], raw: '' });
    expect(text).toContain('about 7 days');
  });

  it(`③ 조직 하루 상한(${String(DOMAIN_NOTICES_PER_ORG_PER_DAY)}) — 지난 24시간 보낸 알림이 상한이면 deferred`, async () => {
    const f = await seedFixture(testPool());
    await member(f.organizationId, 'owner');
    const { id: domainId } = await verifiedCustomDomain(f.organizationId);
    for (let i = 0; i < DOMAIN_NOTICES_PER_ORG_PER_DAY; i += 1) {
      const sentId = await notice(f, domainId, 'removed');
      await provisioningPool().query(`UPDATE domain_notices SET status = 'sent', claimed_at = now(), sent_at = now(), ses_message_id = $2 WHERE id = $1`, [sentId, `m-${String(i)}`]);
    }
    const pending = await notice(f, domainId, 'removed');
    const { ses, run } = drain(f.organizationId);
    expect(await run()).toMatchObject({ deferred: 1 });
    expect(ses.sent).toEqual([]);
    expect((await statusOf(pending)).status).toBe('pending');
  });

  it(`③-b 상한은 두 칸 — 확인 완료(verified) ${String(DOMAIN_NOTICES_PER_ORG_PER_DAY)}건이 차도 정지 알림은 적히고 보내진다 · 그 반대도`, async () => {
    const f = await seedFixture(testPool());
    await member(f.organizationId, 'owner');
    const { id: domainId } = await verifiedCustomDomain(f.organizationId);
    const row = { id: domainId, organizationId: f.organizationId };
    const db = provisioningPool();
    // 적기(틱) — verified 칸이 차면 verified 만 capped, 정지는 들어간다.
    for (let i = 0; i < DOMAIN_NOTICES_PER_ORG_PER_DAY; i += 1) expect(await insertNotice(db, row, { kind: 'verified', eventKey: `verified:${String(i)}` })).toBe('inserted');
    expect(await insertNotice(db, row, { kind: 'verified', eventKey: 'verified:overflow' })).toBe('capped');
    expect(await insertNotice(db, row, { kind: 'suspended', eventKey: 'dkim_failed:1' })).toBe('inserted');
    expect(await insertNotice(db, row, { kind: 'suspended', eventKey: 'dkim_failed:1' })).toBe('duplicate');
    // 정지 계열 칸을 채우면 정지 계열만 capped(verified 칸은 따로 — 이미 차 있어 capped 인 것과 무관하게 세는 칸이 다르다).
    for (let i = 2; i <= DOMAIN_NOTICES_PER_ORG_PER_DAY; i += 1) expect(await insertNotice(db, row, { kind: 'removed', eventKey: `removed:${String(i)}` })).toBe('inserted');
    expect(await insertNotice(db, row, { kind: 'expiry_warning', eventKey: 'd7:20261025' })).toBe('capped');

    // 보내기(알림기) — 정지 계열로 보낸 것이 10 이어도 확인 완료는 미루지 않는다.
    const g = await seedFixture(testPool());
    await member(g.organizationId, 'owner');
    const { id: other } = await verifiedCustomDomain(g.organizationId);
    for (let i = 0; i < DOMAIN_NOTICES_PER_ORG_PER_DAY; i += 1) {
      const sentId = await notice(g, other, 'removed');
      await db.query(`UPDATE domain_notices SET status = 'sent', claimed_at = now(), sent_at = now(), ses_message_id = $2 WHERE id = $1`, [sentId, `m-${String(i)}`]);
    }
    const verifiedId = await notice(g, other, 'verified', 'verified:1');
    const { ses, run } = drain(g.organizationId);
    expect(await run()).toMatchObject({ sent: 1 });
    expect(ses.sent).toHaveLength(1);
    expect((await statusOf(verifiedId)).status).toBe('sent');
  });

  it('④ 비활성 조직(운영자 거절) — 틱이 살아 있는 행을 removed 로 · pending 은 사가 끝 · verified 는 사가가 잇는다 · 알림 없음', async () => {
    const f = await seedFixture(testPool(), { plan: 'team' });
    const apex = newApex();
    const pending = await pendingDomain(f.organizationId, `agents.${apex}`, apex);
    const { id: verifiedId } = await verifiedCustomDomain(f.organizationId);
    await provisioningPool().query(`UPDATE organizations SET review_status = 'rejected', reviewed_at = now() WHERE id = $1`, [f.organizationId]);
    const world = fakeWorld();
    world.unavailable = true; // 정리는 SES 호출 없이 된다(domain-control 이 없어도).
    await runDomainTick({ pool: tick as never, invoker: fakeInvoker(world), now: () => new Date(Date.now() + 60_000), scope: { organizationIds: [f.organizationId] } });
    expect(await domainState(pending.id)).toMatchObject({ status: 'removed', removal_step: 'done' });
    expect(await domainState(verifiedId)).toMatchObject({ status: 'removed', removal_step: 'none' });
    const notices = await provisioningPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM domain_notices WHERE organization_id = $1`, [f.organizationId]);
    expect(notices.rows[0]?.n).toBe(0);
    // 활성 조직은 그대로다(대조군).
    const live = await seedFixture(testPool());
    const { id: liveId } = await verifiedCustomDomain(live.organizationId);
    await runDomainTick({ pool: tick as never, invoker: fakeInvoker(fakeWorld()), now: () => new Date(Date.now() + 60_000), scope: { organizationIds: [live.organizationId] } });
    expect((await domainState(liveId))['status']).toBe('verified');
  });
});
