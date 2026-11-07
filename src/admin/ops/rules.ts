/**
 * src/admin/ops/rules.ts — 연락처 목록(`agent_contact_rules`, 정책 v2) 더하기·지우기. CLI `pnpm admin:rules` 와 관리 API
 * (`POST /api/agents/{id}/rules` · `DELETE /api/agents/{id}/rules/{ruleId}`)가 이 함수들을 부른다 — 같은 입력은 같은 코드로 거부된다.
 *
 * **목록 변경 = 새 정책 버전**(계약 v2 §1). 규칙 행 쓰기와 버전 추가는 한 트랜잭션이고, 정책 행 잠금(`lockPolicy` 의 `FOR UPDATE`)이
 * 같은 에이전트의 목록 변경을 직렬화한다 — 상한·중복 검사가 잠근 뒤의 상태를 본다. 스냅샷은 바꾼 **뒤의** 목록 전량을 싣는다.
 *
 * 가드:
 *   - 방향 `outbound|inbound`, 목록 `allow|block`, 값은 `contact-rules.ts` 모양(주소 또는 `example.com`·`*.example.com`) —
 *     `invalid_rule_direction` · `invalid_rule_list` · `invalid_rule_value`.
 *   - **발신 allow 에 atmark.ai 도메인 규칙 금지**(`rule_platform_domain` — `atmark.ai`·`*.atmark.ai`·`x.atmark.ai`, 202609241040).
 *     한 줄이 플랫폼의 모든 에이전트를 연다. 다른 에이전트는 정확한 주소로만. (관문도 그런 행을 버린다 — `resolveOutboundRules`.)
 *   - 값 모양은 dot-atom 주소 또는 도메인 — 따옴표 로컬파트·끝 점 도메인은 `invalid_rule_value`(202609241040 — 검증 M2).
 *   - **발신 allow 에 에이전트 자기 주소 금지**(`rule_self_address`) — 스스로에게 보내는 루프가 정책상 열린다(프로비저닝 seed 와
 *     같은 거부). 판정형(`+tag` 절단)으로 넓게 본다.
 *   - 중복 409 `rule_duplicate` · 상한(방향·목록당 1000) 409 `rule_limit`.
 *   - 지우기: 이 에이전트의 **살아 있는** 규칙이 아니면(없음·이미 지움·다른 에이전트·모양 틀린 id) 404 `rule_not_found` — 구별하지 않는다.
 *     지우기는 **표시**다(`removed_at`·`removed_by` — 202609241020). admin 롤은 DELETE 가 없다(ADR-0006) — 행은 남아 "누가 언제 뺐나" 에 답한다.
 */

import type { Pool } from 'pg';

import { withTransaction } from '../../db/client';
import {
  CONTACT_RULE_DIRECTIONS,
  CONTACT_RULE_LISTS,
  MAX_CONTACT_RULES_PER_LIST,
  toAgentId,
  type AgentId,
  type ContactRuleDirection,
  type ContactRuleKind,
  type ContactRuleList,
  type ContactRuleRow,
} from '../../db/schema';
import { contactRuleKindOf, isPlatformDomainRule, normalizeContactRuleValue } from '../../policy/contact-rules';
import { normalizeAddress } from '../../policy/policy-loader';
import { AdminInputError, notFound, UUID_PATTERN } from './errors';
import { appendPolicyVersion, lockPolicy, policyViewOf, type PolicyView } from './policy';

interface ContactRuleInput {
  readonly direction: ContactRuleDirection;
  readonly list: ContactRuleList;
  readonly kind: ContactRuleKind;
  /** 저장형(소문자·trim). */
  readonly value: string;
}

/** 사람의 입력 → 규칙. 모양이 틀리면 코드와 함께 거부한다(두 표면 같은 코드). */
export function resolveContactRuleInput(raw: { readonly direction: unknown; readonly list: unknown; readonly value: unknown }): ContactRuleInput {
  if (typeof raw.direction !== 'string' || !(CONTACT_RULE_DIRECTIONS as readonly string[]).includes(raw.direction)) {
    throw new AdminInputError(`direction 은 ${CONTACT_RULE_DIRECTIONS.join(' | ')}: ${String(raw.direction)}`, 'invalid_rule_direction');
  }
  if (typeof raw.list !== 'string' || !(CONTACT_RULE_LISTS as readonly string[]).includes(raw.list)) {
    throw new AdminInputError(`list 는 ${CONTACT_RULE_LISTS.join(' | ')}: ${String(raw.list)}`, 'invalid_rule_list');
  }
  if (typeof raw.value !== 'string') throw new AdminInputError('value 는 문자열이다.', 'invalid_rule_value');
  const value = normalizeContactRuleValue(raw.value);
  const kind = contactRuleKindOf(value);
  if (kind === null) {
    throw new AdminInputError(
      '값은 이메일 주소(a@example.com) 또는 도메인(example.com — 하위 도메인은 *.example.com)이어야 한다(ASCII 만).',
      'invalid_rule_value',
    );
  }
  if (raw.direction === 'outbound' && raw.list === 'allow' && kind === 'domain' && isPlatformDomainRule(value)) {
    // `atmark.ai` 한 줄은 이 플랫폼의 **모든 에이전트**를 여는 규칙이다(202609241040 — 검증 L1). 다른 에이전트는 정확한 주소로만.
    throw new AdminInputError(
      `발신 허용 목록에 ${value} 같은 atmark.ai 도메인 규칙은 넣을 수 없다 — 다른 에이전트는 정확한 주소(name@atmark.ai)로 더한다.`,
      'rule_platform_domain',
    );
  }
  return { direction: raw.direction as ContactRuleDirection, list: raw.list as ContactRuleList, kind, value };
}

interface AddRuleResult {
  readonly rule: ContactRuleRow;
  readonly policy: PolicyView;
}

/** 규칙 하나를 더하고 새 버전을 쓴다. `confirm` 은 쓰기 직전에 부른다(CLI 의 운영 확인). */
export async function addRuleOp(
  pool: Pool,
  agentId: AgentId,
  input: ContactRuleInput,
  createdBy: string,
  confirm: () => Promise<void> = () => Promise.resolve(),
): Promise<AddRuleResult> {
  return withTransaction(pool, async (client) => {
    const current = await lockPolicy(client, agentId);

    if (input.direction === 'outbound' && input.list === 'allow' && input.kind === 'address') {
      // 활성 주소만 — 폐기한 별칭은 재발급되면 남의 주소다(ADR-0013 2026-09-29 개정, 보안 리뷰 L7).
      const own = await client.query<{ address: string }>('SELECT address FROM agent_addresses WHERE agent_id = $1 AND retired_at IS NULL', [agentId]);
      const wide = normalizeAddress(input.value);
      if (own.rows.some((row) => normalizeAddress(row.address) === wide)) {
        throw new AdminInputError(`발신 허용 목록에 에이전트 자기 주소를 넣을 수 없다: ${input.value}`, 'rule_self_address');
      }
    }
    const sameList = current.rules.filter((rule) => rule.direction === input.direction && rule.list === input.list);
    if (sameList.some((rule) => rule.value === input.value)) {
      throw new AdminInputError(`이미 목록에 있다: ${input.value}`, 'rule_duplicate', 409);
    }
    if (sameList.length >= MAX_CONTACT_RULES_PER_LIST) {
      throw new AdminInputError(`목록은 ${String(MAX_CONTACT_RULES_PER_LIST)}개까지다.`, 'rule_limit', 409);
    }

    await confirm();
    const inserted = await client.query<ContactRuleRow>(
      `INSERT INTO agent_contact_rules (agent_id, direction, list, kind, value, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, agent_id, direction, list, kind, value, created_at, created_by, removed_at, removed_by`,
      [agentId, input.direction, input.list, input.kind, input.value, createdBy],
    );
    const row = inserted.rows[0];
    if (row === undefined) throw new Error('agent_contact_rules INSERT 가 행을 돌려주지 않았다');
    const { version, rules } = await appendPolicyVersion(client, agentId, current, current, createdBy);
    return {
      rule: { ...row, agent_id: toAgentId(row.agent_id) },
      policy: policyViewOf({ ...current, version, rules }),
    };
  });
}

/** 규칙 하나를 지우고 새 버전을 쓴다. */
export async function removeRuleOp(
  pool: Pool,
  agentId: AgentId,
  ruleId: string,
  createdBy: string,
  confirm: (rule: ContactRuleRow) => Promise<void> = () => Promise.resolve(),
): Promise<PolicyView> {
  if (!UUID_PATTERN.test(ruleId)) throw notFound('규칙이 없다.', 'rule_not_found');
  return withTransaction(pool, async (client) => {
    const current = await lockPolicy(client, agentId);
    const target = current.rules.find((rule) => rule.id === ruleId);
    if (target === undefined) throw notFound('규칙이 없다.', 'rule_not_found');
    await confirm(target);
    const removed = await client.query(
      `UPDATE agent_contact_rules SET removed_at = now(), removed_by = $3
        WHERE id = $1 AND agent_id = $2 AND removed_at IS NULL`,
      [ruleId, agentId, createdBy],
    );
    if (removed.rowCount !== 1) throw notFound('규칙이 없다.', 'rule_not_found');
    const { version, rules } = await appendPolicyVersion(client, agentId, current, current, createdBy);
    return policyViewOf({ ...current, version, rules });
  });
}
