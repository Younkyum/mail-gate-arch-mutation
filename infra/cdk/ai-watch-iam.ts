/**
 * infra/cdk/ai-watch-iam.ts — AI 의심 메일 감시(ADR-0017 초안) 주체별 IAM 동작 · KMS 조건 상수. 계약(`src/inbound/ai-watch/contract.ts`)의 IAM 절이
 * 여기로 왔다 — `src/**` 에 KMS 복호 동작 이름 문자열을 두지 않기 위해서다(arch `keypair-immutability`). 주체별 설명은 계약 머리말의 "IAM" 주석.
 * 리소스 ARN 은 고정, 와일드카드 없음. CMK 허용문(inbound 역할 · Mac 사용자)에는 두 조건(서비스 + 요청 큐 ARN)을 반드시 건다.
 */

/** 모든 CMK 허용문에 거는 조건(값: 서비스 = `viaService`, 큐 ARN = 요청 큐 ARN). */
export const AI_WATCH_KMS_CONDITIONS = {
  viaServiceKey: 'kms:ViaService',
  viaService: 'sqs.ap-northeast-2.amazonaws.com',
  queueArnContextKey: 'kms:EncryptionContext:aws:sqs:arn',
} as const;

export const AI_WATCH_IAM_ACTIONS = {
  inboundRequestQueue: ['sqs:SendMessage'],
  inboundKms: ['kms:GenerateDataKey', 'kms:Decrypt'],
  resultLambdaResultQueue: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:ChangeMessageVisibility', 'sqs:GetQueueAttributes'],
  workerRequestQueue: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:ChangeMessageVisibility', 'sqs:GetQueueAttributes'],
  workerResultQueue: ['sqs:SendMessage'],
  workerKms: ['kms:Decrypt'],
} as const;
