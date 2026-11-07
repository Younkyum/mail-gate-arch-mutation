/**
 * `workers/ai-watch-result` — 결과 큐 소비자(가짜 저장소). 계약 위반은 `rejected`(재전달 없음) · 판정·하트비트는 정의 함수로 · DB 장애만 `failed`.
 * 핸들러의 부분 배치 실패는 `failed` 만.
 */

import { describe, expect, it } from 'vitest';

import type { AiWatchResultStore } from '../../../src/db/repositories/ai-watch-result-store';
import { serializeAiWatchResult } from '../../../src/inbound/ai-watch/contract';
import { createAiWatchResultHandler } from '../../../src/runtime/handlers/ai-watch-result';
import type { LambdaContext } from '../../../src/runtime/lambda';
import { consumeAiWatchResult } from '../../../src/workers/ai-watch-result';

const JOB = '0b7f6c1e-5d1a-4c8e-9f3a-2b6d7e8f9a01';
const MODEL = 'laya-ml-aw-2026.10.1-int8';

const verdict = serializeAiWatchResult({ v: 1, kind: 'verdict', job_id: JOB, verdict: 'flagged', band: 'high', model_version: MODEL, latency_ms: 40 });
const heartbeat = serializeAiWatchResult({
  v: 1,
  kind: 'heartbeat',
  worker_id: 'macstudio-1',
  model_version: MODEL,
  at: '2026-10-06T00:00:00.000Z',
  queue_lag_ms: 5,
  self_test: 'fail',
  draining: true,
});

function fakeStore(outcome: 'recorded' | 'late' | 'ignored' = 'recorded', fail = false) {
  const calls: { kind: string; input: unknown }[] = [];
  const store: AiWatchResultStore = {
    recordVerdict(input) {
      calls.push({ kind: 'verdict', input });
      if (fail) return Promise.reject(new Error('db down'));
      return Promise.resolve({ outcome, latencyMs: outcome === 'ignored' ? null : 1200 });
    },
    recordHeartbeat(input) {
      calls.push({ kind: 'heartbeat', input });
      return fail ? Promise.reject(new Error('db down')) : Promise.resolve();
    },
    purgeExpired() {
      calls.push({ kind: 'purge', input: null });
      return Promise.resolve(0);
    },
  };
  return { store, calls };
}

describe('consumeAiWatchResult', () => {
  it('판정 → 정의 함수 하나(job · 판정 · 밴드 · 모델 버전), 결말을 그대로', async () => {
    const { store, calls } = fakeStore('recorded');
    expect(await consumeAiWatchResult({ store }, { receiptId: 'r1', body: verdict })).toBe('recorded');
    expect(calls).toEqual([{ kind: 'verdict', input: { jobId: JOB, verdict: 'flagged', band: 'high', modelVersion: MODEL } }]);
  });

  it('늦은 결과 · 모르는/중복 job 은 저장소의 결말(late · ignored) — 재전달 대상 아님', async () => {
    expect(await consumeAiWatchResult({ store: fakeStore('late').store }, { receiptId: null, body: verdict })).toBe('late');
    expect(await consumeAiWatchResult({ store: fakeStore('ignored').store }, { receiptId: null, body: verdict })).toBe('ignored');
  });

  it('하트비트 → 자기 시험 · draining 을 그대로 넘긴다', async () => {
    const { store, calls } = fakeStore();
    expect(await consumeAiWatchResult({ store }, { receiptId: null, body: heartbeat })).toBe('heartbeat');
    expect(calls).toEqual([
      { kind: 'heartbeat', input: { workerId: 'macstudio-1', modelVersion: MODEL, selfTestOk: false, draining: true } },
      { kind: 'purge', input: null },
    ]);
  });

  it('계약 위반(점수 원값 · 모르는 kind · JSON 아님)은 저장소를 부르지 않고 rejected', async () => {
    const { store, calls } = fakeStore();
    const scored = JSON.stringify({ ...JSON.parse(verdict), attack_score: 0.93 });
    for (const body of [scored, '{"v":1,"kind":"other"}', 'nope']) {
      expect(await consumeAiWatchResult({ store }, { receiptId: null, body })).toBe('rejected');
    }
    expect(calls).toEqual([]);
  });

  it('DB 장애만 failed', async () => {
    expect(await consumeAiWatchResult({ store: fakeStore('recorded', true).store }, { receiptId: null, body: verdict })).toBe('failed');
    expect(await consumeAiWatchResult({ store: fakeStore('recorded', true).store }, { receiptId: null, body: heartbeat })).toBe('failed');
  });
});

describe('핸들러 — 부분 배치 실패는 failed 만', () => {
  it('rejected · recorded 는 지우고 failed 는 돌려준다', async () => {
    const ok = fakeStore('recorded');
    const handler = createAiWatchResultHandler(() => Promise.resolve({ deps: { store: ok.store } }));
    const context = { awsRequestId: 'req', invokedFunctionArn: 'arn:aws:lambda:ap-northeast-2:1:function:atmark-ai-watch-result' } as LambdaContext;
    const response = await handler({ Records: [{ messageId: 'a', body: verdict }, { messageId: 'b', body: 'bad' }] }, context);
    expect(response.batchItemFailures).toEqual([]);

    const down = fakeStore('recorded', true);
    const failing = createAiWatchResultHandler(() => Promise.resolve({ deps: { store: down.store } }));
    const failed = await failing({ Records: [{ messageId: 'c', body: verdict }, { messageId: 'd', body: 'bad' }] }, context);
    expect(failed.batchItemFailures).toEqual([{ itemIdentifier: 'c' }]);
  });
});
