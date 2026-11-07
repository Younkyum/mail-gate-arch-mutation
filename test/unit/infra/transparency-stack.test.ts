/**
 * AtmarkTransparency(ADR-0008, US-010) — 합성 템플릿 단언. 스텁 코드 · AWS 호출 0.
 *
 *   ① 공개 로그 버킷: Object Lock **COMPLIANCE 1년** · 버저닝 · 공개 차단 · 보존(RETAIN) · 읽기는 `id.atmark.ai` 배포(OAC)의 `log/*` 뿐 ·
 *      옛 판은 보존(365일) 뒤 수명 주기로 지운다 · 이름·origin 은 컨텍스트로 바꿀 수 있고 운영 값은 여기서 고정한다.
 *   ② KMS 키 둘: Ed25519(체크포인트)·P-256(Rekor 앵커) · SIGN_VERIFY · **비추출**(가져온 키 아님 · 다중 리전 아님) · 키 정책 Deny 가
 *      `kms:Sign` 을 **그 키의 역할 하나**(체크포인트 → 로그 역할 · 앵커 → 앵커 역할) 말고 막는다.
 *   ③ 역할 둘(M5 — 2026-09-24 분리): 로그 역할 = 체크포인트 키 Sign(Ed25519 RAW) · `atmark/db/tlog` · 게시 키 모양 PutObject + `log/checkpoint`
 *      GetObject(게시 수위) · 앵커 키·앵커 비밀 0. 앵커 역할 = 앵커 키 Sign(ECDSA DIGEST) · `atmark/db/tlog-anchor` · 영수증 키 모양 PutObject
 *      뿐 · 체크포인트 키·tlog 비밀·GetObject 0. 둘 다 SES 0 · Decrypt 0 · 다른 비밀 0.
 *   ②' 체크포인트 키: 삭제 예약·비활성화 명시 Deny(L6).
 *   ④ 런타임 전체에서 `kms:Sign` 을 가진 역할은 이 둘뿐(Compute 역할 0).
 *   ⑤ Lambda 둘: 예약 동시성 각 1 · VPC · 스케줄 둘(log 5분 → 로그 함수 · anchor 매시 → 앵커 함수) · 함수마다 자기 환경만 ·
 *      DB 연결 예산 합(Compute 69 + 이 둘 2) = 71 ≤ 73(api 8 → 7 · AI 감시 결과 1 × 1 — 2026-10-06 ADR-0017 초안 · admin 예약 2 → 3 · api 10 → 9 · 결제 sync 1 × 1 · 웹훅 × 0, 2026-09-25 WP-2).
 *   ⑥ id.atmark.ai `/log/*` 동작 → 로그 버킷 · migrate 는 tlog DB 비밀 둘에 **쓰기** 권한과 환경 변수를 받는다(bootstrap-roles).
 *   ⑦ M2(2026-09-24 적대적 검증) — 쓰기 역할의 S3 리소스는 코드가 쓰는 키 모양뿐 · `/log/*` 는 게시 모양 밖 URI 를 404(경로 가드 함수) ·
 *      응답은 nosniff + CSP sandbox + CORS(GET/HEAD, 자격 없음). 생산자(타일·게시·앵커)의 실제 경로로 대조한다.
 */

import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

import {
  DENY_CHECKPOINT_KEY_DESTRUCTION_SID,
  DENY_SIGN_EXCEPT_TLOG_SID,
  TLOG_ANCHOR_FUNCTION_NAME,
  TLOG_ANCHOR_RESERVED_CONCURRENCY,
  TLOG_ANCHOR_RUNTIME_ROLE_NAME,
  TLOG_DEFAULT_ORIGIN,
  TLOG_FUNCTION_NAME,
  TLOG_NONCURRENT_EXPIRATION_DAYS,
  TLOG_OBJECT_LOCK_DAYS,
  TLOG_RESERVED_CONCURRENCY,
  TLOG_RUNTIME_ROLE_NAME,
  transparencyLogBucketName,
  transparencyLogOrigin,
} from '../../../infra/cdk/stacks/transparency-stack';
import { TRANSPARENCY_LOG_CSP, TRANSPARENCY_LOG_PATH_GUARD_SOURCE } from '../../../infra/cdk/stacks/identity-cdn-stack';
import { TLOG_ANCHOR_WRITE_KEYS, TLOG_LOG_WRITE_KEYS, TLOG_OTS_CALENDARS } from '../../../infra/cdk/stacks/transparency-stack';
import { TLOG_COMPOSITION_ENV, TRANSPARENCY_POOL_MAX } from '../../../src/runtime/transparency-composition';
import { TLOG_ORIGIN } from '../../../src/tlog/constants';
import { rightmostTiles, tilePath } from '../../../src/tlog/tiles';
import {
  ACCOUNT,
  actionsOf,
  buildRuntimeApp,
  readsSsmSecret,
  REGION,
  runtimeStackTemplate,
  runtimeTemplates,
  statementsByRole,
  writesSsmSecret,
  type IamStatement,
} from './runtime-app';

// 기본 런타임 앱 synth(실행 전체에서 한 번 — runtime-app.ts). 컨텍스트를 바꾸는 단언은 아래에서 buildRuntimeApp() 으로 따로 synth 한다.
const template = runtimeStackTemplate('transparency');
const compute = runtimeTemplates().compute;
const identity = runtimeStackTemplate('identityCdn');

function only<T>(record: Record<string, T>): T {
  const values = Object.values(record);
  expect(values).toHaveLength(1);
  return values[0] as T;
}

interface FunctionResource {
  readonly Properties: { FunctionName: string; ReservedConcurrentExecutions: number; Environment: { Variables: Record<string, unknown> } } & Record<string, unknown>;
}

/** IAM 리소스(`Fn::Join` 으로 만든 버킷 ARN + 키) → 버킷 안의 키 목록. */
function objectKeysOf(resource: unknown): string[] {
  const list = Array.isArray(resource) ? resource : [resource];
  return list.map((entry) => {
    const text = JSON.stringify(entry);
    const match = /"\/(log\/[^"]*)"\]\]\}$/.exec(text);
    expect(match, text).not.toBeNull();
    return (match as RegExpExecArray)[1] as string;
  });
}

function functionNamed(source: Template, name: string): FunctionResource {
  const found = (Object.values(source.findResources('AWS::Lambda::Function')) as FunctionResource[]).filter((fn) => fn.Properties.FunctionName === name);
  expect(found, name).toHaveLength(1);
  return found[0] as FunctionResource;
}

describe('① 공개 로그 버킷 — Object Lock COMPLIANCE 1년', () => {
  it('버저닝 · Object Lock 기본 보존 COMPLIANCE 365일 · 공개 차단 · RETAIN · 고정 이름', () => {
    const bucket = only(template.findResources('AWS::S3::Bucket')) as { Properties: Record<string, unknown>; DeletionPolicy: string };
    expect(bucket.DeletionPolicy).toBe('Retain');
    expect(bucket.Properties['BucketName']).toBe(transparencyLogBucketName(ACCOUNT, REGION));
    expect(bucket.Properties['ObjectLockEnabled']).toBe(true);
    expect(bucket.Properties['ObjectLockConfiguration']).toEqual({
      ObjectLockEnabled: 'Enabled',
      Rule: { DefaultRetention: { Mode: 'COMPLIANCE', Days: TLOG_OBJECT_LOCK_DAYS } },
    });
    expect(TLOG_OBJECT_LOCK_DAYS).toBe(365);
    expect(bucket.Properties['VersioningConfiguration']).toEqual({ Status: 'Enabled' });
    // 옛 판(매시 덮어쓰는 checkpoint·key)은 보존이 끝난 뒤 지운다 — 보존보다 먼저 지우는 규칙이 아니다.
    expect(bucket.Properties['LifecycleConfiguration']).toEqual({
      Rules: [{ Id: 'ExpireNoncurrentAfterRetention', NoncurrentVersionExpiration: { NoncurrentDays: TLOG_NONCURRENT_EXPIRATION_DAYS }, Status: 'Enabled' }],
    });
    expect(TLOG_NONCURRENT_EXPIRATION_DAYS).toBeGreaterThan(TLOG_OBJECT_LOCK_DAYS);
    expect(bucket.Properties['PublicAccessBlockConfiguration']).toEqual({
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    });
  });

  it('버킷 정책의 Allow 는 CloudFront(그 배포 ARN 조건) 의 log/* GetObject 하나뿐 · 나머지는 TLS 강제 Deny', () => {
    const policy = only(template.findResources('AWS::S3::BucketPolicy')) as { Properties: { PolicyDocument: { Statement: (IamStatement & { Principal?: unknown })[] } } };
    const allows = policy.Properties.PolicyDocument.Statement.filter((statement) => statement.Effect === 'Allow');
    expect(allows).toHaveLength(1);
    expect(allows[0]?.Principal).toEqual({ Service: 'cloudfront.amazonaws.com' });
    expect(actionsOf(allows[0] as IamStatement)).toEqual(['s3:GetObject']);
    expect(JSON.stringify(allows[0]?.Resource)).toContain('/log/*');
    expect(JSON.stringify(allows[0]?.Condition)).toContain('AWS:SourceArn');
    expect(policy.Properties.PolicyDocument.Statement.filter((statement) => statement.Effect === 'Deny').every((statement) => JSON.stringify(statement.Condition).includes('aws:SecureTransport'))).toBe(true);
  });
});

describe('② KMS 서명 키 — 비추출 · 서명 전용 · 역할 하나', () => {
  const keys = Object.values(template.findResources('AWS::KMS::Key')) as { Properties: Record<string, unknown>; DeletionPolicy: string }[];

  it('Ed25519 · P-256 두 키 · SIGN_VERIFY · 가져온 키 아님 · 단일 리전 · RETAIN', () => {
    expect(keys.map((key) => key.Properties['KeySpec']).sort()).toEqual(['ECC_NIST_EDWARDS25519', 'ECC_NIST_P256']);
    for (const key of keys) {
      expect(key.Properties['KeyUsage']).toBe('SIGN_VERIFY');
      // Origin 이 EXTERNAL(가져온 키)이면 개인키 사본이 KMS 밖에 있다 — 비추출이 아니다. 기본(AWS_KMS)만 허용.
      expect(key.Properties['Origin'] === undefined || key.Properties['Origin'] === 'AWS_KMS').toBe(true);
      expect(key.Properties['MultiRegion'] === undefined || key.Properties['MultiRegion'] === false).toBe(true);
      expect(key.DeletionPolicy).toBe('Retain');
    }
  });

  it('키 정책: kms:Sign 명시 Deny(그 키의 역할 ARN 하나만 제외 — 체크포인트 → 로그 역할 · 앵커 → 앵커 역할) — 넓은 IAM 정책으로도 뒤집히지 않는다', () => {
    const expected: Readonly<Record<string, { readonly allowed: string; readonly other: string }>> = {
      ECC_NIST_EDWARDS25519: { allowed: TLOG_RUNTIME_ROLE_NAME, other: TLOG_ANCHOR_RUNTIME_ROLE_NAME },
      ECC_NIST_P256: { allowed: TLOG_ANCHOR_RUNTIME_ROLE_NAME, other: TLOG_RUNTIME_ROLE_NAME },
    };
    for (const key of keys) {
      const statements = (key.Properties['KeyPolicy'] as { Statement: (IamStatement & { Principal?: unknown })[] }).Statement;
      const deny = statements.find((statement) => statement.Sid === DENY_SIGN_EXCEPT_TLOG_SID);
      const roles = expected[key.Properties['KeySpec'] as string];
      expect(roles).toBeDefined();
      expect(deny?.Effect).toBe('Deny');
      expect(deny?.Principal).toEqual({ AWS: '*' });
      expect(actionsOf(deny as IamStatement)).toEqual(['kms:Sign']);
      expect(JSON.stringify(deny?.Condition)).toContain(`role/${roles?.allowed ?? '?'}"`);
      expect(JSON.stringify(deny?.Condition)).not.toContain(`role/${roles?.other ?? '?'}"`);
      expect(JSON.stringify(deny?.Condition)).toContain('ArnNotEquals');
    }
  });
});

describe("②' 체크포인트 키 — 삭제 예약·비활성화 명시 Deny(L6)", () => {
  it('Ed25519 키 정책: 모든 주체에 kms:ScheduleKeyDeletion · kms:DisableKey Deny(조건 없음) — PutKeyPolicy 는 막지 않는다(break-glass)', () => {
    const keys = Object.values(template.findResources('AWS::KMS::Key')) as { Properties: Record<string, unknown> }[];
    const checkpoint = keys.find((key) => key.Properties['KeySpec'] === 'ECC_NIST_EDWARDS25519');
    const statements = (checkpoint?.Properties['KeyPolicy'] as { Statement: (IamStatement & { Principal?: unknown })[] }).Statement;
    const deny = statements.find((statement) => statement.Sid === DENY_CHECKPOINT_KEY_DESTRUCTION_SID);
    expect(deny?.Effect).toBe('Deny');
    expect(deny?.Principal).toEqual({ AWS: '*' });
    expect(actionsOf(deny as IamStatement).sort()).toEqual(['kms:DisableKey', 'kms:ScheduleKeyDeletion']);
    expect(deny?.Condition).toBeUndefined();
    expect(statements.filter((statement) => statement.Effect === 'Deny').flatMap((statement) => actionsOf(statement))).not.toContain('kms:PutKeyPolicy');
  });
});

describe('③ 역할 둘 — 함수마다 최소 권한(M5: 앵커는 체크포인트 키·로그 DB 비밀에 닿지 않는다)', () => {
  const roles = template.findResources('AWS::IAM::Role') as Record<string, { Properties: { RoleName?: string; ManagedPolicyArns?: unknown[] } }>;
  const roleIdOf = (name: string): string => Object.entries(roles).find(([, role]) => role.Properties.RoleName === name)?.[0] ?? '';
  const logRoleId = roleIdOf(TLOG_RUNTIME_ROLE_NAME);
  const anchorRoleId = roleIdOf(TLOG_ANCHOR_RUNTIME_ROLE_NAME);
  const logStatements = statementsByRole(template).get(logRoleId) ?? [];
  const anchorStatements = statementsByRole(template).get(anchorRoleId) ?? [];
  const keyIdOf = (spec: string): string =>
    Object.entries(template.findResources('AWS::KMS::Key') as Record<string, { Properties: { KeySpec: string } }>).find(([, key]) => key.Properties.KeySpec === spec)?.[0] ?? '?';
  const checkpointKeyId = keyIdOf('ECC_NIST_EDWARDS25519');
  const anchorKeyId = keyIdOf('ECC_NIST_P256');

  it('역할은 로그·앵커 둘 · 그 밖의 역할은 스케줄러의 호출 역할뿐(lambda:InvokeFunction 하나)', () => {
    expect(logRoleId).not.toBe('');
    expect(anchorRoleId).not.toBe('');
    expect(logRoleId).not.toBe(anchorRoleId);
    const others = [...statementsByRole(template).entries()].filter(([id]) => id !== logRoleId && id !== anchorRoleId).flatMap(([, list]) => list.flatMap(actionsOf));
    expect([...new Set(others)]).toEqual(['lambda:InvokeFunction']);
  });

  it('로그 역할: kms:Sign(체크포인트 키 · Ed25519 RAW) · GetPublicKey · tlog 비밀 하나 · 게시 키 모양 PutObject · log/checkpoint GetObject — 앵커 키·앵커 비밀 0', () => {
    expect([...new Set(logStatements.flatMap(actionsOf))].sort()).toEqual([
      'kms:Decrypt',
      'kms:GetPublicKey',
      'kms:Sign',
      's3:GetObject',
      's3:ListBucket',
      's3:PutObject',
      'ssm:GetParameter',
    ]);
    // ListBucket — 첫 게시 전 없는 `log/checkpoint` 를 403 이 아니라 404 로 받게(게시 수위 가드, 2026-09-24 운영 첫 틱 실측). 버킷 자체 하나에만.
    const list = logStatements.filter((statement) => actionsOf(statement).includes('s3:ListBucket'));
    expect(list).toHaveLength(1);
    expect(actionsOf(list[0] as IamStatement)).toEqual(['s3:ListBucket']);
    expect(JSON.stringify(list[0]?.Resource)).not.toContain('/*');
    const signs = logStatements.filter((statement) => actionsOf(statement).includes('kms:Sign'));
    expect(signs.map((statement) => statement.Condition)).toEqual([{ StringEquals: { 'kms:SigningAlgorithm': 'ED25519_SHA_512', 'kms:MessageType': 'RAW' } }]);
    const kmsResources = JSON.stringify(logStatements.filter((statement) => actionsOf(statement).some((action) => action.startsWith('kms:'))).map((statement) => statement.Resource));
    expect(kmsResources).toContain(checkpointKeyId);
    expect(kmsResources).not.toContain(anchorKeyId);
    // 2026-10-12 비밀 → SSM 이전 — 자기 DB 비밀 하나(SSM /atmark/db/tlog) + 그 파라미터 문맥의 SSM 경유 Decrypt.
    const secret = logStatements.filter((statement) => actionsOf(statement).includes('ssm:GetParameter'));
    expect(secret).toHaveLength(1);
    expect(readsSsmSecret(secret[0] as IamStatement, 'atmark/db/tlog')).toBe(true);
    expect(readsSsmSecret(secret[0] as IamStatement, 'atmark/db/tlog-anchor')).toBe(false);
    const decrypt = logStatements.filter((statement) => actionsOf(statement).includes('kms:Decrypt'));
    expect(decrypt).toHaveLength(1);
    expect(JSON.stringify(decrypt[0]?.Condition)).toContain(`ssm.${REGION}.amazonaws.com`);
    expect(JSON.stringify(decrypt[0]?.Condition)).toContain(':parameter/atmark/db/tlog"');
    expect(logStatements.some((statement) => actionsOf(statement).some((action) => action.startsWith('secretsmanager:')))).toBe(false);
    const get = logStatements.filter((statement) => actionsOf(statement).includes('s3:GetObject'));
    expect(get).toHaveLength(1);
    expect(JSON.stringify(get[0]?.Resource)).toMatch(/\/log\/checkpoint"\]\]\}$|\/log\/checkpoint"/);
    expect(JSON.stringify(get[0]?.Resource)).not.toContain('log/*');
    // M2 — 게시 키 모양만(`log/*` 통째가 아니다).
    const put = logStatements.filter((statement) => actionsOf(statement).includes('s3:PutObject'));
    expect(put).toHaveLength(1);
    expect(objectKeysOf(put[0]?.Resource).sort()).toEqual([...TLOG_LOG_WRITE_KEYS].sort());
    expect([...TLOG_LOG_WRITE_KEYS].sort()).toEqual(['log/checkpoint', 'log/checkpoints/*', 'log/key', 'log/tile/*']);
    expect(JSON.stringify(roles[logRoleId]?.Properties.ManagedPolicyArns)).not.toMatch(/SES|Admin|FullAccess/i);
  });

  it('앵커 역할: kms:Sign(앵커 키 · ECDSA DIGEST) · GetPublicKey · tlog-anchor 비밀 하나 · 영수증 키 모양 PutObject 뿐 — 체크포인트 키·tlog 비밀·GetObject 0', () => {
    expect([...new Set(anchorStatements.flatMap(actionsOf))].sort()).toEqual(['kms:Decrypt', 'kms:GetPublicKey', 'kms:Sign', 's3:PutObject', 'ssm:GetParameter']);
    const signs = anchorStatements.filter((statement) => actionsOf(statement).includes('kms:Sign'));
    expect(signs.map((statement) => statement.Condition)).toEqual([{ StringEquals: { 'kms:SigningAlgorithm': 'ECDSA_SHA_256', 'kms:MessageType': 'DIGEST' } }]);
    const kmsResources = JSON.stringify(anchorStatements.filter((statement) => actionsOf(statement).some((action) => action.startsWith('kms:'))).map((statement) => statement.Resource));
    expect(kmsResources).toContain(anchorKeyId);
    expect(kmsResources).not.toContain(checkpointKeyId);
    const secret = anchorStatements.filter((statement) => actionsOf(statement).includes('ssm:GetParameter'));
    expect(secret).toHaveLength(1);
    expect(readsSsmSecret(secret[0] as IamStatement, 'atmark/db/tlog-anchor')).toBe(true);
    expect(readsSsmSecret(secret[0] as IamStatement, 'atmark/db/tlog')).toBe(false);
    const decrypt = anchorStatements.filter((statement) => actionsOf(statement).includes('kms:Decrypt'));
    expect(decrypt).toHaveLength(1);
    expect(JSON.stringify(decrypt[0]?.Condition)).toContain(':parameter/atmark/db/tlog-anchor"');
    expect(JSON.stringify(decrypt[0]?.Condition)).not.toContain(':parameter/atmark/db/tlog"');
    const put = anchorStatements.filter((statement) => actionsOf(statement).includes('s3:PutObject'));
    expect(put).toHaveLength(1);
    // M2 — 영수증 키 모양만(`log/anchors/*` 통째가 아니다 — `log/anchors/x.html` 을 쓸 수 없다).
    expect(objectKeysOf(put[0]?.Resource).sort()).toEqual(['log/anchors/ots/*.ots', 'log/anchors/rekor/*.json']);
    expect(JSON.stringify(roles[anchorRoleId]?.Properties.ManagedPolicyArns)).not.toMatch(/SES|Admin|FullAccess/i);
  });
});

describe('④ 런타임에서 투명성 로그 키로 kms:Sign 을 가진 역할은 투명성 로그 역할 둘뿐(로그 · 앵커)', () => {
  it('Compute 템플릿의 kms:Sign 은 Domain Connect 문장 하나뿐(admin · 그 스택의 RSA 키 — 투명성 로그 키가 아니다) · kms:* 없음', () => {
    const computeStatements = [...statementsByRole(compute).values()].flat();
    expect(computeStatements.flatMap(actionsOf).filter((action) => action === 'kms:*')).toEqual([]);
    const signs = computeStatements.filter((statement) => actionsOf(statement).includes('kms:Sign'));
    expect(signs.map((statement) => statement.Sid)).toEqual(['DomainConnectSign']);
    expect(JSON.stringify(signs[0]?.Resource)).toMatch(/DomainConnectSigningKey/);
  });
});

describe('⑤ Lambda 둘 · 스케줄 · DB 연결 예산', () => {
  it('함수 둘 · 예약 동시성 각 1 · VPC · SES 환경 없음 · 스케줄은 과제마다 자기 함수를 부른다', () => {
    const fns = Object.entries(template.findResources('AWS::Lambda::Function')) as [string, FunctionResource][];
    expect(fns.map(([, fn]) => fn.Properties.FunctionName).sort()).toEqual([TLOG_ANCHOR_FUNCTION_NAME, TLOG_FUNCTION_NAME].sort());
    const log = functionNamed(template, TLOG_FUNCTION_NAME);
    const anchor = functionNamed(template, TLOG_ANCHOR_FUNCTION_NAME);
    expect(log.Properties.ReservedConcurrentExecutions).toBe(TLOG_RESERVED_CONCURRENCY);
    expect(anchor.Properties.ReservedConcurrentExecutions).toBe(TLOG_ANCHOR_RESERVED_CONCURRENCY);
    for (const fn of [log, anchor]) {
      expect(fn.Properties['VpcConfig']).toBeDefined();
      const variables = Object.keys(fn.Properties.Environment.Variables);
      expect(variables.some((name) => name.includes('SES') || name === 'ATMARK_DB_SECRET_ARN')).toBe(false);
    }
    const idOf = (name: string): string => fns.find(([, fn]) => fn.Properties.FunctionName === name)?.[0] ?? '?';
    const schedules = Object.values(template.findResources('AWS::Scheduler::Schedule')) as { Properties: { ScheduleExpression: string; Target: { Input: string; Arn: unknown } } }[];
    expect(schedules.map((schedule) => `${schedule.Properties.Target.Input} ${schedule.Properties.ScheduleExpression} ${JSON.stringify(schedule.Properties.Target.Arn)}`).sort()).toEqual(
      [
        `{"task":"anchor"} rate(1 hour) ${JSON.stringify({ 'Fn::GetAtt': [idOf(TLOG_ANCHOR_FUNCTION_NAME), 'Arn'] })}`,
        `{"task":"log"} rate(5 minutes) ${JSON.stringify({ 'Fn::GetAtt': [idOf(TLOG_FUNCTION_NAME), 'Arn'] })}`,
      ].sort(),
    );
  });

  it('M5 — 함수마다 자기 환경만: 로그 함수에 앵커 키·앵커 비밀·캘린더 없음 · 앵커 함수에 체크포인트 키·tlog 비밀 없음', () => {
    const log = Object.keys(functionNamed(template, TLOG_FUNCTION_NAME).Properties.Environment.Variables);
    const anchor = Object.keys(functionNamed(template, TLOG_ANCHOR_FUNCTION_NAME).Properties.Environment.Variables);
    expect(log).toEqual(expect.arrayContaining(['ATMARK_DB_TLOG_SECRET_ARN', 'ATMARK_TLOG_SIGNING_KEY_ARN', 'ATMARK_TLOG_BUCKET', TLOG_COMPOSITION_ENV.origin]));
    expect(log.filter((name) => /ANCHOR|OTS|REKOR/.test(name))).toEqual([]);
    expect(anchor).toEqual(expect.arrayContaining(['ATMARK_DB_TLOG_ANCHOR_SECRET_ARN', 'ATMARK_TLOG_ANCHOR_KEY_ARN', 'ATMARK_TLOG_BUCKET', 'ATMARK_TLOG_OTS_CALENDARS']));
    expect(anchor.filter((name) => name === 'ATMARK_DB_TLOG_SECRET_ARN' || name === 'ATMARK_TLOG_SIGNING_KEY_ARN')).toEqual([]);
  });

  it('알람 — 로그(5분 × 3 연속) · 앵커(1시간 × 3 연속) 오류', () => {
    const alarms = Object.values(template.findResources('AWS::CloudWatch::Alarm')) as { Properties: { AlarmName: string; Period: number; EvaluationPeriods: number } }[];
    expect(alarms.map((alarm) => `${alarm.Properties.AlarmName} ${String(alarm.Properties.Period)}x${String(alarm.Properties.EvaluationPeriods)}`).sort()).toEqual([
      'atmark-transparency-anchor-errors 3600x3',
      'atmark-transparency-log-errors 300x3',
    ]);
  });

  it('Compute 의 연결(예약 동시성 × 풀) + 확인 틱 1 + AI 감시 결과 1 + 실시간 1 = 70, 이 두 함수(1 × 1 씩)를 더해 72 ≤ 75 — api 10 → 9 → 8 → 7 이 결제 sync 1 · 운영자 콘솔 2 · AI 감시 결과 1 을 냈고 실시간 1(묶음 E)이 org-api 몫 2 에서 하나를 썼다(WP-2 · ADR-0015 · ADR-0014 단계 4 · ADR-0017 초안)', async () => {
    const { DB_POOL_MAX, MIGRATION_POOL_MAX, CONTACT_FORWARDER_POOL_MAX } = await import('../../../src/runtime/composition');
    const { BILLING_SYNC_POOL_MAX } = await import('../../../src/runtime/billing-composition');
    const { BILLING_WEBHOOK_POOL_MAX } = await import('../../../src/runtime/billing-webhook-composition');
    const { ADMIN_POOL_MAX, DOMAIN_TICK_POOL_MAX } = await import('../../../src/runtime/admin-composition');
    const { LOGIN_MAILER_POOL_MAX } = await import('../../../src/runtime/login-mailer-composition');
    const { PASSPORT_SIGNER_POOL_MAX } = await import('../../../src/runtime/passport-signer-composition');
    const { OPS_FUNCTION_NAME, OPS_POOL_MAX } = await import('../../../src/ops/contract');
    const { DOMAIN_CONTROL_POOL_MAX } = await import('../../../src/runtime/handlers/domain-control');
    const { AI_WATCH_RESULT_FUNCTION_NAME, AI_WATCH_RESULT_POOL_MAX } = await import('../../../src/inbound/ai-watch/contract');
    const { REALTIME_FUNCTION_NAME, REALTIME_POOL_MAX } = await import('../../../src/realtime/contract');
    const pools: Readonly<Record<string, number>> = {
      // ADR-0014 단계 2 — domain-control 2 × 풀 0(DB 없음). 합은 그대로 72.
      'atmark-domain-control': DOMAIN_CONTROL_POOL_MAX,
      'atmark-domain-policy-audit': DOMAIN_CONTROL_POOL_MAX,
      'atmark-migrate': MIGRATION_POOL_MAX,
      'atmark-admin': ADMIN_POOL_MAX,
      'atmark-login-mailer': LOGIN_MAILER_POOL_MAX,
      'atmark-passport-signer': PASSPORT_SIGNER_POOL_MAX,
      'atmark-contact-forwarder': CONTACT_FORWARDER_POOL_MAX,
      'atmark-billing-sync': BILLING_SYNC_POOL_MAX,
      'atmark-billing-webhook': BILLING_WEBHOOK_POOL_MAX,
      [OPS_FUNCTION_NAME]: OPS_POOL_MAX,
      [AI_WATCH_RESULT_FUNCTION_NAME]: AI_WATCH_RESULT_POOL_MAX,
      // 묶음 E — 실시간 WebSocket 1 × 1(org-api 몫 2 → 1).
      [REALTIME_FUNCTION_NAME]: REALTIME_POOL_MAX,
    };
    const fns = Object.values(compute.findResources('AWS::Lambda::Function')) as { Properties: { FunctionName: string; ReservedConcurrentExecutions: number } }[];
    // 확인 틱(admin λ 안 · 틱 롤 풀 크기 1 · 스케줄러만 부른다 — 한 번에 하나)은 예약 동시성과 곱하지 않고 1 을 더한다(리드 결정 72 → 73).
    const computeConnections =
      fns.reduce((sum, fn) => sum + fn.Properties.ReservedConcurrentExecutions * (pools[fn.Properties.FunctionName] ?? DB_POOL_MAX), 0) + DOMAIN_TICK_POOL_MAX;
    const tlogFunctions = Object.values(template.findResources('AWS::Lambda::Function')) as { Properties: { ReservedConcurrentExecutions: number } }[];
    const tlogConnections = tlogFunctions.reduce((sum, fn) => sum + fn.Properties.ReservedConcurrentExecutions * TRANSPARENCY_POOL_MAX, 0);
    expect(TRANSPARENCY_POOL_MAX).toBe(1);
    expect(tlogConnections).toBe(2);
    expect(computeConnections).toBe(70);
    expect(computeConnections + tlogConnections).toBe(72);
    expect(computeConnections + tlogConnections).toBeLessThanOrEqual(75);
  });
});

describe('①\' 이름·origin·Rekor — 운영 값 고정 · 컨텍스트로 바꿀 수 있다', () => {
  it('운영 기본값: 버킷 atmark-tlog-<계정>-<리전> · origin = 코드 상수 · Rekor 는 샤드 키 없이 꺼져 있다', () => {
    expect(transparencyLogBucketName(ACCOUNT, REGION)).toBe(`atmark-tlog-${ACCOUNT}-${REGION}`);
    expect(TLOG_DEFAULT_ORIGIN).toBe(TLOG_ORIGIN);
    expect(transparencyLogOrigin()).toBe('id.atmark.ai/log/v1');
    expect(functionNamed(template, TLOG_FUNCTION_NAME).Properties.Environment.Variables[TLOG_COMPOSITION_ENV.origin]).toBe(TLOG_ORIGIN);
    const env = functionNamed(template, TLOG_ANCHOR_FUNCTION_NAME).Properties.Environment.Variables;
    expect(env['ATMARK_TLOG_REKOR_URL']).toBe('');
    expect(env[TLOG_COMPOSITION_ENV.rekorVkey]).toBe('');
  });

  it('컨텍스트(스테이징): 다른 버킷 · 다른 origin · Rekor 샤드 키를 주면 Rekor URL 이 켜진다 · 모양이 틀리면 합성 실패', () => {
    const previous = process.env['CDK_CONTEXT_JSON'];
    process.env['CDK_CONTEXT_JSON'] = JSON.stringify({
      'atmark:tlogBucketName': 'atmark-tlog-staging-example',
      'atmark:tlogOrigin': 'staging.id.atmark.ai/log/v1',
      'atmark:tlogRekorUrl': 'https://log2026-1.rekor.sigstore.dev',
      'atmark:tlogRekorVkey': 'log2026-1.rekor.sigstore.dev+00000000+AQ==',
    });
    try {
      const staging = Template.fromStack(buildRuntimeApp().transparency);
      const bucket = only(staging.findResources('AWS::S3::Bucket')) as { Properties: Record<string, unknown> };
      expect(bucket.Properties['BucketName']).toBe('atmark-tlog-staging-example');
      expect(functionNamed(staging, TLOG_FUNCTION_NAME).Properties.Environment.Variables[TLOG_COMPOSITION_ENV.origin]).toBe('staging.id.atmark.ai/log/v1');
      expect(functionNamed(staging, TLOG_ANCHOR_FUNCTION_NAME).Properties.Environment.Variables['ATMARK_TLOG_REKOR_URL']).toBe('https://log2026-1.rekor.sigstore.dev');
      // 샤드 키 이름이 샤드 호스트와 다르면 합성하지 않는다.
      process.env['CDK_CONTEXT_JSON'] = JSON.stringify({ 'atmark:tlogRekorVkey': 'log2026-1.rekor.sigstore.dev+00000000+AQ==' });
      expect(() => buildRuntimeApp()).toThrow(/Rekor 샤드 호스트/);
    } finally {
      if (previous === undefined) delete process.env['CDK_CONTEXT_JSON'];
      else process.env['CDK_CONTEXT_JSON'] = previous;
    }
    const node = (context: Record<string, string>): { tryGetContext(key: string): unknown } => ({ tryGetContext: (key: string) => context[key] });
    expect(() => transparencyLogBucketName(ACCOUNT, REGION, node({ 'atmark:tlogBucketName': 'Bad_Bucket' }))).toThrow(/버킷 이름/);
    expect(() => transparencyLogOrigin(node({ 'atmark:tlogOrigin': 'https://id.atmark.ai/log' }))).toThrow(/origin/);
  });
});

describe('⑥ 배선 — id.atmark.ai/log/* · migrate 의 비밀 쓰기', () => {
  it('identity 배포에 /log/* 동작(로그 버킷 오리진, GET/HEAD)', () => {
    const distribution = only(identity.findResources('AWS::CloudFront::Distribution')) as {
      Properties: { DistributionConfig: { CacheBehaviors: { PathPattern: string; TargetOriginId: string; AllowedMethods: string[] }[]; Origins: { Id: string; DomainName: unknown }[] } };
    };
    const config = distribution.Properties.DistributionConfig;
    const behavior = config.CacheBehaviors.find((candidate) => candidate.PathPattern === '/log/*');
    expect(behavior?.AllowedMethods).toEqual(['GET', 'HEAD']);
    const origin = config.Origins.find((candidate) => candidate.Id === behavior?.TargetOriginId);
    expect(JSON.stringify(origin?.DomainName)).toContain(transparencyLogBucketName(ACCOUNT, REGION));
  });

  it('migrate 는 tlog DB 비밀 둘(SSM)에 PutParameter · 환경 변수로 SSM 이름을 받는다 · 로그·앵커 함수도 SSM 이름', () => {
    const fns = compute.findResources('AWS::Lambda::Function') as Record<string, { Properties: { FunctionName: string; Environment: { Variables: Record<string, unknown> } } }>;
    const migrate = Object.values(fns).find((fn) => fn.Properties.FunctionName === 'atmark-migrate');
    expect(migrate?.Properties.Environment.Variables['ATMARK_DB_TLOG_SECRET_ARN']).toBe('/atmark/db/tlog');
    expect(migrate?.Properties.Environment.Variables['ATMARK_DB_TLOG_ANCHOR_SECRET_ARN']).toBe('/atmark/db/tlog-anchor');
    const write = [...statementsByRole(compute).values()].flat().find((statement) => statement.Sid === 'DbRoleSecretsWrite');
    expect(write === undefined ? false : writesSsmSecret(write, 'atmark/db/tlog')).toBe(true);
    expect(write === undefined ? false : writesSsmSecret(write, 'atmark/db/tlog-anchor')).toBe(true);
    // 옛 자리(이 스택 소유 Secrets Manager 비밀)는 남아 있다 — 다음 PR 에서 지운다(배포 런북 §49 ④). migrate 는 확인 읽기만.
    const legacy = [...statementsByRole(compute).values()].flat().find((statement) => statement.Sid === 'DbRoleLegacySecretsRead');
    expect(JSON.stringify(legacy?.Resource)).toContain('DbTlogSecret');
    expect(JSON.stringify(legacy?.Resource)).toContain('DbTlogAnchorSecret');
    const tlogFns = template.findResources('AWS::Lambda::Function') as Record<string, { Properties: { Environment: { Variables: Record<string, unknown> } } }>;
    const values = Object.values(tlogFns).flatMap((fn) =>
      ['ATMARK_DB_TLOG_SECRET_ARN', 'ATMARK_DB_TLOG_ANCHOR_SECRET_ARN'].map((name) => fn.Properties.Environment.Variables[name]).filter((v) => v !== undefined),
    );
    expect(values.sort()).toEqual(['/atmark/db/tlog', '/atmark/db/tlog-anchor']);
  });
});

describe('⑦ M2 — 쓰기 키 모양 · /log/* 경로 가드 · 응답 헤더', () => {
  type Guard = (event: { request: { uri: string } }) => { statusCode?: number; uri?: string };
  const guard = new Function(`${TRANSPARENCY_LOG_PATH_GUARD_SOURCE}\nreturn handler;`)() as Guard;
  const served = (uri: string): boolean => guard({ request: { uri } }).statusCode === undefined;
  /** 생산자가 실제로 쓰는 키(`log/` 아래 상대 경로) — 타일은 `rightmostTiles` 의 출력, 게시·앵커는 `publisher.ts` · `anchor.ts` 의 모양. */
  const produced = (): string[] => {
    const paths = new Set<string>(['checkpoint', 'key', 'checkpoints/0', 'checkpoints/12345', 'anchors/rekor/0', 'anchors/rekor/987'].map((p) => (p.startsWith('anchors/rekor/') ? `${p}.json` : p)));
    const hashes = Array.from({ length: 65_537 }, (_, i) => Buffer.alloc(32, i % 251));
    for (const size of [1, 2, 255, 256, 257, 513, 65_536, 65_537]) {
      for (const tile of rightmostTiles(hashes, hashes, size)) paths.add(tile.path);
    }
    // 큰 로그의 타일 번호(`x001/x234/067`) — 같은 생산자 함수.
    for (const level of [0, 1, 2, 'entries'] as const) for (const width of [1, 17, 256]) paths.add(tilePath(level, 1_234_067, width));
    for (const endpoint of TLOG_OTS_CALENDARS) for (const epoch of [0, 41]) paths.add(`anchors/ots/${String(epoch)}/${new URL(endpoint).hostname}.ots`);
    return [...paths];
  };
  const globToRegExp = (glob: string): RegExp => new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
  const writable = (key: string, globs: readonly string[]): boolean => globs.some((glob) => globToRegExp(glob).test(key));

  it('생산자가 쓰는 모든 키: 로그·앵커 중 정확히 한 역할이 쓸 수 있고, 경로 가드가 내보낸다', () => {
    const paths = produced();
    expect(paths.some((p) => p.includes('.p/'))).toBe(true);
    expect(paths.some((p) => p.includes('/x'))).toBe(true);
    expect(paths.some((p) => p.startsWith('tile/entries/'))).toBe(true);
    for (const path of paths) {
      const key = `log/${path}`;
      expect(writable(key, TLOG_LOG_WRITE_KEYS) !== writable(key, TLOG_ANCHOR_WRITE_KEYS), key).toBe(true);
      expect(served(`/${key}`), key).toBe(true);
    }
    // 앵커 역할은 로그 경로에, 로그 역할은 앵커 영수증에 쓰지 못한다.
    expect(writable('log/checkpoint', TLOG_ANCHOR_WRITE_KEYS)).toBe(false);
    expect(writable('log/anchors/rekor/1.json', TLOG_LOG_WRITE_KEYS)).toBe(false);
  });

  it('모양 밖 URI 는 404 — 앵커 역할이 쓸 수 있는 임의 키·HTML·경로 조작·쿼리 없는 변형 모두', () => {
    for (const uri of [
      '/log/anchors/x.html',
      '/log/anchors/rekor/1.html',
      '/log/anchors/rekor/evil.json',
      '/log/anchors/rekor/1.json/../x',
      '/log/anchors/ots/1/evil.html.ots/x',
      '/log/anchors/ots/1/EVIL.ots',
      '/log/anchors/ots/01/a.pool.opentimestamps.org.ots',
      '/log/checkpoints/abc',
      '/log/checkpoints/1.html',
      '/log/checkpoint.html',
      '/log/tile/0/000.html',
      '/log/tile/0/12',
      '/log/tile/0/000.p/256',
      '/log/tile/0/000.p/0',
      '/log/tile/entries/x1/000',
      '/log/',
      '/log/index.html',
      '/log/key/',
    ]) {
      expect(guard({ request: { uri } }).statusCode, uri).toBe(404);
    }
  });

  it('identity 배포 /log/* 동작: 경로 가드(viewer-request, cloudfront-js-2.0) · 응답 헤더 정책(nosniff · CSP sandbox · CORS GET/HEAD 자격 없음) · 캐시 정책은 그대로', () => {
    const distribution = only(identity.findResources('AWS::CloudFront::Distribution')) as {
      Properties: {
        DistributionConfig: {
          CacheBehaviors: { PathPattern: string; CachePolicyId: string; ResponseHeadersPolicyId: unknown; FunctionAssociations?: { EventType: string; FunctionARN: unknown }[] }[];
        };
      };
    };
    const behavior = distribution.Properties.DistributionConfig.CacheBehaviors.find((candidate) => candidate.PathPattern === '/log/*');
    // 관리형 CachingOptimized(오리진 Cache-Control 을 따른다 — 체크포인트 60초 · 타일 1년).
    expect(behavior?.CachePolicyId).toBe('658327ea-f89d-4fab-a63d-7e88639e58f6');
    expect(behavior?.FunctionAssociations).toHaveLength(1);
    expect(behavior?.FunctionAssociations?.[0]?.EventType).toBe('viewer-request');
    const fnId = Object.keys(identity.findResources('AWS::CloudFront::Function')).find((id) => JSON.stringify(behavior?.FunctionAssociations?.[0]?.FunctionARN).includes(id));
    const fn = identity.findResources('AWS::CloudFront::Function')[fnId ?? ''] as { Properties: { FunctionCode: string; FunctionConfig: { Runtime: string } } };
    expect(fn.Properties.FunctionConfig.Runtime).toBe('cloudfront-js-2.0');
    expect(fn.Properties.FunctionCode).toBe(TRANSPARENCY_LOG_PATH_GUARD_SOURCE);
    const policies = identity.findResources('AWS::CloudFront::ResponseHeadersPolicy') as Record<
      string,
      { Properties: { ResponseHeadersPolicyConfig: { Name: string; CorsConfig: Record<string, unknown>; SecurityHeadersConfig: Record<string, Record<string, unknown>> } } }
    >;
    const [policyId, policy] = Object.entries(policies).find(([, candidate]) => candidate.Properties.ResponseHeadersPolicyConfig.Name === 'atmark-transparency-log') ?? [];
    expect(JSON.stringify(behavior?.ResponseHeadersPolicyId)).toContain(policyId ?? '?');
    const config = policy?.Properties.ResponseHeadersPolicyConfig;
    expect(config?.SecurityHeadersConfig['ContentTypeOptions']).toEqual({ Override: true });
    expect(config?.SecurityHeadersConfig['ContentSecurityPolicy']).toEqual({ ContentSecurityPolicy: "default-src 'none'; sandbox", Override: true });
    expect(TRANSPARENCY_LOG_CSP).toBe("default-src 'none'; sandbox");
    expect(config?.CorsConfig['AccessControlAllowCredentials']).toBe(false);
    expect(config?.CorsConfig['AccessControlAllowMethods']).toEqual({ Items: ['GET', 'HEAD'] });
    expect(config?.CorsConfig['AccessControlAllowOrigins']).toEqual({ Items: ['*'] });
  });
});
