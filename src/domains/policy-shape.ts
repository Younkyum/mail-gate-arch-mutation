/**
 * src/domains/policy-shape.ts — SES identity 자원 정책의 **모양 검사**(ADR-0014 결정 4 · 보안 리뷰 M2). 순수 함수.
 *
 * domain-control 이 정책을 쓰고 확인 틱이 그 정책을 domain-control 로 감사하면, domain-control 이 탈취됐을 때 감사도 같이 거짓말한다. 그래서 **다른
 * 주체**(읽기 전용 `domain-policy-audit` λ — 역할은 SES Get·List 뿐)가 같은 규칙으로 본다. 규칙은 `scripts/check-ses-principals.sh` 의 자원 정책 절과
 * 같다(allowlist `resourcePolicyGrants`):
 *   - 플랫폼 identity(`atmark.ai` 와 그 하위)에는 정책이 **없다**.
 *   - 고객 identity 의 정책 이름은 `atmark-sender-` 로 시작하고, 모든 Statement 는 Allow · Principal = `{"AWS": 발송 역할 ARN}` 하나 · Not* 칸 없음 ·
 *     Action ⊆ {SendEmail, SendRawEmail}(비지 않음) · Resource = 그 identity ARN 하나 · Condition = `StringEquals ses:FromAddress` 하나(그 도메인 주소, 비지 않음).
 * 결과는 **문제 코드 목록**(도메인·주소 값 없음 — 로그·메트릭에 실어도 된다).
 */

import { IDENTITY_POLICY_NAME_PREFIX } from './contract';

/** 독립 감사 λ 의 정기 전수 입력(인프라 · 핸들러가 같은 값을 본다). */
export const DOMAIN_POLICY_AUDIT_SCHEDULE_INPUT = { source: 'atmark.schedule' } as const;

/** 정책 **원문을 싣는** CloudTrail 이벤트(쓰기 — v2 둘 · v1 하나). 감사 λ 는 이 원문도 검사한다(보안 재검증 MEDIUM-1 — 만들고 보내고 지우는 사이를 닫는다). */
export const DOMAIN_POLICY_WRITE_EVENTS: readonly string[] = ['CreateEmailIdentityPolicy', 'UpdateEmailIdentityPolicy', 'PutIdentityPolicy'];

/** 정책을 지우는 CloudTrail 이벤트 — 지운 뒤의 상태를 다시 본다(짧은 생성→삭제 짝의 마지막 단계). */
const DOMAIN_POLICY_DELETE_EVENTS: readonly string[] = ['DeleteEmailIdentityPolicy', 'DeleteIdentityPolicy'];

/** 독립 감사 λ 를 깨우는 CloudTrail 이벤트 이름 전부. */
export const DOMAIN_POLICY_AUDIT_TRIGGER_EVENTS: readonly string[] = [...DOMAIN_POLICY_WRITE_EVENTS, ...DOMAIN_POLICY_DELETE_EVENTS];

/** 정책을 가질 수 없는 플랫폼 identity(와 그 하위). */
const PLATFORM_IDENTITIES: readonly string[] = ['atmark.ai'];

const ALLOWED_ACTIONS = new Set(['ses:SendEmail', 'ses:SendRawEmail']);

export type PolicyShapeProblem =
  | 'platform_policy'
  | 'name_prefix'
  | 'not_json'
  | 'no_statement'
  | 'not_allow'
  | 'not_field'
  | 'principal'
  | 'action'
  | 'resource'
  | 'condition'
  | 'from_address'
  /** 감사가 그 identity 를 읽지 못했다(SES 오류 · 시간 예산 소진) — 닫힌 쪽: 위반으로 센다(보안 재검증 MEDIUM-2). */
  | 'unreadable';

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined ? [] : [value];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, i) => key === expected[i]);
}

export function isPlatformIdentity(identity: string): boolean {
  const lower = identity.toLowerCase();
  return PLATFORM_IDENTITIES.some((platform) => lower === platform || lower.endsWith(`.${platform}`));
}

/** identity 하나의 정책 전부를 검사한다 — 문제가 없으면 빈 배열. */
export function identityPolicyProblems(
  identity: string,
  policies: Readonly<Record<string, string>>,
  frame: { readonly senderRoleArn: string; readonly accountId: string; readonly region: string },
): PolicyShapeProblem[] {
  const names = Object.keys(policies);
  if (isPlatformIdentity(identity)) return names.length > 0 ? ['platform_policy'] : [];
  const problems = new Set<PolicyShapeProblem>();
  const resource = `arn:aws:ses:${frame.region}:${frame.accountId}:identity/${identity}`;
  for (const name of names) {
    if (!name.startsWith(IDENTITY_POLICY_NAME_PREFIX)) problems.add('name_prefix');
    let document: unknown;
    try {
      document = JSON.parse(policies[name] ?? '');
    } catch {
      problems.add('not_json');
      continue;
    }
    const statements = isRecord(document) ? asArray(document['Statement']) : [];
    if (statements.length === 0) problems.add('no_statement');
    for (const raw of statements) {
      if (!isRecord(raw)) {
        problems.add('no_statement');
        continue;
      }
      if (raw['Effect'] !== 'Allow') problems.add('not_allow');
      if ('NotPrincipal' in raw || 'NotAction' in raw || 'NotResource' in raw) problems.add('not_field');
      const principal = raw['Principal'];
      if (!isRecord(principal) || !sameKeys(principal, ['AWS']) || principal['AWS'] !== frame.senderRoleArn) problems.add('principal');
      const actions = asArray(raw['Action']);
      if (actions.length === 0 || actions.some((action) => typeof action !== 'string' || !ALLOWED_ACTIONS.has(action))) problems.add('action');
      const resources = asArray(raw['Resource']);
      if (resources.length !== 1 || resources[0] !== resource) problems.add('resource');
      const condition = raw['Condition'];
      const equals = isRecord(condition) ? condition['StringEquals'] : undefined;
      if (!isRecord(condition) || !sameKeys(condition, ['StringEquals']) || !isRecord(equals) || !sameKeys(equals, ['ses:FromAddress'])) {
        problems.add('condition');
        continue;
      }
      const addresses = asArray(equals['ses:FromAddress']);
      if (addresses.length === 0 || addresses.some((address) => typeof address !== 'string' || !address.endsWith(`@${identity}`) || address.indexOf('@') !== address.lastIndexOf('@'))) {
        problems.add('from_address');
      }
    }
  }
  return [...problems].sort();
}
