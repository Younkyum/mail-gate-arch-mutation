/**
 * Layer F 러너 — 비공허성 검증 (계획 §5.0 "Layer F").
 *
 * **주장:** Layer A–E 는 잠들어 있지 않다. 알려진 위반을 넣으면 **실제로 빨간불이 켜진다.**
 *
 * 절차: 기준선 측정(깨끗한 트리) → 변이 적용 → `vitest run test/arch` → **실패해야 정상**
 * → 원상 복구 → 마지막에 기준선 재확인.
 *
 * **판정은 stdout 문자열 매칭이 아니라 JSON 리포트의 테스트별 `status` 로 한다.**
 * 이유는 실증된 결함이다: vitest 기본 리포터는 느린 테스트(>300ms)의 이름을 **통과했을
 * 때도** 출력한다. Layer B 의 정방향 테스트는 `findReferencesAsNodes()` 때문에 수 초가
 * 걸려 green 일 때도 이름이 찍히고, 같은 변이가 Layer C 를 대신 실패시킨다. 그래서
 * "스위트가 실패했다 && 표적 테스트 이름이 stdout 어딘가에 있다" 는 조건이 **Layer B 가
 * 아무 일도 안 해도 충족됐다.** 그 판정식으로는 Layer F 자신이 공허해진다.
 * 지금은 `--reporter=json` 의 `assertionResults[].status === 'failed'` 만 본다.
 *
 * **이 러너가 잡는 것**
 * - glob·tsconfig·허용목록이 깨져 어떤 층이 0건만 검사하게 된 상태.
 * - 층의 단언이 실수로 항상 참이 되도록 바뀐 상태(단언 대상 변수 오타 등).
 * - `test/arch/**` 에 스킵 마커가 들어와 층이 조용히 꺼진 상태(사전 점검).
 *
 * **이 러너가 못 잡는 것**
 * - 변이 6종이 **겨냥하지 않은** 우회 수법. 보증 범위는 "알려진 위반"까지다.
 * - 층이 존재하지만 **범위가 좁은** 경우(예: Layer C 의 미선언 디렉터리 사각지대).
 *   변이가 그 범위 안에서 작성되므로 범위 자체의 결함은 드러나지 않는다.
 * - 표적 테스트 **이름이 서로 겹치도록** 지어진 경우. 판정 단위가 이름이므로 그때는
 *   다시 흐려진다. `assertDistinctTargets()`(겹침)와 `assertTargetsExist()`(실재성,
 *   기준선에서 정확히 1개 매칭)가 기동 시 그 두 경로를 막는다.
 * - vitest 가 JSON 리포트를 쓰지 못할 정도로 일찍 죽는 경우. 그때는 판정 불가로
 *   보고한다 — stdout 으로 되돌아가지 않는다. 그게 이 결함의 재발 경로다.
 *
 * **오염 금지가 이 러너의 안전 요건이다.** 변이는 워킹트리를 직접 건드리므로, 파일뿐
 * 아니라 **러너가 만든 디렉터리까지** 되돌려야 한다. 잔재가 남으면 다음 기준선이
 * 오염되고, 그 순간 "빨간불이 정상인 실행"과 "빨간불이 사고인 실행"을 구분할 수 없게 된다.
 * 잔재 검사는 `git status` 가 아니라 **실행 전 지문과의 대조**다 — 변이 E 의 산출물
 * (`cdk.out/**`)과 러너가 만든 빈 디렉터리는 git 이 구조상 볼 수 없고, 반대로 git 은
 * 실행 전부터 더러웠던 파일을 러너의 잔재로 오인한다.
 *
 * **동시 편집 위험 (2026-09-22 관측).** 변이는 `src/policy/gate.ts` 같은 **실제 소스를
 * 덮어썼다가 되돌린다.** 그래서 이 러너가 도는 동안 다른 누군가가 같은 파일을 저장하면
 * 그 저장은 복구 시점에 **조용히 사라진다** — 러너 입장에서는 정상 복구이고, 지문 대조도
 * 통과한다(복구된 내용이 러너가 읽은 그 내용이므로). `pnpm demo:p1a` 가 이 러너를
 * 부르므로 데모 실행도 같은 창을 연다.
 *
 * 병렬 작업자가 `src/policy/**` 를 편집하는 동안에는 이 러너를 돌리지 마라. 복사본
 * 위에서 변이하도록 고치려면 arch 테스트들이 루트 경로를 인자로 받아야 하는데, 그러면
 * **층이 검사하는 경로와 프로덕션 경로가 갈라진다** — 이 러너가 존재하는 이유가
 * "층이 진짜 프로덕션 코드를 보는가" 이므로 그 갈라짐이 곧 다음 공허성이다.
 * 지금은 고치지 않고 규율로 다룬다.
 *
 * **실행 비용 (2026-09-25).** 예전에는 변이마다 `vitest run test/arch` 전체(22 파일, 기본 워커 10, RSS 8GB+)를 돌려
 * 기준선·복구 확인을 합쳐 59회 전체 실행이었다. 지금은 **기준선 1회(전체)** 로 표적 이름 → 파일 지도를 만든 뒤, 변이마다
 * **표적 테스트가 사는 파일 하나만** 워커 2개로 돌린다. 판정식은 그대로다(표적 테스트의 `status === 'failed'`) — 표적이
 * 사는 파일을 돌리므로 판정에 쓰는 결과는 전체 실행 때와 같다. 잃는 것은 "다른 층도 함께 빨개졌다" 는 **진단용** 정보뿐이다.
 * 마지막 복구 확인은 전 변이를 돌린 경우 전체 arch, 일부만 돌린 경우(`--only`·`--affected`) 그 표적 파일들이다.
 *
 * **중단 안전.** SIGINT·SIGTERM·SIGHUP·잡히지 않은 예외에서 **현재 변이의 흔적을 되돌리고** vitest 프로세스 그룹을 끝낸 뒤
 * 나간다. 예전에는 처리기가 없어 러너를 죽이면 변이된 소스 파일이 워킹트리에 그대로 남았다.
 * (SIGKILL 은 잡을 수 없다 — 그때는 `git status`·`git diff` 로 직접 확인한다.)
 *
 * 실행: `pnpm mutations` (= `pnpm exec tsx test/arch/mutations/run-mutations.ts`)
 *   `--only=<id,id,...>`  카탈로그의 그 변이만.
 *   `--affected`          HEAD 대비 바뀐(미추적 포함) 파일이 변이 대상 경로 · 표적 테스트 파일이거나, 변이 경로와 같은
 *                         모듈(`test/modules.ts`)에 속하는 변이만. 전역 경로(`GLOBAL_PATHS` — 러너 설정·의존성·
 *                         `test/arch/support/**`)나 `test/arch/mutations/**` 가 바뀌었으면 전부.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isGlobalPath, modulesOfPath, type ModuleName } from '../../modules';
import { MUTATIONS, type Mutation } from './catalogue';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * JSON 리포트는 **리포 밖**(OS 임시 디렉터리)에 쓴다.
 * 리포 안에 쓰면 그 파일 자신이 잔재 검사의 대상이 되고, gitignore 로 숨기면
 * 이번에 고친 바로 그 사각지대(추적되지 않는 산출물)를 하나 더 만드는 셈이 된다.
 */
const REPORT_DIR = mkdtempSync(join(tmpdir(), 'arch-mutation-'));
const REPORT_FILE = join(REPORT_DIR, 'report.json');

/** 되돌리기 위해 기억해 두는 원본. `null` 이면 "원래 없던 파일"이라 삭제한다. */
interface Snapshot {
  readonly path: string;
  readonly original: string | null;
}

/**
 * 한 변이가 워킹트리에 남긴 흔적 전부.
 * **적용과 동시에 채워진다** — 반환값으로 주면 적용 중 예외가 났을 때 호출자가
 * 되돌릴 대상을 모르고, 그대로 잔재가 된다.
 */
interface Trace {
  readonly snapshots: Snapshot[];
  /** 러너가 새로 만든 디렉터리. 깊은 것부터 지운다. */
  readonly createdDirs: string[];
}

function newTrace(): Trace {
  return { snapshots: [], createdDirs: [] };
}

/** 파일의 부모 디렉터리를 만들면서, **새로 생긴** 디렉터리만 흔적에 기록한다. */
function ensureParentDir(absoluteFile: string, trace: Trace): void {
  const missing: string[] = [];
  let current = dirname(absoluteFile);

  while (current !== REPO_ROOT && current.startsWith(REPO_ROOT) && !existsSync(current)) {
    missing.push(current);
    current = dirname(current);
  }

  mkdirSync(dirname(absoluteFile), { recursive: true });
  trace.createdDirs.push(...missing);
}

function applyMutation(mutation: Mutation, trace: Trace): void {
  for (const file of mutation.files) {
    const absolute = join(REPO_ROOT, file.path);
    trace.snapshots.push({ path: absolute, original: existsSync(absolute) ? readFileSync(absolute, 'utf8') : null });
    ensureParentDir(absolute, trace);
    writeFileSync(absolute, file.content, 'utf8');
  }

  for (const replacement of mutation.replacements ?? []) {
    const absolute = join(REPO_ROOT, replacement.path);
    const current = readFileSync(absolute, 'utf8');
    if (!current.includes(replacement.find)) {
      // 앵커가 사라졌는데 조용히 no-op 이 되면, 변이가 적용되지 않은 채 "스위트가 통과했다"는
      // 결론이 나온다. 그건 Layer F 자신의 공허한 통과다. 즉시 에러로 끊는다.
      throw new Error(
        `[${mutation.id}] ${replacement.path} 에서 앵커를 찾지 못했다. 변이가 적용되지 않았다:\n${replacement.find}`,
      );
    }
    trace.snapshots.push({ path: absolute, original: current });
    writeFileSync(absolute, current.replace(replacement.find, replacement.replace), 'utf8');
  }
}

function revert(trace: Trace): void {
  // 파일 역순 복구 — 같은 파일을 두 번 건드린 경우 최초 원본이 마지막에 쓰인다.
  for (const snapshot of [...trace.snapshots].reverse()) {
    if (snapshot.original === null) rmSync(snapshot.path, { force: true });
    else writeFileSync(snapshot.path, snapshot.original, 'utf8');
  }

  // 디렉터리는 깊은 것부터. 비어 있을 때만 지운다 — 다른 워커가 같은 디렉터리에
  // 진짜 파일을 넣었다면 그건 우리 것이 아니다.
  // `rmSync` 가 아니라 `rmdirSync` 를 쓴다: 비어 있지 않으면 **예외가 나는 쪽**이 옳다.
  // 재귀 삭제였다면 남의 파일을 조용히 지우는 경로가 생긴다.
  for (const dir of [...trace.createdDirs].sort((a, b) => b.length - a.length)) {
    if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
  }
}

// ---------------------------------------------------------------------------
// 스위트 실행과 **테스트 단위** 판정
// ---------------------------------------------------------------------------

/** vitest `--reporter=json` 산출물 중 이 러너가 쓰는 부분만. */
interface VitestJsonReport {
  readonly testResults?: readonly {
    readonly name?: string;
    readonly status?: string;
    readonly message?: string;
    readonly assertionResults?: readonly {
      readonly fullName?: string;
      readonly status?: string;
    }[];
  }[];
}

interface SuiteRun {
  readonly passed: boolean;
  /** 이 실행이 **실제로 돌린** 모든 테스트의 `fullName`. 표적 실재성 검사에 쓴다. */
  readonly allTests: readonly string[];
  /**
   * **실패한** 테스트의 `fullName` 목록. 판정은 오직 이 목록으로 한다.
   * 파일이 통째로 수집 실패하면 개별 테스트가 없으므로 `<파일>: <메시지>` 로 합성해 넣는다.
   */
  readonly failedTests: readonly string[];
  /** 사람이 읽는 진단용 원본 출력. **판정에는 절대 쓰지 않는다** — 리포트가 없을 때만 찍는다. */
  readonly output: string;
}

/** 마지막 리포트에서 읽은 "테스트 fullName → 리포 상대 파일 경로". 기준선 뒤에 표적 → 파일 지도를 만든다. */
const testFileByName = new Map<string, string>();

function readReport(): { readonly allTests: string[]; readonly failedTests: string[] } {
  if (!existsSync(REPORT_FILE)) {
    // 리포트가 없다 = vitest 가 리포트를 쓰기 전에 죽었다. 여기서 stdout 매칭으로
    // 물러나면 이번에 없앤 거짓 양성이 그대로 돌아온다. **판정 불가로 남긴다** —
    // 어떤 표적 이름과도 매칭되지 않으므로 러너가 실패를 보고한다.
    return { allTests: [], failedTests: ['<JSON 리포트 없음 — vitest 가 리포트를 쓰지 못했다. 판정 불가>'] };
  }

  let report: VitestJsonReport;
  try {
    report = JSON.parse(readFileSync(REPORT_FILE, 'utf8')) as VitestJsonReport;
  } catch (error) {
    return { allTests: [], failedTests: [`<JSON 리포트 파싱 실패: ${String(error)}. 판정 불가>`] };
  }

  const allTests: string[] = [];
  const failedTests: string[] = [];
  for (const file of report.testResults ?? []) {
    const assertions = file.assertionResults ?? [];
    for (const assertion of assertions) {
      const name = assertion.fullName ?? '<이름 없음>';
      allTests.push(name);
      if (file.name !== undefined) testFileByName.set(name, toRepoRelative(file.name));
      if (assertion.status === 'failed') failedTests.push(name);
    }
    if (file.status === 'failed' && !assertions.some((assertion) => assertion.status === 'failed')) {
      // 파일이 수집 단계에서 죽었다. 개별 테스트 이름이 없으므로 표적 판정에는 걸리지
      // 않는다 — 그게 옳다. "컴파일이 깨져서 빨간불"은 층이 잡은 것이 아니다.
      const head = (file.message ?? '수집 실패').split('\n')[0] ?? '수집 실패';
      failedTests.push(`${file.name ?? '<파일 미상>'}: ${head}`);
    }
  }
  return { allTests, failedTests };
}

const VITEST_CLI = join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs');

/** 지금 돌고 있는 vitest. 신호 처리기가 이 프로세스 **그룹**을 끝낸다(워커까지). */
let currentChild: ChildProcess | undefined;

/**
 * arch 프로젝트를 돌린다. `files` 가 비어 있으면 전체, 아니면 그 파일들만.
 *
 * `pnpm exec` 를 거치지 않고 vitest CLI 를 **자기 프로세스 그룹**(`detached`)으로 직접 띄운다 — 중단 시 `kill(-pid)` 로
 * 워커까지 한 번에 끝내기 위해서다. pnpm 을 사이에 두면 pnpm 만 죽고 vitest 워커가 고아로 남는 경로가 생긴다.
 * 비동기(`spawn`)인 이유: 동기 실행 중에는 Node 가 신호 처리기를 부르지 못한다 — 처리기가 있어도 되돌릴 기회가 없다.
 */
function runArch(files: readonly string[], maxWorkers?: number): Promise<SuiteRun> {
  rmSync(REPORT_FILE, { force: true });
  const args = [
    VITEST_CLI,
    'run',
    '--project',
    'arch',
    ...files,
    ...(maxWorkers === undefined ? [] : [`--maxWorkers=${maxWorkers}`]),
    '--reporter=default',
    '--reporter=json',
    `--outputFile.json=${REPORT_FILE}`,
  ];
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, args, {
      cwd: REPO_ROOT,
      env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    currentChild = child;
    let output = '';
    const append = (chunk: Buffer): void => {
      output = (output + chunk.toString('utf8')).slice(-200_000);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('close', (code) => {
      currentChild = undefined;
      const report = readReport();
      resolvePromise({ passed: code === 0, allTests: report.allTests, failedTests: report.failedTests, output });
    });
  });
}

// ---------------------------------------------------------------------------
// 잔재 검사 — git 과 파일시스템 두 갈래
// ---------------------------------------------------------------------------

function toRepoRelative(absolute: string): string {
  return relative(REPO_ROOT, absolute).split(sep).join('/');
}

/** 변이가 직접 쓰는 파일 경로. */
function mutationFilePaths(): string[] {
  return [
    ...new Set(
      MUTATIONS.flatMap((mutation) => [
        ...mutation.files.map((file) => file.path),
        ...(mutation.replacements ?? []).map((replacement) => replacement.path),
      ]),
    ),
  ].sort();
}

/**
 * 감시 대상 = 변이 파일 + **그 조상 디렉터리**.
 * 디렉터리를 넣는 이유는 러너가 만든 빈 디렉터리(`src/workers/` 등)를 어떤 git 명령도
 * 보지 못하기 때문이다.
 */
function watchedPaths(): string[] {
  const files = mutationFilePaths();
  const all = new Set<string>(files);
  for (const file of files) {
    let current = dirname(join(REPO_ROOT, file));
    while (current !== REPO_ROOT && current.startsWith(REPO_ROOT)) {
      all.add(toRepoRelative(current));
      current = dirname(current);
    }
  }
  return [...all].sort();
}

/** 존재하지 않으면 `null`, 디렉터리면 `'<dir>'`, 파일이면 내용 해시. */
function fingerprint(relativePath: string): string | null {
  const absolute = join(REPO_ROOT, relativePath);
  if (!existsSync(absolute)) return null;
  if (statSync(absolute).isDirectory()) return '<dir>';
  return createHash('sha256').update(readFileSync(absolute)).digest('hex');
}

/** 실행 **전**의 지문. 실행 후와 비교해 잔재를 판정한다. */
function snapshotFingerprints(paths: readonly string[]): Map<string, string | null> {
  return new Map(paths.map((path) => [path, fingerprint(path)]));
}

/**
 * 러너가 남긴 잔재.
 *
 * **`git status` 를 쓰지 않는다.** 두 가지를 구분하지 못하기 때문이다:
 *   ① 변이 E 의 산출물(`cdk.out/**`)과 빈 디렉터리는 gitignore·git 의 구조상
 *      **영원히 보이지 않는다** — 그 변이에 대해 검사가 항상 공백이었다.
 *   ② 러너를 돌리기 전부터 더러운 파일(다른 사람이 같은 트리에서 작업 중인 경우)을
 *      러너의 잔재로 오인한다.
 * 대신 실행 전 지문과 직접 대조한다. "내가 건드린 경로가 내가 본 그대로 돌아왔는가"
 * 만 묻는 것이고, 그게 이 검사가 실제로 보증하려는 명제다.
 * (CI 는 깨끗한 체크아웃이므로 `git diff --exit-code` 스텝이 git 층의 보증을 따로 준다.)
 */
function leftovers(before: Map<string, string | null>): string[] {
  const residue: string[] = [];

  for (const [path, expected] of before) {
    const actual = fingerprint(path);
    if (actual === expected) continue;

    if (expected === null) residue.push(`${path}: 변이 산출물이 남아 있다 (실행 전에는 없던 경로다)`);
    else if (actual === null) residue.push(`${path}: 원래 있던 경로가 사라졌다 (복구 실패)`);
    else residue.push(`${path}: 내용이 실행 전과 다르다 (복구 실패)`);
  }

  return residue;
}

// ---------------------------------------------------------------------------
// 사전 점검
// ---------------------------------------------------------------------------

/**
 * `test/arch/**` 의 `.test.ts` 전부.
 * **`git ls-files` 가 아니라 디스크를 읽는다** — 미추적 파일의 스킵 마커가 검사되지
 * 않으면 "새로 추가한 층을 `.skip` 으로 넣고 커밋 전에 green 을 확인" 하는 경로가 열린다.
 */
function archTestFiles(): string[] {
  const root = join(REPO_ROOT, 'test', 'arch');
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.test.ts')) out.push(full);
    }
  };
  if (existsSync(root)) walk(root);
  return out.sort();
}

/**
 * 사전 점검 — `test/arch/**` 에 스킵/단독 실행 마커가 없어야 한다.
 * 마커 문자열을 조립해서 만든다. 리터럴로 적으면 이 파일 자신이 걸린다.
 */
function skippedArchTests(): string[] {
  const markers = ['skip', 'only', 'todo'].flatMap((suffix) =>
    ['it', 'test', 'describe'].map((fn) => `${fn}.${suffix}`),
  );

  const offenders: string[] = [];
  for (const file of archTestFiles()) {
    const content = readFileSync(file, 'utf8');
    for (const marker of markers) if (content.includes(marker)) offenders.push(`${toRepoRelative(file)}: ${marker}`);
  }
  return offenders;
}

/**
 * 표적 이름이 서로를 포함하면 테스트 단위 판정이 다시 흐려진다.
 * 기준선(전부 통과)에서는 드러나지 않으므로 이름끼리 직접 대조한다.
 */
function assertDistinctTargets(): void {
  const clashes: string[] = [];
  for (const mutation of MUTATIONS) {
    if (mutation.targetTest.trim().length === 0) {
      clashes.push(`${mutation.id}: targetTest 가 비어 있다`);
      continue;
    }
    for (const other of MUTATIONS) {
      if (other.id === mutation.id) continue;
      if (other.targetTest.includes(mutation.targetTest)) {
        clashes.push(`${mutation.id} 의 표적 이름이 ${other.id} 의 표적 이름에도 포함된다`);
      }
    }
  }
  if (clashes.length > 0) {
    console.error('✗ 변이 표적이 겹친다 — 테스트 단위 판정이 무의미해진다:');
    for (const clash of clashes) console.error(`  - ${clash}`);
    process.exit(1);
  }
}

/**
 * 표적 **실재성** 검사 — 기준선이 실제로 돌린 테스트 중에 각 표적이 정확히 하나 있어야 한다.
 *
 * 이게 없으면 표적 이름에 오타가 나거나 테스트 제목이 바뀐 순간, 그 변이는
 * "겨냥한 단언이 안 걸렸다"로 매 실행 실패하거나(운이 좋을 때) — 더 나쁘게는
 * 이름이 다른 테스트에 걸려 엉뚱한 층의 빨간불을 통과 근거로 삼는다.
 */
function assertTargetsExist(baseline: SuiteRun): void {
  const problems: string[] = [];
  for (const mutation of MUTATIONS) {
    const hits = baseline.allTests.filter((name) => name.includes(mutation.targetTest));
    if (hits.length !== 1) {
      problems.push(`${mutation.id}: 표적 "${mutation.targetTest}" 이 기준선에서 ${hits.length}개 테스트와 매칭된다 (1개여야 한다)`);
    }
  }
  if (problems.length > 0) {
    console.error('✗ 변이 표적이 실재하지 않거나 모호하다 — 그 변이는 아무것도 증명하지 못한다:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// 선택 — `--only`·`--affected`
// ---------------------------------------------------------------------------

interface Options {
  readonly only: readonly string[] | undefined;
  readonly affected: boolean;
}

function parseOptions(argv: readonly string[]): Options {
  let only: string[] | undefined;
  let affected = false;
  for (const arg of argv) {
    if (arg.startsWith('--only=')) {
      only = arg
        .slice('--only='.length)
        .split(',')
        .map((id) => id.trim())
        .filter((id) => id.length > 0);
    } else if (arg === '--affected') affected = true;
    else {
      console.error(`✗ 알 수 없는 인자: ${arg} (쓸 수 있는 것: --only=<id,...> · --affected)`);
      process.exit(2);
    }
  }
  if (only !== undefined) {
    const known = new Set(MUTATIONS.map((mutation) => mutation.id));
    const unknown = only.filter((id) => !known.has(id));
    if (only.length === 0 || unknown.length > 0) {
      console.error(`✗ --only 에 카탈로그에 없는 id 가 있다: ${unknown.join(', ') || '(비어 있음)'}`);
      process.exit(2);
    }
  }
  return { only, affected };
}

/** HEAD 대비 바뀐 경로(스테이징·워킹트리·미추적). 리포 상대 경로. */
function changedPaths(): Set<string> {
  const git = (args: string[]): string[] => {
    const result = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} 실패: ${result.stderr}`);
    return result.stdout.split('\n').filter((line) => line.length > 0);
  };
  return new Set([...git(['diff', '--name-only', 'HEAD']), ...git(['ls-files', '--others', '--exclude-standard'])]);
}

function mutationPaths(mutation: Mutation): string[] {
  return [...mutation.files.map((file) => file.path), ...(mutation.replacements ?? []).map((r) => r.path)];
}

/**
 * 이 경로가 바뀌면 어느 변이든 판정이 흔들릴 수 있다 — `--affected` 가 전부를 고른다.
 * 전역 경로(러너 설정·의존성·arch 공용 도구)는 `test/modules.ts` 의 `GLOBAL_PATHS` 와 같다.
 */
function touchesEveryMutation(path: string): boolean {
  return isGlobalPath(path) || path.startsWith('test/arch/mutations/');
}

/**
 * 바뀐 파일이 이 변이에 닿는가 — ① 변이가 쓰는 경로 자체 ② 표적 테스트 파일 ③ 변이 경로와 **같은 모듈**(`test/modules.ts`)의 파일.
 * ③ 이 있는 이유: 층의 판정은 변이 파일 하나가 아니라 그 모듈의 이웃 코드(허용 목록·import 폐포)에도 기대기 때문이다.
 */
function affectedBy(mutation: Mutation, changed: ReadonlySet<string>, changedModules: ReadonlySet<ModuleName>): boolean {
  const paths = mutationPaths(mutation);
  return (
    paths.some((path) => changed.has(path)) ||
    changed.has(targetFileOf(mutation)) ||
    paths.some((path) => modulesOfPath(path).some((name) => changedModules.has(name)))
  );
}

function targetFileOf(mutation: Mutation): string {
  const hits = [...testFileByName].filter(([name]) => name.includes(mutation.targetTest));
  // assertTargetsExist 가 "정확히 1개" 를 이미 보증한다. 여기서 어긋나면 러너 자신의 결함이다.
  if (hits.length !== 1) throw new Error(`[${mutation.id}] 표적 파일을 정하지 못했다 (${hits.length}개 매칭)`);
  return hits[0]![1];
}

// ---------------------------------------------------------------------------
// 중단 처리 — 신호·예외에서 현재 변이를 되돌린다
// ---------------------------------------------------------------------------

/** 지금 워킹트리에 걸려 있는 변이의 흔적. 변이 사이에는 `undefined`. */
let activeTrace: Trace | undefined;
let aborting = false;

function abort(reason: string, exitCode: number): never {
  if (!aborting) {
    aborting = true;
    console.error(`\n✗ 러너 중단 (${reason}) — 현재 변이를 되돌린다.`);
    if (currentChild?.pid !== undefined) {
      try {
        process.kill(-currentChild.pid, 'SIGKILL');
      } catch {
        // 이미 끝났다.
      }
    }
    if (activeTrace !== undefined) {
      try {
        revert(activeTrace);
        console.error('  복구 완료.');
      } catch (error) {
        console.error(`  ✗ 복구 실패 — 워킹트리를 직접 확인하라 (git status): ${String(error)}`);
      }
      activeTrace = undefined;
    }
    rmSync(REPORT_DIR, { recursive: true, force: true });
  }
  process.exit(exitCode);
}

function installAbortHandlers(): void {
  const signals: [NodeJS.Signals, number][] = [
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGHUP', 129],
  ];
  for (const [signal, code] of signals) process.on(signal, () => abort(signal, code));
  process.on('uncaughtException', (error) => abort(`예외: ${String(error)}`, 1));
  process.on('unhandledRejection', (error) => abort(`거부된 약속: ${String(error)}`, 1));
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  installAbortHandlers();
  const options = parseOptions(process.argv.slice(2));

  assertDistinctTargets();

  const skipped = skippedArchTests();
  if (skipped.length > 0) {
    console.error('✗ arch 테스트에 스킵 마커가 있다 — 층이 꺼진 채로 green 이 된다:');
    for (const offender of skipped) console.error(`  - ${offender}`);
    process.exit(1);
  }

  const changed = options.affected ? changedPaths() : new Set<string>();
  const changedModules = new Set([...changed].flatMap(modulesOfPath));
  if (options.affected) {
    const mutationModules = new Set(MUTATIONS.flatMap((m) => mutationPaths(m).flatMap(modulesOfPath)));
    const anyRelevant = [...changed].some(
      (path) =>
        touchesEveryMutation(path) ||
        path.startsWith('test/arch/') ||
        MUTATIONS.some((m) => mutationPaths(m).includes(path)) ||
        modulesOfPath(path).some((name) => mutationModules.has(name)),
    );
    if (!anyRelevant) {
      console.log('✓ --affected: HEAD 대비 바뀐 파일 중 변이 대상·arch 테스트가 없다 — 돌릴 변이 0종.');
      rmSync(REPORT_DIR, { recursive: true, force: true });
      return;
    }
  }

  const watched = watchedPaths();
  const fingerprintsBefore = snapshotFingerprints(watched);

  // 기준선은 **변이 적용 전, 깨끗한 트리에서** 잰다. 이 순서가 어긋나면 이후 판정 전부가 무의미하다.
  // 전체 arch 를 한 번 돌린다 — 표적 이름 → 파일 지도도 여기서 만든다.
  const baseline = await runArch([]);
  if (!baseline.passed) {
    console.error('✗ 기준선(변이 없음)에서 arch 스위트가 이미 실패한다. 변이 검증 이전의 문제다.');
    for (const failure of baseline.failedTests) console.error(`  × ${failure}`);
    if (baseline.allTests.length === 0) console.error(baseline.output.slice(-3000));
    process.exit(1);
  }
  console.log(`✓ 기준선: 변이 없는 상태에서 arch 스위트 green (테스트 ${baseline.allTests.length}개)\n`);

  assertTargetsExist(baseline);

  const everything = options.affected && [...changed].some(touchesEveryMutation);
  const selected = MUTATIONS.filter((mutation) => {
    if (options.only !== undefined && !options.only.includes(mutation.id)) return false;
    if (options.affected && !everything) {
      return affectedBy(mutation, changed, changedModules);
    }
    return true;
  });
  const partial = selected.length !== MUTATIONS.length;
  if (partial) console.log(`변이 ${selected.length}/${MUTATIONS.length}종만 돌린다: ${selected.map((m) => m.id).join(', ') || '(없음)'}\n`);

  const failures: string[] = [];

  for (const mutation of selected) {
    const trace = newTrace();
    activeTrace = trace;
    try {
      applyMutation(mutation, trace);
      const run = await runArch([targetFileOf(mutation)], 2);
      // **판정은 여기 한 줄이다.** 표적 테스트가 *실패 목록*에 있는가.
      // 통과한 테스트의 이름은 이 목록에 애초에 들어오지 않는다 — 그게 stdout 매칭과의 차이다.
      const matched = run.failedTests.filter((name) => name.includes(mutation.targetTest));

      if (run.passed) {
        failures.push(
          `${mutation.id} (Layer ${mutation.targetLayer}): 변이를 넣었는데 스위트가 통과했다 — 그 층은 잠들어 있다`,
        );
        console.error(`✗ ${mutation.id} — Layer ${mutation.targetLayer} 가 잡지 못했다: ${mutation.description}`);
      } else if (matched.length === 0) {
        failures.push(
          `${mutation.id} (Layer ${mutation.targetLayer}): 스위트는 실패했지만 **표적 테스트는 통과했다** (표적: ${mutation.targetTest})`,
        );
        console.error(`✗ ${mutation.id} — 다른 테스트가 대신 실패했다. 표적 단언은 걸리지 않았다.`);
        console.error(`  표적: ${mutation.targetTest}`);
        console.error('  실제로 실패한 테스트:');
        for (const failure of run.failedTests) console.error(`    × ${failure}`);
        if (run.allTests.length === 0) console.error(run.output.slice(-2000));
      } else {
        console.log(`✓ ${mutation.id} — Layer ${mutation.targetLayer} 가 잡았다: ${mutation.description}`);
        for (const name of matched) console.log(`    × ${name}`);
      }
    } catch (error) {
      failures.push(`${mutation.id}: 변이 적용 중 오류 — ${String(error)}`);
      console.error(`✗ ${mutation.id} — 변이 적용 실패: ${String(error)}`);
    } finally {
      // 예외 경로에서도 반드시 돈다. 부분 적용도 흔적에 쌓여 있으므로 함께 되돌린다.
      revert(trace);
      activeTrace = undefined;
    }
  }

  const residue = leftovers(fingerprintsBefore);
  if (residue.length > 0) {
    failures.push(`워킹트리에 변이 잔재가 남았다: ${residue.join(', ')}`);
    console.error('✗ 변이 잔재:');
    for (const line of residue) console.error(`  ${line}`);
  }

  // 복구 확인: 전부 돌렸으면 전체 arch, 일부만 돌렸으면 그 표적 파일들.
  const afterFiles = partial ? [...new Set(selected.map(targetFileOf))].sort() : [];
  const after = partial && afterFiles.length === 0 ? undefined : await runArch(afterFiles);
  if (after !== undefined && !after.passed) {
    failures.push('복구 후 기준선이 green 이 아니다');
    console.error('✗ 변이 복구 후에도 스위트가 실패한다 — 워킹트리에 잔해가 남았을 수 있다.');
    for (const failure of after.failedTests) console.error(`  × ${failure}`);
  }

  rmSync(REPORT_DIR, { recursive: true, force: true });

  if (failures.length > 0) {
    console.error(`\n✗ Layer F 실패 ${failures.length}건:`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }

  const scope = partial ? `선택된 변이 ${selected.length}종(전체 ${MUTATIONS.length}종 중)` : `변이 ${MUTATIONS.length}종`;
  console.log(`\n✓ Layer F: ${scope} 전부를 겨냥한 층이 잡았다. 잔재 0, 복구 후 기준선 green.`);
}

void main();
