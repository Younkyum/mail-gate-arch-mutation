/**
 * 멱등 키 차분 퍼즈 — **(유도 키 같음) ⇔ (라우트 request_hash 같음)** 을 발송 도구 셋에서 (`src/mcp/tools.ts` 판단 ③).
 *
 * 키는 **도구를 실제로 불러서** 얻는다(가짜 라우트 칸이 받은 `idempotency-key` 헤더) — 뷰 함수만 부르면 `run` 이 뷰에
 * 무엇을 넘기는지(전달의 원 제목 읽기 등)를 건너뛴다. 난수는 시드 고정(mulberry32) — 빨강이 재현된다.
 * 해시 쪽은 라우트의 파서(`parseSendBody`·`parseReplyBody`)·`hashOutboundRequest`·`replySubject` 를 그대로 쓰고, 라우트가
 * 파서 뒤에 하는 해석(전달의 `forwardedSubject`·`forwardedText`, 회신의 기본 수신자·제목)만 옮겨 적었다. 전달 모델이
 * 실제 라우트와 같은지는 `test/integration/mcp/mcp-server.test.ts` 의 L2 사례가 실제 라우트·DB 로 본다.
 *
 * ★ L2(검증에서 증명된 틈): 전달에서 `subject` 를 기본값(`Fwd: <원 제목>`)과 똑같이 적은 호출과 생략한 호출은 해시가
 *   같은데 키가 달랐다. (되돌리기: `forwardKeyView` 의 접기를 빼면 `forward SAME HASH DIFF KEY` → 빨강)
 */

import { describe, expect, it } from 'vitest';

import { hashOutboundRequest } from '../../../src/api/outbound-store';
import { parseReplyBody, parseSendBody } from '../../../src/api/outbound-http';
import { MAX_SUBJECT_LENGTH } from '../../../src/api/outbound-service';
import { replySubject } from '../../../src/api/routes/reply';
import type { ApiRequest, ApiResponse } from '../../../src/api/http';
import { callTool, findTool, forwardDefaultSubject, type McpDependencies, type ToolContext } from '../../../src/mcp/tools';

const AGENT = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
const MID = '11111111-2222-4333-8444-555555555555';
const PRIMARY = 'bot@atmark.ai';
const SENDER = 'sender@ext.com';

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const froms = [undefined, PRIMARY, ` ${PRIMARY}`, `${PRIMARY} `];
const tos = [['a@x.com'], [' a@x.com'], ['a@x.com', 'b@y.com'], ['b@y.com', 'a@x.com'], ['A@x.com'], ['a@x.com', 'a@x.com'], ['a@x.com\u200B']];
const subjects = ['Hi', 'Hi ', ' Hi', 'Hi\r\n', '\uFF28i', 'Re: Orig', 'Re: orig', '', '   ', 'x'.repeat(1000), 'x'.repeat(999)];
const texts = ['body', 'body ', 'body\r\n', 'body\n', 'é', 'e\u0301'];
const htmls = [undefined, null, '', '<b>x</b>'];
const notes = [undefined, '', ' ', '\n', 'n', 'n '];
/** 전달 원 메일의 제목 — 없음·빈·앞뒤 공백·긴 것(998자에서 잘리는 기본 제목)까지. */
const originals: readonly (string | null)[] = [null, '', 'Orig', ' Orig ', 'y'.repeat(1000)];

/** 전달 제목 후보 — 기본 제목과 같은 것·거의 같은 것(공백·대소문자·잘림 경계). */
function forwardSubjects(original: string | null): readonly (string | undefined)[] {
  const fallback = forwardDefaultSubject(original);
  return [undefined, ...subjects, fallback, `${fallback} `, ` ${fallback}`, fallback.toLowerCase(), `${fallback}zzzz`, 'Fwd:', 'Fwd: ', 'Fwd:  Orig'];
}

interface Captured {
  key: string | null;
}

function ports(capture: Captured, original: string | null): McpDependencies {
  const record = (request: ApiRequest): Promise<ApiResponse> => {
    capture.key = request.headers['idempotency-key'] ?? null;
    return Promise.resolve({ status: 200, body: { message_id: 'm', replayed: false } });
  };
  const unused = (): never => {
    throw new Error('이 퍼즈에서 쓰지 않는 칸');
  };
  return {
    authenticate: unused,
    send: record,
    reply: (request) => record(request),
    findReplyTarget: () =>
      Promise.resolve({
        inboundMessageId: MID,
        threadId: '99999999-9999-4999-8999-999999999999',
        fromAddress: SENDER,
        fromAuthenticated: true,
        subject: 'Orig',
        messageIdHeader: null,
        inReplyTo: null,
        quarantined: false,
        // 라우트의 `from` 생략 기본값(받은 주소가 활성이면 그것, 아니면 대표 — 메일 기본기 2차). 이 퍼즈는 대표로 받은 메일이다.
        defaultFromAddress: PRIMARY,
      } as never),
    forward: (request) => record(request),
    forwardOriginal: () => Promise.resolve({ subject: original }),
    listInbox: unused,
    readEmail: unused,
    getThread: unused,
    getAttachment: unused,
    readAttachment: unused,
    getApproval: unused,
    getAgentPolicy: unused,
    sendingAddresses: () => Promise.resolve([{ address: PRIMARY, isPrimary: true }]),
    verificationCode: unused,
    listScheduled: unused,
    cancelScheduled: unused,
    listWebhooks: unused,
    createWebhook: unused,
    deleteWebhook: unused,
    listWebhookDeliveries: unused,
    redeliverWebhook: unused,
    createDraft: unused,
    listDrafts: unused,
    getDraft: unused,
    updateDraft: unused,
    discardDraft: unused,
    sendDraft: unused,
    setLabels: unused,
    listLabels: unused,
    getCapabilities: unused,
    createAgent: unused,
    getRealtimeConnection: unused,
    requestPolicyChange: unused,
    getPolicyRequest: unused,
  };
}

async function keyOf(tool: string, args: Record<string, unknown>, original: string | null = null): Promise<string | null> {
  const capture: Captured = { key: null };
  const context: ToolContext = {
    deps: ports(capture, original),
    principal: { agentId: AGENT as never, capabilities: ['messages:send', 'messages:read'] },
    authorization: 'Bearer x',
  };
  const definition = findTool(tool);
  if (definition === undefined) throw new Error(tool);
  const outcome = await callTool(definition, context, args);
  return outcome.httpStatus === null ? null : capture.key;
}

// ---- 라우트가 해시하는 값(모델) ----

function sendHash(body: Record<string, unknown>): string | null {
  const parsed = parseSendBody(body);
  if (parsed.kind === 'error') return null;
  const v = parsed.value;
  if (v.recipients.length === 0 || v.subject.trim() === '' || v.subject.length > MAX_SUBJECT_LENGTH) return null;
  return hashOutboundRequest({ routeId: 'send', fromAddress: v.fromAddress, recipients: v.recipients, subject: v.subject, text: v.text, html: v.html, inReplyTo: null });
}

function replyHash(body: Record<string, unknown>): string | null {
  const parsed = parseReplyBody(body);
  if (parsed.kind === 'error') return null;
  const v = parsed.value;
  const subject = v.subject ?? replySubject('Orig');
  if (subject === null || subject.trim() === '' || subject.length > MAX_SUBJECT_LENGTH) return null;
  return hashOutboundRequest({
    routeId: 'reply',
    fromAddress: v.fromAddress ?? PRIMARY,
    recipients: v.recipients ?? [SENDER],
    subject,
    text: v.text,
    html: v.html,
    inReplyTo: MID,
  });
}

/** `routes/forward.ts` 의 `forwardedSubject`·`forwardedText` 를 옮긴 것(원문 블록은 원 메일마다 고정이라 상수). */
function forwardHash(body: Record<string, unknown>, original: string | null): string | null {
  const parsed = parseSendBody({ ...body, subject: body['subject'] ?? '', text: body['text'] ?? '' });
  if (parsed.kind === 'error') return null;
  const v = parsed.value;
  const subject = (v.subject.trim() !== '' ? v.subject : `Fwd: ${original ?? ''}`.trim()).slice(0, MAX_SUBJECT_LENGTH);
  const block = `ORIGINAL(${original ?? ''})`;
  const text = v.text.trim() === '' ? block : `${v.text}\n\n${block}`;
  return hashOutboundRequest({ routeId: 'forward', fromAddress: v.fromAddress, recipients: v.recipients, subject, text, html: null, inReplyTo: null });
}

// ---- 판정 ----

interface Sample {
  readonly key: string;
  readonly hash: string;
  readonly args: string;
}

function violationsOf(samples: readonly Sample[]): string[] {
  const byKey = new Map<string, Sample>();
  const byHash = new Map<string, Sample>();
  const out = new Set<string>();
  for (const sample of samples) {
    const k = byKey.get(sample.key);
    if (k !== undefined && k.hash !== sample.hash) out.add(`SAME KEY DIFF HASH: ${k.args} vs ${sample.args}`);
    byKey.set(sample.key, sample);
    const h = byHash.get(sample.hash);
    if (h !== undefined && h.key !== sample.key) out.add(`SAME HASH DIFF KEY: ${h.args} vs ${sample.args}`);
    byHash.set(sample.hash, sample);
  }
  return [...out].map((line) => line.slice(0, 400));
}

const ITERATIONS = 6_000;

function strip<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

describe('★ 멱등 키 차분 퍼즈 — (유도 키 같음) ⇔ (라우트 해시 같음), 위반 0', () => {
  it('send_email', async () => {
    const pick = mulberry32(1);
    const one = <T>(values: readonly T[]): T => values[Math.floor(pick() * values.length)] as T;
    const samples: Sample[] = [];
    for (let i = 0; i < ITERATIONS; i += 1) {
      const args = strip({ from: one(froms), to: one(tos), subject: one(subjects), text: one(texts), html: one(htmls) });
      const key = await keyOf('send_email', args);
      const hash = sendHash({ agent_id: AGENT, ...args, from: args.from ?? PRIMARY });
      if (key !== null && hash !== null) samples.push({ key, hash, args: JSON.stringify(args) });
    }
    expect(samples.length).toBeGreaterThan(ITERATIONS / 2); // 비공허성 — 대부분 라우트가 받는 본문이다
    expect(violationsOf(samples)).toEqual([]);
  });

  it('reply_email — 기본 수신자·Re: 제목까지', async () => {
    const pick = mulberry32(2);
    const one = <T>(values: readonly T[]): T => values[Math.floor(pick() * values.length)] as T;
    const samples: Sample[] = [];
    for (let i = 0; i < ITERATIONS; i += 1) {
      const args = strip({
        message_id: one([MID, MID.toUpperCase(), ` ${MID}`]),
        from: one(froms),
        text: one(texts),
        html: one(htmls),
        to: one([undefined, [SENDER], [` ${SENDER}`], ['a@x.com']]),
        subject: one([undefined, 'Re: Orig', 'Re:  Orig', 'Hi', '']),
      });
      const key = await keyOf('reply_email', args);
      const hash = replyHash({ agent_id: AGENT, ...args, from: args.from ?? PRIMARY, in_reply_to: MID, to: args.to ?? null, subject: args.subject ?? null });
      if (key !== null && hash !== null) samples.push({ key, hash, args: JSON.stringify(args) });
    }
    expect(samples.length).toBeGreaterThan(ITERATIONS / 2);
    expect(violationsOf(samples)).toEqual([]);
  });

  it('★ forward_email — 기본 제목을 명시한 호출과 생략한 호출은 같은 키(L2) · 원 제목마다', async () => {
    let folded = 0;
    for (const [index, original] of originals.entries()) {
      const pick = mulberry32(10 + index);
      const one = <T>(values: readonly T[]): T => values[Math.floor(pick() * values.length)] as T;
      const samples: Sample[] = [];
      for (let i = 0; i < ITERATIONS; i += 1) {
        const args = strip({ message_id: MID, from: one(froms), to: one(tos), note: one(notes), subject: one(forwardSubjects(original)) });
        const key = await keyOf('forward_email', args, original);
        const hash = forwardHash({ agent_id: AGENT, from: args.from ?? PRIMARY, to: args.to, text: args.note ?? '', subject: args.subject ?? '' }, original);
        if (key !== null && hash !== null) samples.push({ key, hash, args: JSON.stringify(args) });
        if (args.subject === forwardDefaultSubject(original)) folded += 1;
      }
      expect(samples.length).toBeGreaterThan(ITERATIONS / 2);
      expect([String(original).slice(0, 20), violationsOf(samples)]).toEqual([String(original).slice(0, 20), []]);
    }
    expect(folded).toBeGreaterThan(100); // 비공허성 — 기본 제목을 명시한 호출이 실제로 섞였다
  });

  it('★ forward_email — 기본 제목과 같을 수 없는 제목은 원 메일을 읽지 않는다(Fwd: 로 시작할 때만)', async () => {
    let reads = 0;
    const capture: Captured = { key: null };
    const base = ports(capture, 'Orig');
    const deps: McpDependencies = {
      ...base,
      forwardOriginal: (...args) => {
        reads += 1;
        return base.forwardOriginal(...args);
      },
    };
    const context: ToolContext = { deps, principal: { agentId: AGENT as never, capabilities: ['messages:send'] }, authorization: 'Bearer x' };
    const tool = findTool('forward_email');
    if (tool === undefined) throw new Error('forward_email');
    await callTool(tool, context, { message_id: MID, to: ['a@x.com'], subject: 'Hello' });
    await callTool(tool, context, { message_id: MID, to: ['a@x.com'] });
    expect(reads).toBe(0);
    await callTool(tool, context, { message_id: MID, to: ['a@x.com'], subject: 'Fwd: Orig' });
    expect(reads).toBe(1);
  });

  it('forwardDefaultSubject 는 라우트의 기본 제목 규칙이다(trim 뒤 998자 절단)', () => {
    expect(forwardDefaultSubject(null)).toBe('Fwd:');
    expect(forwardDefaultSubject(' Orig ')).toBe('Fwd:  Orig');
    expect(forwardDefaultSubject('y'.repeat(1000))).toHaveLength(MAX_SUBJECT_LENGTH);
  });
});
