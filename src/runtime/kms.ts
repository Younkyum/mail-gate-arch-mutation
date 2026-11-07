/**
 * src/runtime/kms.ts — **KMS SDK 를 import 하는 유일한 파일.** 공개 면은 `createKmsDataKeyGenerator` 하나 —
 * `kms:GenerateDataKey` 만 한다(`Decrypt` 는 없다: 복호는 P6 signer 의 일, AC-e2).
 *
 * 쓰는 곳은 admin Lambda 의 프로비저닝(AWS custody, `passport/custody-aws.ts` 의 `DataKeyGenerator` 포트) 하나다.
 * 격리 규칙은 SES·S3·Secrets Manager 와 같다: 클라이언트 하나당 파일 하나, **파일 이름으로** 네트워크 송출 허용목록
 * (`test/arch/network-egress.arch.test.ts`)과 dependency-cruiser(`no-kms-sdk-outside-runtime-kms`)에 오른다.
 * CLI(`scripts/admin/custody.ts`)는 `src/**` 규칙 밖이라 자기 어댑터를 쓴다 — 같은 명령·같은 입력이다.
 */

import { GenerateDataKeyCommand, KMSClient } from '@aws-sdk/client-kms';

import type { DataKeyGenerator } from '../passport/custody-aws';

/** SDK 클라이언트의 `send` 중 여기서 쓰는 모양 — 테스트는 이 면만 가짜로 준다. */
export interface KmsDataKeyClient {
  send(command: GenerateDataKeyCommand): Promise<{ Plaintext?: Uint8Array | undefined; CiphertextBlob?: Uint8Array | undefined }>;
}

/** 실제 KMS. **부르는 순간 AWS 자격증명이 필요하다**(만들기만 해서는 네트워크를 타지 않는다). */
export function createKmsClient(region: string): KmsDataKeyClient {
  return new KMSClient({ region });
}

export function createKmsDataKeyGenerator(client: KmsDataKeyClient): DataKeyGenerator {
  return {
    async generateDataKey(input) {
      const output = await client.send(new GenerateDataKeyCommand({ KeyId: input.keyId, KeySpec: input.keySpec }));
      if (output.Plaintext === undefined || output.CiphertextBlob === undefined) {
        throw new Error('KMS GenerateDataKey 가 Plaintext/CiphertextBlob 을 돌려주지 않았다.');
      }
      return { plaintext: output.Plaintext, ciphertextBlob: output.CiphertextBlob };
    },
  };
}
