/**
 * 콘솔 모드 이름 ↔ 내부 enum(정책 v2).
 *
 *   | 콘솔 | 발신 `outbound_mode` | 수신 `inbound_mode` |
 *   |---|---|---|
 *   | `all` (전체)            | `unrestricted`   | `all` |
 *   | `allowlist` (화이트리스트) | `allowlist_only` | `allowlist_only` |
 *   | `blocklist` (블랙리스트)   | `blocklist_only` | `blocklist_only` |
 *   | `none` (전부 X)          | `disabled`       | `disabled` |
 *
 * 레거시 발신 모드(`approval_required`·`reply_only`)는 보기에서 `legacy`, 고를 수 없다(ADR-0007). 표가 여기 하나인 이유: 관리 API 와
 * 에이전트 표면(MCP `get_my_policy`)이 같은 이름을 말해야 한다. 순수 모듈이라 두 번들 어디서나 import 한다.
 */

import type { InboundMode, OutboundMode } from '../db/schema';

export type ConsoleMode = 'all' | 'allowlist' | 'blocklist' | 'none';

export const CONSOLE_MODES = ['all', 'allowlist', 'blocklist', 'none'] as const satisfies readonly ConsoleMode[];

export const CONSOLE_OUTBOUND_MODES: Readonly<Record<ConsoleMode, OutboundMode>> = {
  all: 'unrestricted',
  allowlist: 'allowlist_only',
  blocklist: 'blocklist_only',
  none: 'disabled',
};

export const CONSOLE_INBOUND_MODES: Readonly<Record<ConsoleMode, InboundMode>> = {
  all: 'all',
  allowlist: 'allowlist_only',
  blocklist: 'blocklist_only',
  none: 'disabled',
};

/** 발신 enum → 콘솔 이름. 레거시 두 모드는 `legacy`(보기 전용). */
export function consoleOutboundModeOf(mode: OutboundMode): ConsoleMode | 'legacy' {
  return CONSOLE_MODES.find((name) => CONSOLE_OUTBOUND_MODES[name] === mode) ?? 'legacy';
}

/** 수신 enum → 콘솔 이름. 표가 enum 과 갈라지면 던진다(조용히 다른 이름을 말하지 않는다). */
export function consoleInboundModeOf(mode: InboundMode): ConsoleMode {
  const found = CONSOLE_MODES.find((name) => CONSOLE_INBOUND_MODES[name] === mode);
  if (found === undefined) throw new Error(`수신 모드 ${String(mode)} 의 콘솔 이름이 없다`);
  return found;
}
