/**
 * 받기 등급(ADR-0016 2026-10-08 · 202610081000~1003) — **실제 Postgres** 위에서 수신 소비자부터 행 · 알림 창 · 에이전트 표면 · 노출 등급까지.
 *
 *   ① 모든 메일이 스캐너를 지난다 — 메일마다 한 번(에이전트 수 · 우회 · 정책 차단과 무관), 모든 행에 판정 · 적중이 남는다.
 *   ② 위험(기본 deliver): 보이고 · 웹훅이 나가고 · 등급 risk · 위험 알림 창(risk_delivered) · 차단 창과 따로.
 *   ③ 위험 + hold: 격리처럼 숨고(risk_hold — 목록 · 상세 · 웹훅 없음) · 창 항목 risk_hold.
 *   ④ risk_notify=false: 위험 창이 없다 · 차단 알림은 그대로(항상).
 *   ⑤ 신뢰 발신자 우회: DMARC 인증 + 정확한 도메인/주소 → 격리 없음 · 등급 none · trusted_bypass · 적중은 남는다 · 노출은 T2 가 아니다.
 *      DMARC 실패 · 하위 도메인 · 스캐너 오류(fail closed) · 정책 차단은 우회하지 않는다.
 *   ⑥ 풀기(정의자 함수): 보이게 되고 · message.received 웹훅 · 노출은 T2 · 다시 풀면 replayed · 정책 차단 · 판정 없음은 거부 ·
 *      웹훅 본문이 이 메일의 것이 아니면 거부 · 칸만 바꾸는 UPDATE 는 가드가 막는다 · 앱 롤은 설정을 쓰지 못한다.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';

import { changePolicyOp, resolvePolicyChange } from '../../../src/admin/ops/policy';
import { addRuleOp, resolveContactRuleInput } from '../../../src/admin/ops/rules';
import { createPostgresExposureRecorder } from '../../../src/db/repositories/exposure-store';
import { createPostgresInboundReadStore } from '../../../src/db/repositories/inbound-read-store';
import type { InjectionScanInput, InjectionScanResult } from '../../../src/security/injection/scanner';
import { messageReceivedEvent } from '../../../src/webhooks/events';
import { TEST_DLP_KEYRING } from '../../support/injection-doubles';
import { closeTestPool, DATABASE_AVAILABLE, provisioningPool, seedFixture, testPool, type Fixture } from '../db/support/harness';
import { consumerDeps, deliver, eml, newObjectStore, newSesMessageId } from './support';

const OWNER_AVAILABLE = DATABASE_AVAILABLE && (process.env['TEST_MIGRATION_DATABASE_URL'] ?? '').trim() !== '';

afterAll(async () => {
  if (DATABASE_AVAILABLE) await closeTestPool();
});

type Family = [family: string, damped: boolean];

/** 결정론 스캐너 — 스캐너 규칙(C 묶음)이 바뀌어도 이 시험의 등급 사실이 흔들리지 않게. 부른 횟수를 센다. */
function fakeScanner(risk: InjectionScanResult['injectionRisk'], families: readonly Family[], quarantine = risk === 'medium' || risk === 'high') {
  const calls: InjectionScanInput[] = [];
  const scan = (input: InjectionScanInput): InjectionScanResult => {
    calls.push(input);
    return {
      injectionRisk: risk,
      scannerVersion: 'test-watch-1',
      quarantine,
      findings: families.map(([family, damped], index) => ({
        ruleId: `test.${family}`,
        family,
        field: 'text',
        view: 'raw',
        fieldIndex: 0,
        start: index,
        end: index + 1,
        weight: 1,
        damped,
      })),
    } as unknown as InjectionScanResult;
  };
  return { scan, calls };
}

interface Row {
  id: string;
  thread_id: string;
  quarantined: boolean;
  quarantine_reason: string | null;
  watch_level: string | null;
  trusted_bypass: boolean;
  injection_risk: string | null;
  scanner_version: string | null;
  released_at: Date | null;
  findings: number;
}

async function rowOf(f: Fixture, sesMessageId: string): Promise<Row> {
  const result = await provisioningPool().query<Row>(
    `SELECT m.id, m.thread_id, m.quarantined, m.quarantine_reason, m.watch_level, m.trusted_bypass, m.injection_risk, m.scanner_version, m.released_at,
            (SELECT count(*)::int FROM security_findings s WHERE s.inbound_message_id = m.id) AS findings
       FROM inbound_messages m WHERE m.agent_id = $1 AND m.ses_message_id = $2`,
    [f.agentId, sesMessageId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('행이 없다');
  return row;
}

async function windows(agentId: string): Promise<{ kind: string; message_count: number; reasons: string[] }[]> {
  return (
    await provisioningPool().query<{ kind: string; message_count: number; reasons: string[] }>(
      `SELECT n.kind, n.message_count, array(SELECT i.reason FROM quarantine_notice_items i WHERE i.notice_id = n.id ORDER BY i.reason) AS reasons
         FROM quarantine_notices n WHERE n.agent_id = $1 ORDER BY n.kind`,
      [agentId],
    )
  ).rows;
}

async function webhookCount(inboundMessageId: string): Promise<number> {
  const result = await provisioningPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM webhook_deliveries WHERE dedupe_key = $1`, [
    `message.received:${inboundMessageId}`,
  ]);
  return result.rows[0]?.n ?? 0;
}

async function withWebhook(f: Fixture): Promise<void> {
  await provisioningPool().query(`INSERT INTO webhook_endpoints (agent_id, url, secret_kid) VALUES ($1, $2, 'k1')`, [
    f.agentId,
    `https://hook-${randomUUID()}.example.com/`,
  ]);
}

async function setAgent(f: Fixture, handling: 'deliver' | 'hold' | null, notify: boolean | null): Promise<void> {
  // 시드 조직에는 owner 멤버십이 없다 — 위험 보류 풀기(hold → deliver)는 owner 만이라(202610081103) 그 경우는 소유자 롤로 행을 바로 적는다(이 시험은 소비자 동작).
  const current = await provisioningPool().query<{ risk_handling: string }>('SELECT risk_handling FROM agent_watch_settings WHERE agent_id = $1', [f.agentId]);
  if (handling === 'deliver' && current.rows[0]?.risk_handling === 'hold') {
    await provisioningPool().query(
      `UPDATE agent_watch_settings SET risk_handling = 'deliver', risk_notify = coalesce($2, risk_notify), updated_at = now() WHERE agent_id = $1`,
      [f.agentId, notify],
    );
    return;
  }
  await provisioningPool().query('SELECT * FROM atmark_watch_set_agent($1, $2, $3, $4, $5)', [f.organizationId, f.agentId, handling, notify, randomUUID()]);
}

async function trust(f: Fixture, entries: readonly [kind: 'address' | 'domain', value: string][]): Promise<void> {
  await provisioningPool().query('SELECT * FROM atmark_watch_set_trusted_senders($1, $2::text[], $3::text[], $4)', [
    f.organizationId,
    entries.map(([kind]) => kind),
    entries.map(([, value]) => value),
    randomUUID(),
  ]);
}

/** 한 통 받는다 — 기본은 DMARC 인증된 From(SES 가 본 From = 헤더 From · pass). */
async function receive(
  f: Fixture,
  scanner: (input: InjectionScanInput) => InjectionScanResult,
  options: { from?: string; dmarc?: 'PASS' | 'FAIL'; recipients?: readonly string[] } = {},
): Promise<string> {
  const from = options.from ?? `sender-${randomUUID().slice(0, 6)}@partner.example`;
  const sesMessageId = newSesMessageId();
  const deps = { ...consumerDeps(testPool(), newObjectStore()), scanner };
  const outcome = await deliver(deps, eml({ from, subject: 'hello', text: 'body text' }), {
    sesMessageId,
    recipients: options.recipients ?? [f.address],
    commonFrom: [from],
    dmarc: options.dmarc ?? 'PASS',
  });
  expect(outcome).toBe('stored');
  return sesMessageId;
}

const RISKY: readonly Family[] = [['narrative', false], ['ai_addressee', false]];
const INJECTION: readonly Family[] = [['override', false], ['exfiltration', false]];

describe.skipIf(!OWNER_AVAILABLE)('받기 등급 — 위험 · 차단 · 보류 · 우회 · 풀기', () => {
  it('① 모든 메일이 스캐너를 지난다 — 메일마다 한 번, 에이전트 둘 · 우회 · 정책 차단이어도 모든 행에 판정 · 적중', async () => {
    const a = await seedFixture(testPool());
    const b = await seedFixture(testPool());
    await trust(a, [['domain', 'partner.example']]);
    await changePolicyOp(provisioningPool(), b.agentId, resolvePolicyChange({ inboundMode: 'none' }), 'test:watch');
    const scanner = fakeScanner('high', INJECTION);
    const ses = await receive(a, scanner.scan, { from: 'ceo@partner.example', recipients: [a.address, b.address] });
    expect(scanner.calls).toHaveLength(1);
    const ra = await rowOf(a, ses);
    const rb = await rowOf(b, ses);
    for (const row of [ra, rb]) {
      expect(row.scanner_version).toBe('test-watch-1');
      expect(row.injection_risk).toBe('high');
      expect(row.findings).toBe(2);
    }
    // a: 우회(조직 목록) — 보인다. b: 정책 차단(수신 꺼짐) — 우회는 다른 조직의 것이라 없다.
    expect(ra).toMatchObject({ quarantined: false, quarantine_reason: null, watch_level: 'none', trusted_bypass: true });
    expect(rb).toMatchObject({ quarantined: true, quarantine_reason: 'policy_blocked', watch_level: 'none', trusted_bypass: false });
  });

  it('② 위험(기본 deliver) — 보이고 · 웹훅 · risk 창(risk_delivered) · 차단 창과 따로', async () => {
    const f = await seedFixture(testPool());
    await withWebhook(f);
    const ses = await receive(f, fakeScanner('low', RISKY).scan);
    const row = await rowOf(f, ses);
    expect(row).toMatchObject({ quarantined: false, quarantine_reason: null, watch_level: 'risk', trusted_bypass: false });
    expect(await createPostgresInboundReadStore(testPool()).findVisible(row.id)).not.toBeNull();
    expect(await webhookCount(row.id)).toBe(1);
    await receive(f, fakeScanner('high', INJECTION).scan);
    expect(await windows(f.agentId)).toEqual([
      { kind: 'block', message_count: 1, reasons: ['injection_risk'] },
      { kind: 'risk', message_count: 1, reasons: ['risk_delivered'] },
    ]);
    // 완화된 적중 · 뉴스레터형 계열만이면 none — 창 없음.
    const g = await seedFixture(testPool());
    const plain = await rowOf(g, await receive(g, fakeScanner('low', [['narrative', true], ['ai_addressee', false]]).scan));
    expect(plain.watch_level).toBe('none');
    expect(await windows(g.agentId)).toEqual([]);
  });

  it('③ 위험 + hold — 격리처럼 숨는다(목록 · 상세 · 웹훅 없음) · 창 항목 risk_hold', async () => {
    const f = await seedFixture(testPool());
    await withWebhook(f);
    await setAgent(f, 'hold', null);
    const row = await rowOf(f, await receive(f, fakeScanner('low', RISKY).scan));
    expect(row).toMatchObject({ quarantined: true, quarantine_reason: 'risk_hold', watch_level: 'risk' });
    const read = createPostgresInboundReadStore(testPool());
    expect(await read.findVisible(row.id)).toBeNull();
    expect((await read.listVisible(f.agentId, { limit: 10, cursor: null })).map((m) => m.id)).not.toContain(row.id);
    expect((await read.quarantineSummary(f.agentId)).count).toBe(1);
    expect(await webhookCount(row.id)).toBe(0);
    expect(await windows(f.agentId)).toEqual([{ kind: 'risk', message_count: 1, reasons: ['risk_hold'] }]);
    // 깨끗한 메일은 hold 설정과 무관하게 보인다(좁히기는 위험 등급에만).
    const clean = await rowOf(f, await receive(f, fakeScanner('none', []).scan));
    expect(clean).toMatchObject({ quarantined: false, watch_level: 'none' });
  });

  it('④ risk_notify=false — 위험 창 없음 · 차단 알림은 항상', async () => {
    const f = await seedFixture(testPool());
    await setAgent(f, null, false);
    await receive(f, fakeScanner('low', RISKY).scan);
    expect(await windows(f.agentId)).toEqual([]);
    await receive(f, fakeScanner('high', INJECTION).scan);
    expect(await windows(f.agentId)).toEqual([{ kind: 'block', message_count: 1, reasons: ['injection_risk'] }]);
  });

  it('⑤ 신뢰 발신자 우회 — DMARC 인증 + 정확한 일치만 · 적중은 남고 · 노출은 T2 가 아니다', async () => {
    const f = await seedFixture(testPool());
    await trust(f, [['domain', 'partner.example'], ['address', 'boss@corp.example']]);
    const exposures = createPostgresExposureRecorder(testPool(), { keyring: TEST_DLP_KEYRING });

    const bypassed = await rowOf(f, await receive(f, fakeScanner('high', INJECTION).scan, { from: 'ceo@partner.example' }));
    expect(bypassed).toMatchObject({ quarantined: false, quarantine_reason: null, watch_level: 'none', trusted_bypass: true, findings: 2 });
    const exposed = await exposures.record({ agentId: f.agentId, surface: 'message_detail', items: [{ inboundMessageId: bypassed.id, part: 'body', field: 'body', content: null }], codes: [] });
    expect(exposed.levels[0]).not.toBe('T2');
    const byAddress = await rowOf(f, await receive(f, fakeScanner('low', RISKY).scan, { from: 'boss@corp.example' }));
    expect(byAddress).toMatchObject({ watch_level: 'none', trusted_bypass: true });
    // 같은 도메인의 다른 주소는 주소 항목과 일치하지 않는다.
    expect(await rowOf(f, await receive(f, fakeScanner('low', RISKY).scan, { from: 'intern@corp.example' }))).toMatchObject({ watch_level: 'risk', trusted_bypass: false });

    // DMARC 실패(위조 From) · 하위 도메인 · 스캐너 오류는 우회하지 않는다.
    expect(await rowOf(f, await receive(f, fakeScanner('high', INJECTION).scan, { from: 'ceo@partner.example', dmarc: 'FAIL' }))).toMatchObject({
      quarantined: true,
      quarantine_reason: 'injection_risk',
      watch_level: 'block',
      trusted_bypass: false,
    });
    expect(await rowOf(f, await receive(f, fakeScanner('high', INJECTION).scan, { from: 'x@mail.partner.example' }))).toMatchObject({
      quarantine_reason: 'injection_risk',
      trusted_bypass: false,
    });
    const broken = (): InjectionScanResult => {
      throw new Error('scanner down');
    };
    expect(await rowOf(f, await receive(f, broken, { from: 'ceo@partner.example' }))).toMatchObject({
      quarantined: true,
      quarantine_reason: 'scanner_error',
      watch_level: 'block',
      trusted_bypass: false,
      injection_risk: null,
    });
    // 정책 차단은 우회가 지우지 못한다.
    await changePolicyOp(provisioningPool(), f.agentId, resolvePolicyChange({ inboundMode: 'blocklist' }), 'test:watch');
    await addRuleOp(provisioningPool(), f.agentId, resolveContactRuleInput({ direction: 'inbound', list: 'block', value: 'partner.example' }), 'test:watch');
    expect(await rowOf(f, await receive(f, fakeScanner('none', []).scan, { from: 'ceo@partner.example' }))).toMatchObject({
      quarantine_reason: 'policy_blocked',
      trusted_bypass: false,
    });
  });

  it('⑥ 풀기 — 보이게 · 웹훅 · 노출 T2 · replayed · 정책 차단 · 판정 없음 · 남의 본문 거부 · 가드', async () => {
    const f = await seedFixture(testPool());
    await withWebhook(f);
    const owner = provisioningPool();
    const read = createPostgresInboundReadStore(testPool());
    const held = await rowOf(f, await receive(f, fakeScanner('high', INJECTION).scan));
    expect(await read.findVisible(held.id)).toBeNull();
    const release = async (id: string, body?: string, eventId: string = randomUUID()) => {
      const target = await owner.query<{ agent_id: string; thread_id: string; received_at: Date }>(
        'SELECT agent_id, thread_id, received_at FROM inbound_messages WHERE id = $1',
        [id],
      );
      const t = target.rows[0];
      if (t === undefined) throw new Error('행이 없다');
      const event = messageReceivedEvent({ agentId: t.agent_id, inboundMessageId: id, threadId: t.thread_id, receivedAt: t.received_at }, eventId);
      const result = await owner.query<{ outcome: string; r_released_from: string | null; r_webhooks: number }>(
        'SELECT outcome, r_released_from, r_webhooks FROM atmark_watch_release_inbound($1, $2, $3, $4, $5)',
        [f.organizationId, id, randomUUID(), eventId, body ?? event.body],
      );
      return result.rows[0];
    };

    // 남의 메일 본문(다른 id)을 실으면 거부 — 아무것도 바뀌지 않는다.
    const other = await rowOf(f, await receive(f, fakeScanner('none', []).scan));
    const foreign = messageReceivedEvent({ agentId: f.agentId, inboundMessageId: other.id, threadId: other.thread_id, receivedAt: new Date('2026-09-23T01:00:01.000Z') });
    await expect(release(held.id, foreign.body, foreign.eventId)).rejects.toThrow(/웹훅 본문이 이 메일의/);
    expect((await rowOf(f, (await owner.query<{ s: string }>('SELECT ses_message_id AS s FROM inbound_messages WHERE id = $1', [held.id])).rows[0]?.s ?? '')).quarantined).toBe(true);

    expect(await release(held.id)).toMatchObject({ outcome: 'released', r_released_from: 'injection_risk', r_webhooks: 1 });
    const visible = await read.findVisible(held.id);
    expect(visible).not.toBeNull();
    expect(await webhookCount(held.id)).toBe(1);
    expect(await release(held.id)).toMatchObject({ outcome: 'replayed' });
    expect(await webhookCount(held.id)).toBe(1);
    // 풀린 메일의 노출은 늘 T2(제목 면도).
    const exposures = createPostgresExposureRecorder(testPool(), { keyring: TEST_DLP_KEYRING });
    const graded = await exposures.record({
      agentId: f.agentId,
      surface: 'message_list',
      items: [{ inboundMessageId: held.id, part: 'subject', field: 'subject', content: null }],
      codes: [],
    });
    expect(graded.levels).toEqual(['T2']);

    // 위험 보류도 풀린다(등급 risk 그대로).
    await setAgent(f, 'hold', null);
    const riskHeld = await rowOf(f, await receive(f, fakeScanner('low', RISKY).scan));
    expect(await release(riskHeld.id)).toMatchObject({ outcome: 'released', r_released_from: 'risk_hold' });
    expect(await rowOf(f, (await owner.query<{ s: string }>('SELECT ses_message_id AS s FROM inbound_messages WHERE id = $1', [riskHeld.id])).rows[0]?.s ?? '')).toMatchObject({
      quarantined: false,
      watch_level: 'risk',
    });

    // 판정 없음 · 숨지 않은 메일 · 다른 조직은 풀지 않는다.
    const broken = (): InjectionScanResult => {
      throw new Error('scanner down');
    };
    const unscanned = await rowOf(f, await receive(f, broken));
    expect(await release(unscanned.id)).toMatchObject({ outcome: 'not_releasable' });
    expect(await release(other.id)).toMatchObject({ outcome: 'not_held' });
    const stranger = await seedFixture(testPool());
    const strangers = await rowOf(stranger, await receive(stranger, fakeScanner('high', INJECTION).scan));
    expect(await release(strangers.id)).toMatchObject({ outcome: 'not_found' });

    // 정책 차단은 풀지 않는다.
    await changePolicyOp(owner, f.agentId, resolvePolicyChange({ inboundMode: 'none' }), 'test:watch');
    const blocked = await rowOf(f, await receive(f, fakeScanner('none', []).scan));
    expect(await release(blocked.id)).toMatchObject({ outcome: 'policy_blocked' });

    // 칸만 바꾸는 UPDATE(소유자 롤) — 가드가 막는다. 앱 롤은 UPDATE 권한부터 없다 · 설정 표 쓰기 0.
    await expect(owner.query(`UPDATE inbound_messages SET quarantined = false, quarantine_reason = NULL WHERE id = $1`, [strangers.id])).rejects.toThrow(/격리 칸은 풀기/);
    await expect(owner.query(`UPDATE inbound_messages SET released_at = NULL, released_by = NULL, released_from = NULL WHERE id = $1`, [held.id])).rejects.toThrow(
      /격리 칸은 풀기/,
    );
    await expect(testPool().query(`INSERT INTO agent_watch_settings (agent_id, risk_handling) VALUES ($1, 'deliver')`, [f.agentId])).rejects.toThrow(/permission denied/);
    await expect(testPool().query(`INSERT INTO org_trusted_senders (organization_id, kind, value) VALUES ($1, 'domain', 'evil.example')`, [f.organizationId])).rejects.toThrow(
      /permission denied/,
    );
    await expect(testPool().query('SELECT * FROM atmark_watch_release_inbound($1, $2, $3, $4, $5)', [f.organizationId, strangers.id, randomUUID(), randomUUID(), '{}'])).rejects.toThrow(
      /permission denied/,
    );
  });

  it('⑦ 신뢰 발신자 표 — 값 모양 · 200 상한 · 지우기는 표시 한 번 · DELETE 금지', async () => {
    const f = await seedFixture(testPool());
    const owner = provisioningPool();
    await expect(trust(f, [['domain', 'Partner.Example']])).rejects.toThrow(/org_trusted_senders_value_kind/);
    await expect(trust(f, [['domain', '*.partner.example']])).rejects.toThrow(/org_trusted_senders_value_kind/);
    await expect(trust(f, [['address', 'partner.example']])).rejects.toThrow(/org_trusted_senders_value_kind/);
    const many = Array.from({ length: 201 }, (_, i) => ['domain', `d${String(i)}.example`] as ['domain', string]);
    const tooMany = await owner.query<{ outcome: string }>('SELECT outcome FROM atmark_watch_set_trusted_senders($1, $2::text[], $3::text[], $4)', [
      f.organizationId,
      many.map(([k]) => k),
      many.map(([, v]) => v),
      randomUUID(),
    ]);
    expect(tooMany.rows[0]?.outcome).toBe('too_many');
    await trust(f, many.slice(0, 200));
    await expect(
      owner.query(`INSERT INTO org_trusted_senders (organization_id, kind, value) VALUES ($1, 'domain', 'extra.example')`, [f.organizationId]),
    ).rejects.toThrow(/200개까지/);
    await trust(f, [['domain', 'd0.example']]);
    const live = await owner.query<{ n: number }>('SELECT count(*)::int AS n FROM org_trusted_senders WHERE organization_id = $1 AND removed_at IS NULL', [f.organizationId]);
    expect(live.rows[0]?.n).toBe(1);
    await expect(owner.query('DELETE FROM org_trusted_senders WHERE organization_id = $1', [f.organizationId])).rejects.toThrow();
    await expect(
      owner.query(`UPDATE org_trusted_senders SET removed_at = NULL WHERE organization_id = $1 AND removed_at IS NOT NULL`, [f.organizationId]),
    ).rejects.toThrow(/지우기 표시는 한 번만/);
  });
});

describe.skipIf(!OWNER_AVAILABLE)('위험 알림 — 같은 기계, 다른 문구', () => {
  it('⑧ 위험 창이 기한이 되면 소유자에게 한 통 — 보류 · 전달 수 · 인증된 도메인만 · 제목 · 본문 · 주소 없음', async () => {
    const { createQuarantineNotifier } = await import('../../../src/notify/quarantine-notifier');
    const { runQuarantineNotifier } = await import('../../../src/workers/quarantine-notifier');
    const { fakeSes, mailText } = await import('../admin/support');
    const f = await seedFixture(testPool());
    const ownerEmail = `wl-owner-${randomUUID().slice(0, 8)}@example.com`;
    await provisioningPool().query('UPDATE organizations SET owner_email = $2 WHERE id = $1', [f.organizationId, ownerEmail]);
    await setAgent(f, 'hold', null);
    await receive(f, fakeScanner('low', RISKY).scan, { from: 'mallory-sentinel@risky.example' });
    await setAgent(f, 'deliver', null);
    await receive(f, fakeScanner('low', RISKY).scan, { from: 'eve@spoofed.example', dmarc: 'FAIL' });
    await provisioningPool().query(`UPDATE quarantine_notices SET next_attempt_at = now() - interval '1 second' WHERE agent_id = $1`, [f.agentId]);
    const ses = fakeSes();
    const now = (): Date => new Date(Date.now() + 2_000);
    const report = await runQuarantineNotifier(
      { db: testPool(), notifier: createQuarantineNotifier({ pool: testPool(), client: ses.client, now }), now },
      { organizationId: f.organizationId },
    );
    expect(report).toMatchObject({ sent: 1 });
    const mail = ses.sent[0];
    expect(mail?.to).toEqual([ownerEmail]);
    const text = mail === undefined ? '' : mailText(mail);
    // 소유자가 메일 언어를 고르지 않았다 — 영어 한 통(2026-10-10).
    // 2026-10-10 개편 — 짧게: 상황 → 수신 로그. 보류/전달 수 · 보낸 곳은 콘솔에.
    expect(text).toContain('2 incoming emails to');
    expect(text).toContain('look suspicious. Review them in the inbound log.');
    expect(text).not.toContain('의심스러운 메일');
    expect(text).not.toContain('risky[.]example');
    expect(text).not.toContain('spoofed');
    expect(text).not.toContain('mallory-sentinel');
    expect(text).not.toContain('body text');
  });
});
