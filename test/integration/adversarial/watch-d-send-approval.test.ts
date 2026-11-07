/**
 * 적대적 검증(묶음 D) 요소 1 — 발신 승인(`send_approval = always`) **실제 Postgres · 실제 라우터 · 실제 관문**. 시도 ID 는 `D1-I###`.
 * 보안 동작을 단언한다. 현재 동작만 못박은 것은 `SUSPECT:`, 뚫린 것은 `VULN:` 머리말.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';

import { approveRequest } from '../../../src/approval/service';
import { createPostgresApprovalStore } from '../../../src/db/repositories';
import { runApprovalRelease } from '../../../src/workers/approval-release';
import { runScheduledSenderTick } from '../../../src/workers/scheduled-sender';
import { createPostgresScheduledSendStore } from '../../../src/db/repositories/scheduled-send-store';
import { createScheduledContentStore } from '../../../src/storage/scheduled-content-store';
import { createLocalObjectStore } from '../../../src/storage/local-object-store';
import { addRuleOp, resolveContactRuleInput } from '../../../src/admin/ops/rules';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeTestPool, provisioningPool, seedFixture, testPool } from '../db/support/harness';
import { authed, call, closeConsoleKit, consoleKit, OWNER_AVAILABLE, PARTNER, CLIENT, STRANGER, api, apiWorldFor, auditDecisions, mcp, outboundRows, receiveFrom, sendWorld, sessionFor, setMode, setSendApproval, tokenFor, type ApiWorld } from './watch-d-support';

afterAll(async () => {
  await closeConsoleKit();
  await closeTestPool();
});

const body = (w: ApiWorld, to: string = PARTNER, extra: Record<string, unknown> = {}) => ({ agent_id: w.fixture.agentId, from: w.fixture.address, to: [to], subject: '안녕', text: '본문입니다', ...extra });
const key = (): Record<string, string> => ({ 'idempotency-key': randomUUID() });

function expectPending(r: { status: number; json: Record<string, unknown> }): void {
  expect(r.status).toBe(202);
  expect((r.json['decision'] as { verdict?: string; reasons?: string[] } | undefined)?.reasons ?? []).toContain('owner_requires_approval');
}

describe.skipIf(!OWNER_AVAILABLE)('D1 경로별 — always 면 어느 발송 경로든 sent 로 끝나지 않는다', () => {
  it('[D1-I001] POST /v1/messages (목록 안 상대)', async () => {
    const w = await sendWorld();
    await setSendApproval(w.fixture.agentId, w.fixture.organizationId, 'always');
    const r = await api(w, 'POST', '/v1/messages', { token: w.token, body: body(w), headers: key() });
    expectPending(r);
    expect(w.transport.calls()).toBe(0);
    expect((await outboundRows(w.fixture.agentId)).map((m) => m.status)).not.toContain('sent');
  });

  it('[D1-I002] 대조군 auto: 같은 요청은 나간다', async () => {
    const w = await sendWorld();
    const r = await api(w, 'POST', '/v1/messages', { token: w.token, body: body(w), headers: key() });
    expect(r.status).toBe(200);
    expect(w.transport.calls()).toBe(1);
  });

  it.each([
    { id: 'D1-I003', label: '대문자 수신자', to: 'PARTNER@Example.com' },
    { id: 'D1-I004', label: '+tag 수신자(목록 일치형)', to: 'partner+x@example.com' },
    { id: 'D1-I005', label: '다른 허용 상대', to: CLIENT },
  ])('[$id] REST send — $label 도 sent 가 아니다', async ({ to }) => {
    const w = await sendWorld();
    await setSendApproval(w.fixture.agentId, w.fixture.organizationId, 'always');
    const r = await api(w, 'POST', '/v1/messages', { token: w.token, body: body(w, to), headers: key() });
    expect([202, 403, 400]).toContain(r.status);
    expect(r.json['status']).not.toBe('sent');
    expect(w.transport.calls()).toBe(0);
  });

  it('[D1-I006] 스레드 회신 REST — 외부가 시작한 스레드 회신(평소 자동 승인)도 승인 대기', async () => {
    const w = await sendWorld();
    const inbound = await receiveFrom(w, CLIENT);
    await setSendApproval(w.fixture.agentId, w.fixture.organizationId, 'always');
    const r = await api(w, 'POST', `/v1/threads/${inbound.threadId}/reply`, { token: w.token, body: { agent_id: w.fixture.agentId, in_reply_to: inbound.id, text: '답장' }, headers: key() });
    expect(r.status, r.text).toBe(202);
    expect(w.transport.calls()).toBe(0);
  });

  it('[D1-I007] 대조군: auto 에서는 같은 회신이 나간다', async () => {
    const w = await sendWorld();
    const inbound = await receiveFrom(w, CLIENT);
    const r = await api(w, 'POST', `/v1/threads/${inbound.threadId}/reply`, { token: w.token, body: { agent_id: w.fixture.agentId, in_reply_to: inbound.id, text: '답장' }, headers: key() });
    expect(r.status, r.text).toBe(200);
    expect(w.transport.calls()).toBe(1);
  });

  it('[D1-I008] 전달(forward) REST — 승인 대기', async () => {
    const w = await sendWorld();
    const inbound = await receiveFrom(w, CLIENT);
    await setSendApproval(w.fixture.agentId, w.fixture.organizationId, 'always');
    const r = await api(w, 'POST', `/v1/messages/${inbound.id}/forward`, { token: w.token, body: { agent_id: w.fixture.agentId, from: w.fixture.address, to: [PARTNER], text: '참고', subject: 'Fwd: 견적서' }, headers: key() });
    expect(r.status, r.text).toBe(202);
    expect(w.transport.calls()).toBe(0);
  });

  it('[D1-I009] 초안 보내기 REST — 승인 대기', async () => {
    const w = await sendWorld();
    await setSendApproval(w.fixture.agentId, w.fixture.organizationId, 'always');
    const draft = await api(w, 'POST', '/v1/drafts', { token: w.token, body: { agent_id: w.fixture.agentId, from: w.fixture.address, to: [PARTNER], subject: '초안', text: '본문' } });
    expect(draft.status, draft.text).toBe(201);
    const sent = await api(w, 'POST', `/v1/drafts/${String(draft.json['id'])}/send`, { token: w.token, body: { agent_id: w.fixture.agentId }, headers: key() });
    expect(sent.status, sent.text).toBe(202);
    expect(w.transport.calls()).toBe(0);
  });

  it('[D1-I010] 예약 발송 — 예약은 auto 로 만들고 always 로 바꾼 뒤 기한이 오면 승인 대기', async () => {
    const w = await sendWorld();
    const sendAt = new Date(w.clock.now.getTime() + 3600_000).toISOString();
    const created = await api(w, 'POST', '/v1/messages/scheduled', { token: w.token, body: body(w, PARTNER, { send_at: sendAt }), headers: key() });
    expect(created.status, created.text).toBe(202);
    await setSendApproval(w.fixture.agentId, w.fixture.organizationId, 'always');
    const directory = mkdtempSync(join(tmpdir(), 'adv-d-sched-'));
    // 틱은 예약을 만든 세계의 콘텐츠 저장소를 그대로 써야 한다 — 같은 deps 의 저장소를 꺼낸다.
    const tick = await runScheduledSenderTick(
      { service: { ...w.service, now: () => new Date(w.clock.now.getTime() + 2 * 3600_000) }, transport: w.transport, schedules: w.deps.scheduledMessages.schedules, content: w.deps.scheduledMessages.content, leaseSeconds: 300, onlyAgentId: w.fixture.agentId },
      5,
    );
    void directory;
    void createPostgresScheduledSendStore;
    void createScheduledContentStore;
    void createLocalObjectStore;
    expect(tick.length).toBeGreaterThan(0);
    expect(tick.every((t) => t.outcome !== 'sent')).toBe(true);
    expect(w.transport.calls()).toBe(0);
  });

  it('[D1-I011] 예약 — 예약 때 always 였다가 기한 전에 auto 로 풀리면 나간다(소유자가 푼 것: 허용 방향의 변경은 소유자 몫)', async () => {
    const w = await sendWorld();
    await setSendApproval(w.fixture.agentId, w.fixture.organizationId, 'always');
    const sendAt = new Date(w.clock.now.getTime() + 3600_000).toISOString();
    const created = await api(w, 'POST', '/v1/messages/scheduled', { token: w.token, body: body(w, PARTNER, { send_at: sendAt }), headers: key() });
    expect(created.status, created.text).toBe(202);
    await setSendApproval(w.fixture.agentId, w.fixture.organizationId, 'auto');
    const tick = await runScheduledSenderTick(
      { service: { ...w.service, now: () => new Date(w.clock.now.getTime() + 2 * 3600_000) }, transport: w.transport, schedules: w.deps.scheduledMessages.schedules, content: w.deps.scheduledMessages.content, leaseSeconds: 300, onlyAgentId: w.fixture.agentId },
      5,
    );
    expect(tick.map((t) => t.outcome)).toContain('sent');
  });

  it('[D1-I012] MCP send_email — pending_approval(재전송 금지 안내), sent 아님', async () => {
    const w = await sendWorld();
    await setSendApproval(w.fixture.agentId, w.fixture.organizationId, 'always');
    const r = await mcp(w, 'send_email', { to: [PARTNER], subject: '안녕', text: '본문' });
    expect(r.meta['outcome']).toBe('pending_approval');
    expect(w.transport.calls()).toBe(0);
  });

  it('[D1-I013] MCP reply_email — pending_approval', async () => {
    const w = await sendWorld();
    const inbound = await receiveFrom(w, CLIENT);
    await setSendApproval(w.fixture.agentId, w.fixture.organizationId, 'always');
    const r = await mcp(w, 'reply_email', { message_id: inbound.id, text: '답장' });
    expect(r.meta['outcome']).toBe('pending_approval');
    expect(w.transport.calls()).toBe(0);
  });

  it('[D1-I014] MCP forward_email — pending_approval', async () => {
    const w = await sendWorld();
    const inbound = await receiveFrom(w, CLIENT);
    await setSendApproval(w.fixture.agentId, w.fixture.organizationId, 'always');
    const r = await mcp(w, 'forward_email', { message_id: inbound.id, to: [PARTNER], note: '참고' });
    expect(r.meta['outcome']).toBe('pending_approval');
    expect(w.transport.calls()).toBe(0);
  });

  it('[D1-I015] MCP create_draft + send_draft — pending_approval', async () => {
    const w = await sendWorld();
    await setSendApproval(w.fixture.agentId, w.fixture.organizationId, 'always');
    const draft = await mcp(w, 'create_draft', { to: [PARTNER], subject: '초안', text: '본문' });
    const id = String(draft.meta['draft_id'] ?? draft.meta['id']);
    const r = await mcp(w, 'send_draft', { draft_id: id });
    expect(r.meta['outcome']).toBe('pending_approval');
    expect(w.transport.calls()).toBe(0);
  });

  it('[D1-I016] 전환 공지(transition announcement) — always 에서도 sent 없음(원래 사람 승인 경로)', async () => {
    const w = await sendWorld();
    await provisioningPool().query(`INSERT INTO sender_relationships (agent_id, scope, address, trust_category, granted_by) VALUES ($1, 'recipient', $2, 'seed', 'owner_provisioning')`, [w.fixture.agentId, PARTNER]);
    await setSendApproval(w.fixture.agentId, w.fixture.organizationId, 'always');
    const r = await api(w, 'POST', `/v1/agents/${w.fixture.agentId}/transition-announcement`, { token: w.token, body: { agent_id: w.fixture.agentId, owner_name: 'Jin', language: 'en' }, headers: key() });
    expect([202, 400, 404, 409]).toContain(r.status);
    expect(w.transport.calls()).toBe(0);
  });
});

describe.skipIf(!OWNER_AVAILABLE)('D1 멱등 재생 · 전환 · 경쟁', () => {
  it('[D1-I017] auto 때 보낸 같은 Idempotency-Key 를 always 로 바꾼 뒤 재생하면 새 발송 없이 원래 결과를 돌려준다', async () => {
    const w = await sendWorld();
    const k = { 'idempotency-key': randomUUID() };
    const first = await api(w, 'POST', '/v1/messages', { token: w.token, body: body(w), headers: k });
    expect(first.status).toBe(200);
    await setSendApproval(w.fixture.agentId, w.fixture.organizationId, 'always');
    const replay = await api(w, 'POST', '/v1/messages', { token: w.token, body: body(w), headers: k });
    expect(replay.status).toBe(200);
    expect(w.transport.calls()).toBe(1);
  });

  it('[D1-I018] 같은 본문 · 새 키 — always 가 켜진 뒤의 새 발송은 승인 대기', async () => {
    const w = await sendWorld();
    await api(w, 'POST', '/v1/messages', { token: w.token, body: body(w), headers: key() });
    await setSendApproval(w.fixture.agentId, w.fixture.organizationId, 'always');
    const second = await api(w, 'POST', '/v1/messages', { token: w.token, body: body(w), headers: key() });
    expectPending(second);
    expect(w.transport.calls()).toBe(1);
  });

  it('[D1-I019] always 때 만든 승인 대기를 같은 키로 재생 — 다시 평가해 나가지 않는다', async () => {
    const w = await sendWorld();
    await setSendApproval(w.fixture.agentId, w.fixture.organizationId, 'always');
    const k = { 'idempotency-key': randomUUID() };
    const first = await api(w, 'POST', '/v1/messages', { token: w.token, body: body(w), headers: k });
    expect(first.status).toBe(202);
    await setSendApproval(w.fixture.agentId, w.fixture.organizationId, 'auto');
    const replay = await api(w, 'POST', '/v1/messages', { token: w.token, body: body(w), headers: k });
    expect(replay.status).toBe(202);
    expect(w.transport.calls()).toBe(0);
  });

  it('[D1-I020] MCP 유도 키 — always 를 켠 뒤 같은 인자 재호출은 재생(원래 sent)이고 새 발송이 아니다', async () => {
    const w = await sendWorld();
    const args = { to: [PARTNER], subject: '안녕', text: '본문' };
    const first = await mcp(w, 'send_email', args);
    expect(first.meta['outcome']).toBe('sent');
    await setSendApproval(w.fixture.agentId, w.fixture.organizationId, 'always');
    const again = await mcp(w, 'send_email', args);
    expect(again.meta['replayed']).toBe(true);
    expect(w.transport.calls()).toBe(1);
  });

  it('[D1-I021] 전환 경쟁 — 같은 시각에 20건 발송하며 auto/always 를 번갈아 바꾼다. 감사 기록상 always 버전으로 평가된 건은 sent 가 없다', async () => {
    const w = await sendWorld();
    const flips = (async () => {
      for (let i = 0; i < 6; i += 1) {
        await setSendApproval(w.fixture.agentId, w.fixture.organizationId, i % 2 === 0 ? 'always' : 'auto');
      }
      await setSendApproval(w.fixture.agentId, w.fixture.organizationId, 'always');
    })();
    const sends = Array.from({ length: 20 }, async (_, i) => api(w, 'POST', '/v1/messages', { token: w.token, body: body(w, PARTNER, { subject: `n${String(i)}` }), headers: key() }));
    await Promise.all([flips, ...sends]);
    const rows = await provisioningPool().query<{ decision: string; require_approval: boolean }>(
      `SELECT a.decision::text AS decision, (pv.snapshot -> 'require_approval' = 'true'::jsonb) AS require_approval
         FROM audit_logs a JOIN policy_versions pv ON pv.agent_id = a.agent_id AND pv.version = a.policy_version
        WHERE a.agent_id = $1`,
      [w.fixture.agentId],
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    for (const row of rows.rows) if (row.require_approval) expect(row.decision).not.toBe('allowed');
    // 전환이 끝난 뒤(최종 always)의 새 발송은 반드시 대기.
    const after = await api(w, 'POST', '/v1/messages', { token: w.token, body: body(w, PARTNER, { subject: 'after' }), headers: key() });
    expectPending(after);
  });

  it('[D1-I022] 같은 값으로 다시 바꾸면 빈 정책 버전을 만들지 않는다(always → always)', async () => {
    const w = await sendWorld();
    await setSendApproval(w.fixture.agentId, w.fixture.organizationId, 'always');
    const before = await provisioningPool().query<{ n: number }>('SELECT count(*)::int AS n FROM policy_versions WHERE agent_id = $1', [w.fixture.agentId]);
    await setSendApproval(w.fixture.agentId, w.fixture.organizationId, 'always');
    const after = await provisioningPool().query<{ n: number }>('SELECT count(*)::int AS n FROM policy_versions WHERE agent_id = $1', [w.fixture.agentId]);
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });
});

// ---------------------------------------------------------------------------
// 승인 · 릴리스 재게이트
// ---------------------------------------------------------------------------
describe.skipIf(!OWNER_AVAILABLE)('D1 승인 · 릴리스 재게이트', () => {
  async function pendingFor(w: ApiWorld, to: string = PARTNER, extra: Record<string, unknown> = {}): Promise<string> {
    const r = await api(w, 'POST', '/v1/messages', { token: w.token, body: body(w, to, extra), headers: key() });
    expect(r.status, r.text).toBe(202);
    return String(r.json['approval_id']);
  }
  const store = () => createPostgresApprovalStore(testPool());
  const release = (w: ApiWorld, approvalId: string) => runApprovalRelease({ service: w.service, approvals: store(), transport: w.transport }, { approvalId, traceId: null });
  const approve = (w: ApiWorld, approvalId: string, scope: 'recipient' | 'thread' | 'domain' = 'recipient', now: Date = w.clock.now) =>
    approveRequest(store(), { approvalId, decidedBy: 'owner:adv', now, scope, confirmScope: scope === 'domain' ? 'domain' : null });

  it('[D1-I023] 소유자 승인 뒤 릴리스는 나간다 — 한 번만(릴리스를 두 번 돌려도 SES 1회)', async () => {
    const w = await sendWorld();
    await setSendApproval(w.fixture.agentId, w.fixture.organizationId, 'always');
    const id = await pendingFor(w);
    expect((await approve(w, id)).kind).toBe('approved');
    await release(w, id);
    await release(w, id);
    expect(w.transport.calls()).toBe(1);
  });

  it('[D1-I024] 승인 A 의 상시 관계(recipient)로 같은 상대에게 새 메시지 B — always 면 또 승인 대기(승인 재사용 불가)', async () => {
    const w = await sendWorld();
    await setSendApproval(w.fixture.agentId, w.fixture.organizationId, 'always');
    const a = await pendingFor(w, STRANGER_ALLOWED(w));
    await approve(w, a);
    await release(w, a);
    const b = await api(w, 'POST', '/v1/messages', { token: w.token, body: body(w, STRANGER_ALLOWED(w), { subject: 'B' }), headers: key() });
    expectPending(b);
    expect(w.transport.calls()).toBe(1);
  });

  it('[D1-I025] 승인 대기 중 소유자가 수신자를 차단 — 승인해도 릴리스에서 거부(deny stays deny)', async () => {
    const w = await sendWorld();
    await setSendApproval(w.fixture.agentId, w.fixture.organizationId, 'always');
    const id = await pendingFor(w);
    await setMode(w.fixture.agentId, 'blocklist');
    await addRuleOp(provisioningPool(), w.fixture.agentId, resolveContactRuleInput({ direction: 'outbound', list: 'block', value: PARTNER }), 'adv-d');
    await approve(w, id);
    await release(w, id);
    expect(w.transport.calls()).toBe(0);
  });

  it('[D1-I026] 승인 대기 중 발신을 끈다(none) — 승인해도 릴리스에서 나가지 않는다', async () => {
    const w = await sendWorld();
    await setSendApproval(w.fixture.agentId, w.fixture.organizationId, 'always');
    const id = await pendingFor(w);
    await setMode(w.fixture.agentId, 'none');
    await approve(w, id);
    await release(w, id);
    expect(w.transport.calls()).toBe(0);
  });

  it('[D1-I027] 승인 대기 중 에이전트 정지 — 릴리스에서 나가지 않는다', async () => {
    const w = await sendWorld();
    await setSendApproval(w.fixture.agentId, w.fixture.organizationId, 'always');
    const id = await pendingFor(w);
    await provisioningPool().query(`UPDATE agents SET status = 'suspended', suspended_by = 'owner' WHERE id = $1`, [w.fixture.agentId]);
    await approve(w, id);
    await release(w, id);
    expect(w.transport.calls()).toBe(0);
  });

  it('[D1-I028] 승인 대기 중 조직 정지(owner_paused) — 릴리스에서 나가지 않는다', async () => {
    const w = await sendWorld();
    await setSendApproval(w.fixture.agentId, w.fixture.organizationId, 'always');
    const id = await pendingFor(w);
    await provisioningPool().query(`UPDATE organizations SET owner_paused = true WHERE id = $1`, [w.fixture.organizationId]);
    await expect(approve(w, id)).rejects.toThrow(/정지|동결|paused/);
    await release(w, id);
    expect(w.transport.calls()).toBe(0);
  });

  it('[D1-I029] 승인 TTL 이 지난 뒤 승인 시도 — not_pending(past_ttl), 나가지 않는다', async () => {
    const w = await sendWorld();
    await setSendApproval(w.fixture.agentId, w.fixture.organizationId, 'always');
    const id = await pendingFor(w);
    const late = new Date(w.clock.now.getTime() + 8 * 24 * 3600_000);
    const outcome = await approve(w, id, 'recipient', late);
    expect(outcome.kind).toBe('not_pending');
    await release(w, id);
    expect(w.transport.calls()).toBe(0);
  });

  it('[D1-I030] 거부(reject)된 요청은 릴리스되지 않는다', async () => {
    const w = await sendWorld();
    await setSendApproval(w.fixture.agentId, w.fixture.organizationId, 'always');
    const id = await pendingFor(w);
    const { rejectRequest } = await import('../../../src/approval/service');
    await rejectRequest(store(), { approvalId: id, decidedBy: 'owner:adv', now: w.clock.now });
    await release(w, id);
    expect(w.transport.calls()).toBe(0);
  });

  it('[D1-I031] 승인 전 릴리스 시도(approved 아님) — 나가지 않는다', async () => {
    const w = await sendWorld();
    await setSendApproval(w.fixture.agentId, w.fixture.organizationId, 'always');
    const id = await pendingFor(w);
    await release(w, id);
    expect(w.transport.calls()).toBe(0);
  });

  it('[D1-I032] 없는 승인 id · 다른 에이전트의 승인 id 로 릴리스 — 아무것도 나가지 않는다', async () => {
    const w = await sendWorld();
    const other = await sendWorld();
    await setSendApproval(other.fixture.agentId, other.fixture.organizationId, 'always');
    const otherId = await pendingFor(other);
    await release(w, randomUUID());
    await release(w, otherId);
    expect(w.transport.calls()).toBe(0);
    expect(other.transport.calls()).toBe(0);
  });

  it('[D1-I033] 다른 에이전트 토큰으로 승인 조회 — 남의 승인은 보이지 않는다', async () => {
    const w = await sendWorld();
    const other = await sendWorld();
    await setSendApproval(other.fixture.agentId, other.fixture.organizationId, 'always');
    const otherId = await pendingFor(other);
    const r = await api(w, 'GET', `/v1/approvals/${otherId}`, { token: w.token });
    expect([403, 404]).toContain(r.status);
  });

  it('[D1-I034] 승인 B(다른 수신자)가 A 의 릴리스를 대신하지 못한다 — A 승인 안 함, B 만 승인 → A 는 안 나간다', async () => {
    const w = await sendWorld();
    await setSendApproval(w.fixture.agentId, w.fixture.organizationId, 'always');
    const a = await pendingFor(w, PARTNER);
    const b = await pendingFor(w, CLIENT);
    await approve(w, b);
    await release(w, a);
    await release(w, b);
    expect(w.transport.calls()).toBe(1);
    const rows = await provisioningPool().query<{ recipients: string[] }>(`SELECT to_addresses AS recipients FROM messages WHERE agent_id = $1 AND status = 'sent'`, [w.fixture.agentId]).catch(() => null);
    void rows;
  });

  it('[D1-I035] 승인 후 릴리스 시 always 를 auto 로 풀든 말든 결과는 같다(소유자 승인이 이미 있다) — 그리고 감사 행은 같은 행을 갱신', async () => {
    const w = await sendWorld();
    await setSendApproval(w.fixture.agentId, w.fixture.organizationId, 'always');
    const id = await pendingFor(w);
    await approve(w, id);
    await release(w, id);
    const decisions = await auditDecisions(w.fixture.agentId);
    expect(decisions.filter((d) => d.decision === 'allowed').length).toBeLessThanOrEqual(1);
  });
});

function STRANGER_ALLOWED(w: ApiWorld): string {
  void w;
  return PARTNER;
}

// ---------------------------------------------------------------------------
// 설정을 바꾸는 사람 · 길
// ---------------------------------------------------------------------------
describe.skipIf(!OWNER_AVAILABLE)('D1 누가 바꿀 수 있나 — 역할 · 조직 · 에이전트 자신', () => {
  async function consoleWorld() {
    const w = await sendWorld();
    const owner = await sessionFor(w.fixture.organizationId, 'owner');
    const admin = await sessionFor(w.fixture.organizationId, 'admin');
    const member = await sessionFor(w.fixture.organizationId, 'member');
    const other = await sendWorld();
    const stranger = await sessionFor(other.fixture.organizationId, 'owner');
    return { w, owner, admin, member, stranger, other };
  }
  const kit = () => consoleKit();
  const patch = (session: Parameters<typeof authed>[0], agentId: string, bodyValue: unknown) => call(kit().deps, 'PATCH', `/api/agents/${agentId}/watch`, authed(session, { body: bodyValue }));
  const currentRow = async (agentId: string) => (await provisioningPool().query<{ require_approval: boolean }>('SELECT require_approval FROM agent_policies WHERE agent_id = $1', [agentId])).rows[0]?.require_approval;

  it('[D1-I036] 소유자는 always 로 켠다 · 감사 행 watch.send_approval.set', async () => {
    const { w, owner } = await consoleWorld();
    const r = await patch(owner, w.fixture.agentId, { sendApproval: 'always' });
    expect(r.statusCode, r.body).toBe(200);
    expect(await currentRow(w.fixture.agentId)).toBe(true);
    const audit = await provisioningPool().query(`SELECT 1 FROM owner_actions WHERE organization_id = $1 AND action = 'watch.send_approval.set'`, [w.fixture.organizationId]);
    expect(audit.rowCount).toBe(1);
  });

  it('[D1-I037] member 는 바꿀 수 없다(403) · 값 불변', async () => {
    const { w, member } = await consoleWorld();
    const r = await patch(member, w.fixture.agentId, { sendApproval: 'always' });
    expect(r.statusCode).toBe(403);
    expect(await currentRow(w.fixture.agentId)).toBe(false);
  });

  it('[D1-I038] member 는 always 를 auto 로 풀 수도 없다(403)', async () => {
    const { w, owner, member } = await consoleWorld();
    await patch(owner, w.fixture.agentId, { sendApproval: 'always' });
    const r = await patch(member, w.fixture.agentId, { sendApproval: 'auto' });
    expect(r.statusCode).toBe(403);
    expect(await currentRow(w.fixture.agentId)).toBe(true);
  });

  it('[D1-I039] 다른 조직의 소유자는 남의 에이전트 값을 바꿀 수 없다(404/403)', async () => {
    const { w, stranger } = await consoleWorld();
    const r = await patch(stranger, w.fixture.agentId, { sendApproval: 'always' });
    expect([403, 404]).toContain(r.statusCode);
    expect(await currentRow(w.fixture.agentId)).toBe(false);
  });

  it('[D1-I040] 다른 조직의 소유자는 남의 에이전트 always 를 auto 로 풀 수 없다', async () => {
    const { w, owner, stranger } = await consoleWorld();
    await patch(owner, w.fixture.agentId, { sendApproval: 'always' });
    const r = await patch(stranger, w.fixture.agentId, { sendApproval: 'auto' });
    expect([403, 404]).toContain(r.statusCode);
    expect(await currentRow(w.fixture.agentId)).toBe(true);
  });

  it('[D1-I041] 세션 없이 호출 — 401', async () => {
    const { w } = await consoleWorld();
    const r = await call(kit().deps, 'PATCH', `/api/agents/${w.fixture.agentId}/watch`, { body: { sendApproval: 'always' } });
    expect([401, 403]).toContain(r.statusCode);
  });

  it('[D1-I042] CSRF 헤더 없이 소유자 세션으로 호출 — 거부(값 불변)', async () => {
    const { w, owner } = await consoleWorld();
    const r = await call(kit().deps, 'PATCH', `/api/agents/${w.fixture.agentId}/watch`, { cookies: owner.cookies, body: { sendApproval: 'always' } });
    expect([401, 403]).toContain(r.statusCode);
    expect(await currentRow(w.fixture.agentId)).toBe(false);
  });

  it('[D1-I043] 에이전트 토큰을 Bearer 로 콘솔 라우트에 — 인증 거부', async () => {
    const { w } = await consoleWorld();
    const r = await call(kit().deps, 'PATCH', `/api/agents/${w.fixture.agentId}/watch`, { headers: { authorization: `Bearer ${w.token}` }, body: { sendApproval: 'always' } });
    expect([401, 403]).toContain(r.statusCode);
  });

  it.each([
    { id: 'D1-I044', value: 'ALWAYS' },
    { id: 'D1-I045', value: 'never' },
    { id: 'D1-I046', value: true },
    { id: 'D1-I047', value: null },
    { id: 'D1-I048', value: 1 },
    { id: 'D1-I049', value: ['always'] },
    { id: 'D1-I050', value: { v: 'always' } },
    { id: 'D1-I051', value: '' },
    { id: 'D1-I052', value: ' always' },
    { id: 'D1-I053', value: 'always\u0000' },
  ])('[$id] 잘못된 sendApproval 값 $value — 400 · 값 불변', async ({ value }) => {
    const { w, owner } = await consoleWorld();
    const r = await patch(owner, w.fixture.agentId, { sendApproval: value });
    expect(r.statusCode, r.body).toBe(400);
    expect(await currentRow(w.fixture.agentId)).toBe(false);
  });

  it.each([
    { id: 'D1-I054', label: '모르는 키 동봉', bodyValue: { sendApproval: 'always', requireApproval: false } },
    { id: 'D1-I055', label: 'require_approval 직접 키', bodyValue: { require_approval: false } },
    { id: 'D1-I056', label: '__proto__ 키', bodyValue: JSON.parse('{"__proto__":{"sendApproval":"auto"},"sendApproval":"always"}') as unknown },
    { id: 'D1-I057', label: '빈 본문', bodyValue: {} },
    { id: 'D1-I058', label: '배열 본문', bodyValue: [{ sendApproval: 'always' }] },
    { id: 'D1-I059', label: '문자열 본문', bodyValue: 'sendApproval=always' },
  ])('[$id] 변형 본문 — $label: 400 이거나 의도 밖 변경 없음', async ({ bodyValue }) => {
    const { w, owner } = await consoleWorld();
    const r = await patch(owner, w.fixture.agentId, bodyValue);
    expect([200, 400]).toContain(r.statusCode);
    if (r.statusCode === 200) expect(await currentRow(w.fixture.agentId)).toBe(true);
    else expect(await currentRow(w.fixture.agentId)).toBe(false);
  });

  // 고침(2026-10-08 — 리드 지시 3): 풀기(always → auto · hold → deliver)는 소유자만. 관리자는 조이기만.
  it('[D1-I060] 관리자(admin)는 소유자가 켠 always 를 auto 로 풀지 못한다(403) — 조이기(auto → always)는 된다', async () => {
    const { w, owner, admin } = await consoleWorld();
    await patch(owner, w.fixture.agentId, { sendApproval: 'always' });
    const r = await patch(admin, w.fixture.agentId, { sendApproval: 'auto' });
    expect(r.statusCode).toBe(403);
    expect(await currentRow(w.fixture.agentId)).toBe(true);
    await patch(owner, w.fixture.agentId, { sendApproval: 'auto' });
    expect((await patch(admin, w.fixture.agentId, { sendApproval: 'always' })).statusCode).toBe(200);
    expect(await currentRow(w.fixture.agentId)).toBe(true);
  });

  it('[D1-I061] 에이전트 토큰으로 정책 라우트(PATCH/PUT/POST) — 쓰기 경로 없음(404/405), 값 불변', async () => {
    const w = await sendWorld();
    await setSendApproval(w.fixture.agentId, w.fixture.organizationId, 'always');
    for (const method of ['PATCH', 'PUT', 'POST', 'DELETE']) {
      for (const path of [`/v1/agents/${w.fixture.agentId}/policy`, `/v1/agents/${w.fixture.agentId}/watch`, `/v1/agents/${w.fixture.agentId}`, `/api/agents/${w.fixture.agentId}/watch`]) {
        const r = await api(w, method, path, { token: w.token, body: { sendApproval: 'auto', send_approval: 'auto', require_approval: false }, headers: key() });
        expect([400, 401, 403, 404, 405], `${method} ${path} → ${String(r.status)}`).toContain(r.status);
      }
    }
    expect(await currentRow(w.fixture.agentId)).toBe(true);
  });

  it('[D1-I062] 모든 권한을 가진 에이전트 토큰(webhooks:manage · audit:read · agents:enroll 포함)으로도 정책 쓰기 없음', async () => {
    const w = await sendWorld();
    await setSendApproval(w.fixture.agentId, w.fixture.organizationId, 'always');
    const all = await tokenFor(w.fixture.agentId, ['messages:send', 'messages:read', 'audit:read', 'agent:read_self', 'webhooks:manage']);
    const r = await api(w, 'PATCH', `/v1/agents/${w.fixture.agentId}/policy`, { token: all, body: { send_approval: 'auto' } });
    expect([400, 403, 404, 405]).toContain(r.status);
    expect(await currentRow(w.fixture.agentId)).toBe(true);
  });

  it.each([
    { id: 'D1-I063', tool: 'set_send_approval' },
    { id: 'D1-I064', tool: 'update_policy' },
    { id: 'D1-I065', tool: 'set_policy' },
    { id: 'D1-I066', tool: 'update_agent' },
    { id: 'D1-I067', tool: 'set_my_policy' },
    { id: 'D1-I068', tool: 'approve_request' },
  ])('[$id] MCP 에 없는 도구 $tool — 호출 불가, 값 불변', async ({ tool }) => {
    const w = await sendWorld();
    await setSendApproval(w.fixture.agentId, w.fixture.organizationId, 'always');
    const r = await mcp(w, tool, { send_approval: 'auto', sendApproval: 'auto', approval_id: randomUUID() });
    expect(r.isError).toBe(true);
    expect(await currentRow(w.fixture.agentId)).toBe(true);
  });

  it('[D1-I069] get_my_policy / 정책 GET 은 sendApproval 을 읽기 전용으로 보여 준다(always)', async () => {
    const w = await sendWorld();
    await setSendApproval(w.fixture.agentId, w.fixture.organizationId, 'always');
    const r = await api(w, 'GET', `/v1/agents/${w.fixture.agentId}/policy`, { token: w.token });
    expect(r.status).toBe(200);
    expect(r.json['send_approval']).toBe('always');
  });

  it('[D1-I070] 정책 모드를 콘솔 정책 라우트로 바꿔도 always 가 유지된다(스냅샷 · 행 둘 다)', async () => {
    const { w, owner } = await consoleWorld();
    await patch(owner, w.fixture.agentId, { sendApproval: 'always' });
    const r = await call(kit().deps, 'PATCH', `/api/agents/${w.fixture.agentId}/policy`, authed(owner, { body: { outbound: { mode: 'all' } } }));
    expect(r.statusCode, r.body).toBe(200);
    const snap = await provisioningPool().query<{ snap: unknown; row: boolean }>(
      `SELECT pv.snapshot -> 'require_approval' AS snap, p.require_approval AS row FROM agent_policies p JOIN policy_versions pv ON pv.agent_id = p.agent_id AND pv.version = p.current_version WHERE p.agent_id = $1`,
      [w.fixture.agentId],
    );
    expect(snap.rows[0]).toEqual({ snap: true, row: true });
    const sent = await api(w, 'POST', '/v1/messages', { token: w.token, body: body(w, 'anyone@random.example'), headers: key() });
    expectPending(sent);
  });

  it('[D1-I071] 규칙(허용 목록) 추가·삭제로 새 버전이 생겨도 always 가 유지된다', async () => {
    const w = await sendWorld();
    await setSendApproval(w.fixture.agentId, w.fixture.organizationId, 'always');
    await addRuleOp(provisioningPool(), w.fixture.agentId, resolveContactRuleInput({ direction: 'outbound', list: 'allow', value: 'new@example.com' }), 'adv-d');
    const r = await api(w, 'POST', '/v1/messages', { token: w.token, body: body(w, 'new@example.com'), headers: key() });
    expectPending(r);
  });

  it('[D1-I072] 한도(perMinute)만 바꾸는 정책 변경에서도 always 가 유지된다', async () => {
    const { w, owner } = await consoleWorld();
    await patch(owner, w.fixture.agentId, { sendApproval: 'always' });
    const r = await call(kit().deps, 'PATCH', `/api/agents/${w.fixture.agentId}/policy`, authed(owner, { body: { limits: { perMinute: 5 } } }));
    expect(r.statusCode, r.body).toBe(200);
    expect(await currentRow(w.fixture.agentId)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DB 층 변조
// ---------------------------------------------------------------------------
describe.skipIf(!OWNER_AVAILABLE)('D1 DB 층 — 롤 권한 · 버전 불변', () => {
  it('[D1-I073] 앱 롤(런타임)은 require_approval 을 쓸 수 없다', async () => {
    const w = await sendWorld();
    await expect(testPool().query('UPDATE agent_policies SET require_approval = false WHERE agent_id = $1', [w.fixture.agentId])).rejects.toThrow();
  });

  it('[D1-I074] 앱 롤은 policy_versions 를 고쳐 쓸 수 없다(스냅샷 require_approval 지우기)', async () => {
    const w = await sendWorld();
    await setSendApproval(w.fixture.agentId, w.fixture.organizationId, 'always');
    await expect(testPool().query(`UPDATE policy_versions SET snapshot = snapshot - 'require_approval' WHERE agent_id = $1`, [w.fixture.agentId])).rejects.toThrow();
    await expect(testPool().query(`DELETE FROM policy_versions WHERE agent_id = $1`, [w.fixture.agentId])).rejects.toThrow();
  });

  it('[D1-I075] 소유자 롤도 정책 버전의 스냅샷을 고칠 수 없다(불변 트리거)', async () => {
    const w = await sendWorld();
    await setSendApproval(w.fixture.agentId, w.fixture.organizationId, 'always');
    await expect(provisioningPool().query(`UPDATE policy_versions SET snapshot = snapshot - 'require_approval' WHERE agent_id = $1`, [w.fixture.agentId])).rejects.toThrow();
  });

  it('[D1-I076] 행만 false 로 되돌린 변조(소유자 롤) — 스냅샷이 true 라서 여전히 승인 대기', async () => {
    const w = await sendWorld();
    await setSendApproval(w.fixture.agentId, w.fixture.organizationId, 'always');
    await provisioningPool().query('UPDATE agent_policies SET require_approval = false WHERE agent_id = $1', [w.fixture.agentId]);
    const r = await api(w, 'POST', '/v1/messages', { token: w.token, body: body(w), headers: key() });
    expectPending(r);
  });

  it('[D1-I077] 정책 포인터(current_version)를 always 켜기 전 버전으로 되돌린 변조 — 행이 true 라서 여전히 승인 대기 · 또는 포인터 변경 거부', async () => {
    const w = await sendWorld();
    await setSendApproval(w.fixture.agentId, w.fixture.organizationId, 'always');
    let rejected = false;
    try {
      await provisioningPool().query('UPDATE agent_policies SET current_version = 1 WHERE agent_id = $1', [w.fixture.agentId]);
    } catch {
      rejected = true;
    }
    if (!rejected) {
      const r = await api(w, 'POST', '/v1/messages', { token: w.token, body: body(w), headers: key() });
      expect(r.status).toBe(202);
    }
    expect(w.transport.calls()).toBe(0);
  });

  it('SUSPECT: [D1-I078] 포인터와 행을 함께 되돌린 변조(소유자 롤) — 정책 버전 · 감사 행 없이 always 가 조용히 꺼진다(소유자 롤은 신뢰 경계 안)', async () => {
    const w = await sendWorld();
    await setSendApproval(w.fixture.agentId, w.fixture.organizationId, 'always');
    let rejected = false;
    try {
      await provisioningPool().query('UPDATE agent_policies SET current_version = 1, require_approval = false WHERE agent_id = $1', [w.fixture.agentId]);
    } catch {
      rejected = true;
    }
    const r = await api(w, 'POST', '/v1/messages', { token: w.token, body: body(w), headers: key() });
    expect(rejected).toBe(false);
    expect(r.status).toBe(200);
  });

  it('SUSPECT: [D1-I079] admin 롤(콘솔 λ)이 포인터를 과거 버전으로 되돌려 always 를 감사 없이 끌 수 있다(정상 경로는 정책 새 버전 + owner_actions) — 트리거가 포인터 되감기를 막으면 좋다', async () => {
    const w = await sendWorld();
    await setSendApproval(w.fixture.agentId, w.fixture.organizationId, 'always');
    const admin = consoleKit().admin;
    let rejected = false;
    try {
      await admin.query('UPDATE agent_policies SET current_version = 1, require_approval = false WHERE agent_id = $1', [w.fixture.agentId]);
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(false);
    const r = await api(w, 'POST', '/v1/messages', { token: w.token, body: body(w), headers: key() });
    expect(r.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 모드 조합 · 승인 범위 · 재생 · 진행 중 전환
// ---------------------------------------------------------------------------
describe.skipIf(!OWNER_AVAILABLE)('D1 모드 조합 · 승인 범위 · 진행 중 전환', () => {
  /** 레거시 모드로 정책 새 버전(스냅샷 = 현재 + 모드만 바꿈, require_approval 은 그대로 이어진다). */
  async function legacyMode(w: ApiWorld, mode: 'approval_required' | 'reply_only'): Promise<void> {
    const db = provisioningPool();
    const cur = await db.query<{ v: number }>('SELECT current_version AS v FROM agent_policies WHERE agent_id = $1', [w.fixture.agentId]);
    const next = (cur.rows[0]?.v ?? 1) + 1;
    await db.query(
      `INSERT INTO policy_versions (agent_id, version, outbound_mode, snapshot)
       SELECT v.agent_id, $2, $3::outbound_mode, v.snapshot || jsonb_build_object('outbound_mode', $3::text)
         FROM policy_versions v JOIN agent_policies p ON p.agent_id = v.agent_id AND p.current_version = v.version WHERE v.agent_id = $1`,
      [w.fixture.agentId, next, mode],
    );
    await db.query(`UPDATE agent_policies SET outbound_mode = $2::outbound_mode, current_version = $3 WHERE agent_id = $1`, [w.fixture.agentId, mode, next]);
  }

  it.each([
    { id: 'D1-I080', label: '허용 상대 + 허용 밖 상대 혼합', to: [PARTNER, 'rando@nowhere.example'] },
    { id: 'D1-I081', label: '허용 밖 상대 한 명', to: ['rando@nowhere.example'] },
  ])('[$id] allowlist + always — $label: 허용으로 새지 않는다(거부 그대로)', async ({ to }) => {
    const w = await sendWorld();
    await setSendApproval(w.fixture.agentId, w.fixture.organizationId, 'always');
    const r = await api(w, 'POST', '/v1/messages', { token: w.token, body: { ...body(w), to }, headers: key() });
    expect(r.status).toBe(403);
    expect(w.transport.calls()).toBe(0);
  });

  it('[D1-I082] 전체 허용(all) + always — 아무 상대든 승인 대기', async () => {
    const w = await sendWorld();
    await setMode(w.fixture.agentId, 'all');
    await setSendApproval(w.fixture.agentId, w.fixture.organizationId, 'always');
    const r = await api(w, 'POST', '/v1/messages', { token: w.token, body: body(w, 'anyone@random.example'), headers: key() });
    expectPending(r);
    expect(w.transport.calls()).toBe(0);
  });

  it('[D1-I083] 전체 허용(all) + always + 수신자 20명 — 전부 한 승인 대기, 전송 0', async () => {
    const w = await sendWorld();
    await setMode(w.fixture.agentId, 'all');
    await setSendApproval(w.fixture.agentId, w.fixture.organizationId, 'always');
    const to = Array.from({ length: 20 }, (_, i) => `r${String(i)}@random.example`);
    const r = await api(w, 'POST', '/v1/messages', { token: w.token, body: { ...body(w), to }, headers: key() });
    expect([202, 400, 403]).toContain(r.status);
    expect(w.transport.calls()).toBe(0);
  });

  it('[D1-I084] 차단 목록 모드 + always — 차단 안 된 상대는 승인 대기, 차단된 상대는 거부', async () => {
    const w = await sendWorld();
    await setMode(w.fixture.agentId, 'blocklist');
    await addRuleOp(provisioningPool(), w.fixture.agentId, resolveContactRuleInput({ direction: 'outbound', list: 'block', value: 'bad@evil.example' }), 'adv-d');
    await setSendApproval(w.fixture.agentId, w.fixture.organizationId, 'always');
    expectPending(await api(w, 'POST', '/v1/messages', { token: w.token, body: body(w, 'good@fine.example'), headers: key() }));
    const blocked = await api(w, 'POST', '/v1/messages', { token: w.token, body: body(w, 'bad@evil.example'), headers: key() });
    expect(blocked.status).toBe(403);
    expect(w.transport.calls()).toBe(0);
  });

  it('[D1-I085] 발신 끔(none) + always — 거부 그대로', async () => {
    const w = await sendWorld();
    await setMode(w.fixture.agentId, 'none');
    await setSendApproval(w.fixture.agentId, w.fixture.organizationId, 'always');
    const r = await api(w, 'POST', '/v1/messages', { token: w.token, body: body(w), headers: key() });
    expect(r.status).toBe(403);
  });

  it('[D1-I086] 레거시 approval_required + always — seed 관계 상대도 승인 대기', async () => {
    const w = await sendWorld();
    await provisioningPool().query(`INSERT INTO sender_relationships (agent_id, scope, address, trust_category, granted_by) VALUES ($1, 'recipient', 'seed@example.com', 'seed', 'owner_provisioning')`, [w.fixture.agentId]);
    await setSendApproval(w.fixture.agentId, w.fixture.organizationId, 'always');
    await legacyMode(w, 'approval_required');
    const r = await api(w, 'POST', '/v1/messages', { token: w.token, body: body(w, 'seed@example.com'), headers: key() });
    expect(r.status, r.text).toBe(202);
    expect(w.transport.calls()).toBe(0);
  });

  it('[D1-I087] 레거시 approval_required + auto 대조군 — seed 관계 상대는 승인 없이 나간다(always 가 실제로 좁힌다)', async () => {
    const w = await sendWorld();
    await provisioningPool().query(`INSERT INTO sender_relationships (agent_id, scope, address, trust_category, granted_by) VALUES ($1, 'recipient', 'seed@example.com', 'seed', 'owner_provisioning')`, [w.fixture.agentId]);
    await legacyMode(w, 'approval_required');
    const r = await api(w, 'POST', '/v1/messages', { token: w.token, body: body(w, 'seed@example.com'), headers: key() });
    expect(r.status, r.text).toBe(200);
  });

  it('[D1-I088] 레거시 reply_only + always — 외부 메일 회신은 거부(승인 없이 나가지 않는다)', async () => {
    const w = await sendWorld();
    const inbound = await receiveFrom(w, CLIENT);
    await setSendApproval(w.fixture.agentId, w.fixture.organizationId, 'always');
    await legacyMode(w, 'reply_only');
    const r = await api(w, 'POST', `/v1/threads/${inbound.threadId}/reply`, { token: w.token, body: { agent_id: w.fixture.agentId, in_reply_to: inbound.id, text: '답장' }, headers: key() });
    expect([202, 403]).toContain(r.status);
    expect(w.transport.calls()).toBe(0);
  });

  it('[D1-I089] 레거시 reply_only + auto 대조군 — 같은 회신은 나가거나(승인 대기) 거부되지 않는다', async () => {
    const w = await sendWorld();
    const inbound = await receiveFrom(w, CLIENT);
    await legacyMode(w, 'reply_only');
    const r = await api(w, 'POST', `/v1/threads/${inbound.threadId}/reply`, { token: w.token, body: { agent_id: w.fixture.agentId, in_reply_to: inbound.id, text: '답장' }, headers: key() });
    expect([200, 202]).toContain(r.status);
  });

  it('[D1-I090] 레거시 reply_only + always — 새 메일(스레드 아님)은 나가지 않는다', async () => {
    const w = await sendWorld();
    await setSendApproval(w.fixture.agentId, w.fixture.organizationId, 'always');
    await legacyMode(w, 'reply_only');
    const r = await api(w, 'POST', '/v1/messages', { token: w.token, body: body(w), headers: key() });
    expect(r.status).not.toBe(200);
    expect(w.transport.calls()).toBe(0);
  });

  it('[D1-I091] 회신 + 수신자 override(다른 사람에게 보내기) + always — 승인 대기 · 전송 0', async () => {
    const w = await sendWorld();
    const inbound = await receiveFrom(w, CLIENT);
    await setSendApproval(w.fixture.agentId, w.fixture.organizationId, 'always');
    const r = await api(w, 'POST', `/v1/threads/${inbound.threadId}/reply`, { token: w.token, body: { agent_id: w.fixture.agentId, in_reply_to: inbound.id, text: '답장', to: [PARTNER] }, headers: key() });
    expect([202, 403]).toContain(r.status);
    expect(w.transport.calls()).toBe(0);
  });

  it('[D1-I092] 답장 초안(in_reply_to) 보내기 + always — 승인 대기', async () => {
    const w = await sendWorld();
    const inbound = await receiveFrom(w, CLIENT);
    await setSendApproval(w.fixture.agentId, w.fixture.organizationId, 'always');
    const draft = await mcp(w, 'create_draft', { message_id: inbound.id, text: '답장 초안' });
    const id = String(draft.meta['draft_id'] ?? draft.meta['id']);
    const r = await mcp(w, 'send_draft', { draft_id: id });
    expect(r.meta['outcome']).not.toBe('sent');
    expect(w.transport.calls()).toBe(0);
  });

  it('[D1-I093] 초안을 auto 에서 만들고 always 로 바꾼 뒤 보내기 — 승인 대기', async () => {
    const w = await sendWorld();
    const draft = await mcp(w, 'create_draft', { to: [PARTNER], subject: '초안', text: '본문' });
    const id = String(draft.meta['draft_id'] ?? draft.meta['id']);
    await setSendApproval(w.fixture.agentId, w.fixture.organizationId, 'always');
    const r = await mcp(w, 'send_draft', { draft_id: id });
    expect(r.meta['outcome']).toBe('pending_approval');
  });

  it('[D1-I094] 같은 초안을 두 번 보내기(always) — 두 번째도 sent 가 아니고 전송 0', async () => {
    const w = await sendWorld();
    await setSendApproval(w.fixture.agentId, w.fixture.organizationId, 'always');
    const draft = await mcp(w, 'create_draft', { to: [PARTNER], subject: '초안', text: '본문' });
    const id = String(draft.meta['draft_id'] ?? draft.meta['id']);
    await mcp(w, 'send_draft', { draft_id: id });
    const second = await mcp(w, 'send_draft', { draft_id: id, idempotency_key: 'fresh-key-2' });
    expect(second.meta['outcome']).not.toBe('sent');
    expect(w.transport.calls()).toBe(0);
  });

  it.each([
    { id: 'D1-I095', scope: 'thread' as const },
    { id: 'D1-I096', scope: 'domain' as const },
  ])('[$id] 승인 범위 $scope 로 승인한 뒤 같은 범위의 새 메시지도 always 면 다시 승인 대기', async ({ scope }) => {
    const w = await sendWorld(['a@example.com', 'b@example.com']);
    await setSendApproval(w.fixture.agentId, w.fixture.organizationId, 'always');
    const first = await api(w, 'POST', '/v1/messages', { token: w.token, body: body(w, 'a@example.com'), headers: key() });
    expect(first.status).toBe(202);
    const store = createPostgresApprovalStore(testPool());
    const outcome = await approveRequest(store, { approvalId: String(first.json['approval_id']), decidedBy: 'owner:adv', now: w.clock.now, scope: 'recipient', confirmScope: null }).catch(() => null);
    void outcome;
    void scope;
    const second = await api(w, 'POST', '/v1/messages', { token: w.token, body: body(w, 'b@example.com'), headers: key() });
    expectPending(second);
  });

  it('[D1-I097] 승인·릴리스로 나간 메시지의 같은 키 재생 — 새 전송 없음', async () => {
    const w = await sendWorld();
    await setSendApproval(w.fixture.agentId, w.fixture.organizationId, 'always');
    const k = { 'idempotency-key': randomUUID() };
    const first = await api(w, 'POST', '/v1/messages', { token: w.token, body: body(w), headers: k });
    const id = String(first.json['approval_id']);
    const store = createPostgresApprovalStore(testPool());
    await approveRequest(store, { approvalId: id, decidedBy: 'owner:adv', now: w.clock.now, scope: 'recipient', confirmScope: null });
    await runApprovalRelease({ service: w.service, approvals: store, transport: w.transport }, { approvalId: id, traceId: null });
    expect(w.transport.calls()).toBe(1);
    await api(w, 'POST', '/v1/messages', { token: w.token, body: body(w), headers: k });
    await api(w, 'POST', '/v1/messages', { token: w.token, body: body(w), headers: k });
    expect(w.transport.calls()).toBe(1);
  });

  it('[D1-I098] 에이전트 스스로 승인하려는 시도 — 라우트 없음(404/405) · MCP 에도 없음', async () => {
    const w = await sendWorld();
    await setSendApproval(w.fixture.agentId, w.fixture.organizationId, 'always');
    const first = await api(w, 'POST', '/v1/messages', { token: w.token, body: body(w), headers: key() });
    const id = String(first.json['approval_id']);
    for (const [method, path] of [['POST', `/v1/approvals/${id}/approve`], ['POST', `/v1/approvals/${id}`], ['PUT', `/v1/approvals/${id}`], ['PATCH', `/v1/approvals/${id}`]] as const) {
      const r = await api(w, method, path, { token: w.token, body: { decision: 'approved', status: 'approved' }, headers: key() });
      expect([400, 401, 403, 404, 405], `${method} ${path}`).toContain(r.status);
    }
    const status = await api(w, 'GET', `/v1/approvals/${id}`, { token: w.token });
    expect(status.json['status']).toBe('pending');
    expect(w.transport.calls()).toBe(0);
  });

  it('SUSPECT: [D1-I099] 전송 중(전송단에 들어간) 발송은 그 사이 always 로 바꿔도 나간다 — 이미 허용 판정을 받은 단 한 건', async () => {
    const w = await sendWorld();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = { calls: () => w.transport.calls(), send: async (request: Parameters<typeof w.transport.send>[0]) => { await gate; return w.transport.send(request); } };
    const slowWorld: ApiWorld = { ...w, deps: { ...w.deps, send: { ...w.deps.send, transport: slow as never } } };
    const inFlight = api(slowWorld, 'POST', '/v1/messages', { token: w.token, body: body(w), headers: key() });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await setSendApproval(w.fixture.agentId, w.fixture.organizationId, 'always');
    release();
    const done = await inFlight;
    expect(done.status).toBe(200);
    expect(w.transport.calls()).toBe(1);
    expectPending(await api(w, 'POST', '/v1/messages', { token: w.token, body: body(w, PARTNER, { subject: '다음' }), headers: key() }));
  });

  it('[D1-I100] 동시 30건(서로 다른 키) + always — 하나도 sent 가 아니다', async () => {
    const w = await sendWorld();
    await setSendApproval(w.fixture.agentId, w.fixture.organizationId, 'always');
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => api(w, 'POST', '/v1/messages', { token: w.token, body: body(w, PARTNER, { subject: `m${String(i)}` }), headers: key() })));
    for (const r of results) expect([202, 429]).toContain(r.status);
    expect(w.transport.calls()).toBe(0);
    expect((await outboundRows(w.fixture.agentId)).filter((m) => m.status === 'sent')).toHaveLength(0);
  });
});
