/**
 * `AtmarkSiteCertificate` · `AtmarkSite` — 합성된 템플릿에 대한 단언. **배포하지 않는다.**
 *
 * 홈 Lambda 는 권한이 **로그 쓰기뿐**이어야 한다(SES·S3·Secrets Manager·KMS·VPC 0). 운영 스택과 참조를 나누지 않고,
 * DB 연결 예산(`compute-stack.test.ts` — AtmarkCompute 템플릿의 함수만 센다)에 들어가지 않는다는 것도 여기서 고정한다.
 */

import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

import {
  PADDLE_CLIENT_TOKEN_CONTEXT_KEY,
  PADDLE_CLIENT_TOKENS,
  SITE_DOMAIN_NAME,
  SITE_FONT_ROUTE_KEY,
  SITE_FONT_THROTTLE,
  SITE_LAMBDA_BUCKET_CEILING,
  SITE_FUNCTION_NAME,
  SITE_PAY_DOMAIN_NAME,
  SITE_RESERVED_CONCURRENCY,
  SITE_ROLE_NAME,
  SITE_THROTTLE,
  SITE_WWW_DOMAIN_NAME,
  SiteCertificateStack,
  SiteStack,
} from '../../../infra/cdk/stacks/site-stack';
import type { LambdaCodeSource } from '../../../infra/cdk/stacks/lambda-code';
import { PADDLE_ENVIRONMENT_DEFAULT, PAY_HOST } from '../../../src/billing/constants';
import { SITE_PAY_ENV } from '../../../src/runtime/handlers/site';
import { SITE_HOST, SITE_WWW_HOST } from '../../../src/site/constants';
import { actionsOf, ACCOUNT, onlyPropertiesOf, REGION, resourcesOf, runtimeTemplates, type IamStatement, type Resources } from './runtime-app';

interface Built {
  readonly site: Template;
  readonly certificate: Template;
}

function buildSite(options: { domains?: boolean; lambdaCode?: LambdaCodeSource; context?: Record<string, string> } = {}): Built {
  const app = new cdk.App(options.context === undefined ? {} : { context: options.context });
  const env = { account: ACCOUNT, region: REGION };
  // `infra/cdk/app.ts` 와 같은 배선 — pay.atmark.ai 는 별도 인증서(WP-2).
  const certificate = new SiteCertificateStack(app, 'AtmarkSiteCertificate', {
    env,
    domainName: SITE_DOMAIN_NAME,
    alternativeNames: [SITE_WWW_DOMAIN_NAME],
    payDomainName: SITE_PAY_DOMAIN_NAME,
  });
  const payCertificate = certificate.payCertificate;
  if (payCertificate === undefined) throw new Error('pay 인증서가 없다');
  const site = new SiteStack(app, 'AtmarkSite', {
    env,
    ...(options.domains === false
      ? {}
      : {
          domains: {
            apex: SITE_DOMAIN_NAME,
            www: SITE_WWW_DOMAIN_NAME,
            certificate: certificate.certificate,
            pay: { domainName: SITE_PAY_DOMAIN_NAME, certificate: payCertificate },
          },
        }),
    lambdaCode: options.lambdaCode ?? { kind: 'stub' },
  });
  return { site: Template.fromStack(site), certificate: Template.fromStack(certificate) };
}

let cached: Built | undefined;
const templates = (): Built => (cached ??= buildSite());

/** 허용 문장 — 비발송 역할의 SES 발송 Deny(`ses-send-deny.ts`, ADR-0014 재검증 INFO)는 따로 단언하고 여기서는 뺀다. */
function allStatements(template: Template): IamStatement[] {
  return Object.values(resourcesOf(template, 'AWS::IAM::Policy'))
    .flatMap((p) => (p.Properties['PolicyDocument'] as { Statement: IamStatement[] }).Statement)
    .filter((statement) => statement.Sid !== 'SesSendDenyNonSendingRole');
}

function sendDeny(template: Template): IamStatement | undefined {
  return Object.values(resourcesOf(template, 'AWS::IAM::Policy'))
    .flatMap((p) => (p.Properties['PolicyDocument'] as { Statement: IamStatement[] }).Statement)
    .find((statement) => statement.Sid === 'SesSendDenyNonSendingRole');
}

describe('AtmarkSite — Lambda atmark-site', () => {
  it('Node 22 · arm64 · index.handler · 128MB · 예약 동시성 2 · VPC 밖 · 환경은 결제 페이지 설정뿐(스위치 꺼짐 · 샌드박스 · 토큰 없으면 싣지 않음)', () => {
    const fn = onlyPropertiesOf(templates().site, 'AWS::Lambda::Function');
    expect(fn['FunctionName']).toBe(SITE_FUNCTION_NAME);
    expect(fn['Runtime']).toBe('nodejs22.x');
    expect(fn['Architectures']).toEqual(['arm64']);
    expect(fn['Handler']).toBe('index.handler');
    expect(fn['MemorySize']).toBe(128);
    expect(fn['ReservedConcurrentExecutions']).toBe(SITE_RESERVED_CONCURRENCY);
    // 콜드 스타트 대비 30 (2·10 에서 폰트 503 — site-stack 주석). 무한정 넓히지 않는다 — 계정 할당량 400 보호.
    expect(SITE_RESERVED_CONCURRENCY).toBeLessThanOrEqual(30);
    expect(fn['VpcConfig']).toBeUndefined();
    const variables = (fn['Environment'] as { Variables: Record<string, string> }).Variables;
    // 결제 스위치 기본 끔(fail-closed → pay 404) · Paddle 환경은 코드 상수 · 클라이언트 토큰은 커밋된 공개값(샌드박스 `test_…`)을 싣는다.
    const token = PADDLE_CLIENT_TOKENS[PADDLE_ENVIRONMENT_DEFAULT];
    expect(token).toMatch(/^test_[A-Za-z0-9]{10,64}$/);
    expect(variables).toEqual({
      [SITE_PAY_ENV.billingEnabled]: 'false',
      [SITE_PAY_ENV.paddleEnvironment]: PADDLE_ENVIRONMENT_DEFAULT,
      [SITE_PAY_ENV.paddleClientToken]: token,
    });
    expect(PADDLE_CLIENT_TOKENS.production).toMatch(/^live_[A-Za-z0-9]{10,64}$/);
    expect(fn['Timeout']).toBeLessThan(30);
  });

  it('로그 그룹 /aws/lambda/atmark-site 보존 90일 · 접근 로그 /atmark/site-access 보존 90일', () => {
    const groups = Object.values(resourcesOf(templates().site, 'AWS::Logs::LogGroup')).map((g) => g.Properties);
    const byName = new Map(groups.map((g) => [g['LogGroupName'], g['RetentionInDays']]));
    expect(byName.get(`/aws/lambda/${SITE_FUNCTION_NAME}`)).toBe(90);
    expect(byName.get('/atmark/site-access')).toBe(90);
  });

  it('DB 연결 예산 밖 — AtmarkCompute 템플릿에 없고(예산 테스트가 세는 대상), DB·비밀 환경이 없다', () => {
    const compute = runtimeTemplates().compute.findResources('AWS::Lambda::Function') as Resources;
    const names = Object.values(compute).map((f) => f.Properties['FunctionName']);
    expect(names).not.toContain(SITE_FUNCTION_NAME);
    expect(JSON.stringify(templates().site.toJSON())).not.toMatch(/ATMARK_DB_|PGSSLMODE|SecretArn|secretsmanager/i);
  });
});

describe('AtmarkSite — IAM 최소 권한(로그만)', () => {
  it('역할 atmark-runtime-site 하나 · 관리형 정책 없음 · lambda 만 맡는다', () => {
    const role = onlyPropertiesOf(templates().site, 'AWS::IAM::Role');
    expect(role['RoleName']).toBe(SITE_ROLE_NAME);
    expect(role['ManagedPolicyArns']).toBeUndefined();
    expect(JSON.stringify(role['AssumeRolePolicyDocument'])).toContain('lambda.amazonaws.com');
    expect(role['Policies']).toBeUndefined();
  });

  it('허용 문장은 자기 로그 그룹의 CreateLogStream·PutLogEvents 뿐 — SES·S3·Secrets·KMS·그 밖 0, 와일드카드 0', () => {
    // 그리고 SES 발송 명시 Deny 하나(ADR-0014 재검증 INFO — 발송 주체가 아닌 모든 역할).
    expect(sendDeny(templates().site)).toMatchObject({ Effect: 'Deny', Action: 'ses:Send*', Resource: '*' });
    const statements = allStatements(templates().site);
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      expect(statement.Effect).toBe('Allow');
      expect(actionsOf(statement).sort()).toEqual(['logs:CreateLogStream', 'logs:PutLogEvents']);
      const resourcesJson = JSON.stringify(statement.Resource);
      expect(resourcesJson).not.toMatch(/"\*"/);
      expect(resourcesJson).toContain('SiteLogs');
    }
    const actions = statements.flatMap(actionsOf);
    for (const forbidden of [/^ses:/i, /^s3:/i, /^secretsmanager:/i, /^kms:/i, /^ec2:/i, /^rds/i, /^sqs:/i, /^sns:/i, /^iam:/i, /^sts:/i, /^\*$/]) {
      expect(actions.filter((a) => forbidden.test(a)), String(forbidden)).toEqual([]);
    }
  });

  it('템플릿에 VPC·보안 그룹·비밀·버킷·키·큐가 없다(운영 스택과 공유하는 것이 없다)', () => {
    const types = Object.values(templates().site.toJSON()['Resources'] as Record<string, { Type: string }>).map((r) => r.Type);
    for (const type of types) {
      expect(type, type).not.toMatch(/EC2::|SecretsManager|S3::|KMS::|SQS::|SNS::|RDS::|SES::/);
    }
    // 교차 스택 참조는 인증서 하나뿐이다(같은 리전 — Export/ImportValue).
    const imports = JSON.stringify(templates().site.toJSON()).match(/Fn::ImportValue":"[^"]+/g) ?? [];
    expect(imports.length).toBeGreaterThan(0);
    for (const value of imports) expect(value).toMatch(/AtmarkSiteCertificate/);
  });
});

describe('AtmarkSite — HTTP API atmark-site', () => {
  it('execute-api 기본 엔드포인트 비활성 · 라우트는 $default + 폰트(스로틀 분리용) 둘 — 통합은 같은 λ 하나(payload v2)', () => {
    const api = onlyPropertiesOf(templates().site, 'AWS::ApiGatewayV2::Api');
    expect(api['Name']).toBe('atmark-site');
    expect(api['DisableExecuteApiEndpoint']).toBe(true);
    const routes = Object.values(resourcesOf(templates().site, 'AWS::ApiGatewayV2::Route')).map((r) => r.Properties);
    expect(routes.map((r) => r['RouteKey']).sort()).toEqual(['$default', SITE_FONT_ROUTE_KEY]);
    expect(SITE_FONT_ROUTE_KEY).toBe('GET /_fonts/{proxy+}');
    // 두 라우트가 같은 통합(= 같은 λ)을 가리킨다 — 따로 둔 이유는 스로틀 버킷뿐이다.
    const integration = onlyPropertiesOf(templates().site, 'AWS::ApiGatewayV2::Integration');
    expect(integration['PayloadFormatVersion']).toBe('2.0');
    expect(new Set(routes.map((r) => JSON.stringify(r['Target']))).size).toBe(1);
  });

  it('폰트 라우트만 별도 버킷(40 / 80) · $default 버킷(20 / 40)은 그대로 · 스테이지가 라우트에 의존', () => {
    const [stageId, stage] = Object.entries(resourcesOf(templates().site, 'AWS::ApiGatewayV2::Stage'))[0] ?? [];
    expect(stage?.Properties['DefaultRouteSettings']).toMatchObject({ ThrottlingRateLimit: 20, ThrottlingBurstLimit: 40 });
    expect(stage?.Properties['RouteSettings']).toEqual({
      'GET /_fonts/{proxy+}': { ThrottlingRateLimit: 40, ThrottlingBurstLimit: 80 },
    });
    expect(SITE_FONT_THROTTLE).toEqual({ rateLimit: 40, burstLimit: 80 });
    // 폰트 버킷은 페이지 버킷을 대신하지 않는다 — 페이지(`$default`)는 예전 값 그대로.
    expect(SITE_THROTTLE).toEqual({ rateLimit: 20, burstLimit: 40 });
    const fontRouteId = Object.entries(resourcesOf(templates().site, 'AWS::ApiGatewayV2::Route')).find(
      ([, r]) => r.Properties['RouteKey'] === SITE_FONT_ROUTE_KEY,
    )?.[0];
    expect(fontRouteId).toBeDefined();
    const deps = (templates().site.toJSON()['Resources'] as Record<string, { DependsOn?: string[] }>)[String(stageId)]?.DependsOn ?? [];
    expect(deps).toContain(fontRouteId);
  });

  it('사이트 λ 로 들어오는 버킷의 합이 상한 안이다(L-2) — 라우트를 더해 문을 조용히 넓히지 않게', () => {
    const stage = onlyPropertiesOf(templates().site, 'AWS::ApiGatewayV2::Stage');
    const buckets = [
      stage['DefaultRouteSettings'] as { ThrottlingRateLimit: number; ThrottlingBurstLimit: number },
      ...Object.values((stage['RouteSettings'] ?? {}) as Record<string, { ThrottlingRateLimit: number; ThrottlingBurstLimit: number }>),
    ];
    const rate = buckets.reduce((sum, b) => sum + b.ThrottlingRateLimit, 0);
    const burst = buckets.reduce((sum, b) => sum + b.ThrottlingBurstLimit, 0);
    expect(rate).toBeLessThanOrEqual(SITE_LAMBDA_BUCKET_CEILING.rateLimit);
    expect(burst).toBeLessThanOrEqual(SITE_LAMBDA_BUCKET_CEILING.burstLimit);
    expect(SITE_LAMBDA_BUCKET_CEILING).toEqual({ rateLimit: 60, burstLimit: 120 });
    // 모든 라우트가 이 스테이지 하나로 들어오고(API 하나), 그 통합은 사이트 λ 하나다 — 위 합이 λ 로 들어오는 전부다.
    expect(Object.keys(resourcesOf(templates().site, 'AWS::ApiGatewayV2::Stage'))).toHaveLength(1);
    expect(Object.keys(resourcesOf(templates().site, 'AWS::ApiGatewayV2::Integration'))).toHaveLength(1);
  });

  it('스테이지 $default · 스로틀 20/40 · 접근 로그에 요청 IP 없음', () => {
    const stage = onlyPropertiesOf(templates().site, 'AWS::ApiGatewayV2::Stage');
    expect(stage['StageName']).toBe('$default');
    expect(stage['AutoDeploy']).toBe(true);
    expect(stage['DefaultRouteSettings']).toMatchObject({ ThrottlingRateLimit: 20, ThrottlingBurstLimit: 40 });
    expect(SITE_THROTTLE).toEqual({ rateLimit: 20, burstLimit: 40 });
    const format = String((stage['AccessLogSettings'] as { Format: string }).Format);
    expect(format).toContain('$context.path');
    expect(format).toContain('$context.domainName');
    expect(format).not.toMatch(/sourceIp|userAgent|querystring/i);
  });

  it('커스텀 도메인 atmark.ai · www.atmark.ai(같은 인증서) · pay.atmark.ai(별도 인증서) — 셋 다 $default 스테이지에 매핑', () => {
    const domains = Object.values(resourcesOf(templates().site, 'AWS::ApiGatewayV2::DomainName')).map((d) => d.Properties);
    expect(domains.map((d) => d['DomainName']).sort()).toEqual([SITE_DOMAIN_NAME, SITE_PAY_DOMAIN_NAME, SITE_WWW_DOMAIN_NAME].sort());
    const certOf = (name: string): string =>
      JSON.stringify((domains.find((d) => d['DomainName'] === name)?.['DomainNameConfigurations'] as { CertificateArn: unknown }[])[0]?.CertificateArn);
    expect(certOf(SITE_DOMAIN_NAME)).toBe(certOf(SITE_WWW_DOMAIN_NAME));
    expect(certOf(SITE_DOMAIN_NAME)).toMatch(/AtmarkSiteCertificate.*SiteCertificate/);
    expect(certOf(SITE_PAY_DOMAIN_NAME)).not.toBe(certOf(SITE_DOMAIN_NAME));
    expect(certOf(SITE_PAY_DOMAIN_NAME)).toMatch(/PaySiteCertificate/);
    const mappings = Object.values(resourcesOf(templates().site, 'AWS::ApiGatewayV2::ApiMapping')).map((m) => m.Properties);
    expect(mappings).toHaveLength(3);
    for (const mapping of mappings) expect(mapping['Stage']).toBeDefined();
    // 한 함수·한 API — pay 는 Lambda 가 Host 로 가른다(src/site/http.ts).
    expect(Object.keys(resourcesOf(templates().site, 'AWS::Lambda::Function'))).toHaveLength(1);
    expect(SITE_PAY_DOMAIN_NAME).toBe(PAY_HOST);
  });

  it('출력 — SiteApexCnameTarget · SiteWwwCnameTarget(각 도메인의 리전 도메인 이름) · SiteUrl', () => {
    const outputs = templates().site.toJSON()['Outputs'] as Record<string, { Value: unknown }>;
    expect(JSON.stringify(outputs['SiteApexCnameTarget']?.Value)).toMatch(/SiteApexDomainName.*RegionalDomainName/);
    expect(JSON.stringify(outputs['SiteWwwCnameTarget']?.Value)).toMatch(/SiteWwwDomainName.*RegionalDomainName/);
    expect(JSON.stringify(outputs['SitePayCnameTarget']?.Value)).toMatch(/SitePayDomainName.*RegionalDomainName/);
    expect(outputs['SiteUrl']?.Value).toBe(`https://${SITE_DOMAIN_NAME}`);
  });

  it('도메인이 없으면 기본 엔드포인트를 쓰고 CNAME 출력이 없다', () => {
    const { site } = buildSite({ domains: false });
    expect(onlyPropertiesOf(site, 'AWS::ApiGatewayV2::Api')['DisableExecuteApiEndpoint']).toBe(false);
    expect(Object.keys(resourcesOf(site, 'AWS::ApiGatewayV2::DomainName'))).toHaveLength(0);
    const outputs = site.toJSON()['Outputs'] as Record<string, unknown>;
    expect(outputs).not.toHaveProperty('SiteApexCnameTarget');
    expect(outputs).not.toHaveProperty('SiteWwwCnameTarget');
  });

  it('도메인 상수는 런타임(src/site/constants.ts)과 같다 — www 리다이렉트가 보는 호스트', () => {
    expect(SITE_DOMAIN_NAME).toBe(SITE_HOST);
    expect(SITE_WWW_DOMAIN_NAME).toBe(SITE_WWW_HOST);
  });
});

describe('AtmarkSiteCertificate', () => {
  const certificateNamed = (domainName: string): Record<string, unknown> => {
    const found = Object.values(resourcesOf(templates().certificate, 'AWS::CertificateManager::Certificate')).filter((c) => c.Properties['DomainName'] === domainName);
    expect(found, domainName).toHaveLength(1);
    return found[0]?.Properties ?? {};
  };

  it('인증서 둘 — atmark.ai(+www)와 pay.atmark.ai 는 따로(SAN 추가로 기존 인증서를 교체하지 않는다)', () => {
    expect(Object.keys(resourcesOf(templates().certificate, 'AWS::CertificateManager::Certificate'))).toHaveLength(2);
    const pay = certificateNamed(SITE_PAY_DOMAIN_NAME);
    expect(pay['SubjectAlternativeNames']).toBeUndefined();
    expect(pay['ValidationMethod']).toBe('DNS');
    expect(pay['DomainValidationOptions']).toBeUndefined();
    const outputs = templates().certificate.toJSON()['Outputs'] as Record<string, { Value: unknown }>;
    expect(outputs).toHaveProperty('PaySiteCertificateArn');
    expect(JSON.stringify(outputs['PaySiteCertificateValidationLookupCommand']?.Value)).toContain('DomainValidationOptions[].ResourceRecord');
    const certs = templates().certificate.findResources('AWS::CertificateManager::Certificate') as Record<string, unknown>;
    // 기존 인증서의 논리 ID 가 그대로다(교체 없음).
    expect(Object.keys(certs).some((id) => id.startsWith('SiteCertificate'))).toBe(true);
  });

  it('atmark.ai + www.atmark.ai · DNS 검증 · 검증 CNAME 조회 명령 출력', () => {
    const cert = certificateNamed(SITE_DOMAIN_NAME);
    expect(cert['DomainName']).toBe(SITE_DOMAIN_NAME);
    expect(cert['SubjectAlternativeNames']).toEqual([SITE_WWW_DOMAIN_NAME]);
    expect(cert['ValidationMethod']).toBe('DNS');
    expect(cert['DomainValidationOptions']).toBeUndefined(); // Route 53 없음 — 사람이 Cloudflare 에 넣는다
    const outputs = templates().certificate.toJSON()['Outputs'] as Record<string, { Value: unknown }>;
    const command = JSON.stringify(outputs['SiteCertificateValidationLookupCommand']?.Value);
    expect(command).toContain('aws acm describe-certificate --region ap-northeast-2');
    expect(command).toContain('DomainValidationOptions[].ResourceRecord');
    expect(outputs).toHaveProperty('SiteCertificateArn');
  });
});

describe('AtmarkSite — 결제 페이지 스위치(WP-2)', () => {
  it('컨텍스트 atmark:billingEnabled=true · 클라이언트 토큰 컨텍스트면 함수 환경에 켜짐·토큰이 실린다 — 비밀·권한은 늘지 않는다', () => {
    const token = 'test_0123456789abcdef0123456789';
    const { site } = buildSite({ context: { 'atmark:billingEnabled': 'true', [PADDLE_CLIENT_TOKEN_CONTEXT_KEY]: token } });
    const fn = onlyPropertiesOf(site, 'AWS::Lambda::Function');
    expect((fn['Environment'] as { Variables: Record<string, string> }).Variables).toEqual({
      [SITE_PAY_ENV.billingEnabled]: 'true',
      [SITE_PAY_ENV.paddleEnvironment]: PADDLE_ENVIRONMENT_DEFAULT,
      [SITE_PAY_ENV.paddleClientToken]: token,
    });
    const actions = allStatements(site).flatMap(actionsOf).sort();
    expect([...new Set(actions)]).toEqual(['logs:CreateLogStream', 'logs:PutLogEvents']);
  });
});

describe('AtmarkSite — 코드 출처', () => {
  it('스텁 코드는 배포 거부 규칙이 붙는다', () => {
    const rules = templates().site.toJSON()['Rules'] as Record<string, unknown>;
    expect(rules).toHaveProperty('StubLambdaCodeIsNotDeployable');
  });

  it('운영 synth 는 dist/lambda/site/index.js 가 없으면 실패한다', () => {
    expect(() => buildSite({ lambdaCode: { kind: 'assets', root: '/nonexistent/atmark/dist/lambda' } })).toThrow(/pnpm build:lambda/);
  });
});
