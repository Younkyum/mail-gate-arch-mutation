/** 적대적 검증(감시 탭 A) — 콘솔 라우터 지반(조직 · 세션 · 역할). 테스트가 아니다. */

import type { Pool } from 'pg';

import type { AdminDependencies } from '../../../src/admin/context';
import { testPool } from '../db/support/harness';
import { consumerDeps, deliver, eml, newObjectStore, newSesMessageId } from '../inbound/support';
import { adminDeps, adminRolePool, authed, call, login, loginMailerPool, newOrganization, ownerPool, suffix, userIdOf, type Session } from '../admin/support';
import { bareAddress, rowFor, type MsgRow, type ReceiveOptions } from './watch-support';
import type { InjectionScanInput, InjectionScanResult } from '../../../src/security/injection/scanner';

export interface AdminWorld {
  owner: Pool;
  admin: Pool;
  mailer: Pool;
  deps: AdminDependencies;
}

export function adminWorld(): AdminWorld {
  const owner = ownerPool();
  const admin = adminRolePool();
  const mailer = loginMailerPool();
  return { owner, admin, mailer, deps: adminDeps(admin) };
}

export async function closeAdminWorld(w: AdminWorld): Promise<void> {
  await w.owner.end();
  await w.admin.end();
  await w.mailer.end();
}

export interface AdminFixture {
  readonly orgId: string;
  readonly organizationId: string;
  readonly session: Session;
  readonly agentId: string;
  readonly address: string;
}

export async function adminFixture(w: AdminWorld): Promise<AdminFixture> {
  const org = await newOrganization(w.owner);
  await w.owner.query(`UPDATE organizations SET review_status = 'active' WHERE id = $1`, [org.id]);
  const session = await login(w.deps, w.mailer, org);
  const agent = await createAgent(w, session, 'adv');
  return { orgId: org.id, organizationId: org.id, session, ...agent };
}

async function createAgent(w: AdminWorld, session: Session, name: string): Promise<{ agentId: string; address: string }> {
  const created = await call(w.deps, 'POST', '/api/agents', authed(session, { body: { name, localPart: `adv-${suffix()}` } }));
  if (created.statusCode !== 201) throw new Error(`agent create ${String(created.statusCode)} ${created.body}`);
  const agent = (created.json() as { agent: { id: string; address: string } }).agent;
  return { agentId: agent.id, address: agent.address };
}

/** 같은 조직에 에이전트 하나 더(콘솔 API). */
export function addAgent(w: AdminWorld, f: AdminFixture): Promise<{ agentId: string; address: string }> {
  return createAgent(w, f.session, 'adv2');
}

export async function asRole(w: AdminWorld, f: AdminFixture, role: 'admin' | 'member'): Promise<Session> {
  const email = `adv-${role}-${suffix()}@example.com`;
  await w.owner.query('INSERT INTO users (email) VALUES ($1)', [email]);
  const userId = await userIdOf(w.owner, email);
  await w.owner.query(`INSERT INTO memberships (user_id, organization_id, role, joined_via) VALUES ($1, $2, $3, 'invite')`, [userId, f.orgId, role]);
  return login(w.deps, w.mailer, { id: f.orgId, ownerEmail: email });
}

export const SUBJECT_SENTINEL = 'ADV-SUBJ-SENTINEL-7Q';
export const BODY_SENTINEL = 'ADV-BODY-SENTINEL-7Q';

/** 콘솔 에이전트(조직 소속)에게 한 통. */
export async function receiveAdmin(
  f: { agentId: string; address: string },
  scan: (input: InjectionScanInput) => InjectionScanResult,
  options: ReceiveOptions = {},
): Promise<{ id: string; ses: string; row: MsgRow }> {
  const from = options.from ?? `mallory-${suffix()}@partner.example`;
  const ses = newSesMessageId();
  const outcome = await deliver(
    { ...consumerDeps(testPool(), newObjectStore()), scanner: scan },
    eml({ from, subject: options.subject ?? SUBJECT_SENTINEL, text: options.text ?? BODY_SENTINEL, ...(options.extraHeaders === undefined ? {} : { extraHeaders: options.extraHeaders }) }),
    { sesMessageId: ses, recipients: options.recipients ?? [f.address], commonFrom: options.commonFrom ?? [bareAddress(from)], dmarc: options.dmarc ?? 'PASS' },
  );
  if (outcome !== 'stored') throw new Error(`수신 결말 ${outcome}`);
  const row = await rowFor(f.agentId, ses);
  if (row === null) throw new Error('행이 없다');
  return { id: row.id, ses, row };
}

export { authed, call };
export type { Session };
