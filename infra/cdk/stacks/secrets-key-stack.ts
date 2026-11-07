/**
 * AtmarkSecretsKey — SSM 으로 옮긴 비밀 20(`/atmark/…` SecureString)의 **고객 관리형 KMS 키** 하나(2026-10-12 비밀 → SSM 이전 · 배포 런북 §49).
 *
 * 왜 AWS 관리형 `alias/aws/ssm` 이 아닌가(보안 리뷰 HIGH): 그 키의 키 정책은 **계정 안의 모든 주체**에게 SSM 경유 Decrypt 를 허락한다. 그러면
 * `ssm:GetParameter` 를 `*` 로 가진 역할(NAT 인스턴스의 `AmazonSSMManagedInstanceCore`)이 IAM 의 kms 권한 없이 `/atmark/*` 를 풀어 읽는다. 이 키는
 * 기본 키 정책(계정 root → IAM 위임)뿐이라 **IAM 으로 kms:Decrypt 를 받은 역할만** 푼다 — Compute·Transparency 의 지정 역할(`ssm-secrets.ts`).
 *
 * 왜 별도 스택인가(AtmarkCompute 안이 아니라): 값 이전 스크립트(`scripts/admin/secrets-to-ssm.sh`)가 이 키로 파라미터를 **먼저** 만들어야 하고, 그 뒤에야
 * Compute 가 환경을 SSM 이름으로 바꿀 수 있다. 키가 Compute 에 있으면 "키를 만드는 배포" 와 "SSM 을 읽기 시작하는 배포" 가 같은 배포가 되어 그 사이에
 * 값을 넣을 틈이 없다(컨텍스트 스위치로 막는 길은, 스위치를 빠뜨린 다음 배포가 조용히 옛 자리로 돌아가는 함정이 남는다). 그래서 손 배포 1회짜리 작은 스택:
 * `cdk deploy AtmarkSecretsKey --exclusively` → 스크립트 → deploy-compute → Transparency 손 배포.
 *
 * RETAIN · 연 1회 자동 회전. 이 키를 지우면 SSM 의 20 값을 풀 수 없다(옛 Secrets Manager 값이 남아 있는 동안은 다시 복사로 복구, 그 뒤엔 재발급).
 */

import * as cdk from 'aws-cdk-lib';
import * as kms from 'aws-cdk-lib/aws-kms';
import type { Construct } from 'constructs';

import { SSM_SECRETS_KEY_ALIAS } from '../../../src/runtime/ssm-secret-names';

export class SecretsKeyStack extends cdk.Stack {
  public readonly key: kms.IKey;

  public constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);
    this.key = new kms.Key(this, 'SsmSecretsKey', {
      alias: SSM_SECRETS_KEY_ALIAS,
      description: 'Atmark SSM SecureString secrets (/atmark/*). Decrypt only via SSM for the designated runtime roles (IAM). Never delete.',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    new cdk.CfnOutput(this, 'SsmSecretsKeyArn', { value: this.key.keyArn, description: `${SSM_SECRETS_KEY_ALIAS} — /atmark/* SecureString 의 키` });
  }
}
