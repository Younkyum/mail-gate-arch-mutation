/**
 * src/passport/custody-aws.ts — 운영 구현. **KMS envelope 암호화 → Secrets Manager.**
 * `agent_keypairs.key_ref` 에는 시크릿 ARN 만 남는다 (계획 §3.5).
 *
 * **AWS SDK 를 import 하지 않고 두 개의 좁은 포트**(`DataKeyGenerator` · `SecretCreator`)로 받는다 — 포트에 없는 연산(복호·덮어쓰기)은
 * 이 파일이 부를 수 없고, envelope 조립 로직(실제로 틀릴 수 있는 부분)은 SDK 없이 전부 테스트된다.
 *
 * **envelope 이란 정확히 무엇인가:** KMS 로 데이터 키(DEK, AES-256)를 하나 받아
 * ① 평문 DEK 로 개인키를 AES-256-GCM 암호화하고 ② 평문 DEK 를 즉시 0으로 지운 뒤
 * ③ KMS 가 준 **암호화된 DEK** 와 암호문을 함께 저장한다. 복호에는 KMS 가 필요하므로
 * 시크릿을 통째로 유출당해도 CMK 접근 없이는 개인키가 나오지 않는다.
 */

import { createCipheriv, randomBytes } from 'node:crypto';

import type { AgentId } from '../db/schema';
import { PrivateKeyMaterial, toKeyRef, type KeyCustody, type KeyRef } from './custody';

/** envelope 포맷 버전. 포맷이 바뀌면 옛 시크릿을 읽을 수 없으므로 값이 박혀 있어야 한다. */
export const ENVELOPE_VERSION = 1;

/** 시크릿 이름 접두사. `infra/cdk/stacks/passport-stack.ts` 와 같은 값이다. */
export const AGENT_KEYPAIR_SECRET_PREFIX = 'atmark/agent-keypairs';

/** `kms:GenerateDataKey` 만. **`Decrypt` 는 없다** — 복호는 P6 `signer.ts` 의 일이다(§3.5 AC-e2). */
export interface DataKeyGenerator {
  generateDataKey(input: {
    readonly keyId: string;
    readonly keySpec: 'AES_256';
  }): Promise<{ readonly plaintext: Uint8Array; readonly ciphertextBlob: Uint8Array }>;
}

/**
 * `secretsmanager:CreateSecret` 만. **`PutSecretValue`(=덮어쓰기)가 없는 것이 설계다** —
 * 그 연산이 포트에 있으면 그것이 곧 키 회전 경로가 된다(§4B.1 "키 재생성 경로 없음").
 * 같은 이름으로 두 번 부르면 AWS 가 `ResourceExistsException` 으로 거부한다.
 */
export interface SecretCreator {
  createSecret(input: {
    readonly name: string;
    readonly secretString: string;
    readonly kmsKeyId: string;
  }): Promise<{ readonly arn: string }>;
}

export interface AwsKeyCustodyDeps {
  readonly kms: DataKeyGenerator;
  readonly secrets: SecretCreator;
  /** envelope 용 CMK. `passport-stack.ts` 의 `AtmarkAgentKeypairKey` ARN. */
  readonly cmkArn: string;
  readonly secretNamePrefix: string;
}

/** Secrets Manager 에 들어가는 JSON. **평문 DEK 도 평문 개인키도 여기 없다.** */
export interface KeyEnvelope {
  readonly v: number;
  readonly alg: 'A256GCM';
  /** KMS 가 돌려준 **암호화된** DEK. 복호에는 CMK 접근이 필요하다. */
  readonly dek: string;
  readonly iv: string;
  readonly tag: string;
  readonly ct: string;
}

/** 시크릿 이름. 에이전트당 하나이고 **재사용되지 않는다**(회전 경로 부재의 대응물). */
export function secretNameFor(prefix: string, agentId: AgentId): string {
  return `${prefix}/${agentId}`;
}

export function createAwsKeyCustody(deps: AwsKeyCustodyDeps): KeyCustody {
  return {
    kind: 'aws-kms-secretsmanager',

    async store(agentId: AgentId, privateKey: PrivateKeyMaterial): Promise<KeyRef> {
      const dataKey = await deps.kms.generateDataKey({ keyId: deps.cmkArn, keySpec: 'AES_256' });
      // GCM 의 표준 nonce 길이. 재사용하면 기밀성이 통째로 무너지므로 **매 호출 난수**다
      // (그리고 DEK 도 매 호출 새것이라 nonce 재사용 위험이 구조적으로 없다).
      const iv = randomBytes(12);

      let envelope: KeyEnvelope;
      try {
        const cipher = createCipheriv('aes-256-gcm', dataKey.plaintext, iv);
        const ciphertext = Buffer.concat([cipher.update(privateKey.expose()), cipher.final()]);
        envelope = {
          v: ENVELOPE_VERSION,
          alg: 'A256GCM',
          dek: Buffer.from(dataKey.ciphertextBlob).toString('base64'),
          iv: iv.toString('base64'),
          tag: cipher.getAuthTag().toString('base64'),
          ct: ciphertext.toString('base64'),
        };
      } finally {
        // **성공·실패 어느 쪽이든** 평문 DEK 를 지운다. finally 가 아니면 예외 경로에서
        // 평문 키가 힙에 남고, 그 힙이 곧 크래시 덤프다.
        dataKey.plaintext.fill(0);
      }

      const created = await deps.secrets.createSecret({
        name: secretNameFor(deps.secretNamePrefix, agentId),
        secretString: JSON.stringify(envelope),
        // 시크릿 자체도 같은 CMK 로 암호화한다. 기본 `aws/secretsmanager` 키로 두면
        // 접근 통제 경계가 둘이 되고, 둘 중 넓은 쪽이 실효 경계가 된다.
        kmsKeyId: deps.cmkArn,
      });

      return toKeyRef('awssm', created.arn);
    },
  };
}
