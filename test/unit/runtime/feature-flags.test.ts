/**
 * 기능 플래그 — 불리언(`readFeatureFlag` — 기본 끔 · `true` 만 켬 · 오타는 기동 거부)과 메일 기본기 2차 단계 공개(`readFeatureRollout` —
 * `false` · `true` · `orgs:<uuid>,…` · 무효 값은 꺼짐 + 경고).
 */

import { afterEach, describe, expect, it } from 'vitest';

import { resetLogSink, setLogSink } from '../../../src/observability/logger';
import { readFeatureFlag, readFeatureRollout, RUNTIME_ENV, RuntimeConfigError } from '../../../src/runtime/config';
import { MAX_ROLLOUT_ORGANIZATIONS, parseFeatureRollout, rolloutAllows } from '../../../src/runtime/feature-rollout';

const ORG_A = '0b6f9f8e-1c2d-4e3f-8a9b-0c1d2e3f4a5b';
const ORG_B = '7d1e2f3a-4b5c-4d6e-9f0a-1b2c3d4e5f60';

describe('readFeatureFlag', () => {
  const name = RUNTIME_ENV.addressAliasesEnabled;

  it('없음 · 빈 값 · false → 꺼짐 · true → 켬', () => {
    expect(readFeatureFlag({}, name)).toBe(false);
    expect(readFeatureFlag({ [name]: '' }, name)).toBe(false);
    expect(readFeatureFlag({ [name]: 'false' }, name)).toBe(false);
    expect(readFeatureFlag({ [name]: 'true' }, name)).toBe(true);
    expect(readFeatureFlag({ [RUNTIME_ENV.outboundAttachmentsEnabled]: 'true' }, RUNTIME_ENV.outboundAttachmentsEnabled)).toBe(true);
  });

  it('다른 값(TRUE · 1 · yes · orgs:)은 조용히 읽지 않고 던진다', () => {
    for (const value of ['TRUE', '1', 'yes', 'on', `orgs:${ORG_A}`]) expect(() => readFeatureFlag({ [name]: value }, name), value).toThrow(RuntimeConfigError);
  });

  it('플래그 이름 = 스택 환경 이름', () => {
    expect(RUNTIME_ENV.addressAliasesEnabled).toBe('ATMARK_ADDRESS_ALIASES_ENABLED');
    expect(RUNTIME_ENV.outboundAttachmentsEnabled).toBe('ATMARK_OUTBOUND_ATTACHMENTS_ENABLED');
  });
});

describe('parseFeatureRollout · rolloutAllows', () => {
  it('false · 빈 값 → 꺼짐 · true → 전체', () => {
    for (const raw of ['', ' ', 'false']) expect(parseFeatureRollout(raw)).toEqual({ ok: true, rollout: false, canonical: 'false' });
    expect(parseFeatureRollout('true')).toEqual({ ok: true, rollout: true, canonical: 'true' });
    expect(rolloutAllows(false, ORG_A)).toBe(false);
    expect(rolloutAllows(true, ORG_A)).toBe(true);
    expect(rolloutAllows(true, null)).toBe(true);
  });

  it('orgs:<uuid>,… → 적힌 조직만 · 정규형(소문자 · 정렬 · 중복 제거)', () => {
    const parsed = parseFeatureRollout(` orgs:${ORG_B}, ${ORG_A.toUpperCase()},${ORG_B}`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.canonical).toBe(`orgs:${ORG_A},${ORG_B}`);
    expect(rolloutAllows(parsed.rollout, ORG_A)).toBe(true);
    expect(rolloutAllows(parsed.rollout, ORG_B.toUpperCase())).toBe(true);
    const single = parseFeatureRollout(`orgs:${ORG_A}`);
    if (!single.ok) throw new Error('parse');
    expect(rolloutAllows(single.rollout, ORG_B)).toBe(false);
    expect(rolloutAllows(single.rollout, null)).toBe(false);
  });

  it('무효 — 모르는 값 · 빈 목록 · 빈 칸 · uuid 아님 · 상한 초과', () => {
    const cases: [string, string][] = [
      ['TRUE', 'not_a_rollout_value'],
      ['1', 'not_a_rollout_value'],
      [ORG_A, 'not_a_rollout_value'],
      ['orgs:', 'empty_allowlist'],
      ['orgs: ', 'empty_allowlist'],
      [`orgs:${ORG_A},`, 'invalid_organization_id'],
      [`orgs:${ORG_A},,${ORG_B}`, 'invalid_organization_id'],
      ['orgs:not-a-uuid', 'invalid_organization_id'],
      [`orgs:${ORG_A.replace(/-/g, '')}`, 'invalid_organization_id'],
      [`orgs:{${ORG_A}}`, 'invalid_organization_id'],
      [`orgs:${ORG_A};${ORG_B}`, 'invalid_organization_id'],
    ];
    for (const [raw, reason] of cases) expect(parseFeatureRollout(raw), raw).toEqual({ ok: false, reason });
    const many = Array.from({ length: MAX_ROLLOUT_ORGANIZATIONS + 1 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    expect(parseFeatureRollout(`orgs:${many.join(',')}`)).toEqual({ ok: false, reason: 'too_many_organizations' });
    expect(parseFeatureRollout(`orgs:${many.slice(1).join(',')}`).ok).toBe(true);
  });
});

describe('readFeatureRollout — 무효 값은 꺼짐 + 기동 경고(fail closed)', () => {
  const name = RUNTIME_ENV.outboundAttachmentsEnabled;
  afterEach(() => resetLogSink());

  it('유효 값은 그대로 · 경고 없음', () => {
    const lines: string[] = [];
    setLogSink((line) => lines.push(line));
    expect(readFeatureRollout({}, name)).toBe(false);
    expect(readFeatureRollout({ [name]: 'true' }, name)).toBe(true);
    const rollout = readFeatureRollout({ [name]: `orgs:${ORG_A}` }, name);
    expect(rolloutAllows(rollout, ORG_A)).toBe(true);
    expect(rolloutAllows(rollout, ORG_B)).toBe(false);
    expect(lines).toEqual([]);
  });

  it('무효 값 → 던지지 않고 false · 경고 한 줄(변수 이름·사유 — 값은 싣지 않는다)', () => {
    const lines: string[] = [];
    setLogSink((line) => lines.push(line));
    for (const raw of ['TRUE', 'orgs:', `orgs:${ORG_A},nope`]) expect(readFeatureRollout({ [name]: raw }, name), raw).toBe(false);
    expect(lines).toHaveLength(3);
    const first = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(first).toMatchObject({ level: 'warn', event: 'runtime.feature_flag_invalid', detail: name, reason: 'not_a_rollout_value', outcome: 'disabled' });
    expect(lines.join('\n')).not.toContain(ORG_A);
  });
});
