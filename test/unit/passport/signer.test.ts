/**
 * `src/passport/signer.ts` — 개인키를 복호하는 유일한 파일(§3.5 AC-e2). **AWS 호출 0** — KMS·Secrets Manager 는 가짜다.
 *
 * 운영 custody(`custody-aws.ts`)가 **실제로 만든** envelope 을 서명기가 풀어 서명하고, 그 서명을 **외부 라이브러리(jose)** 가 검증한다 —
 * 보관과 복호가 같은 포맷을 쓴다는 것의 왕복 증명이다. 그리고 거부: 다른 CMK · 다른 에이전트의 시크릿 · 변조된 암호문 · 짝이 아닌 공개키 ·
 * 운영에서의 개발 경로. 오류 메시지에 키 자료가 없다(코드만).
 */

import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DecryptCommand } from '@aws-sdk/client-kms';
import { compactVerify, importJWK } from 'jose';
import { describe, expect, it } from 'vitest';

import { toAgentId } from '../../../src/db/schema';
import { PrivateKeyMaterial, ProductionCustodyGuardError, type KeyRef } from '../../../src/passport/custody';
import { AGENT_KEYPAIR_SECRET_PREFIX, createAwsKeyCustody } from '../../../src/passport/custody-aws';
import { createPassportSigner, type KmsDecryptClient } from '../../../src/passport/signer';
import { PassportSigningError } from '../../../src/passport/signing';

const AGENT = toAgentId('00112233445566778899aabbccddeeff');
const CMK = 'arn:aws:kms:ap-northeast-2:123456789012:key/11111111-2222-3333-4444-555555555555';
const HEADER = { alg: 'EdDSA', kid: 'did:web:id.atmark.ai:agents:x#key-1', typ: 'JWT' };

/** 가짜 KMS — GenerateDataKey 가 준 평문 DEK 를 기억했다가 Decrypt 로 돌려준다. KeyId 가 CMK 가 아니면 거부. */
function fakeKms() {
  const dataKeys = new Map<string, Uint8Array>();
  const handedOut: Uint8Array[] = [];
  const decryptCalls: { keyId: string | undefined }[] = [];
  return {
    handedOut,
    decryptCalls,
    generator: {
      generateDataKey() {
        const plaintext = new Uint8Array(randomBytes(32));
        const blob = new Uint8Array(randomBytes(48));
        dataKeys.set(Buffer.from(blob).toString('hex'), Uint8Array.from(plaintext));
        return Promise.resolve({ plaintext, ciphertextBlob: blob });
      },
    },
    client: {
      send(command: DecryptCommand) {
        decryptCalls.push({ keyId: command.input.KeyId });
        if (command.input.KeyId !== CMK) return Promise.reject(Object.assign(new Error('wrong key'), { name: 'IncorrectKeyException' }));
        const stored = dataKeys.get(Buffer.from(command.input.CiphertextBlob ?? new Uint8Array()).toString('hex'));
        if (stored === undefined) return Promise.reject(Object.assign(new Error('bad blob'), { name: 'InvalidCiphertextException' }));
        const copy = Uint8Array.from(stored);
        handedOut.push(copy);
        return Promise.resolve({ Plaintext: copy });
      },
    } satisfies KmsDecryptClient,
  };
}

async function provisionedKey() {
  const kms = fakeKms();
  const secrets = new Map<string, string>();
  const custody = createAwsKeyCustody({
    kms: kms.generator,
    secrets: {
      createSecret(input) {
        const arn = `arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:${input.name}-AbCdEf`;
        secrets.set(arn, input.secretString);
        return Promise.resolve({ arn });
      },
    },
    cmkArn: CMK,
    secretNamePrefix: AGENT_KEYPAIR_SECRET_PREFIX,
  });
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const x = (publicKey.export({ format: 'jwk' }) as { x: string }).x;
  const keyRef: KeyRef = await custody.store(AGENT, new PrivateKeyMaterial(new Uint8Array(privateKey.export({ format: 'der', type: 'pkcs8' }))));
  const reads: string[] = [];
  const reader = {
    readSecretString(id: string) {
      reads.push(id);
      const value = secrets.get(id);
      return value === undefined ? Promise.reject(new Error('no secret')) : Promise.resolve(value);
    },
  };
  return { kms, secrets, keyRef, x, reader, reads };
}

describe('AWS 경로 — custody-aws 가 만든 envelope 을 풀어 서명한다', () => {
  it('왕복: 서명을 jose(외부)가 검증 · Decrypt 의 KeyId 는 CMK 로 고정 · 쓴 DEK 는 0 으로 지워진다', async () => {
    const { kms, keyRef, x, reader } = await provisionedKey();
    const signer = createPassportSigner({ kind: 'aws', secrets: reader, kms: kms.client, cmkArn: CMK });
    const jws = await signer.signCompact({ agentId: AGENT, keyRef, expectedPublicKey: x, header: HEADER, payload: '{"a":1}' });
    const verified = await compactVerify(jws, await importJWK({ kty: 'OKP', crv: 'Ed25519', x }, 'EdDSA'));
    expect(new TextDecoder().decode(verified.payload)).toBe('{"a":1}');
    expect(kms.decryptCalls).toEqual([{ keyId: CMK }]);
    expect(kms.handedOut.every((dek) => dek.every((byte) => byte === 0))).toBe(true);
  });

  it('짝이 아닌 공개키면 서명하지 않는다(key_ref 포인터 교체 사고)', async () => {
    const { kms, keyRef, reader } = await provisionedKey();
    const other = (generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }) as { x: string }).x;
    const signer = createPassportSigner({ kind: 'aws', secrets: reader, kms: kms.client, cmkArn: CMK });
    await expect(signer.signCompact({ agentId: AGENT, keyRef, expectedPublicKey: other, header: HEADER, payload: '{}' })).rejects.toThrow(
      new PassportSigningError('private_key_public_key_mismatch'),
    );
  });

  it('다른 에이전트의 시크릿 ARN 이면 **읽기 전에** 거부한다', async () => {
    const { kms, x, reader, reads } = await provisionedKey();
    const signer = createPassportSigner({ kind: 'aws', secrets: reader, kms: kms.client, cmkArn: CMK });
    const foreign = `awssm://arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:atmark/db/app-AbCdEf`;
    await expect(signer.signCompact({ agentId: AGENT, keyRef: foreign, expectedPublicKey: x, header: HEADER, payload: '{}' })).rejects.toThrow(
      new PassportSigningError('key_ref_not_agent_secret'),
    );
    expect(reads).toEqual([]);
  });

  it('변조된 암호문 → envelope_decrypt_failed(메시지에 키 자료 없음) · 다른 CMK → 실패', async () => {
    const { kms, keyRef, x, secrets, reader } = await provisionedKey();
    const arn = keyRef.slice('awssm://'.length);
    const envelope = JSON.parse(secrets.get(arn) ?? '{}') as { ct: string };
    const ct = Buffer.from(envelope.ct, 'base64');
    ct[0] = (ct[0] ?? 0) ^ 1;
    secrets.set(arn, JSON.stringify({ ...envelope, ct: ct.toString('base64') }));
    const signer = createPassportSigner({ kind: 'aws', secrets: reader, kms: kms.client, cmkArn: CMK });
    const failure = await signer.signCompact({ agentId: AGENT, keyRef, expectedPublicKey: x, header: HEADER, payload: '{}' }).catch((error: unknown) => error);
    expect(failure).toEqual(new PassportSigningError('envelope_decrypt_failed'));
    expect(String((failure as Error).message)).toMatch(/^[a-z0-9_:.-]+$/);

    const wrongCmk = createPassportSigner({ kind: 'aws', secrets: reader, kms: kms.client, cmkArn: `${CMK}0` });
    await expect(wrongCmk.signCompact({ agentId: AGENT, keyRef, expectedPublicKey: x, header: HEADER, payload: '{}' })).rejects.toThrow();
  });

  it('devfile 참조는 AWS 서명기가 받지 않는다 · alg 는 EdDSA 만', async () => {
    const { kms, x, reader, keyRef } = await provisionedKey();
    const signer = createPassportSigner({ kind: 'aws', secrets: reader, kms: kms.client, cmkArn: CMK });
    await expect(signer.signCompact({ agentId: AGENT, keyRef: `devfile://${AGENT}`, expectedPublicKey: x, header: HEADER, payload: '{}' })).rejects.toThrow(
      new PassportSigningError('key_ref_scheme_mismatch'),
    );
    await expect(signer.signCompact({ agentId: AGENT, keyRef, expectedPublicKey: x, header: { ...HEADER, alg: 'none' }, payload: '{}' })).rejects.toThrow(
      new PassportSigningError('header_alg_not_eddsa'),
    );
  });
});

describe('개발 경로(devfile) — 운영이면 던진다', () => {
  it('운영 환경이면 팩토리에서 던진다(조용한 평문 폴백 없음)', () => {
    expect(() => createPassportSigner({ kind: 'local-dev', env: { ATMARK_ENV: 'production' } })).toThrow(ProductionCustodyGuardError);
  });

  it('개발 키 파일로 서명 · 다른 에이전트의 참조는 거부', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'atmark-signer-'));
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    writeFileSync(join(directory, `${AGENT}.pkcs8`), privateKey.export({ format: 'der', type: 'pkcs8' }));
    const x = (publicKey.export({ format: 'jwk' }) as { x: string }).x;
    const signer = createPassportSigner({ kind: 'local-dev', directory, env: {} });
    const jws = await signer.signCompact({ agentId: AGENT, keyRef: `devfile://${AGENT}`, expectedPublicKey: x, header: HEADER, payload: 'p' });
    await expect(compactVerify(jws, await importJWK({ kty: 'OKP', crv: 'Ed25519', x }, 'EdDSA'))).resolves.toBeDefined();
    await expect(
      signer.signCompact({ agentId: AGENT, keyRef: 'devfile://ffffffffffffffffffffffffffffffff', expectedPublicKey: x, header: HEADER, payload: 'p' }),
    ).rejects.toThrow(new PassportSigningError('key_ref_agent_mismatch'));
  });
});
