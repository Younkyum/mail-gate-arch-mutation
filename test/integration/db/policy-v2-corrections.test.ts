/**
 * 정책 v2 이전 보정(202609241040) — **대표 행 위에서 1010 → 1040 을 실제로 돌린다** (검증 M1·M3·M4·L1).
 *
 * 공유 DB(이미 전부 적용됨)로는 이전을 다시 돌릴 수 없다 — 그래서 **빈 스크래치 DB** 를 만들어 1010 직전까지 적용하고, 옛 모양의
 * 정책·관계를 심은 뒤 나머지(1010·1020·1030·1040·…)를 적용한다. 판정은 관문과 같은 로더·엔진(`loadEvaluationInput`·`evaluate`)으로
 * 본다 — "행이 이렇다" 가 아니라 "이 수신자가 막힌다/나간다" 가 명제다.
 *
 *   M1  옛 unrestricted + 옛 blocklist → blocklist_only(차단이 다시 읽힌다).
 *   M4  (a) `@` 없는 옛 allowlist 항목의 도메인 규칙 제거 (b) 레거시 에이전트의 옛 allowlist 제거(seed·approved 관계만 남김)
 *       (c) reply_only 의 auto_approve_domains 제거 · approval_required 의 auto_approve_domains 는 남김.
 *   L1  발신 allow 의 atmark.ai 도메인 규칙 제거(누가 만들었든).
 *   M3  바로잡은 에이전트마다 새 버전(스냅샷 = 살아 있는 목록) · 이후 버전 없는 목록 변경은 커밋되지 않는다.
 *
 * **`TEST_DATABASE_URL`·`TEST_MIGRATION_DATABASE_URL` 이 없으면 건너뛴다.** 스크래치 DB 는 끝에서 지운다.
 */

import { randomBytes } from 'node:crypto';

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPool } from '../../../src/db/client';
import { loadMigrations, migrate } from '../../../src/db/migrate';
import { createPostgresPolicySource } from '../../../src/db/repositories/policy-source';
import { toAgentId } from '../../../src/db/schema';
import { contactRuleKindOf } from '../../../src/policy/contact-rules';
import { evaluate } from '../../../src/policy/engine';
import { loadEvaluationInput } from '../../../src/policy/policy-loader';
import { DATABASE_AVAILABLE } from './support/harness';

const OWNER_URL = (process.env['TEST_MIGRATION_DATABASE_URL'] ?? '').trim();
const AVAILABLE = DATABASE_AVAILABLE && OWNER_URL !== '';
const FIRST_V2 = '202609241010';
const CORRECTIONS = '202609241040';

const ORG = '00000000-0000-4000-8000-0000000000f1';
const A = (n: number): string => `f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1${n.toString(16).padStart(2, '0')}`;
const LIMITS = { per_minute: 100, per_hour: 1000, per_day: 5000, recipients_per_message: 20 };
const CONTENT = { max_attachment_bytes_total: 10_000_000, allowed_mime_types: ['text/plain'] };

/** 옛(v1) 에이전트 — 모드·config_json(옛 목록 키 포함)·seed 관계. */
interface Legacy {
  readonly n: number;
  readonly mode: 'approval_required' | 'reply_only' | 'unrestricted' | 'allowlist_only' | 'disabled';
  readonly config: Record<string, unknown>;
  readonly seeds?: readonly string[];
}

const LEGACY: readonly Legacy[] = [
  // approval_required — seed 한 명 · 쓰이지 않던 옛 allowlist · 사람 없이 나가던 auto_approve 도메인.
  { n: 1, mode: 'approval_required', config: { allowlist: ['seed@a.com', 'extra@inert.com'], blocklist: [], auto_approve_domains: ['auto.com'] }, seeds: ['seed@a.com'] },
  // reply_only — seed 둘(태그 보존) · 옛 allowlist · grace 동안만 쓰이던 auto_approve 도메인.
  { n: 2, mode: 'reply_only', config: { allowlist: ['s@b.com', 'other@b.com'], blocklist: [], auto_approve_domains: ['replyauto.com'] }, seeds: ['s@b.com', 'upper+tag@b.com'] },
  // unrestricted + 옛 blocklist(@domain 은 하위까지).
  { n: 3, mode: 'unrestricted', config: { allowlist: [], blocklist: ['@evil.com', 'bad@x.com'] } },
  // allowlist_only — 주소 하나만 옛 판정에서 무언가를 열었다. 나머지(`@` 없는 값)는 아무것도 열지 않았다.
  { n: 4, mode: 'allowlist_only', config: { allowlist: ['example.com', '@wide.com', 'ok@z.com', '*.star.com', '*.atmark.ai'], blocklist: [] } },
  // allowlist_only — 손대지 않을 에이전트(대조군).
  { n: 5, mode: 'allowlist_only', config: { allowlist: ['a@b.com'], blocklist: ['no@b.com'] } },
  // unrestricted, 옛 blocklist 없음 — 그대로 "전체"(대조군).
  { n: 6, mode: 'unrestricted', config: { allowlist: [], blocklist: [] } },
  // allowlist_only — 1010 뒤에 소유자가 넣은 atmark.ai 도메인 allow(L1 대상, 아래에서 심는다).
  { n: 7, mode: 'allowlist_only', config: { allowlist: ['peer@atmark.ai'], blocklist: [] } },
];

let admin: Pool | undefined;
let scratch: Pool | undefined;
let scratchName = '';

function db(): Pool {
  if (scratch === undefined) throw new Error('스크래치 DB 가 없다');
  return scratch;
}

async function seedLegacy(pool: Pool): Promise<void> {
  await pool.query(`INSERT INTO organizations (id, name, billing_status) VALUES ($1, 'v2fix', 'active')`, [ORG]);
  for (const agent of LEGACY) {
    const id = A(agent.n);
    await pool.query(`INSERT INTO agents (id, organization_id, name, status) VALUES ($1, $2, $3, 'active')`, [id, ORG, `v2fix-${String(agent.n)}`]);
    await pool.query(`INSERT INTO agent_addresses (agent_id, address, domain, is_primary) VALUES ($1, $2, 'atmark.ai', true)`, [id, `v2fix-${String(agent.n)}@atmark.ai`]);
    const config = { ...CONTENT, ...agent.config };
    await pool.query(
      `INSERT INTO agent_policies (agent_id, outbound_mode, limits, config_json, current_version) VALUES ($1, $2, $3::jsonb, $4::jsonb, 1)`,
      [id, agent.mode, JSON.stringify(LIMITS), JSON.stringify(config)],
    );
    await pool.query(
      `INSERT INTO policy_versions (agent_id, version, outbound_mode, snapshot, created_by) VALUES ($1, 1, $2, $3::jsonb, 'v1')`,
      [id, agent.mode, JSON.stringify({ outbound_mode: agent.mode, limits: LIMITS, config_json: config })],
    );
    for (const seed of agent.seeds ?? []) {
      await pool.query(
        `INSERT INTO sender_relationships (agent_id, scope, address, trust_category, granted_by) VALUES ($1, 'recipient', $2, 'seed', 'owner_provisioning')`,
        [id, seed],
      );
    }
  }
}

/** 1010~1030 뒤, 1040 전 — 소유자가 콘솔로 넣은 것처럼 atmark.ai 도메인 allow 를 더한다(그때는 막는 것이 없었다). */
async function seedPlatformDomainRule(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO agent_contact_rules (agent_id, direction, list, kind, value, created_by) VALUES ($1, 'outbound', 'allow', 'domain', 'atmark.ai', 'owner:test')`,
      [A(7)],
    );
    await client.query(
      `INSERT INTO policy_versions (agent_id, version, outbound_mode, inbound_mode, snapshot, created_by)
       SELECT p.agent_id, p.current_version + 1, v.outbound_mode, v.inbound_mode,
              v.snapshot || jsonb_build_object('contact_rules', (SELECT jsonb_agg(jsonb_build_object('id', r.id, 'direction', r.direction,
                'list', r.list, 'kind', r.kind, 'value', r.value)) FROM agent_contact_rules r WHERE r.agent_id = p.agent_id AND r.removed_at IS NULL)),
              'owner:test'
         FROM agent_policies p JOIN policy_versions v ON v.agent_id = p.agent_id AND v.version = p.current_version
        WHERE p.agent_id = $1`,
      [A(7)],
    );
    await client.query('UPDATE agent_policies SET current_version = current_version + 1 WHERE agent_id = $1', [A(7)]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function applyMigrations(pool: Pool, keep: (filename: string) => boolean): Promise<void> {
  const client = await pool.connect();
  try {
    await migrate(client, loadMigrations().filter((file) => keep(file.filename)));
  } finally {
    client.release();
  }
}

async function activeRules(n: number, list: 'allow' | 'block'): Promise<string[]> {
  const result = await db().query<{ value: string }>(
    `SELECT value FROM agent_contact_rules WHERE agent_id = $1 AND direction = 'outbound' AND list = $2 AND removed_at IS NULL ORDER BY value COLLATE "C"`,
    [A(n), list],
  );
  return result.rows.map((row) => row.value);
}

async function currentMode(n: number): Promise<{ mode: string; createdBy: string | null }> {
  const result = await db().query<{ outbound_mode: string; created_by: string | null }>(
    `SELECT v.outbound_mode, v.created_by FROM agent_policies p JOIN policy_versions v ON v.agent_id = p.agent_id AND v.version = p.current_version
      WHERE p.agent_id = $1`,
    [A(n)],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`정책 없음 ${String(n)}`);
  return { mode: row.outbound_mode, createdBy: row.created_by };
}

/** 관문과 같은 로더·엔진으로 판정한다(허용 또는 첫 거부 사유). */
async function verdict(n: number, recipient: string): Promise<string> {
  const input = await loadEvaluationInput(createPostgresPolicySource(db()), {
    agentId: toAgentId(A(n)),
    now: new Date(),
    traceId: null,
    thisAttemptCostCents: 0,
    release: null,
    attempt: { routeId: 'send', fromAddress: `v2fix-${String(n)}@atmark.ai`, recipients: [recipient], attachments: [], threadId: null, contentShape: 'other', dlp: [], pinnedTaint: false },
  });
  const decision = evaluate(input.ctx, input.policy);
  return decision.verdict === 'allowed' ? 'allowed' : `${decision.verdict}:${decision.reasons.join(',')}`;
}

const before = new Map<string, string>();

describe.skipIf(!AVAILABLE)('정책 v2 이전 보정(202609241040) — 스크래치 DB 에서 1010 → 1040', () => {
  beforeAll(async () => {
    admin = createPool(OWNER_URL, { max: 1 });
    scratchName = `atmark_v2fix_${randomBytes(4).toString('hex')}`;
    await admin.query(`CREATE DATABASE ${scratchName}`);
    const url = new URL(OWNER_URL);
    url.pathname = `/${scratchName}`;
    scratch = createPool(url.toString(), { max: 2 });
    // 정리 단계의 `DROP DATABASE … WITH (FORCE)` 가 스크래치 DB 연결을 끊는다(57P01). 쉬는 클라이언트의 그 통지를 받을 곳이 없으면
    // vitest 가 "처리되지 않은 오류"로 실행 전체를 실패시킨다(2026-09-25 test:coverage 에서 간헐 관찰). 57P01 만 삼키고 나머지는 던진다.
    const ignoreForcedDrop = (error: Error & { code?: string }): void => {
      if (error.code !== '57P01') throw error;
    };
    scratch.on('error', ignoreForcedDrop);
    admin.on('error', ignoreForcedDrop);

    await applyMigrations(db(), (file) => file < FIRST_V2);
    await seedLegacy(db());
    await applyMigrations(db(), (file) => file < CORRECTIONS);
    await seedPlatformDomainRule(db());
    // 1040 직전의 판정 — 결함이 실제로 있었다는 비공허성 근거.
    for (const [n, recipient] of [[3, 'bad@x.com'], [3, 'u@sub.evil.com'], [4, 'x@example.com'], [1, 'extra@inert.com'], [2, 'x@replyauto.com']] as const) {
      before.set(`${String(n)}:${recipient}`, await verdict(n, recipient));
    }
    // L1 은 관문이 이미 플랫폼 도메인 allow 를 버린다(`resolveOutboundRules`) — 1040 전의 결함은 행으로 본다.
    before.set('7:allow', (await activeRules(7, 'allow')).join(','));
    await applyMigrations(db(), () => true);
  }, 180_000);

  afterAll(async () => {
    await scratch?.end();
    if (admin !== undefined && scratchName !== '') await admin.query(`DROP DATABASE IF EXISTS ${scratchName} WITH (FORCE)`);
    await admin?.end();
  });

  it('비공허성 — 1040 전에는 결함이 판정에 보였다(M1 차단 무시 · M4 넓어진 허용 · L1 플랫폼 도메인)', () => {
    expect(Object.fromEntries(before)).toEqual({
      '3:bad@x.com': 'allowed',
      '3:u@sub.evil.com': 'allowed',
      '4:x@example.com': 'allowed',
      '1:extra@inert.com': 'allowed',
      '2:x@replyauto.com': 'allowed',
      '7:allow': 'atmark.ai,peer@atmark.ai',
    });
  });

  it('M1 — 옛 unrestricted + 옛 blocklist → blocklist_only: 예전에 막히던 상대가 다시 막히고, 나머지는 나간다', async () => {
    expect(await currentMode(3)).toEqual({ mode: 'blocklist_only', createdBy: `migration:${CORRECTIONS}` });
    expect(await activeRules(3, 'block')).toEqual(['*.evil.com', 'bad@x.com', 'evil.com']);
    expect(await verdict(3, 'bad@x.com')).toBe('denied:recipient_blocklisted');
    expect(await verdict(3, 'Bad+tag@X.com')).toBe('denied:recipient_blocklisted');
    expect(await verdict(3, 'u@sub.evil.com')).toBe('denied:recipient_blocklisted');
    expect(await verdict(3, 'u@evil.com')).toBe('denied:recipient_blocklisted');
    expect(await verdict(3, 'friend@else.com')).toBe('allowed');
    // 옛 blocklist 가 없던 "전체" 는 그대로(대조군).
    expect(await currentMode(6)).toEqual({ mode: 'unrestricted', createdBy: 'migration:202609241010' });
  });

  it('M4 (a) — `@` 없는 옛 allowlist 항목이 연 도메인은 닫힌다 · 주소 항목은 남는다', async () => {
    expect(await activeRules(4, 'allow')).toEqual(['ok@z.com']);
    expect(await currentMode(4)).toEqual({ mode: 'allowlist_only', createdBy: `migration:${CORRECTIONS}` });
    expect(await verdict(4, 'x@example.com')).toBe('denied:recipient_not_allowlisted');
    expect(await verdict(4, 'x@a.star.com')).toBe('denied:recipient_not_allowlisted');
    expect(await verdict(4, 'ok@z.com')).toBe('allowed');
  });

  it('M4 (b)(c) — 레거시: seed 관계와 approval_required 의 auto_approve 도메인만 남는다', async () => {
    // approval_required: seed + auto.com 남음, 쓰이지 않던 옛 allowlist(extra@inert.com) 제거.
    expect(await activeRules(1, 'allow')).toEqual(['auto.com', 'seed@a.com']);
    expect(await verdict(1, 'extra@inert.com')).toBe('denied:recipient_not_allowlisted');
    expect(await verdict(1, 'seed@a.com')).toBe('allowed');
    expect(await verdict(1, 'x@auto.com')).toBe('allowed');
    // reply_only: seed 둘(소문자·태그 보존)만 — 옛 allowlist(other@b.com)·auto_approve(replyauto.com) 제거.
    expect(await activeRules(2, 'allow')).toEqual(['s@b.com', 'upper+tag@b.com']);
    expect(await verdict(2, 'x@replyauto.com')).toBe('denied:recipient_not_allowlisted');
    expect(await verdict(2, 'other@b.com')).toBe('denied:recipient_not_allowlisted');
    expect(await verdict(2, 's@b.com')).toBe('allowed');
    // 지운 행은 남고 누가 뺐는지 적혀 있다.
    const removed = await db().query<{ value: string; removed_by: string }>(
      `SELECT value, removed_by FROM agent_contact_rules WHERE agent_id = ANY($1::char(32)[]) AND removed_at IS NOT NULL ORDER BY value COLLATE "C"`,
      [[A(1), A(2), A(4)]],
    );
    expect(removed.rows).toEqual(
      ['*.atmark.ai', '*.star.com', 'example.com', 'extra@inert.com', 'other@b.com', 'replyauto.com'].map((value) => ({
        value,
        removed_by: `migration:${CORRECTIONS}`,
      })),
    );
  });

  it('L1 — 발신 allow 의 atmark.ai 도메인 규칙은 누가 만들었든 지워진다 · 정확한 주소는 남는다', async () => {
    expect(await activeRules(7, 'allow')).toEqual(['peer@atmark.ai']);
    expect(await verdict(7, 'anyone@atmark.ai')).toBe('denied:recipient_not_allowlisted');
    expect(await verdict(7, 'peer@atmark.ai')).toBe('allowed');
  });

  it('M3 — 바로잡은 에이전트만 새 버전 한 행 · 그 스냅샷 = 살아 있는 목록 · 대조군은 그대로', async () => {
    const versions = await db().query<{ agent_id: string; n: number }>(
      `SELECT agent_id, count(*)::int AS n FROM policy_versions WHERE created_by = $1 GROUP BY 1 ORDER BY 1`,
      [`migration:${CORRECTIONS}`],
    );
    expect(versions.rows.map((row) => [row.agent_id, row.n])).toEqual([1, 2, 3, 4, 7].map((n) => [A(n), 1]));
    const consistent = await db().query<{ agent_id: string; ok: boolean }>(
      `SELECT agent_id, atmark_contact_rules_match_current_version(agent_id) AS ok FROM agent_policies ORDER BY 1`,
    );
    expect(consistent.rows.every((row) => row.ok)).toBe(true);
    expect(await activeRules(5, 'allow')).toEqual(['a@b.com']);
    expect(await activeRules(5, 'block')).toEqual(['no@b.com']);
  });

  it('M2 — 1040 뒤 DB 의 값 모양 함수는 dot-atom(앱 contactRuleKindOf 와 같은 답)', async () => {
    const samples = ['a.b@x.com', '.a@x.com', 'a.@x.com', 'a..b@x.com', '"a"@x.com', 'a@x.com.', 'x.com', '*.x.com'];
    const result = await db().query<{ v: string; kind: string | null }>('SELECT v, atmark_contact_rule_kind(v) AS kind FROM unnest($1::text[]) v', [samples]);
    expect(result.rows.map((row) => [row.v, row.kind])).toEqual(samples.map((v) => [v, contactRuleKindOf(v)]));
    expect(result.rows.filter((row) => row.kind === null).map((row) => row.v)).toEqual(['.a@x.com', 'a.@x.com', 'a..b@x.com', '"a"@x.com', 'a@x.com.']);
  });

  it('M3 — 1040 뒤에는 버전 없는 목록 변경이 커밋되지 않는다(스크래치 DB 에서도 트리거가 선다)', async () => {
    await expect(
      db().query(`INSERT INTO agent_contact_rules (agent_id, direction, list, kind, value, created_by) VALUES ($1, 'outbound', 'allow', 'address', 'sneak@x.com', 'raw')`, [A(5)]),
    ).rejects.toThrow(/새 정책 버전/);
    expect(await activeRules(5, 'allow')).toEqual(['a@b.com']);
    // 규칙은 그대로 두고 포인터만 목록 없는 버전으로 옮긴다 → 커밋 실패(포인터 쪽 트리거).
    const client = await db().connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO policy_versions (agent_id, version, outbound_mode, inbound_mode, snapshot, created_by)
         SELECT agent_id, version + 1, outbound_mode, inbound_mode, snapshot - 'contact_rules', 'raw'
           FROM policy_versions WHERE agent_id = $1 ORDER BY version DESC LIMIT 1`,
        [A(5)],
      );
      await client.query('UPDATE agent_policies SET current_version = current_version + 1 WHERE agent_id = $1', [A(5)]);
      await expect(client.query('COMMIT')).rejects.toThrow(/새 정책 버전/);
    } finally {
      client.release();
    }
    expect(await currentMode(5)).toEqual({ mode: 'allowlist_only', createdBy: 'migration:202609241010' });
  });
});
