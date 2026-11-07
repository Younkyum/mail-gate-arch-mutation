/**
 * AtmarkSes — SES Configuration Set + 이벤트 파이프라인 (계획 §6 P0, §3.3 "Day-0 필수 작업")
 *
 * 이 스택이 만드는 것은 **발송 경로가 아니라 관측 경로**다. 발송 자체는 P1의
 * `src/mail/transport/ses-transport.ts`(AC-8 Layer A의 유일한 SES 접점)가 담당하고,
 * 여기서는 그 발송이 어떻게 됐는지를 기계가 읽을 수 있는 형태로 흘려보낸다.
 *
 * **도메인 identity는 이 스택에 없다.** `atmark.ai` 는 2026-09-22 콘솔에서 생성돼
 * Verified / DKIM Successful(Easy DKIM RSA-2048, ap-northeast-2) 상태이며,
 * `ses.EmailIdentity` 로 다시 선언하면 CloudFormation 이 같은 이름의 identity 를
 * 새로 만들려다 충돌한다. 추후 `cdk import` 로 스택에 편입할지 검토한다.
 * (검토 트리거: notify.atmark.ai 도입 — §3.3 Q2 — 시점에 identity 가 2개가 되면 그때)
 */

import * as cdk from 'aws-cdk-lib';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

/** Configuration Set 이름. `ses-transport.ts` 가 SendEmail 시 이 이름을 지정한다. */
export const CONFIGURATION_SET_NAME = 'atmark-default';

/** SES 이벤트가 흘러드는 SNS 토픽 이름. P1의 `src/workers/ses-event-consumer.ts` 가 구독한다. */
export const SES_EVENT_TOPIC_NAME = 'atmark-ses-events';

/** 소비자가 폴링하는 큐. `ses-event-consumer` 의 입력이다 (ADR-0004). */
export const SES_EVENT_QUEUE_NAME = 'atmark-ses-events';

/** 파싱 불가능한 건이 모이는 곳. 여기 쌓이는 것이 곧 배선이 바뀌었다는 신호다. */
export const SES_EVENT_DLQ_NAME = 'atmark-ses-events-dlq';

/**
 * 같은 건을 몇 번까지 재전달하는가.
 *
 * 소비자는 실패를 세 갈래로 구분한다(`ses-event-consumer.ts`): 파싱 불가(재전달해도
 * 같다) · 재전달(DB 실패) · 정상. 그러므로 여기 쌓이는 것은 **일시적 실패가 5회 연속
 * 났거나 소비자가 죽었거나** 둘 중 하나이고, 둘 다 사람이 봐야 하는 사건이다.
 */
export const SES_EVENT_MAX_RECEIVE_COUNT = 5;

/**
 * 큐 가시성(초) — 소비자(`atmark-ses-events`, 타임아웃 30s)의 **6배**(2026-09-24, 60 → 180).
 *
 * 소비자의 예약 동시성은 1 이고(연결 예산 — `compute-stack.ts` `RESERVED_CONCURRENCY` 머리말) SQS 이벤트 소스의 최대 동시성은 최소 2 라,
 * 두 배치가 겹치면 하나가 스로틀된다. Lambda 는 스로틀된 배치를 **가시성 창 안에서** 다시 부른다 — 창이 짧으면 메시지가 큐로 돌아가
 * 수신 횟수가 올라가고, 처리 오류가 한 번도 없었는데 DLQ(`SES_EVENT_MAX_RECEIVE_COUNT`)로 간다. AWS 안내(Lambda 개발자 안내서 "SQS 와
 * Lambda — 큐 구성")가 권하는 "함수 타임아웃의 6배 이상" 을 따른다. 대가: 소비자가 죽으면 그 배치가 3분 동안 보이지 않는다(이벤트는
 * 관측용이다 — 발송·수신을 막지 않는다). 테스트가 "≥ 6 × 타임아웃" 을 고정한다(`compute-stack.test.ts`).
 */
export const SES_EVENT_QUEUE_VISIBILITY_SECONDS = 180;

export class SesStack extends cdk.Stack {
  /** P1 워커·알람이 참조할 수 있도록 노출한다. */
  public readonly eventTopic: sns.Topic;
  public readonly configurationSet: ses.ConfigurationSet;
  /** `ses-event-consumer` 가 읽는 큐. */
  public readonly eventQueue: sqs.Queue;
  public readonly eventDeadLetterQueue: sqs.Queue;

  public constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // SES 이벤트 팬아웃 지점. 토픽을 두는 이유는 구독자가 하나가 아니기 때문이다 —
    // §3.3 모니터링 표가 bounce/complaint 집계(SQS→consumer)를 요구하고,
    // §4.5는 lease 만료 재전송 **직전에** 같은 이벤트 이력을 조회해 중복 발송을 막는다.
    this.eventTopic = new sns.Topic(this, 'SesEventTopic', {
      topicName: SES_EVENT_TOPIC_NAME,
      displayName: 'Atmark SES sending events',
      // 평문 HTTP publish 를 거부한다. 이 토픽에는 수신자 주소가 실려 흐르므로
      // (bounce 이벤트의 `bouncedRecipients`) 전송 구간 암호화를 선택 사항으로 두지 않는다.
      enforceSSL: true,
    });

    this.configurationSet = new ses.ConfigurationSet(this, 'DefaultConfigurationSet', {
      configurationSetName: CONFIGURATION_SET_NAME,
      // §3.3 모니터링 표의 bounce rate(경고 2% / 위험 4%)·complaint rate(0.08% / 0.2%)를
      // CloudWatch 지표로 얻는 유일한 경로다. 이것이 꺼져 있으면 알람을 걸 대상이 없다.
      reputationMetrics: true,
      // TLS 협상 실패 시 평문으로 떨어뜨리지 않고 발송을 포기한다.
      // 에이전트 메일은 사람의 사적 서신과 같은 등급으로 다룬다는 결정의 인프라 측 표현.
      tlsPolicy: ses.ConfigurationSetTlsPolicy.REQUIRE,
      // **이 configuration set 에서 engagement metrics(열람·클릭 추적)를 명시적으로 끈다.**
      // 계정 수준 VDM 이 콘솔에서 켜지더라도(CDK 밖) 이 설정이 이겨 이 configuration set 은 끈 채로 남는다
      // (계정 기본값에 기대지 않는다). HTML 본문의 href 에는 로그인/가입/초대 토큰이 fragment 로 실려 있다 —
      // 추적을 켜면 SES 가 그 링크를 리다이렉트로 다시 쓰고 픽셀을 심어, 토큰이 SES/awstrack.me 로그에 남는다.
      // 위 이벤트 목록에서 OPEN·CLICK 을 빼는 것과 같은 결정의 계정-우회 경로를 막는 표현.
      vdmOptions: { engagementMetrics: false },
    });

    this.configurationSet.addEventDestination('SnsEventDestination', {
      configurationSetEventDestinationName: 'atmark-ses-events-sns',
      destination: ses.EventDestination.snsTopic(this.eventTopic),
      // OPEN·CLICK 은 의도적으로 제외한다 — 추적 픽셀·링크 래핑을 켜야 나오는 이벤트이고,
      // 그것은 발신 도메인의 스팸 신호를 키운다(§3.3 프리모템 #2가 지키려는 placement).
      // SUBSCRIPTION 도 구독 관리 링크를 붙일 때 생기는 이벤트라 Phase 1 범위 밖이다.
      events: [
        // SEND: §4.5 4항 — 전송 성공 직후 프로세스가 죽은 경우를 판별하는 유일한 외부 증거.
        ses.EmailSendingEvent.SEND,
        // DELIVERY: delivery delay p95(§3.3 경고 60s / 위험 300s)의 분모.
        ses.EmailSendingEvent.DELIVERY,
        // BOUNCE / COMPLAINT: SES 계정 정지 기준(5% / 0.5%)에 걸리기 전에 멈추기 위한 신호.
        ses.EmailSendingEvent.BOUNCE,
        ses.EmailSendingEvent.COMPLAINT,
        // REJECT: 바이러스 판정 등으로 SES 가 수락 후 버린 건. bounce 로 잡히지 않는다.
        ses.EmailSendingEvent.REJECT,
        // RENDERING_FAILURE: 템플릿 발송 시 데이터 불일치. 조용히 사라지는 실패라 반드시 본다.
        ses.EmailSendingEvent.RENDERING_FAILURE,
        // DELIVERY_DELAY: 아직 실패가 아닌 지연. §4.5의 lease 만료 재전송 판단 입력이다 —
        // "지연 중"인 건을 재전송하면 그것이 곧 중복 발송이 된다.
        ses.EmailSendingEvent.DELIVERY_DELAY,
      ],
    });

    // -----------------------------------------------------------------------
    // 소비자의 입력 — 토픽만으로는 아무도 듣지 않는다 (ADR-0004)
    // -----------------------------------------------------------------------

    // **왜 SQS 를 끼우는가 (SNS→Lambda 직결이 아니라).**
    // SNS 의 재시도는 우리 눈에 보이지 않는다 — 실패가 어디에 쌓이는지도, 몇 건이
    // 남았는지도 콘솔 밖에서는 알 수 없다. 큐를 두면 깊이가 수치가 되고, DLQ 가
    // **"파싱할 수 없는 건" 을 눈에 보이는 더미로 만든다.** 소비자가 파싱 실패를 던지지
    // 않고 값으로 돌려주는 설계(`ses-event-consumer.ts` 규율 ②)가 성립하려면 그 더미가
    // 있어야 한다 — 없으면 poison pill 을 버리거나 영원히 재시도하거나 둘 중 하나다.
    this.eventDeadLetterQueue = new sqs.Queue(this, 'SesEventDeadLetterQueue', {
      queueName: SES_EVENT_DLQ_NAME,
      // 기본 4일은 주말 하나를 못 넘긴다. 금요일 저녁에 배선이 깨지면 월요일에 증거가 없다.
      retentionPeriod: cdk.Duration.days(14),
      enforceSSL: true,
    });

    this.eventQueue = new sqs.Queue(this, 'SesEventQueue', {
      queueName: SES_EVENT_QUEUE_NAME,
      // 소비자 한 건의 일은 파싱 + INSERT 하나다. 길이는 처리 시간이 아니라 스로틀 재시도 창이 정한다 — 위 상수의 머리말.
      visibilityTimeout: cdk.Duration.seconds(SES_EVENT_QUEUE_VISIBILITY_SECONDS),
      retentionPeriod: cdk.Duration.days(14),
      enforceSSL: true,
      deadLetterQueue: {
        queue: this.eventDeadLetterQueue,
        maxReceiveCount: SES_EVENT_MAX_RECEIVE_COUNT,
      },
    });

    // **`rawMessageDelivery` 를 켜지 않는다.** 파서(`mail/events/ses-event.ts`)는 봉투
    // 유무를 둘 다 받지만, 봉투에는 SNS 의 `MessageId`·`Timestamp` 가 들어 있어 조사
    // 시점에 "언제 팬아웃됐는가" 를 답한다. 그 값을 버려서 얻는 것은 바이트 몇 개다.
    this.eventTopic.addSubscription(new subscriptions.SqsSubscription(this.eventQueue));

    new cdk.CfnOutput(this, 'SesEventQueueUrl', {
      value: this.eventQueue.queueUrl,
      description: 'ses-event-consumer 가 폴링할 SQS 큐 URL',
    });

    new cdk.CfnOutput(this, 'SesEventDeadLetterQueueUrl', {
      value: this.eventDeadLetterQueue.queueUrl,
      description: '파싱 불가·연속 실패 건이 모이는 DLQ. 깊이 > 0 은 사람이 볼 사건이다.',
    });

    new cdk.CfnOutput(this, 'ConfigurationSetName', {
      value: this.configurationSet.configurationSetName,
      description: 'ses-transport.ts 가 SendEmail 에 지정할 Configuration Set 이름',
    });

    new cdk.CfnOutput(this, 'SesEventTopicArn', {
      value: this.eventTopic.topicArn,
      description: 'P1 ses-event-consumer 가 구독할 SNS 토픽 ARN',
    });
  }
}
