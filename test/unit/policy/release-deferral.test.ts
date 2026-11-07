/**
 * 릴리스 거부 분류표 (`src/policy/release-deferral.ts`) — **분류가 빠지면 빨개진다.**
 *
 * T3 결함("분당 한도 거부가 승인분을 영구 종결")의 재발 경로는 둘이다:
 *   ① 새 사유 코드가 생겼는데 표에 없다 → 기본값이 "영구" 면 그 사유의 승인분이 다시 영구 종결된다.
 *   ② 표에서 일시적 사유 하나가 영구로 바뀐다(또는 반대로 영구 사유가 일시적이 되어 무한 재시도).
 * ①은 `satisfies Record<DenyReason, …>` 가 컴파일에서 막고, 여기서는 **`types.ts` 원문의 유니온**과 표의 키를
 * 런타임에서 한 번 더 맞붙인다. ②는 기대 분류를 **표와 독립적으로** 적어 맞붙인다.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DENY_REASON_PERSISTENCE,
  planReleaseRetry,
  RELEASE_RETRY_MARGIN_SECONDS,
  RELEASE_WINDOW_GRACE_SECONDS,
  releaseWindowClosed,
} from '../../../src/policy/release-deferral';
import {
  allowed,
  deny,
  toDeniedDecision,
  type DecisionReason,
  type PolicyStamp,
} from '../../../src/policy/types';

const NOW = new Date('2026-10-15T12:00:00.000Z');
const DEADLINE = new Date(NOW.getTime() + 48 * 3_600_000);
const STAMP: PolicyStamp = { policyVersion: 1, policyVersionId: 'pv-1', evaluatedAt: NOW };

/** `types.ts` 의 `export type DenyReason = …;` 원문에서 문자열 리터럴을 전부 뽑는다. */
function denyReasonsFromSource(): string[] {
  const source = readFileSync(resolve(__dirname, '../../../src/policy/types.ts'), 'utf8');
  const start = source.indexOf('export type DenyReason =');
  const end = source.indexOf(';', start);
  if (start < 0 || end < 0) throw new Error('types.ts 에서 DenyReason 유니온을 찾지 못했다 — 이 검사가 공허해진다');
  const body = source.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  return [...body.matchAll(/'([a-z_]+)'/g)].map((match) => match[1] as string);
}

/**
 * **기대 분류 — 표를 보지 않고 적은 것이다.** 일시적 = 시간(또는 소유자의 설정 변경)만으로 풀리고 사람의 승인이
 * 그대로 유효한 것. 이 목록이 표와 갈라지면 둘 중 하나가 틀렸다.
 */
const EXPECTED_TRANSIENT = [
  'rate_limit_per_minute',
  'rate_limit_per_hour',
  'rate_limit_per_day',
  'warmup_daily_cap',
  'budget_exhausted',
  'evaluation_error',
  // ADR-0011 — 요금제 하루 한도. 워밍업 캡과 같은 성질(24시간 창 · 요금제 변경으로 풀린다).
  'plan_daily_cap',
  // ADR-0011 §9 — 요금제만 묶은 메시지당 수신자. 요금제가 풀리면 같은 봉투가 나간다(정책이 묶은 recipients_per_message 는 영구).
  'plan_recipients_per_message',
  // ADR-0014 — 요금제 강등으로 정지된 고객 도메인(업그레이드로 풀린다) · 도메인 워밍업 캡(24시간 창). `domain_suspended` 는 영구다.
  'domain_plan_limit',
  'domain_warmup_daily_cap',
].sort();

function denied(reasons: readonly [DecisionReason, ...DecisionReason[]], retryAfterSeconds: number | null = null) {
  return toDeniedDecision(deny(reasons, retryAfterSeconds), STAMP);
}

describe('분류표 — 모든 거부 사유가 정확히 한 번 분류돼 있다', () => {
  it('표의 키 집합 = types.ts 의 DenyReason 유니온 (새 사유가 표 밖에서 태어나지 않는다)', () => {
    const fromSource = denyReasonsFromSource();
    // 추출 자체가 살아 있다는 증거 — 0개면 아래 등식이 공허하게 참이 된다.
    expect(fromSource.length).toBeGreaterThanOrEqual(20);
    expect(Object.keys(DENY_REASON_PERSISTENCE).sort()).toEqual([...new Set(fromSource)].sort());
  });

  it('일시적 사유 집합이 기대와 같다 — 한도·워밍업·예산·평가 실패만 시간이 풀어 준다', () => {
    const transient = Object.entries(DENY_REASON_PERSISTENCE)
      .filter(([, persistence]) => persistence.kind === 'transient')
      .map(([reason]) => reason)
      .sort();
    expect(transient).toEqual(EXPECTED_TRANSIENT);
  });

  it('일시적 사유의 fallback 은 양수다 — 0 이면 같은 순간에 무한히 다시 집힌다', () => {
    for (const persistence of Object.values(DENY_REASON_PERSISTENCE)) {
      if (persistence.kind === 'transient') expect(persistence.fallbackRetrySeconds).toBeGreaterThan(0);
    }
  });
});

describe('planReleaseRetry — 미룰 것인가 / 닫을 것인가', () => {
  it('분당 한도 → retry_after + 여유 1초 뒤로 미룬다', () => {
    const plan = planReleaseRetry(denied(['rate_limit_per_minute'], 60), NOW, DEADLINE);
    expect(plan).toEqual({
      retryAt: new Date(NOW.getTime() + (60 + RELEASE_RETRY_MARGIN_SECONDS) * 1000),
      reason: 'rate_limit_per_minute',
    });
  });

  it('규칙이 retry_after 를 주지 않는 일시적 사유(예산) → 분류표의 fallback', () => {
    const plan = planReleaseRetry(denied(['budget_exhausted']), NOW, DEADLINE);
    expect(plan?.retryAt).toEqual(new Date(NOW.getTime() + (3600 + RELEASE_RETRY_MARGIN_SECONDS) * 1000));
    expect(plan?.reason).toBe('budget_exhausted');
  });

  it('재시도 시각은 창 끝을 넘지 않는다 — 창 끝의 재평가가 마지막 기회다', () => {
    const nearEnd = new Date(DEADLINE.getTime() - 10_000);
    expect(planReleaseRetry(denied(['warmup_daily_cap'], 36_000), nearEnd, DEADLINE)?.retryAt).toEqual(DEADLINE);
  });

  it('창 끝(이후)이면 일시적 사유도 닫는다 — 무한 재시도는 없다', () => {
    expect(planReleaseRetry(denied(['rate_limit_per_minute'], 60), DEADLINE, DEADLINE)).toBeNull();
    expect(planReleaseRetry(denied(['rate_limit_per_minute'], 60), new Date(DEADLINE.getTime() + 1), DEADLINE)).toBeNull();
  });

  it('영구 사유는 곧바로 닫는다 — 억제·차단·kill-switch 를 재시도하면 창 내내 헛돈다', () => {
    for (const reason of ['suppression_list', 'recipient_blocklisted', 'recipient_not_allowlisted', 'outbound_disabled', 'org_abuse_freeze', 'org_owner_paused', 'org_pending_review', 'org_review_rejected', 'from_forgery'] as const) {
      expect(planReleaseRetry(denied([reason]), NOW, DEADLINE)).toBeNull();
    }
  });

  it('검토 전·거절(셀프 가입)은 영구다 — 활성화 순간 검토 전에 쌓인 승인분이 몰려 나가지 않는다', () => {
    expect(DENY_REASON_PERSISTENCE.org_pending_review).toEqual({ kind: 'permanent' });
    expect(DENY_REASON_PERSISTENCE.org_review_rejected).toEqual({ kind: 'permanent' });
  });

  it('일시적 + 영구가 섞이면 닫는다 — 1분 뒤에도 수신자 수 초과는 그대로다', () => {
    expect(planReleaseRetry(denied(['rate_limit_per_minute', 'recipients_per_message'], 60), NOW, DEADLINE)).toBeNull();
  });

  it('여러 일시적 사유 — 규칙의 retry_after(가장 긴 것)가 fallback 보다 우선한다', () => {
    const plan = planReleaseRetry(denied(['rate_limit_per_minute', 'rate_limit_per_hour'], 3600), NOW, DEADLINE);
    expect(plan?.retryAt).toEqual(new Date(NOW.getTime() + (3600 + RELEASE_RETRY_MARGIN_SECONDS) * 1000));
    expect(plan?.reason).toBe('rate_limit_per_minute');
  });

  it('거부 사유가 아닌 표지만 있는 거부 → 닫는다(시간이 풀어 준다는 근거가 없다) · 표지는 분류에 관여하지 않는다', () => {
    expect(planReleaseRetry(denied(['bootstrap_grace']), NOW, DEADLINE)).toBeNull();
    expect(planReleaseRetry(denied(['bootstrap_grace', 'rate_limit_per_minute'], 60), NOW, DEADLINE)?.reason).toBe(
      'rate_limit_per_minute',
    );
  });

  it('거부가 아닌 판정은 미룰 것도 닫을 것도 없다', () => {
    expect(planReleaseRetry(allowed(['approval_granted'], STAMP), NOW, DEADLINE)).toBeNull();
  });
});

describe('releaseWindowClosed — 허용 쪽의 창 끝 (V1 MINOR-1)', () => {
  const GRACE_END = DEADLINE.getTime() + RELEASE_WINDOW_GRACE_SECONDS * 1000;

  it('창 끝 정각과 유예 안은 열려 있다 — 창 끝의 마지막 재평가가 스윕 지연으로 늦어도 보낸다', () => {
    expect(releaseWindowClosed(DEADLINE, DEADLINE)).toBe(false);
    expect(releaseWindowClosed(new Date(GRACE_END - 1), DEADLINE)).toBe(false);
  });

  it('창 끝 + 유예 정각부터 닫힌다 — 사흘 뒤는 물론이다', () => {
    expect(releaseWindowClosed(new Date(GRACE_END), DEADLINE)).toBe(true);
    expect(releaseWindowClosed(new Date(DEADLINE.getTime() + 24 * 3_600_000), DEADLINE)).toBe(true);
  });

  it('유예는 양수이고 한 시간보다 짧다 — 0 이면 창 끝 재평가가 닫히고, 길면 워커 정지가 늦은 발송이 된다', () => {
    expect(RELEASE_WINDOW_GRACE_SECONDS).toBeGreaterThan(0);
    expect(RELEASE_WINDOW_GRACE_SECONDS).toBeLessThan(3600);
  });

  it('release_window_expired 는 영구다 — 기다릴수록 더 늦는다', () => {
    expect(DENY_REASON_PERSISTENCE.release_window_expired).toEqual({ kind: 'permanent' });
    expect(planReleaseRetry(denied(['release_window_expired']), NOW, DEADLINE)).toBeNull();
  });
});
