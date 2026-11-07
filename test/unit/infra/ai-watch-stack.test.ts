/**
 * AI 의심 메일 감시(ADR-0017 초안) 인프라 — AtmarkAiWatch(CMK · 큐 셋 · Mac IAM 사용자)와 AtmarkCompute 의 결선(결과 λ · inbound 송신 · 비밀 · 킬 스위치).
 *
 * 단언의 축: **최소 권한**(Mac 사용자는 SQS 둘 + Decrypt · 명시 NotAction Deny / 결과 λ 는 자기 DB 비밀 + 결과 큐 소비 / inbound 는 SendMessage 하나) ·
 * **복호화 주체는 정확히 둘**(키 정책 — 루트 문장에 데이터 동작·CreateGrant 없음 · 두 조건) · **본문의 두 번째 보관 장소 없음**(요청 큐 DLQ 없음 · 보존 300초) ·
 * **SES·S3 0** · 계약 상수와 글자 단위로 같다(`src/inbound/ai-watch/contract.ts`).
 */

import * as cdk from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

import {
  AI_WATCH_INBOUND_ROLE_NAME,
  AI_WATCH_KEY_ADMIN_ACTIONS,
  AI_WATCH_KEY_SIDS,
  AI_WATCH_RESULT_TIMEOUT_SECONDS,
  AI_WATCH_RESULT_VISIBILITY_SECONDS,
  AiWatchStack,
} from '../../../infra/cdk/stacks/ai-watch-stack';
import {
  AI_WATCH_MODE_CONTEXT_KEY,
  AI_WATCH_QUEUES_READY_CONTEXT_KEY,
  aiWatchModeOf,
  aiWatchQueuesReadyOf,
} from '../../../infra/cdk/stacks/compute-stack';
import {
  AI_WATCH_DB_SECRET_NAME,
  AI_WATCH_ENV,
  AI_WATCH_IAM_USER,
  AI_WATCH_KMS_ALIAS,
  AI_WATCH_QUEUES,
  AI_WATCH_REQUEST_RETENTION_SECONDS,
  AI_WATCH_REQUEST_VISIBILITY_SECONDS,
  AI_WATCH_RESULT_BATCH_SIZE,
  AI_WATCH_RESULT_FUNCTION_NAME,
  AI_WATCH_RESULT_MAX_RECEIVE,
  AI_WATCH_RESULT_RETENTION_SECONDS,
} from '../../../src/inbound/ai-watch/contract';
import { AI_WATCH_IAM_ACTIONS, AI_WATCH_KMS_CONDITIONS } from '../../../infra/cdk/ai-watch-iam';
import {
  ACCOUNT,
  REGION,
  actionsOf,
  allStatementsByRole,
  buildRuntimeApp,
  readsSsmSecret,
  runtimeTemplates,
  statementsByRole,
  type IamStatement,
} from './runtime-app';

const REQUEST_QUEUE_ARN = `arn:aws:sqs:${REGION}:${ACCOUNT}:${AI_WATCH_QUEUES.request}`;
const RESULT_QUEUE_ARN = `arn:aws:sqs:${REGION}:${ACCOUNT}:${AI_WATCH_QUEUES.result}`;

let aiWatchTemplate: Template | undefined;
function aiWatch(): Template {
  aiWatchTemplate ??= Template.fromStack(new AiWatchStack(new cdk.App(), 'AtmarkAiWatch', { env: { account: ACCOUNT, region: REGION } }));
  return aiWatchTemplate;
}

interface QueueProps {
  QueueName: string;
  MessageRetentionPeriod?: number;
  VisibilityTimeout?: number;
  KmsMasterKeyId?: unknown;
  SqsManagedSseEnabled?: boolean;
  RedrivePolicy?: { deadLetterTargetArn: unknown; maxReceiveCount: number };
}

function queues(): Map<string, { id: string; props: QueueProps }> {
  const found = aiWatch().findResources('AWS::SQS::Queue') as Record<string, { Properties: QueueProps }>;
  return new Map(Object.entries(found).map(([id, q]) => [q.Properties.QueueName, { id, props: q.Properties }]));
}

interface KeyStatement {
  Sid: string;
  Effect: string;
  Principal: { AWS: unknown };
  Action: string | string[];
  Resource: string;
  Condition?: Record<string, Record<string, unknown>>;
}

function keyStatements(): KeyStatement[] {
  const keys = Object.values(aiWatch().findResources('AWS::KMS::Key')) as { Properties: { KeyPolicy: { Statement: KeyStatement[] } } }[];
  expect(keys).toHaveLength(1);
  return keys[0]!.Properties.KeyPolicy.Statement;
}

const asList = (value: string | string[]): string[] => (typeof value === 'string' ? [value] : [...value]);

describe('AtmarkAiWatch — 큐', () => {
  it('요청 큐: 보존 300초 · 가시성 15초 · DLQ 없음 · SSE-KMS(이 스택의 CMK)', () => {
    const request = queues().get(AI_WATCH_QUEUES.request)!.props;
    expect(request.MessageRetentionPeriod).toBe(AI_WATCH_REQUEST_RETENTION_SECONDS);
    expect(request.VisibilityTimeout).toBe(AI_WATCH_REQUEST_VISIBILITY_SECONDS);
    expect(request.RedrivePolicy).toBeUndefined();
    const keyId = Object.keys(aiWatch().findResources('AWS::KMS::Key'))[0]!;
    expect(JSON.stringify(request.KmsMasterKeyId)).toContain(keyId);
    expect(request.SqsManagedSseEnabled).toBeUndefined();
  });

  it('결과 큐: 보존 1일 · SSE-SQS · DLQ maxReceive 3 · 가시성 = 결과 λ 타임아웃 × 6 / DLQ: 14일 · SSE-SQS', () => {
    const all = queues();
    const result = all.get(AI_WATCH_QUEUES.result)!.props;
    const dlq = all.get(AI_WATCH_QUEUES.resultDlq)!;
    expect(all.size).toBe(3);
    expect(result.MessageRetentionPeriod).toBe(AI_WATCH_RESULT_RETENTION_SECONDS);
    expect(result.SqsManagedSseEnabled).toBe(true);
    expect(result.KmsMasterKeyId).toBeUndefined();
    expect(result.VisibilityTimeout).toBe(AI_WATCH_RESULT_VISIBILITY_SECONDS);
    expect(AI_WATCH_RESULT_VISIBILITY_SECONDS).toBe(6 * AI_WATCH_RESULT_TIMEOUT_SECONDS);
    expect(result.RedrivePolicy?.maxReceiveCount).toBe(AI_WATCH_RESULT_MAX_RECEIVE);
    expect(JSON.stringify(result.RedrivePolicy?.deadLetterTargetArn)).toContain(dlq.id);
    expect(dlq.props.MessageRetentionPeriod).toBe(14 * 86_400);
    expect(dlq.props.SqsManagedSseEnabled).toBe(true);
  });

  it('세 큐 모두 TLS 아닌 요청 Deny(aws:SecureTransport=false)', () => {
    const policies = Object.values(aiWatch().findResources('AWS::SQS::QueuePolicy')) as { Properties: { Queues: unknown[]; PolicyDocument: { Statement: IamStatement[] } } }[];
    const covered = policies.filter((p) =>
      p.Properties.PolicyDocument.Statement.some((s) => s.Effect === 'Deny' && JSON.stringify(s.Condition) === JSON.stringify({ Bool: { 'aws:SecureTransport': 'false' } })),
    );
    expect(covered.flatMap((p) => p.Properties.Queues)).toHaveLength(3);
    // 큐 정책은 Deny 만 — 자원 정책으로 누구에게도 허용을 주지 않는다(권한은 IAM 사용자 · 결과 λ 역할 쪽에만).
    for (const p of policies) for (const s of p.Properties.PolicyDocument.Statement) expect(s.Effect).toBe('Deny');
  });
});

describe('AtmarkAiWatch — CMK 키 정책(복호화 주체는 정확히 둘)', () => {
  it('별칭 · 자동 회전 · 문장 셋(관리 · Mac · inbound)', () => {
    aiWatch().hasResourceProperties('AWS::KMS::Alias', { AliasName: AI_WATCH_KMS_ALIAS });
    aiWatch().hasResourceProperties('AWS::KMS::Key', { EnableKeyRotation: true });
    expect(keyStatements().map((s) => s.Sid).sort()).toEqual(Object.values(AI_WATCH_KEY_SIDS).sort());
  });

  it('루트(= IAM 관리자) 문장은 관리 동작만 — 데이터 동작 · CreateGrant · 와일드카드 없음(IAM 정책으로 복호화를 줄 수 없다)', () => {
    const admin = keyStatements().find((s) => s.Sid === AI_WATCH_KEY_SIDS.admin)!;
    expect(JSON.stringify(admin.Principal)).toContain(':root');
    const actions = asList(admin.Action);
    expect(actions.sort()).toEqual([...AI_WATCH_KEY_ADMIN_ACTIONS].sort());
    for (const action of actions) {
      expect(action).not.toMatch(/\*|Decrypt|Encrypt|GenerateDataKey|ReEncrypt|CreateGrant|Sign|Verify|Mac$/);
    }
    expect(actions).toContain('kms:PutKeyPolicy'); // 잠금 안전 검사 — CloudFormation 이 키를 계속 관리한다
  });

  it('Mac 사용자 Decrypt · inbound 역할 GenerateDataKey+Decrypt — 둘 다 ViaService(SQS) + 요청 큐 ARN 문맥 조건', () => {
    const statements = keyStatements();
    const expected = {
      StringEquals: {
        [AI_WATCH_KMS_CONDITIONS.viaServiceKey]: AI_WATCH_KMS_CONDITIONS.viaService,
        [AI_WATCH_KMS_CONDITIONS.queueArnContextKey]: REQUEST_QUEUE_ARN,
      },
    };
    const worker = statements.find((s) => s.Sid === AI_WATCH_KEY_SIDS.worker)!;
    expect(asList(worker.Action)).toEqual([...AI_WATCH_IAM_ACTIONS.workerKms]);
    expect(worker.Condition).toEqual(expected);
    expect(JSON.stringify(worker.Principal)).toContain('WorkerUser');
    const inbound = statements.find((s) => s.Sid === AI_WATCH_KEY_SIDS.inbound)!;
    expect(asList(inbound.Action).sort()).toEqual([...AI_WATCH_IAM_ACTIONS.inboundKms].sort());
    expect(inbound.Condition).toEqual(expected);
    expect(inbound.Principal).toEqual({ AWS: `arn:aws:iam::${ACCOUNT}:role/${AI_WATCH_INBOUND_ROLE_NAME}` });
    expect(AI_WATCH_KMS_CONDITIONS.viaService).toBe(`sqs.${REGION}.amazonaws.com`);
    // 데이터 동작을 받는 주체는 이 둘뿐.
    const dataStatements = statements.filter((s) => asList(s.Action).some((a) => /Decrypt|GenerateDataKey|Encrypt/.test(a)));
    expect(dataStatements.map((s) => s.Sid).sort()).toEqual([AI_WATCH_KEY_SIDS.inbound, AI_WATCH_KEY_SIDS.worker].sort());
  });

  it('키 정책의 inbound 주체 이름 = Compute 가 만드는 inbound 역할 이름', () => {
    const roles = runtimeTemplates().compute.findResources('AWS::IAM::Role') as Record<string, { Properties: { RoleName?: string } }>;
    expect(Object.values(roles).map((r) => r.Properties.RoleName)).toContain(AI_WATCH_INBOUND_ROLE_NAME);
  });
});

describe('AtmarkAiWatch — Mac IAM 사용자(SQS 둘 + Decrypt, 그 밖 명시 Deny)', () => {
  const userStatements = (): IamStatement[] => {
    const policies = Object.values(aiWatch().findResources('AWS::IAM::Policy')) as { Properties: { Users?: unknown[]; PolicyDocument: { Statement: IamStatement[] } } }[];
    expect(policies).toHaveLength(1);
    expect(policies[0]!.Properties.Users).toHaveLength(1);
    return policies[0]!.Properties.PolicyDocument.Statement;
  };

  it('사용자 하나 · 이름 계약 · 콘솔 로그인 없음 · **액세스 키를 만들지 않는다** · 관리형 정책 0', () => {
    const t = aiWatch();
    t.resourceCountIs('AWS::IAM::User', 1);
    t.hasResourceProperties('AWS::IAM::User', { UserName: AI_WATCH_IAM_USER });
    t.resourceCountIs('AWS::IAM::AccessKey', 0);
    const user = Object.values(t.findResources('AWS::IAM::User'))[0] as { Properties: Record<string, unknown> };
    expect(user.Properties['LoginProfile']).toBeUndefined();
    expect(user.Properties['ManagedPolicyArns']).toBeUndefined();
    expect(user.Properties['Groups']).toBeUndefined();
  });

  it('허용 셋 — 요청 큐 소비 · 결과 큐 송신 · CMK Decrypt(조건 둘) — 자원은 전부 고정(와일드카드 없음)', () => {
    const allows = userStatements().filter((s) => s.Effect === 'Allow');
    expect(allows.map((s) => s.Sid).sort()).toEqual(['RequestQueueConsume', 'RequestQueueKeyDecryptViaSqs', 'ResultQueueSend']);
    const bySid = new Map(allows.map((s) => [s.Sid, s]));
    expect(actionsOf(bySid.get('RequestQueueConsume')!).sort()).toEqual([...AI_WATCH_IAM_ACTIONS.workerRequestQueue].sort());
    expect(JSON.stringify(bySid.get('RequestQueueConsume')!.Resource)).toContain(queues().get(AI_WATCH_QUEUES.request)!.id);
    expect(actionsOf(bySid.get('ResultQueueSend')!)).toEqual([...AI_WATCH_IAM_ACTIONS.workerResultQueue]);
    expect(JSON.stringify(bySid.get('ResultQueueSend')!.Resource)).toContain(queues().get(AI_WATCH_QUEUES.result)!.id);
    expect(actionsOf(bySid.get('RequestQueueKeyDecryptViaSqs')!)).toEqual([...AI_WATCH_IAM_ACTIONS.workerKms]);
    expect(bySid.get('RequestQueueKeyDecryptViaSqs')!.Condition).toEqual({
      StringEquals: { 'kms:ViaService': `sqs.${REGION}.amazonaws.com`, 'kms:EncryptionContext:aws:sqs:arn': REQUEST_QUEUE_ARN },
    });
    for (const s of allows) {
      expect(JSON.stringify(s.Resource)).not.toContain('*');
      for (const a of actionsOf(s)) expect(a).not.toMatch(/\*|^(ses|s3|cloudwatch|logs|sts|iam|secretsmanager):/);
    }
  });

  it('명시 Deny(NotAction = 허용 동작 정확히) — 나중에 붙는 넓은 정책도 SQS 둘 + Decrypt 밖으로 못 나간다', () => {
    const deny = userStatements().find((s) => s.Effect === 'Deny') as IamStatement & { NotAction?: string[] };
    expect(deny.Sid).toBe('DenyEverythingElse');
    expect(deny.Resource).toBe('*');
    expect([...(deny.NotAction ?? [])].sort()).toEqual(
      [...new Set([...AI_WATCH_IAM_ACTIONS.workerRequestQueue, ...AI_WATCH_IAM_ACTIONS.workerResultQueue, ...AI_WATCH_IAM_ACTIONS.workerKms])].sort(),
    );
  });

  it('이 스택에는 Lambda · 역할 · 버킷 · SES 가 없다(선로뿐)', () => {
    const t = aiWatch();
    for (const type of ['AWS::Lambda::Function', 'AWS::IAM::Role', 'AWS::S3::Bucket', 'AWS::SES::ConfigurationSet', 'AWS::SecretsManager::Secret']) t.resourceCountIs(type, 0);
    expect(JSON.stringify(t.toJSON())).not.toMatch(/"ses:|"s3:/);
  });
});

// ---------------------------------------------------------------------------
// AtmarkCompute 결선
// ---------------------------------------------------------------------------

interface FunctionProps {
  FunctionName: string;
  Timeout: number;
  ReservedConcurrentExecutions: number;
  VpcConfig?: unknown;
  Role: { 'Fn::GetAtt': [string, string] };
  Environment: { Variables: Record<string, unknown> };
}

function functionsOf(template: Template): Map<string, { id: string; props: FunctionProps }> {
  const fns = template.findResources('AWS::Lambda::Function') as Record<string, { Properties: FunctionProps }>;
  return new Map(Object.entries(fns).map(([id, f]) => [f.Properties.FunctionName, { id, props: f.Properties }]));
}

function computeWithContext(context: Record<string, string>): Template {
  const previous = process.env['CDK_CONTEXT_JSON'];
  process.env['CDK_CONTEXT_JSON'] = JSON.stringify(context);
  try {
    return Template.fromStack(buildRuntimeApp().compute);
  } finally {
    if (previous === undefined) delete process.env['CDK_CONTEXT_JSON'];
    else process.env['CDK_CONTEXT_JSON'] = previous;
  }
}

describe('AtmarkCompute — AI 감시 결과 λ', () => {
  const compute = (): Template => runtimeTemplates().compute;
  const result = (): { id: string; props: FunctionProps } => functionsOf(compute()).get(AI_WATCH_RESULT_FUNCTION_NAME)!;

  it('VPC 안 · 예약 1 · 타임아웃 = AtmarkAiWatch 가시성 산식의 값 · 환경은 자기 DB 비밀 위치 + TLS 뿐', () => {
    const fn = result().props;
    expect(fn.VpcConfig).toBeDefined();
    expect(fn.ReservedConcurrentExecutions).toBe(1);
    expect(fn.Timeout).toBe(AI_WATCH_RESULT_TIMEOUT_SECONDS);
    // 묶음 E — 판정이 보류를 풀면 실시간 힌트(`@connections` 엔드포인트 위치만 — 권한은 아래 `RealtimePostToConnection` 하나).
    expect(Object.keys(fn.Environment.Variables).sort()).toEqual([
      'ATMARK_DB_AI_WATCH_SECRET_ARN',
      'ATMARK_ENV',
      'ATMARK_REALTIME_CALLBACK_URL',
      'NODE_EXTRA_CA_CERTS',
      'PGSSLMODE',
    ]);
  });

  it('역할: 허용은 자기 DB 비밀 읽기 하나(SSM GetParameter + SSM 경유 Decrypt) + 결과 큐 소비 — SES · S3 · 다른 비밀 0 · SES 발송 Deny 있음', () => {
    const roleId = result().props.Role['Fn::GetAtt'][0];
    const roles = compute().findResources('AWS::IAM::Role') as Record<string, { Properties: { RoleName: string } }>;
    expect(roles[roleId]?.Properties.RoleName).toBe('atmark-runtime-ai-watch-result');
    // 기본값이 큐 준비(true)라 결과 큐 소비 문장(SQS 이벤트 소스가 붙이는 Sid 없는 문장)이 함께 있다 — 그 밖의 허용은 0.
    const allAllows = (statementsByRole(compute()).get(roleId) ?? []).filter((s) => s.Effect === 'Allow');
    const sqsConsume = allAllows.filter((s) => s.Sid === undefined);
    expect(sqsConsume).toHaveLength(1);
    expect(actionsOf(sqsConsume[0]!).every((a) => a.startsWith('sqs:'))).toBe(true);
    expect(JSON.stringify(sqsConsume[0]!.Resource)).toContain(AI_WATCH_QUEUES.result);
    // 묶음 E — 실시간 힌트 `PostToConnection`(실시간 API 의 v1/POST/@connections/* 하나 — compute-stack.test.ts "실시간 WebSocket").
    const realtime = allAllows.filter((s) => s.Sid === 'RealtimePostToConnection');
    expect(realtime.flatMap(actionsOf)).toEqual(['execute-api:ManageConnections']);
    const allows = allAllows.filter((s) => s.Sid !== undefined && s.Sid !== 'RealtimePostToConnection');
    expect(allows.map((s) => s.Sid)).toEqual(['DbAiWatchSecretRead', 'DbAiWatchSecretReadDecrypt']);
    expect(actionsOf(allows[0]!)).toEqual(['ssm:GetParameter']);
    expect(readsSsmSecret(allows[0]!, AI_WATCH_DB_SECRET_NAME)).toBe(true);
    expect(actionsOf(allows[1]!)).toEqual(['kms:Decrypt']);
    expect(allows[1]!.Condition?.['StringEquals']?.['kms:ViaService']).toBe(`ssm.${REGION}.amazonaws.com`);
    expect((allStatementsByRole(compute()).get(roleId) ?? []).some((s) => s.Effect === 'Deny' && actionsOf(s).includes('ses:Send*'))).toBe(true);
  });

  it('ai-watch DB 비밀(SSM /atmark/db/ai-watch)을 읽는 역할은 결과 λ 와 migrate(쓰기 포함) 둘뿐 · 두 환경에 위치', () => {
    const readers = [...statementsByRole(compute())]
      .filter(([, statements]) => statements.some((s) => readsSsmSecret(s, AI_WATCH_DB_SECRET_NAME)))
      .map(([role]) => role);
    const roles = compute().findResources('AWS::IAM::Role') as Record<string, { Properties: { RoleName: string } }>;
    expect(readers.map((id) => roles[id]?.Properties.RoleName).sort()).toEqual(['atmark-runtime-ai-watch-result', 'atmark-runtime-migrate']);
    const migrate = functionsOf(compute()).get('atmark-migrate')!.props;
    expect(migrate.Environment.Variables[AI_WATCH_ENV.dbSecretArn]).toBe(`/${AI_WATCH_DB_SECRET_NAME}`);
    expect(result().props.Environment.Variables[AI_WATCH_ENV.dbSecretArn]).toBe(`/${AI_WATCH_DB_SECRET_NAME}`);
  });

  it('기본(큐 준비 뒤 — 2026-10-06): 결과 큐 매핑 있음 · 명시 false: 매핑 없음 + 합성 경고 / atmark:aiWatchQueuesReady=true: batch 10 · 부분 실패 보고 · 최대 동시성 없음 · 소비 권한은 결과 큐 ARN 하나', () => {
    const mappingsFor = (template: Template): { Properties: Record<string, unknown> }[] =>
      (Object.values(template.findResources('AWS::Lambda::EventSourceMapping')) as { Properties: Record<string, unknown> }[]).filter((m) =>
        JSON.stringify(m.Properties['EventSourceArn']).includes(AI_WATCH_QUEUES.result),
      );
    // 2026-10-06 운영에 AtmarkAiWatch 배포 뒤 기본값을 true 로 굳혔다(deploy 7-2) — 기본 합성은 매핑 하나, 명시 false 는 매핑 없음 + 경고.
    expect(mappingsFor(compute())).toHaveLength(1);
    const notReady = (() => {
      const previous = process.env['CDK_CONTEXT_JSON'];
      process.env['CDK_CONTEXT_JSON'] = JSON.stringify({ [AI_WATCH_QUEUES_READY_CONTEXT_KEY]: 'false' });
      try {
        return buildRuntimeApp().compute;
      } finally {
        if (previous === undefined) delete process.env['CDK_CONTEXT_JSON'];
        else process.env['CDK_CONTEXT_JSON'] = previous;
      }
    })();
    expect(mappingsFor(Template.fromStack(notReady))).toHaveLength(0);
    Annotations.fromStack(notReady).hasWarning('*', Match.stringLikeRegexp('AI 감시 결과 큐 매핑 없이 합성했다'));

    const readyApp = (() => {
      const previous = process.env['CDK_CONTEXT_JSON'];
      process.env['CDK_CONTEXT_JSON'] = JSON.stringify({ [AI_WATCH_QUEUES_READY_CONTEXT_KEY]: 'true' });
      try {
        return buildRuntimeApp().compute;
      } finally {
        if (previous === undefined) delete process.env['CDK_CONTEXT_JSON'];
        else process.env['CDK_CONTEXT_JSON'] = previous;
      }
    })();
    Annotations.fromStack(readyApp).hasNoWarning('*', Match.stringLikeRegexp('AI 감시 결과 큐 매핑 없이 합성했다'));
    const ready = Template.fromStack(readyApp);
    const [mapping] = mappingsFor(ready);
    expect(mapping?.Properties['EventSourceArn']).toBe(RESULT_QUEUE_ARN);
    expect(mapping?.Properties['BatchSize']).toBe(AI_WATCH_RESULT_BATCH_SIZE);
    expect(mapping?.Properties['FunctionResponseTypes']).toEqual(['ReportBatchItemFailures']);
    expect(mapping?.Properties['ScalingConfig']).toBeUndefined();
    const roleId = functionsOf(ready).get(AI_WATCH_RESULT_FUNCTION_NAME)!.props.Role['Fn::GetAtt'][0];
    const queueStatements = (statementsByRole(ready).get(roleId) ?? []).filter((s) => actionsOf(s).some((a) => a.startsWith('sqs:')));
    expect(queueStatements).toHaveLength(1);
    expect(queueStatements[0]!.Resource).toBe(RESULT_QUEUE_ARN);
    const consume = actionsOf(queueStatements[0]!);
    for (const action of AI_WATCH_IAM_ACTIONS.resultLambdaResultQueue) expect(consume).toContain(action);
    expect(consume.filter((a) => !(AI_WATCH_IAM_ACTIONS.resultLambdaResultQueue as readonly string[]).includes(a))).toEqual(['sqs:GetQueueUrl']);
  });
});

describe('AtmarkCompute — inbound 의 AI 감시 결선', () => {
  const compute = (): Template => runtimeTemplates().compute;

  it('inbound 환경: 킬 스위치 기본 off · 요청 큐 URL — 다른 함수에는 둘 다 없다', () => {
    for (const [name, { props }] of functionsOf(compute())) {
      const vars = props.Environment.Variables;
      if (name === 'atmark-inbound') {
        expect(vars[AI_WATCH_ENV.mode]).toBe('off');
        expect(vars[AI_WATCH_ENV.requestQueueUrl]).toBe(`https://sqs.${REGION}.amazonaws.com/${ACCOUNT}/${AI_WATCH_QUEUES.request}`);
      } else {
        expect(AI_WATCH_ENV.mode in vars, name).toBe(false);
        expect(AI_WATCH_ENV.requestQueueUrl in vars, name).toBe(false);
      }
    }
  });

  it('inbound 역할: 요청 큐 SendMessage 하나(ARN 고정) · IAM 에 KMS 문장 없음(키 정책이 준다) · 요청 큐에 닿는 다른 역할 없음', () => {
    const fn = functionsOf(compute()).get('atmark-inbound')!.props;
    const roleId = fn.Role['Fn::GetAtt'][0];
    const statements = statementsByRole(compute()).get(roleId) ?? [];
    const send = statements.find((s) => s.Sid === 'AiWatchRequestSend')!;
    expect(actionsOf(send)).toEqual([...AI_WATCH_IAM_ACTIONS.inboundRequestQueue]);
    expect(send.Resource).toBe(REQUEST_QUEUE_ARN);
    for (const s of statements) for (const a of actionsOf(s)) expect(a.startsWith('kms:') && JSON.stringify(s).includes('ai-watch')).toBe(false);
    for (const [role, list] of statementsByRole(compute())) {
      if (role === roleId) continue;
      expect(JSON.stringify(list), role).not.toContain(AI_WATCH_QUEUES.request);
    }
  });

  it('킬 스위치 컨텍스트: shadow · on 은 그대로, 오타는 synth 를 멈춘다', () => {
    const node = (value: unknown) => ({ tryGetContext: (key: string) => (key === AI_WATCH_MODE_CONTEXT_KEY ? value : undefined) });
    expect(aiWatchModeOf(node(undefined))).toBe('off');
    expect(aiWatchModeOf(node('shadow'))).toBe('shadow');
    expect(aiWatchModeOf(node('on'))).toBe('on');
    expect(() => aiWatchModeOf(node('ON'))).toThrow(/off \| shadow \| on/);
    expect(() => aiWatchModeOf(node(''))).toThrow();
    expect(aiWatchQueuesReadyOf({ tryGetContext: () => undefined })).toBe(true);
    expect(aiWatchQueuesReadyOf({ tryGetContext: () => 'false' })).toBe(false);
    expect(aiWatchQueuesReadyOf({ tryGetContext: () => 'true' })).toBe(true);
    const shadow = computeWithContext({ [AI_WATCH_MODE_CONTEXT_KEY]: 'shadow' });
    expect(functionsOf(shadow).get('atmark-inbound')!.props.Environment.Variables[AI_WATCH_ENV.mode]).toBe('shadow');
  });
});
