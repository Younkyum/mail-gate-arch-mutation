/**
 * `src/runtime/domain-control-invoker.ts`(포트 `DomainControlInvoker` 의 실제 구현) · `lambda-invoke.ts` 의 `invokeJsonRequestResponse` — AWS 호출 0(가짜 클라이언트).
 *
 *   - 함수 ARN 은 한정자 없는 `atmark-domain-control` 만(다른 함수 · 버전·별칭 한정자 → 조립 거부).
 *   - 동기 호출(RequestResponse) · 입력 `{ batch }` · 시간 상한에서 풀려난다.
 *   - 결과가 요청과 길이·순서·op·rowId·닫힌 값이 다르면 `DomainControlUnavailableError`(틱은 아무것도 바꾸지 않는다 — 닫힌 쪽).
 */

import type { InvokeCommand } from '@aws-sdk/client-lambda';
import { describe, expect, it } from 'vitest';

import { DOMAIN_CONTROL_INVOKE_TIMEOUT_MS, DomainControlUnavailableError, type DomainControlRequest } from '../../../src/domains/contract';
import { RuntimeConfigError } from '../../../src/runtime/config';
import { createDomainControlInvoker, DOMAIN_CONTROL_FUNCTION_ARN_PATTERN, resultMatches } from '../../../src/runtime/domain-control-invoker';
import { invokeJsonRequestResponse, type LambdaInvokeClient } from '../../../src/runtime/lambda-invoke';

const ARN = 'arn:aws:lambda:ap-northeast-2:123456789012:function:atmark-domain-control';
const ROW = '11111111-1111-4111-8111-111111111111';
const base = { rowId: ROW, domain: 'agents.example.com', registrable: 'example.com' } as const;
const CHECK: DomainControlRequest = { op: 'check', ...base, token: 'T'.repeat(43) };
const EXPIRY: DomainControlRequest = { op: 'check_expiry', ...base };

function fakeClient(respond: (input: InvokeCommand['input']) => Promise<{ StatusCode?: number; Payload?: Uint8Array; FunctionError?: string }>) {
  const sent: InvokeCommand['input'][] = [];
  const client: LambdaInvokeClient = {
    send(command) {
      sent.push(command.input);
      return respond(command.input);
    },
  };
  return { client, sent };
}
const body = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

describe('domain-control 호출기', () => {
  it('함수 ARN 은 한정자 없는 atmark-domain-control 만', () => {
    expect(DOMAIN_CONTROL_FUNCTION_ARN_PATTERN.test(ARN)).toBe(true);
    for (const bad of [`${ARN}:1`, `${ARN}:live`, ARN.replace('atmark-domain-control', 'atmark-admin'), '*', `${ARN}x`]) {
      expect(() => createDomainControlInvoker({ client: fakeClient(() => Promise.resolve({})).client, functionArn: bad }), bad).toThrow(RuntimeConfigError);
    }
  });

  it('동기 호출 · 입력 { batch } · 결과를 요청 순서로 돌려준다', async () => {
    const results = [
      { op: 'check', rowId: ROW, txt: 'present', mx: 'missing', errorCode: null },
      { op: 'check_expiry', rowId: ROW, outcome: 'ok', expiresAt: '2027-01-01T00:00:00.000Z', errorCode: null },
    ];
    const { client, sent } = fakeClient(() => Promise.resolve({ StatusCode: 200, Payload: body({ results }) }));
    const invoker = createDomainControlInvoker({ client, functionArn: ARN });
    await expect(invoker.invoke([CHECK, EXPIRY])).resolves.toEqual(results);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.InvocationType).toBe('RequestResponse');
    expect(sent[0]?.FunctionName).toBe(ARN);
    expect(JSON.parse(new TextDecoder().decode(sent[0]?.Payload as Uint8Array))).toEqual({ batch: [CHECK, EXPIRY] });
    // 빈 배치는 부르지 않는다.
    await expect(invoker.invoke([])).resolves.toEqual([]);
    expect(sent).toHaveLength(1);
  });

  it.each([
    ['함수 오류', { StatusCode: 200, FunctionError: 'Unhandled', Payload: body({}) }],
    ['상태 코드', { StatusCode: 500, Payload: body({ results: [] }) }],
    ['JSON 아님', { StatusCode: 200, Payload: new TextEncoder().encode('nope') }],
    ['결과 길이', { StatusCode: 200, Payload: body({ results: [] }) }],
    ['op 가 다르다', { StatusCode: 200, Payload: body({ results: [{ op: 'check_expiry', rowId: ROW, outcome: 'ok', expiresAt: null, errorCode: null }] }) }],
    ['rowId 가 다르다', { StatusCode: 200, Payload: body({ results: [{ op: 'check', rowId: 'x', txt: 'present', mx: 'missing', errorCode: null }] }) }],
    ['닫힌 값 밖', { StatusCode: 200, Payload: body({ results: [{ op: 'check', rowId: ROW, txt: 'maybe', mx: 'missing', errorCode: null }] }) }],
  ])('%s → DomainControlUnavailableError', async (_label, response) => {
    const invoker = createDomainControlInvoker({ client: fakeClient(() => Promise.resolve(response)).client, functionArn: ARN });
    await expect(invoker.invoke([CHECK])).rejects.toThrow(DomainControlUnavailableError);
  });

  it('SDK 오류 · 시간 상한 → DomainControlUnavailableError(상한에서 풀려난다)', async () => {
    const failing = createDomainControlInvoker({ client: fakeClient(() => Promise.reject(new Error('net'))).client, functionArn: ARN });
    await expect(failing.invoke([CHECK])).rejects.toThrow(/invoke_failed/);
    const hanging = createDomainControlInvoker({ client: fakeClient(() => new Promise(() => undefined)).client, functionArn: ARN, timeoutMs: 20 });
    await expect(hanging.invoke([CHECK])).rejects.toThrow(/timeout/);
    expect(DOMAIN_CONTROL_INVOKE_TIMEOUT_MS).toBe(10_000);
  });

  it('결과 모양 대조 — op 별 닫힌 값', () => {
    const saga: DomainControlRequest = { op: 'saga_step', ...base, step: 'identity', supersededRowId: null };
    const ok = { op: 'saga_step', rowId: ROW, outcome: 'advanced', ownerRowTag: null, dkimTokens: ['a'], dkimStatus: 'pending', mailFromStatus: 'unknown', policyDigest: null, errorCode: null };
    expect(resultMatches(saga, ok)).toBe(true);
    expect(resultMatches(saga, { ...ok, outcome: 'done' })).toBe(false);
    expect(resultMatches(saga, { ...ok, dkimTokens: [1] })).toBe(false);
    expect(resultMatches(saga, { ...ok, dkimStatus: 'SUCCESS' })).toBe(false);
    expect(resultMatches({ op: 'sync_policy', ...base, addresses: [] }, { op: 'sync_policy', rowId: ROW, outcome: 'too_large', policyDigest: null, errorCode: null })).toBe(true);
    expect(resultMatches({ op: 'remove_step', ...base, step: 'policy' }, { op: 'remove_step', rowId: ROW, outcome: 'not_owner', errorCode: 5 })).toBe(false);
  });
});

describe('peek_identity 결과 대조(2026-10 one-shot)', () => {
  const peek: DomainControlRequest = { op: 'peek_identity', ...base };
  const owned = { op: 'peek_identity', rowId: ROW, outcome: 'found', ownerIsRow: true, dkimTokens: ['a', 'b', 'c'], dkimStatus: 'success', mailFromStatus: 'pending', errorCode: null };

  it('계약 모양은 통과 · 관리자 아닌 행은 상태 unknown 일 때만', () => {
    expect(resultMatches(peek, owned)).toBe(true);
    expect(resultMatches(peek, { ...owned, ownerIsRow: false, dkimStatus: 'unknown', mailFromStatus: 'unknown' })).toBe(true);
    expect(resultMatches(peek, { ...owned, outcome: 'absent', ownerIsRow: false, dkimTokens: [], dkimStatus: 'unknown', mailFromStatus: 'unknown' })).toBe(true);
  });

  it('★ 관리자 아닌 행에 상태를 실은 결과 · 닫힌 값 밖 · 모양 틀림은 거부', () => {
    expect(resultMatches(peek, { ...owned, ownerIsRow: false })).toBe(false);
    expect(resultMatches(peek, { ...owned, ownerIsRow: false, dkimStatus: 'unknown' })).toBe(false);
    expect(resultMatches(peek, { ...owned, outcome: 'advanced' })).toBe(false);
    expect(resultMatches(peek, { ...owned, ownerIsRow: 'yes' })).toBe(false);
    expect(resultMatches(peek, { ...owned, dkimTokens: [1] })).toBe(false);
    expect(resultMatches(peek, { ...owned, dkimStatus: 'SUCCESS' })).toBe(false);
    expect(resultMatches(peek, { ...owned, op: 'check' })).toBe(false);
  });
});

describe('invokeJsonRequestResponse — 던지지 않고 이유 코드로', () => {
  it('성공 · 함수 오류 · 형식 오류 · 실패', async () => {
    const call = (respond: () => Promise<{ StatusCode?: number; Payload?: Uint8Array; FunctionError?: string }>) =>
      invokeJsonRequestResponse({ client: fakeClient(respond).client, functionArn: ARN, payload: { a: 1 }, timeoutMs: 1_000 });
    await expect(call(() => Promise.resolve({ StatusCode: 200, Payload: body({ ok: true }) }))).resolves.toEqual({ ok: true, body: { ok: true } });
    await expect(call(() => Promise.resolve({ StatusCode: 200, FunctionError: 'Handled' }))).resolves.toEqual({ ok: false, reason: 'function_error' });
    await expect(call(() => Promise.resolve({ StatusCode: 200, Payload: new TextEncoder().encode('{') }))).resolves.toEqual({ ok: false, reason: 'malformed' });
    await expect(call(() => Promise.reject(new Error('x')))).resolves.toEqual({ ok: false, reason: 'invoke_failed' });
  });
});
