/**
 * src/runtime/ssm-secret-names.ts — SSM Parameter Store 로 옮긴 비밀의 **이름만**(2026-10-12 비밀 → SSM 이전). SDK·네트워크 없음 —
 * CDK(`infra/cdk/stacks/ssm-secrets.ts`)와 런타임(`secrets.ts`)이 같은 목록을 쓰려고 따로 둔다. 이전 스크립트
 * `scripts/admin/secrets-to-ssm.sh` 의 목록과 같은지 테스트가 대조한다.
 */

/** SSM 파라미터 이름의 접두사 — 옛 Secrets Manager 이름 `atmark/<경로>` 는 `/atmark/<경로>` 가 된다. */
export const SSM_SECRET_PREFIX = '/atmark/';

/**
 * SecureString 의 **고객 관리형 KMS 키** 별칭(`infra/cdk/stacks/secrets-key-stack.ts`). AWS 관리형 `alias/aws/ssm` 은 계정 안의 모든 주체에게 SSM 경유
 * 복호를 허락하므로 쓰지 않는다(보안 리뷰 — NAT 인스턴스 역할이 `ssm:GetParameter *` 를 가진다). 롤 부트스트랩·이전 스크립트가 쓸 때 이 키를 지정한다.
 */
export const SSM_SECRETS_KEY_ALIAS = 'alias/atmark-ssm-secrets';

/** SSM SecureString(standard) 값의 상한 — 4 KB. 넘는 값은 쓰지 않는다(이전 스크립트도 같은 상한으로 실패 표시). */
export const SSM_STANDARD_VALUE_MAX_BYTES = 4096;

/**
 * SSM 으로 옮긴 비밀 20 — 옛 Secrets Manager 이름(`atmark/…`). 새 이름은 `ssmParameterNameOf`. 이전 스크립트
 * (`scripts/admin/secrets-to-ssm.sh`)·CDK(`infra/cdk/stacks/ssm-secrets.ts`)가 같은 목록인지 테스트가 대조한다.
 * 첫 12개가 DB 롤(migrate `bootstrap-roles` 가 쓴다), 나머지 8개는 사람이 넣는 키링·API 키다.
 */
export const SSM_DB_ROLE_SECRET_NAMES = [
  'atmark/db/owner',
  'atmark/db/app',
  'atmark/db/admin',
  'atmark/db/login-mailer',
  'atmark/db/passport-signer',
  'atmark/db/tlog',
  'atmark/db/tlog-anchor',
  'atmark/db/billing',
  'atmark/db/billing-operator',
  'atmark/db/ops',
  'atmark/db/domain-tick',
  'atmark/db/ai-watch',
] as const;

export const SSM_SECRET_NAMES = [
  ...SSM_DB_ROLE_SECRET_NAMES,
  'atmark/approval-link-keys',
  'atmark/owner-login-keys',
  'atmark/ops-keys',
  'atmark/ops-login-keys',
  'atmark/contact-forward-to',
  'atmark/billing/paddle/admin-api-key',
  'atmark/billing/paddle/sync-api-key',
  'atmark/billing/paddle/webhook-secret',
] as const;

/** `atmark/db/app` → `/atmark/db/app`. */
export function ssmParameterNameOf(secretName: string): string {
  return `/${secretName}`;
}

/** 이 식별자는 SSM 파라미터 이름인가(`/atmark/…`). 아니면 Secrets Manager(ARN 또는 이름)다. */
export function isSsmParameterName(secretId: string): boolean {
  return secretId.startsWith(SSM_SECRET_PREFIX);
}
