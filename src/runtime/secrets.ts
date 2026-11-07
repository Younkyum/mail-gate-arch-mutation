/**
 * src/runtime/secrets.ts — **비밀 SDK(Secrets Manager · SSM Parameter Store)를 import 하는 유일한 파일.**
 *
 * 격리 규칙은 SES(`mail/transport/ses-transport.ts`)·S3(`storage/s3-object-store.ts`) 와 같다: AWS SDK 클라이언트
 * 하나당 파일 하나, 그 파일은 **이름으로** 네트워크 송출 허용목록(`test/arch/network-egress.arch.test.ts`)에 오른다(비밀 SDK 둘은 이 파일 하나).
 *
 * **비밀이 어디 있는가는 식별자 모양이 정한다**(2026-10-12 비밀 → SSM 이전, 배포 런북 §49):
 *   - `/atmark/…` 로 시작하는 이름 → SSM Parameter Store **SecureString**(GetParameter WithDecryption · 고객 관리형 키 `alias/atmark-ssm-secrets`).
 *     DB 롤 12 · 키링·API 키 8 이 여기 산다(`SSM_SECRET_NAMES`).
 *   - 그 밖(ARN · `atmark/…` 이름) → Secrets Manager. 남긴 넷: `atmark/db/master`(RDS 마스터에 묶임) · `atmark/webhook-secret-keys`(재생성 금지
 *     KEK — SSM 은 삭제 복구 창이 없다) · `atmark/dlp-keys`(CFN 생성값) · `atmark/agent-keypairs/*`(key_ref 불변).
 * 환경 변수 이름(`ATMARK_*_SECRET_ARN`)은 계약이라 그대로 두고 **값만** ARN → 파라미터 이름으로 바뀐다 — 되돌리기는 값을 ARN 으로 돌리는 것뿐이다.
 *
 * 공개 면: `readSecretString`(모든 핸들러), `putSecretString`(**migrate 핸들러의 롤 부트스트랩만** — 롤 비밀번호를 만들어 제자리에 쓴다,
 * ADR-0006), `createAgentKeypairSecretCreator`(**admin 의 프로비저닝만** — 에이전트 키 envelope 를 `atmark/agent-keypairs/<id>` 에 **새로**
 * 만든다. 그 접두사 밖의 이름은 거부한다). 삭제(`DeleteSecret`·`DeleteParameter`)·회전·덮어쓰기(에이전트 키)는 없다 — 런타임 역할에는
 * `ssm:DeleteParameter*` 명시 Deny 도 있다(`infra/cdk/stacks/ssm-secrets.ts`). 쓰기 권한은 IAM 이 역할마다 좁혀 준다(migrate = PutParameter
 * DB 롤 12 자리, admin = CreateSecret 접두사 하나).
 *
 * 캐시는 여기 없다. 콜드 스타트 1회 읽기는 조립 루트의 메모이즈(`lambda.ts` `memoize`)가 진다 — 이 파일이 캐시를
 * 가지면 "언제 다시 읽는가" 가 두 곳에서 정해진다.
 */

import {
  CreateSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { GetParameterCommand, PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

import { AGENT_KEYPAIR_SECRET_PREFIX, type SecretCreator } from '../passport/custody-aws';
import { isSsmParameterName, SSM_SECRETS_KEY_ALIAS, SSM_STANDARD_VALUE_MAX_BYTES } from './ssm-secret-names';

export {
  isSsmParameterName,
  SSM_DB_ROLE_SECRET_NAMES,
  SSM_SECRET_NAMES,
  SSM_SECRET_PREFIX,
  SSM_SECRETS_KEY_ALIAS,
  SSM_STANDARD_VALUE_MAX_BYTES,
  ssmParameterNameOf,
} from './ssm-secret-names';

/** 비밀 하나를 문자열로 읽는다. 조립 루트가 보는 면은 이것뿐이다 — 테스트는 가짜를 준다. */
export interface SecretReader {
  readSecretString(secretId: string): Promise<string>;
}

/** 비밀이 없거나 문자열이 아니다. **메시지에 값을 싣지 않는다** — 식별자만. */
export class SecretUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretUnavailableError';
  }
}

/** 비밀 자리 자체가 없다(SSM `ParameterNotFound` · Secrets Manager `ResourceNotFoundException`). 롤 부트스트랩이 "비었다" 로 읽는다. */
export class SecretNotFoundError extends SecretUnavailableError {
  constructor(message: string) {
    super(message);
    this.name = 'SecretNotFoundError';
  }
}

/** SSM 파라미터 이름 → 옛 Secrets Manager 이름(`/atmark/db/app` → `atmark/db/app`). 롤 부트스트랩의 "옛 값이 남았나" 확인 전용. */
export function legacySecretIdOf(parameterName: string): string {
  if (!isSsmParameterName(parameterName)) throw new SecretUnavailableError(`SSM 파라미터 이름이 아니다: ${parameterName}`);
  return parameterName.slice(1);
}

function errorNameOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'name' in error && typeof error.name === 'string' ? error.name : undefined;
}

/** Secrets Manager `GetSecretValue` 의 `send` 면 — 테스트는 이 면만 가짜로 준다. */
export interface SecretsManagerReadClient {
  send(command: GetSecretValueCommand): Promise<{ SecretString?: string | undefined }>;
}

/** Secrets Manager 읽기. 없는 비밀은 `SecretNotFoundError`. */
export function createSecretsManagerReader(client: SecretsManagerReadClient): SecretReader {
  return {
    async readSecretString(secretId: string): Promise<string> {
      let output: { SecretString?: string | undefined };
      try {
        output = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
      } catch (error) {
        if (errorNameOf(error) === 'ResourceNotFoundException') throw new SecretNotFoundError(`비밀 ${secretId} 이 없다.`);
        throw error;
      }
      const value = output.SecretString;
      // 바이너리 비밀(`SecretBinary`)은 받지 않는다 — 우리 비밀은 전부 JSON·키링 문자열이다.
      if (value === undefined || value.trim() === '') {
        throw new SecretUnavailableError(`비밀 ${secretId} 에 SecretString 이 없다.`);
      }
      return value;
    },
  };
}

/** SSM `GetParameter` 의 `send` 면 — 테스트는 이 면만 가짜로 준다. */
export interface SsmReadClient {
  send(command: GetParameterCommand): Promise<{ Parameter?: { Type?: string | undefined; Value?: string | undefined } | undefined }>;
}

/**
 * SSM Parameter Store 읽기 — `WithDecryption: true`. 없는 파라미터는 `SecretNotFoundError`. **SecureString 이 아닌 파라미터는 받지 않는다**
 * (평문 String 으로 잘못 넣은 비밀이 조용히 쓰이지 않게).
 */
export function createSsmParameterReader(client: SsmReadClient): SecretReader {
  return {
    async readSecretString(secretId: string): Promise<string> {
      if (!isSsmParameterName(secretId)) throw new SecretUnavailableError(`SSM 파라미터 이름이 아니다: ${secretId}`);
      let output: Awaited<ReturnType<SsmReadClient['send']>>;
      try {
        output = await client.send(new GetParameterCommand({ Name: secretId, WithDecryption: true }));
      } catch (error) {
        if (errorNameOf(error) === 'ParameterNotFound') throw new SecretNotFoundError(`파라미터 ${secretId} 가 없다.`);
        throw error;
      }
      const parameter = output.Parameter;
      if (parameter?.Type !== 'SecureString') {
        throw new SecretUnavailableError(`파라미터 ${secretId} 가 SecureString 이 아니다 — 비밀은 SecureString 으로만 둔다.`);
      }
      const value = parameter.Value;
      if (value === undefined || value.trim() === '') throw new SecretUnavailableError(`파라미터 ${secretId} 에 값이 없다.`);
      return value;
    },
  };
}

/** `createSecretReader` 가 쓰는 클라이언트 — 테스트는 가짜를 준다. 없으면 처음 필요할 때 실제 클라이언트를 만든다. */
export interface SecretReadClients {
  readonly ssm?: SsmReadClient;
  readonly secretsManager?: SecretsManagerReadClient;
}

/**
 * 운영 읽기 면 — 식별자 모양으로 SSM / Secrets Manager 를 고른다. 클라이언트는 **처음 필요할 때** 하나씩 만든다(SSM 만 읽는 함수는
 * Secrets Manager 클라이언트를 만들지 않는다). 부르기만 해서는 네트워크를 타지 않는다.
 */
export function createSecretReader(region: string, clients: SecretReadClients = {}): SecretReader {
  let ssm: SecretReader | undefined;
  let secretsManager: SecretReader | undefined;
  return {
    readSecretString(secretId: string): Promise<string> {
      if (isSsmParameterName(secretId)) {
        ssm ??= createSsmParameterReader(clients.ssm ?? new SSMClient({ region }));
        return ssm.readSecretString(secretId);
      }
      secretsManager ??= createSecretsManagerReader(clients.secretsManager ?? new SecretsManagerClient({ region }));
      return secretsManager.readSecretString(secretId);
    },
  };
}

/** 비밀 자리에 새 값을 쓴다. **롤 부트스트랩 전용** — 다른 조립은 이 면을 받지 않는다. */
export interface SecretWriter {
  putSecretString(secretId: string, value: string): Promise<void>;
}

/** SSM `PutParameter` 의 `send` 면 — 테스트는 이 면만 가짜로 준다. */
export interface SsmWriteClient {
  send(command: PutParameterCommand): Promise<unknown>;
}

/**
 * SSM SecureString(standard) 쓰기 — `Overwrite: true`(롤 부트스트랩이 placeholder 자리를 채우거나 빈 자리를 만든다). KMS 키는 고객 관리형
 * `alias/atmark-ssm-secrets`(`SSM_SECRETS_KEY_ALIAS` — AWS 관리형 키를 쓰지 않는다). 4 KB 를 넘는 값은 보내지 않는다.
 */
export function createSsmParameterWriter(client: SsmWriteClient): SecretWriter {
  return {
    async putSecretString(secretId: string, value: string): Promise<void> {
      if (!isSsmParameterName(secretId)) throw new SecretUnavailableError(`SSM 파라미터 이름이 아니다: ${secretId}`);
      if (Buffer.byteLength(value, 'utf8') > SSM_STANDARD_VALUE_MAX_BYTES) {
        throw new SecretUnavailableError(`파라미터 ${secretId} 의 값이 ${String(SSM_STANDARD_VALUE_MAX_BYTES)} 바이트를 넘는다.`);
      }
      await client.send(
        new PutParameterCommand({ Name: secretId, Value: value, Type: 'SecureString', KeyId: SSM_SECRETS_KEY_ALIAS, Tier: 'Standard', Overwrite: true }),
      );
    },
  };
}

/** 운영 쓰기 면 — 읽기와 같은 규칙으로 SSM / Secrets Manager 를 고른다(되돌리기: env 를 ARN 으로 돌리면 옛 자리에 쓴다). */
export function createSecretWriter(region: string): SecretWriter {
  let ssm: SecretWriter | undefined;
  let secretsManager: SecretsManagerClient | undefined;
  return {
    async putSecretString(secretId: string, value: string): Promise<void> {
      if (isSsmParameterName(secretId)) {
        ssm ??= createSsmParameterWriter(new SSMClient({ region }));
        await ssm.putSecretString(secretId, value);
        return;
      }
      secretsManager ??= new SecretsManagerClient({ region });
      await secretsManager.send(new PutSecretValueCommand({ SecretId: secretId, SecretString: value }));
    },
  };
}

/** `CreateSecret` 의 `send` 면 — 테스트는 이 면만 가짜로 준다. */
export interface SecretCreateClient {
  send(command: CreateSecretCommand): Promise<{ ARN?: string | undefined }>;
}

export function createSecretsManagerCreateClient(region: string): SecretCreateClient {
  return new SecretsManagerClient({ region });
}

/**
 * 에이전트 키 envelope 시크릿 **생성** 포트(`passport/custody-aws.ts` `SecretCreator`). 이름이
 * `atmark/agent-keypairs/` 밖이면 던진다 — 이 면으로 운영 비밀(DB·키링) 이름공간에 새 비밀을 만들 수 없다.
 * 같은 이름을 두 번 만들면 AWS 가 `ResourceExistsException` 으로 거부한다(덮어쓰기 = 키 회전 경로 없음).
 */
export function createAgentKeypairSecretCreator(client: SecretCreateClient): SecretCreator {
  return {
    async createSecret(input) {
      if (!input.name.startsWith(`${AGENT_KEYPAIR_SECRET_PREFIX}/`)) {
        throw new SecretUnavailableError(`에이전트 키 시크릿이 아닌 이름은 만들지 않는다: ${input.name}`);
      }
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
