/**
 * ops/ai-watch/worker/score.ts — 로짓 → attack_score → 밴드 → 판정.
 *
 *   attack_score = 1 − softmax(logits / T)[benign]       (T = release_config.temperature)
 *   밴드: high ≥ bands.high > mid ≥ bands.mid(= 경고 임계 `recommended_threshold_attack_score`) > low
 *   판정: high|mid → flagged · low → clear (계약 `bandMatchesVerdict`)
 *
 * **점수 원값은 이 모듈 밖으로 나가지 않는다** — 선로·로그에는 밴드와 판정만(계약 `AI_WATCH_BANDS` 주석).
 */

import type { AiWatchBand } from '../../../src/inbound/ai-watch/contract';

export interface BandThresholds {
  /** `high` 의 아래 경계(포함). */
  readonly high: number;
  /** `mid` 의 아래 경계(포함) = 경고 임계. */
  readonly mid: number;
}

export function softmax(values: readonly number[], temperature: number): number[] {
  const scaled = values.map((value) => value / temperature);
  const max = Math.max(...scaled);
  const exps = scaled.map((value) => Math.exp(value - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((value) => value / sum);
}

/** 라벨 순서는 [benign, spam_phish, injection] — 0 번이 benign. */
export function attackScore(logits: readonly number[], temperature: number): number {
  if (logits.length !== 3 || !logits.every(Number.isFinite)) throw new RangeError('bad_logits');
  return 1 - softmax(logits, temperature)[0]!;
}

export function bandOf(score: number, bands: BandThresholds): AiWatchBand {
  if (score >= bands.high) return 'high';
  if (score >= bands.mid) return 'mid';
  return 'low';
}

export function verdictOf(band: AiWatchBand): 'flagged' | 'clear' {
  return band === 'low' ? 'clear' : 'flagged';
}
