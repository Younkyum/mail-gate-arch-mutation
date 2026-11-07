/**
 * 정책 v2 — DB 쪽 사실 (202609241010 · 1020 · 1030).
 *
 *   ① 값 모양: 앱(`contact-rules.ts` `contactRuleKindOf`)과 DB(`atmark_contact_rule_kind`)가 **같은 판정**을 한다 — 앱이 받고 DB 가
 *      거부하면 500, DB 가 받고 앱이 거부하면 두 번째 벽이 빈다.
 *   ② 이전 결과(사후 검증 — 운영의 진윤겸 에이전트(Chronostasis)에도 같은 질의가 선다): 이전이 만든 버전은 레거시 모드가 아니고,
 *      스냅샷에 수신 모드·목록이 있고, 옛 목록 키가 없다. 레거시였던 에이전트의 seed·approved 관계(주소·도메인)는 발신 allow 로 옮겨졌다.
 *   ③ migrate `status` 가 이전 결과를 이름으로 보인다(`policyV2`).
 *
 * **`TEST_DATABASE_URL`·`TEST_MIGRATION_DATABASE_URL` 이 없으면 통째로 건너뛴다.**
 */

import { afterAll, describe, expect, it } from 'vitest';

import { createPool } from '../../../src/db/client';
import { contactRuleKindOf } from '../../../src/policy/contact-rules';
import { createMigrateHandler, type MigrationStatus } from '../../../src/runtime/handlers/migrate';
import type { LambdaContext } from '../../../src/runtime/lambda';
import { closeTestPool, DATABASE_AVAILABLE, provisioningPool } from './support/harness';

const OWNER_AVAILABLE = (process.env['TEST_MIGRATION_DATABASE_URL'] ?? '').trim() !== '';

afterAll(async () => {
  if (DATABASE_AVAILABLE) await closeTestPool();
});

const SAMPLES: readonly string[] = [
  'a@example.com',
  'first.last+tag@sub.example.co.kr',
  "o'brien@example.ie",
  'x!#$%&*/=?^_`{|}~-@example.com',
  'example.com',
  '*.example.com',
  'xn--bcher-kva.example',
  'a-b.c-d.example',
  '',
  '@example.com',
  'a@',
  'a@localhost',
  'localhost',
  'a b@example.com',
  'A@example.com',
  'Example.com',
  'bücher.example',
  '한글@example.com',
  '*example.com',
  'a.*.example.com',
  '-bad.example.com',
  'bad-.example.com',
  'a@@example.com',
  'a@-x.example',
  'a@x..example',
  '**.example.com',
  'a"b@example.com',
  'a(b)@example.com',
  'a@example.com\n',
  `${'a'.repeat(64)}@example.com`,
  `${'a'.repeat(65)}@example.com`,
  `${'b'.repeat(63)}.example`,
  `${'b'.repeat(64)}.example`,
  `${'c.'.repeat(126)}ab`,
  `${'c.'.repeat(127)}ab`,
  // dot-atom(202609241040 — 검증 M2): 앞·뒤·연속 점 로컬파트·따옴표·끝 점 도메인은 목록 값이 아니다.
  '.a@example.com',
  'a.@example.com',
  'a..b@example.com',
  'a.b.c@example.com',
  '"a"@example.com',
  'a@example.com.',
  'example.com.',
  `${'a'.repeat(30)}.${'b'.repeat(33)}@example.com`,
  `${'a'.repeat(30)}.${'b'.repeat(34)}@example.com`,
];

describe.skipIf(!DATABASE_AVAILABLE || !OWNER_AVAILABLE)('정책 v2 — DB 쪽 사실', () => {
  it('① 값 모양 — 앱 contactRuleKindOf 와 DB atmark_contact_rule_kind 가 표본 전부에서 같은 답', async () => {
    const result = await provisioningPool().query<{ value: string; kind: string | null }>(
      'SELECT v AS value, atmark_contact_rule_kind(v) AS kind FROM unnest($1::text[]) AS v',
      [[...SAMPLES]],
    );
    const mismatches = result.rows.filter((row) => row.kind !== contactRuleKindOf(row.value)).map((row) => `${JSON.stringify(row.value)} db=${String(row.kind)} app=${String(contactRuleKindOf(row.value))}`);
    expect(mismatches).toEqual([]);
    // 비공허성 — 둘 다의 답이 섞여 있다.
    expect(new Set(result.rows.map((row) => row.kind))).toEqual(new Set(['address', 'domain', null]));
  });

  it('② 이전 결과 — 이전이 만든 버전은 레거시가 아니고 스냅샷이 목록·수신 모드를 싣고, 옛 목록 키가 없다', async () => {
    const db = provisioningPool();
    const bad = await db.query<{ agent_id: string; problem: string }>(
      `SELECT v.agent_id,
              CASE
                WHEN v.outbound_mode IN ('approval_required', 'reply_only') THEN 'legacy_mode'
                WHEN NOT (v.snapshot ? 'contact_rules') OR jsonb_typeof(v.snapshot -> 'contact_rules') <> 'array' THEN 'no_rules_in_snapshot'
                WHEN NOT (v.snapshot ? 'inbound_mode') THEN 'no_inbound_mode_in_snapshot'
                WHEN (v.snapshot -> 'config_json') ? 'allowlist' OR (v.snapshot -> 'config_json') ? 'blocklist' THEN 'old_lists_in_snapshot'
                WHEN NOT EXISTS (SELECT 1 FROM policy_versions p WHERE p.agent_id = v.agent_id AND p.version = v.version - 1) THEN 'no_previous_version'
              END AS problem
         FROM policy_versions v
        WHERE v.created_by = 'migration:202609241010'`,
    );
    expect(bad.rows.filter((row) => row.problem !== null)).toEqual([]);
  });

  it('② 이전 결과 — 레거시였던 에이전트의 seed·approved 관계(주소·도메인, 모양이 맞는 것)는 전부 발신 allow 규칙이 됐다', async () => {
    const db = provisioningPool();
    const missing = await db.query<{ agent_id: string; value: string }>(
      `SELECT r.agent_id, lower(CASE r.scope WHEN 'recipient' THEN r.address ELSE r.domain END) AS value
         FROM policy_versions v
         JOIN policy_versions prev ON prev.agent_id = v.agent_id AND prev.version = v.version - 1
         JOIN sender_relationships r ON r.agent_id = v.agent_id
        WHERE v.created_by = 'migration:202609241010'
          AND prev.outbound_mode IN ('approval_required', 'reply_only')
          AND v.outbound_mode = 'allowlist_only'
          AND r.trust_category IN ('seed', 'approved')
          AND r.scope IN ('recipient', 'domain')
          AND r.created_at <= v.created_at
          AND atmark_contact_rule_kind(lower(CASE r.scope WHEN 'recipient' THEN r.address ELSE r.domain END)) IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM agent_contact_rules c
             WHERE c.agent_id = r.agent_id AND c.direction = 'outbound' AND c.list = 'allow'
               AND c.value = lower(CASE r.scope WHEN 'recipient' THEN r.address ELSE r.domain END))
        LIMIT 20`,
    );
    expect(missing.rows).toEqual([]);
  });

  it('③ migrate status 가 이전 결과를 보인다 — policyV2 { legacyOutboundModeAgents, configListAgents, contactRules }', async () => {
    // 핸들러는 끝나면 풀을 닫는다 — 공유 풀이 아니라 이 테스트만의 풀을 준다.
    const pool = createPool(process.env['TEST_MIGRATION_DATABASE_URL'] ?? '', { max: 1 });
    const handler = createMigrateHandler({
      owner: () => Promise.resolve({ deps: null, pool }),
      bootstrap: () => Promise.reject(new Error('쓰지 않는다')),
    });
    const status = (await handler({ action: 'status' }, { awsRequestId: 'policy-v2-status' } as LambdaContext)) as MigrationStatus;
    expect(status.policyV2).not.toBeNull();
    expect(status.policyV2).toMatchObject({
      legacyOutboundModeAgents: expect.any(Number) as unknown,
      configListAgents: expect.any(Number) as unknown,
    });
    expect(Object.keys(status.policyV2?.contactRules ?? {}).every((key) => /^(inbound|outbound):(allow|block)$/.test(key))).toBe(true);
    // 가드 이름이 status 에 올라 있다 — 지우기 표시 한 번·DELETE 불가·값 모양·정책 사유 모양.
    expect(status.missingGuards.filter((guard) => guard.includes('agent_contact_rules') || guard.includes('policy_reason'))).toEqual([]);
  });
});
