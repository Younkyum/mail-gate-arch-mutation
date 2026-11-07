/**
 * Stage 0~7 의 거부 축 전수 (계획 §5.1 *"+ Stage 0–6 각 거부 축"*).
 *
 * 각 `describe` 는 Stage 하나에 대응하고, 각 `it` 은 그 Stage 의 **거부 축 하나**다.
 * 축을 이 파일에서 세는 이유: 규칙 모듈에 새 거부 사유가 생겼는데 테스트가 없으면
 * 커버리지 게이트가 잡지만, **사유 코드만 바뀐 경우**는 커버리지가 잡지 못한다.
 * 여기서는 사유 코드 문자열까지 단언한다 — audit 질의(AC-9)의 축이 곧 이 문자열이다.
 */

import { describe, expect, it } from 'vitest';
import { evaluate, HARD_STAGES } from '../../../src/policy/engine';
import { normalizeAddress } from '../../../src/policy/policy-loader';
import { evaluateOutboundMode } from '../../../src/policy/rules/outbound-mode';
import { MAX_RECIPIENTS_PER_MESSAGE } from '../../../src/policy/rules/content';
import { UnimplementedOutboundModeError, type PolicyStamp } from '../../../src/policy/types';
import {
  ALLOWED_RECIPIENT,
  NOW,
  POLICY_VERSION_ID,
  STRANGER_RECIPIENT,
  basePolicy,
  contextWith,
  policyWith,
} from './fixtures';

const STAMP: PolicyStamp = { policyVersion: 1, policyVersionId: POLICY_VERSION_ID, evaluatedAt: NOW };

function reasonsOf(ctx: Parameters<typeof evaluate>[0], policy = basePolicy): readonly string[] {
  const decision = evaluate(ctx, policy);
  expect(decision.verdict).toBe('denied');
  return decision.reasons;
}

describe('Stage 순서 — 배열이 §4.2 표와 같다', () => {
  it('하드 Stage 는 0~6 의 7개이고 순서가 고정되어 있다', () => {
    expect(HARD_STAGES.map((stage) => stage.name)).toEqual([
      'kill_switch',
      'identity_binding',
      'suppression',
      'blocklist',
      'limits',
      'budget',
      'content_guards',
    ]);
    expect(HARD_STAGES.map((stage) => stage.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});

describe('Stage 0 — kill switches', () => {
  it.each(['delinquent', 'suspended'] as const)('billing_status = %s → org_billing_blocked', (billingStatus) => {
    expect(reasonsOf(contextWith({ organization: { billingStatus } }))).toContain('org_billing_blocked');
  });

  it('billing_status = trialing 은 막지 않는다 — 평가판이 발송 불가면 제품이 아니다', () => {
    expect(evaluate(contextWith({ organization: { billingStatus: 'trialing' } }), basePolicy).verdict).toBe(
      'allowed',
    );
  });

  it('abuse_freeze → org_abuse_freeze', () => {
    expect(reasonsOf(contextWith({ organization: { abuseFreeze: true } }))).toContain('org_abuse_freeze');
  });

  it('owner_paused → org_owner_paused (소유자 정지는 플랫폼 동결과 다른 사유 코드)', () => {
    const reasons = reasonsOf(contextWith({ organization: { ownerPaused: true } }));
    expect(reasons).toEqual(['org_owner_paused']);
    expect(evaluate(contextWith({ organization: { ownerPaused: true } }), basePolicy).verdict).toBe('denied');
  });

  it('동결과 소유자 정지가 함께 켜지면 사유가 둘 다 남는다 · 둘 다 꺼지면 Stage 0 은 막지 않는다', () => {
    expect(reasonsOf(contextWith({ organization: { abuseFreeze: true, ownerPaused: true } }))).toEqual(
      expect.arrayContaining(['org_abuse_freeze', 'org_owner_paused']),
    );
    expect(evaluate(contextWith({ organization: { abuseFreeze: false, ownerPaused: false } }), basePolicy).verdict).toBe('allowed');
  });

  it('셀프 가입 검토: pending_review → org_pending_review · rejected → org_review_rejected · active 는 막지 않는다', () => {
    const pending = contextWith({ organization: { reviewStatus: 'pending_review' } });
    expect(reasonsOf(pending)).toEqual(['org_pending_review']);
    expect(evaluate(pending, basePolicy).verdict).toBe('denied');
    const rejected = contextWith({ organization: { reviewStatus: 'rejected' } });
    expect(reasonsOf(rejected)).toEqual(['org_review_rejected']);
    expect(evaluate(rejected, basePolicy).verdict).toBe('denied');
    expect(evaluate(contextWith({ organization: { reviewStatus: 'active' } }), basePolicy).verdict).toBe('allowed');
    // 허용목록 방식 — 모르는 검토 상태도 거부(기본이 거부).
    const unknown = contextWith({ organization: { reviewStatus: 'on_hold' as unknown as 'active' } });
    expect(evaluate(unknown, basePolicy).verdict).toBe('denied');
  });

  it('agent.status != active → agent_not_active', () => {
    for (const status of ['provisioning', 'suspended', 'disabled'] as const) {
      expect(reasonsOf(contextWith({ agent: { status } }))).toContain('agent_not_active');
    }
  });

  it('outbound_mode = disabled → outbound_disabled (Stage 7 이 아니라 여기서)', () => {
    const decision = evaluate(contextWith({}), policyWith({ outboundMode: 'disabled' }));
    expect(decision.reasons).toContain('outbound_disabled');
  });

  it('여러 킬 스위치가 동시에 켜지면 사유가 전부 남는다', () => {
    const reasons = reasonsOf(
      contextWith({ organization: { abuseFreeze: true, billingStatus: 'suspended' }, agent: { status: 'suspended' } }),
    );
    expect(reasons).toEqual(
      expect.arrayContaining(['org_billing_blocked', 'org_abuse_freeze', 'agent_not_active']),
    );
  });
});

describe('Stage 1 — identity binding (AC-1)', () => {
  it('묶이지 않은 주소로 보내면 from_forgery', () => {
    expect(reasonsOf(contextWith({ attempt: { fromAddress: 'other@atmark.ai' } }))).toEqual(['from_forgery']);
  });

  it('여러 주소 중 하나와 일치하면 통과한다', () => {
    const decision = evaluate(
      contextWith({
        agent: { boundAddresses: ['first@atmark.ai', 'agent@atmark.ai'] },
        attempt: { fromAddress: 'agent@atmark.ai' },
      }),
      basePolicy,
    );
    expect(decision.verdict).toBe('allowed');
  });

  it('신원 거부는 한도·예산보다 먼저다 — 위조 발신자가 남의 한도를 쓰지 못한다', () => {
    const reasons = reasonsOf(
      contextWith({
        attempt: { fromAddress: 'other@atmark.ai' },
        counters: { agentLastMinute: 999 },
        budget: { monthToDateSpentCents: 999_999 },
      }),
    );
    expect(reasons).toEqual(['from_forgery']);
  });
});

describe('Stage 2 — suppression', () => {
  it('조직 억제 목록 → suppression_list', () => {
    expect(reasonsOf(contextWith({ suppressedRecipients: [ALLOWED_RECIPIENT] }))).toContain('suppression_list');
  });

  it('SES 계정 수준 억제 → ses_account_level_suppression (해소 경로가 다르므로 코드도 다르다)', () => {
    expect(reasonsOf(contextWith({ sesSuppressedRecipients: [ALLOWED_RECIPIENT] }))).toContain(
      'ses_account_level_suppression',
    );
  });

  it('양쪽에 동시에 걸리면 사유가 둘 다 남는다', () => {
    const reasons = reasonsOf(
      contextWith({ suppressedRecipients: [ALLOWED_RECIPIENT], sesSuppressedRecipients: [ALLOWED_RECIPIENT] }),
    );
    expect(reasons).toEqual(['suppression_list', 'ses_account_level_suppression']);
  });

  it('억제는 allowlist 를 이긴다 — 승인 판정보다 먼저이므로 (§4.2 원칙 1)', () => {
    const decision = evaluate(contextWith({ suppressedRecipients: [ALLOWED_RECIPIENT] }), basePolicy);
    expect(decision.verdict).toBe('denied');
  });
});

describe('Stage 3 — 발신 차단 목록 (정책 v2: 값 = 주소 · example.com · *.example.com)', () => {
  it.each([
    ['주소', ALLOWED_RECIPIENT],
    ['도메인(example.com)', 'example.com'],
  ])('%s 단위 차단 → recipient_blocklisted', (_kind, rule) => {
    expect(reasonsOf(contextWith({}), policyWith({ blocklist: [rule] }))).toEqual(['recipient_blocklisted']);
  });

  it.each([
    ['다른 도메인 항목', ['other.com']],
    ['빈 목록', []],
  ])('%s 은 아무것도 막지 않는다', (_kind, blocklist) => {
    expect(evaluate(contextWith({}), policyWith({ blocklist })).verdict).toBe('allowed');
  });

  it('수신자가 여럿일 때 하나만 걸려도 메시지 전체가 거부된다', () => {
    const decision = evaluate(
      contextWith({ attempt: { recipients: [ALLOWED_RECIPIENT, STRANGER_RECIPIENT] } }),
      policyWith({ blocklist: [STRANGER_RECIPIENT], allowlist: [ALLOWED_RECIPIENT, STRANGER_RECIPIENT] }),
    );
    expect(decision.reasons).toEqual(['recipient_blocklisted']);
  });

  it('**blocklist 는 allowlist 를 이긴다** (§4.2 — 화이트리스트 모드에서도)', () => {
    const decision = evaluate(
      contextWith({}),
      policyWith({ allowlist: [ALLOWED_RECIPIENT], blocklist: [ALLOWED_RECIPIENT] }),
    );
    expect(decision.verdict).toBe('denied');
    expect(decision.reasons).toEqual(['recipient_blocklisted']);
  });

  it('`example.com` 은 **그 도메인만** — 하위 도메인은 `*.example.com` 으로 따로 막는다(계약 v2 §1 권장안)', () => {
    const sub = contextWith({ attempt: { recipients: ['user@mail.example.com'] } });
    const allow = ['user@mail.example.com'];
    expect(evaluate(sub, policyWith({ blocklist: ['example.com'], allowlist: allow })).verdict).toBe('allowed');
    const denied = evaluate(sub, policyWith({ blocklist: ['*.example.com'], allowlist: allow }));
    expect(denied.verdict).toBe('denied');
    expect(denied.reasons).toEqual(['recipient_blocklisted']);
    // `*.` 은 정점을 덮지 않는다 — 둘 다 원하면 두 행.
    expect(evaluate(contextWith({}), policyWith({ blocklist: ['*.example.com'] })).verdict).toBe('allowed');
  });

  it('접미사 매칭이 도메인 경계를 지킨다 — `*.example.com` 이 `notexample.com` 을 막지 않는다', () => {
    const decision = evaluate(
      contextWith({ attempt: { recipients: ['user@notexample.com'] } }),
      policyWith({ blocklist: ['*.example.com', 'example.com'], allowlist: ['user@notexample.com'] }),
    );
    expect(decision.verdict).toBe('allowed');
  });

  it('`+tag` 는 로더 정규화를 거쳐 같은 주소로 판정된다 — 문자열 변형으로 차단이 뚫리지 않는다', () => {
    // 정규화 지점은 로더 하나다(§ `policy-loader.ts`). 엔진은 정규화된 값만 본다 —
    // 그래서 여기서도 로더의 함수를 거쳐 들어간다. 억제 목록 쪽의 같은 성질은
    // 교집합을 로더가 구하므로 `policy-loader.test.ts` 가 검사한다.
    const recipient = normalizeAddress('Victim+newsletter@Example.com');
    expect(recipient).toBe('victim@example.com');

    const decision = evaluate(
      contextWith({ attempt: { recipients: [recipient] }, approval: { recipients: ['victim+newsletter@example.com'] } }),
      policyWith({ blocklist: ['victim@example.com'], allowlist: ['victim+newsletter@example.com'] }),
    );
    expect(decision.reasons).toEqual(['recipient_blocklisted']);
  });

  it('`@` 가 없는 망가진 주소는 도메인 규칙에 걸리지 않는다 — 빈 도메인이 도메인 값과 일치하면 안 된다', () => {
    const decision = evaluate(
      contextWith({ attempt: { recipients: ['not-an-address'] }, approval: { recipients: ['not-an-address'] } }),
      policyWith({ blocklist: ['example.com'], allowlist: ['example.com'] }),
    );
    // Stage 3 을 지나(차단 아님) Stage 7 에서 목록 밖으로 거부된다 — 어느 쪽 도메인 규칙도 빈 도메인을 덮지 않는다.
    expect(decision.reasons).toEqual(['recipient_not_allowlisted']);
  });

  it('**전체(unrestricted) 는 차단 목록을 읽지 않는다** — 목록을 쓰는 모드는 화이트리스트·블랙리스트·레거시(계약 v2 §1 표)', () => {
    const policy = (mode: 'unrestricted' | 'blocklist_only' | 'approval_required') => policyWith({ outboundMode: mode, blocklist: [ALLOWED_RECIPIENT] });
    expect(evaluate(contextWith({}), policy('unrestricted')).reasons).toEqual(['unrestricted_mode']);
    expect(evaluate(contextWith({}), policy('blocklist_only')).reasons).toEqual(['recipient_blocklisted']);
    expect(evaluate(contextWith({}), policy('approval_required')).reasons).toEqual(['recipient_blocklisted']);
  });
});

describe('Stage 5 — budget', () => {
  it('예산을 넘기면 budget_exhausted', () => {
    expect(
      reasonsOf(contextWith({ budget: { monthToDateSpentCents: 10_000, thisAttemptCostCents: 1 } })),
    ).toEqual(['budget_exhausted']);
  });

  it('정확히 예산에 도달하는 시도는 통과한다 — 경계는 초과에서 막힌다', () => {
    const decision = evaluate(
      contextWith({ budget: { monthToDateSpentCents: 9_990, thisAttemptCostCents: 10 } }),
      basePolicy,
    );
    expect(decision.verdict).toBe('allowed');
  });

  it('이번 시도 비용을 더해서 판정한다 — 소진 후가 아니라 초과 전에 막는다', () => {
    const decision = evaluate(
      contextWith({ budget: { monthToDateSpentCents: 9_999, thisAttemptCostCents: 2 } }),
      basePolicy,
    );
    expect(decision.verdict).toBe('denied');
  });
});

describe('Stage 6 — content guards', () => {
  it('첨부 총량 초과 → attachment_bytes_exceeded', () => {
    const reasons = reasonsOf(
      contextWith({
        attempt: {
          attachments: [{ filename: 'a.pdf', mimeType: 'application/pdf', bytes: 5_000_001 }],
        },
      }),
    );
    expect(reasons).toContain('attachment_bytes_exceeded');
  });

  it('첨부 총량은 합계로 판정한다', () => {
    const reasons = reasonsOf(
      contextWith({
        attempt: {
          attachments: [
            { filename: 'a.pdf', mimeType: 'application/pdf', bytes: 3_000_000 },
            { filename: 'b.pdf', mimeType: 'application/pdf', bytes: 3_000_000 },
          ],
        },
      }),
    );
    expect(reasons).toContain('attachment_bytes_exceeded');
  });

  it('허용목록 밖 MIME → mime_type_not_allowed (차단목록이 아니라 허용목록이다)', () => {
    const reasons = reasonsOf(
      contextWith({
        attempt: {
          attachments: [{ filename: 'x.exe', mimeType: 'application/x-msdownload', bytes: 10 }],
        },
      }),
    );
    expect(reasons).toEqual(['mime_type_not_allowed']);
  });

  it('허용된 MIME + 한도 내 첨부는 통과한다', () => {
    const decision = evaluate(
      contextWith({
        attempt: { attachments: [{ filename: 'a.pdf', mimeType: 'application/pdf', bytes: 100 }] },
      }),
      basePolicy,
    );
    expect(decision.verdict).toBe('allowed');
  });

  it('시스템 절대 상한을 넘는 수신자 수 → recipient_ceiling_exceeded', () => {
    const recipients = Array.from(
      { length: MAX_RECIPIENTS_PER_MESSAGE + 1 },
      (_unused, index) => `r${index}@example.com`,
    );
    const ctx = contextWith({ attempt: { recipients } });
    const policy = policyWith({ limits: { recipientsPerMessage: 10_000 }, allowlist: recipients });
    // 요금제 클램프(ADR-0011 — beta 도 천장 50)가 Stage 4 에서 먼저 막는다. Stage 6 은 그 클램프가 사라져도 남는 **둘째 층**이다.
    expect(reasonsOf(ctx, policy)).toEqual(['recipients_per_message']);
    const content = HARD_STAGES.find((stage) => stage.name === 'content_guards');
    expect(content?.run(ctx, policy)?.reasons).toContain('recipient_ceiling_exceeded');
  });
});

describe('Stage 7 — outbound_mode', () => {
  it('allowlist_only — 수신자 전원이 목록 안이면 allowed', () => {
    const decision = evaluate(
      contextWith({ attempt: { recipients: [ALLOWED_RECIPIENT, 'second@example.com'] } }),
      policyWith({ allowlist: [ALLOWED_RECIPIENT, 'second@example.com'] }),
    );
    expect(decision.verdict).toBe('allowed');
    expect(decision.reasons).toEqual(['allowlist_match']);
  });

  it('allowlist_only — 한 명이라도 목록 밖이면 recipient_not_allowlisted', () => {
    const reasons = reasonsOf(
      contextWith({ attempt: { recipients: [ALLOWED_RECIPIENT, STRANGER_RECIPIENT] } }),
    );
    expect(reasons).toEqual(['recipient_not_allowlisted']);
  });

  it('unrestricted — 수신자 제한만 없다. 앞 Stage 는 그대로 적용된다', () => {
    const allowedDecision = evaluate(
      contextWith({ attempt: { recipients: [STRANGER_RECIPIENT] } }),
      policyWith({ outboundMode: 'unrestricted' }),
    );
    expect(allowedDecision.verdict).toBe('allowed');

    const stillDenied = evaluate(
      contextWith({ attempt: { recipients: [STRANGER_RECIPIENT] }, suppressedRecipients: [STRANGER_RECIPIENT] }),
      policyWith({ outboundMode: 'unrestricted' }),
    );
    expect(stillDenied.verdict).toBe('denied');
  });

  it('disabled 방어 분기 — Stage 0 을 건너뛰고 Stage 7 을 직접 불러도 거부한다', () => {
    // Stage 0 이 리팩터로 약해졌을 때 `disabled` 가 허용 쪽으로 굴러떨어지지 않는지.
    const decision = evaluateOutboundMode(
      contextWith({}),
      policyWith({ outboundMode: 'disabled' }),
      STAMP,
    );
    expect(decision.verdict).toBe('denied');
    expect(decision.reasons).toEqual(['outbound_disabled']);
  });

  // `approval_required`·`reply_only` 의 분기(P2)는 `stage7-approval.test.ts` 가 전수로 본다.

  it('열거형 밖 값이 DB 에서 들어와도 허용되지 않는다 (fail closed)', () => {
    const rogue = policyWith({}) as unknown as Parameters<typeof evaluateOutboundMode>[1];
    expect(() =>
      evaluateOutboundMode(contextWith({}), { ...rogue, outboundMode: 'not_a_mode' as never }, STAMP),
    ).toThrow(UnimplementedOutboundModeError);
  });
});
