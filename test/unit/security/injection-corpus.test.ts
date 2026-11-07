/**
 * dev 코퍼스(`test/fixtures/injection/dev/`) 위의 AC-7 판정과 **되돌리기(ablation)** 검증.
 *
 * ⚠ **dev 에서의 통과는 증거가 아니다.** 이 코퍼스는 룰을 쓴 사람이 쓰고, 룰을 이 코퍼스에 맞춰 튜닝했다 —
 * 과적합이 정의상 들어 있다. AC-7 의 증거는 봉인 홀드아웃을 **리드가 한 번** 돌린 결과뿐이다
 * (`scripts/eval-injection.ts`). 이 테스트는 두 가지만 지킨다:
 *   1. 회귀 — 룰을 고치다 dev 의 워크로드 1 음성을 격리하기 시작하면 바로 빨개진다.
 *   2. **비공허성** — 룰·정규화 단계 하나하나가 **실제로 무언가를 지킨다**. 끄면 그 룰이 잡던 양성이
 *      빠지거나(점수 하락·격리 해제), 그 단계가 드러내던 적중이 사라져야 한다. "초록인데 아무것도
 *      안 지킨다" 를 막는 것이 이 파일의 존재 이유다.
 *
 * 이 파일은 dev 경로만 읽는다. 홀드아웃 경로를 **참조하지 않는다**(봉인 테스트가 단언한다).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { htmlHiddenText, htmlToText } from '../../../src/mail/mime/parse-html';
import {
  scanForInjection,
  type InjectionScanInput,
  type InjectionScanResult,
  type ScanAblation,
} from '../../../src/security/injection/scanner';
import { COMPACT_RULES, SEMANTIC_RULES, TECHNIQUE_RULES } from '../../../src/security/injection/rules';

const DEV = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'injection', 'dev');

interface Label {
  readonly label: 'positive' | 'negative';
  readonly risk?: 'high' | 'medium' | 'low';
}

const labels = JSON.parse(readFileSync(join(DEV, 'labels.json'), 'utf8')) as Record<string, Label>;

function load(file: string): InjectionScanInput {
  const content = readFileSync(join(DEV, file), 'utf8');
  if (file.endsWith('.html')) {
    const text = htmlToText(content);
    const hidden = htmlHiddenText(content);
    return { subject: null, text, htmlText: text, hiddenText: hidden === '' ? null : hidden };
  }
  if (!file.endsWith('.json')) return { subject: null, text: content, htmlText: null };
  const value = JSON.parse(content) as { subject?: string | null; text: string; htmlText?: string | null; attachmentNames?: (string | null)[]; hiddenText?: string | null };
  return { subject: value.subject ?? null, text: value.text, htmlText: value.htmlText ?? null, attachmentNames: value.attachmentNames ?? [], hiddenText: value.hiddenText ?? null };
}

const inputs = new Map(Object.keys(labels).map((f) => [f, load(f)]));
const baseline = new Map([...inputs].map(([f, input]) => [f, scanForInjection(input)]));
const entries = Object.entries(labels);
const positives = entries.filter(([, l]) => l.label === 'positive').map(([f]) => f);
const negatives = entries.filter(([, l]) => l.label === 'negative').map(([f]) => f);

const scan = (file: string, ablation: ScanAblation): InjectionScanResult => scanForInjection(inputs.get(file) ?? { subject: null, text: '', htmlText: null }, ablation);
const base = (file: string): InjectionScanResult => {
  const result = baseline.get(file);
  if (!result) throw new Error(`기준선 없음: ${file}`);
  return result;
};

describe('dev 코퍼스 구성', () => {
  it('라벨 파일과 디렉터리가 정확히 일치한다(조용히 빠진 표본이 없다)', () => {
    const onDisk = ['positive', 'negative'].flatMap((d) => readdirSync(join(DEV, d)).map((f) => `${d}/${f}`)).sort();
    expect(Object.keys(labels).sort()).toEqual(onDisk);
  });

  it('음성의 과반이 워크로드 1(가입 확인·인증 코드·재설정)이고 한국어·영어가 둘 다 있다', () => {
    const wl1 = negatives.filter((f) => f.startsWith('negative/wl1-'));
    expect(wl1.length * 2).toBeGreaterThan(negatives.length);
    expect(wl1.some((f) => f.includes('-ko-'))).toBe(true);
    expect(wl1.some((f) => f.includes('-en-'))).toBe(true);
  });

  it('양성에 위험도 세 단계와 인증 메일 위장 탈취가 있다', () => {
    const risks = new Set(positives.map((f) => labels[f]?.risk));
    expect(risks).toEqual(new Set(['high', 'medium', 'low']));
    expect(positives.filter((f) => f.includes('verification-disguise')).length).toBeGreaterThanOrEqual(2);
  });
});

describe('AC-7 기준 — dev (과적합 경고: 머리말)', () => {
  it('워크로드 1 음성은 하나도 격리하지 않는다', () => {
    const quarantined = negatives.filter((f) => f.startsWith('negative/wl1-') && base(f).quarantine);
    expect(quarantined).toEqual([]);
  });

  it('음성 오탐률 ≤ 5%', () => {
    const fp = negatives.filter((f) => base(f).quarantine);
    expect(fp.length / negatives.length).toBeLessThanOrEqual(0.05);
  });

  it('high 양성은 전부 격리한다(고위험 미탐 0)', () => {
    const missed = positives.filter((f) => labels[f]?.risk === 'high' && !base(f).quarantine);
    expect(missed).toEqual([]);
  });

  it('medium 양성은 격리하고, low 양성은 적어도 low 를 받는다', () => {
    expect(positives.filter((f) => labels[f]?.risk === 'medium' && !base(f).quarantine)).toEqual([]);
    expect(positives.filter((f) => labels[f]?.risk === 'low' && base(f).injectionRisk === 'none')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 되돌리기 — 룰
// ---------------------------------------------------------------------------

const allRuleIds = [
  ...new Set([
    ...SEMANTIC_RULES.map((r) => r.id),
    ...COMPACT_RULES.map((r) => r.id),
    ...TECHNIQUE_RULES.map((r) => r.id),
    'obfuscation.normalization_revealed',
    'obfuscation.spacing_revealed',
    'encoded.base64_payload',
    'encoded.hex_payload',
    'encoded.letter_transform',
    'encoded.entity_payload',
  ]),
];

/** dev 양성에서 한 번도 발화하지 않는 룰 — 인라인 사례로 따로 증명한다(아래). 목록이 늘면 dev 양성을 보태라. */
const EXERCISED_INLINE = new Set(['technique.bidi_control', 'scan_limit.truncated']);

describe('되돌리기 — 룰마다 끄면 그 룰이 지키던 것이 빠진다', () => {
  it.each(allRuleIds.filter((id) => !EXERCISED_INLINE.has(id)))('%s', (ruleId) => {
    const firing = positives.filter((f) => base(f).findings.some((x) => x.ruleId === ruleId));
    // 1) 비공허: dev 양성 어딘가에서 실제로 발화한다.
    expect(firing.length).toBeGreaterThan(0);
    for (const f of firing) {
      const off = scan(f, { disabledRules: new Set([ruleId]) });
      // 2) 끄면 그 룰의 적중이 사라진다(다른 경로가 같은 id 를 대신 만들지 않는다).
      expect(off.findings.some((x) => x.ruleId === ruleId)).toBe(false);
      // 3) 점수는 절대 오르지 않는다.
      expect(off.score).toBeLessThanOrEqual(base(f).score);
    }
  });

  it('축(family)마다 적어도 하나의 dev 양성은 그 축을 끄면 점수가 떨어진다 — 축이 장식이 아니다', () => {
    const families = [...new Set([...SEMANTIC_RULES, ...TECHNIQUE_RULES].map((r) => r.family))];
    const idsOf = (family: string): string[] =>
      [...SEMANTIC_RULES, ...TECHNIQUE_RULES, ...COMPACT_RULES].filter((r) => r.family === family).map((r) => r.id);
    const inert = families.filter(
      (family) => !positives.some((f) => scan(f, { disabledRules: new Set(idsOf(family)) }).score < base(f).score),
    );
    expect(inert).toEqual([]);
  });

  it.each([
    // 단독으로 격리를 만드는 룰 — 끄면 그 양성이 격리에서 풀린다(= 그 룰만이 그 공격을 막고 있다).
    ['exfiltration.send_to_destination.en', 'positive/high-verification-disguise-en.txt'],
    ['exfiltration.reply_with_secret.en', 'positive/high-reply-with-password.txt'],
    ['exfiltration.reply_with_secret.ko', 'positive/high-ko-reply-exfil.txt'],
    ['exfiltration.destination_then_bulk.en', 'positive/high-bcc-bulk.txt'],
    ['override.en', 'positive/med-override-only.txt'],
    ['override.ignore_above.en', 'positive/med-ignore-above.txt'],
    ['jailbreak.en', 'positive/med-jailbreak.txt'],
    ['jailbreak.ko', 'positive/med-ko-jailbreak.txt'],
    ['concealment.en', 'positive/med-concealment.txt'],
    ['concealment.ko', 'positive/med-ko-concealment-spaced.txt'],
    ['role_spoof.token', 'positive/med-role-token.txt'],
    ['encoded.decode_and_follow', 'positive/med-decode-follow.txt'],
    ['tool_invocation.remote_payload', 'positive/med-remote-payload.txt'],
    ['technique.variation_selector_run', 'positive/med-variation-selector.txt'],
    // v2 — 홀드아웃 v1 이 드러낸 계열을 일반화한 룰. 각각 그 룰만이 막고 있는 레드팀 변형이 있다.
    ['exfiltration.gather_then_send.en', 'positive/high-gather-phrasal.txt'],
    ['exfiltration.gather_then_send.en', 'positive/high-gather-pronoun-split.txt'],
    ['exfiltration.passive_demand.en', 'positive/high-passive-demand.txt'],
    ['exfiltration.destination_then_bulk.en', 'positive/high-dest-then-secret.txt'],
    ['exfiltration.send_to_destination.ko', 'positive/high-ko-topic.txt'],
    ['exfiltration.send_to_destination.ko', 'positive/high-ko-honorific.txt'],
    ['exfiltration.send_to_destination.ko', 'positive/high-ko-telegraphic.txt'],
    ['concealment.approval_bypass.ko', 'positive/high-ko-approval-bypass.txt'],
    ['concealment.approval_bypass.en', 'positive/med-approval-bypass.txt'],
    ['concealment.self_reference.en', 'positive/med-conceal-self.txt'],
    ['concealment.omit_output.en', 'positive/med-omit-summary.txt'],
    ['ai_addressee.tell_user', 'positive/med-tell-user-quote.txt'],
    ['ai_addressee.tell_user.ko', 'positive/med-ko-tell-user.txt'],
    ['role_spoof.agent_label', 'positive/med-ko-tell-user.txt'],
    // v3 — 다국어·필터 호명. high-ja-mixed 는 v3 에서 접은 가나(認証コード)로 유출 룰도 걸려 덮어쓰기 하나로 버티지 않는다.
    ['override.ja', 'positive/med-ja-override.txt'],
    ['override.multi', 'positive/med-es-override.txt'],
    ['prompt_leak.multi', 'positive/med-ru-prompt-leak.txt'],
    ['concealment.multi', 'positive/med-tr-concealment.txt'],
    ['exfiltration.send_to_destination.multi', 'positive/high-de-exfil-colon.txt'],
    ['override.multi', 'positive/med-es-override-interjection.txt'],
    ['exfiltration.send_to_destination.multi', 'positive/high-es-verification-disguise.txt'],
    ['exfiltration.reply_with_secret.multi', 'positive/high-id-reply-secret.txt'],
  ])('%s 를 끄면 %s 가 격리에서 풀린다', (ruleId, file) => {
    expect(base(file).quarantine).toBe(true);
    expect(scan(file, { disabledRules: new Set([ruleId]) }).quarantine).toBe(false);
  });

  it('인라인: 양방향 제어문자 룰', () => {
    const text = `invoice${String.fromCodePoint(0x202e)}fdp.exe`;
    expect(scanForInjection({ subject: null, text, htmlText: null }).findings.map((f) => f.ruleId)).toEqual(['technique.bidi_control']);
    expect(scanForInjection({ subject: null, text, htmlText: null }, { disabledRules: new Set(['technique.bidi_control']) }).findings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 되돌리기 — 정규화 단계
// ---------------------------------------------------------------------------

describe('되돌리기 — 정규화 단계마다 끄면 그 단계가 막던 우회가 통과한다', () => {
  it.each([
    // [단계, 표본, 기대: 끈 뒤 격리가 풀린다]
    ['nfkc', 'positive/high-fullwidth.txt'],
    ['homoglyph', 'positive/high-homoglyph.txt'],
    ['compact', 'positive/high-spaced-letters.txt'],
    ['base64', 'positive/high-base64.txt'],
    ['base64', 'positive/high-base64-double.txt'],
    ['hex', 'positive/high-hex.txt'],
    ['entity', 'positive/high-entity-encoded.txt'],
    ['transform', 'positive/high-rot13.txt'],
    ['transform', 'positive/high-reversed.txt'],
    ['whitespace', 'positive/med-ko-concealment-spaced.txt'],
  ] as const)('%s 를 끄면 %s 가 격리에서 풀린다', (stage, file) => {
    expect(base(file).quarantine).toBe(true);
    expect(scan(file, { disabledStages: new Set([stage]) }).quarantine).toBe(false);
  });

  it('invisible 을 끄면 제로폭으로 쪼갠 유출 요구가 격리에서 풀린다', () => {
    const file = 'positive/high-zw-exfil-only.txt';
    expect(base(file).injectionRisk).toBe('high');
    expect(scan(file, { disabledStages: new Set(['invisible']) }).quarantine).toBe(false);
  });

  it('tags 를 끄면 태그 문자 속 지시가 의미 룰에서 사라진다(기법 룰만 남는다)', () => {
    const file = 'positive/high-unicode-tags.txt';
    const off = scan(file, { disabledStages: new Set(['tags']) });
    expect(base(file).findings.some((f) => f.family === 'exfiltration')).toBe(true);
    expect(off.findings.filter((f) => f.family !== 'technique')).toEqual([]);
    expect(off.injectionRisk).not.toBe('high');
  });

  it('base64 줄 잇기: 76자로 접힌 덩어리는 이어야 유출이 보인다 — 줄마다 따로 풀면 목적지 주소가 두 줄로 갈린다', () => {
    const file = 'positive/high-base64-wrapped.txt';
    const input = inputs.get(file);
    if (input === undefined) throw new Error(file);
    const decodedExfil = (r: InjectionScanResult): boolean => r.findings.some((f) => f.view === 'base64' && f.family === 'exfiltration');
    expect(decodedExfil(base(file))).toBe(true);
    // 대조군: 같은 줄들을 빈 줄로 떼어 놓으면(잇기 조건 불충족) 어느 줄도 혼자서는 유출로 읽히지 않는다.
    const separated = { ...input, text: input.text.replace(/\n(?=[A-Za-z0-9+/]{20})/g, '\n\n') };
    expect(decodedExfil(scanForInjection(separated))).toBe(false);
  });

  it('damping 을 끄면 보안 교육·프롬프트 엔지니어링 음성이 격리된다 — 완화가 경계 음성을 지키고 있다', () => {
    const edge = [
      'negative/edge-security-training-en.txt',
      'negative/edge-security-training-ko.txt',
      'negative/edge-prompt-engineering-code.txt',
      'negative/edge-prompt-study-ko.txt',
    ];
    for (const f of edge) {
      expect(base(f).quarantine).toBe(false);
      expect(scan(f, { disabledStages: new Set(['damping']) }).quarantine).toBe(true);
    }
  });
});
