/**
 * 평문 키 자료 지우기 — **최선 노력의 몫이 실제로 지워지는가** (2026-09-24 검증 #8).
 *
 * `node:crypto` 를 감싸 우리 코드가 받는 평문 버퍼의 **참조**를 모아 두고, 호출이 끝난 뒤 그 바이트가 전부 0 인지 본다:
 *   ① 서명기(`signer.ts`, AWS 경로) — 복호기의 update·final 조각 · 서명 키를 만든 DER(이어 붙인 버퍼) · KMS 가 준 DEK.
 *   ② 발급(`keypair.ts`) — `privateKey.export()` 가 준 DER 원본(예전 판은 복사본만 지우고 원본을 힙에 남겼다).
 * 지울 수 없는 사본(SDK 의 base64 문자열 · OpenSSL 키 객체)은 대상이 아니다 — signer.ts 머리말.
 */

import { randomBytes } from 'node:crypto';

import type { DecryptCommand } from '@aws-sdk/client-kms';
import { compactVerify, importJWK } from 'jose';
import { describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({ decipherOutputs: [] as Buffer[], privateKeyInputs: [] as Buffer[], exportedDer: [] as Buffer[] }));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    createDecipheriv: (...args: Parameters<typeof actual.createDecipheriv>) => {
      const decipher = actual.createDecipheriv(...args);
      const update = decipher.update.bind(decipher) as (data: Buffer) => Buffer;
      const final = decipher.final.bind(decipher) as () => Buffer;
      return Object.assign(decipher, {
        update: (data: Buffer) => {
          const out = update(data);
          captured.decipherOutputs.push(out);
          return out;
        },
        final: () => {
          const out = final();
          captured.decipherOutputs.push(out);
          return out;
        },
      });
    },
    createPrivateKey: (input: { key: Buffer } & Record<string, unknown>) => {
      if (Buffer.isBuffer(input.key)) captured.privateKeyInputs.push(input.key);
      return actual.createPrivateKey(input as never);
    },
    generateKeyPairSync: (type: 'ed25519') => {
      const pair = actual.generateKeyPairSync(type);
      const exportKey = pair.privateKey.export.bind(pair.privateKey) as (options: unknown) => Buffer | string;
      Object.defineProperty(pair.privateKey, 'export', {
        value: (options: { format?: string }) => {
          const out = exportKey(options);
          if (options.format === 'der' && Buffer.isBuffer(out)) captured.exportedDer.push(out);
          return out;
        },
      });
      return pair;
    },
  };
});

const { toAgentId } = await import('../../../src/db/schema');
const { PrivateKeyMaterial } = await import('../../../src/passport/custody');
const { AGENT_KEYPAIR_SECRET_PREFIX, createAwsKeyCustody } = await import('../../../src/passport/custody-aws');
const { issueAtProvisioning } = await import('../../../src/passport/keypair');
const { createPassportSigner } = await import('../../../src/passport/signer');
const actualCrypto = await vi.importActual<typeof import('node:crypto')>('node:crypto');

const AGENT = toAgentId('00112233445566778899aabbccddeeff');
const CMK = 'arn:aws:kms:ap-northeast-2:123456789012:key/11111111-2222-3333-4444-555555555555';
const allZero = (buffer: Uint8Array): boolean => buffer.length > 0 && buffer.every((byte) => byte === 0);

describe('평문 키 자료 지우기 — 최선 노력의 몫', () => {
  it('① 서명기(AWS 경로) — 복호기 update·final 조각 · 서명 키 DER · DEK 가 서명 뒤 전부 0 이다(서명은 여전히 검증된다)', async () => {
    const dataKeys = new Map<string, Uint8Array>();
    const handedOut: Uint8Array[] = [];
    const secrets = new Map<string, string>();
    const custody = createAwsKeyCustody({
      kms: {
        generateDataKey() {
          const plaintext = new Uint8Array(randomBytes(32));
          const blob = new Uint8Array(randomBytes(48));
          dataKeys.set(Buffer.from(blob).toString('hex'), Uint8Array.from(plaintext));
          return Promise.resolve({ plaintext, ciphertextBlob: blob });
        },
      },
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
    const { publicKey, privateKey } = actualCrypto.generateKeyPairSync('ed25519');
    const x = (publicKey.export({ format: 'jwk' }) as { x: string }).x;
    const keyRef = await custody.store(AGENT, new PrivateKeyMaterial(new Uint8Array(privateKey.export({ format: 'der', type: 'pkcs8' }))));
    const signer = createPassportSigner({
      kind: 'aws',
      cmkArn: CMK,
      secrets: { readSecretString: (id: string) => Promise.resolve(secrets.get(id) ?? '') },
      kms: {
        send(command: DecryptCommand) {
          const stored = dataKeys.get(Buffer.from(command.input.CiphertextBlob ?? new Uint8Array()).toString('hex'));
          const copy = Uint8Array.from(stored ?? new Uint8Array());
          handedOut.push(copy);
          return Promise.resolve({ Plaintext: copy });
        },
      },
    });

    captured.decipherOutputs.length = 0;
    captured.privateKeyInputs.length = 0;
    const jws = await signer.signCompact({ agentId: AGENT, keyRef, expectedPublicKey: x, header: { alg: 'EdDSA', kid: 'k', typ: 'JWT' }, payload: '{"a":1}' });
    await expect(compactVerify(jws, await importJWK({ kty: 'OKP', crv: 'Ed25519', x }, 'EdDSA'))).resolves.toBeDefined();

    // 비공허: 조각을 실제로 잡았다(update 는 DER 본문 — 비어 있지 않다).
    expect(captured.decipherOutputs.length).toBe(2);
    expect(captured.decipherOutputs.some((part) => part.length > 0)).toBe(true);
    for (const part of captured.decipherOutputs) expect(part.every((byte) => byte === 0)).toBe(true);
    expect(captured.privateKeyInputs).toHaveLength(1);
    for (const der of captured.privateKeyInputs) expect(allZero(der)).toBe(true);
    expect(handedOut.every(allZero)).toBe(true);
  });

  it('② 발급 — privateKey.export() 가 준 DER 원본이 custody 보관 뒤 0 이다(복사본만 지우지 않는다)', async () => {
    captured.exportedDer.length = 0;
    let stored: Uint8Array | undefined;
    await issueAtProvisioning(
      {
        insertAgentKeypair: (input) =>
          Promise.resolve({ agent_id: input.agentId, public_key: input.publicKey, algorithm: input.algorithm, key_ref: input.keyRef, created_at: new Date() } as never),
        insertPassport: (input) => Promise.resolve({ agent_id: input.agentId, did: input.did, status: 'draft', version: input.version } as never),
      },
      {
        kind: 'local-dev',
        store(_agentId: unknown, material: InstanceType<typeof PrivateKeyMaterial>) {
          stored = Uint8Array.from(material.expose());
          return Promise.resolve(`devfile://${AGENT}` as never);
        },
      } as never,
      AGENT,
    );
    expect(stored?.length ?? 0).toBeGreaterThan(0); // 비공허: 보관 시점에는 평문이 있었다.
    expect(captured.exportedDer).toHaveLength(1);
    for (const der of captured.exportedDer) expect(allZero(der)).toBe(true);
  });
});
