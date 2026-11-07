/**
 * `AtmarkCiCd` — GitHub Actions OIDC 역할의 신뢰 조건 단언(`infra/cdk/stacks/ci-cd-stack.ts`). **배포하지 않는다.**
 *
 * 고정하는 것:
 *   - 공급자는 `token.actions.githubusercontent.com` 하나 · 클라이언트 id 는 `sts.amazonaws.com` 하나 · 커스텀 리소스 λ 없음(네이티브).
 *   - 역할마다 신뢰 문장은 정확히 하나 · `sts:AssumeRoleWithWebIdentity` · 연산자는 `StringEquals` 뿐(StringLike·ForAnyValue 없음) ·
 *     `aud = sts.amazonaws.com` · `sub` 는 정해진 값 **정확히**(`*`·`?` 없음, 다른 리포 없음).
 *   - web 은 main 브랜치 ref, compute 는 환경 `production` — 서로의 `sub` 로는 받을 수 없다.
 *   - 권한: 부트스트랩 역할 assume 은 deploy · file-publishing · lookup(두 리전)뿐 · 스택 상태 읽기는 자기 스택만 · compute 의 추가 권한은 migrate 호출 · 디스패처 스케줄 ·
 *     스케줄러 역할 PassRole(Scheduler 에게만) · 로그 조회뿐. `Action: *` · `Resource: *` 없음 · 관리형 정책 0.
 */

import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

import {
  CiCdStack,
  DEPLOY_COMPUTE_ROLE_NAME,
  DEPLOY_COMPUTE_SUBJECT,
  DEPLOY_WEB_ROLE_NAME,
  DEPLOY_WEB_SUBJECT,
  GITHUB_SUBJECT_PREFIX,
} from '../../../infra/cdk/stacks/ci-cd-stack';
import { ACCOUNT, REGION } from './runtime-app';

interface Statement {
  readonly Effect: string;
  readonly Action: string | readonly string[];
  readonly Resource?: unknown;
  readonly Principal?: { readonly Federated?: unknown };
  readonly Condition?: Record<string, Record<string, unknown>>;
  readonly Sid?: string;
}

interface RoleResource {
  readonly Properties: {
    readonly RoleName: string;
    readonly AssumeRolePolicyDocument: { readonly Statement: readonly Statement[] };
    readonly ManagedPolicyArns?: unknown;
  };
}

const template = Template.fromStack(new CiCdStack(new cdk.App(), 'AtmarkCiCd', { env: { account: ACCOUNT, region: REGION } }));

function role(name: string): { readonly logicalId: string; readonly resource: RoleResource } {
  const roles = template.findResources('AWS::IAM::Role') as Record<string, RoleResource>;
  const found = Object.entries(roles).filter(([, r]) => r.Properties.RoleName === name);
  expect(found, `역할 ${name}`).toHaveLength(1);
  const [logicalId, resource] = found[0] as [string, RoleResource];
  return { logicalId, resource };
}

function policyStatements(logicalId: string): Statement[] {
  const policies = template.findResources('AWS::IAM::Policy') as Record<
    string,
    { Properties: { Roles: readonly { Ref: string }[]; PolicyDocument: { Statement: readonly Statement[] } } }
  >;
  return Object.values(policies)
    .filter((p) => p.Properties.Roles.some((r) => r.Ref === logicalId))
    .flatMap((p) => p.Properties.PolicyDocument.Statement)
    // 비발송 역할의 SES 발송 Deny(ADR-0014 재검증 INFO)는 아래 절이 따로 본다.
    .filter((statement) => (statement as { Sid?: string }).Sid !== 'SesSendDenyNonSendingRole');
}

function sendDenyOf(logicalId: string): Statement | undefined {
  const policies = template.findResources('AWS::IAM::Policy') as Record<
    string,
    { Properties: { Roles: readonly { Ref: string }[]; PolicyDocument: { Statement: readonly Statement[] } } }
  >;
  return Object.values(policies)
    .filter((p) => p.Properties.Roles.some((r) => r.Ref === logicalId))
    .flatMap((p) => p.Properties.PolicyDocument.Statement)
    .find((statement) => (statement as { Sid?: string }).Sid === 'SesSendDenyNonSendingRole');
}

const actions = (s: Statement): string[] => (Array.isArray(s.Action) ? [...(s.Action as string[])] : [s.Action as string]);
const resources = (s: Statement): unknown[] => (Array.isArray(s.Resource) ? [...(s.Resource as unknown[])] : [s.Resource]);

const CASES = [
  { name: DEPLOY_WEB_ROLE_NAME, subject: DEPLOY_WEB_SUBJECT, expected: 'repo:Younkyum@83539914/Atmark@1379438442:ref:refs/heads/main' },
  { name: DEPLOY_COMPUTE_ROLE_NAME, subject: DEPLOY_COMPUTE_SUBJECT, expected: 'repo:Younkyum@83539914/Atmark@1379438442:environment:production' },
] as const;

describe('AtmarkCiCd — GitHub OIDC 공급자', () => {
  it('공급자 하나 · URL token.actions.githubusercontent.com · 클라이언트 id sts.amazonaws.com 하나 · 커스텀 리소스 λ 없음', () => {
    template.resourceCountIs('AWS::IAM::OIDCProvider', 1);
    template.hasResourceProperties('AWS::IAM::OIDCProvider', {
      Url: 'https://token.actions.githubusercontent.com',
      ClientIdList: ['sts.amazonaws.com'],
    });
    template.resourceCountIs('AWS::Lambda::Function', 0);
    template.resourceCountIs('Custom::AWSCDKOpenIdConnectProvider', 0);
  });

  it('스택의 리소스는 공급자 · 역할 둘 · 인라인 정책뿐이다(장기 키 — IAM 사용자 · 액세스 키 — 없음)', () => {
    const types = Object.values(template.toJSON().Resources as Record<string, { Type: string }>).map((r) => r.Type);
    expect(new Set(types)).toEqual(new Set(['AWS::IAM::OIDCProvider', 'AWS::IAM::Role', 'AWS::IAM::Policy']));
    template.resourceCountIs('AWS::IAM::Role', 2);
    template.resourceCountIs('AWS::IAM::User', 0);
    template.resourceCountIs('AWS::IAM::AccessKey', 0);
  });
});

describe.each(CASES)('AtmarkCiCd — $name 신뢰 조건', ({ name, subject, expected }) => {
  it('sub 상수가 정해진 값과 정확히 같다(리포 하나 · 와일드카드 없음)', () => {
    expect(subject).toBe(expected);
    expect(subject).not.toMatch(/[*?]/);
    expect(subject.startsWith(`${GITHUB_SUBJECT_PREFIX}:`)).toBe(true);
  });

  it('신뢰 문장 하나 · AssumeRoleWithWebIdentity · 연산자 StringEquals 뿐 · aud = sts.amazonaws.com · sub 정확히 일치', () => {
    const { resource } = role(name);
    const statements = resource.Properties.AssumeRolePolicyDocument.Statement;
    expect(statements).toHaveLength(1);
    const [trust] = statements as [Statement];
    expect(trust.Effect).toBe('Allow');
    expect(actions(trust)).toEqual(['sts:AssumeRoleWithWebIdentity']);
    expect(trust.Principal?.Federated).toEqual({ Ref: expect.stringMatching(/^GitHubOidcProvider/) as unknown });
    expect(trust.Condition).toEqual({
      StringEquals: {
        'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        'token.actions.githubusercontent.com:sub': expected,
      },
    });
  });

  it('신뢰 정책 어디에도 와일드카드 리포가 없다(repo:*, Younkyum/*, StringLike)', () => {
    const { resource } = role(name);
    const json = JSON.stringify(resource.Properties.AssumeRolePolicyDocument);
    expect(json).not.toContain('StringLike');
    expect(json).not.toContain('ForAnyValue');
    expect(json).not.toMatch(/repo:\*|Younkyum\/\*|Atmark:\*|\*/);
  });

  it('관리형 정책 0', () => {
    expect(role(name).resource.Properties.ManagedPolicyArns).toBeUndefined();
  });
});

describe('AtmarkCiCd — 두 역할은 서로의 sub 로 받을 수 없다', () => {
  it('web 의 sub 는 compute 신뢰에 없고, compute 의 sub 는 web 신뢰에 없다', () => {
    const web = JSON.stringify(role(DEPLOY_WEB_ROLE_NAME).resource.Properties.AssumeRolePolicyDocument);
    const compute = JSON.stringify(role(DEPLOY_COMPUTE_ROLE_NAME).resource.Properties.AssumeRolePolicyDocument);
    expect(web).not.toContain(DEPLOY_COMPUTE_SUBJECT);
    expect(compute).not.toContain(DEPLOY_WEB_SUBJECT);
    expect(DEPLOY_WEB_SUBJECT).not.toBe(DEPLOY_COMPUTE_SUBJECT);
  });
});

describe('AtmarkCiCd — 권한', () => {
  const bootstrap = (kinds: readonly string[]): string[] =>
    ['ap-northeast-2', 'us-east-1'].flatMap((r) => kinds.map((k) => `arn:aws:iam::${ACCOUNT}:role/cdk-hnb659fds-${k}-role-${ACCOUNT}-${r}`));

  const stackArns = (stacks: readonly string[]): string[] =>
    stacks.map((s) => `arn:aws:cloudformation:${REGION}:${ACCOUNT}:stack/${s}/*`);

  it('web: 부트스트랩 deploy · file-publishing · lookup 역할 assume(두 리전, qualifier hnb659fds) + 세 스택 상태 읽기뿐', () => {
    const statements = policyStatements(role(DEPLOY_WEB_ROLE_NAME).logicalId);
    const bySid = Object.fromEntries(statements.map((s) => [s.Sid, s]));
    expect(Object.keys(bySid).sort()).toEqual(['AssumeCdkBootstrapRoles', 'StackStatusRead']);
    const assume = bySid['AssumeCdkBootstrapRoles'] as Statement;
    expect(actions(assume).sort()).toEqual(['sts:AssumeRole', 'sts:TagSession']);
    expect((resources(assume) as string[]).sort()).toEqual(bootstrap(['deploy', 'file-publishing', 'lookup']).sort());
    const status = bySid['StackStatusRead'] as Statement;
    expect(actions(status).sort()).toEqual(['cloudformation:DescribeStackEvents', 'cloudformation:DescribeStacks']);
    expect(resources(status)).toEqual(stackArns(['AtmarkSite', 'AtmarkSiteCdn', 'AtmarkDocs']));
  });

  it('compute: 부트스트랩 assume + AtmarkCompute 상태 읽기 + migrate 호출 + 디스패처 스케줄 + 스케줄러 역할 PassRole(Scheduler 에게만) + 스모크 로그 조회', () => {
    const statements = policyStatements(role(DEPLOY_COMPUTE_ROLE_NAME).logicalId);
    const bySid = Object.fromEntries(statements.map((s) => [s.Sid, s]));
    expect(Object.keys(bySid).sort()).toEqual(
      ['AssumeCdkBootstrapRoles', 'InvokeMigrate', 'PassSchedulerTargetRole', 'PauseResumeWebhookDispatcher', 'SmokeLogsRead', 'StackStatusRead'].sort(),
    );
    expect(resources(bySid['StackStatusRead'] as Statement)).toEqual(stackArns(['AtmarkCompute']));
    expect((resources(bySid['AssumeCdkBootstrapRoles'] as Statement) as string[]).sort()).toEqual(
      bootstrap(['deploy', 'file-publishing', 'lookup']).sort(),
    );
    expect(actions(bySid['InvokeMigrate'] as Statement)).toEqual(['lambda:InvokeFunction']);
    expect(resources(bySid['InvokeMigrate'] as Statement)).toEqual([`arn:aws:lambda:${REGION}:${ACCOUNT}:function:atmark-migrate`]);
    expect(actions(bySid['PauseResumeWebhookDispatcher'] as Statement).sort()).toEqual(['scheduler:GetSchedule', 'scheduler:UpdateSchedule']);
    expect(resources(bySid['PauseResumeWebhookDispatcher'] as Statement)).toEqual([
      `arn:aws:scheduler:${REGION}:${ACCOUNT}:schedule/default/atmark-webhook-dispatcher`,
    ]);
    expect(bySid['PassSchedulerTargetRole']?.Condition).toEqual({ StringEquals: { 'iam:PassedToService': 'scheduler.amazonaws.com' } });
    expect(actions(bySid['SmokeLogsRead'] as Statement)).toEqual(['logs:FilterLogEvents']);
  });

  it('두 역할 모두 SES 발송 명시 Deny 를 갖는다(ADR-0014 재검증 INFO — 발송 주체가 아닌 모든 역할)', () => {
    for (const name of [DEPLOY_WEB_ROLE_NAME, DEPLOY_COMPUTE_ROLE_NAME]) {
      expect(sendDenyOf(role(name).logicalId), name).toMatchObject({ Effect: 'Deny', Action: 'ses:Send*', Resource: '*' });
    }
  });

  it('두 역할 어디에도 Action * · Resource * · ses:* 가 없다', () => {
    for (const name of [DEPLOY_WEB_ROLE_NAME, DEPLOY_COMPUTE_ROLE_NAME]) {
      for (const s of policyStatements(role(name).logicalId)) {
        expect(s.Effect).toBe('Allow');
        for (const a of actions(s)) {
          expect(a).not.toBe('*');
          expect(a.endsWith(':*')).toBe(false);
          expect(a.startsWith('ses:')).toBe(false);
        }
        expect(resources(s)).not.toContain('*');
      }
    }
  });
});
