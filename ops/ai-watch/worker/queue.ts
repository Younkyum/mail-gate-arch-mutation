/**
 * ops/ai-watch/worker/queue.ts — SQS 두 큐(요청 받기 · 결과 보내기). IAM 사용자 `atmark-ai-watch` 의 권한과 1:1:
 * 요청 큐 Receive/Delete(+ ChangeVisibility · GetQueueAttributes — 지금은 안 씀) · 결과 큐 SendMessage. 다른 API 를 부르지 않는다.
 *
 * 자격 증명은 `main.ts` 가 넘긴다(키체인 → 래퍼 → FD 3). 환경 변수·파일·`~/.aws` 를 읽지 않는다 — 기본 자격 증명 체인을 쓰지 않는다.
 */

import { DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';

import type { ReceivedMessage, WorkQueue } from './core';

/** long poll(설계 §1 — Mac 이 당겨 간다). SQS 상한 20초. */
const RECEIVE_WAIT_SECONDS = 20;
/** 한 번에 받는 수. 건당 p95 ~110ms 라 10건도 가시성 15초 안에 끝난다. */
const RECEIVE_MAX_MESSAGES = 10;

export interface QueueConfig {
  readonly region: string;
  readonly requestQueueUrl: string;
  readonly resultQueueUrl: string;
  readonly credentials: { readonly accessKeyId: string; readonly secretAccessKey: string };
  /** 시험 전용 루프백 엔드포인트(`config.ts`). 운영은 null — SDK 기본(sqs.ap-northeast-2.amazonaws.com). */
  readonly endpoint?: string | null;
}

export function createSqsWorkQueue(config: QueueConfig): WorkQueue {
  const client = new SQSClient({
    region: config.region,
    credentials: { accessKeyId: config.credentials.accessKeyId, secretAccessKey: config.credentials.secretAccessKey },
    maxAttempts: 3,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
  });
  return {
    async receive(signal) {
      const out = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: config.requestQueueUrl,
          MaxNumberOfMessages: RECEIVE_MAX_MESSAGES,
          WaitTimeSeconds: RECEIVE_WAIT_SECONDS,
          MessageSystemAttributeNames: ['SentTimestamp'],
        }),
        { abortSignal: signal },
      );
      return (out.Messages ?? []).flatMap((message): ReceivedMessage[] => {
        if (message.Body === undefined || message.ReceiptHandle === undefined) return [];
        const sent = Number(message.Attributes?.SentTimestamp);
        return [{ body: message.Body, receiptHandle: message.ReceiptHandle, sentTimestampMs: Number.isFinite(sent) ? sent : null }];
      });
    },
    async deleteRequest(receiptHandle) {
      await client.send(new DeleteMessageCommand({ QueueUrl: config.requestQueueUrl, ReceiptHandle: receiptHandle }));
    },
    async sendResult(body) {
      await client.send(new SendMessageCommand({ QueueUrl: config.resultQueueUrl, MessageBody: body }));
    },
  };
}
