/**
 * 운영자 CLI `pnpm admin:domain` · `pnpm admin:feature`(ADR-0014 단계 4) — 인자 판별(접속 전 입력 오류) · `--revoke-all-policies` 는 atmark.ai 를 건드리지 않는다.
 * DB 동작(해제 · 톰스톤 · 정지)은 `test/integration/domains/{tick,transfer-race}.test.ts` 가 본다.
 */

import { describe, expect, it, vi } from 'vitest';

import { domain, isPlatformIdentity, parseDomainArgs } from '../../../scripts/admin/domain';
import { enabledByOf, parseFeatureArgs } from '../../../scripts/admin/feature';

const ORG = '11111111-1111-4111-8111-111111111111';

describe('admin:feature', () => {
  it('셋 중 하나만 · 기능 이름은 목록 안 · 조직 id 모양 · enabled_by 칸 모양', () => {
    expect(parseFeatureArgs(['--org', ORG, '--enable', 'custom_domains'])).toMatchObject({ kind: 'enable', org: ORG, feature: 'custom_domains' });
    expect(parseFeatureArgs(['--org', ORG, '--disable', 'CUSTOM_DOMAINS'])).toMatchObject({ kind: 'disable', feature: 'custom_domains' });
    expect(parseFeatureArgs(['--list'])).toEqual({ kind: 'list', org: null });
    expect(() => parseFeatureArgs(['--org', ORG, '--enable', 'everything'])).toThrow(/알 수 없는 기능/);
    expect(() => parseFeatureArgs(['--org', 'x', '--enable', 'custom_domains'])).toThrow(/조직 id/);
    expect(() => parseFeatureArgs(['--list', '--enable', 'custom_domains'])).toThrow(/하나만/);
    expect(enabledByOf('admin:feature:Jin Younkyum')).toMatch(/^[a-z0-9][a-z0-9_.:-]{0,63}$/);
  });
});

describe('admin:domain', () => {
  it('명령 하나만 · --domain 은 행 id · region 모양', () => {
    expect(parseDomainArgs(['--unfreeze', '--domain', ORG])).toEqual({ kind: 'unfreeze', domainId: ORG, yes: false });
    expect(parseDomainArgs(['--suspend-all-customer', '--yes'])).toEqual({ kind: 'suspend-all-customer', yes: true });
    expect(parseDomainArgs(['--revoke-all-policies'])).toEqual({ kind: 'revoke-all-policies', region: 'ap-northeast-2', yes: false });
    expect(() => parseDomainArgs(['--suspend'])).toThrow(/도메인 행 id/);
    expect(() => parseDomainArgs(['--suspend', '--unfreeze', '--domain', ORG])).toThrow(/하나만/);
    expect(() => parseDomainArgs(['--revoke-all-policies', '--region', 'mars'])).toThrow(/region/);
  });

  it('--revoke-all-policies — atmark.ai 는 건너뛰고 관리 표시가 있는 identity 의 atmark-sender-* 정책만 지운다(#13 L2) · 비대화형은 --yes 필요', async () => {
    expect(['atmark.ai', 'x.atmark.ai', 'login@atmark.ai'].every(isPlatformIdentity)).toBe(true);
    expect(isPlatformIdentity('agents.example.com')).toBe(false);
    const deletePolicy = vi.fn(async () => undefined);
    const ses = () => ({
      listIdentities: async () => ['atmark.ai', 'agents.a.com', 'agents.b.com'],
      getIdentity: async (name: string) => ({
        tags: name === 'agents.b.com' ? {} : { 'atmark:managed': 'customer-domain' },
        policies: { [`atmark-sender-${name}-0`]: '{}', [`atmark-sender-${name}-1`]: '{}', other: '{}' },
        dkimTokens: [],
        dkimStatus: null,
        mailFromStatus: null,
      }),
      deletePolicy,
    });
    const out: string[] = [];
    const io = { out: (line: string) => out.push(line), err: () => undefined, interactive: false, ask: async () => '' };
    await expect(domain(['--revoke-all-policies'], { env: {}, io, ses })).rejects.toThrow(/--yes/);
    expect(deletePolicy).not.toHaveBeenCalled();
    await domain(['--revoke-all-policies', '--yes'], { env: {}, io, ses });
    expect(deletePolicy.mock.calls.map((call) => (call as unknown[]).slice(0, 2))).toEqual([
      ['agents.a.com', 'atmark-sender-agents.a.com-0'],
      ['agents.a.com', 'atmark-sender-agents.a.com-1'],
    ]);
    expect(out).toEqual(['revoked identities=1 policies=2']);
  });
});
