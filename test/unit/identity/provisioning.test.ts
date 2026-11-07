/**
 * 프로비저닝(계획 §4B.1 — 원자성). 핵심은 순서와 경계다 — 모든 삽입이 한 `withTransaction` 콜백 안에서 일어나고, 중간에 실패하면 이후 삽입
 * 없이 롤백된다(소급 발급 경로의 부재).
 */

import { describe, expect, it } from 'vitest';
import { AGENT_ID_PATTERN, DEFAULT_OUTBOUND_MODE } from '../../../src/db/schema';
import { hashAgentToken, DEFAULT_AGENT_TOKEN_CAPABILITIES } from '../../../src/identity/agent-token';
import { AgentAddressError } from '../../../src/identity/address';
import { SeedContactError } from '../../../src/identity/seed-contacts';
import {
  DEFAULT_ALLOWED_MIME_TYPES,
  DEFAULT_MAX_ATTACHMENT_BYTES_TOTAL,
  DEFAULT_POLICY_LIMITS,
  INITIAL_POLICY_VERSION,
  provisionAgent,
  ProvisioningError,
  resolveOwnerEmail,
} from '../../../src/identity/provisioning';
import { createFakeStore, EXISTING_ORG_ID, provisionRequest, testKeyCustody, type FailurePoint } from './fixtures';

describe('provisionAgent — 정상 경로', () => {
  it('한 트랜잭션 안에서 정해진 순서로 전부 만든다', async () => {
    const { store, calls } = createFakeStore();
    await provisionAgent(store, provisionRequest(), testKeyCustody());

    expect(calls.order).toEqual([
      'withTransaction:begin',
      'findOrganization',
      'insertAgent',
      // ★ PP-A — 키와 draft passport 는 **에이전트 행 직후, 같은 트랜잭션 안**이다(소급 발급 경로 부재).
      'insertAgentKeypair',
      'insertPassport',
      'insertAgentAddress',
      'insertAgentPolicy',
      // 정책 v2 — seed 가 발신 allow 규칙 1행. **버전보다 먼저** — 스냅샷이 그 행(id 포함)을 싣는다.
      'insertContactRule',
      'insertPolicyVersion',
      // seed contact 1명(픽스처)당 seed 관계 1행(AC-a2).
      'insertSeedRelationship',
      'insertAgentToken',
      // **마지막이다.** 앞이 하나라도 빠지면 에이전트는 활성화되지 않는다.
      'activateAgent',
      'withTransaction:commit',
    ]);
  });

  it('agentId 는 트랜잭션 안에서 태어나고 `agents.id` 가 된다 (§4B.1)', async () => {
    const { store, calls } = createFakeStore();
    const result = await provisionAgent(store, provisionRequest(), testKeyCustody());

    expect(result.agent.id).toMatch(AGENT_ID_PATTERN);
    expect(calls.agents[0]?.id).toBe(result.agent.id);
    // 주소·정책·버전·토큰이 전부 같은 agentId 를 참조한다 — 별도 내부 PK 가 없다.
    expect(calls.addresses[0]?.agentId).toBe(result.agent.id);
    expect(calls.policies[0]?.agentId).toBe(result.agent.id);
    expect(calls.policyVersions[0]?.agentId).toBe(result.agent.id);
    expect(calls.tokens[0]?.agentId).toBe(result.agent.id);
    expect(calls.activated).toEqual([result.agent.id]);
    // 반환되는 에이전트는 활성화 후 상태다.
    expect(result.agent.status).toBe('active');
    // PP-A 도 같은 값을 쓴다(AC-13 의 "동일성").
    expect(calls.keypairs[0]?.agentId).toBe(result.agent.id);
    expect(calls.passports[0]?.agentId).toBe(result.agent.id);
    expect(calls.passports[0]?.did).toBe(`did:web:id.atmark.ai:agents:${result.agent.id}`);
  });

  it('PP-A — ed25519 keypair 와 draft passport 가 같은 트랜잭션에서 붙는다 (§4B.1)', async () => {
    const { store, calls } = createFakeStore();
    await provisionAgent(store, provisionRequest(), testKeyCustody());

    expect(calls.keypairs).toHaveLength(1);
    expect(calls.keypairs[0]?.algorithm).toBe('ed25519');
    // 원시 32바이트의 base64url = JWK 의 x. 43자 무패딩이 그 사실의 관측 가능한 형태다.
    expect(calls.keypairs[0]?.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // **DB 로 가는 것은 참조뿐이다.** 개인키도 암호문도 아니다 (§3.5 AC-e1).
    expect(calls.keypairs[0]?.keyRef).toMatch(/^devfile:\/\//);

    expect(calls.passports).toHaveLength(1);
    expect(calls.passports[0]?.controller).toBe('did:web:id.atmark.ai');
    expect(calls.passports[0]?.version).toBe(1);
  });

  it('`ProvisionedAgent` 는 passport 를 내보내지 않는다 (B5 — draft DID 는 어떤 외부 표면에도 직렬화하지 않는다)', async () => {
    const { store } = createFakeStore();
    const result = await provisionAgent(store, provisionRequest(), testKeyCustody());

    expect(Object.keys(result).sort()).toEqual([
      'address',
      'agent',
      'organization',
      'policy',
      'policyVersion',
      'token',
    ]);
    expect(JSON.stringify(result)).not.toContain('did:web:');
  });

  it('프로비저닝마다 새 agentId 다', async () => {
    const first = await provisionAgent(createFakeStore().store, provisionRequest(), testKeyCustody());
    const second = await provisionAgent(createFakeStore().store, provisionRequest(), testKeyCustody());
    expect(first.agent.id).not.toBe(second.agent.id);
  });

  it('주소는 `{name}@atmark.ai` 이고 primary 다', async () => {
    const { store, calls } = createFakeStore();
    const result = await provisionAgent(store, provisionRequest({ addressLocalPart: 'Sales.Bot' }), testKeyCustody());
    expect(result.address.address).toBe('sales.bot@atmark.ai');
    expect(result.address.domain).toBe('atmark.ai');
    expect(calls.addresses[0]?.isPrimary).toBe(true);
  });

  it('조직이 없으면 같은 트랜잭션에서 만든다', async () => {
    const { store, calls } = createFakeStore();
    await provisionAgent(store, provisionRequest({ organization: { kind: 'create', name: 'Atmark', ownerEmail: 'owner@example.com' } }), testKeyCustody());
    expect(calls.order[1]).toBe('insertOrganization');
    expect(calls.order).not.toContain('findOrganization');
  });

  it('기존 조직을 쓰면 새로 만들지 않는다', async () => {
    const { store, calls } = createFakeStore();
    const result = await provisionAgent(store, provisionRequest(), testKeyCustody());
    expect(result.organization.id).toBe(EXISTING_ORG_ID);
    expect(calls.order).not.toContain('insertOrganization');
  });
});

describe('provisionAgent — 정책', () => {
  it('seed contacts 가 그대로 **발신 allow 목록**이 된다 (§3.1 층 2 · 정책 v2)', async () => {
    const { store, calls } = createFakeStore();
    await provisionAgent(
      store,
      provisionRequest({ seedContacts: ['  Jinyounkyum+x@Gmail.com  ', 'partner@example.com'] }),
      testKeyCustody(),
    );
    // 허용 비교형(소문자, `+tag` 보존) — 소유자가 적은 주소 그대로다(V1 MINOR-2).
    expect(calls.contactRules.map((rule) => [rule.direction, rule.list, rule.kind, rule.value])).toEqual([
      ['outbound', 'allow', 'address', 'jinyounkyum+x@gmail.com'],
      ['outbound', 'allow', 'address', 'partner@example.com'],
    ]);
    // 목록은 config_json 에 없다(202609241010 이 옮겼다).
    expect(calls.policies[0]?.configJson).not.toHaveProperty('allowlist');
  });

  it('`policy-loader` 가 요구하는 jsonb 형태를 전부 채운다', async () => {
    const { store, calls } = createFakeStore();
    await provisionAgent(store, provisionRequest(), testKeyCustody());

    // 하나라도 빠지면 첫 평가에서 `PolicyShapeError` → `evaluation_error` 로 끝난다.
    expect(calls.policies[0]?.limits).toEqual({ ...DEFAULT_POLICY_LIMITS });
    expect(calls.policies[0]?.configJson).toEqual({
      max_attachment_bytes_total: DEFAULT_MAX_ATTACHMENT_BYTES_TOTAL,
      allowed_mime_types: [...DEFAULT_ALLOWED_MIME_TYPES],
    });
  });

  it('policy_versions 는 version 1 에 정책 전문 스냅샷을 담는다 (§4.3)', async () => {
    const { store, calls } = createFakeStore();
    await provisionAgent(store, provisionRequest(), testKeyCustody());
    const version = calls.policyVersions[0];

    expect(version?.version).toBe(INITIAL_POLICY_VERSION);
    expect(version?.createdBy).toBe('owner_provisioning');
    // 정책 v2 — 스냅샷이 수신 모드와 **목록 전문**(규칙 id 포함)을 싣는다(AC-9 "왜 나갔나").
    expect(version?.snapshot).toEqual({
      outbound_mode: DEFAULT_OUTBOUND_MODE,
      inbound_mode: 'all',
      limits: calls.policies[0]?.limits,
      config_json: calls.policies[0]?.configJson,
      contact_rules: [
        {
          id: '44444444-4444-4444-8444-000000000001',
          direction: 'outbound',
          list: 'allow',
          kind: 'address',
          value: 'jinyounkyum@gmail.com',
        },
      ],
    });
  });

  it('AC-a1(정책 v2 재정의, ADR-0007) — 기본은 발신 `allowlist_only` · 수신 `all` 이다', async () => {
    const { store, calls } = createFakeStore();
    await provisionAgent(store, provisionRequest(), testKeyCustody());
    // 정책 행과 스냅샷이 **같은 값**을 받는다.
    expect(calls.policyVersions[0]?.snapshot['outbound_mode']).toBe('allowlist_only');
    expect(calls.policies[0]?.outboundMode).toBe('allowlist_only');
    expect(calls.policyVersions[0]?.snapshot['inbound_mode']).toBe('all');
    expect(calls.policies[0]?.inboundMode).toBe('all');
  });

  it.each(['allowlist_only', 'approval_required'] as const)(
    '모드 %s 를 명시하면 그 값이 정책 행과 스냅샷 **둘 다**에 간다(레거시 승인 모드도 — 데모가 승인 장면을 만든다)',
    async (mode) => {
      const { store, calls } = createFakeStore();
      await provisionAgent(store, provisionRequest({ outboundMode: mode }), testKeyCustody());
      expect(calls.policies[0]?.outboundMode).toBe(mode);
      expect(calls.policyVersions[0]?.snapshot['outbound_mode']).toBe(mode);
    },
  );

  it('AC-a2 전제 — seed contact 마다 seed 관계가 **같은 트랜잭션에서** 1행씩 생긴다', async () => {
    const { store, calls } = createFakeStore();
    await provisionAgent(
      store,
      provisionRequest({ seedContacts: ['  Partner+tag@Example.com ', 'partner@example.com', 'b@x.io'] }),
      testKeyCustody(),
    );
    // 정규화·중복 제거 뒤의 값이다 — 로더가 허용 판정에 쓰는 키(소문자, `+tag` 보존)와 같은 모양이어야 매칭된다.
    expect(calls.seedRelationships.map((row) => row.address)).toEqual(['partner+tag@example.com', 'partner@example.com', 'b@x.io']);
    const begin = calls.order.indexOf('withTransaction:begin');
    const commit = calls.order.indexOf('withTransaction:commit');
    const seeds = calls.order.flatMap((step, index) => (step === 'insertSeedRelationship' ? [index] : []));
    expect(seeds.length).toBe(3);
    expect(seeds.every((index) => index > begin && index < commit)).toBe(true);
  });

  it('기본 수신자 상한은 절대 천장(50)보다 낮다', () => {
    expect(DEFAULT_POLICY_LIMITS.recipients_per_message).toBeLessThan(50);
  });
});

describe('provisionAgent — 토큰', () => {
  it('저장소에는 해시만 넘어가고 평문은 1회 반환된다', async () => {
    const { store, calls } = createFakeStore();
    const result = await provisionAgent(store, provisionRequest(), testKeyCustody());

    expect(calls.tokens[0]?.tokenHash).toBe(hashAgentToken(result.token.plaintext));
    expect(JSON.stringify(calls.tokens[0])).not.toContain(result.token.plaintext);
    expect(result.token.plaintext.startsWith('atk_agent_')).toBe(true);
  });

  it('기본 권한으로 발급한다', async () => {
    const { store, calls } = createFakeStore();
    await provisionAgent(store, provisionRequest(), testKeyCustody());
    // 기본 권한 = 넷 — `webhooks:manage` 는 기본에 없다(2026-09-30, 소유자가 골라 준다).
    expect(calls.tokens[0]?.capabilities).toEqual([...DEFAULT_AGENT_TOKEN_CAPABILITIES]);
    expect(calls.tokens[0]?.capabilities).not.toContain('webhooks:manage');
  });

  it('권한을 좁혀서 발급할 수 있다', async () => {
    const { store, calls } = createFakeStore();
    await provisionAgent(store, provisionRequest({ tokenCapabilities: ['messages:read'] }), testKeyCustody());
    expect(calls.tokens[0]?.capabilities).toEqual(['messages:read']);
  });
});

describe('provisionAgent — 원자성 (§4B.1)', () => {
  const points: readonly FailurePoint[] = [
    'insertAgent',
    'insertAgentKeypair',
    'insertPassport',
    'insertAgentAddress',
    'insertAgentPolicy',
    'insertPolicyVersion',
    'insertSeedRelationship',
    'insertAgentToken',
    'activateAgent',
  ];

  it.each(points)('%s 이 실패하면 롤백되고 이후 삽입은 일어나지 않는다', async (point) => {
    const { store, calls } = createFakeStore(point);

    await expect(provisionAgent(store, provisionRequest(), testKeyCustody())).rejects.toThrow(`injected failure at ${point}`);

    expect(calls.rolledBack).toBe(true);
    expect(calls.order.at(-1)).toBe('withTransaction:rollback');
    // 실패 지점이 마지막으로 시도된 연산이다 — 그 뒤로 아무것도 진행되지 않았다.
    expect(calls.order.at(-2)).toBe(point);
  });

  it('활성화 실패 시 에이전트는 active 가 되지 않는다 (fail closed 이중화 — Stage 0 이 비활성을 전건 DENY)', async () => {
    const { store, calls } = createFakeStore('activateAgent');
    await expect(provisionAgent(store, provisionRequest(), testKeyCustody())).rejects.toThrow();
    expect(calls.activated).toEqual([]);
  });
});

describe('provisionAgent — 입력 검증은 트랜잭션 밖에서 끝난다', () => {
  it.each([
    ['빈 이름', provisionRequest({ agentName: '   ' }), ProvisioningError],
    ['이름 길이 초과', provisionRequest({ agentName: 'a'.repeat(201) }), ProvisioningError],
    ['예산이 음수', provisionRequest({ monthlyBudgetCents: -1 }), ProvisioningError],
    ['예산이 소수', provisionRequest({ monthlyBudgetCents: 1.5 }), ProvisioningError],
    ['로컬파트 위반', provisionRequest({ addressLocalPart: 'bad!' }), AgentAddressError],
    ['seed contact 형식 위반', provisionRequest({ seedContacts: ['nope'] }), SeedContactError],
  ])('%s 은 트랜잭션을 열지 않고 던진다', async (_label, request, errorType) => {
    const { store, calls } = createFakeStore();
    await expect(provisionAgent(store, request, testKeyCustody())).rejects.toThrow(errorType);
    expect(calls.order).toEqual([]);
  });

  it.each(['assistant@atmark.ai', 'Assistant+loop@atmark.ai'])(
    'seed contact 에 자기 주소(%s — `+tag` 변형 포함, 거부 쪽은 넓게)를 넣을 수 없다 (자기 자신에게 보내는 루프)',
    async (seed) => {
      const { store, calls } = createFakeStore();
      await expect(
        provisionAgent(store, provisionRequest({ addressLocalPart: 'assistant', seedContacts: [seed] }), testKeyCustody()),
      ).rejects.toThrow(ProvisioningError);
      expect(calls.order).toEqual([]);
    },
  );

  it('없는 조직은 트랜잭션 안에서 거부된다 — FK 앞에서 끊어 원인을 말한다', async () => {
    const { store, calls } = createFakeStore();
    await expect(
      provisionAgent(store, provisionRequest({ organization: { kind: 'existing', id: 'missing' } }), testKeyCustody()),
    ).rejects.toThrow(ProvisioningError);
    expect(calls.rolledBack).toBe(true);
    expect(calls.agents).toEqual([]);
  });
});

describe('소유자 이메일 (P2 — 승인 알림의 유일한 수신자)', () => {
  it('trim + 소문자로 정규화한다', () => {
    expect(resolveOwnerEmail('  Owner+Ops@Example.COM ')).toBe('owner+ops@example.com');
  });

  it.each([
    ['에이전트 도메인 — 에이전트가 자기 승인 링크를 받는다', 'boss@atmark.ai'],
    ['에이전트 하위 도메인', 'boss@mail.atmark.ai'],
    ['CRLF — To 헤더 인젝션', 'owner@example.com\r\nBcc: x@y.com'],
    ['두 주소', 'a@example.com,b@example.com'],
    ['표시 이름', 'Owner <owner@example.com>'],
    ['도메인 점 없음', 'owner@localhost'],
    ['빈 값', '   '],
  ])('%s 은 거부한다', (_label, raw) => {
    expect(() => resolveOwnerEmail(raw)).toThrow(ProvisioningError);
  });

  it('조직을 새로 만들 때 형식이 틀리면 트랜잭션을 열기 전에 던진다', async () => {
    const { store, calls } = createFakeStore();
    await expect(
      provisionAgent(
        store,
        provisionRequest({ organization: { kind: 'create', name: 'Atmark', ownerEmail: 'boss@atmark.ai' } }),
        testKeyCustody(),
      ),
    ).rejects.toThrow(ProvisioningError);
    expect(calls.order).toEqual([]);
  });
});
