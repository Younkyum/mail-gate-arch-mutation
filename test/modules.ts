/**
 * 테스트 모듈 지도 — `pnpm test:mod` · `pnpm test:changed` · 변이 러너 `--affected` 가 함께 쓴다.
 *
 *   - `sources` : 모듈의 소스(와 전용 테스트 도우미) 경로 접두사 — 바뀐 파일 → 모듈.
 *   - `tests`   : unit·integration 테스트 경로 접두사(디렉터리는 `/` 로 끝낸다) 또는 파일.
 *   - `arch`    : 모듈의 경로를 본문에 적은 arch 테스트.
 *
 * 어느 모듈에도 속하지 않는 `.test.ts` 는 `test:mod`·`test:changed` 로 영영 돌지 않으므로 없어야 한다(`test/unit/meta/test-modules.test.ts`).
 * 전 src 를 훑는 arch 층은 일부 모듈에만 묶여 있으므로 배포 전에는 `pnpm test` · `pnpm test:coverage` 를 돌린다.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface TestModule {
  readonly sources: readonly string[];
  readonly tests: readonly string[];
  readonly arch: readonly string[];
}

const A = (name: string): string => `test/arch/${name}.arch.test.ts`;

export const MODULES = {
  admin: {
    // `src/ui/` — 콘솔·홈이 같이 쓰는 자체 호스팅 폰트(Pretendard, `scripts/gen-fonts.ts` 가 생성).
    // `scripts/ops-web/` — 운영자 웹 화면(`pnpm admin:web`, 로컬 전용). CLI 와 같은 연산을 부른다.
    sources: ['src/admin/', 'src/ops/', 'scripts/admin/', 'scripts/redteam-eval.ts', 'scripts/ops-web/', 'test/support/theme-contrast.ts', 'src/ui/', 'scripts/gen-fonts.ts'],
    tests: ['test/unit/admin/', 'test/integration/admin/', 'test/integration/signup/', 'test/unit/ui/', 'test/unit/ops-web/', 'test/integration/ops-web/', 'test/unit/ops/', 'test/integration/ops/'],
    arch: [A('admin-separation'), A('gate-chokepoint'), A('sender-marks-surface'), A('policy-v2'), A('ops-web-local-only'), A('ops-console-separation'), A('ai-watch-boundary'), A('redteam-export-allowlist')],
  },
  docs: {
    // 사용자 문서(docs.atmark.ai). `src/ui/`(폰트·토큰·파비콘) · `src/billing/plans.ts`(한도 표) · `src/mcp/tools.ts`(도구 이름 대조) ·
    // `src/site/`(옮겨 적은 팔레트·상수 대조, 머리·꼬리의 Docs 링크)가 바뀌어도 문서 테스트를 돌린다.
    sources: [
      'src/docs/',
      'scripts/gen-docs.ts',
      'scripts/gen-docs-shots.ts',
      'scripts/docs-veil.ts',
      'scripts/ui/docs-preview.ts',
      'src/ui/',
      'src/billing/plans.ts',
      'src/mcp/tools.ts',
      'src/site/',
      'infra/cdk/stacks/docs-',
      'src/runtime/handlers/docs.ts',
    ],
    tests: ['test/unit/docs/', 'test/unit/infra/docs-', 'test/unit/site/copy-guard.test.ts', 'test/unit/site/blog.test.ts'],
    arch: [],
  },
  // AI 의심 메일 감시 Mac 워커(설계 ai-mail-watch §5) — 모델까지 도는 대조는 `pnpm ai-watch:selftest` · `pnpm ai-watch:e2e`(네이티브 · 모델 필요).
  'ai-watch-worker': {
    sources: ['ops/ai-watch/', 'src/inbound/ai-watch/contract.ts'],
    tests: ['test/unit/ai-watch-worker/'],
    arch: [A('ai-watch-boundary')],
  },
  api: {
    sources: ['src/api/'],
    tests: ['test/unit/api/', 'test/integration/api/', 'test/integration/outbound/'],
    arch: [
      A('inbound-visibility'),
      A('mcp-adapter'),
      A('deny-all-matrix'),
      A('outbound-entrypoint-partition'),
      A('passport-public-surface'),
      A('policy-v2'),
      A('verification-boundary'),
    ],
  },
  approval: {
    sources: ['src/approval/'],
    tests: ['test/unit/approval/', 'test/integration/approval/', 'test/integration/signup/'],
    arch: [A('approval-boundary'), A('mcp-adapter'), A('verification-boundary')],
  },
  billing: {
    // 요금제(ADR-0011) + Paddle 웹훅·sync λ · 결제 저장소 · 엔타이틀먼트 쓰기 · 마이그레이션 202609250400.
    sources: [
      'src/billing/',
      'test/support/entitlements.ts',
      'src/runtime/handlers/billing-',
      'src/runtime/billing-',
      'src/db/repositories/billing.ts',
      'src/db/repositories/entitlements-write.ts',
      'src/db/migrations/202609250400_billing_provider.sql',
    ],
    tests: [
      'test/unit/billing/',
      'test/integration/billing/',
      'test/unit/runtime/billing-',
      'test/unit/policy/entitlement-limits.test.ts',
      'test/integration/db/org-entitlements.test.ts',
      'test/integration/db/billing-provider.test.ts',
      'test/integration/admin/plan.test.ts',
      'test/integration/admin/billing-routes.test.ts',
      'test/integration/signup/org-review-cli.test.ts',
      'test/unit/admin/admin-console-billing.test.ts',
    ],
    arch: [A('transparency-log'), A('billing-boundary'), A('network-egress')],
  },
  contact: {
    sources: ['src/contact/'],
    tests: ['test/unit/contact/'],
    arch: [A('contact-forward')],
  },
  // 고객 도메인(ADR-0014) — 계약·이름 판정·PSL 스냅샷(생성기 포함). DB 가드·claim 통합 테스트는 db 모듈에도 속한다(`test/integration/db/`).
  domains: {
    sources: ['src/domains/', 'scripts/update-psl.ts'],
    tests: [
      'test/unit/domains/',
      'test/unit/identity/address-domains.test.ts',
      'test/unit/tlog/domain-leaf.test.ts',
      'test/integration/db/custom-domains-triggers.test.ts',
      'test/integration/db/mail-identity-claims.test.ts',
      // 단계 4(M3a) — 틱 · 사가 · 양도 · 대표 주소 포인터 · 앵커 이름.
      'test/integration/domains/',
      'test/unit/identity/primary.test.ts',
    ],
    arch: [A('tlog-kind-check'), A('transparency-log'), A('domain-tick-boundary')],
  },
  db: {
    sources: ['src/db/'],
    // `test/integration/billing/` 은 billing 모듈에만 둔다 — 겹치면 `test:mod db`·`test:mod billing` 동시 실행 때
    //   reconcile 테스트가 싱글턴 행 `billing_reconcile_state` 를 서로 덮는다.
    tests: ['test/integration/db/', 'test/integration/runtime/'],
    arch: [
      A('approval-boundary'),
      A('policy-v2'),
      A('inbound-visibility'),
      A('observability-pii'),
      A('transparency-log'),
      A('tlog-kind-check'),
      A('keypair-immutability'),
      A('passport-public-surface'),
      A('sender-marks-surface'),
    ],
  },
  gate: {
    sources: ['src/gate/'],
    tests: ['test/unit/gate/', 'test/integration/gate/', 'test/integration/outbound/'],
    arch: [A('gate-chokepoint'), A('deny-all-matrix')],
  },
  identity: {
    sources: ['src/identity/'],
    // 적대적 검증 D — 자가 등록.
    tests: ['test/unit/identity/', 'test/unit/adversarial/watch-d-enroll.test.ts', 'test/integration/adversarial/watch-d-enroll'],
    arch: [A('keypair-immutability'), A('operator-reserved-address')],
  },
  // 감시 탭 받기 등급(ADR-0016 2026-10-08) — 설정 계약 · 수신 소비자의 등급/우회/보류 · 콘솔 API.
  watch: {
    sources: ['src/watch/', 'src/admin/routes/watch.ts', 'src/admin/ops/watch.ts', 'src/db/repositories/watch-settings-store.ts', 'src/security/levels.ts'],
    // 적대적 검증 A·D — 접두사 `watch-` 가 둘 다 덮는다.
    tests: [
      'test/unit/watch/',
      'test/unit/security/levels.test.ts',
      'test/integration/inbound/watch-levels.test.ts',
      'test/integration/admin/admin-watch.test.ts',
      'test/unit/adversarial/watch-',
      'test/integration/adversarial/watch-',
    ],
    arch: [A('inbound-scan-always'), A('inbound-visibility')],
  },
  // 실시간 WebSocket(묶음 E) — 연결 · 인증 · 힌트 푸시 · 연결 표(202610081300) · 실시간 λ · 전송단.
  realtime: {
    sources: [
      'src/realtime/',
      'src/db/repositories/realtime-connection-store.ts',
      'src/runtime/handlers/realtime.ts',
      'src/runtime/realtime-pusher.ts',
      'src/runtime/realtime-transport.ts',
      'src/db/migrations/202610081300_realtime_connections.sql',
      'src/db/migrations/202610081301_realtime_live_cap_review.sql',
    ],
    tests: ['test/unit/realtime/', 'test/integration/realtime/', 'test/unit/adversarial/realtime-', 'test/integration/adversarial/realtime-'],
    arch: [A('network-egress'), A('inbound-visibility')],
  },
  inbound: {
    sources: ['src/inbound/'],
    tests: ['test/unit/inbound/', 'test/integration/inbound/'],
    arch: [A('inbound-visibility'), A('network-egress'), A('ai-watch-boundary')],
  },
  infra: {
    // `src/runtime/config.ts`(`RUNTIME_ENV` — 스택 테스트가 λ 환경 이름을 이것으로 단언) · `src/billing/constants.ts`(`PAY_HOST` 인증서 · 환경 기본값).
    sources: ['infra/', 'cdk.json', 'test/unit/infra/runtime-app.ts', 'src/runtime/config.ts', 'src/billing/constants.ts'],
    tests: [
      'test/unit/infra/',
      'test/unit/inbound/inbound-stack.test.ts',
      'test/unit/storage/storage-stack.test.ts',
      'test/unit/notify/approval-page-url.test.ts',
      'test/integration/admin/login-principal-separation.test.ts',
    ],
    arch: [A('iam-single-principal'), A('observability-alarms')],
  },
  mail: {
    sources: ['src/mail/', 'test/fixtures/eml/', 'test/fixtures/verification/'],
    // 적대적 검증 D — 가입 감지.
    tests: ['test/unit/mail/', 'test/integration/outbound/', 'test/unit/adversarial/watch-d-signup.test.ts', 'test/integration/adversarial/watch-d-signup.test.ts'],
    arch: [A('ses-import-boundary'), A('gate-chokepoint'), A('iam-single-principal'), A('verification-boundary'), A('inbound-visibility')],
  },
  mcp: {
    sources: ['src/mcp/'],
    tests: ['test/unit/mcp/', 'test/integration/mcp/'],
    arch: [A('mcp-adapter'), A('outbound-entrypoint-partition'), A('inbound-visibility')],
  },
  meta: {
    sources: ['test/modules.ts', 'test/run-modules.ts', 'test/support/integration-global-setup.ts'],
    tests: ['test/unit/meta/'],
    arch: [],
  },
  notify: {
    // `src/i18n/` — 시스템 메일 언어 등록부(202610101000 — 템플릿 사전 · 알림기 · 콘솔 설정이 함께 쓴다).
    sources: ['src/notify/', 'src/i18n/'],
    tests: ['test/unit/notify/', 'test/integration/signup/', 'test/unit/site/copy-guard.test.ts'],
    arch: [A('gate-chokepoint'), A('contact-forward'), A('admin-separation')],
  },
  observability: {
    sources: ['src/observability/'],
    tests: ['test/unit/observability/'],
    arch: [A('observability-pii'), A('observability-alarms')],
  },
  passport: {
    sources: ['src/passport/', 'test/fixtures/passport/'],
    tests: ['test/unit/passport/', 'test/integration/passport/'],
    arch: [A('keypair-immutability'), A('passport-public-surface'), A('passport-signer-isolation')],
  },
  policy: {
    sources: ['src/policy/'],
    // 적대적 검증 D — 발신 승인.
    tests: ['test/unit/policy/', 'test/integration/db/policy-', 'test/integration/outbound/deny-all-matrix.test.ts', 'test/integration/policy/', 'test/unit/adversarial/watch-d-send-approval.test.ts', 'test/integration/adversarial/watch-d-send-approval.test.ts', 'test/integration/adversarial/policy-request-'],
    arch: [
      A('deny-all-matrix'),
      A('policy-v2'),
      A('approval-boundary'),
      // ADR-0016 — 위험 신호는 로더(별도 포트)로만 · 판정 쪽 폐포에 저장소 없음.
      A('risk-signals'),
      // ADR-0017 — AI 감시 신호는 경고 표시만 · 판정 쪽 폐포에 ai-watch 모듈 · SQL 없음.
      A('ai-watch-boundary'),
      A('gate-chokepoint'),
      A('outbound-entrypoint-partition'),
      A('sender-marks-surface'),
      A('verification-boundary'),
    ],
  },
  runtime: {
    // `scripts/build-lambda.ts` — 핸들러 목록·번들 옵션(`bundle.test.ts` 가 읽는다) · `src/billing/constants.ts` — `config.ts` 의 결제 환경 형식.
    sources: ['src/runtime/', 'scripts/build-lambda.ts', 'src/billing/constants.ts'],
    tests: ['test/unit/runtime/', 'test/integration/runtime/'],
    arch: [A('admin-separation'), A('network-egress'), A('passport-signer-isolation'), A('transparency-log'), A('gate-chokepoint')],
  },
  security: {
    sources: ['src/security/', 'test/fixtures/injection/', 'test/fixtures/exfil/', 'test/support/injection-doubles.ts'],
    // `test/unit/policy/risk-hold.test.ts` — 위험 보류(ADR-0016)가 DLP 계열(`src/security/dlp/scan.ts`)을 사유로 옮긴다.
    // `test/integration/security/` — ADR-0016 M1·M2 배선을 끝에서 끝까지(노출 · DLP · 위험 보류 · once · 적대 코퍼스 `test/fixtures/exfil/`).
    tests: ['test/unit/security/', 'test/integration/signup/', 'test/unit/policy/risk-hold.test.ts', 'test/integration/security/'],
    arch: [A('security-boundary'), A('security-trust'), A('injection-holdout-seal'), A('network-egress'), A('risk-signals'), A('ai-watch-boundary')],
  },
  site: {
    // `src/billing/constants.ts` — `pay.atmark.ai` 페이지의 호스트·환경(WP-2 · D-1).
    // `src/ui/` — 콘솔과 같이 쓰는 자체 호스팅 폰트.
    // 블로그(2026-10-01) — 생성기(`scripts/blog/`, `gen-blog*.ts`)와 글 픽스처.
    sources: [
      'src/site/',
      'test/support/theme-contrast.ts',
      'test/support/copy-guard.ts',
      'test/support/site-html.ts',
      'src/billing/constants.ts',
      'src/ui/',
      'scripts/gen-fonts.ts',
      'scripts/blog/',
      'scripts/gen-blog.ts',
      'scripts/gen-blog-images.ts',
      'test/fixtures/blog/',
    ],
    tests: ['test/unit/site/', 'test/unit/ui/'],
    arch: [],
  },
  storage: {
    sources: ['src/storage/'],
    tests: ['test/unit/storage/'],
    arch: [A('network-egress')],
  },
  tlog: {
    sources: ['src/tlog/', 'scripts/tlog-verify/', 'scripts/log-verify.ts', 'test/support/tlog-'],
    tests: ['test/unit/tlog/', 'test/integration/tlog/'],
    arch: [A('transparency-log'), A('tlog-kind-check')],
  },
  webhooks: {
    sources: ['src/webhooks/'],
    // 인증 헤더 적대 검증(202610141400 — 헤더 주입 · 봉인 변조 · 결속 우회 · 누출).
    tests: ['test/unit/webhooks/', 'test/integration/webhooks/', 'test/unit/adversarial/webhook-authorization.test.ts'],
    // `inbound-visibility` ⑤ — 웹훅 소스에 `policy_blocked` 리터럴 0(메일 기본기 AC-A4-3).
    arch: [A('network-egress'), A('inbound-visibility')],
  },
  workers: {
    sources: ['src/workers/'],
    tests: ['test/unit/workers/', 'test/integration/workers/', 'test/integration/adversarial/platform-reputation.test.ts'],
    arch: [A('approval-boundary'), A('outbound-entrypoint-partition'), A('gate-chokepoint'), A('verification-boundary'), A('inbound-scan-always')],
  },
} as const satisfies Record<string, TestModule>;

export type ModuleName = keyof typeof MODULES;
export const MODULE_NAMES = Object.keys(MODULES).sort() as ModuleName[];

/**
 * 바뀌면 **어느 모듈 지도로도 범위를 좁힐 수 없는** 경로 — `test:changed` 는 전부를 돌린다.
 * 테스트 러너 설정·의존성·arch 공용 도구가 여기 든다.
 */
export const GLOBAL_PATHS: readonly string[] = [
  'package.json',
  'pnpm-lock.yaml',
  'tsconfig.json',
  'vitest.config.ts',
  'test/arch/support/',
];

/**
 * 핵심 테스트 — 사용자 기능에 직결된 여정. `pnpm test:core`(= `test:mod --core` + Python SDK)가 정리·리팩터링 때 동작 보존의 기준선이다.
 */
export const CORE_TESTS: readonly string[] = [
  // 로그인 · 토큰
  'test/integration/admin/login-code.test.ts',
  'test/integration/admin/login-link-invalidation.test.ts',
  'test/integration/admin/cross-site-auth.test.ts',
  'test/unit/security/login-code.test.ts',
  'test/unit/security/login-limits.test.ts',
  'test/integration/admin/admin-tokens.test.ts',
  'test/integration/admin/admin-token-rotate.test.ts',
  'test/integration/api/agent-token-touch.test.ts',
  'test/integration/admin/agent-enroll.test.ts',
  'test/integration/adversarial/watch-d-enroll.test.ts',
  'test/unit/admin/org-api-auth.test.ts',
  // 발송 · 정책 · 승인
  'test/integration/outbound/send.test.ts',
  'test/integration/outbound/postgres-send.test.ts',
  'test/integration/outbound/deny-all-matrix.test.ts',
  'test/integration/outbound/send-approval.test.ts',
  'test/integration/outbound/idempotency-key.test.ts',
  'test/integration/outbound/ses-events.test.ts',
  'test/integration/approval/approval-flow.test.ts',
  'test/integration/approval/approval-link-uses.test.ts',
  'test/integration/db/policy-v2-db.test.ts',
  'test/integration/security/injection-defense.test.ts',
  'test/unit/policy/engine.table.test.ts',
  'test/unit/policy/risk-hold.test.ts',
  // 수신 · 격리
  'test/integration/inbound/inbound-consumer.test.ts',
  'test/integration/inbound/inbound-policy.test.ts',
  'test/integration/inbound/inbound-scan.test.ts',
  'test/integration/inbound/quarantine-notice.test.ts',
  'test/integration/inbound/sender-trust.test.ts',
  'test/integration/inbound/thread-quarantine-auth.test.ts',
  'test/integration/inbound/inbound-no-body.test.ts',
  'test/integration/adversarial/watch-risk-consumer.test.ts',
  'test/integration/adversarial/watch-trusted-sender-consumer.test.ts',
  'test/integration/workers/ses-event-webhook.test.ts',
  'test/unit/mail/mime-parse.test.ts',
  // API · MCP
  'test/integration/mcp/mcp-server.test.ts',
  'test/integration/inbound/inbound-read-api.test.ts',
  'test/integration/api/inbound-filters.test.ts',
  'test/integration/api/verification-code.test.ts',
  'test/integration/db/drafts-integrity.test.ts',
  'test/unit/mcp/mcp-server.test.ts',
  'test/unit/mcp/mail-basics-tools.test.ts',
  'test/unit/mcp/read-attachment-tool.test.ts',
  'test/unit/mail/verification/extract.test.ts',
  // 웹훅 · 실시간
  'test/integration/webhooks/webhook-v2.test.ts',
  'test/integration/webhooks/webhook-management.test.ts',
  'test/integration/webhooks/webhook-authorization.test.ts',
  'test/integration/realtime/realtime.test.ts',
  'test/integration/adversarial/realtime-lifecycle.test.ts',
  'test/unit/webhooks/dispatcher.test.ts',
  'test/unit/webhooks/authorization.test.ts',
  'test/unit/adversarial/webhook-authorization.test.ts',
  'test/unit/webhooks/signing.test.ts',
  // 알림 · 가입 · 요금제
  'test/integration/admin/owner-login-notifier.test.ts',
  'test/integration/admin/mail-locale.test.ts',
  'test/integration/signup/welcome-mail.test.ts',
  'test/unit/notify/approval-notification-template.test.ts',
  'test/unit/notify/quarantine-notice-template.test.ts',
  'test/integration/signup/waitlist.test.ts',
  'test/integration/admin/signup.test.ts',
  'test/integration/admin/plan.test.ts',
  'test/integration/billing/sync.test.ts',
  'test/unit/billing/paddle-signature.test.ts',
  // 신원(여권)
  'test/integration/passport/publication-flow.test.ts',
  'test/integration/passport/public-view-leakage.test.ts',
  'test/unit/passport/did.test.ts',
  // TypeScript SDK(vitest `sdk` 프로젝트) — Python SDK 는 `pnpm test:core` 가 따로 돈다.
  'sdk/typescript/test/client.test.ts',
  'sdk/typescript/test/contract.test.ts',
  'sdk/typescript/test/realtime.test.ts',
  'sdk/typescript/test/webhooks.test.ts',
];

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export type Project = 'unit' | 'arch' | 'integration' | 'sdk';

export function projectOf(file: string): Project | undefined {
  if (file.startsWith('test/unit/')) return 'unit';
  if (file.startsWith('test/arch/')) return 'arch';
  if (file.startsWith('test/integration/')) return 'integration';
  if (file.startsWith('sdk/typescript/test/')) return 'sdk';
  return undefined;
}

/** 디스크의 `test/**\/*.test.ts` 전부(리포 상대, `/` 구분). */
export function allTestFiles(): string[] {
  const root = join(REPO_ROOT, 'test');
  return readdirSync(root, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.ts'))
    .map((entry) => relative(REPO_ROOT, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort();
}

function matches(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => path === prefix || path.startsWith(prefix));
}

/** 모듈이 고르는 테스트 파일(unit·integration 접두사 + arch 목록). */
export function testsOfModule(name: ModuleName, files: readonly string[] = allTestFiles()): string[] {
  const module: TestModule = MODULES[name];
  return files.filter((file) => matches(file, module.tests) || module.arch.includes(file));
}

/** 파일 하나를 소유하는 모듈들(`sources` 또는 `tests` 접두사). */
export function modulesOfPath(path: string): ModuleName[] {
  return MODULE_NAMES.filter((name) => {
    const module: TestModule = MODULES[name];
    return matches(path, module.sources) || matches(path, module.tests);
  });
}

export function isGlobalPath(path: string): boolean {
  return matches(path, GLOBAL_PATHS);
}

/**
 * 이 경로를 **본문에 적은** arch 테스트 — `src/policy/gate.ts` 가 바뀌면 그 문자열(또는 확장자 뺀 형태)을 품은 arch 파일.
 * 모듈 지도의 arch 목록이 놓친 "특정 파일을 겨냥한" 단언을 줍는다.
 */
export function archTestsReferencing(path: string, files: readonly string[] = allTestFiles()): string[] {
  if (!path.startsWith('src/') && !path.startsWith('infra/') && !path.startsWith('scripts/')) return [];
  const bare = path.replace(/\.ts$/, '');
  return files.filter((file) => {
    if (projectOf(file) !== 'arch') return false;
    const text = readFileSync(join(REPO_ROOT, file), 'utf8');
    return text.includes(bare);
  });
}

export interface ChangedSelection {
  /** 전부를 돌려야 한다(전역 경로가 바뀌었다). */
  readonly everything: boolean;
  readonly modules: readonly ModuleName[];
  /** 모듈 밖에서 직접 고른 테스트 — 바뀐 `.test.ts` 자신 · 바뀐 경로를 적은 arch 테스트. */
  readonly extraTests: readonly string[];
  /** 어느 모듈에도 속하지 않아 무시한 경로(문서 등). */
  readonly ignored: readonly string[];
  readonly files: readonly string[];
}

export function selectForChanged(changed: readonly string[]): ChangedSelection {
  const files = allTestFiles();
  if (changed.some(isGlobalPath)) {
    return { everything: true, modules: MODULE_NAMES, extraTests: [], ignored: [], files };
  }
  const modules = new Set<ModuleName>();
  const extra = new Set<string>();
  const ignored: string[] = [];
  for (const path of changed) {
    if (path.endsWith('.test.ts')) {
      // 바뀐 테스트는 **그 파일만** 돌린다 — 모듈 전체를 끌고 오지 않는다. 지워진 파일은 건너뛴다.
      if (existsSync(join(REPO_ROOT, path))) extra.add(path);
      continue;
    }
    const owners = modulesOfPath(path);
    for (const owner of owners) modules.add(owner);
    const referencing = archTestsReferencing(path, files);
    for (const file of referencing) extra.add(file);
    if (owners.length === 0 && referencing.length === 0) {
      if (path.startsWith('test/arch/mutations/')) continue; // 변이 카탈로그·러너 — `pnpm mutations --affected` 의 몫.
      ignored.push(path);
    }
  }
  const chosen = new Set<string>(extra);
  for (const name of modules) for (const file of testsOfModule(name, files)) chosen.add(file);
  return {
    everything: false,
    modules: [...modules].sort(),
    extraTests: [...extra].sort(),
    ignored: ignored.sort(),
    files: [...chosen].sort(),
  };
}
