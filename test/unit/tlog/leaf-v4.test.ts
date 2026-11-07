/**
 * tlog v4(202609270115, ADR-0013 2차) — 잎 빌더의 두 변경.
 *   ① `billing.entitlement` 는 필수 아홉 칸 + 늦은 두 칸을 **둘 다 있거나 둘 다 없음**으로 받는다(9칸 레거시 · 11칸). 10칸은 TypeError(서열기가
 *      `source.missing(unrepresentable)` 로 커밋). 9칸 잎의 바이트는 v4 전과 같다(과거 잎 해시 불변 — 키가 없으면 JCS 에도 없다).
 *   ② `identity.address_retired` — 평문은 에이전트 id 뿐, 주소는 커밋.
 */

import { describe, expect, it } from 'vitest';

import { buildOrgLeaf, ENTITLEMENT_LATE_LIMIT_FIELDS, type OrgEvent } from '../../../src/tlog/leaf';

const CONTEXT = { log: 'a'.repeat(32), seq: 3, saltKey: Buffer.alloc(32, 7) };
const AT = '2026-09-27T01:02:03.000000Z';
const NINE = {
  max_agents: 10,
  org_daily_recipients: 1000,
  agent_per_day_max: 300,
  agent_per_minute_max: 30,
  recipients_per_message_max: 25,
  tokens_per_agent_max: 5,
  webhook_endpoints_per_agent_max: 3,
  org_api_keys_max: 2,
  inbound_storage_bytes: 10737418240,
};

function entitlement(limits: Record<string, number>): OrgEvent {
  return { kind: 'billing.entitlement', src: { t: 'org_entitlements', id: '00000000-0000-4000-8000-000000000001', e: 'update', r: 1 }, at: AT, planCode: 'pro', cause: 'operator', version: 2, limits, graceUntil: null };
}

describe('tlog v4 잎 빌더', () => {
  it('9칸(레거시) 잎에는 늦은 두 칸 키가 없다 · 11칸 잎에는 둘 다 있다', () => {
    const nine = JSON.parse(buildOrgLeaf(CONTEXT, entitlement(NINE)).json) as { body: Record<string, unknown> };
    for (const field of ENTITLEMENT_LATE_LIMIT_FIELDS) expect(Object.hasOwn(nine.body, field), field).toBe(false);
    const eleven = JSON.parse(buildOrgLeaf(CONTEXT, entitlement({ ...NINE, aliases_per_agent_max: 5, attachment_bytes_total_max: 10485760 })).json) as {
      body: Record<string, unknown>;
    };
    expect(eleven.body).toMatchObject({ aliases_per_agent_max: 5, attachment_bytes_total_max: 10485760 });
  });

  it('9칸 잎 바이트 = 늦은 칸을 모르는 옛 빌더의 바이트(키 순서 JCS · 과거 해시 불변)', () => {
    const json = buildOrgLeaf(CONTEXT, entitlement(NINE)).json;
    expect(json).toBe(
      '{"at":"2026-09-27T01:02:03.000000Z","body":{"agent_per_day_max":300,"agent_per_minute_max":30,"cause":"operator","grace_until":null,"inbound_storage_bytes":10737418240,"max_agents":10,"org_api_keys_max":2,"org_daily_recipients":1000,"plan_code":"pro","recipients_per_message_max":25,"tokens_per_agent_max":5,"version":2,"webhook_endpoints_per_agent_max":3},"c":{},"kind":"billing.entitlement","log":"' +
        'a'.repeat(32) +
        '","seq":3,"src":{"e":"update","id":"00000000-0000-4000-8000-000000000001","r":1,"t":"org_entitlements"},"v":1}',
    );
  });

  it('10칸(늦은 두 칸 중 하나만) · 음수는 잎 모양이 아니다(TypeError)', () => {
    expect(() => buildOrgLeaf(CONTEXT, entitlement({ ...NINE, aliases_per_agent_max: 5 }))).toThrow(TypeError);
    expect(() => buildOrgLeaf(CONTEXT, entitlement({ ...NINE, attachment_bytes_total_max: 10485760 }))).toThrow(TypeError);
    expect(() => buildOrgLeaf(CONTEXT, entitlement({ ...NINE, aliases_per_agent_max: -1, attachment_bytes_total_max: 0 }))).toThrow(TypeError);
  });

  it('identity.address_retired — 평문은 agent_id 뿐 · 주소는 커밋 · 빈 at 은 모양이 아니다', () => {
    const event: OrgEvent = {
      kind: 'identity.address_retired',
      src: { t: 'agent_addresses', id: '00000000-0000-4000-8000-000000000002', e: 'update', r: 1 },
      at: AT,
      agentId: 'b'.repeat(32),
      address: 'alias-7@atmark.ai',
    };
    const leaf = JSON.parse(buildOrgLeaf(CONTEXT, event).json) as { body: Record<string, unknown>; c: Record<string, string> };
    expect(leaf.body).toEqual({ agent_id: 'b'.repeat(32) });
    expect(Object.keys(leaf.c)).toEqual(['address']);
    expect(JSON.stringify(leaf)).not.toContain('@');
    expect(() => buildOrgLeaf(CONTEXT, { ...event, at: '' })).toThrow(TypeError);
  });
});
