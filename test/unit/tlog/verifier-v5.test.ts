/**
 * 검증기 판 5(ADR-0014 단계 3 · 개정 — 리드 결정 2026-10-02) — 고객 도메인 잎 `domain.status` ↔ 원천 `custom_domains`, 대표 주소 선택 잎
 * `identity.primary_set` ↔ 원천 `agent_primary_changes`.
 *
 *   ① 판 요구는 **조건부**다: 그 잎·행이 없는 번들은 `min_verifier_version: 4` 그대로이고 판 4(동결본)·판 5 둘 다 통과한다 — 도메인이 없는 조직의
 *      소유자는 검증기를 갱신하지 않아도 된다. 그 잎이 든 번들은 5 를 요구하고 판 4 는 `verifier_outdated` 로 멈춘다.
 *   ② 서버가 5 를 4 로 낮춰 실어도 판 4 는 그 잎을 통과시키지 않는다(닫힌 쪽 — 요구 판은 친절이지 보안 경계가 아니다).
 *   ③ 판 5 의 원천 대조: 상태·사유·수신 MX 접기, 도메인 이름 커밋, 잎 없는 생성·제거, 대표 주소 커밋·원인·시각, 미래 시각, update 잎 거부.
 *   ④ 잎 모양(ADR 개정에 박는 값): 평문에 도메인·주소 없음(`@` 0).
 *   ⑤ 신원 블록 파일: `identity.primary_set` 은 체인의 블록 · `domains`(도메인 사건, 체인 밖)는 판 5 와 2차 검증기가 본다.
 */

import { describe, expect, it } from 'vitest';

import { verifyBundle, verifyIdentityBlocks, VERIFIER_VERSION } from '../../../scripts/tlog-verify/verifier';
import { blockHashOf, GENESIS_BLOCK_HASH, IDENTITY_BLOCKS_FORMAT } from '../../../src/tlog/identity-blocks';
import { buildOrgLeaf } from '../../../src/tlog/leaf';
import { DOMAIN_MIN_VERIFIER_VERSION, MIN_VERIFIER_VERSION } from '../../../src/tlog/proofs';
import { verifyBundle as verifyBundleV4, verifyIdentityBlocks as verifyIdentityBlocksV4 } from '../../support/legacy/tlog-verifier-v4';
import { secondVerifyIdentityBlocks } from '../../support/tlog-second-verifier';
import { SYNTHETIC_CUSTOM_DOMAIN, SYNTHETIC_PRIMARY_ADDRESS, syntheticHistory } from '../../support/tlog-synthetic';

const IDENTITY_SINCE = '2026-09-24T01:30:00.000000Z';
const codes = (report: { errors: readonly { code: string }[] }): string[] => report.errors.map((issue) => issue.code);

type Bundle = Record<string, unknown> & { sources: { rows: Record<string, unknown>[] }; leaves: { leaf: string }[] };
const asBundle = (value: Record<string, unknown>): Bundle => value as Bundle;

/** 원천 행 하나를 비튼 사본(t 로 고른다). `null` 이면 그 행을 뺀다. */
function withRow(bundle: Record<string, unknown>, table: string, patch: Record<string, unknown> | null): Record<string, unknown> {
  const copy = structuredClone(bundle) as Bundle;
  copy.sources.rows = copy.sources.rows.flatMap((row) => (row['t'] !== table ? [row] : patch === null ? [] : [{ ...row, ...patch }]));
  return copy;
}

const v5History = syntheticHistory({ tag: 'v5', epochs: 8, identitySince: IDENTITY_SINCE, v5Events: true });
const vkey = v5History.signer.vkey;

describe('① 판 요구는 그 잎이 있을 때만 5 다', () => {
  it('상수 — 기본 4 · 도메인/대표 주소 5 = 이 검증기', () => {
    expect(MIN_VERIFIER_VERSION).toBe(4);
    expect(DOMAIN_MIN_VERIFIER_VERSION).toBe(5);
    // 이 검증기는 판 6(운영자 행위자 — 202610131610)이다 — 판 5 번들을 그대로 읽는다.
    expect(VERIFIER_VERSION).toBe(6);
  });

  it('도메인·대표 주소 잎이 없는 번들 — min 4 · 판 4 와 판 5 둘 다 통과', () => {
    const plain = syntheticHistory({ tag: 'v5-plain', epochs: 6, identitySince: IDENTITY_SINCE });
    const bundle = plain.bundle(0, 5);
    expect(bundle['min_verifier_version']).toBe(4);
    expect(verifyBundle(bundle, { pinnedVkey: plain.signer.vkey }).errors).toEqual([]);
    expect(verifyBundleV4(bundle, { pinnedVkey: plain.signer.vkey }).errors).toEqual([]);
  });

  it('도메인을 가진 조직은 범위에 그 잎이 없어도(에폭 0~3) 도메인 행이 늘 실려 min 5 — 판 5 통과(기준 잎 없음 = 맥락) · 판 4 는 outdated', () => {
    const early = v5History.bundle(0, 3);
    expect(early['min_verifier_version']).toBe(5);
    expect(asBundle(early).sources.rows.filter((row) => row['t'] === 'custom_domains')).toHaveLength(1);
    expect(asBundle(early).sources.rows.some((row) => row['t'] === 'agent_primary_changes')).toBe(false);
    expect(verifyBundle(early, { pinnedVkey: vkey }).errors).toEqual([]);
    expect(verifyBundleV4(early, { pinnedVkey: vkey }).errors.map((issue) => issue.code)).toEqual(['verifier_outdated']);
  });

  it('그 잎이 든 번들 — min 5 · 판 5 통과 · 판 4 는 verifier_outdated', () => {
    const bundle = v5History.bundle(0, 5);
    expect(bundle['min_verifier_version']).toBe(5);
    const report = verifyBundle(bundle, { pinnedVkey: vkey });
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
    expect(codes(verifyBundleV4(bundle, { pinnedVkey: vkey }))).toEqual(['verifier_outdated']);
  });
});

describe('② 서버가 요구 판을 낮춰도 판 4 는 그 잎을 통과시키지 않는다', () => {
  it('min 4 로 낮춘 도메인 번들 → 판 4 는 원천 대조에서 실패(행 없음·모르는 표)', () => {
    const lowered = { ...v5History.bundle(0, 5), min_verifier_version: 4 };
    const report = verifyBundleV4(lowered, { pinnedVkey: vkey });
    expect(report.ok).toBe(false);
    expect(codes(report).some((code) => code === 'row_leaf_mismatch' || code === 'row_without_leaf' || code === 'leaf_without_row')).toBe(true);
  });

  it('원천 행까지 빼고 낮춰도 → 판 4 는 leaf_without_row', () => {
    const stripped = withRow(withRow({ ...v5History.bundle(0, 5), min_verifier_version: 4 }, 'custom_domains', null), 'agent_primary_changes', null);
    expect(codes(verifyBundleV4(stripped, { pinnedVkey: vkey }))).toContain('leaf_without_row');
  });
});

describe('③ 판 5 원천 대조', () => {
  const bundle = v5History.bundle(0, 5);

  it.each([
    ['상태', { status: 'suspended', suspended_reason: 'operator' }, 'status'],
    ['수신 MX', { inbound_mx_status: 'other' }, 'inbound'],
    ['도메인 이름(커밋)', { domain: 'agents.someone-else.com' }, 'c.domain'],
    ['생성 시각', { created_at: '2026-09-24T04:00:00.000002Z' }, 'at'],
  ] as const)('custom_domains %s 를 바꾸면 row_leaf_mismatch(%s)', (_label, patch, field) => {
    const report = verifyBundle(withRow(bundle, 'custom_domains', patch), { pinnedVkey: vkey });
    expect(codes(report)).toEqual(['row_leaf_mismatch']);
    expect(report.errors[0]?.detail).toContain(field);
  });

  it('창 끝 뒤에 바뀐 행이 마지막 잎과 다르면 경고 + 저장 상태에 대기 — 다음 번들이 잎 없이 풀지 못하면 domain_update_leaf_missing(보안 리뷰 M3)', () => {
    const changed = { status: 'suspended', suspended_reason: 'dkim_failed', updated_at: '2026-09-24T06:30:00.000000Z' };
    const first = verifyBundle(withRow(bundle, 'custom_domains', changed), { pinnedVkey: vkey });
    expect(first.errors).toEqual([]);
    expect(first.warnings.some((warning) => warning.startsWith('domain_fold_deferred'))).toBe(true);
    const pending = first.state?.domain_folds?.find((entry) => entry.updated_at !== null);
    expect(pending?.updated_at).toBe('2026-09-24T06:30:00.000000Z');
    // 다음 번들(5~7)에는 그 도메인의 잎이 없는데 행은 여전히 다르다 → 실패.
    const next = verifyBundle(withRow(v5History.bundle(5, 7), 'custom_domains', changed), { pinnedVkey: vkey, previous: first.state });
    expect(next.errors.map((issue) => issue.code)).toEqual(['domain_update_leaf_missing']);
    // 행을 마지막 잎과 다시 맞춰도(잎 없이 되돌렸다) 대기 시각이 창 안으로 들어왔으니 실패다(재검증 R2).
    expect(verifyBundle(v5History.bundle(5, 7), { pinnedVkey: vkey, previous: first.state }).errors.map((issue) => issue.code)).toEqual([
      'domain_update_leaf_missing',
    ]);
    // updated_at 을 이번 창 끝 바로 뒤로 옮겨 대기를 다시 미루려 해도 실패다(재검증 R2).
    const redeferred = withRow(v5History.bundle(5, 7), 'custom_domains', { ...changed, updated_at: '2026-09-24T08:00:00.000000Z' });
    expect(verifyBundle(redeferred, { pinnedVkey: vkey, previous: first.state }).errors.map((issue) => issue.code)).toEqual(['domain_update_leaf_missing']);
  });

  it('대기는 뒤의 잎이 풀어 준다 — 창 끝 뒤에 바뀐 행(에폭 0~4) → 다음 번들(4~7)의 update 잎으로 해소', () => {
    const first = verifyBundle(v5History.bundle(0, 4), { pinnedVkey: vkey });
    expect(first.errors).toEqual([]);
    expect(first.warnings.some((warning) => warning.startsWith('domain_fold_deferred'))).toBe(true);
    const next = verifyBundle(v5History.bundle(4, 7), { pinnedVkey: vkey, previous: first.state });
    expect(next.errors).toEqual([]);
    expect(next.state?.domain_folds?.every((entry) => entry.updated_at === null)).toBe(true);
  });

  it('접기 기준이 저장된 도메인 행을 removed 잎 없이 번들에서 빼면 domain_row_missing(재검증 R1)', () => {
    const saved = verifyBundle(bundle, { pinnedVkey: vkey });
    expect(saved.errors).toEqual([]);
    const omitted = withRow(v5History.bundle(5, 7), 'custom_domains', null);
    expect(verifyBundle(omitted, { pinnedVkey: vkey, previous: saved.state }).errors.map((issue) => issue.code)).toEqual(['domain_row_missing']);
    // 저장 상태 없이 처음 보면(기준 없음) 판단할 수 없다.
    expect(verifyBundle(omitted, { pinnedVkey: vkey }).errors).toEqual([]);
  });

  it('트리거를 끄고 상태를 바꾼 뒤 새 잎이 없는 번들 — 저장 상태의 마지막 잎으로 접어 row_leaf_mismatch(보안 리뷰 M3)', () => {
    const saved = verifyBundle(bundle, { pinnedVkey: vkey });
    expect(saved.errors).toEqual([]);
    expect(saved.state?.domain_folds).toHaveLength(1);
    const later = v5History.bundle(5, 7);
    expect(verifyBundle(later, { pinnedVkey: vkey, previous: saved.state }).errors).toEqual([]);
    const tampered = withRow(later, 'custom_domains', { status: 'suspended', suspended_reason: 'operator' });
    const report = verifyBundle(tampered, { pinnedVkey: vkey, previous: saved.state });
    expect(report.errors.map((issue) => issue.code)).toEqual(['row_leaf_mismatch']);
    expect(report.errors[0]?.detail).toContain('status');
    // 저장 상태 없이 처음 보면(기준 잎 없음) 접을 수 없다 — 머리말의 한계(맥락 행).
    expect(verifyBundle(withRow(v5History.bundle(6, 7), 'custom_domains', { status: 'suspended', suspended_reason: 'operator' }), { pinnedVkey: vkey }).errors).toEqual([]);
  });

  it('창 안에서 제거됐는데 removed 잎이 없으면 remove_leaf', () => {
    const report = verifyBundle(withRow(bundle, 'custom_domains', { status: 'removed', removed_at: '2026-09-24T05:30:00.000000Z' }), { pinnedVkey: vkey });
    expect(codes(report)).toEqual(['row_leaf_mismatch']);
    expect(report.errors[0]?.detail).toContain('remove_leaf');
  });

  it('잎 없이 창 안에서 만든 도메인 행 → row_without_leaf · 창 밖에서 만든 행은 맥락', () => {
    const extra = (created: string): Record<string, unknown> => {
      const copy = structuredClone(bundle) as Bundle;
      copy.sources.rows.push({
        t: 'custom_domains',
        id: '0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e',
        domain: 'agents.hidden.com',
        status: 'pending',
        suspended_reason: null,
        inbound_mx_status: 'unknown',
        created_at: created,
        updated_at: created,
        removed_at: null,
      });
      return copy;
    };
    expect(codes(verifyBundle(extra('2026-09-24T02:30:00.000000Z'), { pinnedVkey: vkey }))).toEqual(['row_without_leaf']);
    expect(verifyBundle(extra('2026-09-20T00:00:00.000000Z'), { pinnedVkey: vkey }).errors).toEqual([]);
  });

  it('도메인 행의 시각이 번들 생성 뒤(미래) → updated_at_in_future', () => {
    expect(codes(verifyBundle(withRow(bundle, 'custom_domains', { updated_at: '2026-09-25T00:00:00.000000Z' }), { pinnedVkey: vkey }))).toEqual(['updated_at_in_future']);
  });

  it.each([
    ['주소(커밋)', { address: 'other@agents.synthetic-customer.com' }, 'c.address'],
    ['원인', { cause: 'operator' }, 'cause'],
    ['에이전트', { agent_id: 'f'.repeat(32) }, 'agent_id'],
    ['생성 시각', { created_at: '2026-09-24T04:00:01.000002Z' }, 'at'],
  ] as const)('agent_primary_changes %s 를 바꾸면 row_leaf_mismatch(%s)', (_label, patch, field) => {
    const report = verifyBundle(withRow(bundle, 'agent_primary_changes', patch), { pinnedVkey: vkey });
    expect(codes(report)).toEqual(['row_leaf_mismatch']);
    expect(report.errors[0]?.detail).toContain(field);
  });

  it('대표 주소 행의 생성 시각이 미래 → updated_at_in_future(창 밖으로 밀어 잎 없는 행을 숨기지 못한다)', () => {
    expect(codes(verifyBundle(withRow(bundle, 'agent_primary_changes', { created_at: '2026-09-25T00:00:00.000000Z' }), { pinnedVkey: vkey }))).toEqual([
      'updated_at_in_future',
    ]);
  });

  it('원천 행을 빼면 leaf_without_row', () => {
    expect(codes(verifyBundle(withRow(bundle, 'custom_domains', null), { pinnedVkey: vkey }))).toEqual(['leaf_without_row']);
    expect(codes(verifyBundle(withRow(bundle, 'agent_primary_changes', null), { pinnedVkey: vkey }))).toEqual(['leaf_without_row']);
  });
});

describe('④ 잎 모양 — ADR 개정에 박는 값', () => {
  const LOG = 'c'.repeat(32);
  const AGENT = 'b'.repeat(32);
  const AT = '2026-10-02T00:00:00.000000Z';

  it('identity.primary_set — body {agent_id, cause} · c {address} · 평문 @ 0 · src insert', () => {
    const leaf = buildOrgLeaf(
      { log: LOG, seq: 3, saltKey: Buffer.alloc(32, 1) },
      { kind: 'identity.primary_set', src: { t: 'agent_primary_changes', id: '11111111-1111-4111-8111-111111111111', e: 'insert', r: 0 }, at: AT, agentId: AGENT, cause: 'owner', address: SYNTHETIC_PRIMARY_ADDRESS },
    );
    const parsed = JSON.parse(leaf.json) as { kind: string; body: Record<string, unknown>; c: Record<string, string>; src: unknown };
    expect(parsed.kind).toBe('identity.primary_set');
    expect(parsed.body).toEqual({ agent_id: AGENT, cause: 'owner' });
    expect(Object.keys(parsed.c)).toEqual(['address']);
    expect(parsed.src).toEqual({ t: 'agent_primary_changes', id: '11111111-1111-4111-8111-111111111111', e: 'insert', r: 0 });
    expect(leaf.json).not.toContain('@');
  });

  it('domain.status — body {domain_id, status, reason, inbound} · c {domain} · 도메인 이름 평문 없음', () => {
    const leaf = buildOrgLeaf(
      { log: LOG, seq: 4, saltKey: Buffer.alloc(32, 1) },
      {
        kind: 'domain.status',
        src: { t: 'custom_domains', id: '22222222-2222-4222-8222-222222222222', e: 'update', r: 2 },
        at: AT,
        domainId: '22222222-2222-4222-8222-222222222222',
        status: 'suspended',
        reason: 'plan_limit',
        inbound: 'ses',
        domain: SYNTHETIC_CUSTOM_DOMAIN,
      },
    );
    const parsed = JSON.parse(leaf.json) as { body: Record<string, unknown>; c: Record<string, string> };
    expect(parsed.body).toEqual({ domain_id: '22222222-2222-4222-8222-222222222222', status: 'suspended', reason: 'plan_limit', inbound: 'ses' });
    expect(Object.keys(parsed.c)).toEqual(['domain']);
    expect(leaf.json).not.toContain('synthetic-customer');
  });
});

describe('⑤ 신원 블록 파일 — primary_set 블록 · 도메인 사건(체인 밖)', () => {
  const LOG = 'a'.repeat(32);
  const AGENT = 'b'.repeat(32);
  const AT = '2026-10-02T00:00:00.000000Z';
  const salt = Buffer.alloc(32, 1);

  function blocksFile(): Record<string, unknown> {
    const created = buildOrgLeaf({ log: LOG, seq: 1, saltKey: salt }, { kind: 'identity.agent_created', src: { t: 'agents', id: AGENT, e: 'insert', r: 0 }, at: AT, agentId: AGENT, name: 'n', status: 'active', suspendedBy: null });
    const primary = buildOrgLeaf(
      { log: LOG, seq: 3, saltKey: salt },
      { kind: 'identity.primary_set', src: { t: 'agent_primary_changes', id: '11111111-1111-4111-8111-111111111111', e: 'insert', r: 0 }, at: AT, agentId: AGENT, cause: 'owner', address: SYNTHETIC_PRIMARY_ADDRESS },
    );
    let prev = GENESIS_BLOCK_HASH;
    const blocks = [created, primary].map((leaf, index) => {
      const leafHash = leaf.hash.toString('hex');
      const blockHash = blockHashOf(prev, leafHash);
      const block = { entryId: String(index), seq: index === 0 ? 1 : 3, kind: leaf.kind, leaf: leaf.json, leafHash, prevBlockHash: prev, blockHash, checkpoint: { state: 'pending' } };
      prev = blockHash;
      return block;
    });
    const domainLeaf = buildOrgLeaf(
      { log: LOG, seq: 2, saltKey: salt },
      { kind: 'domain.status', src: { t: 'custom_domains', id: '22222222-2222-4222-8222-222222222222', e: 'insert', r: 0 }, at: AT, domainId: '22222222-2222-4222-8222-222222222222', status: 'pending', reason: null, inbound: 'unknown', domain: SYNTHETIC_CUSTOM_DOMAIN },
    );
    const domains = [{ entryId: '9', seq: 2, at: AT, domain: SYNTHETIC_CUSTOM_DOMAIN, leaf: domainLeaf.json, leafHash: domainLeaf.hash.toString('hex'), checkpoint: { state: 'pending' } }];
    return { format: IDENTITY_BLOCKS_FORMAT, agentId: AGENT, truncated: false, blocks, missing: [], domains };
  }

  it('판 5 · 2차 검증기 — primary_set 블록과 도메인 사건을 받는다(증명 없음 = 일관성만)', () => {
    const report = verifyIdentityBlocks(blocksFile());
    expect(report.errors).toEqual([]);
    expect(report.assurance).toBe('consistency_only');
    expect(report.stats).toMatchObject({ blocks: 2, domains: 1, domains_proven: 0 });
    expect(secondVerifyIdentityBlocks(blocksFile())).toEqual([]);
  });

  it('판 4 는 primary_set 블록을 모르는 종류로 거부한다(소유자가 검증기를 갱신한다)', () => {
    expect(codes(verifyIdentityBlocksV4(blocksFile()))).toContain('identity_block_kind');
  });

  it('도메인 사건의 종류·해시를 바꾸면 두 검증기가 거부한다', () => {
    const wrongKind = blocksFile();
    const domains = wrongKind['domains'] as Record<string, unknown>[];
    (domains[0] as Record<string, unknown>)['leaf'] = (wrongKind['blocks'] as Record<string, unknown>[])[0]?.['leaf'];
    (domains[0] as Record<string, unknown>)['leafHash'] = (wrongKind['blocks'] as Record<string, unknown>[])[0]?.['leafHash'];
    expect(codes(verifyIdentityBlocks(wrongKind))).toContain('identity_domain_kind');
    expect(secondVerifyIdentityBlocks(wrongKind)).toContain('domain_kind:0');
    const wrongHash = blocksFile();
    ((wrongHash['domains'] as Record<string, unknown>[])[0] as Record<string, unknown>)['leafHash'] = '0'.repeat(64);
    expect(codes(verifyIdentityBlocks(wrongHash))).toContain('leaf_hash_mismatch');
    expect(secondVerifyIdentityBlocks(wrongHash)).toContain('domain_leaf_hash:0');
  });
});
