/**
 * ops/ai-watch/worker/preprocess.ts — 모델 입력 만들기(laya-train 산출물 `release_config.json` 의 `sequence`·`state_ids` 그대로).
 *
 *   input_ids = prefix_ids(고정 99토큰) + state_ids(≤ 284) + [SEP]
 *   state_ids = tok(text, add_special_tokens=false).ids
 *               길이 > 280 이면 ids[:152] + [108, 7317, 108] + ids[-128:]   (앞 152 · 이음 "\n…\n" · 뒤 128)
 *               그 뒤 ids[:284]
 *   attention_mask = 전부 1(배치 1 — 패딩 없음)
 *
 * `text` 는 이미 `aw-in/1`(학습 `render_email`) 로 만든 발췌문이다 — 워커는 다듬지 않는다(trim·NFKC 없음).
 * 숫자를 바꾸면 골든 24 가 깨진다(`pnpm ai-watch:selftest`).
 */

/** 이 길이를 넘으면 앞·뒤를 자른다. */
const STATE_TRUNCATE_ABOVE = 280;
const STATE_HEAD = 152;
const STATE_TAIL = 128;
/** `"\n…\n"` 의 토큰 — 학습 쪽 절단과 같은 이음. */
export const STATE_JOIN_IDS: readonly number[] = [108, 7317, 108];

export interface SequenceSpec {
  readonly prefixIds: readonly number[];
  readonly stateBudget: number;
  readonly sepId: number;
  readonly maxLen: number;
}

export function truncateStateIds(ids: readonly number[], stateBudget: number): number[] {
  const cut = ids.length > STATE_TRUNCATE_ABOVE ? [...ids.slice(0, STATE_HEAD), ...STATE_JOIN_IDS, ...ids.slice(-STATE_TAIL)] : [...ids];
  return cut.slice(0, stateBudget);
}

export function buildInputIds(spec: SequenceSpec, stateIds: readonly number[]): number[] {
  const ids = [...spec.prefixIds, ...truncateStateIds(stateIds, spec.stateBudget), spec.sepId];
  if (ids.length > spec.maxLen) throw new RangeError('sequence_too_long');
  return ids;
}

/** `release_config.json` → 시퀀스 규격. 모양이 다르면 던진다(기동 실패 = 자기 시험 실패). */
export function sequenceSpecOf(releaseConfig: unknown): SequenceSpec {
  const config = releaseConfig as { prefix?: { prefix_ids?: unknown; state_budget?: unknown; sep_id?: unknown; max_len?: unknown } };
  const prefix = config.prefix;
  const ids = prefix?.prefix_ids;
  if (!Array.isArray(ids) || !ids.every((id) => Number.isInteger(id) && id >= 0)) throw new TypeError('bad_prefix_ids');
  const stateBudget = prefix?.state_budget;
  const sepId = prefix?.sep_id;
  const maxLen = prefix?.max_len;
  if (typeof stateBudget !== 'number' || typeof sepId !== 'number' || typeof maxLen !== 'number') throw new TypeError('bad_prefix_spec');
  if (ids.length + stateBudget + 1 > maxLen) throw new RangeError('bad_prefix_budget');
  return { prefixIds: ids as number[], stateBudget, sepId, maxLen };
}

/**
 * 골든 픽스처(`fixtures.json` — subject/text 쌍)를 `aw-in/1` 문자열로 — 학습 `render_email` 과 같다.
 * 운영 선로의 요청은 이미 이 모양이라 워커 경로에서는 부르지 않는다(자기 시험 전용).
 */
export function renderEmail(subject: string | null | undefined, text: string | null | undefined): string {
  const body = (text ?? '').trim();
  const title = (subject ?? '').trim();
  return title === '' ? body : `Subject: ${title}\n\n${body}`;
}
