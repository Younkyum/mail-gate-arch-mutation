/**
 * 메일 기본기 2차 A2 — 발신 첨부의 인프라(계획 §4 A2 "인프라" · §6 2차 synth diff 기준).
 *
 *   ① Storage: 수명주기 둘(스테이징 2일 · 영구본 1년) · GuardDuty Malware Protection 계획(보호 범위 = 스테이징 접두사 하나 · 태그 켬) ·
 *      그 역할(서비스 주체 + SourceAccount · 객체 권한은 스테이징 접두사만).
 *   ② Compute: 첨부 접두사 두 개에 쓰는 역할은 발송 역할 하나 · 스캔 태그 읽기(GetObjectTagging)는 스테이징만 · 태그 **쓰기** 권한은 런타임
 *      역할 어디에도 없다(판정을 스스로 "깨끗함" 으로 적지 못한다) · 스위치 env 는 api 만 · 기본 꺼짐.
 *   ③ 접두사 상수 = 런타임 상수.
 *   보안 리뷰 L1 — 버킷 정책이 스테이징 접두사의 태그 쓰기·삭제를 GuardDuty 역할 밖 모두에게 Deny · 발송 역할의 스테이징 GetObject 는
 *   `s3:ExistingObjectTag/GuardDutyMalwareScanStatus = NO_THREATS_FOUND` 조건이 붙는다(스캔 전·위협 객체는 읽지도 못한다).
 */

import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

import {
  GUARDDUTY_MALWARE_PROTECTION_PRINCIPAL,
  OUTBOUND_ATTACHMENTS_PREFIX as STACK_ATTACHMENTS,
  OUTBOUND_UPLOADS_PREFIX as STACK_UPLOADS,
  StorageStack,
} from '../../../infra/cdk/stacks/storage-stack';
import { OUTBOUND_ATTACHMENTS_PREFIX, OUTBOUND_UPLOADS_PREFIX } from '../../../src/storage/object-store';
import { ACCOUNT, actionsOf, REGION, runtimeTemplates, statementsByRole, type IamStatement } from './runtime-app';

function storageTemplate(): Template {
  const app = new cdk.App();
  return Template.fromStack(new StorageStack(app, 'AtmarkStorage', { env: { account: ACCOUNT, region: REGION } }));
}

const resourcesOf = (statement: IamStatement): string => JSON.stringify(statement.Resource ?? null);

describe('A2 — Storage: 수명주기 · GuardDuty 보호 계획', () => {
  const template = storageTemplate();

  it('접두사 상수 = 런타임 상수', () => {
    expect(STACK_UPLOADS).toBe(OUTBOUND_UPLOADS_PREFIX);
    expect(STACK_ATTACHMENTS).toBe(OUTBOUND_ATTACHMENTS_PREFIX);
  });

  it('수명주기 — 스테이징 2일 · 영구본 365일', () => {
    const bucket = Object.values(template.findResources('AWS::S3::Bucket'))[0] as { Properties: { LifecycleConfiguration: { Rules: Record<string, unknown>[] } } };
    const rules = bucket.Properties.LifecycleConfiguration.Rules;
    expect(rules.find((rule) => rule['Prefix'] === OUTBOUND_UPLOADS_PREFIX)).toMatchObject({ ExpirationInDays: 2, Status: 'Enabled' });
    expect(rules.find((rule) => rule['Prefix'] === OUTBOUND_ATTACHMENTS_PREFIX)).toMatchObject({ ExpirationInDays: 365, Status: 'Enabled' });
  });

  it('보호 계획 하나 — 스테이징 접두사만 · 태그 켬', () => {
    const plans = Object.values(template.findResources('AWS::GuardDuty::MalwareProtectionPlan')) as { Properties: Record<string, unknown> }[];
    expect(plans).toHaveLength(1);
    expect(plans[0]?.Properties).toMatchObject({
      ProtectedResource: { S3Bucket: { ObjectPrefixes: [OUTBOUND_UPLOADS_PREFIX] } },
      Actions: { Tagging: { Status: 'ENABLED' } },
    });
  });

  it('보호 계획 역할 — GuardDuty 서비스 주체 + SourceAccount · 객체 읽기·태그는 스테이징 접두사만', () => {
    const roles = Object.values(template.findResources('AWS::IAM::Role')) as { Properties: { AssumeRolePolicyDocument: { Statement: IamStatement[] } } }[];
    const trust = roles.flatMap((role) => role.Properties.AssumeRolePolicyDocument.Statement);
    const guard = trust.find((statement) => JSON.stringify(statement).includes(GUARDDUTY_MALWARE_PROTECTION_PRINCIPAL));
    expect(guard?.Condition).toEqual({ StringEquals: { 'aws:SourceAccount': ACCOUNT } });
    const statements = [...statementsByRole(template).values()].flat();
    for (const statement of statements) {
      const actions = actionsOf(statement);
      if (actions.some((action) => action.startsWith('s3:GetObject') || action.includes('Tagging'))) {
        expect(resourcesOf(statement), statement.Sid).toContain(OUTBOUND_UPLOADS_PREFIX);
      }
    }
  });
});

describe('보안 리뷰 L1 — 스캔 태그 쓰기 Deny(버킷 정책)', () => {
  it('스테이징 접두사의 태그 쓰기·삭제 넷 — GuardDuty 역할이 아니면 모두 Deny', () => {
    const template = storageTemplate();
    const policies = Object.values(template.findResources('AWS::S3::BucketPolicy')) as { Properties: { PolicyDocument: { Statement: IamStatement[] } } }[];
    const deny = policies.flatMap((policy) => policy.Properties.PolicyDocument.Statement).find((statement) => statement.Sid === 'DenyScanTagWritesOutsideGuardDuty');
    expect(deny).toBeDefined();
    const statement = deny as IamStatement & { Principal: unknown };
    expect(statement.Effect).toBe('Deny');
    expect(statement.Principal).toEqual({ AWS: '*' });
    expect([...actionsOf(statement)].sort()).toEqual(['s3:DeleteObjectTagging', 's3:DeleteObjectVersionTagging', 's3:PutObjectTagging', 's3:PutObjectVersionTagging']);
    expect(resourcesOf(statement)).toContain(OUTBOUND_UPLOADS_PREFIX);
    expect(resourcesOf(statement)).not.toContain(OUTBOUND_ATTACHMENTS_PREFIX);
    // 예외는 보호 계획 역할 하나(ARN 참조).
    const roleIds = Object.keys(template.findResources('AWS::IAM::Role'));
    const exempt = JSON.stringify(statement.Condition?.['ArnNotEquals']?.['aws:PrincipalArn'] ?? null);
    expect(roleIds.some((id) => exempt.includes(id))).toBe(true);
  });
});

describe('A2 — Compute: 발송 역할만 첨부 접두사 · 태그 쓰기 0 · 스위치 env', () => {
  const compute = runtimeTemplates().compute;

  it('첨부 접두사(uploads·attachments)에 쓰거나 읽는 역할은 하나(발송 역할) · 스캔 태그 읽기는 스테이징만', () => {
    const touching = [...statementsByRole(compute)].filter(([, statements]) =>
      statements.some((statement) => /outbound\/(uploads|attachments)\//.test(resourcesOf(statement))),
    );
    expect(touching.map(([role]) => role)).toHaveLength(1);
    const statements = touching[0]?.[1] ?? [];
    const tagging = statements.filter((statement) => actionsOf(statement).includes('s3:GetObjectTagging'));
    expect(tagging).toHaveLength(1);
    expect(resourcesOf(tagging[0] as IamStatement)).toContain(OUTBOUND_UPLOADS_PREFIX);
    expect(resourcesOf(tagging[0] as IamStatement)).not.toContain(OUTBOUND_ATTACHMENTS_PREFIX);
  });

  it('보안 리뷰 L1 — 발송 역할의 스테이징 GetObject 는 스캔 태그 조건(NO_THREATS_FOUND) 아래에서만', () => {
    for (const [role, statements] of statementsByRole(compute)) {
      for (const statement of statements) {
        if (!actionsOf(statement).includes('s3:GetObject')) continue;
        if (!resourcesOf(statement).includes(OUTBOUND_UPLOADS_PREFIX)) continue;
        expect(statement.Condition, `${role} ${String(statement.Sid)}`).toEqual({
          StringEquals: { 's3:ExistingObjectTag/GuardDutyMalwareScanStatus': 'NO_THREATS_FOUND' },
        });
      }
    }
    const guarded = [...statementsByRole(compute).values()]
      .flat()
      .filter((statement) => actionsOf(statement).includes('s3:GetObject') && resourcesOf(statement).includes(OUTBOUND_UPLOADS_PREFIX));
    expect(guarded).toHaveLength(1);
  });

  it('런타임 역할 어디에도 태그 쓰기·삭제가 없다(스캔 판정을 스스로 적지 못한다)', () => {
    for (const [role, statements] of statementsByRole(compute)) {
      const actions = statements.flatMap(actionsOf);
      for (const forbidden of ['s3:PutObjectTagging', 's3:PutObjectVersionTagging', 's3:DeleteObjectTagging', 's3:DeleteObject']) {
        expect(actions, role).not.toContain(forbidden);
      }
    }
  });

  it('스위치 ATMARK_OUTBOUND_ATTACHMENTS_ENABLED 는 api 에만 · 기본 true(전체 공개 2026-09-29)', () => {
    const functions = compute.findResources('AWS::Lambda::Function') as Record<string, { Properties: { FunctionName: string; Environment: { Variables: Record<string, unknown> } } }>;
    for (const fn of Object.values(functions)) {
      const has = 'ATMARK_OUTBOUND_ATTACHMENTS_ENABLED' in fn.Properties.Environment.Variables;
      expect(has, fn.Properties.FunctionName).toBe(fn.Properties.FunctionName === 'atmark-api');
      if (has) expect(fn.Properties.Environment.Variables['ATMARK_OUTBOUND_ATTACHMENTS_ENABLED']).toBe('true');
    }
  });
});
