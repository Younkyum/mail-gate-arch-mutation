/**
 * ops/ai-watch/worker/engine.ts — 모델 디렉터리 하나를 "검증된 분류기" 로: 잠금 대조(sha256) → release_config 대조 → 네이티브 로드 → 자기 시험.
 * 워커(`main.ts`)와 골든 시험(`test/golden.ts`)이 같은 길을 쓴다.
 */

import { join } from 'node:path';

import type { AiWatchBand } from '../../../src/inbound/ai-watch/contract';
import { lockMatchesReleaseConfig, readJson, verifyModelDir, type LockedModel } from './lock';
import { loadClassifier, type Classifier } from './model';
import { sequenceSpecOf, type SequenceSpec } from './preprocess';
import { attackScore, bandOf } from './score';
import { parseFixtures, runSelfTest, type SelfTestReport } from './selftest';

export interface Engine {
  readonly version: string;
  readonly classifier: Classifier;
  readonly spec: SequenceSpec;
  bandOf(text: string): Promise<AiWatchBand>;
  selfTest(): Promise<SelfTestReport>;
}

export type EngineLoad = { readonly ok: true; readonly engine: Engine } | { readonly ok: false; readonly reason: string };

export async function loadEngine(input: { readonly dir: string; readonly locked: LockedModel; readonly threads: number }): Promise<EngineLoad> {
  const integrity = await verifyModelDir(input.dir, input.locked);
  if (!integrity.ok) return { ok: false, reason: 'model_hash_mismatch' };
  const releaseConfig = readJson(join(input.dir, 'release_config.json'));
  if (!lockMatchesReleaseConfig(input.locked, releaseConfig)) return { ok: false, reason: 'lock_config_mismatch' };
  const modelFile = (releaseConfig as { model_file?: unknown }).model_file;
  if (typeof modelFile !== 'string' || !Object.hasOwn(input.locked.files, modelFile)) return { ok: false, reason: 'model_file_not_locked' };
  const spec = sequenceSpecOf(releaseConfig);
  const classifier = await loadClassifier({ dir: input.dir, modelFile, spec, threads: input.threads });
  const fixtures = Object.hasOwn(input.locked.files, 'fixtures.json') ? parseFixtures(readJson(join(input.dir, 'fixtures.json'))) : [];
  const { temperature, bands } = input.locked;
  const engine: Engine = {
    version: input.locked.version,
    classifier,
    spec,
    bandOf: async (text) => bandOf(attackScore(await classifier.classify(text), temperature), bands),
    selfTest: () => runSelfTest({ classifier, spec, fixtures, temperature, bands }),
  };
  return { ok: true, engine };
}
