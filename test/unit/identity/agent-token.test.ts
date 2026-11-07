/** agent-scoped API 토큰(`atk_agent_*`, 계획 §47) — 절반은 "무엇이 불가능한가" 의 부정 단언이다. */

import { describe, expect, it } from 'vitest';
import { toAgentId } from '../../../src/db/schema';
import {
  AGENT_TOKEN_CAPABILITIES,
  AGENT_TOKEN_HINT_LENGTH,
  AGENT_TOKEN_PREFIX,
  AGENT_TOKEN_SECRET_BYTES,
  authenticateAgentToken,
  authorizeAgentToken,
  CAPABILITY_PRIVILEGE_SEPARATION,
  DEFAULT_AGENT_TOKEN_CAPABILITIES,
  ENROLLED_AGENT_TOKEN_CAPABILITIES,
  agentTokenHint,
  FORBIDDEN_TO_AGENT_TOKENS,
  effectiveAgentTokenCapabilities,
  hashAgentToken,
  impliedAgentTokenCapabilities,
  issueAgentToken,
  LEGACY_POLICY_REQUEST_CUTOFF,
  type AgentPrincipal,
  type AgentTokenRecord,
  type AgentTokenStore,
} from '../../../src/identity/agent-token';
import { OTHER_AGENT_ID } from './fixtures';

const SELF = toAgentId('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
const NOW = new Date('2026-09-22T12:00:00Z');

function storeOf(record: AgentTokenRecord | null): AgentTokenStore {
  return { findByHash: (hash) => Promise.resolve(record !== null && record.tokenHash === hash ? record : null) };
}

function recordFor(
  tokenHash: string,
  overrides: Partial<AgentTokenRecord> = {},
): AgentTokenRecord {
  return {
    tokenHash,
    agentId: SELF,
    capabilities: [...AGENT_TOKEN_CAPABILITIES],
    revokedAt: null,
    expiresAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 권한 경계 — §47
// ---------------------------------------------------------------------------

describe('권한 경계 (§47)', () => {
  it('토큰 권한과 금지 행위의 교집합은 공집합이다', () => {
    const capabilities = new Set<string>(AGENT_TOKEN_CAPABILITIES);
    const overlap = FORBIDDEN_TO_AGENT_TOKENS.filter((action) => capabilities.has(action));
    expect(overlap).toEqual([]);
    // 컴파일 시점 단언이 실제로 평가됐음을 런타임에서도 확인한다.
    expect(CAPABILITY_PRIVILEGE_SEPARATION).toBe(true);
  });

  it.each([
    ['다른 에이전트 생성', 'agents:create'],
    ['과금 변경', 'billing:write'],
    ['정책 변경', 'policy:write'],
    ['조직 API 키 열람', 'org_api_keys:read'],
    ['자기 예산 상향', 'budget:write'],
  ])('%s 은 토큰 권한 유니온에 존재하지 않는다', (_label, action) => {
    expect([...AGENT_TOKEN_CAPABILITIES]).not.toContain(action);
    expect([...FORBIDDEN_TO_AGENT_TOKENS]).toContain(action);
  });

  // `agents:enroll` 은 `agents:create`(금지 — 조직 키의 권한)보다 좁은 권한이고, 기본 권한·자가 등록 토큰 어디에도 없다(연쇄 금지 — DB 트리거도).
  it('agents:enroll — agents:create 와 다른 이름 · 기본 권한에 없음 · 자가 등록 토큰에 없음', () => {
    expect([...AGENT_TOKEN_CAPABILITIES]).toContain('agents:enroll');
    expect([...AGENT_TOKEN_CAPABILITIES]).not.toContain('agents:create');
    expect([...FORBIDDEN_TO_AGENT_TOKENS]).toContain('agents:create');
    expect([...DEFAULT_AGENT_TOKEN_CAPABILITIES]).not.toContain('agents:enroll');
    expect([...ENROLLED_AGENT_TOKEN_CAPABILITIES].sort()).toEqual(['agent:read_self', 'messages:read', 'messages:send']);
  });

  it('모든 권한이 self-scope 다 — 다른 에이전트를 지칭할 이름이 없다', () => {
    for (const capability of AGENT_TOKEN_CAPABILITIES) {
      expect(capability).not.toMatch(/other|any|all|org/);
    }
  });
});

// ---------------------------------------------------------------------------
// 발급 · 해시
// ---------------------------------------------------------------------------

describe('issueAgentToken', () => {
  it('`atk_agent_` 접두사 + base64url 43자를 만든다', () => {
    const issued = issueAgentToken(SELF);
    expect(issued.plaintext.startsWith(AGENT_TOKEN_PREFIX)).toBe(true);
    const secret = issued.plaintext.slice(AGENT_TOKEN_PREFIX.length);
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // 32바이트 → base64url 43자(패딩 없음).
    expect(Buffer.from(secret, 'base64url')).toHaveLength(AGENT_TOKEN_SECRET_BYTES);
  });

  it('끝 4자(hint) = 평문의 끝 4자 · 비밀부의 일부일 뿐 전체가 아니다 · 형식이 아니면 만들지 않는다(콘솔 v4)', () => {
    const issued = issueAgentToken(SELF);
    expect(AGENT_TOKEN_HINT_LENGTH).toBe(4);
    expect(issued.hint).toBe(issued.plaintext.slice(-4));
    expect(issued.hint).toMatch(/^[A-Za-z0-9_-]{4}$/);
    expect(agentTokenHint(issued.plaintext)).toBe(issued.hint);
    for (const bad of ['', 'atk_agent_short', `atk_admin_${'a'.repeat(43)}`, `${issued.plaintext}x`]) {
      expect(() => agentTokenHint(bad), bad).toThrow(TypeError);
    }
  });

  it('해시는 평문의 sha256 hex 이고 평문이 섞여 있지 않다', () => {
    const issued = issueAgentToken(SELF);
    expect(issued.tokenHash).toBe(hashAgentToken(issued.plaintext));
    expect(issued.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(issued.tokenHash).not.toContain(issued.plaintext.slice(AGENT_TOKEN_PREFIX.length));
  });

  it('호출마다 다른 평문이다', () => {
    const tokens = new Set(Array.from({ length: 64 }, () => issueAgentToken(SELF).plaintext));
    expect(tokens.size).toBe(64);
  });

  it('권한을 좁혀서 발급할 수 있다', () => {
    expect(issueAgentToken(SELF, ['messages:read']).capabilities).toEqual(['messages:read']);
  });
});

// ---------------------------------------------------------------------------
// 인증
// ---------------------------------------------------------------------------

describe('authenticateAgentToken', () => {
  it('유효한 토큰은 자기 에이전트의 principal 이 된다(touch 없는 저장소도)', async () => {
    const issued = issueAgentToken(SELF);
    const result = await authenticateAgentToken(storeOf(recordFor(issued.tokenHash)), issued.plaintext, NOW);
    expect(result).toEqual({
      kind: 'authenticated',
      principal: { agentId: SELF, capabilities: [...AGENT_TOKEN_CAPABILITIES] },
    });
  });

  it.each([
    ['접두사 없음', 'deadbeef'],
    ['조직 키 접두사', 'atk_org_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['길이 부족', `${AGENT_TOKEN_PREFIX}short`],
    ['base64url 밖 문자', `${AGENT_TOKEN_PREFIX}${'+'.repeat(43)}`],
    ['빈 문자열', ''],
  ])('%s 은 저장소에 닿기 전에 거부된다', async (_label, presented) => {
    let touched = false;
    const store: AgentTokenStore = {
      findByHash: () => {
        touched = true;
        return Promise.resolve(null);
      },
    };
    const result = await authenticateAgentToken(store, presented, NOW);
    expect(result).toEqual({ kind: 'rejected', reason: 'malformed_token' });
    expect(touched).toBe(false);
  });

  it.each([
    ['형식은 맞지만 없는 토큰', null, 'unknown_token'],
    ['폐기된 토큰', { revokedAt: new Date('2026-09-21T00:00:00Z') }, 'token_revoked'],
    ['만료 시각 정각(경계)', { expiresAt: NOW }, 'token_expired'],
  ] as const)('%s → %s', async (_label, overrides, reason) => {
    const issued = issueAgentToken(SELF);
    const record = overrides === null ? null : recordFor(issued.tokenHash, overrides);
    const result = await authenticateAgentToken(storeOf(record), issued.plaintext, NOW);
    expect(result).toEqual({ kind: 'rejected', reason });
  });

  it('만료 전이면 통과한다', async () => {
    const issued = issueAgentToken(SELF);
    const record = recordFor(issued.tokenHash, { expiresAt: new Date('2026-09-22T12:00:01Z') });
    const result = await authenticateAgentToken(storeOf(record), issued.plaintext, NOW);
    expect(result.kind).toBe('authenticated');
  });
});

// ---------------------------------------------------------------------------
// touch — 마지막 사용 시각 (US-007)
// ---------------------------------------------------------------------------

describe('authenticateAgentToken — touch', () => {
  it('인증 성공이면 store.touch 를 그 토큰 해시·시계로 정확히 한 번 부른다', async () => {
    const issued = issueAgentToken(SELF);
    const record = recordFor(issued.tokenHash);
    const calls: Array<{ tokenHash: string; now: Date }> = [];
    const store: AgentTokenStore = {
      findByHash: () => Promise.resolve(record),
      touch: (tokenHash, now) => {
        calls.push({ tokenHash, now });
        return Promise.resolve();
      },
    };

    const result = await authenticateAgentToken(store, issued.plaintext, NOW);

    expect(result.kind).toBe('authenticated');
    expect(calls).toEqual([{ tokenHash: issued.tokenHash, now: NOW }]);
  });

  it.each([
    ['폐기된 토큰', recordFor('h', { revokedAt: new Date('2026-09-21T00:00:00Z') })],
    ['만료된 토큰', recordFor('h', { expiresAt: NOW })],
    ['알 수 없는 토큰', null],
  ])('%s 은 인증이 거부되므로 touch 를 부르지 않는다', async (_label, record) => {
    const issued = issueAgentToken(SELF);
    let touched = false;
    const store: AgentTokenStore = {
      findByHash: () => Promise.resolve(record === null ? null : { ...record, tokenHash: issued.tokenHash }),
      touch: () => {
        touched = true;
        return Promise.resolve();
      },
    };

    const result = await authenticateAgentToken(store, issued.plaintext, NOW);

    expect(result.kind).toBe('rejected');
    expect(touched).toBe(false);
  });

  it('touch 가 실패해도 인증 결과는 바뀌지 않는다 — 삼킨다', async () => {
    const issued = issueAgentToken(SELF);
    const record = recordFor(issued.tokenHash);
    const store: AgentTokenStore = {
      findByHash: () => Promise.resolve(record),
      touch: () => Promise.reject(new Error('연결 끊김')),
    };

    const result = await authenticateAgentToken(store, issued.plaintext, NOW);

    expect(result).toEqual({
      kind: 'authenticated',
      principal: { agentId: SELF, capabilities: [...AGENT_TOKEN_CAPABILITIES] },
    });
  });
});

// ---------------------------------------------------------------------------
// 인가
// ---------------------------------------------------------------------------

describe('authorizeAgentToken', () => {
  const principal: AgentPrincipal = { agentId: SELF, capabilities: ['messages:send', 'audit:read'] };

  it('자기 에이전트 + 보유 권한이면 허용', () => {
    expect(authorizeAgentToken(principal, 'messages:send', SELF)).toEqual({ kind: 'authorized' });
  });

  it('다른 에이전트를 대상으로 하면 권한이 있어도 거부 — 소유 검사가 먼저다', () => {
    expect(authorizeAgentToken(principal, 'messages:send', OTHER_AGENT_ID)).toEqual({
      kind: 'denied',
      reason: 'not_own_agent',
    });
  });

  it('보유하지 않은 권한은 자기 에이전트라도 거부', () => {
    expect(authorizeAgentToken(principal, 'messages:read', SELF)).toEqual({
      kind: 'denied',
      reason: 'capability_not_granted',
    });
  });

  it('권한이 비어 있으면 자기 것에도 아무것도 못 한다 (fail closed)', () => {
    const empty: AgentPrincipal = { agentId: SELF, capabilities: [] };
    for (const capability of AGENT_TOKEN_CAPABILITIES) {
      expect(authorizeAgentToken(empty, capability, SELF).kind).toBe('denied');
    }
  });
});

// ---------------------------------------------------------------------------
// 함의 권한 — 기본값 이전 토큰의 policy:request(2026-10-13 "기존 토큰에도 추가")
// ---------------------------------------------------------------------------

describe('impliedAgentTokenCapabilities — 기본값 이전 토큰의 policy:request', () => {
  const OLD_DEFAULT = ['messages:send', 'messages:read', 'audit:read', 'agent:read_self'] as const;
  const BEFORE = new Date(LEGACY_POLICY_REQUEST_CUTOFF.getTime() - 1000);

  it('경계는 2026-10-13T03:10:00Z 다(SQL 함수 202610131400 과 같은 값)', () => {
    expect(LEGACY_POLICY_REQUEST_CUTOFF.toISOString()).toBe('2026-10-13T03:10:00.000Z');
  });

  it('경계 이전 · 자가 등록 아님 · 옛 기본 권한 → policy:request 함의', () => {
    expect(impliedAgentTokenCapabilities({ capabilities: OLD_DEFAULT, issuedAt: BEFORE, selfEnrolledAgent: false, operatorReservedAgent: false })).toEqual(['policy:request']);
    expect(effectiveAgentTokenCapabilities({ capabilities: OLD_DEFAULT, issuedAt: BEFORE, selfEnrolledAgent: false, operatorReservedAgent: false })).toEqual([...OLD_DEFAULT, 'policy:request']);
  });

  it.each([
    ['경계 정각(이후로 친다)', { issuedAt: LEGACY_POLICY_REQUEST_CUTOFF, selfEnrolledAgent: false, operatorReservedAgent: false, capabilities: OLD_DEFAULT }],
    ['경계 뒤', { issuedAt: new Date('2026-10-14T00:00:00Z'), selfEnrolledAgent: false, operatorReservedAgent: false, capabilities: OLD_DEFAULT }],
    ['자가 등록 에이전트', { issuedAt: BEFORE, selfEnrolledAgent: true, capabilities: OLD_DEFAULT }],
    ['자가 등록 권한 세트 + 자가 등록 에이전트', { issuedAt: BEFORE, selfEnrolledAgent: true, capabilities: ENROLLED_AGENT_TOKEN_CAPABILITIES }],
    ['발급 시각 모름(fail-closed)', { selfEnrolledAgent: false, operatorReservedAgent: false, capabilities: OLD_DEFAULT }],
    ['자가 등록 여부 모름(fail-closed)', { issuedAt: BEFORE, operatorReservedAgent: false, capabilities: OLD_DEFAULT }],
    ['운영자 예약 주소 에이전트(보안 감사 M-1)', { issuedAt: BEFORE, selfEnrolledAgent: false, operatorReservedAgent: true, capabilities: OLD_DEFAULT }],
    ['예약 주소 여부 모름(fail-closed)', { issuedAt: BEFORE, selfEnrolledAgent: false, capabilities: OLD_DEFAULT }],
    ['agent:read_self 없음', { issuedAt: BEFORE, selfEnrolledAgent: false, operatorReservedAgent: false, capabilities: ['messages:send', 'messages:read'] }],
    ['메일 권한 없음(웹훅 · 감사 전용)', { issuedAt: BEFORE, selfEnrolledAgent: false, operatorReservedAgent: false, capabilities: ['agent:read_self', 'webhooks:manage', 'audit:read'] }],
    ['이미 열에 있음(중복 없음)', { issuedAt: BEFORE, selfEnrolledAgent: false, operatorReservedAgent: false, capabilities: [...OLD_DEFAULT, 'policy:request'] }],
  ] as const)('%s → 함의 없음', (_label, facts) => {
    expect(impliedAgentTokenCapabilities(facts)).toEqual([]);
  });

  it('읽기 전용(messages:read + agent:read_self)도 함의된다', () => {
    expect(impliedAgentTokenCapabilities({ capabilities: ['messages:read', 'agent:read_self'], issuedAt: BEFORE, selfEnrolledAgent: false, operatorReservedAgent: false })).toEqual(['policy:request']);
  });

  it('함의는 금지 목록과 겹치지 않는다', () => {
    for (const forbidden of FORBIDDEN_TO_AGENT_TOKENS) {
      expect(effectiveAgentTokenCapabilities({ capabilities: [...AGENT_TOKEN_CAPABILITIES], issuedAt: BEFORE, selfEnrolledAgent: false, operatorReservedAgent: false })).not.toContain(forbidden);
    }
  });

  it('authenticateAgentToken 은 유효 권한을 principal 에 싣는다 — 레코드의 열은 그대로', async () => {
    const issued = issueAgentToken(SELF, OLD_DEFAULT);
    const record = recordFor(issued.tokenHash, { capabilities: OLD_DEFAULT, issuedAt: BEFORE, selfEnrolledAgent: false, operatorReservedAgent: false });
    const result = await authenticateAgentToken(storeOf(record), issued.plaintext, NOW);
    expect(result.kind === 'authenticated' ? result.principal.capabilities : null).toEqual([...OLD_DEFAULT, 'policy:request']);
    expect(record.capabilities).toEqual(OLD_DEFAULT);
  });

  it('authenticateAgentToken — 자가 등록 에이전트의 옛 토큰은 함의 없음', async () => {
    const issued = issueAgentToken(SELF, ENROLLED_AGENT_TOKEN_CAPABILITIES);
    const record = recordFor(issued.tokenHash, { capabilities: ENROLLED_AGENT_TOKEN_CAPABILITIES, issuedAt: BEFORE, selfEnrolledAgent: true });
    const result = await authenticateAgentToken(storeOf(record), issued.plaintext, NOW);
    expect(result.kind === 'authenticated' ? result.principal.capabilities : null).toEqual([...ENROLLED_AGENT_TOKEN_CAPABILITIES]);
  });

  it('운영자 예약 주소 에이전트 — 열에 policy:request 가 있어도 유효 권한에서 빠진다(보안 감사 M-1)', async () => {
    const caps = [...OLD_DEFAULT, 'policy:request'] as const;
    expect(effectiveAgentTokenCapabilities({ capabilities: caps, issuedAt: NOW, selfEnrolledAgent: false, operatorReservedAgent: true })).toEqual([...OLD_DEFAULT]);
    // 모르면 열 그대로(DB 정의자가 따로 거부한다).
    expect(effectiveAgentTokenCapabilities({ capabilities: caps, issuedAt: NOW, selfEnrolledAgent: false })).toEqual(caps);
    const issued = issueAgentToken(SELF, caps);
    const record = recordFor(issued.tokenHash, { capabilities: caps, issuedAt: NOW, selfEnrolledAgent: false, operatorReservedAgent: true });
    const result = await authenticateAgentToken(storeOf(record), issued.plaintext, NOW);
    expect(result.kind === 'authenticated' ? result.principal.capabilities : null).toEqual([...OLD_DEFAULT]);
  });
});
