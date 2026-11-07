/**
 * US-009(ADR-0009) — 문의 전달의 인프라 불변식. **발송 주체를 늘리지 않고**(발송 역할 공유) 이 함수만의 것은 함수 단위 조건으로 묶는다.
 *
 *   ① 전달 주소 비밀(`atmark/contact-forward-to`)은 Data 스택의 RETAIN 자리값이다 — 템플릿에 주소가 없다.
 *   ② 그 비밀을 읽는 문장은 발송 역할의 하나뿐이고 `lambda:SourceFunctionArn` = contact-forwarder 로 묶였다. 비밀 ARN 환경 변수도 그 함수만.
 *   ③ `contact/forward/*`: 쓰기는 inbound 역할 하나, 읽기는 발송 역할의 함수 조건 문장 하나(ListBucket 없음). 다른 역할 0.
 *   ④ `forward` 라우팅(명시)에서 발송 역할은 `support@` 를 그 함수 밖에서 명시 Deny(키가 없으면 `ArnNotEquals` 참 — 빼낸 자격증명도 거부).
 *   ⑤ contact-forwarder 는 발송 역할 · 1분 스케줄 · 예약 동시성 1 · 상수 짝(발신 주소·문서 접두사)이 런타임과 같다.
 *
 * 되돌리기 검증: 조건을 지우면 ②④ · 접두사 쓰기를 발송 역할에 주면 ③ · 비밀 값에 주소를 넣으면 ① 이 빨개진다.
 */

import { describe, expect, it } from 'vitest';

import {
  CONTACT_DOCUMENT_PREFIX,
  CONTACT_FORWARD_FROM_ADDRESS,
  RESERVED_CONCURRENCY,
  SCHEDULES,
  SENDER_ROLE_LOGICAL_ID,
  SES_SENDING_HANDLERS,
} from '../../../infra/cdk/stacks/compute-stack';
import { CONTACT_FORWARD_TO_SECRET_NAME, SECRET_PLACEHOLDER_VALUE } from '../../../infra/cdk/stacks/data-stack';
import { CONTACT_ADDRESS, CONTACT_DOCUMENT_PREFIX as RUNTIME_CONTACT_DOCUMENT_PREFIX } from '../../../src/contact/intake';
import { CONTACT_FORWARD_FROM_ADDRESS as RUNTIME_FROM } from '../../../src/notify/contact-forwarder';
import { RUNTIME_ENV } from '../../../src/runtime/config';
import { actionsOf, forwardRoutingCompute, readsSsmSecret, runtimeTemplates, statementsByRole, type IamStatement } from './runtime-app';

const FORWARDER_ARN = 'arn:aws:lambda:ap-northeast-2:123456789012:function:atmark-contact-forwarder';
const FUNCTION_CONDITION = { ArnEquals: { 'lambda:SourceFunctionArn': FORWARDER_ARN } };

interface FunctionProps {
  readonly FunctionName: string;
  readonly Role: { 'Fn::GetAtt': [string, string] };
  readonly ReservedConcurrentExecutions?: number;
  readonly Environment?: { Variables?: Record<string, unknown> };
}

function functions(): Map<string, FunctionProps> {
  const found = runtimeTemplates().compute.findResources('AWS::Lambda::Function') as Record<string, { Properties: FunctionProps }>;
  return new Map(Object.values(found).map((f) => [f.Properties.FunctionName, f.Properties]));
}

function contactSecretLogicalId(): string {
  const secrets = runtimeTemplates().data.findResources('AWS::SecretsManager::Secret') as Record<
    string,
    { Properties: { Name?: string; SecretString?: string }; DeletionPolicy?: string; UpdateReplacePolicy?: string }
  >;
  const entry = Object.entries(secrets).find(([, secret]) => secret.Properties.Name === CONTACT_FORWARD_TO_SECRET_NAME);
  if (entry === undefined) throw new Error('atmark/contact-forward-to 비밀이 Data 스택에 없다');
  return entry[0];
}

const mentions = (statement: IamStatement, needle: string): boolean => JSON.stringify(statement.Resource ?? '').includes(needle);

describe('문의 전달 인프라 (US-009, ADR-0009)', () => {
  it('① 전달 주소 비밀은 RETAIN 자리값 — 템플릿에 주소가 없다', () => {
    const secrets = runtimeTemplates().data.findResources('AWS::SecretsManager::Secret') as Record<
      string,
      { Properties: { SecretString?: string }; DeletionPolicy?: string; UpdateReplacePolicy?: string }
    >;
    const secret = secrets[contactSecretLogicalId()];
    expect(secret?.Properties.SecretString).toBe(SECRET_PLACEHOLDER_VALUE);
    expect(secret?.DeletionPolicy).toBe('Retain');
    expect(secret?.UpdateReplacePolicy).toBe('Retain');
    // 스택 템플릿 어디에도 `@` 가 들어간 외부 주소가 없다(support@·login@ 같은 우리 주소만).
    for (const template of Object.values(runtimeTemplates())) {
      const addresses = JSON.stringify(template.toJSON()).match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [];
      expect(addresses.filter((address) => !address.toLowerCase().endsWith('@atmark.ai') && !address.toLowerCase().endsWith('.atmark.ai'))).toEqual([]);
    }
  });

  it('② 비밀 읽기(SSM /atmark/contact-forward-to)는 발송 역할의 함수 조건 문장 하나뿐 · 위치 환경 변수도 contact-forwarder 만', () => {
    const readers: { role: string; statement: IamStatement }[] = [];
    const legacy: string[] = [];
    for (const [role, statements] of statementsByRole(runtimeTemplates().compute)) {
      for (const statement of statements) {
        if (readsSsmSecret(statement, CONTACT_FORWARD_TO_SECRET_NAME)) readers.push({ role, statement });
        // 옛 Secrets Manager 자리(교차 스택 참조 — 논리 ID 가 이름에 남는다)는 아무도 읽지 않는다(2026-10-12 비밀 → SSM 이전).
        if (actionsOf(statement).some((action) => action.startsWith('secretsmanager:')) && mentions(statement, 'ContactForwardToSecret')) legacy.push(role);
      }
    }
    expect(legacy).toEqual([]);
    expect(readers.map((r) => r.role)).toEqual([SENDER_ROLE_LOGICAL_ID]);
    expect(readers[0]?.statement.Effect).toBe('Allow');
    expect(actionsOf(readers[0]?.statement as IamStatement)).toEqual(['ssm:GetParameter']);
    expect(readers[0]?.statement.Condition).toEqual(FUNCTION_CONDITION);

    for (const [name, fn] of functions()) {
      const has = Object.keys(fn.Environment?.Variables ?? {}).includes(RUNTIME_ENV.contactForwardToSecretArn);
      expect(has, name).toBe(name === 'atmark-contact-forwarder');
      if (has) expect(fn.Environment?.Variables?.[RUNTIME_ENV.contactForwardToSecretArn]).toBe(`/${CONTACT_FORWARD_TO_SECRET_NAME}`);
    }
  });

  it('③ contact/forward/*: 쓰기는 inbound 역할 하나 · 읽기는 발송 역할의 함수 조건 문장 하나 · 그 밖 0', () => {
    const inboundRole = functions().get('atmark-inbound')?.Role['Fn::GetAtt'][0];
    const touched: string[] = [];
    for (const [role, statements] of statementsByRole(runtimeTemplates().compute)) {
      for (const statement of statements.filter((s) => mentions(s, CONTACT_DOCUMENT_PREFIX))) {
        const actions = actionsOf(statement);
        touched.push(`${role}:${actions.join('+')}`);
        if (actions.includes('s3:PutObject')) expect(role).toBe(inboundRole);
        if (actions.includes('s3:GetObject')) {
          expect(role).toBe(SENDER_ROLE_LOGICAL_ID);
          expect(actions).toEqual(['s3:GetObject']);
          expect(statement.Condition).toEqual(FUNCTION_CONDITION);
        }
      }
    }
    expect(touched.sort()).toEqual([`${inboundRole ?? ''}:s3:PutObject`, `${SENDER_ROLE_LOGICAL_ID}:s3:GetObject`].sort());
  });

  it('④ forward 라우팅(명시) — 발송 역할은 support@ 를 contact-forwarder 함수 밖에서 명시 Deny', () => {
    // 기본 라우팅은 2026-09-30 부터 forward 가 아니라(지금 agent_and_notify) 그 Deny 가 없다(아래 테스트) — 이 Deny 는 `-c atmark:contactRouting=forward` 의 몫이다.
    const denies = (statementsByRole(forwardRoutingCompute()).get(SENDER_ROLE_LOGICAL_ID) ?? []).filter(
      // 정확한 주소를 거는 Deny 만 — 예약 접미사 Deny(`*?support@atmark.ai`, 최종 검증 M3a)는 `compute-stack.test.ts` 가 본다.
      (s) =>
        s.Effect === 'Deny' &&
        (s.Condition as { StringEqualsIgnoreCase?: Record<string, unknown> } | undefined)?.StringEqualsIgnoreCase?.['ses:FromAddress'] ===
          CONTACT_FORWARD_FROM_ADDRESS,
    );
    expect(denies).toHaveLength(1);
    expect(actionsOf(denies[0] as IamStatement).sort()).toEqual(['ses:SendEmail', 'ses:SendRawEmail']);
    expect(denies[0]?.Resource).toBe('*');
    expect(denies[0]?.Condition).toEqual({
      StringEqualsIgnoreCase: { 'ses:FromAddress': 'support@atmark.ai' },
      ArnNotEquals: { 'lambda:SourceFunctionArn': FORWARDER_ARN },
    });
  });

  it('④b 기본 라우팅(agent_and_notify) — 발송 역할에 support@ 정확 일치 Deny 가 없다(지원 에이전트가 support@ 로 회신한다)', () => {
    const denies = (statementsByRole(runtimeTemplates().compute).get(SENDER_ROLE_LOGICAL_ID) ?? []).filter(
      (s) =>
        s.Effect === 'Deny' &&
        (s.Condition as { StringEqualsIgnoreCase?: Record<string, unknown> } | undefined)?.StringEqualsIgnoreCase?.['ses:FromAddress'] ===
          CONTACT_FORWARD_FROM_ADDRESS,
    );
    expect(denies).toEqual([]);
  });

  it('⑤ contact-forwarder: 발송 역할 · 1분 · 예약 동시성 1 · 상수 짝이 런타임과 같다', () => {
    const fn = functions().get('atmark-contact-forwarder');
    expect(fn?.Role['Fn::GetAtt'][0]).toBe(SENDER_ROLE_LOGICAL_ID);
    expect(fn?.ReservedConcurrentExecutions).toBe(1);
    expect(RESERVED_CONCURRENCY['contact-forwarder']).toBe(1);
    expect(SCHEDULES.find((s) => s.handler === 'contact-forwarder')?.minutes).toBe(1);
    expect(SES_SENDING_HANDLERS).toContain('contact-forwarder');
    expect(CONTACT_FORWARD_FROM_ADDRESS).toBe(CONTACT_ADDRESS);
    expect(RUNTIME_FROM).toBe(CONTACT_ADDRESS);
    expect(CONTACT_DOCUMENT_PREFIX).toBe(RUNTIME_CONTACT_DOCUMENT_PREFIX);
  });
});
