/**
 * test/integration/domains/support.ts — 고객 도메인 단계 4 통합 테스트의 지반.
 *
 *   - **틱 롤 풀**: 로컬 DB 의 `atmark_domain_tick` 은 NOLOGIN 이다(런북 custom-domains §1-2) — 소유자 URL 로 붙어 연결마다 `SET ROLE atmark_domain_tick`
 *     을 건다. 권한은 그 롤의 것이다(GRANT 가 틀리면 여기서 42501).
 *   - **가짜 domain-control**: 실제 핸들러 로직(`parseDomainControlBatch` → `runDomainControlBatch`)을 가짜 SES(도메인 여럿 · 호출 기록 · 실패 주입) ·
 *     가짜 DNS(apex 별 TXT 토큰 · 도메인 별 MX) · 가짜 RDAP 위에서 돌리고, 결과를 실제 호출 구현과 같은 대조(`resultMatches`)로 본다.
 */

import { randomBytes } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';

import {
  combineChallengeVerdicts,
  DomainControlUnavailableError,
  type DnsVerdict,
  type DomainControlInvoker,
  type DomainControlRequest,
  type DomainControlResult,
} from '../../../src/domains/contract';
import type { DnsLookup } from '../../../src/domains/dns-lookup';
import type { RdapExpiryResult } from '../../../src/domains/rdap';
import type { SesIdentityControl, SesIdentitySnapshot } from '../../../src/mail/transport/ses-identity';
import { resultMatches } from '../../../src/runtime/domain-control-invoker';
import { parseDomainControlBatch, runDomainControlBatch, type DomainControlDependencies } from '../../../src/runtime/handlers/domain-control';
import { provisioningPool } from '../db/support/harness';

export const OWNER_URL = process.env['TEST_MIGRATION_DATABASE_URL'] ?? '';
export const ACCOUNT = '123456789012';
export const SENDER = `arn:aws:iam::${ACCOUNT}:role/atmark-runtime-sender`;

/** 틱 롤 풀 — 연결마다 `SET ROLE atmark_domain_tick`. 크기 1(운영과 같다). */
export function tickPool(max = 1): Pool {
  const pool = new Pool({ connectionString: OWNER_URL, max });
  pool.on('connect', (client: PoolClient) => {
    void client.query('SET ROLE atmark_domain_tick');
  });
  return pool;
}

/** 첫 쿼리 전에 SET ROLE 이 끝나도록 — `connect` 이벤트의 쿼리는 같은 연결의 다음 쿼리보다 먼저 줄을 선다. */
export async function currentRole(pool: Pool): Promise<string> {
  return (await pool.query<{ role: string }>('SELECT current_user AS role')).rows[0]?.role ?? '';
}

export const newApex = (): string => `cd${randomBytes(5).toString('hex')}.com`;
const newToken = (): string => randomBytes(32).toString('base64url');

/** 기능 허용 + pending 행(소유자 롤). */
export async function pendingDomain(organizationId: string, domain: string, registrable: string, token = newToken()): Promise<{ id: string; token: string }> {
  const owner = provisioningPool();
  await owner.query(`INSERT INTO org_features (organization_id, feature, enabled_by) VALUES ($1, 'custom_domains', 'test') ON CONFLICT DO NOTHING`, [organizationId]);
  const row = await owner.query<{ id: string }>(
    `INSERT INTO custom_domains (organization_id, domain, registrable_domain, challenge_token) VALUES ($1, $2, $3, $4) RETURNING id::text AS id`,
    [organizationId, domain, registrable, token],
  );
  return { id: row.rows[0]?.id ?? '', token };
}

export async function domainState(id: string): Promise<Record<string, unknown>> {
  const row = await provisioningPool().query(
    `SELECT status, suspended_reason, pending_reason, saga_step, removal_step, superseded_by::text AS superseded_by, ses_identity_row_tag::text AS tag,
            consecutive_definitive_failures AS failures, policy_sync_requested_at IS NOT NULL AS sync_requested, dkim_status, txt_verified_at IS NOT NULL AS txt,
            identity_claimed_at IS NOT NULL AS claimed, identity_released_at IS NOT NULL AS released, identity_handover_to::text AS handover_to,
            identity_deleted_at IS NOT NULL AS deleted, cardinality(dkim_tokens) AS tokens
       FROM custom_domains WHERE id = $1`,
    [id],
  );
  return row.rows[0] ?? {};
}

// ---------------------------------------------------------------------------
// 가짜 SES · DNS · RDAP
// ---------------------------------------------------------------------------

interface FakeIdentity {
  tags: Record<string, string>;
  policies: Record<string, string>;
  dkimStatus: string;
  mailFrom: boolean;
  configSet: boolean;
}

export interface FakeWorld {
  readonly identities: Map<string, FakeIdentity>;
  /** 이름(서브도메인 또는 apex) → 그 이름의 `_atmark-challenge` TXT 에 있는 토큰들. `'error'` 면 그 이름의 DNS 가 오류. 두 이름은 OR. */
  readonly txt: Map<string, Set<string> | 'error'>;
  /** 도메인 → MX 판정(없으면 missing). */
  readonly mx: Map<string, 'missing' | 'ses' | 'other' | 'error'>;
  /** SES 호출 기록 `op domain`. */
  readonly sesCalls: string[];
  /** domain-control 요청 기록. */
  readonly requests: DomainControlRequest[];
  /** 다음 N 번 그 SES 연산을 실패시킨다(`createIdentity` · `putMailFrom` · `putConfigurationSet` · `deletePolicy` …). */
  readonly failNext: Map<string, number>;
  /** identity 를 만들면 DKIM 을 곧바로 이 값으로(기본 SUCCESS). */
  dkimOnCreate: string;
  /** domain-control 자체를 꺼 둔다(호출 실패 — 틱은 아무것도 바꾸지 않아야 한다). */
  unavailable: boolean;
}

export function fakeWorld(): FakeWorld {
  return { identities: new Map(), txt: new Map(), mx: new Map(), sesCalls: [], requests: [], failNext: new Map(), dkimOnCreate: 'SUCCESS', unavailable: false };
}

function fakeSes(world: FakeWorld): SesIdentityControl {
  const record = (op: string, domain: string): void => {
    world.sesCalls.push(`${op} ${domain}`);
    const left = world.failNext.get(op) ?? 0;
    if (left > 0) {
      world.failNext.set(op, left - 1);
      throw Object.assign(new Error('injected'), { name: 'TooManyRequestsException' });
    }
  };
  const snapshot = (identity: FakeIdentity): SesIdentitySnapshot => ({
    tags: { ...identity.tags },
    policies: { ...identity.policies },
    dkimTokens: ['tok1', 'tok2', 'tok3'],
    dkimStatus: identity.dkimStatus,
    mailFromStatus: identity.mailFrom ? 'SUCCESS' : 'NOT_STARTED',
  });
  return {
    getIdentity(domain) {
      record('getIdentity', domain);
      const identity = world.identities.get(domain);
      return Promise.resolve(identity === undefined ? null : snapshot(identity));
    },
    createIdentity(domain, tags) {
      record('createIdentity', domain);
      if (world.identities.has(domain)) return Promise.reject(Object.assign(new Error('exists'), { name: 'AlreadyExistsException' }));
      world.identities.set(domain, { tags: { ...tags }, policies: {}, dkimStatus: world.dkimOnCreate, mailFrom: false, configSet: false });
      return Promise.resolve();
    },
    tagIdentity(arn, tags) {
      const domain = arn.slice(arn.indexOf('identity/') + 'identity/'.length);
      record('tagIdentity', domain);
      const identity = world.identities.get(domain);
      if (identity !== undefined) identity.tags = { ...identity.tags, ...tags };
      return Promise.resolve();
    },
    putMailFrom(domain) {
      record('putMailFrom', domain);
      const identity = world.identities.get(domain);
      if (identity !== undefined) identity.mailFrom = true;
      return Promise.resolve();
    },
    putConfigurationSet(domain) {
      record('putConfigurationSet', domain);
      const identity = world.identities.get(domain);
      if (identity !== undefined) identity.configSet = true;
      return Promise.resolve();
    },
    createPolicy(domain, name, policy) {
      record('createPolicy', domain);
      const identity = world.identities.get(domain);
      if (identity !== undefined) identity.policies[name] = policy;
      return Promise.resolve();
    },
    updatePolicy(domain, name, policy) {
      record('updatePolicy', domain);
      const identity = world.identities.get(domain);
      if (identity !== undefined) identity.policies[name] = policy;
      return Promise.resolve();
    },
    deletePolicy(domain, name) {
      record('deletePolicy', domain);
      const identity = world.identities.get(domain);
      if (identity !== undefined) delete identity.policies[name];
      return Promise.resolve();
    },
    deleteIdentity(domain) {
      record('deleteIdentity', domain);
      world.identities.delete(domain);
      return Promise.resolve();
    },
    listIdentities() {
      return Promise.resolve([...world.identities.keys()]);
    },
  };
}

function fakeDns(world: FakeWorld): DnsLookup {
  return {
    // 두 이름의 OR(one-shot): `world.txt` 의 키는 서브도메인(`domain`) 또는 apex(`registrable`) — 그 이름의 `_atmark-challenge` TXT.
    checkChallenge(domain, registrable, token) {
      const verdictOf = (name: string): DnsVerdict => {
        const tokens = world.txt.get(name);
        if (tokens === 'error') return 'error';
        return tokens?.has(token) === true ? 'present' : 'absent';
      };
      const verdict = combineChallengeVerdicts([verdictOf(domain), verdictOf(registrable)]);
      return Promise.resolve({ verdict, errorCode: verdict === 'error' ? 'dns_timeout' : null });
    },
    checkMx(domain) {
      const mx = world.mx.get(domain) ?? 'missing';
      return Promise.resolve(mx === 'error' ? { verdict: 'error', errorCode: 'dns_timeout' } : { verdict: mx, errorCode: null });
    },
  };
}

/** 실제 핸들러 로직을 가짜 세계 위에서 — 결과는 실제 호출 구현과 같은 대조를 지난다. */
export function fakeInvoker(world: FakeWorld): DomainControlInvoker {
  const deps: DomainControlDependencies = {
    ses: fakeSes(world),
    dns: fakeDns(world),
    rdap: (): Promise<RdapExpiryResult> => Promise.resolve({ kind: 'unsupported' }),
    senderRoleArn: SENDER,
    accountId: ACCOUNT,
    region: 'ap-northeast-2',
    configurationSet: 'atmark-default',
  };
  return {
    async invoke(batch) {
      if (world.unavailable) throw new DomainControlUnavailableError('test: off');
      world.requests.push(...batch);
      const parsed = parseDomainControlBatch(JSON.parse(JSON.stringify({ batch })) as unknown);
      const results: readonly DomainControlResult[] = JSON.parse(JSON.stringify(await runDomainControlBatch(deps, parsed))) as DomainControlResult[];
      return batch.map((request, i) => {
        const result = results[i];
        if (!resultMatches(request, result)) throw new DomainControlUnavailableError('test: 계약 모양 아님');
        return result;
      });
    },
  };
}

/** 이 행(rowId)에 간 요청의 op 들. */
export function opsFor(world: FakeWorld, rowId: string): string[] {
  return world.requests.filter((request) => request.rowId === rowId).map((request) => request.op);
}
