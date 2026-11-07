/**
 * 키 보관 — **운영 가드**와 **개인키 유출 차단**.
 *
 * 계획 §3.5 는 개인키 보관을 KMS envelope + Secrets Manager 로 확정했다. 개발 구현이 하나 더 있고,
 * **그 구현이 운영에서 선택되지 않는다는 것**이 이 파일이 지키는 명제다. 조용히 평문 보관으로 떨어지는 폴백은 사고가 난 뒤에야
 * 드러나고, 그때는 이미 전 에이전트의 키가 평문으로 디스크에 있다.
 */

import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { toAgentId } from '../../../src/db/schema';
import {
  KeyRefFormatError,
  PrivateKeyMaterial,
  ProductionCustodyGuardError,
  assertNotProduction,
  isProductionEnvironment,
  toKeyRef,
} from '../../../src/passport/custody';
import {
  AGENT_KEYPAIR_SECRET_PREFIX,
  ENVELOPE_VERSION,
  createAwsKeyCustody,
  secretNameFor,
  type KeyEnvelope,
} from '../../../src/passport/custody-aws';
import { createLocalDevKeyCustody } from '../../../src/passport/custody-local';

const AGENT_ID = toAgentId('0123456789abcdef0123456789abcdef');

function material(): PrivateKeyMaterial {
  return new PrivateKeyMaterial(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
}

describe('운영 판정 — fail closed', () => {
  it.each([
    ['ATMARK_ENV=production', { ATMARK_ENV: 'production' }],
    ['ATMARK_ENV=prod', { ATMARK_ENV: 'prod' }],
    ['ATMARK_ENV 미설정 + NODE_ENV=production', { NODE_ENV: 'production' }],
    ['대소문자 무관', { ATMARK_ENV: 'Production' }],
  ])('%s 은 운영이다', (_label, env) => {
    expect(isProductionEnvironment(env)).toBe(true);
  });

  it.each([
    ['둘 다 없음', {}],
    ['development', { ATMARK_ENV: 'development' }],
    ['test', { NODE_ENV: 'test' }],
    // **ATMARK_ENV 가 이긴다.** NODE_ENV 는 번들러·프레임워크가 성능 목적으로 켜는 값이라
    // "여기가 운영인가" 의 신뢰할 수 있는 답이 아니다.
    ['ATMARK_ENV=staging 이 NODE_ENV=production 을 이긴다', { ATMARK_ENV: 'staging', NODE_ENV: 'production' }],
  ])('%s 은 운영이 아니다', (_label, env) => {
    expect(isProductionEnvironment(env)).toBe(false);
  });

  it('운영이면 `assertNotProduction` 이 던진다 — 경고가 아니라 예외다', () => {
    expect(() => assertNotProduction('probe', { ATMARK_ENV: 'production' })).toThrow(
      ProductionCustodyGuardError,
    );
  });
});

describe('로컬 개발 구현 — 운영에서 선택되지 않는다', () => {
  it('팩토리가 운영에서 던진다', () => {
    expect(() => createLocalDevKeyCustody({ env: { ATMARK_ENV: 'production' } })).toThrow(
      ProductionCustodyGuardError,
    );
  });

  it('팩토리 통과 후 환경이 운영으로 바뀌어도 `store` 가 던진다', async () => {
    // 장기 실행 워커가 나중에 운영 설정을 받는 구성. 팩토리에서만 검사하면 통과한다.
    const env: NodeJS.ProcessEnv = { ATMARK_ENV: 'development' };
    const custody = createLocalDevKeyCustody({
      directory: mkdtempSync(join(tmpdir(), 'atmark-keys-')),
      env,
    });
    env['ATMARK_ENV'] = 'production';
    await expect(custody.store(AGENT_ID, material())).rejects.toThrow(ProductionCustodyGuardError);
  });

  it('개인키를 0600 파일로 쓰고 **참조만** 돌려준다', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'atmark-keys-'));
    const custody = createLocalDevKeyCustody({ directory, env: {} });

    const ref = await custody.store(AGENT_ID, material());

    // DB 로 가는 값에 키 자료가 없다 — 경로조차 없다(호스트 경로는 DB 에 들어가지 않는다).
    expect(ref).toBe(`devfile://${AGENT_ID}`);
    expect(readdirSync(directory)).toEqual([`${AGENT_ID}.pkcs8`]);
    expect(statSync(join(directory, `${AGENT_ID}.pkcs8`)).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(directory, `${AGENT_ID}.pkcs8`))).toEqual(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
  });

  it('같은 에이전트에 두 번 보관할 수 없다 — 덮어쓰기 경로가 없다 (회전 부재의 파일시스템 대응물)', async () => {
    const custody = createLocalDevKeyCustody({
      directory: mkdtempSync(join(tmpdir(), 'atmark-keys-')),
      env: {},
    });
    await custody.store(AGENT_ID, material());
    await expect(custody.store(AGENT_ID, material())).rejects.toThrow(/EEXIST/);
  });
});

describe('운영 구현 — KMS envelope → Secrets Manager', () => {
  function fakeDeps() {
    const dataKey = new Uint8Array(32).fill(7);
    const created: { name: string; secretString: string; kmsKeyId: string }[] = [];
    return {
      dataKey,
      created,
      deps: {
        kms: {
          generateDataKey: () =>
            Promise.resolve({ plaintext: dataKey, ciphertextBlob: new Uint8Array([9, 9, 9]) }),
        },
        secrets: {
          createSecret: (input: { name: string; secretString: string; kmsKeyId: string }) => {
            created.push(input);
            return Promise.resolve({ arn: `arn:aws:secretsmanager:ap-northeast-2:1:secret:${input.name}` });
          },
        },
        cmkArn: 'arn:aws:kms:ap-northeast-2:1:key/abc',
        secretNamePrefix: AGENT_KEYPAIR_SECRET_PREFIX,
      },
    };
  }

  it('시크릿에는 암호문만 들어간다 — 평문 개인키도 평문 DEK 도 없다', async () => {
    const { created, deps } = fakeDeps();
    await createAwsKeyCustody(deps).store(AGENT_ID, material());

    const envelope = JSON.parse(created[0]?.secretString ?? '{}') as KeyEnvelope;
    expect(envelope.v).toBe(ENVELOPE_VERSION);
    expect(envelope.alg).toBe('A256GCM');
    // KMS 가 돌려준 **암호화된** DEK. 복호에는 CMK 접근이 필요하다.
    expect(Buffer.from(envelope.dek, 'base64')).toEqual(Buffer.from([9, 9, 9]));

    // 평문 개인키 바이트가 시크릿 어디에도 없다.
    const plaintextHex = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]).toString('hex');
    expect(Buffer.from(envelope.ct, 'base64').toString('hex')).not.toBe(plaintextHex);
    expect(created[0]?.secretString).not.toContain(plaintextHex);
  });

  it('평문 DEK 를 보관 직후 0으로 지운다', async () => {
    const { dataKey, deps } = fakeDeps();
    await createAwsKeyCustody(deps).store(AGENT_ID, material());
    expect([...dataKey].every((byte) => byte === 0)).toBe(true);
  });

  it('보관에 실패해도 평문 DEK 를 지운다 (예외 경로의 힙이 곧 덤프다)', async () => {
    const { dataKey, deps } = fakeDeps();
    const broken = {
      ...deps,
      secrets: { createSecret: () => Promise.reject(new Error('aws down')) },
    };
    await expect(createAwsKeyCustody(broken).store(AGENT_ID, material())).rejects.toThrow('aws down');
    expect([...dataKey].every((byte) => byte === 0)).toBe(true);
  });

  it('시크릿 이름은 에이전트당 하나이고 `key_ref` 는 그 ARN 이다', async () => {
    const { created, deps } = fakeDeps();
    const ref = await createAwsKeyCustody(deps).store(AGENT_ID, material());

    expect(created[0]?.name).toBe(secretNameFor(AGENT_KEYPAIR_SECRET_PREFIX, AGENT_ID));
    expect(ref.startsWith('awssm://arn:aws:secretsmanager:')).toBe(true);
    // 시크릿 자체도 같은 CMK 로 암호화한다 — 접근 통제 경계가 둘이면 넓은 쪽이 실효 경계다.
    expect(created[0]?.kmsKeyId).toBe(deps.cmkArn);
  });

  it('포트에 `PutSecretValue`(덮어쓰기)가 없다 — 있으면 그것이 회전 경로다', () => {
    const { deps } = fakeDeps();
    expect(Object.keys(deps.secrets)).toEqual(['createSecret']);
    expect(Object.keys(deps.kms)).toEqual(['generateDataKey']);
  });
});

describe('개인키 자료는 직렬화되지 않는다 (§3.5 AC-e1)', () => {
  it('JSON.stringify 와 문자열 보간에 평문이 나가지 않는다', () => {
    const secret = new PrivateKeyMaterial(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
    expect(JSON.stringify({ key: secret })).toBe('{"key":"[redacted]"}');
    expect(`${secret}`).toBe('[redacted]');
    // 구조화 로그가 에러 컨텍스트를 통째로 직렬화해도 같은 결과여야 한다.
    expect(JSON.stringify({ context: { material: secret } })).not.toContain('222');
  });

  it('`wipe()` 가 바이트를 0으로 만든다', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    new PrivateKeyMaterial(bytes).wipe();
    expect([...bytes]).toEqual([0, 0, 0]);
  });

  it('빈 자료는 거부한다', () => {
    expect(() => new PrivateKeyMaterial(new Uint8Array())).toThrow();
  });
});

describe('key_ref 형식', () => {
  it('스킴과 로케이터를 붙인다', () => {
    expect(toKeyRef('devfile', AGENT_ID)).toBe(`devfile://${AGENT_ID}`);
  });

  it.each([
    ['빈 로케이터', ''],
    ['제어문자', 'arn:aws\u0000evil'],
    ['512자 초과', 'a'.repeat(513)],
  ])('%s 은 거부한다 — DB CHECK 와 같은 집합이어야 한다', (_label, locator) => {
    expect(() => toKeyRef('awssm', locator)).toThrow(KeyRefFormatError);
  });
});
