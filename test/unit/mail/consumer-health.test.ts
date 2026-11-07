/**
 * `src/mail/events/health.ts` — **소비자 정지를 "이벤트 없음" 과 구별한다** (ADR-0004).
 *
 * ADR 이 닫지 못한 채 남긴 창:
 *
 * > 이벤트 소비자가 죽으면 조회가 항상 비어 있고, 우리는 그것을 "안 나갔다" 로 읽는다.
 *
 * 그 판정이 틀리는 방향은 둘이고 **둘 다 알람을 죽인다**:
 *   - 트래픽이 없는 밤에 `stalled` 를 내면 매일 울리고, 매일 울리는 알람은 곧 꺼진다.
 *   - 소비자가 죽었는데 `ok` 를 내면 알람이 정확히 필요한 순간에 조용하다.
 *
 * 그래서 아래 표는 두 방향을 모두 고정한다.
 */

import { describe, expect, it } from 'vitest';

import {
  CONSUMER_STALE_AFTER_SECONDS,
  evaluateConsumerHealth,
} from '../../../src/mail/events/health';

const NOW = new Date('2026-09-22T12:00:00.000Z');

function ago(seconds: number): Date {
  return new Date(NOW.getTime() - seconds * 1000);
}

describe('유예 상수', () => {
  it('900초다 — 이벤트 지연의 정상 범위(초 단위)보다 두 자릿수 위이고, lease TTL(300초)보다 길다', () => {
    // lease TTL 보다 짧으면 lease 한 번 만료될 때마다 정지 알람이 함께 울린다 — lease 만료는 "한 건의 판단 유보", 정지는 "전건이 막혔다".
    expect(CONSUMER_STALE_AFTER_SECONDS).toBe(900);
    expect(CONSUMER_STALE_AFTER_SECONDS).toBeGreaterThan(300);
  });
});

describe('판정', () => {
  it.each([
    // 신규 배포 첫날 알람이 울리지 않는 이유가 이 분기다.
    ['한 통도 안 나갔으면 idle 이다 — 정지가 아니다', { lastEventAt: null, lastSentAt: null }, 'idle'],
    ['이벤트가 있어도 나간 메일이 없으면 idle 이다', { lastEventAt: ago(100_000), lastSentAt: null }, 'idle'],
    ['방금 나간 메일은 유예 안이라 ok 다 — Send 는 대개 초 단위지만 보장이 없다', { lastEventAt: null, lastSentAt: ago(10) }, 'ok'],
    ['유예 직전(899초)은 아직 ok 다', { lastEventAt: null, lastSentAt: ago(899) }, 'ok'],
    // 그 발송 자신의 이벤트가 아니어도 좋다 — 묻는 것은 "소비자가 도는가" 이지 "이 메일이 나갔는가"(SendEvidenceLookup)가 아니다.
    ['발송보다 **뒤에** 들어온 이벤트가 있으면 소비자는 살아 있다', { lastEventAt: ago(900), lastSentAt: ago(1000) }, 'ok'],
    ['발송보다 **앞선** 이벤트뿐이면 stalled 다 — 과거의 이벤트는 현재의 생사를 말하지 않는다', { lastEventAt: ago(5000), lastSentAt: ago(2000) }, 'stalled'],
  ] as const)('%s', (_label, freshness, kind) => {
    const health = evaluateConsumerHealth(freshness, NOW);
    if (kind === 'stalled') expect(health.kind).toBe(kind);
    else expect(health).toEqual({ kind });
  });

  it('**유예를 넘겼는데 그 발송 이후의 이벤트가 없으면 stalled 다**', () => {
    expect(evaluateConsumerHealth({ lastEventAt: null, lastSentAt: ago(1000) }, NOW)).toEqual({ kind: 'stalled', staleSeconds: 1000 });
  });

  it('유예를 인자로 좁히면 같은 입력이 stalled 가 된다 — 테스트가 시간을 기다리지 않는다', () => {
    const freshness = { lastEventAt: null, lastSentAt: ago(60) };
    expect(evaluateConsumerHealth(freshness, NOW).kind).toBe('ok');
    expect(evaluateConsumerHealth(freshness, NOW, 30).kind).toBe('stalled');
  });
});
