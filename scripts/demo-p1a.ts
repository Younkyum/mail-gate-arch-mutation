/**
 * `pnpm demo:p1a` — 계획 §6 P1a 의 demo.
 *
 *   ***"아직 아무것도 못 보내지만, 보낼 수 없다는 것이 CI로 증명된다."***
 *
 * > **P1b 이후의 읽는 법.** 위 문장의 앞부분은 이제 사실이 아니다 — `OUTBOUND_ROUTES` 에
 * > 발송 경로 5종이 등록됐고 `send` 는 실동작한다(계획 §6 P1b 8번). 그래도 이 demo 는
 * > 그대로 유효하다: 증명 대상이 "경로가 0개" 가 아니라 **"등록되지 않은 경로는 보낼 수
 * > 없다"** 이기 때문이다. 장면 ② 가 쓰는 `routeId`(`demo_send`)는 매니페스트 밖이며,
 * > 그 전제 자체를 장면 ② 가 먼저 단언한다.
 *
 * 네 장면을 순서대로 보인다:
 *   ① arch 스위트 6층 green
 *   ② deny-all 매트릭스 전건 차단 — 거부 축 6종 × (엔진 판정 + 관문의 SES 호출 0회)
 *   ③ 워밍업 캡(R22)이 코드 상수로 강제됨 — AC-c2
 *   ④ Layer F 가 알려진 위반 전부를 잡음 (개수는 MUTATIONS.length 에서 파생)
 *      — `ATMARK_DEMO_MUTATIONS=affected|skip` 으로 범위를 줄일 수 있다. 그때 판정 문장은 "부분" 이라고 말한다.
 *
 * **실패는 전부 exit 1 이다.** demo 가 빨간불을 보여 주고도 0으로 끝나면, 그 demo 는
 * 계획 §9 시나리오 5("통과를 선언했는데 통과가 아니었다")의 실행본이다.
 */

import { entitlementRow, entitlementsOf } from '../test/support/entitlements';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  AgentPolicyRow,
  AgentRow,
  OrganizationRow,
  PolicyVersionRow,
  SuppressionEntryRow,
} from '../src/db/schema';
import { toAgentId } from '../src/db/schema';
import { evaluate } from '../src/policy/engine';
import { dispatch, unserialized, type AuditEntry, type GateDependencies } from '../src/policy/gate';
import { OUTBOUND_ROUTES } from '../src/policy/manifest';
import { warmupDailyCap } from '../src/policy/rules/limits';
import type { PolicySource, PolicySourceResult } from '../src/policy/policy-loader';
import type { EvaluationContext, ResolvedPolicy } from '../src/policy/types';
// 거부 축의 정의는 Layer D 생성기가 갖는다. demo 가 자기 목록을 따로 들면 축이 하나
// 늘어도 demo 는 조용히 예전 6종만 보여 준다.
import { DENY_AXES, type DenyAxis } from '../test/arch/support/deny-all-matrix';
import { MUTATIONS } from '../test/arch/mutations/catalogue';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const failures: string[] = [];

function section(title: string): void {
  console.log(`\n${'─'.repeat(72)}\n${title}\n${'─'.repeat(72)}`);
}

function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

function run(command: string, args: readonly string[]): { ok: boolean; output: string } {
  const result = spawnSync(command, [...args], { cwd: REPO_ROOT, encoding: 'utf8', stdio: 'pipe' });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

// ---------------------------------------------------------------------------
// 픽스처 — demo 전용. 프로덕션 데이터가 아니다.
// ---------------------------------------------------------------------------

const AGENT_ID = toAgentId('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6');
const ORG_ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-10-15T12:00:00.000Z');
const SENDING_STARTED_AT = new Date('2026-09-01T00:00:00.000Z');
const AGENT_ADDRESS = 'agent@atmark.ai';
const ALLOWED_RECIPIENT = 'friend@example.com';

const organization: OrganizationRow = {
  id: ORG_ID,
  name: 'Atmark demo',
  ses_tenant_id: null,
  billing_status: 'active',
  abuse_freeze: false,
  owner_paused: false,
  review_status: 'active',
  sending_started_at: SENDING_STARTED_AT,
  created_at: NOW,
  updated_at: NOW,
};

const agent: AgentRow = {
  id: AGENT_ID,
  organization_id: ORG_ID,
  name: 'demo-agent',
  status: 'active',
  plan: 'free',
  monthly_budget_cents: 10_000,
  created_at: NOW,
  updated_at: NOW,
};

const policyRow: AgentPolicyRow = {
  agent_id: AGENT_ID,
  outbound_mode: 'allowlist_only', // §4.4 — P1 demo 의 모드
  inbound_mode: 'all',
  require_approval: false,
  limits: { per_minute: 10, per_hour: 100, per_day: 500, recipients_per_message: 10 },
  config_json: {
    max_attachment_bytes_total: 5_000_000,
    allowed_mime_types: ['application/pdf'],
  },
  current_version: 1,
  created_at: NOW,
  updated_at: NOW,
};

const policyVersion: PolicyVersionRow = {
  id: '22222222-2222-4222-8222-222222222222',
  agent_id: AGENT_ID,
  version: 1,
  outbound_mode: 'allowlist_only',
  inbound_mode: 'all',
  // 정책 v2 — 목록은 버전 스냅샷의 `contact_rules`(발신 allow 한 행, 202609241040 — 관문은 스냅샷을 읽는다).
  snapshot: {
    contact_rules: [
      { id: '33333333-3333-4333-8333-333333333333', direction: 'outbound', list: 'allow', kind: 'address', value: ALLOWED_RECIPIENT },
    ],
  },
  created_by: null,
  created_at: NOW,
};

const basePolicy: ResolvedPolicy = {
  agentId: AGENT_ID,
  outboundMode: 'allowlist_only',
  version: 1,
  versionId: policyVersion.id,
  limits: { perMinute: 10, perHour: 100, perDay: 500, recipientsPerMessage: 10 },
  content: { maxAttachmentBytesTotal: 5_000_000, allowedMimeTypes: ['application/pdf'] },
  allowlist: [ALLOWED_RECIPIENT],
  agentRequestedAllowlist: [],
  blocklist: [],
  preApproval: { autoApproveReplyWithinThread: true, autoApproveDomains: [], autoApproveVerificationSenders: false },
  approvalTtlSeconds: 24 * 60 * 60,
  sendApproval: 'auto',
};

const baseContext: EvaluationContext = {
  now: NOW,
  traceId: 'demo-p1a',
  organization: {
    id: ORG_ID,
    billingStatus: 'active',
    abuseFreeze: false,
    ownerPaused: false,
    reviewStatus: 'active',
    sendingStartedAt: SENDING_STARTED_AT,
    entitlements: entitlementsOf('beta'),
  },
  agent: { id: AGENT_ID, status: 'active', boundAddresses: [AGENT_ADDRESS], inactiveAddresses: [], boundDomains: new Map([['atmark.ai', 'platform']]) },
  attempt: {
    routeId: 'demo_send',
    fromAddress: AGENT_ADDRESS,
    recipients: [ALLOWED_RECIPIENT],
    attachments: [],
    threadId: null,
    contentShape: 'other', dlp: [], pinnedTaint: false,
  },
  suppressedRecipients: [],
  sesSuppressedRecipients: [],
  counters: { agentLastMinute: 0, agentLastHour: 0, agentLastDay: 0, orgRecipientsLastDay: 0, domainRecipientsLastDay: 0 },
  sendingDomain: null,
  budget: { monthlyBudgetCents: 10_000, monthToDateSpentCents: 0, thisAttemptCostCents: 10 },
  approval: {
    recipients: [ALLOWED_RECIPIENT],
    thread: null,
    relationships: [],
    grant: null,
    bootstrapGrace: { agentCreatedAt: NOW, outboundSentCount: 0 },
    humanApprovalRequired: null, riskHold: null,
  },
};

/** 거부 축 → 그 축 하나만 비튼 (컨텍스트, 정책) + 기대 사유. */
function scenarioFor(axis: DenyAxis): {
  readonly ctx: EvaluationContext;
  readonly policy: ResolvedPolicy;
  readonly expectedReason: string;
} {
  switch (axis) {
    case 'outbound_mode_disabled':
      return { ctx: baseContext, policy: { ...basePolicy, outboundMode: 'disabled' }, expectedReason: 'outbound_disabled' };
    case 'suppression_list':
      return { ctx: { ...baseContext, suppressedRecipients: [ALLOWED_RECIPIENT] }, policy: basePolicy, expectedReason: 'suppression_list' };
    case 'blocklist':
      return { ctx: baseContext, policy: { ...basePolicy, blocklist: [ALLOWED_RECIPIENT] }, expectedReason: 'recipient_blocklisted' };
    case 'budget_exhausted':
      return {
        ctx: { ...baseContext, budget: { ...baseContext.budget, monthToDateSpentCents: 10_000 } },
        policy: basePolicy,
        expectedReason: 'budget_exhausted',
      };
    case 'warmup_cap':
      return {
        ctx: {
          ...baseContext,
          now: new Date(SENDING_STARTED_AT.getTime() + 5 * 86_400_000 + 12 * 3_600_000), // Day 6
          // 눈금은 **수신자 수**다 — 50 수신자 뒤의 1명이 Day 6 캡 50 을 넘긴다.
          counters: { ...baseContext.counters, orgRecipientsLastDay: 50 },
        },
        policy: basePolicy,
        expectedReason: 'warmup_daily_cap',
      };
    case 'from_forgery':
      return {
        ctx: { ...baseContext, attempt: { ...baseContext.attempt, fromAddress: 'someone-else@atmark.ai' } },
        policy: basePolicy,
        expectedReason: 'from_forgery',
      };
  }
}

// ---------------------------------------------------------------------------
// 장면 ① arch 스위트
// ---------------------------------------------------------------------------

function sceneArchSuite(): void {
  section('① arch 스위트 — AC-8 의 6층이 green 인가');

  const result = run('pnpm', ['exec', 'vitest', 'run', 'test/arch', '--reporter=basic']);
  const testFiles = [...result.output.matchAll(/test\/arch\/([\w.-]+)\.arch\.test\.ts/g)].map((m) => m[1]);
  const layers = [...new Set(testFiles)].sort();

  check('arch 스위트 통과', result.ok, result.ok ? '' : result.output.slice(-1200));
  check('층이 실제로 돌았다 (0건 통과가 아니다)', layers.length >= 5, `실행된 층: ${layers.join(', ')}`);
}

// ---------------------------------------------------------------------------
// 장면 ② deny-all 매트릭스
// ---------------------------------------------------------------------------

function sourceFor(suppressions: readonly SuppressionEntryRow[]): PolicySource {
  const result: PolicySourceResult = {
    entitlements: entitlementRow('beta'),
    organization,
    agent,
    addresses: [
      { id: 'addr-1', agent_id: AGENT_ID, address: AGENT_ADDRESS, domain: 'atmark.ai', is_primary: true, created_at: NOW },
    ],
    inactiveAddresses: [],
    policy: policyRow,
    policyVersion,
    suppressions,
    counters: baseContext.counters,
    monthToDateSpentCents: 0,
    relationships: [],
    approvalGrant: null,
    outboundSentCount: 0,
    agentRequestedRuleIds: [],
    // 고객 도메인(ADR-0014) — 에이전트 주소가 전부 atmark.ai 라 소스가 고객 도메인 행을 주지 않는다.
    customDomains: [],
    thread: null,
  };
  return { load: () => Promise.resolve(result) };
}

async function sceneDenyAllMatrix(): Promise<void> {
  section('② deny-all 매트릭스 — 거부 축 6종이 전부 차단되는가');

  check('거부 축은 Layer D 생성기와 같은 6종이다', DENY_AXES.length === 6, DENY_AXES.join(', '));

  // (a) 엔진 판정 — 축마다 기대 사유가 나오는가.
  for (const axis of DENY_AXES) {
    const { ctx, policy, expectedReason } = scenarioFor(axis);
    const decision = evaluate(ctx, policy);
    const ok = decision.verdict === 'denied' && decision.reasons.includes(expectedReason as never);
    check(`엔진: ${axis} → denied(${expectedReason})`, ok, `실제: ${decision.verdict} [${decision.reasons.join(', ')}]`);
  }

  // (b) 관문 — 실제 매니페스트로 돌린다. **SES 호출 0회 + audit 1행.**
  let sesSendCalls = 0;
  const auditRows: AuditEntry[] = [];
  const deps: GateDependencies = {
    source: sourceFor([]),
    audit: {
      record: (entry) => {
        auditRows.push(entry);
        return Promise.resolve(`audit-${auditRows.length}`);
      },
      resolve: () => Promise.resolve(),
      resolvePending: () => Promise.resolve(false),
    },
    leases: { acquire: () => Promise.resolve(true), statusOf: () => Promise.resolve('pending') },
    // 데모는 시도를 하나씩 돌린다 — 직렬화할 경쟁 자체가 없다(`unserialized` 주석).
    serializer: unserialized(),
    transport: {
      send: () => {
        sesSendCalls += 1;
        return Promise.resolve({ sesMessageId: 'should-never-happen' });
      },
    },
    leaseTtlSeconds: 300,
  };

  // **P1b 정정.** 여기 있던 단언은 `OUTBOUND_ROUTES.length === 0` 이었고, 그 0 은
  // "발송 경로가 아직 하나도 없다" 는 P1a 의 상태 그 자체였다. P1b 가 경로 5종을
  // 등록하면서 그 명제는 **의도대로** 거짓이 됐다(계획 §6 P1b 8번).
  //
  // 그래도 아래 단언("정상 시도조차 unregistered_route 로 거부된다")은 살아 있어야
  // 한다 — 그것이 이 장면의 표적이기 때문이다. 다만 그 단언이 의미를 가지려면
  // **demo 가 쓰는 routeId 가 매니페스트에 없어야** 하고, 그 전제를 이제 명시한다.
  // (전제를 적지 않으면 언젠가 `demo_send` 가 등록되는 날 이 장면이 조용히 공허해진다.)
  check(
    `demo 의 routeId 는 매니페스트 밖이다 — 미등록 경로가 거부된다는 아래 단언의 전제`,
    !OUTBOUND_ROUTES.some((route) => route.id === baseContext.attempt.routeId),
    `등록된 경로 ${String(OUTBOUND_ROUTES.length)}종: ${OUTBOUND_ROUTES.map((r) => r.id).join(', ')}`,
  );

  const outcome = await dispatch(deps, {
    agentId: AGENT_ID,
    attempt: baseContext.attempt,
    now: NOW,
    traceId: 'demo-p1a',
    thisAttemptCostCents: 10,
    messageId: 'demo-msg-1',
    messageIdHeader: '<demo-msg-1@atmark.ai>',
    leaseId: 'demo-lease-1',
    release: null,
  });

  check(
    '관문: 정상 시도조차 unregistered_route 로 거부된다',
    outcome.kind === 'denied' && outcome.decision.reasons.includes('unregistered_route' as never),
    `${outcome.kind} [${outcome.decision.reasons.join(', ')}]`,
  );
  check('관문: SES 호출 0회 (AC-5 의 문자 그대로의 증명)', sesSendCalls === 0, `호출 ${sesSendCalls}회`);
  check('관문: audit 행 정확히 1개 (§4.3)', auditRows.length === 1, `${auditRows.length}행`);
}

// ---------------------------------------------------------------------------
// 장면 ③ 워밍업 캡 (R22)
// ---------------------------------------------------------------------------

function sceneWarmupCap(): void {
  section('③ 워밍업 캡 — 문서가 아니라 코드 상수인가 (R22 / AC-c2)');

  const table: readonly (readonly [number, number])[] = [
    [1, 20], [4, 50], [7, 100], [10, 200], [13, 400], [16, 1000],
  ];
  for (const [day, expected] of table) {
    const at = new Date(SENDING_STARTED_AT.getTime() + (day - 1) * 86_400_000 + 12 * 3_600_000);
    const actual = warmupDailyCap(at, SENDING_STARTED_AT);
    check(`Day ${day} 상한 ${expected} 수신자`, actual === expected, `실제 ${actual}`);
  }

  const { ctx, policy } = scenarioFor('warmup_cap');
  const decision = evaluate(ctx, policy);
  check(
    'AC-c2: 6일차 51번째 **수신자**가 warmup_daily_cap 으로 차단 + retry_after',
    decision.verdict === 'denied' &&
      decision.reasons.includes('warmup_daily_cap' as never) &&
      (decision.retryAfterSeconds ?? 0) > 0,
    `${decision.verdict} [${decision.reasons.join(', ')}] retry_after=${String(decision.retryAfterSeconds)}`,
  );

  // 정책 jsonb 로 한도를 무한대로 열어도 캡은 살아 있다.
  const bypassAttempt = evaluate(ctx, {
    ...policy,
    limits: { perMinute: 1e9, perHour: 1e9, perDay: 1e9, recipientsPerMessage: 1e9 },
  });
  check(
    '앱·DB 설정으로 끌 수 없다 — 한도를 열어도 캡이 이긴다',
    bypassAttempt.verdict === 'denied' && bypassAttempt.reasons.includes('warmup_daily_cap' as never),
    bypassAttempt.reasons.join(', '),
  );
}

// ---------------------------------------------------------------------------
// 장면 ④ Layer F
// ---------------------------------------------------------------------------

/**
 * `ATMARK_DEMO_MUTATIONS` — 장면 ④ 의 범위. 기본은 `full`(카탈로그 전부 — 계획 §6 의 demo 그대로).
 *   `affected` : HEAD 대비 바뀐 파일에 닿는 변이만(`run-mutations.ts --affected`). 개발 중 반복용.
 *   `skip`     : 장면 ④ 를 돌리지 않는다. 장면 제목과 마지막 판정 문장이 "생략·부분" 이라고 말한다 — 생략한 demo 가
 *                전 장면 통과처럼 읽히지 않게.
 */
type LayerFMode = 'full' | 'affected' | 'skip';

function layerFMode(): LayerFMode {
  const value = process.env['ATMARK_DEMO_MUTATIONS'] ?? 'full';
  if (value === 'full' || value === 'affected' || value === 'skip') return value;
  console.error(`✗ ATMARK_DEMO_MUTATIONS=${value} — full · affected · skip 중 하나여야 한다`);
  process.exit(2);
}

function sceneLayerF(mode: LayerFMode): void {
  if (mode === 'skip') {
    section(`④ Layer F — 생략 (ATMARK_DEMO_MUTATIONS=skip). 변이 ${MUTATIONS.length}종은 이번 실행에서 검증되지 않았다`);
    return;
  }
  const scope = mode === 'full' ? `알려진 위반 ${MUTATIONS.length}종` : `HEAD 대비 바뀐 파일에 닿는 변이(전체 ${MUTATIONS.length}종 중)`;
  section(`④ Layer F — ${scope}을 겨냥한 층이 잡는가 (비공허성)`);

  const result = run('pnpm', ['exec', 'tsx', 'test/arch/mutations/run-mutations.ts', ...(mode === 'affected' ? ['--affected'] : [])]);
  const lines = result.output.split('\n').filter((l) => /^[✓✗]/.test(l.trim()));
  for (const line of lines) {
    console.log(`  ${line.trim()}`);
  }
  if (mode === 'full') {
    // 러너의 마지막 줄이 **전체 개수**를 말해야 한다 — 일부만 돈 실행이 전부로 읽히지 않게.
    const whole = lines.some((line) => line.includes(`Layer F: 변이 ${MUTATIONS.length}종 전부를 겨냥한 층이 잡았다`));
    check(`변이 ${MUTATIONS.length}종 전부를 겨냥한 층이 잡았다`, result.ok && whole, result.ok ? '' : result.output.slice(-1500));
  } else {
    check('바뀐 파일에 닿는 변이를 겨냥한 층이 잡았다 (--affected)', result.ok, result.ok ? '' : result.output.slice(-1500));
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('demo:p1a — "보낼 수 없다는 것이 CI로 증명된다." (P1b 이후: 등록되지 않은 경로는 보낼 수 없다)');

  const mode = layerFMode();
  sceneArchSuite();
  await sceneDenyAllMatrix();
  sceneWarmupCap();
  sceneLayerF(mode);

  section('판정');
  if (failures.length > 0) {
    console.error(`✗ demo:p1a 실패 ${failures.length}건:`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  // P1b 이후에도 이 demo 의 명제는 그대로다: **등록되지 않은 경로는 보낼 수 없다.**
  // 바뀐 것은 등록된 경로의 개수뿐이고, 그 개수는 위 장면 ② 가 그때그때 출력한다.
  if (mode !== 'full') {
    console.log(
      `✓ 위상(부분): arch 6층 · deny-all 매트릭스 · 워밍업 캡 green. Layer F 는 ${mode === 'skip' ? '생략' : '바뀐 파일에 닿는 변이만'} — 전부 증명하려면 ATMARK_DEMO_MUTATIONS 없이 다시 돌린다.`,
    );
    return;
  }
  console.log('✓ 위상: 등록되지 않은 경로는 보낼 수 없다. arch 6층 · deny-all 매트릭스 · 워밍업 캡 · Layer F 로 증명됐다.');
}

void main();
