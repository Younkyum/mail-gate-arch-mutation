/**
 * AtmarkApiCertificate — `api.atmark.ai` ACM 인증서 (ap-northeast-2, API Gateway 리전 도메인용).
 *
 * **왜 커스텀 도메인인가.** 소유자 승인 매직링크(`ATMARK_APPROVAL_PAGE_URL`)가 메일 본문에 실린다.
 * `*.execute-api.amazonaws.com` 링크는 ① 발신 도메인(atmark.ai)과 링크 도메인이 어긋나 수신 측 스팸 판정에
 * 불리하고, ② 소유자에게 "atmark.ai 링크만 믿어라" 라는 규칙을 줄 수 없으며(피싱 방어의 전제), ③ API 를
 * 다시 만들면 URL 이 바뀐다. 셋 다 GATE 첫날부터 걸린다.
 *
 * **왜 별도 스택인가.** DNS 검증은 사람이 Cloudflare 에 CNAME 을 넣을 때까지 `CREATE_IN_PROGRESS` 로 멈춘다
 * (`identity-cdn-stack.ts` 와 같은 절차, infra/cdk/README.md "ACM DNS 검증 절차"). 컴퓨트 스택 안에 두면
 * 그 대기가 Lambda·API 배포 전체를 붙잡는다. 인증서를 먼저 배포·검증하고 컴퓨트를 배포한다.
 *
 * **배포 전 확인:** `atmark.ai` 의 CAA 가 `amazon.com` 을 허용하는지(`id.atmark.ai` 에만 걸었다면 `api` 는 apex CAA 를 상속한다).
 */

import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import type { Construct } from 'constructs';

export const API_DOMAIN_NAME = 'api.atmark.ai';

/**
 * 관리 화면 호스트(2026-09-23 리드 결정). api 와 **다른 호스트** — 세션 쿠키(`__Host-`)가 이 호스트에만 묶이고, api 의 HTTP API
 * 에는 관리 경로가 없다. 같은 클래스로 **별도 스택**(`AtmarkConsoleCertificate`)에 인증서를 만든다(DNS 검증 대기를 분리).
 */
export const CONSOLE_DOMAIN_NAME = 'console.atmark.ai';

/**
 * 운영자 콘솔 호스트(ADR-0015) — 이름은 계약(`src/ops/contract.ts`)이 정한다. 같은 클래스로 **별도 스택**(`AtmarkOpsCertificate`,
 * 인증서 이름 `atmark-ops`)에 만든다. Compute 는 이 인증서가 발급된 **뒤에만** `opsDomain` 으로 받는다(`app.ts` 컨텍스트
 * `atmark:opsDomainReady` — 롤아웃 §5 6단계). 검증 CNAME 은 진윤겸 승인 뒤 리드가 Cloudflare 에 넣는다(프록시 OFF).
 */
export { OPS_DOMAIN_NAME } from '../../../src/ops/contract';

export interface ApiCertificateStackProps extends cdk.StackProps {
  readonly domainName: string;
  /** ACM 콘솔에 보이는 이름. 기본 `atmark-api`(기존 인증서 — 바꾸면 교체된다). */
  readonly certificateName?: string;
}

export class ApiCertificateStack extends cdk.Stack {
  public readonly certificate: acm.ICertificate;

  public constructor(scope: Construct, id: string, props: ApiCertificateStackProps) {
    super(scope, id, props);

    this.certificate = new acm.Certificate(this, 'ApiCertificate', {
      domainName: props.domainName,
      // Route 53 호스팅 영역이 없다(DNS 는 Cloudflare). 검증 CNAME 은 사람이 넣는다.
      validation: acm.CertificateValidation.fromDns(),
      certificateName: props.certificateName ?? 'atmark-api',
    });

    new cdk.CfnOutput(this, 'ApiCertificateArn', {
      value: this.certificate.certificateArn,
      description: `${props.domainName} ACM 인증서 ARN (${this.region})`,
    });
    new cdk.CfnOutput(this, 'ApiCertificateValidationLookupCommand', {
      value: [
        `AWS_PROFILE=atmark aws acm describe-certificate --region ${this.region}`,
        `--certificate-arn ${this.certificate.certificateArn}`,
        "--query 'Certificate.DomainValidationOptions[].ResourceRecord'",
      ].join(' '),
      description: 'Cloudflare 에 수동 입력할 ACM 검증 CNAME 을 조회하는 명령(프록시 OFF).',
    });
  }
}
