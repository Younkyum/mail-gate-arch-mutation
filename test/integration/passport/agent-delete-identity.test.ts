/**
 * 에이전트 삭제(202610131000)와 공개 신원 — 보안 재검토 L-2. 실제 롤(콘솔 `atmark_admin` · 서명 `atmark_passport_signer` · 소유자). AWS 0 —
 * S3·CloudFront 는 가짜, 서명은 개발 키 파일.
 *
 *   ① 게시된 여권 → 삭제 → 삭제 트리거의 폐기 요청을 서명 워커가 처리 → 새 버전 `revoked`.
 *   ② 정지 요청이 우선 칸에 대기 중일 때 삭제(폐기 요청은 ON CONFLICT 로 들어가지 못한다) → 워커가 그 정지를 **폐기로** 처리(`effectiveKind`).
 *   ③ draft 여권 → 삭제 → 콘솔을 거치지 않은 게시 요청(소유자 셸)도 워커가 `agent_deleted` 로 거부 · 버전 그대로.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPool } from '../../../src/db/client';
import { toAgentId, type AgentId } from '../../../src/db/schema';
import { createLocalDevKeyCustody } from '../../../src/passport/custody-local';
import { effectiveKind, runPassportPublisherTick } from '../../../src/passport/publisher';
import { createPassportSigner } from '../../../src/passport/signer';
import { adminDeps, adminRolePool, APP_URL, authed, AVAILABLE, call, login, loginMailerPool, newOrganization, ownerPool, suffix, type Session } from '../admin/support';

function roleUrl(role: string): string {
  const url = new URL(APP_URL);
  url.username = role;
  url.password = '';
  return url.toString();
}

describe('effectiveKind — 삭제한 에이전트의 요청', () => {
  it('살아 있으면 그대로 · 삭제했으면 공개된 여권은 폐기 · draft 는 null(거부)', () => {
    expect(effectiveKind('publish', 'draft', false)).toBe('publish');
    expect(effectiveKind('suspend', 'published', false)).toBe('suspend');
    for (const kind of ['publish', 'resign', 'suspend', 'revoke'] as const) {
      expect(effectiveKind(kind, 'published', true)).toBe('revoke');
      expect(effectiveKind(kind, 'suspended', true)).toBe('revoke');
      expect(effectiveKind(kind, 'draft', true)).toBeNull();
    }
  });
});

describe.skipIf(!AVAILABLE)('에이전트 삭제 — 공개 신원 폐기(L-2)', { timeout: 120_000 }, () => {
  let owner: Pool;
  let admin: Pool;
  let mailer: Pool;
  let signerDb: Pool;
  let keyDir: string;
  let deps: ReturnType<typeof adminDeps>;
  const noop = { put: () => Promise.resolve(), invalidate: () => Promise.resolve() };

  const tick = (agent: AgentId) =>
    runPassportPublisherTick(
      {
        db: signerDb,
        signer: createPassportSigner({ kind: 'local-dev', directory: keyDir, env: {} }),
        documents: { put: noop.put },
        cdn: { invalidate: noop.invalidate },
        now: () => new Date(Date.now() + 1000),
      },
      { agentIds: [agent] },
    );
  const latest = async (agent: AgentId) =>
    (await owner.query<{ version: number; status: string }>('SELECT version, status::text AS status FROM passports WHERE agent_id = $1 AND superseded_at IS NULL', [agent])).rows[0];
  const requests = async (agent: AgentId) =>
    (
      await owner.query<{ kind: string; status: string; outcome: string | null; outcome_reason: string | null }>(
        'SELECT kind::text AS kind, status::text AS status, outcome, outcome_reason FROM passport_publish_requests WHERE agent_id = $1 ORDER BY created_at, id',
        [agent],
      )
    ).rows;

  async function orgWithAgent(): Promise<{ session: Session; agent: AgentId }> {
    const org = await newOrganization(owner);
    const session = await login(deps, mailer, org);
    const created = await call(deps, 'POST', '/api/agents', authed(session, { body: { name: 'del-id', localPart: `di-${suffix()}` } }));
    expect(created.statusCode, created.body).toBe(201);
    return { session, agent: toAgentId((created.json() as { agent: { id: string } }).agent.id) };
  }

  async function published(): Promise<{ session: Session; agent: AgentId }> {
    const f = await orgWithAgent();
    expect((await call(deps, 'POST', `/api/agents/${f.agent}/identity/publish`, authed(f.session))).statusCode).toBe(202);
    expect(await tick(f.agent)).toMatchObject({ 'signed.published': 1 });
    return f;
  }

  const del = (f: { session: Session; agent: AgentId }) => call(deps, 'POST', `/api/agents/${f.agent}/delete`, authed(f.session, { body: {} }));

  beforeAll(() => {
    owner = ownerPool();
    admin = adminRolePool();
    mailer = loginMailerPool();
    signerDb = createPool(roleUrl('atmark_passport_signer'), { max: 2 });
    keyDir = mkdtempSync(join(tmpdir(), 'atmark-agent-delete-identity-'));
    deps = adminDeps(admin, { custody: () => createLocalDevKeyCustody({ directory: keyDir, env: {} }) });
  });

  afterAll(async () => {
    await Promise.all([owner.end(), admin.end(), mailer.end(), signerDb.end()]);
    rmSync(keyDir, { recursive: true, force: true });
  });

  it('① 게시된 여권 → 삭제 → 폐기 요청 → 워커가 revoked 새 버전', async () => {
    const f = await published();
    expect((await del(f)).statusCode).toBe(200);
    expect((await requests(f.agent)).at(-1)).toMatchObject({ kind: 'revoke', status: 'pending' });
    await tick(f.agent);
    expect(await latest(f.agent)).toEqual({ version: 2, status: 'revoked' });
  });

  it('② 정지가 우선 칸에 대기 중일 때 삭제 — 폐기 요청은 못 들어가도 워커가 그 정지를 폐기로 처리', async () => {
    const f = await published();
    expect((await call(deps, 'POST', `/api/agents/${f.agent}/identity/suspend`, authed(f.session))).statusCode).toBe(202);
    expect((await del(f)).statusCode).toBe(200);
    const pending = (await requests(f.agent)).filter((r) => r.status === 'pending');
    expect(pending.map((r) => r.kind)).toEqual(['suspend']);
    await tick(f.agent);
    expect(await latest(f.agent)).toEqual({ version: 2, status: 'revoked' });
    expect((await requests(f.agent)).at(-1)).toMatchObject({ kind: 'suspend', outcome: 'revoked' });
  });

  it('③ draft 여권 → 삭제 → 게시 요청(소유자 셸)도 워커가 agent_deleted 로 거부 · 버전 그대로', async () => {
    const f = await orgWithAgent();
    expect((await del(f)).statusCode).toBe(200);
    expect((await requests(f.agent)).filter((r) => r.kind === 'revoke')).toEqual([]);
    await owner.query("INSERT INTO passport_publish_requests (agent_id, kind, requested_by) VALUES ($1, 'publish', 'operator:test')", [f.agent]);
    expect(await tick(f.agent)).toMatchObject({ rejected: 1 });
    expect((await requests(f.agent)).at(-1)).toMatchObject({ status: 'rejected', outcome_reason: 'agent_deleted' });
    expect(await latest(f.agent)).toEqual({ version: 1, status: 'draft' });
  });
});
