/**
 * P3b — **스레드 회신은 로더가 DB 에서 확인한 사실이다. 요청 필드는 주장일 뿐이다.**
 *
 * 세 층을 본다:
 *   ① 엔진(Stage 7) — `auto_approve_reply_within_thread` 는 **에이전트가 시작한 스레드**에서만, 외부 스레드는
 *      `auto_approve_verification_senders` 의 전제 **전부**가 참일 때만. `reply_only` 도 같은 사실을 읽는다.
 *   ② 로더(`resolveThreadReply`) — 주장된 스레드가 이 에이전트의 것 · 인증 수신 존재 · 수신자 전원이 인증 발신자.
 *   ③ 구조 — 엔진이 주장(`attempt.threadId`)을 읽지 않고, 정책 경로 어디에도 `display_thread_id` 가 없다.
 *
 * 각 케이스는 한 축만 비튼다. 기본값(`verifiedThread`)은 모든 전제가 참인 답장 대상이다 — 그래서 한 축을 비튼
 * 케이스가 막히면 그 축이 막은 것이다.
 */

import { entitlementRow } from '../../support/entitlements';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { toAgentId, type SenderRelationshipRow } from '../../../src/db/schema';
import {
  loadEvaluationInput,
  resolveThreadReply,
  type PolicySourceResult,
  type ThreadSource,
} from '../../../src/policy/policy-loader';
import { evaluateOutboundMode, VERIFICATION_REPLY_WINDOW_MS } from '../../../src/policy/rules/outbound-mode';
import type { PolicyStamp, RepliedInbound } from '../../../src/policy/types';
import {
  AGENT_ID,
  NOW,
  ORG_ID,
  POLICY_VERSION_ID,
  STRANGER_RECIPIENT,
  THREAD_ID,
  baseAttempt,
  baseCounters,
  contextWith,
  policyWith,
  verifiedThread,
} from './fixtures';

const STAMP: PolicyStamp = { policyVersion: 7, policyVersionId: 'v-7', evaluatedAt: NOW };
const DAY_MS = 24 * 60 * 60 * 1000;

const approvalRequired = policyWith({ outboundMode: 'approval_required' });
const verificationOn = policyWith({
  outboundMode: 'approval_required',
  preApproval: { autoApproveVerificationSenders: true },
});
const replyOnly = policyWith({ outboundMode: 'reply_only' });

/** grace 가 끝난 `reply_only` 에이전트(15일 전 생성). */
const GRACE_OVER = { agentCreatedAt: new Date(NOW.getTime() - 15 * DAY_MS), outboundSentCount: 0 };

function decide(
  policy: typeof approvalRequired,
  thread: ReturnType<typeof verifiedThread> | null,
  attempt: Parameters<typeof contextWith>[0]['attempt'] = {},
): ReturnType<typeof evaluateOutboundMode> {
  return evaluateOutboundMode(
    contextWith({ attempt: { recipients: [STRANGER_RECIPIENT], ...attempt }, approval: { thread } }),
    policy,
    STAMP,
  );
}

// ---------------------------------------------------------------------------
// ① 엔진 — auto_approve_reply_within_thread
// ---------------------------------------------------------------------------

describe('`auto_approve_reply_within_thread` — 에이전트가 시작한 스레드에서만 (P3b 리드 결정)', () => {
  it('에이전트 스레드의 검증된 회신 → allowed', () => {
    const decision = decide(approvalRequired, verifiedThread('agent'));
    expect(decision.verdict).toBe('allowed');
    expect(decision.reasons).toEqual(['auto_approve_reply_within_thread']);
  });

  it('★ 외부인이 시작한 스레드의 회신 → 이 규칙으로는 통과하지 못한다(승인 대기)', () => {
    const decision = decide(approvalRequired, verifiedThread('external'));
    expect(decision.verdict).toBe('pending_approval');
    expect(decision.reasons).toEqual(['new_recipient']);
  });

  it('★ 요청이 스레드를 **주장**해도 로더가 확인하지 않았으면(`thread: null`) 회신이 아니다', () => {
    const decision = decide(approvalRequired, null, { threadId: THREAD_ID, contentShape: 'code_only' });
    expect(decision.verdict).toBe('pending_approval');
    expect(decision.reasons).toEqual(['new_recipient']);
  });

  it('★ 에이전트 스레드여도 답하는 메일이 격리돼 있으면 열지 않는다', () => {
    const decision = decide(approvalRequired, verifiedThread('agent', { quarantined: true }));
    expect(decision.verdict).toBe('pending_approval');
  });

  it('규칙 OFF 면 에이전트 스레드도 승인 대기다', () => {
    const decision = decide(
      policyWith({ outboundMode: 'approval_required', preApproval: { autoApproveReplyWithinThread: false } }),
      verifiedThread('agent'),
    );
    expect(decision.verdict).toBe('pending_approval');
  });
});

// ---------------------------------------------------------------------------
// ① 엔진 — auto_approve_verification_senders
// ---------------------------------------------------------------------------

describe('`auto_approve_verification_senders` — 외부 스레드가 여는 유일한 문, 전제 전부 필요 (§3.4 3조)', () => {
  const codeReply = { contentShape: 'code_only' as const };

  it('전제 전부 참 + ON → allowed `auto_approve_verification_sender`', () => {
    const decision = decide(verificationOn, verifiedThread('external'), codeReply);
    expect(decision.verdict).toBe('allowed');
    expect(decision.reasons).toEqual(['auto_approve_verification_sender']);
  });

  it('기본값(OFF)이면 전제가 전부 참이어도 승인 대기', () => {
    expect(decide(approvalRequired, verifiedThread('external'), codeReply).verdict).toBe('pending_approval');
  });

  it('ON 이어도 검증된 스레드가 없으면(주장만) 닫혀 있다', () => {
    expect(decide(verificationOn, null, { ...codeReply, threadId: THREAD_ID }).verdict).toBe('pending_approval');
  });

  const closed: ReadonlyArray<readonly [string, Partial<RepliedInbound>, Parameters<typeof contextWith>[0]['attempt']]> = [
    ['★ injection_risk === null (판정 없음) 은 none 이 아니다', { injectionRisk: null }, codeReply],
    ['injection_risk === low', { injectionRisk: 'low' }, codeReply],
    ['★ 격리된 메일', { quarantined: true }, codeReply],
    ['sender_trust === null (P4 이전 행)', { senderTrust: null }, codeReply],
    ['sender_trust === unknown', { senderTrust: 'unknown' }, codeReply],
    ['sender_trust === blocked', { senderTrust: 'blocked' }, codeReply],
    ['수신 후 24시간 초과', { receivedAt: new Date(NOW.getTime() - VERIFICATION_REPLY_WINDOW_MS - 1) }, codeReply],
    ['수신 시각이 미래(시계가 어긋난 행으로 창을 늘리지 않는다)', { receivedAt: new Date(NOW.getTime() + 1) }, codeReply],
    ['★ 수신자가 그 메일의 발신자가 아니다(Reply-To 등)', { recipientsAreItsSender: false }, codeReply],
    ['받은 메일에 첨부', { attachmentCount: 1 }, codeReply],
    [
      '보내는 메일에 첨부',
      {},
      { ...codeReply, attachments: [{ filename: 'a.txt', mimeType: 'text/plain', bytes: 1 }] },
    ],
    ['본문이 코드 회신이 아니다', {}, { contentShape: 'other' }],
  ];

  it.each(closed)('%s → 승인 대기', (_label, inbound, attempt) => {
    const decision = decide(verificationOn, verifiedThread('external', inbound), attempt);
    expect(decision.verdict).toBe('pending_approval');
    expect(decision.reasons).toEqual(['new_recipient']);
  });

  it.each(['seen', 'seed', 'approved'] as const)('sender_trust === %s 는 `>= seen` 이다', (trust) => {
    expect(decide(verificationOn, verifiedThread('external', { senderTrust: trust }), codeReply).verdict).toBe(
      'allowed',
    );
  });

  it('창의 경계 — 정확히 24시간 전 수신은 안, 수신 직후(0ms)도 안', () => {
    const at = (ms: number) => verifiedThread('external', { receivedAt: new Date(NOW.getTime() - ms) });
    expect(decide(verificationOn, at(VERIFICATION_REPLY_WINDOW_MS), codeReply).verdict).toBe('allowed');
    expect(decide(verificationOn, at(0), codeReply).verdict).toBe('allowed');
  });
});

// ---------------------------------------------------------------------------
// ① 엔진 — reply_only
// ---------------------------------------------------------------------------

describe('`reply_only` — "기존 스레드 내 회신" 도 로더의 사실로 (P3b)', () => {
  it('검증된 스레드 회신은 grace 가 끝났어도 allowed — 스레드를 연 쪽은 묻지 않는다', () => {
    for (const startedBy of ['agent', 'external'] as const) {
      const decision = evaluateOutboundMode(
        contextWith({ approval: { thread: verifiedThread(startedBy), bootstrapGrace: GRACE_OVER } }),
        replyOnly,
        STAMP,
      );
      expect(decision.verdict).toBe('allowed');
      expect(decision.reasons).toEqual(['reply_within_thread']);
    }
  });

  it('★ 스레드를 주장만 하면(grace 종료) → denied `reply_only_no_inbound_thread`', () => {
    const decision = evaluateOutboundMode(
      contextWith({ attempt: { threadId: THREAD_ID }, approval: { thread: null, bootstrapGrace: GRACE_OVER } }),
      replyOnly,
      STAMP,
    );
    expect(decision.verdict).toBe('denied');
    expect(decision.reasons).toEqual(['reply_only_no_inbound_thread']);
  });

  it('★ 격리 메일에 답하려 하면(grace 종료) → denied `reply_only_inbound_quarantined`', () => {
    const decision = evaluateOutboundMode(
      contextWith({ approval: { thread: verifiedThread('external', { quarantined: true }), bootstrapGrace: GRACE_OVER } }),
      replyOnly,
      STAMP,
    );
    expect(decision.verdict).toBe('denied');
    expect(decision.reasons).toEqual(['reply_only_inbound_quarantined']);
  });

  it('격리 메일 + grace 안 → approval_required 처럼(사람에게 묻는다)', () => {
    const decision = evaluateOutboundMode(
      contextWith({
        attempt: { recipients: [STRANGER_RECIPIENT] },
        approval: { thread: verifiedThread('external', { quarantined: true }) },
      }),
      replyOnly,
      STAMP,
    );
    expect(decision.verdict).toBe('pending_approval');
    expect(decision.reasons).toEqual(['new_recipient', 'bootstrap_grace']);
  });
});

// ---------------------------------------------------------------------------
// ② 로더 — resolveThreadReply
// ---------------------------------------------------------------------------

const PARTNER = 'bob@partner.example';

function threadSource(overrides: Partial<ThreadSource> = {}, thread: Partial<ThreadSource['thread']> = {}): ThreadSource {
  return {
    thread: {
      id: THREAD_ID,
      agent_id: AGENT_ID,
      started_by: 'external',
      starter_address: PARTNER,
      subject_normalized: '견적',
      created_at: NOW,
      last_message_at: NOW,
      ...thread,
    },
    authenticatedSenders: [PARTNER, 'carol@partner.example'],
    latestAuthenticatedInbound: {
      id: 'inbound-1',
      from_address: PARTNER,
      injection_risk: 'none',
      sender_trust: 'seen',
      quarantined: false,
      received_at: NOW,
      attachment_count: 0,
    },
    ...overrides,
  };
}

describe('`resolveThreadReply` — 주장을 사실로 바꾸는 유일한 지점', () => {
  it('전부 맞으면 검증된 회신 — 판정 값은 행 그대로 옮긴다', () => {
    const verified = resolveThreadReply(threadSource(), AGENT_ID, THREAD_ID, [PARTNER]);
    expect(verified).toEqual({
      threadId: THREAD_ID,
      startedBy: 'external',
      repliedTo: {
        inboundMessageId: 'inbound-1',
        injectionRisk: 'none',
        senderTrust: 'seen',
        quarantined: false,
        receivedAt: NOW,
        attachmentCount: 0,
        recipientsAreItsSender: true,
      },
    });
  });

  it('주장이 없으면 소스가 무엇을 주든 null', () => {
    expect(resolveThreadReply(threadSource(), AGENT_ID, null, [PARTNER])).toBeNull();
  });

  it('소스가 스레드를 못 찾았으면 null', () => {
    expect(resolveThreadReply(null, AGENT_ID, THREAD_ID, [PARTNER])).toBeNull();
  });

  it('★ 남의 에이전트 스레드 — 소스가 범위를 빠뜨려도 로더가 막는다', () => {
    const other = toAgentId('ffffffffffffffffffffffffffffffff');
    expect(resolveThreadReply(threadSource({}, { agent_id: other }), AGENT_ID, THREAD_ID, [PARTNER])).toBeNull();
  });

  it('소스가 주장과 다른 스레드를 돌려주면 null', () => {
    expect(
      resolveThreadReply(threadSource({}, { id: '99999999-9999-4999-8999-999999999999' }), AGENT_ID, THREAD_ID, [PARTNER]),
    ).toBeNull();
  });

  it('답할 인증 수신이 없는 스레드는 회신 스레드가 아니다', () => {
    expect(
      resolveThreadReply(threadSource({ latestAuthenticatedInbound: null }), AGENT_ID, THREAD_ID, [PARTNER]),
    ).toBeNull();
  });

  it('★ 수신자 중 하나라도 그 스레드의 인증 발신자가 아니면 null (Reply-To·제3자 끼워 넣기)', () => {
    expect(resolveThreadReply(threadSource(), AGENT_ID, THREAD_ID, ['attacker@evil.example'])).toBeNull();
    expect(resolveThreadReply(threadSource(), AGENT_ID, THREAD_ID, [PARTNER, 'attacker@evil.example'])).toBeNull();
  });

  it('`+tag` 를 자르지 않는다 — 허용 판정은 좁은 쪽(bob+x@ 는 bob@ 의 스레드 권한을 빌리지 못한다)', () => {
    expect(resolveThreadReply(threadSource(), AGENT_ID, THREAD_ID, ['bob+x@partner.example'])).toBeNull();
  });

  it('대소문자·앞뒤 공백은 같은 주소다', () => {
    expect(resolveThreadReply(threadSource(), AGENT_ID, THREAD_ID, [' Bob@Partner.Example '])).not.toBeNull();
  });

  it('수신자 0명은 회신이 아니다', () => {
    expect(resolveThreadReply(threadSource(), AGENT_ID, THREAD_ID, [])).toBeNull();
  });

  it('스레드의 다른 인증 발신자에게 답하면 회신이지만 "그 메일의 발신자" 는 아니다', () => {
    const verified = resolveThreadReply(threadSource(), AGENT_ID, THREAD_ID, ['carol@partner.example']);
    expect(verified?.repliedTo.recipientsAreItsSender).toBe(false);
  });

  it('★ injection_risk === null 은 null 로 옮긴다 — none 으로 메우지 않는다', () => {
    const source = threadSource({
      latestAuthenticatedInbound: { ...threadSource().latestAuthenticatedInbound!, injection_risk: null, sender_trust: null },
    });
    const verified = resolveThreadReply(source, AGENT_ID, THREAD_ID, [PARTNER]);
    expect(verified?.repliedTo.injectionRisk).toBeNull();
    expect(verified?.repliedTo.senderTrust).toBeNull();
  });

  it('attachment_count 가 정수가 아니면 던진다(fail closed)', () => {
    const source = threadSource({
      latestAuthenticatedInbound: { ...threadSource().latestAuthenticatedInbound!, attachment_count: -1 },
    });
    expect(() => resolveThreadReply(source, AGENT_ID, THREAD_ID, [PARTNER])).toThrow();
  });
});

// ---------------------------------------------------------------------------
// ② 로더 — loadEvaluationInput 이 주장 대신 사실을 싣는다
// ---------------------------------------------------------------------------

function sourceResult(overrides: Partial<PolicySourceResult> = {}): PolicySourceResult {
  return {
    entitlements: entitlementRow('beta'),
    organization: {
      id: ORG_ID,
      name: 'Atmark',
      ses_tenant_id: null,
      billing_status: 'active',
      abuse_freeze: false,
      owner_paused: false,
      review_status: 'active',
      sending_started_at: NOW,
      created_at: NOW,
      updated_at: NOW,
    },
    agent: {
      id: AGENT_ID,
      organization_id: ORG_ID,
      name: 'demo',
      status: 'active',
      plan: 'free',
      monthly_budget_cents: 10_000,
      created_at: NOW,
      updated_at: NOW,
    },
    addresses: [
      { id: 'addr-1', agent_id: AGENT_ID, address: 'agent@atmark.ai', domain: 'atmark.ai', is_primary: true, created_at: NOW },
    ],
    policy: {
      agent_id: AGENT_ID,
      outbound_mode: 'approval_required',
      inbound_mode: 'all',
      require_approval: false,
      limits: { per_minute: 10, per_hour: 100, per_day: 500, recipients_per_message: 10 },
      config_json: { allowlist: [], blocklist: [], max_attachment_bytes_total: 1000, allowed_mime_types: [] },
      current_version: 1,
      created_at: NOW,
      updated_at: NOW,
    },
    policyVersion: {
      id: POLICY_VERSION_ID,
      agent_id: AGENT_ID,
      version: 1,
      outbound_mode: 'approval_required',
      inbound_mode: 'all',
      snapshot: {},
      created_by: null,
      created_at: NOW,
    },
    suppressions: [],
    counters: baseCounters,
    monthToDateSpentCents: 0,
    relationships: [],
    approvalGrant: null,
    outboundSentCount: 0,
    agentRequestedRuleIds: [],
    // 고객 도메인(ADR-0014) — 에이전트 주소가 전부 atmark.ai 라 소스가 고객 도메인 행을 주지 않는다.
    inactiveAddresses: [],
    customDomains: [],
    thread: null,
    ...overrides,
  };
}

const threadScoped: SenderRelationshipRow = {
  id: 'rel-1',
  agent_id: AGENT_ID,
  scope: 'thread',
  address: PARTNER,
  domain: null,
  thread_id: THREAD_ID,
  trust_category: 'approved',
  granted_via_approval_id: 'apr-1',
  granted_by: 'owner@example.com',
  domain_scope_confirmed_by: null,
  created_at: NOW,
};

async function load(result: PolicySourceResult, threadId: string | null, contentShape: string = 'other') {
  const input = await loadEvaluationInput(
    { load: () => Promise.resolve(result) },
    {
      agentId: AGENT_ID,
      attempt: { ...baseAttempt, recipients: [PARTNER], threadId, contentShape: contentShape as 'other' },
      now: NOW,
      traceId: null,
      thisAttemptCostCents: 0,
      release: null,
    },
  );
  return input.ctx;
}

describe('`loadEvaluationInput` — 스레드는 사실로만 싣는다', () => {
  it('소스가 스레드 사실을 주면 검증 결과가 `approval.thread` 에 실린다', async () => {
    const ctx = await load(sourceResult({ thread: threadSource() }), THREAD_ID);
    expect(ctx.approval.thread?.threadId).toBe(THREAD_ID);
    expect(ctx.approval.thread?.startedBy).toBe('external');
  });

  it('★ 주장만 있고 소스가 사실을 주지 않으면 `thread: null` — `thread` 스코프 관계도 매칭되지 않는다', async () => {
    const ctx = await load(sourceResult({ relationships: [threadScoped] }), THREAD_ID);
    expect(ctx.approval.thread).toBeNull();
    expect(ctx.approval.relationships).toEqual([]);
  });

  it('검증된 스레드면 그 스레드의 `thread` 스코프 관계가 매칭된다', async () => {
    const ctx = await load(sourceResult({ thread: threadSource(), relationships: [threadScoped] }), THREAD_ID);
    expect(ctx.approval.relationships).toEqual([{ recipient: PARTNER, trustCategory: 'approved', scope: 'thread' }]);
  });

  it('본문 모양은 좁은 쪽으로만 옮긴다 — 모르는 값은 other', async () => {
    expect((await load(sourceResult(), null, 'code_only')).attempt.contentShape).toBe('code_only');
    expect((await load(sourceResult(), null, 'CODE_ONLY')).attempt.contentShape).toBe('other');
  });
});

// ---------------------------------------------------------------------------
// ③ 구조 — 엔진은 주장을 읽지 않고, 정책 경로에는 표시용 스레드가 없다
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, '../../..');

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** 주석을 지운 코드만 — 주석이 옛 이름을 설명하는 것은 허용한다. */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('구조 — 주장과 표시용 스레드가 판정에 닿지 않는다', () => {
  const ruleFiles = filesUnder(join(REPO_ROOT, 'src/policy/rules'));

  it('규칙 파일을 실제로 읽었다(공허한 통과 방지)', () => {
    expect(ruleFiles.length).toBeGreaterThanOrEqual(8);
  });

  it('★ Stage 규칙(`src/policy/rules/**`)은 `attempt.threadId` 를 읽지 않는다 — 스레드는 `approval.thread` 로만', () => {
    const offenders = ruleFiles.filter((file) => /attempt\.threadId|isThreadReply/.test(codeOf(file)));
    expect(offenders).toEqual([]);
    // 통제군 — 같은 검사가 실제 참조를 잡는다.
    expect(/attempt\.threadId/.test('if (ctx.attempt.threadId !== null)')).toBe(true);
  });

  it('★ 정책 경로(`src/policy/**`, `policy-source.ts`)는 `display_thread_id` 를 읽지 않는다', () => {
    const files = [...filesUnder(join(REPO_ROOT, 'src/policy')), join(REPO_ROOT, 'src/db/repositories/policy-source.ts')];
    const offenders = files.filter((file) => codeOf(file).includes('display_thread_id'));
    expect(offenders).toEqual([]);
  });

  it('`OutboundAttempt` 에는 불리언 스레드 주장이 없다 — 되살리면 이 테스트가 먼저 안다', () => {
    const types = codeOf(join(REPO_ROOT, 'src/policy/types.ts'));
    const attempt = types.slice(types.indexOf('export interface OutboundAttempt'), types.indexOf('export type ContentShape'));
    expect(attempt).toContain('threadId');
    expect(attempt).not.toMatch(/isThreadReply/);
  });
});
