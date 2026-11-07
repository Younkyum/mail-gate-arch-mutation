/**
 * AI 의심 메일 감시 경계(ADR-0017 · 설계 `docs/internal/plans/ai-mail-watch.md` §6.4) — **모델 신호는 경고 표시만이다. 판정에 닿지 않는다.**
 *
 *   ① 판정 쪽(관문 `src/gate/**` · 정책 `src/policy/**`(위험 보류 · 정책 엔진 · 로더) · 승인 `src/approval/**` · 보안 `src/security/**`(오염 등급
 *      `taint.ts` · DLP · 인젝션 스캐너) · 승인 워커 `src/workers/approval-*` · 발송 서비스 `src/api/outbound-service.ts`(REST · MCP 발송이 지나는 곳))의
 *      **런타임 import 폐포**에 `src/inbound/ai-watch/**` 가 없고, `ai_watch` · `ai_hold` · `ai_mail_watch` 를 적은 SQL(문자열)을 가진 파일도 없다.
 *   ② 판정 쪽 저장소(`risk-signal-store` · `policy-source` · `exposure-store` · `trust-facts-store` · `inbound-policy-store`)의 문자열에 그 이름이 0건.
 *   ③ `ai_watch_jobs` 를 **쓰는**(INSERT · UPDATE · DELETE) 프로덕션 파일은 작업을 만드는 `inbound-store.ts` 와 결과 λ 뿐이다(결과 λ 는 DEFINER 함수로
 *      쓰므로 리터럴이 없을 수도 있다 — 허용 목록 ⊆).
 *   ④ `src/**` 와 `infra/**` 는 `ops/ai-watch/**`(Mac 워커)를 import 하지 않는다 · `src/**` 어디에도 모델 런타임(`onnxruntime-*` · `@huggingface/*` ·
 *      `@xenova/*` · `tokenizers`) import 가 없다 — 모델이 λ 로 새어 들어오지 않게.
 *   ⑤ 킬 스위치 env `ATMARK_AI_WATCH` 를 **읽는** 프로덕션 코드는 조립 루트(`runtime/composition.ts`)뿐이다. 이름(문자열)은 계약 · 설정 표
 *      (`contract.ts` · `config.ts`)에만 있다(`risk-signals` ④ 와 같은 결).
 *
 * 각 규칙은 순수 검사 함수(`check*`)이고, 맨 아래 "검사기는 공허하지 않다" 가 메모리 위 가짜 프로젝트에 위반을 심어 **빨개지는지** 확인한다.
 */

import { describe, expect, it } from 'vitest';
import { Project, SyntaxKind, type SourceFile } from 'ts-morph';

import { getProject, listTsFilesUnder, REPO_ROOT, toRepoRelative } from './support/project';

// ---------------------------------------------------------------------------
// 규칙에 쓰는 이름
// ---------------------------------------------------------------------------

const AI_WATCH_DIR = 'src/inbound/ai-watch/';
/**
 * SQL 이름(표 · 칸 · 함수) — `ai_watch_jobs` · `ai_watch_runtime` · `ai_watch_job_id` · `ai_hold_until` · `ai_mail_watch_enabled` · `ai_watch_record_*`.
 * 이것이 판정 쪽 문자열에 있으면 판정이 감시 결과를 읽을 수 있다. 메트릭 이름(`ai_watch.enqueue_failed` — 점)은 SQL 이 아니라 걸지 않는다.
 */
const AI_WATCH_SQL = /\bai_(?:watch_[a-z]\w*|hold_[a-z]\w*|mail_watch\w*)/;
const DECISION_DIRS = ['src/gate/', 'src/policy/', 'src/approval/', 'src/security/'];
const DECISION_FILES = ['src/api/outbound-service.ts'];
const DECISION_FILE_PATTERNS = [/^src\/workers\/approval-[\w-]+\.ts$/];
const DECISION_STORES = [
  'src/db/repositories/risk-signal-store.ts',
  'src/db/repositories/policy-source.ts',
  'src/db/repositories/exposure-store.ts',
  'src/db/repositories/trust-facts-store.ts',
  'src/db/repositories/inbound-policy-store.ts',
];
const JOB_WRITERS_ALLOWED = ['src/db/repositories/inbound-store.ts', 'src/workers/ai-watch-result.ts', 'src/runtime/handlers/ai-watch-result.ts'];
const JOB_WRITE = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+ai_watch_jobs\b/i;
const MODEL_RUNTIME = /^(?:onnxruntime(?:-[\w-]+)?|@huggingface\/[\w.-]+|@xenova\/[\w.-]+|tokenizers)(?:\/.*)?$/;
const KILL_SWITCH_ENV = 'ATMARK_AI_WATCH';
const KILL_SWITCH_NAME_HOMES = ['src/inbound/ai-watch/contract.ts', 'src/runtime/config.ts'];
const KILL_SWITCH_READERS_ALLOWED = ['src/runtime/composition.ts'];
/** 킬 스위치를 읽는 표현(코드). `RUNTIME_ENV.aiWatchMode` · `AI_WATCH_ENV.mode` · `process.env.ATMARK_AI_WATCH` · `parseAiWatchMode(…)`. */
const KILL_SWITCH_ACCESS = new Set(['RUNTIME_ENV.aiWatchMode', 'AI_WATCH_ENV.mode', `process.env.${KILL_SWITCH_ENV}`]);

// ---------------------------------------------------------------------------
// 순수 검사 — (파일들) → 위반 목록. 프로젝트를 받으므로 가짜 프로젝트로 시험할 수 있다.
// ---------------------------------------------------------------------------

function rel(file: SourceFile, root: string): string {
  return toRepoRelativeFrom(root, file.getFilePath());
}

function toRepoRelativeFrom(root: string, path: string): string {
  return root === REPO_ROOT ? toRepoRelative(path) : path.replace(`${root}/`, '');
}

/** 문자열 · 템플릿 조각(주석은 아니다). */
function stringsOf(file: SourceFile): string[] {
  return [
    ...file.getDescendantsOfKind(SyntaxKind.StringLiteral).map((node) => node.getLiteralValue()),
    ...file.getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral).map((node) => node.getLiteralValue()),
    ...file.getDescendantsOfKind(SyntaxKind.TemplateHead).map((node) => node.getText()),
    ...file.getDescendantsOfKind(SyntaxKind.TemplateMiddle).map((node) => node.getText()),
    ...file.getDescendantsOfKind(SyntaxKind.TemplateTail).map((node) => node.getText()),
  ];
}

/**
 * 예외 하나 — `src/db/schema.ts` 의 컬럼 대장(`P3A_TABLE_COLUMNS`, PRD "본문 없음" 단언의 정확한 칸 목록)에 적힌 **칸 이름 그대로의 문자열** 둘.
 * SQL 이 아니라 이름 목록이고, 판정 쪽 거의 전부가 그 파일(타입·상수)을 런타임으로 import 한다. 칸 이름 **정확히** 그것일 때만 넘긴다 — 같은 파일에
 * `ai_watch` 를 읽는 SQL 조각이 생기면 여전히 빨갛다.
 */
const SCHEMA_FILE = 'src/db/schema.ts';
const SCHEMA_COLUMN_NAMES = new Set(['ai_watch_job_id', 'ai_hold_until']);

function mentionsAiWatchSql(file: SourceFile, path = ''): boolean {
  return stringsOf(file).some((text) => AI_WATCH_SQL.test(text) && !(path === SCHEMA_FILE && SCHEMA_COLUMN_NAMES.has(text)));
}

/** 런타임 import 폐포(`import type` 제외, `src/` 안만). */
function runtimeClosure(start: SourceFile, root: string): SourceFile[] {
  const seen = new Map<string, SourceFile>();
  const queue: SourceFile[] = [start];
  while (queue.length > 0) {
    const file = queue.pop() as SourceFile;
    const path = rel(file, root);
    if (seen.has(path) || !path.startsWith('src/')) continue;
    seen.set(path, file);
    for (const declaration of [...file.getImportDeclarations(), ...file.getExportDeclarations()]) {
      if (declaration.isTypeOnly()) continue;
      const target = declaration.getModuleSpecifierSourceFile();
      if (target) queue.push(target);
    }
  }
  return [...seen.values()];
}

function isDecisionEntry(path: string): boolean {
  return DECISION_DIRS.some((dir) => path.startsWith(dir)) || DECISION_FILES.includes(path) || DECISION_FILE_PATTERNS.some((re) => re.test(path));
}

/** ① 판정 쪽 폐포 — 위반 = `입구 → 닿은 파일(이유)`. */
export function checkDecisionClosure(files: readonly SourceFile[], root: string): { entries: number; violations: string[] } {
  const entries = files.filter((file) => isDecisionEntry(rel(file, root)));
  const violations = new Set<string>();
  for (const entry of entries) {
    for (const reached of runtimeClosure(entry, root)) {
      const path = rel(reached, root);
      if (path.startsWith(AI_WATCH_DIR)) violations.add(`${rel(entry, root)} → ${path} (ai-watch 모듈)`);
      else if (mentionsAiWatchSql(reached, path)) violations.add(`${rel(entry, root)} → ${path} (ai_watch SQL)`);
    }
  }
  return { entries: entries.length, violations: [...violations].sort() };
}

/** ② 판정 쪽 저장소의 문자열. */
export function checkDecisionStores(files: readonly SourceFile[], root: string, stores: readonly string[] = DECISION_STORES): { found: number; violations: string[] } {
  const targets = files.filter((file) => stores.includes(rel(file, root)));
  return { found: targets.length, violations: targets.filter((file) => mentionsAiWatchSql(file)).map((file) => rel(file, root)).sort() };
}

/** ③ `ai_watch_jobs` 를 쓰는 파일. */
export function checkJobWriters(files: readonly SourceFile[], root: string): { writers: string[]; violations: string[] } {
  const writers = files
    .filter((file) => rel(file, root).startsWith('src/') && !rel(file, root).startsWith('src/db/migrations/'))
    .filter((file) => stringsOf(file).some((text) => JOB_WRITE.test(text)))
    .map((file) => rel(file, root))
    .sort();
  return { writers, violations: writers.filter((path) => !JOB_WRITERS_ALLOWED.includes(path)) };
}

/** ④ import 방향 — src·infra → ops/ai-watch 금지 · src → 모델 런타임 금지. 동적 `import()` · `require()` 도 본다. */
export function checkImports(files: readonly SourceFile[], root: string): string[] {
  const violations: string[] = [];
  for (const file of files) {
    const path = rel(file, root);
    const inSrc = path.startsWith('src/');
    if (!inSrc && !path.startsWith('infra/')) continue;
    const specifiers: { spec: string; target: string | null }[] = [];
    for (const declaration of [...file.getImportDeclarations(), ...file.getExportDeclarations()]) {
      const spec = declaration.getModuleSpecifierValue();
      if (spec === undefined) continue;
      const target = declaration.getModuleSpecifierSourceFile();
      specifiers.push({ spec, target: target ? rel(target, root) : null });
    }
    for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression();
      const isDynamic = callee.getKind() === SyntaxKind.ImportKeyword || callee.getText() === 'require';
      const arg = call.getArguments()[0];
      if (isDynamic && arg !== undefined && (arg.isKind(SyntaxKind.StringLiteral) || arg.isKind(SyntaxKind.NoSubstitutionTemplateLiteral))) {
        specifiers.push({ spec: arg.getLiteralValue(), target: null });
      }
    }
    for (const { spec, target } of specifiers) {
      // 해석된 대상으로 판정한다(`src/admin/ops/ai-watch.ts` 의 `../ops/ai-watch` 는 Mac 워커가 아니다). 해석되지 않는 상대 경로만 글자로 본다.
      const worker = target !== null ? target.startsWith('ops/ai-watch/') : spec.startsWith('.') && /(?:^|\/)ops\/ai-watch\/(?:worker|test)\b/.test(spec);
      if (worker) violations.push(`${path} → ${spec} (Mac 워커)`);
      if (inSrc && MODEL_RUNTIME.test(spec)) violations.push(`${path} → ${spec} (모델 런타임)`);
    }
  }
  return violations.sort();
}

/** ⑤ 킬 스위치 — 이름이 있는 파일 · 읽는 파일. */
export function checkKillSwitch(files: readonly SourceFile[], root: string): { named: string[]; readers: string[]; violations: string[] } {
  const src = files.filter((file) => rel(file, root).startsWith('src/'));
  const named = src.filter((file) => stringsOf(file).some((text) => text === KILL_SWITCH_ENV)).map((file) => rel(file, root)).sort();
  const readers = src
    .filter((file) => !KILL_SWITCH_NAME_HOMES.includes(rel(file, root)))
    .filter(
      (file) =>
        file.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression).some((node) => KILL_SWITCH_ACCESS.has(node.getText().replace(/\s+/g, ''))) ||
        file.getDescendantsOfKind(SyntaxKind.ElementAccessExpression).some((node) => {
          const arg = node.getArgumentExpression();
          return arg !== undefined && /\.mode$|aiWatchMode$/.test(arg.getText());
        }) ||
        file.getDescendantsOfKind(SyntaxKind.CallExpression).some((node) => node.getExpression().getText() === 'parseAiWatchMode'),
    )
    .map((file) => rel(file, root))
    .sort();
  const violations = [
    ...named.filter((path) => !KILL_SWITCH_NAME_HOMES.includes(path)).map((path) => `${path} (이름)`),
    ...readers.filter((path) => !KILL_SWITCH_READERS_ALLOWED.includes(path)).map((path) => `${path} (읽기)`),
  ];
  return { named, readers, violations };
}

// ---------------------------------------------------------------------------
// 실제 트리
// ---------------------------------------------------------------------------

function realFiles(): SourceFile[] {
  return getProject()
    .getSourceFiles()
    .filter((file) => {
      const path = toRepoRelative(file.getFilePath());
      return path.startsWith('src/') || path.startsWith('infra/');
    });
}

describe('AI 의심 메일 감시 경계 — 경고 전용(ADR-0017)', () => {
  it('① 판정 쪽(관문 · 정책 · 위험 보류 · 승인 · 오염 등급 · 발송 서비스)의 런타임 폐포에 ai-watch 모듈 · ai_watch SQL 이 없다', () => {
    const { entries, violations } = checkDecisionClosure(realFiles(), REPO_ROOT);
    // 입구가 비면 이 규칙은 공허하다 — 디렉터리 이름이 바뀌었는지 본다.
    expect(entries).toBeGreaterThan(20);
    expect(violations).toEqual([]);
  });

  it('② 판정 쪽 저장소 다섯의 SQL 에 ai_watch · ai_hold · ai_mail_watch 가 0건', () => {
    const { found, violations } = checkDecisionStores(realFiles(), REPO_ROOT);
    expect(found).toBe(DECISION_STORES.length);
    expect(violations).toEqual([]);
  });

  it('③ ai_watch_jobs 를 쓰는 프로덕션 파일은 inbound-store 와 결과 λ 뿐(작업은 inbound 만 만든다)', () => {
    const { writers, violations } = checkJobWriters(realFiles(), REPO_ROOT);
    expect(writers).toContain('src/db/repositories/inbound-store.ts');
    expect(violations).toEqual([]);
  });

  it('④ src · infra 는 ops/ai-watch 를 import 하지 않는다 · src 에 모델 런타임 import 가 없다', () => {
    expect(listTsFilesUnder('src').length).toBeGreaterThan(100);
    expect(checkImports(realFiles(), REPO_ROOT)).toEqual([]);
  });

  it('⑤ 킬 스위치 ATMARK_AI_WATCH — 이름은 계약 · 설정 표에만, 읽는 곳은 조립 루트뿐', () => {
    const { named, violations } = checkKillSwitch(realFiles(), REPO_ROOT);
    expect(named).toContain('src/inbound/ai-watch/contract.ts');
    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 검사기는 공허하지 않다 — 메모리 위 가짜 리포에 위반을 심는다
// ---------------------------------------------------------------------------

const FAKE_ROOT = '/repo';

function fakeProject(files: Readonly<Record<string, string>>): SourceFile[] {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { allowJs: false, module: 99, moduleResolution: 100, target: 99 } });
  const out: SourceFile[] = [];
  for (const [path, text] of Object.entries(files)) out.push(project.createSourceFile(`${FAKE_ROOT}/${path}`, text));
  project.resolveSourceFileDependencies();
  return out;
}

describe('AI 의심 메일 감시 경계 — 검사기는 공허하지 않다(심은 위반이 잡힌다)', () => {
  const CONTRACT = `export const AI_WATCH_ENV = { mode: '${KILL_SWITCH_ENV}' } as const;\nexport function parseAiWatchMode(raw: string | undefined) { return raw ?? 'off'; }\n`;

  it('① 위험 보류가 ai-watch 를 (간접으로) import 하면 · 정책 로더가 ai_hold 를 읽는 저장소에 닿으면 잡힌다 · 타입만 import 는 괜찮다', () => {
    const files = fakeProject({
      'src/inbound/ai-watch/contract.ts': CONTRACT,
      'src/inbound/ai-watch/status.ts': `import { AI_WATCH_ENV } from './contract';\nexport type S = 'flagged';\nexport const x = AI_WATCH_ENV;\n`,
      'src/util/bridge.ts': `export { x } from '../inbound/ai-watch/status';\n`,
      'src/policy/rules/risk-hold.ts': `import { x } from '../../util/bridge';\nexport const y = x;\n`,
      'src/db/repositories/sneaky.ts': 'export const q = `SELECT ai_hold_until FROM inbound_messages`;\n',
      'src/policy/policy-loader.ts': `import { q } from '../db/repositories/sneaky';\nexport const z = q;\n`,
      'src/security/taint.ts': `import type { S } from '../inbound/ai-watch/status';\nexport type T = S;\n`,
      'src/api/outbound-service.ts': `export const clean = 1;\n`,
    });
    const { entries, violations } = checkDecisionClosure(files, FAKE_ROOT);
    expect(entries).toBe(4);
    expect(violations).toEqual([
      'src/policy/policy-loader.ts → src/db/repositories/sneaky.ts (ai_watch SQL)',
      'src/policy/rules/risk-hold.ts → src/inbound/ai-watch/contract.ts (ai-watch 모듈)',
      'src/policy/rules/risk-hold.ts → src/inbound/ai-watch/status.ts (ai-watch 모듈)',
    ]);
  });

  it('② 판정 쪽 저장소의 SQL 문자열에 ai_watch 가 있으면 잡힌다(주석은 아니다)', () => {
    const files = fakeProject({
      'src/db/repositories/risk-signal-store.ts': '// ai_watch 는 여기서 읽지 않는다(주석)\nexport const q = `SELECT 1 FROM x JOIN ai_watch_jobs j ON true`;\n',
      'src/db/repositories/policy-source.ts': "export const q = 'SELECT owner_paused FROM organizations';\n",
    });
    expect(checkDecisionStores(files, FAKE_ROOT, ['src/db/repositories/risk-signal-store.ts', 'src/db/repositories/policy-source.ts'])).toEqual({
      found: 2,
      violations: ['src/db/repositories/risk-signal-store.ts'],
    });
  });

  it('③ 허용 목록 밖에서 ai_watch_jobs 를 UPDATE 하면 잡힌다 · SELECT 는 괜찮다', () => {
    const files = fakeProject({
      'src/db/repositories/inbound-store.ts': "export const q = 'INSERT INTO ai_watch_jobs (organization_id) VALUES ($1)';\n",
      'src/admin/routes/logs.ts': "export const q = 'SELECT j.state FROM ai_watch_jobs j';\n",
      'src/api/routes/evil.ts': 'export const q = `UPDATE ai_watch_jobs SET verdict = $2 WHERE job_id = $1`;\n',
    });
    expect(checkJobWriters(files, FAKE_ROOT)).toEqual({
      writers: ['src/api/routes/evil.ts', 'src/db/repositories/inbound-store.ts'],
      violations: ['src/api/routes/evil.ts'],
    });
  });

  it('④ src → ops/ai-watch · infra → ops/ai-watch · src → onnxruntime-node · 동적 import 의 @huggingface 가 잡힌다', () => {
    const files = fakeProject({
      'ops/ai-watch/worker/core.ts': 'export const core = 1;\n',
      'src/workers/x.ts': `import { core } from '../../ops/ai-watch/worker/core';\nexport const a = core;\n`,
      'infra/cdk/stacks/y.ts': `import { core } from '../../../ops/ai-watch/worker/core';\nexport const b = core;\n`,
      'src/inbound/ai-watch/z.ts': `import * as ort from 'onnxruntime-node';\nexport const c = ort;\n`,
      'src/runtime/w.ts': `export async function load() { return import('@huggingface/transformers'); }\n`,
      'src/ok.ts': `import { readFileSync } from 'node:fs';\nexport const d = readFileSync;\n`,
    });
    expect(checkImports(files, FAKE_ROOT)).toEqual([
      'infra/cdk/stacks/y.ts → ../../../ops/ai-watch/worker/core (Mac 워커)',
      'src/inbound/ai-watch/z.ts → onnxruntime-node (모델 런타임)',
      'src/runtime/w.ts → @huggingface/transformers (모델 런타임)',
      'src/workers/x.ts → ../../ops/ai-watch/worker/core (Mac 워커)',
    ]);
  });

  it('⑤ 조립 루트 밖에서 킬 스위치를 읽거나 이름을 적으면 잡힌다', () => {
    const files = fakeProject({
      'src/inbound/ai-watch/contract.ts': CONTRACT,
      'src/runtime/config.ts': `export const RUNTIME_ENV = { aiWatchMode: '${KILL_SWITCH_ENV}' } as const;\n`,
      'src/runtime/composition.ts': `import { RUNTIME_ENV } from './config';\nimport { parseAiWatchMode } from '../inbound/ai-watch/contract';\nexport const m = parseAiWatchMode(process.env[RUNTIME_ENV.aiWatchMode]);\n`,
      'src/workers/inbound-consumer.ts': `import { AI_WATCH_ENV } from '../inbound/ai-watch/contract';\nexport const m = process.env[AI_WATCH_ENV.mode];\n`,
      'src/admin/routes/sneaky.ts': `export const m = process.env.${KILL_SWITCH_ENV};\n`,
      'src/api/routes/named.ts': `export const m = process.env['${KILL_SWITCH_ENV}'];\n`,
    });
    const result = checkKillSwitch(files, FAKE_ROOT);
    expect(result.readers).toEqual(['src/admin/routes/sneaky.ts', 'src/runtime/composition.ts', 'src/workers/inbound-consumer.ts']);
    expect(result.violations).toEqual(['src/api/routes/named.ts (이름)', 'src/admin/routes/sneaky.ts (읽기)', 'src/workers/inbound-consumer.ts (읽기)']);
  });
});
