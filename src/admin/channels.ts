/**
 * src/admin/channels.ts — 정책 채널 이름(확장성 P1 R-5, 계획 §3.4 · ADR-0007 추가 절).
 *
 * 지금 채널은 **email 하나**다. `/api/agents/{id}/channels/{channel}/policy|rules` 는 옛 `/policy`·`/rules` 의 별칭이고 DB 에는 채널 칸이
 * 없다(정책 테이블·`policy_versions` 스냅샷 잎은 이메일 전용 — 두 번째 채널 없이 칸만 넣으면 검증할 방법이 없다). 두 번째 채널이 생기는
 * 날의 조건은 ADR-0007 추가 절에 있다. 목록 밖 채널은 404 `channel_not_found`.
 */

export const CHANNELS = ['email'] as const;

type Channel = (typeof CHANNELS)[number];

export function isChannel(value: unknown): value is Channel {
  return typeof value === 'string' && (CHANNELS as readonly string[]).includes(value);
}
