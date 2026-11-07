#!/usr/bin/env tsx
/**
 * eval-llmail.ts — LLMail-Inject(Microsoft, 2025 · MIT) 공격 메일과 독립 정상 메일로 injection 스캐너를 잰다. 결과는
 * `docs/security/llmail-eval.md`. **데이터는 리포에 넣지 않는다**(`.omc/spikes/llmail/` — 무시되는 디렉터리).
 *
 * 두 단계:
 *
 *   1. `prepare --raw <phase1.jsonl> --raw <phase2.jsonl> --out <디렉터리>`
 *      원본 제출(`raw_submissions_phase*.jsonl`)을 (제목, 본문) 으로 중복 제거하고 **팀 id 의 해시**로 dev 30% / sealed 70% 를 나눈다
 *      (같은 팀의 변형 제출이 양쪽에 갈리면 dev 튜닝이 sealed 로 샌다 — 그래서 제출이 아니라 팀 단위). 같은 글을 여러 팀이 냈으면 파일 순서상
 *      첫 제출의 팀을 따른다(글은 한쪽에만 있다). `dev.jsonl` · `sealed.jsonl` · `sealed-ids.txt`(정렬된 제출 id) 와 그 sha256 을 쓴다 —
 *      봉인 다이제스트는 문서에 적는다.
 *
 *   2. `run --attacks <준비된 jsonl> [--benign <ml-data jsonl> --benign-sources a,b,…] [--benign-llmail <emails_for_fp_tests.json>]
 *          [--benign-fixtures <코퍼스 디렉터리>] [--sample <0–100>] [--json <출력>] [--dump-misses <출력>]`
 *      공격 · 정상 각각에 받은 메일 등급(`classifyInboundLevel` — 격리 = `block`, low + 위험 계열 = `risk`, 그 밖 `none`)의 비율,
 *      언어별 · 단계(phase)별 · 시나리오별 · 방어(level 문자)별 · 성공한 공격만, 지연 p50/p95 를 낸다.
 *      `--sample` 은 제출 id 해시로 고른 **공격** 결정론 표본(튜닝 반복용 — 정상 메일은 늘 전부). `--dump-misses` 는 놓친 공격 원문을 **로컬 파일**로 — 리포에 넣지 않는다.
 *
 * 출력에 공격 원문을 싣지 않는다(표준 출력은 수치뿐).
 */

import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';

import { classifyInboundLevel, type InboundLevel } from '../src/security/levels';
import { INJECTION_SCANNER_VERSION, scanForInjection, type InjectionScanInput } from '../src/security/injection/scanner';

/** 분할 소금 — 바꾸면 분할이 바뀐다(봉인이 깨진다). */
const SPLIT_SALT = 'atmark-llmail-split-v1';
const DEV_PERCENT = 30;

interface Prepared {
  readonly id: string;
  readonly team: string;
  readonly phase: 1 | 2;
  readonly scenario: string;
  readonly subject: string;
  readonly body: string;
  /** 다섯 목표가 모두 참인 제출이 (같은 글 중) 하나라도 있었다 — 방어된 LLM 을 실제로 뚫은 공격. */
  readonly success: boolean;
  readonly dupes: number;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function bucket(key: string): number {
  return Number.parseInt(sha256(`${SPLIT_SALT}:${key}`).slice(0, 8), 16) % 100;
}

function args(argv: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i] ?? '';
    if (!key.startsWith('--')) continue;
    const value = argv[i + 1] !== undefined && !(argv[i + 1] ?? '').startsWith('--') ? (argv[(i += 1)] ?? '') : 'true';
    out.set(key.slice(2), [...(out.get(key.slice(2)) ?? []), value]);
  }
  return out;
}

async function* lines(path: string): AsyncGenerator<string> {
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of rl) if (line.trim() !== '') yield line;
}

// ---------------------------------------------------------------------------
// prepare
// ---------------------------------------------------------------------------

async function prepare(opts: Map<string, string[]>): Promise<void> {
  const raws = opts.get('raw') ?? [];
  const outDir = opts.get('out')?.[0];
  if (raws.length === 0 || outDir === undefined) throw new Error('prepare --raw <file> [--raw <file>] --out <dir>');
  const byText = new Map<string, { -readonly [K in keyof Prepared]: Prepared[K] }>();
  let total = 0;
  for (const path of raws) {
    const phase: 1 | 2 = /phase2/.test(path) ? 2 : 1;
    for await (const line of lines(path)) {
      const r = JSON.parse(line) as { RowKey?: string; job_id?: string; team_id?: string; scenario?: string; subject?: string; body?: string; objectives?: string };
      total += 1;
      const subject = typeof r.subject === 'string' ? r.subject : '';
      const body = typeof r.body === 'string' ? r.body : '';
      if (subject === '' && body === '') continue;
      let success = false;
      try {
        const o = JSON.parse(r.objectives ?? '{}') as Record<string, boolean>;
        const values = Object.values(o);
        success = values.length > 0 && values.every(Boolean);
      } catch {
        success = false;
      }
      const key = sha256(`${subject}\u0000${body}`);
      const seen = byText.get(key);
      if (seen !== undefined) {
        seen.dupes += 1;
        seen.success ||= success;
        continue;
      }
      byText.set(key, {
        id: r.RowKey ?? r.job_id ?? key.slice(0, 32),
        team: r.team_id ?? 'unknown',
        phase,
        scenario: r.scenario ?? 'unknown',
        subject,
        body,
        success,
        dupes: 0,
      });
    }
  }
  mkdirSync(outDir, { recursive: true });
  const dev: string[] = [];
  const sealed: string[] = [];
  const sealedIds: string[] = [];
  const teams = { dev: new Set<string>(), sealed: new Set<string>() };
  for (const record of byText.values()) {
    const isDev = bucket(record.team) < DEV_PERCENT;
    (isDev ? dev : sealed).push(JSON.stringify(record));
    (isDev ? teams.dev : teams.sealed).add(record.team);
    if (!isDev) sealedIds.push(record.id);
  }
  sealedIds.sort();
  const idsText = `${sealedIds.join('\n')}\n`;
  writeFileSync(join(outDir, 'dev.jsonl'), `${dev.join('\n')}\n`);
  writeFileSync(join(outDir, 'sealed.jsonl'), `${sealed.join('\n')}\n`);
  writeFileSync(join(outDir, 'sealed-ids.txt'), idsText);
  console.log(
    JSON.stringify(
      {
        rawSubmissions: total,
        unique: byText.size,
        dev: { submissions: dev.length, teams: teams.dev.size },
        sealed: { submissions: sealed.length, teams: teams.sealed.size, idsSha256: sha256(idsText) },
        salt: SPLIT_SALT,
        devPercent: DEV_PERCENT,
      },
      null,
      2,
    ),
  );
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

/** 거친 언어 판별 — 문자 체계 먼저, 라틴은 기능어 수. 보고용이지 판정에 쓰지 않는다. */
const LATIN_STOPWORDS: Readonly<Record<string, readonly string[]>> = {
  en: ['the', 'and', 'you', 'to', 'of', 'is', 'please', 'this', 'with', 'for'],
  es: ['el', 'la', 'de', 'que', 'por', 'favor', 'para', 'con', 'este', 'correo', 'los', 'una'],
  fr: ['le', 'la', 'les', 'des', 'est', 'vous', 'pour', 'avec', 'veuillez', 'une', 'et', 'ce'],
  de: ['der', 'die', 'das', 'und', 'bitte', 'sie', 'mit', 'ist', 'eine', 'nicht', 'an', 'zu'],
  pt: ['o', 'os', 'que', 'por', 'favor', 'para', 'com', 'você', 'uma', 'não', 'este', 'do'],
  it: ['il', 'che', 'per', 'con', 'una', 'questo', 'sono', 'gli', 'della', 'non', 'di'],
};

export function detectLanguage(text: string): string {
  const sample = text.slice(0, 4000);
  const count = (re: RegExp): number => (sample.match(re) ?? []).length;
  const letters = count(/\p{L}/gu) || 1;
  const scripts: [string, number][] = [
    ['ko', count(/[ㄱ-ㆎ가-힣]/gu)],
    ['ja', count(/[぀-ヿ]/gu)],
    ['zh', count(/\p{Script=Han}/gu)],
    ['ru', count(/\p{Script=Cyrillic}/gu)],
    ['ar', count(/\p{Script=Arabic}/gu)],
    ['hi', count(/\p{Script=Devanagari}/gu)],
    ['th', count(/\p{Script=Thai}/gu)],
  ];
  const ja = scripts[1]?.[1] ?? 0;
  for (const [lang, n] of scripts) {
    if (lang === 'zh' && ja > 0) continue;
    if (n / letters >= 0.2) return lang;
  }
  if (ja / letters >= 0.05) return 'ja';
  const words = sample.toLowerCase().match(/\p{L}+/gu) ?? [];
  if (words.length === 0) return 'unk';
  let best = 'unk';
  let bestScore = 0;
  for (const [lang, list] of Object.entries(LATIN_STOPWORDS)) {
    const set = new Set(list);
    const score = words.filter((w) => set.has(w)).length;
    if (score > bestScore) {
      best = lang;
      bestScore = score;
    }
  }
  return bestScore >= 2 ? best : 'unk';
}

interface Sample {
  readonly id: string;
  readonly group: string;
  readonly lang: string;
  readonly input: InjectionScanInput;
  readonly tags: readonly string[];
  readonly raw?: string;
  /** 거의 같은 글 묶음 열쇠(날짜·숫자·구두점·요일·달 이름을 뺀 글자) — 한 팀이 날짜만 바꿔 수천 번 낸 틀을 한 번으로 센다. */
  readonly cluster?: string;
}

const CALENDAR_WORDS = /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|am|pm)\b/g;

export function clusterKey(text: string): string {
  return sha256(text.toLowerCase().replace(CALENDAR_WORDS, '').replace(/[^\p{L}]/gu, '')).slice(0, 16);
}

interface Outcome {
  readonly level: InboundLevel;
  readonly anyRisk: boolean;
  readonly ms: number;
  readonly families: readonly string[];
}

function scanOne(input: InjectionScanInput): Outcome {
  const t0 = performance.now();
  const result = scanForInjection(input);
  const level = classifyInboundLevel({
    quarantined: result.quarantine,
    quarantineReason: result.quarantine ? 'injection_risk' : null,
    injectionRisk: result.injectionRisk,
    findings: result.findings,
    trustedBypass: false,
  });
  const ms = performance.now() - t0;
  return { level: level.level, anyRisk: result.injectionRisk !== 'none', ms, families: [...new Set(result.findings.map((f) => f.family))] };
}

class Tally {
  n = 0;
  block = 0;
  risk = 0;
  none = 0;
  anyRisk = 0;
  add(o: Outcome): void {
    this.n += 1;
    if (o.level === 'block') this.block += 1;
    else if (o.level === 'risk') this.risk += 1;
    else this.none += 1;
    if (o.anyRisk) this.anyRisk += 1;
  }
  row(): Record<string, number | string> {
    const pct = (k: number): string => (this.n === 0 ? '-' : `${((100 * k) / this.n).toFixed(2)}%`);
    return { n: this.n, block: pct(this.block), risk: pct(this.risk), riskOrBlock: pct(this.block + this.risk), none: pct(this.none), anyScore: pct(this.anyRisk) };
  }
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

function sampleKeep(id: string, percent: number): boolean {
  return percent >= 100 || bucket(`sample:${id}`) < percent;
}

async function loadAttacks(paths: readonly string[], percent: number): Promise<Sample[]> {
  const out: Sample[] = [];
  for (const path of paths) {
    for await (const line of lines(path)) {
      const r = JSON.parse(line) as Prepared;
      if (!sampleKeep(r.id, percent)) continue;
      const scenario = /^level(\d)([a-z])$/.exec(r.scenario);
      out.push({
        id: r.id,
        group: 'llmail',
        lang: detectLanguage(`${r.subject}\n${r.body}`),
        input: { subject: r.subject === '' ? null : r.subject, text: r.body, htmlText: null },
        tags: [
          `phase${String(r.phase)}`,
          `scenario:${scenario?.[1] ?? '?'}`,
          `defense:${scenario?.[2] ?? '?'}`,
          ...(r.success ? ['success'] : []),
        ],
        raw: `${r.subject}\n${r.body}`,
        cluster: clusterKey(`${r.subject}\n${r.body}`),
      });
    }
  }
  return out;
}

async function loadBenign(opts: Map<string, string[]>, percent: number): Promise<Sample[]> {
  const out: Sample[] = [];
  const allowed = new Set((opts.get('benign-sources') ?? []).flatMap((s) => s.split(',')).filter((s) => s !== ''));
  for (const path of opts.get('benign') ?? []) {
    for await (const line of lines(path)) {
      const r = JSON.parse(line) as { id: string; source: string; lang: string; label: string; subject: string | null; text: string };
      if (r.label !== 'benign') continue;
      if (allowed.size > 0 && !allowed.has(r.source)) continue;
      if (!sampleKeep(r.id, percent)) continue;
      out.push({ id: r.id, group: r.source, lang: r.lang, input: { subject: r.subject, text: r.text, htmlText: null }, tags: [] });
    }
  }
  for (const path of opts.get('benign-llmail') ?? []) {
    const emails = JSON.parse(readFileSync(path, 'utf8')) as string[];
    emails.forEach((email, i) => {
      const m = /^Subject of the email: ([\s\S]*?)\.\s{2,}Body: ([\s\S]*)$/.exec(email);
      out.push({
        id: `llmail-fp-${String(i)}`,
        group: 'llmail-fp-tests',
        lang: 'en',
        input: { subject: m?.[1] ?? null, text: m?.[2] ?? email, htmlText: null },
        tags: [],
      });
    });
  }
  for (const dir of opts.get('benign-fixtures') ?? []) {
    const labels = JSON.parse(readFileSync(join(dir, 'labels.json'), 'utf8')) as Record<string, { label: string }>;
    for (const [file, label] of Object.entries(labels)) {
      if (label.label !== 'negative') continue;
      const content = readFileSync(join(dir, file), 'utf8');
      const input: InjectionScanInput = file.endsWith('.json')
        ? (() => {
            const v = JSON.parse(content) as { subject?: string | null; text: string; htmlText?: string | null };
            return { subject: v.subject ?? null, text: v.text, htmlText: v.htmlText ?? null };
          })()
        : { subject: null, text: content, htmlText: null };
      out.push({ id: file, group: `fixtures:${relative(process.cwd(), dir).split(sep).join('/')}`, lang: detectLanguage(input.text), input, tags: [] });
    }
  }
  return out;
}

function listFixtureDirs(dir: string): boolean {
  return existsSync(dir) && statSync(dir).isDirectory() && readdirSync(dir).includes('labels.json');
}

async function run(opts: Map<string, string[]>): Promise<void> {
  const percent = Number(opts.get('sample')?.[0] ?? '100');
  for (const dir of opts.get('benign-fixtures') ?? []) if (!listFixtureDirs(dir)) throw new Error(`labels.json 없음: ${dir}`);
  const attacks = await loadAttacks(opts.get('attacks') ?? [], percent);
  const benign = await loadBenign(opts, 100);
  if (attacks.length === 0 && benign.length === 0) throw new Error('표본이 없다 — --attacks 또는 --benign');

  const report: Record<string, unknown> = { scannerVersion: INJECTION_SCANNER_VERSION, samplePercent: percent };
  const misses: string[] = [];
  const fps: string[] = [];

  const section = (name: string, samples: readonly Sample[], isAttack: boolean): void => {
    const all = new Tally();
    const byKey = new Map<string, Tally>();
    const families = new Map<string, number>();
    const times: number[] = [];
    /** 묶음별 [건수, block, risk] — 묶음 가중 비율(묶음마다 1표, 구성원 비율로 나눔). */
    const clusters = new Map<string, [number, number, number]>();
    const tallyOf = (key: string): Tally => {
      let t = byKey.get(key);
      if (t === undefined) {
        t = new Tally();
        byKey.set(key, t);
      }
      return t;
    };
    for (const s of samples) {
      const o = scanOne(s.input);
      times.push(o.ms);
      all.add(o);
      if (s.cluster !== undefined) {
        const c = clusters.get(s.cluster) ?? [0, 0, 0];
        c[0] += 1;
        if (o.level === 'block') c[1] += 1;
        if (o.level === 'risk') c[2] += 1;
        clusters.set(s.cluster, c);
      }
      tallyOf(`group:${s.group}`).add(o);
      tallyOf(`lang:${s.lang}`).add(o);
      for (const tag of s.tags) tallyOf(tag).add(o);
      if (o.level !== 'none') for (const f of o.families) families.set(f, (families.get(f) ?? 0) + 1);
      if (isAttack && o.level === 'none' && s.raw !== undefined) misses.push(JSON.stringify({ id: s.id, lang: s.lang, tags: s.tags, families: o.families, text: s.raw }));
      if (!isAttack && o.level !== 'none') fps.push(JSON.stringify({ id: s.id, group: s.group, lang: s.lang, level: o.level, families: o.families }));
    }
    times.sort((a, b) => a - b);
    const keys = [...byKey.keys()].sort();
    let cBlock = 0;
    let cRisk = 0;
    for (const [n, b, r] of clusters.values()) {
      cBlock += b / n;
      cRisk += r / n;
    }
    const clusterRow =
      clusters.size === 0
        ? null
        : {
            clusters: clusters.size,
            block: `${((100 * cBlock) / clusters.size).toFixed(2)}%`,
            risk: `${((100 * cRisk) / clusters.size).toFixed(2)}%`,
            riskOrBlock: `${((100 * (cBlock + cRisk)) / clusters.size).toFixed(2)}%`,
            none: `${((100 * (clusters.size - cBlock - cRisk)) / clusters.size).toFixed(2)}%`,
          };
    report[name] = {
      all: all.row(),
      clusterWeighted: clusterRow,
      breakdown: Object.fromEntries(keys.map((k) => [k, byKey.get(k)?.row()])),
      familiesInFlagged: Object.fromEntries([...families].sort((a, b) => b[1] - a[1])),
      latencyMs: { p50: Number(percentile(times, 50).toFixed(3)), p95: Number(percentile(times, 95).toFixed(3)), max: Number((times[times.length - 1] ?? 0).toFixed(3)) },
    };
    console.log(`\n## ${name} — ${String(all.n)}건`);
    console.table({ all: all.row(), ...Object.fromEntries(keys.filter((k) => (byKey.get(k)?.n ?? 0) >= 20 || !k.startsWith('lang:')).map((k) => [k, byKey.get(k)?.row()])) });
    if (clusterRow !== null) console.log('묶음 가중(거의 같은 글 = 1표):', JSON.stringify(clusterRow));
    console.log(`지연 p50 ${percentile(times, 50).toFixed(3)}ms · p95 ${percentile(times, 95).toFixed(3)}ms`);
  };

  console.log(`스캐너 ${INJECTION_SCANNER_VERSION} · 표본 ${String(percent)}%`);
  if (attacks.length > 0) section('attacks', attacks, true);
  if (benign.length > 0) section('benign', benign, false);

  const jsonOut = opts.get('json')?.[0];
  if (jsonOut !== undefined) writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`);
  const missOut = opts.get('dump-misses')?.[0];
  if (missOut !== undefined) writeFileSync(missOut, `${misses.join('\n')}\n`);
  const fpOut = opts.get('dump-fps')?.[0];
  if (fpOut !== undefined) writeFileSync(fpOut, `${fps.join('\n')}\n`);
}

// ---------------------------------------------------------------------------
// ko-split — 한국어 슬라이스 재분할(2026-10-08 3차)
// ---------------------------------------------------------------------------

/** 한국어 재분할 소금 — 바꾸면 ko-tune / ko-holdout 이 바뀐다(봉인이 깨진다). */
const KO_SPLIT_SALT = 'ko2:';

/**
 * `ko-split --sealed <sealed.jsonl> --out <디렉터리>` — 옛 sealed 의 한국어 행 **전부**를 `sha256("ko2:" + id)` 순서로 정렬해
 * 앞 절반(올림)을 `ko-tune`, 나머지를 `ko-holdout` 으로 쓴다. 옛 dev 의 한국어 행은 이미 튜닝에 쓰였으므로 어느 쪽에도 넣지 않는다.
 * 정렬된 id 목록의 sha256 을 출력한다(문서에 적는다) — 원문은 출력하지 않는다.
 */
async function koSplit(opts: Map<string, string[]>): Promise<void> {
  const sealed = opts.get('sealed')?.[0];
  const outDir = opts.get('out')?.[0];
  if (sealed === undefined || outDir === undefined) throw new Error('ko-split --sealed <sealed.jsonl> --out <dir>');
  const rows: { id: string; key: string; line: string }[] = [];
  for await (const line of lines(sealed)) {
    const r = JSON.parse(line) as Prepared;
    if (detectLanguage(`${r.subject}\n${r.body}`) !== 'ko') continue;
    rows.push({ id: r.id, key: sha256(`${KO_SPLIT_SALT}${r.id}`), line });
  }
  rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const half = Math.ceil(rows.length / 2);
  const parts = { 'ko-tune': rows.slice(0, half), 'ko-holdout': rows.slice(half) };
  mkdirSync(outDir, { recursive: true });
  const summary: Record<string, unknown> = { salt: KO_SPLIT_SALT, total: rows.length };
  for (const [name, list] of Object.entries(parts)) {
    const ids = `${list.map((r) => r.id).sort().join('\n')}\n`;
    writeFileSync(join(outDir, `${name}.jsonl`), `${list.map((r) => r.line).join('\n')}\n`);
    writeFileSync(join(outDir, `${name}-ids.txt`), ids);
    summary[name] = { rows: list.length, idsSha256: sha256(ids) };
  }
  console.log(JSON.stringify(summary, null, 2));
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const opts = args(rest);
  if (command === 'prepare') await prepare(opts);
  else if (command === 'ko-split') await koSplit(opts);
  else if (command === 'run') await run(opts);
  else {
    console.error('사용: eval-llmail.ts prepare|run … (머리말 참조)');
    process.exit(2);
  }
}

if (process.argv[1]?.endsWith('eval-llmail.ts')) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(2);
  });
}
