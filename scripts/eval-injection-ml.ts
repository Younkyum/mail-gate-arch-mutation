#!/usr/bin/env tsx
/**
 * eval-injection-ml.ts — injection 스캐너를 **공개 다국어 jsonl** 하나에 돌려 집계 지표만 낸다.
 *
 * 사용: `pnpm exec tsx scripts/eval-injection-ml.ts <파일.jsonl> [--json <출력.json>] [--by source|lang|source,lang]`
 *
 * 줄 형식: `{ id, source, lang, label: "benign" | "spam_phish" | "injection", subject, text, … }`.
 * 인젝션 지표는 `label === "injection"` 대 `label === "benign"`(spam_phish 는 참고로 격리율만).
 *
 * 스캐너 점수는 정수(축별 최댓값의 합)다. 그래서 "TPR@FP" 는 연속 임계가 아니라 **운영 임계 세 개**로 낸다:
 *   - `low+`  (점수 ≥ 1) — 위험 보류(taint) T2 의 입구(행동 계열이면 low 도 T2).
 *   - `quar`  (점수 ≥ 3, medium) — 격리.
 *   - `high`  (점수 ≥ 5).
 * AUROC 는 동점을 절반으로 세는 Mann–Whitney 다(점수가 대부분 0 이라 0.5 근처에서 출발한다).
 *
 * **출력에 본문을 싣지 않는다** — 묶음 이름·건수·비율뿐. 봉인 세트에 돌려도 집계만 남는다.
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { INJECTION_SCANNER_VERSION, scanForInjection } from '../src/security/injection/scanner';

interface Row {
  readonly source?: string;
  readonly lang?: string;
  readonly label?: string;
  readonly subject?: string | null;
  readonly text?: string;
}

interface Scored {
  readonly source: string;
  readonly lang: string;
  readonly label: string;
  readonly score: number;
}

const args = process.argv.slice(2);
const file = args[0];
if (file === undefined) {
  console.error('사용: tsx scripts/eval-injection-ml.ts <파일.jsonl> [--json 출력] [--by source,lang]');
  process.exit(2);
}
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : undefined;
const by = (args.includes('--by') ? (args[args.indexOf('--by') + 1] ?? 'source,lang') : 'source,lang').split(',');

const rows: Scored[] = [];
let unreadable = 0;
for (const line of readFileSync(file, 'utf8').split('\n')) {
  if (line.trim() === '') continue;
  let r: Row;
  try {
    r = JSON.parse(line) as Row;
  } catch {
    // 파싱 오류 메시지는 줄의 일부를 싣는다 — 봉인 세트의 본문이 출력에 새지 않게 개수만 센다.
    unreadable += 1;
    continue;
  }
  const result = scanForInjection({ subject: typeof r.subject === 'string' ? r.subject : null, text: String(r.text ?? ''), htmlText: null });
  rows.push({ source: r.source ?? 'unknown', lang: r.lang ?? 'unk', label: r.label ?? 'unknown', score: result.score });
}

function auroc(pos: readonly number[], neg: readonly number[]): number | null {
  if (pos.length === 0 || neg.length === 0) return null;
  // 정수 점수 — 값별 빈도로 O(n) 에 가깝게.
  const negCounts = new Map<number, number>();
  for (const s of neg) negCounts.set(s, (negCounts.get(s) ?? 0) + 1);
  const values = [...negCounts.keys()].sort((a, b) => a - b);
  let total = 0;
  for (const s of pos) {
    for (const v of values) {
      const c = negCounts.get(v) ?? 0;
      if (v < s) total += c;
      else if (v === s) total += c / 2;
    }
  }
  return total / (pos.length * neg.length);
}

interface Summary {
  readonly group: string;
  readonly nInjection: number;
  readonly nBenign: number;
  readonly nSpam: number;
  readonly auroc: number | null;
  readonly tprLow: number | null;
  readonly tprQuar: number | null;
  readonly tprHigh: number | null;
  readonly fpLow: number | null;
  readonly fpQuar: number | null;
  readonly fpLowCount: number;
  readonly fpQuarCount: number;
  readonly spamQuar: number | null;
}

const rate = (xs: readonly number[], min: number): number | null => (xs.length === 0 ? null : xs.filter((s) => s >= min).length / xs.length);

function summarize(group: string, items: readonly Scored[]): Summary {
  const pos = items.filter((r) => r.label === 'injection').map((r) => r.score);
  const neg = items.filter((r) => r.label === 'benign').map((r) => r.score);
  const spam = items.filter((r) => r.label === 'spam_phish').map((r) => r.score);
  return {
    group,
    nInjection: pos.length,
    nBenign: neg.length,
    nSpam: spam.length,
    auroc: auroc(pos, neg),
    tprLow: rate(pos, 1),
    tprQuar: rate(pos, 3),
    tprHigh: rate(pos, 5),
    fpLow: rate(neg, 1),
    fpQuar: rate(neg, 3),
    fpLowCount: neg.filter((s) => s >= 1).length,
    fpQuarCount: neg.filter((s) => s >= 3).length,
    spamQuar: rate(spam, 3),
  };
}

const keyOf = (r: Scored): string => by.map((k) => (k === 'source' ? r.source : k === 'lang' ? r.lang : '')).join('/');
const groups = new Map<string, Scored[]>();
for (const r of rows) {
  const k = keyOf(r);
  const list = groups.get(k) ?? [];
  list.push(r);
  groups.set(k, list);
}
const byLang = new Map<string, Scored[]>();
for (const r of rows) {
  const list = byLang.get(r.lang) ?? [];
  list.push(r);
  byLang.set(r.lang, list);
}

const summaries = [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => summarize(k, v));
const langSummaries = [...byLang].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => summarize(`lang:${k}`, v));
const overall = summarize('ALL', rows);

const f = (x: number | null): string => (x === null ? '   -  ' : x.toFixed(3).padStart(6));
const header = `${'group'.padEnd(34)} ${'inj'.padStart(5)} ${'ben'.padStart(5)} ${'spam'.padStart(5)}  AUROC  TPRlow TPRqua TPRhig  FPlow  FPqua spamQ`;
const line = (s: Summary): string =>
  `${s.group.padEnd(34)} ${String(s.nInjection).padStart(5)} ${String(s.nBenign).padStart(5)} ${String(s.nSpam).padStart(5)} ${f(s.auroc)} ${f(s.tprLow)} ${f(s.tprQuar)} ${f(s.tprHigh)} ${f(s.fpLow)} ${f(s.fpQuar)} ${f(s.spamQuar)}`;

console.log(`scanner ${INJECTION_SCANNER_VERSION} · ${String(rows.length)} rows · unreadable ${String(unreadable)} · ${file.split('/').pop() ?? ''}`);
console.log(header);
for (const s of summaries) console.log(line(s));
console.log('-- by language');
for (const s of langSummaries) console.log(line(s));
console.log('--');
console.log(line(overall));
console.log(`benign FP: low+ ${String(overall.fpLowCount)}/${String(overall.nBenign)} · quarantine ${String(overall.fpQuarCount)}/${String(overall.nBenign)}`);

if (jsonOut !== undefined) {
  writeFileSync(jsonOut, `${JSON.stringify({ scanner: INJECTION_SCANNER_VERSION, file: file.split('/').pop(), overall, groups: summaries, languages: langSummaries }, null, 2)}\n`);
}
