/**
 * `atmark-domain-policy-audit` — SES identity 자원 정책의 **독립 감사**(ADR-0014 결정 4 · 보안 리뷰 M2 · 재검증 MEDIUM-1·2). **읽기 전용 · DB 없음 · VPC 밖 · 예약 1.**
 *
 * domain-control 은 정책을 쓰는 주체라 자기 감사(`audit_policy`)는 그 λ 가 탈취되면 같이 무너진다. 이 λ 는 **다른 역할**(SES `GetEmailIdentity` ·
 * `ListEmailIdentities` 뿐 — 변형·발송 0)로 같은 규칙(`src/domains/policy-shape.ts` = `check-ses-principals.sh` 자원 정책 절)을 본다.
 *
 * 입력은 둘뿐이다(그 밖은 던진다):
 *   - **CloudTrail 이벤트**(EventBridge — 정책 쓰기 `Create/UpdateEmailIdentityPolicy` · v1 `PutIdentityPolicy`, 지우기 `DeleteEmailIdentityPolicy` · v1
 *     `DeleteIdentityPolicy`): 그 identity 를 SES 에서 **지금** 다시 읽어 본다. 쓰기 이벤트면 **요청에 실린 정책 원문도** 같은 규칙으로 본다 — 탈취된
 *     domain-control 이 "넓은 정책 생성 → 발송 → 삭제" 를 하면 지금 상태는 깨끗하지만 원문은 남는다(재검증 MEDIUM-1). 둘 중 하나라도 위반이면 위반(OR).
 *     원문은 **알람 쪽으로만** 쓴다(원문이 깨끗해도 지금 상태 검사를 건너뛰지 않는다) — 그래서 이벤트를 믿어도 안전하다.
 *   - **`{"source":"atmark.schedule"}`**(Scheduler 12시간마다): 계정의 identity 전부 + **하트비트**(`atmark.domain.policy_audit_audited` — 0 이어도 낸다,
 *     결측이면 알람 — 재검증 MEDIUM-2).
 * 읽지 못한 identity(SES 오류 · 시간 예산 소진)는 `unreadable` 위반으로 센다 — 감사가 조용히 멈추지 않게(닫힌 쪽). 목록 자체를 못 읽으면 던진다(Lambda
 * Errors 알람). 결과: EMF `atmark.domain.policy_shape_violation`(위반 identity 수 — 0 이어도 낸다) → 알람 `atmark-domain-policy-shape`. 로그에는 문제 코드와
 * 수만(도메인명 없음) — 어느 identity 인지는 운영자가 `scripts/check-ses-principals.sh` 로 본다(런북 custom-domains §2).
 */

import { IDENTITY_MANAGED_TAG, IDENTITY_MANAGED_TAG_VALUE, IDENTITY_ROW_TAG } from '../../domains/contract';
import { emitDomainMetric, DOMAIN_METRIC_NAMES } from '../../domains/metrics';
import {
  DOMAIN_POLICY_AUDIT_SCHEDULE_INPUT,
  DOMAIN_POLICY_AUDIT_TRIGGER_EVENTS,
  DOMAIN_POLICY_WRITE_EVENTS,
  identityPolicyProblems,
  type PolicyShapeProblem,
} from '../../domains/policy-shape';
import { createSesIdentityControl, type SesIdentityControl } from '../../mail/transport/ses-identity';
import { log } from '../../observability/logger';
import { requireEnv, requireProductionRuntime, RUNTIME_ENV, RuntimeConfigError } from '../config';

export const DOMAIN_POLICY_AUDIT_ROUTE_ID = 'domain-policy-audit';

/** DB 연결 예산에 더하는 값 — DB 가 없다. */
export const DOMAIN_POLICY_AUDIT_POOL_MAX = 0;

/** 전수 감사의 시간 예산(ms) — λ 타임아웃(300초) 안. 넘으면 남은 identity 는 `unreadable` 위반으로 센다(조용히 건너뛰지 않는다). */
export const DOMAIN_POLICY_AUDIT_BUDGET_MS = 240_000;

/** 동시에 읽는 identity 수 — SES 제어면 레이트(초당 몇 건)를 넘지 않게 작게. */
export const DOMAIN_POLICY_AUDIT_CONCURRENCY = 4;

const SENDER_ROLE_ARN_PATTERN = /^arn:aws:iam::(\d{12}):role\/[A-Za-z0-9+=,.@_-]{1,64}$/;
const IDENTITY_NAME_PATTERN = /^[A-Za-z0-9._@+-]{1,320}$/;

export interface DomainPolicyAuditDependencies {
  readonly ses: Pick<SesIdentityControl, 'getIdentity' | 'listIdentities'>;
  readonly senderRoleArn: string;
  readonly accountId: string;
  readonly region: string;
  /** 시계(테스트는 가짜). */
  readonly now?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 이벤트가 실어 온 정책(쓰기 이벤트만) — 이름 · 원문. */
export interface EventPolicy {
  readonly name: string;
  readonly document: string;
}

export type AuditTarget =
  | { readonly kind: 'all' }
  | { readonly kind: 'one'; readonly identity: string; readonly eventPolicy: EventPolicy | 'unreadable' | null };

/** 입력 판별 — 정기(전수) · CloudTrail(identity 하나 + 쓰기면 원문). 그 밖은 던진다. */
export function auditTargetOf(event: unknown): AuditTarget {
  if (isRecord(event) && Object.keys(event).length === 1 && event['source'] === DOMAIN_POLICY_AUDIT_SCHEDULE_INPUT.source) return { kind: 'all' };
  if (isRecord(event) && event['source'] === 'aws.ses' && event['detail-type'] === 'AWS API Call via CloudTrail' && isRecord(event['detail'])) {
    const detail = event['detail'];
    const parameters = isRecord(detail['requestParameters']) ? detail['requestParameters'] : {};
    const name = typeof detail['eventName'] === 'string' ? detail['eventName'] : '';
    if (DOMAIN_POLICY_AUDIT_TRIGGER_EVENTS.includes(name)) {
      // v2 `emailIdentity`·`policyName`·`policy` · v1 `identity`·`policyName`·`policy`.
      const identity = parameters['emailIdentity'] ?? parameters['identity'];
      // 이름을 읽지 못한 정책 이벤트도 놓치지 않는다 — 전수로 본다.
      if (typeof identity !== 'string' || !IDENTITY_NAME_PATTERN.test(identity)) return { kind: 'all' };
      const policyName = parameters['policyName'];
      const document = parameters['policy'];
      if (!DOMAIN_POLICY_WRITE_EVENTS.includes(name)) return { kind: 'one', identity, eventPolicy: null };
      // ★ 쓰기 이벤트인데 원문이 문자열이 아니면(칸 이름이 다르다 · 잘렸다) 조용히 지금 상태만 보지 않는다 — `unreadable` 위반(재검증 LOW-A).
      //   CloudTrail 칸 이름은 실물로 아직 확인하지 않았다(deploy §38-2 M5 체크리스트) — 다르면 쓰기마다 알람 45 로 크게 드러난다.
      if (typeof document !== 'string') return { kind: 'one', identity, eventPolicy: 'unreadable' };
      return { kind: 'one', identity, eventPolicy: { name: typeof policyName === 'string' ? policyName : '', document } };
    }
  }
  throw new Error('domain-policy-audit: 모르는 입력(정기 {source} · SES 정책 CloudTrail 이벤트만)');
}

/**
 * 감사 문제 코드 — 정책 모양(`PolicyShapeProblem`, = check-ses-principals.sh) + **고아 태그**(#13 보안 리뷰 M2): 관리 표시(`atmark:managed=customer-domain`)가
 * 있는 identity 의 행 태그(`atmark:row`)가 없거나 행 id 모양이 아니다 — 어느 행의 제거 사가도 이 identity 를 지우지 못한다(태그가 같아야 지운다).
 */
export type AuditProblem = PolicyShapeProblem | 'orphan_tag';

const ROW_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface AuditResult {
  readonly audited: number;
  readonly violating: number;
  readonly problems: readonly AuditProblem[];
  /**
   * 전수 감사에서 본 **관리 identity 의 행 태그**(uuid 만 — 도메인 이름 없음). 감사 λ 에는 DB 가 없어 "태그가 removed·done 행을 가리킨다" 는 여기서
   * 판정하지 못한다 — 로그 `domain_policy_audit.managed_rows` 로 내고, 운영자가 런북 custom-domains §3 의 질의로 대조한다(행 상태는 DB 에만 있다).
   */
  readonly managedRows: readonly string[];
}

export async function runDomainPolicyAudit(deps: DomainPolicyAuditDependencies, target: AuditTarget): Promise<AuditResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  // 목록을 못 읽으면 던진다 — Lambda Errors 알람(재검증 MEDIUM-2). 하트비트도 나가지 않으므로 결측 알람이 한 번 더 본다.
  const identities = target.kind === 'all' ? await deps.ses.listIdentities() : [target.identity];
  const problems = new Set<AuditProblem>();
  const managedRows = new Set<string>();
  let violating = 0;
  const flag = (found: readonly AuditProblem[]): void => {
    if (found.length === 0) return;
    violating += 1;
    for (const problem of found) problems.add(problem);
  };
  const auditOne = async (identity: string): Promise<void> => {
    const found = new Set<AuditProblem>();
    // 쓰기 이벤트의 원문 — 지금 상태와 OR(재검증 MEDIUM-1).
    if (target.kind === 'one' && target.eventPolicy === 'unreadable') found.add('unreadable');
    if (target.kind === 'one' && target.eventPolicy !== null && target.eventPolicy !== 'unreadable') {
      for (const problem of identityPolicyProblems(identity, { [target.eventPolicy.name]: target.eventPolicy.document }, deps)) found.add(problem);
    }
    if (now() - started > DOMAIN_POLICY_AUDIT_BUDGET_MS) {
      found.add('unreadable');
    } else {
      try {
        const snapshot = await deps.ses.getIdentity(identity);
        if (snapshot !== null) {
          for (const problem of identityPolicyProblems(identity, snapshot.policies, deps)) found.add(problem);
          if (snapshot.tags[IDENTITY_MANAGED_TAG] === IDENTITY_MANAGED_TAG_VALUE) {
            const row = snapshot.tags[IDENTITY_ROW_TAG];
            if (row === undefined || !ROW_ID_PATTERN.test(row)) found.add('orphan_tag');
            else managedRows.add(row);
          }
        }
      } catch {
        // 읽지 못했다 — 닫힌 쪽으로 위반(재검증 MEDIUM-2). 다른 identity 는 계속 본다.
        found.add('unreadable');
      }
    }
    flag([...found]);
  };
  // 작은 동시성으로 — 한 identity 의 실패가 전체를 멈추지 않는다.
  const queue = [...identities];
  const workers = Array.from({ length: Math.min(DOMAIN_POLICY_AUDIT_CONCURRENCY, queue.length) }, async () => {
    for (let identity = queue.shift(); identity !== undefined; identity = queue.shift()) await auditOne(identity);
  });
  await Promise.all(workers);
  return { audited: identities.length, violating, problems: [...problems].sort(), managedRows: [...managedRows].sort() };
}

export function composeDomainPolicyAudit(env: NodeJS.ProcessEnv): DomainPolicyAuditDependencies {
  requireProductionRuntime(env);
  const senderRoleArn = requireEnv(env, RUNTIME_ENV.senderRoleArn);
  const match = SENDER_ROLE_ARN_PATTERN.exec(senderRoleArn);
  if (match === null) throw new RuntimeConfigError(`${RUNTIME_ENV.senderRoleArn} 가 IAM 역할 ARN 이 아니다.`);
  const region = requireEnv(env, RUNTIME_ENV.region);
  return { ses: createSesIdentityControl(region), senderRoleArn, accountId: match[1] ?? '', region };
}

export function createDomainPolicyAuditHandler(compose: () => DomainPolicyAuditDependencies) {
  let deps: DomainPolicyAuditDependencies | undefined;
  return async (event: unknown): Promise<{ readonly audited: number; readonly violating: number }> => {
    deps ??= compose();
    const target = auditTargetOf(event);
    const result = await runDomainPolicyAudit(deps, target);
    emitDomainMetric(DOMAIN_METRIC_NAMES.policyShapeViolation, result.violating);
    // 하트비트 — 정기 전수만(이벤트 감사는 드물어 결측 판정에 쓰지 않는다).
    if (target.kind === 'all') emitDomainMetric(DOMAIN_METRIC_NAMES.policyAuditAudited, result.audited);
    log(result.violating > 0 ? 'error' : 'info', 'domain_policy_audit.result', {
      route_id: DOMAIN_POLICY_AUDIT_ROUTE_ID,
      outcome: result.violating > 0 ? 'violation' : 'clean',
      detail: `scope=${target.kind} audited=${String(result.audited)} violating=${String(result.violating)} problems=${result.problems.join(',')}`,
    });
    // 관리 identity 의 행 태그(전수만) — DB 의 removed·done 행과 대조하는 재료(런북 custom-domains §3). uuid 만, 최대 200개.
    if (target.kind === 'all') {
      log('info', 'domain_policy_audit.managed_rows', {
        route_id: DOMAIN_POLICY_AUDIT_ROUTE_ID,
        outcome: 'listed',
        detail: `count=${String(result.managedRows.length)} rows=${result.managedRows.slice(0, 200).join(',')}`,
      });
    }
    return { audited: result.audited, violating: result.violating };
  };
}

export const handler = createDomainPolicyAuditHandler(() => composeDomainPolicyAudit(process.env));
