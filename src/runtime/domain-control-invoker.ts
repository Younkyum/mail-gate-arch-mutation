/**
 * src/runtime/domain-control-invoker.ts — 포트 `DomainControlInvoker`(계약 `src/domains/contract.ts`)의 **실제 구현**: admin λ 안의 확인 틱이
 * domain-control λ 를 동기(RequestResponse)로 부른다(ADR-0014 결정 3 · 단계 2). Lambda SDK 는 `runtime/lambda-invoke.ts` 를 거친다.
 *
 *   - 함수 ARN 은 `ATMARK_DOMAIN_CONTROL_FUNCTION_ARN` — `atmark-domain-control` 함수의 **한정자 없는** ARN 이어야 한다(아니면 조립 거부 —
 *     login-mailer · api ARN 과 같은 규칙). IAM 은 admin 역할에 이 ARN 하나(compute-stack `DomainControlInvoke`).
 *   - 배치 하나 = 호출 하나 · 시간 상한 `DOMAIN_CONTROL_INVOKE_TIMEOUT_MS`. 결과는 **요청과 같은 길이 · 같은 순서 · 같은 op·rowId** 여야 하고, 판정 칸이
 *     계약의 닫힌 값이어야 한다 — 하나라도 어긋나면 `DomainControlUnavailableError`(틱은 아무것도 바꾸지 않고 끝난다 — 닫힌 쪽).
 *   - 배선(admin 조립 · 틱)은 단계 4 다 — 그때까지 admin 조립은 계획된 비활성 포트(`unavailableDomainControlInvoker`)를 쓴다.
 */

import {
  CUSTOM_DOMAIN_SES_STATUSES,
  DOMAIN_CONTROL_INVOKE_TIMEOUT_MS,
  DomainControlUnavailableError,
  type DomainControlInvoker,
  type DomainControlRequest,
  type DomainControlResult,
} from '../domains/contract';
import { RuntimeConfigError } from './config';
import { invokeJsonRequestResponse, type LambdaInvokeClient } from './lambda-invoke';

/** domain-control 함수 ARN(한정자 없음). */
export const DOMAIN_CONTROL_FUNCTION_ARN_PATTERN = /^arn:aws[a-z-]*:lambda:[a-z0-9-]+:\d{12}:function:atmark-domain-control$/;

const DNS_VERDICTS = ['present', 'absent', 'error'];
const MX_VERDICTS = ['missing', 'ses', 'other', 'error'];
const OUTCOMES: Readonly<Record<DomainControlRequest['op'], readonly string[]>> = {
  check: [],
  saga_step: ['advanced', 'identity_owned_elsewhere', 'error'],
  remove_step: ['advanced', 'not_owner', 'error'],
  sync_policy: ['synced', 'rejected_input', 'too_large', 'not_owner', 'error'],
  audit_policy: ['clean', 'drift', 'not_owner', 'error'],
  check_expiry: ['ok', 'unsupported', 'error'],
  peek_identity: ['found', 'absent', 'error'],
};
const SES_STATUSES: readonly string[] = CUSTOM_DOMAIN_SES_STATUSES;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const nullableString = (value: unknown): boolean => value === null || typeof value === 'string';

/** 결과 하나가 요청 하나에 맞는 계약 모양인가. */
export function resultMatches(request: DomainControlRequest, raw: unknown): raw is DomainControlResult {
  if (!isRecord(raw) || raw['op'] !== request.op || raw['rowId'] !== request.rowId || !nullableString(raw['errorCode'])) return false;
  const outcomeOk = (): boolean => OUTCOMES[request.op].includes(String(raw['outcome']));
  switch (request.op) {
    case 'check':
      return DNS_VERDICTS.includes(String(raw['txt'])) && MX_VERDICTS.includes(String(raw['mx']));
    case 'saga_step':
      return (
        outcomeOk() &&
        nullableString(raw['ownerRowTag']) &&
        Array.isArray(raw['dkimTokens']) &&
        (raw['dkimTokens'] as unknown[]).every((token) => typeof token === 'string') &&
        SES_STATUSES.includes(String(raw['dkimStatus'])) &&
        SES_STATUSES.includes(String(raw['mailFromStatus'])) &&
        nullableString(raw['policyDigest'])
      );
    case 'remove_step':
      return outcomeOk();
    case 'sync_policy':
      return outcomeOk() && nullableString(raw['policyDigest']);
    case 'audit_policy':
      return outcomeOk() && SES_STATUSES.includes(String(raw['dkimStatus']));
    case 'check_expiry':
      return outcomeOk() && nullableString(raw['expiresAt']);
    case 'peek_identity':
      return (
        outcomeOk() &&
        typeof raw['ownerIsRow'] === 'boolean' &&
        Array.isArray(raw['dkimTokens']) &&
        (raw['dkimTokens'] as unknown[]).every((token) => typeof token === 'string') &&
        SES_STATUSES.includes(String(raw['dkimStatus'])) &&
        SES_STATUSES.includes(String(raw['mailFromStatus'])) &&
        // 관리자 아닌 행에 상태를 싣는 결과는 계약 밖(다른 행의 진행을 보여 주지 않는다).
        (raw['ownerIsRow'] === true || (raw['dkimStatus'] === 'unknown' && raw['mailFromStatus'] === 'unknown'))
      );
  }
}

export function createDomainControlInvoker(input: {
  readonly client: LambdaInvokeClient;
  readonly functionArn: string;
  readonly timeoutMs?: number;
}): DomainControlInvoker {
  if (!DOMAIN_CONTROL_FUNCTION_ARN_PATTERN.test(input.functionArn)) {
    throw new RuntimeConfigError('domain-control 함수 ARN(한정자 없는 atmark-domain-control)이 아니다.');
  }
  const timeoutMs = input.timeoutMs ?? DOMAIN_CONTROL_INVOKE_TIMEOUT_MS;
  return {
    async invoke(batch) {
      if (batch.length === 0) return [];
      const reply = await invokeJsonRequestResponse({ client: input.client, functionArn: input.functionArn, payload: { batch }, timeoutMs });
      if (!reply.ok) throw new DomainControlUnavailableError(`domain-control 호출 실패(${reply.reason})`);
      const results = isRecord(reply.body) ? reply.body['results'] : undefined;
      if (!Array.isArray(results) || results.length !== batch.length) throw new DomainControlUnavailableError('domain-control 결과 길이가 요청과 다르다');
      return batch.map((request, i) => {
        const result: unknown = results[i];
        if (!resultMatches(request, result)) throw new DomainControlUnavailableError(`domain-control 결과 ${String(i)} 가 계약 모양이 아니다`);
        return result;
      });
    },
  };
}
