/**
 * 서명 Lambda(`atmark-passport-signer`)의 IAM·배선 — 합성된 템플릿에 대한 단언(계약 §3 · 계획 §3.5 AC-e2). **배포하지 않는다.**
 *
 * 주장:
 *   ① 서명 역할의 액션은 정확히 넷 — 자기 DB 비밀·에이전트 키 envelope 읽기(GetSecretValue) · envelope 복호(kms:Decrypt) ·
 *      identity 버킷 `agents/*` PutObject · identity 배포 CreateInvalidation. **SES 0 · 다른 비밀 0 · S3 삭제 0.**
 *   ② identity 버킷에 쓰는 역할·배포를 무효화하는 역할은 서명 역할 하나다.
 *   ③ 예약 동시성 1 · 1분 스케줄 · 공통 환경(앱 DB 비밀·메일 버킷·승인 키) 없음.
 *   ④ 데이터 스택에 `atmark/db/passport-signer` 자리 비밀(RETAIN) · migrate 만 그 비밀에 쓴다.
 *   ⑤ `id.atmark.ai` — 기본 동작 CORS · `/v1/identity/*` 는 api 오리진(HTTPS)으로 · **캐시 키는 경로 하나**(헤더·쿠키·쿼리 없음,
 *      TTL 0~300 · 오리진 요청 정책 없음 — `Host` 를 넘기지 않는다, 2026-09-24 검증).
 *   ⑥ CMK 키 정책 — Secrets Manager 를 거치지 않은 `kms:Decrypt`(DEK 직접 복호)는 서명 역할 말고 전부 **Deny**(2026-09-24 검증).
 *      관리 역할·운영자의 Secrets Manager 경유 Decrypt(CreateSecret) · GenerateDataKey · 키 관리(루트)는 막지 않는다.
 */

import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

import { PASSPORT_SIGNER_ROLE_NAME, RESERVED_CONCURRENCY, SCHEDULES } from '../../../infra/cdk/stacks/compute-stack';
import { DB_PASSPORT_SIGNER_SECRET_NAME } from '../../../infra/cdk/stacks/data-stack';
import { IDENTITY_API_MAX_TTL_SECONDS, IDENTITY_API_PATH_PATTERN } from '../../../infra/cdk/stacks/identity-cdn-stack';
import { DENY_DIRECT_DECRYPT_SID, PassportStack } from '../../../infra/cdk/stacks/passport-stack';
import {
  ACCOUNT,
  actionsOf,
  readsSsmSecret,
  REGION,
  runtimeStackTemplate,
  runtimeTemplates,
  statementsByRole,
  writesSsmSecret,
  type IamStatement,
} from './runtime-app';

interface FunctionProps {
  readonly FunctionName: string;
  readonly Role: { 'Fn::GetAtt': [string, string] };
  readonly ReservedConcurrentExecutions?: number;
  readonly Environment: { Variables: Record<string, unknown> };
}

function signerFunction(): FunctionProps {
  const functions = runtimeTemplates().compute.findResources('AWS::Lambda::Function') as Record<string, { Properties: FunctionProps }>;
  const found = Object.values(functions).find((fn) => fn.Properties.FunctionName === 'atmark-passport-signer');
  if (found === undefined) throw new Error('atmark-passport-signer 가 없다');
  return found.Properties;
}

function signerStatements(): IamStatement[] {
  return statementsByRole(runtimeTemplates().compute).get(signerFunction().Role['Fn::GetAtt'][0]) ?? [];
}

describe('서명 역할 — 최소 권한 (계약 §3)', () => {
  it('역할 이름 · 액션은 정확히 다섯 — SES 0 (자기 DB 비밀은 SSM — 2026-10-12)', () => {
    const roles = runtimeTemplates().compute.findResources('AWS::IAM::Role') as Record<string, { Properties: { RoleName?: string } }>;
    expect(roles[signerFunction().Role['Fn::GetAtt'][0]]?.Properties.RoleName).toBe(PASSPORT_SIGNER_ROLE_NAME);
    const actions = [...new Set(signerStatements().flatMap(actionsOf))].sort();
    expect(actions).toEqual(['cloudfront:CreateInvalidation', 'kms:Decrypt', 's3:PutObject', 'secretsmanager:GetSecretValue', 'ssm:GetParameter']);
    for (const action of actions) expect(action).not.toMatch(/^(ses|sesv2):|^\*$|Delete|PutSecretValue|CreateSecret/);
  });

  it('읽는 비밀은 자기 DB 비밀과 에이전트 키 envelope 접두사 둘뿐이다(앱·소유자·admin DB · 로그인 키 · 승인·웹훅 키 없음)', () => {
    const reads = signerStatements().filter((s) => actionsOf(s).includes('secretsmanager:GetSecretValue'));
    const refs = reads.flatMap((s) => (Array.isArray(s.Resource) ? s.Resource : [s.Resource])).map((r) => JSON.stringify(r));
    expect(refs).toHaveLength(1);
    expect(refs.join(' ')).toContain('secret:atmark/agent-keypairs/*');
    const params = signerStatements().filter((s) => actionsOf(s).includes('ssm:GetParameter'));
    expect(params).toHaveLength(1);
    expect(readsSsmSecret(params[0] as IamStatement, DB_PASSPORT_SIGNER_SECRET_NAME)).toBe(true);
    expect(params.flatMap((s) => (Array.isArray(s.Resource) ? s.Resource : [s.Resource]))).toHaveLength(1);
    expect(refs.join(' ')).not.toMatch(/DbAppSecret|DbOwnerSecret|DbAdminSecret|DbLoginMailerSecret|OwnerLoginKeys|ApprovalLinkKeys|WebhookSecretKeys|MasterSecret/);
  });

  it('PutObject 는 identity 버킷의 agents/* 하나 · 무효화는 identity 배포 하나', () => {
    const puts = signerStatements().filter((s) => actionsOf(s).includes('s3:PutObject'));
    expect(puts).toHaveLength(1);
    expect(JSON.stringify(puts[0]?.Resource)).toMatch(/DidDocumentBucket/);
    expect(JSON.stringify(puts[0]?.Resource)).toContain('/agents/*');
    const invalidations = signerStatements().filter((s) => actionsOf(s).includes('cloudfront:CreateInvalidation'));
    expect(invalidations).toHaveLength(1);
    expect(JSON.stringify(invalidations[0]?.Resource)).toMatch(/IdentityDistribution/);
  });

  it('identity 버킷에 쓰는 역할 · 배포를 무효화하는 역할은 서명 역할 하나다', () => {
    const signerRole = signerFunction().Role['Fn::GetAtt'][0];
    const writers: string[] = [];
    const invalidators: string[] = [];
    for (const [role, statements] of statementsByRole(runtimeTemplates().compute)) {
      for (const statement of statements) {
        const resource = JSON.stringify(statement.Resource);
        if (actionsOf(statement).some((a) => a.startsWith('s3:')) && /DidDocumentBucket/.test(resource)) writers.push(role);
        if (actionsOf(statement).some((a) => a.startsWith('cloudfront:'))) invalidators.push(role);
      }
    }
    expect(writers).toEqual([signerRole]);
    expect(invalidators).toEqual([signerRole]);
  });
});

describe('서명 Lambda — 동시성 · 스케줄 · 환경', () => {
  it('예약 동시성 1 · 1분 스케줄', () => {
    expect(signerFunction().ReservedConcurrentExecutions).toBe(1);
    expect(RESERVED_CONCURRENCY['passport-signer']).toBe(1);
    expect(SCHEDULES.find((s) => s.handler === 'passport-signer')?.minutes).toBe(1);
  });

  it('환경은 자기 것만 — 앱 DB 비밀·메일 버킷·승인·웹훅 키·로그인 키 없음 · CMK·버킷·배포 ID 있음', () => {
    const variables = Object.keys(signerFunction().Environment.Variables).sort();
    expect(variables).toEqual(
      [
        'ATMARK_DB_PASSPORT_SIGNER_SECRET_ARN',
        'ATMARK_ENV',
        'ATMARK_IDENTITY_BUCKET',
        'ATMARK_IDENTITY_DISTRIBUTION_ID',
        'ATMARK_PASSPORT_KMS_KEY_ID',
        'NODE_EXTRA_CA_CERTS',
        'PGSSLMODE',
      ].sort(),
    );
  });
});

describe('데이터 스택 · migrate', () => {
  it('atmark/db/passport-signer 자리 비밀 — RETAIN', () => {
    const secrets = runtimeTemplates().data.findResources('AWS::SecretsManager::Secret') as Record<
      string,
      { Properties: { Name: string }; DeletionPolicy?: string }
    >;
    const found = Object.values(secrets).find((secret) => secret.Properties.Name === DB_PASSPORT_SIGNER_SECRET_NAME);
    expect(found?.DeletionPolicy).toBe('Retain');
  });

  it('서명 DB 비밀에 쓰는 역할은 migrate 하나(부트스트랩) · 읽는 역할은 서명 역할 하나', () => {
    const writers: string[] = [];
    const readers: string[] = [];
    for (const [role, statements] of statementsByRole(runtimeTemplates().compute)) {
      for (const statement of statements) {
        if (writesSsmSecret(statement, DB_PASSPORT_SIGNER_SECRET_NAME)) writers.push(role);
        else if (readsSsmSecret(statement, DB_PASSPORT_SIGNER_SECRET_NAME)) readers.push(role);
      }
    }
    expect(writers.map((role) => role.replace(/[0-9A-F]{8}$/, ''))).toEqual(['MigrateRole']);
    expect(readers).toEqual([signerFunction().Role['Fn::GetAtt'][0]]);
  });
});

describe('id.atmark.ai — CORS · 공개 신원 API 가 CloudFront 뒤에 선다 (§4B.3 r3 배치 위치)', () => {
  it('기본 동작에 CORS 응답 헤더 정책 · /v1/identity/* 는 HTTPS 커스텀 오리진(api.atmark.ai) · GET/HEAD 만', () => {
    const template = runtimeStackTemplate('identityCdn');
    const distributions = template.findResources('AWS::CloudFront::Distribution') as Record<
      string,
      {
        Properties: {
          DistributionConfig: {
            DefaultCacheBehavior: { ResponseHeadersPolicyId?: string };
            CacheBehaviors?: { PathPattern: string; AllowedMethods: string[]; TargetOriginId: string; ResponseHeadersPolicyId?: string }[];
            Origins: { Id: string; DomainName: unknown; CustomOriginConfig?: { OriginProtocolPolicy: string } }[];
          };
        };
      }
    >;
    const config = Object.values(distributions)[0]?.Properties.DistributionConfig;
    expect(config?.DefaultCacheBehavior.ResponseHeadersPolicyId).toBeDefined();
    const behavior = config?.CacheBehaviors?.find((entry) => entry.PathPattern === IDENTITY_API_PATH_PATTERN);
    expect(behavior?.AllowedMethods.sort()).toEqual(['GET', 'HEAD']);
    expect(behavior?.ResponseHeadersPolicyId).toBeDefined();
    const origin = config?.Origins.find((entry) => entry.Id === behavior?.TargetOriginId);
    expect(origin?.DomainName).toBe('api.atmark.ai');
    expect(origin?.CustomOriginConfig?.OriginProtocolPolicy).toBe('https-only');
  });
});

describe('id.atmark.ai/v1/identity/* — 캐시 키는 경로 하나 · Host 를 오리진에 넘기지 않는다 (2026-09-24 검증)', () => {
  /** 관리형 정책 id — 캐시 키에 Host·Origin·쿠키·쿼리를 넣는 것(예전 판)과, 뷰어 요청 전부를 넘기는 것. */
  const MANAGED_USE_ORIGIN_CACHE_CONTROL_HEADERS = '83da9c7e-98b4-4e11-a168-04f0df8e2c65';
  const MANAGED_ALL_VIEWER = '216adef6-5c7f-47e4-b989-5492eafa07d3';

  function identityApiBehavior() {
    const template = runtimeStackTemplate('identityCdn');
    const distribution = Object.values(
      template.findResources('AWS::CloudFront::Distribution') as Record<
        string,
        { Properties: { DistributionConfig: { CacheBehaviors?: { PathPattern: string; CachePolicyId?: unknown; OriginRequestPolicyId?: unknown }[] } } }
      >,
    )[0];
    const behavior = distribution?.Properties.DistributionConfig.CacheBehaviors?.find((entry) => entry.PathPattern === IDENTITY_API_PATH_PATTERN);
    if (behavior === undefined) throw new Error('/v1/identity/* 동작이 없다');
    return { template, behavior };
  }

  it('캐시 정책은 이 스택의 사용자 정책 — 헤더·쿠키·쿼리 없음 · TTL 최소 0 · 기본 0 · 최대 300', () => {
    const { template, behavior } = identityApiBehavior();
    expect(JSON.stringify(behavior.CachePolicyId)).not.toContain(MANAGED_USE_ORIGIN_CACHE_CONTROL_HEADERS);
    const ref = (behavior.CachePolicyId as { Ref?: string }).Ref;
    expect(ref).toBeDefined();
    const policies = template.findResources('AWS::CloudFront::CachePolicy') as Record<
      string,
      {
        Properties: {
          CachePolicyConfig: {
            MinTTL: number;
            DefaultTTL: number;
            MaxTTL: number;
            ParametersInCacheKeyAndForwardedToOrigin: {
              HeadersConfig: { HeaderBehavior: string; Headers?: unknown };
              CookiesConfig: { CookieBehavior: string };
              QueryStringsConfig: { QueryStringBehavior: string };
            };
          };
        };
      }
    >;
    const config = policies[ref ?? '']?.Properties.CachePolicyConfig;
    expect(config).toBeDefined();
    expect([config?.MinTTL, config?.DefaultTTL, config?.MaxTTL]).toEqual([0, 0, IDENTITY_API_MAX_TTL_SECONDS]);
    expect(IDENTITY_API_MAX_TTL_SECONDS).toBe(300);
    const key = config?.ParametersInCacheKeyAndForwardedToOrigin;
    expect([key?.HeadersConfig.HeaderBehavior, key?.CookiesConfig.CookieBehavior, key?.QueryStringsConfig.QueryStringBehavior]).toEqual(['none', 'none', 'none']);
    expect(key?.HeadersConfig.Headers).toBeUndefined();
  });

  it('오리진 요청 정책 없음 — 뷰어의 Host·쿠키·쿼리·헤더가 api.atmark.ai 로 가지 않는다', () => {
    const { behavior } = identityApiBehavior();
    expect(behavior.OriginRequestPolicyId).toBeUndefined();
    expect(JSON.stringify(behavior)).not.toContain(MANAGED_ALL_VIEWER);
  });
});

describe('CMK 키 정책 — DEK 직접 복호는 서명 역할 하나 (2026-09-24 검증)', () => {
  interface KeyStatement {
    readonly Sid?: string;
    readonly Effect: 'Allow' | 'Deny';
    readonly Action: string | string[];
    readonly Principal: { AWS: unknown };
    readonly Condition?: Record<string, Record<string, unknown>>;
  }

  function keyStatements(): KeyStatement[] {
    const stack = new PassportStack(new cdk.App(), 'AtmarkPassport', { env: { account: ACCOUNT, region: REGION } });
    const keys = Template.fromStack(stack).findResources('AWS::KMS::Key') as Record<string, { Properties: { KeyPolicy: { Statement: KeyStatement[] } } }>;
    const [key] = Object.values(keys);
    if (key === undefined) throw new Error('CMK 가 없다');
    return key.Properties.KeyPolicy.Statement;
  }

  /** `{Fn::Join: ['', ['arn:', {Ref: AWS::Partition}, …]]}` → 문자열(파티션 aws). */
  function resolve(value: unknown): unknown {
    if (typeof value !== 'object' || value === null) return value;
    const join = (value as { 'Fn::Join'?: [string, unknown[]] })['Fn::Join'];
    if (join === undefined) return value;
    return join[1].map((part) => (typeof part === 'string' ? part : (part as { Ref?: string }).Ref === 'AWS::Partition' ? 'aws' : '?')).join(join[0]);
  }

  /** 이 키 정책의 Deny 문장만으로 **거부되는가**(IAM 조건 의미: 문장 안 조건은 AND, 부정 연산자는 키가 없으면 참). */
  function denied(request: { readonly action: string; readonly principalArn: string; readonly viaService?: string }): boolean {
    return keyStatements()
      .filter((statement) => statement.Effect === 'Deny')
      .some((statement) => {
        const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
        if (!actions.includes(request.action) && !actions.includes('kms:*')) return false;
        return Object.entries(statement.Condition ?? {}).every(([operator, entries]) =>
          Object.entries(entries).every(([conditionKey, raw]) => {
            const expected = resolve(raw);
            const actual = conditionKey === 'kms:ViaService' ? request.viaService : conditionKey === 'aws:PrincipalArn' ? request.principalArn : undefined;
            if (operator === 'StringNotEquals' || operator === 'ArnNotEquals') return actual === undefined || actual !== expected;
            throw new Error(`이 평가기가 모르는 조건 연산자: ${operator}`);
          }),
        );
      });
  }

  const role = (name: string): string => `arn:aws:iam::${ACCOUNT}:role/${name}`;
  const viaSecretsManager = `secretsmanager.${REGION}.amazonaws.com`;

  it('Deny 문장 — kms:Decrypt · 모든 주체 · (ViaService ≠ secretsmanager) AND (PrincipalArn ≠ 서명 역할)', () => {
    const deny = keyStatements().find((statement) => statement.Sid === DENY_DIRECT_DECRYPT_SID);
    expect(deny).toMatchObject({ Effect: 'Deny', Action: 'kms:Decrypt', Principal: { AWS: '*' } });
    expect(deny?.Condition?.['StringNotEquals']).toEqual({ 'kms:ViaService': viaSecretsManager });
    expect(resolve(deny?.Condition?.['ArnNotEquals']?.['aws:PrincipalArn'])).toBe(role(PASSPORT_SIGNER_ROLE_NAME));
  });

  it('평가 — 서명 역할만 DEK 를 직접 푼다 · 관리 역할·운영자·아무 주체의 직접 Decrypt 는 거부 · Secrets Manager 경유(CreateSecret)는 그대로', () => {
    expect(denied({ action: 'kms:Decrypt', principalArn: role(PASSPORT_SIGNER_ROLE_NAME) })).toBe(false);
    expect(denied({ action: 'kms:Decrypt', principalArn: role(PASSPORT_SIGNER_ROLE_NAME), viaService: viaSecretsManager })).toBe(false);
    for (const principal of [role('atmark-runtime-admin'), role('atmark-runtime-sender'), role('OrganizationAccountAccessRole'), `arn:aws:iam::${ACCOUNT}:root`]) {
      expect(denied({ action: 'kms:Decrypt', principalArn: principal }), principal).toBe(true);
      // 다른 서비스 경유도 직접과 같다.
      expect(denied({ action: 'kms:Decrypt', principalArn: principal, viaService: `s3.${REGION}.amazonaws.com` }), principal).toBe(true);
    }
    // 프로비저닝(콘솔 = 관리 역할, CLI = 운영자 IAM)은 막히지 않는다.
    expect(denied({ action: 'kms:Decrypt', principalArn: role('atmark-runtime-admin'), viaService: viaSecretsManager })).toBe(false);
    expect(denied({ action: 'kms:Decrypt', principalArn: `arn:aws:iam::${ACCOUNT}:role/AWSReservedSSO_Admin_x`, viaService: viaSecretsManager })).toBe(false);
    expect(denied({ action: 'kms:GenerateDataKey', principalArn: role('atmark-runtime-admin') })).toBe(false);
    // 키 관리(비상 해제 경로)는 Deny 대상이 아니다.
    for (const action of ['kms:PutKeyPolicy', 'kms:GetKeyPolicy', 'kms:DescribeKey', 'kms:ScheduleKeyDeletion']) {
      expect(denied({ action, principalArn: `arn:aws:iam::${ACCOUNT}:root` }), action).toBe(false);
    }
  });

  it('계정 루트의 kms:* 위임은 남는다(키 관리 비상 경로) · Deny 는 Decrypt 하나뿐', () => {
    const statements = keyStatements();
    expect(statements.some((statement) => statement.Effect === 'Allow' && statement.Action === 'kms:*' && JSON.stringify(resolve(statement.Principal.AWS)).includes(':root'))).toBe(true);
    expect(statements.filter((statement) => statement.Effect === 'Deny').map((statement) => statement.Action)).toEqual(['kms:Decrypt']);
  });

  it('키 정책의 역할 이름 = compute 스택이 만든 서명 역할의 이름', () => {
    const roles = runtimeTemplates().compute.findResources('AWS::IAM::Role') as Record<string, { Properties: { RoleName?: string } }>;
    expect(Object.values(roles).map((entry) => entry.Properties.RoleName)).toContain(PASSPORT_SIGNER_ROLE_NAME);
  });
});
