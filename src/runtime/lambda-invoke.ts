/**
 * src/runtime/lambda-invoke.ts — **Lambda SDK 를 import 하는 유일한 파일.** 공개 면은 넷이다: login-mailer **깨우기**, 콘솔 웹훅의
 * **시크릿 받기**(`createWebhookSecretIssuer` — admin λ → api λ 내부 이벤트, 보안 M1), **JSON 동기 호출**
 * (`invokeJsonRequestResponse` — admin λ 의 확인 틱 → domain-control λ, `runtime/domain-control-invoker.ts`), **자가 등록**
 * (`createAgentEnroller` — api λ → admin λ). 각 절은 아래.
 *
 * 깨우기가 왜 있는가: admin λ 는 로그인·가입·초대 메일을 outbox 에 적을 뿐이고 보내지 않는다(ADR-0006 — SES 0 · 로그인 메일 발송 주체는
 * login-mailer 하나). login-mailer 는 1분 틱으로만 돌아서 메일이 최대 1분(+ 콜드 스타트) 늦었다. 그래서 admin 은 **커밋 뒤** login-mailer 를
 * `InvocationType: 'Event'`(비동기 — 202 만 받고 끝을 기다리지 않는다)로 깨운다. 입력은 고정값 `{"source":"atmark.kick"}` 하나 — 주소·id·
 * 토큰이 실리지 않는다. login-mailer 는 틱과 **같은 일**(outbox 비우기)을 한다 — 무엇을 보낼지는 DB 가 정하고, 중복 발송은 DB 클레임이 막는다.
 * 1분 틱은 그대로 둔다(깨우기가 실패해도 늦을 뿐 빠지지 않는다).
 *
 * 규율:
 *   - **요청을 실패시키지 않는다.** 오류·시간 초과는 삼키고 로그 한 줄(`runtime.login_mailer_kick` · `outcome` · `error_kind`)만 남긴다.
 *   - **짧게 묶는다.** `LOGIN_MAILER_KICK_TIMEOUT_MS`(1초)에서 끊는다 — Lambda 는 응답을 돌려준 뒤 얼기 때문에 호출 자체는 await 한다
 *     (비동기 호출은 보통 수십 ms 에 202 를 받는다).
 *   - IAM 은 admin 역할에 `lambda:InvokeFunction` on login-mailer 함수 ARN **정확히 하나**(와일드카드·버전 없음, compute-stack).
 *
 * 격리 규칙은 SES·S3·KMS·SQS 와 같다: 클라이언트 하나당 파일 하나, **파일 이름으로** 네트워크 송출 허용목록
 * (`test/arch/network-egress.arch.test.ts`)과 dependency-cruiser(`no-lambda-sdk-outside-runtime-lambda-invoke`)에 오른다.
 */

import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';

import { log } from '../observability/logger';
import { LOGIN_MAILER_EVENT_SOURCE } from './config';
import type { AgentEnrollInvokeResult, EnrollEvent } from './enroll-event';
import { INTERNAL_EVENT_SOURCE, type InternalApiEvent } from './internal-api-event';

/** 깨우기 한 번의 시간 상한(ms). 넘으면 끊고 삼킨다 — 메일은 다음 틱(≤ 1분)에 나간다. */
export const LOGIN_MAILER_KICK_TIMEOUT_MS = 1_000;

/** 깨우기 입력 — 고정값. 사용자 데이터를 실을 자리가 없다. */
export const LOGIN_MAILER_KICK_PAYLOAD = JSON.stringify({ source: LOGIN_MAILER_EVENT_SOURCE.kick });

/** SDK 클라이언트의 `send` 중 여기서 쓰는 모양 — 테스트는 이 면만 가짜로 준다. */
export interface LambdaInvokeClient {
  send(
    command: InvokeCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<{ StatusCode?: number | undefined; Payload?: Uint8Array | undefined; FunctionError?: string | undefined }>;
}

/** 실제 Lambda. **부르는 순간 자격증명이 필요하다**(만들기만 해서는 네트워크를 타지 않는다). */
export function createLambdaInvokeClient(region: string): LambdaInvokeClient {
  return new LambdaClient({ region });
}

/**
 * login-mailer 깨우기. 돌려주는 함수는 **던지지 않는다** — 성공(202)이든 실패든 `undefined` 로 끝난다.
 * `functionArn` 은 조립이 환경(`ATMARK_LOGIN_MAILER_FUNCTION_ARN`)에서 읽어 모양을 확인한 값이다.
 */
export function createLoginMailerKicker(input: {
  readonly client: LambdaInvokeClient;
  readonly functionArn: string;
  readonly timeoutMs?: number;
  /** 로그의 `route_id` — 깨우는 쪽(admin · ops). 기본 `admin`. */
  readonly routeId?: 'admin' | 'ops';
}): () => Promise<void> {
  const timeoutMs = input.timeoutMs ?? LOGIN_MAILER_KICK_TIMEOUT_MS;
  const routeId = input.routeId ?? 'admin';
  const payload = new TextEncoder().encode(LOGIN_MAILER_KICK_PAYLOAD);
  return async () => {
    const started = Date.now();
    const controller = new AbortController();
    // SDK 에 abort 를 넘기고, 같은 신호로 경주도 건다 — SDK 의 어느 단계가 abort 를 늦게 보더라도 요청은 상한에서 풀려난다.
    const expired = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new DOMException('login-mailer kick timed out', 'TimeoutError')), { once: true });
    });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const output = await Promise.race([
        input.client.send(new InvokeCommand({ FunctionName: input.functionArn, InvocationType: 'Event', Payload: payload }), {
          abortSignal: controller.signal,
        }),
        expired,
      ]);
      if (output.StatusCode !== 202) {
        log('warn', 'runtime.login_mailer_kick', {
          route_id: routeId,
          outcome: 'unexpected_status',
          http_status: output.StatusCode ?? null,
          latency_ms: Date.now() - started,
        });
      }
    } catch (error) {
      log('warn', 'runtime.login_mailer_kick', {
        route_id: routeId,
        outcome: 'failed',
        error_kind: error instanceof Error ? error.name : typeof error,
        latency_ms: Date.now() - started,
      });
    } finally {
      clearTimeout(timer);
    }
  };
}

// ---------------------------------------------------------------------------
// 콘솔 웹훅 시크릿 받기 — admin λ → api λ (보안 M1)
// ---------------------------------------------------------------------------
//
// admin λ 는 웹훅 키링을 갖지 않는다. 콘솔 등록·회전을 커밋한 뒤 api λ 를 **동기**(RequestResponse)로 불러 활성 kid 를 묻거나(새 행에 적는다) 방금
// 만든 행의 시크릿을 받는다. 입력은 `runtime/internal-api-event.ts` 의 정확한 모양 하나 — api λ 가 DB 에서 "60초 안의 콘솔 행" 인지 다시 본다.
// IAM 은 admin 역할에 `lambda:InvokeFunction` on api 함수 ARN **정확히 하나**. 실패(시간 초과·함수 오류·거절)는 `WebhookSecretIssueError` 로 던진다 —
// 콘솔 라우트가 503 으로 바꾼다(요청 전체를 죽이지 않는다): `activeKid` 실패는 **쓰기 전**이라 `webhooks_unavailable`, `issue` 실패는 행위가 이미
// 커밋된 뒤라 `webhook_secret_unavailable` + `item`(사용자는 교체로 새 시크릿을 받는다). `issue` 는 재시도하지 않는다 — api λ 가 버전당 한 번만
// 내주므로(재검토 L-1) 재시도는 거절될 뿐이다. 결과(시크릿)는 로그에 싣지 않는다.

/** 한 번의 시간 상한(ms) — api λ 의 콜드 스타트(비밀 읽기 · 풀)를 견디되 admin λ 25초 안에서 끝난다. */
export const WEBHOOK_SECRET_ISSUE_TIMEOUT_MS = 8_000;

/** 활성 kid 캐시 수명(ms). kid 는 비밀이 아니고 키 묶음을 바꿀 때만 바뀐다. */
export const WEBHOOK_ACTIVE_KID_TTL_MS = 5 * 60_000;

export class WebhookSecretIssueError extends Error {
  constructor(
    readonly reason: 'timeout' | 'function_error' | 'not_eligible' | 'unavailable' | 'malformed' | 'invoke_failed' | 'invalid_authorization' | 'invalid_url',
  ) {
    super(`webhook secret issue failed: ${reason}`);
    this.name = 'WebhookSecretIssueError';
  }
}

/** 봉인 대상(보안 리뷰 L3) — api λ 가 DB 에서 다시 본다. */
export interface WebhookSealTarget {
  readonly agentId: string;
  readonly organizationId: string;
  readonly endpointId: string;
  readonly url: string;
  readonly purpose: 'register' | 'replace';
}

export interface WebhookSecretIssuer {
  /** 새 행에 적을 활성 kid. */
  activeKid(): Promise<string>;
  /** 방금(60초 안) 콘솔이 등록·회전한 행의 시크릿. */
  issue(agentId: string, endpointId: string): Promise<string>;
  /**
   * 인증 헤더 값 봉인(202610141400) — api λ 가 규칙과 대상(조직 · 에이전트 · 엔드포인트 · URL)을 보고 `(agentId, endpointId, 정규화 URL)` 로 봉인한다.
   * 규칙 위반 · 대상 불일치는 `WebhookSecretIssueError`(`invalid_authorization` · `invalid_url` · `not_eligible`). 값과 결과는 로그에 싣지 않는다.
   */
  sealAuthorization(
    target: WebhookSealTarget,
    authorization: string,
  ): Promise<{ readonly url: string; readonly kid: string; readonly sealed: string; readonly hint: string; readonly generation: number }>;
}

export function createWebhookSecretIssuer(input: {
  readonly client: LambdaInvokeClient;
  readonly functionArn: string;
  readonly timeoutMs?: number;
  readonly clock?: () => number;
}): WebhookSecretIssuer {
  const timeoutMs = input.timeoutMs ?? WEBHOOK_SECRET_ISSUE_TIMEOUT_MS;
  const clock = input.clock ?? Date.now;
  let cachedKid: { readonly kid: string; readonly at: number } | undefined;

  const invoke = async (payload: InternalApiEvent): Promise<Record<string, unknown>> => {
    const controller = new AbortController();
    const expired = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new WebhookSecretIssueError('timeout')), { once: true });
    });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const output = await Promise.race([
        input.client
          .send(
            new InvokeCommand({
              FunctionName: input.functionArn,
              InvocationType: 'RequestResponse',
              Payload: new TextEncoder().encode(JSON.stringify(payload)),
            }),
            { abortSignal: controller.signal },
          )
          .catch((error: unknown) => {
            if (error instanceof WebhookSecretIssueError) throw error;
            throw new WebhookSecretIssueError(controller.signal.aborted ? 'timeout' : 'invoke_failed');
          }),
        expired,
      ]);
      if (output.FunctionError !== undefined || output.StatusCode !== 200) throw new WebhookSecretIssueError('function_error');
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(output.Payload ?? new Uint8Array()));
      } catch {
        throw new WebhookSecretIssueError('malformed');
      }
      if (typeof parsed !== 'object' || parsed === null) throw new WebhookSecretIssueError('malformed');
      const result = parsed as Record<string, unknown>;
      if (result['ok'] !== true) {
        const error = result['error'];
        throw new WebhookSecretIssueError(
          error === 'not_eligible' || error === 'invalid_authorization' || error === 'invalid_url' ? error : 'unavailable',
        );
      }
      return result;
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async activeKid() {
      const now = clock();
      if (cachedKid !== undefined && now - cachedKid.at < WEBHOOK_ACTIVE_KID_TTL_MS) return cachedKid.kid;
      const result = await invoke({ source: INTERNAL_EVENT_SOURCE, kind: 'webhook.activeKid' });
      const kid = result['kid'];
      if (typeof kid !== 'string' || !/^[a-z0-9]{1,16}$/.test(kid)) throw new WebhookSecretIssueError('malformed');
      cachedKid = { kid, at: now };
      return kid;
    },
    async issue(agentId, endpointId) {
      const result = await invoke({ source: INTERNAL_EVENT_SOURCE, kind: 'webhook.issueSecret', agentId, endpointId });
      const secret = result['secret'];
      if (typeof secret !== 'string' || !secret.startsWith('whsec_')) throw new WebhookSecretIssueError('malformed');
      return secret;
    },
    async sealAuthorization(target, authorization) {
      const result = await invoke({ source: INTERNAL_EVENT_SOURCE, kind: 'webhook.sealAuthorization', ...target, authorization });
      const sealedUrl = result['url'];
      const kid = result['kid'];
      const sealed = result['sealed'];
      const hint = result['hint'];
      const generation = result['generation'];
      if (
        typeof generation !== 'number' ||
        !Number.isSafeInteger(generation) ||
        generation < 1 ||
        typeof sealedUrl !== 'string' ||
        typeof kid !== 'string' ||
        !/^[a-z0-9]{1,16}$/.test(kid) ||
        typeof sealed !== 'string' ||
        !/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,3000}$/.test(sealed) ||
        typeof hint !== 'string' ||
        hint.length < 1 ||
        hint.length > 40
      ) {
        throw new WebhookSecretIssueError('malformed');
      }
      return { url: sealedUrl, kid, sealed, hint, generation };
    },
  };
}

// ---------------------------------------------------------------------------
// JSON 동기 호출 — admin λ(확인 틱) → domain-control λ (ADR-0014 단계 2)
// ---------------------------------------------------------------------------
//
// 모양 판정은 부르는 쪽(`runtime/domain-control-invoker.ts`)이 한다 — 이 함수는 시간 상한 · 함수 오류 · JSON 파싱까지만. 실패는 **이유 코드**로
// 돌려준다(던지지 않는다 — 부르는 쪽이 자기 오류 형식으로 바꾼다). IAM 은 admin 역할에 그 함수 ARN 하나(compute-stack).

export type JsonInvokeFailure = 'timeout' | 'invoke_failed' | 'function_error' | 'malformed';

export async function invokeJsonRequestResponse(input: {
  readonly client: LambdaInvokeClient;
  readonly functionArn: string;
  readonly payload: unknown;
  readonly timeoutMs: number;
}): Promise<{ readonly ok: true; readonly body: unknown } | { readonly ok: false; readonly reason: JsonInvokeFailure }> {
  const controller = new AbortController();
  const expired = new Promise<'timeout'>((resolve) => {
    controller.signal.addEventListener('abort', () => resolve('timeout'), { once: true });
  });
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const output = await Promise.race([
      input.client
        .send(
          new InvokeCommand({
            FunctionName: input.functionArn,
            InvocationType: 'RequestResponse',
            Payload: new TextEncoder().encode(JSON.stringify(input.payload)),
          }),
          { abortSignal: controller.signal },
        )
        .catch(() => (controller.signal.aborted ? ('timeout' as const) : ('invoke_failed' as const))),
      expired,
    ]);
    if (output === 'timeout' || output === 'invoke_failed') return { ok: false, reason: output };
    if (output.FunctionError !== undefined || output.StatusCode !== 200) return { ok: false, reason: 'function_error' };
    try {
      return { ok: true, body: JSON.parse(new TextDecoder().decode(output.Payload ?? new Uint8Array())) as unknown };
    } catch {
      return { ok: false, reason: 'malformed' };
    }
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// 자가 등록 — api λ → admin λ (ADR-0016 2026-10-08 · 모양 `runtime/enroll-event.ts`)
// ---------------------------------------------------------------------------
//
// api λ 가 토큰 · 권한 · 입력을 본 뒤 admin λ 를 RequestResponse 로 부른다. IAM 은 api 역할에 `lambda:InvokeFunction` on `atmark-admin` ARN **하나**.
// admin λ 의 예약 동시성은 3 이다 — 콘솔과 다툰다. 그래서 **짧게 묶고**(`AGENT_ENROLL_TIMEOUT_MS`) 스로틀(`TooManyRequestsException`)은 `busy` 로 돌려준다
// (라우트가 503 `enroll_busy`). 재시도하지 않는다 — 시간 초과 뒤 admin 이 커밋했을 수 있고, 다시 부르면 에이전트가 둘 생긴다(하루 상한이 묶는다).
// 이벤트(토큰 원문)와 결과(새 토큰)는 로그에 싣지 않는다.

/** 한 번의 시간 상한(ms) — admin λ 콜드 스타트(비밀 · 풀) + 키 보관(KMS · SM) 두 번 왕복. api λ 의 시간 안에서 끝난다. */
export const AGENT_ENROLL_TIMEOUT_MS = 12_000;

export function createAgentEnroller(input: {
  readonly client: LambdaInvokeClient;
  readonly functionArn: string;
  readonly timeoutMs?: number;
}): (event: EnrollEvent) => Promise<AgentEnrollInvokeResult> {
  const timeoutMs = input.timeoutMs ?? AGENT_ENROLL_TIMEOUT_MS;
  return async (event) => {
    const controller = new AbortController();
    const expired = new Promise<'timeout'>((resolve) => {
      controller.signal.addEventListener('abort', () => resolve('timeout'), { once: true });
    });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const output = await Promise.race([
        input.client
          .send(
            new InvokeCommand({ FunctionName: input.functionArn, InvocationType: 'RequestResponse', Payload: new TextEncoder().encode(JSON.stringify(event)) }),
            { abortSignal: controller.signal },
          )
          .catch((error: unknown) => {
            if (controller.signal.aborted) return 'timeout' as const;
            const name = error instanceof Error ? error.name : '';
            return name === 'TooManyRequestsException' || name === 'ThrottlingException' ? ('busy' as const) : ('unavailable' as const);
          }),
        expired,
      ]);
      if (output === 'timeout' || output === 'busy' || output === 'unavailable') return { ok: false, reason: output };
      if (output.FunctionError !== undefined || output.StatusCode !== 200) return { ok: false, reason: 'unavailable' };
      try {
        return { ok: true, body: JSON.parse(new TextDecoder().decode(output.Payload ?? new Uint8Array())) as unknown };
      } catch {
        return { ok: false, reason: 'unavailable' };
      }
    } finally {
      clearTimeout(timer);
    }
  };
}
