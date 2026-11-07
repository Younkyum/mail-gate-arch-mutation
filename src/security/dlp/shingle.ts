/**
 * src/security/dlp/shingle.ts — **받은 메일 복사 지문**(ADR-0016 B `inbound_copy`). 받은 메일 본문이 통째로·크게 다른 곳으로 나가는지 본다.
 *
 * 방식: 접은 보기의 **단어 8-gram** 롤링 해시 → **winnowing**(창 w=4, Schleimer·Wilkerson·Aiken 2003) → 고른 gram 을 HMAC 으로 지문화.
 *   - winnowing 은 "길이 k+w−1 = 11 단어 이상 겹치는 구간은 반드시 지문 하나를 공유한다" 를 보장한다 — 문장 몇 개를 그대로 옮기면 걸린다.
 *   - 롤링 해시는 키 없는 두 갈래 32비트(FNV-1a 단어 해시의 다항식)라 **선택**에만 쓴다. 저장·비교하는 값은 HMAC(`hmac-keyring`)이다 —
 *     원문 단어를 저장하지 않고, 키 없이는 지문에서 문장을 거꾸로 맞춰 볼 수 없다.
 *   - 받은 메일은 지문을 **최대 256개**(HMAC 값이 작은 것부터 — bottom-k) 둔다. 발신 쪽은 상한 200,000 개까지 전부 낸다(1MB 산문은 약 7만 개 — 상한에 닿지 않는다).
 *
 * 판정(`inboundCopyOverlap`): 받은 메일 한 통과의 겹침이 **12개 이상**, 또는 **4개 이상이면서 그 메일 지문의 30% 이상**.
 * 4개 하한은 짧은 메일의 상투구("문의 사항이 있으시면 언제든지 연락 주세요")가 30% 를 혼자 넘기지 않게 한다.
 * 회신 대상 메일·수신자 본인이 보낸 메일은 호출자(`scan.ts`)가 뺀다 — 인용 회신은 정상이다.
 */

import { createHmac } from 'node:crypto';

import type { HmacKeyring } from '../hmac-keyring';

const SHINGLE_CONTEXT = 'atmark.dlp.inbound-shingle.v1';

export const SHINGLE_WORDS = 8;
export const WINNOW_WINDOW = 4;
export const MAX_INBOUND_FINGERPRINTS = 256;
export const MAX_OUTBOUND_FINGERPRINTS = 200_000;
export const COPY_MIN_OVERLAP = 12;
export const COPY_MIN_RATIO = 0.3;
export const COPY_RATIO_MIN_OVERLAP = 4;

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

function isWordChar(text: string, i: number): boolean {
  const c = text.charCodeAt(i);
  if ((c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x7a) || (c >= 0xac00 && c <= 0xd7a3)) return true;
  if (c < 0x80) return false;
  return LETTER_OR_DIGIT.test(text[i] ?? '');
}

/** 단어 해시 두 갈래(FNV-1a 32비트, 다른 시작값). */
function wordHashes(text: string, start: number, end: number): readonly [number, number] {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = start; i < end; i += 1) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x01000193) ^ (b >>> 13);
  }
  return [a >>> 0, b >>> 0];
}

const BASE_A = 0x9e3779b1;
const BASE_B = 0x85ebca77;

function power(base: number, exp: number): number {
  let out = 1;
  for (let i = 0; i < exp; i += 1) out = Math.imul(out, base);
  return out;
}

const TOP_A = power(BASE_A, SHINGLE_WORDS - 1);
const TOP_B = power(BASE_B, SHINGLE_WORDS - 1);

/**
 * 접은 보기 → winnowing 으로 고른 gram 해시(두 갈래를 붙인 16자 hex 키, 중복 없음). 한 번 훑는다.
 */
function winnowedGrams(folded: string, limit: number): { readonly grams: Set<string>; readonly truncated: boolean } {
  const wordsA: number[] = [];
  const wordsB: number[] = [];
  let i = 0;
  while (i < folded.length) {
    if (!isWordChar(folded, i)) {
      i += 1;
      continue;
    }
    const start = i;
    while (i < folded.length && isWordChar(folded, i)) i += 1;
    const [a, b] = wordHashes(folded, start, i);
    wordsA.push(a);
    wordsB.push(b);
  }

  const grams = new Set<string>();
  if (wordsA.length < SHINGLE_WORDS) return { grams, truncated: false };

  // 롤링 해시.
  const gramA: number[] = [];
  const gramB: number[] = [];
  let ha = 0;
  let hb = 0;
  for (let w = 0; w < wordsA.length; w += 1) {
    if (w >= SHINGLE_WORDS) {
      ha = (ha - Math.imul(wordsA[w - SHINGLE_WORDS] ?? 0, TOP_A)) | 0;
      hb = (hb - Math.imul(wordsB[w - SHINGLE_WORDS] ?? 0, TOP_B)) | 0;
    }
    ha = (Math.imul(ha, BASE_A) + (wordsA[w] ?? 0)) | 0;
    hb = (Math.imul(hb, BASE_B) + (wordsB[w] ?? 0)) | 0;
    if (w >= SHINGLE_WORDS - 1) {
      gramA.push(ha >>> 0);
      gramB.push(hb >>> 0);
    }
  }

  // winnowing — 창마다 최솟값(같으면 가장 오른쪽). 창 4 라 창 안을 그대로 훑는다(선형).
  const less = (x: number, y: number): boolean =>
    (gramA[x] ?? 0) < (gramA[y] ?? 0) || ((gramA[x] ?? 0) === (gramA[y] ?? 0) && (gramB[x] ?? 0) <= (gramB[y] ?? 0));
  const windows = Math.max(1, gramA.length - WINNOW_WINDOW + 1);
  let lastPicked = -1;
  let truncated = false;
  for (let s = 0; s < windows; s += 1) {
    let best = s;
    const end = Math.min(gramA.length, s + WINNOW_WINDOW);
    for (let j = s + 1; j < end; j += 1) if (less(j, best)) best = j;
    if (best === lastPicked) continue;
    lastPicked = best;
    if (grams.size >= limit) {
      truncated = true;
      break;
    }
    grams.add(`${(gramA[best] ?? 0).toString(16).padStart(8, '0')}${(gramB[best] ?? 0).toString(16).padStart(8, '0')}`);
  }
  return { grams, truncated };
}

function macOf(key: Buffer, gram: string): string {
  return createHmac('sha256', key).update(`${SHINGLE_CONTEXT}\n${gram}`, 'utf8').digest('hex').slice(0, 16);
}

/** 받은 메일 한 통의 지문 묶음. */
export interface ShingleSet {
  readonly kid: string;
  readonly fingerprints: readonly string[];
}

/** 받은 메일(접은 보기) → 지문 최대 256개(HMAC 값 오름차순 bottom-k). 활성 키. */
export function inboundShingles(keyring: HmacKeyring, folded: string): ShingleSet {
  const key = keyring.keys.get(keyring.activeKid);
  if (key === undefined) return { kid: keyring.activeKid, fingerprints: [] };
  const { grams } = winnowedGrams(folded, MAX_OUTBOUND_FINGERPRINTS);
  const macs = [...new Set([...grams].map((g) => macOf(key, g)))].sort();
  return { kid: keyring.activeKid, fingerprints: macs.slice(0, MAX_INBOUND_FINGERPRINTS) };
}

export interface OutboundShingles {
  /** kid → 지문 집합. */
  readonly byKid: ReadonlyMap<string, ReadonlySet<string>>;
  readonly truncated: boolean;
}

/** 발신 본문(접은 보기) → 요청한 kid 마다 지문 집합. */
export function outboundShingles(keyring: HmacKeyring, folded: string, kids: Iterable<string>): OutboundShingles {
  const { grams, truncated } = winnowedGrams(folded, MAX_OUTBOUND_FINGERPRINTS);
  const byKid = new Map<string, ReadonlySet<string>>();
  for (const kid of kids) {
    const key = keyring.keys.get(kid);
    if (key === undefined || byKid.has(kid)) continue;
    byKid.set(kid, new Set([...grams].map((g) => macOf(key, g))));
  }
  return { byKid, truncated };
}

/** 받은 메일 한 통과의 겹침 판정(머리말 "판정"). */
export function inboundCopyOverlap(outbound: ReadonlySet<string>, inbound: readonly string[]): boolean {
  if (inbound.length === 0) return false;
  const unique = new Set(inbound);
  let overlap = 0;
  for (const fingerprint of unique) if (outbound.has(fingerprint)) overlap += 1;
  if (overlap >= COPY_MIN_OVERLAP) return true;
  return overlap >= COPY_RATIO_MIN_OVERLAP && overlap / unique.size >= COPY_MIN_RATIO;
}
