/** Domain Connect KMS 서명기 — 명령 모양(RSA PKCS1 SHA-256 · RAW) · 공개키 검증 뒤에만 돌려준다 · 키 모양 확인. 가짜 KMS(AWS 호출 0). */

import { generateKeyPairSync, sign as rsaSign } from 'node:crypto';

import { GetPublicKeyCommand, SignCommand } from '@aws-sdk/client-kms';
import { describe, expect, it } from 'vitest';

import { createKmsDcSigner, DcSigningError, type DcKmsClient } from '../../../src/domains/dc-kms-signer';

const ARN = 'arn:aws:kms:ap-northeast-2:111122223333:key/abcd';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });

function kms(options: { keySpec?: string; wrongKey?: boolean } = {}): { client: DcKmsClient; commands: unknown[] } {
  const commands: unknown[] = [];
  const client = {
    send: (command: SignCommand | GetPublicKeyCommand) => {
      commands.push(command.input);
      if (command instanceof GetPublicKeyCommand) {
        return Promise.resolve({ PublicKey: publicKey.export({ format: 'der', type: 'spki' }), KeySpec: options.keySpec ?? 'RSA_2048', KeyUsage: 'SIGN_VERIFY' });
      }
      const message = Buffer.from(command.input.Message as Uint8Array);
      return Promise.resolve({ Signature: rsaSign('sha256', message, options.wrongKey === true ? other.privateKey : privateKey) });
    },
  } as unknown as DcKmsClient;
  return { client, commands };
}

describe('Domain Connect KMS 서명기', () => {
  it('SignCommand = RAW · RSASSA_PKCS1_V1_5_SHA_256 · 그 키 · 공개키는 한 번만 읽는다', async () => {
    const { client, commands } = kms();
    const signer = createKmsDcSigner(client, ARN);
    await signer.sign(Buffer.from('domain=example.com'));
    await signer.sign(Buffer.from('domain=example.org'));
    expect(commands.filter((input) => (input as { Message?: unknown }).Message === undefined)).toHaveLength(1);
    expect(commands.find((input) => (input as { Message?: unknown }).Message !== undefined)).toMatchObject({
      KeyId: ARN,
      MessageType: 'RAW',
      SigningAlgorithm: 'RSASSA_PKCS1_V1_5_SHA_256',
    });
  });

  it('공개키로 검증되지 않는 서명 · 키 모양 틀림 · ARN 아님 · 빈/큰 메시지는 던진다', async () => {
    await expect(createKmsDcSigner(kms({ wrongKey: true }).client, ARN).sign(Buffer.from('x'))).rejects.toThrow('kms_signature_unverified');
    await expect(createKmsDcSigner(kms({ keySpec: 'RSA_4096' }).client, ARN).sign(Buffer.from('x'))).rejects.toThrow('kms_key_spec_mismatch');
    expect(() => createKmsDcSigner(kms().client, 'alias/x')).toThrow(DcSigningError);
    await expect(createKmsDcSigner(kms().client, ARN).sign(Buffer.alloc(0))).rejects.toThrow('kms_raw_message_size');
    await expect(createKmsDcSigner(kms().client, ARN).sign(Buffer.alloc(4097))).rejects.toThrow('kms_raw_message_size');
  });
});
