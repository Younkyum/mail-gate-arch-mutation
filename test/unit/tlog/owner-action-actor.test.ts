/**
 * `owner.action` 잎의 **행위자 두 변형**(확장성 P1 R-6 · ADR-0008 추가 절 · 202609250160) — 소유자 세션은 `c.session`, 조직 API 키는
 * `c.api_key`. DB·AWS 0.
 *
 * 되돌리면 빨개져야 하는 것:
 *   - 키 행위 잎은 `c.api_key` 만 있고 `c.session` 이 없다(칸 이름으로 구별 — 값은 커밋으로만, 키 id 평문이 잎에 없다).
 *   - 세션 행위 잎은 옛 모양 그대로(`c.session` 하나) — 기존 잎 바이트가 바뀌지 않는다.
 *   - 둘 다·둘 다 없음은 잎을 만들지 않는다(TypeError).
 *   - 검증기: 원천 행이 행위자 종류(`actor`)를 대면 잎의 커밋 칸과 같아야 한다(`row_leaf_mismatch … actor`) · 옛 번들(종류 없음)은 그대로 통과.
 */

import { randomBytes, randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { VERIFIER_VERSION, verifyBundle } from '../../../scripts/tlog-verify/verifier';
import { buildOrgLeaf } from '../../../src/tlog/leaf';
import { OPERATOR_MIN_VERIFIER_VERSION } from '../../../src/tlog/proofs';
import { SYNTHETIC_OPERATOR_ACTOR, syntheticHistory } from '../../support/tlog-synthetic';

const LOG = 'c'.repeat(32);
const AT = '2026-09-25T00:00:00.000000Z';
const context = { log: LOG, seq: 3, saltKey: randomBytes(32) };
const src = { t: 'owner_actions' as const, id: randomUUID(), e: 'insert' as const, r: 0 };

function commitmentsOf(json: string): Record<string, string> {
  return (JSON.parse(json) as { c: Record<string, string> }).c;
}

describe('owner.action 행위자 변형', () => {
  it('세션 행위 = c.session 하나(옛 모양 그대로)', () => {
    const sessionId = randomUUID();
    const leaf = buildOrgLeaf(context, { kind: 'owner.action', src, at: AT, action: 'agent.create', targetId: 'a'.repeat(32), sessionId });
    expect(Object.keys(commitmentsOf(leaf.json))).toEqual(['session']);
    // orgApiKeyId 를 null 로 명시해도 바이트가 같다.
    const same = buildOrgLeaf(context, { kind: 'owner.action', src, at: AT, action: 'agent.create', targetId: 'a'.repeat(32), sessionId, orgApiKeyId: null });
    expect(same.json).toBe(leaf.json);
  });

  it('키 행위 = c.api_key 하나 · 키 id 평문은 잎에 없다', () => {
    const keyId = randomUUID();
    const leaf = buildOrgLeaf(context, { kind: 'owner.action', src, at: AT, action: 'agent.create', targetId: 'a'.repeat(32), sessionId: null, orgApiKeyId: keyId });
    expect(Object.keys(commitmentsOf(leaf.json))).toEqual(['api_key']);
    expect(leaf.json).not.toContain(keyId);
  });

  it('둘 다·둘 다 없음은 거부', () => {
    expect(() =>
      buildOrgLeaf(context, { kind: 'owner.action', src, at: AT, action: 'agent.create', targetId: null, sessionId: randomUUID(), orgApiKeyId: randomUUID() }),
    ).toThrow(TypeError);
    expect(() => buildOrgLeaf(context, { kind: 'owner.action', src, at: AT, action: 'agent.create', targetId: null, sessionId: null })).toThrow(TypeError);
  });
});

describe('검증기 — 원천 행의 행위자 종류', () => {
  const history = syntheticHistory({ tag: 'actor-variant', epochs: 3 });
  const vkey = history.signer.vkey;
  type Bundle = { sources: { rows: Record<string, unknown>[] } };
  const ownerRows = (bundle: Bundle): Record<string, unknown>[] => bundle.sources.rows.filter((row) => row['t'] === 'owner_actions');

  it('종류 없음(옛 번들) · session → 통과', () => {
    const plain = history.bundle(0, 2) as unknown as Bundle;
    expect(verifyBundle(plain, { pinnedVkey: vkey }).errors).toEqual([]);
    const labelled = history.bundle(0, 2) as unknown as Bundle;
    for (const row of ownerRows(labelled)) row['actor'] = 'session';
    expect(verifyBundle(labelled, { pinnedVkey: vkey }).errors).toEqual([]);
  });

  it('행은 api_key 인데 잎은 c.session · 모르는 종류 → row_leaf_mismatch(actor)', () => {
    for (const actor of ['api_key', 'robot']) {
      const bundle = history.bundle(0, 2) as unknown as Bundle;
      const row = ownerRows(bundle)[0];
      if (row === undefined) throw new Error('합성 번들에 owner_actions 행이 없다');
      row['actor'] = actor;
      const report = verifyBundle(bundle, { pinnedVkey: vkey });
      const mismatch = report.errors.find((issue) => issue.code === 'row_leaf_mismatch');
      expect(mismatch?.detail, actor).toContain('actor');
    }
  });
});

/**
 * 셋째 행위자 — 운영자 · 시스템(202610131610 · 판 6). 운영자 CLI(`admin:agent-delete` · `admin:kill-switch --org`)와 플랫폼의 공유 도메인 평판 자동
 * 동결이 `owner_actions` 에 남기는 행. 잎은 `c.operator` 커밋 하나(행위자 · 사유 — 평문 없음).
 */
describe('owner.action 운영자 행위자(판 6)', () => {
  it('운영자 행위 = c.operator 하나 · 행위자 · 사유 평문은 잎에 없다 · 세션 행위 잎 바이트는 그대로', () => {
    const reason = '7d:complaint_rate · 7d attempts=900 bounces=0 complaints=3';
    const leaf = buildOrgLeaf(context, {
      kind: 'owner.action',
      src,
      at: AT,
      action: 'org.abuse_freeze',
      targetId: null,
      sessionId: null,
      operatorActor: SYNTHETIC_OPERATOR_ACTOR,
      operatorReason: reason,
    });
    expect(Object.keys(commitmentsOf(leaf.json))).toEqual(['operator']);
    expect(leaf.json).not.toContain('platform_reputation');
    expect(leaf.json).not.toContain('complaints=3');
    const sessionId = randomUUID();
    const plain = buildOrgLeaf(context, { kind: 'owner.action', src, at: AT, action: 'agent.create', targetId: null, sessionId });
    const explicit = buildOrgLeaf(context, { kind: 'owner.action', src, at: AT, action: 'agent.create', targetId: null, sessionId, operatorActor: null, operatorReason: null });
    expect(explicit.json).toBe(plain.json);
  });

  it('운영자와 세션 · 키가 함께 · 행위자만 · 사유만은 거부', () => {
    const base = { kind: 'owner.action' as const, src, at: AT, action: 'agent.delete', targetId: null };
    expect(() => buildOrgLeaf(context, { ...base, sessionId: randomUUID(), operatorActor: 'admin:agent-delete:ops', operatorReason: 'r' })).toThrow(TypeError);
    expect(() => buildOrgLeaf(context, { ...base, sessionId: null, orgApiKeyId: randomUUID(), operatorActor: 'admin:agent-delete:ops', operatorReason: 'r' })).toThrow(TypeError);
    expect(() => buildOrgLeaf(context, { ...base, sessionId: null, operatorActor: 'admin:agent-delete:ops', operatorReason: null })).toThrow(TypeError);
    expect(() => buildOrgLeaf(context, { ...base, sessionId: null, operatorActor: null, operatorReason: 'r' })).toThrow(TypeError);
  });

  it('검증기 판 6 — 운영자 행 · c.operator 잎 통과 · 번들은 6 을 요구 · 행위자 종류가 어긋나면 actor', () => {
    expect(VERIFIER_VERSION).toBe(OPERATOR_MIN_VERIFIER_VERSION);
    const history = syntheticHistory({ tag: 'actor-operator', epochs: 3, operatorActions: true });
    type Bundle = { min_verifier_version?: number; sources: { rows: Record<string, unknown>[] } };
    const bundle = history.bundle(0, 2) as unknown as Bundle;
    expect(bundle.min_verifier_version).toBe(6);
    expect(bundle.sources.rows.some((row) => row['actor'] === 'operator')).toBe(true);
    expect(verifyBundle(bundle, { pinnedVkey: history.signer.vkey }).errors).toEqual([]);

    for (const actor of ['session', 'api_key', null]) {
      const bent = structuredClone(history.bundle(0, 2)) as unknown as Bundle;
      const row = bent.sources.rows.find((candidate) => candidate['action'] === 'org.abuse_freeze');
      if (row === undefined) throw new Error('운영자 행이 없다');
      row['actor'] = actor;
      const mismatch = verifyBundle(bent, { pinnedVkey: history.signer.vkey }).errors.find((issue) => issue.code === 'row_leaf_mismatch');
      expect(mismatch?.detail, String(actor)).toContain('actor');
    }
    // 세션 잎인데 행이 operator 라고 하면 actor.
    const plain = syntheticHistory({ tag: 'actor-operator-plain', epochs: 3 });
    const lying = structuredClone(plain.bundle(0, 2)) as unknown as Bundle;
    const first = lying.sources.rows.find((row) => row['t'] === 'owner_actions');
    if (first === undefined) throw new Error('owner_actions 행이 없다');
    first['actor'] = 'operator';
    expect(verifyBundle(lying, { pinnedVkey: plain.signer.vkey }).errors.find((issue) => issue.code === 'row_leaf_mismatch')?.detail).toContain('actor');
  });

  it('판 5 검증기 흉내 — 번들이 6 을 요구하면 verifier_outdated(친절한 멈춤)', () => {
    const history = syntheticHistory({ tag: 'actor-operator-old', epochs: 3, operatorActions: true });
    const bundle = history.bundle(0, 2) as unknown as Record<string, unknown>;
    const report = verifyBundle({ ...bundle, min_verifier_version: VERIFIER_VERSION + 1 }, { pinnedVkey: history.signer.vkey });
    expect(report.errors.map((issue) => issue.code)).toEqual(['verifier_outdated']);
  });
});
