/**
 * **IAM 역할 설명은 Latin-1 일부만 받는다 — synth 는 통과하고 CloudFormation 검증·배포에서만 거부된다.**
 *
 * 2026-09-27 메일 기본기 2차 배포 전 `cdk diff` 에서 `AtmarkStorage` 의 GuardDuty 보호 계획 역할 설명에 든 em dash(—)가
 * `^[\u0009\u000A\u000D -~¡-ÿ]*$` 에 걸렸다(CloudFormation-Validate F3031). EC2 설명(ec2-descriptions)과 같은 종류 —
 * AWS 가 거부해야만 드러나므로 배포 전에 빨개지는 곳을 여기 둔다. (CloudFormation 출력의 Description 은 유니코드를 받으므로 대상이 아니다.)
 */

import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

import { StorageStack } from '../../../infra/cdk/stacks/storage-stack';
import { runtimeStackTemplate, runtimeTemplates } from './runtime-app';

/** IAM CreateRole 의 Description 허용 문자 집합. 길이는 1000 이하. */
const IAM_ROLE_DESCRIPTION = /^[\u0009\u000A\u000D -~¡-ÿ]{0,1000}$/;

function offences(stack: string, template: Template): string[] {
  const roles = template.findResources('AWS::IAM::Role') as Record<string, { Properties?: { Description?: unknown } }>;
  return Object.entries(roles)
    .filter(([, role]) => typeof role.Properties?.Description === 'string' && !IAM_ROLE_DESCRIPTION.test(role.Properties.Description))
    .map(([id, role]) => `${stack}/${id}: ${String(role.Properties?.Description)}`);
}

describe('IAM 역할 설명 문자 집합', () => {
  it('Storage 와 런타임 스택(Network·Data·Compute·Transparency·IdentityCdn·Billing)의 모든 역할 설명이 허용 문자 집합 안에 있다', () => {
    const storage = Template.fromStack(
      new StorageStack(new cdk.App(), 'AtmarkStorage', { env: { account: '123456789012', region: 'ap-northeast-2' } }),
    );
    const templates: Record<string, Template> = {
      ...runtimeTemplates(),
      transparency: runtimeStackTemplate('transparency'),
      identityCdn: runtimeStackTemplate('identityCdn'),
      billing: runtimeStackTemplate('billing'),
      storage,
    };
    expect(Object.entries(templates).flatMap(([stack, template]) => offences(stack, template))).toEqual([]);
  });

  it('대조군: em dash·한글 설명은 이 검사에 걸린다(검사가 살아 있다)', () => {
    expect(IAM_ROLE_DESCRIPTION.test('GuardDuty Malware Protection for S3 — scans')).toBe(false);
    expect(IAM_ROLE_DESCRIPTION.test('발송 역할')).toBe(false);
    expect(IAM_ROLE_DESCRIPTION.test('GuardDuty Malware Protection for S3 - scans outbound/uploads/')).toBe(true);
  });
});
