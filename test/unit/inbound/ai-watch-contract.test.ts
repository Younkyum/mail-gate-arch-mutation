/**
 * `src/inbound/ai-watch/contract.ts` — 선로 스키마의 엄격 파서·직렬화기. 외부 입력이므로 던지지 않고, 모르는 키·모양은 닫힌 어휘로 거부한다.
 */

import { describe, expect, it } from 'vitest';

import {
  AI_WATCH_AGENT_NOTE,
  AI_WATCH_EXCERPT,
  AI_WATCH_INPUT_VERSION,
  AI_WATCH_MAX_RESULT_BYTES,
  bandMatchesVerdict,
  parseAiWatchMode,
  parseAiWatchRequest,
  parseAiWatchResult,
  serializeAiWatchRequest,
  serializeAiWatchResult,
  type AiWatchHeartbeatResult,
  type AiWatchRequest,
  type AiWatchVerdictResult,
} from '../../../src/inbound/ai-watch/contract';

const JOB = '0b7f6c1e-5d1a-4c8e-9f3a-2b6d7e8f9a01';
const TEXT = 'Subject: 안녕하세요\n\n다음 주 회의 일정을 확인 부탁드립니다. 감사합니다.';

const request: AiWatchRequest = {
  v: 1,
  job_id: JOB,
  enqueued_at: '2026-10-06T01:02:03.004Z',
  deadline: '2026-10-06T01:02:33.004Z',
  input_version: AI_WATCH_INPUT_VERSION,
  text: TEXT,
};

const verdict: AiWatchVerdictResult = {
  v: 1,
  kind: 'verdict',
  job_id: JOB,
  verdict: 'flagged',
  band: 'high',
  model_version: 'laya-ml-aw-2026.10.1-int8',
  latency_ms: 42,
};

const heartbeat: AiWatchHeartbeatResult = {
  v: 1,
  kind: 'heartbeat',
  worker_id: 'macstudio-1',
  model_version: 'laya-ml-aw-2026.10.1-int8',
  at: '2026-10-06T01:02:03.004Z',
  queue_lag_ms: 120,
  self_test: 'pass',
  draining: false,
};

function withField(base: object, key: string, value: unknown): string {
  return JSON.stringify({ ...base, [key]: value });
}

function without(base: object, key: string): string {
  const copy: Record<string, unknown> = { ...base };
  delete copy[key];
  return JSON.stringify(copy);
}

describe('parseAiWatchMode', () => {
  it('없으면 off, 정확한 값만 받는다', () => {
    expect(parseAiWatchMode(undefined)).toEqual({ mode: 'off', valid: true });
    expect(parseAiWatchMode(' on ')).toEqual({ mode: 'on', valid: true });
    expect(parseAiWatchMode('shadow')).toEqual({ mode: 'shadow', valid: true });
    expect(parseAiWatchMode('ON')).toEqual({ mode: 'off', valid: false });
    expect(parseAiWatchMode('true')).toEqual({ mode: 'off', valid: false });
  });
});

describe('요청 ai-watch/req/v1', () => {
  it('왕복한다', () => {
    const parsed = parseAiWatchRequest(serializeAiWatchRequest(request));
    expect(parsed).toEqual({ ok: true, value: request });
  });

  it('모르는 키·빠진 키를 거부한다', () => {
    expect(parseAiWatchRequest(withField(request, 'from', 'a@b.c'))).toEqual({ ok: false, reason: 'unknown_key' });
    expect(parseAiWatchRequest(without(request, 'deadline'))).toEqual({ ok: false, reason: 'missing_key' });
  });

  it('모양이 틀리면 거부한다', () => {
    expect(parseAiWatchRequest('nope')).toEqual({ ok: false, reason: 'not_json' });
    expect(parseAiWatchRequest('[]')).toEqual({ ok: false, reason: 'not_object' });
    expect(parseAiWatchRequest(withField(request, 'v', 2))).toEqual({ ok: false, reason: 'bad_version' });
    expect(parseAiWatchRequest(withField(request, 'job_id', 'X'))).toEqual({ ok: false, reason: 'bad_job_id' });
    expect(parseAiWatchRequest(withField(request, 'job_id', JOB.toUpperCase()))).toEqual({ ok: false, reason: 'bad_job_id' });
    expect(parseAiWatchRequest(withField(request, 'enqueued_at', '2026-10-06T01:02:03Z'))).toEqual({ ok: false, reason: 'bad_timestamp' });
    expect(parseAiWatchRequest(withField(request, 'deadline', '2026-02-30T00:00:00.000Z'))).toEqual({ ok: false, reason: 'bad_timestamp' });
    expect(parseAiWatchRequest(withField(request, 'deadline', request.enqueued_at))).toEqual({ ok: false, reason: 'bad_timestamp' });
    expect(parseAiWatchRequest(withField(request, 'input_version', 'aw-in/2'))).toEqual({ ok: false, reason: 'bad_input_version' });
  });

  it('발췌문 길이·금지 문자', () => {
    expect(parseAiWatchRequest(withField(request, 'text', 'x'.repeat(AI_WATCH_EXCERPT.minChars - 1))).ok).toBe(false);
    expect(parseAiWatchRequest(withField(request, 'text', 'x'.repeat(AI_WATCH_EXCERPT.minChars))).ok).toBe(true);
    // 코드 포인트로 센다 — 이모지 4,000 개(UTF-16 8,000)는 통과, 4,001 개는 거부.
    expect(parseAiWatchRequest(withField(request, 'text', '😀'.repeat(AI_WATCH_EXCERPT.maxChars))).ok).toBe(true);
    expect(parseAiWatchRequest(withField(request, 'text', '😀'.repeat(AI_WATCH_EXCERPT.maxChars + 1))).ok).toBe(false);
    expect(parseAiWatchRequest(withField(request, 'text', `${TEXT}\u0000`))).toEqual({ ok: false, reason: 'bad_text' });
    expect(parseAiWatchRequest(withField(request, 'text', `${TEXT}\u007f`))).toEqual({ ok: false, reason: 'bad_text' });
    expect(parseAiWatchRequest(withField(request, 'text', `${TEXT}\t\r\n`)).ok).toBe(true);
    expect(parseAiWatchRequest(withField(request, 'text', 42))).toEqual({ ok: false, reason: 'bad_text' });
  });

  it('너무 큰 본문은 파싱 전에 거부한다', () => {
    expect(parseAiWatchRequest(' '.repeat(20_001))).toEqual({ ok: false, reason: 'too_large' });
  });

  it('직렬화기는 계약을 어긴 값을 내보내지 않는다', () => {
    expect(() => serializeAiWatchRequest({ ...request, text: 'short' })).toThrow(/bad_text/);
  });
});

describe('결과 ai-watch/res/v1', () => {
  it('판정·하트비트가 왕복한다', () => {
    expect(parseAiWatchResult(serializeAiWatchResult(verdict))).toEqual({ ok: true, value: verdict });
    expect(parseAiWatchResult(serializeAiWatchResult(heartbeat))).toEqual({ ok: true, value: heartbeat });
    const error: AiWatchVerdictResult = { ...verdict, verdict: 'error', band: null };
    expect(parseAiWatchResult(serializeAiWatchResult(error))).toEqual({ ok: true, value: error });
  });

  it('점수 원값 같은 모르는 키를 거부한다', () => {
    expect(parseAiWatchResult(withField(verdict, 'attack_score', 0.91))).toEqual({ ok: false, reason: 'unknown_key' });
    expect(parseAiWatchResult(withField(heartbeat, 'job_id', JOB))).toEqual({ ok: false, reason: 'unknown_key' });
    expect(parseAiWatchResult(without(verdict, 'band'))).toEqual({ ok: false, reason: 'missing_key' });
  });

  it('kind·버전', () => {
    expect(parseAiWatchResult(withField(verdict, 'kind', 'other'))).toEqual({ ok: false, reason: 'bad_kind' });
    expect(parseAiWatchResult(withField(verdict, 'v', '1'))).toEqual({ ok: false, reason: 'bad_version' });
  });

  it('판정·밴드 어휘와 대응', () => {
    expect(parseAiWatchResult(withField(verdict, 'verdict', 'malicious'))).toEqual({ ok: false, reason: 'bad_verdict' });
    expect(parseAiWatchResult(withField(verdict, 'band', 'extreme'))).toEqual({ ok: false, reason: 'bad_band' });
    expect(parseAiWatchResult(withField(verdict, 'band', 'low'))).toEqual({ ok: false, reason: 'band_mismatch' });
    expect(parseAiWatchResult(withField(verdict, 'band', null))).toEqual({ ok: false, reason: 'band_mismatch' });
    expect(parseAiWatchResult(JSON.stringify({ ...verdict, verdict: 'clear', band: 'mid' }))).toEqual({ ok: false, reason: 'band_mismatch' });
    expect(parseAiWatchResult(JSON.stringify({ ...verdict, verdict: 'error', band: 'low' }))).toEqual({ ok: false, reason: 'band_mismatch' });
    expect(bandMatchesVerdict('flagged', 'mid')).toBe(true);
    expect(bandMatchesVerdict('clear', 'low')).toBe(true);
  });

  it('model_version·worker_id 모양', () => {
    expect(parseAiWatchResult(withField(verdict, 'model_version', 'x'.repeat(65)))).toEqual({ ok: false, reason: 'bad_model_version' });
    expect(parseAiWatchResult(withField(verdict, 'model_version', 'Laya'))).toEqual({ ok: false, reason: 'bad_model_version' });
    expect(parseAiWatchResult(withField(verdict, 'model_version', 'a b'))).toEqual({ ok: false, reason: 'bad_model_version' });
    expect(parseAiWatchResult(withField(heartbeat, 'worker_id', '-x'))).toEqual({ ok: false, reason: 'bad_worker_id' });
  });

  it('숫자·플래그', () => {
    expect(parseAiWatchResult(withField(verdict, 'latency_ms', -1))).toEqual({ ok: false, reason: 'bad_number' });
    expect(parseAiWatchResult(withField(verdict, 'latency_ms', 1.5))).toEqual({ ok: false, reason: 'bad_number' });
    expect(parseAiWatchResult(withField(verdict, 'latency_ms', 600_001))).toEqual({ ok: false, reason: 'bad_number' });
    expect(parseAiWatchResult(withField(heartbeat, 'queue_lag_ms', '5'))).toEqual({ ok: false, reason: 'bad_number' });
    expect(parseAiWatchResult(withField(heartbeat, 'self_test', 'ok'))).toEqual({ ok: false, reason: 'bad_flag' });
    expect(parseAiWatchResult(withField(heartbeat, 'draining', 'false'))).toEqual({ ok: false, reason: 'bad_flag' });
    expect(parseAiWatchResult(withField(heartbeat, 'at', 'yesterday'))).toEqual({ ok: false, reason: 'bad_timestamp' });
  });

  it('결과 본문 바이트 상한', () => {
    expect(parseAiWatchResult(' '.repeat(AI_WATCH_MAX_RESULT_BYTES + 1))).toEqual({ ok: false, reason: 'too_large' });
  });
});

describe('고정 문구', () => {
  it('에이전트 경고는 영어 고정 한 줄이다', () => {
    expect(AI_WATCH_AGENT_NOTE).not.toMatch(/\n/);
    expect(AI_WATCH_AGENT_NOTE.startsWith('Note: ')).toBe(true);
  });
});
