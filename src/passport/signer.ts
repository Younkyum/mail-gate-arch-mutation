/**
 * src/passport/signer.ts — ★ **에이전트 개인키를 복호할 수 있는 유일한 파일** (계획 §3.5 AC-e2 · §5.0b Layer P4).
 *
 * 이 파일만이:
 *   - `kms:Decrypt` 를 부른다(KMS SDK `DecryptCommand` — envelope 의 DEK 를 푼다),
 *   - envelope(AES-256-GCM)을 푼다(`createDecipheriv`),
 *   - 개발 키 파일(`devfile://`)을 읽는다,
 *   - 평문 개인키로 서명한다.
 * `test/arch/passport-signer-isolation.arch.test.ts` 가 네 가지 전부를 **파일 이름으로** 단언하고, `.dependency-cruiser.cjs` 의
 * `passport-signer-only-from-signer-composition` 이 이 파일을 import 하는 곳을 서명 Lambda 의 조립 루트 하나로 묶는다. IAM 쪽 대응물은
 * `infra/cdk/stacks/compute-stack.ts` 의 `atmark-runtime-passport-signer` 역할 하나만 `kms:Decrypt`(ViaService 조건 없이)와
 * `atmark/agent-keypairs/*` 읽기를 갖는다는 것이다.
 *
 * **밖으로 나가는 것은 서명(JWS compact 문자열)뿐이다.** 평문 키·DEK 는 이 함수들의 지역 변수로만 산다. 지우기는 **최선 노력**이다:
 * 우리가 쥔 버퍼(KMS 가 돌려준 DEK · 복호기의 update/final 조각 · 이어 붙인 DER · 개발 키 파일 바이트)는 쓰고 나면 `fill(0)` 한다.
 * 그러나 JS 런타임에서 **지울 수 없는 사본**이 남는다 — KMS SDK 가 응답 JSON 을 파싱하며 만든 base64 문자열(JS 문자열은 불변),
 * `createPrivateKey` 가 OpenSSL 쪽에 만든 키 객체(GC 가 거둘 때까지), GC 이동으로 생긴 사본. 그래서 이 파일은 "메모리에 평문이
 * 남지 않는다" 를 약속하지 않는다 — 약속하는 것은 **우리 코드가 사본을 늘리지 않고, 쥔 것은 지운다**는 것까지다.
 * 오류 메시지에 키 자료·암호문·시크릿 값을 싣지 않는다 — 단계 이름(코드)만.
 *
 * **서명 전에 공개키를 대조한다.** 복호한 개인키에서 공개키를 다시 뽑아 `agent_keypairs.public_key` 와 비교하고, 다르면 서명하지
 * 않는다. `key_ref` 가 엉뚱한 시크릿을 가리키는 사고(§4B.1 이 "가장 위험" 이라 부른 포인터 교체)가 **잘못된 키로 서명된 문서**로
 * 세상에 나가는 대신 여기서 멈춘다.
 */

import { createDecipheriv, createPrivateKey, createPublicKey, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DecryptCommand, KMSClient } from '@aws-sdk/client-kms';

import type { AgentId } from '../db/schema';
import { AGENT_KEYPAIR_SECRET_PREFIX, ENVELOPE_VERSION, type KeyEnvelope } from './custody-aws';
import { assertNotProduction, PrivateKeyMaterial } from './custody';
import { resolveDevKeyDirectory } from './custody-local';
import { PassportSigningError, type PassportSigner, type SignRequest } from './signing';

/** `kms:Decrypt` 의 `send` 면 — 테스트는 이 면만 가짜로 준다. */
export interface KmsDecryptClient {
  send(command: DecryptCommand): Promise<{ Plaintext?: Uint8Array | undefined }>;
}

/** 실제 KMS. **부르는 순간 AWS 자격증명이 필요하다**(만들기만 해서는 네트워크를 타지 않는다). */
export function createSignerKmsClient(region: string): KmsDecryptClient {
  return new KMSClient({ region });
}

/** 시크릿 읽기 면 — `src/runtime/secrets.ts` 의 `SecretReader` 와 같은 모양(구조적 타입). */
export interface EnvelopeSecretReader {
  readSecretString(secretId: string): Promise<string>;
}

export type PassportSignerOptions =
  | {
      readonly kind: 'aws';
      readonly secrets: EnvelopeSecretReader;
      readonly kms: KmsDecryptClient;
      /** envelope CMK(ARN). Decrypt 에 `KeyId` 로 고정한다 — 다른 CMK 로 싸인 DEK 는 풀지 않는다. */
      readonly cmkArn: string;
    }
  | {
      /** 개발·테스트 전용 — `custody-local.ts` 가 쓴 `<dir>/<agentId>.pkcs8`. 운영이면 던진다. */
      readonly kind: 'local-dev';
      readonly directory?: string;
      readonly env?: NodeJS.ProcessEnv;
    };

/** 복호한 envelope 의 모양 검사 — 필드 이름만 본다(값은 오류에 싣지 않는다). */
function parseEnvelope(raw: string): KeyEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PassportSigningError('envelope_not_json');
  }
  const record = parsed as Partial<Record<keyof KeyEnvelope, unknown>> | null;
  if (typeof record !== 'object' || record === null) throw new PassportSigningError('envelope_not_object');
  if (record.v !== ENVELOPE_VERSION || record.alg !== 'A256GCM') throw new PassportSigningError('envelope_version');
  for (const field of ['dek', 'iv', 'tag', 'ct'] as const) {
    if (typeof record[field] !== 'string' || record[field] === '') throw new PassportSigningError(`envelope_field_${field}`);
  }
  return record as KeyEnvelope;
}

/** `awssm://<arn>` · `devfile://<agentId>` → 스킴·위치. 다른 모양은 거부. */
function splitKeyRef(keyRef: string): { readonly scheme: 'awssm' | 'devfile'; readonly locator: string } {
  const match = /^(awssm|devfile):\/\/(.+)$/.exec(keyRef);
  if (match?.[1] === undefined || match[2] === undefined) throw new PassportSigningError('key_ref_format');
  return { scheme: match[1] as 'awssm' | 'devfile', locator: match[2] };
}

async function loadAwsKey(
  options: Extract<PassportSignerOptions, { kind: 'aws' }>,
  agentId: AgentId,
  locator: string,
): Promise<PrivateKeyMaterial> {
  // 시크릿 이름 범위 — 이 서명기는 에이전트 키 시크릿 말고는 읽지 않는다(IAM 이 한 번 더 막는다). ARN 은
  // `arn:aws:secretsmanager:<region>:<account>:secret:atmark/agent-keypairs/<agentId>-XXXXXX` 모양이다.
  const secretName = `${AGENT_KEYPAIR_SECRET_PREFIX}/${agentId}`;
  if (!locator.startsWith('arn:aws:secretsmanager:') || !locator.includes(`:secret:${secretName}-`)) {
    throw new PassportSigningError('key_ref_not_agent_secret');
  }
  const envelope = parseEnvelope(await options.secrets.readSecretString(locator));
  const decrypted = await options.kms.send(
    new DecryptCommand({ CiphertextBlob: Buffer.from(envelope.dek, 'base64'), KeyId: options.cmkArn }),
  );
  const dek = decrypted.Plaintext;
  if (dek === undefined || dek.length !== 32) throw new PassportSigningError('kms_decrypt_no_plaintext');
  // 복호기 조각(update·final)은 평문 개인키의 일부다 — 이어 붙인 뒤(또는 실패하면) 0 으로 지운다(최선 노력, 머리말).
  const parts: Buffer[] = [];
  try {
    const decipher = createDecipheriv('aes-256-gcm', dek, Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    parts.push(decipher.update(Buffer.from(envelope.ct, 'base64')));
    parts.push(decipher.final());
    // concat 은 새 버퍼 하나를 만든다 — 그 버퍼는 `PrivateKeyMaterial` 이 쥐고 서명 뒤 `wipe()` 가 지운다.
    const der = Buffer.concat(parts);
    return new PrivateKeyMaterial(new Uint8Array(der.buffer, der.byteOffset, der.length));
  } catch (error) {
    if (error instanceof PassportSigningError) throw error;
    // GCM 태그 불일치 = 암호문이 바뀌었거나 다른 DEK. 원인 문자열(OpenSSL 메시지)은 싣지 않는다.
    throw new PassportSigningError('envelope_decrypt_failed');
  } finally {
    for (const part of parts) part.fill(0);
    dek.fill(0);
  }
}

function loadDevKey(options: Extract<PassportSignerOptions, { kind: 'local-dev' }>, agentId: AgentId, locator: string): PrivateKeyMaterial {
  const env = options.env ?? process.env;
  assertNotProduction('createPassportSigner(local-dev).signCompact', env);
  if (locator !== agentId) throw new PassportSigningError('key_ref_agent_mismatch');
  const directory = resolveDevKeyDirectory({ ...(options.directory === undefined ? {} : { directory: options.directory }), env });
  let bytes: Buffer;
  try {
    bytes = readFileSync(join(directory, `${agentId}.pkcs8`));
  } catch {
    throw new PassportSigningError('dev_key_unreadable');
  }
  return new PrivateKeyMaterial(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length));
}

/** 개인키 → 공개키 원시 32바이트의 base64url(= JWK `x`). */
function publicKeyOf(key: KeyObject): string {
  const jwk = createPublicKey(key).export({ format: 'jwk' }) as { x?: unknown };
  if (typeof jwk.x !== 'string') throw new PassportSigningError('public_key_export');
  return jwk.x;
}

export function createPassportSigner(options: PassportSignerOptions): PassportSigner {
  if (options.kind === 'local-dev') assertNotProduction('createPassportSigner(local-dev)', options.env ?? process.env);
  return {
    kind: options.kind,
    async signCompact(request: SignRequest): Promise<string> {
      if (request.header['alg'] !== 'EdDSA') throw new PassportSigningError('header_alg_not_eddsa');
      const { scheme, locator } = splitKeyRef(request.keyRef);
      if (scheme !== (options.kind === 'aws' ? 'awssm' : 'devfile')) throw new PassportSigningError('key_ref_scheme_mismatch');

      const material =
        options.kind === 'aws' ? await loadAwsKey(options, request.agentId, locator) : loadDevKey(options, request.agentId, locator);
      let key: KeyObject;
      try {
        // 복사하지 않는 뷰 — 아래 `wipe()` 가 이 바이트를 0 으로 지운다(JS 쪽 사본을 늘리지 않게). OpenSSL 이 만든 키 객체 안의
        // 사본은 우리가 지울 수 없다(머리말 — 최선 노력).
        const der = material.expose();
        key = createPrivateKey({ key: Buffer.from(der.buffer, der.byteOffset, der.byteLength), format: 'der', type: 'pkcs8' });
      } catch {
        throw new PassportSigningError('private_key_parse');
      } finally {
        material.wipe();
      }
      if (key.asymmetricKeyType !== 'ed25519') throw new PassportSigningError('private_key_not_ed25519');
      if (publicKeyOf(key) !== request.expectedPublicKey) throw new PassportSigningError('private_key_public_key_mismatch');

      const signingInput = `${Buffer.from(JSON.stringify(request.header), 'utf8').toString('base64url')}.${Buffer.from(
        request.payload,
        'utf8',
      ).toString('base64url')}`;
      const signature = cryptoSign(null, Buffer.from(signingInput, 'ascii'), key);
      return `${signingInput}.${signature.toString('base64url')}`;
    },
  };
}
