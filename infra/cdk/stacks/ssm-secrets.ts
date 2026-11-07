/**
 * 비밀 → SSM Parameter Store 이전(2026-10-12, 진윤겸 "안전한 부분만 이전" · 배포 런북 §49)의 IAM 조각.
 *
 * - 파라미터(SecureString, standard, 고객 관리형 키 `alias/atmark-ssm-secrets` — `secrets-key-stack.ts`)는 **CloudFormation 이 만들지 않는다** — CFN 은 SecureString 을 만들 수 없고, 값은
 *   옛 Secrets Manager 비밀에서 **복사**한다(`scripts/admin/secrets-to-ssm.sh`, 진윤겸이 직접). DB 롤 12 자리는 그 뒤 migrate `bootstrap-roles` 가 쓴다.
 * - 읽기: 역할마다 **필요한 이름만** `ssm:GetParameter`(경로 와일드카드 없음) + 그 키 하나에 `kms:Decrypt`(SSM 경유 · 그 파라미터 ARN 의 암호화 문맥만).
 *   키 정책은 기본(계정 root → IAM 위임)뿐이라 이 IAM 문장을 받은 역할만 푼다 — `ssm:GetParameter *` 를 가진 NAT 역할도 kms 권한이 없어 못 푼다.
 * - 쓰기: migrate 역할 하나 — DB 롤 12 자리 `ssm:PutParameter`(+ 같은 키 `kms:Encrypt`·`GenerateDataKey` SSM 경유).
 * - **삭제는 아무도 못 한다**: 이 스택들의 모든 역할에 `ssm:DeleteParameter`·`ssm:DeleteParameters` 명시 Deny(애스펙트 — SES 발송 Deny 와 같은 모양).
 *   SSM 에는 Secrets Manager 의 삭제 복구 창이 없다 — 지우면 끝이다.
 */

import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';
import type { IConstruct } from 'constructs';

import { ssmParameterNameOf } from '../../../src/runtime/ssm-secret-names';

export const SSM_DELETE_DENY_SID = 'SsmParameterDeleteDeny';
export const SSM_DELETE_DENY_ACTIONS: readonly string[] = ['ssm:DeleteParameter', 'ssm:DeleteParameters'];

/** `atmark/db/app` → `arn:aws:ssm:<region>:<account>:parameter/atmark/db/app`(이름이 `/` 로 시작하면 ARN 에는 `/` 가 하나다). */
export function ssmParameterArn(stack: cdk.Stack, secretName: string): string {
  return `arn:${stack.partition}:ssm:${stack.region}:${stack.account}:parameter${ssmParameterNameOf(secretName)}`;
}

/** SSM 이 SecureString 을 풀 때 쓰는 KMS 문장 — 그 키 하나 · SSM 경유 · 암호화 문맥 `PARAMETER_ARN` 이 그 파라미터들일 때만. */
function kmsViaSsm(stack: cdk.Stack, sid: string, actions: string[], key: kms.IKey, parameterArns: string[]): iam.PolicyStatement {
  return new iam.PolicyStatement({
    sid,
    actions,
    resources: [key.keyArn],
    conditions: {
      StringEquals: { 'kms:ViaService': `ssm.${stack.region}.amazonaws.com`, 'kms:EncryptionContext:PARAMETER_ARN': parameterArns },
    },
  });
}

/** 역할에 SSM 비밀 읽기(GetParameter + 복호)를 준다. 이름은 옛 Secrets Manager 이름(`atmark/…`). */
export function grantSsmSecretRead(
  role: iam.IRole,
  sid: string,
  secretNames: readonly string[],
  key: kms.IKey,
  options: { conditions?: Record<string, unknown> } = {},
): void {
  const stack = cdk.Stack.of(role);
  const arns = secretNames.map((name) => ssmParameterArn(stack, name));
  role.addToPrincipalPolicy(
    new iam.PolicyStatement({ sid, actions: ['ssm:GetParameter'], resources: arns, ...(options.conditions ? { conditions: options.conditions } : {}) }),
  );
  role.addToPrincipalPolicy(kmsViaSsm(stack, `${sid}Decrypt`, ['kms:Decrypt'], key, arns));
}

/** migrate 역할 — DB 롤 자리 읽기·쓰기(GetParameter · PutParameter + KMS Encrypt/Decrypt SSM 경유). */
export function grantSsmSecretWrite(role: iam.IRole, sid: string, secretNames: readonly string[], key: kms.IKey): void {
  const stack = cdk.Stack.of(role);
  const arns = secretNames.map((name) => ssmParameterArn(stack, name));
  role.addToPrincipalPolicy(new iam.PolicyStatement({ sid, actions: ['ssm:GetParameter', 'ssm:PutParameter'], resources: arns }));
  role.addToPrincipalPolicy(kmsViaSsm(stack, `${sid}Kms`, ['kms:Decrypt', 'kms:Encrypt', 'kms:GenerateDataKey'], key, arns));
}

const denied = new WeakSet<iam.Role>();

/** 스택 안의 **모든 L2 IAM 역할**에 SSM 파라미터 삭제 명시 Deny 를 붙이는 애스펙트. */
export class SsmDeleteDenyAspect implements cdk.IAspect {
  public visit(node: IConstruct): void {
    if (!(node instanceof iam.Role) || denied.has(node)) return;
    denied.add(node);
    node.addToPolicy(new iam.PolicyStatement({ sid: SSM_DELETE_DENY_SID, effect: iam.Effect.DENY, actions: [...SSM_DELETE_DENY_ACTIONS], resources: ['*'] }));
  }
}

/** 스택에 애스펙트를 건다. 쓰는 스택: Compute · Transparency(SSM 비밀을 읽는 런타임 역할이 있는 두 스택). */
export function denySsmDeleteInStack(scope: IConstruct): void {
  cdk.Aspects.of(scope).add(new SsmDeleteDenyAspect());
}
