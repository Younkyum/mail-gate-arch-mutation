/**
 * 잎 `domain.status`(202609291130, ADR-0014 · 계획 §3.10) — 빌더의 모양. 평문 = 도메인 행 id · 상태 · 정지 사유 · 수신 MX 판정(코드), **도메인
 * 이름은 커밋으로만**(잎은 append-only — `identity.address_assigned` 와 같은 규율, N7). 모양이 아닌 코드는 평문에서 빠지고
 * 커밋으로 간다(빌더 공통 규칙), 시각이 모양이 아니면 TypeError(서열기가 `source.missing(unrepresentable)` 로 커밋). 검증기 판 5 는 단계 3 이다.
 */

import { describe, expect, it } from 'vitest';

import { buildOrgLeaf, type OrgEvent } from '../../../src/tlog/leaf';

const CONTEXT = { log: 'c'.repeat(32), seq: 4, saltKey: Buffer.alloc(32, 9) };
const AT = '2026-09-29T01:02:03.000000Z';
const DOMAIN_ID = '00000000-0000-4000-8000-00000000000d';

function domainStatus(overrides: Partial<Extract<OrgEvent, { kind: 'domain.status' }>> = {}): OrgEvent {
  return {
    kind: 'domain.status',
    src: { t: 'custom_domains', id: DOMAIN_ID, e: 'update', r: 2 },
    at: AT,
    domainId: DOMAIN_ID,
    status: 'suspended',
    reason: 'ownership_lost',
    inbound: 'ses',
    domain: 'agents.sentinel-customer.com',
    ...overrides,
  };
}

describe('domain.status 잎', () => {
  it('평문은 코드뿐 · 도메인 이름은 커밋 c.domain 으로만(센티넬이 JSON 에 없다)', () => {
    const leaf = buildOrgLeaf(CONTEXT, domainStatus());
    expect(leaf.kind).toBe('domain.status');
    expect(leaf.json).not.toContain('sentinel-customer');
    expect(leaf.json).not.toContain('@');
    const parsed = JSON.parse(leaf.json) as { body: Record<string, unknown>; c: Record<string, unknown>; src: Record<string, unknown> };
    expect(parsed.body).toEqual({ domain_id: DOMAIN_ID, status: 'suspended', reason: 'ownership_lost', inbound: 'ses' });
    expect(Object.keys(parsed.c)).toEqual(['domain']);
    expect(parsed.src).toEqual({ t: 'custom_domains', id: DOMAIN_ID, e: 'update', r: 2 });
  });

  it('정지 사유가 없으면 null · 같은 입력이면 같은 바이트', () => {
    const verified = buildOrgLeaf(CONTEXT, domainStatus({ status: 'verified', reason: null }));
    expect((JSON.parse(verified.json) as { body: { reason: unknown } }).body.reason).toBeNull();
    expect(buildOrgLeaf(CONTEXT, domainStatus()).json).toBe(buildOrgLeaf(CONTEXT, domainStatus()).json);
  });

  it('모양이 아닌 코드·id 는 평문에 싣지 않고 커밋으로 옮긴다(빌더 공통 규칙) · 빈 at 은 TypeError', () => {
    const odd = JSON.parse(buildOrgLeaf(CONTEXT, domainStatus({ status: 'Suspended!', domainId: 'not-a-uuid' })).json) as {
      body: Record<string, unknown>;
      c: Record<string, unknown>;
    };
    expect(odd.body).toMatchObject({ status: null, domain_id: null });
    expect(Object.keys(odd.c).sort()).toEqual(['body.domain_id', 'body.status', 'domain']);
    expect(() => buildOrgLeaf(CONTEXT, domainStatus({ at: '' }))).toThrow(TypeError);
  });
});
