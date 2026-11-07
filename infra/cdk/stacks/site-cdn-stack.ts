/**
 * AtmarkSiteCdnCertificate · AtmarkSiteCdn — 홈 `https://atmark.ai` 앞의 CloudFront(2026-09-27).
 *
 * **왜.** 첫 방문 한 번이 폰트 청크 ≈18 개를 한꺼번에 요청하고, 사이트 λ 번들이 폰트 바이트(≈4MB)를 싣고 있어 콜드 스타트가 ≈0.35초다.
 * 그 버스트가 예약 동시성(2 → 10 → 30, `site-stack.ts` `SITE_RESERVED_CONCURRENCY`)을 넘어 폰트 503 이 났다. 폰트·이미지는 내용 해시가
 * URL 에 있는 1년 immutable 이라 엣지가 한 번 받으면 λ 를 다시 부르지 않는다 — 버스트는 엣지(POP)당 첫 요청 한 번으로 줄어든다.
 *
 * **오리진 = apex 커스텀 도메인의 리전 도메인 이름**(`d-xxxx.execute-api.ap-northeast-2.amazonaws.com`, `AtmarkSite` 출력 `SiteApexCnameTarget`)
 * **+ 뷰어 `Host`(atmark.ai) 전달.** CloudFront 는 `Host` 를 전달하면 그 값으로 오리진 인증서를 검증하고(SNI 도 그 값) API Gateway 는 커스텀
 * 도메인 `atmark.ai`(ap-northeast-2 인증서 `atmark-site`)로 요청을 받아 같은 API 매핑으로 보낸다. 그래서:
 *   - execute-api 기본 엔드포인트는 **계속 꺼 둔다**(`disableExecuteApiEndpoint`) — 입구가 새로 열리지 않는다. 기본 엔드포인트를 오리진으로
 *     쓰면 `Host` 를 넘길 수 없어(403) λ 가 호스트를 구분하지 못한다.
 *   - λ 는 전과 같은 `Host` 를 본다 — `src/site/http.ts` 무변경(www 301 · pay 분기 · apex 페이지).
 *   - 되돌리기는 **DNS 하나**(apex CNAME 을 다시 `SiteApexCnameTarget` 으로). API Gateway 쪽은 전환 전후로 그대로다.
 *   - 대가: `AtmarkSite` 가 그 리전 도메인 이름을 export 하고 이 스택이 import 한다 — apex 도메인 리소스를 교체하려면 이 스택을 먼저 지운다.
 *   - `*.cloudfront.net` 으로 직접 오면 `Host` 가 오리진 인증서와 맞지 않아 502 다(정본 이름 하나만 산다 — 의도).
 *
 * **별칭은 apex 하나.** `www.atmark.ai`(301 뿐)와 `pay.atmark.ai`(no-store · Paddle 체크아웃)는 API Gateway 에 그대로 둔다 — 캐시할 것이 없고,
 * DNS 를 바꿀 이유가 없다. 인증서는 www 를 SAN 으로 싣는다(나중에 별칭을 더할 때 재발급·재검증이 없게). 자산 캐시 키에는 `Host` 가 들어 있으므로
 * www 를 별칭에 더해도 www 의 301 이 apex 캐시를 오염시키지 않는다(테스트가 본다).
 *
 * **캐시 동작.**
 *   - 자산(`SITE_CDN_CACHED_PATH_PATTERNS` — `/_fonts/*` · `/img/*` · `/og/*` · 파비콘(옛 둘 · 해시 `/favicon-*` · `/apple-touch-icon*`) · `robots.txt` · `sitemap.xml` · `llms.txt`):
 *     캐시 정책 `atmark-site-assets` — 키 = `Host` + 경로(+ 정규화된 `Accept-Encoding`). 쿼리·쿠키는 키에도 오리진에도 없다(쿼리로 캐시를
 *     우회해 λ 를 두드릴 수 없다). TTL 은 **오리진 `Cache-Control`** 을 따른다(최소 0 · 기본 0 = 헤더가 없으면 캐시 안 함 · 최대 1년).
 *     `Origin` 은 키에 넣지 않는다 — 폰트의 ACAO 는 요청을 반사하지 않는 고정값(`https://console.atmark.ai`)이라 모든 출처에 같은 응답이다.
 *     엣지 압축을 켠다(오리진은 이 경로들을 압축하지 않는다 — woff2·webp·png 는 CloudFront 가 압축하지 않는 형식이고, 텍스트·svg·ico 만 준다).
 *   - 그 밖(HTML 페이지 · /login · /signup · 404 · 405): 관리형 `CachingDisabled` + `AllViewer`(뷰어의 헤더·쿼리·쿠키를 그대로 오리진에 — λ 가
 *     읽는 것은 `Host` · `Accept-Encoding` · 경로 · 쿼리 · 메서드뿐이다). 모든 메서드를 넘겨 POST 등은 지금처럼 λ 가 405 를 낸다.
 *     엣지 압축 **끔** — HTML 은 오리진이 gzip 하고 `vary: accept-encoding` 을 싣는다(캐시 정책이 압축 정규화를 하지 않으므로 뷰어의
 *     `Accept-Encoding` 이 그대로 간다). CloudFront 는 이미 `content-encoding` 이 있는 응답을 다시 압축하지 않는다 — 이중 인코딩 없음.
 *   - **응답 헤더 정책 없음** — 오리진의 CSP · HSTS · nosniff · x-frame-options · ACAO · cache-control · vary 를 그대로 통과시킨다. 관리형
 *     보안 헤더 정책을 붙이면 페이지별 CSP(스타일·스크립트 해시)를 덮어쓴다.
 *   - 접근 로그 없음 — 홈은 요청 IP 를 남기지 않는다(`site-stack.ts` 접근 로그 형식, 개인정보 처리 안내).
 *   - 가격 등급 200 — 100 은 북미·유럽만이라 한국 방문자가 미국·유럽 엣지로 간다. 200 에 한국·일본이 있다.
 *
 * **언어 협상(2026-09-30).** 기본 동작(HTML)의 뷰어 요청에 CloudFront Function `atmark-site-lang`(`src/site/edge-lang.ts` 의 소스 그대로) 하나를
 * 건다 — 영어가 기본(접두어 없음)이고, 쿠키 `atmark_lang=ko` 또는 (쿠키 없이) Accept-Language 가 한국어를 가장 높이 치면 접두어 없는 페이지 경로를
 * `/kr…` 로 302 한다. 언어 전환 링크의 `?hl=` 은 쿠키를 적고 쿼리 없는 경로로 302. 자산 동작에는 걸지 않는다(캐시 경로는 협상 대상이 아니다).
 * 페이지는 캐시하지 않으므로(`CachingDisabled`) 협상이 캐시 키를 흔들지 않는다 — 함수가 오리진 앞에서 먼저 답한다.
 *
 * **스택이 둘인 이유**는 `identity-cdn-stack.ts` 와 같다 — CloudFront 인증서는 us-east-1 에만, 배포 본체는 ap-northeast-2(`crossRegionReferences`).
 * 배포·DNS·되돌리기: `docs/runbooks/site.md` §10.
 */

import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import type { Construct } from 'constructs';

import { SITE_LANG_FUNCTION_CODE } from '../../../src/site/edge-lang';

/**
 * 엣지에 캐시하는 경로(CloudFront 경로 패턴 — `*` 는 `/` 를 포함한 아무 문자열). 전부 오리진이 `Cache-Control` 을 싣는 비문서 자산이다
 * (`src/site/http.ts`): 폰트·`/img/` 1년 immutable · `/og/`·파비콘 30일 · 크롤러 파일 5분. HTML 페이지 경로는 여기 걸리지 않는다(테스트).
 */
export const SITE_CDN_CACHED_PATH_PATTERNS = [
  '/_fonts/*',
  '/img/*',
  '/og/*',
  '/favicon.svg',
  '/favicon.ico',
  // 해시 파비콘(`/favicon-<해시>.svg|.ico`, 1년 immutable)과 apple-touch-icon(해시·옛 경로) — `src/ui/favicon.ts`.
  '/favicon-*',
  '/apple-touch-icon*',
  '/robots.txt',
  '/sitemap.xml',
  '/llms.txt',
] as const;

/** 자산 캐시 정책 이름과 최대 TTL(1년 — 오리진의 `max-age=31536000` 과 같다). */
export const SITE_CDN_ASSET_CACHE_POLICY_NAME = 'atmark-site-assets';

/** 언어 협상 함수 이름(CloudFront Functions — 계정·전역에서 유일). */
export const SITE_CDN_LANG_FUNCTION_NAME = 'atmark-site-lang';
export const SITE_CDN_ASSET_MAX_TTL_DAYS = 365;

export interface SiteCdnCertificateStackProps extends cdk.StackProps {
  readonly domainName: string;
  readonly alternativeNames: readonly string[];
}

/** `us-east-1` 전용 — CloudFront 용 `atmark.ai`(+ `www.atmark.ai`) ACM 인증서(DNS 검증). ap-northeast-2 의 `atmark-site` 와 별개다. */
export class SiteCdnCertificateStack extends cdk.Stack {
  public readonly certificate: acm.ICertificate;

  public constructor(scope: Construct, id: string, props: SiteCdnCertificateStackProps) {
    super(scope, id, props);

    this.certificate = new acm.Certificate(this, 'SiteCdnCertificate', {
      domainName: props.domainName,
      subjectAlternativeNames: [...props.alternativeNames],
      // Route 53 호스팅 영역이 없다(DNS 는 Cloudflare). 검증 CNAME 은 같은 계정·같은 이름이면 ap-northeast-2 인증서(`atmark-site`)와 같은
      // 값이라 이미 Cloudflare 에 있을 가능성이 높다 — 아래 조회 명령으로 확인하고, 없으면 사람이 넣는다(런북 site.md §10).
      validation: acm.CertificateValidation.fromDns(),
      certificateName: 'atmark-site-cdn',
    });

    new cdk.CfnOutput(this, 'SiteCdnCertificateArn', {
      value: this.certificate.certificateArn,
      description: `${[props.domainName, ...props.alternativeNames].join(' + ')} ACM 인증서 ARN (${this.region}, CloudFront 용)`,
    });
    new cdk.CfnOutput(this, 'SiteCdnCertificateValidationLookupCommand', {
      value: [
        `AWS_PROFILE=atmark aws acm describe-certificate --region ${this.region}`,
        `--certificate-arn ${this.certificate.certificateArn}`,
        "--query 'Certificate.DomainValidationOptions[].ResourceRecord'",
      ].join(' '),
      description: 'Cloudflare 에 있어야 할 ACM 검증 CNAME(이름마다 하나 — 프록시 OFF)을 조회하는 명령. atmark-site 인증서의 것과 같으면 추가할 것이 없다.',
    });
  }
}

export interface SiteCdnStackProps extends cdk.StackProps {
  /** 별칭(`atmark.ai`). */
  readonly domainName: string;
  /** `us-east-1` 의 SiteCdnCertificateStack 인증서. */
  readonly certificate: acm.ICertificate;
  /** 오리진 — `AtmarkSite` apex 커스텀 도메인의 리전 도메인 이름(`d-xxxx.execute-api.ap-northeast-2.amazonaws.com`). */
  readonly originDomainName: string;
}

export class SiteCdnStack extends cdk.Stack {
  public readonly distribution: cloudfront.Distribution;

  public constructor(scope: Construct, id: string, props: SiteCdnStackProps) {
    super(scope, id, props);

    const origin = new origins.HttpOrigin(props.originDomainName, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      originSslProtocols: [cloudfront.OriginSslPolicy.TLS_V1_2],
    });

    // 키 = Host + 경로(+ 정규화된 Accept-Encoding). 캐시 키의 헤더는 오리진으로도 간다 — Host 가 있어야 API Gateway 가 커스텀 도메인
    // atmark.ai 로 받는다(없으면 SNI·Host 가 d-xxxx 가 되어 거절). 쿼리·쿠키는 키에도 오리진에도 없다.
    const assetCachePolicy = new cloudfront.CachePolicy(this, 'SiteAssetCachePolicy', {
      cachePolicyName: SITE_CDN_ASSET_CACHE_POLICY_NAME,
      comment: 'atmark.ai static assets (fonts, images, favicon, crawl files) - Host + path key, honours origin Cache-Control',
      minTtl: cdk.Duration.seconds(0),
      defaultTtl: cdk.Duration.seconds(0),
      maxTtl: cdk.Duration.days(SITE_CDN_ASSET_MAX_TTL_DAYS),
      headerBehavior: cloudfront.CacheHeaderBehavior.allowList('Host'),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });

    // 언어 협상(영어 기본 · `/kr` 한국어) — HTML 이 지나는 기본 동작의 뷰어 요청에만.
    const langFunction = new cloudfront.Function(this, 'SiteLangFunction', {
      functionName: SITE_CDN_LANG_FUNCTION_NAME,
      comment: 'atmark.ai language: cookie atmark_lang / Accept-Language -> /kr (302), ?hl= sets the cookie',
      code: cloudfront.FunctionCode.fromInline(SITE_LANG_FUNCTION_CODE),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
    });

    const assetBehavior: cloudfront.BehaviorOptions = {
      origin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
      cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
      cachePolicy: assetCachePolicy,
      compress: true,
    };

    this.distribution = new cloudfront.Distribution(this, 'SiteDistribution', {
      comment: 'Atmark home atmark.ai - edge cache for immutable assets, pages pass through to the site HTTP API',
      defaultBehavior: {
        origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
        // HTML 은 오리진이 gzip 한다(vary: accept-encoding). 엣지는 손대지 않는다.
        compress: false,
        functionAssociations: [{ function: langFunction, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
      },
      additionalBehaviors: Object.fromEntries(SITE_CDN_CACHED_PATH_PATTERNS.map((pattern) => [pattern, assetBehavior])),
      domainNames: [props.domainName],
      certificate: props.certificate,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
      enableIpv6: true,
      enableLogging: false,
    });

    new cdk.CfnOutput(this, 'SiteDistributionDomainName', {
      value: this.distribution.distributionDomainName,
      description: `${props.domainName} (apex) 의 새 CNAME 값 — Cloudflare 에 CNAME(평탄화)으로, **프록시 OFF(DNS only)**. 되돌리기는 AtmarkSite 출력 SiteApexCnameTarget 으로(런북 site.md §10)`,
    });
    new cdk.CfnOutput(this, 'SiteDistributionId', {
      value: this.distribution.distributionId,
      description: 'CloudFront 배포 ID (무효화: aws cloudfront create-invalidation --distribution-id <이 값> --paths "/robots.txt")',
    });
  }
}
