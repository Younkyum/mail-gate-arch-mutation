/**
 * src/mail/transport/ses-transport.ts — **SES SDK 를 import 하는 유일한 파일** (AC-8 Layer A).
 *
 * 두 도구가 같은 명제를 이중으로 단언한다: `.dependency-cruiser.cjs` 의
 * `no-ses-sdk-outside-transport` 와 `test/arch/ses-import-boundary.arch.test.ts`.
 * 한 도구의 설정이 잘못되어 룰이 **아무 파일도 검사하지 않게 되는** 사고가 흔하기 때문이며,
 * 증명이 단일 설정에 의존하면 증명이 아니다(계획 §5.0 Layer A).
 *
 * 그리고 Layer B 가 역방향을 막는다 — **이 파일의 export 를 참조하는 프로덕션 파일은
 * `src/policy/gate.ts` 하나뿐이다.** 그래서 이 전송단은 조립 루트(`db/repositories/index.ts`)
 * 에서도 조립되지 않는다. 불편한 것이 아니라 **그것이 관문의 형태**다.
 *
 * ---
 *
 * **여기서 메일을 보내지 마라 — 코드가 있다는 것과 보낸다는 것은 다르다.**
 * SES 계정 한도는 **50,000통/일**이고(R22, 샌드박스가 2026-09-22 에 46초 만에 풀렸다),
 * 남은 제동장치는 `src/policy/rules/limits.ts` 의 워밍업 캡뿐이다(Day 1 = **20 수신자**).
 * 실발송은 리드가 `demo:p1b` 로 통제한다. 단위 테스트는 `SesSendClient` 에 가짜를 주입한다.
 */

import {
  SendEmailCommand,
  SESv2Client,
  type SendEmailCommandOutput,
} from '@aws-sdk/client-sesv2';

import { noopSendingClock, type SendingClock } from '../../db/repositories/sending-clock';
import type { OutboundTransport, TransportRequest } from '../../policy/gate';
import {
  ATMARK_MESSAGE_ID_TAG,
  ATMARK_NOTIFICATION_ID_TAG,
  isSesTagValue,
  SesTagValueError,
  toMessageIdTagValue,
} from '../events/tag';
import { assertMessageIdHeader } from '../message-id';
import { buildRawMessage, type MessageThreading, type RawAttachment } from '../mime/build';

/** 인바운드 수신 리전과 같다. 리전이 갈리면 DKIM·Configuration Set 이 따로 논다. */
export const SES_REGION = 'ap-northeast-2';

/**
 * 이미 배포된 Configuration Set. **지정을 빠뜨리면 bounce·complaint 이벤트가
 * 아무 데로도 가지 않는다** — `suppression_entries` 를 채우는 것이 그 이벤트이고,
 * 그것이 없으면 Stage 2(억제)는 영원히 빈 목록을 본다. 조용히 느슨해지는 종류의 누락이다.
 */
export const SES_CONFIGURATION_SET = 'atmark-default';

/** 렌더된 본문. 저장소는 S3 이고(PRD 제약), 어디서 읽는지는 구현이 정한다. */
export interface MessageContent {
  readonly subject: string;
  readonly text: string;
  /** `null` 이면 text/plain 단일 파트. */
  readonly html: string | null;
  /** 회신 헤더(`In-Reply-To`·`References`). 회신이 아니면 `null` (P3b). */
  readonly threading: MessageThreading | null;
  /** 첨부(메일 기본기 2차 A2) — 본문 출처가 영구본을 읽어 체크섬을 대조한 바이트. 없으면 첨부 없는 메일. */
  readonly attachments?: readonly RawAttachment[];
}

/**
 * 본문 출처. **worker-3 / P1c 가 S3 구현을 넣는다.**
 *
 * 전송단이 직접 S3 를 읽지 않는 이유: 그러면 이 파일이 SES 와 S3 두 SDK 를 함께 들고
 * 있게 되고, Layer A 가 지키는 "전송단은 한 가지 일만 한다" 가 흐려진다.
 */
export interface MessageContentSource {
  load(messageId: string): Promise<MessageContent>;
}

/**
 * SES 호출면. `SESv2Client` 전체가 아니라 이 한 메서드만 받는다 —
 * **단위 테스트가 네트워크 없이 돌아야 하고**, 그 요구가 인터페이스를 좁히는 이유다.
 */
export interface SesSendClient {
  send(command: SendEmailCommand): Promise<SendEmailCommandOutput>;
}

/**
 * 전송 결과.
 *
 * `OutboundTransport.send` 는 `{ sesMessageId }` 만 요구하지만, 여기서는
 * **`messageIdHeader` 도 함께 돌려준다** (§4.5-4). 호출자가 이 값을 그대로 저장하고
 * 재시도에 다시 넘겨야 수신측이 중복을 병합한다 — "전송 전에 생성된 값이 무엇이었는지"
 * 를 호출자가 결과에서 다시 확인할 수 있어야 그 규약이 코드로 닫힌다.
 */
export interface SesSendResult {
  readonly sesMessageId: string;
  readonly messageIdHeader: string;
}

/** 관문이 보는 면(`OutboundTransport`)보다 넓은 반환을 낸다. 대입은 그대로 성립한다. */
export interface SesTransport extends OutboundTransport {
  send(request: TransportRequest): Promise<SesSendResult>;
}

export interface SesTransportDependencies {
  readonly client: SesSendClient;
  readonly content: MessageContentSource;
  /** 최초 발송 성공 시점에 `organizations.sending_started_at` 을 1회 세팅한다 (§3.3 M7). */
  readonly sendingClock: SendingClock;
  readonly configurationSet: string;
  readonly now: () => Date;
}

/**
 * **raw MIME 의 헤더 `From` = 기대한 값, 글자 그대로** (2026-09-24 최종 검증 M3b). 세 발송면 전부가 SES 에 넘기기 직전에 부른다.
 * 기대값은 대개 `FromEmailAddress` 그 자체이고, 표시 이름이 붙는 한 통(환영 메일 — `"Onve (Atmark)" <onve@atmark.ai>`)은 그 헤더 값 전체다 —
 * 그때도 표시 이름 안의 주소가 `FromEmailAddress` 와 같다는 것은 `displayFromHeader` 가 먼저 본다(비교는 여전히 글자 그대로).
 *
 * IAM 의 `ses:FromAddress` 조건은 `FromEmailAddress` 를 본다. raw MIME 안의 `From` 헤더가 그 값과 달라도 SES 가 거부하는지는
 * AWS 문서가 말하지 않는다(ADR-0006 "M3b"). 그래서 우리 쪽에서 등식을 세운다: 조립한 raw 의 헤더 부분(첫 빈 줄 앞)에서 `From`
 * 필드를 **정확히 하나** 찾아(대소문자 무시, 접힌 줄 펼침) 그 값(앞뒤 공백 제거)이 `FromEmailAddress` 와 **글자 그대로** 같아야 한다.
 * 지금은 두 값이 같은 변수에서 나오므로 통과가 정상이다 — 이 검사는 조립 코드가 바뀌어 두 값이 갈라지는 날(표시 이름 추가,
 * 헤더 재정렬, 앞뒤 공백이 붙은 주소)을 전송 전에 잡는다. 어긋나면 **보내지 않고 던진다.**
 */
export function assertHeaderFromMatches(raw: string, expectedHeaderValue: string): void {
  const end = raw.indexOf('\r\n\r\n');
  const head = (end < 0 ? raw : raw.slice(0, end)).replace(/\r\n[ \t]/g, ' ');
  const values = head
    .split('\r\n')
    .filter((line) => /^from:/i.test(line))
    .map((line) => line.slice('from:'.length).trim());
  if (values.length !== 1 || values[0] !== expectedHeaderValue) {
    throw new Error(
      `헤더 From 이 기대한 값과 다르다 — 보내지 않는다 (From 필드 ${String(values.length)}개, 기대=${JSON.stringify(expectedHeaderValue)})`,
    );
  }
}

/**
 * 헤더 `From` 에 실을 값. 표시 이름이 없으면 주소 그대로. 있으면 **정확히** `"<이름>" <FromEmailAddress>` 모양만 받는다 — 이름은 인쇄 가능한
 * ASCII 1–64자(따옴표·역슬래시 없음 — 인용 문자열이 깨지지 않게, 인코딩된 낱말이 필요 없게), 꺾쇠 안의 주소는 `FromEmailAddress` 와 글자 그대로
 * 같다(IAM `ses:FromAddress` 가 보는 값과 받는 사람이 보는 주소가 갈라지지 않게). 어긋나면 보내지 않고 던진다.
 */
function displayFromHeader(fromAddress: string, fromHeader: string | undefined): string {
  if (fromHeader === undefined) return fromAddress;
  const match = /^"([\x20\x21\x23-\x5b\x5d-\x7e]{1,64})" <([^<>\s]+)>$/.exec(fromHeader);
  if (match === null || match[2] !== fromAddress) {
    throw new Error(`표시 이름 From 헤더는 "<이름>" <${fromAddress}> 모양이어야 한다 — 보내지 않는다`);
  }
  return fromHeader;
}

/** 실제 SES 클라이언트. **이 함수를 부르는 순간 AWS 자격증명이 필요하다.** */
export function createSesClient(region: string = SES_REGION): SesSendClient {
  const client = new SESv2Client({ region });
  return { send: (command) => client.send(command) };
}

/** 기본값을 채운 의존성. `client` 와 `content` 는 기본값이 없다 — 있으면 안 된다. */
export interface SesTransportOptions {
  readonly client: SesSendClient;
  readonly content: MessageContentSource;
  readonly sendingClock?: SendingClock;
  readonly configurationSet?: string;
  readonly now?: () => Date;
}

export function createSesTransport(options: SesTransportOptions): SesTransport {
  const deps: SesTransportDependencies = {
    client: options.client,
    content: options.content,
    sendingClock: options.sendingClock ?? noopSendingClock(),
    configurationSet: options.configurationSet ?? SES_CONFIGURATION_SET,
    now: options.now ?? (() => new Date()),
  };

  return {
    async send(request: TransportRequest): Promise<SesSendResult> {
      // **전송 전 검증.** 형식이 깨진 헤더는 SES 가 받아 줄 수도 있고 거부할 수도 있다 —
      // 받아 주면 DB 의 값과 실제로 나간 값이 갈라지고, 그 갈라짐은 AC-i3 를 조용히 깬다.
      const messageIdHeader = assertMessageIdHeader(request.messageIdHeader);

      // **전송 전 검증 그 둘째 — 조인 키** (ADR-0004).
      //
      // SES 는 `Message-ID` 를 덮어쓴다. 그래서 전송이 성공한 뒤 이 발송을 우리 행으로
      // 되돌리는 유일한 끈은 아래 `EmailTags` 에 싣는 이 값이고, 그것이 SES 의 태그 문자
      // 제약(`^[A-Za-z0-9_-]{1,256}$`)을 만족하지 않으면 **끈이 없는 채로 메일이 나간다.**
      // 그 상태에서 프로세스가 죽으면 lease 만료 시점에 "그 메일은 나갔는가" 에 답할
      // 방법이 다시 0이 된다. `messageIdHeader` 검증과 같은 이유로 여기서 끊는다.
      const messageIdTagValue = toMessageIdTagValue(request.messageId);

      const content = await deps.content.load(request.messageId);
      const sentAt = deps.now();

      const raw = buildRawMessage({
        fromAddress: request.fromAddress,
        recipients: request.recipients,
        subject: content.subject,
        messageIdHeader,
        date: sentAt,
        text: content.text,
        html: content.html,
        threading: content.threading,
        // 에이전트 메일은 Reply-To 를 쓰지 않는다 — 회신 주소를 요청이 정할 자리가 없다.
        replyTo: null,
        attachments: content.attachments ?? [],
      });
      assertHeaderFromMatches(raw, request.fromAddress);

      const output = await deps.client.send(
        new SendEmailCommand({
          FromEmailAddress: request.fromAddress,
          Destination: { ToAddresses: [...request.recipients] },
          ConfigurationSetName: deps.configurationSet,
          Content: { Raw: { Data: Buffer.from(raw, 'utf8') } },
          // **우리 `message_id` 를 싣는다** (ADR-0004 결정 1). Configuration Set 이
          // 발행하는 이벤트의 `mail.tags` 에 이 값이 그대로 돌아오므로, **SES 가 무엇을
          // 덮어쓰든 이벤트가 우리 행으로 되돌아온다.** `ConfigurationSetName` 과
          // 짝이다 — 하나만 있으면 둘 다 아무 일도 하지 않는다(이벤트가 발행되지
          // 않거나, 발행돼도 조인할 키가 없다).
          EmailTags: [{ Name: ATMARK_MESSAGE_ID_TAG, Value: messageIdTagValue }],
        }),
      );

      const sesMessageId = output.MessageId;
      if (sesMessageId === undefined || sesMessageId === '') {
        // 200 을 받았는데 id 가 없다 — 보냈는지 아닌지를 우리가 말할 수 없는 상태다.
        // 성공으로 치면 `messages` 행이 `sent` 인데 `ses_message_id` 가 없어 상태기계
        // CHECK 를 위반하고, 무엇보다 SES 이벤트를 이 발송에 연결할 키가 사라진다.
        throw new Error('SES 가 MessageId 없이 응답했다 — 발송 여부를 확정할 수 없다');
      }

      // **여기가 §3.3 M7 의 "최초 SES 발송 성공 시점" 이다.**
      // 실패를 삼키는 이유: 이 시점에 메일은 **이미 나갔다.** 여기서 던지면 관문이
      // `failed` 로 기록하고 호출자가 재시도해 **같은 메일이 두 번 나간다** —
      // 기준일 기록 실패가 중복 발송의 원인이 되는 것은 방향이 뒤집힌 것이다.
      // 기록에 실패하면 램프는 Day 1 캡(20 수신자)에 머문다 — 막히는 방향이라 안전하다.
      await deps.sendingClock.markFirstSend(request.messageId, sentAt).catch((error: unknown) => {
        console.error(
          `sending_started_at 세팅 실패 (messageId=${request.messageId}): ` +
            `${error instanceof Error ? error.message : String(error)}. ` +
            '워밍업 램프는 기준일이 생길 때까지 Day 1 캡에 머문다.',
        );
        return false;
      });

      return { sesMessageId, messageIdHeader };
    },
  };
}

// ---------------------------------------------------------------------------
// 소유자 승인 알림 — 관문을 지나지 않는 **두 번째** 발송면 (P2, §3.4 5조)
// ---------------------------------------------------------------------------

/**
 * 소유자 알림 한 통. **에이전트 메일이 아니다** — `messages` 행도 audit 행도 없고, 워밍업 캡을 먹지 않으며
 * `sending_started_at` 도 건드리지 않는다(알림이 에이전트의 램프를 시작시키면 안 된다).
 *
 * ★ **이 함수는 수신자·제목·본문을 인자로 받는다 — 그래서 아무나 부를 수 없다.** Layer B 가 이 파일의
 * export 를 참조할 수 있는 프로덕션 파일을 **이름으로** 둘로 못 박는다: 관문과 `src/notify/approval-notifier.ts`.
 * 그리고 그 알림 모듈의 공개 API 는 `approvalId` 하나만 받는다(수신자는 DB 의 `organizations.owner_email`).
 * 이 함수의 넓은 시그니처는 그 두 겹 안쪽에서만 존재한다 — 알림 경로가 에이전트 메일의 우회로가 되는
 * 것을 막는 것은 이 시그니처가 아니라 **이 함수에 닿을 수 있는 파일의 집합**이다
 * (`test/arch/gate-chokepoint.arch.test.ts`).
 */
export interface OwnerNotificationEmail {
  /** `approval_notifications.id`(uuid). SES 태그·`Message-ID` 의 재료다. */
  readonly notificationId: string;
  /** SES `FromEmailAddress`(IAM `ses:FromAddress` 가 보는 값). */
  readonly fromAddress: string;
  /**
   * 헤더 `From` 에 표시 이름을 붙일 때만 — `"<이름>" <fromAddress>` 모양 그대로(`displayFromHeader` 가 본다). 없으면 헤더는 주소 그대로다.
   * 채우는 것은 환영 · 대기자 명단 메일(`"Onve (Atmark)"`)과 notify@ 알림 셋(승인 · 도메인 · 격리 — `"Atmark"`)이다. 모두 모듈 상수 하나에서.
   */
  readonly fromHeader?: string;
  /** 정확히 1명. 소유자 알림에 수신자 목록은 없다. */
  readonly toAddress: string;
  readonly subject: string;
  /** text/plain 파트 — 늘 있다. */
  readonly text: string;
  /**
   * text/html 대안 파트(2026-09-28). 있으면 `multipart/alternative`(text/plain 이 먼저), 없으면 예전과 같은 text/plain 단일 파트.
   * HTML 은 링크 글자와 실제 href 를 갈라놓을 수 있는 표면이다 — 그래서 **공용 틀 `src/notify/mail-layout.ts` 가 만든 값만** 싣는다
   * (주 링크 하나 + 승인 알림만 버금 링크 하나 · 링크 아래 같은 href 의 원문 URL · 보간 값 이스케이프 · 원격 자원 0). 승인 알림도 2026-10-10 부터 이 틀을
   * 쓴다 — 에이전트가 고른 문자열(수신자 · 제목 · 첨부 이름)을 싣지 않게 바뀌었다. 문의 전달은 여전히 이 칸이 없다(`test/unit/notify/mail-html.test.ts`).
   */
  readonly html?: string;
}

export interface SesNotificationTransport {
  sendOwnerNotification(email: OwnerNotificationEmail): Promise<{ readonly sesMessageId: string }>;
}

export interface SesNotificationTransportOptions {
  readonly client: SesSendClient;
  readonly configurationSet?: string;
  readonly now?: () => Date;
}

/**
 * 알림 전송단. 에이전트 전송단(`createSesTransport`)과 **같은 Configuration Set** 을 쓴다 —
 * `atmark-default` 가 TLS REQUIRE 이고(`ses-stack.ts`), 알림 본문에는 **승인 권한 그 자체인 링크**가 실린다.
 * 평문 SMTP 구간으로 그 링크가 흐르면 경로 위의 누구나 요청을 승인할 수 있다.
 */
export function createSesNotificationTransport(options: SesNotificationTransportOptions): SesNotificationTransport {
  const configurationSet = options.configurationSet ?? SES_CONFIGURATION_SET;
  const now = options.now ?? (() => new Date());

  return {
    async sendOwnerNotification(email: OwnerNotificationEmail): Promise<{ readonly sesMessageId: string }> {
      if (!isSesTagValue(email.notificationId)) throw new SesTagValueError(email.notificationId);
      const messageIdHeader = assertMessageIdHeader(`<notify.${email.notificationId}@atmark.ai>`);
      const headerFrom = displayFromHeader(email.fromAddress, email.fromHeader);

      const raw = buildRawMessage({
        fromAddress: headerFrom,
        recipients: [email.toAddress],
        subject: email.subject,
        messageIdHeader,
        date: now(),
        text: email.text,
        html: email.html ?? null,
        threading: null,
        replyTo: null,
      });
      assertHeaderFromMatches(raw, headerFrom);

      const output = await options.client.send(
        new SendEmailCommand({
          FromEmailAddress: email.fromAddress,
          Destination: { ToAddresses: [email.toAddress] },
          ConfigurationSetName: configurationSet,
          Content: { Raw: { Data: Buffer.from(raw, 'utf8') } },
          EmailTags: [{ Name: ATMARK_NOTIFICATION_ID_TAG, Value: email.notificationId }],
        }),
      );

      const sesMessageId = output.MessageId;
      if (sesMessageId === undefined || sesMessageId === '') {
        throw new Error('SES 가 MessageId 없이 응답했다 — 알림 발송 여부를 확정할 수 없다');
      }
      return { sesMessageId };
    },
  };
}

// ---------------------------------------------------------------------------
// 문의 전달 — 관문을 지나지 않는 시스템 메일 (US-009, ADR-0009)
// ---------------------------------------------------------------------------

/**
 * 문의 전달 한 통. **에이전트 메일이 아니다**(`messages`·audit 행 없음, 워밍업 캡 없음, `sending_started_at` 무관).
 *
 * 알림면(`sendOwnerNotification`)과 다른 점은 `Reply-To` 하나다 — 운영자가 회신하면 원 발신자에게 바로 가야 한다. 그래서 면을
 * 따로 둔다: 알림면에 Reply-To 칸을 열면 로그인·가입·승인 알림 모듈도 그 칸을 쓸 수 있게 된다. 이 면을 쥐는 프로덕션 파일은
 * `src/notify/contact-forwarder.ts` 하나이고(Layer B 가 이름으로 본다), 그 모듈의 공개 API 는 `forwardId` 하나만 받는다 —
 * 수신자는 비밀(`atmark/contact-forward-to`)에서만 나온다.
 */
export interface ContactForwardEmail {
  /** `contact_forwards.id`(uuid). SES 태그(알림 태그 — 하드 바운스는 시스템 억제로 간다)·`Message-ID` 의 재료다. */
  readonly forwardId: string;
  readonly fromAddress: string;
  /** 정확히 1명(운영자). */
  readonly toAddress: string;
  /** 원 발신자 한 주소. `null` = Reply-To 없음(알림만 모드 — `ATMARK_CONTACT_ROUTING=agent_and_notify`, 회신은 Atmark 에서). */
  readonly replyToAddress: string | null;
  readonly subject: string;
  /** text/plain 만. */
  readonly text: string;
}

export interface SesContactForwardTransport {
  sendContactForward(email: ContactForwardEmail): Promise<{ readonly sesMessageId: string }>;
}

export function createSesContactForwardTransport(options: SesNotificationTransportOptions): SesContactForwardTransport {
  const configurationSet = options.configurationSet ?? SES_CONFIGURATION_SET;
  const now = options.now ?? (() => new Date());

  return {
    async sendContactForward(email: ContactForwardEmail): Promise<{ readonly sesMessageId: string }> {
      if (!isSesTagValue(email.forwardId)) throw new SesTagValueError(email.forwardId);
      const messageIdHeader = assertMessageIdHeader(`<contact.${email.forwardId}@atmark.ai>`);

      const raw = buildRawMessage({
        fromAddress: email.fromAddress,
        recipients: [email.toAddress],
        subject: email.subject,
        messageIdHeader,
        date: now(),
        text: email.text,
        html: null,
        threading: null,
        replyTo: email.replyToAddress,
      });
      assertHeaderFromMatches(raw, email.fromAddress);

      const output = await options.client.send(
        new SendEmailCommand({
          FromEmailAddress: email.fromAddress,
          Destination: { ToAddresses: [email.toAddress] },
          ConfigurationSetName: configurationSet,
          Content: { Raw: { Data: Buffer.from(raw, 'utf8') } },
          EmailTags: [{ Name: ATMARK_NOTIFICATION_ID_TAG, Value: email.forwardId }],
        }),
      );

      const sesMessageId = output.MessageId;
      if (sesMessageId === undefined || sesMessageId === '') {
        throw new Error('SES 가 MessageId 없이 응답했다 — 전달 여부를 확정할 수 없다');
      }
      return { sesMessageId };
    },
  };
}
