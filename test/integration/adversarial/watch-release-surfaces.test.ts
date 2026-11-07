/**
 * 적대적 검증 A-2 (에이전트 읽기 표면) — 숨은 메일이 모든 읽기 면에서 없다가, 풀린 뒤에는 모든 면에서 보이고 T2 로 센다.
 * 시도 하나 = (면 × 숨김 종류). 면: 목록 · 목록 필터 셋 · since · 상세 · 스레드 · 첨부 URL · 첨부 내용 · 인증 코드 두 모드 · 격리 개수.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { handleGetInboundAttachment, handleGetInboundAttachmentContent } from '../../../src/api/routes/attachments';
import { handleGetInboundMessage, handleListInboundMessages } from '../../../src/api/routes/inbound-messages';
import { handleGetThread } from '../../../src/api/routes/threads';
import { handleGetVerificationCode } from '../../../src/api/routes/verification-code';
import { closeTestPool } from '../db/support/harness';
import { adminFixture, adminWorld, authed, call, closeAdminWorld, type AdminFixture, type AdminWorld } from './watch-admin-support';
import { exposureLevels, fakeScanner, get, INJECTION, OWNER_AVAILABLE, receiveInto, RISKY, setAgent, tokenFor, webhookCount, withWebhook, worldOf, type World } from './watch-support';

let w: AdminWorld;
beforeAll(() => {
  if (OWNER_AVAILABLE) w = adminWorld();
});
afterAll(async () => {
  if (OWNER_AVAILABLE) {
    await closeAdminWorld(w);
    await closeTestPool();
  }
});

type Kind = 'injection_risk' | 'risk_hold';
interface Snapshot {
  list: unknown;
  listFrom: unknown;
  listDomain: unknown;
  listThread: unknown;
  listSince: unknown;
  detail: { status: number; body: Record<string, unknown> };
  thread: { status: number; body: Record<string, unknown> };
  attUrl: { status: number; body: Record<string, unknown> };
  attContent: { status: number; body: Record<string, unknown> };
  vcVerified: { status: number; body: Record<string, unknown> };
  vcCandidates: { status: number; body: Record<string, unknown> };
}
interface Scenario {
  f: AdminFixture;
  world: World;
  id: string;
  threadId: string;
  pre: Snapshot;
  post: Snapshot;
  webhooksBefore: number;
  webhooksAfter: number;
  quarantinedBefore: number;
  quarantinedAfter: number;
  newerCleanId: string;
  exposures: { part: string; level: number }[];
}

const FROM = 'security@service.example';
const T0 = Date.now();
const HELD_AT = new Date(T0 - 120_000).toISOString();
const CLEAN_AT = new Date(T0 - 60_000).toISOString();
const SINCE = new Date(T0 - 90_000).toISOString();

async function snapshot(world: World, id: string, threadId: string): Promise<Snapshot> {
  const t = world.token;
  const agent = world.fixture.agentId;
  const list = (query: Record<string, string>) => handleListInboundMessages(world.deps, get(t, { agent_id: agent, ...query }));
  const bodyOf = (r: { status: number; body: Record<string, unknown> }) => r;
  return {
    list: (await list({})).body,
    listFrom: (await list({ from: FROM })).body,
    listDomain: (await list({ from_domain: 'service.example' })).body,
    listThread: (await list({ thread_id: threadId })).body,
    listSince: (await list({ since: SINCE })).body,
    detail: bodyOf(await handleGetInboundMessage(world.deps, get(t), { inboundMessageId: id })),
    thread: bodyOf(await handleGetThread(world.deps, get(t), { threadId })),
    attUrl: bodyOf(await handleGetInboundAttachment(world.deps, get(t), { inboundMessageId: id, index: '0' })),
    attContent: bodyOf(await handleGetInboundAttachmentContent(world.deps, get(t), { inboundMessageId: id, index: '0' })),
    vcVerified: bodyOf(await handleGetVerificationCode(world.deps, get(t, { agent_id: agent, sender_domain: 'service.example', since: new Date(T0 - 600_000).toISOString() }))),
    vcCandidates: bodyOf(await handleGetVerificationCode(world.deps, get(t, { agent_id: agent, since: new Date(T0 - 600_000).toISOString() }))),
  };
}

async function build(kind: Kind): Promise<Scenario> {
  const f = await adminFixture(w);
  const world = await worldOf({ organizationId: f.orgId, agentId: f.agentId as never, address: f.address, policyVersionId: '' });
  await withWebhook(f);
  if (kind === 'risk_hold') await setAgent(f, 'hold', null);
  const scanner = kind === 'injection_risk' ? fakeScanner('high', INJECTION).scan : fakeScanner('low', RISKY).scan;
  const held = await receiveInto(world, scanner, { from: FROM, receivedAt: HELD_AT });
  expect(held.row.quarantined).toBe(true);
  // 더 늦게 온 깨끗한 메일 — 에이전트가 이 시각을 `since` 로 폴링한다.
  const clean = await receiveInto(world, fakeScanner('none', []).scan, { from: 'news@other.example', subject: 'weekly newsletter', text: 'hello', receivedAt: CLEAN_AT });
  const pre = await snapshot(world, held.row.id, held.row.thread_id);
  const quarantinedBefore = ((pre.list as { quarantined: { count: number } }).quarantined).count;
  const webhooksBefore = await webhookCount(held.row.id);
  const released = await call(w.deps, 'POST', `/api/watch/held/${held.row.id}/release`, authed(f.session, { body: {} }));
  expect(released.statusCode, released.body).toBe(200);
  const post = await snapshot(world, held.row.id, held.row.thread_id);
  return {
    f,
    world,
    id: held.row.id,
    threadId: held.row.thread_id,
    pre,
    post,
    webhooksBefore,
    webhooksAfter: await webhookCount(held.row.id),
    quarantinedBefore,
    quarantinedAfter: ((post.list as { quarantined: { count: number } }).quarantined).count,
    newerCleanId: clean.row.id,
    exposures: await exposureLevels(f.agentId, held.row.id),
  };
}

const idsOf = (list: unknown): string[] => ((list as { messages: { id: string }[] }).messages ?? []).map((m) => m.id);

describe.skipIf(!OWNER_AVAILABLE).each(['injection_risk', 'risk_hold'] as const)('A-2 읽기 표면 — 숨김 종류 %s', (kind) => {
  let s: Scenario;
  const tag = kind === 'injection_risk' ? 'I' : 'H';
  beforeAll(async () => {
    s = await build(kind);
  });

  // --- 풀기 전: 모든 면에 없다 ---
  it(`[S-${tag}01] 풀기 전 목록에 id 가 없다`, () => {
    expect(idsOf(s.pre.list)).not.toContain(s.id);
  });
  it(`[S-${tag}02] 풀기 전 발신자 필터 목록에 없다`, () => {
    expect(idsOf(s.pre.listFrom)).toEqual([]);
  });
  it(`[S-${tag}03] 풀기 전 도메인 필터 목록에 없다`, () => {
    expect(idsOf(s.pre.listDomain)).toEqual([]);
  });
  it(`[S-${tag}04] 풀기 전 스레드 필터 목록에 없다`, () => {
    expect(idsOf(s.pre.listThread)).toEqual([]);
  });
  it(`[S-${tag}05] 풀기 전 since 목록에 없다`, () => {
    expect(idsOf(s.pre.listSince)).not.toContain(s.id);
  });
  it(`[S-${tag}06] 풀기 전 상세는 없는 id 와 같은 404`, () => {
    expect(s.pre.detail.status).toBe(404);
    expect(s.pre.detail.body['error']).toBe('message_not_found');
  });
  it(`[S-${tag}07] 풀기 전 스레드는 404`, () => {
    expect(s.pre.thread.status).toBe(404);
  });
  it(`[S-${tag}08] 풀기 전 첨부 URL 404`, () => {
    expect(s.pre.attUrl.status).toBe(404);
  });
  it(`[S-${tag}09] 풀기 전 첨부 내용 404`, () => {
    expect(s.pre.attContent.status).toBe(404);
  });
  it(`[S-${tag}10] 풀기 전 인증 코드(확정 모드)에 코드가 없다`, () => {
    expect(JSON.stringify(s.pre.vcVerified.body)).not.toContain('482913');
    expect(s.pre.vcVerified.status).toBe(404);
  });
  it(`[S-${tag}11] 풀기 전 인증 코드(후보 모드)에 코드가 없다`, () => {
    expect(JSON.stringify(s.pre.vcCandidates.body)).not.toContain('482913');
  });
  it(`[S-${tag}12] 풀기 전 응답 어디에도 메일의 흔적(id · 발신 도메인 · 제목 · 코드)이 없다`, () => {
    const lists = JSON.stringify([s.pre.list, s.pre.listFrom, s.pre.listDomain, s.pre.listThread, s.pre.listSince, s.pre.vcVerified, s.pre.vcCandidates]);
    for (const needle of [s.id, 'security@service.example', 'Your verification code', '482913']) expect(lists, needle).not.toContain(needle);
    // 404 오류 문장은 요청한 id 를 되풀이할 수 있다(요청자가 준 값). 그 밖의 흔적은 없어야 한다.
    const errors = JSON.stringify([s.pre.detail, s.pre.thread, s.pre.attUrl, s.pre.attContent]);
    for (const needle of ['security@service.example', 'Your verification code', '482913']) expect(errors, needle).not.toContain(needle);
  });
  it(`[S-${tag}13] 풀기 전 격리 개수는 숨은 메일을 개수로만 센다`, () => {
    expect(s.quarantinedBefore).toBe(1);
  });
  it(`[S-${tag}14] 풀기 전 웹훅은 한 건도 없다`, () => {
    expect(s.webhooksBefore).toBe(0);
  });

  // --- 풀린 뒤: 모든 면에 보인다 ---
  it(`[S-${tag}15] 풀린 뒤 목록에 보인다`, () => {
    expect(idsOf(s.post.list)).toContain(s.id);
  });
  it(`[S-${tag}16] 풀린 뒤 발신자 필터 목록에 보인다`, () => {
    expect(idsOf(s.post.listFrom)).toEqual([s.id]);
  });
  it(`[S-${tag}17] 풀린 뒤 도메인 필터 목록에 보인다`, () => {
    expect(idsOf(s.post.listDomain)).toEqual([s.id]);
  });
  it(`[S-${tag}18] 풀린 뒤 스레드 필터 목록에 보인다`, () => {
    expect(idsOf(s.post.listThread)).toEqual([s.id]);
  });
  it(`VULN: [S-${tag}19] 풀린 뒤 since(마지막으로 본 시각) 폴링에도 보인다 — 풀린 메일은 received_at 이 과거라 놓친다`, () => {
    expect(idsOf(s.post.listSince)).toContain(s.id);
  });
  it(`[S-${tag}20] 풀린 뒤 상세 200, 본문 포함`, () => {
    expect(s.post.detail.status).toBe(200);
    expect(JSON.stringify(s.post.detail.body)).toContain('482913');
  });
  it(`[S-${tag}21] 풀린 뒤 스레드 200`, () => {
    expect(s.post.thread.status).toBe(200);
    expect(JSON.stringify(s.post.thread.body)).toContain(s.id);
  });
  it(`[S-${tag}22] 풀린 뒤 첨부 URL 200`, () => {
    expect(s.post.attUrl.status).toBe(200);
  });
  it(`[S-${tag}23] 풀린 뒤 첨부 내용 200`, () => {
    expect(s.post.attContent.status).toBe(200);
  });
  it(`[S-${tag}24] 풀린 뒤 인증 코드(확정 모드)가 나온다`, () => {
    expect(s.post.vcVerified.status).toBe(200);
    expect(JSON.stringify(s.post.vcVerified.body)).toContain('482913');
  });
  it(`[S-${tag}25] 풀린 뒤 격리 개수는 0`, () => {
    expect(s.quarantinedAfter).toBe(0);
  });
  it(`[S-${tag}26] 풀린 뒤 웹훅은 정확히 한 건`, () => {
    expect(s.webhooksAfter).toBe(1);
  });
  // --- 노출은 모든 부분이 T2 ---
  it(`[S-${tag}27] 풀린 메일의 노출 기록이 있다(상세 · 목록 제목 · 첨부 · 코드)`, () => {
    expect(s.exposures.map((e) => e.part).sort()).toEqual(expect.arrayContaining(['body', 'subject', 'attachment:0']));
  });
  it(`[S-${tag}28] 노출 기록의 모든 부분이 T2 (level 2)`, () => {
    expect(s.exposures.length).toBeGreaterThan(0);
    for (const e of s.exposures) expect(e.level, e.part).toBe(2);
  });
  it(`[S-${tag}29] 인증 코드 노출(verification_code)도 T2`, () => {
    const codePart = s.exposures.find((e) => e.part === 'verification_code');
    expect(codePart, '인증 코드 노출 행').toBeDefined();
    expect(codePart?.level).toBe(2);
  });
  it(`[S-${tag}30] 풀린 뒤 같은 목록의 다른 깨끗한 메일 노출은 T2 로 오르지 않는다(풀린 메일만 T2)`, async () => {
    const levels = await exposureLevels(s.f.agentId, s.newerCleanId);
    for (const e of levels) expect(e.level, e.part).toBeLessThan(2);
  });
  it(`[S-${tag}31] 에이전트는 quarantined 필터로 숨은 메일을 요청할 수 없다`, async () => {
    const r = await handleListInboundMessages(s.world.deps, get(s.world.token, { agent_id: s.f.agentId, quarantined: 'true' }));
    expect(r.status).toBe(400);
  });
  it(`[S-${tag}32] 다른 에이전트 토큰으로 풀린 메일 상세 → 403`, async () => {
    const other = await adminFixture(w);
    const token = await tokenFor(other.agentId as never);
    const r = await handleGetInboundMessage(s.world.deps, get(token), { inboundMessageId: s.id });
    expect(r.status).toBe(403);
  });
});
