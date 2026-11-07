#!/usr/bin/env tsx
/**
 * scripts/admin/domain.ts — 고객 도메인 **운영자 명령**(ADR-0014 결정 12 · 14 · 계획 §3.8 · §3.14 · 런북 custom-domains). 소유자 롤로만 붙는다 — DB 전이
 * 가드가 reputation · operator 정지를 **소유자 롤에게만** 풀게 한다(틱도 못 푼다, 보안 M3).
 *
 *   pnpm admin:domain --unfreeze --domain <도메인 행 id> [--yes]
 *   pnpm admin:domain --suspend --domain <도메인 행 id> [--yes]
 *   pnpm admin:domain --suspend-all-customer [--yes]
 *   pnpm admin:domain --revoke-all-policies [--region ap-northeast-2] [--yes]
 *
 *   - `--unfreeze` — `suspended(reputation | operator)` → verified(정책 동기화는 전이 가드가 요청한다 — 다음 틱이 다시 만든다). 같은 도메인 **또는 같은
 *     apex** 에 남은 **동결 톰스톤**(`frozen_reason_at_removal` — 동결된 채 제거된 행)도 함께 지운다(재리뷰 M1 — 지우지 않으면 다시 등록할 수 없다).
 *     removed 행의 id 를 주면 톰스톤만 지운다.
 *   - `--suspend` — verified(또는 더 약한 사유로 정지된) 행을 `suspended(operator)` 로(정책은 다음 틱이 지운다 · 관문은 커밋 즉시 막는다 · 알림 한 통).
 *   - `--suspend-all-customer` — 모든 verified · suspended(operator 아님) 행을 `suspended(operator)` 로. 계정 평판 사고 · domain-control 탈취의 DB 정합
 *     (계획 §3.14 ②). pending · verifying 은 정지 전이가 없다 — 수를 알리니 확인 틱(Scheduler)을 먼저 끈다.
 *   - `--revoke-all-policies` — **운영자 AWS 자격**으로 관리 표시(`atmark:managed=customer-domain`)가 있는 고객 identity 의 `atmark-sender-*` 정책을 지운다(계획 §3.14
 *     ② — 고객 도메인 발신이 AWS 층에서 모두 멈춘다, atmark.ai 영향 없음). DB 는 건드리지 않는다 — 이어서 `--suspend-all-customer`.
 * 운영 DB 면 변경 전 확인(`--yes`).
 */

import { parseArgs } from 'node:util';

import type { Pool } from 'pg';

import { IDENTITY_MANAGED_TAG, IDENTITY_MANAGED_TAG_VALUE, IDENTITY_POLICY_NAME_PREFIX } from '../../src/domains/contract';
import { createSesIdentityControl, type SesIdentityControl } from '../../src/mail/transport/ses-identity';
import { AdminInputError, confirmProduction, EXIT_OK, isMain, runAdminMain, withAdminConnection, type AdminDeps, type TargetInfo } from './common';

const USAGE = [
  'pnpm admin:domain --unfreeze --domain <도메인 행 id> [--yes]',
  'pnpm admin:domain --suspend --domain <도메인 행 id> [--yes]',
  'pnpm admin:domain --suspend-all-customer [--yes]',
  'pnpm admin:domain --revoke-all-policies [--region ap-northeast-2] [--yes]',
].join('\n');

const DOMAIN_ROW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DEFAULT_REGION = 'ap-northeast-2';

export type DomainCommand =
  | { readonly kind: 'unfreeze'; readonly domainId: string; readonly yes: boolean }
  | { readonly kind: 'suspend'; readonly domainId: string; readonly yes: boolean }
  | { readonly kind: 'suspend-all-customer'; readonly yes: boolean }
  | { readonly kind: 'revoke-all-policies'; readonly region: string; readonly yes: boolean };

export interface DomainCliDeps extends AdminDeps {
  /** SES 제어면(운영자 자격) — 테스트는 가짜를 준다. */
  readonly ses?: (region: string) => Pick<SesIdentityControl, 'listIdentities' | 'getIdentity' | 'deletePolicy'>;
}

function domainId(raw: string | undefined): string {
  const id = raw?.trim().toLowerCase() ?? '';
  if (!DOMAIN_ROW_ID.test(id)) throw new AdminInputError(`--domain 은 도메인 행 id(uuid)다.\n${USAGE}`);
  return id;
}

/** argv → 명령. 형식 오류는 접속 전에 던진다(exit 2). `null` 이면 도움말. */
export function parseDomainArgs(argv: readonly string[]): DomainCommand | null {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      unfreeze: { type: 'boolean', default: false },
      suspend: { type: 'boolean', default: false },
      'suspend-all-customer': { type: 'boolean', default: false },
      'revoke-all-policies': { type: 'boolean', default: false },
      domain: { type: 'string' },
      region: { type: 'string' },
      yes: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (values.help) return null;
  const modes = [values.unfreeze, values.suspend, values['suspend-all-customer'], values['revoke-all-policies']].filter(Boolean).length;
  if (modes !== 1) throw new AdminInputError(`--unfreeze · --suspend · --suspend-all-customer · --revoke-all-policies 중 하나만.\n${USAGE}`);
  if (values.unfreeze) return { kind: 'unfreeze', domainId: domainId(values.domain), yes: values.yes };
  if (values.suspend) return { kind: 'suspend', domainId: domainId(values.domain), yes: values.yes };
  if (values['suspend-all-customer']) return { kind: 'suspend-all-customer', yes: values.yes };
  const region = values.region?.trim() ?? DEFAULT_REGION;
  if (!/^[a-z]{2}-[a-z]+-\d$/.test(region)) throw new AdminInputError(`--region 모양이 아니다: ${region}`);
  return { kind: 'revoke-all-policies', region, yes: values.yes };
}

export async function domain(argv: readonly string[], deps: DomainCliDeps): Promise<number> {
  const command = parseDomainArgs(argv);
  if (command === null) {
    deps.io.out(USAGE);
    return EXIT_OK;
  }
  if (command.kind === 'revoke-all-policies') return revokeAllPolicies(command, deps);
  return withAdminConnection(deps, ({ pool, target }) => runDomain(pool, target, command, deps));
}

/** 명령 하나를 이 풀(소유자 롤)에서. 테스트는 롤백할 트랜잭션의 풀을 준다. */
export async function runDomain(pool: Pool, target: TargetInfo, command: Exclude<DomainCommand, { kind: 'revoke-all-policies' }>, deps: AdminDeps): Promise<number> {
  if (command.kind === 'suspend-all-customer') return suspendAll(pool, target, command, deps);
  const row = await pool.query<{ id: string; organization_id: string; domain: string; registrable_domain: string; status: string; suspended_reason: string | null }>(
    'SELECT id::text AS id, organization_id::text AS organization_id, domain, registrable_domain, status, suspended_reason FROM custom_domains WHERE id = $1',
    [command.domainId],
  );
  const found = row.rows[0];
  if (found === undefined) throw new AdminInputError(`도메인 행이 없다: ${command.domainId}`, 'domain_not_found');
  if (command.kind === 'suspend') {
    if (found.status !== 'verified' && !(found.status === 'suspended' && found.suspended_reason !== 'operator')) {
      throw new AdminInputError(`정지할 수 없는 상태다(${found.status}${found.suspended_reason === null ? '' : `/${found.suspended_reason}`}) — verified · suspended 만.`);
    }
    await confirmProduction(target, `도메인 ${found.id} 운영자 정지`, command.yes, deps.io);
    await pool.query(
      `UPDATE custom_domains SET status = 'suspended', suspended_reason = 'operator', suspended_at = now(), removal_due_at = NULL WHERE id = $1`,
      [found.id],
    );
    await pool.query(
      `INSERT INTO domain_notices (domain_id, organization_id, kind, event_key) VALUES ($1, $2, 'suspended', $3) ON CONFLICT (domain_id, kind, event_key) DO NOTHING`,
      [found.id, found.organization_id, `operator:${String(Math.floor(Date.now() / 1000))}`],
    );
    deps.io.out(`domain ${found.id} suspended operator`);
    return EXIT_OK;
  }
  // unfreeze
  const frozen = found.status === 'suspended' && (found.suspended_reason === 'reputation' || found.suspended_reason === 'operator');
  if (!frozen && found.status !== 'removed') {
    throw new AdminInputError(`동결 상태가 아니다(${found.status}${found.suspended_reason === null ? '' : `/${found.suspended_reason}`}) — reputation · operator 정지 또는 동결된 채 제거된 행만.`);
  }
  await confirmProduction(target, `도메인 ${found.id} 동결 해제(같은 도메인·apex 톰스톤 포함)`, command.yes, deps.io);
  if (frozen) {
    await pool.query(
      `UPDATE custom_domains SET status = 'verified', suspended_reason = NULL, consecutive_definitive_failures = 0, next_check_at = now() WHERE id = $1`,
      [found.id],
    );
  }
  const cleared = await pool.query(
    `UPDATE custom_domains SET frozen_reason_at_removal = NULL
      WHERE (domain = $1 OR registrable_domain = $2) AND frozen_reason_at_removal IS NOT NULL`,
    [found.domain, found.registrable_domain],
  );
  deps.io.out(`domain ${found.id} ${frozen ? 'unfrozen' : 'unchanged'} tombstones_cleared=${String(cleared.rowCount ?? 0)}`);
  return EXIT_OK;
}

async function suspendAll(pool: Pool, target: TargetInfo, command: Extract<DomainCommand, { kind: 'suspend-all-customer' }>, deps: AdminDeps): Promise<number> {
  const counts = await pool.query<{ status: string; n: number }>(`SELECT status, count(*)::int AS n FROM custom_domains WHERE status <> 'removed' GROUP BY status ORDER BY status`);
  for (const row of counts.rows) deps.io.err(`  ${row.status}: ${String(row.n)}`);
  await confirmProduction(target, '모든 고객 도메인(verified · operator 아닌 suspended) 운영자 정지', command.yes, deps.io);
  const suspended = await pool.query<{ id: string; organization_id: string }>(
    `UPDATE custom_domains SET status = 'suspended', suspended_reason = 'operator', suspended_at = now(), removal_due_at = NULL
      WHERE status = 'verified' OR (status = 'suspended' AND suspended_reason <> 'operator')
      RETURNING id::text AS id, organization_id::text AS organization_id`,
  );
  const eventKey = `operator:${String(Math.floor(Date.now() / 1000))}`;
  for (const row of suspended.rows) {
    await pool.query(
      `INSERT INTO domain_notices (domain_id, organization_id, kind, event_key) VALUES ($1, $2, 'suspended', $3) ON CONFLICT (domain_id, kind, event_key) DO NOTHING`,
      [row.id, row.organization_id, eventKey],
    );
  }
  deps.io.out(`suspended ${String(suspended.rowCount ?? 0)}`);
  const inFlight = counts.rows.filter((row) => row.status === 'pending' || row.status === 'verifying').reduce((sum, row) => sum + row.n, 0);
  if (inFlight > 0) deps.io.err(`⚠ pending · verifying ${String(inFlight)}개는 정지 전이가 없다 — 확인 틱(Scheduler atmark-domain-recheck)을 끄고 런북대로.`);
  return EXIT_OK;
}

/** atmark.ai 와 그 하위 도메인 — 손대지 않는다. */
export function isPlatformIdentity(identity: string): boolean {
  const name = identity.toLowerCase();
  const domain = name.includes('@') ? name.slice(name.lastIndexOf('@') + 1) : name;
  return domain === 'atmark.ai' || domain.endsWith('.atmark.ai');
}

async function revokeAllPolicies(command: Extract<DomainCommand, { kind: 'revoke-all-policies' }>, deps: DomainCliDeps): Promise<number> {
  const ses = (deps.ses ?? createSesIdentityControl)(command.region);
  const identities = (await ses.listIdentities()).filter((identity) => !isPlatformIdentity(identity));
  deps.io.err(`atmark.ai 밖 identity ${String(identities.length)}개 — 관리 표시(${IDENTITY_MANAGED_TAG}=${IDENTITY_MANAGED_TAG_VALUE})가 있는 것의 ${IDENTITY_POLICY_NAME_PREFIX}* 정책만 지운다.`);
  if (!command.yes) {
    if (!deps.io.interactive) throw new AdminInputError('SES 자원 정책 삭제는 확인이 필요하다 — 대화형 터미널에서 실행하거나 --yes 를 준다.');
    const answer = await deps.io.ask('계속하려면 yes 를 입력: ');
    if (answer.trim() !== 'yes') throw new AdminInputError('취소했다 — 아무것도 바꾸지 않았다.');
  }
  let deleted = 0;
  let managed = 0;
  let foreign = 0;
  for (const identity of identities) {
    const snapshot = await ses.getIdentity(identity);
    if (snapshot === null) continue;
    // #13 보안 리뷰 L2 — 우리가 관리하는 고객 identity(태그)의 우리 이름(`atmark-sender-`) 정책만. 그 밖은 사람이 판단한다(수만 알린다).
    if (snapshot.tags[IDENTITY_MANAGED_TAG] !== IDENTITY_MANAGED_TAG_VALUE) {
      if (Object.keys(snapshot.policies).length > 0) foreign += 1;
      continue;
    }
    managed += 1;
    for (const name of Object.keys(snapshot.policies).sort()) {
      if (!name.startsWith(IDENTITY_POLICY_NAME_PREFIX)) {
        foreign += 1;
        continue;
      }
      await ses.deletePolicy(identity, name);
      deleted += 1;
    }
  }
  deps.io.out(`revoked identities=${String(managed)} policies=${String(deleted)}`);
  if (foreign > 0) deps.io.err(`⚠ 관리 표시가 없거나 이름이 ${IDENTITY_POLICY_NAME_PREFIX} 가 아닌 정책 ${String(foreign)}건은 그대로 — scripts/check-ses-principals.sh 로 보고 손으로 판단한다.`);
  deps.io.err('이어서: pnpm admin:domain --suspend-all-customer --yes (DB 정합) · scripts/check-ses-principals.sh');
  return EXIT_OK;
}

if (isMain(import.meta.url)) await runAdminMain((argv, deps) => domain(argv, deps));
