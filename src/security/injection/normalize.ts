/**
 * src/security/injection/normalize.ts — 스캐너가 룰을 거는 "접힌 보기(folded view)" 를 만든다.
 *
 * ---------------------------------------------------------------------------
 * ## 왜 정규화를 먼저 하는가, 그리고 왜 원문도 따로 보는가
 * ---------------------------------------------------------------------------
 *
 * 의미 룰("이전 지시를 무시하라")은 **글자 모양이 아니라 읽히는 내용**에 걸어야 한다. 에이전트(LLM)는
 * `ｉｇｎｏｒｅ`(전각), `іgnore`(키릴 і), `ig\u200Bnore`(제로폭), `𝐢𝐠𝐧𝐨𝐫𝐞`(수학 굵은꼴)을 전부
 * "ignore" 로 읽는다. 룰이 원문에만 걸리면 이 네 가지가 전부 우회다. 그래서 의미 룰은 접힌 보기에 건다.
 *
 * 반대로 **"접어야만 보였다" 는 사실 자체가 신호다.** 정상 메일은 지시문을 숨기지 않는다. 그래서 접을 때
 * 출력 글자마다 `heavy` 표시(원문과 모양이 달랐다)를 남기고, 의미 룰 적중 구간에 heavy 글자가 있으면
 * 스캐너가 난독화 가중치를 더한다 — 이것이 "정규화 전후 둘 다 본다" 의 구현이다. 기법 룰(C1·태그 문자·
 * 제로폭·동형문자 혼용)은 **원문**에 건다. 접고 나면 그 흔적이 사라지기 때문이다.
 *
 * 단계(코드 포인트마다 한 번, 한 번 훑기 — 선형 시간):
 *   1. 보이지 않는 문자 제거 — 제로폭·양방향 제어·변형 선택자·한글 채움 문자·C0/C1 제어문자.
 *      제거된 문자 **다음** 글자를 heavy 로 표시한다(`ig\u200Bnore` 의 `n`).
 *   2. 유니코드 태그 문자(U+E0020–E007E) → 대응 ASCII. "ASCII 밀수" 기법 — 화면에는 아무것도 없는데
 *      모델 토크나이저는 읽는다. 지우지 않고 **풀어서** 룰이 내용을 보게 한다.
 *   3. NFKD → 소문자 → 결합 부호 제거 → NFC. 사실상 NFKC + 발음 부호 접기다. 전각·수학 영숫자·합자
 *      (`ﬁ`)·`ïgnörе` 가 여기서 풀린다. **한글 음절·자모는 이 단계를 건너뛴다** — NFKD 는 음절을 자모로
 *      쪼개고, 쪼갠 뒤 NFC 로 되돌리는 것은 비용만 든다.
 *   3b. 한글 자모 조립 — 첫가끝 자모(NFD 한글)와 호환 자모로 쪼갠 낱말(`ㅇㅣㅈㅓㄴ`)을 음절로(`composeJamo`). 호환 자모 조립은 강한 표시.
 *   4. 동형문자 접기 — 키릴·그리스 소문자 중 라틴과 모양이 같은 것을 라틴으로(`а`→`a`, `ο`→`o`).
 *   5. 공백 접기 — 공백류 연속은 한 칸. 연속 안에 개행이 있었으면 `\n` 한 칸(줄머리 룰이 쓴다).
 *      그래서 룰 정규식은 단어 사이를 `\s` **한 글자**로 적을 수 있고, `\s+` 같은 가변 수량자가 필요 없다.
 *
 * 출력 글자마다 원문 위치(`srcStart`/`srcEnd`)를 기록한다. 적중 위치는 **원문 좌표**로 보고된다.
 */

/** 접은 문자열과 그 글자별 원문 좌표·heavy 표시. */
export interface FoldedView {
  readonly text: string;
  /** 출력 UTF-16 인덱스 → 원문 UTF-16 시작 인덱스. */
  readonly srcStart: Int32Array;
  /** 출력 UTF-16 인덱스 → 원문 UTF-16 끝 인덱스(배타). */
  readonly srcEnd: Int32Array;
  /**
   * 비트 표시. `HEAVY`(1) — 출력 글자가 원문과 다른 모양에서 왔다(NFKC 변화·발음 부호 접기·동형문자·태그 해독·
   * 보이지 않는 문자 직후). `HEAVY_STRONG`(2) — 그중 **자연어가 쓸 이유가 없는** 변화만: 보이지 않는 문자 직후·
   * 태그 해독·호환 분해(전각·수학 영숫자 — NFKD 가 NFD 와 다르다). 다국어 룰(`nativeFold`)은 강한 표시만 본다 —
   * 프랑스어 `é`→`e`·러시아어 `о`→`o` 는 그 언어를 읽는 정상 경로이지 난독화가 아니다.
   */
  readonly heavy: Uint8Array;
  /** 출력 상한(`MAX_FOLDED_CHARS`)에 걸려 입력 끝까지 접지 못했다. 스캐너는 이것을 절단으로 본다(fail-closed). */
  readonly truncated: boolean;
}

/**
 * 접은 보기 상한. NFKD 는 한 글자를 최대 18자로 늘린다(U+FDFA) — 1MB 입력이 18MB 가 되어 룰 수십 개가
 * 그 위를 돈다(확장 증폭). 입력 상한의 2배에서 멈춘다.
 */
export const MAX_FOLDED_CHARS = 2_000_000;

/** 압축 보기 — 접은 보기에서 문자·숫자만 남긴 것. 글자 사이에 공백·구두점을 끼운 우회(`i.g.n.o.r.e`)용. */
export interface CompactView {
  readonly text: string;
  /** 압축 인덱스 → 접은 보기 인덱스. */
  readonly foldedIndex: Int32Array;
}

/**
 * 지우는 보이지 않는 문자 — `[시작, 끝]` 코드 포인트 구간. 개별 범위를 명시한다: `\p{Cf}` 전체를 지우면
 * 아랍어 서식 문자 같은 의미 있는 것까지 섞이고, 무엇을 지우는지 목록으로 읽을 수 없다.
 * 태그 문자(U+E0020–E007E)는 여기 없다 — 지우지 않고 푼다(머리말 2단계).
 */
const INVISIBLE_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x0008], [0x000b, 0x000c], [0x000e, 0x001f],
  [0x007f, 0x009f], // DEL + C1 제어문자
  [0x00ad, 0x00ad], // soft hyphen
  [0x034f, 0x034f], // combining grapheme joiner
  [0x061c, 0x061c], // arabic letter mark
  [0x115f, 0x1160], // 한글 초성·중성 채움
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x200b, 0x200f], // ZWSP·ZWNJ·ZWJ·LRM·RLM
  [0x202a, 0x202e], // 양방향 임베딩·오버라이드
  [0x2060, 0x206f], // word joiner·보이지 않는 연산자·양방향 격리
  [0x3164, 0x3164], // 한글 채움 문자
  [0xfe00, 0xfe0f], // 변형 선택자
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0], // 반각 한글 채움
  [0x1d173, 0x1d17a],
  [0xe0001, 0xe0001],
  [0xe007f, 0xe007f],
  [0xe0100, 0xe01ef], // 변형 선택자 보충
];

function isInvisible(cp: number): boolean {
  for (const [lo, hi] of INVISIBLE_RANGES) {
    if (cp < lo) return false;
    if (cp <= hi) return true;
  }
  return false;
}

/** 공백류. NFKC 가 공백으로 접는 것(U+00A0·U+3000 등)도 포함한다. */
function isSpace(cp: number): boolean {
  return (
    cp === 0x20 ||
    cp === 0x09 ||
    cp === 0x0a ||
    cp === 0x0d ||
    cp === 0x85 ||
    cp === 0xa0 ||
    cp === 0x1680 ||
    (cp >= 0x2000 && cp <= 0x200a) ||
    cp === 0x2028 ||
    cp === 0x2029 ||
    cp === 0x202f ||
    cp === 0x205f ||
    cp === 0x3000
  );
}

/** 한글은 NFKD 를 건너뛴다(머리말 3단계). 음절·호환 자모·첫가끝 자모. */
function isHangul(cp: number): boolean {
  return (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0x3130 && cp <= 0x318f) || (cp >= 0x1100 && cp <= 0x11ff);
}

/**
 * 한글 자모 조립(2026-10-08 4차). 두 꼴을 음절로 묶는다:
 *   - **첫가끝 자모**(U+1100–11FF, NFD 한글) — 화면에서는 음절과 똑같이 보인다. 정준 등가라 표시를 남기지 않는다(맥의 NFD 파일 이름처럼
 *     정상 글에도 나온다).
 *   - **호환 자모**(U+3131–318E)로 쪼갠 낱말(`ㅇㅣㅈㅓㄴ ㅈㅣㅅㅣ`) — 초성 + 중성(+ 종성) 이 이어질 때만 묶는다. 모음이 없는 `ㅋㅋ`·`ㅎㅇ`·`ㅠㅠ`
 *     는 그대로다. 정상 글이 자음·모음을 낱자로 이어 쓸 이유가 없으므로 **강한** 표시(난독화 가산의 재료)를 남긴다.
 * 겹모음(ㅗ+ㅏ)·겹받침(ㄱ+ㅅ)을 낱자 둘로 쓴 것은 묶지 않는다(조합 규칙이 모호하다 — 원문 그대로 둔다).
 */
const COMPAT_CHOSEONG = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
const COMPAT_JONGSEONG = ' ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ';
const compatChoseong = (cp: number): number => COMPAT_CHOSEONG.indexOf(String.fromCharCode(cp));
const compatJungseong = (cp: number): number => (cp >= 0x314f && cp <= 0x3163 ? cp - 0x314f : -1);
const compatJongseong = (cp: number): number => (cp >= 0x3131 && cp <= 0x314e ? COMPAT_JONGSEONG.indexOf(String.fromCharCode(cp)) : -1);
const conjChoseong = (cp: number): number => (cp >= 0x1100 && cp <= 0x1112 ? cp - 0x1100 : -1);
const conjJungseong = (cp: number): number => (cp >= 0x1161 && cp <= 0x1175 ? cp - 0x1161 : -1);
const conjJongseong = (cp: number): number => (cp >= 0x11a8 && cp <= 0x11c2 ? cp - 0x11a7 : -1);

/** `input[i]` 에서 시작하는 자모 묶음을 음절 하나로. 묶을 수 없으면 `null`. 자모는 모두 BMP 라 한 글자 = 한 UTF-16 단위. */
function composeJamo(input: string, i: number): { readonly syllable: string; readonly end: number; readonly compat: boolean } | null {
  const a = input.charCodeAt(i);
  const compat = a >= 0x3131 && a <= 0x318e;
  const l = compat ? compatChoseong(a) : conjChoseong(a);
  if (l < 0) return null;
  const v = compat ? compatJungseong(input.charCodeAt(i + 1)) : conjJungseong(input.charCodeAt(i + 1));
  if (v < 0) return null;
  let end = i + 2;
  let t = 0;
  if (end < input.length) {
    const c = input.charCodeAt(end);
    const tt = compat ? compatJongseong(c) : conjJongseong(c);
    // 호환 자모의 받침은 다음이 모음이 아닐 때만(다음 음절의 초성이다). 첫가끝 종성은 따로 부호가 있어 모호하지 않다.
    if (tt > 0 && (!compat || compatJungseong(input.charCodeAt(end + 1)) < 0)) {
      t = tt;
      end += 1;
    }
  }
  return { syllable: String.fromCharCode(0xac00 + (l * 21 + v) * 28 + t), end, compat };
}

/**
 * 동형문자 표 — **소문자 기준**(3단계에서 이미 소문자가 됐다). 라틴 소문자와 모양이 같거나
 * 대문자형이 라틴 대문자와 같은 것만. 러시아어 본문은 뜻 없는 라틴 문자열이 되지만, 그 문자열에
 * 영어 지시문 룰이 걸릴 확률은 무시할 수 있다(그리고 걸린다면 그것이 바로 동형문자 공격이다).
 */
const HOMOGLYPHS: ReadonlyMap<number, string> = new Map<number, string>([
  // 키릴
  [0x0430, 'a'], [0x0432, 'b'], [0x0435, 'e'], [0x0451, 'e'], [0x0454, 'e'], [0x043a, 'k'],
  [0x043c, 'm'], [0x043d, 'h'], [0x043e, 'o'], [0x0440, 'p'], [0x0441, 'c'], [0x0442, 't'],
  [0x0443, 'y'], [0x0445, 'x'], [0x0455, 's'], [0x0456, 'i'], [0x0457, 'i'], [0x0458, 'j'],
  [0x04bb, 'h'], [0x04cf, 'l'], [0x0501, 'd'], [0x051b, 'q'], [0x051d, 'w'], [0x0433, 'r'],
  [0x0438, 'u'], [0x043f, 'n'], [0x044c, 'b'], [0x0461, 'w'], [0x04af, 'y'],
  // 그리스
  [0x03b1, 'a'], [0x03b2, 'b'], [0x03b5, 'e'], [0x03b7, 'n'], [0x03b9, 'i'], [0x03ba, 'k'],
  [0x03bd, 'v'], [0x03bf, 'o'], [0x03c1, 'p'], [0x03c4, 't'], [0x03c5, 'u'], [0x03c7, 'x'],
  [0x03b3, 'y'], [0x03c9, 'w'], [0x03f2, 'c'], [0x03f3, 'j'], [0x03c2, 'c'],
  // 라틴 확장 중 흔한 대체
  [0x0131, 'i'], [0x0251, 'a'], [0x0261, 'g'], [0x026a, 'i'], [0x0269, 'i'], [0x1d00, 'a'],
  [0x0280, 'r'], [0x1d0f, 'o'], [0x1d1c, 'u'], [0x0274, 'n'], [0x029f, 'l'],
]);

const MARKS = /\p{M}/gu;

/** 코드 포인트 하나의 접힌 결과. 캐시한다 — 같은 비 ASCII 글자는 본문에 수천 번 나온다. */
const foldCache = new Map<number, string>();
const FOLD_CACHE_MAX = 65_536;

function mapHomoglyphs(s: string): string {
  let mapped = '';
  for (const ch of s) mapped += HOMOGLYPHS.get(ch.codePointAt(0) ?? 0) ?? ch;
  return mapped;
}

function foldCodePoint(cp: number): string {
  const cached = foldCache.get(cp);
  if (cached !== undefined) return cached;
  const out = mapHomoglyphs(String.fromCodePoint(cp).normalize('NFKD').toLowerCase().replace(MARKS, '').normalize('NFC'));
  if (foldCache.size < FOLD_CACHE_MAX) foldCache.set(cp, out);
  return out;
}

/** 단계를 끈 접기(캐시 없음 — 되돌리기 검증 전용). */
function foldCodePointPartial(cp: number, skipNfkc: boolean, skipHomoglyph: boolean): string {
  const ch = String.fromCodePoint(cp);
  const out = skipNfkc ? ch.toLowerCase() : ch.normalize('NFKD').toLowerCase().replace(MARKS, '').normalize('NFC');
  return skipHomoglyph ? out : mapHomoglyphs(out);
}

/** ASCII 영숫자인가 — heavy 판정은 "비 ASCII 가 ASCII 영숫자로 바뀌었다" 에만 건다. */
function hasAsciiAlnum(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if ((c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x7a)) return true;
  }
  return false;
}

/**
 * 정규화 단계 이름. **되돌리기 검증 전용** — 단위 테스트가 단계 하나씩 끄고 그 단계가 막던 우회 양성이
 * 실제로 빠지는지 본다("초록인데 아무것도 안 지킨다" 방지). 운영 경로는 항상 전 단계를 켠다.
 */
export type FoldStage = 'invisible' | 'tags' | 'nfkc' | 'homoglyph' | 'whitespace' | 'jamo';

export const HEAVY = 1;
export const HEAVY_STRONG = 2;

/** 호환 분해 글자인가 — 전각·수학 영숫자·합자(NFKD ≠ NFD). 발음 부호만 붙은 글자(é)는 아니다. */
const compatCache = new Map<number, boolean>();
function isCompatibility(cp: number): boolean {
  const cached = compatCache.get(cp);
  if (cached !== undefined) return cached;
  const ch = String.fromCodePoint(cp);
  const value = ch.normalize('NFKD') !== ch.normalize('NFD');
  if (compatCache.size < FOLD_CACHE_MAX) compatCache.set(cp, value);
  return value;
}

const NO_STAGES_DISABLED: ReadonlySet<FoldStage> = new Set();

/**
 * 원문 → 접은 보기. 한 번 훑는다. 출력 길이는 입력의 수 배를 넘지 않는다(NFKD 확장은 유한하다).
 */
export function fold(input: string, disabled: ReadonlySet<FoldStage> = NO_STAGES_DISABLED): FoldedView {
  const keepInvisible = disabled.has('invisible');
  const keepTags = disabled.has('tags');
  const skipNfkc = disabled.has('nfkc');
  const skipHomoglyph = disabled.has('homoglyph');
  const keepWhitespace = disabled.has('whitespace');
  const keepJamo = disabled.has('jamo');
  const parts: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  const heavy: number[] = [];

  let pendingSpace = false;
  let pendingNewline = false;
  let pendingSpaceStart = 0;
  let pendingSpaceEnd = 0;
  let markNextHeavy = false;
  /** 직전에 지운 것이 **보이지 않는 문자**였다(강한 표시). 홀로 선 결합 부호(태국어 성조·힌디어 모음 기호)는 약한 표시만. */
  let markNextStrong = false;

  const emit = (s: string, start: number, end: number, isHeavy: boolean, isStrong = isHeavy): void => {
    if (pendingSpace) {
      if (parts.length > 0) {
        parts.push(pendingNewline ? '\n' : ' ');
        starts.push(pendingSpaceStart);
        ends.push(pendingSpaceEnd);
        heavy.push(0);
      }
      pendingSpace = false;
      pendingNewline = false;
    }
    for (let k = 0; k < s.length; k += 1) {
      parts.push(s[k] ?? '');
      starts.push(start);
      ends.push(end);
      heavy.push((isHeavy ? HEAVY : 0) | (isStrong ? HEAVY_STRONG : 0));
    }
  };

  const space = (newline: boolean, start: number, end: number): void => {
    if (keepWhitespace) {
      emit(newline ? '\n' : ' ', start, end, false);
      return;
    }
    if (!pendingSpace) {
      pendingSpace = true;
      pendingSpaceStart = start;
    }
    pendingSpaceEnd = end;
    if (newline) pendingNewline = true;
  };

  let i = 0;
  let truncated = false;
  while (i < input.length) {
    if (parts.length >= MAX_FOLDED_CHARS) {
      truncated = true;
      break;
    }
    const cp = input.codePointAt(i) ?? 0;
    const width = cp > 0xffff ? 2 : 1;
    const start = i;
    const end = i + width;
    i = end;

    if (cp < 0x80) {
      if (isSpace(cp)) {
        space(cp === 0x0a || cp === 0x0d, start, end);
        continue;
      }
      if (isInvisible(cp) && !keepInvisible) {
        markNextHeavy = true;
        markNextStrong = true;
        continue;
      }
      const lower = cp >= 0x41 && cp <= 0x5a ? String.fromCharCode(cp + 32) : String.fromCharCode(cp);
      emit(lower, start, end, markNextHeavy, markNextStrong);
      markNextHeavy = false;
      markNextStrong = false;
      continue;
    }
    if (isSpace(cp)) {
      space(cp === 0x85 || cp === 0x2028 || cp === 0x2029, start, end);
      continue;
    }
    // 유니코드 태그 문자 → ASCII. 지우지 않고 푼다(머리말 2단계).
    if (cp >= 0xe0020 && cp <= 0xe007e && !keepTags) {
      // 태그 연속의 시작은 단어 경계다 — 보이는 글자에 붙은 숨은 문장이 앞 단어와 한 단어로 읽히지 않게.
      const prevIsTag = start > 1 && (input.codePointAt(start - 2) ?? 0) >= 0xe0000;
      if (start > 0 && !prevIsTag) space(false, start, start);
      const ascii = String.fromCharCode(cp - 0xe0000).toLowerCase();
      if (ascii === ' ') space(false, start, end);
      else emit(ascii, start, end, true);
      continue;
    }
    if ((isInvisible(cp) || (cp >= 0xe0020 && cp <= 0xe007e)) && !keepInvisible) {
      markNextHeavy = true;
      markNextStrong = true;
      continue;
    }
    if (!keepJamo && ((cp >= 0x3131 && cp <= 0x314e) || (cp >= 0x1100 && cp <= 0x1112))) {
      const joined = composeJamo(input, start);
      if (joined !== null) {
        emit(joined.syllable, start, joined.end, markNextHeavy || joined.compat, markNextStrong || joined.compat);
        markNextHeavy = false;
        markNextStrong = false;
        i = joined.end;
        continue;
      }
    }
    if (isHangul(cp) || (keepInvisible && isInvisible(cp))) {
      emit(String.fromCodePoint(cp), start, end, markNextHeavy, markNextStrong);
      markNextHeavy = false;
      markNextStrong = false;
      continue;
    }
    const folded = skipNfkc || skipHomoglyph ? foldCodePointPartial(cp, skipNfkc, skipHomoglyph) : foldCodePoint(cp);
    if (folded.length === 0) {
      // 홀로 선 결합 부호 등 — 지운다. 글자 사이에 끼운 결합 부호도 우회 기법이다.
      markNextHeavy = true;
      continue;
    }
    if (folded.trim().length === 0) {
      space(false, start, end);
      continue;
    }
    const ascii = hasAsciiAlnum(folded);
    emit(folded, start, end, markNextHeavy || ascii, markNextStrong || (ascii && isCompatibility(cp)));
    markNextHeavy = false;
    markNextStrong = false;
  }

  return {
    text: parts.join(''),
    srcStart: Int32Array.from(starts),
    srcEnd: Int32Array.from(ends),
    heavy: Uint8Array.from(heavy),
    truncated,
  };
}

/**
 * 룰 **원문**을 접은 보기의 글자로 옮긴다 — 다국어 룰은 사람이 읽는 원래 글자(`игнорируй`, `プロンプト`, `précédentes`)로
 * 적고, 모듈을 읽을 때 이 함수로 접는다. 비 ASCII 코드 포인트만 `fold` 와 **같은 함수**로 바꾼다(ASCII 는 정규식 문법이라
 * 그대로 둔다). 그래서 룰과 본문이 언제나 같은 접기를 거친다 — 러시아어는 동형문자 표를, 일본어는 탁점 제거를,
 * 힌디어는 모음 기호 제거를 둘 다 똑같이 받는다. 정규식 안에서는 비 ASCII 를 **글자로만** 써야 한다(클래스 안이면 한
 * 글자가 한 글자로 접히는 것만).
 */
export function foldPatternLiteral(source: string): string {
  let out = '';
  for (const ch of source) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x80 || isHangul(cp)) out += ch;
    else if (isInvisible(cp)) continue;
    else out += foldCodePoint(cp);
  }
  return out;
}

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/** 접은 보기 → 문자·숫자만 남긴 압축 보기. */
export function compact(folded: FoldedView): CompactView {
  const parts: string[] = [];
  const index: number[] = [];
  const text = folded.text;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] ?? '';
    const c = ch.charCodeAt(0);
    // ASCII 빠른 길. 서로게이트는 접은 보기에서 거의 나오지 않지만 나오면 정규식이 판정한다.
    const keep =
      (c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x7a) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0x80 && LETTER_OR_DIGIT.test(ch));
    if (!keep) continue;
    parts.push(ch);
    index.push(i);
  }
  return { text: parts.join(''), foldedIndex: Int32Array.from(index) };
}

/**
 * 버전 해시 재료(`scanner.ts`) — 정규화 **데이터**(지우는 구간·동형문자 표). 표를 바꾸면 스탬프가 바뀐다.
 */
export const NORMALIZATION_SIGNATURE: string = [
  INVISIBLE_RANGES.map(([lo, hi]) => `${lo.toString(16)}-${hi.toString(16)}`).join(','),
  [...HOMOGLYPHS].map(([cp, ch]) => `${cp.toString(16)}>${ch}`).join(','),
  'tags:e0020-e007e>ascii',
  'nfkd>lower>strip-marks>nfc;hangul-skip',
  'jamo-compose:conjoining(canonical,no-mark)|compat(L+V[+T if next not V],strong)',
  'heavy-bits:1=any,2=strong(invisible-adjacent|tag|compat-to-ascii);lone-mark=weak',
  'space-collapse:newline-preserving',
  `max-folded:${String(MAX_FOLDED_CHARS)}`,
].join('\n');
