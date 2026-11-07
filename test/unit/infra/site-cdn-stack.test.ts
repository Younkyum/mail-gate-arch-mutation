/**
 * `AtmarkSiteCdnCertificate` · `AtmarkSiteCdn` — 홈 앞 CloudFront 의 합성 템플릿 단언. **배포하지 않는다.**
 *
 * 고정하는 것: 인증서는 us-east-1 · 별칭은 apex 하나(www·pay 는 API Gateway 그대로) · 오리진은 apex 커스텀 도메인의 리전 도메인 이름 +
 * Host 전달 · 자산 경로만 캐시(키 = Host + 경로, 쿼리·쿠키 없음, 오리진 Cache-Control) · 페이지는 캐시 안 함 · 응답 헤더 정책 0(CSP 를 덮지 않는다) ·
 * 접근 로그 0 · 엣지 함수는 언어 협상 하나(2026-09-30 — 기본 동작의 뷰어 요청에만). 그리고 캐시 경로 패턴이 **핸들러와 맞는지**(페이지 경로는 걸리지 않고, 걸리는 경로는 오리진이 Cache-Control 을 싣는다).
 */

import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

import {
  SITE_CDN_ASSET_CACHE_POLICY_NAME,
  SITE_CDN_CACHED_PATH_PATTERNS,
  SITE_CDN_LANG_FUNCTION_NAME,
  SiteCdnCertificateStack,
  SiteCdnStack,
} from '../../../infra/cdk/stacks/site-cdn-stack';
import {
  SITE_DOMAIN_NAME,
  SITE_PAY_DOMAIN_NAME,
  SITE_WWW_DOMAIN_NAME,
  SiteCertificateStack,
  SiteStack,
} from '../../../infra/cdk/stacks/site-stack';
import { handleSiteRequest, SITE_ROUTES } from '../../../src/site/http';
import { CONSOLE_ORIGIN } from '../../../src/site/constants';
import { SITE_LANG_FUNCTION_CODE } from '../../../src/site/edge-lang';
import { OG_IMAGES } from '../../../src/site/image-data';
import { SITE_PHOTOS } from '../../../src/site/photo-data';
import { APPLE_TOUCH_ICON_PATH, FAVICON_ICO_PATH, FAVICON_SVG_PATH } from '../../../src/ui/favicon';
import { fontPath } from '../../../src/ui/font-faces';
import { PRETENDARD_CHUNKS } from '../../../src/ui/pretendard-data';
import { ACCOUNT, onlyPropertiesOf, REGION, resourcesOf } from './runtime-app';

/** CloudFront 관리형 정책 id(AWS 문서의 고정값). */
const MANAGED_CACHING_DISABLED = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad';
const MANAGED_ALL_VIEWER = '216adef6-5c7f-47e4-b989-5492eafa07d3';

interface Built {
  readonly site: Template;
  readonly cdnCertificate: Template;
  readonly cdn: Template;
  readonly cdnCertificateRegion: string;
}

function build(): Built {
  const app = new cdk.App();
  const env = { account: ACCOUNT, region: REGION };
  // `infra/cdk/app.ts` 와 같은 배선.
  const certificate = new SiteCertificateStack(app, 'AtmarkSiteCertificate', {
    env,
    domainName: SITE_DOMAIN_NAME,
    alternativeNames: [SITE_WWW_DOMAIN_NAME],
    payDomainName: SITE_PAY_DOMAIN_NAME,
  });
  if (certificate.payCertificate === undefined) throw new Error('pay 인증서가 없다');
  const site = new SiteStack(app, 'AtmarkSite', {
    env,
    domains: {
      apex: SITE_DOMAIN_NAME,
      www: SITE_WWW_DOMAIN_NAME,
      certificate: certificate.certificate,
      pay: { domainName: SITE_PAY_DOMAIN_NAME, certificate: certificate.payCertificate },
    },
    lambdaCode: { kind: 'stub' },
  });
  if (site.apexDomain === undefined) throw new Error('apex 도메인이 없다');
  const cdnCertificate = new SiteCdnCertificateStack(app, 'AtmarkSiteCdnCertificate', {
    env: { account: ACCOUNT, region: 'us-east-1' },
    domainName: SITE_DOMAIN_NAME,
    alternativeNames: [SITE_WWW_DOMAIN_NAME],
    crossRegionReferences: true,
  });
  const cdn = new SiteCdnStack(app, 'AtmarkSiteCdn', {
    env,
    domainName: SITE_DOMAIN_NAME,
    certificate: cdnCertificate.certificate,
    originDomainName: site.apexDomain.regionalDomainName,
    crossRegionReferences: true,
  });
  cdn.addStackDependency(cdnCertificate);
  return {
    site: Template.fromStack(site),
    cdnCertificate: Template.fromStack(cdnCertificate),
    cdn: Template.fromStack(cdn),
    cdnCertificateRegion: cdnCertificate.region,
  };
}

let cached: Built | undefined;
const built = (): Built => (cached ??= build());

interface Behavior {
  PathPattern?: string;
  CachePolicyId?: unknown;
  OriginRequestPolicyId?: unknown;
  ResponseHeadersPolicyId?: unknown;
  AllowedMethods?: string[];
  CachedMethods?: string[];
  Compress?: boolean;
  ViewerProtocolPolicy?: string;
  FunctionAssociations?: unknown;
  LambdaFunctionAssociations?: unknown;
  TargetOriginId?: string;
}

const distributionConfig = (): Record<string, unknown> =>
  onlyPropertiesOf(built().cdn, 'AWS::CloudFront::Distribution')['DistributionConfig'] as Record<string, unknown>;
const defaultBehavior = (): Behavior => distributionConfig()['DefaultCacheBehavior'] as Behavior;
const cacheBehaviors = (): Behavior[] => (distributionConfig()['CacheBehaviors'] ?? []) as Behavior[];

/** CloudFront 경로 패턴 → 정규식(`*` 는 `/` 포함 아무 문자열, `?` 는 한 글자 — 대소문자 구분). */
function patternRegex(pattern: string): RegExp {
  const body = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${body}$`);
}
const cachedBy = (path: string): string | undefined => SITE_CDN_CACHED_PATH_PATTERNS.find((p) => patternRegex(p).test(path));

const get = (path: string, headers: Record<string, string> = {}): ReturnType<typeof handleSiteRequest> =>
  handleSiteRequest({ rawPath: path, headers: { host: SITE_DOMAIN_NAME, ...headers }, requestContext: { http: { method: 'GET' } } });

describe('AtmarkSiteCdnCertificate — us-east-1', () => {
  it('us-east-1 · atmark.ai + www.atmark.ai · DNS 검증(Route 53 없음) · 이름 atmark-site-cdn · 조회 명령 출력', () => {
    expect(built().cdnCertificateRegion).toBe('us-east-1');
    const cert = onlyPropertiesOf(built().cdnCertificate, 'AWS::CertificateManager::Certificate');
    expect(cert['DomainName']).toBe(SITE_DOMAIN_NAME);
    expect(cert['SubjectAlternativeNames']).toEqual([SITE_WWW_DOMAIN_NAME]);
    expect(cert['ValidationMethod']).toBe('DNS');
    expect(cert['DomainValidationOptions']).toBeUndefined();
    // `certificateName` 은 Name 태그다(ap-northeast-2 의 atmark-site 와 구분).
    expect(cert['Tags']).toEqual([{ Key: 'Name', Value: 'atmark-site-cdn' }]);
    const outputs = built().cdnCertificate.toJSON()['Outputs'] as Record<string, { Value: unknown }>;
    expect(outputs).toHaveProperty('SiteCdnCertificateArn');
    const command = JSON.stringify(outputs['SiteCdnCertificateValidationLookupCommand']?.Value);
    expect(command).toContain('aws acm describe-certificate --region us-east-1');
    expect(command).toContain('DomainValidationOptions[].ResourceRecord');
  });
});

describe('AtmarkSiteCdn — 배포', () => {
  it('별칭은 apex 하나(www·pay 는 API Gateway 그대로) · us-east-1 인증서(SNI) · TLS 1.2_2021 · HTTP/2+3 · IPv6 · 가격 등급 200 · 접근 로그 없음', () => {
    const config = distributionConfig();
    expect(config['Aliases']).toEqual([SITE_DOMAIN_NAME]);
    const viewer = config['ViewerCertificate'] as Record<string, unknown>;
    expect(viewer['SslSupportMethod']).toBe('sni-only');
    expect(viewer['MinimumProtocolVersion']).toBe('TLSv1.2_2021');
    // 교차 리전 참조(SSM 을 읽는 커스텀 리소스)로 us-east-1 스택의 인증서를 가리킨다 — ap-northeast-2 인증서(atmark-site)가 아니다.
    expect(JSON.stringify(viewer['AcmCertificateArn'])).toMatch(/SiteCdnCertificate/);
    expect(JSON.stringify(viewer['AcmCertificateArn'])).not.toMatch(/AtmarkSiteCertificate/);
    expect(config['HttpVersion']).toBe('http2and3');
    expect(config['IPV6Enabled']).toBe(true);
    // 100 은 북미·유럽만 — 한국 방문자가 먼 엣지로 간다.
    expect(config['PriceClass']).toBe('PriceClass_200');
    // 홈은 요청 IP 를 남기지 않는다(개인정보 처리 안내 · site-stack 접근 로그 형식).
    expect(config['Logging']).toBeUndefined();
    expect(config['WebACLId']).toBeUndefined();
  });

  it('오리진 하나 = AtmarkSite apex 커스텀 도메인의 리전 도메인 이름(export/import) · HTTPS 만 · TLS 1.2', () => {
    const originsList = distributionConfig()['Origins'] as Record<string, unknown>[];
    expect(originsList).toHaveLength(1);
    const origin = originsList[0] ?? {};
    expect(JSON.stringify(origin['DomainName'])).toMatch(/Fn::ImportValue.*AtmarkSite:.*SiteApexDomainName.*RegionalDomainName/);
    expect(origin['CustomOriginConfig']).toMatchObject({ OriginProtocolPolicy: 'https-only', OriginSSLProtocols: ['TLSv1.2'] });
    expect(origin['S3OriginConfig']).toBeUndefined();
    // 오리진이 쓰는 이름이 바로 DNS 되돌리기 대상(SiteApexCnameTarget) — AtmarkSite 가 그 값을 export 한다.
    const siteOutputs = built().site.toJSON()['Outputs'] as Record<string, { Value: unknown; Export?: unknown }>;
    const exported = Object.values(siteOutputs).filter((o) => o.Export !== undefined);
    expect(exported).toHaveLength(1);
    expect(JSON.stringify(exported[0]?.Value)).toMatch(/SiteApexDomainName.*RegionalDomainName/);
    expect(JSON.stringify(siteOutputs['SiteApexCnameTarget']?.Value)).toBe(JSON.stringify(exported[0]?.Value));
  });

  it('기본 동작(페이지) — CachingDisabled · AllViewer(Host·Accept-Encoding·쿼리 그대로) · 모든 메서드(405 는 λ 가) · 엣지 압축 끔 · HTTPS 로 리다이렉트', () => {
    const behavior = defaultBehavior();
    expect(behavior.CachePolicyId).toBe(MANAGED_CACHING_DISABLED);
    expect(behavior.OriginRequestPolicyId).toBe(MANAGED_ALL_VIEWER);
    expect([...(behavior.AllowedMethods ?? [])].sort()).toEqual(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT']);
    // HTML 은 오리진이 gzip + vary: accept-encoding — 엣지가 다시 압축하지 않는다.
    expect(behavior.Compress).toBe(false);
    expect(behavior.ViewerProtocolPolicy).toBe('redirect-to-https');
  });

  it('자산 동작 — 패턴은 SITE_CDN_CACHED_PATH_PATTERNS 그대로 · 모두 같은 캐시 정책 · GET/HEAD · 엣지 압축 · 오리진 요청 정책 없음', () => {
    const behaviors = cacheBehaviors();
    expect(behaviors.map((b) => b.PathPattern)).toEqual([...SITE_CDN_CACHED_PATH_PATTERNS]);
    expect(SITE_CDN_CACHED_PATH_PATTERNS).toEqual([
      '/_fonts/*',
      '/img/*',
      '/og/*',
      '/favicon.svg',
      '/favicon.ico',
      '/favicon-*',
      '/apple-touch-icon*',
      '/robots.txt',
      '/sitemap.xml',
      '/llms.txt',
    ]);
    const policyIds = Object.keys(resourcesOf(built().cdn, 'AWS::CloudFront::CachePolicy'));
    expect(policyIds).toHaveLength(1);
    for (const behavior of behaviors) {
      expect(behavior.CachePolicyId, behavior.PathPattern).toEqual({ Ref: policyIds[0] });
      // 캐시 키의 헤더(Host)가 오리진으로 간다 — 따로 오리진 요청 정책을 두면 키에 없는 것이 오리진으로 새어 캐시를 우회할 수 있다.
      expect(behavior.OriginRequestPolicyId, behavior.PathPattern).toBeUndefined();
      expect([...(behavior.AllowedMethods ?? [])].sort()).toEqual(['GET', 'HEAD']);
      expect([...(behavior.CachedMethods ?? [])].sort()).toEqual(['GET', 'HEAD']);
      expect(behavior.Compress).toBe(true);
      expect(behavior.ViewerProtocolPolicy).toBe('redirect-to-https');
      expect(behavior.FunctionAssociations).toBeUndefined();
      expect(behavior.LambdaFunctionAssociations).toBeUndefined();
      expect(behavior.TargetOriginId).toBe(defaultBehavior().TargetOriginId);
    }
  });

  it('자산 캐시 정책 — 키 = Host + 경로(+ 정규화 Accept-Encoding) · 쿼리·쿠키 없음 · Origin 없음 · TTL 은 오리진 Cache-Control(0 / 0 / 1년)', () => {
    const config = onlyPropertiesOf(built().cdn, 'AWS::CloudFront::CachePolicy')['CachePolicyConfig'] as Record<string, unknown>;
    expect(config['Name']).toBe(SITE_CDN_ASSET_CACHE_POLICY_NAME);
    expect(config['MinTTL']).toBe(0);
    expect(config['DefaultTTL']).toBe(0);
    expect(config['MaxTTL']).toBe(31_536_000);
    const key = config['ParametersInCacheKeyAndForwardedToOrigin'] as Record<string, Record<string, unknown>>;
    // Host 가 키에 있어야 (1) 오리진(API Gateway 커스텀 도메인)이 atmark.ai 로 받고 (2) 나중에 www 를 별칭에 더해도 www 의 301 이 apex 캐시를 오염시키지 않는다.
    expect(key['HeadersConfig']).toEqual({ HeaderBehavior: 'whitelist', Headers: ['Host'] });
    expect(key['CookiesConfig']).toEqual({ CookieBehavior: 'none' });
    expect(key['QueryStringsConfig']).toEqual({ QueryStringBehavior: 'none' });
    expect(key['EnableAcceptEncodingGzip']).toBe(true);
    expect(key['EnableAcceptEncodingBrotli']).toBe(true);
  });

  it('응답 헤더 정책 0 — 오리진의 CSP·HSTS·ACAO·vary 를 그대로 통과(관리형 보안 헤더가 페이지별 CSP 를 덮지 않게) · 엣지 함수는 언어 협상 하나 · 오리진 요청 정책 리소스 0', () => {
    const template = built().cdn;
    expect(Object.keys(resourcesOf(template, 'AWS::CloudFront::ResponseHeadersPolicy'))).toHaveLength(0);
    // 2026-09-30 — 엣지 함수는 언어 협상(atmark-site-lang) 하나뿐. 소스는 edge-lang.ts 그대로 · cloudfront-js-2.0.
    const functions = resourcesOf(template, 'AWS::CloudFront::Function');
    expect(Object.keys(functions)).toHaveLength(1);
    const fnId = Object.keys(functions)[0] ?? '';
    const fn = functions[fnId]?.Properties ?? {};
    expect(fn['Name']).toBe(SITE_CDN_LANG_FUNCTION_NAME);
    expect(SITE_CDN_LANG_FUNCTION_NAME).toBe('atmark-site-lang');
    expect(fn['FunctionCode']).toBe(SITE_LANG_FUNCTION_CODE);
    expect((fn['FunctionConfig'] as Record<string, unknown>)['Runtime']).toBe('cloudfront-js-2.0');
    expect(fn['AutoPublish']).toBe(true);
    // 기본 동작(HTML)에만 뷰어 요청으로 정확히 하나 · 람다@엣지 없음 · 자산 동작에는 없다(위 자산 동작 단언).
    const assoc = defaultBehavior().FunctionAssociations as { EventType?: string; FunctionARN?: unknown }[] | undefined;
    expect(assoc).toHaveLength(1);
    expect(assoc?.[0]?.EventType).toBe('viewer-request');
    expect(assoc?.[0]?.FunctionARN).toEqual({ 'Fn::GetAtt': [fnId, 'FunctionARN'] });
    expect(defaultBehavior().LambdaFunctionAssociations).toBeUndefined();
    for (const behavior of cacheBehaviors()) expect(behavior.FunctionAssociations, behavior.PathPattern).toBeUndefined();
    expect(Object.keys(resourcesOf(template, 'AWS::CloudFront::OriginRequestPolicy'))).toHaveLength(0);
    for (const behavior of [defaultBehavior(), ...cacheBehaviors()]) {
      expect(behavior.ResponseHeadersPolicyId, behavior.PathPattern ?? 'default').toBeUndefined();
    }
  });

  it('출력 — 새 apex CNAME 값(배포 도메인 이름)과 배포 ID', () => {
    const outputs = built().cdn.toJSON()['Outputs'] as Record<string, { Value: unknown }>;
    expect(JSON.stringify(outputs['SiteDistributionDomainName']?.Value)).toMatch(/SiteDistribution.*DomainName/);
    expect(outputs).toHaveProperty('SiteDistributionId');
  });
});

describe('AtmarkSite — CloudFront 를 세워도 그대로인 것', () => {
  it('execute-api 기본 엔드포인트는 여전히 꺼져 있다 · 커스텀 도메인 셋(apex·www·pay)과 매핑 셋 그대로 · CDN 템플릿은 www·pay 를 모른다', () => {
    const api = onlyPropertiesOf(built().site, 'AWS::ApiGatewayV2::Api');
    expect(api['DisableExecuteApiEndpoint']).toBe(true);
    const domains = Object.values(resourcesOf(built().site, 'AWS::ApiGatewayV2::DomainName')).map((d) => d.Properties['DomainName']);
    expect(domains.sort()).toEqual([SITE_DOMAIN_NAME, SITE_PAY_DOMAIN_NAME, SITE_WWW_DOMAIN_NAME].sort());
    expect(Object.keys(resourcesOf(built().site, 'AWS::ApiGatewayV2::ApiMapping'))).toHaveLength(3);
    const cdnJson = JSON.stringify(built().cdn.toJSON());
    expect(cdnJson).not.toContain(SITE_PAY_DOMAIN_NAME);
    expect(cdnJson).not.toContain(SITE_WWW_DOMAIN_NAME);
  });
});

describe('캐시 경로 패턴 ↔ 핸들러(src/site/http.ts)', () => {
  it('HTML 페이지 경로(라우트 전부 · 404 · 끝 슬래시)는 어떤 캐시 패턴에도 걸리지 않는다 — 페이지는 늘 λ 로', () => {
    const pages = [...Object.keys(SITE_ROUTES), '/nope', '/kr/nope', '/en/nope', '/terms/', '/kr/', '/en/', '/en/pricing'];
    expect(Object.keys(SITE_ROUTES).length).toBeGreaterThan(10);
    for (const path of pages) expect(cachedBy(path), path).toBeUndefined();
  });

  it('캐시되는 경로의 실제 응답 — 200 · 오리진이 max-age 를 싣는다(TTL 근거) · HTML 이 아니다(Vary·gzip 없음)', () => {
    const chunk = PRETENDARD_CHUNKS[0];
    if (chunk === undefined) throw new Error('폰트 청크가 없다');
    const samples = [
      fontPath(chunk),
      SITE_PHOTOS['desk-window'][0]?.path ?? '∅',
      SITE_PHOTOS['post-boxes'][1]?.path ?? '∅',
      OG_IMAGES.ko.path,
      '/favicon.svg',
      '/favicon.ico',
      // 2026-09-30 — 해시 파비콘 셋과 옛 apple-touch-icon(실제 경로로 새 패턴 둘을 친다).
      FAVICON_SVG_PATH,
      FAVICON_ICO_PATH,
      APPLE_TOUCH_ICON_PATH,
      '/apple-touch-icon.png',
      '/robots.txt',
      '/sitemap.xml',
      '/llms.txt',
    ];
    const covered = new Set<string>();
    for (const path of samples) {
      const pattern = cachedBy(path);
      expect(pattern, path).toBeDefined();
      covered.add(String(pattern));
      const response = get(path, { 'accept-encoding': 'br,gzip' });
      expect(response.statusCode, path).toBe(200);
      expect(response.headers['cache-control'], path).toMatch(/^public, max-age=[1-9][0-9]*/);
      expect(response.headers['content-type'] ?? '', path).not.toMatch(/^text\/html/);
      expect(response.headers['content-encoding'], path).toBeUndefined();
      expect(response.headers['vary'], path).toBeUndefined();
    }
    // 모든 패턴이 실제 자산 하나 이상을 덮는다(죽은 패턴 없음).
    expect([...covered].sort()).toEqual([...SITE_CDN_CACHED_PATH_PATTERNS].sort());
  });

  it('폰트 ACAO 는 요청 Origin 과 무관한 고정값(콘솔 출처) — Origin 을 캐시 키에 넣지 않아도 된다', () => {
    const chunk = PRETENDARD_CHUNKS[0];
    if (chunk === undefined) throw new Error('폰트 청크가 없다');
    const path = fontPath(chunk);
    const fromConsole = get(path, { origin: CONSOLE_ORIGIN });
    const fromElsewhere = get(path, { origin: 'https://evil.example' });
    const noOrigin = get(path);
    for (const response of [fromConsole, fromElsewhere, noOrigin]) {
      expect(response.headers['access-control-allow-origin']).toBe(CONSOLE_ORIGIN);
      expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    }
    expect(fromElsewhere.headers).toEqual(noOrigin.headers);
  });

  it('www 호스트는 자산 경로에도 301 — 캐시 키에 Host 가 있어야 하는 이유(www 를 별칭에 더할 때)', () => {
    const chunk = PRETENDARD_CHUNKS[0];
    if (chunk === undefined) throw new Error('폰트 청크가 없다');
    const response = get(fontPath(chunk), { host: SITE_WWW_DOMAIN_NAME });
    expect(response.statusCode).toBe(301);
  });
});
