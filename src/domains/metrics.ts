/**
 * src/domains/metrics.ts — 고객 도메인 **알람 수치**(ADR-0014 · 계획 §3.4·§3.5·§3.6·§3.8 — 알람 7 + `domain.policy_too_large`). 시끄러운 수신(41)만은 여기 없다 — 수신 소비자가
 * `METRIC_NAMES.inboundUnknownCustomDomain` 으로 낸다(틱 집계는 도메인 틱 롤에 수신 거부 표 권한이 필요해 하지 않았다, 2026-10-12).
 *
 * 이름은 알람(`infra/cdk/stacks/observability-stack.ts` 38~44번)과의 단일 진실 원천이다. 네임스페이스는 기존 `METRIC_NAMESPACE`('Atmark').
 * **차원이 없다** — 도메인 id·이름은 메트릭에 싣지 않는다(기수 · 관측 PII 규칙). 어느 도메인인지는 같은 틱의 로그(`DOMAIN_LOG_EVENTS` — 도메인 id 만)가
 * 말한다. 방출은 확인 틱(단계 4 — admin λ 의 `{task:'domain-recheck'}`)이 한다: 틱마다 `dueBacklog` 를 **0 이어도** 낸다(결측 = 틱 정지 —
 * `atmark-domain-check-stale` 이 결측을 위반으로 읽는다).
 */

import { writeLine } from '../observability/logger';
import { METRIC_NAMESPACE } from '../observability/metrics';

export const DOMAIN_METRIC_NAMES = {
  /** 확인·사가·감사 결과가 `error`(DNS·SES·RDAP 인프라 오류 — 소유권 상실로 세지 않는 것)인 건수. 알람 `atmark-domain-check-errors`. */
  checkError: 'atmark.domain.check_error',
  /** 생성 사가가 다른 행의 identity 를 만났다(`identity_owned_elsewhere` — 운영자 판단). 같은 알람(1건이 곧 알람). */
  identityOwnedElsewhere: 'atmark.domain.identity_owned_elsewhere',
  /** 틱마다 한 번(0 이어도): next_check_at 이 1시간 넘게 지난 행 수. 알람 `atmark-domain-check-stale`(결측 = 위반). */
  dueBacklog: 'atmark.domain.due_backlog',
  /**
   * 틱마다 한 번(0 이어도): **고아 identity 후보**(#13 재검증) — 대체된 옛 행은 제거 사가를 끝냈는데(done) 후속 행은 채택 전(saga_step none · 태그가 자기 것
   * 아님)에 removed 가 된 쌍의 수. 0 이 정상. 알람(1 이상)은 후속(observability-stack).
   */
  orphanCandidates: 'atmark.domain.orphan_candidates',
  /** 평판 판정이 경고 또는 동결(J6). 알람 `atmark-domain-reputation-freeze`. */
  reputationFlagged: 'atmark.domain.reputation_flagged',
  /** verified·suspended 도메인의 MX 가 SES 밖으로 바뀌었다. 알람 `atmark-domain-mx-conflict`. */
  mxConflict: 'atmark.domain.mx_conflict',
  /** 정책 감사가 drift 를 찾았다(덮어쓰기 + operator 정지). 알람 `atmark-domain-policy-drift`. */
  policyDrift: 'atmark.domain.policy_drift',
  /** 정책이 20개를 넘는다 — 기존 정책 유지(`too_large`). 알람 `atmark-domain-policy-too-large`. */
  policyTooLarge: 'atmark.domain.policy_too_large',
  /** 독립 감사(`domain-policy-audit` λ — 읽기 전용 역할)가 계약 모양이 아닌 자원 정책을 가진 identity 수(0 이어도 낸다). 알람 `atmark-domain-policy-shape`. */
  policyShapeViolation: 'atmark.domain.policy_shape_violation',
  /** 정기 전수 감사의 **하트비트**(본 identity 수 — 0 이어도 낸다). 하루 동안 없으면 알람 `atmark-domain-policy-audit-silence`(결측 = 위반). */
  policyAuditAudited: 'atmark.domain.policy_audit_audited',
  /**
   * 틱마다 한 번(0 이어도): **활성 identity 관리자 수**(2026-10 one-shot — DB `identity_claimed_at` 있음 · released · deleted 없음). SES 리전 identity
   * 할당량(10,000)의 10% 를 넘으면 알람(`IDENTITIES_HELD_ALARM_THRESHOLD`).
   */
  identitiesHeld: 'atmark.domain.identities_held',
  /** identity 관리권 이동(선점 인수 · 양도 · 넘겨주기) 건수. 알람 없음(관측용). */
  identityHandover: 'atmark.domain.identity_handover',
} as const;

export type DomainMetricName = (typeof DOMAIN_METRIC_NAMES)[keyof typeof DOMAIN_METRIC_NAMES];

/** 메트릭 한 건(EMF 한 줄, 차원 없음 = 빈 집합 롤업). **던지지 않는다.** */
export function emitDomainMetric(name: DomainMetricName, value: number): void {
  let line: string;
  try {
    line = JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [{ Namespace: METRIC_NAMESPACE, Dimensions: [[]], Metrics: [{ Name: name, Unit: 'Count' }] }],
      },
      [name]: value,
    });
  } catch {
    return;
  }
  writeLine(line);
}
