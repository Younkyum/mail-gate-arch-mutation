/**
 * src/tlog/checkpoint-signer.ts — ★ **투명성 로그의 KMS `Sign` 을 부르는 유일한 파일** (ADR-0008 §2.4 · A-T4).
 *
 * 두 키, 두 주체:
 *   - 체크포인트 키 — KMS `ECC_NIST_EDWARDS25519`, `ED25519_SHA_512` + `MessageType: RAW`(AWS KMS Sign API, 2026-09-24 확인 —
 *     Ed25519 순수 서명은 RAW 만 받는다). 주체는 `atmark-runtime-transparency-log` 하나(키 정책 Deny + IAM).
 *   - 앵커 키 — KMS `ECC_NIST_P256`, `ECDSA_SHA_256` + `MessageType: DIGEST`. Rekor v2 `hashedrekord` 용(`signing.ts` 머리말).
 *     주체는 `atmark-runtime-transparency-anchor` 하나(키 정책 Deny + IAM — 함수·역할이 따로다, 2026-09-24 M5).
 * 두 키 모두 **비추출**이다 — KMS 비대칭 키의 개인키는 KMS 밖으로 나오지 않고(AWS 문서 "never leaves AWS KMS unencrypted"),
 * 키 자료 출처는 `AWS_KMS`(가져온 키가 아니다 — 가져온 키는 사본이 밖에 있다). 인프라 테스트가 `Origin`·`MultiRegion` 을 본다.
 *
 * 이 파일은 서명 **결과만** 돌려준다. 받은 서명은 공개키로 한 번 더 검증한 뒤에야 쓴다(`epoch.ts`) — KMS 가 엉뚱한 키로 서명한
 * 사고가 공개 체크포인트로 나가지 않게.
 */

import { createPublicKey } from 'node:crypto';

import { GetPublicKeyCommand, KMSClient, SignCommand } from '@aws-sdk/client-kms';

import { TlogSigningError, type AnchorSigner, type NoteSigner } from './signing';

/** KMS 의 `send` 면 — 테스트는 이 면만 가짜로 준다. */
export interface TlogKmsClient {
  send(command: SignCommand): Promise<{ Signature?: Uint8Array | undefined; SigningAlgorithm?: string | undefined }>;
  send(command: GetPublicKeyCommand): Promise<{ PublicKey?: Uint8Array | undefined; KeySpec?: string | undefined; KeyUsage?: string | undefined }>;
}

export function createTlogKmsClient(region: string): TlogKmsClient {
  return new KMSClient({ region }) as unknown as TlogKmsClient;
}

async function spkiOf(kms: TlogKmsClient, keyArn: string, expectedSpec: string): Promise<Buffer> {
  const response = await kms.send(new GetPublicKeyCommand({ KeyId: keyArn }));
  if (response.KeySpec !== expectedSpec) throw new TlogSigningError('kms_key_spec_mismatch');
  if (response.KeyUsage !== 'SIGN_VERIFY') throw new TlogSigningError('kms_key_usage_mismatch');
  if (response.PublicKey === undefined) throw new TlogSigningError('kms_public_key_missing');
  return Buffer.from(response.PublicKey);
}

/** 체크포인트 서명기(Ed25519, KMS). 공개키는 첫 호출에서 한 번 읽는다(실행 환경당). */
export function createKmsNoteSigner(kms: TlogKmsClient, keyArn: string, keyName: string): NoteSigner {
  if (!keyArn.startsWith('arn:aws:kms:')) throw new TlogSigningError('kms_key_arn_required');
  let cached: Promise<Buffer> | undefined;
  return {
    keyName,
    publicKey(): Promise<Buffer> {
      cached ??= spkiOf(kms, keyArn, 'ECC_NIST_EDWARDS25519').then((spki) => {
        const jwk = createPublicKey({ key: spki, format: 'der', type: 'spki' }).export({ format: 'jwk' }) as { crv?: unknown; x?: unknown };
        if (jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') throw new TlogSigningError('kms_public_key_not_ed25519');
        return Buffer.from(jwk.x, 'base64url');
      });
      return cached;
    },
    async sign(message: Uint8Array): Promise<Buffer> {
      if (message.length === 0 || message.length > 4096) throw new TlogSigningError('kms_raw_message_size');
      const response = await kms.send(
        new SignCommand({ KeyId: keyArn, Message: message, MessageType: 'RAW', SigningAlgorithm: 'ED25519_SHA_512' }),
      );
      if (response.Signature === undefined || response.Signature.length !== 64) throw new TlogSigningError('kms_signature_shape');
      return Buffer.from(response.Signature);
    },
  };
}

/** 앵커 서명기(ECDSA P-256, KMS) — Rekor v2 hashedrekord. */
export function createKmsAnchorSigner(kms: TlogKmsClient, keyArn: string): AnchorSigner {
  if (!keyArn.startsWith('arn:aws:kms:')) throw new TlogSigningError('kms_key_arn_required');
  let cached: Promise<Buffer> | undefined;
  return {
    publicKeySpki(): Promise<Buffer> {
      cached ??= spkiOf(kms, keyArn, 'ECC_NIST_P256');
      return cached;
    },
    async signDigest(digest: Uint8Array): Promise<Buffer> {
      if (digest.length !== 32) throw new TlogSigningError('anchor_digest_size');
      const response = await kms.send(
        new SignCommand({ KeyId: keyArn, Message: digest, MessageType: 'DIGEST', SigningAlgorithm: 'ECDSA_SHA_256' }),
      );
      if (response.Signature === undefined || response.Signature.length < 8) throw new TlogSigningError('kms_signature_shape');
      return Buffer.from(response.Signature);
    },
  };
}
