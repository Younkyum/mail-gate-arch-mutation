/**
 * `dispatcher.ts` — 재시도 정책·영구 실패·SSRF·**DNS 재바인딩**을 가짜 포트로 고정한다.
 * 네트워크에 닿지 않는다(전송단·리졸버 모두 가짜).
 */

import { randomBytes, randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { resetLogSink, setLogSink } from '../../../src/observability/logger';
import { parseHmacKeyring } from '../../../src/security/hmac-keyring';
import type { HostResolver } from '../../../src/webhooks/destination';
import {
  MAX_ATTEMPTS,
  RETRY_SCHEDULE_MS,
  dispatchDueWebhooks,
  type ClaimedDelivery,
  type WebhookDispatchDependencies,
  type WebhookHttpRequest,
  type WebhookOutboxPort,
  type WebhookTransportResult,
} from '../../../src/webhooks/dispatcher';
import { deriveWebhookSecret, verifyWebhook } from '../../../src/webhooks/signing';

const RING = parseHmacKeyring(`w1:${randomBytes(32).toString('base64url')}`, 'TEST');
const NOW = new Date('2026-09-23T00:00:00.000Z');
const PUBLIC_IP = '93.184.215.14';

function claimed(overrides: Partial<ClaimedDelivery> = {}, endpoint: Partial<ClaimedDelivery['endpoint']> = {}): ClaimedDelivery {
  return {
    deliveryId: randomUUID(),
    eventId: randomUUID(),
    body: '{"id":"e","type":"message.sent"}',
    attempt: 1,
    ...overrides,
    endpoint: {
      id: randomUUID(),
      url: 'https://hooks.example.com/atmark',
      secretKid: 'w1',
      secretVersion: 1,
      disabled: false,
      ...endpoint,
    },
  };
}

function harness(
  deliveries: readonly ClaimedDelivery[],
  options: {
    readonly resolve?: HostResolver;
    readonly respond?: (request: WebhookHttpRequest) => Promise<WebhookTransportResult>;
    readonly fenced?: boolean;
  } = {},
) {
  const calls = {
    delivered: [] as { id: string; attempt: number; status: number }[],
    retried: [] as { id: string; attempt: number; at: Date; error: string; status: number | null }[],
    dead: [] as { id: string; attempt: number; error: string; status: number | null }[],
    requests: [] as WebhookHttpRequest[],
  };
  const fenced = options.fenced ?? true;
  const outbox: WebhookOutboxPort = {
    claimDue: vi.fn(async () => deliveries),
    async markDelivered(id, attempt, _now, status) {
      calls.delivered.push({ id, attempt, status });
      return fenced;
    },
    async scheduleRetry(id, attempt, at, error, status) {
      calls.retried.push({ id, attempt, at, error, status });
      return fenced;
    },
    async markDead(id, attempt, _now, error, status) {
      calls.dead.push({ id, attempt, error, status });
      return fenced;
    },
  };
  const resolve = options.resolve ?? vi.fn(async () => [{ address: PUBLIC_IP, family: 4 as const }]);
  const deps: WebhookDispatchDependencies = {
    outbox,
    resolve,
    keyring: RING,
    transport: {
      post: vi.fn(async (request: WebhookHttpRequest) => {
        calls.requests.push(request);
        return options.respond ? options.respond(request) : { kind: 'response' as const, status: 200 };
      }),
    },
  };
  return { deps, calls, resolve };
}

const headersOf = (request: WebhookHttpRequest | undefined) => ({
  id: request?.headers['webhook-id'] ?? '',
  timestamp: request?.headers['webhook-timestamp'] ?? '',
  signature: request?.headers['webhook-signature'] ?? '',
});

describe('웹훅 디스패처 — 성공 경로', () => {
  it('2xx → delivered. 서명은 파생 시크릿으로 검증되고 webhook-id 는 이벤트 id 다', async () => {
    const delivery = claimed();
    const { deps, calls } = harness([delivery]);
    const reports = await dispatchDueWebhooks(deps, NOW);

    expect(reports).toEqual([{ deliveryId: delivery.deliveryId, outcome: 'delivered', errorKind: null, httpStatus: 200 }]);
    expect(calls.delivered).toEqual([{ id: delivery.deliveryId, attempt: 1, status: 200 }]);

    const [request] = calls.requests;
    if (request === undefined) throw new Error('전송 없음');
    expect(request.headers['webhook-id']).toBe(delivery.eventId);
    expect(request.body).toBe(delivery.body);
    const secret = deriveWebhookSecret(RING, { endpointId: delivery.endpoint.id, kid: 'w1', version: 1 });
    expect(verifyWebhook(secret, headersOf(request), request.body, NOW)).toEqual({ kind: 'valid' });
  });
});

describe('웹훅 디스패처 — 재시도 정책', () => {
  it('스케줄은 10회, 첫 시도부터 마지막까지 약 31시간 40분이다', () => {
    expect(MAX_ATTEMPTS).toBe(10);
    const total = RETRY_SCHEDULE_MS.reduce((a, b) => a + b, 0);
    expect(total).toBe((31 * 60 + 42) * 60_000 + 30_000);
  });

  it.each([
    [1, 30_000],
    [2, 120_000],
    [9, 16 * 3_600_000],
  ])('시도 %i 가 500 이면 %i ms 뒤 재시도', async (attempt, delay) => {
    const delivery = claimed({ attempt });
    const { deps, calls } = harness([delivery], { respond: async () => ({ kind: 'response', status: 500 }) });
    await dispatchDueWebhooks(deps, NOW);
    expect(calls.retried).toEqual([
      { id: delivery.deliveryId, attempt, at: new Date(NOW.getTime() + delay), error: 'http_status', status: 500 },
    ]);
    expect(calls.dead).toEqual([]);
  });

  it('마지막(10번째) 시도가 실패하면 dead', async () => {
    const delivery = claimed({ attempt: MAX_ATTEMPTS });
    const { deps, calls } = harness([delivery], { respond: async () => ({ kind: 'response', status: 503 }) });
    await dispatchDueWebhooks(deps, NOW);
    expect(calls.dead).toEqual([{ id: delivery.deliveryId, attempt: MAX_ATTEMPTS, error: 'http_status', status: 503 }]);
    expect(calls.retried).toEqual([]);
  });

  it('크래시로 한도를 넘겨 집힌 건은 보내지 않고 dead', async () => {
    const delivery = claimed({ attempt: MAX_ATTEMPTS + 1 });
    const { deps, calls } = harness([delivery]);
    await dispatchDueWebhooks(deps, NOW);
    expect(calls.requests).toEqual([]);
    expect(calls.dead).toMatchObject([{ error: 'max_attempts_exceeded' }]);
  });

  it.each([
    ['3xx 는 실패다 — 리다이렉트를 따라가지 않는다', { kind: 'response', status: 302 }, 'http_status'],
    ['4xx', { kind: 'response', status: 404 }, 'http_status'],
    ['네트워크', { kind: 'network_error', code: 'ECONNREFUSED' }, 'network_error'],
    ['타임아웃', { kind: 'timeout' }, 'timeout'],
  ] as const)('%s → 재시도', async (_label, result, error) => {
    const { deps, calls } = harness([claimed()], { respond: async () => result });
    await dispatchDueWebhooks(deps, NOW);
    expect(calls.retried).toMatchObject([{ error }]);
    expect(calls.delivered).toEqual([]);
  });

  it('전송단이 던지면 실패로 센다 — 삼켜서 성공으로 두지 않는다', async () => {
    const { deps, calls } = harness([claimed()], { respond: async () => Promise.reject(new Error('boom')) });
    await dispatchDueWebhooks(deps, NOW);
    expect(calls.retried).toMatchObject([{ error: 'network_error' }]);
  });

  it('DNS 실패 → 재시도', async () => {
    const { deps, calls } = harness([claimed()], { resolve: vi.fn(async () => Promise.reject(new Error('ENOTFOUND'))) });
    await dispatchDueWebhooks(deps, NOW);
    expect(calls.retried).toMatchObject([{ error: 'dns_failure' }]);
    expect(calls.requests).toEqual([]);
  });

  it('서명 키(kid)가 묶음에 없으면 보내지 않고 재시도 — 설정이 고쳐지면 회복된다', async () => {
    const { deps, calls } = harness([claimed({}, { secretKid: 'gone' })]);
    await dispatchDueWebhooks(deps, NOW);
    expect(calls.requests).toEqual([]);
    expect(calls.retried).toMatchObject([{ error: 'signing_key_unavailable' }]);
  });

  it('펜싱에 지면 lease_lost 로 보고한다', async () => {
    const { deps } = harness([claimed()], { fenced: false });
    expect(await dispatchDueWebhooks(deps, NOW)).toMatchObject([{ outcome: 'lease_lost' }]);
  });
});

describe('웹훅 디스패처 — SSRF', () => {
  it.each([
    ['메타데이터로 풀리는 이름', 'https://hooks.example.com/', ['169.254.169.254']],
    ['사설 대역으로 풀리는 이름', 'https://hooks.example.com/', ['10.0.0.8']],
    ['IPv6 ULA 로 풀리는 이름', 'https://hooks.example.com/', ['fd00:ec2::254']],
    ['IP 리터럴 루프백', 'https://127.0.0.1/', []],
    ['내부 이름', 'https://metadata.google.internal/', []],
  ])('%s → 보내지 않고 **첫 시도에서 바로** dead(blocked_destination)', async (_label, url, addresses) => {
    const resolve = vi.fn(async () =>
      addresses.map((address) => ({ address, family: address.includes(':') ? (6 as const) : (4 as const) })),
    );
    const { deps, calls } = harness([claimed({ attempt: 1 }, { url })], { resolve });
    await dispatchDueWebhooks(deps, NOW);
    expect(calls.requests).toEqual([]);
    expect(calls.dead).toMatchObject([{ attempt: 1, error: 'blocked_destination' }]);
    expect(calls.retried).toEqual([]);
  });

  it('**DNS 재바인딩** — 첫 응답은 공인, 두 번째는 메타데이터여도 연결은 검사한 IP 로 간다', async () => {
    const answers = [PUBLIC_IP, '169.254.169.254'];
    const resolve = vi.fn(async () => [{ address: answers.shift() ?? '169.254.169.254', family: 4 as const }]);
    const { deps, calls } = harness([claimed()], { resolve });

    await dispatchDueWebhooks(deps, NOW);

    // 리졸버는 한 번만 불렸고, 전송단은 그 한 번의 결과(공인 IP)를 받았다.
    // 검사와 연결이 각자 이름을 풀었다면 두 번째 응답(메타데이터)이 연결에 쓰였을 것이다.
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(calls.requests).toHaveLength(1);
    expect(calls.requests[0]).toMatchObject({ hostname: 'hooks.example.com', address: PUBLIC_IP, family: 4 });
  });

  it('비활성 엔드포인트는 보내지 않고 dead', async () => {
    const { deps, calls } = harness([claimed({}, { disabled: true })]);
    await dispatchDueWebhooks(deps, NOW);
    expect(calls.requests).toEqual([]);
    expect(calls.dead).toMatchObject([{ error: 'endpoint_disabled' }]);
  });

  it('http 로 바뀐 URL(등록 뒤 우회)은 invalid_url 로 dead', async () => {
    const { deps, calls } = harness([claimed({}, { url: 'http://hooks.example.com/' })]);
    await dispatchDueWebhooks(deps, NOW);
    expect(calls.requests).toEqual([]);
    expect(calls.dead).toMatchObject([{ error: 'invalid_url' }]);
  });
});

describe('웹훅 디스패처 — 한 건의 실패가 다른 건을 막지 않는다', () => {
  it('차단·실패·성공이 섞여도 각자 기록된다', async () => {
    const blocked = claimed({}, { url: 'https://127.0.0.1/' });
    const failing = claimed({}, { url: 'https://fail.example.com/' });
    const ok = claimed();
    const { deps, calls } = harness([blocked, failing, ok], {
      respond: async (request) =>
        request.hostname === 'fail.example.com' ? { kind: 'response', status: 500 } : { kind: 'response', status: 204 },
    });
    const reports = await dispatchDueWebhooks(deps, NOW);
    expect(reports.map((r) => r.outcome)).toEqual(['dead', 'retry_scheduled', 'delivered']);
    expect(calls.delivered).toMatchObject([{ id: ok.deliveryId, status: 204 }]);
  });
});

/**
 * 메일 기본기 1차 A4 — 알람 `atmark-webhook-dead-ratio` 의 분자·분모(`webhookDead` · `webhookDelivered`). **펜싱을 통과한 결말만** 센다 —
 * 임대를 잃은 늦은 시도까지 세면 한 전달이 두 번 잡혀 비율이 흔들린다. 재시도 예약은 결말이 아니라 세지 않는다.
 */
describe('웹훅 디스패처 — 결말 메트릭(A4)', () => {
  async function metricsOf(run: () => Promise<unknown>): Promise<{ delivered: number; dead: number }> {
    const lines: string[] = [];
    setLogSink((line) => lines.push(line));
    try {
      await run();
    } finally {
      resetLogSink();
    }
    return {
      delivered: lines.filter((line) => line.includes('"atmark.webhook.delivered"')).length,
      dead: lines.filter((line) => line.includes('"atmark.webhook.dead"')).length,
    };
  }

  it('2xx → delivered 1 · dead 0', async () => {
    const { deps } = harness([claimed()]);
    expect(await metricsOf(() => dispatchDueWebhooks(deps, NOW))).toEqual({ delivered: 1, dead: 0 });
  });

  it('영구 실패(목적지 차단) → dead 1 · 마지막 시도의 5xx → dead 1 · 재시도 예약 → 0', async () => {
    const blocked = harness([claimed({}, { url: 'https://127.0.0.1/' })]);
    expect(await metricsOf(() => dispatchDueWebhooks(blocked.deps, NOW))).toEqual({ delivered: 0, dead: 1 });

    const last = harness([claimed({ attempt: MAX_ATTEMPTS })], { respond: async () => ({ kind: 'response', status: 503 }) });
    expect(await metricsOf(() => dispatchDueWebhooks(last.deps, NOW))).toEqual({ delivered: 0, dead: 1 });

    const retry = harness([claimed({ attempt: 1 })], { respond: async () => ({ kind: 'response', status: 503 }) });
    expect(await metricsOf(() => dispatchDueWebhooks(retry.deps, NOW))).toEqual({ delivered: 0, dead: 0 });
  });

  it('M7-b 소유자가 지운 엔드포인트(endpoint_disabled)의 dead 는 행은 dead 로 남기되 dead 메트릭에서 뺀다 — 한 테넌트의 삭제가 알람 24 를 울리지 않게', async () => {
    const disabled = harness([claimed({}, { disabled: true })]);
    const reports: unknown[] = [];
    expect(await metricsOf(async () => reports.push(...(await dispatchDueWebhooks(disabled.deps, NOW))))).toEqual({ delivered: 0, dead: 0 });
    expect(disabled.calls.dead).toMatchObject([{ error: 'endpoint_disabled' }]);
    expect(reports).toMatchObject([{ outcome: 'dead', errorKind: 'endpoint_disabled' }]);
  });

  it('임대를 잃은 결말(펜싱 실패)은 세지 않는다', async () => {
    const ok = harness([claimed()], { fenced: false });
    expect(await metricsOf(() => dispatchDueWebhooks(ok.deps, NOW))).toEqual({ delivered: 0, dead: 0 });
    const dead = harness([claimed({}, { url: 'https://127.0.0.1/' })], { fenced: false });
    expect(await metricsOf(() => dispatchDueWebhooks(dead.deps, NOW))).toEqual({ delivered: 0, dead: 0 });
  });
});

describe('시크릿 회전 유예 — 새·옛 둘 다로 서명', () => {
  it('유예 안이면 서명 둘(`v1,<새> v1,<옛>`) — 새 시크릿·옛 시크릿 어느 쪽으로도 검증된다', async () => {
    const delivery = claimed({}, { secretVersion: 2, previousSecret: { kid: 'w1', version: 1, validUntil: new Date(NOW.getTime() + 1) } });
    const { deps, calls } = harness([delivery]);
    await dispatchDueWebhooks(deps, NOW);
    const request = calls.requests[0];
    const entries = (request?.headers['webhook-signature'] ?? '').split(' ');
    expect(entries).toHaveLength(2);
    for (const entry of entries) expect(entry).toMatch(/^v1,[A-Za-z0-9+/]+=*$/);
    const fresh = deriveWebhookSecret(RING, { endpointId: delivery.endpoint.id, kid: 'w1', version: 2 });
    const previous = deriveWebhookSecret(RING, { endpointId: delivery.endpoint.id, kid: 'w1', version: 1 });
    expect(verifyWebhook(fresh, headersOf(request), delivery.body, NOW)).toEqual({ kind: 'valid' });
    expect(verifyWebhook(previous, headersOf(request), delivery.body, NOW)).toEqual({ kind: 'valid' });
    // 순서: 새 것이 먼저다.
    const onlyFresh = { ...headersOf(request), signature: entries[0] ?? '' };
    expect(verifyWebhook(fresh, onlyFresh, delivery.body, NOW)).toEqual({ kind: 'valid' });
  });

  it('유예가 끝나면(now ≥ validUntil) 서명 하나 — 옛 시크릿은 더 맞지 않는다', async () => {
    const delivery = claimed({}, { secretVersion: 2, previousSecret: { kid: 'w1', version: 1, validUntil: NOW } });
    const { deps, calls } = harness([delivery]);
    await dispatchDueWebhooks(deps, NOW);
    const request = calls.requests[0];
    expect((request?.headers['webhook-signature'] ?? '').split(' ')).toHaveLength(1);
    const previous = deriveWebhookSecret(RING, { endpointId: delivery.endpoint.id, kid: 'w1', version: 1 });
    expect(verifyWebhook(previous, headersOf(request), delivery.body, NOW)).toEqual({ kind: 'invalid', reason: 'no_matching_signature' });
  });

  it('옛 kid 가 키 묶음에서 빠졌으면 새 시크릿 하나로만 서명하고 전달은 그대로 된다(실패시키지 않는다)', async () => {
    const delivery = claimed({}, { secretVersion: 3, previousSecret: { kid: 'gone', version: 2, validUntil: new Date(NOW.getTime() + 60_000) } });
    const { deps, calls } = harness([delivery]);
    const [report] = await dispatchDueWebhooks(deps, NOW);
    expect(report?.outcome).toBe('delivered');
    expect((calls.requests[0]?.headers['webhook-signature'] ?? '').split(' ')).toHaveLength(1);
  });

  it('회전한 적 없으면(`previousSecret` null·없음) 서명 하나 — 예전과 같다', async () => {
    for (const previousSecret of [null, undefined]) {
      const { deps, calls } = harness([claimed({}, previousSecret === null ? { previousSecret } : {})]);
      await dispatchDueWebhooks(deps, NOW);
      expect((calls.requests[0]?.headers['webhook-signature'] ?? '').split(' ')).toHaveLength(1);
    }
  });
});
