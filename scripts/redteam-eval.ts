#!/usr/bin/env tsx
/**
 * scripts/redteam-eval.ts — **한국어 레드팀 데이터셋 평가**. `pnpm admin:redteam-export` 가 쓴 JSONL 을 읽어 지금 스캐너로 다시 잰다.
 *
 *   pnpm exec tsx scripts/redteam-eval.ts --in .omc/spikes/redteam-ko [--in <파일>…] [--json <출력>]
 *       [--model-scores <model.jsonl> [--model-threshold 0.5]] [--emit-rows <rows.jsonl>]
 *
 * 공격(label 1)의 **재현율**(risk 또는 block — `classifyInboundLevel` 등급)을 지금 룰 · 받을 때 룰 · AI 감시(있으면)별로, 등급별로,
 * 제목의 `[범주]` 표지별로 낸다. 대조 메일(label 0)은 **오탐률**(risk 또는 block · block). **표준 출력은 수치뿐**이다 — 제목 · 본문 · id 를 찍지 않는다.
 * `--in` 이 디렉터리면 그 안의 `redteam-*.jsonl` 전부(같은 메일은 가장 나중 파일 것 하나).
 *
 * ## 학습 모델(선택) — 이 스크립트는 모델에 기대지 않는다
 *
 * 모델 점수는 리포 밖 하네스(`.omc/research/ai-watch-ko-eval-scripts/` — ONNX 추론 `infer.py`, 발췌 `scan.mts`)로 따로 만든다:
 *   1. `--emit-rows <S>/rows.jsonl` — 하네스 입력 모양(`{id, set:'redteam', subject, text}`)으로 쓴다(로컬 파일 · 0600).
 *   2. 하네스의 `scan.mts <S>`(발췌 `scan.jsonl` 생성) → `python infer.py <S>`(`<S>/model.jsonl` — `{id, score}`).
 *   3. `--model-scores <S>/model.jsonl` 로 다시 돌리면 모델 재현율 · 오탐률이 붙는다(점수 ≥ `--model-threshold`).
 */

import { chmodSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { INJECTION_SCANNER_VERSION } from '../src/security/injection/scanner';
import type { InboundLevel } from '../src/security/levels';
import { isMain } from './admin/common';
import { categoryTags, rescan, ROW_SCHEMA, type RedteamRow } from './admin/redteam-export';

const USAGE =
  'pnpm exec tsx scripts/redteam-eval.ts --in <디렉터리|파일> [--in …] [--json <출력>] [--model-scores <model.jsonl> [--model-threshold 0.5]] [--emit-rows <rows.jsonl>]';

export interface EvalRow {
  readonly id: string;
  readonly label: 0 | 1;
  readonly categories: readonly string[];
  readonly now: InboundLevel | null;
  readonly receipt: InboundLevel;
  /** AI 감시가 판정을 냈으면 flagged 인가. 판정 없음(작업 없음 · 대기 · 만료 · 오류)은 `null`. */
  readonly aiFlagged: boolean | null;
  readonly modelScore: number | null;
}

export interface Rate {
  readonly n: number;
  readonly hit: number;
  readonly pct: number | null;
}

function rate(rows: readonly EvalRow[], hit: (row: EvalRow) => boolean): Rate {
  const n = rows.length;
  const count = rows.filter(hit).length;
  return { n, hit: count, pct: n === 0 ? null : (100 * count) / n };
}

const caught = (level: InboundLevel | null): boolean => level === 'risk' || level === 'block';

export interface EvalSummary {
  readonly scannerVersion: string;
  readonly rows: number;
  readonly attacks: number;
  readonly benign: number;
  readonly bodyMissing: number;
  readonly attack: {
    readonly recallNow: Rate;
    readonly recallReceipt: Rate;
    readonly levelsNow: Readonly<Record<InboundLevel, Rate>>;
    readonly aiWatch: Rate;
    readonly model: Rate | null;
    readonly byCategory: Readonly<Record<string, { readonly now: Rate; readonly receipt: Rate }>>;
  };
  readonly benignFp: {
    readonly riskOrBlockNow: Rate;
    readonly blockNow: Rate;
    readonly riskOrBlockReceipt: Rate;
    readonly aiWatch: Rate;
    readonly model: Rate | null;
  };
}

/** 데이터셋 줄 → 평가 줄. 본문이 있으면 지금 룰로 다시 돌린다(내보낸 때의 `rescan` 은 쓰지 않는다 — 룰이 그 뒤에 바뀌었을 수 있다). */
export function evalRowOf(row: RedteamRow, modelScores: ReadonlyMap<string, number>): EvalRow {
  if (row.schema !== ROW_SCHEMA) throw new Error(`데이터셋 모양이 다르다: ${String(row.schema)}`);
  const now =
    row.text === null
      ? null
      : rescan({
          subject: row.subject,
          text: row.text,
          htmlText: row.html_text,
          hiddenText: row.hidden_text,
          c1Removed: row.c1_removed,
          attachmentNames: row.attachment_names,
        }).level;
  const ai = row.ai_watch;
  return {
    id: row.message_id,
    label: row.label,
    categories: row.categories.length > 0 ? row.categories : categoryTags(row.subject),
    now,
    receipt: row.receipt.level,
    aiFlagged: ai === null || ai.verdict === null || ai.verdict === 'error' ? null : ai.verdict === 'flagged',
    modelScore: modelScores.get(row.message_id) ?? null,
  };
}

export function summarize(rows: readonly EvalRow[], options: { readonly modelThreshold: number; readonly hasModel: boolean }): EvalSummary {
  const attacks = rows.filter((r) => r.label === 1);
  const benign = rows.filter((r) => r.label === 0);
  const scannedAttacks = attacks.filter((r) => r.now !== null);
  const scannedBenign = benign.filter((r) => r.now !== null);
  const modelRate = (set: readonly EvalRow[]): Rate | null =>
    options.hasModel ? rate(set.filter((r) => r.modelScore !== null), (r) => (r.modelScore ?? 0) >= options.modelThreshold) : null;
  const aiRate = (set: readonly EvalRow[]): Rate => rate(set.filter((r) => r.aiFlagged !== null), (r) => r.aiFlagged === true);

  const categories = [...new Set(attacks.flatMap((r) => r.categories))].sort();
  const byCategory: Record<string, { now: Rate; receipt: Rate }> = {};
  for (const tag of [...categories, '(표지 없음)']) {
    const set = attacks.filter((r) => (tag === '(표지 없음)' ? r.categories.length === 0 : r.categories.includes(tag)));
    if (set.length === 0) continue;
    byCategory[tag] = {
      now: rate(set.filter((r) => r.now !== null), (r) => caught(r.now)),
      receipt: rate(set, (r) => caught(r.receipt)),
    };
  }

  return {
    scannerVersion: INJECTION_SCANNER_VERSION,
    rows: rows.length,
    attacks: attacks.length,
    benign: benign.length,
    bodyMissing: rows.filter((r) => r.now === null).length,
    attack: {
      recallNow: rate(scannedAttacks, (r) => caught(r.now)),
      recallReceipt: rate(attacks, (r) => caught(r.receipt)),
      levelsNow: {
        block: rate(scannedAttacks, (r) => r.now === 'block'),
        risk: rate(scannedAttacks, (r) => r.now === 'risk'),
        none: rate(scannedAttacks, (r) => r.now === 'none'),
      },
      aiWatch: aiRate(attacks),
      model: modelRate(attacks),
      byCategory,
    },
    benignFp: {
      riskOrBlockNow: rate(scannedBenign, (r) => caught(r.now)),
      blockNow: rate(scannedBenign, (r) => r.now === 'block'),
      riskOrBlockReceipt: rate(benign, (r) => caught(r.receipt)),
      aiWatch: aiRate(benign),
      model: modelRate(benign),
    },
  };
}

function fmt(r: Rate | null): string {
  if (r === null) return '-';
  return r.pct === null ? `- (n=0)` : `${r.pct.toFixed(1)}% (${String(r.hit)}/${String(r.n)})`;
}

/** 요약 → 출력 줄. 수치뿐. */
export function report(s: EvalSummary, modelThreshold: number): string[] {
  const lines = [
    `scanner ${s.scannerVersion}`,
    `rows ${String(s.rows)} · attack ${String(s.attacks)} · benign ${String(s.benign)} · body missing ${String(s.bodyMissing)}`,
    '',
    '공격 재현율(risk 또는 block)',
    `  지금 룰       ${fmt(s.attack.recallNow)}`,
    `  받을 때 룰    ${fmt(s.attack.recallReceipt)}`,
    `  AI 감시 flagged ${fmt(s.attack.aiWatch)}`,
    `  모델(≥${String(modelThreshold)}) ${fmt(s.attack.model)}`,
    `  지금 룰 등급  block ${fmt(s.attack.levelsNow.block)} · risk ${fmt(s.attack.levelsNow.risk)} · none ${fmt(s.attack.levelsNow.none)}`,
    '',
    '범주별(지금 룰 · 받을 때 룰)',
    ...Object.entries(s.attack.byCategory).map(([tag, v]) => `  [${tag}] ${fmt(v.now)} · ${fmt(v.receipt)}`),
    '',
    '대조 메일 오탐(label 0)',
    `  지금 룰 risk 또는 block ${fmt(s.benignFp.riskOrBlockNow)} · block ${fmt(s.benignFp.blockNow)}`,
    `  받을 때 룰 risk 또는 block ${fmt(s.benignFp.riskOrBlockReceipt)}`,
    `  AI 감시 flagged ${fmt(s.benignFp.aiWatch)}`,
    `  모델(≥${String(modelThreshold)}) ${fmt(s.benignFp.model)}`,
  ];
  return lines;
}

function inputFiles(paths: readonly string[]): string[] {
  const files: string[] = [];
  for (const path of paths) {
    if (!existsSync(path)) throw new Error(`없다: ${path}`);
    if (statSync(path).isDirectory()) {
      files.push(
        ...readdirSync(path)
          .filter((name) => /^redteam-.*\.jsonl$/.test(name))
          .sort()
          .map((name) => join(path, name)),
      );
    } else files.push(path);
  }
  return files;
}

/** 파일들 → 줄(같은 메일은 나중 파일 것). */
export function loadRows(files: readonly string[]): RedteamRow[] {
  const byId = new Map<string, RedteamRow>();
  for (const file of files) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      const row = JSON.parse(line) as RedteamRow;
      byId.set(row.message_id, row);
    }
  }
  return [...byId.values()];
}

function loadModelScores(path: string): Map<string, number> {
  const scores = new Map<string, number>();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const r = JSON.parse(line) as { id?: unknown; score?: unknown };
    if (typeof r.id === 'string' && typeof r.score === 'number') scores.set(r.id, r.score);
  }
  return scores;
}

export function main(argv: readonly string[]): number {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      in: { type: 'string', multiple: true },
      json: { type: 'string' },
      'model-scores': { type: 'string' },
      'model-threshold': { type: 'string' },
      'emit-rows': { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (values.help || values.in === undefined || values.in.length === 0) {
    process.stdout.write(`${USAGE}\n`);
    return values.help ? 0 : 2;
  }
  const threshold = values['model-threshold'] === undefined ? 0.5 : Number(values['model-threshold']);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error('--model-threshold 는 0~1');

  const rows = loadRows(inputFiles(values.in));
  if (values['emit-rows'] !== undefined) {
    const out = rows.filter((r) => r.text !== null).map((r) => JSON.stringify({ id: r.message_id, set: 'redteam', label: r.label, subject: r.subject, text: r.text }));
    writeFileSync(values['emit-rows'], out.length === 0 ? '' : `${out.join('\n')}\n`, { mode: 0o600 });
    chmodSync(values['emit-rows'], 0o600);
    process.stderr.write(`하네스 입력 ${String(out.length)}줄을 썼다.\n`);
  }
  const scores = values['model-scores'] === undefined ? new Map<string, number>() : loadModelScores(values['model-scores']);
  const summary = summarize(
    rows.map((r) => evalRowOf(r, scores)),
    { modelThreshold: threshold, hasModel: values['model-scores'] !== undefined },
  );
  for (const line of report(summary, threshold)) process.stdout.write(`${line}\n`);
  if (values.json !== undefined) writeFileSync(values.json, `${JSON.stringify(summary, null, 2)}\n`);
  return 0;
}

if (isMain(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`실패: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
