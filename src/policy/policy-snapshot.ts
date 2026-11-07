/**
 * `policy_versions.snapshot` 의 모양(§4.3 · 정책 v2). 스냅샷은 평가 시점 정책의 전문이고(AC-9 의 사후 불변 근거), 목록도 그
 * 일부다 — 목록 변경 = 새 버전. 프로비저닝과 관리 정책·목록 변경이 이 함수 하나를 쓴다(모양이 둘이면 감사 질의에서야 드러난다).
 */

import type { ContactRuleRow, InboundMode, JsonObject, OutboundMode } from '../db/schema';

/** 스냅샷에 싣는 규칙 한 행(판정 근거만 — 시각·작성자는 행에 있다). */
export type SnapshotRule = Pick<ContactRuleRow, 'id' | 'direction' | 'list' | 'kind' | 'value'>;

export interface PolicySnapshotInput {
  readonly outboundMode: OutboundMode;
  readonly inboundMode: InboundMode;
  readonly limits: JsonObject;
  readonly configJson: JsonObject;
  readonly rules: readonly SnapshotRule[];
  /** 소유자 발신 승인 `always`. 없으면 auto(옛 스냅샷과 같은 값). */
  readonly requireApproval?: boolean;
}

function compare(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** 스냅샷 JSON. 규칙은 방향 → 목록 → 값 순(결정적) — 입력 순서와 무관하게 같은 목록이면 같은 스냅샷이다. */
export function policySnapshotOf(input: PolicySnapshotInput): JsonObject {
  const rules = [...input.rules].sort(
    (a, b) => compare(a.direction, b.direction) || compare(a.list, b.list) || compare(a.value, b.value),
  );
  return {
    outbound_mode: input.outboundMode,
    inbound_mode: input.inboundMode,
    limits: input.limits,
    config_json: input.configJson,
    // `always` 일 때만 싣는다 — 칸이 없으면 auto.
    ...(input.requireApproval === true ? { require_approval: true } : {}),
    contact_rules: rules.map((rule) => ({
      id: rule.id,
      direction: rule.direction,
      list: rule.list,
      kind: rule.kind,
      value: rule.value,
    })),
  };
}
