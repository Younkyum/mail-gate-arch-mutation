/**
 * src/security/injection/scanner.ts — 수신 메일 한 통의 injection 위험도 판정. **결정론적 · LLM 없음 · 네트워크 없음.**
 *
 * 입력은 MIME 파서(`src/mail/mime/parse.ts`) 출력의 부분 모양이다 — **import 하지 않는다.** 이 디렉터리는
 * 저장소 안의 어떤 모듈에도 기대지 않는 순수 함수 묶음이고(`test/arch/security-isolation.arch.test.ts`),
 * 그래야 "스캐너가 무엇을 보는가" 가 이 파일의 인자 목록으로 끝난다.
 *
 * ---------------------------------------------------------------------------
 * ## 무엇을 보는가
 * ---------------------------------------------------------------------------
 *
 *   - `text` **와** `htmlText` 둘 다. 한국 서비스 메일은 plain 에 "HTML 을 지원하지 않습니다" 만 넣고
 *     실제 내용은 HTML 에만 두는 경우가 있다. 파서는 HTML 의 숨김 요소 텍스트를 일부러 남긴다.
 *     두 값이 같으면(plain 파트가 없어 HTML 변환이 `text` 가 된 경우) 한 번만 본다.
 *   - `subject`, 첨부 파일명. 첨부 파일명·rfc822 내부는 아직 라이브러리 디코딩을 탄다(파서 머리말) —
 *     C1 제어문자(파서 차이 공격)가 들어올 수 있는 경로다.
 *
 * **파서는 C1 을 지운다 — 그래서 흔적을 따로 받는다.** `parse.ts` 는 본문의 C0·C1 제어문자를 삭제하고 헤더
 * 값(제목·파일명)의 제어문자를 공백으로 바꾼다. 지운 문자열만 받으면 C1 기법 룰은 발화할 수 없으므로(v1 에서
 * 운영 경로의 C1 신호가 죽어 있었다) 파서가 필드별 C1 개수와 "C1·ASCII 교대" 최장 길이를 `c1Removed` 로 내고,
 * 이 스캐너는 그것을 원문에 거는 것과 **같은 id·가중치**의 기법 적중(`view: 'parser'`, 좌표 0–0)으로 센다.
 * 지워진 뒤의 ASCII(`\u008Cc` → `c`)는 여전히 접은 보기에서 의미 룰이 본다.
 *
 * **알려진 한계 — HTML 스타일 숨김.** 흰 글씨·`display:none`·0 크기는 파서(`parse-html.ts`)가 속성을 버려서
 * 이 스캐너가 "숨겨졌다" 는 사실을 모른다(숨긴 **텍스트**는 남으므로 내용은 본다). 표시하지 않은 이유:
 * ① 정상 마케팅 메일 대부분이 숨김 프리헤더(`display:none;max-height:0`)를 쓴다 — 숨김 자체는 신호가 못 되고
 * 다른 적중과 겹칠 때 가산하는 보조 신호일 뿐이다. ② 인라인 `style` 만 보면 `<style>` 클래스·상속 배경색·
 * `mso-hide`·화면 밖 위치로 바로 우회된다 — 제대로 하려면 CSS 캐스케이드가 필요하고, 그것은 선형 시간
 * 토크나이저(`parse-html.ts`)를 요소 스택·선택자 매칭으로 바꾸는 일이다. ③ 숨긴 곳의 지시문은 숨기지 않은
 * 것과 똑같이 의미 룰을 받는다 — 잃는 것은 "숨겼다" 가산점 하나다. 비용 대비 이득이 작아 남겨 둔다.
 *
 * **글 속에 남은 엔티티·`%XX`**(2026-10-08 인코딩 점검): text/plain 파트의 `&#64;`, HTML 파트의 이중 엔티티(`&amp;#64;` — 파서는 한 번만 푼다),
 * `drop%40example` 은 에이전트(LLM)가 풀어 읽는다. 엔티티 보기(`view: 'entity'`)가 풀어서 **접은 보기에서 걸리지 않던 룰만** 센다. 점검 표와 남은
 * 한계는 `docs/security/encoding-limits.md`.
 *
 * ---------------------------------------------------------------------------
 * ## 출력 규율
 * ---------------------------------------------------------------------------
 *
 *   - `SecurityFinding` 에 **매칭된 원문을 싣지 않는다.** 룰 id·필드·보기·원문 좌표·가중치뿐. finding 은
 *     로그·audit·`security_findings` 행으로 간다 — 인증 코드·주소(PII)나 공격 문자열 자체가 거기 실리면
 *     관측 경계(§4.3)가 무너지고, 공격 문자열이 **다른 에이전트의 컨텍스트로 재주입**될 수 있다.
 *     원문이 필요하면 좌표와 `scannerVersion` 으로 저장된 원문(S3)에서 재현한다.
 *   - `scannerVersion` — 룰 표 버전 + 룰 표 해시. 룰이 바뀐 뒤에도 과거 판정을 재현할 수 있게.
 *
 * ---------------------------------------------------------------------------
 * ## 격리 임계 — `medium` 부터
 * ---------------------------------------------------------------------------
 *
 *   - `low`(점수 1–2)는 **약한 표지 하나**다: 시스템 프롬프트 **언급**, AI 호명 단독, 줄머리 `system:`,
 *     단어 속 제로폭 몇 개. AI 뉴스레터·보안 교육 메일이 정확히 이 모양이고, 에이전트를 움직일 지시를
 *     담지 않는다. 이것까지 격리하면 오탐 예산(≤5%)을 경계 음성이 다 쓴다. → 격리하지 않고 위험도만 붙인다.
 *   - `medium`(3–4)은 **지시성 표지**가 하나 이상이다: 지시 덮어쓰기, 탈옥, 은폐 요구, 대화 구분자 위조,
 *     유니코드 태그 밀수, C1/ASCII 교대, 절단. 이것들은 사람 독자에게 의미가 없다 — 정상 메일이 쓸
 *     이유가 없는 표지이므로 격리의 오탐 비용이 낮다.
 *   - `high`(≥5)는 도구 행동으로 비밀을 내보내라는 요구이거나 지시성 표지 + 다른 축.
 *
 *   `high` 만 격리하지 않는 이유: **고위험 미탐 0%** 가 AC-7 의 요구이고, 룰이 한 축을 놓쳐 high 가 medium
 *   으로 떨어진 공격도 격리돼야 한다. medium 격리가 그 여유다. 격리는 삭제가 아니다(R9) — 소유자가 복구한다.
 */

import { createHash } from 'node:crypto';

import { HEAVY, HEAVY_STRONG, NORMALIZATION_SIGNATURE, compact, fold, type FoldStage, type FoldedView } from './normalize';
import {
  COMPACT_RULES,
  DAMPED_TOTAL_CAP,
  ENCODED_WEIGHT,
  EXAMPLE_LEAD,
  INJECTION_RULESET_VERSION,
  Lexicon,
  META_DISCUSSION,
  RULES_SIGNATURE,
  HIDDEN_WEIGHT,
  OBFUSCATION_WEIGHT,
  SEMANTIC_RULES,
  TECHNIQUE_RULES,
  TRUNCATION_WEIGHT,
  allMatches,
  type RuleFamily,
  type SemanticRule,
  type Span,
} from './rules';

export type InjectionRisk = 'none' | 'low' | 'medium' | 'high';
export type ScanField = 'subject' | 'text' | 'html' | 'attachment_name';
/**
 * 적중을 본 보기. `raw` 기법 룰 · `folded` 접은 보기 · `compact` 문자만 남긴 보기 · `base64` 풀어 접은 보기
 * (줄바꿈으로 나뉜 덩어리를 이은 것·두 겹 인코딩 포함) · `hex` 16진수를 풀어 접은 보기 · `transform` 글자
 * 치환(ROT13·거꾸로 쓰기)을 되돌린 보기 · `entity` 글 속에 그대로 남은 HTML 엔티티(이름·숫자·이중)와 `%XX` 를 푼 보기(좌표는 필드 전체) ·
 * `parser` 파서가 스캐너보다 먼저 지운 흔적(좌표 없음, 0–0).
 */
export type ScanView = 'raw' | 'folded' | 'compact' | 'base64' | 'hex' | 'entity' | 'transform' | 'parser' | 'hidden';

/**
 * 파서가 **지운** C1 제어문자의 흔적 — 파서 출력 `ParsedInboundMessage.c1Removed` 와 같은 모양이다.
 * 파서는 본문의 C1 을 지우고 헤더의 C1 을 공백으로 바꾼다. 그 뒤의 문자열만 받으면 파서 차이 공격
 * (CP949 확장 음절 → C1 + ASCII)의 흔적이 사라지므로 파서가 개수와 "C1·ASCII 교대" 최장 길이를 따로 넘긴다.
 */
export interface ParserC1Removal {
  readonly field: 'subject' | 'text' | 'htmlText' | 'attachmentName';
  /** 첨부 파일명이면 첨부 순서, 아니면 0. */
  readonly index: number;
  readonly count: number;
  /** C1 바로 뒤에 인쇄 가능 ASCII 가 오는 쌍이 연속한 최장 개수. */
  readonly longestAlternation: number;
}

/** 파서 출력(`ParsedInboundMessage`)의 부분 모양. 구조적으로 호환된다. */
export interface InjectionScanInput {
  readonly subject: string | null;
  readonly text: string;
  readonly htmlText: string | null;
  readonly attachmentNames?: readonly (string | null)[];
  /** 파서가 지운 C1 의 흔적. 운영 경로는 `parseInboundMime` 결과의 `c1Removed` 를 그대로 넘긴다. */
  readonly c1Removed?: readonly ParserC1Removal[];
  /**
   * HTML 에서 **숨긴** 글(`parseInboundMime` 결과의 `hiddenText`). `htmlText` 에도 들어 있다 — 이 필드는 "숨겼다" 는 사실을 전한다.
   * 숨긴 글 **안에서** 지시성(위험) 룰이 걸릴 때만 숨김 가산(`concealment.hidden_html`)을 더한다. 숨긴 글 자체는 신호가 아니다(마케팅 프리헤더).
   */
  readonly hiddenText?: string | null;
}

export interface SecurityFinding {
  readonly ruleId: string;
  readonly family: RuleFamily;
  readonly field: ScanField;
  /** 첨부 파일명이면 첨부 순서, 아니면 0. */
  readonly fieldIndex: number;
  readonly view: ScanView;
  /** **원문(필드 문자열) UTF-16 좌표**. base64 적중이면 그 후보 덩어리 전체. 매칭 원문은 싣지 않는다. */
  readonly start: number;
  readonly end: number;
  /** 점수에 들어간 가중치(완화됐으면 1). */
  readonly weight: number;
  /** 인용·코드 안 메타 논의로 완화됐다. */
  readonly damped: boolean;
}

export interface InjectionScanResult {
  readonly scannerVersion: string;
  readonly injectionRisk: InjectionRisk;
  readonly score: number;
  readonly quarantine: boolean;
  /** 원문 좌표 순. 최대 `MAX_FINDINGS` 개 — 넘으면 `findingsTruncated`. 점수는 전체로 계산한다. */
  readonly findings: readonly SecurityFinding[];
  readonly findingsTruncated: boolean;
}

/** 격리 임계 — 머리말 "격리 임계". */
export const QUARANTINE_FROM: InjectionRisk = 'medium';

const RISK_ORDER: Readonly<Record<InjectionRisk, number>> = { none: 0, low: 1, medium: 2, high: 3 };

export function shouldQuarantine(risk: InjectionRisk): boolean {
  return RISK_ORDER[risk] >= RISK_ORDER[QUARANTINE_FROM];
}

/** 점수(축별 최댓값의 합) → 위험도 하한. */
const RISK_THRESHOLDS = { low: 1, medium: 3, high: 5 } as const;

export function riskFromScore(score: number): InjectionRisk {
  if (score >= RISK_THRESHOLDS.high) return 'high';
  if (score >= RISK_THRESHOLDS.medium) return 'medium';
  if (score >= RISK_THRESHOLDS.low) return 'low';
  return 'none';
}

/** 필드 하나의 스캔 상한. 파서의 `maxTextChars`(1,000,000)와 같다 — 파서를 거친 입력은 잘리지 않는다. */
export const MAX_FIELD_CHARS = 1_000_000;
const MAX_ATTACHMENT_NAMES = 500;
const MAX_FINDINGS = 64;
/** 룰 하나가 필드 하나에서 보고하는 적중 수. 점수는 존재만 본다. */
const MAX_HITS_PER_RULE = 8;

// base64 후보 — 상한이 있는 수량자만(ReDoS 규율). 긴 덩어리는 8192자 단위로 잘려 여러 후보가 된다.
export const BASE64_CANDIDATE = /[A-Za-z0-9+/_-]{24,8192}={0,2}/g;
const MAX_BASE64_CANDIDATES_PER_FIELD = 256;
const MAX_BASE64_DECODED_CHARS_PER_FIELD = 512 * 1024;
/**
 * 이웃한 base64 후보 사이가 **줄바꿈 하나(와 인용 표시 `>`)** 뿐이면 한 덩어리로 잇는다 — MIME 식 76자
 * 줄바꿈이 목적지 주소를 두 줄로 쪼개 어느 줄도 혼자서는 룰에 안 걸리던 것(v1 에서 놓친 계열).
 */
export const BASE64_LINE_JOIN = /^[ \t]{0,4}\r?\n[ \t>]{0,4}$/;
const MAX_BASE64_JOINED_CHARS = 64 * 1024;
/** 풀어낸 base64 안의 base64 — 두 겹까지 푼다(v1 약점: 이중 인코딩). */
const BASE64_MAX_DEPTH = 2;
/**
 * 16진수 후보 — `49676e6f7265…`, `\x49\x67…`, `%49%67…`, `49 67 6e …`. 12바이트 이상. 풀어서 UTF-8 이고 글자가
 * 절반 이상일 때만 본다(해시·메시지 ID 는 이진 쓰레기로 풀려 버려진다).
 */
export const HEX_CANDIDATE = /(?:\\x|%|0x)?[0-9a-fA-F]{2}(?:(?:\\x|%|0x|[ ,:-])?[0-9a-fA-F]{2}){11,4095}/g;
const MAX_HEX_CANDIDATES_PER_FIELD = 64;
/**
 * 글자 치환 보기의 방아쇠 — 영어 기능어의 ROT13 형(`gur` the · `naq` and · `lbh` you …)과 거꾸로 쓴 형
 * (`eht` · `dna` · `uoy` …). 서로 다른 2개 이상이 합쳐 3번 이상 나오면 그 치환을 되돌린 보기에 의미 룰을 건다.
 * 문구가 아니라 **언어의 통계**에 거는 것이라 특정 페이로드에 맞춘 룰이 아니다.
 */
export const ROT13_FUNCTION_WORDS = /\b(?:gur|naq|lbh|lbhe|nyy|guvf|jvgu|sebz|gung|nal|vafgehpgvbaf|cerivbhf|vtaber|sbejneq|fraq|cnffjbeq|rznvyf?)\b/g;
export const REVERSED_FUNCTION_WORDS = /\b(?:eht|dna|uoy|ruoy|lla|siht|htiw|morf|taht|yna|snoitcurtsni|suoiverp|erongi|drawrof|dnes|drowssap|sliame|liame)\b/g;
const TRANSFORM_MIN_HITS = 3;
const TRANSFORM_MIN_DISTINCT = 2;
/** C1·ASCII 교대가 이 길이 이상이면 파서 차이 공격의 모양이다(`technique.c1_interleaved_ascii` 와 같은 문턱). */
const C1_ALTERNATION_MIN = 4;
/**
 * 엔티티·퍼센트 보기의 방아쇠 — 글 속에 **그대로 남은** `&#64;`·`&amp;#105;`·`&commat;`·`%40`. 파서는 HTML 파트의 엔티티를 한 번 풀지만
 * text/plain 파트·이중 인코딩·`%XX` 는 그대로 넘긴다. 받는 에이전트(LLM)는 그것을 풀어 읽는다(`contact&#64;example.com` = 주소).
 */
export const ENTITY_TRIGGER = /&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z]{2,8});|%[0-9a-fA-F]{2}/;
const ENTITY_PATTERN = /&(?:#([0-9]{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]{2,8}));/g;
const PERCENT_RUN = /(?:%[0-9a-fA-F]{2}){1,1024}/g;
/** 엔티티 이름 — 흔한 것과 난독화에 쓰이는 구두점 이름. 모르는 이름은 그대로 둔다. */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', commat: '@', period: '.', colon: ':', sol: '/', lowbar: '_', hyphen: '-',
  dash: '-', num: '#', percnt: '%', excl: '!', quest: '?', lpar: '(', rpar: ')', lsqb: '[', rsqb: ']', lbrack: '[', rbrack: ']', comma: ',',
  semi: ';', equals: '=', plus: '+', ast: '*', bsol: '\\', vert: '|', grave: '`', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', hellip: '…',
  zwj: '\u200d', zwnj: '\u200c', shy: '\u00ad', newline: '\n', tab: '\t',
};

/** 점수 규칙의 데이터 서명 — 임계·격리 임계·스캔 상한. 바꾸면 스탬프가 바뀐다. */
const SCORING_SIGNATURE = JSON.stringify({
  aggregate: 'family-max-sum',
  RISK_THRESHOLDS,
  QUARANTINE_FROM,
  MAX_FIELD_CHARS,
  MAX_ATTACHMENT_NAMES,
  BASE64_CANDIDATE: BASE64_CANDIDATE.source,
  MAX_BASE64_CANDIDATES_PER_FIELD,
  MAX_BASE64_DECODED_CHARS_PER_FIELD,
  BASE64_LINE_JOIN: BASE64_LINE_JOIN.source,
  MAX_BASE64_JOINED_CHARS,
  BASE64_MAX_DEPTH,
  HEX_CANDIDATE: HEX_CANDIDATE.source,
  MAX_HEX_CANDIDATES_PER_FIELD,
  ROT13_FUNCTION_WORDS: ROT13_FUNCTION_WORDS.source,
  REVERSED_FUNCTION_WORDS: REVERSED_FUNCTION_WORDS.source,
  TRANSFORM_MIN_HITS,
  TRANSFORM_MIN_DISTINCT,
  C1_ALTERNATION_MIN,
  ENTITY_TRIGGER: ENTITY_TRIGGER.source,
  ENTITY_PATTERN: ENTITY_PATTERN.source,
  PERCENT_RUN: PERCENT_RUN.source,
  NAMED_ENTITIES,
  entityView: 'decode-twice+percent-utf8;new-rules-only;encoded.entity_payload',
  hiddenView: 'risk-family-in-hidden->concealment.hidden_html',
  HIDDEN_RISK_FAMILIES: 'ACTIONABLE+CONCEALED+ai_addressee+prompt_leak+role_spoof+jailbreak+authority',
  parserC1: 'count>0:technique.c1_control;alternation>=min:technique.c1_interleaved_ascii',
});

/** 판정기 데이터 전체(룰·정규화·점수)의 SHA-256. `INJECTION_RULESET_VERSION` 을 올리는 것을 잊었는지 테스트가 본다. */
export const INJECTION_SCANNER_FINGERPRINT = createHash('sha256')
  .update(RULES_SIGNATURE)
  .update('\n--\n')
  .update(NORMALIZATION_SIGNATURE)
  .update('\n--\n')
  .update(SCORING_SIGNATURE)
  .digest('hex');

/** `security_findings`·수신 메시지 행에 함께 저장한다. */
export const INJECTION_SCANNER_VERSION = `atmark-injection/${INJECTION_RULESET_VERSION}+${INJECTION_SCANNER_FINGERPRINT.slice(0, 12)}`;

/**
 * 숨긴 글 안에서 **지시성** 룰이 걸리면 숨김 가산을 붙이는, 그 "지시성" 계열. `taint.ts` 의 ACTIONABLE ∪ CONCEALED 를 **포함하고**,
 * 사람에게 쓴 메일이라면 숨길 이유가 없는 호명·유출·역할 계열을 더 넓게 본다(숨긴 곳에서는 AI 호명·프롬프트 유출도 지시성 표지다).
 * 스캐너는 taint 를 import 하지 않으므로(taint 가 스캐너를 import 한다) 여기 둔다. `scan_limit` 은 넣지 않는다(절단은 지시가 아니다).
 */
export const HIDDEN_RISK_FAMILIES: ReadonlySet<RuleFamily> = new Set<RuleFamily>([
  'exfiltration', 'agent_action', 'tool_invocation', 'override', 'concealment', 'narrative',
  'ai_addressee', 'prompt_leak', 'role_spoof', 'jailbreak', 'authority',
  'technique', 'obfuscation', 'encoded', 'evasion',
]);

const QUOTE_CHARS = new Set(['"', "'", '“', '”', '‘', '’', '`', '「', '」', '『', '』', '«', '»']);

/** 되돌리기 검증 전용 — 운영 호출은 인자 없이 부른다(`fold` 의 `FoldStage` 참조). */
export type ScanStage = 'compact' | 'base64' | 'hex' | 'entity' | 'transform' | 'hidden' | 'damping';

export interface ScanAblation {
  readonly disabledRules?: ReadonlySet<string>;
  readonly disabledStages?: ReadonlySet<FoldStage | ScanStage>;
}

const SCAN_STAGES: ReadonlySet<string> = new Set<ScanStage>(['compact', 'base64', 'hex', 'entity', 'transform', 'hidden', 'damping']);

interface FieldInput {
  readonly field: ScanField;
  readonly index: number;
  readonly raw: string;
  readonly truncated: boolean;
}

function collectFields(input: InjectionScanInput): FieldInput[] {
  const out: FieldInput[] = [];
  const add = (field: ScanField, index: number, value: string | null | undefined): void => {
    if (value === null || value === undefined || value.length === 0) return;
    const truncated = value.length > MAX_FIELD_CHARS;
    out.push({ field, index, raw: truncated ? value.slice(0, MAX_FIELD_CHARS) : value, truncated });
  };
  add('subject', 0, input.subject);
  add('text', 0, input.text);
  if (input.htmlText !== input.text) add('html', 0, input.htmlText);
  const names = input.attachmentNames ?? [];
  names.slice(0, MAX_ATTACHMENT_NAMES).forEach((name, i) => add('attachment_name', i, name));
  return out;
}

const LETTER = /\p{L}/u;
/** 엄격 UTF-8 — 비스트리밍 `decode` 는 부를 때마다 상태를 새로 시작하므로 하나를 다시 쓴다. */
const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true });

function isApostrophe(text: string, i: number): boolean {
  const ch = text[i];
  if (ch !== "'" && ch !== '’') return false;
  return LETTER.test(text[i - 1] ?? '') && LETTER.test(text[i + 1] ?? '');
}

/** 적중이 같은 줄의 인용부호 안에 있는가(앞 80자·뒤 160자). */
function isQuoted(text: string, start: number, end: number): boolean {
  let before = false;
  for (let j = start - 1; j >= Math.max(0, start - 80); j -= 1) {
    const ch = text[j] ?? '';
    if (ch === '\n') break;
    if (QUOTE_CHARS.has(ch) && !isApostrophe(text, j)) {
      before = true;
      break;
    }
  }
  if (!before) return false;
  for (let j = end; j < Math.min(text.length, end + 160); j += 1) {
    const ch = text[j] ?? '';
    if (ch === '\n') break;
    if (QUOTE_CHARS.has(ch) && !isApostrophe(text, j)) return true;
  }
  return false;
}

/**
 * 역할 토큰이 줄 **가운데** 있다 — 문장 속 언급("Llama 2 used [INST] markers")이지 대화 경계가 아니다.
 * 구분자 위조가 모델에게 턴 경계로 읽히려면 줄머리에 와야 한다. 메타 논의 문서에서만 쓴다.
 */
function startsLine(text: string, position: number): boolean {
  for (let j = position - 1; j >= 0; j -= 1) {
    const ch = text[j];
    if (ch === '\n') return true;
    if (ch !== ' ') return false;
  }
  return true;
}

function fencePositions(text: string): number[] {
  return allMatches(/```/g, text).map((s) => s.start);
}

function insideFence(fences: readonly number[], position: number): boolean {
  let count = 0;
  for (const f of fences) {
    if (f >= position) break;
    count += 1;
  }
  return count % 2 === 1;
}

/** 의미 룰 하나를 텍스트 하나에 건다. 결과 좌표는 그 텍스트 좌표. */
function runSemantic(rule: SemanticRule, text: string, lexicon: Lexicon): Span[] {
  if (rule.kind === 'pattern') return allMatches(rule.pattern, text, MAX_HITS_PER_RULE);
  return rule.find(text, lexicon).slice(0, MAX_HITS_PER_RULE);
}

/** 적중 구간에 `mask` 표시 글자가 있는가. 다국어 룰(`nativeFold`)은 강한 표시만 본다(`normalize.ts` `heavy`). */
function spanIsHeavy(view: FoldedView, span: Span, mask: number): boolean {
  for (let i = span.start; i < span.end; i += 1) if (((view.heavy[i] ?? 0) & mask) !== 0) return true;
  return false;
}

function toRaw(view: FoldedView, span: Span): Span {
  const last = Math.max(span.start, span.end - 1);
  return { start: view.srcStart[span.start] ?? 0, end: view.srcEnd[last] ?? 0 };
}

/** 풀어낸 바이트가 사람이 읽는 글인가 — UTF-8 이고, 제어문자가 거의 없고, 글자가 절반 이상. */
function plausibleText(bytes: Uint8Array): string | null {
  let decoded: string;
  try {
    decoded = UTF8_STRICT.decode(bytes);
  } catch {
    return null;
  }
  if (decoded.length < 12) return null;
  let bad = 0;
  let letters = 0;
  for (const ch of decoded) {
    const c = ch.codePointAt(0) ?? 0;
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0xfffd || (c >= 0x7f && c <= 0x9f)) bad += 1;
    else if (LETTER.test(ch)) letters += 1;
  }
  return bad / decoded.length <= 0.02 && letters / decoded.length >= 0.5 ? decoded : null;
}

function decodeBase64Text(candidate: string): string | null {
  for (let offset = 0; offset < 4; offset += 1) {
    const body = candidate.slice(offset);
    if (body.length < 16) return null;
    const decoded = plausibleText(Buffer.from(body, 'base64'));
    if (decoded !== null) return decoded;
  }
  return null;
}

function decodeHexText(candidate: string): string | null {
  const digits = candidate.replace(/\\x|%|0x|[ ,:-]/g, '');
  if (digits.length % 2 !== 0) return null;
  return plausibleText(Buffer.from(digits, 'hex'));
}

/**
 * base64 후보 묶음 — 줄바꿈 하나로만 나뉜 이웃 후보는 한 묶음이다(`BASE64_LINE_JOIN`). 묶음은 이어서 먼저 풀고,
 * 이은 것이 글이 아니면 줄마다 따로 푼다(서로 무관한 덩어리가 우연히 붙어 있을 수 있다).
 */
function base64Groups(raw: string): Span[][] {
  const groups: Span[][] = [];
  for (const span of allMatches(BASE64_CANDIDATE, raw, MAX_BASE64_CANDIDATES_PER_FIELD)) {
    const group = groups[groups.length - 1];
    const first = group?.[0];
    const last = group?.[group.length - 1];
    if (
      group !== undefined &&
      first !== undefined &&
      last !== undefined &&
      span.end - first.start <= MAX_BASE64_JOINED_CHARS &&
      BASE64_LINE_JOIN.test(raw.slice(last.end, span.start))
    ) {
      group.push(span);
    } else {
      groups.push([span]);
    }
  }
  return groups;
}

/** 묶음 하나를 푼 글들 — 이은 것이 글이면 그것 하나, 아니면 줄마다. */
function decodeBase64Group(raw: string, group: readonly Span[]): { readonly span: Span; readonly text: string }[] {
  const first = group[0];
  const last = group[group.length - 1];
  if (first === undefined || last === undefined) return [];
  if (group.length > 1) {
    const joined = decodeBase64Text(raw.slice(first.start, last.end).replace(/[\s>]/g, ''));
    if (joined !== null) return [{ span: { start: first.start, end: last.end }, text: joined }];
  }
  const out: { span: Span; text: string }[] = [];
  for (const span of group) {
    const decoded = decodeBase64Text(raw.slice(span.start, span.end));
    if (decoded !== null) out.push({ span, text: decoded });
  }
  return out;
}

/** 글자 치환 보기의 방아쇠 — 서로 다른 기능어 `TRANSFORM_MIN_DISTINCT` 개 이상, 합쳐 `TRANSFORM_MIN_HITS` 번 이상. */
function transformTriggered(pattern: RegExp, text: string): boolean {
  const seen = new Set<string>();
  let hits = 0;
  pattern.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    hits += 1;
    seen.add(m[0]);
    if (hits >= TRANSFORM_MIN_HITS && seen.size >= TRANSFORM_MIN_DISTINCT) return true;
  }
  return false;
}

function decodeEntitiesOnce(text: string): string {
  return text.replace(ENTITY_PATTERN, (match: string, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (name !== undefined) return NAMED_ENTITIES[name.toLowerCase()] ?? match;
    const cp = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex ?? '', 16);
    if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return match;
    return String.fromCodePoint(cp);
  });
}

/** `%XX` 연속을 UTF-8 로 푼다. 잘못된 UTF-8 은 그 연속을 그대로 둔다(이진 토큰). */
function decodePercentRuns(text: string): string {
  return text.replace(PERCENT_RUN, (run: string) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

/** 엔티티(두 겹까지)와 `%XX` 를 푼 글. 바뀐 것이 없으면 `null`. 선형 — 정규식 둘 다 상한 있는 꼴이다. */
export function decodeEntityView(raw: string): string | null {
  if (!ENTITY_TRIGGER.test(raw)) return null;
  const decoded = decodePercentRuns(decodeEntitiesOnce(decodeEntitiesOnce(raw)));
  return decoded === raw ? null : decoded;
}

function rot13(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    out += c >= 0x61 && c <= 0x7a ? String.fromCharCode(((c - 0x61 + 13) % 26) + 0x61) : (text[i] ?? '');
  }
  return out;
}

/** 적중 정렬 순서 — 필드 → 순서 → 좌표 → 룰 id. */
const FIELD_ORDER: Readonly<Record<ScanField, number>> = { subject: 0, text: 1, html: 2, attachment_name: 3 };

const PARSER_FIELD: Readonly<Record<ParserC1Removal['field'], ScanField>> = {
  subject: 'subject',
  text: 'text',
  htmlText: 'html',
  attachmentName: 'attachment_name',
};

/**
 * 한 통을 판정한다. 던지지 않는다 — 입력 때문에 수신 파이프라인이 죽으면 poison pill 이다.
 */
export function scanForInjection(input: InjectionScanInput, ablation: ScanAblation = {}): InjectionScanResult {
  const disabledRules = ablation.disabledRules ?? new Set<string>();
  const disabledStages = ablation.disabledStages ?? new Set();
  const foldStages = new Set<FoldStage>([...disabledStages].filter((s): s is FoldStage => !SCAN_STAGES.has(s)));

  const fields = collectFields(input);
  const folded = fields.map((f) => fold(f.raw, foldStages));
  const metaDiscussion = !disabledStages.has('damping') && folded.some((v) => META_DISCUSSION.test(v.text));

  const findings: SecurityFinding[] = [];
  const push = (
    f: FieldInput,
    ruleId: string,
    family: RuleFamily,
    view: ScanView,
    span: Span,
    weight: number,
    damped: boolean,
  ): void => {
    findings.push({ ruleId, family, field: f.field, fieldIndex: f.index, view, start: span.start, end: span.end, weight, damped });
  };

  fields.forEach((f, fi) => {
    const view = folded[fi];
    if (view === undefined) return;

    if (f.truncated || view.truncated) {
      const at = f.truncated ? MAX_FIELD_CHARS : (view.srcEnd[view.srcEnd.length - 1] ?? 0);
      push(f, 'scan_limit.truncated', 'scan_limit', 'raw', { start: at, end: at }, TRUNCATION_WEIGHT, false);
    }

    for (const rule of TECHNIQUE_RULES) {
      if (disabledRules.has(rule.id)) continue;
      for (const span of rule.find(f.raw).slice(0, MAX_HITS_PER_RULE)) push(f, rule.id, rule.family, 'raw', span, rule.weight, false);
    }

    // ── 접은 보기 ──
    const text = view.text;
    const lexicon = new Lexicon(text);
    const fences = fencePositions(text);
    const foldedHitRules = new Set<string>();
    for (const rule of SEMANTIC_RULES) {
      if (disabledRules.has(rule.id)) continue;
      for (const span of runSemantic(rule, text, lexicon)) {
        foldedHitRules.add(rule.id);
        const damped =
          rule.dampable &&
          metaDiscussion &&
          (isQuoted(text, span.start, span.end) ||
            insideFence(fences, span.start) ||
            EXAMPLE_LEAD.test(text.slice(Math.max(0, span.start - 60), span.start)) ||
            (rule.family === 'role_spoof' && !startsLine(text, span.start)));
        const raw = toRaw(view, span);
        push(f, rule.id, rule.family, 'folded', raw, damped ? 1 : rule.weight, damped);
        if (spanIsHeavy(view, span, rule.nativeFold === true ? HEAVY_STRONG : HEAVY) && !disabledRules.has('obfuscation.normalization_revealed')) {
          push(f, 'obfuscation.normalization_revealed', 'obfuscation', 'folded', raw, OBFUSCATION_WEIGHT, false);
        }
      }
    }

    // ── 압축 보기 — 접은 보기에서 같은 룰이 적중하지 않았을 때만 ──
    if (!disabledStages.has('compact')) {
      const comp = compact(view);
      for (const rule of COMPACT_RULES) {
        if (disabledRules.has(rule.id) || foldedHitRules.has(rule.id)) continue;
        for (const span of allMatches(rule.pattern, comp.text, MAX_HITS_PER_RULE)) {
          const foldedSpan = {
            start: comp.foldedIndex[span.start] ?? 0,
            end: (comp.foldedIndex[Math.max(span.start, span.end - 1)] ?? 0) + 1,
          };
          const raw = toRaw(view, foldedSpan);
          push(f, rule.id, rule.family, 'compact', raw, rule.weight, false);
          if (!disabledRules.has('obfuscation.spacing_revealed')) {
            push(f, 'obfuscation.spacing_revealed', 'obfuscation', 'compact', raw, OBFUSCATION_WEIGHT, false);
          }
        }
      }
    }

    /** 풀어낸 글 하나에 의미 룰을 건다(`skip` 의 룰은 빼고). 적중 좌표는 원문 후보 덩어리 전체. 하나라도 적중하면 true. */
    const scanDecoded = (decoded: string, candidate: Span, view: ScanView, skip?: ReadonlySet<string>): boolean => {
      const decodedText = fold(decoded, foldStages).text;
      const decodedLexicon = new Lexicon(decodedText);
      let hit = false;
      for (const rule of SEMANTIC_RULES) {
        if (disabledRules.has(rule.id) || skip?.has(rule.id) === true) continue;
        if (runSemantic(rule, decodedText, decodedLexicon).length === 0) continue;
        hit = true;
        push(f, rule.id, rule.family, view, candidate, rule.weight, false);
      }
      return hit;
    };

    // ── base64 후보를 풀어 접은 보기 — 줄바꿈으로 나뉜 덩어리는 잇고, 풀린 글 안의 base64 는 한 겹 더 ──
    if (!disabledStages.has('base64')) {
      let decodedBudget = MAX_BASE64_DECODED_CHARS_PER_FIELD;
      for (const group of base64Groups(f.raw)) {
        if (decodedBudget <= 0) break;
        for (const { span: candidate, text: decoded } of decodeBase64Group(f.raw, group)) {
          let layer: string[] = [decoded];
          let hit = false;
          for (let depth = 1; depth <= BASE64_MAX_DEPTH && layer.length > 0 && decodedBudget > 0; depth += 1) {
            const next: string[] = [];
            for (const text of layer) {
              decodedBudget -= text.length;
              if (scanDecoded(text, candidate, 'base64')) hit = true;
              if (depth === BASE64_MAX_DEPTH) continue;
              for (const inner of allMatches(BASE64_CANDIDATE, text, MAX_BASE64_CANDIDATES_PER_FIELD)) {
                const innerText = decodeBase64Text(text.slice(inner.start, inner.end));
                if (innerText !== null) next.push(innerText);
              }
            }
            layer = next;
          }
          if (hit && !disabledRules.has('encoded.base64_payload')) {
            push(f, 'encoded.base64_payload', 'encoded', 'base64', candidate, ENCODED_WEIGHT, false);
          }
        }
      }
    }

    // ── 16진수 후보를 풀어 접은 보기 ──
    if (!disabledStages.has('hex')) {
      for (const candidate of allMatches(HEX_CANDIDATE, f.raw, MAX_HEX_CANDIDATES_PER_FIELD)) {
        const decoded = decodeHexText(f.raw.slice(candidate.start, candidate.end));
        if (decoded === null) continue;
        if (scanDecoded(decoded, candidate, 'hex') && !disabledRules.has('encoded.hex_payload')) {
          push(f, 'encoded.hex_payload', 'encoded', 'hex', candidate, ENCODED_WEIGHT, false);
        }
      }
    }

    // ── 글 속에 남은 HTML 엔티티·`%XX` 를 푼 보기 — **접은 보기에서 걸리지 않던 룰만** 센다(같은 증거를 두 번 세지 않는다).
    //    새 룰이 걸리면 감춘 것이다 → `encoded.entity_payload`(base64 와 같은 가산). 좌표는 필드 전체. ──
    if (!disabledStages.has('entity')) {
      const decoded = decodeEntityView(f.raw);
      const whole = { start: 0, end: f.raw.length };
      if (decoded !== null && scanDecoded(decoded, whole, 'entity', foldedHitRules) && !disabledRules.has('encoded.entity_payload')) {
        push(f, 'encoded.entity_payload', 'encoded', 'entity', whole, ENCODED_WEIGHT, false);
      }
    }

    // ── 글자 치환(ROT13·거꾸로 쓰기)을 되돌린 보기 — 기능어 통계가 방아쇠 ──
    if (!disabledStages.has('transform')) {
      const transforms: { readonly transformed: string; readonly back: (span: Span) => Span }[] = [];
      if (transformTriggered(ROT13_FUNCTION_WORDS, text)) transforms.push({ transformed: rot13(text), back: (span) => span });
      if (transformTriggered(REVERSED_FUNCTION_WORDS, text)) {
        transforms.push({
          transformed: [...text].reverse().join(''),
          back: (span) => ({ start: text.length - span.end, end: text.length - span.start }),
        });
      }
      for (const { transformed, back } of transforms) {
        const transformedLexicon = new Lexicon(transformed);
        let hit = false;
        let first: Span | null = null;
        for (const rule of SEMANTIC_RULES) {
          if (disabledRules.has(rule.id)) continue;
          for (const span of runSemantic(rule, transformed, transformedLexicon)) {
            const raw = toRaw(view, back(span));
            first ??= raw;
            hit = true;
            push(f, rule.id, rule.family, 'transform', raw, rule.weight, false);
          }
        }
        if (hit && first !== null && !disabledRules.has('encoded.letter_transform')) {
          push(f, 'encoded.letter_transform', 'encoded', 'transform', first, ENCODED_WEIGHT, false);
        }
      }
    }
  });

  // ── 파서가 지운 C1 의 흔적(좌표 없음) ──
  for (const removal of input.c1Removed ?? []) {
    if (removal.count <= 0) continue;
    const at = { ruleId: '', family: 'technique' as const, field: PARSER_FIELD[removal.field], fieldIndex: removal.index, view: 'parser' as const, start: 0, end: 0, damped: false };
    // 가중치는 원문에 거는 같은 id 의 기법 룰과 같다 — 같은 현상을 파서가 대신 본 것이다.
    const weightOf = (id: string): number => TECHNIQUE_RULES.find((r) => r.id === id)?.weight ?? 0;
    if (!disabledRules.has('technique.c1_control')) findings.push({ ...at, ruleId: 'technique.c1_control', weight: weightOf('technique.c1_control') });
    if (removal.longestAlternation >= C1_ALTERNATION_MIN && !disabledRules.has('technique.c1_interleaved_ascii')) {
      findings.push({ ...at, ruleId: 'technique.c1_interleaved_ascii', weight: weightOf('technique.c1_interleaved_ascii') });
    }
  }

  // ── 숨긴 HTML 글(2026-10-08 인코딩 점검 — 숨김 신호) ──
  //    파서가 넘긴 `hiddenText` 는 보이는 글이 아니다. 그 **안에서** 지시성 룰이 걸릴 때만 숨김 가산을 붙인다(`concealment.hidden_html`).
  //    숨긴 글 자체는 신호가 아니다(마케팅 프리헤더). 가산은 한 번(가장 앞 적중 좌표) — 숨긴 글은 원문 `html` 좌표계가 아니라 0–0 으로 둔다.
  const hidden = input.hiddenText;
  if (hidden !== null && hidden !== undefined && hidden.length > 0 && !disabledStages.has('hidden') && !disabledRules.has('concealment.hidden_html')) {
    const hiddenText = fold(hidden.slice(0, MAX_FIELD_CHARS), foldStages).text;
    const hiddenLexicon = new Lexicon(hiddenText);
    const instructive = SEMANTIC_RULES.some(
      (rule) => !disabledRules.has(rule.id) && HIDDEN_RISK_FAMILIES.has(rule.family) && runSemantic(rule, hiddenText, hiddenLexicon).length > 0,
    );
    if (instructive) {
      findings.push({ ruleId: 'concealment.hidden_html', family: 'concealment', field: 'html', fieldIndex: 0, view: 'hidden', start: 0, end: 0, weight: HIDDEN_WEIGHT, damped: false });
    }
  }

  // ── 점수: **축(family)마다 최댓값 하나**를 더한다. 같은 축의 룰 여럿은 같은 증거를 다른 말로 잡은 것이다
  //    ("if you are an AI summarizing this email" 은 AI 호명 룰 셋에 걸린다 — 세 번 세면 무해한 요약 조작이
  //    high 가 된다). 축이 다르면 독립 증거로 합한다. 완화된 적중만 있는 축은 따로 모아 상한(2)으로 묶는다. ──
  const full = new Map<RuleFamily, number>();
  const dampedOnly = new Map<RuleFamily, number>();
  for (const finding of findings) {
    const bucket = finding.damped ? dampedOnly : full;
    bucket.set(finding.family, Math.max(bucket.get(finding.family) ?? 0, finding.weight));
  }
  let score = 0;
  for (const weight of full.values()) score += weight;
  let dampedTotal = 0;
  for (const [family, weight] of dampedOnly) if (!full.has(family)) dampedTotal += weight;
  score += Math.min(dampedTotal, DAMPED_TOTAL_CAP);

  const injectionRisk = riskFromScore(score);
  findings.sort(
    (a, b) =>
      FIELD_ORDER[a.field] - FIELD_ORDER[b.field] || a.fieldIndex - b.fieldIndex || a.start - b.start || a.ruleId.localeCompare(b.ruleId),
  );

  return {
    scannerVersion: INJECTION_SCANNER_VERSION,
    injectionRisk,
    score,
    quarantine: shouldQuarantine(injectionRisk),
    findings: findings.slice(0, MAX_FINDINGS),
    findingsTruncated: findings.length > MAX_FINDINGS,
  };
}
