/**
 * `metrics.ts` — **차원이 의도한 것뿐이고, 알람이 볼 수 있는 형태로 나간다.**
 * EMF 는 적힌 조합만 발행하므로 빈 집합을 빠뜨리면 차원 없는 알람이 영원히 `INSUFFICIENT_DATA` 다.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { resetLogSink, setLogSink } from '../../../src/observability/logger';
import {
  METRIC_DIMENSION_KEYS,
  METRIC_NAMES,
  METRIC_NAMESPACE,
  countMetric,
  emitMetric,
  type MetricDimensions,
} from '../../../src/observability/metrics';

interface EmfLine {
  readonly _aws: {
    readonly Timestamp: number;
    readonly CloudWatchMetrics: readonly {
      readonly Namespace: string;
      readonly Dimensions: readonly (readonly string[])[];
      readonly Metrics: readonly { readonly Name: string; readonly Unit: string }[];
    }[];
  };
  readonly [key: string]: unknown;
}

function capture(): { readonly lines: EmfLine[] } {
  const lines: EmfLine[] = [];
  setLogSink((line) => {
    lines.push(JSON.parse(line) as EmfLine);
  });
  return { lines };
}

afterEach(() => {
  resetLogSink();
});

describe('metrics — 기수(cardinality)', () => {
  it('차원 어휘는 5개뿐이고 agent_id·message_id·수신자를 포함하지 않는다', () => {
    // `agent_id` 는 로그에는 싣고 메트릭에는 싣지 않는다 — 차원 조합 하나가 곧 시계열 하나다.
    expect([...METRIC_DIMENSION_KEYS]).toEqual(['route_id', 'verdict', 'reason', 'outcome', 'lane']);
    for (const banned of ['agent_id', 'organization_id', 'message_id', 'recipient', 'from_address']) {
      expect(METRIC_DIMENSION_KEYS).not.toContain(banned);
    }
  });

  it('어휘 밖의 차원은 버려진다 — 기수 폭발의 입구를 닫는다', () => {
    const { lines } = capture();
    countMetric(METRIC_NAMES.attempts, {
      route_id: 'send',
      agent_id: 'a'.repeat(32),
    } as unknown as MetricDimensions);

    const emitted = lines[0];
    expect(emitted).toBeDefined();
    expect(emitted?.['agent_id']).toBeUndefined();
    expect(emitted?.['route_id']).toBe('send');
    expect(emitted?._aws.CloudWatchMetrics[0]?.Dimensions).toEqual([[], ['route_id']]);
  });

  it('빈 문자열 차원은 시계열을 만들지 않는다', () => {
    const { lines } = capture();
    countMetric(METRIC_NAMES.attempts, { route_id: '' });
    expect(lines[0]?._aws.CloudWatchMetrics[0]?.Dimensions).toEqual([[]]);
  });

  it('차원 키 순서가 달라도 같은 시계열이 된다 — 정렬이 집계를 쪼개지 않게 한다', () => {
    const { lines } = capture();
    countMetric(METRIC_NAMES.attempts, { verdict: 'denied', route_id: 'send' });
    countMetric(METRIC_NAMES.attempts, { route_id: 'send', verdict: 'denied' });

    const first = lines[0]?._aws.CloudWatchMetrics[0]?.Dimensions;
    expect(first).toEqual(lines[1]?._aws.CloudWatchMetrics[0]?.Dimensions);
    expect(first).toEqual([[], ['route_id', 'verdict']]);
  });
});

describe('metrics — 알람이 볼 수 있는 형태', () => {
  it('네임스페이스·이름·단위·값이 알람 정의와 같은 축을 가리키고, 빈 차원 집합이 항상 함께 나간다', () => {
    const { lines } = capture();
    emitMetric(METRIC_NAMES.latencyMs, 42, 'Milliseconds', { route_id: 'send' });

    const block = lines[0]?._aws.CloudWatchMetrics[0];
    expect(block?.Namespace).toBe(METRIC_NAMESPACE);
    // 알람은 차원 없이 정의돼 있다(`observability-stack.ts` 의 `custom()`) — 그 알람이 보는 시계열이 빈 집합이다.
    expect(block?.Dimensions).toEqual([[], ['route_id']]);
    expect(block?.Metrics).toEqual([{ Name: METRIC_NAMES.latencyMs, Unit: 'Milliseconds' }]);
    expect(lines[0]?.[METRIC_NAMES.latencyMs]).toBe(42);
  });

  it('메트릭 이름은 서로 겹치지 않는다 — 한 이름을 두 뜻으로 쓰면 알람이 거짓말한다', () => {
    const names = Object.values(METRIC_NAMES);
    expect(names.length).toBe(new Set(names).size);
  });
});

describe('metrics — 관측은 결말을 뒤집지 않는다', () => {
  it('싱크가 던져도 emitMetric 은 던지지 않는다', () => {
    setLogSink(() => {
      throw new Error('EMF sink down');
    });
    expect(() => {
      countMetric(METRIC_NAMES.auditResolveFailed, { route_id: 'send' });
    }).not.toThrow();
  });
});
