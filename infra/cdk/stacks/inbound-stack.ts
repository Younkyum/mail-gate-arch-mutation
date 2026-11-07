/**
 * AtmarkInbound — SES 이메일 **수신** 파이프라인 (계획 §6 P3a).
 *
 *   MX(atmark.ai · verified 고객 도메인) → SES receipt rule set `atmark-inbound`(활성)
 *     → 규칙 `atmark-agent-mail`: 스팸·바이러스 스캔 → S3 액션(원문을 `inbound/raw/{SES messageId}` 에)
 *       → S3 액션의 SNS 알림(`atmark-inbound-mail`) → SQS(`atmark-inbound-mail`, DLQ)
 *         → `src/workers/inbound-consumer.ts`
 *
 * **MX 레코드는 여기 없다** — DNS 는 배포 단계의 일이고, MX 가 생기기 전에는
 * 이 스택이 배포돼 있어도 메일이 한 통도 들어오지 않는다(아래 "활성화" 참조).
 *
 * ---
 *
 * **판단 기록**
 *
 * - **수신 대상 = 이 계정·리전의 verified 도메인 전부(규칙에 `recipients` 없음 — ADR-0014 M5, 2026-10).** 에이전트 주소는
 *   런타임에 프로비저닝되므로 주소를 규칙에 나열하면 에이전트를 만들 때마다 인프라 배포가 필요하다 — 고객 도메인도 같다(domain-control 이
 *   identity 를 만들고 verified 가 되는 시점은 런타임이다). SES 의미: "If this field is not specified, this rule matches all recipients
 *   on all verified domains"(API `ReceiptRule.Recipients`). 그래서 문지기는 규칙이 아니라 **소비자**다 — 봉투 수신자를 `agent_addresses`
 *   와 대조하고(모르는 주소 = `unknown_recipient`), 고객 도메인 주소는 같은 조직의 `custom_domains` 행이 받을 수 있는 상태일 때만 받는다
 *   (아니면 `domain_not_active`) — 둘 다 **원문을 읽기 전에** 결말만 남긴다(`src/workers/inbound-consumer.ts` `consumeAgentRecipients` ·
 *   `src/db/repositories/inbound-store.ts` `findAgentsByAddresses`). 실제 스위치는 여전히 MX 다: 고객이 자기 도메인 MX 를
 *   `inbound-smtp.{region}` 으로 돌리기 전에는 그 도메인 메일이 SES 에 오지 않는다. M1~M4 동안은 `[INBOUND_DOMAIN]` 이었다(고객 도메인 제외).
 * - **활성화를 스택이 한다 (`SetActiveReceiptRuleSet` 커스텀 리소스).** 활성 rule set 은 **리전당 하나**다.
 *   이 계정·리전은 수신을 쓴 적이 없다고 알려져 있다(MX 없음) — **AWS 로 확인하지 않았다**(이 작업은 AWS 호출 금지).
 *   활성화를 사람 손(콘솔)에
 *   남기면 "배포는 됐는데 규칙이 비활성" 이 조용한 고장이 된다: SES 는 활성 rule set 이 없으면 메일을 받지 않고,
 *   그 사실은 첫 수신이 오지 않을 때에야 드러난다. 대가는 둘이다 — ① 다른 rule set 이 이미 활성이면 **그것을
 *   대체한다**(배포 전 `aws ses describe-active-receipt-rule-set` 로 비어 있음을 확인하라 — 배포 런북에 넣을 항목), ② 스택 삭제 시
 *   활성 rule set 을 **해제**한다(활성 상태의 rule set 은 삭제되지 않으므로 해제가 삭제의 전제다).
 *   활성화 자체는 무해하다: MX 가 없으면 SES 로 오는 메일이 없다. **MX 가 실제 스위치다.**
 * - **스캔 켬(`scanEnabled`).** 판정은 알림의 `spamVerdict`·`virusVerdict` 로 오고, 규칙이 메일을 버리지는
 *   않는다 — 버림은 소비자의 결정이다(바이러스 = 파싱하지 않고 결말만, 스팸 = 저장 + 판정 기록).
 *   규칙에서 버리면(Stop/Bounce 액션 + Lambda 판정) "왜 안 왔는가" 의 기록이 SES 밖에 남지 않는다.
 * - **TLS 는 Optional.** 수신 측 TLS 강제는 발신자를 인증하지 않는다(그것은 DMARC 의 일이다). 강제하면 평문
 *   전송하는 소수의 가입 확인 메일(AC-3)이 SMTP 단계에서 거절되고, 그 거절은 우리 쪽 어디에도 기록되지 않는다.
 * - **S3 액션의 KMS 없음.** receipt rule 의 `KmsKeyArn` 은 SSE-KMS 가 아니라 **클라이언트측 암호화**다
 *   (`storage-stack.ts` 머리말). 버킷 기본 SSE-S3 로 저장 시 암호화된다.
 * - **버킷은 이름으로 가져온다(`fromBucketName`).** 구체 버킷 객체를 넘기면 S3 액션이 저장소 스택의 버킷 정책에
 *   문장을 더하고(그 문장이 이 스택의 규칙 ARN 을 참조) 두 스택이 서로를 참조하는 순환이 된다. SES 쓰기 권한은
 *   저장소 스택이 이미 갖고 있다(`inbound/raw/*`, SourceAccount + SourceArn). 버킷 이름 참조가 스택 간
 *   의존(저장소 → 수신)을 만들어 배포 순서도 맞는다.
 * - **SNS 는 봉투를 벗기지 않는다(`rawMessageDelivery` 꺼짐)** — `ses-stack.ts` 와 같은 이유. 파서(`receipt.ts`)는
 *   둘 다 받는다.
 * - **가시성 타임아웃 5분.** 한 건의 일은 S3 원문(최대 40 MiB) 읽기 + 파싱 + 첨부 쓰기 + DB 트랜잭션이다.
 *   소비자 컴퓨트(Lambda)의 타임아웃은 이보다 짧아야 한다 — 그 스택이 생길 때 맞춘다.
 */

import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as actions from 'aws-cdk-lib/aws-ses-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as cr from 'aws-cdk-lib/custom-resources';
import type { Construct } from 'constructs';

import { INBOUND_RAW_PREFIX } from './storage-stack';
import { denySesSendingInStack } from './ses-send-deny';

/** 수신 도메인. 에이전트 주소가 사는 곳이다. */
export const INBOUND_DOMAIN = 'atmark.ai';

export const INBOUND_RULE_SET_NAME = 'atmark-inbound';
export const INBOUND_RULE_NAME = 'atmark-agent-mail';
export const INBOUND_TOPIC_NAME = 'atmark-inbound-mail';
export const INBOUND_QUEUE_NAME = 'atmark-inbound-mail';
export const INBOUND_DLQ_NAME = 'atmark-inbound-mail-dlq';

/** `ses-stack.ts` 의 `SES_EVENT_MAX_RECEIVE_COUNT` 와 같은 근거 — 일시 장애 5회 연속 = 사람이 볼 사건. */
export const INBOUND_MAX_RECEIVE_COUNT = 5;

export const INBOUND_VISIBILITY_TIMEOUT_SECONDS = 300;

export interface InboundStackProps extends cdk.StackProps {
  /** `StorageStack.mailBucket.bucketName`. 원문이 떨어지는 곳. */
  readonly mailBucketName: string;
}

export class InboundStack extends cdk.Stack {
  public readonly ruleSet: ses.ReceiptRuleSet;
  public readonly topic: sns.Topic;
  public readonly queue: sqs.Queue;
  public readonly deadLetterQueue: sqs.Queue;

  public constructor(scope: Construct, id: string, props: InboundStackProps) {
    super(scope, id, props);
    // 발송하지 않는 역할 전부에 SES 발송 명시 Deny(ADR-0014 단계 2 · 재검증 INFO — `ses-send-deny.ts`, 비용 0).
    denySesSendingInStack(this);

    const bucket = s3.Bucket.fromBucketName(this, 'MailStoreBucket', props.mailBucketName);

    this.topic = new sns.Topic(this, 'InboundMailTopic', {
      topicName: INBOUND_TOPIC_NAME,
      displayName: 'Atmark inbound mail (SES receipt S3 action notifications)',
      // 알림에 봉투 주소·헤더가 실린다. 전송 구간 암호화를 선택 사항으로 두지 않는다.
      enforceSSL: true,
    });

    // SES 가 이 토픽에 publish 할 수 있게 — **이 계정의 receipt rule 로만**(confused deputy).
    // 저장소 스택의 버킷 정책과 같은 조건 형태다.
    this.topic.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowSesReceiptRulePublish',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('ses.amazonaws.com')],
        actions: ['sns:Publish'],
        resources: [this.topic.topicArn],
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          ArnLike: {
            'aws:SourceArn': `arn:aws:ses:${this.region}:${this.account}:receipt-rule-set/${INBOUND_RULE_SET_NAME}:receipt-rule/*`,
          },
        },
      }),
    );

    this.deadLetterQueue = new sqs.Queue(this, 'InboundMailDeadLetterQueue', {
      queueName: INBOUND_DLQ_NAME,
      retentionPeriod: cdk.Duration.days(14),
      enforceSSL: true,
    });

    this.queue = new sqs.Queue(this, 'InboundMailQueue', {
      queueName: INBOUND_QUEUE_NAME,
      visibilityTimeout: cdk.Duration.seconds(INBOUND_VISIBILITY_TIMEOUT_SECONDS),
      retentionPeriod: cdk.Duration.days(14),
      enforceSSL: true,
      deadLetterQueue: { queue: this.deadLetterQueue, maxReceiveCount: INBOUND_MAX_RECEIVE_COUNT },
    });

    this.topic.addSubscription(new subscriptions.SqsSubscription(this.queue));

    this.ruleSet = new ses.ReceiptRuleSet(this, 'InboundRuleSet', {
      receiptRuleSetName: INBOUND_RULE_SET_NAME,
    });

    const rule = this.ruleSet.addRule('AgentMailRule', {
      receiptRuleName: INBOUND_RULE_NAME,
      enabled: true,
      // recipients 없음 = 이 리전의 verified 도메인 전부(머리말). 규칙 이름·construct id 를 바꾸지 않는다 — CFN `Rule.Recipients` 는
      //   "No interruption" 갱신이고 `Rule.Name`·`RuleSetName` 만 교체다(교체면 규칙이 지워졌다 다시 생기는 사이 수신이 빈다).
      scanEnabled: true,
      tlsPolicy: ses.TlsPolicy.OPTIONAL,
      actions: [
        new actions.S3({
          bucket,
          objectKeyPrefix: INBOUND_RAW_PREFIX,
          topic: this.topic,
        }),
      ],
    });

    // 가져온 버킷이라 CDK 가 권한을 붙이지 않는다는 경고 — 의도다(머리말 "버킷은 이름으로 가져온다").
    // 권한은 저장소 스택의 `AllowSesReceiptRuleWriteInboundRaw` 이고 test/unit/storage/storage-stack.test.ts 가 단언한다.
    cdk.Annotations.of(rule).acknowledgeWarning(
      '@aws-cdk/s3:AddBucketPermissions',
      'SES 쓰기 권한은 AtmarkStorage 버킷 정책(inbound/raw/*, SourceAccount+SourceArn)이 이미 준다',
    );

    // 활성화 — 머리말 "활성화를 스택이 한다". SES v1 API 다(수신은 v2 에 없다).
    const activation = new cr.AwsCustomResource(this, 'ActivateInboundRuleSet', {
      onCreate: {
        service: 'SES',
        action: 'setActiveReceiptRuleSet',
        parameters: { RuleSetName: INBOUND_RULE_SET_NAME },
        physicalResourceId: cr.PhysicalResourceId.of(`${INBOUND_RULE_SET_NAME}-active`),
      },
      onUpdate: {
        service: 'SES',
        action: 'setActiveReceiptRuleSet',
        parameters: { RuleSetName: INBOUND_RULE_SET_NAME },
        physicalResourceId: cr.PhysicalResourceId.of(`${INBOUND_RULE_SET_NAME}-active`),
      },
      // 이름 없이 부르면 활성 rule set 을 해제한다. 활성인 채로는 rule set 을 지울 수 없다.
      onDelete: {
        service: 'SES',
        action: 'setActiveReceiptRuleSet',
        parameters: {},
      },
      // 이 API 는 리소스 수준 권한이 없다. 액션 하나로만 좁힌다(발송 권한 아님 — Layer E 무관).
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({ actions: ['ses:SetActiveReceiptRuleSet'], resources: ['*'] }),
      ]),
      // 배포 시 npm 에서 SDK 를 받지 않는다 — 외부 네트워크에 기대는 배포 단계를 만들지 않는다.
      installLatestAwsSdk: false,
    });
    activation.node.addDependency(this.ruleSet);

    new cdk.CfnOutput(this, 'InboundQueueUrl', {
      value: this.queue.queueUrl,
      description: 'inbound-consumer 가 폴링할 SQS 큐 URL',
    });
    new cdk.CfnOutput(this, 'InboundDeadLetterQueueUrl', {
      value: this.deadLetterQueue.queueUrl,
      description: '연속 일시 장애·파싱 불가 알림이 모이는 DLQ. 깊이 > 0 은 사람이 볼 사건이다.',
    });
    new cdk.CfnOutput(this, 'InboundRuleSetName', {
      value: this.ruleSet.receiptRuleSetName,
      description: '활성 receipt rule set (리전당 하나)',
    });
    new cdk.CfnOutput(this, 'InboundMxRecord', {
      value: `10 inbound-smtp.${this.region}.amazonaws.com`,
      description: `${INBOUND_DOMAIN} 에 게시할 MX 값 — **배포 단계에서 사람이 DNS(Cloudflare)에 넣는다.** 이 스택은 만들지 않는다.`,
    });
  }
}
