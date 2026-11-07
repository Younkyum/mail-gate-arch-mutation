/**
 * `AtmarkSes` — configuration set 의 engagement metrics(열람·클릭 추적) 고정 단언.
 *
 * 계정 수준 VDM(Virtual Deliverability Manager)은 CDK 밖(콘솔)에서 켜질 수 있다 — 이 스택이 관측할 수도, 막을 수도 없는 표면이다.
 * 켜지면 SES 가 HTML 본문의 href 를 추적 리다이렉트로 다시 쓰고 픽셀을 심는다. 로그인/가입/초대 메일의 링크에는
 * 토큰이 fragment 로 실려 있어(`docs/adr/0006-login-mail-principal.md`), 추적이 켜지는 순간 그 토큰이 SES·awstrack.me
 * 로그에 남는다. `vdmOptions.engagementMetrics: false` 는 이 configuration set 한정으로 계정 설정을 이기는 명시적 OFF 다 —
 * 이 테스트는 그 값이 합성된 템플릿에서 빠지지 않게 고정한다.
 */

import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

import { CONFIGURATION_SET_NAME, SesStack } from '../../../infra/cdk/stacks/ses-stack';

function synthConfigurationSet(): Record<string, unknown> {
  const template = Template.fromStack(new SesStack(new cdk.App(), 'AtmarkSes', { env: { account: '123456789012', region: 'ap-northeast-2' } }));
  const sets = template.findResources('AWS::SES::ConfigurationSet') as Record<string, { Properties: Record<string, unknown> }>;
  const [configurationSet] = Object.values(sets);
  expect(configurationSet?.Properties.Name).toBe(CONFIGURATION_SET_NAME);
  return configurationSet?.Properties ?? {};
}

describe('SES configuration set — engagement metrics OFF', () => {
  it('VdmOptions.DashboardOptions.EngagementMetrics 가 DISABLED 로 고정되어 있다', () => {
    const properties = synthConfigurationSet();
    expect(properties.VdmOptions).toEqual({ DashboardOptions: { EngagementMetrics: 'DISABLED' } });
  });

  it('이벤트 목적지는 여전히 OPEN·CLICK·SUBSCRIPTION 을 구독하지 않는다 (계정 우회 경로 하나만 막는 게 아니라 둘 다 막혀 있는지 확인)', () => {
    const template = Template.fromStack(new SesStack(new cdk.App(), 'AtmarkSes', { env: { account: '123456789012', region: 'ap-northeast-2' } }));
    const destinations = template.findResources('AWS::SES::ConfigurationSetEventDestination') as Record<
      string,
      { Properties: { EventDestination?: { MatchingEventTypes?: string[] } } }
    >;
    const eventTypes = Object.values(destinations).flatMap((destination) => destination.Properties.EventDestination?.MatchingEventTypes ?? []);
    expect(eventTypes).not.toContain('OPEN');
    expect(eventTypes).not.toContain('CLICK');
    expect(eventTypes).not.toContain('SUBSCRIPTION');
  });
});
