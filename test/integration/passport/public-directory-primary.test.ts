/**
 * 메일 기본기 1차 선행 — 공개 조회는 **대표 주소만**(결정 D5, AC-P-1). `src/passport/public-directory.ts` 의 `AND addr.is_primary`.
 *
 *   - 대표 주소 응답은 바이트 그대로다(같은 에이전트에 비대표 주소가 생겨도 대표 응답은 한 글자도 바뀌지 않는다).
 *   - 비대표 주소는 **없는 주소와 같은** 404 다(상태·헤더·본문 동일 — "이 주소도 같은 에이전트" 라는 연결이 새지 않는다).
 *
 * 조건을 지우면 비대표 주소가 200 으로 같은 신원을 돌려주어 빨갛다(arch `passport-public-surface` ④ 가 SQL 로도 본다).
 * **`TEST_DATABASE_URL` 이 없으면 통째로 건너뛴다.**
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPool } from '../../../src/db/client';
import { toAgentId, type AgentId } from '../../../src/db/schema';
import { createLocalDevKeyCustody } from '../../../src/passport/custody-local';
import { createPostgresIdentityDirectory } from '../../../src/passport/public-directory';
import { runPassportPublisherTick } from '../../../src/passport/publisher';
import { createPassportSigner } from '../../../src/passport/signer';
import { routeHttpApiEvent, type ApiDependencies } from '../../../src/runtime/router';
import { adminDeps, adminRolePool, APP_URL, authed, AVAILABLE, call, login, loginMailerPool, newOrganization, ownerPool, suffix } from '../admin/support';

function roleUrl(role: string): string {
  const url = new URL(APP_URL);
  url.username = role;
  url.password = '';
  return url.toString();
}

describe.skipIf(!AVAILABLE)('AC-P-1 — 공개 조회는 대표 주소만', () => {
  let owner: Pool;
  let admin: Pool;
  let mailer: Pool;
  let app: Pool;
  let signerDb: Pool;
  let keyDir: string;
  let agentId: AgentId;
  let primary: string;

  beforeAll(async () => {
    owner = ownerPool();
    admin = adminRolePool();
    mailer = loginMailerPool();
    app = createPool(APP_URL, { max: 2 });
    signerDb = createPool(roleUrl('atmark_passport_signer'), { max: 2 });
    keyDir = mkdtempSync(join(tmpdir(), 'atmark-primary-'));
    const deps = adminDeps(admin, { custody: () => createLocalDevKeyCustody({ directory: keyDir, env: {} }) });
    const organization = await newOrganization(owner);
    const session = await login(deps, mailer, organization);
    const created = await call(deps, 'POST', '/api/agents', authed(session, { body: { name: 'Primary Only', localPart: `prim-${suffix()}` } }));
    const agent = (created.json() as { agent: { id: string; address: string } }).agent;
    agentId = toAgentId(agent.id);
    primary = agent.address;
    expect((await call(deps, 'POST', `/api/agents/${agentId}/identity/publish`, authed(session))).statusCode).toBe(202);
    await runPassportPublisherTick(
      {
        db: signerDb,
        signer: createPassportSigner({ kind: 'local-dev', directory: keyDir, env: {} }),
        documents: { put: () => Promise.resolve() },
        cdn: { invalidate: () => Promise.resolve() },
        now: () => new Date(Date.now() + 1000),
      },
      { agentIds: [agentId] },
    );
  });

  afterAll(async () => {
    await Promise.all([owner.end(), admin.end(), mailer.end(), app.end(), signerDb.end()]);
    rmSync(keyDir, { recursive: true, force: true });
  });

  function lookup(address: string): ReturnType<typeof routeHttpApiEvent> {
    const deps = { identity: { directory: createPostgresIdentityDirectory(app) } } as unknown as ApiDependencies;
    return routeHttpApiEvent(deps, {
      rawPath: `/v1/identity/${encodeURIComponent(address)}`,
      requestContext: { requestId: 'primary-only', http: { method: 'GET' } },
    });
  }

  it('대표 200 은 비대표 주소가 생겨도 바이트 그대로 · 비대표 주소는 없는 주소와 같은 404', async () => {
    const before = await lookup(primary);
    expect(before.statusCode).toBe(200);
    expect(before.body).toContain(primary);

    // 같은 에이전트의 비대표 주소 — 2차 별칭(A6)의 모양. 운영에서는 admin 발급만이 만든다(여기서는 소유자 롤로 심는다).
    const alias = `alias-${suffix()}@atmark.ai`;
    await owner.query(`INSERT INTO agent_addresses (agent_id, address, domain, is_primary) VALUES ($1, $2, 'atmark.ai', false)`, [agentId, alias]);

    const after = await lookup(primary);
    expect(after.statusCode).toBe(200);
    expect(after.body).toBe(before.body);
    expect(after.headers).toEqual(before.headers);

    const viaAlias = await lookup(alias);
    const nobody = await lookup(`nobody-${suffix()}@atmark.ai`);
    expect(viaAlias.statusCode).toBe(404);
    expect(viaAlias.body).toBe(nobody.body);
    expect(viaAlias.headers).toEqual(nobody.headers);
    expect(viaAlias.body).not.toContain(agentId);
    expect(await createPostgresIdentityDirectory(app).findByAddress(alias)).toBeNull();
  });
});
