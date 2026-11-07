/**
 * src/domains/dc-kms-signer.ts — Domain Connect 적용 URL 서명(KMS). **이 키로 KMS `Sign`·`GetPublicKey` 를 부르는 유일한 파일**
 * (`test/arch/transparency-log.arch.test.ts` · `network-egress` 허용 목록 · `.dependency-cruiser.cjs`).
 *
 * 키: KMS `RSA_2048` · `SIGN_VERIFY` · 알고리즘 `RSASSA_PKCS1_V1_5_SHA_256` · `MessageType: RAW`(KMS 가 SHA-256 을 잰다 — 4KB 상한).
 * 개인키는 KMS 밖으로 나오지 않는다. 주체는 admin λ 역할 하나(IAM · 키 정책 Deny — `infra/cdk/stacks/compute-stack.ts`).
 * 받은 서명은 공개키로 한 번 검증한 뒤에야 돌려준다 — 엉뚱한 키·알고리즘이 업체에서 "서명 틀림" 으로 사용자를 막지 않게.
 * 서명하는 문자열은 `dc-url.ts` 가 DB 행에서만 만든다(서명 오라클 아님).
 */

import { createPublicKey, verify, type KeyObject } from 'node:crypto';

import { GetPublicKeyCommand, KMSClient, SignCommand } from '@aws-sdk/client-kms';

import type { DcSigner } from './dc-url';

const DC_SIGNING_ALGORITHM = 'RSASSA_PKCS1_V1_5_SHA_256';
const DC_KEY_SPEC = 'RSA_2048';

/** KMS 의 `send` 면 — 테스트는 이 면만 가짜로 준다. */
export interface DcKmsClient {
  send(command: SignCommand): Promise<{ Signature?: Uint8Array | undefined }>;
  send(command: GetPublicKeyCommand): Promise<{ PublicKey?: Uint8Array | undefined; KeySpec?: string | undefined; KeyUsage?: string | undefined }>;
}

export function createDcKmsClient(region: string): DcKmsClient {
  return new KMSClient({ region }) as unknown as DcKmsClient;
}

export class DcSigningError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'DcSigningError';
  }
}

/** 공개키(SPKI DER) — 키 모양까지 확인한다. `scripts/admin/dc-pubkey.ts` 도 이것을 쓴다. */
export async function dcPublicKeySpki(kms: DcKmsClient, keyArn: string): Promise<Buffer> {
  const response = await kms.send(new GetPublicKeyCommand({ KeyId: keyArn }));
  if (response.KeySpec !== DC_KEY_SPEC) throw new DcSigningError('kms_key_spec_mismatch');
  if (response.KeyUsage !== 'SIGN_VERIFY') throw new DcSigningError('kms_key_usage_mismatch');
  if (response.PublicKey === undefined) throw new DcSigningError('kms_public_key_missing');
  return Buffer.from(response.PublicKey);
}

export function createKmsDcSigner(kms: DcKmsClient, keyArn: string): DcSigner {
  if (!/^arn:aws[a-z-]*:kms:/.test(keyArn)) throw new DcSigningError('kms_key_arn_required');
  let publicKey: Promise<KeyObject> | undefined;
  return {
    async sign(message: Buffer): Promise<Buffer> {
      if (message.length === 0 || message.length > 4096) throw new DcSigningError('kms_raw_message_size');
      // 실패한 읽기는 캐시하지 않는다(다음 요청이 다시 읽는다).
      publicKey ??= dcPublicKeySpki(kms, keyArn)
        .then((spki) => createPublicKey({ key: spki, format: 'der', type: 'spki' }))
        .catch((error: unknown) => {
          publicKey = undefined;
          throw error;
        });
      const response = await kms.send(new SignCommand({ KeyId: keyArn, Message: message, MessageType: 'RAW', SigningAlgorithm: DC_SIGNING_ALGORITHM }));
      if (response.Signature === undefined || response.Signature.length !== 256) throw new DcSigningError('kms_signature_shape');
      const signature = Buffer.from(response.Signature);
      if (!verify('sha256', message, await publicKey, signature)) throw new DcSigningError('kms_signature_unverified');
      return signature;
    },
  };
}
