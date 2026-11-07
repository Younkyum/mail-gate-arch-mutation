#!/usr/bin/env tsx
/**
 * scripts/admin/agent-token.ts — `pnpm admin:agent-token --agent <agentId> [--expires <N>d | YYYY-MM-DD]
 *   [--capabilities messages:send,messages:read,...] [--yes]`
 *
 * 에이전트 토큰을 하나 더 발급한다(분실·교체). 발급 규칙은 `issueAgentToken`, 저장은 `createPostgresAgentTokenStore().insert`
 * — 둘 다 기존 코드다. **평문은 stdout 에 한 번 나가고 어디에도 저장되지 않는다** — `agent_api_keys` 에 평문 컬럼이 없다.
 *
 * **권한 기본값 = `DEFAULT_AGENT_TOKEN_CAPABILITIES`**(프로비저닝 토큰과 같은 집합). 전부 self-scope 이고 특권
 * (`FORBIDDEN_TO_AGENT_TOKENS` — 에이전트 생성·정책·예산 쓰기)은 이 유니온에 표현조차 안 된다. 좁히려면 `--capabilities`.
 * **만료 기본값 = 없음**(프로비저닝 토큰과 같다). 한 에이전트의 토큰 둘이 서로 다른 만료 규칙을 가지면 어느 쪽이 먼저
 * 끊기는지 대표가 기억해야 한다 — 만료를 원하면 `--expires` 로 명시한다.
 *
 * **폐기**(리드 추가, 2026-09-23):
 *   `--revoke-all` — 이 에이전트의 살아 있는 토큰을 전부 폐기한다(`revoked_at`, 행은 지우지 않는다). 새 토큰 없음.
 *   `--rotate`     — 전부 폐기 + 새 토큰 1개 발급을 **한 트랜잭션**으로. 유출 대응의 기본형이다.
 * `admin:kill-switch` 는 토큰 유출의 대안이 **아니다** — 에이전트를 정지시켜도 다시 켜는 순간 유출된 토큰이 같이
 * 살아난다. 폐기는 평문이 필요 없다(에이전트 id 로 행을 찍는다). 이미 폐기된 행의 `revoked_at` 은 덮지 않는다 —
 * 그 시각은 "언제부터 무효였는가" 의 경계선이다(`agent-token-store.ts` 의 revoke 와 같은 규율).
 *
 * **발급·폐기는 `src/admin/ops/agents.ts`** — 관리 API(`POST /api/agents/{id}/token`)와 같은 함수다.
 */

import { parseArgs } from 'node:util';

import { issueAgentTokenOp, requireTokenableAgent, resolveCapabilities, revokeAgentTokensOp } from '../../src/admin/ops/agents';
import { isAgentId, type AgentId } from '../../src/db/schema';
import { AGENT_TOKEN_CAPABILITIES, type AgentTokenCapability } from '../../src/identity/agent-token';
import { AdminInputError, confirmProduction, EXIT_OK, isMain, runAdminMain, splitList, withAdminConnection, type AdminDeps } from './common';

const USAGE =
  'pnpm admin:agent-token --agent <agentId> [--rotate | --revoke-all] [--expires <N>d | YYYY-MM-DD] ' +
  `[--capabilities ${AGENT_TOKEN_CAPABILITIES.join(',')}] [--yes]`;

const DAY_MS = 86_400_000;

/** `30d` → 지금부터 30일, `2026-12-31` → 그날 00:00 KST. 과거는 거부. */
export function parseExpiry(raw: string | undefined, now: Date): Date | null {
  if (raw === undefined) return null;
  const days = /^(\d{1,4})d$/.exec(raw.trim());
  let at: Date;
  if (days !== null) {
    const count = Number(days[1]);
    if (count < 1) throw new AdminInputError('--expires 는 1d 이상', 'invalid_expiry');
    at = new Date(now.getTime() + count * DAY_MS);
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) {
    at = new Date(`${raw.trim()}T00:00:00+09:00`);
    if (Number.isNaN(at.getTime())) throw new AdminInputError(`--expires 날짜가 아니다: ${raw}`, 'invalid_expiry');
  } else {
    throw new AdminInputError(`--expires 는 <N>d 또는 YYYY-MM-DD: ${raw}`, 'invalid_expiry');
  }
  if (at.getTime() <= now.getTime()) throw new AdminInputError(`--expires 가 이미 지났다: ${raw}`, 'invalid_expiry');
  return at;
}

/** 쉼표 목록 → 공유 검증(`resolveCapabilities`). 규칙은 API 와 같다. */
/** `--capabilities` 를 안 주면 기본 권한 · 주었는데 비었으면(`--capabilities ""`·`,`) `invalid_capability`(`resolveCapabilities`). */
export function parseCapabilities(values: readonly string[] | undefined): readonly AgentTokenCapability[] {
  return resolveCapabilities(values === undefined ? undefined : splitList(values));
}

export async function agentToken(argv: readonly string[], deps: AdminDeps): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      agent: { type: 'string' },
      expires: { type: 'string' },
      capabilities: { type: 'string', multiple: true },
      rotate: { type: 'boolean', default: false },
      'revoke-all': { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (values.help) {
    deps.io.out(USAGE);
    return EXIT_OK;
  }
  const agentRaw = values.agent?.trim() ?? '';
  if (!isAgentId(agentRaw)) throw new AdminInputError(`--agent 는 에이전트 id(hex 32). ${USAGE}`);
  const agentId: AgentId = agentRaw;
  const revokeAll = values['revoke-all'];
  if (revokeAll && values.rotate) throw new AdminInputError('--rotate 와 --revoke-all 은 함께 쓸 수 없다(--rotate 가 폐기를 포함한다).');
  if (revokeAll && (values.expires !== undefined || values.capabilities !== undefined)) {
    throw new AdminInputError('--revoke-all 은 새 토큰을 만들지 않는다 — --expires·--capabilities 는 --rotate 와 쓴다.');
  }
  const capabilities = parseCapabilities(values.capabilities);
  const expiresAt = parseExpiry(values.expires, new Date());

  return withAdminConnection(deps, async ({ pool, target }) => {
    if (revokeAll || values.rotate) {
      const action = revokeAll ? '토큰 전부 폐기' : '토큰 전부 폐기 + 새 토큰 발급(교체)';
      const result = await revokeAgentTokensOp(pool, agentId, revokeAll ? 'revoke-all' : 'rotate', { capabilities, expiresAt }, () =>
        confirmProduction(target, `에이전트 ${agentId} ${action}`, values.yes, deps.io),
      );
      deps.io.err(`에이전트 ${agentId}: 살아 있던 토큰 ${String(result.revoked)}개 폐기.`);
      if (result.issued === null) {
        deps.io.err('새 토큰은 만들지 않았다 — 에이전트는 지금 인증할 수 없다. 교체하려면 --rotate.');
        return EXIT_OK;
      }
      deps.io.out(`token ${result.issued.token}`);
      deps.io.err(`새 토큰 — 권한 ${result.issued.capabilities.join(', ')} · 만료 ${expiresAt?.toISOString() ?? '없음'}`);
      deps.io.err('⚠ 지금 한 번만 보인다(DB 에는 sha256 만 남는다).');
      return EXIT_OK;
    }

    const status = await requireTokenableAgent(pool, agentId);
    await confirmProduction(target, `에이전트 ${agentId} 토큰 발급 (${capabilities.join(',')})`, values.yes, deps.io);
    const issued = await issueAgentTokenOp(pool, agentId, { capabilities, expiresAt });
    deps.io.out(`token ${issued.token}`);
    deps.io.err(`에이전트 ${agentId}(상태 ${status}) 토큰 — 권한 ${issued.capabilities.join(', ')} · 만료 ${expiresAt?.toISOString() ?? '없음'}`);
    deps.io.err('⚠ 지금 한 번만 보인다(DB 에는 sha256 만 남는다).');
    return EXIT_OK;
  });
}

if (isMain(import.meta.url)) await runAdminMain(agentToken);
