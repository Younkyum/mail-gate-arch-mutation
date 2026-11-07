/**
 * 메일 기본기 2차 단계 공개 플래그 — CDK 컨텍스트 · 상수(`featureRolloutOf`). 런타임과 같은 파서(`src/runtime/feature-rollout.ts`)를 쓰고,
 * 틀린 값은 **합성이 멈춘다**(런타임은 꺼짐으로 읽지만 배포 전에 잡는다). 기본값 `false` 의 env 는 `compute-stack.test.ts` ·
 * `outbound-attachments-stack.test.ts` 가 본다.
 */

import * as cdk from 'aws-cdk-lib';
import { describe, expect, it } from 'vitest';

import {
  ADDRESS_ALIASES_ENABLED_CONTEXT_KEY,
  ADDRESS_ALIASES_ENABLED_DEFAULT,
  featureRolloutOf,
  OUTBOUND_ATTACHMENTS_ENABLED_CONTEXT_KEY,
  OUTBOUND_ATTACHMENTS_ENABLED_DEFAULT,
} from '../../../infra/cdk/stacks/compute-stack';
import { parseFeatureRollout } from '../../../src/runtime/feature-rollout';

const ORG_A = '0b6f9f8e-1c2d-4e3f-8a9b-0c1d2e3f4a5b';
const ORG_B = '7d1e2f3a-4b5c-4d6e-9f0a-1b2c3d4e5f60';

function nodeWith(context: Record<string, unknown>): cdk.App['node'] {
  return new cdk.App({ context }).node;
}

describe('featureRolloutOf — 컨텍스트 → env 정규형', () => {
  it('상수 기본값은 유효하고 지금은 전체 공개(2026-09-29)', () => {
    expect(parseFeatureRollout(String(ADDRESS_ALIASES_ENABLED_DEFAULT)).ok).toBe(true);
    expect(parseFeatureRollout(String(OUTBOUND_ATTACHMENTS_ENABLED_DEFAULT)).ok).toBe(true);
    expect(featureRolloutOf(nodeWith({}), ADDRESS_ALIASES_ENABLED_CONTEXT_KEY, ADDRESS_ALIASES_ENABLED_DEFAULT)).toBe('true');
    expect(featureRolloutOf(nodeWith({}), OUTBOUND_ATTACHMENTS_ENABLED_CONTEXT_KEY, OUTBOUND_ATTACHMENTS_ENABLED_DEFAULT)).toBe('true');
  });

  it('컨텍스트 false · true · orgs:… — 정규형(소문자 · 정렬 · 중복 제거)', () => {
    const key = OUTBOUND_ATTACHMENTS_ENABLED_CONTEXT_KEY;
    expect(featureRolloutOf(nodeWith({ [key]: 'false' }), key, true)).toBe('false');
    expect(featureRolloutOf(nodeWith({ [key]: 'true' }), key, false)).toBe('true');
    expect(featureRolloutOf(nodeWith({ [key]: true }), key, false)).toBe('true');
    expect(featureRolloutOf(nodeWith({ [key]: `orgs:${ORG_B},${ORG_A.toUpperCase()},${ORG_B}` }), key, false)).toBe(`orgs:${ORG_A},${ORG_B}`);
  });

  it('상수가 orgs:… 이면 그 값(컨텍스트 없을 때)', () => {
    expect(featureRolloutOf(nodeWith({}), ADDRESS_ALIASES_ENABLED_CONTEXT_KEY, `orgs:${ORG_A}`)).toBe(`orgs:${ORG_A}`);
  });

  it('틀린 값은 합성을 멈춘다(조용히 닫힌 채 배포되지 않게)', () => {
    const key = ADDRESS_ALIASES_ENABLED_CONTEXT_KEY;
    for (const bad of ['TRUE', 'yes', 'orgs:', `orgs:${ORG_A},`, 'orgs:not-a-uuid', ORG_A]) {
      expect(() => featureRolloutOf(nodeWith({ [key]: bad }), key, false), bad).toThrow(/atmark:addressAliasesEnabled/);
    }
  });
});
