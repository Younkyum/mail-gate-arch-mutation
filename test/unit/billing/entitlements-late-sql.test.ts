/**
 * 메일 기본기 2차 D6 — 마이그레이션 `202609270105`(두 칸 · 채움 트리거 · 출처-롤 가드 열한 칸) · `202609270120`(백필) · `202609270115`(tlog v4)의
 * 상수 = 코드 상수(AC-D6-1). 한쪽만 바꾸면 여기서 빨개진다.
 *
 *   - 두 칸의 CHECK 상한 = `ENTITLEMENT_CEILINGS`(별칭 20 · 첨부 25 MiB, 첨부는 MiB 배수).
 *   - 채움 트리거의 CASE = `PLAN_CATALOG`(다섯 요금제 모두 — 옛 코드의 INSERT 가 어느 요금제든 채워진다).
 *   - 출처-롤 가드의 배열 넷(free·pro·team·scale) = `PLAN_CATALOG` 를 `LIMIT_COLUMNS` 순서(열한 칸)로 · beta 배열 없음 · 루프 11.
 *   - 백필 VALUES = `PLAN_CATALOG` 의 두 칸.
 *   - tlog v4 의 `tlog_enqueue()` 가 202609250300 의 정의를 **줄마다 그대로** 담는다(R17 — 기존 분기가 깨지지 않는다) · 스냅샷 두 칸 ·
 *     잎 종류 CHECK = `ORG_LEAF_KINDS`.
 * 실제 DB 동작(전환 · 백필 · 카탈로그 거부)은 통합 테스트 `test/integration/tlog/entitlement-v4-transition.test.ts` 가 본다.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { MAX_ACTIVE_ALIASES_PER_AGENT, MAX_ALIASES_ISSUED_PER_AGENT, MAX_ALIASES_PER_ORG_PER_DAY } from '../../../src/admin/ops/addresses';
import { ENTITLEMENT_CEILINGS, LIMIT_COLUMNS, MIB, PLAN_CATALOG, PLAN_CODES } from '../../../src/billing/plans';
import { ORG_LEAF_KINDS } from '../../../src/tlog/constants';
import { ENTITLEMENT_LATE_LIMIT_FIELDS, ENTITLEMENT_LIMIT_FIELDS } from '../../../src/tlog/leaf';

const read = (name: string): string => readFileSync(new URL(`../../../src/db/migrations/${name}`, import.meta.url), 'utf8');
const stripComments = (sql: string): string => sql.replace(/--[^\n]*/g, '');
const M0105 = stripComments(read('202609270105_entitlements_aliases_attachments.sql'));
const M0115 = read('202609270115_tlog_v4.sql');
const M0120 = stripComments(read('202609270120_entitlements_backfill.sql'));
const M0300 = read('202609250300_org_entitlements.sql');

describe('202609270105 = src/billing/plans.ts', () => {
  it('LIMIT_COLUMNS 끝의 두 칸 = 잎의 늦은 두 칸(순서까지)', () => {
    expect(LIMIT_COLUMNS.slice(-2).map(([, column]) => column)).toEqual([...ENTITLEMENT_LATE_LIMIT_FIELDS]);
    expect(LIMIT_COLUMNS.slice(0, -2).map(([, column]) => column)).toEqual([...ENTITLEMENT_LIMIT_FIELDS]);
  });

  it('두 칸 CHECK 상한 = 천장(별칭 20 · 첨부 25 MiB · MiB 배수)', () => {
    const aliases = /aliases_per_agent_max BETWEEN 0 AND (\d+)\)/.exec(M0105);
    expect(Number(aliases?.[1])).toBe(ENTITLEMENT_CEILINGS.aliasesPerAgentMax);
    const attachments = /attachment_bytes_total_max BETWEEN 0 AND (\d+) AND attachment_bytes_total_max % (\d+) = 0/.exec(M0105);
    expect(Number(attachments?.[1])).toBe(ENTITLEMENT_CEILINGS.attachmentBytesTotalMax);
    expect(Number(attachments?.[2])).toBe(MIB);
    expect(ENTITLEMENT_CEILINGS.aliasesPerAgentMax).toBe(20);
    expect(ENTITLEMENT_CEILINGS.attachmentBytesTotalMax).toBe(25 * MIB);
  });

  it('카탈로그 = 결정 표(D6) — 별칭 0/3/5/10/20 · 첨부 5/10/10/20/25 MiB', () => {
    expect(PLAN_CODES.map((plan) => PLAN_CATALOG[plan].aliasesPerAgentMax)).toEqual([0, 3, 5, 10, 20]);
    expect(PLAN_CODES.map((plan) => PLAN_CATALOG[plan].attachmentBytesTotalMax / MIB)).toEqual([5, 10, 10, 20, 25]);
    for (const plan of PLAN_CODES) expect(PLAN_CATALOG[plan].attachmentBytesTotalMax % MIB, plan).toBe(0);
  });

  it('채움 트리거의 CASE 두 개 = PLAN_CATALOG(다섯 요금제)', () => {
    const body = /CREATE FUNCTION org_entitlements_fill_new_limits\(\)[\s\S]*?\$\$;/.exec(M0105)?.[0] ?? '';
    const cases = [...body.matchAll(/CASE NEW\.plan_code\s+([\s\S]*?)END;/g)].map((match) => match[1] ?? '');
    expect(cases).toHaveLength(2);
    const parse = (text: string): Record<string, number> =>
      Object.fromEntries([...text.matchAll(/WHEN '([a-z]+)' THEN (\d+)/g)].map((match) => [match[1] ?? '', Number(match[2])]));
    expect(parse(cases[0] ?? '')).toEqual(Object.fromEntries(PLAN_CODES.map((plan) => [plan, PLAN_CATALOG[plan].aliasesPerAgentMax])));
    expect(parse(cases[1] ?? '')).toEqual(Object.fromEntries(PLAN_CODES.map((plan) => [plan, PLAN_CATALOG[plan].attachmentBytesTotalMax])));
  });

  it('출처-롤 가드의 카탈로그 배열 넷 = PLAN_CATALOG(LIMIT_COLUMNS 열한 칸) · beta 배열 없음 · 칸별 비교 11', () => {
    for (const plan of ['free', 'pro', 'team', 'scale'] as const) {
      const match = new RegExp(`${plan}_limits CONSTANT bigint\\[\\] := ARRAY\\[([^\\]]*)\\]`).exec(M0105);
      expect(match, plan).not.toBeNull();
      expect((match?.[1] ?? '').split(',').map((value) => Number(value.trim())), plan).toEqual(LIMIT_COLUMNS.map(([key]) => PLAN_CATALOG[plan][key]));
    }
    expect(M0105).not.toMatch(/beta_limits/);
    expect(M0105).toMatch(/FOR i IN 1 \.\. 11 LOOP/);
    // 옛 billing-sync 의 UPDATE(두 칸 그대로)는 카탈로그로 맞춘다 — 끝의 두 자리.
    expect(M0105).toMatch(/NEW\.aliases_per_agent_max := catalog\[10\];/);
    expect(M0105).toMatch(/NEW\.attachment_bytes_total_max := catalog\[11\];/);
    // 원인 CHECK 을 넓힌 대신 billing 롤의 원인을 가드가 묶는다.
    expect(M0105).toMatch(/NEW\.cause NOT IN \('provider_event', 'grace_expired', 'reconcile'\)/);
  });

  it('맨 위에서 잠금 시간 5초 · 새 CHECK 는 NOT VALID(검증은 0106)', () => {
    expect(M0105.trimStart().startsWith("SET LOCAL lock_timeout = '5s';")).toBe(true);
    expect(M0105.match(/\) NOT VALID/g)?.length).toBe(3);
    const validate = read('202609270106_entitlements_aliases_attachments_validate.sql');
    for (const name of ['org_entitlements_aliases_per_agent_max_check', 'org_entitlements_attachment_bytes_total_max_check', 'org_entitlements_source_cause']) {
      expect(validate).toContain(`VALIDATE CONSTRAINT ${name};`);
    }
  });
});

describe('202609270110 별칭 천장 = 적용 지점 상수 = 엔타이틀먼트 천장(AC-D6-1)', () => {
  const M0110 = stripComments(read('202609270110_agent_address_aliases.sql'));
  it('활성 20 · 누적 20 · 조직 하루 20 — DB 트리거 = ops/addresses.ts 상수 · 활성 천장 = ENTITLEMENT_CEILINGS', () => {
    expect(Number(/IF active >= (\d+) THEN/.exec(M0110)?.[1])).toBe(MAX_ACTIVE_ALIASES_PER_AGENT);
    expect(Number(/IF issued >= (\d+) THEN/.exec(M0110)?.[1])).toBe(MAX_ALIASES_ISSUED_PER_AGENT);
    expect(Number(/IF today >= (\d+) THEN/.exec(M0110)?.[1])).toBe(MAX_ALIASES_PER_ORG_PER_DAY);
    expect(MAX_ACTIVE_ALIASES_PER_AGENT).toBe(ENTITLEMENT_CEILINGS.aliasesPerAgentMax);
    // 잠금 키 = 앱의 조직 잠금(`addAliasOp`).
    expect(M0110).toContain("hashtextextended('agent_addresses_org:' || org::text, 0)");
  });
});

describe('202609270120 백필 = 카탈로그', () => {
  it('VALUES 다섯 = PLAN_CATALOG 의 두 칸', () => {
    for (const plan of PLAN_CODES) {
      const match = new RegExp(`\\('${plan}', (\\d+), (\\d+)\\)`).exec(M0120);
      expect(match, plan).not.toBeNull();
      expect([Number(match?.[1]), Number(match?.[2])], plan).toEqual([PLAN_CATALOG[plan].aliasesPerAgentMax, PLAN_CATALOG[plan].attachmentBytesTotalMax]);
    }
    expect(M0120).toMatch(/cause = 'backfill'/);
    expect(M0120).toMatch(/version = e\.version \+ 1/);
    expect(M0120).toMatch(/SET NOT NULL/);
  });
});

describe('202609270115 tlog v4 — tlog_enqueue 재정의(R17)', () => {
  const definition = (sql: string): string => /CREATE OR REPLACE FUNCTION tlog_enqueue\(\)[\s\S]*?\n\$\$;/.exec(sql)?.[0] ?? '';

  it('202609250300 정의의 모든 줄이 v4 정의에 있다(기존 분기 글자 그대로)', () => {
    const before = definition(M0300);
    const after = definition(M0115);
    expect(before.length).toBeGreaterThan(1000);
    const afterLines = new Set(after.split('\n'));
    for (const line of before.split('\n')) expect(afterLines.has(line), line).toBe(true);
  });

  it('스냅샷 두 칸 · 주소 갱신 분기 · 폐기 트리거는 retired_at NULL → 값에만', () => {
    const after = definition(M0115);
    for (const field of ENTITLEMENT_LATE_LIMIT_FIELDS) expect(after).toContain(`'${field}', NEW.${field},`);
    expect(after).toContain("ELSIF TG_TABLE_NAME = 'agent_addresses' AND event = 'update' THEN");
    expect(M0115).toMatch(/AFTER UPDATE OF retired_at ON agent_addresses FOR EACH ROW\s+WHEN \(OLD\.retired_at IS NULL AND NEW\.retired_at IS NOT NULL\)/);
  });

  it('잎 종류 CHECK = ORG_LEAF_KINDS · 폐기 잎은 agent_addresses 의 update 에서만', () => {
    const list = /tlog_leaves_kind_check CHECK \(kind IN \(([\s\S]*?)\)\) NOT VALID/.exec(M0115)?.[1] ?? '';
    // 0115 는 v4 시점의 목록이다 — 그 뒤 202609291130(ADR-0014)이 `domain.status` 를, 202610021110 이 `identity.primary_set` 을 더했다(교체형
    // CHECK 의 상위 집합 규칙은 `test/arch/tlog-kind-check.arch.test.ts` 가 마이그레이션 전체에서 본다).
    const V4_KINDS = ORG_LEAF_KINDS.filter((kind) => kind !== 'domain.status' && kind !== 'identity.primary_set');
    expect([...list.matchAll(/'([a-z_.]+)'/g)].map((match) => match[1]).sort()).toEqual([...V4_KINDS].sort());
    expect(M0115).toContain("WHEN kind = 'identity.address_retired' THEN source_table = 'agent_addresses' AND event = 'update'");
  });
});
