/**
 * src/runtime/cloudfront.ts — **CloudFront SDK 를 import 하는 유일한 파일.** 공개 면은 `createCloudFrontInvalidator` 하나 —
 * `cloudfront:CreateInvalidation` 만 한다(배포 설정 변경·삭제 없음).
 *
 * 쓰는 곳은 서명 Lambda(`atmark-passport-signer`) 하나다: 재서명·정지·폐기는 5분(`max-age=300`)을 기다리면 안 된다(§4B.1b —
 * "정지된 에이전트가 5분간 published 로 보이는" 창을 닫는다). 격리 규칙은 SES·S3·Secrets Manager·KMS 와 같다: 클라이언트 하나당
 * 파일 하나, **파일 이름으로** 네트워크 송출 허용목록(`test/arch/network-egress.arch.test.ts`)과 dependency-cruiser
 * (`no-cloudfront-sdk-outside-runtime-cloudfront`)에 오른다. IAM 은 identity 배포 하나에 대한 CreateInvalidation 만 준다.
 *
 * **멱등.** `CallerReference` 를 호출자가 준다(게시 요청 id) — 같은 요청을 재시도하면 CloudFront 가 새 무효화를 만들지 않고 같은 것을
 * 돌려준다. 무효화 수(월 1,000 경로 무료)를 재시도가 갉아먹지 않는다.
 */

import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';

/** SDK 클라이언트의 `send` 중 여기서 쓰는 모양 — 테스트는 이 면만 가짜로 준다. */
export interface CloudFrontInvalidationClient {
  send(command: CreateInvalidationCommand): Promise<{ Invalidation?: { Id?: string | undefined } | undefined }>;
}

/** 실제 CloudFront(전역 서비스 — 엔드포인트는 us-east-1). **부르는 순간 AWS 자격증명이 필요하다.** */
export function createCloudFrontClient(): CloudFrontInvalidationClient {
  return new CloudFrontClient({ region: 'us-east-1' });
}

/** 무효화 면 — 서명 Lambda(`src/passport/publisher.ts`)가 받는다. */
export interface CdnInvalidator {
  invalidate(paths: readonly string[], callerReference: string): Promise<void>;
}

/** 한 번에 무효화할 경로 상한 — 서명 워커는 둘을 보낸다: 에이전트 하나의 문서 셋(`/agents/{id}/*`) + 공개 API 와일드카드(`/v1/identity/*`). */
export const MAX_INVALIDATION_PATHS = 10;

export function createCloudFrontInvalidator(client: CloudFrontInvalidationClient, distributionId: string): CdnInvalidator {
  if (!/^[A-Z0-9]{8,32}$/.test(distributionId)) throw new Error('CloudFront 배포 ID 형식이 아니다.');
  return {
    async invalidate(paths: readonly string[], callerReference: string): Promise<void> {
      if (paths.length === 0 || paths.length > MAX_INVALIDATION_PATHS) throw new Error(`무효화 경로는 1~${String(MAX_INVALIDATION_PATHS)}개다.`);
      for (const path of paths) if (!path.startsWith('/')) throw new Error('무효화 경로는 / 로 시작한다.');
      await client.send(
        new CreateInvalidationCommand({
          DistributionId: distributionId,
          InvalidationBatch: { CallerReference: callerReference, Paths: { Quantity: paths.length, Items: [...paths] } },
        }),
      );
    },
  };
}
