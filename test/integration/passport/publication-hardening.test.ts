/**
 * 신원 게시 — 2026-09-24 검증 반영(IDENTITY #3 #4 #11) e2e. 실제 Postgres 롤 넷(콘솔 `atmark_admin` · 서명 `atmark_passport_signer` ·
 * 공개 API `atmark_app` · 지반 소유자). AWS 0 — S3·CloudFront 는 기록만 하는 가짜, 서명은 개발 키 파일.
 *
 *   ① 조직 검토 전제(#3) — 검토가 끝나지 않은 조직: 콘솔 게시 409 `identity_org_not_active` · 콘솔을 거치지 않은 게시 요청도 서명 워커가
 *      거부(`org_not_active`) · published 를 이어 가는 재서명도 거부 · **정지는 된다**.
 *   ② 공개 `capabilities` 가 조직 층 차단(소유자 정지·검토 전)을 반영한다(#3).
 *   ③ `no_policy_violations`(#4) — 소유자 정책이 막은 거부(`recipient_not_allowlisted` 등)는 위반이 아니다 · 90일 밖의 위반은 세지 않는다 ·
 *      창 안의 진짜 위반(`from_forgery`)은 센다(비공허).
 *   ④ 대기 요청 상호작용(#11) — 백오프 중인 게시 뒤에서도 정지가 들어가 **먼저** 처리되고 그 게시를 대체한다 · 정지 뒤에 사람이 누른 게시는
 *      대체되지 않는다 · suspended 에서 대기 중인 재서명은 게시를 **충족하지 않는다**(409).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { handleGetIdentity as handlePublicIdentity } from '../../../src/api/routes/identity';
import { createPool } from '../../../src/db/client';
import { toAgentId, type AgentId } from '../../../src/db/schema';
import { createLocalDevKeyCustody } from '../../../src/passport/custody-local';
import { createPostgresIdentityDirectory } from '../../../src/passport/public-directory';
import { runPassportPublisherTick } from '../../../src/passport/publisher';
import { createPassportSigner } from '../../../src/passport/signer';
import { adminDeps, adminRolePool, APP_URL, authed, AVAILABLE, call, login, loginMailerPool, newOrganization, ownerPool, suffix, type Session } from '../admin/support';

function roleUrl(role: string): string {
  const url = new URL(APP_URL);
  url.username = role;
  url.password = '';
  return url.toString();
}

describe.skipIf(!AVAILABLE)('신원 게시 — 조직 검토 · 공개 capabilities · 위반 정의 · 대기 요청 우선순위 (2026-09-24 검증)', () => {
  let owner: Pool;
  let admin: Pool;
  let mailer: Pool;
  let app: Pool;
  let signerDb: Pool;
  let keyDir: string;
  let deps: ReturnType<typeof adminDeps>;
  const noop = { put: () => Promise.resolve(), invalidate: () => Promise.resolve() };

  const tick = (agent: AgentId, at: Date = new Date(Date.now() + 1000)) =>
    runPassportPublisherTick(
      {
        db: signerDb,
        signer: createPassportSigner({ kind: 'local-dev', directory: keyDir, env: {} }),
        documents: { put: noop.put },
        cdn: { invalidate: noop.invalidate },
        now: () => at,
      },
      { agentIds: [agent] },
    );
  const publicGet = (raw: string) => handlePublicIdentity({ directory: createPostgresIdentityDirectory(app) }, { address: raw });
  const versions = async (agent: AgentId) =>
    (await owner.query<{ version: number; status: string }>('SELECT version, status FROM passports WHERE agent_id = $1 ORDER BY version', [agent])).rows;
  const requests = async (agent: AgentId) =>
    (
      await owner.query<{ kind: string; status: string; outcome_reason: string | null }>(
        'SELECT kind, status::text, outcome_reason FROM passport_publish_requests WHERE agent_id = $1 ORDER BY created_at, id',
        [agent],
      )
    ).rows;
  const post = (session: Session, agent: AgentId, action: 'publish' | 'suspend') =>
    call(deps, 'POST', `/api/agents/${agent}/identity/${action}`, authed(session));

  async function orgWithAgent(): Promise<{ org: { id: string }; session: Session; agent: AgentId; address: string }> {
    const org = await newOrganization(owner);
    const session = await login(deps, mailer, org);
    const created = await call(deps, 'POST', '/api/agents', authed(session, { body: { name: 'hardening', localPart: `hd-${suffix()}` } }));
    expect(created.statusCode, created.body).toBe(201);
    const agent = (created.json() as { agent: { id: string; address: string } }).agent;
    return { org, session, agent: toAgentId(agent.id), address: agent.address };
  }

  async function published(): Promise<Awaited<ReturnType<typeof orgWithAgent>>> {
    const fixture = await orgWithAgent();
    expect((await post(fixture.session, fixture.agent, 'publish')).statusCode).toBe(202);
    expect(await tick(fixture.agent)).toMatchObject({ 'signed.published': 1 });
    return fixture;
  }

  const setReview = (orgId: string, status: 'active' | 'pending_review') =>
    owner.query('UPDATE organizations SET review_status = $2::organization_review_status WHERE id = $1', [orgId, status]);

  beforeAll(() => {
    owner = ownerPool();
    admin = adminRolePool();
    mailer = loginMailerPool();
    app = createPool(APP_URL, { max: 2 });
    signerDb = createPool(roleUrl('atmark_passport_signer'), { max: 2 });
    keyDir = mkdtempSync(join(tmpdir(), 'atmark-passport-hardening-'));
    deps = adminDeps(admin, { custody: () => createLocalDevKeyCustody({ directory: keyDir, env: {} }) });
  });

  afterAll(async () => {
    await Promise.all([owner.end(), admin.end(), mailer.end(), app.end(), signerDb.end()]);
    rmSync(keyDir, { recursive: true, force: true });
  });

  it('① 검토 전 조직 — 콘솔 게시 409 identity_org_not_active · 콘솔을 거치지 않은 게시 요청도 워커가 거부 · 버전 그대로', async () => {
    const f = await orgWithAgent();
    await setReview(f.org.id, 'pending_review');
    const refused = await post(f.session, f.agent, 'publish');
    expect([refused.statusCode, (refused.json() as { error: string }).error]).toEqual([409, 'identity_org_not_active']);
    // 콘솔 검사를 우회한 요청(소유자 셸) — 서명 워커가 같은 전제로 거부한다.
    await owner.query("INSERT INTO passport_publish_requests (agent_id, kind, requested_by) VALUES ($1, 'publish', 'operator:test')", [f.agent]);
    expect(await tick(f.agent)).toMatchObject({ rejected: 1 });
    expect((await requests(f.agent)).at(-1)).toMatchObject({ status: 'rejected', outcome_reason: 'org_not_active' });
    expect(await versions(f.agent)).toEqual([{ version: 1, status: 'draft' }]);
    // 비공허: 검토가 끝나면 된다.
    await setReview(f.org.id, 'active');
    expect((await post(f.session, f.agent, 'publish')).statusCode).toBe(202);
    expect(await tick(f.agent)).toMatchObject({ 'signed.published': 1 });
  });

  it('① 게시 뒤 조직이 검토 전으로 — published 를 이어 가는 재서명은 거부(새 버전 없음) · 정지는 된다(내리는 쪽은 열려 있다)', async () => {
    const f = await published();
    await setReview(f.org.id, 'pending_review');
    await owner.query("INSERT INTO passport_publish_requests (agent_id, kind, requested_by) VALUES ($1, 'resign', 'system:resign')", [f.agent]);
    expect(await tick(f.agent)).toMatchObject({ rejected: 1 });
    expect((await requests(f.agent)).at(-1)).toMatchObject({ kind: 'resign', outcome_reason: 'org_not_active' });
    expect(await versions(f.agent)).toEqual([{ version: 1, status: 'published' }]);
    expect((await post(f.session, f.agent, 'suspend')).statusCode).toBe(202);
    expect(await tick(f.agent)).toMatchObject({ 'signed.suspended': 1 });
    expect((await versions(f.agent)).at(-1)).toEqual({ version: 2, status: 'suspended' });
  });

  it('② 공개 capabilities — 조직 소유자 정지면 can_send=false · 검토 전이면 주고받기 모두 false · 풀면 되돌아온다', async () => {
    const f = await published();
    await owner.query("UPDATE agent_policies SET outbound_mode = 'unrestricted' WHERE agent_id = $1", [f.agent]);
    const baseline = await publicGet(f.address);
    expect(baseline).toMatchObject({ status: 200, body: { capabilities: { can_send: true, can_receive: true } } });
    await owner.query('UPDATE organizations SET owner_paused = true WHERE id = $1', [f.org.id]);
    expect(await publicGet(f.address)).toMatchObject({ body: { capabilities: { can_send: false, can_receive: true } } });
    await owner.query('UPDATE organizations SET owner_paused = false WHERE id = $1', [f.org.id]);
    await setReview(f.org.id, 'pending_review');
    const pending = await publicGet(f.address);
    expect(pending).toMatchObject({ body: { capabilities: { can_send: false, can_receive: false } } });
    expect(JSON.stringify(pending.body)).not.toMatch(/pending_review|owner_paused|review/);
    await setReview(f.org.id, 'active');
    expect(await publicGet(f.address)).toEqual(baseline);
  });

  it('③ no_policy_violations — 소유자 정책이 막은 거부 · 90일 밖 위반은 세지 않는다 · 창 안의 from_forgery 는 센다', async () => {
    const f = await published();
    const version = await owner.query<{ id: string }>('SELECT id FROM policy_versions WHERE agent_id = $1 ORDER BY version DESC LIMIT 1', [f.agent]);
    const deny = (reasons: string[], daysAgo: number) =>
      owner.query(
        `INSERT INTO audit_logs (agent_id, decision, reasons, policy_version_id, policy_version, created_at, evaluated_at)
         VALUES ($1, 'denied', $2::text[], $3, 1, now() - make_interval(days => $4), now() - make_interval(days => $4))`,
        [f.agent, reasons, version.rows[0]?.id, daysAgo],
      );
    const attestation = async (): Promise<unknown> => {
      const row = await owner.query<{ document: string }>(
        'SELECT d.document FROM passports p JOIN passport_documents d ON d.passport_id = p.id WHERE p.agent_id = $1 AND p.superseded_at IS NULL',
        [f.agent],
      );
      const document = JSON.parse(row.rows[0]?.document ?? '{}') as { credentialSubject: { attestations: { type: string; value: unknown }[] } };
      return document.credentialSubject.attestations.find((entry) => entry.type === 'no_policy_violations')?.value;
    };
    const resign = async () => {
      await owner.query("INSERT INTO passport_publish_requests (agent_id, kind, requested_by) VALUES ($1, 'resign', 'system:resign')", [f.agent]);
      return tick(f.agent);
    };
    expect(await attestation()).toBe(true);

    // 정책이 일한 것(화이트리스트 밖 · 블랙리스트 · 전부 X · 옛 이름) + 창 밖의 진짜 위반.
    await deny(['recipient_not_allowlisted'], 0);
    await deny(['recipient_blocklisted', 'outbound_disabled'], 1);
    await deny(['recipient_not_in_allowlist'], 2);
    await deny(['from_forgery'], 100);
    expect(await resign()).toMatchObject({ 'signed.unchanged': 1 });
    expect(await attestation()).toBe(true);
    expect(await versions(f.agent)).toHaveLength(1);

    // 창 안의 진짜 위반 — 새 버전, false.
    await deny(['from_forgery'], 3);
    expect(await resign()).toMatchObject({ 'signed.published': 1 });
    expect(await attestation()).toBe(false);
  });

  it('④ 백오프 중인 게시 뒤에서도 정지가 들어가고 먼저 처리된다 — 그 게시는 superseded_by_suspend · 되살아나지 않는다', async () => {
    const f = await published();
    expect((await post(f.session, f.agent, 'publish')).statusCode).toBe(202);
    // 게시 요청이 백오프 중(서명 실패 뒤 대기)인 상태를 만든다.
    await owner.query(
      "UPDATE passport_publish_requests SET attempt_count = 3, last_error = 'sign:kmsinternalexception', next_attempt_at = now() + interval '1 hour' WHERE agent_id = $1 AND status = 'pending'",
      [f.agent],
    );
    const suspend = await post(f.session, f.agent, 'suspend');
    expect(suspend.statusCode, suspend.body).toBe(202);
    expect((suspend.json() as { identity: { pending: { kind: string } } }).identity.pending.kind).toBe('suspend');

    expect(await tick(f.agent)).toMatchObject({ 'signed.suspended': 1 });
    expect(await requests(f.agent)).toEqual([
      { kind: 'publish', status: 'done', outcome_reason: null },
      { kind: 'publish', status: 'rejected', outcome_reason: 'superseded_by_suspend' },
      { kind: 'suspend', status: 'done', outcome_reason: null },
    ]);
    // 두 시간 뒤(백오프가 끝났을 시각)에도 게시는 되살아나지 않는다.
    await tick(f.agent, new Date(Date.now() + 2 * 3600_000));
    expect(await versions(f.agent)).toEqual([
      { version: 1, status: 'published' },
      { version: 2, status: 'suspended' },
    ]);

    // 정지 **뒤에** 사람이 누른 게시는 대체되지 않는다.
    expect((await post(f.session, f.agent, 'publish')).statusCode).toBe(202);
    expect(await tick(f.agent)).toMatchObject({ 'signed.published': 1 });
    expect((await versions(f.agent)).at(-1)).toEqual({ version: 3, status: 'published' });
  });

  it('④ 게시가 먼저 잡혀도(정지는 아직 기한 전 — 경쟁 흉내) 그보다 나중에 들어온 정지가 이긴다 — 그 게시는 거부 · 새 버전 없음', async () => {
    const f = await published();
    // 정지가 게시 행을 닫지 못한 경우(다른 워커가 게시 행을 잠근 사이)를 흉내: 게시를 넣고 정지를 넣은 뒤 **게시만** 기한 안에 둬
    // 워커가 게시를 먼저 잡게 한다. 게시 처리 쪽의 "나중 우선 요청" 검사가 막아야 한다.
    expect((await post(f.session, f.agent, 'publish')).statusCode).toBe(202);
    expect((await post(f.session, f.agent, 'suspend')).statusCode).toBe(202);
    await owner.query(
      "UPDATE passport_publish_requests SET next_attempt_at = now() + interval '1 hour' WHERE agent_id = $1 AND status = 'pending' AND kind = 'suspend'",
      [f.agent],
    );
    expect(await tick(f.agent)).toMatchObject({ rejected: 1 });
    expect((await requests(f.agent)).find((row) => row.kind === 'publish' && row.status === 'rejected')?.outcome_reason).toBe('superseded_by_suspend');
    expect(await versions(f.agent)).toEqual([{ version: 1, status: 'published' }]);
  });

  it('④ suspended 에서 대기 중인 재서명은 게시를 충족하지 않는다 — 409(예전 판은 재서명을 돌려줘 게시가 조용히 사라졌다)', async () => {
    const f = await published();
    expect((await post(f.session, f.agent, 'suspend')).statusCode).toBe(202);
    expect(await tick(f.agent)).toMatchObject({ 'signed.suspended': 1 });
    await owner.query("INSERT INTO passport_publish_requests (agent_id, kind, requested_by) VALUES ($1, 'resign', 'system:resign')", [f.agent]);
    const publish = await post(f.session, f.agent, 'publish');
    expect([publish.statusCode, (publish.json() as { error: string }).error]).toEqual([409, 'identity_request_pending']);
    // 재서명이 끝나면(suspended 유지) 게시가 된다.
    expect(await tick(f.agent)).toMatchObject({ 'signed.unchanged': 1 });
    expect((await post(f.session, f.agent, 'publish')).statusCode).toBe(202);
    expect(await tick(f.agent)).toMatchObject({ 'signed.published': 1 });
    // 비공허: published 에서는 대기 중인 재서명이 게시를 충족한다(같은 요청을 돌려준다).
    await owner.query("INSERT INTO passport_publish_requests (agent_id, kind, requested_by) VALUES ($1, 'resign', 'system:resign')", [f.agent]);
    const satisfied = await post(f.session, f.agent, 'publish');
    expect([satisfied.statusCode, (satisfied.json() as { request: { kind: string } }).request.kind]).toEqual([202, 'resign']);
  });
});
