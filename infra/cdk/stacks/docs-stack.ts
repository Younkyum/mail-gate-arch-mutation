/**
 * AtmarkDocsCertificate · AtmarkDocs — 사용자 문서 `https://docs.atmark.ai`(계획 `.omc/plans/docs-site.md` §5, 선택지 A).
 *
 * **왜 홈(`AtmarkSite`)과 따로인가.** 같은 λ 에 Host 분기로 얹으면(선택지 A2) 문서 배포가 홈·결제(`pay.atmark.ai`) 배포가 되고, 스크린샷·
 * 폰트로 커진 번들이 홈 콜드 스타트를 늦춘다. 그래서 **함수·역할·HTTP API·인증서·로그 그룹이 전부 새것**이고, 기존 스택의 어느 리소스도
 * 참조하지 않는다 — 이 파일을 더해도 기존 스택 템플릿의 diff 는 0 이다(`test/unit/infra/docs-stacks.test.ts` 가 합성으로 단언).
 *
 * **스택이 둘인 이유**는 홈과 같다 — DNS 검증 인증서(`atmark-docs`, docs.atmark.ai 하나 · 기존 인증서에 SAN 을 더하지 않는다: 교체·재검증 방지)는
 * 사람이 Cloudflare 에 CNAME 을 넣을 때까지 `CREATE_IN_PROGRESS` 로 멈춘다. 그 대기가 함수 배포를 붙잡지 않게 먼저 따로 배포한다.
 *
 * **최소 권한.** 역할 `atmark-runtime-docs` 에는 자기 로그 그룹 쓰기만(관리형 정책 없음) · VPC 밖 · DB·비밀·SES·S3·KMS 0 · 환경 변수 0.
 * 입구는 커스텀 도메인 하나(execute-api 기본 엔드포인트 끔). 접근 로그는 요청 IP 를 남기지 않는다(홈과 같은 형식).
 * 스로틀: 페이지 `$default` 20/40 · 폰트 라우트 40/80(홈과 같은 판단 — 첫 방문 한 번이 폰트 청크 여럿을 한꺼번에 부른다). 앞에 CloudFront
 * (`docs-cdn-stack.ts`)가 자산과 HTML 을 엣지에 두므로 λ 에는 캐시 미스만 온다.
 *
 * 배포·DNS·되돌리기: `docs/runbooks/docs.md`.
 */

import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';

import { lambdaCodeOf, refuseStubDeployment, type LambdaCodeSource } from './lambda-code';
import { denySesSendingInStack } from './ses-send-deny';

/** 문서 호스트 — `src/docs/constants.ts` `DOCS_HOST` 와 같아야 한다(테스트). */
export const DOCS_DOMAIN_NAME = 'docs.atmark.ai';

export const DOCS_FUNCTION_NAME = 'atmark-docs';
export const DOCS_ROLE_NAME = 'atmark-runtime-docs';
/** `dist/lambda/<이 이름>/index.js` — `scripts/build-lambda.ts` 의 `docs`. */
export const DOCS_HANDLER = 'docs';
/** 256MB — 콜드 스타트에 페이지 전부를 한 번 렌더한다(마크다운 → HTML · 검색 색인). 메모리가 곧 CPU 라 128 보다 콜드 스타트가 짧다. */
export const DOCS_MEMORY_MB = 256;
export const DOCS_TIMEOUT_SECONDS = 10;
/** 예약 동시성 — 앞에 CloudFront 가 있어 λ 에는 엣지 캐시 미스만 온다. 상한은 비용·남용 차단과 계정 할당량 보호. DB 를 쓰지 않는다. */
export const DOCS_RESERVED_CONCURRENCY = 20;
export const DOCS_THROTTLE = { rateLimit: 20, burstLimit: 40 } as const;
export const DOCS_FONT_ROUTE_KEY = 'GET /_fonts/{proxy+}';
export const DOCS_FONT_THROTTLE = { rateLimit: 40, burstLimit: 80 } as const;
/** λ 로 들어오는 모든 버킷의 합 상한 — 라우트를 더해 문이 조용히 넓어지면 테스트가 빨개진다. */
export const DOCS_LAMBDA_BUCKET_CEILING = { rateLimit: 60, burstLimit: 120 } as const;

export interface DocsCertificateStackProps extends cdk.StackProps {
  readonly domainName: string;
}

/** `docs.atmark.ai` ACM 인증서(ap-northeast-2, API Gateway 리전 도메인용 · DNS 검증). 이름 `atmark-docs` — 기존 인증서와 별개. */
export class DocsCertificateStack extends cdk.Stack {
  public readonly certificate: acm.ICertificate;

  public constructor(scope: Construct, id: string, props: DocsCertificateStackProps) {
    super(scope, id, props);
    this.certificate = new acm.Certificate(this, 'DocsCertificate', {
      domainName: props.domainName,
      // Route 53 호스팅 영역이 없다(DNS 는 Cloudflare). 검증 CNAME 은 진윤겸 승인 뒤 리드가 넣는다(런북 docs.md).
      validation: acm.CertificateValidation.fromDns(),
      certificateName: 'atmark-docs',
    });
    new cdk.CfnOutput(this, 'DocsCertificateArn', {
      value: this.certificate.certificateArn,
      description: `${props.domainName} ACM certificate ARN (${this.region})`,
    });
    new cdk.CfnOutput(this, 'DocsCertificateValidationLookupCommand', {
      value: [
        `AWS_PROFILE=atmark aws acm describe-certificate --region ${this.region}`,
        `--certificate-arn ${this.certificate.certificateArn}`,
        "--query 'Certificate.DomainValidationOptions[].ResourceRecord'",
      ].join(' '),
      description: 'Command that prints the ACM validation CNAME to add in Cloudflare (proxy OFF).',
    });
  }
}

export interface DocsStackProps extends cdk.StackProps {
  /** 없으면 커스텀 도메인 없이 execute-api 기본 엔드포인트만(테스트·검토용). */
  readonly domain?: { readonly domainName: string; readonly certificate: acm.ICertificate };
  readonly lambdaCode: LambdaCodeSource;
}

export class DocsStack extends cdk.Stack {
  public readonly function: lambda.Function;
  public readonly role: iam.Role;
  public readonly httpApi: apigwv2.HttpApi;
  /** 커스텀 도메인 — `AtmarkDocsCdn` 이 이 도메인의 리전 도메인 이름을 오리진으로 쓴다. */
  public readonly domain: apigwv2.DomainName | undefined;

  public constructor(scope: Construct, id: string, props: DocsStackProps) {
    super(scope, id, props);
    // 발송하지 않는 역할 전부에 SES 발송 명시 Deny(ADR-0014 단계 2 · 재검증 INFO — `ses-send-deny.ts`, 비용 0).
    denySesSendingInStack(this);

    const logGroup = new logs.LogGroup(this, 'DocsLogs', {
      logGroupName: `/aws/lambda/${DOCS_FUNCTION_NAME}`,
      retention: logs.RetentionDays.THREE_MONTHS,
    });
    this.role = new iam.Role(this, 'DocsRole', {
      roleName: DOCS_ROLE_NAME,
      description: 'docs.atmark.ai static docs. Own log group write only. No SES, no S3, no secrets, no KMS, no VPC.',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'OwnLogGroupWrite',
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [logGroup.logGroupArn],
      }),
    );

    const code = (): lambda.Code => lambdaCodeOf(props.lambdaCode, DOCS_HANDLER);
    this.function = new lambda.Function(this, 'DocsFunction', {
      functionName: DOCS_FUNCTION_NAME,
      description: 'docs.atmark.ai user documentation pages (ko, en), search index, llms.txt - no DB, no secrets, no SES, no VPC',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: code(),
      memorySize: DOCS_MEMORY_MB,
      timeout: cdk.Duration.seconds(DOCS_TIMEOUT_SECONDS),
      reservedConcurrentExecutions: DOCS_RESERVED_CONCURRENCY,
      role: this.role,
      logGroup,
    });

    this.httpApi = new apigwv2.HttpApi(this, 'DocsHttpApi', {
      apiName: 'atmark-docs',
      description: 'docs.atmark.ai (docs Lambda only)',
      createDefaultStage: false,
      disableExecuteApiEndpoint: props.domain !== undefined,
    });
    const integration = new HttpLambdaIntegration('DocsIntegration', this.function, {
      payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_2_0,
    });
    new apigwv2.HttpRoute(this, 'DocsDefaultRoute', { httpApi: this.httpApi, routeKey: apigwv2.HttpRouteKey.DEFAULT, integration });
    const fontRoute = new apigwv2.HttpRoute(this, 'DocsFontRoute', {
      httpApi: this.httpApi,
      routeKey: apigwv2.HttpRouteKey.with(DOCS_FONT_ROUTE_KEY.slice('GET '.length), apigwv2.HttpMethod.GET),
      integration,
    });

    this.domain =
      props.domain === undefined
        ? undefined
        : new apigwv2.DomainName(this, 'DocsDomainName', { domainName: props.domain.domainName, certificate: props.domain.certificate });

    const accessLogs = new logs.LogGroup(this, 'DocsAccessLogs', {
      logGroupName: '/atmark/docs-access',
      retention: logs.RetentionDays.THREE_MONTHS,
    });
    const stage = this.httpApi.addStage('DocsDefaultStage', {
      stageName: '$default',
      autoDeploy: true,
      throttle: DOCS_THROTTLE,
      accessLogSettings: {
        destination: new apigwv2.LogGroupLogDestination(accessLogs),
        // 요청 IP 를 남기지 않는다(로그인·계정 없는 공개 문서 — 홈과 같은 형식).
        format: apigw.AccessLogFormat.custom(
          JSON.stringify({
            requestId: '$context.requestId',
            requestTime: '$context.requestTime',
            host: '$context.domainName',
            method: '$context.httpMethod',
            path: '$context.path',
            status: '$context.status',
            latencyMs: '$context.integrationLatency',
            integrationError: '$context.integrationErrorMessage',
          }),
        ),
      },
      ...(this.domain === undefined ? {} : { domainMapping: { domainName: this.domain } }),
    });
    (stage.node.defaultChild as apigwv2.CfnStage).routeSettings = {
      [DOCS_FONT_ROUTE_KEY]: { ThrottlingRateLimit: DOCS_FONT_THROTTLE.rateLimit, ThrottlingBurstLimit: DOCS_FONT_THROTTLE.burstLimit },
    };
    stage.node.addDependency(fontRoute);

    refuseStubDeployment(this, props.lambdaCode, { warn: true });

    new cdk.CfnOutput(this, 'DocsUrl', {
      value: props.domain === undefined ? this.httpApi.apiEndpoint : `https://${props.domain.domainName}`,
      description: 'Docs origin',
    });
    if (this.domain !== undefined) {
      new cdk.CfnOutput(this, 'DocsRegionalDomainName', {
        value: this.domain.regionalDomainName,
        description: `${props.domain?.domainName ?? ''} API Gateway regional domain (CloudFront origin; direct-DNS fallback target, proxy OFF)`,
      });
    }
  }
}
