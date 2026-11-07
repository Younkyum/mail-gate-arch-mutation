/**
 * 비발송 역할의 **SES 발송 명시 Deny**(ADR-0014 결정 4 · 계획 §3.5 "발송 역할 외 모든 런타임 역할").
 *
 * 고객 도메인 identity 에는 identity policy(자원 기반 권한)가 붙는다. 그 정책의 Principal 은 발송 역할 하나로만 조립되지만(domain-control 의
 * `SENDER_ROLE_ARN`), domain-control 이 탈취되거나 운영자가 콘솔에서 정책을 넓히면 **IAM Allow 가 없는 역할도** 같은 계정 주체라 그 정책만으로
 * 보낼 수 있다(스파이크 S1 ① — SES IAM 권한 0 인 역할이 identity policy 만으로 발송). 그 길을 identity 기반 **Deny** 로 닫는다 — Deny 는 자원 정책의
 * Allow 보다 먼저다. 발송 주체는 그대로 둘(발송 역할 · login-mailer)이고, 그 둘에는 붙이지 않는다.
 *
 * `ses:Send*` — SendEmail·SendRawEmail 만이 아니라 identity policy 가 줄 수 있는 나머지 발송 액션(템플릿·대량)과 확인 메일 발송까지 한 문장으로.
 * 발송 주체 둘을 뺀 **모든 역할**에 붙인다 — 아래 애스펙트(`SesSendDenyAspect`)가 스택 안의 L2 역할을 전수로 돈다(재검증 INFO). `test/arch/iam-single-principal.arch.test.ts`
 * 가 산출물로 전수 확인한다.
 */

import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { IConstruct } from 'constructs';

export const SES_SEND_DENY_SID = 'SesSendDenyNonSendingRole';

/** 발송 주체(발송 역할 · login-mailer) — Deny 를 붙이지 않는다. 이미 붙인 역할은 두 번 붙이지 않는다. */
const exempt = new WeakSet<iam.IRole>();
const denied = new WeakSet<iam.IRole>();

/** Deny 문장이 덮는 액션 — 와일드카드 하나(발송 계열 전부). */
export const SES_SEND_DENY_ACTIONS: readonly string[] = ['ses:Send*'];

export function denySesSending(role: iam.Role): void {
  if (denied.has(role)) return;
  denied.add(role);
  role.addToPolicy(
    new iam.PolicyStatement({
      sid: SES_SEND_DENY_SID,
      effect: iam.Effect.DENY,
      actions: [...SES_SEND_DENY_ACTIONS],
      resources: ['*'],
    }),
  );
}


/** 이 역할은 발송 주체다 — 애스펙트가 Deny 를 붙이지 않는다(Layer E `mustEqual: 2` 의 둘에만 쓴다). */
export function exemptFromSesSendDeny(role: iam.Role): void {
  exempt.add(role);
}

/**
 * 스택 안의 **모든 L2 IAM 역할**(Lambda · Scheduler 대상 · 커스텀 리소스 · CI/CD 배포 역할)에 `ses:Send*` 명시 Deny 를 붙이는 애스펙트(보안 재검증 INFO —
 * 비용 0, 일관성). 발송 주체 둘은 `exemptFromSesSendDeny` 로 뺀다. 역할 목록을 손으로 적지 않으므로 CDK 가 만드는 역할(Scheduler 대상 · AwsCustomResource
 * 의 함수)도 빠지지 않는다. 쓰는 스택: Compute · Transparency · Inbound · Site · Docs · CiCd.
 */
export class SesSendDenyAspect implements cdk.IAspect {
  public visit(node: IConstruct): void {
    if (!(node instanceof iam.Role) || exempt.has(node)) return;
    denySesSending(node);
  }
}

/** 스택에 애스펙트를 건다. */
export function denySesSendingInStack(scope: IConstruct): void {
  cdk.Aspects.of(scope).add(new SesSendDenyAspect());
}
