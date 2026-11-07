/**
 * 오염 분류(`src/security/taint.ts`, ADR-0016 A) — 규칙 표 · 창 산수 · **음성 코퍼스 위의 T2 = 0**.
 *
 * 음성 코퍼스: 활성 홀드아웃이 없다(`scripts/injection-seal.ts` `ACTIVE_SEAL_DIGEST = null` — v1 소진, v2 보류). 그래서
 *   - **판정 세트 = 소진된 v1 봉인 세트의 benign 30통**(`test/fixtures/injection/consumed/v1`, 2026-09-23 봉인). 이 세트는 오염 규칙을 쓰기
 *     **전에** 있었고 규칙을 거기에 맞추지 않았다 — T2 = 0 을 단언한다.
 *   - **참고 세트 = dev 음성 165통**(`test/fixtures/injection/dev/negative`). 경계 음성(edge-*)을 일부러 모은 세트라 T2 가 나온다 —
 *     그 목록을 그대로 못 박는다(늘면 빨개진다). 워크로드 1(wl1-*) 음성은 T2 = 0 이다.
 * 숨기거나 감싼 흔적 {technique, obfuscation, encoded} 의 완화되지 않은 low 를 T2 로 올린 뒤에도(리뷰 M5) 두 세트의 T2 는 그대로다 — 아래 단언이 그 측정이다.
 * 둘 다 "DMARC 통과 · sender_trust seen" 인 정상 수신으로 놓고 본문 면에서 분류한다 — 인증 실패 규칙(T2 규칙 4)은 코퍼스 밖의 사실이다.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { scanForInjection, type InjectionScanInput } from '../../../src/security/injection/scanner';
import {
  AGENT_TAINT_WINDOW_MS,
  FUTURE_EXPOSURE_TOLERANCE_MS,
  futureExposureCount,
  THREAD_SENDER_TAINT_WINDOW_MS,
  agentTaintActive,
  classifyTaint,
  maxTaint,
  taintedSenders,
  threadTaintActive,
  type TaintExposure,
  type TaintInput,
} from '../../../src/security/taint';

const PASS = { spf: 'pass', dkim: 'pass', dmarc: 'pass', fromAuthenticated: true } as const;
const base: TaintInput = {
  surface: 'message_detail',
  field: 'body',
  injectionRisk: 'none',
  findings: [],
  auth: PASS,
  senderTrust: 'seen',
};

describe('classifyTaint — 규칙 표', () => {
  it.each<[string, Partial<TaintInput>, 'T0' | 'T1' | 'T2']>([
    ['깨끗한 인증 메일', {}, 'T0'],
    ['첨부 텍스트 low', { surface: 'attachment_content', field: 'attachment_text', injectionRisk: 'low' }, 'T2'],
    ['첨부 텍스트 판정 없음', { surface: 'attachment_content', field: 'attachment_text', injectionRisk: null }, 'T2'],
    ['첨부 텍스트 none', { surface: 'attachment_content', field: 'attachment_text', injectionRisk: 'none' }, 'T0'],
    ['본문 medium', { injectionRisk: 'medium' }, 'T2'],
    ['본문 high', { injectionRisk: 'high' }, 'T2'],
    ['본문 low + exfiltration', { injectionRisk: 'low', findings: [{ family: 'exfiltration', damped: false }] }, 'T2'],
    ['본문 low + agent_action', { injectionRisk: 'low', findings: [{ family: 'agent_action', damped: false }] }, 'T2'],
    ['본문 low + tool_invocation', { injectionRisk: 'low', findings: [{ family: 'tool_invocation', damped: false }] }, 'T2'],
    ['본문 low + override', { injectionRisk: 'low', findings: [{ family: 'override', damped: false }] }, 'T2'],
    ['본문 low + concealment', { injectionRisk: 'low', findings: [{ family: 'concealment', damped: false }] }, 'T2'],
    ['본문 low + override 완화(보안 교육)', { injectionRisk: 'low', findings: [{ family: 'override', damped: true }] }, 'T1'],
    ['본문 low + prompt_reference(뉴스레터)', { injectionRisk: 'low', findings: [{ family: 'prompt_reference', damped: false }] }, 'T1'],
    ['본문 low + role_spoof', { injectionRisk: 'low', findings: [{ family: 'role_spoof', damped: false }] }, 'T1'],
    ['본문 low + technique(제로폭·태그 문자)', { injectionRisk: 'low', findings: [{ family: 'technique', damped: false }] }, 'T2'],
    ['본문 low + obfuscation', { injectionRisk: 'low', findings: [{ family: 'obfuscation', damped: false }] }, 'T2'],
    ['본문 low + encoded', { injectionRisk: 'low', findings: [{ family: 'encoded', damped: false }] }, 'T2'],
    ['본문 low + encoded 완화', { injectionRisk: 'low', findings: [{ family: 'encoded', damped: true }] }, 'T1'],
    ['미인증 발신 첨부 텍스트(none)', { surface: 'attachment_content', field: 'attachment_text', auth: { spf: 'fail', dkim: 'fail', dmarc: 'fail', fromAuthenticated: false } }, 'T2'],
    ['미인증 발신 본문', { auth: { spf: 'pass', dkim: 'fail', dmarc: 'fail', fromAuthenticated: false } }, 'T2'],
    ['미인증 발신 본문(gray)', { auth: { spf: 'gray', dkim: 'gray', dmarc: 'gray', fromAuthenticated: false } }, 'T2'],
    ['인증 코드 면 DMARC fail', { surface: 'verification_code', field: 'verification_code', auth: { spf: 'pass', dkim: 'fail', dmarc: 'fail', fromAuthenticated: false } }, 'T2'],
    ['인증 코드 면 DMARC gray', { surface: 'verification_code', field: 'verification_code', auth: { spf: 'pass', dkim: 'gray', dmarc: 'gray', fromAuthenticated: false } }, 'T0'],
    ['본문 판정 없음(P4 이전)', { injectionRisk: null }, 'T1'],
    ['sender_trust unknown', { senderTrust: 'unknown' }, 'T1'],
    ['sender_trust 없음', { senderTrust: null }, 'T1'],
    ['sender_trust blocked', { senderTrust: 'blocked' }, 'T1'],
    ['스레드 면 깨끗', { surface: 'thread' }, 'T0'],
    // 제목 면(목록 · 스레드 보기 — 재검증 N1 리드 결정): 움직이는·숨긴 계열의 low 이상만 T2, 미인증은 T1.
    ['제목 면 미인증 발신(뉴스레터)', { surface: 'message_list', field: 'subject', auth: { spf: 'fail', dkim: 'fail', dmarc: 'fail', fromAuthenticated: false } }, 'T1'],
    ['제목 면 미인증 + 판정 없음', { surface: 'message_list', field: 'subject', injectionRisk: null, auth: { spf: 'fail', dkim: 'fail', dmarc: 'fail', fromAuthenticated: false } }, 'T1'],
    ['제목 면 low + prompt_reference', { surface: 'message_list', field: 'subject', injectionRisk: 'low', findings: [{ family: 'prompt_reference', damped: false }] }, 'T1'],
    ['제목 면 low + agent_action', { surface: 'message_list', field: 'subject', injectionRisk: 'low', findings: [{ family: 'agent_action', damped: false }] }, 'T2'],
    ['제목 면 low + encoded', { surface: 'thread', field: 'subject', injectionRisk: 'low', findings: [{ family: 'encoded', damped: false }] }, 'T2'],
    ['제목 면 low + override 완화', { surface: 'thread', field: 'subject', injectionRisk: 'low', findings: [{ family: 'override', damped: true }] }, 'T1'],
    ['제목 면 미인증 + low + exfiltration', { surface: 'message_list', field: 'subject', injectionRisk: 'low', findings: [{ family: 'exfiltration', damped: false }], auth: { spf: 'fail', dkim: 'fail', dmarc: 'fail', fromAuthenticated: false } }, 'T2'],
    ['제목 면 medium + 계열 밖', { surface: 'message_list', field: 'subject', injectionRisk: 'medium', findings: [{ family: 'role_spoof', damped: false }] }, 'T1'],
    ['제목 면 깨끗한 인증 메일', { surface: 'message_list', field: 'subject' }, 'T0'],
    // 풀린 메일(2026-10-08 묶음 A) — 면 · 필드와 무관하게 늘 T2.
    ['풀린 메일 본문(깨끗해 보여도)', { released: true }, 'T2'],
    ['풀린 메일 제목 면', { surface: 'message_list', field: 'subject', released: true }, 'T2'],
    ['풀린 메일 인증 코드 면', { surface: 'verification_code', field: 'verification_code', released: true }, 'T2'],
    // 신뢰 발신자 우회 — 본문 · 제목 면의 메일 판정을 보지 않는다. 첨부 텍스트 · 미인증(위조)은 그대로.
    ['우회 본문 high', { injectionRisk: 'high', findings: [{ family: 'override', damped: false }], trustedBypass: true }, 'T0'],
    ['우회 본문 low + narrative', { injectionRisk: 'low', findings: [{ family: 'narrative', damped: false }], trustedBypass: true }, 'T0'],
    ['우회 제목 면 low + agent_action', { surface: 'message_list', field: 'subject', injectionRisk: 'low', findings: [{ family: 'agent_action', damped: false }], trustedBypass: true }, 'T0'],
    ['우회 첨부 텍스트 low(읽을 때 스캔)', { surface: 'attachment_content', field: 'attachment_text', injectionRisk: 'low', trustedBypass: true }, 'T2'],
    ['우회 표지 + 미인증(있을 수 없는 행 — 우회를 보지 않는다)', { injectionRisk: 'high', trustedBypass: true, auth: { spf: 'fail', dkim: 'fail', dmarc: 'fail', fromAuthenticated: false } }, 'T2'],
  ])('%s → %s', (_name, patch, want) => {
    expect(classifyTaint({ ...base, ...patch })).toBe(want);
  });

  it('maxTaint — 스레드 면은 가장 나쁜 메일을 따른다', () => {
    expect(maxTaint([])).toBe('T0');
    expect(maxTaint(['T0', 'T1'])).toBe('T1');
    expect(maxTaint(['T1', 'T2', 'T0'])).toBe('T2');
  });
});

describe('창 — 에이전트 4시간 · 스레드·발신자 7일', () => {
  const now = new Date('2026-10-15T12:00:00Z');
  const at = (ms: number): Date => new Date(now.getTime() - ms);
  const exposure = (patch: Partial<TaintExposure>): TaintExposure => ({
    level: 'T2',
    exposedAt: at(0),
    threadId: 'th-1',
    senderAddress: 'Attacker@Evil.example',
    ...patch,
  });

  it('상수', () => {
    expect(AGENT_TAINT_WINDOW_MS).toBe(4 * 3600 * 1000);
    expect(THREAD_SENDER_TAINT_WINDOW_MS).toBe(7 * 24 * 3600 * 1000);
  });

  it('에이전트 창 — 4시간 직전까지, 정각부터 밖', () => {
    expect(agentTaintActive([exposure({ exposedAt: at(AGENT_TAINT_WINDOW_MS - 1) })], now)).toBe(true);
    expect(agentTaintActive([exposure({ exposedAt: at(AGENT_TAINT_WINDOW_MS) })], now)).toBe(false);
  });

  it('T1·T0 은 창을 열지 않는다', () => {
    expect(agentTaintActive([exposure({ level: 'T1' }), exposure({ level: 'T0' })], now)).toBe(false);
    expect(threadTaintActive([exposure({ level: 'T1' })], 'th-1', now)).toBe(false);
  });

  it('미래 시각은 지금+5분으로 잘라 유효(fail closed) · 5분보다 먼 미래는 수로 드러난다', () => {
    expect(agentTaintActive([exposure({ exposedAt: at(-60_000) })], now)).toBe(true);
    expect(agentTaintActive([exposure({ exposedAt: at(-FUTURE_EXPOSURE_TOLERANCE_MS) })], now)).toBe(true);
    const far = [exposure({ exposedAt: at(-30 * 24 * 3600 * 1000) })];
    expect(agentTaintActive(far, now)).toBe(true);
    expect(threadTaintActive(far, 'th-1', now)).toBe(true);
    expect(taintedSenders(far, now)).toEqual(['attacker@evil.example']);
    expect(futureExposureCount(far, now)).toBe(1);
    expect(futureExposureCount([exposure({ exposedAt: at(-FUTURE_EXPOSURE_TOLERANCE_MS - 1) })], now)).toBe(1);
    expect(futureExposureCount([exposure({ exposedAt: at(-60_000) })], now)).toBe(0);
  });

  it('스레드 창 — 7일, 다른 스레드·스레드 없음은 아님', () => {
    const list = [exposure({ exposedAt: at(THREAD_SENDER_TAINT_WINDOW_MS - 1) })];
    expect(threadTaintActive(list, 'th-1', now)).toBe(true);
    expect(threadTaintActive(list, 'th-2', now)).toBe(false);
    expect(threadTaintActive(list, null, now)).toBe(false);
    expect(threadTaintActive([exposure({ exposedAt: at(THREAD_SENDER_TAINT_WINDOW_MS) })], 'th-1', now)).toBe(false);
  });

  it('발신자 — 주소 단위 · 소문자 · 중복 없음 · 창 밖 제외', () => {
    const result = taintedSenders(
      [
        exposure({}),
        exposure({ senderAddress: 'boss@corp.example' }),
        exposure({ senderAddress: 'BOSS@corp.example' }),
        exposure({ senderAddress: 'old@x.example', exposedAt: at(THREAD_SENDER_TAINT_WINDOW_MS) }),
        exposure({ senderAddress: 't1@x.example', level: 'T1' }),
      ],
      now,
    );
    expect(result).toEqual(['attacker@evil.example', 'boss@corp.example']);
  });
});

// ---------------------------------------------------------------------------
// 음성 코퍼스 — T2 = 0
// ---------------------------------------------------------------------------

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'injection');

function load(path: string): InjectionScanInput {
  const content = readFileSync(path, 'utf8');
  if (!path.endsWith('.json')) return { subject: null, text: content, htmlText: null };
  const value = JSON.parse(content) as { subject?: string | null; text: string; htmlText?: string | null; attachmentNames?: (string | null)[] };
  return { subject: value.subject ?? null, text: value.text, htmlText: value.htmlText ?? null, attachmentNames: value.attachmentNames ?? [] };
}

function taintOfMail(path: string): 'T0' | 'T1' | 'T2' {
  const scan = scanForInjection(load(path));
  return classifyTaint({
    ...base,
    injectionRisk: scan.injectionRisk,
    findings: scan.findings.map((f) => ({ family: f.family, damped: f.damped })),
  });
}

describe('음성 코퍼스 위의 오염 분류', () => {
  it('판정 — 소진된 v1 봉인 세트 benign 30통: T2 = 0', () => {
    const labels = JSON.parse(readFileSync(join(FIXTURES, 'consumed', 'v1', 'labels.json'), 'utf8')) as {
      cases: { file: string; label: string }[];
    };
    const benign = labels.cases.filter((c) => c.label === 'benign');
    expect(benign).toHaveLength(30);
    const levels = benign.map((c) => [c.file, taintOfMail(join(FIXTURES, 'consumed', 'v1', c.file))] as const);
    expect(levels.filter(([, level]) => level === 'T2')).toEqual([]);
    // 비공허성 — 분류가 실제로 low 를 보고 있다(T1 이 0 이면 스캐너 결과를 안 읽은 것일 수 있다).
    expect(levels.filter(([, level]) => level === 'T1').length).toBeGreaterThan(0);
  });

  it('참고 — dev 음성 165통(v3 에서 다국어 워크로드 1·경계 72통 · 2026-10-08 서술형·인코딩 경계 22통 추가 — 보안 리뷰·재검증 경계 포함): 워크로드 1 은 T2 = 0, 경계 음성의 T2 는 이 셋뿐이다', () => {
    const labels = JSON.parse(readFileSync(join(FIXTURES, 'dev', 'labels.json'), 'utf8')) as Record<string, { label: string }>;
    const negatives = Object.entries(labels)
      .filter(([, l]) => l.label === 'negative')
      .map(([file]) => file);
    expect(negatives).toHaveLength(165);
    const t2 = negatives.filter((file) => taintOfMail(join(FIXTURES, 'dev', file)) === 'T2').sort();
    expect(t2.filter((file) => file.startsWith('negative/wl1-'))).toEqual([]);
    expect(t2).toEqual([
      'negative/edge-approve-reminder.txt',
      'negative/edge-coworker-results.txt',
      'negative/edge-search-inbox.txt',
    ]);
  });
});
