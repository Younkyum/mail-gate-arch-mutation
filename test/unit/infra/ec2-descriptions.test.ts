/**
 * **EC2 보안 그룹 설명은 ASCII 일부만 받는다 — synth 는 통과하고 배포에서만 거부된다.**
 *
 * 2026-09-23 첫 운영 배포에서 `AtmarkNetwork` 가 `CREATE_FAILED` 로 롤백됐다. NAT 보안 그룹 인그레스 규칙의 설명이
 * 한글이었다("VPC 내부 HTTPS 를 NAT"). EC2 는 GroupDescription 과 규칙 Description 에 `a-zA-Z0-9. _-:/()#,@[]+=&;{}!$*`
 * 만 허용한다. CDK 타입도, synth 도, 기존 스택 테스트도 이것을 몰랐다 — AWS 가 거부해야만 드러나는 종류라, 배포 전에
 * 빨개지는 곳이 여기 하나뿐이다. (CloudFormation 출력의 Description 은 유니코드를 받으므로 대상이 아니다.)
 */

import type { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

import { runtimeTemplates } from './runtime-app';

/** EC2 API 가 문서화한 허용 문자 집합(보안 그룹·규칙 설명). 길이는 255 이하. */
const EC2_DESCRIPTION = /^[a-zA-Z0-9. _\-:/()#,@[\]+=&;{}!$*]{0,255}$/;

interface Offence {
  readonly stack: string;
  readonly resource: string;
  readonly where: string;
  readonly value: string;
}

function offences(stack: string, template: Template): Offence[] {
  const found: Offence[] = [];
  const check = (resource: string, where: string, value: unknown): void => {
    if (typeof value === 'string' && !EC2_DESCRIPTION.test(value)) found.push({ stack, resource, where, value });
  };
  for (const type of ['AWS::EC2::SecurityGroup', 'AWS::EC2::SecurityGroupIngress', 'AWS::EC2::SecurityGroupEgress']) {
    const resources = template.findResources(type) as Record<string, { Properties?: Record<string, unknown> }>;
    for (const [id, resource] of Object.entries(resources)) {
      const properties = resource.Properties ?? {};
      check(id, 'GroupDescription', properties['GroupDescription']);
      check(id, 'Description', properties['Description']);
      for (const key of ['SecurityGroupIngress', 'SecurityGroupEgress']) {
        const rules = properties[key];
        if (!Array.isArray(rules)) continue;
        rules.forEach((rule: { Description?: unknown }, index) => {
          check(id, `${key}[${String(index)}].Description`, rule.Description);
        });
      }
    }
  }
  return found;
}

describe('EC2 보안 그룹 설명 문자 집합', () => {
  it('Network·Data·Compute 스택의 모든 보안 그룹·규칙 설명이 EC2 허용 문자 집합 안에 있다', () => {
    const templates = runtimeTemplates();
    const all = Object.entries(templates).flatMap(([stack, template]) => offences(stack, template));
    expect(all).toEqual([]);
  });

  it('대조군: 한글 설명은 이 검사에 걸린다(검사가 살아 있다)', () => {
    expect(EC2_DESCRIPTION.test('VPC 내부 HTTPS 를 NAT')).toBe(false);
    expect(EC2_DESCRIPTION.test('HTTPS from VPC to NAT')).toBe(true);
  });
});
