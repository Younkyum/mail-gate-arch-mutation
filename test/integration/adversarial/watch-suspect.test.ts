/**
 * 적대적 검증 A — “의심스럽지만 설계 의도일 수 있다”는 항목. 현재 동작을 그대로 단언해 기록한다(통과 = 동작이 보고서와 같다).
 * 이름 앞 `SUSPECT:` — 고칠지는 리드가 정한다.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { createPostgresExposureRecorder } from '../../../src/db/repositories/exposure-store';
import { createPostgresReplyTargetLookup } from '../../../src/db/repositories/reply-target-store';
import { agentTaintActive, taintedSenders, type TaintExposure } from '../../../src/security/taint';
import { TEST_DLP_KEYRING } from '../../support/injection-doubles';
import { closeTestPool, DATABASE_AVAILABLE } from '../db/support/harness';
import { adminFixture, adminWorld, authed, call, closeAdminWorld, type AdminWorld } from './watch-admin-support';
import { exposureLevels, fakeScanner, INJECTION, OWNER_AVAILABLE, provisioningPool, receiveMail, rowFor, seedFixture, testPool, trust, type MsgRow } from './watch-support';

let w: AdminWorld;
beforeAll(() => {
  if (OWNER_AVAILABLE) w = adminWorld();
});
afterAll(async () => {
  if (OWNER_AVAILABLE) await closeAdminWorld(w);
  if (DATABASE_AVAILABLE) await closeTestPool();
});

describe.skipIf(!OWNER_AVAILABLE)('SUSPECT — 설계 의도일 수 있는 우회 · 틈', () => {
  it('[T1-S01] (고침) 공용 메일 도메인(gmail.com)은 도메인 항목으로 받지 않는다 — 그 도메인의 정확한 주소는 받는다', async () => {
    const f = await adminFixture(w);
    const saved = await call(w.deps, 'PATCH', '/api/watch/settings', authed(f.session, { body: { trustedSenders: ['gmail.com'] } }));
    expect(saved.statusCode).toBe(400);
    expect(saved.json()).toMatchObject({ error: 'trusted_sender_freemail_domain' });
    for (const domain of ['naver.com', 'gmx.de', 'atmark.ai']) {
      expect((await call(w.deps, 'PATCH', '/api/watch/settings', authed(f.session, { body: { trustedSenders: [domain] } }))).json()).toMatchObject({ error: 'trusted_sender_freemail_domain' });
    }
    await expect(provisioningPool().query(`INSERT INTO org_trusted_senders (organization_id, kind, value) VALUES ($1, 'domain', 'gmail.com')`, [f.orgId])).rejects.toThrow(
      /org_trusted_senders_not_freemail/,
    );
    expect((await call(w.deps, 'PATCH', '/api/watch/settings', authed(f.session, { body: { trustedSenders: ['boss@gmail.com'] } }))).statusCode).toBe(200);
    const r = await receiveMail(f, fakeScanner('high', INJECTION).scan, { from: 'anybody.at.all@gmail.com' });
    expect(r.row).toMatchObject({ trusted_bypass: false, quarantined: true });
  });
  it('SUSPECT: [T1-S02] 공개 접미사(co.uk)도 항목으로 받는다(해당 도메인으로 직접 보내는 사람만 일치 — 실질 영향 작음)', async () => {
    const f = await adminFixture(w);
    expect((await call(w.deps, 'PATCH', '/api/watch/settings', authed(f.session, { body: { trustedSenders: ['co.uk'] } }))).statusCode).toBe(200);
  });
  it('[T1-S03] (고침) From 과 다른 도메인의 Reply-To 가 있으면 우회하지 않는다 — 보통 메일처럼 격리 · 같은 도메인 Reply-To 는 우회', async () => {
    const f = await seedFixture(testPool());
    await trust(f, [['domain', 'partner.example']]);
    const r = await receiveMail(f, fakeScanner('high', INJECTION).scan, { from: 'ceo@partner.example', extraHeaders: ['Reply-To: attacker@evil.example'] });
    expect(r.row).toMatchObject({ trusted_bypass: false, quarantined: true, quarantine_reason: 'injection_risk' });
    const same = await receiveMail(f, fakeScanner('high', INJECTION).scan, { from: 'ceo@partner.example', extraHeaders: ['Reply-To: desk@partner.example'] });
    const row = same.row as MsgRow;
    expect(row.trusted_bypass).toBe(true);
    const rec = createPostgresExposureRecorder(testPool(), { keyring: TEST_DLP_KEYRING });
    const out = await rec.record({ agentId: f.agentId, surface: 'message_detail', items: [{ inboundMessageId: row.id, part: 'body', field: 'body', content: null, replyTo: ['attacker@evil.example'] }], codes: [] });
    expect(out.levels[0]).not.toBe('T2');
    const levels = await exposureLevels(f.agentId, row.id);
    const exposures: TaintExposure[] = levels.map((l) => ({ level: l.level === 2 ? 'T2' : 'T1', exposedAt: new Date(), threadId: row.thread_id, senderAddress: row.from_address }));
    expect(taintedSenders(exposures, new Date())).not.toContain('attacker@evil.example');
    expect(agentTaintActive(exposures, new Date())).toBe(false);
  });
  it('SUSPECT: [T1-S04] 우회된 high(인젝션) 메일은 소유자 알림 창도 만들지 않는다(조용히 통과 — 계정이 탈취된 신뢰 발신자는 소유자가 모른다)', async () => {
    const f = await seedFixture(testPool());
    await trust(f, [['domain', 'partner.example']]);
    await receiveMail(f, fakeScanner('high', INJECTION).scan, { from: 'ceo@partner.example' });
    expect((await provisioningPool().query('SELECT 1 FROM quarantine_notices WHERE agent_id = $1', [f.agentId])).rowCount).toBe(0);
  });
  it('SUSPECT: [T1-S05] 우회된 메일은 신뢰 목록에서 항목이 지워져도 그대로 보이고, 소급 숨김이 없다', async () => {
    const f = await seedFixture(testPool());
    await trust(f, [['domain', 'partner.example']]);
    const r = await receiveMail(f, fakeScanner('high', INJECTION).scan, { from: 'ceo@partner.example' });
    await trust(f, []);
    expect((await rowFor(f.agentId, r.ses))?.quarantined).toBe(false);
  });
  it('[S-001] (고침) 풀리지 않은 숨은 메일(위험 보류 · 격리 · 정책 차단)은 보낸 사람 신뢰 이력(수신 횟수)에 세지 않는다', async () => {
    const f = await seedFixture(testPool());
    const src = readFileSync(join(__dirname, '../../../src/db/repositories/trust-facts-store.ts'), 'utf8');
    expect(src).toMatch(/WHERE agent_id = \$1 AND from_address = \$2 AND NOT quarantined/);
    expect(src).not.toMatch(/quarantine_reason IS DISTINCT FROM 'policy_blocked'/);
    expect(f.agentId).toBeTruthy();
  });
  it('[S-002] 에이전트 표면(src/api · src/mcp)에는 inbound_messages 를 직접 읽는 SQL 이 없다(읽기 저장소 경유)', () => {
    const root = join(__dirname, '../../../src');
    const offenders: string[] = [];
    for (const dir of ['api', 'mcp']) {
      const walk = (path: string): void => {
        for (const entry of readdirSync(path, { withFileTypes: true })) {
          const full = join(path, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.name.endsWith('.ts') && /FROM\s+inbound_messages|JOIN\s+inbound_messages/i.test(readFileSync(full, 'utf8'))) offenders.push(full);
        }
      };
      walk(join(root, dir));
    }
    expect(offenders).toEqual([]);
  });
  it('[S-003] 풀린 메일에는 답장 대상 조회가 quarantined=false 를 준다(풀린 뒤에만 답할 수 있다)', async () => {
    const f = await adminFixture(w);
    const { receiveAdmin } = await import('./watch-admin-support');
    const m = await receiveAdmin(f, fakeScanner('high', INJECTION).scan);
    const lookup = createPostgresReplyTargetLookup(testPool());
    expect((await lookup.find(f.agentId, m.id))?.quarantined).toBe(true);
    await call(w.deps, 'POST', `/api/watch/held/${m.id}/release`, authed(f.session, { body: {} }));
    expect((await lookup.find(f.agentId, m.id))?.quarantined).toBe(false);
  });
});
