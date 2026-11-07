/**
 * `POST /v1/agents/:id/transition-announcement` — **배선** (계획 §3.2 2단계 · AC-b1 · AC-b2), DB 없이.
 *
 * DB 가 있어야만 참인 것(요청 행 1개·`subject='batch'`·결정된 요청에 합류 불가·audit 20행의 실제 갱신)은
 * `test/integration/approval/transition-announcement.test.ts` 가 본다. 여기서는 라우트 → 관문 → 릴리스의
 * 배선과 수신자별 결말, 응답 모양, 멱등을 본다.
 */

import { describe, expect, it } from 'vitest';

import type { ApiRequest } from '../../../src/api/http';
import {
  handleTransitionAnnouncement,
  recipientIdempotencyKey,
  toAnnouncementResponse,
} from '../../../src/api/routes/transition-announcement';
import { renderTransitionAnnouncement } from '../../../src/api/transition-announcement-template';
import type { ApprovalRequestItemRow, ApprovalRequestRow, SenderRelationshipRow } from '../../../src/db/schema';
import type { AuditEntry } from '../../../src/policy/gate';
import type { PolicySource, PolicySourceResult } from '../../../src/policy/policy-loader';
import { runApprovalRelease } from '../../../src/workers/approval-release';
import {
  AGENT_ADDRESS,
  AGENT_ID,
  NOW,
  approvedWithSchedule,
  harness,
  issuedToken,
  policyRow,
  policyVersionRow,
  sourceResult,
  suppressionRow,
  type OutboundHarness,
} from './support/fakes';

const SEEDS = Array.from({ length: 20 }, (_, index) => `seed-${String(index + 1).padStart(2, '0')}@partner.example`);

function seedRelationship(address: string): SenderRelationshipRow {
  return {
    id: `rel-${address}`,
    agent_id: AGENT_ID,
    scope: 'recipient',
    address,
    domain: null,
    thread_id: null,
    trust_category: 'seed',
    granted_via_approval_id: null,
    granted_by: 'owner_provisioning',
    domain_scope_confirmed_by: null,
    created_at: NOW,
  };
}

/**
 * 기본 모드(`approval_required`) + seed 20명. **표지가 없으면 20명 전원이 `seed_relationship` 으로 허용되는
 * 상태다** — 그래서 이 픽스처 위에서 승인 대기가 나오는 것은 표지 덕분이다(대조군 테스트 참조).
 * 워밍업은 Day 16+ (캡 1000) — 캡 축은 따로 본다.
 */
function announcementResult(overrides: Partial<PolicySourceResult> = {}): PolicySourceResult {
  const base = sourceResult();
  return {
    ...base,
    organization: { ...base.organization, sending_started_at: new Date('2026-09-01T00:00:00.000Z') },
    policy: policyRow({
      outbound_mode: 'approval_required',
      limits: { per_minute: 100, per_hour: 1000, per_day: 5000, recipients_per_message: 10 },
    }),
    policyVersion: policyVersionRow({ outbound_mode: 'approval_required' }),
    relationships: SEEDS.map(seedRelationship),
    ...overrides,
  };
}

function announce(
  test: OutboundHarness,
  options: {
    readonly seeds?: readonly string[];
    readonly key?: string;
    readonly body?: Record<string, unknown>;
  } = {},
) {
  const token = issuedToken();
  const request: ApiRequest = {
    headers: { authorization: `Bearer ${token.plaintext}`, 'idempotency-key': options.key ?? 'announce-1' },
    query: {},
    body: { agent_id: AGENT_ID, from: AGENT_ADDRESS, owner_name: '진윤겸', ...options.body },
  };
  return handleTransitionAnnouncement(
    { tokens: token.store, service: test.service, seeds: { listSeedContacts: () => Promise.resolve(options.seeds ?? SEEDS) } },
    request,
  );
}

function approvalIdsOf(rows: readonly AuditEntry[]): string[] {
  return [...new Set(rows.flatMap((row) => (row.approval === null ? [] : [row.approval.approvalId])))];
}

describe('AC-b1 — 20명에 요청 1개, 승인 전 SES 0회', () => {
  it('20 시도 = 20 audit 행(전부 승인 대기) · 공유 approval_id 1개 · subject batch · 전송단 미접촉', async () => {
    const test = harness(announcementResult());
    const response = await announce(test);

    expect(response.status).toBe(202);
    expect(response.body['counts']).toEqual({ recipients: 20, pending_approval: 20, denied: 0, replayed: 0 });

    const rows = test.audit.rows;
    expect(rows).toHaveLength(20);
    expect(rows.every((row) => row.decision.verdict === 'pending_approval')).toBe(true);
    // **요청 1개.** 20행이 같은 id 를 싣는다 — 시도마다 새 id 였다면 여기가 20이다.
    const approvalIds = approvalIdsOf(rows);
    expect(approvalIds).toHaveLength(1);
    expect(response.body['approval_id']).toBe(approvalIds[0]);
    expect(rows.every((row) => row.approval?.subject === 'batch')).toBe(true);
    // 항목 = 수신자 1명씩, seed 순서 그대로.
    expect(rows.map((row) => row.approval?.envelope.recipients)).toEqual(SEEDS.map((seed) => [seed]));
    // 사유는 표지 하나 — seed_relationship 이 아니다.
    expect(rows.every((row) => row.decision.reasons.join() === 'transition_announcement')).toBe(true);
    // 같은 시계 — 요청 하나의 created_at/expires_at 이 항목마다 갈라지지 않는다.
    expect(new Set(rows.map((row) => row.approval?.expiresAt.getTime())).size).toBe(1);

    // **승인 전 SES 0회**: lease 를 잡은 시도가 없다 — 20행 전부 `pending` 이다(전송단에 닿으려면 lease 가 먼저다).
    for (const row of rows) {
      const message = await test.service.messages.findById(row.messageId as string);
      expect(message?.status).toBe('pending');
    }
    expect(test.audit.resolutions).toHaveLength(0);
    expect(test.transport.calls()).toBe(0);
  });

  it('공지 본문은 템플릿 — 에이전트 주소·소유자 이름이 치환된다(ko 기본, en 선택)', async () => {
    const test = harness(announcementResult());
    await announce(test, { seeds: [SEEDS[0] as string], body: { language: 'en', owner_name: 'Younkyum Jin' } });
    const messageId = test.audit.rows[0]?.messageId as string;
    const stored = await test.content.load(messageId);
    const expected = renderTransitionAnnouncement({ agentAddress: AGENT_ADDRESS, ownerName: 'Younkyum Jin', language: 'en' });
    expect(stored).toEqual({ subject: expected.subject, text: expected.text, html: null, threading: null });
    expect(expected.subject).toContain(AGENT_ADDRESS);
    expect(expected.text).toContain('Younkyum Jin');

    const ko = renderTransitionAnnouncement({ agentAddress: AGENT_ADDRESS, ownerName: '진윤겸', language: 'ko' });
    expect(ko.subject).toContain('진윤겸');
    expect(ko.text).toContain(AGENT_ADDRESS);
    // "계속 전달된다" 고 약속하지 않는다 — 전달 규칙은 8일차에 꺼진다(§3.2 C1).
    expect(ko.text).toContain('곧 전달이 중단됩니다');
  });
});

describe('AC-b2 — 승인 뒤 20통, 20행 전부 transition_announcement + 같은 approval_id', () => {
  it('릴리스가 20건을 보내고 **새 행 없이** 같은 20행을 갱신한다', async () => {
    let current = announcementResult();
    const switchable: PolicySource = { load: () => Promise.resolve(current) };
    const test = harness(current);
    const service = { ...test.service, source: switchable };

    const response = await handleTransitionAnnouncement(
      {
        tokens: issuedToken().store,
        service,
        seeds: { listSeedContacts: () => Promise.resolve(SEEDS) },
      },
      {
        headers: { authorization: '', 'idempotency-key': 'k' },
        query: {},
        body: {},
      },
    );
    // 인증 없이 들어오면 관문 앞에서 끝난다 — 행도 요청도 없다.
    expect(response.status).toBe(401);
    expect(test.audit.rows).toHaveLength(0);

    const first = await announce({ ...test, service });
    expect(first.status).toBe(202);
    const rows = [...test.audit.rows];
    const [approvalId] = approvalIdsOf(rows);
    if (approvalId === undefined) throw new Error('요청이 없다');

    // 사람이 승인했다 — 로더가 읽는 grant.
    const request: ApprovalRequestRow = {
      id: approvalId,
      agent_id: AGENT_ID,
      subject: 'batch',
      status: 'approved',
      created_at: NOW,
      expires_at: new Date(NOW.getTime() + 24 * 3600 * 1000),
      decided_at: NOW,
      decided_by: 'owner@example.com',
      granted_scope: 'recipient',
    };
    current = { ...current, approvalGrant: { request, recipients: SEEDS } };
    const items: ApprovalRequestItemRow[] = rows.map((row, index) => ({
      approval_id: approvalId,
      message_id: row.messageId as string,
      audit_id: `audit-${String(index + 1)}`,
      from_address: row.approval?.envelope.fromAddress as string,
      recipients: row.approval?.envelope.recipients as readonly string[],
      is_thread_reply: false,
      thread_id: null,
      cost_cents: 0,
      created_at: NOW,
    }));

    const outcomes = await runApprovalRelease(
      {
        service,
        approvals: approvedWithSchedule(request, items),
        transport: test.transport,
      },
      { approvalId, traceId: null },
    );

    expect(outcomes.map((outcome) => outcome.kind)).toEqual(Array.from({ length: 20 }, () => 'sent'));
    expect(test.transport.calls()).toBe(20);
    // **20행 그대로다** — 릴리스는 새 행을 쓰지 않고 같은 행을 `allowed` 로 갱신했다(§4.3).
    expect(test.audit.rows).toHaveLength(20);
    expect(test.audit.pendingResolutions).toHaveLength(20);
    expect(test.audit.pendingResolutions.every((entry) => entry.target.approvalId === approvalId)).toBe(true);
    expect(test.audit.pendingResolutions.every((entry) => entry.resolution.kind === 'released')).toBe(true);
    expect(new Set(test.audit.pendingResolutions.map((entry) => entry.target.auditId)).size).toBe(20);
    // 각 행의 사유는 최초 평가 값이다(DB 에서는 트리거로 불변) — 20행 전부 transition_announcement.
    expect(test.audit.rows.every((row) => row.decision.reasons.includes('transition_announcement'))).toBe(true);
    expect(test.audit.resolutions.filter((entry) => entry.outcome === 'sent')).toHaveLength(20);
  });
});

describe('부분 실패 — 배치 원자성이 아니라 수신자별 결말', () => {
  it('한 명이 억제 목록이면 그 한 명만 denied(요청 항목 없음), 19명은 같은 요청으로 대기 — 202', async () => {
    const suppressed = SEEDS[4] as string;
    const test = harness(announcementResult({ suppressions: [suppressionRow(suppressed)] }));
    const response = await announce(test);

    expect(response.status).toBe(202);
    expect(response.body['counts']).toEqual({ recipients: 20, pending_approval: 19, denied: 1, replayed: 0 });
    // 시도 20건 = 20행. 거부 행도 한 시도의 결말이다.
    expect(test.audit.rows).toHaveLength(20);
    const deniedRows = test.audit.rows.filter((row) => row.decision.verdict === 'denied');
    expect(deniedRows).toHaveLength(1);
    expect(deniedRows[0]?.decision.reasons).toEqual(['suppression_list']);
    // 억제된 상대는 사람에게 묻지 않는다(§4.2 원칙 1).
    expect(deniedRows[0]?.approval).toBeNull();
    expect(approvalIdsOf(test.audit.rows)).toHaveLength(1);
    const results = response.body['results'] as readonly { recipient: string; status: string }[];
    expect(results.find((result) => result.recipient === suppressed)?.status).toBe('denied');
  });

  it('전원 거부(kill-switch)면 403 policy_denied · 요청 0개', async () => {
    const base = announcementResult();
    const test = harness({ ...base, organization: { ...base.organization, abuse_freeze: true } });
    const response = await announce(test);

    expect(response.status).toBe(403);
    expect(response.body['error']).toBe('policy_denied');
    expect((response.body['decision'] as { reasons: string[] }).reasons).toContain('org_abuse_freeze');
    expect(test.audit.rows).toHaveLength(20);
    expect(approvalIdsOf(test.audit.rows)).toHaveLength(0);
  });
});

describe('멱등 (§4.5-1)', () => {
  it('같은 키 재호출 — 새 행·새 요청 없이 최초 결과(대기)를 돌려준다', async () => {
    const test = harness(announcementResult());
    await announce(test);
    const replay = await announce(test);

    expect(replay.status).toBe(202);
    expect(replay.body['counts']).toEqual({ recipients: 20, pending_approval: 0, denied: 0, replayed: 20 });
    expect(test.audit.rows).toHaveLength(20);
    expect(test.store.rowCount()).toBe(20);
  });

  it('전원 거부였던 공지의 재호출은 다시 403', async () => {
    const base = announcementResult();
    const test = harness({ ...base, organization: { ...base.organization, abuse_freeze: true } });
    await announce(test);
    const replay = await announce(test);
    expect(replay.status).toBe(403);
    expect(test.audit.rows).toHaveLength(20);
  });

  it('같은 키로 다른 공지(소유자 이름) → 409', async () => {
    const test = harness(announcementResult());
    await announce(test);
    const conflict = await announce(test, { body: { owner_name: '다른 사람' } });
    expect(conflict.status).toBe(409);
    expect(conflict.body['error']).toBe('idempotency_key_reused');
    expect(test.audit.rows).toHaveLength(20);
  });

  it('수신자별 키는 (요청 키, 수신자) 로 결정되고 255자 CHECK 안이다', () => {
    const a = recipientIdempotencyKey('k'.repeat(255), 'x@y.z');
    expect(a).toBe(recipientIdempotencyKey('k'.repeat(255), 'x@y.z'));
    expect(a).not.toBe(recipientIdempotencyKey('k'.repeat(255), 'w@y.z'));
    expect(a.length).toBeLessThanOrEqual(255);
  });
});

describe('관문 앞에서 끝나는 요청 — 행도 요청도 없다', () => {
  it.each([
    ['owner_name 없음', { owner_name: undefined }],
    ['owner_name 에 개행(헤더 인젝션)', { owner_name: '진윤겸\r\nBcc: x@y.z' }],
    ['owner_name 에 양방향 재정렬 문자', { owner_name: '진윤‮겸' }],
    ['owner_name 이 너무 길다', { owner_name: '가'.repeat(81) }],
    ['language 가 ko/en 밖', { language: 'jp' }],
    ['from 이 정규형이 아니다', { from: 'Demo-Agent+x@atmark.ai' }],
    ['from 이 주소가 아니다', { from: 'not-an-address' }],
    ['agent_id 형식 오류', { agent_id: 'nope' }],
    ['cost_cents 음수', { cost_cents: -1 }],
  ] as const)('%s → 400', async (_name, body) => {
    const test = harness(announcementResult());
    const response = await announce(test, { body });
    expect(response.status).toBe(400);
    expect(test.audit.rows).toHaveLength(0);
  });

  it('본문이 객체가 아니면 400', async () => {
    const test = harness(announcementResult());
    const token = issuedToken();
    const response = await handleTransitionAnnouncement(
      { tokens: token.store, service: test.service, seeds: { listSeedContacts: () => Promise.resolve(SEEDS) } },
      { headers: { authorization: `Bearer ${token.plaintext}`, 'idempotency-key': 'k' }, query: {}, body: [] },
    );
    expect(response.status).toBe(400);
  });

  it('다른 에이전트를 대상으로 하면 403 forbidden', async () => {
    const test = harness(announcementResult());
    const response = await announce(test, { body: { agent_id: 'f'.repeat(32) } });
    expect(response.status).toBe(403);
    expect(response.body['error']).toBe('forbidden');
    expect(test.audit.rows).toHaveLength(0);
  });

  it('seed 0개 → 409 no_seed_contacts, seed 21개 → 409 seed_contacts_over_limit', async () => {
    const test = harness(announcementResult());
    expect((await announce(test, { seeds: [] })).body['error']).toBe('no_seed_contacts');
    const over = await announce(test, { seeds: [...SEEDS, 'one-more@partner.example'] });
    expect(over.status).toBe(409);
    expect(over.body['error']).toBe('seed_contacts_over_limit');
    expect(test.audit.rows).toHaveLength(0);
  });
});

describe('응답 번역 — 이 경로에서 나오면 안 되는 결말', () => {
  it('sent/failed 같은 결말이 섞이면 502 — 매니페스트 표지가 사라졌다는 신호', () => {
    const response = toAnnouncementResponse([
      { recipient: 'a@b.c', outcome: { kind: 'failed', messageId: 'm-1', reason: 'x', decision: undefined as never } },
      { recipient: 'g@h.i', outcome: { kind: 'sent', messageId: 'm-3', messageIdHeader: '<x@y>', sesMessageId: 's', decision: undefined as never, settled: true } },
    ]);
    expect(response.status).toBe(502);
    expect(response.body['error']).toBe('transition_announcement_unexpected_outcome');
  });

  it('입력 오류 결말은 400', () => {
    const response = toAnnouncementResponse([{ recipient: 'a@b.c', outcome: { kind: 'invalid', detail: 'x' } }]);
    expect(response.status).toBe(400);
  });
});
