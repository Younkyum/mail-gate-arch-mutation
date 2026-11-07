/**
 * 콘솔 웹훅 관리(2026-09-30 — ADR-0013 개정) — `/api/agents/{id}/webhooks*` 여섯 경로를 **`atmark_admin` 롤 풀**로 돌린다(202609301410 의 GRANT 가
 * 공허하지 않은지 · 에이전트 API 와 같은 연산이 그 권한 안에서 도는지).
 *
 *   - 계약 모양(camelCase): 목록 `{items, limits, availableEventTypes}` · 등록 201 `{item, secret}` · 회전 `{item, secret, previousValidUntil}` ·
 *     삭제 `{item}` · 전달 목록 `{items, nextCursor}`(상태 네 가지 — failed 는 재시도 대기) · 재전송 202 `{item}`.
 *   - 역할: owner·admin 쓰기 · member 는 읽기만(쓰기 403 forbidden_role) · 다른 조직 404.
 *   - 감사: 쓰기마다 owner_actions 한 행(`agent.webhook.*`, 대상 = 에이전트) · 거부는 감사 없음 · 콘솔 회전은 원장 via=console.
 *   - 오류 코드는 에이전트 API 와 같다(invalid_webhook_url · webhook_endpoint_limit · delivery_not_dead …).
 *   - 시크릿(보안 M1): admin λ 는 키링이 없다 — `deps.webhookSecrets` 는 api λ 의 내부 이벤트 처리(`handleInternalApiEvent`, **앱 롤 풀**)를 그대로
 *     부르는 가짜다. api 쪽은 60초 안의 콘솔 행에만 답한다(API 로 만든 행 · 60초 지난 행 · API 회전 버전은 not_eligible). 발급기가 없거나 kid 를
 *     못 받으면 **아무것도 쓰기 전에** 503 · 커밋 뒤 시크릿을 못 받으면 503 + item.
 *   - 발급은 (엔드포인트, 버전)당 한 번(재검토 L-1): 같은 버전의 두 번째 발급은 60초 안이라도 not_eligible · 콘솔 회전의 새 버전은 한 번 더.
 *   - URL 가림(보안 L3): member 목록은 `url` 이 가린 값 · `urlMasked: true`. 감사 상세(보안 L2): 엔드포인트 id · URL 호스트 · 전달 id 둘.
 */

import { randomBytes, randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AdminDependencies } from '../../../src/admin/context';
import { INTERNAL_EVENT_SOURCE } from '../../../src/runtime/internal-api-event';
import { handleInternalApiEvent } from '../../../src/runtime/internal-api-handler';
import { toAgentId } from '../../../src/db/schema';
import { handleRegisterWebhookEndpoint } from '../../../src/api/routes/webhook-endpoints';
import { createPostgresAgentTokenStore } from '../../../src/db/repositories/agent-token-store';
import { issueAgentToken } from '../../../src/identity/agent-token';
import { parseHmacKeyring } from '../../../src/security/hmac-keyring';
import { deriveWebhookSecret } from '../../../src/webhooks/signing';
import { WEBHOOK_EVENT_TYPES } from '../../../src/webhooks/events';
import { adminDeps, adminRolePool, appPool, authed, AVAILABLE, call, login, loginMailerPool, newOrganization, ownerPool, suffix, userIdOf, type Session } from './support';

const RING = parseHmacKeyring(`w1:${randomBytes(32).toString('base64url')}`, 'TEST');

interface Item {
  id: string;
  url: string;
  eventTypes: string[];
  createdAt: string;
  status: string;
  secretVersion: number;
  rotatedAt: string | null;
  previousValidUntil: string | null;
  lastDelivery: { status: string; at: string; httpStatus: number | null } | null;
}

interface DeliveryItem {
  id: string;
  webhookId: string;
  eventType: string;
  status: string;
  attempts: number;
  httpStatus: number | null;
  createdAt: string;
  lastAttemptAt: string | null;
  deliveredAt: string | null;
}

const ITEM_KEYS = [
  'authorizationHint',
  'createdAt',
  'eventTypes',
  'hasAuthorization',
  'id',
  'lastDelivery',
  'previousValidUntil',
  'rotatedAt',
  'secretVersion',
  'status',
  'url',
  'urlMasked',
];
const DELIVERY_KEYS = ['attempts', 'createdAt', 'deliveredAt', 'eventType', 'httpStatus', 'id', 'lastAttemptAt', 'status', 'webhookId'];

describe.skipIf(!AVAILABLE)('콘솔 웹훅 — atmark_admin 롤', () => {
  let owner: Pool;
  let admin: Pool;
  let mailer: Pool;
  let app: Pool;
  let deps: AdminDependencies;

  /** api λ 쪽 내부 이벤트 처리(앱 롤 풀) — 운영의 Lambda 호출을 함수 호출로 바꾼 것뿐이다. */
  async function issueViaApi(agentId: string, endpointId: string): Promise<{ ok: boolean; secret?: string; error?: string }> {
    return (await handleInternalApiEvent({ db: app, keyring: RING }, { source: INTERNAL_EVENT_SOURCE, kind: 'webhook.issueSecret', agentId, endpointId })) as {
      ok: boolean;
      secret?: string;
      error?: string;
    };
  }

  beforeAll(() => {
    owner = ownerPool();
    admin = adminRolePool();
    mailer = loginMailerPool();
    app = appPool();
    deps = adminDeps(admin, {
      webhookSecrets: {
        activeKid: () => Promise.resolve('w1'),
        issue: async (agentId, endpointId) => {
          const result = await issueViaApi(agentId, endpointId);
          if (result.secret === undefined) throw new Error(`issue refused: ${String(result.error)}`);
          return result.secret;
        },
        // 인증 헤더 봉인(202610141400) — api λ 의 내부 이벤트 처리 그대로(앱 롤 풀 · 같은 키 묶음).
        sealAuthorization: async (target, authorization) => {
          const result = (await handleInternalApiEvent(
            { db: app, keyring: RING },
            { source: INTERNAL_EVENT_SOURCE, kind: 'webhook.sealAuthorization', ...target, authorization },
          )) as { ok: boolean; error?: string; url?: string; kid?: string; sealed?: string; hint?: string; generation?: number };
          if (
            !result.ok ||
            result.url === undefined ||
            result.kid === undefined ||
            result.sealed === undefined ||
            result.hint === undefined ||
            result.generation === undefined
          ) {
            throw Object.assign(new Error('seal refused'), { reason: result.error });
          }
          return { url: result.url, kid: result.kid, sealed: result.sealed, hint: result.hint, generation: result.generation };
        },
      },
    });
  });
  afterAll(async () => {
    await owner.end();
    await admin.end();
    await mailer.end();
    await app.end();
  });

  async function fixture(plan: 'beta' | 'free' = 'beta'): Promise<{ orgId: string; session: Session; agentId: string }> {
    const org = await newOrganization(owner, plan);
    const session = await login(deps, mailer, org);
    const created = await call(deps, 'POST', '/api/agents', authed(session, { body: { name: 'hooks', localPart: `hook-${suffix()}` } }));
    expect(created.statusCode, created.body).toBe(201);
    return { orgId: org.id, session, agentId: (created.json() as { agent: { id: string } }).agent.id };
  }

  async function roleSession(organizationId: string, role: 'admin' | 'member'): Promise<Session> {
    const email = `hook-${role}-${suffix()}@example.com`;
    await owner.query('INSERT INTO users (email) VALUES ($1)', [email]);
    const userId = await userIdOf(owner, email);
    await owner.query(`INSERT INTO memberships (user_id, organization_id, role, joined_via) VALUES ($1, $2, $3, 'invite')`, [userId, organizationId, role]);
    return login(deps, mailer, { id: organizationId, ownerEmail: email });
  }

  const base = (agentId: string): string => `/api/agents/${agentId}/webhooks`;
  const hookUrl = (): string => `https://hooks-${randomUUID().slice(0, 8)}.example.com/atmark`;

  async function create(session: Session, agentId: string, body: Record<string, unknown> = { url: hookUrl() }) {
    return call(deps, 'POST', base(agentId), authed(session, { body }));
  }

  async function created(session: Session, agentId: string, body?: Record<string, unknown>): Promise<{ item: Item; secret: string }> {
    const result = await create(session, agentId, body);
    expect(result.statusCode, result.body).toBe(201);
    return result.json() as { item: Item; secret: string };
  }

  /**
   * 커밋 뒤 시크릿을 받지 못한 콘솔 등록(503 + item) — 발급기가 api 를 부르지 않고 실패하므로 그 버전의 발급 선점이 **아직 남아 있다**.
   * 발급 확인 규칙만 따로 볼 때 쓴다(보통 등록은 응답에서 이미 한 번 발급했다 — 재검토 L-1).
   */
  async function createdUnissued(session: Session, agentId: string): Promise<Item> {
    const unissued = adminDeps(admin, { webhookSecrets: { activeKid: () => Promise.resolve('w1'), issue: () => Promise.reject(new Error('timeout')) } });
    const result = await call(unissued, 'POST', base(agentId), authed(session, { body: { url: hookUrl() } }));
    expect(result.statusCode, result.body).toBe(503);
    return (result.json() as { item: Item }).item;
  }

  async function auditActions(orgId: string): Promise<Array<[string, string | null]>> {
    const rows = await owner.query<{ action: string; target_id: string | null }>(
      "SELECT action, target_id FROM owner_actions WHERE organization_id = $1 AND action LIKE 'agent.webhook.%' ORDER BY created_at, id",
      [orgId],
    );
    return rows.rows.map((row) => [row.action, row.target_id]);
  }

  /** 전달 행 하나를 소유자 롤로 심는다(상태별 — 디스패처를 돌리지 않고 화면 상태를 본다). */
  async function seedDelivery(endpointId: string, shape: 'delivered' | 'failed' | 'dead' | 'pending', createdAt: Date): Promise<string> {
    const row = await owner.query<{ id: string }>(
      `INSERT INTO webhook_deliveries (event_id, endpoint_id, event_type, dedupe_key, body, next_attempt_at, status, attempt_count,
                                       last_error, last_http_status, delivered_at, dead_at, last_attempt_at, created_at)
       VALUES ($1, $2, 'message.sent', $3, '{}', $4, $5::webhook_delivery_status, $6, $7, $8, $9, $10, $11, $4)
       RETURNING id`,
      [
        randomUUID(),
        endpointId,
        `message.sent:${randomUUID()}`,
        createdAt,
        shape === 'failed' ? 'pending' : shape,
        shape === 'pending' ? 0 : shape === 'dead' ? 10 : 2,
        shape === 'failed' || shape === 'dead' ? 'http_status' : null,
        shape === 'delivered' ? 200 : shape === 'pending' ? null : 503,
        shape === 'delivered' ? createdAt : null,
        shape === 'dead' ? createdAt : null,
        shape === 'pending' ? null : createdAt,
      ],
    );
    return row.rows[0]?.id ?? '';
  }

  it('풀은 atmark_admin 이다 — GRANT 단언이 공허하지 않다', async () => {
    expect((await admin.query<{ user: string }>('SELECT current_user AS user')).rows[0]?.user).toBe('atmark_admin');
  });

  it('★ 등록 201 {item, secret} · 목록 {items, limits, availableEventTypes} · 계약 모양 그대로 · 시크릿은 등록 응답에만', async () => {
    const f = await fixture();
    const { item, secret } = await created(f.session, f.agentId, { url: hookUrl(), eventTypes: ['message.bounced', 'message.received'] });
    expect(Object.keys(item).sort()).toEqual(ITEM_KEYS);
    expect(item).toMatchObject({ status: 'active', secretVersion: 1, rotatedAt: null, previousValidUntil: null, lastDelivery: null, urlMasked: false });
    const createdVia = await owner.query<{ created_via: string }>('SELECT created_via FROM webhook_endpoints WHERE id = $1', [item.id]);
    expect(createdVia.rows).toEqual([{ created_via: 'console' }]);
    expect(item.eventTypes).toEqual(['message.received', 'message.bounced']);
    expect(secret).toBe(deriveWebhookSecret(RING, { endpointId: item.id, kid: 'w1', version: 1 }));

    const listed = await call(deps, 'GET', base(f.agentId), authed(f.session));
    expect(listed.statusCode).toBe(200);
    const view = listed.json() as { items: Item[]; limits: Record<string, number>; availableEventTypes: string[] };
    expect(view.items.map((i) => i.id)).toEqual([item.id]);
    expect(view.limits).toEqual({ active: 1, activeMax: 10, registrationsToday: 1, registrationsMax: 10 });
    expect(view.availableEventTypes).toEqual([...WEBHOOK_EVENT_TYPES]);
    expect(listed.body).not.toContain('whsec_');
    // 생략한 구독은 옛 4종으로 풀어 보인다.
    const plain = await created(f.session, f.agentId);
    expect(plain.item.eventTypes).toEqual(['approval.resolved', 'approval.expired', 'message.sent', 'message.received']);
    expect(await auditActions(f.orgId)).toEqual([
      ['agent.webhook.create', f.agentId],
      ['agent.webhook.create', f.agentId],
    ]);
  });

  it('★ 회전 {item, secret, previousValidUntil} · 버전 2 · 원장 via=console · 삭제 {item} → 목록에서 빠지고 status=all 에는 deleted', async () => {
    const f = await fixture();
    const { item } = await created(f.session, f.agentId);
    const rotated = await call(deps, 'POST', `${base(f.agentId)}/${item.id}/rotate`, authed(f.session));
    expect(rotated.statusCode, rotated.body).toBe(200);
    const payload = rotated.json() as { item: Item; secret: string; previousValidUntil: string };
    expect(Object.keys(payload).sort()).toEqual(['item', 'previousValidUntil', 'secret']);
    expect(payload.item).toMatchObject({ id: item.id, secretVersion: 2, previousValidUntil: payload.previousValidUntil });
    expect(payload.item.rotatedAt).not.toBeNull();
    expect(payload.secret).toBe(deriveWebhookSecret(RING, { endpointId: item.id, kid: 'w1', version: 2 }));
    const ledger = await owner.query<{ via: string }>('SELECT via FROM webhook_secret_rotations WHERE endpoint_id = $1', [item.id]);
    expect(ledger.rows).toEqual([{ via: 'console' }]);

    const deleted = await call(deps, 'DELETE', `${base(f.agentId)}/${item.id}`, authed(f.session));
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect((deleted.json() as { item: Item }).item).toMatchObject({ id: item.id, status: 'deleted' });
    expect(((await call(deps, 'GET', base(f.agentId), authed(f.session))).json() as { items: Item[] }).items).toEqual([]);
    const all = (await call(deps, 'GET', base(f.agentId), authed(f.session, { query: 'status=all' }))).json() as { items: Item[] };
    expect(all.items.map((i) => [i.id, i.status])).toEqual([[item.id, 'deleted']]);
    // 지운 것은 다시 지우거나 회전할 수 없다(404) — 감사 없음.
    expect((await call(deps, 'DELETE', `${base(f.agentId)}/${item.id}`, authed(f.session))).json()).toMatchObject({ error: 'webhook_not_found' });
    expect((await call(deps, 'POST', `${base(f.agentId)}/${item.id}/rotate`, authed(f.session))).json()).toMatchObject({ error: 'webhook_not_found' });
    expect(await auditActions(f.orgId)).toEqual([
      ['agent.webhook.create', f.agentId],
      ['agent.webhook.rotate', f.agentId],
      ['agent.webhook.delete', f.agentId],
    ]);
  });

  it('★ 전달 목록: 상태 넷(delivered·failed·dead·pending) · 계약 모양 · webhookId 로 거르기 · 마지막 전달 · 재전송 202 {item} · dead 아닌 것 409', async () => {
    const f = await fixture();
    const first = (await created(f.session, f.agentId)).item;
    const second = (await created(f.session, f.agentId)).item;
    const t = Date.now() - 60_000;
    const delivered = await seedDelivery(first.id, 'delivered', new Date(t));
    const failed = await seedDelivery(second.id, 'failed', new Date(t + 1_000));
    const dead = await seedDelivery(second.id, 'dead', new Date(t + 2_000));
    const pending = await seedDelivery(first.id, 'pending', new Date(t + 3_000));

    const listed = await call(deps, 'GET', `${base(f.agentId)}/deliveries`, authed(f.session));
    expect(listed.statusCode, listed.body).toBe(200);
    const page = listed.json() as { items: DeliveryItem[]; nextCursor: string | null };
    expect(page.nextCursor).toBeNull();
    expect(page.items.map((d) => [d.id, d.status])).toEqual([
      [pending, 'pending'],
      [dead, 'dead'],
      [failed, 'failed'],
      [delivered, 'delivered'],
    ]);
    for (const d of page.items) expect(Object.keys(d).sort()).toEqual(DELIVERY_KEYS);
    expect(page.items.find((d) => d.id === failed)).toMatchObject({ webhookId: second.id, attempts: 2, httpStatus: 503, deliveredAt: null });
    expect(page.items.find((d) => d.id === pending)).toMatchObject({ attempts: 0, lastAttemptAt: null });

    const filtered = (await call(deps, 'GET', `${base(f.agentId)}/deliveries`, authed(f.session, { query: `webhookId=${first.id}` }))).json() as {
      items: DeliveryItem[];
    };
    expect(filtered.items.map((d) => d.id)).toEqual([pending, delivered]);

    const hooks = (await call(deps, 'GET', base(f.agentId), authed(f.session))).json() as { items: Item[] };
    expect(hooks.items.find((i) => i.id === second.id)?.lastDelivery).toMatchObject({ status: 'dead', httpStatus: 503 });

    const redelivered = await call(deps, 'POST', `${base(f.agentId)}/deliveries/${dead}/redeliver`, authed(f.session));
    expect(redelivered.statusCode, redelivered.body).toBe(202);
    expect((redelivered.json() as { item: DeliveryItem }).item).toMatchObject({ webhookId: second.id, status: 'pending', attempts: 0, lastAttemptAt: null });
    const notDead = await call(deps, 'POST', `${base(f.agentId)}/deliveries/${delivered}/redeliver`, authed(f.session));
    expect(notDead.statusCode).toBe(409);
    expect(notDead.json()).toMatchObject({ error: 'delivery_not_dead' });
    expect((await call(deps, 'POST', `${base(f.agentId)}/deliveries/${randomUUID()}/redeliver`, authed(f.session))).json()).toMatchObject({
      error: 'delivery_not_found',
    });
    expect((await auditActions(f.orgId)).filter(([action]) => action === 'agent.webhook.redeliver')).toEqual([['agent.webhook.redeliver', f.agentId]]);
  });

  it('★ 역할: admin 은 쓴다 · member 는 목록·전달 목록만(쓰기 넷 403 forbidden_role) · 다른 조직 404', async () => {
    const f = await fixture();
    const adminSession = await roleSession(f.orgId, 'admin');
    const { item } = await created(adminSession, f.agentId);
    const member = await roleSession(f.orgId, 'member');
    expect((await call(deps, 'GET', base(f.agentId), authed(member))).statusCode).toBe(200);
    expect((await call(deps, 'GET', `${base(f.agentId)}/deliveries`, authed(member))).statusCode).toBe(200);
    for (const [method, path] of [
      ['POST', base(f.agentId)],
      ['DELETE', `${base(f.agentId)}/${item.id}`],
      ['POST', `${base(f.agentId)}/${item.id}/rotate`],
      ['POST', `${base(f.agentId)}/deliveries/${randomUUID()}/redeliver`],
    ] as const) {
      const result = await call(deps, method, path, authed(member, method === 'POST' && path === base(f.agentId) ? { body: { url: hookUrl() } } : {}));
      expect(result.statusCode, `${method} ${path}`).toBe(403);
      expect(result.json(), `${method} ${path}`).toMatchObject({ error: 'forbidden_role', required: 'admin' });
    }
    const other = await fixture();
    expect((await call(deps, 'GET', base(f.agentId), authed(other.session))).json()).toMatchObject({ error: 'agent_not_found' });
    expect((await call(deps, 'POST', `${base(f.agentId)}/${item.id}/rotate`, authed(other.session))).json()).toMatchObject({ error: 'agent_not_found' });
  });

  it('오류 코드는 에이전트 API 와 같다 — invalid_webhook_url 400 · 잘못된 구독 400 · Free 의 두 번째는 webhook_endpoint_limit 409 · 거부는 감사 없음', async () => {
    const f = await fixture();
    for (const url of ['http://hooks.example.com/', 'https://127.0.0.1/', '']) {
      const result = await create(f.session, f.agentId, { url });
      expect(result.statusCode, url).toBe(400);
      expect(result.json(), url).toMatchObject({ error: 'invalid_webhook_url' });
    }
    expect((await create(f.session, f.agentId, { url: hookUrl(), eventTypes: ['nope'] })).json()).toMatchObject({ error: 'invalid_event_types' });
    expect((await create(f.session, f.agentId, { url: hookUrl(), secret: 'x' })).json()).toMatchObject({ error: 'invalid_body' });
    // Free 는 활성 1개 — 두 번째가 409(요금제 한도 · 에이전트 API 와 같은 min(천장, 요금제)).
    const free = await fixture('free');
    await created(free.session, free.agentId);
    const limited = await create(free.session, free.agentId);
    expect(limited.statusCode).toBe(409);
    expect(limited.json()).toMatchObject({ error: 'webhook_endpoint_limit' });
    const view = (await call(deps, 'GET', base(free.agentId), authed(free.session))).json() as { limits: Record<string, number> };
    expect(view.limits).toMatchObject({ active: 1, activeMax: 1, registrationsToday: 1 });
    expect(await auditActions(f.orgId)).toEqual([]);
    expect(await auditActions(free.orgId)).toEqual([['agent.webhook.create', free.agentId]]);
  });

  it('★ 보안 M1·L4 — 발급기가 없거나 kid 를 못 받으면 쓰기 전에 503(행·감사 0) · 커밋 뒤 시크릿을 못 받으면 503 + item(행위는 됐다)', async () => {
    const f = await fixture();
    const { item } = await created(f.session, f.agentId);
    const count = async (): Promise<number> =>
      (await owner.query<{ n: number }>('SELECT count(*)::int AS n FROM webhook_endpoints WHERE agent_id = $1', [f.agentId])).rows[0]?.n ?? -1;
    const before = await count();
    const auditBefore = (await auditActions(f.orgId)).length;
    for (const broken of [
      adminDeps(admin),
      adminDeps(admin, { webhookSecrets: { activeKid: () => Promise.reject(new Error('down')), issue: () => Promise.reject(new Error('down')) } }),
    ]) {
      expect((await call(broken, 'GET', base(f.agentId), authed(f.session))).statusCode).toBe(200);
      const create503 = await call(broken, 'POST', base(f.agentId), authed(f.session, { body: { url: hookUrl() } }));
      expect(create503.statusCode).toBe(503);
      expect(create503.json()).toMatchObject({ error: 'webhooks_unavailable' });
      expect((await call(broken, 'POST', `${base(f.agentId)}/${item.id}/rotate`, authed(f.session))).statusCode).toBe(503);
    }
    expect(await count()).toBe(before);
    expect((await auditActions(f.orgId)).length).toBe(auditBefore);

    const lateFailure = adminDeps(admin, { webhookSecrets: { activeKid: () => Promise.resolve('w1'), issue: () => Promise.reject(new Error('timeout')) } });
    const late = await call(lateFailure, 'POST', base(f.agentId), authed(f.session, { body: { url: hookUrl() } }));
    expect(late.statusCode).toBe(503);
    const body = late.json() as { error: string; item: Item };
    expect(body.error).toBe('webhook_secret_unavailable');
    expect(body.item).toMatchObject({ status: 'active', secretVersion: 1 });
    expect(late.body).not.toContain('whsec_');
    expect(await count()).toBe(before + 1);
    // 시크릿은 교체로 새로 받는다 — 60초 안의 콘솔 회전이라 api 쪽이 답한다.
    const rotated = await call(deps, 'POST', `${base(f.agentId)}/${body.item.id}/rotate`, authed(f.session));
    expect(rotated.statusCode).toBe(200);
    expect((rotated.json() as { secret: string }).secret).toBe(deriveWebhookSecret(RING, { endpointId: body.item.id, kid: 'w1', version: 2 }));
  });

  it('★ 보안 M1 — api 쪽 발급 확인: API 로 등록한 행 · 60초 지난 콘솔 행 · API 회전으로 바뀐 버전 · 지운 행 · 남의 에이전트는 not_eligible', async () => {
    const f = await fixture();
    const agentId = toAgentId(f.agentId);
    // API 로 등록한 행(앱 롤 · via=api).
    const token = issueAgentToken(agentId, ['messages:read', 'webhooks:manage']);
    await createPostgresAgentTokenStore(owner).insert({ agentId, tokenHash: token.tokenHash, capabilities: token.capabilities, expiresAt: null });
    const viaApi = await handleRegisterWebhookEndpoint(
      { tokens: createPostgresAgentTokenStore(app), db: app, keyring: RING, now: () => new Date() },
      { headers: { authorization: `Bearer ${token.plaintext}` }, query: {}, body: { url: hookUrl() } },
      { agentId },
    );
    expect(viaApi.status).toBe(201);
    expect(await issueViaApi(agentId, viaApi.body['id'] as string)).toEqual({ ok: false, error: 'not_eligible' });

    // 콘솔 행 — 다른 에이전트 id 로는 답하지 않고(선점도 쓰지 않는다), 방금이면 답한다.
    const item = await createdUnissued(f.session, f.agentId);
    const other = await fixture();
    expect(await issueViaApi(other.agentId, item.id)).toEqual({ ok: false, error: 'not_eligible' });
    expect(await issueViaApi(agentId, item.id)).toEqual({ ok: true, secret: deriveWebhookSecret(RING, { endpointId: item.id, kid: 'w1', version: 1 }) });

    // 60초 지난 콘솔 행(소유자 롤 · 트리거를 끈 트랜잭션으로 created_at 을 과거로) — 아직 발급하지 않은 버전이어도 창 밖이면 거절.
    const aged = await createdUnissued(f.session, f.agentId);
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL session_replication_role = replica');
      await client.query(`UPDATE webhook_endpoints SET created_at = now() - interval '61 seconds' WHERE id = $1`, [aged.id]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    expect(await issueViaApi(agentId, aged.id)).toEqual({ ok: false, error: 'not_eligible' });

    // API 로 회전한 버전 — 콘솔 회전이 아니다.
    const apiRotated = await owner.query(`SELECT * FROM rotate_webhook_endpoint_secret($1, $2::uuid, 'w1', 'api')`, [agentId, item.id]);
    expect(apiRotated.rows[0]).toMatchObject({ r_outcome: 'rotated', r_secret_version: 2 });
    expect(await issueViaApi(agentId, item.id)).toEqual({ ok: false, error: 'not_eligible' });

    // 지운 행(아직 발급하지 않은 버전).
    const gone = await createdUnissued(f.session, f.agentId);
    expect((await call(deps, 'DELETE', `${base(f.agentId)}/${gone.id}`, authed(f.session))).statusCode).toBe(200);
    expect(await issueViaApi(agentId, gone.id)).toEqual({ ok: false, error: 'not_eligible' });
  });

  it('★ 재검토 L-1 — 콘솔 발급은 (엔드포인트, 버전)당 한 번: 두 번째는 60초 안이라도 not_eligible · 콘솔 회전의 새 버전은 한 번 더 · 원장은 append-only', async () => {
    const f = await fixture();
    const agentId = toAgentId(f.agentId);
    // 등록 응답이 버전 1 을 이미 받았다 — 같은 버전을 다시 받을 수 없다(다른 환경·재시도의 재조회 차단).
    const { item, secret } = await created(f.session, f.agentId);
    expect(secret).toBe(deriveWebhookSecret(RING, { endpointId: item.id, kid: 'w1', version: 1 }));
    expect(await issueViaApi(agentId, item.id)).toEqual({ ok: false, error: 'not_eligible' });

    // 콘솔 회전 → 버전 2 는 회전 응답에서 한 번 · 그 뒤 다시는 없다.
    const rotated = await call(deps, 'POST', `${base(f.agentId)}/${item.id}/rotate`, authed(f.session));
    expect(rotated.statusCode, rotated.body).toBe(200);
    expect((rotated.json() as { secret: string }).secret).toBe(deriveWebhookSecret(RING, { endpointId: item.id, kid: 'w1', version: 2 }));
    expect(await issueViaApi(agentId, item.id)).toEqual({ ok: false, error: 'not_eligible' });

    // 회전 응답이 시크릿을 받지 못했으면(api 를 부르기 전 실패) 버전 3 은 아직 선점되지 않았다 — 한 번 받고, 두 번째는 거절.
    const unissued = adminDeps(admin, { webhookSecrets: { activeKid: () => Promise.resolve('w1'), issue: () => Promise.reject(new Error('timeout')) } });
    const late = await call(unissued, 'POST', `${base(f.agentId)}/${item.id}/rotate`, authed(f.session));
    expect(late.statusCode).toBe(503);
    expect(late.json()).toMatchObject({ error: 'webhook_secret_unavailable', item: { id: item.id, secretVersion: 3 } });
    expect(await issueViaApi(agentId, item.id)).toEqual({ ok: true, secret: deriveWebhookSecret(RING, { endpointId: item.id, kid: 'w1', version: 3 }) });
    expect(await issueViaApi(agentId, item.id)).toEqual({ ok: false, error: 'not_eligible' });

    const issues = await owner.query<{ version: number }>('SELECT version FROM webhook_console_secret_issues WHERE endpoint_id = $1 ORDER BY version', [item.id]);
    expect(issues.rows).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
    // append-only — 소유자 롤도 선점을 지우거나 고쳐 같은 버전을 다시 열 수 없다.
    await expect(owner.query('DELETE FROM webhook_console_secret_issues WHERE endpoint_id = $1', [item.id])).rejects.toThrow();
    await expect(owner.query('UPDATE webhook_console_secret_issues SET version = version + 10 WHERE endpoint_id = $1', [item.id])).rejects.toThrow();
  });

  it('★ 보안 L3·L2 — member 목록의 url 은 가린 값(urlMasked) · owner 는 전체 · 감사 상세에 엔드포인트 id · URL 호스트 · 전달 id 둘', async () => {
    const f = await fixture();
    const target = `https://hooks-${suffix()}.example.com/v1/atmark-in?token=s3cr3t`;
    const { item } = await created(f.session, f.agentId, { url: target });
    const member = await roleSession(f.orgId, 'member');
    const masked = ((await call(deps, 'GET', base(f.agentId), authed(member))).json() as { items: Item[] }).items;
    expect(masked).toMatchObject([{ id: item.id, urlMasked: true }]);
    expect(masked[0]?.url).toBe(`${new URL(target).origin}/…k-in`);
    expect(JSON.stringify(masked)).not.toContain('s3cr3t');
    const full = ((await call(deps, 'GET', base(f.agentId), authed(f.session))).json() as { items: Item[] }).items;
    expect(full).toMatchObject([{ id: item.id, url: target, urlMasked: false }]);

    const dead = await seedDelivery(item.id, 'dead', new Date(Date.now() - 30_000));
    const redelivered = await call(deps, 'POST', `${base(f.agentId)}/deliveries/${dead}/redeliver`, authed(f.session));
    const newId = (redelivered.json() as { item: DeliveryItem }).item.id;
    await call(deps, 'POST', `${base(f.agentId)}/${item.id}/rotate`, authed(f.session));
    await call(deps, 'DELETE', `${base(f.agentId)}/${item.id}`, authed(f.session));
    const details = await owner.query<{ action: string; endpoint_id: string; url_host: string; delivery_id: string | null; new_delivery_id: string | null }>(
      `SELECT o.action, d.endpoint_id::text, d.url_host, d.delivery_id::text, d.new_delivery_id::text
         FROM owner_actions o JOIN webhook_owner_action_details d ON d.owner_action_id = o.id
        WHERE o.organization_id = $1 ORDER BY o.created_at, o.id`,
      [f.orgId],
    );
    const host = new URL(target).host;
    expect(details.rows).toEqual([
      { action: 'agent.webhook.create', endpoint_id: item.id, url_host: host, delivery_id: null, new_delivery_id: null },
      { action: 'agent.webhook.redeliver', endpoint_id: item.id, url_host: host, delivery_id: dead, new_delivery_id: newId },
      { action: 'agent.webhook.rotate', endpoint_id: item.id, url_host: host, delivery_id: null, new_delivery_id: null },
      { action: 'agent.webhook.delete', endpoint_id: item.id, url_host: host, delivery_id: null, new_delivery_id: null },
    ]);
  });

  it('★ 인증 헤더(202610141400) — 추가 때 · 설정/교체 · 지우기 · 목록은 힌트뿐 · 감사(값 없음) · 규칙 위반 400 · 봉인기 없으면 쓰기 전 503 · member 403', async () => {
    const f = await fixture();
    const value = `Bearer console_${randomBytes(16).toString('hex')}`;
    const fragment = value.slice('Bearer '.length);
    const { item } = await created(f.session, f.agentId, { url: hookUrl(), authorization: value });
    expect(item).toMatchObject({ hasAuthorization: true, authorizationHint: `Bearer …${value.slice(-4)}` });
    const stored = await owner.query<{ set_via: string; sealed: string }>('SELECT set_via, sealed FROM webhook_endpoint_authorizations WHERE endpoint_id = $1', [item.id]);
    expect(stored.rows[0]?.set_via).toBe('console');
    expect(stored.rows[0]?.sealed).not.toContain(fragment);

    // 목록(owner · member) 어디에도 값이 없다.
    const member = await roleSession(f.orgId, 'member');
    for (const session of [f.session, member]) {
      const listed = await call(deps, 'GET', base(f.agentId), authed(session));
      expect(listed.body).not.toContain(fragment);
      expect((listed.json() as { items: Item[] }).items[0]).toMatchObject({ hasAuthorization: true });
    }

    // 교체 → 힌트가 바뀐다 · 지우기 → false · 두 번째 지우기는 감사 없이 200.
    const next = `Basic ${Buffer.from(`user:${randomBytes(12).toString('hex')}`).toString('base64')}`;
    const set = await call(deps, 'POST', `${base(f.agentId)}/${item.id}/authorization`, authed(f.session, { body: { authorization: next } }));
    expect(set.statusCode, set.body).toBe(200);
    expect((set.json() as { item: Item }).item).toMatchObject({ hasAuthorization: true, authorizationHint: 'Basic …' });
    const cleared = await call(deps, 'DELETE', `${base(f.agentId)}/${item.id}/authorization`, authed(f.session));
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect((cleared.json() as { item: Item }).item).toMatchObject({ hasAuthorization: false, authorizationHint: null });
    expect((await call(deps, 'DELETE', `${base(f.agentId)}/${item.id}/authorization`, authed(f.session))).statusCode).toBe(200);

    // 규칙 위반 · 모르는 칸 · 빈 값 → 400 · 값을 되돌리지 않는다.
    for (const body of [{ authorization: 'Bearer x\r\nHost: evil' }, { authorization: '' }, { authorization: 'ok', extra: 1 }]) {
      const bad = await call(deps, 'POST', `${base(f.agentId)}/${item.id}/authorization`, authed(f.session, { body }));
      expect(bad.statusCode).toBe(400);
      expect(bad.body).not.toContain('evil');
    }
    const badCreate = await create(f.session, f.agentId, { url: hookUrl(), authorization: 'Bearer 토큰' });
    expect(badCreate.statusCode).toBe(400);
    expect((badCreate.json() as { error: string }).error).toBe('invalid_authorization');

    // member 는 쓰지 못한다 · 남의 웹훅 id 는 404.
    expect((await call(deps, 'POST', `${base(f.agentId)}/${item.id}/authorization`, authed(member, { body: { authorization: value } }))).statusCode).toBe(403);
    expect((await call(deps, 'DELETE', `${base(f.agentId)}/${item.id}/authorization`, authed(member))).statusCode).toBe(403);
    expect((await call(deps, 'POST', `${base(f.agentId)}/${randomUUID()}/authorization`, authed(f.session, { body: { authorization: value } }))).statusCode).toBe(404);

    // 봉인기가 없으면 아무것도 쓰기 전에 503(행 · 감사 0).
    const before = await owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM owner_actions WHERE organization_id = $1`, [f.orgId]);
    const noSealer = adminDeps(admin, { webhookSecrets: { activeKid: () => Promise.resolve('w1'), issue: () => Promise.reject(new Error('x')) } });
    const refused = await call(noSealer, 'POST', `${base(f.agentId)}/${item.id}/authorization`, authed(f.session, { body: { authorization: value } }));
    expect(refused.statusCode).toBe(503);
    const refusedCreate = await call(noSealer, 'POST', base(f.agentId), authed(f.session, { body: { url: hookUrl(), authorization: value } }));
    expect(refusedCreate.statusCode).toBe(503);
    const after = await owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM owner_actions WHERE organization_id = $1`, [f.orgId]);
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);

    // 감사 — 행위 이름과 엔드포인트 · 호스트만. 값은 감사 · 상세 · 잎 원천 어디에도 없다.
    const audit = await owner.query<{ action: string; endpoint_id: string }>(
      `SELECT o.action, d.endpoint_id::text FROM owner_actions o JOIN webhook_owner_action_details d ON d.owner_action_id = o.id
        WHERE o.organization_id = $1 ORDER BY o.created_at, o.id`,
      [f.orgId],
    );
    expect(audit.rows.map((row) => row.action)).toEqual(['agent.webhook.create', 'agent.webhook.authorization_set', 'agent.webhook.authorization_clear']);
    const leaked = await owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM owner_actions WHERE organization_id = $1 AND row_to_json(owner_actions)::text LIKE $2`, [
      f.orgId,
      `%${fragment}%`,
    ]);
    expect(leaked.rows[0]?.n).toBe(0);
  });

  it('★ 보안 리뷰 L3 — api 쪽 봉인 확인: 다른 조직 · 삭제한 엔드포인트 · 다른 에이전트 · 다른 URL · 이미 있는 id 의 register 는 not_eligible(봉인값 없음)', async () => {
    const f = await fixture();
    const other = await fixture();
    const { item } = await created(f.session, f.agentId, { url: hookUrl() });
    const seal = (target: Record<string, unknown>) =>
      handleInternalApiEvent(
        { db: app, keyring: RING },
        { source: INTERNAL_EVENT_SOURCE, kind: 'webhook.sealAuthorization', authorization: 'Bearer l3_0123456789abcdef', ...target } as never,
      );
    const good = { agentId: f.agentId, organizationId: f.orgId, endpointId: item.id, url: item.url, purpose: 'replace' };
    await expect(seal(good)).resolves.toMatchObject({ ok: true });
    for (const bad of [
      { ...good, organizationId: other.orgId },
      { ...good, agentId: other.agentId },
      { ...good, agentId: other.agentId, organizationId: other.orgId },
      { ...good, url: hookUrl() },
      { ...good, endpointId: randomUUID() },
      { ...good, purpose: 'register' },
    ]) {
      const result = (await seal(bad)) as { ok: boolean; error?: string; sealed?: string };
      expect(result, JSON.stringify(bad)).toEqual({ ok: false, error: 'not_eligible' });
    }
    await expect(seal({ ...good, endpointId: randomUUID(), purpose: 'register' })).resolves.toMatchObject({ ok: true });
    await expect(seal({ ...good, organizationId: other.orgId, endpointId: randomUUID(), purpose: 'register' })).resolves.toEqual({ ok: false, error: 'not_eligible' });
    // 지운 엔드포인트 — 콘솔 설정은 404(웹훅 없음), api 쪽도 not_eligible.
    await call(deps, 'DELETE', `${base(f.agentId)}/${item.id}`, authed(f.session));
    await expect(seal(good)).resolves.toEqual({ ok: false, error: 'not_eligible' });
  });
});
