/**
 * `AtmarkDocsCertificate` · `AtmarkDocs` · `AtmarkDocsCdnCertificate` · `AtmarkDocsCdn` — 사용자 문서(docs.atmark.ai) 스택의 합성 템플릿 단언.
 * **배포하지 않는다.**
 *
 * 고정하는 것:
 *   - **기존 스택 diff 0** — `infra/cdk/app.ts` 와 같은 배선으로 운영·홈 스택을 세운 앱을 문서 스택 없이 한 번, 있이 한 번 합성해 기존 스택의
 *     템플릿이 바이트까지 같은지 본다(문서 스택은 기존 스택의 어느 리소스도 참조하지 않는다).
 *   - λ: 이름·역할(자기 로그 그룹 쓰기만, 관리형 정책 0) · VPC 밖 · 환경 변수 0 · arm64 · Node 22 · 예약 동시성 · 스텁 배포 거부.
 *   - HTTP API: 커스텀 도메인 하나 · execute-api 기본 엔드포인트 끔 · 스로틀(합이 천장 안) · 접근 로그에 요청 IP 없음.
 *   - CDN: us-east-1 인증서 · 별칭 하나 · 오리진 = 문서 커스텀 도메인의 리전 이름(+ Host) · 자산 경로만 긴 캐시(핸들러와 대조) · 페이지는 오리진
 *     Cache-Control(5분)을 따르고 키에 쿼리 · 응답 헤더 정책 0 · 접근 로그 0 · GET/HEAD 만.
 */

import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import {
  DOCS_CDN_ASSET_CACHE_POLICY_NAME,
  DOCS_CDN_ASSET_PATH_PATTERNS,
  DOCS_CDN_PAGE_CACHE_POLICY_NAME,
  DOCS_CDN_SEARCH_CACHE_POLICY_NAME,
  DOCS_CDN_SEARCH_PATH_PATTERNS,
  DocsCdnCertificateStack,
  DocsCdnStack,
} from '../../../infra/cdk/stacks/docs-cdn-stack';
import {
  DOCS_DOMAIN_NAME,
  DOCS_FONT_ROUTE_KEY,
  DOCS_FONT_THROTTLE,
  DOCS_FUNCTION_NAME,
  DOCS_LAMBDA_BUCKET_CEILING,
  DOCS_RESERVED_CONCURRENCY,
  DOCS_ROLE_NAME,
  DOCS_THROTTLE,
  DocsCertificateStack,
  DocsStack,
} from '../../../infra/cdk/stacks/docs-stack';
import { SiteCdnCertificateStack, SiteCdnStack } from '../../../infra/cdk/stacks/site-cdn-stack';
import { SITE_DOMAIN_NAME, SITE_PAY_DOMAIN_NAME, SITE_WWW_DOMAIN_NAME, SiteCertificateStack, SiteStack } from '../../../infra/cdk/stacks/site-stack';
import { DOCS_HOST } from '../../../src/docs/constants';
import { handleDocsRequest } from '../../../src/docs/http';
import { ACCOUNT, buildRuntimeApp, onlyPropertiesOf, REGION, resourcesOf } from './runtime-app';

interface DocsStacks {
  readonly certificate: DocsCertificateStack;
  readonly docs: DocsStack;
  readonly cdnCertificate: DocsCdnCertificateStack;
  readonly cdn: DocsCdnStack;
}

/** `infra/cdk/app.ts` 와 같은 배선 — 문서 스택 넷. */
function addDocsStacks(app: cdk.App, lambdaCode: { kind: 'stub' } = { kind: 'stub' }): DocsStacks {
  const env = { account: ACCOUNT, region: REGION };
  const certificate = new DocsCertificateStack(app, 'AtmarkDocsCertificate', { env, domainName: DOCS_DOMAIN_NAME });
  const docs = new DocsStack(app, 'AtmarkDocs', { env, domain: { domainName: DOCS_DOMAIN_NAME, certificate: certificate.certificate }, lambdaCode });
  if (docs.domain === undefined) throw new Error('문서 도메인이 없다');
  const cdnCertificate = new DocsCdnCertificateStack(app, 'AtmarkDocsCdnCertificate', {
    env: { account: ACCOUNT, region: 'us-east-1' },
    domainName: DOCS_DOMAIN_NAME,
    crossRegionReferences: true,
  });
  const cdn = new DocsCdnStack(app, 'AtmarkDocsCdn', {
    env,
    domainName: DOCS_DOMAIN_NAME,
    certificate: cdnCertificate.certificate,
    originDomainName: docs.domain.regionalDomainName,
    crossRegionReferences: true,
  });
  cdn.addStackDependency(cdnCertificate);
  return { certificate, docs, cdnCertificate, cdn };
}

/** 홈 스택 넷(`app.ts` 와 같은 배선). */
function addSiteStacks(app: cdk.App): void {
  const env = { account: ACCOUNT, region: REGION };
  const cert = new SiteCertificateStack(app, 'AtmarkSiteCertificate', { env, domainName: SITE_DOMAIN_NAME, alternativeNames: [SITE_WWW_DOMAIN_NAME], payDomainName: SITE_PAY_DOMAIN_NAME });
  if (cert.payCertificate === undefined) throw new Error('pay 인증서 없음');
  const site = new SiteStack(app, 'AtmarkSite', {
    env,
    domains: { apex: SITE_DOMAIN_NAME, www: SITE_WWW_DOMAIN_NAME, certificate: cert.certificate, pay: { domainName: SITE_PAY_DOMAIN_NAME, certificate: cert.payCertificate } },
    lambdaCode: { kind: 'stub' },
  });
  if (site.apexDomain === undefined) throw new Error('apex 없음');
  const cdnCert = new SiteCdnCertificateStack(app, 'AtmarkSiteCdnCertificate', {
    env: { account: ACCOUNT, region: 'us-east-1' },
    domainName: SITE_DOMAIN_NAME,
    alternativeNames: [SITE_WWW_DOMAIN_NAME],
    crossRegionReferences: true,
  });
  const cdn = new SiteCdnStack(app, 'AtmarkSiteCdn', { env, domainName: SITE_DOMAIN_NAME, certificate: cdnCert.certificate, originDomainName: site.apexDomain.regionalDomainName, crossRegionReferences: true });
  cdn.addStackDependency(cdnCert);
}

interface Built {
  readonly certificate: Template;
  readonly docs: Template;
  readonly cdnCertificate: Template;
  readonly cdn: Template;
  readonly cdnCertificateRegion: string;
}

let cached: Built | undefined;
function built(): Built {
  if (cached === undefined) {
    const app = new cdk.App();
    const s = addDocsStacks(app);
    cached = {
      certificate: Template.fromStack(s.certificate),
      docs: Template.fromStack(s.docs),
      cdnCertificate: Template.fromStack(s.cdnCertificate),
      cdn: Template.fromStack(s.cdn),
      cdnCertificateRegion: s.cdnCertificate.region,
    };
  }
  return cached;
}

describe('기존 스택 diff 0', () => {
  it('운영·홈 스택의 템플릿은 문서 스택을 더해도 바이트까지 같다', () => {
    const without = buildRuntimeApp();
    addSiteStacks(without.app);
    const withDocs = buildRuntimeApp();
    addSiteStacks(withDocs.app);
    addDocsStacks(withDocs.app);
    const a = without.app.synth();
    const b = withDocs.app.synth();
    const names = a.stacks.map((s) => s.stackName).sort();
    expect(names.length).toBeGreaterThanOrEqual(15);
    expect(names).toEqual(expect.arrayContaining(['AtmarkCompute', 'AtmarkSite', 'AtmarkSiteCdn', 'AtmarkIdentityCdn']));
    for (const name of names) expect(JSON.stringify(b.getStackByName(name).template), name).toBe(JSON.stringify(a.getStackByName(name).template));
    // 새로 생긴 스택은 문서 스택 넷뿐이다.
    expect(b.stacks.map((s) => s.stackName).filter((n) => !names.includes(n)).sort()).toEqual(['AtmarkDocs', 'AtmarkDocsCdn', 'AtmarkDocsCdnCertificate', 'AtmarkDocsCertificate']);
    // 문서 스택의 템플릿은 기존 스택을 가리키지 않는다(export 가져오기는 문서 스택끼리만).
    for (const docsName of ['AtmarkDocs', 'AtmarkDocsCdn', 'AtmarkDocsCertificate', 'AtmarkDocsCdnCertificate']) {
      const json = JSON.stringify(b.getStackByName(docsName).template);
      for (const m of json.matchAll(/"Fn::ImportValue":"([^":]+):/g)) expect(m[1], docsName).toMatch(/^AtmarkDocs/);
    }
  }, 240_000);

  it('app.ts 가 문서 스택 넷을 같은 id·순서로 세운다', () => {
    const source = readFileSync(new URL('../../../infra/cdk/app.ts', import.meta.url), 'utf8');
    for (const id of ['AtmarkDocsCertificate', 'AtmarkDocs', 'AtmarkDocsCdnCertificate', 'AtmarkDocsCdn']) expect(source).toContain(`'${id}'`);
    expect(source).toContain('docsCdn.addStackDependency(docsCdnCertificate)');
    expect(source).toContain('originDomainName: docs.domain.regionalDomainName');
  });
});

describe('AtmarkDocsCertificate', () => {
  it('docs.atmark.ai 하나 · DNS 검증 · 이름 atmark-docs · 조회 명령 출력', () => {
    const cert = onlyPropertiesOf(built().certificate, 'AWS::CertificateManager::Certificate');
    expect(cert['DomainName']).toBe(DOCS_DOMAIN_NAME);
    expect(cert['SubjectAlternativeNames']).toBeUndefined();
    expect(cert['ValidationMethod']).toBe('DNS');
    expect(cert['DomainValidationOptions']).toBeUndefined();
    expect(cert['Tags']).toEqual([{ Key: 'Name', Value: 'atmark-docs' }]);
    expect(DOCS_DOMAIN_NAME).toBe(DOCS_HOST);
    const outputs = built().certificate.toJSON()['Outputs'] as Record<string, { Value: unknown }>;
    expect(JSON.stringify(outputs['DocsCertificateValidationLookupCommand']?.Value)).toContain('aws acm describe-certificate --region ap-northeast-2');
  });
});

describe('AtmarkDocs — λ · 역할', () => {
  it('함수 하나 — 이름 · VPC 밖 · 환경 변수 0 · arm64 · Node 22 · 예약 동시성', () => {
    const fn = onlyPropertiesOf(built().docs, 'AWS::Lambda::Function');
    expect(fn['FunctionName']).toBe(DOCS_FUNCTION_NAME);
    expect(fn['VpcConfig']).toBeUndefined();
    expect(fn['Environment']).toBeUndefined();
    expect(fn['Architectures']).toEqual(['arm64']);
    expect(fn['Runtime']).toBe('nodejs22.x');
    expect(fn['ReservedConcurrentExecutions']).toBe(DOCS_RESERVED_CONCURRENCY);
    expect(fn['Handler']).toBe('index.handler');
  });

  it('역할 — 이름 · 관리형 정책 0 · 권한은 자기 로그 그룹 쓰기 둘뿐', () => {
    const role = onlyPropertiesOf(built().docs, 'AWS::IAM::Role');
    expect(role['RoleName']).toBe(DOCS_ROLE_NAME);
    expect(role['ManagedPolicyArns']).toBeUndefined();
    expect(JSON.stringify(role['AssumeRolePolicyDocument'])).toContain('lambda.amazonaws.com');
    expect(/^[\x20-\x7e]*$/.test(String(role['Description']))).toBe(true);
    const policies = Object.values(resourcesOf(built().docs, 'AWS::IAM::Policy'));
    expect(policies).toHaveLength(1);
    const all = (policies[0]?.Properties['PolicyDocument'] as { Statement: Record<string, unknown>[] }).Statement ?? [];
    // SES 발송 명시 Deny(ADR-0014 재검증 INFO — 발송 주체가 아닌 모든 역할)는 따로 본다.
    expect(all.find((s) => s['Sid'] === 'SesSendDenyNonSendingRole')).toMatchObject({ Effect: 'Deny', Action: 'ses:Send*', Resource: '*' });
    const statements = all.filter((s) => s['Sid'] !== 'SesSendDenyNonSendingRole');
    expect(statements).toHaveLength(1);
    expect(statements[0]?.['Action']).toEqual(['logs:CreateLogStream', 'logs:PutLogEvents']);
    expect(JSON.stringify(statements[0]?.['Resource'])).toMatch(/DocsLogs/);
    // SES(Deny 밖)·S3·KMS·Secrets·VPC 권한이 없다.
    expect(JSON.stringify(built().docs.toJSON()).replace('"ses:Send*"', '')).not.toMatch(/ses:|s3:|kms:|secretsmanager:|ec2:CreateNetworkInterface/);
  });

  it('로그 그룹 — /aws/lambda/atmark-docs · 접근 로그 /atmark/docs-access · 보존 90일', () => {
    const groups = Object.values(resourcesOf(built().docs, 'AWS::Logs::LogGroup')).map((g) => [g.Properties['LogGroupName'], g.Properties['RetentionInDays']]);
    expect(groups.sort()).toEqual([
      ['/atmark/docs-access', 90],
      [`/aws/lambda/${DOCS_FUNCTION_NAME}`, 90],
    ]);
  });

  it('스텁 코드면 배포 거부 규칙이 선다', () => {
    const rules = built().docs.toJSON()['Rules'] as Record<string, unknown> | undefined;
    expect(Object.keys(rules ?? {})).toContain('StubLambdaCodeIsNotDeployable');
  });
});

describe('AtmarkDocs — HTTP API', () => {
  it('execute-api 기본 엔드포인트 끔 · 커스텀 도메인 docs.atmark.ai 하나 · 매핑은 스테이지의 것 하나', () => {
    const api = onlyPropertiesOf(built().docs, 'AWS::ApiGatewayV2::Api');
    expect(api['Name']).toBe('atmark-docs');
    expect(api['DisableExecuteApiEndpoint']).toBe(true);
    const domain = onlyPropertiesOf(built().docs, 'AWS::ApiGatewayV2::DomainName');
    expect(domain['DomainName']).toBe(DOCS_DOMAIN_NAME);
    expect(Object.keys(resourcesOf(built().docs, 'AWS::ApiGatewayV2::ApiMapping'))).toHaveLength(1);
  });

  it('라우트 둘($default · 폰트) · 스로틀 — 합이 천장 안', () => {
    const routes = Object.values(resourcesOf(built().docs, 'AWS::ApiGatewayV2::Route')).map((r) => r.Properties['RouteKey']);
    expect(routes.sort()).toEqual(['$default', DOCS_FONT_ROUTE_KEY].sort());
    const stage = onlyPropertiesOf(built().docs, 'AWS::ApiGatewayV2::Stage');
    expect(stage['DefaultRouteSettings']).toMatchObject({ ThrottlingRateLimit: DOCS_THROTTLE.rateLimit, ThrottlingBurstLimit: DOCS_THROTTLE.burstLimit });
    expect(stage['RouteSettings']).toEqual({ [DOCS_FONT_ROUTE_KEY]: { ThrottlingRateLimit: DOCS_FONT_THROTTLE.rateLimit, ThrottlingBurstLimit: DOCS_FONT_THROTTLE.burstLimit } });
    expect(DOCS_THROTTLE.rateLimit + DOCS_FONT_THROTTLE.rateLimit).toBeLessThanOrEqual(DOCS_LAMBDA_BUCKET_CEILING.rateLimit);
    expect(DOCS_THROTTLE.burstLimit + DOCS_FONT_THROTTLE.burstLimit).toBeLessThanOrEqual(DOCS_LAMBDA_BUCKET_CEILING.burstLimit);
  });

  it('접근 로그에 요청 IP·사용자 에이전트가 없다', () => {
    const stage = onlyPropertiesOf(built().docs, 'AWS::ApiGatewayV2::Stage');
    const format = String((stage['AccessLogSettings'] as Record<string, unknown>)['Format']);
    expect(format).toContain('$context.requestId');
    expect(format).not.toMatch(/sourceIp|userAgent|identity\./);
  });
});

describe('AtmarkDocsCdnCertificate · AtmarkDocsCdn', () => {
  const distribution = (): Record<string, unknown> => onlyPropertiesOf(built().cdn, 'AWS::CloudFront::Distribution')['DistributionConfig'] as Record<string, unknown>;
  interface Behavior {
    PathPattern?: string;
    CachePolicyId?: unknown;
    OriginRequestPolicyId?: unknown;
    ResponseHeadersPolicyId?: unknown;
    AllowedMethods?: string[];
    Compress?: boolean;
    ViewerProtocolPolicy?: string;
  }
  const defaultBehavior = (): Behavior => distribution()['DefaultCacheBehavior'] as Behavior;
  const behaviors = (): Behavior[] => (distribution()['CacheBehaviors'] ?? []) as Behavior[];
  const policies = (): Record<string, Record<string, unknown>> =>
    Object.fromEntries(
      Object.entries(resourcesOf(built().cdn, 'AWS::CloudFront::CachePolicy')).map(([id, r]) => [
        String((r.Properties['CachePolicyConfig'] as Record<string, unknown>)['Name']),
        { id, ...(r.Properties['CachePolicyConfig'] as Record<string, unknown>) },
      ]),
    );

  it('인증서 — us-east-1 · docs.atmark.ai · DNS · 이름 atmark-docs-cdn', () => {
    expect(built().cdnCertificateRegion).toBe('us-east-1');
    const cert = onlyPropertiesOf(built().cdnCertificate, 'AWS::CertificateManager::Certificate');
    expect(cert['DomainName']).toBe(DOCS_DOMAIN_NAME);
    expect(cert['ValidationMethod']).toBe('DNS');
    expect(cert['Tags']).toEqual([{ Key: 'Name', Value: 'atmark-docs-cdn' }]);
  });

  it('배포 — 별칭 하나 · SNI · TLS 1.2_2021 · HTTP/2+3 · IPv6 · 가격 등급 200 · 접근 로그·WAF 없음', () => {
    const config = distribution();
    expect(config['Aliases']).toEqual([DOCS_DOMAIN_NAME]);
    const viewer = config['ViewerCertificate'] as Record<string, unknown>;
    expect(viewer['SslSupportMethod']).toBe('sni-only');
    expect(viewer['MinimumProtocolVersion']).toBe('TLSv1.2_2021');
    expect(JSON.stringify(viewer['AcmCertificateArn'])).toMatch(/DocsCdnCertificate/);
    expect(config['HttpVersion']).toBe('http2and3');
    expect(config['IPV6Enabled']).toBe(true);
    expect(config['PriceClass']).toBe('PriceClass_200');
    expect(config['Logging']).toBeUndefined();
    expect(config['WebACLId']).toBeUndefined();
  });

  it('오리진 하나 = AtmarkDocs 커스텀 도메인의 리전 이름(import) · HTTPS 만', () => {
    const origins = distribution()['Origins'] as Record<string, unknown>[];
    expect(origins).toHaveLength(1);
    expect(JSON.stringify(origins[0]?.['DomainName'])).toMatch(/Fn::ImportValue.*AtmarkDocs:.*DocsDomainName.*RegionalDomainName/);
    expect(origins[0]?.['CustomOriginConfig']).toMatchObject({ OriginProtocolPolicy: 'https-only', OriginSSLProtocols: ['TLSv1.2'] });
  });

  it('캐시 정책 셋 — 자산(키 Host+경로, 1년까지) · 페이지(키 Host+경로, 쿼리 없음, 하루까지 — 실제로는 오리진 5분) · 검색(키에 q 만) · 쿠키 없음 · 압축 정규화', () => {
    const p = policies();
    expect(Object.keys(p).sort()).toEqual([DOCS_CDN_ASSET_CACHE_POLICY_NAME, DOCS_CDN_PAGE_CACHE_POLICY_NAME, DOCS_CDN_SEARCH_CACHE_POLICY_NAME].sort());
    const asset = p[DOCS_CDN_ASSET_CACHE_POLICY_NAME] ?? {};
    const page = p[DOCS_CDN_PAGE_CACHE_POLICY_NAME] ?? {};
    const search = p[DOCS_CDN_SEARCH_CACHE_POLICY_NAME] ?? {};
    expect(asset['MaxTTL']).toBe(31_536_000);
    expect(page['MaxTTL']).toBe(86_400);
    expect(search['MaxTTL']).toBe(86_400);
    for (const c of [asset, page, search]) {
      expect(c['MinTTL']).toBe(0);
      expect(c['DefaultTTL']).toBe(0);
      const key = c['ParametersInCacheKeyAndForwardedToOrigin'] as Record<string, Record<string, unknown>>;
      expect(key['HeadersConfig']).toEqual({ HeaderBehavior: 'whitelist', Headers: ['Host'] });
      expect(key['CookiesConfig']).toEqual({ CookieBehavior: 'none' });
      expect(key['EnableAcceptEncodingGzip']).toBe(true);
    }
    expect((asset['ParametersInCacheKeyAndForwardedToOrigin'] as Record<string, unknown>)['QueryStringsConfig']).toEqual({ QueryStringBehavior: 'none' });
    // 보안 검토 L7 — 페이지는 쿼리를 키·오리진에서 버린다(쿼리로 캐시를 우회해 λ 를 두드릴 수 없다). 검색만 q 하나.
    expect((page['ParametersInCacheKeyAndForwardedToOrigin'] as Record<string, unknown>)['QueryStringsConfig']).toEqual({ QueryStringBehavior: 'none' });
    expect((search['ParametersInCacheKeyAndForwardedToOrigin'] as Record<string, unknown>)['QueryStringsConfig']).toEqual({ QueryStringBehavior: 'whitelist', QueryStrings: ['q'] });
    expect(defaultBehavior().CachePolicyId).toEqual({ Ref: page['id'] });
    for (const b of behaviors()) {
      const isSearch = (DOCS_CDN_SEARCH_PATH_PATTERNS as readonly string[]).includes(b.PathPattern ?? '');
      expect(b.CachePolicyId, b.PathPattern).toEqual({ Ref: isSearch ? search['id'] : asset['id'] });
    }
  });

  it('동작 — GET/HEAD 만 · HTTPS 로 · 엣지 압축 · 오리진 요청 정책·응답 헤더 정책·엣지 함수 0', () => {
    expect(behaviors().map((b) => b.PathPattern)).toEqual([...DOCS_CDN_SEARCH_PATH_PATTERNS, ...DOCS_CDN_ASSET_PATH_PATTERNS]);
    expect(DOCS_CDN_SEARCH_PATH_PATTERNS).toEqual(['/search', '/en/search']);
    for (const b of [defaultBehavior(), ...behaviors()]) {
      expect([...(b.AllowedMethods ?? [])].sort(), b.PathPattern ?? 'default').toEqual(['GET', 'HEAD']);
      expect(b.ViewerProtocolPolicy).toBe('redirect-to-https');
      expect(b.Compress).toBe(true);
      expect(b.OriginRequestPolicyId).toBeUndefined();
      expect(b.ResponseHeadersPolicyId).toBeUndefined();
    }
    for (const type of ['AWS::CloudFront::ResponseHeadersPolicy', 'AWS::CloudFront::Function', 'AWS::CloudFront::OriginRequestPolicy']) {
      expect(Object.keys(resourcesOf(built().cdn, type)), type).toHaveLength(0);
    }
  });

  it('자산 패턴이 핸들러와 맞다 — 걸리는 경로는 오리진이 Cache-Control 을 싣고, 페이지 경로는 걸리지 않는다', () => {
    const regex = (pattern: string): RegExp => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    const cachedBy = (path: string): string | undefined => DOCS_CDN_ASSET_PATH_PATTERNS.find((p) => regex(p).test(path));
    const get = (path: string): ReturnType<typeof handleDocsRequest> => handleDocsRequest({ rawPath: path, requestContext: { http: { method: 'GET' } } });
    const home = get('/').body;
    const searchPath = /data-index="([^"]+)"/.exec(home)?.[1] ?? '';
    const fontPath = /url\((\/_fonts\/[^)]+)\)/.exec(home)?.[1] ?? '';
    const imgPath = /src="(\/_img\/[^"]+)"/.exec(get('/get-started/quickstart').body + get('/agents/create').body + home)?.[1];
    const assets = [searchPath, fontPath, '/favicon.svg', '/favicon.ico', '/robots.txt', '/sitemap.xml', '/llms.txt', '/llms-full.txt', ...(imgPath === undefined ? [] : [imgPath])];
    for (const path of assets) {
      expect(cachedBy(path), path).toBeDefined();
      const r = get(path);
      expect(r.statusCode, path).toBe(200);
      expect(r.headers['cache-control'], path).toMatch(/^public, max-age=\d+/);
    }
    for (const path of ['/', '/en', '/get-started/quickstart', '/get-started/quickstart.md', '/search', '/nope']) expect(cachedBy(path), path).toBeUndefined();
  });

  it('출력 — CNAME 값(배포 도메인)과 배포 ID', () => {
    const outputs = built().cdn.toJSON()['Outputs'] as Record<string, { Value: unknown }>;
    expect(JSON.stringify(outputs['DocsDistributionDomainName']?.Value)).toMatch(/DocsDistribution.*DomainName/);
    expect(outputs).toHaveProperty('DocsDistributionId');
    const docsOutputs = built().docs.toJSON()['Outputs'] as Record<string, { Value: unknown }>;
    expect(JSON.stringify(docsOutputs['DocsRegionalDomainName']?.Value)).toMatch(/DocsDomainName.*RegionalDomainName/);
  });
});
