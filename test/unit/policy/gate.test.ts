/**
 * `gate.ts` — 평가 → lease → audit → 전송의 유일 경로(§4.2, §4.5).
 * 전송 경로는 `vi.mock` 으로 매니페스트에 픽스처 경로를 심어 검사한다 — 프로덕션에 "경로 목록 주입" 이음매를 만들면
 * 호출자가 매니페스트 대조를 우회할 수 있다(AC-8). 이음매는 테스트에만 있다.
 */

import { entitlementRow } from '../../support/entitlements';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageStatus } from '../../../src/db/schema';
import { resetLogSink, setLogSink } from '../../../src/observability/logger';
import {
  dispatch,
  SerializationUnavailableError,
  unavailableTransport,
  unserialized,
  type AuditEntry,
  type DispatchSerializer,
  type GateDependencies,
} from '../../../src/policy/gate';
import { OUTBOUND_ROUTES } from '../../../src/policy/manifest';
import { unavailablePolicySource, type PolicySource, type PolicySourceResult } from '../../../src/policy/policy-loader';
import { AGENT_ID, NOW, ORG_ID, POLICY_VERSION_ID, baseAttempt, baseCounters } from './fixtures';

vi.mock('../../../src/policy/manifest', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/policy/manifest')>();
  return {
    ...original,
    OUTBOUND_ROUTES: [
      {
        id: 'fixture_send',
        kind: 'http',
        file: 'src/api/routes/fixture-messages.ts',
        ref: 'POST /v1/fixture/messages',
        requiresIdempotencyKey: true,
      },
    ],
  };
});

const SOURCE_RESULT: PolicySourceResult = {
  entitlements: entitlementRow('beta'),
  organization: {
    id: ORG_ID,
    name: 'Atmark',
    ses_tenant_id: null,
    billing_status: 'active',
    abuse_freeze: false,
    owner_paused: false,
    review_status: 'active',
    sending_started_at: new Date('2026-09-01T00:00:00.000Z'),
    created_at: NOW,
    updated_at: NOW,
  },
  agent: {
    id: AGENT_ID,
    organization_id: ORG_ID,
    name: 'demo',
    status: 'active',
    plan: 'free',
    monthly_budget_cents: 10_000,
    created_at: NOW,
    updated_at: NOW,
  },
  addresses: [
    { id: 'addr-1', agent_id: AGENT_ID, address: 'agent@atmark.ai', domain: 'atmark.ai', is_primary: true, created_at: NOW },
  ],
  policy: {
    agent_id: AGENT_ID,
    outbound_mode: 'allowlist_only',
    inbound_mode: 'all',
    require_approval: false,
    limits: { per_minute: 10, per_hour: 100, per_day: 500, recipients_per_message: 10 },
    config_json: {
      max_attachment_bytes_total: 5_000_000,
      allowed_mime_types: ['application/pdf'],
    },
    current_version: 1,
    created_at: NOW,
    updated_at: NOW,
  },
  policyVersion: {
    id: POLICY_VERSION_ID,
    agent_id: AGENT_ID,
    version: 1,
    outbound_mode: 'allowlist_only',
    inbound_mode: 'all',
    // 정책 v2 — 목록은 버전 스냅샷에서(202609241040).
    snapshot: {
      contact_rules: [
        { id: '55555555-5555-4555-8555-555555555555', direction: 'outbound', list: 'allow', kind: 'address', value: 'friend@example.com' },
      ],
    },
    created_by: null,
    created_at: NOW,
  },
  suppressions: [],
  counters: baseCounters,
  monthToDateSpentCents: 0,
  relationships: [],
  approvalGrant: null,
  outboundSentCount: 0,
  agentRequestedRuleIds: [],
  // 고객 도메인(ADR-0014) — 에이전트 주소가 전부 atmark.ai 라 소스가 고객 도메인 행을 주지 않는다.
  inactiveAddresses: [],
  customDomains: [],
  thread: null,
};

function workingSource(): PolicySource {
  return { load: () => Promise.resolve(SOURCE_RESULT) };
}

interface Harness {
  readonly deps: GateDependencies;
  readonly audit: { readonly records: AuditEntry[]; readonly resolutions: string[] };
  readonly sesSendCalls: { count: number };
}

function harness(options: {
  readonly source?: PolicySource;
  readonly acquire?: boolean;
  readonly status?: MessageStatus;
  readonly sendFails?: boolean;
  /** 전송은 **성공**하되 그 뒤의 `audit.resolve` 가 첫 호출에 던진다. */
  readonly resolveFailsAfterSend?: boolean;
  /** 직렬화 계층 주입. 생략하면 직렬화하지 않는다(단일 시도 단위 테스트). */
  readonly serializer?: DispatchSerializer;
}): Harness {
  const records: AuditEntry[] = [];
  const resolutions: string[] = [];
  const sesSendCalls = { count: 0 };

  return {
    audit: { records, resolutions },
    sesSendCalls,
    deps: {
      source: options.source ?? workingSource(),
      serializer: options.serializer ?? unserialized(),
      audit: {
        record: (entry) => {
          records.push(entry);
          return Promise.resolve(`audit-${records.length}`);
        },
        resolve: (auditId, outcome) => {
          // 전송 성공 뒤의 기록만 실패시킨다("성공 후 기록 실패" 축만 분리).
          if (options.resolveFailsAfterSend === true && outcome === 'sent') {
            return Promise.reject(new Error('audit UPDATE timeout'));
          }
          resolutions.push(`${auditId}:${outcome}`);
          return Promise.resolve();
        },
        resolvePending: () => Promise.resolve(false),
      },
      leases: {
        acquire: () => Promise.resolve(options.acquire ?? true),
        statusOf: () => Promise.resolve(options.status ?? 'pending'),
      },
      transport: {
        send: () => {
          sesSendCalls.count += 1;
          return options.sendFails
            ? Promise.reject(new Error('ses unavailable'))
            : Promise.resolve({ sesMessageId: 'ses-1' });
        },
      },
      leaseTtlSeconds: 300,
    },
  };
}

const request = {
  agentId: AGENT_ID,
  attempt: { ...baseAttempt, recipients: ['friend@example.com'] },
  now: NOW,
  traceId: 'trace-1',
  thisAttemptCostCents: 10,
  messageId: 'msg-1',
  messageIdHeader: '<msg-1@atmark.ai>',
  leaseId: 'lease-1',
  release: null,
};

describe('gate — 실제 매니페스트와 테스트 픽스처는 다른 것이다', () => {
  // 표적은 이음매다 — 실제 매니페스트와 테스트 픽스처(1건)가 **다르다는 것**을 단언한다.
  it('실제 매니페스트에는 발송 경로가 등록돼 있다 (send/reply/forward/scheduled_send …)', async () => {
    const actual = await vi.importActual<typeof import('../../../src/policy/manifest')>(
      '../../../src/policy/manifest',
    );
    expect(actual.OUTBOUND_ROUTES.length).toBeGreaterThan(0);
    expect(actual.OUTBOUND_ROUTES.map((route) => route.id)).toContain('send');
    // 이음매가 실재한다 — 이 파일이 보는 것은 실제 매니페스트가 아니다.
    expect(actual.OUTBOUND_ROUTES.length).not.toBe(OUTBOUND_ROUTES.length);
  });

  it('테스트가 보는 매니페스트는 픽스처 1건이다 (이음매는 테스트에만 있다)', () => {
    expect(OUTBOUND_ROUTES).toHaveLength(1);
  });
});

describe('gate — 거부 경로', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness({});
  });

  it('등록되지 않은 routeId 는 평가 전에 거부된다 + SES 호출 0회', async () => {
    const outcome = await dispatch(h.deps, { ...request, attempt: { ...request.attempt, routeId: 'ghost' } });

    expect(outcome.kind).toBe('denied');
    expect(outcome.decision.reasons).toEqual(['unregistered_route']);
    expect(h.sesSendCalls.count).toBe(0);
  });

  it('정책 거부 시 audit 행이 정확히 1개 + SES 호출 0회 (§4.3, Layer D)', async () => {
    const outcome = await dispatch(h.deps, {
      ...request,
      attempt: { ...request.attempt, recipients: ['stranger@example.com'] },
    });

    expect(outcome.kind).toBe('denied');
    expect(outcome.decision.reasons).toEqual(['recipient_not_allowlisted']);
    expect(h.audit.records).toHaveLength(1);
    expect(h.audit.records[0]?.decision.policyVersion).toBe(1);
    expect(h.sesSendCalls.count).toBe(0);
  });

  // 회귀 — 발송 성공 뒤의 기록 실패가 나간 메일에 `failed` 를 찍으면 호출자의 재시도가 두 번째 메일을 보낸다(§4.5).
  // 허용 축의 사후 실패라 deny-all 매트릭스·Layer A~F 가 잡지 못한다.
  it('전송 성공 뒤 audit 해소가 실패해도 결말은 sent 다 — 기록 실패가 중복 발송의 원인이 되지 않는다', async () => {
    const h2 = harness({ resolveFailsAfterSend: true });
    const outcome = await dispatch(h2.deps, request);

    // 핵심: 나간 메일을 'failed' 로 재분류하지 않는다.
    expect(outcome.kind).toBe('sent');
    expect(h2.sesSendCalls.count).toBe(1);

    // 해소는 실패했으므로 행이 미해소로 남는다 — 그 뜻은 "전송 이후" 하나다.
    expect(h2.audit.records).toHaveLength(1);
    expect(h2.audit.resolutions).toEqual([]);
  });

  it('정책을 못 읽어도 audit 행은 남는다 — 조용한 거부는 없다 (Principle P3)', async () => {
    const failing = harness({ source: unavailablePolicySource() });
    const outcome = await dispatch(failing.deps, request);

    expect(outcome.kind).toBe('denied');
    expect(outcome.decision.reasons).toEqual(['evaluation_error']);
    expect(failing.sesSendCalls.count).toBe(0);

    expect(failing.audit.records).toHaveLength(1);

    // 스탬프는 둘 다 `null`(DB CHECK 가 `denied` + `evaluation_error` 로 좁힌다).
    const row = failing.audit.records[0];
    expect(row?.decision.policyVersion).toBeNull();
    expect(row?.decision.policyVersionId).toBeNull();
    expect(row?.decision.verdict).toBe('denied');
  });

  it('엔진이 던져도 통과하지 않는다 — 열거형 밖 모드가 evaluation_error 로 떨어진다', async () => {
    // 엔진이 던지는 경로는 DB 가 열거형 밖 값을 넘긴 경우뿐이다(Stage 7 `default`).
    const rogueMode = 'not_a_mode' as unknown as 'allowlist_only';
    const unimplemented = harness({
      source: {
        load: () =>
          Promise.resolve({
            ...SOURCE_RESULT,
            policy: { ...SOURCE_RESULT.policy, outbound_mode: rogueMode },
            policyVersion: { ...SOURCE_RESULT.policyVersion, outbound_mode: rogueMode },
          }),
      },
    });

    const outcome = await dispatch(unimplemented.deps, request);
    expect(outcome.kind).toBe('denied');
    expect(outcome.decision.reasons).toEqual(['evaluation_error']);
    expect(unimplemented.sesSendCalls.count).toBe(0);
  });
});

describe('gate — 전송 경로 (§4.5 lease)', () => {
  it('허용 → lease 취득 → 전송 → 같은 audit 행 갱신', async () => {
    const h = harness({});
    const outcome = await dispatch(h.deps, request);

    expect(outcome.kind).toBe('sent');
    expect(h.sesSendCalls.count).toBe(1);
    expect(h.audit.records).toHaveLength(1);
    expect(h.audit.resolutions).toEqual(['audit-1:sent']);
  });

  it('허용 경로의 audit 행은 **lease 취득 뒤에** 쓰인다 (§4.5-5)', async () => {
    const order: string[] = [];
    const h = harness({});
    const deps: GateDependencies = {
      ...h.deps,
      audit: {
        record: (entry) => {
          order.push('audit.record');
          return h.deps.audit.record(entry);
        },
        resolve: (auditId, outcome, reason) => {
          order.push(`audit.resolve:${outcome}`);
          return h.deps.audit.resolve(auditId, outcome, reason);
        },
        resolvePending: h.deps.audit.resolvePending,
      },
      leases: {
        acquire: (leaseRequest) => {
          order.push('lease.acquire');
          return h.deps.leases.acquire(leaseRequest);
        },
        statusOf: (messageId) => h.deps.leases.statusOf(messageId),
      },
      transport: {
        send: (transportRequest) => {
          order.push('transport.send');
          return h.deps.transport.send(transportRequest);
        },
      },
    };

    await dispatch(deps, request);
    expect(order).toEqual(['lease.acquire', 'audit.record', 'transport.send', 'audit.resolve:sent']);
  });

  it('lease 를 못 얻으면 전송도 audit 행도 없다 — 중복 SQS 전달이 여기서 죽는다', async () => {
    const h = harness({ acquire: false });
    const outcome = await dispatch(h.deps, request);

    expect(outcome.kind).toBe('duplicate_suppressed');
    expect(h.sesSendCalls.count).toBe(0);
    // 행을 쓰면 재전달 수만큼 audit 행이 늘고(AC-i1) "보내다 죽었다" 와 구별되지 않는다.
    expect(h.audit.records).toHaveLength(0);
    expect(h.audit.resolutions).toEqual([]);
  });

  it('이미 종단 상태인 메시지는 lease 도 audit 행도 시도하지 않는다', async () => {
    for (const status of ['sent', 'failed'] as const) {
      const h = harness({ status });
      const outcome = await dispatch(h.deps, request);
      expect(outcome.kind).toBe('duplicate_suppressed');
      expect(h.sesSendCalls.count).toBe(0);
      expect(h.audit.records).toHaveLength(0);
    }
  });

  it('SQS 3회 재전달 — SES 호출 1회 · audit 행 1개 (AC-i1 · AC-i2)', async () => {
    // 평가는 세 번 일어나도 행은 lease 를 이긴 워커 하나만 쓴다(§4.5-5).
    const records: AuditEntry[] = [];
    const resolutions: string[] = [];
    const sesSendCalls = { count: 0 };
    let status: MessageStatus = 'pending';
    let leaseHeld = false;

    const deps: GateDependencies = {
      source: workingSource(),
      serializer: unserialized(),
      audit: {
        record: (entry) => {
          records.push(entry);
          return Promise.resolve(`audit-${records.length}`);
        },
        resolve: (auditId, outcome) => {
          resolutions.push(`${auditId}:${outcome}`);
          return Promise.resolve();
        },
        resolvePending: () => Promise.resolve(false),
      },
      leases: {
        acquire: () => {
          if (leaseHeld) return Promise.resolve(false);
          leaseHeld = true;
          return Promise.resolve(true);
        },
        statusOf: () => Promise.resolve(status),
      },
      transport: {
        send: () => {
          sesSendCalls.count += 1;
          status = 'sent';
          return Promise.resolve({ sesMessageId: 'ses-1' });
        },
      },
      leaseTtlSeconds: 300,
    };

    const kinds: string[] = [];
    for (let delivery = 0; delivery < 3; delivery += 1) {
      kinds.push((await dispatch(deps, request)).kind);
    }

    expect(kinds).toEqual(['sent', 'duplicate_suppressed', 'duplicate_suppressed']);
    expect(sesSendCalls.count).toBe(1);
    expect(records).toHaveLength(1);
    expect(resolutions).toEqual(['audit-1:sent']);
  });

  it('전송 실패는 같은 audit 행에 failed 로 기록된다 (새 행이 아니다)', async () => {
    const h = harness({ sendFails: true });
    const outcome = await dispatch(h.deps, request);

    expect(outcome.kind).toBe('failed');
    expect(h.audit.records).toHaveLength(1);
    expect(h.audit.resolutions).toEqual(['audit-1:failed']);
  });

  it('Error 가 아닌 값이 던져져도 사유 문자열로 기록된다', async () => {
    const h = harness({});
    const deps: GateDependencies = {
      ...h.deps,
      transport: {
        send: () => {
          h.sesSendCalls.count += 1;
          // 라이브러리가 문자열을 던지기도 한다 — `reason` 이 `undefined` 가 되면 안 된다.
          return Promise.reject('ses blew up');
        },
      },
    };

    const outcome = await dispatch(deps, request);
    expect(outcome.kind).toBe('failed');
    expect(outcome).toMatchObject({ reason: 'ses blew up' });
  });

  it('허용인데 messages 행이 없으면 보내지 않는다 (호출자 계약 위반)', async () => {
    const h = harness({});
    const outcome = await dispatch(h.deps, { ...request, messageId: null });

    expect(outcome.kind).toBe('failed');
    expect(h.sesSendCalls.count).toBe(0);
    expect(h.audit.resolutions).toEqual(['audit-1:failed']);
  });
});

describe('DispatchSerializer — 평가~lease 구간의 직렬화 (R22)', () => {
  /** 호출 순서를 기록하는 serializer. 구간이 **평가보다 먼저 열리는지**가 요점이다. */
  function recordingSerializer(events: string[]) {
    return {
      async serialize<T>(_agentId: typeof AGENT_ID, run: () => Promise<T>): Promise<T> {
        events.push('lock');
        try {
          return await run();
        } finally {
          events.push('unlock');
        }
      },
    };
  }

  it('구간은 평가 전에 열리고 전송 전에 닫힌다 — SES 왕복은 잠금 밖이다', async () => {
    const events: string[] = [];
    const h = harness({ serializer: recordingSerializer(events) });
    const deps = {
      ...h.deps,
      transport: {
        send: () => {
          events.push('transport');
          h.sesSendCalls.count += 1;
          return Promise.resolve({ sesMessageId: 'ses-1' });
        },
      },
    };

    const outcome = await dispatch(deps, request);

    expect(outcome.kind).toBe('sent');
    // `unlock` 이 `transport` 보다 앞 — 뒤라면 조직 전체가 SES 왕복만큼 줄을 선다.
    expect(events).toEqual(['lock', 'unlock', 'transport']);
  });

  it('직렬화가 실패하면 보내지 않고 denied + evaluation_error 로 남긴다 (fail closed)', async () => {
    const h = harness({
      serializer: {
        serialize: () => Promise.reject(new SerializationUnavailableError('잠글 조직을 찾지 못했다')),
      },
    });

    const outcome = await dispatch(h.deps, request);

    expect(outcome.kind).toBe('denied');
    expect(outcome).toMatchObject({ decision: { reasons: ['evaluation_error'] } });
    expect(h.sesSendCalls.count).toBe(0);
    // **조용한 거부는 없다.** 잠그지 못한 시도도 audit 행 1개를 남긴다.
    expect(h.audit.records).toHaveLength(1);
  });

  it('직렬화 외의 예외는 삼키지 않는다 — 행을 못 남긴 거부가 되면 안 된다', async () => {
    const h = harness({
      serializer: {
        serialize: () => Promise.reject(new Error('audit INSERT 실패')),
      },
    });

    await expect(dispatch(h.deps, request)).rejects.toThrow(/audit INSERT 실패/);
    expect(h.sesSendCalls.count).toBe(0);
  });

  it('unserialized() 는 구간을 그대로 통과시킨다 — 이름이 무엇을 포기했는지 말한다', async () => {
    const seen: string[] = [];
    const result = await unserialized().serialize(AGENT_ID, () => {
      seen.push('run');
      return Promise.resolve('ok');
    });

    expect(result).toBe('ok');
    expect(seen).toEqual(['run']);
  });
});

describe('unavailableTransport — P1a 의 전송단 스텁', () => {
  it('조용히 성공하지 않고 던진다 — 호출될 수 없는 것과 호출해도 무해한 것은 다르다', async () => {
    await expect(
      unavailableTransport().send({
        messageId: 'msg-1',
        messageIdHeader: '<m@atmark.ai>',
        fromAddress: 'agent@atmark.ai',
        recipients: ['friend@example.com'],
      }),
    ).rejects.toThrow(/P1a 에는 전송단이 없다/);
  });

});

describe('gate — 관측은 발송의 결말을 뒤집지 않는다 (P1c 회귀)', () => {
  afterEach(() => {
    resetLogSink();
  });

  // 전송 성공 뒤의 관측이 던지면 나간 메일이 `failed` 가 되고 재시도가 두 번째 메일을 보낸다.
  // 방어: 관측은 던지지 않고(①) `settle` 반환 뒤 try 밖에 있다(②). 싱크를 폭파시켜 ①을 확인한다.
  it('로그 싱크가 던져도 결말은 sent 다', async () => {
    setLogSink(() => {
      throw new Error('CloudWatch agent down');
    });

    const h = harness({});
    const outcome = await dispatch(h.deps, request);

    expect(outcome.kind).toBe('sent');
    expect(h.sesSendCalls.count).toBe(1);
    // audit 은 관측과 무관하게 해소된다(두 평면은 분리돼 있다).
    expect(h.audit.resolutions).toEqual(['audit-1:sent']);
  });

  it('싱크가 던지는 **동시에** audit 해소도 실패해도 결말은 sent 다', async () => {
    // 최악의 조합(기록·알람 모두 실패)에도 나간 메일을 안 나갔다고 말하지 않는다.
    setLogSink(() => {
      throw new Error('EPIPE');
    });

    const h = harness({ resolveFailsAfterSend: true });
    const outcome = await dispatch(h.deps, request);

    expect(outcome.kind).toBe('sent');
    expect(h.sesSendCalls.count).toBe(1);
    expect(h.audit.resolutions).toEqual([]);
  });

  it('거부 경로에서도 싱크 폭파가 결말을 바꾸지 않는다', async () => {
    setLogSink(() => {
      throw new Error('sink down');
    });

    const h = harness({});
    const outcome = await dispatch(h.deps, {
      ...request,
      attempt: { ...request.attempt, recipients: ['stranger@example.com'] },
    });

    expect(outcome.kind).toBe('denied');
    expect(h.sesSendCalls.count).toBe(0);
    expect(h.audit.records).toHaveLength(1);
  });

  it('직렬화 실패 경로 — 알람 3의 방출이 실패해도 fail-closed 가 유지된다', async () => {
    setLogSink(() => {
      throw new Error('sink down');
    });

    const h = harness({
      serializer: {
        serialize: () => Promise.reject(new SerializationUnavailableError('잠글 조직을 찾지 못했다')),
      },
    });

    const outcome = await dispatch(h.deps, request);

    expect(outcome.kind).toBe('denied');
    expect(h.sesSendCalls.count).toBe(0);
    expect(h.audit.records).toHaveLength(1);
  });

  it('관문은 시도마다 로그 1줄과 메트릭을 방출한다 — 0줄이면 관측이 잠든 것이다', async () => {
    const lines: string[] = [];
    setLogSink((line) => {
      lines.push(line);
    });

    const h = harness({});
    await dispatch(h.deps, request);

    const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const attempts = parsed.filter((entry) => entry['event'] === 'gate.attempt');
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ route_id: 'fixture_send', verdict: 'allowed', recipient_count: 1 });

    // 메트릭은 EMF 로 같은 싱크에 나간다. `atmark.send.recipients` 가 없으면 알람 2 는 데이터가 없다.
    const emf = parsed.filter((entry) => entry['_aws'] !== undefined);
    const metricNames = emf.flatMap((entry) => Object.keys(entry).filter((key) => key.startsWith('atmark.')));
    expect(metricNames).toContain('atmark.gate.attempts');
    expect(metricNames).toContain('atmark.send.recipients');
  });

  it('from_inactive(폐기된 자기 주소)는 warn 한 줄과 따로 센 메트릭을 남긴다 — 위반이 아니어도 관측에서 사라지지 않는다(보안 리뷰 L1)', async () => {
    const lines: string[] = [];
    setLogSink((line) => {
      lines.push(line);
    });
    const retired = 'old-alias@atmark.ai';
    const h = harness({ source: { load: () => Promise.resolve({ ...SOURCE_RESULT, inactiveAddresses: [retired] }) } });
    const outcome = await dispatch(h.deps, { ...request, attempt: { ...request.attempt, fromAddress: retired } });
    expect(outcome.kind).toBe('denied');
    expect(outcome.decision.reasons).toEqual(['from_inactive']);
    const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(parsed.filter((entry) => entry['event'] === 'gate.from_inactive')).toEqual([expect.objectContaining({ level: 'warn', route_id: 'fixture_send' })]);
    const metricNames = parsed.filter((entry) => entry['_aws'] !== undefined).flatMap((entry) => Object.keys(entry).filter((key) => key.startsWith('atmark.')));
    expect(metricNames).toContain('atmark.gate.from_inactive');
    // 평범한 허용 시도는 이 신호를 내지 않는다.
    lines.length = 0;
    await dispatch(harness({}).deps, request);
    expect(lines.some((line) => line.includes('from_inactive'))).toBe(false);
  });

  it('수신자 주소는 관문 로그 어디에도 나타나지 않는다', async () => {
    const lines: string[] = [];
    setLogSink((line) => {
      lines.push(line);
    });

    const h = harness({});
    await dispatch(h.deps, request);

    expect(lines.join('\n')).not.toContain('friend@example.com');
  });
});

describe('위험 보류 관측(ADR-0016 — risk_hold.evaluated · risk_hold.held)', () => {
  afterEach(() => resetLogSink());

  function captured(): { readonly lines: Record<string, unknown>[] } {
    const lines: Record<string, unknown>[] = [];
    setLogSink((line) => {
      lines.push(JSON.parse(line) as Record<string, unknown>);
    });
    return { lines };
  }

  const evaluated = (lines: readonly Record<string, unknown>[]): unknown[] =>
    lines.filter((line) => 'atmark.risk_hold.evaluated' in line).map((line) => [line['outcome'], line['reason'] ?? null]);
  const held = (lines: readonly Record<string, unknown>[]): unknown[] =>
    lines.filter((line) => line['event'] === 'risk_hold.held').map((line) => [line['outcome'], line['reason']]);

  const signals = (mode: 'observe' | 'enforce') => ({ load: () => Promise.resolve({ mode, exposures: [] }) });

  it.each([
    ['enforce · 깨끗함 → clear', 'enforce', [], ['friend@example.com'], 'sent', ['clear', null], []],
    ['enforce · DLP → held(보류 + 로그)', 'enforce', ['atmark_credential'], ['friend@example.com'], 'pending_approval', ['held', 'dlp_atmark_credential'], [['held', 'dlp_atmark_credential']]],
    ['enforce · 앞 Stage 가 거부 → skipped(로그 없음)', 'enforce', ['atmark_credential'], ['stranger@example.com'], 'denied', ['skipped', 'dlp_atmark_credential'], []],
    ['observe · DLP → observed(판정 그대로 + 로그)', 'observe', ['atmark_credential'], ['friend@example.com'], 'sent', ['observed', 'dlp_atmark_credential'], [['observed', 'dlp_atmark_credential']]],
    ['observe · 앞 Stage 가 거부 → skipped', 'observe', ['atmark_credential'], ['stranger@example.com'], 'denied', ['skipped', 'dlp_atmark_credential'], []],
  ] as const)('%s', async (_label, mode, dlp, recipients, kind, metric, logs) => {
    const { lines } = captured();
    const h = harness({});
    const outcome = await dispatch({ ...h.deps, riskSignals: signals(mode) }, { ...request, attempt: { ...request.attempt, recipients: [...recipients], dlp: [...dlp] } });
    expect(outcome.kind).toBe(kind);
    expect(evaluated(lines)).toEqual([metric]);
    expect(held(lines)).toEqual(logs);
  });

  it('위험 신호 포트가 없으면(대역) 관측하지 않는다 · 포트가 던지면 evaluation_error', async () => {
    const { lines } = captured();
    expect((await dispatch(harness({}).deps, request)).kind).toBe('sent');
    expect(evaluated(lines)).toEqual([]);
    const failing = await dispatch({ ...harness({}).deps, riskSignals: { load: () => Promise.reject(new Error('db down')) } }, request);
    expect([failing.kind, failing.decision.reasons]).toEqual(['denied', ['evaluation_error']]);
  });
});
