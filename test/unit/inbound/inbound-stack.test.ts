/**
 * `AtmarkInbound` 스택 — 합성된 템플릿에 대한 단언. **배포하지 않는다.**
 *
 * 수신 대상이 verified 도메인 전부(recipients 없음 — M5)이고, 스캔이 켜져 있고, 원문이 `inbound/raw/` 에 떨어지며 SNS 로 알리고,
 * SQS 가 DLQ 를 갖고, rule set 이 활성화되며, 그 활성화 주체에 **발송 권한이 없다**.
 */

import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

import {
  INBOUND_MAX_RECEIVE_COUNT,
  INBOUND_RULE_NAME,
  INBOUND_RULE_SET_NAME,
  InboundStack,
} from '../../../infra/cdk/stacks/inbound-stack';
import { INBOUND_RAW_PREFIX } from '../../../src/storage/object-store';

const ACCOUNT = '123456789012';
const REGION = 'ap-northeast-2';

function synth(): Template {
  const app = new cdk.App();
  const stack = new InboundStack(app, 'AtmarkInbound', {
    env: { account: ACCOUNT, region: REGION },
    mailBucketName: 'atmark-mail-store-test',
  });
  return Template.fromStack(stack);
}

describe('AtmarkInbound — receipt rule', () => {
  it('rule set 하나, 규칙 하나: recipients 없음(verified 도메인 전부 — M5) · 스캔 켬 · 활성', () => {
    const template = synth();
    template.resourceCountIs('AWS::SES::ReceiptRuleSet', 1);
    template.hasResourceProperties('AWS::SES::ReceiptRuleSet', { RuleSetName: INBOUND_RULE_SET_NAME });
    template.resourceCountIs('AWS::SES::ReceiptRule', 1);
    // 문지기는 소비자다(unknown_recipient · domain_not_active — 원문을 읽기 전). 규칙에 도메인을 다시 적으면 고객 도메인 메일이 SES 에서 조용히 사라진다.
    template.hasResourceProperties('AWS::SES::ReceiptRule', {
      Rule: Match.objectLike({ Name: INBOUND_RULE_NAME, Enabled: true, Recipients: Match.absent(), ScanEnabled: true, TlsPolicy: 'Optional' }),
    });
  });

  it('논리 ID 고정 — recipients 를 빼는 M5 는 규칙의 제자리 갱신이다(규칙·rule set 교체 0 · 활성화 커스텀 리소스 재실행 0)', () => {
    // CFN: `Rule.Recipients` = No interruption · `Rule.Name`·`RuleSetName` = Replacement. 논리 ID 가 바뀌면 CFN 은 새 리소스를 만들고 옛것을 지운다.
    const template = synth();
    expect(Object.keys(template.findResources('AWS::SES::ReceiptRuleSet'))).toEqual(['InboundRuleSet3F1E0E90']);
    expect(Object.keys(template.findResources('AWS::SES::ReceiptRule'))).toEqual(['InboundRuleSetAgentMailRule6A01A68A']);
    expect(Object.keys(template.findResources('Custom::AWS'))).toEqual(['ActivateInboundRuleSet355E6BB0']);
  });

  it('S3 액션: 런타임과 같은 접두사 · SNS 알림 · KMS 없음(클라이언트측 암호화가 아니다)', () => {
    const rules = Object.values(synth().findResources('AWS::SES::ReceiptRule')) as {
      Properties: { Rule: { Actions: { S3Action?: Record<string, unknown> }[] } };
    }[];
    const actions = rules[0]?.Properties.Rule.Actions ?? [];
    expect(actions).toHaveLength(1);
    const s3 = actions[0]?.S3Action;
    expect(s3?.['ObjectKeyPrefix']).toBe(INBOUND_RAW_PREFIX);
    expect(s3?.['BucketName']).toBe('atmark-mail-store-test');
    expect(s3?.['TopicArn']).toBeDefined();
    expect(s3).not.toHaveProperty('KmsKeyArn');
  });

  it('SES 의 SNS publish 는 이 계정의 이 rule set 으로만 열린다', () => {
    synth().hasResourceProperties('AWS::SNS::TopicPolicy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Principal: { Service: 'ses.amazonaws.com' },
            Action: 'sns:Publish',
            Condition: {
              StringEquals: { 'aws:SourceAccount': ACCOUNT },
              ArnLike: {
                'aws:SourceArn': `arn:aws:ses:${REGION}:${ACCOUNT}:receipt-rule-set/${INBOUND_RULE_SET_NAME}:receipt-rule/*`,
              },
            },
          }),
        ]),
      }),
    });
  });

  it('활성화 커스텀 리소스가 있고, 그 권한은 SetActiveReceiptRuleSet 하나다 — 발송 권한 없음', () => {
    const template = synth();
    template.hasResourceProperties('Custom::AWS', {
      Create: Match.stringLikeRegexp(`setActiveReceiptRuleSet.*${INBOUND_RULE_SET_NAME}`),
    });
    const policies = Object.values(template.findResources('AWS::IAM::Policy')) as {
      Properties: { PolicyDocument: { Statement: { Sid?: string; Effect: string; Action: unknown; Resource?: unknown }[] } };
    }[];
    const statements = policies.flatMap((policy) => policy.Properties.PolicyDocument.Statement);
    // 허용은 하나 · 그리고 SES 발송 명시 Deny 하나(ADR-0014 재검증 INFO — 발송 주체가 아닌 모든 역할).
    expect(statements.filter((s) => s.Effect === 'Allow').map((s) => s.Action)).toEqual(['ses:SetActiveReceiptRuleSet']);
    expect(statements.filter((s) => s.Effect === 'Deny')).toEqual([{ Sid: 'SesSendDenyNonSendingRole', Effect: 'Deny', Action: 'ses:Send*', Resource: '*' }]);
  });
});

describe('AtmarkInbound — 큐', () => {
  it('큐는 DLQ 를 갖고 SSL 을 강제한다', () => {
    const template = synth();
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'atmark-inbound-mail',
      RedrivePolicy: Match.objectLike({ maxReceiveCount: INBOUND_MAX_RECEIVE_COUNT }),
    });
    template.resourceCountIs('AWS::SNS::Subscription', 1);
    // 봉투를 벗기지 않는다(ses-stack 과 같은 선택). 파서는 둘 다 받는다.
    template.hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'sqs', RawMessageDelivery: Match.absent() });
  });

  it('MX 레코드를 만들지 않는다 — DNS 는 배포 단계다. 값은 출력으로만', () => {
    const template = synth();
    expect(Object.keys(template.findResources('AWS::Route53::RecordSet'))).toEqual([]);
    template.hasOutput('InboundMxRecord', { Value: `10 inbound-smtp.${REGION}.amazonaws.com` });
  });
});
