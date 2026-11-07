/**
 * src/runtime/sqs.ts — **SQS SDK 를 import 하는 유일한 파일**(WP-2 — 결제 웹훅 λ 의 FIFO `SendMessage`).
 *
 * 격리 규칙은 `secrets.ts`·`kms.ts` 와 같다: AWS SDK 클라이언트 하나당 파일 하나, 이 파일은 **이름으로** 네트워크 송출 허용목록
 * (`test/arch/network-egress.arch.test.ts`)에 오르고 `.dependency-cruiser.cjs` `no-sqs-sdk-outside-runtime-sqs` 가 한 번 더 막는다(변이 BL-2).
 * 공개 면은 FIFO 보내기와 표준 큐 보내기(AI 감시 요청 큐) 둘이다 — 받기·지우기(소비)는 Lambda 이벤트 소스 매핑이 하므로 코드에 없다.
 * FIFO 면은 중복 제거 id·그룹 id 를 **필수 인자**로 받는다(표준 큐로 잘못 보내는 길이 타입에 없다). 표준 면은 큐 URL 을 만들 때 묶는다.
 */

import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';

/** FIFO 큐에 메시지 하나. 조립 루트가 보는 면 — 테스트는 가짜를 준다. */
export interface FifoQueueSender {
  sendFifo(input: {
    readonly queueUrl: string;
    readonly body: string;
    readonly groupId: string;
    readonly deduplicationId: string;
  }): Promise<void>;
}

/** 실제 SQS. **부르는 순간 자격증명이 필요하다**(부르기만 해서는 네트워크를 타지 않는다). */
export function createSqsFifoSender(region: string): FifoQueueSender {
  const client = new SQSClient({ region });
  return {
    async sendFifo(input) {
      await client.send(
        new SendMessageCommand({
          QueueUrl: input.queueUrl,
          MessageBody: input.body,
          MessageGroupId: input.groupId,
          MessageDeduplicationId: input.deduplicationId,
        }),
      );
    },
  };
}

/** 표준 큐 보내기의 요청 타임아웃(ms) · 시도 횟수(첫 시도 포함). */
export const AI_WATCH_SQS_REQUEST_TIMEOUT_MS = 2_000;
export const AI_WATCH_SQS_MAX_ATTEMPTS = 2;

/**
 * 표준 큐에 메시지 하나 — AI 의심 메일 감시 요청 큐(`atmark-ai-watch-req`, ADR-0017 초안)만 쓴다. inbound λ 의 조립 루트가 만들고, 큐 URL 은
 * 조립 루트가 묶는다(호출자는 본문만 넘긴다 — 다른 큐로 보낼 길이 면에 없다). 메시지 속성 없음(계약 `contract.ts`).
 */
export interface StandardQueueSender {
  send(body: string): Promise<void>;
}

/** 실제 SQS(표준 큐 하나에 묶음). **부르는 순간 자격증명이 필요하다.** */
export function createSqsStandardSender(region: string, queueUrl: string): StandardQueueSender {
  // 커밋 뒤 수신 λ 안에서 부른다 — SQS 가 느려도 수신 배치를 붙잡지 않게 짧게 끊는다(보안 리뷰 L6). 실패는 호출자가 fail-skip 으로 받는다.
  const client = new SQSClient({ region, maxAttempts: AI_WATCH_SQS_MAX_ATTEMPTS, requestHandler: { requestTimeout: AI_WATCH_SQS_REQUEST_TIMEOUT_MS } });
  return {
    async send(body) {
      await client.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: body }));
    },
  };
}
