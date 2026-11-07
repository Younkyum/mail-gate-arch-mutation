/**
 * AI 의심 메일 감시(ADR-0017 초안 · 설계 §8.2 통합) — 실제 Postgres 17 · 운영과 같은 소비자·저장소 · 결과 λ 롤(`atmark_ai_watch`)로 붙은 DEFINER 함수.
 *
 *   - 승격 → 작업 하나 · 커밋 뒤 요청 큐 한 건(계약 파서 통과) · 보류(작업 마감) · 웹훅 `next_attempt_at` 지연
 *   - 보류 행은 목록·상세·스레드·첨부에 없고 **인증 코드 원천에는 있다**(Q3)
 *   - 판정 → 즉시 보인다 · provenance `ai_watch` · 웹훅 앞당김 · 재생/모르는 job 은 `ignored`
 *   - 마감이 지난 작업에 이어지면 보류가 이미 풀려 있다(fail-skip 은 시간이 연다) · 늦은 결과 `late` · 10분 넘으면 `ignored` + `expired`
 *   - 30초 CHECK · NULL 로만 · 작업 상태 한 번만 · `atmark_ai_watch` 표 권한 0 · 토글 가드(P0A07)
 *   - 하트비트 침묵 → 보류 없음(작업은 보낸다) · 전송 실패 → skip · shadow · 신뢰 발신자 · 끈 조직(키 없음) · 같은 조직 두 에이전트 = 작업 하나
 */

import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPool } from '../../../src/db/client';
import { createPostgresAiWatchResultStore } from '../../../src/db/repositories/ai-watch-result-store';
import { createPostgresInboundReadStore } from '../../../src/db/repositories/inbound-read-store';
import { createPostgresReplyTargetLookup } from '../../../src/db/repositories/reply-target-store';
import { createPostgresAiWatchInboundPort } from '../../../src/db/repositories/inbound-store';
import { parseAiWatchRequest } from '../../../src/inbound/ai-watch/contract';
import type { InboundAiWatchDependencies, InboundConsumerDependencies } from '../../../src/workers/inbound-consumer';
import { closeTestPool, DATABASE_AVAILABLE, provisioningPool, seedFixture, testPool, type Fixture } from '../db/support/harness';
import { consumerDeps, deliver, eml, newObjectStore, newSesMessageId } from './support';

const appUrl = process.env['TEST_DATABASE_URL'] ?? '';
const OWNER_AVAILABLE = DATABASE_AVAILABLE && (process.env['TEST_MIGRATION_DATABASE_URL'] ?? '').trim() !== '';

/** 결과 λ 의 롤로 붙는 풀 — 앱 URL 의 사용자만 바꾼다(로컬·CI 비밀번호 'atmark'). */
function aiWatchRolePool(): Pool {
  const parsed = new URL(appUrl);
  parsed.username = 'atmark_ai_watch';
  parsed.password = 'atmark';
  return createPool(parsed.toString(), { max: 1 });
}

const BODY = 'Hello, please confirm the meeting schedule for next Tuesday. Thanks a lot for your help.';
const MODEL = 'laya-ml-aw-2026.10.1-int8';

interface Queue {
  readonly bodies: string[];
  fail: boolean;
  send(body: string): Promise<void>;
}

function fakeQueue(): Queue {
  const queue: Queue = {
    bodies: [],
    fail: false,
    send(body) {
      if (queue.fail) return Promise.reject(new Error('sqs down'));
      queue.bodies.push(body);
      return Promise.resolve();
    },
  };
  return queue;
}

describe.skipIf(!OWNER_AVAILABLE)('AI 의심 메일 감시 — 승격 · 보류 · 결과 (Postgres)', () => {
  const objects = newObjectStore();
  let rolePool: Pool;

  const owner = (): Pool => provisioningPool();

  async function enableOrg(fixture: Fixture): Promise<void> {
    await owner().query(`INSERT INTO org_features (organization_id, feature, enabled_by) VALUES ($1, 'ai_mail_watch', 'test')`, [fixture.organizationId]);
    await owner().query('UPDATE organizations SET ai_mail_watch_enabled = true WHERE id = $1', [fixture.organizationId]);
  }

  async function heartbeat(at: 'now' | 'stale', options: { draining?: boolean; selfTestOk?: boolean } = {}): Promise<void> {
    await owner().query(
      `UPDATE ai_watch_runtime SET last_heartbeat_at = CASE WHEN $1 THEN now() ELSE now() - interval '6 minutes' END,
              draining = $2, self_test_ok = $3, model_version = $4, worker_id = 'test' WHERE id`,
      [at === 'now', options.draining ?? false, options.selfTestOk ?? true, MODEL],
    );
  }

  function deps(queue: Queue, mode: InboundAiWatchDependencies['mode'] = 'on'): InboundConsumerDependencies {
    return { ...consumerDeps(testPool(), objects), aiWatch: { mode, store: createPostgresAiWatchInboundPort(testPool()), queue } };
  }

  async function receive(
    d: InboundConsumerDependencies,
    fixture: Fixture,
    options: { sesMessageId?: string; recipients?: readonly string[]; text?: string; from?: string } = {},
  ): Promise<string> {
    const sesMessageId = options.sesMessageId ?? newSesMessageId();
    const outcome = await deliver(d, eml({ from: options.from ?? 'stranger@example.com', subject: '회의', text: options.text ?? BODY }), {
      sesMessageId,
      recipients: options.recipients ?? [fixture.address],
    });
    expect(outcome).toBe('stored');
    return sesMessageId;
  }

  async function rowOf(agentId: string, sesMessageId: string): Promise<{
    id: string;
    ai_watch_job_id: string | null;
    hold: boolean;
    ai_hold_until: Date | null;
    created_at: Date;
  }> {
    const result = await owner().query<{ id: string; ai_watch_job_id: string | null; hold: boolean; ai_hold_until: Date | null; created_at: Date }>(
      `SELECT id, ai_watch_job_id, (ai_hold_until IS NOT NULL AND ai_hold_until > now()) AS hold, ai_hold_until, created_at
         FROM inbound_messages WHERE agent_id = $1 AND ses_message_id = $2`,
      [agentId, sesMessageId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('행 없음');
    return row;
  }

  async function jobOf(jobId: string): Promise<{ state: string; verdict: string | null; band: string | null; late: boolean; shadow: boolean; skip_reason: string | null }> {
    const result = await owner().query<{ state: string; verdict: string | null; band: string | null; late: boolean; shadow: boolean; skip_reason: string | null }>(
      'SELECT state, verdict, band, late, shadow, skip_reason FROM ai_watch_jobs WHERE job_id = $1',
      [jobId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('작업 없음');
    return row;
  }

  async function webhookEndpoint(fixture: Fixture): Promise<void> {
    await owner().query(`INSERT INTO webhook_endpoints (agent_id, url, secret_kid) VALUES ($1, $2, 'k1')`, [
      fixture.agentId,
      `https://hook-${randomUUID()}.example.com/`,
    ]);
  }

  async function webhookDelay(inboundMessageId: string): Promise<number> {
    const result = await owner().query<{ delay: number }>(
      `SELECT extract(epoch FROM d.next_attempt_at - now())::float8 AS delay FROM webhook_deliveries d WHERE d.dedupe_key = $1`,
      [`message.received:${inboundMessageId}`],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('웹훅 행 없음');
    return row.delay;
  }

  beforeAll(() => {
    rolePool = aiWatchRolePool();
  });

  afterAll(async () => {
    await rolePool.end();
    await closeTestPool();
  });

  it('승격: 작업 하나 · 커밋 뒤 요청 한 건 · 보류 · 웹훅 지연 → 보류 중엔 목록·상세·스레드에 없고 인증 코드 원천엔 있다 → 판정이 풀고 앞당긴다', async () => {
    await heartbeat('now');
    const fixture = await seedFixture(testPool());
    await enableOrg(fixture);
    await webhookEndpoint(fixture);
    const queue = fakeQueue();
    const sesMessageId = await receive(deps(queue), fixture);

    const row = await rowOf(fixture.agentId, sesMessageId);
    expect(row.ai_watch_job_id).not.toBeNull();
    expect(row.hold).toBe(true);
    expect(row.ai_hold_until!.getTime() - row.created_at.getTime()).toBeLessThanOrEqual(30_000);
    expect(queue.bodies).toHaveLength(1);
    const request = parseAiWatchRequest(queue.bodies[0] ?? '');
    expect(request.ok).toBe(true);
    if (!request.ok) return;
    expect(request.value.job_id).toBe(row.ai_watch_job_id);
    expect(request.value.text).toBe(`Subject: 회의\n\n${BODY}`);
    // 나가는 것은 발췌문과 작업 id 뿐 — 주소·SES id·에이전트 id 가 본문 어디에도 없다.
    expect(queue.bodies[0]).not.toContain(fixture.address);
    expect(queue.bodies[0]).not.toContain(sesMessageId);
    expect(queue.bodies[0]).not.toContain(fixture.agentId);
    expect(await webhookDelay(row.id)).toBeGreaterThan(5);

    const read = createPostgresInboundReadStore(testPool());
    expect((await read.listVisible(fixture.agentId, { limit: 10, cursor: null })).map((m) => m.id)).not.toContain(row.id);
    expect(await read.findVisible(row.id)).toBeNull();
    const threadId = (await owner().query<{ thread_id: string }>('SELECT thread_id FROM inbound_messages WHERE id = $1', [row.id])).rows[0]?.thread_id ?? '';
    expect((await read.threadView(threadId))?.entries.map((e) => e.id) ?? []).not.toContain(row.id);
    const window = { since: new Date('2026-01-01T00:00:00Z'), until: new Date('2027-01-01T00:00:00Z'), authenticated: null, limit: 10 };
    // 확정 모드(발신 도메인 지정)만 보류를 보지 않는다(Q3) — 후보 모드(발신자 없음)는 보류를 지킨다(보안 리뷰 M3).
    const verified = await read.listVerificationSources(fixture.agentId, { ...window, sender: { domain: 'example.com', includeSubdomains: false } });
    expect(verified.map((s) => s.id)).toContain(row.id);
    const candidates = await read.listVerificationSources(fixture.agentId, { ...window, sender: null });
    expect(candidates.map((s) => s.id)).not.toContain(row.id);
    // 답장 대상 조회도 보류 중엔 없다(보이지 않는 메일 = 없는 메일 → 404).
    const replyTargets = createPostgresReplyTargetLookup(testPool());
    expect(await replyTargets.find(fixture.agentId, row.id)).toBeNull();

    const store = createPostgresAiWatchResultStore(rolePool);
    const recorded = await store.recordVerdict({ jobId: request.value.job_id, verdict: 'flagged', band: 'high', modelVersion: MODEL });
    expect(recorded.outcome).toBe('recorded');
    expect(recorded.latencyMs).not.toBeNull();
    expect((await rowOf(fixture.agentId, sesMessageId)).ai_hold_until).toBeNull();
    expect(await webhookDelay(row.id)).toBeLessThanOrEqual(0);
    const visible = await read.findVisible(row.id);
    expect(visible?.aiWatch).toEqual({ status: 'flagged', modelVersion: MODEL });
    expect((await read.listVerificationSources(fixture.agentId, { ...window, sender: null })).map((s) => s.id)).toContain(row.id);
    expect((await replyTargets.find(fixture.agentId, row.id))?.inboundMessageId).toBe(row.id);

    // 재생 · 모르는 job — 0행 → ignored(Mac 은 임의의 메일에 경고를 붙일 수 없다).
    expect((await store.recordVerdict({ jobId: request.value.job_id, verdict: 'clear', band: 'low', modelVersion: MODEL })).outcome).toBe('ignored');
    expect((await store.recordVerdict({ jobId: randomUUID(), verdict: 'flagged', band: 'high', modelVersion: MODEL })).outcome).toBe('ignored');
    expect(await jobOf(request.value.job_id)).toMatchObject({ state: 'done', verdict: 'flagged', band: 'high', late: false });
  });

  it('같은 조직의 두 에이전트 = 작업 하나 · 요청 한 건 · 판정이 둘 다 푼다', async () => {
    await heartbeat('now');
    const first = await seedFixture(testPool());
    await enableOrg(first);
    const second = await seedFixture(testPool());
    // 둘째 에이전트를 첫 조직으로 옮긴다(픽스처는 조직을 새로 만든다).
    await owner().query('UPDATE agents SET organization_id = $1 WHERE id = $2', [first.organizationId, second.agentId]);
    const queue = fakeQueue();
    const d = deps(queue);
    const sesMessageId = await receive(d, first, { recipients: [first.address, second.address] });
    const a = await rowOf(first.agentId, sesMessageId);
    const b = await rowOf(second.agentId, sesMessageId);
    expect(a.ai_watch_job_id).not.toBeNull();
    expect(a.ai_watch_job_id).toBe(b.ai_watch_job_id);
    expect(a.hold && b.hold).toBe(true);
    expect(queue.bodies).toHaveLength(1);
    await createPostgresAiWatchResultStore(rolePool).recordVerdict({ jobId: a.ai_watch_job_id ?? '', verdict: 'clear', band: 'low', modelVersion: MODEL });
    expect([(await rowOf(first.agentId, sesMessageId)).ai_hold_until, (await rowOf(second.agentId, sesMessageId)).ai_hold_until]).toEqual([null, null]);
  });

  it('첨부 — 보류 중엔 첨부 조회도 null, 판정 뒤에 보인다', async () => {
    await heartbeat('now');
    const fixture = await seedFixture(testPool());
    await enableOrg(fixture);
    const sesMessageId = newSesMessageId();
    const outcome = await deliver(
      deps(fakeQueue()),
      eml({
        from: 'stranger@example.com',
        subject: '자료',
        text: BODY,
        attachment: { filename: 'a.txt', contentType: 'text/plain', bytes: new TextEncoder().encode('attached text') },
      }),
      { sesMessageId, recipients: [fixture.address] },
    );
    expect(outcome).toBe('stored');
    const row = await rowOf(fixture.agentId, sesMessageId);
    const read = createPostgresInboundReadStore(testPool());
    expect(await read.findVisibleAttachment(row.id, 0)).toBeNull();
    await createPostgresAiWatchResultStore(rolePool).recordVerdict({ jobId: row.ai_watch_job_id ?? '', verdict: 'clear', band: 'low', modelVersion: MODEL });
    expect((await read.findVisibleAttachment(row.id, 0))?.attachment.index).toBe(0);
    expect((await read.findVisible(row.id))?.aiWatch).toEqual({ status: 'clear', modelVersion: MODEL });
  });

  it('since 폴링 — 보류 중이라 건너뛴 메일이 풀리면 since = 마지막으로 본 received_at 으로도 받는다(보안 리뷰 M5)', async () => {
    await heartbeat('now');
    const fixture = await seedFixture(testPool());
    await enableOrg(fixture);
    const read = createPostgresInboundReadStore(testPool());
    // M — 먼저 왔지만 보류. N — 뒤에 왔고 감시 없이 바로 보인다(킬 스위치 off 경로).
    const mSes = newSesMessageId();
    await deliver(deps(fakeQueue()), eml({ from: 'stranger@example.com', subject: '회의', text: BODY }), {
      sesMessageId: mSes,
      recipients: [fixture.address],
      receivedAt: new Date(Date.now() - 3_000).toISOString(),
    });
    const nSes = newSesMessageId();
    await deliver(consumerDeps(testPool(), objects), eml({ from: 'other@example.com', subject: '다른 메일', text: BODY }), {
      sesMessageId: nSes,
      recipients: [fixture.address],
      receivedAt: new Date().toISOString(),
    });
    const m = await rowOf(fixture.agentId, mSes);
    expect(m.hold).toBe(true);
    const first = await read.listVisible(fixture.agentId, { limit: 10, cursor: null });
    expect(first.map((x) => x.id)).not.toContain(m.id);
    const lastSeen = first[0]?.receivedAt;
    expect(lastSeen).toBeDefined();
    await createPostgresAiWatchResultStore(rolePool).recordVerdict({ jobId: m.ai_watch_job_id ?? '', verdict: 'clear', band: 'low', modelVersion: MODEL });
    const second = await read.listVisible(fixture.agentId, { limit: 10, cursor: null, filters: { since: lastSeen as Date } });
    expect(second.map((x) => x.id)).toContain(m.id);
    // 작업 없는 옛 메일은 since 앞이면 여전히 빠진다(겹침은 감시 작업이 있는 행만).
    const older = await read.listVisible(fixture.agentId, { limit: 10, cursor: null, filters: { since: new Date(Date.now() + 60_000) } });
    expect(older.map((x) => x.id)).toEqual([]);
  });

  it('재전달(이미 기록됨)은 요청을 다시 보내지 않는다', async () => {
    await heartbeat('now');
    const fixture = await seedFixture(testPool());
    await enableOrg(fixture);
    const queue = fakeQueue();
    const d = deps(queue);
    const sesMessageId = await receive(d, fixture);
    const again = await deliver(d, null, { sesMessageId, recipients: [fixture.address] });
    expect(again).toBe('duplicate');
    expect(queue.bodies).toHaveLength(1);
  });

  it('마감이 지난 작업에 이어지면 보류는 이미 풀려 있다(시간이 연다) · 늦은 결과는 late · 10분 넘은 결과는 ignored + expired', async () => {
    await heartbeat('now');
    const fixture = await seedFixture(testPool());
    await enableOrg(fixture);
    const sesMessageId = newSesMessageId();
    // 소유자가 마감이 지난 작업을 먼저 둔다(다른 에이전트 몫으로 이미 만들어진 작업 · 재전달을 흉내).
    const job = (
      await owner().query<{ job_id: string }>(
        `INSERT INTO ai_watch_jobs (organization_id, ses_message_id, enqueued_at, deadline)
         VALUES ($1, $2, now() - interval '40 seconds', now() - interval '10 seconds') RETURNING job_id`,
        [fixture.organizationId, sesMessageId],
      )
    ).rows[0]?.job_id ?? '';
    const queue = fakeQueue();
    await receive(deps(queue), fixture, { sesMessageId });
    const row = await rowOf(fixture.agentId, sesMessageId);
    expect(row.ai_watch_job_id).toBe(job);
    expect(row.hold).toBe(false);
    expect(queue.bodies).toHaveLength(0); // 이 호출이 만든 작업이 아니다
    const read = createPostgresInboundReadStore(testPool());
    expect((await read.findVisible(row.id))?.aiWatch).toEqual({ status: 'unavailable', modelVersion: null });

    const store = createPostgresAiWatchResultStore(rolePool);
    expect((await store.recordVerdict({ jobId: job, verdict: 'clear', band: 'low', modelVersion: MODEL })).outcome).toBe('late');
    expect(await jobOf(job)).toMatchObject({ state: 'done', late: true });

    const old = (
      await owner().query<{ job_id: string }>(
        `INSERT INTO ai_watch_jobs (organization_id, ses_message_id, enqueued_at, deadline)
         VALUES ($1, $2, now() - interval '11 minutes', now() - interval '10 minutes 30 seconds') RETURNING job_id`,
        [fixture.organizationId, newSesMessageId()],
      )
    ).rows[0]?.job_id ?? '';
    expect((await store.recordVerdict({ jobId: old, verdict: 'flagged', band: 'high', modelVersion: MODEL })).outcome).toBe('ignored');
    expect((await jobOf(old)).state).toBe('expired');
  });

  it('보존 — 90일 넘은 작업은 결과 λ 롤의 purge 가 지우고, 이어진 메일 행의 연결은 NULL 이 된다(메일은 남는다)', async () => {
    await heartbeat('now');
    const fixture = await seedFixture(testPool());
    await enableOrg(fixture);
    const sesMessageId = newSesMessageId();
    const job = (
      await owner().query<{ job_id: string }>(
        `INSERT INTO ai_watch_jobs (organization_id, ses_message_id, enqueued_at, deadline)
         VALUES ($1, $2, now() - interval '91 days', now() - interval '91 days' + interval '30 seconds') RETURNING job_id`,
        [fixture.organizationId, sesMessageId],
      )
    ).rows[0]?.job_id ?? '';
    await receive(deps(fakeQueue()), fixture, { sesMessageId });
    expect((await rowOf(fixture.agentId, sesMessageId)).ai_watch_job_id).toBe(job);
    expect(await createPostgresAiWatchResultStore(rolePool).purgeExpired()).toBeGreaterThanOrEqual(1);
    expect((await owner().query('SELECT 1 FROM ai_watch_jobs WHERE job_id = $1', [job])).rowCount).toBe(0);
    expect((await rowOf(fixture.agentId, sesMessageId)).ai_watch_job_id).toBeNull();
    // 앱 롤은 보존 함수를 부를 수 없다(결과 λ 롤만).
    await expect(testPool().query('SELECT purge_ai_watch_jobs()')).rejects.toMatchObject({ code: '42501' });
  });

  it('DB 가 30초 상한 · NULL 로만 · 작업 상태 한 번만을 집행한다', async () => {
    await heartbeat('now');
    const fixture = await seedFixture(testPool());
    await enableOrg(fixture);
    const sesMessageId = await receive(deps(fakeQueue()), fixture);
    const row = await rowOf(fixture.agentId, sesMessageId);

    // 보류를 늘릴 수 없다(release-only 트리거).
    await expect(owner().query(`UPDATE inbound_messages SET ai_hold_until = now() + interval '20 seconds' WHERE id = $1`, [row.id])).rejects.toMatchObject({
      code: '23514',
    });
    // 30초 넘는 보류로는 행을 만들 수 없다(CHECK) — 기존 행을 본떠 새 행 INSERT.
    const copy = newSesMessageId();
    await expect(
      owner().query(
        `INSERT INTO inbound_messages
         SELECT (jsonb_populate_record(NULL::inbound_messages, to_jsonb(m) || jsonb_build_object(
                   'id', gen_random_uuid(), 'ses_message_id', $2::text, 'raw_storage_key', 'inbound/raw/' || $2::text,
                   'created_at', now(), 'ai_hold_until', now() + interval '31 seconds'))).*
           FROM inbound_messages m WHERE m.id = $1`,
        [row.id, copy],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'inbound_messages_ai_hold_max_30s' });
    // 작업은 pending 에서 한 번만 나간다.
    const store = createPostgresAiWatchResultStore(rolePool);
    await store.recordVerdict({ jobId: row.ai_watch_job_id ?? '', verdict: 'error', band: null, modelVersion: MODEL });
    await expect(owner().query(`UPDATE ai_watch_jobs SET state = 'expired' WHERE job_id = $1`, [row.ai_watch_job_id])).rejects.toMatchObject({ code: '23514' });
    // 판정·밴드 모양은 닫혀 있다.
    await expect(
      owner().query(
        `INSERT INTO ai_watch_jobs (organization_id, ses_message_id, state, verdict, band, model_version, decided_at)
         VALUES ($1, $2, 'done', 'flagged', 'low', 'm', now())`,
        [fixture.organizationId, newSesMessageId()],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('atmark_ai_watch 롤은 표를 읽지도 쓰지도 못한다 — 정의 함수 둘만', async () => {
    await expect(rolePool.query('SELECT 1 FROM ai_watch_jobs LIMIT 1')).rejects.toMatchObject({ code: '42501' });
    await expect(rolePool.query('SELECT 1 FROM inbound_messages LIMIT 1')).rejects.toMatchObject({ code: '42501' });
    await expect(rolePool.query(`UPDATE ai_watch_runtime SET draining = true`)).rejects.toMatchObject({ code: '42501' });
    await expect(rolePool.query(`SELECT ai_watch_skip_job($1)`, [randomUUID()])).rejects.toMatchObject({ code: '42501' });
    await expect(rolePool.query('SELECT ai_watch_worker_healthy()')).rejects.toMatchObject({ code: '42501' });
    // 앱 롤은 결과 함수를 부를 수 없다(Mac → 결과 λ 롤만).
    await expect(testPool().query(`SELECT * FROM ai_watch_record_verdict($1, 'flagged', 'high', 'm')`, [randomUUID()])).rejects.toMatchObject({
      code: '42501',
    });
    await expect(testPool().query(`UPDATE ai_watch_jobs SET state = 'skipped' WHERE false`)).rejects.toMatchObject({ code: '42501' });
  });

  it('토글 가드 — 허용 목록 없이는 켤 수 없다(P0A07), 끄기는 된다', async () => {
    const fixture = await seedFixture(testPool());
    await expect(owner().query('UPDATE organizations SET ai_mail_watch_enabled = true WHERE id = $1', [fixture.organizationId])).rejects.toMatchObject({
      code: 'P0A07',
    });
    await enableOrg(fixture);
    await owner().query(`DELETE FROM org_features WHERE organization_id = $1 AND feature = 'ai_mail_watch'`, [fixture.organizationId]);
    await owner().query('UPDATE organizations SET ai_mail_watch_enabled = false WHERE id = $1', [fixture.organizationId]);
  });

  it('하트비트가 5분 넘게 조용하거나 draining 이면 보류 없이 기록한다(작업은 보낸다)', async () => {
    for (const state of [{ at: 'stale' as const }, { at: 'now' as const, draining: true }, { at: 'now' as const, selfTestOk: false }]) {
      await heartbeat(state.at, state);
      const fixture = await seedFixture(testPool());
      await enableOrg(fixture);
      const queue = fakeQueue();
      const sesMessageId = await receive(deps(queue), fixture);
      const row = await rowOf(fixture.agentId, sesMessageId);
      expect(row.ai_watch_job_id).not.toBeNull();
      expect(row.ai_hold_until).toBeNull();
      expect(queue.bodies).toHaveLength(1);
    }
    await heartbeat('now');
  });

  it('요청 큐 전송 실패 → 작업 skipped · 보류 즉시 해제 · 웹훅 앞당김(메일 기록은 그대로)', async () => {
    await heartbeat('now');
    const fixture = await seedFixture(testPool());
    await enableOrg(fixture);
    await webhookEndpoint(fixture);
    const queue = fakeQueue();
    queue.fail = true;
    const sesMessageId = await receive(deps(queue), fixture);
    const row = await rowOf(fixture.agentId, sesMessageId);
    expect(row.ai_hold_until).toBeNull();
    expect(await jobOf(row.ai_watch_job_id ?? '')).toMatchObject({ state: 'skipped', skip_reason: 'enqueue_failed' });
    expect(await webhookDelay(row.id)).toBeLessThanOrEqual(0);
    expect((await createPostgresInboundReadStore(testPool()).findVisible(row.id))?.aiWatch?.status).toBe('unavailable');
  });

  it('shadow — 작업은 보내되 보류 0 · 에이전트 provenance 키 없음', async () => {
    await heartbeat('now');
    const fixture = await seedFixture(testPool());
    await enableOrg(fixture);
    const queue = fakeQueue();
    const sesMessageId = await receive(deps(queue, 'shadow'), fixture);
    const row = await rowOf(fixture.agentId, sesMessageId);
    expect(row.ai_hold_until).toBeNull();
    expect(queue.bodies).toHaveLength(1);
    expect((await jobOf(row.ai_watch_job_id ?? '')).shadow).toBe(true);
    await createPostgresAiWatchResultStore(rolePool).recordVerdict({ jobId: row.ai_watch_job_id ?? '', verdict: 'flagged', band: 'high', modelVersion: MODEL });
    expect((await createPostgresInboundReadStore(testPool()).findVisible(row.id))?.aiWatch).toBeNull();
  });

  it('승격 밖(빈 본문) → 작업 없음 · 키 없음 / 끈 조직 → provenance 키 없음(null) · 허용 목록만 있고 토글 꺼짐 → 작업 없음', async () => {
    await heartbeat('now');
    const read = createPostgresInboundReadStore(testPool());
    const enabled = await seedFixture(testPool());
    await enableOrg(enabled);
    const queue = fakeQueue();
    const short = await receive(deps(queue), enabled, { text: 'ok' });
    const shortRow = await rowOf(enabled.agentId, short);
    expect(shortRow.ai_watch_job_id).toBeNull();
    expect((await read.findVisible(shortRow.id))?.aiWatch).toBeNull();

    const off = await seedFixture(testPool());
    const offSes = await receive(deps(queue), off);
    const offRow = await rowOf(off.agentId, offSes);
    expect(offRow.ai_watch_job_id).toBeNull();
    expect((await read.findVisible(offRow.id))?.aiWatch).toBeNull();

    const allowedOnly = await seedFixture(testPool());
    await owner().query(`INSERT INTO org_features (organization_id, feature, enabled_by) VALUES ($1, 'ai_mail_watch', 'test')`, [allowedOnly.organizationId]);
    const allowedSes = await receive(deps(queue), allowedOnly);
    expect((await rowOf(allowedOnly.agentId, allowedSes)).ai_watch_job_id).toBeNull();
    expect(queue.bodies).toHaveLength(0);
  });

  it('킬 스위치 off(의존성 없음) — 켠 조직이어도 작업 0 · 보류 0', async () => {
    await heartbeat('now');
    const fixture = await seedFixture(testPool());
    await enableOrg(fixture);
    const sesMessageId = await receive(consumerDeps(testPool(), objects), fixture);
    const row = await rowOf(fixture.agentId, sesMessageId);
    expect(row.ai_watch_job_id).toBeNull();
    expect(row.ai_hold_until).toBeNull();
  });
});
