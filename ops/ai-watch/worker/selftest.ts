/**
 * ops/ai-watch/worker/selftest.ts — 골든 픽스처(`fixtures.json`, laya-train 이 Python ORT 로 뽑은 24건) 대조.
 *
 * 건마다 셋을 본다: ① 전처리 + 토크나이저가 만든 input_ids 가 픽스처의 `rendered_input_ids` 와 **정확히** 같다
 * ② 로짓이 `logits_int8` 과 `LOGIT_TOLERANCE` 안 ③ 경고 판정(attack ≥ mid)이 픽스처 점수의 판정과 같다.
 * 결과에는 개수만 싣는다(픽스처 id·본문·로짓은 로그로 나가지 않는다).
 */

import type { Classifier } from './model';
import { buildInputIds, renderEmail, type SequenceSpec } from './preprocess';
import { attackScore, type BandThresholds } from './score';

/** 같은 INT8 모델 · 같은 ORT 계열이면 1e-4 안쪽이 나온다(laya-train 실측). 판정은 정확히 같아야 한다. */
const LOGIT_TOLERANCE = 1e-3;
const EXPECTED_FIXTURES = 24;

export interface GoldenFixture {
  readonly subject: string | null;
  readonly text: string | null;
  readonly rendered_input_ids: readonly number[];
  readonly logits_int8: readonly number[];
  readonly attack_score: number;
}

export interface SelfTestReport {
  readonly pass: boolean;
  readonly fixtures: number;
  readonly idMismatch: number;
  readonly logitMismatch: number;
  readonly decisionFlips: number;
  readonly maxLogitDiff: number;
}

export function parseFixtures(raw: unknown): GoldenFixture[] {
  if (!Array.isArray(raw)) throw new TypeError('bad_fixtures');
  return raw.map((entry: unknown) => {
    const f = entry as Partial<GoldenFixture>;
    if (!Array.isArray(f.rendered_input_ids) || !Array.isArray(f.logits_int8) || typeof f.attack_score !== 'number') {
      throw new TypeError('bad_fixture');
    }
    return {
      subject: typeof f.subject === 'string' ? f.subject : null,
      text: typeof f.text === 'string' ? f.text : null,
      rendered_input_ids: f.rendered_input_ids,
      logits_int8: f.logits_int8,
      attack_score: f.attack_score,
    };
  });
}

export async function runSelfTest(input: {
  readonly classifier: Classifier;
  readonly spec: SequenceSpec;
  readonly fixtures: readonly GoldenFixture[];
  readonly temperature: number;
  readonly bands: BandThresholds;
}): Promise<SelfTestReport> {
  let idMismatch = 0;
  let logitMismatch = 0;
  let decisionFlips = 0;
  let maxLogitDiff = 0;
  for (const fixture of input.fixtures) {
    const ids = buildInputIds(input.spec, await input.classifier.tokenize(renderEmail(fixture.subject, fixture.text)));
    const idsMatch = ids.length === fixture.rendered_input_ids.length && ids.every((id, i) => id === fixture.rendered_input_ids[i]);
    if (!idsMatch) idMismatch += 1;
    // 로짓은 **우리가 만든 ids** 로 돌린다 — 전처리부터 판정까지 운영 경로 그대로.
    const logits = await input.classifier.logitsOf(ids);
    const diff = Math.max(...logits.map((value, i) => Math.abs(value - (fixture.logits_int8[i] ?? Number.NaN))));
    if (!(diff <= LOGIT_TOLERANCE)) logitMismatch += 1;
    if (Number.isFinite(diff)) maxLogitDiff = Math.max(maxLogitDiff, diff);
    const ours = attackScore(logits, input.temperature) >= input.bands.mid;
    const theirs = fixture.attack_score >= input.bands.mid;
    if (ours !== theirs) decisionFlips += 1;
  }
  return {
    pass: input.fixtures.length === EXPECTED_FIXTURES && idMismatch === 0 && logitMismatch === 0 && decisionFlips === 0,
    fixtures: input.fixtures.length,
    idMismatch,
    logitMismatch,
    decisionFlips,
    maxLogitDiff,
  };
}
