/**
 * AtmarkDocsCdnCertificate · AtmarkDocsCdn — 사용자 문서 `https://docs.atmark.ai` 앞의 CloudFront(계획 §5-3).
 *
 * 홈 CDN(`site-cdn-stack.ts`)과 같은 모양이다:
 *   - **오리진 = `AtmarkDocs` 커스텀 도메인의 리전 도메인 이름 + 뷰어 `Host`(docs.atmark.ai) 전달.** API Gateway 는 커스텀 도메인으로 요청을
 *     받고(ap-northeast-2 인증서 `atmark-docs`), execute-api 기본 엔드포인트는 계속 꺼져 있다. `*.cloudfront.net` 으로 직접 오면 Host 가 오리진
 *     인증서와 맞지 않아 502 다(정본 이름 하나만 산다 — 의도).
 *   - **처음부터 DNS 는 CloudFront 를 가리킨다**(홈처럼 나중에 옮기지 않는다). 되돌리기는 DNS 하나 — `docs` CNAME 을 `AtmarkDocs` 출력
 *     `DocsRegionalDomainName` 으로(런북 docs.md).
 * 캐시 동작:
 *   - 자산(`DOCS_CDN_ASSET_PATH_PATTERNS` — 폰트·스크린샷·검색 색인은 내용 해시 URL 1년 immutable, 파비콘 30일, 크롤러 파일 5분): 키 = Host + 경로
 *     (+ 정규화된 Accept-Encoding). 쿼리·쿠키는 키에도 오리진에도 없다(쿼리로 캐시를 우회해 λ 를 두드릴 수 없다). 엣지 압축 켬.
 *   - 페이지(그 밖 — HTML · `.md` · 404): 오리진 `cache-control: public, max-age=300` 을 따른다(개인화가 없다 — 쿠키를 읽지도
 *     만들지도 않는다). 키 = Host + 경로 + 정규화된 Accept-Encoding · **쿼리 없음**(쿼리로 캐시를 우회할 수 없다).
 *   - 서버 검색(`/search` · `/en/search`): 페이지와 같되 키·오리진에 쿼리 `q` 하나만. HTML 은 오리진이 gzip 하고
 *     `vary: accept-encoding` 을 싣는다 — CloudFront 는 이미 인코딩된 응답을 다시 압축하지 않는다. GET·HEAD 만.
 *   - **응답 헤더 정책 없음** — 오리진의 페이지별 CSP(스타일·스크립트 해시)·HSTS·nosniff·DENY 를 그대로 통과시킨다.
 *   - 접근 로그 없음(요청 IP 를 남기지 않는다) · 가격 등급 200(한국·일본 엣지 포함) · TLS 1.2 이상 · HTTP/2·3.
 * 인증서는 us-east-1 에만(CloudFront 제약) — 별도 스택 `AtmarkDocsCdnCertificate`(`atmark-docs-cdn`), `crossRegionReferences` 로 넘긴다.
 */

import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import type { Construct } from 'constructs';

/** 엣지에 오래 두는 자산 경로. HTML 페이지 경로는 여기 걸리지 않는다(테스트가 핸들러와 대조). */
export const DOCS_CDN_ASSET_PATH_PATTERNS = [
  '/_fonts/*',
  '/_img/*',
  '/_search/*',
  '/favicon.svg',
  '/favicon.ico',
  // 해시 파비콘(`/favicon-<해시>.svg|.ico`, 1년 immutable)과 apple-touch-icon(해시·옛 경로) — `src/ui/favicon.ts`.
  '/favicon-*',
  '/apple-touch-icon*',
  '/robots.txt',
  '/sitemap.xml',
  '/llms.txt',
  '/llms-full.txt',
] as const;

/** 서버 검색 경로 — 이 둘만 캐시 키·오리진에 쿼리 `q` 를 싣는다(보안 검토 L7). 나머지 페이지는 쿼리를 버린다(쿼리로 캐시를 우회해 λ 를 두드릴 수 없다). */
export const DOCS_CDN_SEARCH_PATH_PATTERNS = ['/search', '/en/search'] as const;

export const DOCS_CDN_ASSET_CACHE_POLICY_NAME = 'atmark-docs-assets';
export const DOCS_CDN_PAGE_CACHE_POLICY_NAME = 'atmark-docs-pages';
export const DOCS_CDN_SEARCH_CACHE_POLICY_NAME = 'atmark-docs-search';
export const DOCS_CDN_ASSET_MAX_TTL_DAYS = 365;
/** 페이지 최대 TTL — 오리진이 5분을 주므로 실제로는 5분. 오리진이 실수로 긴 값을 내도 하루를 넘기지 않는다. */
export const DOCS_CDN_PAGE_MAX_TTL_SECONDS = 86_400;

export interface DocsCdnCertificateStackProps extends cdk.StackProps {
  readonly domainName: string;
}

/** `us-east-1` 전용 — CloudFront 용 `docs.atmark.ai` ACM 인증서(DNS 검증). ap-northeast-2 의 `atmark-docs` 와 별개. */
export class DocsCdnCertificateStack extends cdk.Stack {
  public readonly certificate: acm.ICertificate;

  public constructor(scope: Construct, id: string, props: DocsCdnCertificateStackProps) {
    super(scope, id, props);
    this.certificate = new acm.Certificate(this, 'DocsCdnCertificate', {
      domainName: props.domainName,
      // 같은 계정·같은 이름이면 검증 CNAME 이 ap-northeast-2 인증서(atmark-docs)와 같다 — 이미 넣었으면 추가할 것이 없다.
      validation: acm.CertificateValidation.fromDns(),
      certificateName: 'atmark-docs-cdn',
    });
    new cdk.CfnOutput(this, 'DocsCdnCertificateArn', {
      value: this.certificate.certificateArn,
      description: `${props.domainName} ACM certificate ARN (${this.region}, for CloudFront)`,
    });
    new cdk.CfnOutput(this, 'DocsCdnCertificateValidationLookupCommand', {
      value: [
        `AWS_PROFILE=atmark aws acm describe-certificate --region ${this.region}`,
        `--certificate-arn ${this.certificate.certificateArn}`,
        "--query 'Certificate.DomainValidationOptions[].ResourceRecord'",
      ].join(' '),
      description: 'Command that prints the ACM validation CNAME (usually identical to the atmark-docs one; proxy OFF).',
    });
  }
}

export interface DocsCdnStackProps extends cdk.StackProps {
  readonly domainName: string;
  readonly certificate: acm.ICertificate;
  /** 오리진 — `AtmarkDocs` 커스텀 도메인의 리전 도메인 이름(`d-xxxx.execute-api.ap-northeast-2.amazonaws.com`). */
  readonly originDomainName: string;
}

export class DocsCdnStack extends cdk.Stack {
  public readonly distribution: cloudfront.Distribution;

  public constructor(scope: Construct, id: string, props: DocsCdnStackProps) {
    super(scope, id, props);

    const origin = new origins.HttpOrigin(props.originDomainName, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      originSslProtocols: [cloudfront.OriginSslPolicy.TLS_V1_2],
    });

    const assetCachePolicy = new cloudfront.CachePolicy(this, 'DocsAssetCachePolicy', {
      cachePolicyName: DOCS_CDN_ASSET_CACHE_POLICY_NAME,
      comment: 'docs.atmark.ai assets (fonts, screenshots, search index, crawl files) - Host + path key, origin Cache-Control',
      minTtl: cdk.Duration.seconds(0),
      defaultTtl: cdk.Duration.seconds(0),
      maxTtl: cdk.Duration.days(DOCS_CDN_ASSET_MAX_TTL_DAYS),
      headerBehavior: cloudfront.CacheHeaderBehavior.allowList('Host'),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });
    const pageCachePolicy = new cloudfront.CachePolicy(this, 'DocsPageCachePolicy', {
      cachePolicyName: DOCS_CDN_PAGE_CACHE_POLICY_NAME,
      comment: 'docs.atmark.ai pages (HTML, .md) - Host + path key (no query), origin Cache-Control (max-age=300)',
      minTtl: cdk.Duration.seconds(0),
      defaultTtl: cdk.Duration.seconds(0),
      maxTtl: cdk.Duration.seconds(DOCS_CDN_PAGE_MAX_TTL_SECONDS),
      headerBehavior: cloudfront.CacheHeaderBehavior.allowList('Host'),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });
    const searchCachePolicy = new cloudfront.CachePolicy(this, 'DocsSearchCachePolicy', {
      cachePolicyName: DOCS_CDN_SEARCH_CACHE_POLICY_NAME,
      comment: 'docs.atmark.ai /search - Host + path + q key, origin Cache-Control (max-age=300)',
      minTtl: cdk.Duration.seconds(0),
      defaultTtl: cdk.Duration.seconds(0),
      maxTtl: cdk.Duration.seconds(DOCS_CDN_PAGE_MAX_TTL_SECONDS),
      headerBehavior: cloudfront.CacheHeaderBehavior.allowList('Host'),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.allowList('q'),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });

    const assetBehavior: cloudfront.BehaviorOptions = {
      origin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
      cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
      cachePolicy: assetCachePolicy,
      compress: true,
    };

    this.distribution = new cloudfront.Distribution(this, 'DocsDistribution', {
      comment: 'Atmark docs docs.atmark.ai - edge cache in front of the docs HTTP API',
      defaultBehavior: {
        origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
        cachePolicy: pageCachePolicy,
        compress: true,
      },
      additionalBehaviors: Object.fromEntries([
        ...DOCS_CDN_SEARCH_PATH_PATTERNS.map((pattern): [string, cloudfront.BehaviorOptions] => [pattern, { ...assetBehavior, cachePolicy: searchCachePolicy }]),
        ...DOCS_CDN_ASSET_PATH_PATTERNS.map((pattern): [string, cloudfront.BehaviorOptions] => [pattern, assetBehavior]),
      ]),
      domainNames: [props.domainName],
      certificate: props.certificate,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
      enableIpv6: true,
      enableLogging: false,
    });

    new cdk.CfnOutput(this, 'DocsDistributionDomainName', {
      value: this.distribution.distributionDomainName,
      description: `${props.domainName} CNAME target - add in Cloudflare as CNAME, proxy OFF (DNS only). Rollback: point it at AtmarkDocs output DocsRegionalDomainName`,
    });
    new cdk.CfnOutput(this, 'DocsDistributionId', {
      value: this.distribution.distributionId,
      description: 'CloudFront distribution ID (invalidate: aws cloudfront create-invalidation --distribution-id <id> --paths "/*")',
    });
  }
}
