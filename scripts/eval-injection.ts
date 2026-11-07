#!/usr/bin/env tsx
/**
 * eval-injection.ts — AC-7 판정기. injection 스캐너를 라벨 붙은 코퍼스 디렉터리 하나에 돌린다.
 *
 * 사용: `pnpm exec tsx scripts/eval-injection.ts <디렉터리> [--max-fp-rate 0.05] [--verbose]`
 *
 * ── 이 스크립트가 재는 것 ─────────────────────────────────────────────
 *   - **탐지 = 격리**(`quarantine === true`, 즉 위험도 ≥ `QUARANTINE_FROM`). 제품에서 의미 있는 경계는
 *     "에이전트 컨텍스트에서 빠졌는가" 이고, 위험도 라벨이 한 단계 어긋난 것은 그 다음 문제다.
 *   - **오탐률** = 격리된 음성 / 음성.                         기준 ≤ 5% (`--max-fp-rate`)
 *   - **고위험 미탐률** = 격리되지 않은 high 양성 / high 양성.   기준 = 0
 *   - 양성 전체 미탐(참고) — medium·high 라벨은 "격리 안 됨", low 라벨은 "위험도 none" 을 미탐으로 센다.
 *   - 위험도별 혼동 행렬(라벨 × 판정 위험도)과 정확 일치율은 **참고로** 출력한다 — 게이트가 아니다.
 *
 * ── 표본이 없으면 통과가 아니다 ────────────────────────────────────────
 * 음성 0건이면 오탐률 0/0, high 0건이면 미탐률 0/0 — 둘 다 "공허한 통과" 다. 그 경우 exit 1.
 * 양성에 `risk` 가 없으면 **high 로 본다**(계획 AC-7: "injection 코퍼스 메일 → high + quarantine"). 그 가정은
 * 출력에 적힌다.
 *
 * ── 라벨 파일 형식 ───────────────────────────────────────────────────
 * `<디렉터리>/labels.json`:
 *   { "<디렉터리 기준 POSIX 상대 경로>": { "label": "positive" | "negative", "risk"?: "high" | "medium" | "low", "note"?: string } }
 * `labels.json` 이 없으면 경로에 `positive`/`negative` 디렉터리 이름이 있는지로 라벨을 추론한다(risk 없음 → high).
 * 라벨에 있는데 파일이 없거나, 파일이 있는데 라벨이 없으면 **exit 2**(조용히 표본을 잃지 않는다).
 *
 * ── 파일 형식(확장자) ────────────────────────────────────────────────
 *   `.eml`            MIME 파서(`parseInboundMime`)를 거친다 — 운영 경로와 같다. 거부되면 exit 2.
 *   `.json`           `{ subject?, text, htmlText?, attachmentNames? }` — 스캐너 입력 그대로.
 *   `.html`/`.htm`    `htmlToText` 로 변환해 `text`·`htmlText` 둘 다에 넣는다(plain 파트 없는 메일과 같다).
 *   그 밖(`.txt` 등)  파일 전체가 `text`.
 *
 * **출력에 메일 본문을 싣지 않는다** — 파일 이름·라벨·위험도·점수·룰 id 만.
 *
 * exit 0 통과 · 1 기준 미달(또는 공허) · 2 입력 오류.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';

import { htmlHiddenText, htmlToText } from '../src/mail/mime/parse-html';
import { parseInboundMime } from '../src/mail/mime/parse';
import {
  INJECTION_SCANNER_VERSION,
  QUARANTINE_FROM,
  scanForInjection,
  type InjectionRisk,
  type InjectionScanInput,
} from '../src/security/injection/scanner';
import { AC7_MIN_HIGH, AC7_MIN_NEGATIVES, AC7_MIN_POSITIVES, ACTIVE_SEAL_DIGEST } from './injection-seal';

type Label = 'positive' | 'negative';
type LabelRisk = 'high' | 'medium' | 'low';

interface LabelEntry {
  readonly label: Label;
  readonly risk?: LabelRisk;
}

class InputError extends Error {}

const IGNORED = new Set(['labels.json']);

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current).sort()) {
      if (entry.startsWith('.')) continue;
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(dir, full).split(sep).join('/'));
    }
  };
  walk(dir);
  return out.filter((f) => !IGNORED.has(f) && !/^readme/i.test(f.split('/').pop() ?? '') && !f.endsWith('.sha256'));
}

function parseLabels(dir: string, files: readonly string[]): Map<string, LabelEntry> {
  const labels = new Map<string, LabelEntry>();
  let raw: unknown = null;
  try {
    raw = JSON.parse(readFileSync(join(dir, 'labels.json'), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new InputError(`labels.json 을 읽지 못했다: ${String(error)}`);
  }
  // 봉인 홀드아웃 형식 `{ version, sealed, cases: [{ file, label, risk, … }] }` 도 받는다
  // (docs/security/injection-holdout.md). 홀드아웃 작성자와 스캐너 작성자는 서로의 산출물을
  // 보지 않고 따로 만들었으므로 형식이 갈렸다 — 평가 러너가 둘 다 읽는 쪽이 맞다.
  // 음성의 `risk: null` 은 "위험도 없음" 이다.
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw) && Array.isArray((raw as { cases?: unknown }).cases)) {
    const flat: Record<string, unknown> = {};
    for (const item of (raw as { cases: unknown[] }).cases) {
      const entry = item as { file?: unknown; label?: unknown; risk?: unknown };
      if (typeof entry.file !== 'string') throw new InputError('cases[].file 은 문자열이어야 한다');
      // 홀드아웃은 `injection`/`benign` 어휘를 쓴다. 그 밖의 값은 그대로 넘겨 아래 검사가 거부하게 한다.
      const label = entry.label === 'injection' ? 'positive' : entry.label === 'benign' ? 'negative' : entry.label;
      flat[entry.file] = entry.risk === null || entry.risk === undefined ? { label } : { label, risk: entry.risk };
    }
    raw = flat;
  }
  if (raw !== null) {
    if (typeof raw !== 'object' || Array.isArray(raw)) throw new InputError('labels.json 은 { 경로: { label, risk? } } 객체여야 한다');
    for (const [path, value] of Object.entries(raw as Record<string, unknown>)) {
      const entry = value as { label?: unknown; risk?: unknown };
      if (entry.label !== 'positive' && entry.label !== 'negative') throw new InputError(`${path}: label 은 positive|negative`);
      if (entry.risk !== undefined && entry.risk !== 'high' && entry.risk !== 'medium' && entry.risk !== 'low') {
        throw new InputError(`${path}: risk 는 high|medium|low`);
      }
      if (entry.label === 'negative' && entry.risk !== undefined) throw new InputError(`${path}: 음성에 risk 를 달 수 없다`);
      labels.set(path, entry.risk === undefined ? { label: entry.label } : { label: entry.label, risk: entry.risk });
    }
    const missing = [...labels.keys()].filter((p) => !files.includes(p));
    if (missing.length > 0) throw new InputError(`라벨은 있는데 파일이 없다: ${missing.join(', ')}`);
  }
  const unlabeled: string[] = [];
  for (const file of files) {
    if (labels.has(file)) continue;
    const segments = file.split('/');
    if (segments.includes('positive')) labels.set(file, { label: 'positive' });
    else if (segments.includes('negative')) labels.set(file, { label: 'negative' });
    else unlabeled.push(file);
  }
  if (unlabeled.length > 0) throw new InputError(`라벨이 없는 파일: ${unlabeled.join(', ')}`);
  return labels;
}

async function loadInput(path: string): Promise<InjectionScanInput> {
  const ext = extname(path).toLowerCase();
  if (ext === '.eml') {
    const result = await parseInboundMime(new Uint8Array(readFileSync(path)));
    if (result.kind !== 'parsed') throw new InputError(`${path}: 파서가 거부했다(${result.kind})`);
    const m = result.message;
    // 파서가 지운 C1 의 흔적을 넘긴다 — 운영 소비자와 같은 입력이어야 평가가 운영을 잰다.
    return {
      subject: m.subject,
      text: m.text,
      htmlText: m.htmlText,
      attachmentNames: m.attachments.map((a) => a.filename),
      c1Removed: m.c1Removed,
      hiddenText: m.hiddenText,
    };
  }
  const content = readFileSync(path, 'utf8');
  if (ext === '.json') {
    const value = JSON.parse(content) as Partial<Record<keyof InjectionScanInput, unknown>>;
    if (typeof value.text !== 'string') throw new InputError(`${path}: text 는 문자열이어야 한다`);
    const optionalString = (v: unknown): string | null => (typeof v === 'string' ? v : null);
    const names = Array.isArray(value.attachmentNames) ? value.attachmentNames.map(optionalString) : [];
    return { subject: optionalString(value.subject), text: value.text, htmlText: optionalString(value.htmlText), attachmentNames: names, hiddenText: optionalString(value.hiddenText) };
  }
  if (ext === '.html' || ext === '.htm') {
    const text = htmlToText(content);
    const hidden = htmlHiddenText(content);
    return { subject: null, text, htmlText: text, hiddenText: hidden === '' ? null : hidden };
  }
  return { subject: null, text: content, htmlText: null };
}

function parseArgs(argv: readonly string[]): { dir: string; maxFpRate: number; verbose: boolean; ac7: boolean } {
  let dir: string | undefined;
  let maxFpRate = 0.05;
  let verbose = false;
  let ac7 = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--max-fp-rate') {
      maxFpRate = Number(argv[i + 1]);
      i += 1;
    } else if (arg === '--verbose') {
      verbose = true;
    } else if (arg === '--ac7') {
      ac7 = true;
    } else if (arg !== undefined && !arg.startsWith('--')) {
      dir = arg;
    }
  }
  if (dir === undefined || !Number.isFinite(maxFpRate)) {
    throw new InputError('사용: tsx scripts/eval-injection.ts <디렉터리> [--max-fp-rate 0.05] [--verbose]');
  }
  return { dir, maxFpRate, verbose, ac7 };
}

const pct = (n: number, d: number): string => (d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(1)}%`);

async function main(): Promise<number> {
  const { dir, maxFpRate, verbose, ac7 } = parseArgs(process.argv.slice(2));
  // **AC-7 판정은 봉인된 활성 세트에서만 한다** (검증자 V3, B3 — 파일 2개짜리 디렉터리가 "AC-7 기준 충족" 을 받았다).
  // `--ac7` 없이 돌리면 같은 지표를 내되 "비공식" 이다. 학습셋·dev 에서의 통과는 증거가 아니다.
  if (ac7) assertSealedHoldout(dir);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new InputError(`디렉터리가 아니다: ${dir}`);
  const files = listFiles(dir);
  const labels = parseLabels(dir, files);

  const rows = ['negative', 'low', 'medium', 'high'] as const;
  const cols: readonly InjectionRisk[] = ['none', 'low', 'medium', 'high'];
  const matrix = new Map<string, Map<InjectionRisk, number>>(rows.map((r) => [r, new Map(cols.map((c) => [c, 0]))]));

  let negatives = 0;
  let falsePositives = 0;
  let high = 0;
  let highMissed = 0;
  let positives = 0;
  let positivesMissed = 0;
  let unrated = 0;
  let exact = 0;
  const failures: string[] = [];

  for (const file of files) {
    const entry = labels.get(file);
    if (entry === undefined) continue;
    const result = scanForInjection(await loadInput(join(dir, file)));
    const rules = [...new Set(result.findings.map((f) => f.ruleId))].join(',') || '-';
    const row = entry.label === 'negative' ? 'negative' : (entry.risk ?? 'high');
    if (entry.label === 'positive' && entry.risk === undefined) unrated += 1;
    const cell = matrix.get(row);
    cell?.set(result.injectionRisk, (cell.get(result.injectionRisk) ?? 0) + 1);
    if ((row === 'negative' ? 'none' : row) === result.injectionRisk) exact += 1;

    let failure: string | null = null;
    if (entry.label === 'negative') {
      negatives += 1;
      if (result.quarantine) {
        falsePositives += 1;
        failure = 'FALSE POSITIVE';
      }
    } else {
      positives += 1;
      // low 라벨은 격리 대상이 아니다(위험도만 붙는다) — low 양성의 미탐은 "아무것도 못 봤다(none)" 뿐이다.
      const missed = row === 'low' ? result.injectionRisk === 'none' : !result.quarantine;
      if (missed) {
        positivesMissed += 1;
        failure = row === 'high' ? 'HIGH MISSED' : 'missed';
      }
      if (row === 'high') {
        high += 1;
        if (!result.quarantine) highMissed += 1;
      }
    }
    const line = `${file}  label=${row}  risk=${result.injectionRisk}  score=${String(result.score)}  rules=${rules}`;
    if (failure !== null) failures.push(`  ${failure.padEnd(15)} ${line}`);
    else if (verbose) console.log(`  ok              ${line}`);
  }

  console.log(`스캐너: ${INJECTION_SCANNER_VERSION}   격리 임계: ${QUARANTINE_FROM} 이상   표본: ${String(files.length)}`);
  if (unrated > 0) console.log(`주의: risk 가 없는 양성 ${String(unrated)}건을 high 로 보았다.`);
  console.log('');
  console.log(`혼동 행렬 (행=라벨, 열=판정 위험도)`);
  console.log(`  ${''.padEnd(10)}${cols.map((c) => c.padStart(8)).join('')}`);
  for (const r of rows) console.log(`  ${r.padEnd(10)}${cols.map((c) => String(matrix.get(r)?.get(c) ?? 0).padStart(8)).join('')}`);
  console.log('');
  console.log(`오탐률(격리된 음성)        ${String(falsePositives)}/${String(negatives)} = ${pct(falsePositives, negatives)}   기준 ≤ ${(maxFpRate * 100).toFixed(1)}%`);
  console.log(`고위험 미탐률(격리 안 된 high) ${String(highMissed)}/${String(high)} = ${pct(highMissed, high)}   기준 = 0`);
  console.log(`양성 전체 미탐(참고; low 는 none 일 때만) ${String(positivesMissed)}/${String(positives)} = ${pct(positivesMissed, positives)}`);
  console.log(`위험도 정확 일치(참고)      ${String(exact)}/${String(files.length)} = ${pct(exact, files.length)}`);
  if (failures.length > 0) {
    console.log('');
    console.log('실패 표본:');
    for (const f of failures) console.log(f);
  }

  const problems: string[] = [];
  if (negatives === 0) problems.push('음성 표본 0건 — 오탐률을 잴 수 없다(공허한 통과 금지)');
  if (high === 0) problems.push('high 양성 표본 0건 — 고위험 미탐률을 잴 수 없다(공허한 통과 금지)');
  if (negatives > 0 && falsePositives / negatives > maxFpRate) problems.push('오탐률 기준 초과');
  if (highMissed > 0) problems.push('고위험 미탐 발생');
  if (ac7 && (positives < AC7_MIN_POSITIVES || high < AC7_MIN_HIGH || negatives < AC7_MIN_NEGATIVES)) {
    problems.push(
      `표본 부족 — 양성 ${String(positives)}/${String(AC7_MIN_POSITIVES)} · high ${String(high)}/${String(AC7_MIN_HIGH)} · 음성 ${String(negatives)}/${String(AC7_MIN_NEGATIVES)}`,
    );
  }
  console.log('');
  const scope = ac7 ? 'AC-7' : '기준(비공식 — AC-7 판정 아님: `--ac7` + 봉인 세트만 판정한다)';
  if (problems.length > 0) {
    console.log(`✗ ${scope} 미달: ${problems.join(' · ')}`);
    return 1;
  }
  console.log(`✓ ${scope} 충족`);
  return 0;
}

/**
 * `--ac7` 전제: 대상이 **활성 봉인 세트**다 — 봉인 digest 가 단일 출처(`injection-seal.ts`)와 같고,
 * 봉인 목록의 모든 파일 바이트가 일치한다. 하나라도 어긋나면 판정 불가(exit 2)다. 통과도 불합격도 아니다.
 */
function assertSealedHoldout(dir: string): void {
  if (ACTIVE_SEAL_DIGEST === null) {
    throw new InputError('활성 봉인 세트가 없다(ACTIVE_SEAL_DIGEST = null) — AC-7 을 판정할 수 없다. docs/security/injection-holdout.md');
  }
  const root = resolve(dir, '..');
  const sealFile = join(root, 'HOLDOUT.sha256');
  if (!existsSync(sealFile)) throw new InputError(`봉인 목록이 없다: ${sealFile}`);
  const digest = createHash('sha256').update(readFileSync(sealFile)).digest('hex');
  if (digest !== ACTIVE_SEAL_DIGEST) throw new InputError('봉인 목록 digest 가 활성 세트와 다르다 — 봉인되지 않은 세트다');
  for (const line of readFileSync(sealFile, 'utf8').split('\n')) {
    const match = /^([0-9a-f]{64}) {2}(\S.*)$/.exec(line);
    if (match === null) continue;
    const [, hash = '', path = ''] = match;
    const full = join(root, path);
    if (!existsSync(full) || createHash('sha256').update(readFileSync(full)).digest('hex') !== hash) {
      throw new InputError(`봉인과 다른 파일: ${path}`);
    }
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof InputError ? `입력 오류: ${error.message}` : error);
    process.exit(2);
  },
);
