/**
 * scripts/admin/custody.ts — `admin:agent-provision` 의 키 보관소 **조립 위치**.
 *
 * `src/passport/custody-aws.ts` 는 SDK 를 import 하지 않고 두 개의 좁은 포트(`DataKeyGenerator`·`SecretCreator`)를
 * 받는다(그 파일 머리말 — `src/**` 의 SDK 경계를 늘리지 않는다). **포트에 SDK 를 꽂는 것은 여기다** — `scripts/` 는
 * `src/**` 의 SDK 격리 규칙(`test/arch/network-egress.arch.test.ts`) 밖이고, 이 CLI 는 대표의 IAM 으로 대표의 노트북에서 돈다.
 * 어댑터가 쓰는 연산은 `kms:GenerateDataKey` 와 `secretsmanager:CreateSecret` 둘뿐이다 — 복호·덮어쓰기가 없다.
 *
 * **선택 규칙 (fail closed):**
 *   - 운영 DB 대상 + 로컬 custody → **거부.** 운영 DB 에 로컬 custody 로 키를 만들면 개인키 평문이 대표 노트북 파일
 *     (`.atmark-dev-keys/`)에 남고, `agent_keypairs.key_ref` 는 `devfile://` 로 영원히 고정된다(불변 트리거).
 *   - 로컬 DB 대상 + AWS custody → **거부.** 개발 에이전트의 키가 운영 계정의 `atmark/agent-keypairs/*` 이름공간을 쓴다.
 *   - 기본값은 대상이 정한다(운영 → aws, 로컬 → local). `createLocalDevKeyCustody` 는 `ATMARK_ENV=production` 이면
 *     스스로 한 번 더 던진다(`assertNotProduction`).
 */

import {
  GenerateDataKeyCommand,
  KMSClient,
  type GenerateDataKeyCommandOutput,
} from '@aws-sdk/client-kms';
import {
  CreateSecretCommand,
  SecretsManagerClient,
  type CreateSecretCommandOutput,
} from '@aws-sdk/client-secrets-manager';

import type { KeyCustody } from '../../src/passport/custody';
import {
  AGENT_KEYPAIR_SECRET_PREFIX,
  createAwsKeyCustody,
  type DataKeyGenerator,
  type SecretCreator,
} from '../../src/passport/custody-aws';
import { createLocalDevKeyCustody } from '../../src/passport/custody-local';
import { AdminInputError, type DbTarget } from './common';

/** envelope CMK. 운영 Lambda 에도 같은 이름으로 들어간다(`compute-stack.ts`). 별칭·ARN 모두 받는다. */
export const PASSPORT_KMS_KEY_ENV = 'ATMARK_PASSPORT_KMS_KEY_ID';

export const DEFAULT_REGION = 'ap-northeast-2';

export type CustodyChoice = 'aws' | 'local';

/** SDK 클라이언트의 `send` 중 여기서 쓰는 모양 — 테스트는 이 면만 가짜로 준다. */
export interface KmsSender {
  send(command: GenerateDataKeyCommand): Promise<GenerateDataKeyCommandOutput>;
}
export interface SecretsSender {
  send(command: CreateSecretCommand): Promise<CreateSecretCommandOutput>;
}

export function kmsDataKeyGenerator(client: KmsSender): DataKeyGenerator {
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

export function secretsManagerCreator(client: SecretsSender): SecretCreator {
  return {
    async createSecret(input) {
      const output = await client.send(
        new CreateSecretCommand({
          Name: input.name,
          SecretString: input.secretString,
          KmsKeyId: input.kmsKeyId,
          Description: 'Atmark agent ed25519 private key — KMS envelope (src/passport/custody-aws.ts). Never overwrite.',
        }),
      );
      if (output.ARN === undefined) throw new Error('Secrets Manager CreateSecret 가 ARN 을 돌려주지 않았다.');
      return { arn: output.ARN };
    },
  };
}

export interface AwsCustodyPorts {
  readonly kms: DataKeyGenerator;
  readonly secrets: SecretCreator;
}

/** 실제 SDK. **부르는 순간 AWS 자격증명이 필요하다**(만들기만 해서는 네트워크를 타지 않는다). */
export function sdkCustodyPorts(env: NodeJS.ProcessEnv): AwsCustodyPorts {
  const region = env['AWS_REGION']?.trim() || DEFAULT_REGION;
  return {
    kms: kmsDataKeyGenerator(new KMSClient({ region })),
    secrets: secretsManagerCreator(new SecretsManagerClient({ region })),
  };
}

export function parseCustodyChoice(raw: string | undefined): CustodyChoice | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'aws' || raw === 'local') return raw;
  throw new AdminInputError(`--custody 는 aws | local: ${raw}`);
}

export function selectCustody(
  target: DbTarget,
  choice: CustodyChoice | undefined,
  env: NodeJS.ProcessEnv,
  awsPorts: () => AwsCustodyPorts,
): KeyCustody {
  const kind = choice ?? (target === 'production' ? 'aws' : 'local');
  if (kind === 'local') {
    if (target === 'production') {
      throw new AdminInputError(
        '운영 DB 에 로컬 custody 로 키를 만들지 않는다 — 개인키 평문이 이 노트북 파일에 남고 key_ref 는 고칠 수 없다. ' +
          '--custody aws(기본값)를 써라.',
      );
    }
    return createLocalDevKeyCustody({ env });
  }
  if (target !== 'production') {
    throw new AdminInputError('AWS custody 는 운영 DB 대상에서만 쓴다 — 로컬 에이전트의 키가 운영 계정에 시크릿으로 남는다.');
  }
  const keyId = env[PASSPORT_KMS_KEY_ENV]?.trim() ?? '';
  if (keyId === '') {
    throw new AdminInputError(`${PASSPORT_KMS_KEY_ENV} 가 비어 있다 — envelope CMK(별칭 alias/atmark-agent-keypairs 또는 ARN).`);
  }
  return createAwsKeyCustody({ ...awsPorts(), cmkArn: keyId, secretNamePrefix: AGENT_KEYPAIR_SECRET_PREFIX });
}
