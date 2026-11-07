/**
 * 적대적 검증(묶음 D) 요소 1 — 발신 승인(`send_approval = always`) 엔진 층. 순수 단위. 시도 ID 는 `D1-U###`.
 * 보안 동작을 단언한다. 현재 동작만 못박은 것은 `SUSPECT:`, 뚫린 것은 `VULN:` 머리말.
 */

import { describe, expect, it } from 'vitest';

import { evaluate } from '../../../src/policy/engine';
import { PolicyShapeError, resolvePolicy } from '../../../src/policy/policy-loader';
import type { AgentPolicyRow, PolicyVersionRow } from '../../../src/db/schema';
import type { AuditDecision, Decision, OutboundMode, RiskHoldContext } from '../../../src/policy/types';
import { ALLOWED_RECIPIENT, NOW, STRANGER_RECIPIENT, AGENT_ID, POLICY_VERSION_ID, contextWith, policyWith, verifiedThread } from '../policy/fixtures';

const RANK: Readonly<Record<AuditDecision, number>> = { allowed: 2, pending_approval: 1, denied: 0 };
const MODES: readonly OutboundMode[] = ['disabled', 'allowlist_only', 'blocklist_only', 'unrestricted', 'approval_required', 'reply_only'];
const THIRD = 'third@other.example';
const BLOCKED = 'blocked@evil.example';

type Ctx = ReturnType<typeof contextWith>;

function both(ctx: Ctx, mode: OutboundMode, extra: Record<string, unknown> = {}): { auto: Decision; always: Decision } {
  const base = { outboundMode: mode, allowlist: [ALLOWED_RECIPIENT, THIRD], blocklist: [BLOCKED], ...extra } as never;
  return { auto: evaluate(ctx, policyWith({ ...(base as object), sendApproval: 'auto' })), always: evaluate(ctx, policyWith({ ...(base as object), sendApproval: 'always' })) };
}

function grantFor(recipients: string[]) {
  return { approvalId: 'a-1', recipients, approvedBy: 'owner' };
}

// ---------------------------------------------------------------------------
// 속성: 모드 × 수신자 모양 — always 가 auto 보다 관대하지 않고, 사람 승인 없이는 allowed 가 아니다.
// ---------------------------------------------------------------------------
const SHAPES: readonly { name: string; recipients: string[]; thread?: boolean }[] = [
  { name: '목록 안 한 명', recipients: [ALLOWED_RECIPIENT] },
  { name: '목록 밖 한 명', recipients: [STRANGER_RECIPIENT] },
  { name: '목록 안 두 명', recipients: [ALLOWED_RECIPIENT, THIRD] },
  { name: '안 + 밖 섞임', recipients: [ALLOWED_RECIPIENT, STRANGER_RECIPIENT] },
  { name: '차단 목록 상대', recipients: [BLOCKED] },
  { name: '스레드 회신(외부 시작)', recipients: [ALLOWED_RECIPIENT], thread: true },
];

describe('D1 엔진 — 모드 × 수신자 모양 (6×6 = 36)', () => {
  const rows = MODES.flatMap((mode) => SHAPES.map((shape) => ({ mode, shape })));
  it.each(rows.map((row, index) => ({ ...row, id: `D1-U${String(index + 1).padStart(3, '0')}` })))(
    '[$id] $mode / $shape.name — always 는 auto 보다 관대하지 않고 grant 없이는 allowed 가 아니다',
    ({ mode, shape }) => {
      const ctx = contextWith({
        attempt: { recipients: shape.recipients, threadId: shape.thread ? 'th' : null },
        approval: { thread: shape.thread ? verifiedThread('external') : null },
      });
      const { auto, always } = both(ctx, mode);
      expect(RANK[always.verdict]).toBeLessThanOrEqual(RANK[auto.verdict]);
      expect(always.verdict).not.toBe('allowed');
      if (auto.verdict === 'denied') expect(always.verdict).toBe('denied');
    },
  );
});

// ---------------------------------------------------------------------------
// grant(사람이 승인한 릴리스) 변조
// ---------------------------------------------------------------------------
describe('D1 엔진 — grant 변조 (once 승인 재사용)', () => {
  const unrestricted = (recipients: string[], grant: ReturnType<typeof grantFor> | null) =>
    both(contextWith({ attempt: { recipients }, approval: { recipients, grant } }), 'unrestricted').always;

  it.each([
    { id: 'D1-U037', label: 'grant 가 수신자 일부만 덮는다(두 명 중 한 명)', recipients: [STRANGER_RECIPIENT, THIRD], grant: grantFor([STRANGER_RECIPIENT]) },
    { id: 'D1-U038', label: 'grant 수신자가 비었다', recipients: [STRANGER_RECIPIENT], grant: grantFor([]) },
    { id: 'D1-U039', label: 'grant 가 다른 사람 A 에 대한 것(메시지 B 에 재사용)', recipients: [STRANGER_RECIPIENT], grant: grantFor([THIRD]) },
    { id: 'D1-U040', label: '대소문자만 다른 grant 수신자', recipients: [STRANGER_RECIPIENT], grant: grantFor([STRANGER_RECIPIENT.toUpperCase()]) },
    { id: 'D1-U041', label: '+tag 만 다른 grant 수신자', recipients: ['stranger+x@example.com'], grant: grantFor([STRANGER_RECIPIENT]) },
    { id: 'D1-U042', label: '앞뒤 공백이 낀 grant 수신자', recipients: [STRANGER_RECIPIENT], grant: grantFor([` ${STRANGER_RECIPIENT} `]) },
    { id: 'D1-U043', label: '시도 수신자가 비었는데 grant 만 있다', recipients: [], grant: grantFor([STRANGER_RECIPIENT]) },
    { id: 'D1-U044', label: '와일드카드 grant 수신자(*)', recipients: [STRANGER_RECIPIENT], grant: grantFor(['*']) },
    { id: 'D1-U045', label: '도메인만 적은 grant 수신자', recipients: [STRANGER_RECIPIENT], grant: grantFor(['example.com']) },
    { id: 'D1-U046', label: '시도 수신자 중복 위장(같은 주소 둘 + 다른 하나)', recipients: [STRANGER_RECIPIENT, STRANGER_RECIPIENT, THIRD], grant: grantFor([STRANGER_RECIPIENT]) },
  ])('[$id] $label — 승인 없이 allowed 가 되지 않는다', ({ recipients, grant }) => {
    const decision = unrestricted(recipients, grant);
    expect(decision.verdict).not.toBe('allowed');
  });

  it('[D1-U047] 대조군: grant 가 전원을 덮으면 나간다(승인이 끝나지 않는 고리 없음)', () => {
    expect(unrestricted([STRANGER_RECIPIENT], grantFor([STRANGER_RECIPIENT])).verdict).toBe('allowed');
  });

  it('[D1-U048] grant 가 있어도 거부는 거부다(차단 목록)', () => {
    const decision = both(contextWith({ attempt: { recipients: [BLOCKED] }, approval: { recipients: [BLOCKED], grant: grantFor([BLOCKED]) } }), 'blocklist_only').always;
    expect(decision.verdict).toBe('denied');
  });

  it('[D1-U049] grant 가 있어도 억제 목록(suppression)은 거부다', () => {
    const decision = both(contextWith({ attempt: { recipients: [STRANGER_RECIPIENT] }, suppressedRecipients: [STRANGER_RECIPIENT], approval: { recipients: [STRANGER_RECIPIENT], grant: grantFor([STRANGER_RECIPIENT]) } }), 'unrestricted').always;
    expect(decision.verdict).toBe('denied');
  });

  it('[D1-U050] grant 가 있어도 kill-switch(에이전트 정지)는 거부다', () => {
    const decision = both(contextWith({ agent: { status: 'suspended' }, attempt: { recipients: [STRANGER_RECIPIENT] }, approval: { recipients: [STRANGER_RECIPIENT], grant: grantFor([STRANGER_RECIPIENT]) } }), 'unrestricted').always;
    expect(decision.verdict).toBe('denied');
  });

  it('[D1-U051] grant 가 있어도 소유자 일시정지 조직은 거부다', () => {
    const decision = both(contextWith({ organization: { ownerPaused: true }, attempt: { recipients: [STRANGER_RECIPIENT] }, approval: { recipients: [STRANGER_RECIPIENT], grant: grantFor([STRANGER_RECIPIENT]) } }), 'unrestricted').always;
    expect(decision.verdict).toBe('denied');
  });

  it('[D1-U052] 릴리스된 grant 에서 DLP 적중은 여전히 사람 승인 문(grant 가 DLP 를 지우지 못한다) — 최소한 more permissive than auto 가 아니다', () => {
    const ctx = contextWith({ attempt: { recipients: [STRANGER_RECIPIENT], dlp: ['atmark_credential'] as never }, approval: { recipients: [STRANGER_RECIPIENT], grant: grantFor([STRANGER_RECIPIENT]) } });
    const { auto, always } = both(ctx, 'unrestricted');
    expect(RANK[always.verdict]).toBeLessThanOrEqual(RANK[auto.verdict]);
  });
});

// ---------------------------------------------------------------------------
// 위험 보류 · 경로 표지와의 합성, 레거시 모드
// ---------------------------------------------------------------------------
describe('D1 엔진 — 합성과 레거시 모드', () => {
  const RISK: RiskHoldContext = { enforce: true, agentTainted: true, threadTainted: false, taintedSenders: [] };

  it.each([
    { id: 'D1-U053', label: 'risk hold + always: 위험 사유가 맨 앞', ctx: contextWith({ attempt: { recipients: [STRANGER_RECIPIENT] }, approval: { riskHold: RISK } }), mode: 'unrestricted' as const },
    { id: 'D1-U054', label: 'risk hold(관찰 모드 enforce=false) + always: 여전히 승인 대기', ctx: contextWith({ attempt: { recipients: [STRANGER_RECIPIENT] }, approval: { riskHold: { ...RISK, enforce: false } } }), mode: 'unrestricted' as const },
    { id: 'D1-U055', label: '경로 표지(전환 안내) + always', ctx: contextWith({ attempt: { recipients: [STRANGER_RECIPIENT] }, approval: { humanApprovalRequired: 'transition_announcement' } }), mode: 'unrestricted' as const },
    { id: 'D1-U056', label: 'riskHold=null(포트 미배선) + always: 여전히 승인 대기', ctx: contextWith({ attempt: { recipients: [STRANGER_RECIPIENT] }, approval: { riskHold: null } }), mode: 'unrestricted' as const },
  ])('[$id] $label', ({ ctx, mode }) => {
    const { always } = both(ctx, mode);
    expect(always.verdict).toBe('pending_approval');
    expect(always.reasons).toContain('owner_requires_approval');
    for (const bad of ['unrestricted_mode', 'allowlist_match', 'approval_granted', 'standing_approval', 'seed_relationship']) expect(always.reasons).not.toContain(bad);
  });

  it.each([
    { id: 'D1-U057', label: 'seed 관계 상대(시드는 평소 승인 없이 통과) + always', relationships: [{ recipient: STRANGER_RECIPIENT, trustCategory: 'seed' as const, scope: 'recipient' as const }] },
    { id: 'D1-U058', label: '승인된 상시 관계 상대 + always', relationships: [{ recipient: STRANGER_RECIPIENT, trustCategory: 'approved' as const, scope: 'recipient' as const }] },
    { id: 'D1-U059', label: '도메인 범위 상시 승인 + always', relationships: [{ recipient: STRANGER_RECIPIENT, trustCategory: 'approved' as const, scope: 'domain' as const }] },
  ])('[$id] $label — approval_required 모드에서도 승인 대기', ({ relationships }) => {
    const ctx = contextWith({ attempt: { recipients: [STRANGER_RECIPIENT] }, approval: { relationships: relationships as never } });
    const { auto, always } = both(ctx, 'approval_required');
    expect(RANK[always.verdict]).toBeLessThanOrEqual(RANK[auto.verdict]);
    expect(always.verdict).not.toBe('allowed');
  });

  it.each([
    { id: 'D1-U060', label: '자동 승인 도메인 + always', autoDomains: ['example.com'] },
    { id: 'D1-U061', label: '자동 승인 도메인(서브도메인 와일드카드) + always', autoDomains: ['*.example.com'] },
  ])('[$id] $label', ({ autoDomains }) => {
    const ctx = contextWith({ attempt: { recipients: [STRANGER_RECIPIENT] } });
    const { always } = both(ctx, 'approval_required', { preApproval: { autoApproveDomains: autoDomains, autoApproveReplyWithinThread: true, autoApproveVerificationSenders: true } });
    expect(always.verdict).not.toBe('allowed');
  });

  it.each([
    { id: 'D1-U062', label: '레거시 reply_only: 에이전트가 시작한 스레드 회신', starter: 'agent' as const },
    { id: 'D1-U063', label: '레거시 reply_only: 외부가 시작한 스레드 회신', starter: 'external' as const },
  ])('[$id] $label — always 면 승인도 없이 거부(허용으로 새지 않는다)', ({ starter }) => {
    const ctx = contextWith({ attempt: { recipients: [ALLOWED_RECIPIENT], threadId: 'th' }, approval: { thread: verifiedThread(starter) } });
    const { auto, always } = both(ctx, 'reply_only');
    expect(RANK[always.verdict]).toBeLessThanOrEqual(RANK[auto.verdict]);
    expect(always.verdict).not.toBe('allowed');
  });

  it('[D1-U064] 레거시 reply_only: 스레드 없는 새 메일은 always 에서도 allowed 가 아니다', () => {
    const r = both(contextWith({}), 'reply_only');
    expect(r.always.verdict).not.toBe('allowed');
    expect(RANK[r.always.verdict]).toBeLessThanOrEqual(RANK[r.auto.verdict]);
  });

  it('[D1-U065] disabled 모드는 always 로 승인 대기가 되지 않는다(거부 유지)', () => {
    expect(both(contextWith({}), 'disabled').always.verdict).toBe('denied');
  });

  it('[D1-U066] 부트스트랩 grace 잔여는 always 에서도 옮겨 실리고 허용으로 새지 않는다', () => {
    const ctx = contextWith({ attempt: { recipients: [STRANGER_RECIPIENT] }, approval: { bootstrapGrace: { agentCreatedAt: NOW, outboundSentCount: 0 } } });
    const { always } = both(ctx, 'approval_required');
    expect(always.verdict).not.toBe('allowed');
  });

  it('[D1-U067] auto 대조군: 같은 맥락은 목록 안 상대에게 allowed (always 가 실제로 좁힌다)', () => {
    expect(both(contextWith({}), 'allowlist_only').auto.verdict).toBe('allowed');
    expect(both(contextWith({}), 'allowlist_only').always.verdict).toBe('pending_approval');
  });
});

// ---------------------------------------------------------------------------
// 로더: 행/스냅샷 → sendApproval (좁은 쪽)
// ---------------------------------------------------------------------------
function rows(overrides: { require?: boolean; snapshot?: Record<string, unknown>; policyVersion?: number; versionRow?: number }): { policy: AgentPolicyRow; version: PolicyVersionRow } {
  const policy = {
    agent_id: AGENT_ID,
    outbound_mode: 'allowlist_only',
    inbound_mode: 'all',
    require_approval: overrides.require ?? false,
    limits: { per_minute: 10, per_hour: 100, per_day: 500, recipients_per_message: 10 },
    config_json: { max_attachment_bytes_total: 5000000, allowed_mime_types: ['application/pdf'] },
    current_version: overrides.policyVersion ?? 1,
    created_at: NOW,
    updated_at: NOW,
  } as unknown as AgentPolicyRow;
  const version = {
    id: POLICY_VERSION_ID,
    agent_id: AGENT_ID,
    version: overrides.versionRow ?? 1,
    outbound_mode: 'allowlist_only',
    inbound_mode: 'all',
    snapshot: { contact_rules: [], ...(overrides.snapshot ?? {}) },
    created_by: 'x',
    created_at: NOW,
  } as unknown as PolicyVersionRow;
  return { policy, version };
}

describe('D1 로더 — 정책 행/스냅샷 변조', () => {
  it.each([
    { id: 'D1-U068', label: '행 true · 스냅샷 칸 없음(옛 스냅샷)', args: { require: true }, expected: 'always' },
    { id: 'D1-U069', label: '행 false · 스냅샷 true(행만 되돌린 변조)', args: { require: false, snapshot: { require_approval: true } }, expected: 'always' },
    { id: 'D1-U070', label: '행 true · 스냅샷 false(스냅샷만 되돌린 변조)', args: { require: true, snapshot: { require_approval: false } }, expected: 'always' },
    { id: 'D1-U071', label: '둘 다 true', args: { require: true, snapshot: { require_approval: true } }, expected: 'always' },
    { id: 'D1-U072', label: '둘 다 없음/false = auto', args: { require: false, snapshot: { require_approval: false } }, expected: 'auto' },
    { id: 'D1-U073', label: '스냅샷 null + 행 true', args: { require: true, snapshot: { require_approval: null } }, expected: 'always' },
    { id: 'D1-U074', label: '스냅샷에 모르는 키 sendApproval:"auto" 를 심어도 행 true 가 이긴다', args: { require: true, snapshot: { sendApproval: 'auto', send_approval: 'auto' } }, expected: 'always' },
    { id: 'D1-U075', label: '스냅샷 중첩 { policy: { require_approval: false } } 은 행 true 를 못 끈다', args: { require: true, snapshot: { policy: { require_approval: false } } }, expected: 'always' },
  ])('[$id] $label → $expected', ({ args, expected }) => {
    const { policy, version } = rows(args);
    expect(resolvePolicy(policy, version, []).sendApproval).toBe(expected);
  });

  it.each([
    { id: 'D1-U076', label: '정책 포인터와 버전 행 번호 불일치(포인터만 조작)', args: { policyVersion: 3, versionRow: 2 } },
    { id: 'D1-U077', label: '포인터가 과거 버전(always 가 켜지기 전)을 가리킨다', args: { policyVersion: 1, versionRow: 2 } },
  ])('[$id] $label — 던져서 닫는다(옛 auto 버전으로 판정하지 않는다)', ({ args }) => {
    const { policy, version } = rows({ ...args, require: true });
    expect(() => resolvePolicy(policy, version, [])).toThrow(PolicyShapeError);
  });

  it.each([
    { id: 'D1-U078', label: '스냅샷 require_approval 이 문자열 "true"', value: 'true' },
    { id: 'D1-U079', label: '스냅샷 require_approval 이 숫자 1', value: 1 },
    { id: 'D1-U080', label: '스냅샷 require_approval 이 문자열 "always"', value: 'always' },
    { id: 'D1-U081', label: '스냅샷 require_approval 이 배열 [true]', value: [true] },
  ])('SUSPECT: [$id] $label — 행이 false 면 auto (칸 모양이 boolean 이 아니면 켜지지 않는다; 쓰는 길은 코드뿐이라 도달 불가)', ({ value }) => {
    const { policy, version } = rows({ require: false, snapshot: { require_approval: value } });
    expect(resolvePolicy(policy, version, []).sendApproval).toBe('auto');
  });
});

// ---------------------------------------------------------------------------
// 퍼징: 시드마다 수천 맥락. 각 시드가 한 번의 시도.
// ---------------------------------------------------------------------------
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('D1 엔진 — 퍼징 (시드당 1,500 맥락 × 전 단계)', () => {
  const seeds = Array.from({ length: 20 }, (_, index) => ({ id: `D1-U${String(82 + index).padStart(3, '0')}`, seed: 9000 + index * 37 }));
  it.each(seeds)('[$id] 시드 $seed — always 가 auto 보다 관대한 맥락이 없다', ({ seed }) => {
    const rand = prng(seed);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
    const some = <T,>(xs: readonly T[]): T[] => xs.filter(() => rand() < 0.4);
    const pool = [ALLOWED_RECIPIENT, STRANGER_RECIPIENT, THIRD, BLOCKED, 'Friend@Example.com', 'friend+tag@example.com'];
    let narrowed = 0;
    for (let i = 0; i < 1_500; i += 1) {
      const recipients = [pick(pool), ...some(pool)].filter((v, idx, xs) => xs.indexOf(v) === idx);
      const riskHold: RiskHoldContext | null = rand() < 0.3 ? null : { enforce: rand() < 0.8, agentTainted: rand() < 0.3, threadTainted: rand() < 0.2, taintedSenders: some(pool) };
      const thread = rand() < 0.3 ? verifiedThread(pick(['agent', 'external'] as const)) : null;
      const grant = rand() < 0.15 ? grantFor(rand() < 0.5 ? recipients : recipients.slice(1)) : null;
      const ctx = contextWith({
        attempt: { recipients, threadId: thread?.threadId ?? null, dlp: some(['atmark_credential', 'received_code'] as never[]) as never },
        suppressedRecipients: rand() < 0.1 ? [pick(pool)] : [],
        approval: {
          recipients,
          riskHold,
          thread,
          grant,
          humanApprovalRequired: rand() < 0.1 ? 'transition_announcement' : null,
          relationships: some(recipients).map((recipient) => ({ recipient, trustCategory: pick(['seed', 'approved'] as const), scope: 'recipient' as const })),
        },
      });
      const mode = pick(MODES);
      let result: { auto: Decision; always: Decision };
      try {
        result = both(ctx, mode, { preApproval: { autoApproveDomains: rand() < 0.3 ? ['example.com'] : [], autoApproveReplyWithinThread: rand() < 0.5, autoApproveVerificationSenders: rand() < 0.5 } });
      } catch {
        continue;
      }
      expect(RANK[result.always.verdict], `seed ${String(seed)} #${String(i)} ${mode}`).toBeLessThanOrEqual(RANK[result.auto.verdict]);
      if (result.always.verdict === 'allowed') {
        expect(grant !== null && recipients.every((r) => grant.recipients.includes(r)), `allowed without covering grant: ${mode}`).toBe(true);
      }
      if (RANK[result.always.verdict] < RANK[result.auto.verdict]) narrowed += 1;
    }
    expect(narrowed).toBeGreaterThan(50);
  });
});
