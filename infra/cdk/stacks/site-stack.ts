/**
 * AtmarkSiteCertificate · AtmarkSite — 홈 `https://atmark.ai`(+ `www.atmark.ai` → 301).
 *
 * **왜 별도 스택 둘인가.**
 *   - 인증서(`AtmarkSiteCertificate`): DNS 검증은 사람이 Cloudflare 에 CNAME 을 넣을 때까지 `CREATE_IN_PROGRESS` 로 멈춘다
 *     (`api-certificate-stack.ts` 와 같은 이유) — 그 대기가 홈 배포를 붙잡지 않게 먼저 따로 배포한다.
 *   - 홈(`AtmarkSite`): 운영 스택(`AtmarkCompute`)과 **공유하는 것이 없다** — VPC·DB·비밀·SES·S3·KMS 어느 것도 참조하지 않는다.
 *     홈을 고쳐 배포해도 발송·수신 스택의 diff 가 0 이고, 거꾸로도 그렇다.
 *
 * **최소 권한.** Lambda `atmark-site` 의 역할(`atmark-runtime-site`)에는 **자기 로그 그룹 쓰기만** 있다 — AWS 관리형 정책도
 * 붙이지 않는다(`AWSLambdaBasicExecutionRole` 은 모든 로그 그룹에 `CreateLogGroup` 을 준다). VPC 밖이다(DB 가 없으니 VPC 가
 * 필요 없고, VPC 에 두면 ENI·NAT 비용만 는다). DB 연결 예산(`compute-stack.test.ts` 의 합 ≤ 75)에 들어가지 않는다 —
 * 그 예산은 AtmarkCompute 템플릿의 함수만 센다. `test/unit/infra/site-stack.test.ts` 가 이 전부를 단언한다.
 *
 * **입구는 커스텀 도메인 둘뿐.** 인증서가 주어지면 execute-api 기본 엔드포인트를 끈다. `www` 리다이렉트는 Lambda 가 한다
 * (`src/site/http.ts` — Host 헤더로 가른다). 스로틀 20/40 — 정적 페이지 하나에 넉넉하고, 넘으면 사건이다.
 *
 * **결제 페이지 `pay.atmark.ai`(WP-2 · D-1).** 같은 함수·같은 HTTP API 에 도메인 매핑 하나를 더한다 — Lambda 가 Host 로 가른다
 * (`src/site/http.ts`). 인증서는 **별도**(`atmark-pay`, `AtmarkSiteCertificate` 안): 기존 인증서에 SAN 을 더하면 인증서가 교체되고
 * 두 이름이 다시 검증을 기다린다. DNS(검증 CNAME · `pay` CNAME, 프록시 OFF)는 **진윤겸 승인 뒤** 리드가 Cloudflare 에 넣는다(런북 site.md).
 * 결제 페이지 설정은 함수 환경 세 키(`ATMARK_BILLING_ENABLED` · `ATMARK_PADDLE_ENV` · `ATMARK_PADDLE_CLIENT_TOKEN` — 공개값)뿐이고 비밀·권한은
 * 늘지 않는다. 스위치는 AtmarkCompute 와 같은 컨텍스트(`atmark:billingEnabled`, 기본 끔 → pay 404).
 *
 * 배포·DNS 절차는 `docs/runbooks/site.md`.
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

import { PADDLE_ENVIRONMENT_DEFAULT, PAY_HOST, type PaddleEnvironment } from '../../../src/billing/constants';
import { billingEnabledOf } from './compute-stack';
import { lambdaCodeOf, refuseStubDeployment, type LambdaCodeSource } from './lambda-code';
import { denySesSendingInStack } from './ses-send-deny';

/** 정본 호스트와 리다이렉트 호스트 — `src/site/constants.ts` 의 `SITE_HOST`·`SITE_WWW_HOST` 와 같아야 한다(테스트). */
export const SITE_DOMAIN_NAME = 'atmark.ai';
export const SITE_WWW_DOMAIN_NAME = 'www.atmark.ai';

export const SITE_FUNCTION_NAME = 'atmark-site';
export const SITE_ROLE_NAME = 'atmark-runtime-site';
/** `dist/lambda/<이 이름>/index.js` — `scripts/build-lambda.ts` 의 `site`. */
export const SITE_HANDLER = 'site';
export const SITE_MEMORY_MB = 128;
export const SITE_TIMEOUT_SECONDS = 10;
/**
 * 예약 동시성 — 30. 따뜻한 호출은 수 ms 지만, 번들이 폰트 바이트(≈4MB)를 싣고 있어 **콜드 스타트가 수백 ms** 이고 첫 방문 한 번이 폰트 청크
 * ≈16 개를 한꺼번에 요청한다. 2 에서 30분 스로틀 64건 · 폰트 503, 10 에서도 첫 방문 콜드 버스트(동시 8·스로틀 7)가 남아(2026-09-27 Lighthouse) 30 으로 올렸다. 상한을 두는 이유는
 * 비용·남용 차단과 계정 동시 실행 할당량(400) 보호다. **DB 를 쓰지 않으므로** RDS 연결 예산과 무관하다. 남용 차단의 1차 선은 HTTP API
 * 스로틀(`SITE_THROTTLE` · `SITE_FONT_THROTTLE`)이고, 더 크게 필요해지면 답은 CloudFront(폰트·이미지 엣지 캐시)다.
 * CloudFront(`AtmarkSiteCdn`, `site-cdn-stack.ts`)가 폰트·이미지를 엣지에서 내게 되면(런북 site.md §10 전환·검증 뒤) 이 값을 다시 낮출 수 있다 —
 * 그때까지는 그대로 둔다(DNS 되돌리기 한 번이면 버스트가 다시 λ 로 온다).
 */
export const SITE_RESERVED_CONCURRENCY = 30;
export const SITE_THROTTLE = { rateLimit: 20, burstLimit: 40 } as const;

/**
 * 자체 호스팅 폰트(`src/ui/fonts.ts` — Pretendard 동적 서브셋) 라우트와 그 버킷. HTTP API 스로틀은 클라이언트별이 아니라 **버킷 하나를 모두가
 * 나눠 쓴다** — 첫 방문 한 번이 청크 ≈16 개를 한꺼번에 요청하므로, 폰트가 `$default`(페이지 20 / 40)를 먹으면 방문자 두셋이 동시에 와도 페이지가 429
 * 를 받는다. 그래서 **라우트를 따로 두고**(같은 λ 통합) 버킷을 나눈다. 값의 근거:
 *   - rate 40 / burst 80(배포 전 리뷰 L-2 — 100 / 200 에서 좁힘) ≈ 첫 방문 2–3 명/초 · 동시 5 명. 응답은 1 년 immutable 이라 재방문은 요청 0 —
 *     이 버킷은 **새 방문자** 수에만 비례한다. 콘솔도 이 폰트를 받지만(M4) 콘솔 사용자는 소수의 소유자다.
 *   - λ 쪽 천장은 예약 동시성(`SITE_RESERVED_CONCURRENCY` 30 — 콜드 스타트 대비)이다. 폰트 호출은 메모리 속 base64 문자열을 돌려줄 뿐이라(DB·조립 0) 수 ms —
 *     합계(`SITE_LAMBDA_BUCKET_CEILING`) × 수 ms ≪ 30 이라 콜드 스타트가 겹쳐도 페이지 몫이 남는다. 넓히면 병목이 동시성으로 옮겨 가 페이지도 같이 스로틀된다(그때는 CloudFront 가 답).
 *   - 남는 틈: 이 버킷 자체를 두드리면 폰트만 429 — `font-display: swap` 이라 글자는 시스템 글꼴로 그대로 보인다. `$default`(페이지)는 줄지 않는다.
 * `HEAD` 와 `/_fonts/`(청크 없음)는 이 라우트에 걸리지 않고 `$default` 로 간다(드물다).
 */
export const SITE_FONT_ROUTE_KEY = 'GET /_fonts/{proxy+}';
export const SITE_FONT_THROTTLE = { rateLimit: 40, burstLimit: 80 } as const;

/**
 * 사이트 λ 로 들어오는 **모든 버킷의 합** 상한(배포 전 리뷰 L-2). HTTP API 는 라우트마다 버킷이 따로라 라우트를 더하면 λ 로 들어오는 문이
 * 조용히 넓어진다 — 합이 이 값을 넘으면 테스트가 빨개진다(넓히려면 예약 동시성과 함께 이 값을 의식적으로 올린다). 지금 = `$default` 20/40 + 폰트 40/80.
 */
export const SITE_LAMBDA_BUCKET_CEILING = { rateLimit: 60, burstLimit: 120 } as const;

/** 결제 페이지 호스트 — `src/billing/constants.ts` `PAY_HOST` 와 같은 값(한 곳에서 온다). */
export const SITE_PAY_DOMAIN_NAME = PAY_HOST;

/**
 * Paddle.js 클라이언트 토큰(**공개값** — 계획 §0 P21, 비밀 아님)을 환경별로. 진윤겸이 전달하면 리드가 커밋한다(런북 billing.md).
 * 비어 있으면 함수 환경에 싣지 않고, 스위치가 켜져도 결제 페이지는 404 다(fail-closed · 이유 코드 로그 한 줄). 한 번 시험하려면
 * `-c atmark:paddleClientToken=test_…` 로 덮어쓴다(굳히려면 여기 커밋 — 컨텍스트를 빠뜨린 배포가 지우지 않게).
 */
export const PADDLE_CLIENT_TOKENS: Readonly<Record<PaddleEnvironment, string>> = {
  // 2026-09-26 샌드박스 토큰 'atmark-pay-sandbox'(공개값).
  sandbox: 'test_988615154b221dcd97557bc7bcb',
  // 2026-09-26 운영 토큰 'atmark-pay-live'(Chronostasis · 공개값).
  production: 'live_fbf2701553ebbde48e45a2a19c8',
};
export const PADDLE_CLIENT_TOKEN_CONTEXT_KEY = 'atmark:paddleClientToken';

export interface SiteCertificateStackProps extends cdk.StackProps {
  readonly domainName: string;
  readonly alternativeNames: readonly string[];
  /** 결제 페이지 호스트(`pay.atmark.ai`) — 주면 **별도 인증서**(`atmark-pay`)를 만든다. 위 인증서는 바뀌지 않는다. */
  readonly payDomainName?: string;
}

/** `atmark.ai` + `www.atmark.ai` ACM 인증서(ap-northeast-2, API Gateway 리전 도메인용 · DNS 검증). */
export class SiteCertificateStack extends cdk.Stack {
  public readonly certificate: acm.ICertificate;
  public readonly payCertificate: acm.ICertificate | undefined;

  public constructor(scope: Construct, id: string, props: SiteCertificateStackProps) {
    super(scope, id, props);

    this.certificate = new acm.Certificate(this, 'SiteCertificate', {
      domainName: props.domainName,
      subjectAlternativeNames: [...props.alternativeNames],
      // Route 53 호스팅 영역이 없다(DNS 는 Cloudflare). 검증 CNAME 은 사람이 넣는다(이름마다 하나 — 둘).
      validation: acm.CertificateValidation.fromDns(),
      certificateName: 'atmark-site',
    });

    new cdk.CfnOutput(this, 'SiteCertificateArn', {
      value: this.certificate.certificateArn,
      description: `${[props.domainName, ...props.alternativeNames].join(' + ')} ACM 인증서 ARN (${this.region})`,
    });
    new cdk.CfnOutput(this, 'SiteCertificateValidationLookupCommand', {
      value: [
        `AWS_PROFILE=atmark aws acm describe-certificate --region ${this.region}`,
        `--certificate-arn ${this.certificate.certificateArn}`,
        "--query 'Certificate.DomainValidationOptions[].ResourceRecord'",
      ].join(' '),
      description: 'Cloudflare 에 수동 입력할 ACM 검증 CNAME(이름마다 하나)을 조회하는 명령(프록시 OFF).',
    });

    // WP-2 — 결제 페이지. 별도 인증서라 기존 atmark.ai 인증서는 그대로다(교체·재검증 없음).
    this.payCertificate =
      props.payDomainName === undefined
        ? undefined
        : new acm.Certificate(this, 'PaySiteCertificate', {
            domainName: props.payDomainName,
            validation: acm.CertificateValidation.fromDns(),
            certificateName: 'atmark-pay',
          });
    if (this.payCertificate !== undefined) {
      new cdk.CfnOutput(this, 'PaySiteCertificateArn', {
        value: this.payCertificate.certificateArn,
        description: `${props.payDomainName ?? ''} ACM 인증서 ARN (${this.region}) — 검증 CNAME 은 진윤겸 승인 뒤 Cloudflare 에(프록시 OFF)`,
      });
      new cdk.CfnOutput(this, 'PaySiteCertificateValidationLookupCommand', {
        value: [
          `AWS_PROFILE=atmark aws acm describe-certificate --region ${this.region}`,
          `--certificate-arn ${this.payCertificate.certificateArn}`,
          "--query 'Certificate.DomainValidationOptions[].ResourceRecord'",
        ].join(' '),
        description: 'pay.atmark.ai 의 ACM 검증 CNAME 을 조회하는 명령(프록시 OFF).',
      });
    }
  }
}

export interface SiteStackProps extends cdk.StackProps {
  /** 없으면 커스텀 도메인 없이 execute-api 기본 엔드포인트만(테스트·검토용). */
  readonly domains?: {
    readonly apex: string;
    readonly www: string;
    readonly certificate: acm.ICertificate;
    /** 결제 페이지(`pay.atmark.ai`) — 별도 인증서. 없으면 매핑하지 않는다(홈만). */
    readonly pay?: { readonly domainName: string; readonly certificate: acm.ICertificate };
  };
  readonly lambdaCode: LambdaCodeSource;
}

export class SiteStack extends cdk.Stack {
  public readonly function: lambda.Function;
  public readonly role: iam.Role;
  public readonly httpApi: apigwv2.HttpApi;
  /**
   * apex(`atmark.ai`) 커스텀 도메인 — `AtmarkSiteCdn`(CloudFront)이 이 도메인의 **리전 도메인 이름**(`d-xxxx.execute-api…`)을 오리진으로 쓴다
   * (`site-cdn-stack.ts`). 도메인이 없으면 `undefined`.
   */
  public readonly apexDomain: apigwv2.DomainName | undefined;

  public constructor(scope: Construct, id: string, props: SiteStackProps) {
    super(scope, id, props);
    // 발송하지 않는 역할 전부에 SES 발송 명시 Deny(ADR-0014 단계 2 · 재검증 INFO — `ses-send-deny.ts`, 비용 0).
    denySesSendingInStack(this);

    // ── 로그 그룹 · 역할(자기 로그 그룹 쓰기만) ─────────────────────────────────
    const logGroup = new logs.LogGroup(this, 'SiteLogs', {
      logGroupName: `/aws/lambda/${SITE_FUNCTION_NAME}`,
      retention: logs.RetentionDays.THREE_MONTHS,
    });
    this.role = new iam.Role(this, 'SiteRole', {
      roleName: SITE_ROLE_NAME,
      description: 'atmark.ai static site. Own log group write only. No SES, no S3, no secrets, no KMS, no VPC.',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'OwnLogGroupWrite',
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        // `logGroupArn`(GetAtt Arn)은 `…:log-group:<이름>:*` — 그 그룹의 스트림 전부를 덮는다. 다른 그룹은 없다.
        resources: [logGroup.logGroupArn],
      }),
    );

    // ── 함수 — VPC 밖, 환경은 결제 페이지 설정 세 키뿐(비밀 없음) ─────────────────────
    const paddleEnvironment = PADDLE_ENVIRONMENT_DEFAULT;
    const tokenContext: unknown = this.node.tryGetContext(PADDLE_CLIENT_TOKEN_CONTEXT_KEY);
    const clientToken = typeof tokenContext === 'string' && tokenContext.trim() !== '' ? tokenContext.trim() : PADDLE_CLIENT_TOKENS[paddleEnvironment];
    const environment: Record<string, string> = {
      ATMARK_BILLING_ENABLED: billingEnabledOf(this.node) ? 'true' : 'false',
      ATMARK_PADDLE_ENV: paddleEnvironment,
      ...(clientToken === '' ? {} : { ATMARK_PADDLE_CLIENT_TOKEN: clientToken }),
    };
    const code = (): lambda.Code => lambdaCodeOf(props.lambdaCode, SITE_HANDLER);
    this.function = new lambda.Function(this, 'SiteFunction', {
      functionName: SITE_FUNCTION_NAME,
      description: 'atmark.ai static pages (home, privacy, terms, login, signup) + pay.atmark.ai checkout page - no DB, no secrets, no SES, no VPC',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: code(),
      memorySize: SITE_MEMORY_MB,
      timeout: cdk.Duration.seconds(SITE_TIMEOUT_SECONDS),
      reservedConcurrentExecutions: SITE_RESERVED_CONCURRENCY,
      role: this.role,
      environment,
      logGroup,
    });

    // ── HTTP API · 커스텀 도메인 둘 ─────────────────────────────────────────
    this.httpApi = new apigwv2.HttpApi(this, 'SiteHttpApi', {
      apiName: 'atmark-site',
      description: 'atmark.ai home (site Lambda only)',
      createDefaultStage: false,
      // 커스텀 도메인이 있으면 execute-api 기본 엔드포인트를 끈다 — 입구는 atmark.ai · www.atmark.ai (+ pay.atmark.ai)뿐.
      disableExecuteApiEndpoint: props.domains !== undefined,
    });
    const siteIntegration = new HttpLambdaIntegration('SiteIntegration', this.function, {
      payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_2_0,
    });
    new apigwv2.HttpRoute(this, 'SiteDefaultRoute', {
      httpApi: this.httpApi,
      routeKey: apigwv2.HttpRouteKey.DEFAULT,
      integration: siteIntegration,
    });
    // 폰트 라우트 — 같은 λ 통합, 스로틀 버킷만 따로(`SITE_FONT_THROTTLE`). 라우팅 자체는 여전히 `src/site/http.ts` 가 한다.
    const fontRoute = new apigwv2.HttpRoute(this, 'SiteFontRoute', {
      httpApi: this.httpApi,
      routeKey: apigwv2.HttpRouteKey.with(SITE_FONT_ROUTE_KEY.slice('GET '.length), apigwv2.HttpMethod.GET),
      integration: siteIntegration,
    });

    this.apexDomain =
      props.domains === undefined
        ? undefined
        : new apigwv2.DomainName(this, 'SiteApexDomainName', {
            domainName: props.domains.apex,
            certificate: props.domains.certificate,
          });
    const apexDomain = this.apexDomain;
    const wwwDomain =
      props.domains === undefined
        ? undefined
        : new apigwv2.DomainName(this, 'SiteWwwDomainName', {
            domainName: props.domains.www,
            certificate: props.domains.certificate,
          });

    const accessLogs = new logs.LogGroup(this, 'SiteAccessLogs', {
      logGroupName: '/atmark/site-access',
      retention: logs.RetentionDays.THREE_MONTHS,
    });
    const stage = this.httpApi.addStage('SiteDefaultStage', {
      stageName: '$default',
      autoDeploy: true,
      throttle: SITE_THROTTLE,
      accessLogSettings: {
        destination: new apigwv2.LogGroupLogDestination(accessLogs),
        // 홈은 **요청 IP 를 남기지 않는다** — 로그인·계정이 없는 공개 페이지라 필요가 없다(개인정보 처리 안내의 "접속 기록" 은
        // 콘솔·API 쪽 기록이다). 호스트는 남긴다(www 리다이렉트 확인용).
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
      ...(apexDomain === undefined ? {} : { domainMapping: { domainName: apexDomain } }),
    });
    // 라우트 단위 스로틀(CloudFormation `RouteSettings` — CDK 의 HttpStage 에 속성이 없어 L1 로 건다. 콘솔과 같은 방식). 라우트가 먼저 있어야 한다.
    (stage.node.defaultChild as apigwv2.CfnStage).routeSettings = {
      [SITE_FONT_ROUTE_KEY]: { ThrottlingRateLimit: SITE_FONT_THROTTLE.rateLimit, ThrottlingBurstLimit: SITE_FONT_THROTTLE.burstLimit },
    };
    stage.node.addDependency(fontRoute);
    if (wwwDomain !== undefined) {
      new apigwv2.ApiMapping(this, 'SiteWwwMapping', { api: this.httpApi, domainName: wwwDomain, stage });
    }
    const payDomain =
      props.domains?.pay === undefined
        ? undefined
        : new apigwv2.DomainName(this, 'SitePayDomainName', {
            domainName: props.domains.pay.domainName,
            certificate: props.domains.pay.certificate,
          });
    if (payDomain !== undefined) {
      new apigwv2.ApiMapping(this, 'SitePayMapping', { api: this.httpApi, domainName: payDomain, stage });
    }

    // ── 스텁 코드는 배포할 수 없다(compute-stack 과 같은 장치) ─────────────────
    refuseStubDeployment(this, props.lambdaCode, { warn: true });

    // ── 출력 ────────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'SiteUrl', {
      value: props.domains === undefined ? this.httpApi.apiEndpoint : `https://${props.domains.apex}`,
      description: '홈 출처',
    });
    if (apexDomain !== undefined && wwwDomain !== undefined) {
      new cdk.CfnOutput(this, 'SiteApexCnameTarget', {
        value: apexDomain.regionalDomainName,
        description: `${props.domains?.apex ?? ''} (apex) 의 CNAME 값 — Cloudflare 에 CNAME(평탄화)으로, **프록시 OFF(DNS only)**`,
      });
      new cdk.CfnOutput(this, 'SiteWwwCnameTarget', {
        value: wwwDomain.regionalDomainName,
        description: `${props.domains?.www ?? ''} 의 CNAME 값 — Cloudflare 에 **프록시 OFF(DNS only)**`,
      });
    }
    if (payDomain !== undefined) {
      new cdk.CfnOutput(this, 'SitePayCnameTarget', {
        value: payDomain.regionalDomainName,
        description: `${props.domains?.pay?.domainName ?? ''} 의 CNAME 값 — **진윤겸 승인 뒤** Cloudflare 에 **프록시 OFF(DNS only)** (런북 site.md)`,
      });
    }
  }
}
