/**
 * 초안 무결성 · 저장 상한(배포 전 보안 리뷰 — 202610081210 `drafts_integrity` · 라우트 쓰기 순서). 실제 Postgres(앱 롤) · 로컬 객체 저장소.
 *
 *   ① DB — 보내는 중 버리기 금지 · 같은 에이전트의 받은 메일 · 첨부만(남의 것 · 없는 것 거부) · 살아 있는 본문 합계 100 MiB(넘으면 HINT draft_storage_limit · 줄이기는 된다).
 *   ② 만들기 — 상한으로 행이 못 들어가면 본문 객체를 쓰지 않는다(고아 없음) · 객체 쓰기가 실패하면 행도 없다 · 429 draft_storage_limit.
 *   ③ 고치기 — 판 N+1 에 참조되지 않은 객체가 남아 있어도(쓰기 뒤 행 갱신 전 장애) 다음 고치기는 N+2 로 넘어가 성공한다(영구 충돌 없음).
 */

import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { handleCreateDraft, handleGetDraft, handleUpdateDraft } from '../../../src/api/routes/drafts';
import { createPostgresDraftStore } from '../../../src/db/repositories/draft-store';
import { toAgentId } from '../../../src/db/schema';
import { hashAgentToken, issueAgentToken, type AgentTokenStore } from '../../../src/identity/agent-token';
import { createDraftContentStore } from '../../../src/storage/draft-content-store';
import { createLocalObjectStore } from '../../../src/storage/local-object-store';
import type { ObjectStore } from '../../../src/storage/object-store';
import { consumerDeps, deliver, eml, newSesMessageId } from '../inbound/support';
import { closeTestPool, DATABASE_AVAILABLE, provisioningPool, seedFixture, testPool } from './support/harness';

afterAll(async () => {
  if (DATABASE_AVAILABLE) await closeTestPool();
});

const MIB = 1024 * 1024;

async function rawDraft(agentId: string, bytes = 0): Promise<string> {
  const id = randomUUID();
  await testPool().query(
    `INSERT INTO drafts (id, agent_id, content_storage_key, content_bytes) VALUES ($1::uuid, $2, 'outbound/drafts/' || $1 || '/1.json', $3)`,
    [id, agentId, bytes],
  );
  return id;
}

function objectStore(): ObjectStore {
  return createLocalObjectStore({ directory: mkdtempSync(join(tmpdir(), 'atmark-drafts-')), env: {} });
}

function routeDeps(agentId: string, objects: ObjectStore) {
  const issued = issueAgentToken(toAgentId(agentId), ['messages:send', 'messages:read']);
  const tokens: AgentTokenStore = {
    findByHash: (hash) =>
      Promise.resolve(hash === hashAgentToken(issued.plaintext) ? { tokenHash: hash, agentId: toAgentId(agentId), capabilities: issued.capabilities, revokedAt: null, expiresAt: null } : null),
  };
  return {
    deps: { tokens, drafts: createPostgresDraftStore(testPool()), content: createDraftContentStore(objects), replyTargets: { find: () => Promise.resolve(null) }, now: () => new Date() },
    headers: { authorization: `Bearer ${issued.plaintext}` },
  };
}

describe.skipIf(!DATABASE_AVAILABLE)('초안 무결성 · 저장 상한', () => {
  it('① 보내는 중 버리기 금지 · 같은 에이전트의 메일 · 첨부만', async () => {
    const owner = await seedFixture(provisioningPool());
    const stranger = await seedFixture(provisioningPool());
    const pool = testPool();
    const id = await rawDraft(owner.agentId);
    await pool.query(`UPDATE drafts SET send_idempotency_key = 'k1', send_claimed_at = now() WHERE id = $1`, [id]);
    await expect(pool.query(`UPDATE drafts SET discarded_at = now() WHERE id = $1`, [id])).rejects.toThrow(/cannot be discarded/);

    const sesMessageId = newSesMessageId();
    await deliver(consumerDeps(pool, objectStore()), eml({ from: 'client@customer.example', subject: '안녕', text: '안녕하세요' }), { sesMessageId, recipients: [stranger.address] });
    const theirs = (await pool.query<{ id: string }>('SELECT id::text FROM inbound_messages WHERE ses_message_id = $1', [sesMessageId])).rows[0]?.id;
    const mine = await rawDraft(owner.agentId);
    await expect(pool.query(`UPDATE drafts SET in_reply_to = $2 WHERE id = $1`, [mine, theirs])).rejects.toThrow(/same agent/);
    await expect(pool.query(`UPDATE drafts SET attachment_ids = ARRAY[$2::uuid] WHERE id = $1`, [mine, randomUUID()])).rejects.toThrow(/same agent/);
    const att = await provisioningPool().query<{ id: string }>(
      `INSERT INTO outbound_attachments (agent_id, filename, mime_type, bytes) VALUES ($1, 'a.pdf', 'application/pdf', 10) RETURNING id::text`,
      [stranger.agentId],
    ).catch(() => null);
    if (att !== null) await expect(pool.query(`UPDATE drafts SET attachment_ids = ARRAY[$2::uuid] WHERE id = $1`, [mine, att.rows[0]?.id])).rejects.toThrow(/same agent/);
  });

  it('① 살아 있는 본문 합계 100 MiB — 넘으면 거부 · 버린 초안은 세지 않는다 · 줄이기는 된다', async () => {
    const f = await seedFixture(provisioningPool());
    const pool = testPool();
    const ids: string[] = [];
    for (let i = 0; i < 10; i += 1) ids.push(await rawDraft(f.agentId, 10 * MIB));
    await expect(rawDraft(f.agentId, 1)).rejects.toMatchObject({ code: 'P0001', hint: 'draft_storage_limit' });
    // 줄이기는 상한과 무관하게 된다 · 늘리기는 거부.
    await pool.query(`UPDATE drafts SET content_bytes = 5 * 1048576 WHERE id = $1`, [ids[0]]);
    await expect(pool.query(`UPDATE drafts SET content_bytes = 10 * 1048576 WHERE id = $1`, [ids[2]])).resolves.toBeDefined();
    await expect(pool.query(`UPDATE drafts SET content_bytes = 10485760 WHERE id = $1`, [ids[0]])).resolves.toBeDefined();
    await expect(rawDraft(f.agentId, 1)).rejects.toMatchObject({ hint: 'draft_storage_limit' });
    await pool.query(`UPDATE drafts SET discarded_at = now() WHERE id = $1`, [ids[1]]);
    expect(await rawDraft(f.agentId, MIB)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('② 만들기 — 상한이면 429 · 본문 객체 없음 · 객체 쓰기가 실패하면 행도 없다', async () => {
    const f = await seedFixture(provisioningPool());
    for (let i = 0; i < 10; i += 1) await rawDraft(f.agentId, 10 * MIB);
    const objects = objectStore();
    const puts: string[] = [];
    const watched: ObjectStore = { ...objects, putIfAbsent: (key, bytes, type) => (puts.push(key), objects.putIfAbsent(key, bytes, type)) };
    const { deps, headers } = routeDeps(f.agentId, watched);
    const limited = await handleCreateDraft(deps, { headers, query: {}, body: { agent_id: f.agentId, text: 'x' } });
    expect([limited.status, limited.body['error']]).toEqual([429, 'draft_storage_limit']);
    expect(puts).toEqual([]);

    const g = await seedFixture(provisioningPool());
    const failing: ObjectStore = { ...objects, putIfAbsent: () => Promise.reject(new Error('s3 down')) };
    const broken = routeDeps(g.agentId, failing);
    await expect(handleCreateDraft(broken.deps, { headers: broken.headers, query: {}, body: { agent_id: g.agentId, text: 'x' } })).rejects.toThrow(/s3 down/);
    expect((await provisioningPool().query('SELECT 1 FROM drafts WHERE agent_id = $1', [g.agentId])).rowCount).toBe(0);
  });

  it('③ 고치기 — 참조되지 않은 판 N+1 객체가 남아도 다음 고치기는 N+2 로 성공한다', async () => {
    const f = await seedFixture(provisioningPool());
    const objects = objectStore();
    const { deps, headers } = routeDeps(f.agentId, objects);
    const created = await handleCreateDraft(deps, { headers, query: {}, body: { agent_id: f.agentId, text: 'v1' } });
    expect(created.status).toBe(201);
    const id = created.body['id'] as string;
    // 장애: 판 2 객체는 썼지만 행은 판 1 그대로.
    await deps.content.put(id, 2, { text: 'orphan', html: null });
    const updated = await handleUpdateDraft(deps, { headers, query: {}, body: { text: 'v2', revision: 1 } }, { draftId: id });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body).toMatchObject({ revision: 3, text: 'v2' });
    const read = await handleGetDraft(deps, { headers, query: {}, body: undefined }, { draftId: id });
    expect(read.body).toMatchObject({ revision: 3, text: 'v2' });
    // 옛 판으로 고치면 진짜 충돌이다.
    const stale = await handleUpdateDraft(deps, { headers, query: {}, body: { text: 'v3', revision: 1 } }, { draftId: id });
    expect([stale.status, stale.body['error']]).toEqual([409, 'draft_revision_conflict']);
  });
});
