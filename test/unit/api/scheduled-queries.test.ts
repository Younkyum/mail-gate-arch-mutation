/**
 * 메일 기본기 A3 — `scheduled-queries.ts` 의 **번역층**만(저장소는 가짜). 실제 DB 위의 판정·가드·경합은
 * `test/integration/db/scheduled-cancel.test.ts` · `test/integration/workers/scheduled-cancel-race.test.ts` 가 본다.
 *
 *   - 저장소 판정 7가지 → HTTP 상태·오류 코드가 **서로 다르다**(AC-A3-2). 취소 로그·메트릭은 `cancelled` 에서만, 거부 로그
 *     `scheduled.cancel_rejected {agent_id, route_id, outcome}` 는 403·429 에서만(코드 리뷰 M7-a).
 *   - 단건 조회: 본문 객체가 없거나 깨졌으면 `subject: null` + 경고 한 줄(코드 리뷰 L5) — 저장소 장애는 그대로 던진다.
 *   - 경로(`channel`)는 인자 그대로 저장소에 간다 — 헤더로 바꿀 수 없다.
 *   - 에이전트 응답에 취소 메모가 없다(행에 있어도).
 *   - 형식 오류·인증 실패·권한 없음은 저장소에 닿기 전에 끝난다.
 *   - 커서 왕복과 거부.
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { ApiRequest } from '../../../src/api/http';
import {
  decodeScheduledCursor,
  encodeScheduledCursor,
  handleCancelScheduledMessage,
  handleGetScheduledMessage,
  handleListScheduledMessages,
  type ScheduledQueryRouteDependencies,
} from '../../../src/api/routes/scheduled-queries';
import type {
  ScheduledCancelInput,
  ScheduledCancelOutcome,
  ScheduledSendRecord,
  ScheduledSendStore,
} from '../../../src/db/repositories/scheduled-send-store';
import { AGENT_SCHEDULED_CANCEL_HOURLY_LIMIT, toAgentId, type AgentTokenCapability } from '../../../src/db/schema';
import { hashAgentToken, issueAgentToken, type AgentTokenStore } from '../../../src/identity/agent-token';
import { resetLogSink, setLogSink } from '../../../src/observability/logger';
import { ALARM_LOG_EVENTS } from '../../../src/observability/metrics';
import { ObjectNotFoundError } from '../../../src/storage/object-store';
import { ScheduledContentCorruptError, type ScheduledContentStore } from '../../../src/storage/scheduled-content-store';

afterEach(() => {
  resetLogSink();
});

const AGENT = toAgentId('a'.repeat(32));
const OTHER = toAgentId('b'.repeat(32));
const ID = '11111111-2222-4333-8444-555555555555';

function record(overrides: Partial<ScheduledSendRecord> = {}): ScheduledSendRecord {
  return {
    id: ID,
    agentId: AGENT,
    requestHash: 'f'.repeat(64),
    fromAddress: 'agent@atmark.ai',
    recipients: ['friend@example.com'],
    sendAt: new Date('2026-09-27T00:00:00.000Z'),
    traceId: null,
    costCents: 0,
    status: 'cancelled',
    attemptCount: 0,
    dispatchOutcome: null,
    messageId: null,
    createdAt: new Date('2026-09-26T00:00:00.000Z'),
    riskTainted: false,
    riskDlp: [],
    agentCancellable: true,
    cancelledAt: new Date('2026-09-26T01:00:00.000Z'),
    cancelReasonCode: 'other',
    cancelNote: 'OWNER-ONLY-NOTE',
    cancelledVia: 'mcp',
    ...overrides,
  };
}

function tokens(capabilities: readonly AgentTokenCapability[]): { readonly plaintext: string; readonly store: AgentTokenStore } {
  const issued = issueAgentToken(AGENT, capabilities);
  return {
    plaintext: issued.plaintext,
    store: {
      findByHash: (hash) =>
        Promise.resolve(
          hash === hashAgentToken(issued.plaintext) ? { tokenHash: hash, agentId: AGENT, capabilities, revokedAt: null, expiresAt: null } : null,
        ),
    },
  };
}

interface Harness {
  readonly deps: ScheduledQueryRouteDependencies;
  readonly token: string;
  readonly calls: string[];
  readonly cancelInputs: ScheduledCancelInput[];
}

function harness(
  options: {
    readonly outcome?: ScheduledCancelOutcome;
    readonly capabilities?: readonly AgentTokenCapability[];
    readonly load?: ScheduledContentStore['load'];
  } = {},
): Harness {
  const calls: string[] = [];
  const cancelInputs: ScheduledCancelInput[] = [];
  const schedules: ScheduledSendStore = {
    create: () => Promise.reject(new Error('create')),
    claimDue: () => Promise.reject(new Error('claimDue')),
    markDispatched: () => Promise.reject(new Error('markDispatched')),
    listForAgent: (agentId, query) => {
      calls.push(`list:${agentId}:${String(query.limit)}`);
      return Promise.resolve([record()]);
    },
    findForAgent: (id, agentId) => {
      calls.push(`find:${id}:${agentId}`);
      return Promise.resolve(record());
    },
    cancel: (input) => {
      calls.push('cancel');
      cancelInputs.push(input);
      return Promise.resolve(options.outcome ?? { kind: 'cancelled', record: record() });
    },
  };
  const content: ScheduledContentStore = {
    keyFor: (id) => `outbound/scheduled/${id}.json`,
    put: () => Promise.reject(new Error('put')),
    load: options.load ?? (() => Promise.resolve({ subject: '제목', text: '본문', html: null })),
  };
  const token = tokens(options.capabilities ?? ['messages:send', 'messages:read']);
  return { deps: { tokens: token.store, schedules, content, now: () => new Date('2026-09-26T02:00:00.000Z') }, token: token.plaintext, calls, cancelInputs };
}

function request(token: string, body: unknown = { reason_code: 'other' }, query: Record<string, string> = {}): ApiRequest {
  return { headers: { authorization: `Bearer ${token}` }, query, body };
}

describe('취소 판정 → HTTP (AC-A3-2)', () => {
  const cases: readonly [ScheduledCancelOutcome, number, string | null][] = [
    [{ kind: 'cancelled', record: record() }, 200, null],
    [{ kind: 'replayed', record: record() }, 200, null],
    [{ kind: 'not_found' }, 404, 'schedule_not_found'],
    [{ kind: 'already_dispatched' }, 409, 'schedule_already_dispatched'],
    [{ kind: 'in_flight' }, 409, 'schedule_in_flight'],
    [{ kind: 'not_agent_cancellable' }, 403, 'schedule_not_agent_cancellable'],
    [{ kind: 'rate_limited' }, 429, 'cancel_rate_limited'],
  ];

  it('판정마다 상태·코드가 정해져 있고 오류 코드는 서로 다르다 · 취소 로그·메트릭은 cancelled 에서만 · 거부 로그는 403·429 에서만', async () => {
    const codes = new Set<string>();
    for (const [index, [outcome, status, error]] of cases.entries()) {
      const h = harness({ outcome });
      const lines: string[] = [];
      setLogSink((line) => lines.push(line));
      // 경로를 번갈아 — 거부 로그는 두 경로 모두에서 난다(보호가 채널 무관하다).
      const channel = index % 2 === 0 ? 'mcp' : 'http';
      const response = await handleCancelScheduledMessage(h.deps, request(h.token), { scheduleId: ID }, channel);
      resetLogSink();
      expect(response.status, outcome.kind).toBe(status);
      if (error === null) {
        expect(response.body['replayed'], outcome.kind).toBe(outcome.kind === 'replayed');
      } else {
        expect(response.body['error'], outcome.kind).toBe(error);
        codes.add(error);
      }
      const emitted = lines.filter((line) => line.includes('scheduled.cancelled') || line.includes('atmark.scheduled.cancelled'));
      expect(emitted.length, outcome.kind).toBe(outcome.kind === 'cancelled' ? 2 : 0);
      const rejected = lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line['event'] === ALARM_LOG_EVENTS.scheduledCancelRejected);
      if (outcome.kind === 'not_agent_cancellable' || outcome.kind === 'rate_limited') {
        expect(rejected, outcome.kind).toHaveLength(1);
        // 동결 어휘의 세 칸만 — schedule id·사유·note 는 싣지 않는다.
        const { ts: _ts, level: _level, event: _event, ...fields } = rejected[0] as Record<string, unknown>;
        expect(fields, outcome.kind).toEqual({ agent_id: AGENT, route_id: channel, outcome: outcome.kind });
      } else {
        expect(rejected, outcome.kind).toHaveLength(0);
      }
    }
    expect(codes.size).toBe(cases.filter(([, , error]) => error !== null).length);
  });

  it('경로 인자가 그대로 저장소에 간다 · 요청 헤더로 바꿀 수 없다 · 상한 상수를 넘긴다', async () => {
    const h = harness();
    const spoofed: ApiRequest = { headers: { authorization: `Bearer ${h.token}`, 'x-atmark-channel': 'http' }, query: {}, body: { reason_code: 'duplicate' } };
    await handleCancelScheduledMessage(h.deps, spoofed, { scheduleId: ID }, 'mcp');
    await handleCancelScheduledMessage(h.deps, request(h.token), { scheduleId: ID }, 'http');
    expect(h.cancelInputs.map((input) => input.channel)).toEqual(['mcp', 'http']);
    expect(h.cancelInputs[0]).toMatchObject({ id: ID, agentId: AGENT, reasonCode: 'duplicate', note: null, agentHourlyLimit: AGENT_SCHEDULED_CANCEL_HOURLY_LIMIT });
    // 상한은 경로와 무관하게 같은 값이다(보안 M1).
    expect(h.cancelInputs[1]).toMatchObject({ channel: 'http', agentHourlyLimit: AGENT_SCHEDULED_CANCEL_HOURLY_LIMIT });
  });

  it('형식 틀린 id · 인증 없음 · 권한 없음 · 본문 오류는 저장소에 닿지 않는다', async () => {
    const h = harness();
    expect((await handleCancelScheduledMessage(h.deps, request(h.token), { scheduleId: 'x' }, 'http')).status).toBe(400);
    expect((await handleCancelScheduledMessage(h.deps, request('nope'), { scheduleId: ID }, 'http')).status).toBe(401);
    expect((await handleCancelScheduledMessage(h.deps, request(h.token, {}), { scheduleId: ID }, 'http')).status).toBe(400);
    const readOnly = harness({ capabilities: ['messages:read'] });
    expect((await handleCancelScheduledMessage(readOnly.deps, request(readOnly.token), { scheduleId: ID }, 'http')).status).toBe(403);
    expect([...h.calls, ...readOnly.calls]).toEqual([]);
  });
});

describe('조회 응답 모양', () => {
  it('목록 {schedules, next_cursor} · 단건 + subject — 어디에도 취소 메모가 없다', async () => {
    const h = harness();
    const list = await handleListScheduledMessages(h.deps, request(h.token, undefined, { agent_id: AGENT }));
    expect(list.status).toBe(200);
    expect(Object.keys(list.body).sort()).toEqual(['next_cursor', 'schedules']);
    expect(list.body['next_cursor']).toBeNull();
    const single = await handleGetScheduledMessage(h.deps, request(h.token, undefined), { scheduleId: ID });
    expect(single.body).toMatchObject({ schedule_id: ID, subject: '제목', cancel_reason_code: 'other', cancelled_via: 'mcp' });
    const cancelled = await handleCancelScheduledMessage(h.deps, request(h.token), { scheduleId: ID }, 'mcp');
    for (const response of [list, single, cancelled]) expect(JSON.stringify(response.body)).not.toContain('OWNER-ONLY-NOTE');
    // 단건은 "자기 에이전트의 예약" 으로만 찾는다 — 남의 id 는 저장소가 null(404).
    expect(h.calls).toContain(`find:${ID}:${AGENT}`);
  });

  it('단건: 본문 객체가 없거나 깨졌으면 subject null + 경고 한 줄 · 저장소 장애는 던진다 (코드 리뷰 L5)', async () => {
    for (const failure of [new ObjectNotFoundError(`outbound/scheduled/${ID}.json`), new ScheduledContentCorruptError(`outbound/scheduled/${ID}.json`, '필드 타입')]) {
      const h = harness({ load: () => Promise.reject(failure) });
      const lines: string[] = [];
      setLogSink((line) => lines.push(line));
      const single = await handleGetScheduledMessage(h.deps, request(h.token, undefined), { scheduleId: ID });
      resetLogSink();
      expect(single.status, failure.name).toBe(200);
      expect(single.body, failure.name).toMatchObject({ schedule_id: ID, subject: null, status: 'cancelled' });
      const warned = lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line['event'] === 'scheduled.content_unreadable');
      expect(warned, failure.name).toHaveLength(1);
      expect(warned[0], failure.name).toMatchObject({ level: 'warn', agent_id: AGENT, detail: ID, error_kind: failure.name });
    }
    const outage = harness({ load: () => Promise.reject(new Error('S3 503')) });
    await expect(handleGetScheduledMessage(outage.deps, request(outage.token, undefined), { scheduleId: ID })).rejects.toThrow('S3 503');
  });

  it('목록: 쿼리 오류는 인증보다 먼저 400 · 남의 에이전트는 403 · limit + 1 을 읽는다 · agent_id 생략 = 토큰의 에이전트', async () => {
    const h = harness();
    for (const query of [{ agent_id: 'X' }, { agent_id: '' }, { agent_id: AGENT, status: 'queued' }, { agent_id: AGENT, limit: '51' }, { agent_id: AGENT, cursor: '***' }]) {
      expect((await handleListScheduledMessages(h.deps, request('nope', undefined, query))).status, JSON.stringify(query)).toBe(400);
    }
    expect((await handleListScheduledMessages(h.deps, request(h.token, undefined, { agent_id: OTHER }))).status).toBe(403);
    expect(h.calls).toEqual([]);
    await handleListScheduledMessages(h.deps, request(h.token, undefined, { agent_id: AGENT, limit: '7' }));
    expect(h.calls).toEqual([`list:${AGENT}:8`]);
    // 생략하면 토큰의 에이전트 — 인증이 먼저다(누구인지 모르면 기본값도 없다).
    expect((await handleListScheduledMessages(h.deps, request('nope', undefined, {}))).status).toBe(401);
    expect((await handleListScheduledMessages(h.deps, request(h.token, undefined, { limit: '3' }))).status).toBe(200);
    expect(h.calls).toEqual([`list:${AGENT}:8`, `list:${AGENT}:4`]);
  });
});

describe('커서', () => {
  it('왕복하고, 모양이 틀리면 null', () => {
    const cursor = { sendAt: new Date('2026-09-27T03:04:05.678Z'), id: ID };
    expect(decodeScheduledCursor(encodeScheduledCursor(cursor))).toEqual(cursor);
    const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64url');
    for (const bad of ['', '!!', b64(`2026-09-27T03:04:05.678Z|${ID}|x`), b64('2026-09-27T03:04:05.678Z|nope'), b64(`2026-09-27|${ID}`), b64(ID)]) {
      expect(decodeScheduledCursor(bad), bad).toBeNull();
    }
  });
});
