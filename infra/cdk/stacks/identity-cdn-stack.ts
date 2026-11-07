/**
 * AtmarkIdentityCertificate / AtmarkIdentityCdn — `id.atmark.ai` 정적 서빙 지반
 * (계획 §6 P0 "r2 추가", §3.3 도메인 구조, ADR-0002)
 *
 * ADR-0002가 `did:web:id.atmark.ai:agents:{agentId}` 를 채택했고 그 해석 경로는
 * `https://id.atmark.ai/agents/{agentId}/did.json` 이다. **URL 경로 스킴은 영구 동결**이며,
 * ADR-0002 Consequences 두 번째 줄이 "가용성이 보안 속성이 된다"고 못박았다 —
 * 이 이름이 내려가면 발급된 passport 전체가 검증 불가가 된다. 그래서 DID 문서는
 * 메인 API가 아니라 S3 + CloudFront 로 분리한다.
 *
 * DID 문서 자체는 P6까지 하나도 만들어지지 않는다. 그럼에도 P0에 있는 이유는
 * **인증서 DNS 검증이 달력-시간**(Principle P5)이기 때문이다. 지반만 먼저 깐다.
 *
 * **스택이 둘인 이유:** CloudFront 의 대체 도메인 이름에 붙이는 ACM 인증서는
 * `us-east-1` 에만 존재할 수 있다. 배포 본체는 나머지 인프라와 같은 `ap-northeast-2` 에
 * 두고, 인증서만 떼어 `us-east-1` 스택으로 만든 뒤 `crossRegionReferences` 로 잇는다.
 */

import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';

/** DID 문서를 서빙할 호스트명. ADR-0002에 의해 동결된 값이다. */
export const IDENTITY_DOMAIN_NAME = 'id.atmark.ai';

export interface IdentityCertificateStackProps extends cdk.StackProps {
  readonly domainName: string;
}

/**
 * `us-east-1` 전용 스택 — CloudFront 용 ACM 인증서만 담는다.
 */
export class IdentityCertificateStack extends cdk.Stack {
  public readonly certificate: acm.ICertificate;

  public constructor(scope: Construct, id: string, props: IdentityCertificateStackProps) {
    super(scope, id, props);

    this.certificate = new acm.Certificate(this, 'IdentityCertificate', {
      domainName: props.domainName,
      // DNS 검증. 이메일 검증은 관리자 메일함 수신에 의존하는데, 그 메일함을 세우는 것이
      // 바로 이 프로젝트가 하려는 일이므로 부트스트랩 역설에 걸린다.
      //
      // 호스팅 영역을 넘기지 않는다 — `atmark.ai` DNS 는 Cloudflare 가 관리하고
      // **Route 53 호스팅 영역이 존재하지 않는다.** 따라서 검증 CNAME 은 CDK 가 만들지 못하고
      // 사람이 Cloudflare 에 직접 넣어야 한다. 아래 CfnOutput 의 안내를 따른다.
      validation: acm.CertificateValidation.fromDns(),
      certificateName: 'atmark-identity',
    });

    new cdk.CfnOutput(this, 'IdentityCertificateArn', {
      value: this.certificate.certificateArn,
      description: 'id.atmark.ai ACM 인증서 ARN (us-east-1)',
    });

    // CloudFormation 은 AWS::CertificateManager::Certificate 의 검증 CNAME 이름·값을
    // 속성으로 노출하지 않는다(Ref = ARN 뿐). 그래서 값 자체를 출력할 수 없고,
    // **값을 꺼내는 명령**을 출력한다. 배포는 이 레코드가 Cloudflare 에 들어갈 때까지
    // CREATE_IN_PROGRESS 로 대기하므로, 배포 직후 다른 터미널에서 이 명령을 돌려야 한다.
    new cdk.CfnOutput(this, 'IdentityCertificateValidationLookupCommand', {
      value: [
        'AWS_PROFILE=atmark aws acm describe-certificate --region us-east-1',
        `--certificate-arn ${this.certificate.certificateArn}`,
        "--query 'Certificate.DomainValidationOptions[].ResourceRecord'",
      ].join(' '),
      description:
        'Cloudflare 에 수동 입력할 ACM 검증 CNAME(Name/Value)을 조회하는 명령. ' +
        'CloudFormation 이 이 레코드 값을 출력으로 제공하지 않아 조회 명령으로 대신한다.',
    });
  }
}

export interface IdentityCdnStackProps extends cdk.StackProps {
  readonly domainName: string;
  /** `us-east-1` 의 IdentityCertificateStack 이 만든 인증서. */
  readonly certificate: acm.ICertificate;
  /**
   * 공개 신원 API(`GET /v1/identity/{address}`)의 오리진 호스트(`api.atmark.ai`). 주면 `id.atmark.ai/v1/identity/*` 가 그 오리진으로 간다 —
   * 계획 §4B.3 r3 "배치 위치": 사람이 실제로 쓰는 검증 표면도 CloudFront 뒤에 둬야 메인 API 장애 때 캐시된 응답이라도 서빙된다
   * (ADR-0002 "가용성이 보안 속성"). 캐시 수명은 오리진의 `Cache-Control`(300초)을 따른다 — 캐시 키는 경로 하나(`identityApiCachePolicy`).
   */
  readonly apiOriginDomainName?: string;
  /**
   * 투명성 로그 공개 버킷 이름(`transparency-stack.ts` `transparencyLogBucketName` — Object Lock). 주면 `id.atmark.ai/log/*` 가 그 버킷을
   * 오리진(OAC)으로 쓴다(ADR-0008 §2.4). 버킷 정책(이 배포만 `log/*` 읽기)은 그 스택이 건다 — 이름을 문자열로 받는 이유는 스택 순환을 피하려고다.
   */
  readonly transparencyLogBucketName?: string;
}

/** 공개 신원 API 경로 — CloudFront 의 추가 동작. `src/api/routes/identity.ts` 와 같은 접두사. */
export const IDENTITY_API_PATH_PATTERN = '/v1/identity/*';

/** 투명성 로그 공개 경로 — CloudFront 의 추가 동작(C2SP tlog-tiles `checkpoint`·`tile/…`, 앵커 영수증). */
export const TRANSPARENCY_LOG_PATH_PATTERN = '/log/*';

/**
 * `/log/*` 로 **내보내는 경로 모양** — 게시·앵커 코드가 쓰는 키 그대로(`src/tlog/publisher.ts` · `tiles.ts` · `anchor.ts`, 테스트가 그
 * 생성기의 출력으로 대조한다). 이 밖의 URI 는 오리진에 가기 전에 404 다(2026-09-24 적대적 검증 M2 — 쓰기 역할이 뚫려 Object Lock 버킷에
 * 임의 키를 1년짜리로 써도 id.atmark.ai 로 나가지 않게). 쓰기 쪽 IAM 은 `transparency-stack.ts` `TLOG_LOG_WRITE_KEYS`.
 */
export const TRANSPARENCY_LOG_PUBLISHED_PATHS: readonly RegExp[] = [
  /^\/log\/checkpoint$/,
  /^\/log\/key$/,
  /^\/log\/checkpoints\/(0|[1-9][0-9]{0,15})$/,
  // C2SP tlog-tiles: tile/<L>/<N>[.p/<W>] · tile/entries/<N>[.p/<W>] — N 은 `x000/…/000`, W 는 1~255.
  /^\/log\/tile\/(entries|0|[1-9][0-9]?)\/(x[0-9]{3}\/)*[0-9]{3}(\.p\/([1-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5]))?$/,
  /^\/log\/anchors\/ots\/(0|[1-9][0-9]{0,15})\/[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+\.ots$/,
  /^\/log\/anchors\/rekor\/(0|[1-9][0-9]{0,15})\.json$/,
];

/** CloudFront Function(viewer-request, cloudfront-js-2.0) 원문 — 모양 밖 URI 는 404. 테스트가 이 원문을 그대로 실행해 본다. */
export const TRANSPARENCY_LOG_PATH_GUARD_SOURCE = [
  `var ALLOWED = [${TRANSPARENCY_LOG_PUBLISHED_PATHS.map((pattern) => pattern.toString()).join(', ')}];`,
  'function handler(event) {',
  '  var uri = event.request.uri;',
  '  for (var i = 0; i < ALLOWED.length; i++) { if (ALLOWED[i].test(uri)) return event.request; }',
  "  return { statusCode: 404, statusDescription: 'Not Found', headers: { 'cache-control': { value: 'public, max-age=60' } } };",
  '}',
].join('\n');

/** `/log/*` 응답 헤더 — nosniff · 스크립트·하위 자원·폼이 없는 CSP sandbox · 교차 출처 GET/HEAD(자격 없음). */
export const TRANSPARENCY_LOG_CSP = "default-src 'none'; sandbox";

/** 공개 신원 API 캐시 수명 상한 — 오리진의 `max-age=300`(`src/api/routes/identity.ts`)과 같다. */
export const IDENTITY_API_MAX_TTL_SECONDS = 300;

/**
 * `ap-northeast-2` 스택 — DID 문서 버킷 + CloudFront 배포.
 */
export class IdentityCdnStack extends cdk.Stack {
  public readonly bucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;

  public constructor(scope: Construct, id: string, props: IdentityCdnStackProps) {
    super(scope, id, props);

    this.bucket = new s3.Bucket(this, 'DidDocumentBucket', {
      // 오리진은 CloudFront 를 통해서만 읽힌다. 버킷을 직접 공개하면 did.json 이
      // 두 개의 URL 로 존재하게 되고, 그중 하나(S3 직접 URL)는 `id.atmark.ai` 라는
      // 이름에 묶이지 않아 ADR-0002가 전제한 "도메인 통제권 = identity 통제권"이 흐려진다.
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      // 버저닝: DID 문서 덮어쓰기는 곧 해당 에이전트의 검증 실패다. 사고를 되돌릴 수 있게 둔다.
      // ADR-0002 F8(일일 외부 스냅샷)의 1차 방어선이기도 하다.
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // 스택을 지워도 DID 문서는 남긴다. 이 버킷의 소실 = 발급된 passport 전량 검증 불가.
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.distribution = new cloudfront.Distribution(this, 'IdentityDistribution', {
      comment: 'Atmark did:web document serving (ADR-0002)',
      defaultBehavior: {
        // OAC. OAI 는 레거시이고 SSE-KMS·신규 리전을 지원하지 않는다.
        //
        // `as s3.IBucket` 은 aws-cdk-lib 타입 선언과 이 리포의 `exactOptionalPropertyTypes: true`
        // 사이의 알려진 충돌을 지나가기 위한 것이다 — `IBucket.isWebsite?: boolean` 과
        // `Bucket.isWebsite: boolean | undefined` 가 그 플래그 아래에서 서로 대입 불가로 판정된다.
        // 런타임 의미 차이는 없다. 리포 전체의 엄격도를 CDK 하나 때문에 낮추지 않는다.
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.bucket as s3.IBucket),
        // HTTP 로 들어온 요청을 거절하지 않고 HTTPS 로 넘긴다 — did:web resolver 중
        // 스킴을 붙이지 않고 접근하는 구현이 있어도 검증이 깨지지 않게 한다.
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        // 기본 캐시 정책. DID 문서는 사실상 불변이고 읽기 일변도라 관리형 최적화 정책으로 충분하다.
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        // P6(PP-B) — 브라우저의 did:web 리졸버·검증기가 교차 출처로 읽는다. GET/HEAD 만, 자격증명 없음(관리형 정책).
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.CORS_ALLOW_ALL_ORIGINS,
      },
      additionalBehaviors: {
        ...(props.transparencyLogBucketName === undefined
          ? {}
          : {
              // 체크포인트는 `max-age=60`, 타일·이력은 불변(1년) — 오리진 `Cache-Control` 을 관리형 최적화 정책이 따른다. 읽기만.
              // 게시 모양 밖 URI 는 경로 가드가 404(오리진에 가지 않는다) · 응답은 nosniff + CSP sandbox + CORS(GET/HEAD, 자격 없음).
              [TRANSPARENCY_LOG_PATH_PATTERN]: {
                origin: origins.S3BucketOrigin.withOriginAccessControl(
                  s3.Bucket.fromBucketAttributes(this, 'TransparencyLogBucket', { bucketName: props.transparencyLogBucketName, region: this.region }),
                ),
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
                cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
                responseHeadersPolicy: new cloudfront.ResponseHeadersPolicy(this, 'TransparencyLogHeaders', {
                  responseHeadersPolicyName: 'atmark-transparency-log',
                  comment: 'id.atmark.ai/log/* - nosniff, CSP sandbox, CORS GET/HEAD any origin without credentials',
                  corsBehavior: {
                    accessControlAllowCredentials: false,
                    accessControlAllowHeaders: ['*'],
                    accessControlAllowMethods: ['GET', 'HEAD'],
                    accessControlAllowOrigins: ['*'],
                    originOverride: true,
                  },
                  securityHeadersBehavior: {
                    contentTypeOptions: { override: true },
                    contentSecurityPolicy: { contentSecurityPolicy: TRANSPARENCY_LOG_CSP, override: true },
                  },
                }),
                functionAssociations: [
                  {
                    eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
                    function: new cloudfront.Function(this, 'TransparencyLogPathGuard', {
                      functionName: 'atmark-transparency-log-path-guard',
                      comment: 'id.atmark.ai/log/* - 404 for any URI outside the published key shapes (ADR-0008)',
                      runtime: cloudfront.FunctionRuntime.JS_2_0,
                      code: cloudfront.FunctionCode.fromInline(TRANSPARENCY_LOG_PATH_GUARD_SOURCE),
                    }),
                  },
                ],
              },
            }),
        ...(props.apiOriginDomainName === undefined
          ? {}
          : {
              [IDENTITY_API_PATH_PATTERN]: {
                origin: new origins.HttpOrigin(props.apiOriginDomainName, {
                  protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
                  originSslProtocols: [cloudfront.OriginSslPolicy.TLS_V1_2],
                }),
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
                // 캐시 키 = **경로(주소) 하나** · 수명은 오리진 `Cache-Control`(`public, max-age=300`, 200·404 공통)을 0~300초 안에서 따른다.
                cachePolicy: this.identityApiCachePolicy(),
                // 오리진 요청 정책 **없음** — 캐시 키에 없는 것은 오리진에 가지 않는다. 뷰어의 `Host`(id.atmark.ai)가 api.atmark.ai 로
                // 넘어가지 않고(API Gateway 커스텀 도메인은 제 Host 만 받는다), 쿠키·쿼리·헤더도 넘어가지 않는다.
                responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.CORS_ALLOW_ALL_ORIGINS,
              },
            }),
      },
      domainNames: [props.domainName],
      certificate: props.certificate,
      // TLS 1.2 미만을 잘라낸다. ADR-0002 Consequences: "TLS 인증서 만료가 곧 검증 중단"이며,
      // 같은 이유로 TLS 자체의 품질도 identity 의 품질이 된다.
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      // Phase 1 트래픽은 검증자 소수다. 가장 저렴한 등급으로 시작한다.
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      enableIpv6: true,
    });

    if (props.transparencyLogBucketName !== undefined) {
      // 가져온 버킷에는 CDK 가 OAC 버킷 정책을 붙이지 못한다 — 그 정책(이 배포 ARN 조건, `log/*` GetObject 하나)은 AtmarkTransparency 가 건다.
      cdk.Annotations.of(this.distribution).acknowledgeWarning(
        '@aws-cdk/aws-cloudfront-origins:updateImportedBucketPolicyOac',
        'transparency-stack.ts AllowIdentityDistributionReadLog 가 버킷 정책을 건다(스택 순환을 피하려고 버킷을 이름으로 가져왔다)',
      );
    }

    new cdk.CfnOutput(this, 'IdentityDistributionDomainName', {
      value: this.distribution.distributionDomainName,
      description:
        'Cloudflare 에 수동 입력할 CNAME 값. `id.atmark.ai` CNAME → 이 도메인 (프록시 OFF).',
    });

    new cdk.CfnOutput(this, 'IdentityDistributionId', {
      value: this.distribution.distributionId,
      description: 'CloudFront 배포 ID (캐시 무효화용)',
    });

    new cdk.CfnOutput(this, 'DidDocumentBucketName', {
      value: this.bucket.bucketName,
      description: 'DID 문서 업로드 대상 버킷 (P6에서 사용)',
    });
  }

  /**
   * `/v1/identity/*` 캐시 정책 (2026-09-24 검증 반영). 예전 판은 관리형 `UseOriginCacheControlHeaders` 였다 — 그 정책의 캐시 키에는
   * **Host·Origin 헤더 · 모든 쿠키 · 모든 쿼리**가 들어가고, 캐시 키의 것은 오리진으로도 간다:
   *   ① `Host: id.atmark.ai` 가 api.atmark.ai(API Gateway 커스텀 도메인)로 넘어가 오리진이 요청을 거절한다(배포 뒤 첫 요청에 드러났을 것).
   *   ② 쿠키·쿼리·Origin 을 바꿀 때마다 새 캐시 키 = 캐시를 우회해 오리진을 친다. 오리진은 전역 5 rps 라우트 스로틀
   *      (`compute-stack.ts` `API_ROUTE_THROTTLES`)이라, `?x=1,2,3…` 만으로 모든 검증자의 조회를 429 로 만들 수 있다.
   * 이 정책은 헤더·쿠키·쿼리를 캐시 키에서 빼고(= 오리진에도 안 보낸다) 경로만 쓴다. TTL: 최소 0 · 기본 0(오리진이 `Cache-Control`
   * 을 안 주면 캐시하지 않는다 — 5xx 등) · 최대 300(오리진이 더 길게 말해도 5분). 압축 두 가지는 `Accept-Encoding` 정규화 값만 키에 넣는다.
   * 남는 우회: 주소 경로 자체를 바꾸는 것(없는 주소·대소문자 변형 — 후자는 오리진이 존재와 무관한 404 를 주고 그것도 캐시된다).
   * 경로 폭주는 캐시로 못 막는다 — WAF 속도 규칙(F18)이 할 일이고 ADR-0003 에 상태를 적었다.
   */
  private identityApiCachePolicy(): cloudfront.ICachePolicy {
    return new cloudfront.CachePolicy(this, 'IdentityApiCachePolicy', {
      cachePolicyName: 'atmark-identity-api',
      comment: 'id.atmark.ai/v1/identity/* - path-only cache key, honours origin Cache-Control within 0..300s',
      minTtl: cdk.Duration.seconds(0),
      defaultTtl: cdk.Duration.seconds(0),
      maxTtl: cdk.Duration.seconds(IDENTITY_API_MAX_TTL_SECONDS),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });
  }
}
