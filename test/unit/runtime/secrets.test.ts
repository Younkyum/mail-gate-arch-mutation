/**
 * `src/runtime/secrets.ts` — SSM Parameter Store 읽기·쓰기(2026-10-12 비밀 → SSM 이전 · 배포 런북 §49)와 식별자 모양에 따른 고르기.
 * AWS 를 부르지 않는다 — `send` 면만 가짜로 준다.
 */

import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { describe, expect, it } from 'vitest';

import {
  createSecretReader,
  createSecretsManagerReader,
  createSsmParameterReader,
  createSsmParameterWriter,
  isSsmParameterName,
  legacySecretIdOf,
  SecretNotFoundError,
  SecretUnavailableError,
  SSM_DB_ROLE_SECRET_NAMES,
  SSM_SECRET_NAMES,
  SSM_SECRETS_KEY_ALIAS,
  ssmParameterNameOf,
} from '../../../src/runtime/secrets';

function awsError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

describe('이름 — 옮긴 20 · 남긴 넷', () => {
  it('20 개 · DB 롤 12 가 앞 · 겹침 없음 · 모두 atmark/ 아래', () => {
    expect(SSM_SECRET_NAMES).toHaveLength(20);
    expect(SSM_DB_ROLE_SECRET_NAMES).toHaveLength(12);
    expect(SSM_SECRET_NAMES.slice(0, 12)).toEqual([...SSM_DB_ROLE_SECRET_NAMES]);
    expect(new Set(SSM_SECRET_NAMES).size).toBe(20);
    for (const name of SSM_SECRET_NAMES) expect(name).toMatch(/^atmark\/[a-z0-9/-]+$/);
    for (const kept of ['atmark/db/master', 'atmark/webhook-secret-keys', 'atmark/dlp-keys']) expect(SSM_SECRET_NAMES).not.toContain(kept);
    expect(SSM_SECRET_NAMES.some((name) => name.startsWith('atmark/agent-keypairs'))).toBe(false);
  });

  it('새 이름 = `/` + 옛 이름 · 식별자 모양으로 가른다 · 옛 이름으로 되돌린다', () => {
    expect(ssmParameterNameOf('atmark/db/app')).toBe('/atmark/db/app');
    expect(isSsmParameterName('/atmark/db/app')).toBe(true);
    expect(isSsmParameterName('atmark/db/app')).toBe(false);
    expect(isSsmParameterName('arn:aws:secretsmanager:ap-northeast-2:1:secret:atmark/db/app-AbCdEf')).toBe(false);
    expect(isSsmParameterName('/other/db/app')).toBe(false);
    expect(legacySecretIdOf('/atmark/db/app')).toBe('atmark/db/app');
    expect(() => legacySecretIdOf('atmark/db/app')).toThrow(SecretUnavailableError);
  });
});

describe('SSM 읽기', () => {
  it('GetParameter WithDecryption · SecureString 값을 돌려준다', async () => {
    const sent: GetParameterCommand[] = [];
    const reader = createSsmParameterReader({
      send(command) {
        sent.push(command);
        return Promise.resolve({ Parameter: { Type: 'SecureString', Value: '{"username":"atmark_app"}' } });
      },
    });
    await expect(reader.readSecretString('/atmark/db/app')).resolves.toBe('{"username":"atmark_app"}');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.input).toEqual({ Name: '/atmark/db/app', WithDecryption: true });
  });

  it('없으면 SecretNotFoundError · SecureString 이 아니면·값이 비면 SecretUnavailableError · 그 밖의 오류는 그대로', async () => {
    const reader = (respond: () => Promise<{ Parameter?: { Type?: string; Value?: string } }>) => createSsmParameterReader({ send: respond });
    await expect(reader(() => Promise.reject(awsError('ParameterNotFound'))).readSecretString('/atmark/db/app')).rejects.toBeInstanceOf(
      SecretNotFoundError,
    );
    const plain = reader(() => Promise.resolve({ Parameter: { Type: 'String', Value: 'leaked' } })).readSecretString('/atmark/db/app');
    await expect(plain).rejects.toThrow(/SecureString/);
    await expect(plain).rejects.not.toThrow(/leaked/);
    await expect(reader(() => Promise.resolve({ Parameter: { Type: 'SecureString', Value: ' ' } })).readSecretString('/atmark/x')).rejects.toBeInstanceOf(
      SecretUnavailableError,
    );
    const denied = reader(() => Promise.reject(awsError('AccessDeniedException'))).readSecretString('/atmark/db/app');
    await expect(denied).rejects.toThrow('AccessDeniedException');
    await expect(denied).rejects.not.toBeInstanceOf(SecretNotFoundError);
  });

  it('SSM 이름이 아니면 보내지 않고 던진다', async () => {
    const reader = createSsmParameterReader({ send: () => Promise.reject(new Error('보내면 안 된다')) });
    await expect(reader.readSecretString('atmark/db/app')).rejects.toThrow(/SSM 파라미터 이름이 아니다/);
  });
});

describe('Secrets Manager 읽기', () => {
  it('ResourceNotFoundException → SecretNotFoundError · 값은 SecretString', async () => {
    const sent: GetSecretValueCommand[] = [];
    const ok = createSecretsManagerReader({
      send(command) {
        sent.push(command);
        return Promise.resolve({ SecretString: 'k1:abc' });
      },
    });
    await expect(ok.readSecretString('atmark/dlp-keys')).resolves.toBe('k1:abc');
    expect(sent[0]?.input).toEqual({ SecretId: 'atmark/dlp-keys' });
    const missing = createSecretsManagerReader({ send: () => Promise.reject(awsError('ResourceNotFoundException')) });
    await expect(missing.readSecretString('atmark/db/app')).rejects.toBeInstanceOf(SecretNotFoundError);
  });
});

describe('createSecretReader — 식별자 모양으로 고른다', () => {
  it('`/atmark/…` 는 SSM, ARN·이름은 Secrets Manager', async () => {
    const asked: string[] = [];
    const reader = createSecretReader('ap-northeast-2', {
      ssm: {
        send(command) {
          asked.push(`ssm:${command.input.Name ?? ''}`);
          return Promise.resolve({ Parameter: { Type: 'SecureString', Value: 'from-ssm' } });
        },
      },
      secretsManager: {
        send(command) {
          asked.push(`sm:${command.input.SecretId ?? ''}`);
          return Promise.resolve({ SecretString: 'from-sm' });
        },
      },
    });
    const arn = 'arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:atmark/webhook-secret-keys-AbCdEf';
    await expect(reader.readSecretString('/atmark/approval-link-keys')).resolves.toBe('from-ssm');
    await expect(reader.readSecretString(arn)).resolves.toBe('from-sm');
    await expect(reader.readSecretString('atmark/db/app')).resolves.toBe('from-sm');
    expect(asked).toEqual(['ssm:/atmark/approval-link-keys', `sm:${arn}`, 'sm:atmark/db/app']);
  });
});

describe('SSM 쓰기 — 롤 부트스트랩', () => {
  it('SecureString · Standard · Overwrite · 고객 관리형 키 alias/atmark-ssm-secrets(AWS 관리형 키 아님)', async () => {
    const sent: PutParameterCommand[] = [];
    const writer = createSsmParameterWriter({
      send(command) {
        sent.push(command);
        return Promise.resolve({});
      },
    });
    await writer.putSecretString('/atmark/db/app', '{"password":"x"}');
    expect(sent[0]?.input).toEqual({
      Name: '/atmark/db/app',
      Value: '{"password":"x"}',
      Type: 'SecureString',
      KeyId: 'alias/atmark-ssm-secrets',
      Tier: 'Standard',
      Overwrite: true,
    });
    expect(SSM_SECRETS_KEY_ALIAS).toBe('alias/atmark-ssm-secrets');
  });

  it('4096 바이트를 넘거나 SSM 이름이 아니면 보내지 않는다', async () => {
    const writer = createSsmParameterWriter({ send: () => Promise.reject(new Error('보내면 안 된다')) });
    await expect(writer.putSecretString('/atmark/db/app', 'x'.repeat(4097))).rejects.toThrow(/4096/);
    await expect(writer.putSecretString('atmark/db/app', 'x')).rejects.toThrow(/SSM 파라미터 이름이 아니다/);
  });
});
