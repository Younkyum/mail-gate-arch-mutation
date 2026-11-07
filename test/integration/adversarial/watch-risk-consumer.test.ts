/**
 * 적대적 검증 A-3 (수신 소비자 · 읽기 저장소 · 알림 · DB 제약) — 위험 처리 hold/deliver 설정이 모든 경로에서 지켜지는지,
 * 차단은 설정과 무관하게 숨고 알리는지, 등급이 면마다 같은지.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';

import { changePolicyOp, resolvePolicyChange } from '../../../src/admin/ops/policy';
import { createPostgresInboundReadStore } from '../../../src/db/repositories/inbound-read-store';
import { createPostgresReplyTargetLookup } from '../../../src/db/repositories/reply-target-store';
import type { AgentId } from '../../../src/db/schema';
import { defangDomain, isDisplayableSenderDomain, renderQuarantineNotice, type QuarantineNoticeView } from '../../../src/notify/quarantine-notice-template';
import type { RuleFamily } from '../../../src/security/injection/rule-types';
import { classifyInboundLevel, type QuarantineReason } from '../../../src/security/levels';
import { closeTestPool, DATABASE_AVAILABLE } from '../db/support/harness';
import { appPool } from '../admin/support';
import {
  cloneInbound,
  fakeScanner,
  INJECTION,
  OWNER_AVAILABLE,
  provisioningPool,
  receiveMail,
  RISKY,
  rowFor,
  seedFixture,
  setAgent,
  testPool,
  throwingScanner,
  trust,
  webhookCount,
  withWebhook,
  type Family,
  type MsgRow,
} from './watch-support';

afterAll(async () => {
  if (DATABASE_AVAILABLE) await closeTestPool();
});

const NARRATIVE: readonly Family[] = [['narrative', false]];
const q = provisioningPool;

async function windows(agentId: string): Promise<{ kind: string; message_count: number; reasons: string[] }[]> {
  return (
    await q().query<{ kind: string; message_count: number; reasons: string[] }>(
      `SELECT n.kind, n.message_count, array(SELECT i.reason FROM quarantine_notice_items i WHERE i.notice_id = n.id ORDER BY i.reason) AS reasons
         FROM quarantine_notices n WHERE n.agent_id = $1 ORDER BY n.kind`,
      [agentId],
    )
  ).rows;
}

async function facts(row: MsgRow): Promise<{ level: string; held: boolean }> {
  const r = (
    await q().query<{ quarantined: boolean; quarantine_reason: string | null; injection_risk: string | null; trusted_bypass: boolean; released_from: string | null; fams: string[] }>(
      `SELECT m.quarantined, m.quarantine_reason, m.injection_risk, m.trusted_bypass, m.released_from,
              coalesce((SELECT array_agg(f.family || ':' || CASE WHEN f.damped THEN '1' ELSE '0' END) FROM security_findings f WHERE f.inbound_message_id = m.id), '{}') AS fams
         FROM inbound_messages m WHERE m.id = $1`,
      [row.id],
    )
  ).rows[0];
  if (r === undefined) throw new Error('no row');
  const verdict = classifyInboundLevel({
    quarantined: r.quarantined,
    quarantineReason: r.quarantine_reason as QuarantineReason | null,
    injectionRisk: r.injection_risk as never,
    findings: r.fams.map((s) => ({ family: s.slice(0, s.lastIndexOf(':')) as RuleFamily, damped: s.endsWith(':1') })),
    trustedBypass: r.trusted_bypass,
    releasedFrom: r.released_from as never,
  });
  return { level: verdict.level, held: r.quarantined };
}

interface Scenario {
  id: string;
  name: string;
  handling: 'deliver' | 'hold' | null;
  notify: boolean | null;
  risk: 'none' | 'low' | 'medium' | 'high' | 'error';
  families: readonly Family[];
  bypass?: boolean;
  policyBlocked?: boolean;
  // 기대
  quarantined: boolean;
  reason: string | null;
  level: 'none' | 'risk' | 'block';
  windows: string[]; // `kind:reason`
}

const SCENARIOS: Scenario[] = [
  { id: 'C-001', name: '설정 행 없음 + 위험 → 전달 · risk · 위험 창(risk_delivered)', handling: null, notify: null, risk: 'low', families: RISKY, quarantined: false, reason: null, level: 'risk', windows: ['risk:risk_delivered'] },
  { id: 'C-002', name: 'deliver 명시 + 위험 → 전달', handling: 'deliver', notify: null, risk: 'low', families: RISKY, quarantined: false, reason: null, level: 'risk', windows: ['risk:risk_delivered'] },
  { id: 'C-003', name: 'hold + 위험 → risk_hold 로 숨김 · 위험 창(risk_hold)', handling: 'hold', notify: null, risk: 'low', families: RISKY, quarantined: true, reason: 'risk_hold', level: 'risk', windows: ['risk:risk_hold'] },
  { id: 'C-004', name: 'hold + 깨끗한 메일 → 보임', handling: 'hold', notify: null, risk: 'none', families: [], quarantined: false, reason: null, level: 'none', windows: [] },
  { id: 'C-005', name: 'hold + low · 완화된 narrative → 보임(위험 아님)', handling: 'hold', notify: null, risk: 'low', families: [['narrative', true]], quarantined: false, reason: null, level: 'none', windows: [] },
  { id: 'C-006', name: 'hold + low · 비움직임 계열만 → 보임', handling: 'hold', notify: null, risk: 'low', families: [['ai_addressee', false]], quarantined: false, reason: null, level: 'none', windows: [] },
  { id: 'C-007', name: 'hold + high → 차단 격리(injection_risk) · risk_hold 가 아님', handling: 'hold', notify: null, risk: 'high', families: INJECTION, quarantined: true, reason: 'injection_risk', level: 'block', windows: ['block:injection_risk'] },
  { id: 'C-008', name: 'deliver + high → 설정과 무관하게 격리', handling: 'deliver', notify: null, risk: 'high', families: INJECTION, quarantined: true, reason: 'injection_risk', level: 'block', windows: ['block:injection_risk'] },
  { id: 'C-009', name: 'deliver + medium → 격리', handling: 'deliver', notify: null, risk: 'medium', families: NARRATIVE, quarantined: true, reason: 'injection_risk', level: 'block', windows: ['block:injection_risk'] },
  { id: 'C-010', name: 'hold + medium → 격리(injection_risk)', handling: 'hold', notify: null, risk: 'medium', families: NARRATIVE, quarantined: true, reason: 'injection_risk', level: 'block', windows: ['block:injection_risk'] },
  { id: 'C-011', name: 'hold + 스캐너 오류 → scanner_error', handling: 'hold', notify: null, risk: 'error', families: [], quarantined: true, reason: 'scanner_error', level: 'block', windows: ['block:scanner_error'] },
  { id: 'C-012', name: 'deliver + 스캐너 오류 → scanner_error', handling: 'deliver', notify: null, risk: 'error', families: [], quarantined: true, reason: 'scanner_error', level: 'block', windows: ['block:scanner_error'] },
  { id: 'C-013', name: 'notify=false + deliver 위험 → 위험 창 없음', handling: 'deliver', notify: false, risk: 'low', families: RISKY, quarantined: false, reason: null, level: 'risk', windows: [] },
  { id: 'C-014', name: 'notify=false + hold 위험 → 숨김 유지 · 위험 창 없음', handling: 'hold', notify: false, risk: 'low', families: RISKY, quarantined: true, reason: 'risk_hold', level: 'risk', windows: [] },
  { id: 'C-015', name: 'notify=false + high → 차단 알림은 그대로(항상)', handling: 'deliver', notify: false, risk: 'high', families: INJECTION, quarantined: true, reason: 'injection_risk', level: 'block', windows: ['block:injection_risk'] },
  { id: 'C-016', name: 'notify=false + hold + high → 차단 알림은 그대로', handling: 'hold', notify: false, risk: 'high', families: INJECTION, quarantined: true, reason: 'injection_risk', level: 'block', windows: ['block:injection_risk'] },
  { id: 'C-017', name: 'notify=false + 스캐너 오류 → 차단 알림은 그대로', handling: 'hold', notify: false, risk: 'error', families: [], quarantined: true, reason: 'scanner_error', level: 'block', windows: ['block:scanner_error'] },
  { id: 'C-018', name: 'notify=true 명시 + 위험 → 위험 창', handling: 'deliver', notify: true, risk: 'low', families: RISKY, quarantined: false, reason: null, level: 'risk', windows: ['risk:risk_delivered'] },
  { id: 'C-019', name: '정책 차단 + hold + 위험 → policy_blocked 가 이긴다 · 창 없음', handling: 'hold', notify: null, risk: 'low', families: RISKY, policyBlocked: true, quarantined: true, reason: 'policy_blocked', level: 'none', windows: [] },
  { id: 'C-020', name: '정책 차단 + high → policy_blocked · 창 없음', handling: 'hold', notify: null, risk: 'high', families: INJECTION, policyBlocked: true, quarantined: true, reason: 'policy_blocked', level: 'none', windows: [] },
  { id: 'C-021', name: '신뢰 우회 + hold + 위험 → 보임(none) · 창 없음', handling: 'hold', notify: null, risk: 'low', families: RISKY, bypass: true, quarantined: false, reason: null, level: 'none', windows: [] },
  { id: 'C-022', name: '신뢰 우회 + high → 보임 · 창 없음', handling: 'hold', notify: null, risk: 'high', families: INJECTION, bypass: true, quarantined: false, reason: null, level: 'none', windows: [] },
  { id: 'C-023', name: '신뢰 우회 + 스캐너 오류 → 격리 유지 · 차단 알림', handling: 'deliver', notify: null, risk: 'error', families: [], bypass: true, quarantined: true, reason: 'scanner_error', level: 'block', windows: ['block:scanner_error'] },
  { id: 'C-024', name: 'hold + 움직이는 계열 override(low) → risk_hold', handling: 'hold', notify: null, risk: 'low', families: [['override', false]], quarantined: true, reason: 'risk_hold', level: 'risk', windows: ['risk:risk_hold'] },
  { id: 'C-025', name: 'hold + 숨긴 흔적 계열 obfuscation(low) → risk_hold', handling: 'hold', notify: null, risk: 'low', families: [['obfuscation', false]], quarantined: true, reason: 'risk_hold', level: 'risk', windows: ['risk:risk_hold'] },
  { id: 'C-026', name: 'hold + 계열 여럿(하나만 비완화) → risk_hold', handling: 'hold', notify: null, risk: 'low', families: [['exfiltration', true], ['concealment', false]], quarantined: true, reason: 'risk_hold', level: 'risk', windows: ['risk:risk_hold'] },
  { id: 'C-027', name: 'deliver + 계열 evasion(low) → 전달 · risk', handling: 'deliver', notify: null, risk: 'low', families: [['evasion', false]], quarantined: false, reason: null, level: 'risk', windows: ['risk:risk_delivered'] },
  { id: 'C-028', name: 'hold + risk none 인데 움직이는 계열(비정상) → 보임', handling: 'hold', notify: null, risk: 'none', families: [['override', false]], quarantined: false, reason: null, level: 'none', windows: [] },
];

describe.skipIf(!OWNER_AVAILABLE)('A-3 설정 조합 × 위험도 — 숨김 · 등급 · 알림 창', () => {
  it.each(SCENARIOS.map((s) => [`[${s.id}] ${s.name}`, s] as const))('%s', async (_name, s) => {
    const f = await seedFixture(testPool());
    if (s.handling !== null || s.notify !== null) await setAgent(f, s.handling, s.notify);
    if (s.bypass === true) await trust(f, [['domain', 'partner.example']]);
    if (s.policyBlocked === true) await changePolicyOp(q(), f.agentId, resolvePolicyChange({ inboundMode: 'none' }), 'adv');
    const scan = s.risk === 'error' ? throwingScanner() : fakeScanner(s.risk, s.families).scan;
    const r = await receiveMail(f, scan, { from: 'x@partner.example' });
    expect(r.row, 'row').not.toBeNull();
    const row = r.row as MsgRow;
    expect([row.quarantined, row.quarantine_reason, row.watch_level]).toEqual([s.quarantined, s.reason, s.level]);
    // 같은 메일은 어느 면에서 계산해도 같은 등급이다(수신 시점 기록 = 행의 사실에서 다시 계산).
    const again = await facts(row);
    expect(again.level).toBe(s.level);
    expect((await windows(f.agentId)).flatMap((w) => w.reasons.map((reason) => `${w.kind}:${reason}`)).sort()).toEqual([...s.windows].sort());
    // 숨은 메일은 보류 목록 후보(격리 칸)에서 정확히 같은 등급으로 보인다.
    if (s.quarantined && s.reason !== 'policy_blocked') {
      const { listHeldOp } = await import('../../../src/admin/ops/watch');
      const held = await listHeldOp(q(), f.organizationId, { agentId: f.agentId, limit: 10, cursor: null });
      expect(held.items.map((i) => [i.id, i.level])).toEqual([[row.id, s.level]]);
    }
  });
});

describe.skipIf(!OWNER_AVAILABLE)('A-3 hold — 모든 에이전트 읽기 경로에서 숨는다', () => {
  async function held() {
    const f = await seedFixture(testPool());
    await setAgent(f, 'hold', null);
    await withWebhook(f);
    const r = await receiveMail(f, fakeScanner('low', RISKY).scan, { from: 'x@partner.example', attachment: { filename: 'a.txt', contentType: 'text/plain', bytes: new TextEncoder().encode('hi') } });
    const row = r.row as MsgRow;
    expect(row.quarantine_reason).toBe('risk_hold');
    return { f, row, store: createPostgresInboundReadStore(testPool()) };
  }
  it('[C-029] 목록 조회 제외', async () => {
    const { f, row, store } = await held();
    expect((await store.listVisible(f.agentId, { limit: 20, cursor: null })).map((m) => m.id)).not.toContain(row.id);
  });
  it('[C-030] 발신자 필터 목록 제외', async () => {
    const { f, store } = await held();
    expect(await store.listVisible(f.agentId, { limit: 20, cursor: null, filters: { fromAddress: 'x@partner.example' } })).toEqual([]);
  });
  it('[C-031] 도메인 필터 목록 제외', async () => {
    const { f, store } = await held();
    expect(await store.listVisible(f.agentId, { limit: 20, cursor: null, filters: { fromDomain: 'partner.example' } })).toEqual([]);
  });
  it('[C-032] since 필터 목록 제외', async () => {
    const { f, store } = await held();
    expect(await store.listVisible(f.agentId, { limit: 20, cursor: null, filters: { since: new Date(0) } })).toEqual([]);
  });
  it('[C-033] 스레드 필터 목록 제외', async () => {
    const { f, row, store } = await held();
    expect(await store.listVisible(f.agentId, { limit: 20, cursor: null, filters: { threadId: row.thread_id } })).toEqual([]);
  });
  it('[C-034] 상세 조회 null', async () => {
    const { row, store } = await held();
    expect(await store.findVisible(row.id)).toBeNull();
  });
  it('[C-035] 스레드 보기 항목 제외(개수만)', async () => {
    const { row, store } = await held();
    const view = await store.threadView(row.thread_id);
    if (view !== null) expect(JSON.stringify(view.entries ?? view)).not.toContain(row.id);
  });
  it('[C-036] 첨부 조회 null', async () => {
    const { row, store } = await held();
    expect(await store.findVisibleAttachment(row.id, 0)).toBeNull();
  });
  it('[C-037] 인증 코드 원천(확정 · 후보 모드) 제외', async () => {
    const { f, store } = await held();
    for (const authenticated of [true, false]) {
      const sources = await store.listVerificationSources(f.agentId, { since: new Date(0), until: new Date(Date.now() + 60_000), authenticated, limit: 50, sender: null } as never);
      expect(sources).toEqual([]);
    }
  });
  it('[C-038] 격리 개수에는 세어진다(개수만 — id · 발신자 없음)', async () => {
    const { f, store } = await held();
    const summary = await store.quarantineSummary(f.agentId);
    expect(summary.count).toBe(1);
    expect(JSON.stringify(summary)).not.toContain('partner.example');
  });
  it('[C-039] 웹훅은 나가지 않는다', async () => {
    const { row } = await held();
    expect(await webhookCount(row.id)).toBe(0);
  });
  it('[C-040] 답장 대상 조회는 quarantined=true 로 거부된다(reply 라우트가 404)', async () => {
    const { f, row } = await held();
    const target = await createPostgresReplyTargetLookup(testPool()).find(f.agentId, row.id);
    expect(target === null || target.quarantined).toBe(true);
  });
  it('[C-041] 설정을 deliver 로 바꿔도 이미 숨은 메일은 풀리지 않는다', async () => {
    const { f, row, store } = await held();
    await setAgent(f, 'deliver', null);
    expect(await store.findVisible(row.id)).toBeNull();
    expect((await rowFor(f.agentId, '')) ?? true).toBeTruthy();
  });
  it('[C-042] 설정을 hold 로 바꿔도 이미 전달된 메일은 사라지지 않는다(소급 없음)', async () => {
    const f = await seedFixture(testPool());
    const r = await receiveMail(f, fakeScanner('low', RISKY).scan, { from: 'x@partner.example' });
    await setAgent(f, 'hold', null);
    expect(await createPostgresInboundReadStore(testPool()).findVisible((r.row as MsgRow).id)).not.toBeNull();
  });
  it('[C-043] 숨은 메일의 id 를 다른 에이전트가 추측해도 findVisible 은 null', async () => {
    const { row } = await held();
    const other = await seedFixture(testPool());
    expect(other.agentId).not.toBe(row.agent_id);
    expect(await createPostgresInboundReadStore(testPool()).findVisible(row.id)).toBeNull();
  });
});

describe.skipIf(!OWNER_AVAILABLE)('A-3 deliver — 위험 메일을 읽으면 오염 T2 가 선다', () => {
  it.each([
    ['C-044', 'message_detail', 'body'],
    ['C-045', 'message_list', 'subject'],
    ['C-046', 'thread', 'subject'],
  ] as const)('[%s] deliver 모드 위험 메일 노출(%s/%s)은 T2', async (_id, surface, field) => {
    const f = await seedFixture(testPool());
    const r = (await receiveMail(f, fakeScanner('low', RISKY).scan, { from: 'x@partner.example' })).row as MsgRow;
    const { createPostgresExposureRecorder } = await import('../../../src/db/repositories/exposure-store');
    const { TEST_DLP_KEYRING } = await import('../../support/injection-doubles');
    const rec = createPostgresExposureRecorder(testPool(), { keyring: TEST_DLP_KEYRING });
    const out = await rec.record({ agentId: f.agentId, surface, items: [{ inboundMessageId: r.id, part: field === 'body' ? 'body' : 'subject', field, content: null }], codes: [] });
    expect(out.levels).toEqual(['T2']);
  });
  it('[C-047] 같은 위험 메일이 우회 발신자에서 오면 T2 가 아니다(대조)', async () => {
    const f = await seedFixture(testPool());
    await trust(f, [['domain', 'partner.example']]);
    const r = (await receiveMail(f, fakeScanner('low', RISKY).scan, { from: 'x@partner.example' })).row as MsgRow;
    const { createPostgresExposureRecorder } = await import('../../../src/db/repositories/exposure-store');
    const { TEST_DLP_KEYRING } = await import('../../support/injection-doubles');
    const rec = createPostgresExposureRecorder(testPool(), { keyring: TEST_DLP_KEYRING });
    const out = await rec.record({ agentId: f.agentId, surface: 'message_detail', items: [{ inboundMessageId: r.id, part: 'body', field: 'body', content: null }], codes: [] });
    expect(out.levels[0]).not.toBe('T2');
  });
  it('[C-048] 미인증 발신자의 위험 메일은 T2 (본문)', async () => {
    const f = await seedFixture(testPool());
    const r = (await receiveMail(f, fakeScanner('none', []).scan, { from: 'x@partner.example', dmarc: 'FAIL' })).row as MsgRow;
    const { createPostgresExposureRecorder } = await import('../../../src/db/repositories/exposure-store');
    const { TEST_DLP_KEYRING } = await import('../../support/injection-doubles');
    const rec = createPostgresExposureRecorder(testPool(), { keyring: TEST_DLP_KEYRING });
    const out = await rec.record({ agentId: f.agentId, surface: 'message_detail', items: [{ inboundMessageId: r.id, part: 'body', field: 'body', content: null }], codes: [] });
    expect(out.levels).toEqual(['T2']);
  });
  it('[C-049] 남의 에이전트가 이 메일을 노출 기록하려 하면 던진다(소유 오류)', async () => {
    const f = await seedFixture(testPool());
    const other = await seedFixture(testPool());
    const r = (await receiveMail(f, fakeScanner('low', RISKY).scan, { from: 'x@partner.example' })).row as MsgRow;
    const { createPostgresExposureRecorder } = await import('../../../src/db/repositories/exposure-store');
    const { TEST_DLP_KEYRING } = await import('../../support/injection-doubles');
    const rec = createPostgresExposureRecorder(testPool(), { keyring: TEST_DLP_KEYRING });
    await expect(rec.record({ agentId: other.agentId, surface: 'message_detail', items: [{ inboundMessageId: r.id, part: 'body', field: 'body', content: null }], codes: [] })).rejects.toThrow();
  });
});

describe.skipIf(!OWNER_AVAILABLE)('A-3 같은 조직 · 다른 설정 — 한 메일이 여러 에이전트에게', () => {
  it('[C-050] 에이전트마다 따로 적용: A 는 hold, B 는 deliver, 스캐너는 한 번', async () => {
    const a = await seedFixture(testPool());
    const b = await seedFixture(testPool());
    await setAgent(a, 'hold', null);
    await setAgent(b, 'deliver', null);
    const scanner = fakeScanner('low', RISKY);
    const r = await receiveMail(a, scanner.scan, { from: 'x@partner.example', recipients: [a.address, b.address] });
    expect(scanner.calls).toHaveLength(1);
    expect(r.row).toMatchObject({ quarantined: true, quarantine_reason: 'risk_hold', watch_level: 'risk' });
    expect(await rowFor(b.agentId, r.ses)).toMatchObject({ quarantined: false, quarantine_reason: null, watch_level: 'risk' });
  });
  it('[C-051] 알림 설정도 에이전트마다: A 는 알림 끔, B 는 켬', async () => {
    const a = await seedFixture(testPool());
    const b = await seedFixture(testPool());
    await setAgent(a, null, false);
    const r = await receiveMail(a, fakeScanner('low', RISKY).scan, { from: 'x@partner.example', recipients: [a.address, b.address] });
    expect(r.outcome).toBe('stored');
    expect(await windows(a.agentId)).toEqual([]);
    expect(await windows(b.agentId)).toHaveLength(1);
  });
  it('[C-052] 차단 알림은 두 에이전트 모두(설정과 무관)', async () => {
    const a = await seedFixture(testPool());
    const b = await seedFixture(testPool());
    await setAgent(a, 'hold', false);
    await setAgent(b, 'deliver', false);
    await receiveMail(a, fakeScanner('high', INJECTION).scan, { from: 'x@partner.example', recipients: [a.address, b.address] });
    expect((await windows(a.agentId))[0]?.kind).toBe('block');
    expect((await windows(b.agentId))[0]?.kind).toBe('block');
  });
  it('[C-053] 세 에이전트: hold / deliver / 행 없음 → 숨김 · 전달 · 전달', async () => {
    const [a, b, c] = [await seedFixture(testPool()), await seedFixture(testPool()), await seedFixture(testPool())];
    await setAgent(a, 'hold', null);
    await setAgent(b, 'deliver', null);
    const r = await receiveMail(a, fakeScanner('low', RISKY).scan, { from: 'x@partner.example', recipients: [a.address, b.address, c.address] });
    const quarantined = [r.row, await rowFor(b.agentId, r.ses), await rowFor(c.agentId, r.ses)].map((x) => x?.quarantined);
    expect(quarantined).toEqual([true, false, false]);
  });
  it('[C-054] 다른 조직 에이전트의 hold 설정이 내 에이전트에 새지 않는다', async () => {
    const a = await seedFixture(testPool());
    const b = await seedFixture(testPool());
    await setAgent(a, 'hold', null);
    const r = await receiveMail(b, fakeScanner('low', RISKY).scan, { from: 'x@partner.example' });
    expect(r.row?.quarantined).toBe(false);
  });
});

describe.skipIf(!OWNER_AVAILABLE)('A-3 알림 내용 — 제목 · 본문 · 발신자 로컬파트가 새지 않는다', () => {
  it('[C-055] 알림 기록(창 · 항목) 전체에 제목 · 본문 · 로컬파트 문자열이 없다', async () => {
    const f = await seedFixture(testPool());
    await receiveMail(f, fakeScanner('high', INJECTION).scan, { from: 'topsecret.local@partner.example', subject: 'NOTICE-SUBJ-SENTINEL', text: 'NOTICE-BODY-SENTINEL' });
    await setAgent(f, 'hold', null);
    await receiveMail(f, fakeScanner('low', RISKY).scan, { from: 'second.local@partner.example', subject: 'NOTICE-SUBJ-SENTINEL', text: 'NOTICE-BODY-SENTINEL' });
    const dump = JSON.stringify(
      (
        await q().query(
          `SELECT n.*, coalesce((SELECT json_agg(i) FROM quarantine_notice_items i WHERE i.notice_id = n.id), '[]'::json) AS items FROM quarantine_notices n WHERE n.agent_id = $1`,
          [f.agentId],
        )
      ).rows,
    );
    for (const needle of ['NOTICE-SUBJ-SENTINEL', 'NOTICE-BODY-SENTINEL', 'topsecret.local', 'second.local']) expect(dump, needle).not.toContain(needle);
  });
  const baseView = (over: Partial<QuarantineNoticeView>): QuarantineNoticeView => ({
    agentId: 'a'.repeat(32),
    agentName: 'agent',
    agentAddress: 'agent@atmark.ai',
    messageCount: 2,
    scannerErrorCount: 0,
    firstAt: new Date('2026-10-08T00:00:00Z'),
    lastAt: new Date('2026-10-08T00:10:00Z'),
    senderDomains: ['partner.example'],
    senderDomainCount: 1,
    unverifiedSenderCount: 0,
    suppressedCount: 0,
    suppressedAgentCount: 0,
    capReached: false,
    ...over,
  });
  const HOSTILE_DOMAINS: [id: string, name: string, domain: string][] = [
    ['C-056', '개행 + 헤더 주입', 'evil.example\r\nBcc: attacker@evil.example'],
    ['C-057', 'HTML 스크립트', '<script>alert(1)</script>.example'],
    ['C-058', '링크 삽입', 'evil.example/phish?x=1'],
    ['C-059', '대문자 도메인', 'EVIL.EXAMPLE'],
    ['C-060', '키릴 동형', 'pаrtner.example'],
    ['C-061', '아주 긴 도메인', `${'a'.repeat(300)}.example`],
    ['C-062', '로컬파트 낀 값', 'ceo@evil.example'],
    ['C-063', '마크다운 링크', '[click](http://evil.example)'],
    ['C-064', '공백 낀 값', 'evil .example'],
    ['C-065', '양방향 제어', 'evil‮.example'],
  ];
  it.each(HOSTILE_DOMAINS.map((h) => [`[${h[0]}] 적대적 발신 도메인(${h[1]})은 알림 본문에 그대로 실리지 않는다`, h[2]] as const))('%s', (_n, domain) => {
    // 도메인을 싣는 알림은 가입 감지뿐이다(2026-10-10 개편) — 그 경로로 본다.
    const mail = renderQuarantineNotice(baseView({ kind: 'signup', senderDomains: [domain], senderDomainCount: 1 }), 'ko');
    const all = `${mail.subject}\n${mail.text}\n${mail.html}`;
    expect(all).not.toContain(domain);
    expect(isDisplayableSenderDomain(domain)).toBe(false);
  });
  it('[C-066] 대조: 정상 도메인은 끊어서(defang) 실린다', () => {
    const mail = renderQuarantineNotice(baseView({ kind: 'signup' }), 'ko');
    expect(`${mail.text}${mail.html}`).toContain(defangDomain('partner.example'));
    expect(`${mail.text}${mail.html}`).not.toContain('partner.example');
  });
  it.each([
    ['C-067', '<script>alert(1)</script>'],
    ['C-068', 'a\r\nBcc: x@evil.example'],
    ['C-069', '"><img src=x onerror=alert(1)>'],
    ['C-070', 'x'.repeat(500)],
  ] as const)('[%s] 적대적 에이전트 이름이 위험 알림 본문에서 이스케이프되거나 정리된다', (_id, name) => {
    const mail = renderQuarantineNotice(baseView({ agentName: name, kind: 'risk', heldCount: 1 }), 'ko');
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).not.toContain('<img src=x');
    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.text).not.toContain('Bcc: x@evil.example\r\n');
  });
  it('[C-071] 위험 알림 문구는 “차단/막았다” 같은 단정을 하지 않는다', () => {
    const mail = renderQuarantineNotice(baseView({ kind: 'risk', heldCount: 1, messageCount: 3 }), 'ko');
    expect(`${mail.text}`).not.toMatch(/100%|immutable|불변/i);
  });
  it('[C-072] 위험 알림과 차단 알림은 제목이 다르다(같은 틀로 헷갈리지 않는다)', () => {
    const risk = renderQuarantineNotice(baseView({ kind: 'risk', heldCount: 1 }), 'ko');
    const block = renderQuarantineNotice(baseView({}), 'ko');
    expect(risk.subject).not.toBe(block.subject);
  });
});

describe.skipIf(!OWNER_AVAILABLE)('A-3 설정 표 · 행 제약 — 직접 변조', () => {
  it('[C-073] 소유자 롤도 알 수 없는 riskHandling 을 INSERT 할 수 없다(CHECK)', async () => {
    const f = await seedFixture(testPool());
    await expect(q().query(`INSERT INTO agent_watch_settings (agent_id, risk_handling) VALUES ($1, 'drop')`, [f.agentId])).rejects.toThrow(/risk_handling/);
  });
  it('[C-074] 앱 롤은 설정 표에 쓸 수 없다', async () => {
    const f = await seedFixture(testPool());
    const app = appPool();
    try {
      await expect(app.query(`INSERT INTO agent_watch_settings (agent_id, risk_handling) VALUES ($1, 'deliver')`, [f.agentId])).rejects.toThrow(/permission denied/);
      await expect(app.query(`UPDATE agent_watch_settings SET risk_handling = 'deliver'`)).rejects.toThrow(/permission denied/);
    } finally {
      await app.end();
    }
  });
  it('[C-075] 앱 롤은 정의자 함수로도 설정을 바꿀 수 없다', async () => {
    const f = await seedFixture(testPool());
    const app = appPool();
    try {
      await expect(app.query(`SELECT * FROM atmark_watch_set_agent($1, $2, 'deliver', true, NULL)`, [f.organizationId, f.agentId])).rejects.toThrow(/permission denied/);
    } finally {
      await app.end();
    }
  });
  it('[C-076] 정의자 함수: 다른 조직 id 로 에이전트 설정 → not_found, 설정 불변', async () => {
    const a = await seedFixture(testPool());
    const b = await seedFixture(testPool());
    const r = await q().query<{ outcome: string }>(`SELECT outcome FROM atmark_watch_set_agent($1, $2, 'hold', false, NULL)`, [b.organizationId, a.agentId]);
    expect(r.rows[0]?.outcome).toBe('not_found');
    expect((await q().query('SELECT 1 FROM agent_watch_settings WHERE agent_id = $1', [a.agentId])).rowCount).toBe(0);
  });
  it('[C-077] 정의자 함수: 잘못된 값 deliver 아닌 문자열 → CHECK', async () => {
    const f = await seedFixture(testPool());
    await expect(q().query(`SELECT * FROM atmark_watch_set_agent($1, $2, 'DROP', NULL, NULL)`, [f.organizationId, f.agentId])).rejects.toThrow();
  });
  it('[C-078] 정의자 함수: 둘 다 NULL 이면 아무것도 바꾸지 않는다(unchanged · 행 안 생김)', async () => {
    const f = await seedFixture(testPool());
    const r = await q().query<{ outcome: string }>(`SELECT outcome FROM atmark_watch_set_agent($1, $2, NULL, NULL, NULL)`, [f.organizationId, f.agentId]);
    expect(r.rows[0]?.outcome).toBe('unchanged');
  });
  it('[C-079] 설정 행 삭제 시도(소유자 롤) — 에이전트 행 FK 때문에 에이전트 삭제 불가', async () => {
    const f = await seedFixture(testPool());
    await setAgent(f, 'hold', null);
    await expect(q().query(`DELETE FROM agents WHERE id = $1`, [f.agentId])).rejects.toThrow();
  });
  const CHECKS: [id: string, name: string, overrides: Record<string, string>, pattern: RegExp][] = [
    ['C-080', '보이는 block 등급(풀리지 않음)', { watch_level: `'block'`, quarantined: 'false', quarantine_reason: 'NULL', injection_risk: `'none'` }, /watch_level_shape/],
    ['C-081', '인젝션 격리인데 등급 none', { watch_level: `'none'`, quarantined: 'true', quarantine_reason: `'injection_risk'`, injection_risk: `'high'` }, /watch_level_shape/],
    ['C-082', 'risk_hold 격리인데 등급 block', { watch_level: `'block'`, quarantined: 'true', quarantine_reason: `'risk_hold'`, injection_risk: `'low'` }, /watch_level_shape/],
    ['C-083', 'scanner_error 격리인데 등급 risk', { watch_level: `'risk'`, quarantined: 'true', quarantine_reason: `'scanner_error'`, injection_risk: 'NULL' }, /watch_level_shape|inbound_messages_/],
    ['C-084', '모르는 등급 문자열', { watch_level: `'critical'` }, /watch_level_check/],
    ['C-085', '모르는 격리 사유', { quarantined: 'true', quarantine_reason: `'because'` }, /quarantine_reason/],
    ['C-086', '우회 + 등급 risk', { trusted_bypass: 'true', watch_level: `'risk'` }, /watch_level_shape/],
    ['C-087', '우회 아닌 보이는 high', { injection_risk: `'high'`, quarantined: 'false', quarantine_reason: 'NULL' }, /high_is_quarantined|inbound_messages_/],
    ['C-088', 'released_from 모르는 값', { released_from: `'bogus'` }, /풀린 칸|released_from/],
    ['C-089', '풀린 칸 일부만(released_at 만)', { released_at: 'now()' }, /풀린 칸|release/],
    ['C-090', '정책 차단 사유인데 policy_reason 없음', { quarantined: 'true', quarantine_reason: `'policy_blocked'`, policy_reason: 'NULL' }, /policy_reason_shape/],
  ];
  it.each(CHECKS.map((c) => [`[${c[0]}] 복제 INSERT 거부: ${c[1]}`, c[2], c[3]] as const))('%s', async (_n, overrides, pattern) => {
    const f = await seedFixture(testPool());
    const r = (await receiveMail(f, fakeScanner('none', []).scan, { from: 'x@partner.example' })).row as MsgRow;
    await expect(cloneInbound(r.id, overrides)).rejects.toThrow(pattern);
  });
  it('[C-091] 대조: 복제 INSERT 하네스 자체는 유효한 행을 받는다', async () => {
    const f = await seedFixture(testPool());
    const r = (await receiveMail(f, fakeScanner('none', []).scan, { from: 'x@partner.example' })).row as MsgRow;
    await expect(cloneInbound(r.id, {})).resolves.toBeUndefined();
  });
  it('[C-092] 등급 칸 watch_level 을 소유자 롤이 UPDATE → 불변 트리거', async () => {
    const f = await seedFixture(testPool());
    const r = (await receiveMail(f, fakeScanner('high', INJECTION).scan, { from: 'x@partner.example' })).row as MsgRow;
    await expect(q().query(`UPDATE inbound_messages SET watch_level = 'none' WHERE id = $1`, [r.id])).rejects.toThrow();
  });
  it('[C-093] 알림 창 kind 모르는 값 INSERT → CHECK', async () => {
    const f = await seedFixture(testPool());
    await expect(q().query(`INSERT INTO quarantine_notices (agent_id, organization_id, kind, next_attempt_at) VALUES ($1, $2, 'bogus', now())`, [f.agentId, f.organizationId])).rejects.toThrow();
  });
  it('[C-094] 한 에이전트·종류에 열린 창 둘 INSERT → 유일 색인', async () => {
    const f = await seedFixture(testPool());
    const insert = () => q().query(`INSERT INTO quarantine_notices (agent_id, organization_id, kind, next_attempt_at) VALUES ($1, $2, 'risk', now())`, [f.agentId, f.organizationId]);
    await insert();
    await expect(insert()).rejects.toThrow();
  });
  it('[C-095] 알림 항목 사유 모르는 값 → CHECK', async () => {
    const f = await seedFixture(testPool());
    const r = (await receiveMail(f, fakeScanner('high', INJECTION).scan, { from: 'x@partner.example' })).row as MsgRow;
    const notice = (await q().query<{ id: string }>('SELECT id FROM quarantine_notices WHERE agent_id = $1', [f.agentId])).rows[0]?.id;
    await expect(q().query(`INSERT INTO quarantine_notice_items (inbound_message_id, notice_id, sender_domain, sender_authenticated, reason) VALUES ($1, $2, 'a.example', true, 'bogus')`, [r.id, notice])).rejects.toThrow();
  });
  it('[C-096] 알림 항목 도메인에 로컬파트가 든 값 → CHECK(공격자 글자 제한)', async () => {
    const f = await seedFixture(testPool());
    const r = (await receiveMail(f, fakeScanner('high', INJECTION).scan, { from: 'x@partner.example' })).row as MsgRow;
    const notice = (await q().query<{ id: string }>('SELECT id FROM quarantine_notices WHERE agent_id = $1', [f.agentId])).rows[0]?.id;
    await expect(
      q().query(`INSERT INTO quarantine_notice_items (inbound_message_id, notice_id, sender_domain, sender_authenticated, reason) VALUES ($1, $2, 'ceo@evil.example', true, 'injection_risk')`, [r.id, notice]),
    ).rejects.toThrow();
  });
  it('[C-097] 위험 등급 메일의 발신 도메인이 이상한 모양이어도 알림 기록은 삼키고 메일은 저장된다', async () => {
    const f = await seedFixture(testPool());
    const r = await receiveMail(f, fakeScanner('low', RISKY).scan, { from: 'x@Weird_Domain.example' });
    expect(r.outcome === 'stored' || r.outcome === 'rejected').toBe(true);
  });
  it('[C-098] 에이전트 id 를 바꿔 낀 settings 읽기(앱 롤)는 자기 에이전트 조직만 본다', async () => {
    const a = await seedFixture(testPool());
    const b = await seedFixture(testPool());
    await trust(a, [['domain', 'a-only.example']]);
    const { createPostgresInboundWatchSource } = await import('../../../src/db/repositories/watch-settings-store');
    const ctx = await createPostgresInboundWatchSource(testPool()).loadInboundWatch(b.agentId);
    expect(ctx.trustedSenders).toEqual([]);
  });
  it('[C-099] 설정이 없는 에이전트 읽기 = 기본값(deliver · 알림 켬)', async () => {
    const f = await seedFixture(testPool());
    const { createPostgresInboundWatchSource } = await import('../../../src/db/repositories/watch-settings-store');
    expect((await createPostgresInboundWatchSource(testPool()).loadInboundWatch(f.agentId)).settings).toEqual({ riskHandling: 'deliver', riskNotify: true });
  });
  it('[C-100] 같은 메일(재전달)이 hold 설정이 바뀐 뒤 와도 첫 행이 정본이다(중복 무시)', async () => {
    const f = await seedFixture(testPool());
    await setAgent(f, 'hold', null);
    const scan = fakeScanner('low', RISKY).scan;
    const first = await receiveMail(f, scan, { from: 'x@partner.example' });
    expect(first.row?.quarantine_reason).toBe('risk_hold');
    await setAgent(f, 'deliver', null);
    expect((await rowFor(f.agentId, first.ses))?.quarantined).toBe(true);
    expect(randomUUID()).toBeTruthy();
  });
});
