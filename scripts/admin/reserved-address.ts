#!/usr/bin/env tsx
/**
 * scripts/admin/reserved-address.ts — **운영자 예약 주소**(`support@`·`onve@`·`abuse@`·`postmaster@atmark.ai` — `claude@` 는 202610141200 에서 뺐다)를 지정한 조직에 준다
 * (2026-09-30, 마이그레이션 202609301500 · 1540 · 런북 deploy §29 · §33). `abuse@`·`postmaster@` 는 수신 전용이라 `alias` 로만 붙는다.
 *
 *   pnpm admin:reserved-address grant     --address support@atmark.ai --org <조직 id> --reason "<사유>" [--by <운영자>] [--yes]
 *   pnpm admin:reserved-address provision --address support@atmark.ai --org <조직 id> --name "Atmark Support"
 *                                         [--budget-cents 10000] [--custody aws|local] [--by <운영자>] [--yes]
 *   pnpm admin:reserved-address alias     --agent <에이전트 id> --address onve@atmark.ai [--yes]
 *
 * 예약 로컬파트는 모든 롤에서 막힌다(DB CHECK). 목록 안의 주소만 예외이고, 그것도 **운영자 허가 행**(`operator_address_grants` — 소유자 롤만
 * 쓴다)이 그 조직을 가리킬 때만 INSERT 된다(DB 트리거 `agent_addresses_operator_grant_guard`, 없으면 42501). 그래서 순서는 grant → provision/alias.
 *
 *   - `grant` — 허가 행 하나. 멱등: 같은 조직이면 그대로(`exists`), 다른 조직이 이미 쥐었으면 거부(옮기는 길은 이 CLI 에 없다 — 소유자 셸).
 *   - `provision` — 그 주소를 **대표 주소**로 하는 새 에이전트(`provisionAgentOp` — 콘솔·`admin:agent-provision` 과 같은 함수: 조직 잠금 · 요금제 한도 ·
 *     주소 가용성 · PP-A 원자성 · 투명성 잎 `identity.address_assigned`). 멱등: 그 조직의 에이전트가 이미 그 주소를 쓰면 새로 만들지 않는다(토큰은
 *     `admin:agent-token`). 기본 발신 모드는 `allowlist_only` 다 — **All 로 바꾸지 않는다**(신뢰할 수 없는 수신 메일 + 프롬프트 인젝션). 회신할 고객 주소만 `admin:rules` 로 더한다(런북 §29-3).
 *   - `alias` — 그 주소를 **별칭**으로(`addOperatorReservedAliasOp` — 요금제 별칭 한도를 보지 않는다. DB 천장 20 · 재발급 보류 · 허가 가드는 그대로).
 *     멱등: 이미 붙어 있으면 그대로.
 *
 * 예약 판정을 건너뛰는 브랜드(`buildOperatorReservedAddress`)는 **이 파일만** 만든다 — `src/admin`·`src/api`·`src/ops`·`src/mcp` 는 import 하지 않는다
 * (`test/arch/operator-reserved-address.arch.test.ts`). 소유자 롤(`DATABASE_MIGRATION_URL`)로만 붙고, 운영 DB 면 변경 전 확인(`--yes`).
 */

import { parseArgs } from 'node:util';

import type { Pool } from 'pg';

import { addOperatorReservedAliasOp } from '../../src/admin/ops/addresses';
import { addressConflict, agentOrganizationOf, DEFAULT_BUDGET_CENTS, ORGANIZATION_ID_PATTERN, provisionAgentOp } from '../../src/admin/ops/agents';
import { withTransaction } from '../../src/db/client';
import { isAgentId, toAgentId } from '../../src/db/schema';
import { AgentAddressError, buildOperatorReservedAddress, isReceiveOnlyAddress, type OperatorReservedAddress } from '../../src/identity/address';
import { readFeatureFlag, RUNTIME_ENV } from '../../src/runtime/config';
import {
  actorOf,
  AdminInputError,
  confirmProduction,
  EXIT_OK,
  isMain,
  runAdminMain,
  withAdminConnection,
  type AdminDeps,
  type TargetInfo,
} from './common';
import { parseCustodyChoice, sdkCustodyPorts, selectCustody, type AwsCustodyPorts, type CustodyChoice } from './custody';

const USAGE = [
  'pnpm admin:reserved-address grant --address <주소> --org <조직 id> --reason "<사유>" [--by <운영자>] [--yes]',
  'pnpm admin:reserved-address provision --address <주소> --org <조직 id> --name "<이름>" [--budget-cents 10000] [--custody aws|local] [--by <운영자>] [--yes]',
  'pnpm admin:reserved-address alias --agent <에이전트 id> --address <주소> [--yes]',
].join('\n');

const REASON_MAX_LENGTH = 500;

export interface ReservedAddressDeps extends AdminDeps {
  /** AWS 포트. 기본은 실제 SDK — 테스트는 가짜를 준다. */
  readonly awsCustodyPorts?: () => AwsCustodyPorts;
}

export type ReservedAddressCommand =
  | { readonly kind: 'grant'; readonly address: OperatorReservedAddress; readonly org: string; readonly reason: string; readonly by: string | undefined; readonly yes: boolean }
  | {
      readonly kind: 'provision';
      readonly address: OperatorReservedAddress;
      readonly org: string;
      readonly name: string;
      readonly budgetCents: number;
      readonly custody: CustodyChoice | undefined;
      readonly by: string | undefined;
      readonly yes: boolean;
    }
  | { readonly kind: 'alias'; readonly address: OperatorReservedAddress; readonly agent: string; readonly yes: boolean };

function operatorAddress(raw: string | undefined): OperatorReservedAddress {
  if (raw === undefined) throw new AdminInputError(`--address 가 필요하다.\n${USAGE}`);
  try {
    return buildOperatorReservedAddress(raw);
  } catch (error) {
    if (error instanceof AgentAddressError) throw new AdminInputError(error.message, 'invalid_address');
    throw error;
  }
}

function organizationId(raw: string | undefined): string {
  const org = raw?.trim().toLowerCase() ?? '';
  if (!ORGANIZATION_ID_PATTERN.test(org)) throw new AdminInputError(`--org 는 조직 id(uuid)다.\n${USAGE}`);
  return org;
}

/** argv → 명령. 형식 오류는 접속 전에 던진다(exit 2). `null` 이면 도움말. */
export function parseReservedAddressArgs(argv: readonly string[]): ReservedAddressCommand | null {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      address: { type: 'string' },
      org: { type: 'string' },
      agent: { type: 'string' },
      reason: { type: 'string' },
      name: { type: 'string' },
      'budget-cents': { type: 'string' },
      custody: { type: 'string' },
      by: { type: 'string' },
      yes: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  if (values.help) return null;
  if (positionals.length !== 1) throw new AdminInputError(`하위 명령 하나(grant | provision | alias)가 필요하다.\n${USAGE}`);
  const sub = positionals[0];
  const address = operatorAddress(values.address);
  if (sub === 'grant') {
    const reason = values.reason?.trim() ?? '';
    if (reason === '' || reason.length > REASON_MAX_LENGTH) throw new AdminInputError(`--reason 은 1~${String(REASON_MAX_LENGTH)}자다.\n${USAGE}`);
    return { kind: 'grant', address, org: organizationId(values.org), reason, by: values.by, yes: values.yes };
  }
  if (sub === 'provision') {
    // 수신 전용 주소(`abuse@`·`postmaster@` — 202609301540)는 대표 주소가 될 수 없다: 대표 주소는 회신 기본 발신 주소이고, 그 주소로는 보내지 못한다
    //   (발송 전처리 400 · IAM Deny). 지원 에이전트에 `alias` 로 붙인다.
    if (isReceiveOnlyAddress(address)) throw new AdminInputError(`${address} 는 수신 전용이다 — provision 이 아니라 alias 로 붙인다.\n${USAGE}`);
    const name = values.name?.trim() ?? '';
    if (name === '') throw new AdminInputError(`--name 이 필요하다.\n${USAGE}`);
    const budgetRaw = values['budget-cents'] ?? String(DEFAULT_BUDGET_CENTS);
    if (!/^\d+$/.test(budgetRaw)) throw new AdminInputError(`--budget-cents 는 0 이상의 정수: ${budgetRaw}`);
    return {
      kind: 'provision',
      address,
      org: organizationId(values.org),
      name,
      budgetCents: Number(budgetRaw),
      custody: parseCustodyChoice(values.custody),
      by: values.by,
      yes: values.yes,
    };
  }
  if (sub === 'alias') {
    const agent = values.agent?.trim() ?? '';
    if (!isAgentId(agent)) throw new AdminInputError(`--agent 는 에이전트 id(uuid)다.\n${USAGE}`);
    return { kind: 'alias', address, agent, yes: values.yes };
  }
  throw new AdminInputError(`알 수 없는 하위 명령: ${String(sub)}\n${USAGE}`);
}

export async function reservedAddress(argv: readonly string[], deps: ReservedAddressDeps): Promise<number> {
  const command = parseReservedAddressArgs(argv);
  if (command === null) {
    deps.io.out(USAGE);
    return EXIT_OK;
  }
  return withAdminConnection(deps, ({ pool, target }) => runReservedAddress(pool, target, command, deps));
}

/** 명령 하나를 이 풀(소유자 롤)에서. 테스트는 롤백할 트랜잭션의 풀을 준다. */
export async function runReservedAddress(pool: Pool, target: TargetInfo, command: ReservedAddressCommand, deps: ReservedAddressDeps): Promise<number> {
  if (command.kind === 'grant') return grant(pool, target, command, deps);
  if (command.kind === 'provision') return provision(pool, target, command, deps);
  return alias(pool, target, command, deps);
}

async function reviewStatusOf(pool: Pool, org: string): Promise<string> {
  const row = await pool.query<{ review_status: string }>('SELECT review_status::text AS review_status FROM organizations WHERE id = $1', [org]);
  const status = row.rows[0]?.review_status;
  if (status === undefined) throw new AdminInputError(`조직이 없다: ${org}`, 'organization_not_found');
  return status;
}

/** 허가 행이 가리키는 조직(없으면 `null`). */
async function grantedOrganization(pool: Pool, address: OperatorReservedAddress): Promise<string | null> {
  const row = await pool.query<{ organization_id: string }>('SELECT organization_id::text AS organization_id FROM operator_address_grants WHERE address = $1', [address]);
  return row.rows[0]?.organization_id ?? null;
}

async function requireGrant(pool: Pool, address: OperatorReservedAddress, org: string): Promise<void> {
  const granted = await grantedOrganization(pool, address);
  if (granted !== org) {
    throw new AdminInputError(
      granted === null
        ? `${address} 의 운영자 허가가 없다 — 먼저 \`pnpm admin:reserved-address grant --address ${address} --org ${org} --reason …\``
        : `${address} 는 다른 조직(${granted})에 허가돼 있다.`,
      'operator_grant_missing',
    );
  }
}

function warnIfNotActive(status: string, org: string, deps: AdminDeps): void {
  if (status !== 'active') {
    deps.io.err(`⚠ 조직 ${org} 의 review_status 가 ${status} 다 — active 가 아니면 이 주소로 오는 메일은 org_not_active 로 거부된다(\`admin:org-review\`).`);
  }
}

async function grant(pool: Pool, target: TargetInfo, command: Extract<ReservedAddressCommand, { kind: 'grant' }>, deps: AdminDeps): Promise<number> {
  const status = await reviewStatusOf(pool, command.org);
  const grantedBy = actorOf('admin:reserved-address', command.by, deps.env);
  await confirmProduction(target, `운영자 예약 주소 허가 ${command.address} → 조직 ${command.org}`, command.yes, deps.io);
  const inserted = await pool.query(
    `INSERT INTO operator_address_grants (address, organization_id, granted_by, reason) VALUES ($1, $2, $3, $4)
     ON CONFLICT (address) DO NOTHING`,
    [command.address, command.org, grantedBy, command.reason],
  );
  if ((inserted.rowCount ?? 0) === 0) {
    const granted = await grantedOrganization(pool, command.address);
    if (granted !== command.org) throw new AdminInputError(`${command.address} 는 이미 다른 조직(${String(granted)})에 허가돼 있다.`, 'operator_grant_conflict');
    deps.io.out(`grant ${command.address} ${command.org} exists`);
  } else {
    deps.io.out(`grant ${command.address} ${command.org} created`);
  }
  warnIfNotActive(status, command.org, deps);
  return EXIT_OK;
}

async function provision(
  pool: Pool,
  target: TargetInfo,
  command: Extract<ReservedAddressCommand, { kind: 'provision' }>,
  deps: ReservedAddressDeps,
): Promise<number> {
  const status = await reviewStatusOf(pool, command.org);
  await requireGrant(pool, command.address, command.org);
  // 멱등 — 그 주소를 이미 이 조직의 에이전트가 쓰면 새로 만들지 않는다(키 보관을 돌리기 전에 본다).
  const existing = await pool.query<{ agent_id: string; organization_id: string; is_primary: boolean }>(
    `SELECT d.agent_id::text AS agent_id, a.organization_id::text AS organization_id, d.is_primary
       FROM agent_addresses d JOIN agents a ON a.id = d.agent_id
      WHERE d.address = $1 AND d.retired_at IS NULL`,
    [command.address],
  );
  const current = existing.rows[0];
  if (current !== undefined) {
    if (current.organization_id !== command.org) throw addressConflict();
    deps.io.out(`agent ${current.agent_id}`);
    deps.io.out(`address ${command.address}`);
    deps.io.err(
      `이미 있다 — 에이전트 ${current.agent_id} 가 ${command.address} 를 ${current.is_primary ? '대표 주소' : '별칭'}로 쓴다. 토큰은 \`pnpm admin:agent-token --agent ${current.agent_id}\`.`,
    );
    warnIfNotActive(status, command.org, deps);
    return EXIT_OK;
  }
  // custody 를 먼저 고른다 — 운영 DB + 로컬 custody 는 확인 프롬프트 전에 거부된다(admin:agent-provision 과 같다).
  const custody = selectCustody(target.target, command.custody, deps.env, deps.awsCustodyPorts ?? (() => sdkCustodyPorts(deps.env)));
  await confirmProduction(target, `운영자 예약 주소 에이전트 "${command.name}" <${command.address}> · 조직 ${command.org} · 키 보관 ${custody.kind}`, command.yes, deps.io);
  const provisioned = await provisionAgentOp(
    pool,
    {
      organizationId: command.org,
      name: command.name,
      localPart: command.address.slice(0, command.address.indexOf('@')),
      seeds: [],
      budgetCents: command.budgetCents,
      createdBy: actorOf('admin:reserved-address', command.by, deps.env),
      attachmentFollowsPlan: readFeatureFlag(process.env, RUNTIME_ENV.policyAttachmentFollowPlan),
      operatorReservedAddress: command.address,
      // 운영자 예약 주소는 허용 목록(빈 목록)으로 태어난다 — 소유자가 만드는 에이전트의 새 기본값(전체, 2026-10-13)을 따르지 않는다.
      outboundMode: 'allowlist_only',
    },
    custody,
  );
  if (provisioned.kind === 'taken') throw addressConflict();
  // B5 — passport·DID 는 찍지 않는다.
  deps.io.out(`agent ${provisioned.agent.id}`);
  deps.io.out(`address ${provisioned.agent.address ?? ''}`);
  deps.io.out(`token ${provisioned.token}`);
  deps.io.err(
    `에이전트를 만들었다 — 조직 ${provisioned.organizationId} · 정책 ${provisioned.agent.outboundMode ?? '?'} v${String(provisioned.policyVersion)} · 키 보관 ${custody.kind}`,
  );
  deps.io.err('⚠ token 은 지금 한 번만 보인다(DB 에는 sha256 만 남는다). 발신 모드는 allowlist_only 그대로 둔다 — All 로 바꾸지 않는다. 회신할 주소만 `pnpm admin:rules --agent <id> --add <주소> --direction outbound --list allow`(런북 §29-3).');
  warnIfNotActive(status, command.org, deps);
  return EXIT_OK;
}

async function alias(pool: Pool, target: TargetInfo, command: Extract<ReservedAddressCommand, { kind: 'alias' }>, deps: AdminDeps): Promise<number> {
  const agentId = toAgentId(command.agent);
  const org = await agentOrganizationOf(pool, agentId);
  if (org === null) throw new AdminInputError(`에이전트가 없다: ${command.agent}`, 'agent_not_found');
  await requireGrant(pool, command.address, org);
  await confirmProduction(target, `운영자 예약 주소 별칭 ${command.address} → 에이전트 ${command.agent}`, command.yes, deps.io);
  const outcome = await withTransaction(pool, (client) => addOperatorReservedAliasOp(client, org, agentId, command.address));
  if (outcome.kind === 'taken') throw addressConflict();
  deps.io.out(`alias ${outcome.item.address} ${command.agent} ${outcome.kind === 'added' ? 'created' : 'exists'}`);
  return EXIT_OK;
}

if (isMain(import.meta.url)) await runAdminMain((argv, deps) => reservedAddress(argv, deps));
