/** 자가 등록 적대 시험 공용 — 조직 · 소유자 세션 · 부모 에이전트(+ agents:enroll 토큰) · API 세계. 테스트가 아니다. */

import type { Pool } from 'pg';

import type { PlanCode } from '../../../src/billing/plans';
import { hashAgentToken } from '../../../src/identity/agent-token';
import { login, newOrganization, type Session } from '../admin/support';
import { api, apiWorldFor, authed, call, consoleKit, suffix, type ApiWorld } from './watch-d-support';

export interface EnrollWorld {
  readonly orgId: string;
  readonly ownerEmail: string;
  readonly owner: Session;
  readonly parentId: string;
  readonly parentAddress: string;
  readonly enrollToken: string;
  readonly w: ApiWorld;
}

export async function enrollWorld(options: { enable?: boolean; plan?: PlanCode | null; cap?: number } = {}): Promise<EnrollWorld> {
  const kit = consoleKit();
  const org = await newOrganization(kit.owner, options.plan === undefined ? 'beta' : options.plan);
  await kit.owner.query(`UPDATE organizations SET review_status = 'active' WHERE id = $1`, [org.id]);
  const owner = await login(kit.deps, kit.mailer, org);
  const local = `pa-${suffix()}`;
  const created = await call(kit.deps, 'POST', '/api/agents', authed(owner, { body: { name: 'parent', localPart: local } }));
  if (created.statusCode !== 201) throw new Error(`parent ${String(created.statusCode)} ${created.body}`);
  const parent = (created.json() as { agent: { id: string; address?: string } }).agent;
  const parentAddress = parent.address ?? `${local}@atmark.ai`;
  const issued = await call(
    kit.deps,
    'POST',
    `/api/agents/${parent.id}/tokens`,
    authed(owner, { body: { label: 'enroll', capabilities: ['messages:send', 'messages:read', 'agent:read_self', 'agents:enroll'] } }),
  );
  if (issued.statusCode !== 201) throw new Error(`token ${String(issued.statusCode)} ${issued.body}`);
  const enrollToken = (issued.json() as { token: string }).token;
  if (options.enable !== false) {
    const body: Record<string, unknown> = { agentSelfEnroll: true };
    if (options.cap !== undefined) body['enrollDailyCap'] = options.cap;
    const on = await call(kit.deps, 'PATCH', '/api/watch/settings', authed(owner, { body }));
    if (on.statusCode !== 200) throw new Error(`settings ${String(on.statusCode)} ${on.body}`);
  }
  const w = await apiWorldFor({ organizationId: org.id, agentId: parent.id as never, address: parentAddress, policyVersionId: '' }, enrollToken);
  return { orgId: org.id, ownerEmail: org.ownerEmail, owner, parentId: parent.id, parentAddress, enrollToken, w };
}

/** `POST /v1/agents` — 에이전트가 부른다. */
export function enrollCall(e: EnrollWorld, body: unknown, token: string = e.enrollToken) {
  return api(e.w, 'POST', '/v1/agents', { token, body });
}

export async function agentCount(pool: Pool, orgId: string): Promise<number> {
  return (await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM agents WHERE organization_id = $1', [orgId])).rows[0]?.n ?? -1;
}

export async function slotRows(pool: Pool, orgId: string): Promise<{ outcome: string; child_agent_id: string | null }[]> {
  return (await pool.query<{ outcome: string; child_agent_id: string | null }>('SELECT outcome, child_agent_id FROM agent_enrollments WHERE organization_id = $1 ORDER BY created_at, id', [orgId])).rows;
}

export { hashAgentToken };
