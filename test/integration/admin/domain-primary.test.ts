/**
 * 고객 도메인 대표 주소(ADR-0014 2026-10 개정 · M3b) — 만들기 · 별칭 · 대표 고르기 · 읽기 경로 · 여권 F-7. 라우터는 `atmark_admin` 롤 풀.
 *
 *   ① 만들 때 고른다: `domain` → 고객 주소가 대표 · @atmark.ai 앵커(`ax--` 난수)는 내부에만 · 선택 `provision` 하나 · `primary` 모순은 400 ·
 *      다른 조직의 도메인(IDOR)은 400 `domain_not_verified`(콘솔 · 조직 API) · `ax--` 로컬파트는 형식 오류 · 확인 안 된 도메인 400.
 *   ② **잠든 앵커는 어디에도 나오지 않는다** — 에이전트 목록 · 한 개 · 주소 목록 · 정책 소스(발신 주소 · 유효 대표) · 답장 기본 From · 운영자 긴급
 *      정지 목록 · 공개 조회(404) · 여권 문서 · 수신 조회(모르는 주소와 같다).
 *   ③ 별칭 `domain` · 대표 고르기(`POST /api/agents/{id}/primary`): 재생 · @atmark.ai 별칭 400 `primary_not_eligible` · 남의 주소 404 · 앵커
 *      `{anchor:true}` · 속도 상한 429 `primary_change_rate_limited` · 감사 `agent.primary.set`.
 *   ④ 유효 대표인 별칭 폐기 409 `address_is_primary` · 대표 고르기와 폐기가 겹쳐도 대표가 NULL 이 되지 않는다(조직 잠금).
 *   ⑧ 고객 도메인 대표 에이전트의 @atmark.ai 별칭(허용 — 앵커는 숨긴 채).
 *   ⑤ 여권 F-7: 주소 = 유효 대표 · `domain_verified` 참(verified · plan_limit) · 평판 정지 거짓 · 소유 상실 → 주소 null(순서 그대로) — 바뀔 때만 새 버전.
 */

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AdminDependencies } from '../../../src/admin/context';
import { createPool, type Queryable } from '../../../src/db/client';
import { createPostgresInboundStore } from '../../../src/db/repositories/inbound-store';
import { createPostgresPolicySource } from '../../../src/db/repositories/policy-source';
import { createPostgresReplyTargetLookup } from '../../../src/db/repositories/reply-target-store';
import { toAgentId } from '../../../src/db/schema';
import { ANCHOR_LOCAL_PART_PATTERN, PRIMARY_CHANGES_PER_AGENT_PER_DAY } from '../../../src/domains/contract';
import { readKillSwitch } from '../../../src/ops/console/reads';
import { createLocalDevKeyCustody } from '../../../src/passport/custody-local';
import { createPostgresIdentityDirectory } from '../../../src/passport/public-directory';
import { runPassportPublisherTick } from '../../../src/passport/publisher';
import { createPassportSigner } from '../../../src/passport/signer';
import { verifiedCustomDomain } from '../policy/support';
import { adminDeps, adminRolePool, APP_URL, appPool, authed, AVAILABLE, call, login, loginMailerPool, newOrganization, ownerPool, suffix, type Session } from './support';

function roleUrl(role: string): string {
  const url = new URL(APP_URL);
  url.username = role;
  url.password = '';
  return url.toString();
}

interface AgentBody {
  id: string;
  address: string | null;
}

interface AddressItem {
  id: string;
  address: string;
  primary: boolean;
  anchor: boolean;
  status: string;
}

describe.skipIf(!AVAILABLE)('고객 도메인 대표 주소 — 만들기 · 고르기 · 읽기 경로 · 여권', { timeout: 180_000 }, () => {
  let owner: Pool;
  let admin: Pool;
  let app: Pool;
  let mailer: Pool;
  let signerDb: Pool;
  let opsDb: Pool;
  let keyDir: string;
  let deps: AdminDependencies;

  beforeAll(() => {
    owner = ownerPool();
    admin = adminRolePool();
    app = appPool();
    mailer = loginMailerPool();
    signerDb = createPool(roleUrl('atmark_passport_signer'), { max: 2 });
    opsDb = createPool(roleUrl('atmark_ops'), { max: 1 });
    keyDir = mkdtempSync(join(tmpdir(), 'atmark-m3b-'));
    deps = adminDeps(admin, { custody: () => createLocalDevKeyCustody({ directory: keyDir, env: {} }), features: { addressAliases: true } });
  });
  afterAll(async () => {
    await Promise.all([owner.end(), admin.end(), app.end(), mailer.end(), signerDb.end(), opsDb.end()]);
    rmSync(keyDir, { recursive: true, force: true });
  });

  async function org(plan: 'beta' | 'scale' = 'scale'): Promise<{ id: string; session: Session; domain: string; domainId: string }> {
    const organization = await newOrganization(owner, plan);
    const { id: domainId, domain } = await verifiedCustomDomain(organization.id);
    return { id: organization.id, session: await login(deps, mailer, organization), domain, domainId };
  }

  const errorOf = (result: { json: () => unknown }): string => (result.json() as { error: string }).error;

  async function createAgent(session: Session, body: Record<string, unknown>): Promise<AgentBody> {
    const created = await call(deps, 'POST', '/api/agents', authed(session, { body: { name: `m3b-${suffix()}`, ...body } }));
    expect(created.statusCode, created.body).toBe(201);
    return (created.json() as { agent: AgentBody }).agent;
  }

  async function anchorOf(agentId: string): Promise<{ id: string; address: string }> {
    const row = await owner.query<{ id: string; address: string }>(`SELECT id::text AS id, address FROM agent_addresses WHERE agent_id = $1 AND is_primary`, [agentId]);
    const found = row.rows[0];
    if (found === undefined) throw new Error('앵커가 없다');
    return found;
  }

  const listAddresses = async (session: Session, agentId: string): Promise<AddressItem[]> =>
    ((await call(deps, 'GET', `/api/agents/${agentId}/aliases`, authed(session))).json() as { items: AddressItem[] }).items;
  const choose = (session: Session, agentId: string, body: Record<string, unknown>) =>
    call(deps, 'POST', `/api/agents/${agentId}/primary`, authed(session, { body }));

  async function inboundTo(agentId: string, envelope: string): Promise<string> {
    const thread = await owner.query<{ id: string }>(`INSERT INTO threads (agent_id, started_by) VALUES ($1, 'external') RETURNING id`, [agentId]);
    const ses = `0100${randomUUID().replace(/-/g, '')}`;
    const inserted = await owner.query<{ id: string }>(
      `INSERT INTO inbound_messages
         (agent_id, envelope_recipient, ses_message_id, thread_id, new_thread_reason, from_address, from_domain, from_authenticated,
          subject, auto_submitted, spf_verdict, dkim_verdict, dmarc_verdict, spam_verdict, virus_verdict, headers_truncated,
          raw_storage_key, parsed_storage_key, text_source, has_html_text, attachment_count, received_at,
          scanner_version, injection_risk, quarantined, sender_trust)
       VALUES ($1, $2, $3, $4, 'no_header_ids', 'sender@partner.example', 'partner.example', true, 'hello', false, 'pass', 'pass', 'pass', 'pass',
               'pass', false, 'inbound/raw/' || $3, 'inbound/parsed/' || $3 || '.json', 'plain', false, 0, now(),
               'test-v0', 'none'::injection_risk, false, 'unknown')
       RETURNING id`,
      [agentId, envelope, ses, thread.rows[0]?.id],
    );
    return inserted.rows[0]?.id ?? '';
  }

  it('① 만들 때 고객 도메인을 대표로 — 앵커는 ax-- 난수 · 선택 provision 하나 · 감사 agent.create', async () => {
    const a = await org();
    const local = `sales-${suffix()}`;
    const agent = await createAgent(a.session, { localPart: local, domain: a.domain });
    expect(agent.address).toBe(`${local}@${a.domain}`);
    const anchor = await anchorOf(agent.id);
    expect(anchor.address.split('@')[0]).toMatch(ANCHOR_LOCAL_PART_PATTERN);
    expect(anchor.address.endsWith('@atmark.ai')).toBe(true);
    const choices = await owner.query<{ cause: string; address: string }>(`SELECT cause, address FROM agent_primary_changes WHERE agent_id = $1`, [agent.id]);
    expect(choices.rows).toEqual([{ cause: 'provision', address: agent.address }]);
    // `primary: 'custom'` 도 같다 · 모순은 400.
    const explicit = await createAgent(a.session, { localPart: `ops-${suffix()}`, domain: a.domain, primary: 'custom' });
    expect(explicit.address?.endsWith(`@${a.domain}`)).toBe(true);
    for (const body of [
      { localPart: `x-${suffix()}`, primary: 'custom' },
      { localPart: `x-${suffix()}`, domain: a.domain, primary: 'atmark' },
      { localPart: `x-${suffix()}`, primary: 'other' },
    ]) {
      const denied = await call(deps, 'POST', '/api/agents', authed(a.session, { body: { name: 'bad', ...body } }));
      expect([denied.statusCode, errorOf(denied)], JSON.stringify(body)).toEqual([400, 'invalid_body']);
    }
    // 사용자 입력 ax-- 는 형식 오류(존재를 밝히지 않는다).
    const anchorShaped = await call(deps, 'POST', '/api/agents', authed(a.session, { body: { name: 'bad', localPart: anchor.address.split('@')[0], domain: a.domain } }));
    expect([anchorShaped.statusCode, errorOf(anchorShaped)]).toEqual([400, 'invalid_local_part']);
  });

  it('① 다른 조직의 도메인 · 확인 안 된 도메인 → 400 domain_not_verified(콘솔 · 조직 API — 정의자 함수는 호출자 조직을 모른다)', async () => {
    const a = await org();
    const b = await org();
    const foreign = await call(deps, 'POST', '/api/agents', authed(b.session, { body: { name: 'idor', localPart: `idor-${suffix()}`, domain: a.domain } }));
    expect([foreign.statusCode, errorOf(foreign)]).toEqual([400, 'domain_not_verified']);
    const unknown = await call(deps, 'POST', '/api/agents', authed(b.session, { body: { name: 'idor', localPart: `idor-${suffix()}`, domain: `agents.cd${suffix()}.com` } }));
    expect([unknown.statusCode, errorOf(unknown)]).toEqual([400, 'domain_not_verified']);
    const issued = await call(deps, 'POST', '/api/org-keys', authed(b.session, { body: { label: `k-${suffix()}`, capabilities: ['agents:create'] } }));
    const key = (issued.json() as { key: string }).key;
    const viaKey = (domain: string) =>
      call(deps, 'POST', '/org-api/v1/agents', { headers: { authorization: `Bearer ${key}` }, body: { name: 'ci', localPart: `ci-${suffix()}`, domain } });
    const keyForeign = await viaKey(a.domain);
    expect([keyForeign.statusCode, errorOf(keyForeign)]).toEqual([400, 'domain_not_verified']);
    const own = await viaKey(b.domain);
    expect(own.statusCode, own.body).toBe(201);
    expect((own.json() as { agent: AgentBody }).agent.address?.endsWith(`@${b.domain}`)).toBe(true);
    const leaked = await owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM agent_addresses WHERE domain = $1`, [a.domain]);
    expect(leaked.rows[0]?.n).toBe(0);
  });

  it('② 잠든 앵커는 어디에도 나오지 않는다 — 목록 · 한 개 · 주소 목록 · 정책 소스 · 답장 기본 From · 운영자 정지 목록 · 수신 조회', async () => {
    const a = await org();
    const agent = await createAgent(a.session, { localPart: `quiet-${suffix()}`, domain: a.domain });
    const anchor = await anchorOf(agent.id);
    const everywhere: string[] = [];
    everywhere.push((await call(deps, 'GET', '/api/agents', authed(a.session))).body);
    everywhere.push((await call(deps, 'GET', '/api/agents', authed(a.session, { query: 'limit=50' }))).body);
    everywhere.push((await call(deps, 'GET', `/api/agents/${agent.id}`, authed(a.session))).body);
    const items = await listAddresses(a.session, agent.id);
    everywhere.push(JSON.stringify(items));
    expect(items.map((item) => [item.address, item.primary, item.anchor])).toEqual([[agent.address, true, false]]);
    // 앵커 로컬파트로 검색해도 나오지 않는다.
    const searched = await call(deps, 'GET', '/api/agents', authed(a.session, { query: `q=${encodeURIComponent(anchor.address.split('@')[0] ?? '')}` }));
    expect(searched.statusCode, searched.body).toBe(200);
    expect((searched.json() as { items: unknown[] }).items).toEqual([]);

    const loaded = await createPostgresPolicySource(app).load({ agentId: toAgentId(agent.id), recipients: [], now: new Date(), threadId: null, releaseApprovalId: null });
    expect(loaded.addresses.map((row) => row.address)).toEqual([agent.address]);
    expect(loaded.primaryAddress).toBe(agent.address);
    expect(loaded.inactiveAddresses).toContain(anchor.address);

    // 앵커로 들어온 옛 메일(앵커가 깨어 있을 때 받은)에 답해도 From 은 잠든 앵커가 아니라 유효 대표다.
    const lookup = createPostgresReplyTargetLookup(app as unknown as Queryable);
    expect((await lookup.find(agent.id, await inboundTo(agent.id, anchor.address)))?.defaultFromAddress).toBe(agent.address);

    await owner.query(`UPDATE agents SET status = 'suspended', suspended_by = 'operator' WHERE id = $1`, [agent.id]);
    const kill = (await readKillSwitch(opsDb)).body as { suspendedAgents: { id: string; address: string | null }[] };
    expect(kill.suspendedAgents.find((row) => row.id === agent.id)?.address).toBe(agent.address);
    everywhere.push(JSON.stringify(kill));

    for (const text of everywhere) expect(text).not.toContain(anchor.address);
    expect(await createPostgresInboundStore(app).findAgentsByAddresses([anchor.address])).toEqual([]);
    expect((await createPostgresInboundStore(app).findAgentsByAddresses([agent.address ?? ''])).map((match) => match.agentId)).toEqual([agent.id]);
  });

  it('③ 별칭 domain · 대표 고르기 — 재생 · @atmark.ai 별칭 400 · 남의 주소 404 · 앵커 {anchor:true} · 감사 agent.primary.set · 속도 상한 429', async () => {
    const a = await org();
    const agent = await createAgent(a.session, { localPart: `pick-${suffix()}` });
    const atmark = agent.address ?? '';
    const custom = await call(deps, 'POST', `/api/agents/${agent.id}/aliases`, authed(a.session, { body: { localPart: `pick-${suffix()}`, domain: a.domain } }));
    expect(custom.statusCode, custom.body).toBe(201);
    const customItem = (custom.json() as { item: AddressItem }).item;
    const plainAlias = await call(deps, 'POST', `/api/agents/${agent.id}/aliases`, authed(a.session, { body: { localPart: `plain-${suffix()}` } }));
    const plainItem = (plainAlias.json() as { item: AddressItem }).item;
    // 확인 안 된 도메인의 별칭은 400(DB 가드와 같은 코드).
    const unverified = await call(deps, 'POST', `/api/agents/${agent.id}/aliases`, authed(a.session, { body: { localPart: `u-${suffix()}`, domain: `agents.cd${suffix()}.com` } }));
    expect([unverified.statusCode, errorOf(unverified)]).toEqual([400, 'domain_not_verified']);

    const picked = await choose(a.session, agent.id, { addressId: customItem.id });
    expect(picked.statusCode, picked.body).toBe(200);
    expect(picked.json()).toEqual({ primary: { addressId: customItem.id, address: customItem.address }, replayed: false });
    expect((await choose(a.session, agent.id, { addressId: customItem.id })).json()).toMatchObject({ replayed: true });
    expect(((await call(deps, 'GET', `/api/agents/${agent.id}`, authed(a.session))).json() as AgentBody).address).toBe(customItem.address);
    // 이제 앵커는 잠들었다 — 주소 목록에 없다.
    expect((await listAddresses(a.session, agent.id)).map((item) => item.address)).not.toContain(atmark);

    const notEligible = await choose(a.session, agent.id, { addressId: plainItem.id });
    expect([notEligible.statusCode, errorOf(notEligible)]).toEqual([400, 'primary_not_eligible']);
    const other = await createAgent(a.session, { localPart: `other-${suffix()}` });
    const foreign = await choose(a.session, agent.id, { addressId: (await anchorOf(other.id)).id });
    expect([foreign.statusCode, errorOf(foreign)]).toEqual([404, 'address_not_found']);
    const bothKeys = await choose(a.session, agent.id, { addressId: customItem.id, anchor: true });
    expect([bothKeys.statusCode, errorOf(bothKeys)]).toEqual([400, 'invalid_body']);

    // "@atmark.ai 주소 켜기" — 잠든 앵커의 id 를 몰라도 고른다.
    const back = await choose(a.session, agent.id, { anchor: true });
    expect(back.json()).toMatchObject({ primary: { address: atmark }, replayed: false });
    const audit = await owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM owner_actions WHERE organization_id = $1 AND action = 'agent.primary.set' AND target_id = $2`, [
      a.id,
      agent.id,
    ]);
    expect(audit.rows[0]?.n).toBe(2);

    // 속도 상한 — 에이전트 24시간 5(원인 owner).
    for (let i = 2; i < PRIMARY_CHANGES_PER_AGENT_PER_DAY; i += 1) {
      expect((await choose(a.session, agent.id, i % 2 === 0 ? { addressId: customItem.id } : { anchor: true })).statusCode).toBe(200);
    }
    // 마지막 선택이 고객 별칭이다 — 같은 것을 다시 고르면 재생(상한을 먹지 않는다), 앵커로 바꾸면 여섯째라 429.
    expect((await choose(a.session, agent.id, { addressId: customItem.id })).json()).toMatchObject({ replayed: true });
    const limited = await choose(a.session, agent.id, { anchor: true });
    expect([limited.statusCode, errorOf(limited)]).toEqual([429, 'primary_change_rate_limited']);
  });

  it('④ 유효 대표인 별칭은 폐기 409 address_is_primary · 대표 고르기와 폐기가 겹쳐도 대표가 NULL 이 되지 않는다', async () => {
    const a = await org();
    const agent = await createAgent(a.session, { localPart: `ret-${suffix()}`, domain: a.domain });
    const [item] = await listAddresses(a.session, agent.id);
    const retire = (addressId: string) => call(deps, 'POST', `/api/agents/${agent.id}/aliases/${addressId}/retire`, authed(a.session, { body: {} }));
    const denied = await retire(item?.id ?? '');
    expect([denied.statusCode, errorOf(denied)]).toEqual([409, 'address_is_primary']);

    for (let round = 0; round < 3; round += 1) {
      // 새 고객 별칭을 만들고, "그것을 대표로 고르기" 와 "그것을 폐기" 를 동시에.
      const added = await call(deps, 'POST', `/api/agents/${agent.id}/aliases`, authed(a.session, { body: { localPart: `race-${suffix()}`, domain: a.domain } }));
      expect(added.statusCode, added.body).toBe(201);
      const target = (added.json() as { item: AddressItem }).item;
      const [picked, retired] = await Promise.all([choose(a.session, agent.id, { addressId: target.id }), retire(target.id)]);
      // 둘 중 하나만 이긴다: 먼저 고르면 폐기는 409 · 먼저 폐기하면 고르기는 400(P0A08).
      expect([[200, 409], [400, 200]]).toContainEqual([picked.statusCode, retired.statusCode]);
      const effective = await owner.query<{ address: string | null }>('SELECT atmark_agent_primary_address($1) AS address', [agent.id]);
      expect(effective.rows[0]?.address).not.toBeNull();
    }
  });

  it('⑤ 여권 F-7 — 주소 = 유효 대표 · domain_verified · 잠든 앵커는 문서 · 공개 조회에 없다 · 바뀔 때만 새 버전 · 주소 없음 모양', async () => {
    const a = await org();
    const agent = await createAgent(a.session, { localPart: `pp-${suffix()}`, domain: a.domain });
    const anchor = await anchorOf(agent.id);
    expect((await call(deps, 'POST', `/api/agents/${agent.id}/identity/publish`, authed(a.session))).statusCode).toBe(202);
    let clock = Date.now() + 1000;
    const tick = async (): Promise<void> => {
      clock += 2000;
      await runPassportPublisherTick(
        {
          db: signerDb,
          signer: createPassportSigner({ kind: 'local-dev', directory: keyDir, env: {} }),
          documents: { put: () => Promise.resolve() },
          cdn: { invalidate: () => Promise.resolve() },
          now: () => new Date(clock),
        },
        { agentIds: [toAgentId(agent.id)] },
      );
    };
    const current = async (): Promise<{ version: number; subject: { address: string | null; attestations: { type: string; value: unknown; domain?: string | null }[] } }> => {
      const row = await owner.query<{ version: number; document: string }>(
        `SELECT p.version, d.document FROM passports p JOIN passport_documents d ON d.passport_id = p.id WHERE p.agent_id = $1 AND p.superseded_at IS NULL`,
        [agent.id],
      );
      const found = row.rows[0];
      if (found === undefined) throw new Error('여권 문서가 없다');
      return { version: found.version, subject: (JSON.parse(found.document) as { credentialSubject: never }).credentialSubject };
    };
    await tick();
    const first = await current();
    expect(first.subject.address).toBe(agent.address);
    expect(first.subject.attestations.map((attestation) => attestation.type)).toEqual([
      'domain_verified',
      'no_policy_violations',
      'account_age_bucket',
      'successful_conversations_bucket',
    ]);
    expect(first.subject.attestations[0]).toMatchObject({ value: true, domain: a.domain });
    const directory = createPostgresIdentityDirectory(app);
    expect(await directory.findByAddress(anchor.address)).toBeNull();
    expect((await directory.findByAddress(agent.address ?? ''))?.address).toBe(agent.address);
    const documents = await owner.query<{ document: string }>(
      `SELECT d.document FROM passports p JOIN passport_documents d ON d.passport_id = p.id WHERE p.agent_id = $1`,
      [agent.id],
    );
    for (const row of documents.rows) expect(row.document).not.toContain(anchor.address);

    // plan_limit 정지 — 여권은 참 유지 → 재서명은 내용이 같아 새 버전 없음.
    await owner.query(`UPDATE custom_domains SET status = 'suspended', suspended_reason = 'plan_limit', suspended_at = now() WHERE id = $1`, [a.domainId]);
    await tick();
    expect((await current()).version).toBe(first.version);
    // 평판 정지 — 주소는 그대로, domain_verified 거짓 → 새 버전.
    await owner.query(`UPDATE custom_domains SET suspended_reason = 'reputation' WHERE id = $1`, [a.domainId]);
    await tick();
    const reputation = await current();
    expect(reputation.version).toBe(first.version + 1);
    expect(reputation.subject.address).toBe(agent.address);
    expect(reputation.subject.attestations[0]).toMatchObject({ type: 'domain_verified', value: false, domain: a.domain });
    // 소유 상실(운영자 롤로 사유를 바꾼다) → retire_on_loss 가 별칭을 폐기 → 대표 무효 → "주소 없음" 여권(칸은 null · 순서 그대로).
    await owner.query(`UPDATE custom_domains SET suspended_reason = 'ownership_lost', removal_due_at = now() + interval '14 days' WHERE id = $1`, [a.domainId]);
    await tick();
    const lost = await current();
    expect(lost.version).toBe(reputation.version + 1);
    expect(lost.subject.address).toBeNull();
    expect(lost.subject.attestations.map((attestation) => attestation.type)).toEqual(first.subject.attestations.map((attestation) => attestation.type));
    expect(lost.subject.attestations[0]).toMatchObject({ type: 'domain_verified', value: false, domain: null });
    expect(await directory.findByAddress(agent.address ?? '')).toBeNull();
    expect(await directory.findByAddress(anchor.address)).toBeNull();
    // 콘솔도 "주소 없음".
    expect(((await call(deps, 'GET', `/api/agents/${agent.id}`, authed(a.session))).json() as AgentBody).address).toBeNull();
  });
  it('⑥ #15 L2 — 허용 목록에서 빠진 조직은 고객 주소를 새로 발급 · 대표로 고르지 못한다(403) · 앵커로 되돌리기와 이미 있는 주소는 그대로', async () => {
    const a = await org();
    const agent = await createAgent(a.session, { localPart: `ff-${suffix()}` });
    const alias = await call(deps, 'POST', `/api/agents/${agent.id}/aliases`, authed(a.session, { body: { localPart: `ff-${suffix()}`, domain: a.domain } }));
    expect(alias.statusCode, alias.body).toBe(201);
    const aliasId = (alias.json() as { item: AddressItem }).item.id;
    await owner.query('DELETE FROM org_features WHERE organization_id = $1', [a.id]);
    const cases = [
      await call(deps, 'POST', `/api/agents/${agent.id}/aliases`, authed(a.session, { body: { localPart: `ff2-${suffix()}`, domain: a.domain } })),
      await call(deps, 'POST', '/api/agents', authed(a.session, { body: { name: 'off', localPart: `off-${suffix()}`, domain: a.domain } })),
      await call(deps, 'POST', '/api/agents', authed(a.session, { body: { name: 'off', localPart: `off-${suffix()}`, domain: a.domain, primary: 'custom' } })),
      await choose(a.session, agent.id, { addressId: aliasId }),
    ];
    for (const denied of cases) expect([denied.statusCode, errorOf(denied)], denied.body).toEqual([403, 'feature_not_enabled']);
    // 이미 있는 주소는 남는다(사용 여부는 관문이 판단) · 앵커로 되돌리기는 재생으로도 된다.
    expect((await listAddresses(a.session, agent.id)).map((item) => item.id)).toContain(aliasId);
    expect((await choose(a.session, agent.id, { anchor: true })).statusCode).toBe(200);
  });

  it('⑦ #15 L4 — 변경 상한을 다 쓴 뒤 도메인을 잃어 "주소 없음" 이면 앵커로 되돌리기는 된다(앞으로 고객 주소 고르기는 여전히 429)', async () => {
    const a = await org();
    const agent = await createAgent(a.session, { localPart: `lim-${suffix()}` });
    const alias = await call(deps, 'POST', `/api/agents/${agent.id}/aliases`, authed(a.session, { body: { localPart: `lim-${suffix()}`, domain: a.domain } }));
    const aliasId = (alias.json() as { item: AddressItem }).item.id;
    for (let i = 0; i < PRIMARY_CHANGES_PER_AGENT_PER_DAY; i += 1) {
      expect((await choose(a.session, agent.id, i % 2 === 0 ? { addressId: aliasId } : { anchor: true })).statusCode).toBe(200);
    }
    // 마지막 선택 = 고객 별칭(5번째) · 상한 소진. 대표가 살아 있을 때 앵커로 바꾸기는 여전히 429.
    const limited = await choose(a.session, agent.id, { anchor: true });
    expect([limited.statusCode, errorOf(limited)]).toEqual([429, 'primary_change_rate_limited']);
    // 소유 상실 → retire_on_loss → 대표 NULL.
    await owner.query(`UPDATE custom_domains SET status = 'suspended', suspended_reason = 'ownership_lost', suspended_at = now(), removal_due_at = now() + interval '14 days' WHERE id = $1`, [
      a.domainId,
    ]);
    expect(((await call(deps, 'GET', `/api/agents/${agent.id}`, authed(a.session))).json() as AgentBody).address).toBeNull();
    const restored = await choose(a.session, agent.id, { anchor: true });
    expect(restored.statusCode, restored.body).toBe(200);
    expect(((await call(deps, 'GET', `/api/agents/${agent.id}`, authed(a.session))).json() as AgentBody).address).toBe(agent.address);
  });

  it('⑧ 고객 도메인 대표 에이전트에도 @atmark.ai 별칭을 단다(201 — 진윤겸 결정) · 목록에 별칭은 보이고 잠든 앵커는 숨는다', async () => {
    const a = await org();
    const agent = await createAgent(a.session, { localPart: `cp-${suffix()}`, domain: a.domain });
    const anchor = await anchorOf(agent.id);
    const local = `desk-${suffix()}`;
    const added = await call(deps, 'POST', `/api/agents/${agent.id}/aliases`, authed(a.session, { body: { localPart: local } }));
    expect(added.statusCode, added.body).toBe(201);
    expect((added.json() as { item: AddressItem }).item.address).toBe(`${local}@atmark.ai`);
    const items = await listAddresses(a.session, agent.id);
    expect(items.map((item) => [item.address, item.primary, item.anchor])).toEqual([
      [agent.address, true, false],
      [`${local}@atmark.ai`, false, false],
    ]);
    expect(JSON.stringify(items)).not.toContain(anchor.address);
    // 대표는 그대로 고객 도메인 주소다(별칭을 달아도 앵커가 깨지 않는다).
    expect(((await call(deps, 'GET', `/api/agents/${agent.id}`, authed(a.session))).json() as AgentBody).address).toBe(agent.address);
  });
});
