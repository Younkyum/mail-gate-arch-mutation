/**
 * **US-004 — 발신 로그 상세가 "무엇을 보냈는가" 를 보인다.** 실제 Postgres · 실제 관문 · 실제 발송 라우트(REST `POST /v1/messages`
 * · MCP `send_email`) → 실제 관리 라우터(`atmark_admin` 롤 풀). 전송단은 세는 가짜(실메일 0), 본문 저장소는 로컬 객체 저장소
 * (운영 S3 와 같은 포트 · 같은 키 `outbound/content/{id}.json`). AWS 호출 0. 되돌리기로 빨개지는 것을 확인한 단언에 ★.
 *
 *   - ★ 발송 시점에 `messages.snippet`(≤512, 한 줄)·`body_storage_key`(= `outbound/content/{id}.json`)가 채워진다 — REST·MCP 둘 다.
 *   - ★ 상세: 보낸 주소·제목·수신자 전부·스레드·스니펫·본문(평문, 줄바꿈 유지)·html 유무·SES 이벤트(시각 오름차순).
 *   - ★ 다른 조직의 발신 id → 404 이고 **본문 저장소를 읽지도 않는다**.
 *   - ★ 크기 상한(64 KiB, 코드포인트 경계) · `truncated`.
 *   - ★ 정화: 양방향·제로폭·제어 문자 제거, 줄바꿈·탭 유지(본문) / 한 줄(스니펫).
 *   - 본문 상태: 자리 없음(`not_stored`, 저장소 호출 0) · 객체 없음(`missing`) · 읽기 실패(`unavailable`).
 *   - ★ DB CHECK: 발신 행의 `body_storage_key` 는 자기 id 의 키만(다른 발송의 본문을 가리킬 수 없다).
 *   - 수신 상세에 본문이 없다는 단언은 `admin-logs.test.ts`(본문·스니펫 키 부재)가 그대로 본다.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AdminDependencies } from '../../../src/admin/context';
import { OUTBOUND_BODY_MAX_BYTES } from '../../../src/admin/routes/logs';
import {
  contentKeyFor,
  createObjectContentReader,
  createObjectContentStore,
  type MessageContentReader,
} from '../../../src/api/content-store';
import { snippetOf, type OutboundServiceDependencies } from '../../../src/api/outbound-service';
import { createPostgresOutboundMessageStore } from '../../../src/api/outbound-store';
import { createPostgresAgentTokenStore, createPostgresGateStores } from '../../../src/db/repositories';
import { createPostgresInboundPolicySource } from '../../../src/db/repositories/inbound-policy-store';
import { issueAgentToken } from '../../../src/identity/agent-token';
import { routeHttpApiEvent, type ApiDependencies } from '../../../src/runtime/router';
import { createLocalObjectStore } from '../../../src/storage/local-object-store';
import type { ObjectStore } from '../../../src/storage/object-store';
import { closeTestPool, DATABASE_AVAILABLE, provisioningPool, seedFixture, testPool, type Fixture } from '../db/support/harness';
import { countingTransport } from '../outbound/support/fakes';
import { adminDeps, adminRolePool, authed, AVAILABLE, call, login, loginMailerPool, newOrganization, ownerPool, suffix, type Session } from './support';
import { inertDlp, inertRiskSignals } from '../../support/injection-doubles';
import { recordingExposures } from '../../support/injection-doubles';

const PARTNER = 'partner@example.com';
const OTHER = 'second@example.com';
/** 보이면 안 되는 문자 — C0/C1 제어(개행·탭 제외) · 양방향 조작 · 폭 없는 문자. */
const INVISIBLE_EXCEPT_NEWLINE_TAB = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/u;

function untouchable(label: string): never {
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (property === 'then') return undefined;
        throw new Error(`${label}.${String(property)} 를 건드렸다`);
      },
    },
  ) as never;
}

/** 읽기 횟수를 세는 리더 — "다른 조직 id 는 저장소를 읽지도 않는다" 를 본다. */
function countingReader(inner: MessageContentReader): MessageContentReader & { readonly loads: () => number } {
  let loads = 0;
  return {
    loads: () => loads,
    load(messageId: string) {
      loads += 1;
      return inner.load(messageId);
    },
  };
}

interface World {
  readonly fixture: Fixture;
  readonly token: string;
  readonly api: ApiDependencies;
  readonly objects: ObjectStore;
  readonly session: Session;
  readonly deps: AdminDependencies;
  readonly reader: ReturnType<typeof countingReader>;
}

describe.skipIf(!AVAILABLE || !DATABASE_AVAILABLE)('US-004 발신 로그 상세 — 보낸 본문 · 배달 이벤트', () => {
  let owner: Pool;
  let admin: Pool;
  let mailer: Pool;

  beforeAll(() => {
    owner = ownerPool();
    admin = adminRolePool();
    mailer = loginMailerPool();
  });
  afterAll(async () => {
    await owner.end();
    await admin.end();
    await mailer.end();
    await closeTestPool();
  });

  async function world(): Promise<World> {
    const app = testPool();
    const fixture = await seedFixture(provisioningPool(), { allowlist: [PARTNER, OTHER] });
    // 픽스처 조직에 소유자 주소를 준다 — 콘솔 로그인(매직링크)의 수신자.
    const ownerEmail = `owner-${suffix()}@example.com`;
    await owner.query('UPDATE organizations SET owner_email = $2 WHERE id = $1', [fixture.organizationId, ownerEmail]);

    const objects = createLocalObjectStore({ directory: mkdtempSync(join(tmpdir(), 'atmark-us004-')), env: {} });
    const stores = createPostgresGateStores(app);
    const tokens = createPostgresAgentTokenStore(app);
    const service: OutboundServiceDependencies = {
      source: stores.source,
      audit: stores.audit,
      dispatchStore: stores.leases,
      serializer: stores.serializer,
      sendEvidence: stores.sendEvidence,
      messages: createPostgresOutboundMessageStore(app),
      content: createObjectContentStore(objects),
      leaseTtlSeconds: 300,
      riskSignals: inertRiskSignals(),
      dlp: inertDlp(),
      now: () => new Date(),
    };
    const api: ApiDependencies = {
      send: { tokens, service, transport: countingTransport() },
      reply: untouchable('reply'),
      forward: untouchable('forward'),
      transitionAnnouncement: untouchable('transitionAnnouncement'),
      audit: untouchable('audit'),
      approvalLink: untouchable('approvalLink'),
      approvals: untouchable('approvals'),
      // MCP 는 발신 주소를 정책 조회로 채운다(`from` 생략).
      agentPolicy: { tokens, policies: service.source, inboundPolicies: createPostgresInboundPolicySource(app), now: () => new Date() },
      webhookEndpoints: untouchable('webhookEndpoints'),
      // MCP 인증은 수신 조회 의존성의 토큰 저장소·시계를 쓴다(`mcpDependenciesOf`).
      inboundRead: { tokens, inbound: untouchable('inbound'), artifacts: untouchable('artifacts'), now: () => new Date(), exposures: recordingExposures(), riskHoldMode: 'enforce', messageState: untouchable('messageState') },
      attachments: untouchable('attachments'),
      scheduledMessages: untouchable('scheduledMessages'),
      scheduledQueries: untouchable('scheduledQueries'),
      verificationCode: untouchable('verificationCode'),
      webhookDeliveries: untouchable('webhookDeliveries'),
      outboundAttachments: untouchable('outboundAttachments'),
    drafts: untouchable('drafts'),
    draftSend: untouchable('draftSend'),
    labels: untouchable('labels'),
      agentEnroll: untouchable('agentEnroll'),
      policyRequests: untouchable('policyRequests'),
      identity: untouchable('identity'),
      health: untouchable('health'),
    };
    const issued = issueAgentToken(fixture.agentId);
    await createPostgresAgentTokenStore(provisioningPool()).insert({
      agentId: fixture.agentId,
      tokenHash: issued.tokenHash,
      capabilities: issued.capabilities,
      expiresAt: null,
    });
    // 관리 콘솔은 **읽기 전용 리더**만 받는다(운영: S3 GetObject on outbound/content/* — 같은 포트).
    const reader = countingReader(createObjectContentReader(objects));
    const deps = adminDeps(admin, { outboundContent: reader });
    const session = await login(deps, mailer, { id: fixture.organizationId, ownerEmail });
    return { fixture, token: issued.plaintext, api, objects, session, deps, reader };
  }

  let rpc = 0;
  async function restSend(w: World, body: { subject: string; text: string; html?: string; to?: string[] }): Promise<string> {
    const result = await routeHttpApiEvent(w.api, {
      rawPath: '/v1/messages',
      headers: { authorization: `Bearer ${w.token}`, 'content-type': 'application/json', 'idempotency-key': `us004-${suffix()}` },
      body: JSON.stringify({ agent_id: w.fixture.agentId, from: w.fixture.address, to: body.to ?? [PARTNER], ...body }),
      isBase64Encoded: false,
      requestContext: { requestId: `us004-${String((rpc += 1))}`, stage: '$default', http: { method: 'POST' } },
    });
    expect([200, 201, 202], result.body).toContain(result.statusCode);
    const parsed = JSON.parse(result.body) as { message_id?: string; messageId?: string };
    const id = parsed.message_id ?? parsed.messageId;
    if (id === undefined) throw new Error(`message_id 가 없다: ${result.body}`);
    return id;
  }

  async function mcpSend(w: World, args: Record<string, unknown>): Promise<string> {
    const result = await routeHttpApiEvent(w.api, {
      rawPath: '/mcp',
      headers: { authorization: `Bearer ${w.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: (rpc += 1), method: 'tools/call', params: { name: 'send_email', arguments: args } }),
      isBase64Encoded: false,
      requestContext: { requestId: `us004-mcp-${String(rpc)}`, stage: '$default', http: { method: 'POST' } },
    });
    const body = JSON.parse(result.body) as { result?: { isError: boolean; content: { text: string }[] } };
    expect(body.result?.isError, result.body).toBe(false);
    const rows = await owner.query<{ id: string }>(
      `SELECT id FROM messages WHERE agent_id = $1 AND direction = 'outbound' ORDER BY created_at DESC, id DESC LIMIT 1`,
      [w.fixture.agentId],
    );
    const id = rows.rows[0]?.id;
    if (id === undefined) throw new Error('MCP 발송 행이 없다');
    return id;
  }

  async function row(id: string): Promise<{ snippet: string | null; body_storage_key: string | null; status: string }> {
    const result = await owner.query<{ snippet: string | null; body_storage_key: string | null; status: string }>(
      'SELECT snippet, body_storage_key, status::text AS status FROM messages WHERE id = $1',
      [id],
    );
    const found = result.rows[0];
    if (found === undefined) throw new Error('행이 없다');
    return found;
  }

  async function detail(w: World, id: string, session: Session = w.session): Promise<{ status: number; json: Record<string, unknown>; raw: string }> {
    const result = await call(w.deps, 'GET', `/api/logs/outbound/${id}`, authed(session));
    return { status: result.statusCode, json: result.statusCode === 200 ? (result.json() as Record<string, unknown>) : {}, raw: result.body };
  }

  it('★ REST 발송 → snippet·body_storage_key 가 INSERT 와 함께 · 상세가 보낸 주소·제목·수신자·스레드·본문·html 유무·SES 이벤트를 준다', async () => {
    const w = await world();
    const text = '안녕하세요,\n내일 3시 회의 확인 부탁드립니다.\n\n— 에이전트';
    const id = await restSend(w, { subject: '회의 일정', text, html: '<p>안녕하세요</p>', to: [PARTNER, OTHER] });

    const stored = await row(id);
    expect(stored.status).toBe('sent');
    expect(stored.snippet).toBe(snippetOf(text));
    expect(stored.snippet).toBe('안녕하세요, 내일 3시 회의 확인 부탁드립니다. — 에이전트');
    expect(stored.body_storage_key).toBe(contentKeyFor(id));
    // 본문 전체는 S3(여기서는 같은 포트의 로컬 저장소)에 — 행에는 키만.
    expect((await w.objects.get(contentKeyFor(id), 1_000_000)).length).toBeGreaterThan(0);

    const before = await detail(w, id);
    expect(before.status, before.raw).toBe(200);
    expect(before.json).toMatchObject({
      id,
      from: w.fixture.address,
      subject: '회의 일정',
      recipients: [OTHER, PARTNER].sort(),
      recipientCount: 2,
      snippet: snippetOf(text),
      decision: 'sent',
      body: { status: 'available', text, truncated: false, hasHtml: true },
      events: [],
    });
    expect(typeof before.json['threadId']).toBe('string');
    // html 내용은 싣지 않는다 — 있다는 사실만.
    expect(before.raw).not.toContain('<p>');

    // SES 이벤트(소비자가 쓰는 것과 같은 표) — 시각 오름차순, 종류 전부.
    const t0 = Date.now();
    for (const [type, offset] of [['delivery', 2000], ['send', 1000], ['bounce', 3000], ['complaint', 4000]] as const) {
      await owner.query(
        `INSERT INTO ses_events (message_id, event_type, ses_message_id, event_at, dedupe_key)
         VALUES ($1, $2::ses_event_type, $3, $4, encode(sha256(convert_to($5, 'UTF8')), 'hex'))`,
        [id, type, `fake-ses-${id}`, new Date(t0 + offset), `${id}-${type}-${suffix()}`],
      );
    }
    const after = await detail(w, id);
    const events = after.json['events'] as Array<{ type: string; at: string }>;
    expect(events.map((event) => event.type)).toEqual(['send', 'delivery', 'bounce', 'complaint']);
    expect(events[0]?.at).toBe(new Date(t0 + 1000).toISOString().replace(/Z$/, '000Z'));
  });

  it('★ MCP send_email 도 같은 앞단 → snippet·body_storage_key · 상세 본문', async () => {
    const w = await world();
    const text = 'MCP 로 보낸 본문\n두 번째 줄';
    const id = await mcpSend(w, { to: [PARTNER], subject: 'MCP 제목', text });
    const stored = await row(id);
    expect(stored.snippet).toBe('MCP 로 보낸 본문 두 번째 줄');
    expect(stored.body_storage_key).toBe(contentKeyFor(id));
    const got = await detail(w, id);
    expect(got.json).toMatchObject({ subject: 'MCP 제목', body: { status: 'available', text, truncated: false, hasHtml: false } });
  });

  it('★ 다른 조직의 발신 id → 404 · 본문 저장소를 읽지 않는다', async () => {
    const w = await world();
    const id = await restSend(w, { subject: '비밀', text: '다른 조직이 보면 안 되는 본문' });
    const other = await newOrganization(owner);
    const otherSession = await login(w.deps, mailer, other);
    const loadsBefore = w.reader.loads();
    const got = await detail(w, id, otherSession);
    expect(got.status).toBe(404);
    expect(got.raw).toContain('log_not_found');
    expect(got.raw).not.toContain('다른 조직이 보면');
    expect(w.reader.loads()).toBe(loadsBefore);
    // 목록에도 없다(조직 범위) — 스니펫이 새지 않는다.
    const listed = await call(w.deps, 'GET', '/api/logs', authed(otherSession, { query: 'type=outbound' }));
    expect(listed.body).not.toContain('다른 조직이 보면');
  });

  it('★ 크기 상한 — 64 KiB(UTF-8) 를 넘는 본문은 코드포인트 경계에서 잘리고 truncated · 스니펫은 512자', async () => {
    const w = await world();
    const text = '가'.repeat(40_000); // 120,000 바이트
    const id = await restSend(w, { subject: '긴 본문', text });
    expect([...((await row(id)).snippet ?? '')]).toHaveLength(512);
    const got = await detail(w, id);
    const body = got.json['body'] as { status: string; text: string; truncated: boolean };
    expect(body.status).toBe('available');
    expect(body.truncated).toBe(true);
    expect(Buffer.byteLength(body.text, 'utf8')).toBeLessThanOrEqual(OUTBOUND_BODY_MAX_BYTES);
    expect(body.text).toBe('가'.repeat(Math.floor(OUTBOUND_BODY_MAX_BYTES / 3)));
    // 목록의 스니펫은 120자 + 잘림 표시.
    const listed = await call(w.deps, 'GET', '/api/logs', authed(w.session, { query: 'type=outbound' }));
    const item = (listed.json() as { items: Array<{ id: string; snippet: string }> }).items.find((entry) => entry.id === id);
    expect(item?.snippet.startsWith('가'.repeat(120))).toBe(true);
    expect([...(item?.snippet ?? '')].length).toBeLessThan(140);
  });

  it('★ 정화 — 본문은 양방향·제로폭·제어 문자를 지우고 줄바꿈·탭을 살린다 · 스니펫·제목은 한 줄', async () => {
    const w = await world();
    const text = 'line1\r\nmoc.live\u202E@bob\u200B\u0007\tcol\u2028end\u0000';
    const id = await restSend(w, { subject: 'sub\u202Eject', text });
    const got = await detail(w, id);
    const body = got.json['body'] as { text: string };
    expect(body.text).toBe('line1\nmoc.live@bob\tcol\nend');
    expect(body.text).not.toMatch(INVISIBLE_EXCEPT_NEWLINE_TAB);
    expect(String(got.json['snippet'])).not.toMatch(/[\n\t]/);
    expect(String(got.json['snippet'])).not.toMatch(INVISIBLE_EXCEPT_NEWLINE_TAB);
    expect(got.json['subject']).toBe('subject');
  });

  it('본문 상태 — 자리 없음(not_stored, 저장소 호출 0) · 객체 없음(missing) · 읽기 실패(unavailable, 원인은 응답에 없다)', async () => {
    const w = await world();
    const id = await restSend(w, { subject: 's', text: 'body' });

    // 옛 행: 키가 없다(202609241320 이전 · 관문 전 실패). 소유자 롤로만 만들 수 있는 모양.
    const legacy = await restSend(w, { subject: 'legacy', text: 'legacy body' });
    await owner.query('UPDATE messages SET body_storage_key = NULL WHERE id = $1', [legacy]);
    const loads = w.reader.loads();
    const notStored = await detail(w, legacy);
    expect(notStored.json['body']).toEqual({ status: 'not_stored', text: null, truncated: false, hasHtml: null });
    expect(w.reader.loads()).toBe(loads);

    // 키는 있는데 객체가 없다.
    const emptyDeps = adminDeps(admin, { outboundContent: createObjectContentReader(createLocalObjectStore({ directory: mkdtempSync(join(tmpdir(), 'atmark-us004-empty-')), env: {} })) });
    const missing = await call(emptyDeps, 'GET', `/api/logs/outbound/${id}`, authed(w.session));
    expect((missing.json() as { body: unknown }).body).toEqual({ status: 'missing', text: null, truncated: false, hasHtml: null });

    // 읽기 실패(S3 403 등) — 상태만, 오류 문장은 응답에 없다.
    const failing = adminDeps(admin, {
      outboundContent: { load: () => Promise.reject(Object.assign(new Error('AccessDenied sentinel-xyz'), { name: 'AccessDenied' })) },
    });
    const unavailable = await call(failing, 'GET', `/api/logs/outbound/${id}`, authed(w.session));
    expect(unavailable.statusCode).toBe(200);
    expect((unavailable.json() as { body: unknown }).body).toEqual({ status: 'unavailable', text: null, truncated: false, hasHtml: null });
    expect(unavailable.body).not.toContain('sentinel-xyz');
  });

  it('US-008 — 객체가 없고 메시지가 보존 기간(365일)을 넘었으면 missing 이 아니라 expired', async () => {
    const w = await world();
    const id = await restSend(w, { subject: 'old', text: 'old body' });
    const createdAt = (await owner.query<{ at: Date }>('SELECT created_at AS at FROM messages WHERE id = $1', [id])).rows[0]?.at;
    if (createdAt === undefined) throw new Error('created_at 을 못 읽었다');

    // `messages.created_at` 은 불변(DB 트리거) — 행의 나이를 바꾸는 대신 라우트가 보는 시계(`now`)를 옮긴다.
    const dayMs = 24 * 60 * 60 * 1000;
    const emptyObjects = createLocalObjectStore({ directory: mkdtempSync(join(tmpdir(), 'atmark-us008-empty-')), env: {} });
    const emptyReader = createObjectContentReader(emptyObjects);

    // 경계 안 — 364일 뒤에도 여전히 missing(객체가 없는 이유는 보존 만료가 아니다).
    const withinRetention = adminDeps(admin, { outboundContent: emptyReader, now: () => new Date(createdAt.getTime() + 364 * dayMs) });
    const stillMissing = await call(withinRetention, 'GET', `/api/logs/outbound/${id}`, authed(w.session));
    expect((stillMissing.json() as { body: unknown }).body).toEqual({ status: 'missing', text: null, truncated: false, hasHtml: null });

    // 경계 밖 — 366일 뒤는 expired(S3 수명주기가 지웠을 시점, US-008).
    const pastRetention = adminDeps(admin, { outboundContent: emptyReader, now: () => new Date(createdAt.getTime() + 366 * dayMs) });
    const expired = await call(pastRetention, 'GET', `/api/logs/outbound/${id}`, authed(w.session));
    expect(expired.statusCode).toBe(200);
    expect((expired.json() as { body: unknown }).body).toEqual({ status: 'expired', text: null, truncated: false, hasHtml: null });

    // 검증 F8 — 운영 admin 역할엔 ListBucket 이 없어 없는 키가 404 가 아니라 403(AccessDenied)이다. 보존 기간을 넘긴 행은
    //   저장소를 **부르지 않고** expired 여야 한다(부르면 403 → unavailable 로 떨어져 expired 가 운영에서 안 보였다).
    let deniedLoads = 0;
    const accessDenied: MessageContentReader = {
      load: () => {
        deniedLoads += 1;
        return Promise.reject(Object.assign(new Error('AccessDenied'), { name: 'AccessDenied' }));
      },
    };
    const pastRetention403 = adminDeps(admin, { outboundContent: accessDenied, now: () => new Date(createdAt.getTime() + 366 * dayMs) });
    const expired403 = await call(pastRetention403, 'GET', `/api/logs/outbound/${id}`, authed(w.session));
    expect((expired403.json() as { body: unknown }).body).toEqual({ status: 'expired', text: null, truncated: false, hasHtml: null });
    expect(deniedLoads).toBe(0);
    // 보존 기간 안의 403 은 여전히 unavailable 이다(원인 불명 — 저장소를 불렀다).
    const within403 = adminDeps(admin, { outboundContent: accessDenied, now: () => new Date(createdAt.getTime() + 364 * dayMs) });
    const unavailable403 = await call(within403, 'GET', `/api/logs/outbound/${id}`, authed(w.session));
    expect((unavailable403.json() as { body: unknown }).body).toEqual({ status: 'unavailable', text: null, truncated: false, hasHtml: null });
    expect(deniedLoads).toBe(1);

    // 자리가 아예 없는 옛 행(not_stored)은 보존 기간과 무관하게 그대로다.
    const legacyOld = await restSend(w, { subject: 'legacy-old', text: 'legacy old body' });
    await owner.query('UPDATE messages SET body_storage_key = NULL WHERE id = $1', [legacyOld]);
    const legacyResult = await call(pastRetention, 'GET', `/api/logs/outbound/${legacyOld}`, authed(w.session));
    expect((legacyResult.json() as { body: unknown }).body).toEqual({ status: 'not_stored', text: null, truncated: false, hasHtml: null });
  });

  it('★ DB CHECK — 발신 행의 body_storage_key 는 자기 id 의 키뿐(다른 발송의 본문을 가리킬 수 없다)', async () => {
    const w = await world();
    const a = await restSend(w, { subject: 'a', text: 'A' });
    const b = await restSend(w, { subject: 'b', text: 'B' });
    await expect(owner.query('UPDATE messages SET body_storage_key = $2 WHERE id = $1', [a, contentKeyFor(b)])).rejects.toMatchObject({
      code: '23514',
    });
    await expect(owner.query('UPDATE messages SET body_storage_key = $2 WHERE id = $1', [a, 'inbound/raw/x'])).rejects.toMatchObject({
      code: '23514',
    });
    // 앱 롤(atmark_app)에는 이 칸의 UPDATE 자체가 없다(202609230750 — 컬럼 단위 UPDATE 목록 밖).
    await expect(testPool().query('UPDATE messages SET body_storage_key = NULL WHERE id = $1', [a])).rejects.toMatchObject({ code: '42501' });
    // `snippet` 은 202609241700(검증 F3)이 보존 스윕용으로 한 칸 열었다 — 대신 가드 트리거가 "NULL 로만 · 365일 넘은 행만" 이라
    //   방금 보낸 행의 스니펫은 지우지도(23514) 위조하지도(23514) 못한다.
    await expect(testPool().query('UPDATE messages SET snippet = NULL WHERE id = $1', [a])).rejects.toMatchObject({ code: '23514' });
    await expect(testPool().query(`UPDATE messages SET snippet = 'forged' WHERE id = $1`, [a])).rejects.toMatchObject({ code: '23514' });
  });

  it('snippetOf — 빈 본문은 null · 한 줄로 접는다', () => {
    expect(snippetOf('   \n\t ')).toBeNull();
    expect(snippetOf('a\n\nb\tc')).toBe('a b c');
  });

});
