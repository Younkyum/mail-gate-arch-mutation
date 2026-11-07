import { configDefaults, defineConfig } from 'vitest/config';

/** 에폭을 닫는 tlog 통합 파일 — 아래 `integration-tlog` 프로젝트(순차). `integration` 프로젝트에서는 뺀다. */
const TLOG_INTEGRATION = 'test/integration/tlog/**/*.test.ts';

/**
 * 세 프로젝트(unit · arch · integration) — 스크립트가 하나씩 **순서대로** 돌린다(`pnpm test` = unit → arch → int, 앞이 빨강이면 멈춘다).
 * vitest 4 는 `vitest.workspace.ts` 를 읽지 않는다 — 프로젝트는 아래 `test.projects` 에 있고(옛 워크스페이스 파일의 세 항목 그대로),
 * 워커 상한·커버리지 같은 전역 옵션은 루트 `test` 에 둔다. 각 프로젝트는 `extends: true` 로 루트 설정을 물려받는다.
 * 세 글롭 밖(`test/<다른 디렉터리>/**`)의 `.test.ts` 는 어느 프로젝트에도 잡히지 않는다 — 새 최상위 테스트 디렉터리를 만들면 여기에 넣는다.
 *
 * **워커 상한.** 기본 워커 수(코어 수 − 1 = 10)로는 arch 22 파일만 돌려도 프로세스 트리 RSS 가 8.7GB 까지 오른다(2026-09-25 실측).
 * 모든 호출(`pnpm vitest run <경로>` 포함)이 `ATMARK_TEST_WORKERS`(기본 4)를 넘지 않는다. 통합은 2 로 더 낮춘다 — **프로젝트 설정으로**:
 * `extends: true` 프로젝트는 루트 `maxWorkers` 를 물려받고 vitest 4 는 프로젝트 값을 CLI `--maxWorkers` 보다 먼저 본다(`resolveMaxWorkers`),
 * 그래서 스크립트의 `--maxWorkers=2` 만으로는 통합이 4 개씩 돌았다(2026-09-28 실측 — `--maxWorkers=1` 에도 동시 4 파일).
 * 워커 상한이 다른 프로젝트는 같은 `sequence.groupOrder` 에 둘 수 없으므로 통합은 groupOrder 1(인자 없는 `vitest run` 에서 unit·arch 뒤).
 * vitest 4 에는 `minWorkers` 가 없다(풀 기본값 forks · 상한만 받는다).
 */
const maxWorkers = Math.max(1, Number.parseInt(process.env['ATMARK_TEST_WORKERS'] ?? '4', 10) || 4);
const integrationWorkers = Math.min(2, maxWorkers);

/**
 * `test:coverage` 는 프로젝트를 하나씩 돌려 blob 으로 모은 뒤 `--merge-reports` 로 합친다. 프로젝트 **하나**의 커버리지로
 * 임계값을 재면 다른 프로젝트가 덮는 줄이 빠져 거짓 빨강이 난다 — 부분 실행(`ATMARK_COVERAGE_PARTIAL=1`)에서는 임계값을 끄고,
 * 합친 결과에서만 잰다. 임계값을 **끄는 경로는 이 환경 변수 하나뿐**이고, 합치는 단계는 그것을 켜지 않는다.
 */
const partialCoverage = process.env['ATMARK_COVERAGE_PARTIAL'] === '1';

/**
 * **동기 테스트의 시간 상한(vitest 4).** vitest 2 는 동기 테스트가 `testTimeout`(기본 5s)을 넘겨도 타이머가 끼어들 틈이 없어 통과시켰고
 * (arch 의 ts-morph 전수 분석 · 커버리지 계측 아래의 조립 루트 대조는 실제로 6–18s 걸렸다), vitest 4 는 끝난 뒤 시간을 재 실패로 친다.
 * 예전 실제 동작(동기 분석은 끝까지 돈다)을 지키되 상한은 둔다: arch 는 늘 30s, 커버리지 실행(`--coverage…`)은 계측이 느려 전 프로젝트 60s.
 * 평소 unit·integration 은 기본 5s 그대로다(비동기 대기의 멈춤을 빨리 잡는다).
 */
const coverageRun = process.argv.some((arg) => arg === '--coverage' || arg.startsWith('--coverage.') || arg.startsWith('--coverage='));
const SYNC_HEAVY_TIMEOUT = coverageRun ? 60_000 : 30_000;

export default defineConfig({
  test: {
    maxWorkers,
    ...(coverageRun ? { testTimeout: SYNC_HEAVY_TIMEOUT } : {}),
    projects: [
      { extends: true, test: { name: 'unit', include: ['test/unit/**/*.test.ts'] } },
      // arch 의 ts-morph 전수 분석은 동기 CPU 작업이라 한 건이 4–7s(커버리지 아래 18s) 걸린다 — 위 `SYNC_HEAVY_TIMEOUT`.
      { extends: true, test: { name: 'arch', include: ['test/arch/**/*.test.ts'], testTimeout: SYNC_HEAVY_TIMEOUT } },
      // SDK(묶음 F) — `sdk/typescript/test`. `pnpm test:sdk`(CI verify 잡). 서버 코드(OpenAPI 정본 · 웹훅 서명)를 읽어 계약을 맞춘다.
      { extends: true, test: { name: 'sdk', include: ['sdk/typescript/test/**/*.test.ts'] } },
      // globalSetup: 지난 실행이 남긴 셀프 가입 조직을 검토 대기열에서 치운다(로컬 DB 에서만 — 파일 머리말).
      {
        extends: true,
        test: {
          name: 'integration',
          maxWorkers: integrationWorkers,
          sequence: { groupOrder: 1 },
          include: ['test/integration/**/*.test.ts'],
          exclude: [...configDefaults.exclude, TLOG_INTEGRATION],
          globalSetup: ['test/support/integration-global-setup.ts'],
        },
      },
      // 에폭을 닫는 tlog 통합 파일 — **한 번에 하나씩, 다른 통합 파일이 다 끝난 뒤** 돈다(`fileParallelism: false` 인 프로젝트는 vitest 4 가
      // 맨 뒤 순차 그룹으로 모은다). 왜: ① 네 파일은 세션 잠금(`test/support/tlog-epoch-test-lock.ts`)으로 어차피 줄을 서는데, vitest 는
      // 지난 실행에서 느렸던·실패한 파일을 먼저 띄우므로 네 파일이 워커를 전부 차지하고 셋은 잠금만 기다리다 beforeAll 상한(300s)에 걸렸다
      // (2026-09-28 실측: 네 파일이 +0s 에 함께 시작, 셋 실패, 하나 807s). ② 에폭 마감은 서열기와 같은 xact 잠금(`TLOG_ADVISORY_LOCK`)을
      // 수 초 쥐므로, 같은 때 outbox 를 비우는 이웃 파일(admin-aliases)이 statement_timeout(10s)에 걸리고, 긴 트랜잭션이
      // migrate-runner 의 `CREATE INDEX CONCURRENTLY` 를 기다리게 했다. 따로 모으면 둘 다 겹치지 않는다.
      {
        extends: true,
        test: {
          name: 'integration-tlog',
          include: [TLOG_INTEGRATION],
          fileParallelism: false,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      ...(partialCoverage ? { reporter: ['text-summary'] } : {}),
      thresholds: partialCoverage ? undefined : {
        // **M12 — P2 Acceptance: 전 Stage ≥95%** (계획 §4.4 P2 열).
        //
        // P1 은 게이트를 "P1 에 구현된 Stage 에 한해" 걸었다 — Stage 7 의 `approval_required`·
        // `reply_only` 가 미구현이라 그 분기를 재면 스텁을 재게 되고, 그것이 계획이 "공허한 통과" 라
        // 부른 것이었다. 그 예외의 흔적이 `gate.ts` 항목의 주석("`pending_approval` 분기가 아직 도달
        // 불가라 한 단계 낮다")이었다. P2 에서 두 분기와 관문의 승인 대기·릴리스 경로가 실제 코드가
        // 됐으므로 **예외를 걷어 내고 `src/policy/**` 전체를 한 줄로 건다.** 파일을 나열하지 않는 이유:
        // 나열하면 새 파일(예: 다음 Stage 규칙)이 목록 밖에서 태어난다 — 글롭은 새 파일을 기본 포함한다.
        'src/policy/**': { branches: 95, statements: 95, functions: 95, lines: 95 },
        // 승인 상태 전이(§3.4). 만료·거절·승인의 조건부 UPDATE 규율이 여기 산다 — Stage 7 과 같은 눈금.
        // `src/approval/**` 가 아니라 파일 하나인 이유: 같은 디렉터리의 다른 모듈(매직링크)은 다른
        // 작업자의 범위이고, 그 파일의 게이트는 그 작업이 정한다.
        'src/approval/service.ts': { branches: 95, statements: 95, functions: 95, lines: 95 },
      },
    },
  },
});
