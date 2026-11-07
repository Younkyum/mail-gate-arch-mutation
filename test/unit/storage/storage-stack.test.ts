/**
 * `AtmarkStorage` 스택 — 합성된 템플릿에 대한 단언. **배포하지 않는다.**
 *
 * 원문을 잃지 않는다(RETAIN·버전 관리), 밖에 보이지 않는다(퍼블릭 차단·SSL 강제), 저장 시 암호화된다
 * (SSE-S3), SES 쓰기 권한이 **이 계정의** receipt rule 로만 열려 있다(confused deputy), 그리고
 * 메일 본문 네 접두사는 365일 뒤 만료된다(US-008, 진윤겸 결정 — `outbound/scheduled/` 는 범위 밖).
 */

import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

import {
  CONTACT_DOCUMENT_PREFIX,
  INBOUND_ATTACHMENTS_PREFIX as STACK_INBOUND_ATTACHMENTS_PREFIX,
  INBOUND_PARSED_PREFIX as STACK_INBOUND_PARSED_PREFIX,
  INBOUND_RAW_PREFIX as STACK_INBOUND_RAW_PREFIX,
  MAIL_BODY_RETENTION_DAYS,
  OUTBOUND_CONTENT_PREFIX as STACK_OUTBOUND_CONTENT_PREFIX,
  StorageStack,
} from '../../../infra/cdk/stacks/storage-stack';
import { CONTACT_DOCUMENT_PREFIX as INTAKE_CONTACT_PREFIX } from '../../../src/contact/intake';
import {
  INBOUND_ATTACHMENTS_PREFIX,
  INBOUND_PARSED_PREFIX,
  INBOUND_RAW_PREFIX,
  OUTBOUND_CONTENT_PREFIX,
} from '../../../src/storage/object-store';

const ACCOUNT = '123456789012';
const REGION = 'ap-northeast-2';

function synth(): Template {
  const app = new cdk.App();
  const stack = new StorageStack(app, 'AtmarkStorage', { env: { account: ACCOUNT, region: REGION } });
  return Template.fromStack(stack);
}

interface Statement {
  readonly Sid?: string;
  readonly Effect: string;
  readonly Principal?: unknown;
  readonly Action: unknown;
  readonly Resource: unknown;
  readonly Condition?: Record<string, Record<string, unknown>>;
}

interface LifecycleRuleResource {
  readonly Status?: string;
  readonly Prefix?: string;
  readonly ExpirationInDays?: number;
  readonly NoncurrentVersionExpiration?: { NoncurrentDays: number };
  readonly AbortIncompleteMultipartUpload?: { DaysAfterInitiation: number };
}

function statements(template: Template): Statement[] {
  const policies = Object.values(template.findResources('AWS::S3::BucketPolicy'));
  expect(policies).toHaveLength(1);
  return (policies[0] as { Properties: { PolicyDocument: { Statement: Statement[] } } }).Properties.PolicyDocument
    .Statement;
}

describe('AtmarkStorage — 버킷', () => {
  it('SSE-S3 · 퍼블릭 전면 차단 · ACL 비활성 · 버전 관리', () => {
    synth().hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }],
      },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
      VersioningConfiguration: { Status: 'Enabled' },
    });
  });

  it('RETAIN — 스택 삭제가 원문 삭제가 되지 않는다 (autoDeleteObjects 커스텀 리소스도 없다)', () => {
    const template = synth();
    const buckets = Object.values(template.findResources('AWS::S3::Bucket'));
    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toMatchObject({ DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
    expect(Object.keys(template.findResources('Custom::S3AutoDeleteObjects'))).toEqual([]);
  });

  it('메일 본문 네 접두사와 문의 전달 문서(US-009)가 365일 뒤 만료된다(US-008) — outbound/scheduled/ 는 규칙이 없다', () => {
    // 문의 전달 문서 접두사는 저장 코드와 같은 값이어야 한다 — 어긋나면 규칙이 아무것도 지우지 않는다.
    expect(CONTACT_DOCUMENT_PREFIX).toBe(INTAKE_CONTACT_PREFIX);
    const [bucket] = Object.values(synth().findResources('AWS::S3::Bucket')) as {
      Properties: { LifecycleConfiguration?: { Rules: LifecycleRuleResource[] } };
    }[];
    const rules = bucket?.Properties.LifecycleConfiguration?.Rules ?? [];
    expect(MAIL_BODY_RETENTION_DAYS).toBe(365);

    // 메일 기본기 2차 A2 — 발신 첨부 스테이징(`outbound/uploads/`)은 2일(보존 규칙이 아니라 위생 — 스캔 전·미사용 업로드), 영구본은 1년.
    const expiryRules = rules.filter((r) => r.Status === 'Enabled' && r.ExpirationInDays !== undefined && r.Prefix !== 'outbound/uploads/');
    expect(rules.find((r) => r.Prefix === 'outbound/uploads/')?.ExpirationInDays).toBe(2);
    const expiryPrefixes = expiryRules.map((r) => r.Prefix).sort();
    expect(expiryPrefixes).toEqual(
      // 묶음 B 초안 본문(`outbound/drafts/`)도 1년 — 배포 전 보안 리뷰(판마다 새 객체 · 버린 초안이 끝없이 쌓였다).
      [INBOUND_RAW_PREFIX, INBOUND_PARSED_PREFIX, INBOUND_ATTACHMENTS_PREFIX, OUTBOUND_CONTENT_PREFIX, CONTACT_DOCUMENT_PREFIX, 'outbound/attachments/', 'outbound/drafts/'].sort(),
    );
    for (const rule of expiryRules) {
      expect(rule.ExpirationInDays).toBe(MAIL_BODY_RETENTION_DAYS);
      expect(rule.NoncurrentVersionExpiration).toEqual({ NoncurrentDays: 7 });
    }
    // 예약 발송 본문(P3c)은 이 결정의 범위 밖 — 발송되면 outbound/content/ 로 옮겨 적힌다.
    expect(expiryPrefixes).not.toContain('outbound/scheduled/');

    const multipartRule = rules.find((r) => r.AbortIncompleteMultipartUpload !== undefined);
    expect(multipartRule?.AbortIncompleteMultipartUpload).toEqual({ DaysAfterInitiation: 7 });
    expect(multipartRule?.Prefix).toBeUndefined();
  });
});

describe('AtmarkStorage — 버킷 정책', () => {
  it('평문 HTTP 를 거부한다 (aws:SecureTransport=false → Deny)', () => {
    const deny = statements(synth()).filter((s) => s.Effect === 'Deny');
    expect(deny.some((s) => JSON.stringify(s.Condition) === JSON.stringify({ Bool: { 'aws:SecureTransport': 'false' } }))).toBe(
      true,
    );
  });

  it('Allow 는 SES 서비스 주체의 s3:PutObject 하나뿐이고, inbound/raw/* · SourceAccount · SourceArn 으로 묶인다', () => {
    const allow = statements(synth()).filter((s) => s.Effect === 'Allow');
    expect(allow).toHaveLength(1);
    const [ses] = allow;
    expect(ses?.Principal).toEqual({ Service: 'ses.amazonaws.com' });
    expect(ses?.Action).toBe('s3:PutObject');
    // 범위가 접두사 하나로 닫혀 있다 — `outbound/content/` 에 SES 가 쓸 수 없다.
    expect(JSON.stringify(ses?.Resource)).toContain(`/${INBOUND_RAW_PREFIX}*`);
    expect(JSON.stringify(ses?.Resource)).not.toContain(OUTBOUND_CONTENT_PREFIX);
    // confused deputy: 다른 계정의 SES 규칙이 이 버킷을 표적으로 삼을 수 없다.
    expect(ses?.Condition?.['StringEquals']).toEqual({ 'aws:SourceAccount': ACCOUNT });
    expect(ses?.Condition?.['ArnLike']).toEqual({
      'aws:SourceArn': `arn:aws:ses:${REGION}:${ACCOUNT}:receipt-rule-set/*:receipt-rule/*`,
    });
  });
});

describe('런타임과 인프라의 접두사가 같다', () => {
  it('src/storage/object-store.ts ↔ infra/cdk/stacks/storage-stack.ts', () => {
    expect(STACK_INBOUND_RAW_PREFIX).toBe(INBOUND_RAW_PREFIX);
    expect(STACK_OUTBOUND_CONTENT_PREFIX).toBe(OUTBOUND_CONTENT_PREFIX);
    // P3a — 수신 파생물 둘.
    expect(STACK_INBOUND_PARSED_PREFIX).toBe(INBOUND_PARSED_PREFIX);
    expect(STACK_INBOUND_ATTACHMENTS_PREFIX).toBe(INBOUND_ATTACHMENTS_PREFIX);
  });

  it('SES 쓰기 허용은 수신 파생물 접두사에 닿지 않는다 — 그 둘은 소비자만 쓴다', () => {
    const resources = JSON.stringify(statements(synth()).filter((s) => s.Effect === 'Allow').map((s) => s.Resource));
    expect(resources).not.toContain(INBOUND_PARSED_PREFIX);
    expect(resources).not.toContain(INBOUND_ATTACHMENTS_PREFIX);
  });
});
