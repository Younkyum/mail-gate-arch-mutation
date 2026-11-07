/**
 * 적대적 검증 A-2 (콘솔 API 단) — 보류 메일 풀기: 권한 · 상태 · 경합 · 웹훅 · 목록 누출 · ID 열거.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { messageReceivedEvent } from '../../../src/webhooks/events';
import { changePolicyOp, resolvePolicyChange } from '../../../src/admin/ops/policy';
import { closeTestPool } from '../db/support/harness';
import { adminFixture, adminWorld, asRole, authed, BODY_SENTINEL, call, closeAdminWorld, receiveAdmin, SUBJECT_SENTINEL, type AdminFixture, type AdminWorld } from './watch-admin-support';
import { cloneInbound, fakeScanner, INJECTION, OWNER_AVAILABLE, RISKY, setAgent, throwingScanner, webhookCount, withWebhook } from './watch-support';
import { appPool } from '../admin/support';

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

const releasePath = (id: string): string => `/api/watch/held/${id}/release`;
const release = (session: AdminFixture['session'], id: string, body: unknown = {}) => call(w.deps, 'POST', releasePath(id), authed(session, { body }));
const isHeld = async (id: string): Promise<boolean> => (await w.owner.query<{ quarantined: boolean }>('SELECT quarantined FROM inbound_messages WHERE id = $1', [id])).rows[0]?.quarantined === true;
const audits = async (orgId: string): Promise<number> =>
  (await w.owner.query(`SELECT 1 FROM owner_actions WHERE organization_id = $1 AND action = 'watch.release'`, [orgId])).rowCount ?? 0;

async function heldInjection(f: AdminFixture): Promise<string> {
  return (await receiveAdmin(f, fakeScanner('high', INJECTION).scan)).id;
}

describe.skipIf(!OWNER_AVAILABLE)('A-2 풀기 — 권한 · 경계', () => {
  it('[R-001] 멤버는 풀 수 없다 → 403, 여전히 숨음', async () => {
    const f = await adminFixture(w);
    const id = await heldInjection(f);
    expect((await release(await asRole(w, f, 'member'), id)).statusCode).toBe(403);
    expect(await isHeld(id)).toBe(true);
  });
  it('[R-002] 세션 없음 → 401', async () => {
    const f = await adminFixture(w);
    const id = await heldInjection(f);
    expect((await call(w.deps, 'POST', releasePath(id), { body: {} })).statusCode).toBe(401);
    expect(await isHeld(id)).toBe(true);
  });
  it('[R-003] CSRF 헤더 없음 → 403', async () => {
    const f = await adminFixture(w);
    const id = await heldInjection(f);
    expect((await call(w.deps, 'POST', releasePath(id), { cookies: f.session.cookies, body: {} })).statusCode).toBe(403);
    expect(await isHeld(id)).toBe(true);
  });
  it('[R-004] CSRF 헤더 틀림 → 403', async () => {
    const f = await adminFixture(w);
    const id = await heldInjection(f);
    expect((await call(w.deps, 'POST', releasePath(id), { cookies: f.session.cookies, headers: { 'x-atmark-csrf': 'nope' }, body: {} })).statusCode).toBe(403);
  });
  it('[R-005] 에이전트 토큰(Bearer)은 세션 라우트에 못 닿는다 → 401', async () => {
    const f = await adminFixture(w);
    const id = await heldInjection(f);
    expect((await call(w.deps, 'POST', releasePath(id), { headers: { authorization: 'Bearer atk_x' }, body: {} })).statusCode).toBe(401);
    expect(await isHeld(id)).toBe(true);
  });
  it('[R-006] 다른 조직의 관리자(소유자)가 풀기 → 404 message_not_found, 숨음 유지', async () => {
    const a = await adminFixture(w);
    const b = await adminFixture(w);
    const id = await heldInjection(a);
    const r = await release(b.session, id);
    expect(r.statusCode).toBe(404);
    expect(r.json()).toMatchObject({ error: 'message_not_found' });
    expect(await isHeld(id)).toBe(true);
    expect(await audits(a.orgId)).toBe(0);
  });
  it('[R-007] ID 열거: 다른 조직의 숨은 메일과 아예 없는 id 의 응답이 같다', async () => {
    const a = await adminFixture(w);
    const b = await adminFixture(w);
    const id = await heldInjection(a);
    const other = await release(b.session, id);
    const missing = await release(b.session, randomUUID());
    expect([other.statusCode, other.body.replace(id, 'X')]).toEqual([missing.statusCode, missing.body]);
  });
  it('[R-008] 관리자 역할은 풀 수 있다(대조)', async () => {
    const f = await adminFixture(w);
    const id = await heldInjection(f);
    expect((await release(await asRole(w, f, 'admin'), id)).statusCode).toBe(200);
    expect(await isHeld(id)).toBe(false);
  });
  it('[R-009] 같은 조직 다른 에이전트의 메일도 조직 관리자는 푼다(조직 범위)', async () => {
    const f = await adminFixture(w);
    const second = await (await import('./watch-admin-support')).addAgent(w, f);
    const id = (await receiveAdmin(second, fakeScanner('high', INJECTION).scan)).id;
    expect((await release(f.session, id)).statusCode).toBe(200);
  });
  it('[R-010] 로그아웃된 세션 쿠키로 풀기 → 401', async () => {
    const f = await adminFixture(w);
    const id = await heldInjection(f);
    await call(w.deps, 'POST', '/api/logout', authed(f.session, { body: {} }));
    expect((await release(f.session, id)).statusCode).toBe(401);
    expect(await isHeld(id)).toBe(true);
  });
  it('[R-011] 풀기 경로에 GET 은 풀지 않는다', async () => {
    const f = await adminFixture(w);
    const id = await heldInjection(f);
    const r = await call(w.deps, 'GET', releasePath(id), authed(f.session));
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(await isHeld(id)).toBe(true);
  });
  it('[R-012] 풀기 경로에 PUT/DELETE/PATCH 는 풀지 않는다', async () => {
    const f = await adminFixture(w);
    const id = await heldInjection(f);
    for (const method of ['PUT', 'DELETE', 'PATCH']) {
      const r = await call(w.deps, method, releasePath(id), authed(f.session, { body: {} }));
      expect(r.statusCode, method).toBeGreaterThanOrEqual(400);
    }
    expect(await isHeld(id)).toBe(true);
  });
});

const BAD_IDS: [id: string, name: string, value: string][] = [
  ['R-013', '대문자 uuid', randomUUID().toUpperCase()],
  ['R-014', 'uuid 아님', 'not-a-uuid'],
  ['R-015', '하이픈 없는 32 hex', 'a'.repeat(32)],
  ['R-016', 'SQL 조각', "1' OR '1'='1"],
  ['R-017', '경로 탈출', '..%2F..%2Fetc'],
  ['R-018', 'uuid + 접미', `${randomUUID()}x`],
  ['R-019', 'uuid 앞 공백', ` ${randomUUID()}`],
  ['R-020', 'NIL uuid', '00000000-0000-0000-0000-000000000000'],
  ['R-021', '아주 긴 문자열', 'a'.repeat(5000)],
  ['R-022', '퍼센트 인코딩 uuid', randomUUID().replace(/-/g, '%2D')],
];

describe.skipIf(!OWNER_AVAILABLE)('A-2 풀기 — 잘못된 ID · 본문', () => {
  it.each(BAD_IDS.map((b) => [`[${b[0]}] ${b[1]} → 400/404, 아무 것도 풀리지 않음`, b[2]] as const))('%s', async (_t, value) => {
    const f = await adminFixture(w);
    const id = await heldInjection(f);
    const r = await release(f.session, value);
    expect([400, 404]).toContain(r.statusCode);
    expect(await isHeld(id)).toBe(true);
  });
  it.each([
    ['R-023', '비어 있지 않은 본문', { force: true }],
    ['R-024', '본문에 messageId 중복', { messageId: randomUUID() }],
    ['R-025', '본문이 배열', [1]],
    ['R-026', '본문이 문자열', 'release'],
  ] as const)('[%s] %s → 400, 풀리지 않음', async (_id, _name, body) => {
    const f = await adminFixture(w);
    const id = await heldInjection(f);
    expect((await release(f.session, id, body)).statusCode).toBe(400);
    expect(await isHeld(id)).toBe(true);
  });
});

describe.skipIf(!OWNER_AVAILABLE)('A-2 풀기 — 상태 · 경합 · 웹훅', () => {
  it('[R-027] 정책 차단 메일 → 409 release_policy_blocked, 숨음 유지', async () => {
    const f = await adminFixture(w);
    await changePolicyOp(w.owner, f.agentId as never, resolvePolicyChange({ inboundMode: 'none' }), 'adv');
    const id = (await receiveAdmin(f, fakeScanner('none', []).scan)).id;
    const r = await release(f.session, id);
    expect([r.statusCode, r.json()]).toEqual([409, expect.objectContaining({ error: 'release_policy_blocked' })]);
    expect(await isHeld(id)).toBe(true);
  });
  it('[R-028] 정책 차단 + 인젝션 high 겹침 → 정책이 이긴다 → 409', async () => {
    const f = await adminFixture(w);
    await changePolicyOp(w.owner, f.agentId as never, resolvePolicyChange({ inboundMode: 'none' }), 'adv');
    const id = (await receiveAdmin(f, fakeScanner('high', INJECTION).scan)).id;
    expect((await release(f.session, id)).json()).toMatchObject({ error: 'release_policy_blocked' });
  });
  it('[R-029] 스캐너 오류(판정 없음) → 409 release_not_scanned', async () => {
    const f = await adminFixture(w);
    const id = (await receiveAdmin(f, throwingScanner())).id;
    expect((await release(f.session, id)).json()).toMatchObject({ error: 'release_not_scanned' });
    expect(await isHeld(id)).toBe(true);
  });
  it('[R-030] 보이는 깨끗한 메일 → 409 message_not_held', async () => {
    const f = await adminFixture(w);
    const id = (await receiveAdmin(f, fakeScanner('none', []).scan)).id;
    expect((await release(f.session, id)).json()).toMatchObject({ error: 'message_not_held' });
  });
  it('[R-031] 전달 모드 위험 메일(이미 보임) → 409, 감사 없음, 웹훅 추가 없음', async () => {
    const f = await adminFixture(w);
    await withWebhook(f);
    const id = (await receiveAdmin(f, fakeScanner('low', RISKY).scan)).id;
    const before = await webhookCount(id);
    expect((await release(f.session, id)).json()).toMatchObject({ error: 'message_not_held' });
    expect(await webhookCount(id)).toBe(before);
    expect(await audits(f.orgId)).toBe(0);
  });
  it('[R-032] 이미 푼 메일 다시 풀기 → 200 replayed, 감사 1행 · 웹훅 1건 유지', async () => {
    const f = await adminFixture(w);
    await withWebhook(f);
    const id = await heldInjection(f);
    expect((await release(f.session, id)).json()).toMatchObject({ replayed: false });
    expect((await release(f.session, id)).json()).toMatchObject({ replayed: true });
    expect((await release(f.session, id)).json()).toMatchObject({ replayed: true });
    expect(await audits(f.orgId)).toBe(1);
    expect(await webhookCount(id)).toBe(1);
  });
  it('[R-033] 이미 푼 정책 차단 아님 메일을 풀린 뒤 정책이 바뀌어도 replayed 만(상태 유지)', async () => {
    const f = await adminFixture(w);
    const id = await heldInjection(f);
    await release(f.session, id);
    await changePolicyOp(w.owner, f.agentId as never, resolvePolicyChange({ inboundMode: 'none' }), 'adv');
    expect((await release(f.session, id)).json()).toMatchObject({ replayed: true });
  });
  it('[R-034] 경합: 같은 메일을 6번 동시에 → 정확히 한 번 released, 웹훅 1건 · 감사 1행', async () => {
    const f = await adminFixture(w);
    await withWebhook(f);
    const id = await heldInjection(f);
    const results = await Promise.all(Array.from({ length: 6 }, () => release(f.session, id)));
    const bodies = results.map((r) => r.json() as { replayed?: boolean });
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    expect(bodies.filter((b) => b.replayed === false)).toHaveLength(1);
    expect(await webhookCount(id)).toBe(1);
    expect(await audits(f.orgId)).toBe(1);
  });
  it('[R-035] 경합: 관리자 두 명이 동시에 → 한 번만', async () => {
    const f = await adminFixture(w);
    await withWebhook(f);
    const id = await heldInjection(f);
    const a1 = await asRole(w, f, 'admin');
    const a2 = await asRole(w, f, 'admin');
    const results = await Promise.all([release(a1, id), release(a2, id), release(f.session, id)]);
    expect(results.filter((r) => (r.json() as { replayed?: boolean }).replayed === false)).toHaveLength(1);
    expect(await webhookCount(id)).toBe(1);
  });
  it('[R-036] 웹훅: 켜진 엔드포인트마다 1건 · 구독 안 한 것/꺼진 것은 0건', async () => {
    const f = await adminFixture(w);
    await withWebhook(f);
    await withWebhook(f);
    await withWebhook(f, ['approval.resolved']);
    const disabled = await withWebhook(f);
    await w.owner.query(`UPDATE webhook_endpoints SET disabled_at = now() WHERE id = $1`, [disabled]);
    const id = await heldInjection(f);
    expect(await webhookCount(id)).toBe(0);
    await release(f.session, id);
    expect(await webhookCount(id)).toBe(2);
  });
  it('[R-037] 웹훅: 격리되어 받을 때는 한 건도 나가지 않는다', async () => {
    const f = await adminFixture(w);
    await withWebhook(f);
    const id = await heldInjection(f);
    expect(await webhookCount(id)).toBe(0);
  });
  it('[R-038] 웹훅: 위험 보류(risk_hold)도 받을 때 0건, 풀면 1건', async () => {
    const f = await adminFixture(w);
    await withWebhook(f);
    await setAgent(f, 'hold', null);
    const id = (await receiveAdmin(f, fakeScanner('low', RISKY).scan)).id;
    expect(await webhookCount(id)).toBe(0);
    expect((await release(f.session, id)).json()).toMatchObject({ releasedFrom: 'risk_hold', level: 'risk' });
    expect(await webhookCount(id)).toBe(1);
  });
  it('[R-039] 웹훅 본문에는 제목 · 본문 · 발신자가 없다(식별자와 시각뿐)', async () => {
    const f = await adminFixture(w);
    await withWebhook(f);
    const id = await heldInjection(f);
    await release(f.session, id);
    const body = (await w.owner.query<{ body: string }>(`SELECT body FROM webhook_deliveries WHERE dedupe_key = $1`, [`message.received:${id}`])).rows[0]?.body ?? '';
    expect(body).not.toContain(SUBJECT_SENTINEL);
    expect(body).not.toContain(BODY_SENTINEL);
    expect(body).not.toContain('mallory');
    expect(body).not.toContain('partner.example');
    expect(JSON.parse(body)).toMatchObject({ type: 'message.received', data: { message_id: id } });
  });
  it('[R-040] 감사 행은 바뀐 호출만: 실패한 풀기(409/404/403)는 감사 0', async () => {
    const f = await adminFixture(w);
    const unscanned = (await receiveAdmin(f, throwingScanner())).id;
    await release(f.session, unscanned);
    await release(f.session, randomUUID());
    await release(await asRole(w, f, 'member'), unscanned);
    expect(await audits(f.orgId)).toBe(0);
  });
  it('[R-041] 풀린 뒤 보류 목록에서 사라진다 · 다른 숨은 메일은 남는다', async () => {
    const f = await adminFixture(w);
    const a = await heldInjection(f);
    const b = await heldInjection(f);
    await release(f.session, a);
    const list = (await call(w.deps, 'GET', '/api/watch/held', authed(f.session))).json() as { items: { id: string }[] };
    expect(list.items.map((i) => i.id)).toEqual([b]);
  });
  it('[R-042] released_by 는 푼 사용자 · released_from 은 풀기 전 사유', async () => {
    const f = await adminFixture(w);
    const id = await heldInjection(f);
    await release(f.session, id);
    const row = (await w.owner.query<{ released_by: string | null; released_from: string | null; watch_level: string }>('SELECT released_by, released_from, watch_level FROM inbound_messages WHERE id = $1', [id])).rows[0];
    expect(row?.released_by).not.toBeNull();
    expect(row).toMatchObject({ released_from: 'injection_risk', watch_level: 'block' });
  });
});

describe.skipIf(!OWNER_AVAILABLE)('A-2 보류 목록 — 누출 · 쪽 나누기 · 열거', () => {
  let f: AdminFixture;
  let other: AdminFixture;
  let secretIds: string[] = [];
  beforeAll(async () => {
    if (!OWNER_AVAILABLE) return;
    f = await adminFixture(w);
    other = await adminFixture(w);
    await setAgent(f, 'hold', null);
    secretIds = [
      (await receiveAdmin(f, fakeScanner('high', INJECTION).scan, { from: 'topsecret.person@sensitive-domain.example', subject: 'TOPSECRET-SUBJECT', text: 'TOPSECRET-BODY' })).id,
      (await receiveAdmin(f, fakeScanner('low', RISKY).scan, { from: 'another.person@other-domain.example', subject: 'TOPSECRET-SUBJECT-2' })).id,
      (await receiveAdmin(f, throwingScanner(), { from: 'third.person@third-domain.example' })).id,
    ];
    await receiveAdmin(other, fakeScanner('high', INJECTION).scan, { from: 'othersecret@other-org.example', subject: 'OTHERORG-SUBJECT' });
  });

  const heldAs = async (role: 'owner' | 'admin' | 'member', query = '') => {
    const session = role === 'owner' ? f.session : await asRole(w, f, role);
    return call(w.deps, 'GET', '/api/watch/held', authed(session, { query }));
  };

  it.each([
    ['R-043', '제목', 'TOPSECRET-SUBJECT'],
    ['R-044', '둘째 제목', 'TOPSECRET-SUBJECT-2'],
    ['R-045', '본문', 'TOPSECRET-BODY'],
    ['R-046', '발신자 로컬파트 topsecret.person', 'topsecret.person'],
    ['R-047', '발신자 로컬파트 another.person', 'another.person'],
    ['R-048', '발신자 로컬파트 third.person', 'third.person'],
    ['R-049', '봉투 발신자 bounce@mail.example.com', 'bounce@'],
    ['R-050', '메시지 ID 헤더 형태 @Mail.Example', 'Mail.Example'],
    ['R-051', '에이전트 별칭 주소 로컬파트(수신 주소)', 'adv-'],
    ['R-052', '다른 조직의 제목', 'OTHERORG-SUBJECT'],
    ['R-053', '다른 조직의 발신 도메인', 'other-org.example'],
  ] as const)('[%s] 멤버의 보류 목록에 %s 이(가) 없다', async (_id, _name, needle) => {
    const r = await heldAs('member');
    expect(r.statusCode).toBe(200);
    if (needle === 'adv-') {
      // 에이전트 이름(adv/adv2)은 소유자가 지은 글자라 있어도 되지만, 수신 주소 로컬파트(adv-xxxx)는 없어야 한다.
      expect(r.body).not.toMatch(/adv-[0-9a-f]{8}@/);
    } else {
      expect(r.body).not.toContain(needle);
    }
  });
  it('[R-054] 항목에는 정해진 키만 있다(본문 · 제목 · 주소 칸 없음)', async () => {
    const items = ((await heldAs('member')).json() as { items: Record<string, unknown>[] }).items;
    expect(items.length).toBe(3);
    const allowed = new Set(['id', 'agentId', 'agentName', 'level', 'reason', 'families', 'injectionRisk', 'senderDomain', 'senderAuthenticated', 'receivedAt', 'releasable']);
    for (const item of items) for (const key of Object.keys(item)) expect(allowed.has(key), key).toBe(true);
  });
  it('[R-055] 목록은 이 조직의 숨은 메일만(다른 조직의 것 없음)', async () => {
    const items = ((await heldAs('owner')).json() as { items: { id: string }[] }).items;
    expect(items.map((i) => i.id).sort()).toEqual([...secretIds].sort());
  });
  it('[R-056] 다른 조직의 agentId 로 거르면 빈 목록(열거 불가)', async () => {
    const r = (await heldAs('owner', `agentId=${other.agentId}`)).json() as { items: unknown[] };
    expect(r.items).toEqual([]);
  });
  it('[R-057] 없는 agentId 도 빈 목록 — 다른 조직의 것과 응답 모양이 같다', async () => {
    const a = (await heldAs('owner', `agentId=${other.agentId}`)).json();
    const b = (await heldAs('owner', `agentId=${'0'.repeat(32)}`)).json();
    expect(a).toEqual(b);
  });
  const badQuery: [id: string, q: string][] = [
    ['R-058', 'limit=0'],
    ['R-059', 'limit=101'],
    ['R-060', 'limit=-1'],
    ['R-061', 'limit=1.5'],
    ['R-062', 'limit=abc'],
    ['R-063', 'limit=Infinity'],
    ['R-064', 'cursor=%%%'],
    ['R-065', `cursor=${Buffer.from('{}').toString('base64url')}`],
    ['R-066', `cursor=${Buffer.from(JSON.stringify({ t: 'not-a-date', i: randomUUID() })).toString('base64url')}`],
    ['R-067', `cursor=${Buffer.from(JSON.stringify({ t: new Date().toISOString(), i: "x'; DROP TABLE inbound_messages;--" })).toString('base64url')}`],
    ['R-068', `cursor=${Buffer.from(JSON.stringify({ t: new Date().toISOString(), i: randomUUID().toUpperCase() })).toString('base64url')}`],
    ['R-069', `cursor=${Buffer.from(JSON.stringify({ t: 5, i: randomUUID() })).toString('base64url')}`],
    ['R-070', `cursor=${Buffer.from(JSON.stringify([1, 2])).toString('base64url')}`],
    ['R-071', 'agentId=nope'],
    ['R-072', "agentId=' OR 1=1 --"],
    ['R-073', `agentId=${'A'.repeat(32)}`],
  ];
  it.each(badQuery.map((q) => [`[${q[0]}] 나쁜 쿼리 ${q[1].slice(0, 40)} → 400`, q[1]] as const))('%s', async (_t, q) => {
    expect((await heldAs('owner', q)).statusCode).toBe(400);
  });
  it('[R-074] 다른 조직 메일의 (시각,id)를 커서로 줘도 이 조직 항목만 돌려준다', async () => {
    const otherId = (await w.owner.query<{ id: string; received_at: Date }>(`SELECT id, received_at FROM inbound_messages WHERE agent_id = $1 LIMIT 1`, [other.agentId])).rows[0];
    const cursor = Buffer.from(JSON.stringify({ t: new Date(otherId?.received_at.getTime() ?? 0 + 1).toISOString(), i: otherId?.id })).toString('base64url');
    const items = ((await heldAs('owner', `cursor=${cursor}`)).json() as { items: { id: string }[] }).items;
    for (const item of items) expect(secretIds).toContain(item.id);
  });
  it('[R-075] 미래 시각 커서는 이 조직 항목만(누출 없음)', async () => {
    const cursor = Buffer.from(JSON.stringify({ t: '9999-12-31T00:00:00.000Z', i: randomUUID() })).toString('base64url');
    const items = ((await heldAs('owner', `cursor=${cursor}`)).json() as { items: { id: string }[] }).items;
    expect(items.map((i) => i.id).sort()).toEqual([...secretIds].sort());
  });
  it('[R-076] 쪽 나누기 limit=1 로 끝까지 돌면 모두 한 번씩만 나온다', async () => {
    const seen: string[] = [];
    let cursor = '';
    for (let i = 0; i < 6; i += 1) {
      const page = (await heldAs('owner', `limit=1${cursor === '' ? '' : `&cursor=${cursor}`}`)).json() as { items: { id: string }[]; nextCursor: string | null };
      seen.push(...page.items.map((x) => x.id));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    expect([...seen].sort()).toEqual([...secretIds].sort());
  });
  it('[R-077] 에이전트 토큰으로 보류 목록 → 401', async () => {
    expect((await call(w.deps, 'GET', '/api/watch/held', { headers: { authorization: 'Bearer atk_x' } })).statusCode).toBe(401);
  });
  it('[R-078] 세션 없는 보류 목록 → 401', async () => {
    expect((await call(w.deps, 'GET', '/api/watch/held')).statusCode).toBe(401);
  });
  it('[R-079] 판정 없음 항목은 releasable:false 로 드러난다', async () => {
    const items = ((await heldAs('owner')).json() as { items: { id: string; releasable: boolean; reason: string }[] }).items;
    expect(items.filter((i) => i.reason === 'scanner_error').every((i) => i.releasable === false)).toBe(true);
  });
  it('[R-080] 풀린 뒤 목록 응답에도 본문 · 제목이 없다', async () => {
    const g = await adminFixture(w);
    const id = (await receiveAdmin(g, fakeScanner('high', INJECTION).scan, { subject: 'AFTER-RELEASE-SUBJ' })).id;
    await release(g.session, id);
    const r = await call(w.deps, 'GET', '/api/watch/held', authed(g.session));
    expect(r.body).not.toContain('AFTER-RELEASE-SUBJ');
  });
});

describe.skipIf(!OWNER_AVAILABLE)('A-2 풀기 — DB 변조 · 정의자 함수 입력', () => {
  async function held(): Promise<{ f: AdminFixture; id: string }> {
    const f = await adminFixture(w);
    return { f, id: await heldInjection(f) };
  }
  const fn = (f: AdminFixture, id: string, user: string | null, eventId: string, body: string) =>
    w.admin.query('SELECT * FROM atmark_watch_release_inbound($1, $2, $3, $4, $5)', [f.orgId, id, user, eventId, body]);

  async function goodEvent(id: string): Promise<{ eventId: string; body: string; agentId: string; threadId: string; receivedAt: Date }> {
    const row = (await w.owner.query<{ agent_id: string; thread_id: string; received_at: Date }>('SELECT agent_id, thread_id, received_at FROM inbound_messages WHERE id = $1', [id])).rows[0];
    if (row === undefined) throw new Error('no row');
    const e = messageReceivedEvent({ agentId: row.agent_id, inboundMessageId: id, threadId: row.thread_id, receivedAt: row.received_at });
    return { eventId: e.eventId, body: e.body, agentId: row.agent_id, threadId: row.thread_id, receivedAt: row.received_at };
  }
  const mutate = (body: string, edit: (o: Record<string, unknown>) => void): string => {
    const o = JSON.parse(body) as Record<string, unknown>;
    edit(o);
    return JSON.stringify(o);
  };

  const BODY_TAMPERS: [id: string, name: string, edit: (o: Record<string, any>) => void][] = [
    ['R-081', 'type 을 다른 이벤트로', (o) => (o['type'] = 'approval.resolved')],
    ['R-082', 'agent_id 를 다른 에이전트로', (o) => (o['agent_id'] = 'f'.repeat(32))],
    ['R-083', 'data.message_id 를 다른 메일로', (o) => ((o['data'] as Record<string, unknown>)['message_id'] = randomUUID())],
    ['R-084', 'data.thread_id 를 다른 스레드로', (o) => ((o['data'] as Record<string, unknown>)['thread_id'] = randomUUID())],
    ['R-085', 'data 에 제목 필드 추가', (o) => ((o['data'] as Record<string, unknown>)['subject'] = 'leak')],
    ['R-086', '최상위에 필드 추가', (o) => (o['extra'] = 1)],
    ['R-087', 'created_at 변조', (o) => (o['created_at'] = '2000-01-01T00:00:00.000Z')],
    ['R-088', 'api_version 숫자', (o) => (o['api_version'] = 1)],
    ['R-089', 'api_version 제거', (o) => delete o['api_version']],
    ['R-090', 'id 를 다른 이벤트 id 로', (o) => (o['id'] = randomUUID())],
  ];
  it.each(BODY_TAMPERS.map((t) => [`[${t[0]}] 웹훅 본문 변조: ${t[1]} → 거부, 풀리지 않음`, t[2]] as const))('%s', async (_t, edit) => {
    const { f, id } = await held();
    const e = await goodEvent(id);
    await expect(fn(f, id, randomUUID(), e.eventId, mutate(e.body, edit))).rejects.toThrow(/웹훅 본문/);
    expect(await isHeld(id)).toBe(true);
  });
  it.each([
    ['R-091', '배열 본문', '[]'],
    ['R-092', 'JSON 아님', 'not json'],
    ['R-093', '빈 객체', '{}'],
    ['R-094', 'null', 'null'],
  ] as const)('[%s] 웹훅 본문이 %s → 거부', async (_id, _name, body) => {
    const { f, id } = await held();
    const e = await goodEvent(id);
    await expect(fn(f, id, randomUUID(), e.eventId, body)).rejects.toThrow();
    expect(await isHeld(id)).toBe(true);
  });
  it('[R-095] 사용자 NULL → 거부(익명 풀기 없음)', async () => {
    const { f, id } = await held();
    const e = await goodEvent(id);
    await expect(fn(f, id, null, e.eventId, e.body)).rejects.toThrow(/푼 사용자/);
    expect(await isHeld(id)).toBe(true);
  });
  it('[R-096] 대조: 올바른 본문이면 풀린다(위 거부가 하네스 오류가 아니다)', async () => {
    const { f, id } = await held();
    const e = await goodEvent(id);
    await fn(f, id, randomUUID(), e.eventId, e.body);
    expect(await isHeld(id)).toBe(false);
  });
  it('[R-097] 다른 조직 id 로 함수 호출 → not_found', async () => {
    const { id } = await held();
    const g = await adminFixture(w);
    const e = await goodEvent(id);
    const r = await w.admin.query<{ outcome: string }>('SELECT outcome FROM atmark_watch_release_inbound($1, $2, $3, $4, $5)', [g.orgId, id, randomUUID(), e.eventId, e.body]);
    expect(r.rows[0]?.outcome).toBe('not_found');
    expect(await isHeld(id)).toBe(true);
  });
  it('[R-098] 앱 롤은 풀기 함수를 호출할 수 없다', async () => {
    const { f, id } = await held();
    const e = await goodEvent(id);
    const app = appPool();
    try {
      await expect(app.query('SELECT * FROM atmark_watch_release_inbound($1, $2, $3, $4, $5)', [f.orgId, id, randomUUID(), e.eventId, e.body])).rejects.toThrow(/permission denied/);
    } finally {
      await app.end();
    }
  });
  it('[R-099] admin 롤은 inbound_messages 를 직접 UPDATE 할 수 없다', async () => {
    const { id } = await held();
    await expect(w.admin.query('UPDATE inbound_messages SET quarantined = false, quarantine_reason = NULL WHERE id = $1', [id])).rejects.toThrow(/permission denied/);
  });
  it('[R-100] 앱 롤은 격리를 직접 풀 수 없다', async () => {
    const { id } = await held();
    const app = appPool();
    try {
      await expect(app.query('UPDATE inbound_messages SET quarantined = false, quarantine_reason = NULL WHERE id = $1', [id])).rejects.toThrow();
    } finally {
      await app.end();
    }
    expect(await isHeld(id)).toBe(true);
  });
  it('[R-101] 소유자 롤도 풀기 칸 없이 격리만 끌 수 없다(가드 트리거)', async () => {
    const { id } = await held();
    await expect(w.owner.query('UPDATE inbound_messages SET quarantined = false, quarantine_reason = NULL WHERE id = $1', [id])).rejects.toThrow(/풀기/);
  });
  it('[R-102] 소유자 롤: 격리 사유만 injection_risk → risk_hold 로 바꾸기 금지', async () => {
    const { id } = await held();
    await expect(w.owner.query(`UPDATE inbound_messages SET quarantine_reason = 'risk_hold' WHERE id = $1`, [id])).rejects.toThrow();
  });
  it('[R-103] 풀린 메일을 다시 격리(quarantined=true)로 되돌리기 금지', async () => {
    const { f, id } = await held();
    await release(f.session, id);
    await expect(w.owner.query(`UPDATE inbound_messages SET quarantined = true, quarantine_reason = 'injection_risk' WHERE id = $1`, [id])).rejects.toThrow();
  });
  it('[R-104] 풀린 메일의 released_from 바꾸기 금지', async () => {
    const { f, id } = await held();
    await release(f.session, id);
    await expect(w.owner.query(`UPDATE inbound_messages SET released_from = 'risk_hold' WHERE id = $1`, [id])).rejects.toThrow();
  });
  it('[R-105] 풀린 메일의 released_by 지우기 금지', async () => {
    const { f, id } = await held();
    await release(f.session, id);
    await expect(w.owner.query(`UPDATE inbound_messages SET released_by = NULL WHERE id = $1`, [id])).rejects.toThrow();
  });
  it('[R-106] 정책 차단 메일에 풀기 칸을 직접 채워 보이게 하기 금지', async () => {
    const f = await adminFixture(w);
    await changePolicyOp(w.owner, f.agentId as never, resolvePolicyChange({ inboundMode: 'none' }), 'adv');
    const id = (await receiveAdmin(f, fakeScanner('none', []).scan)).id;
    await expect(
      w.owner.query(`UPDATE inbound_messages SET quarantined = false, quarantine_reason = NULL, released_at = now(), released_by = $2, released_from = 'injection_risk' WHERE id = $1`, [id, randomUUID()]),
    ).rejects.toThrow();
  });
  it('[R-107] 판정 없음 메일에 풀기 칸을 직접 채우기 금지', async () => {
    const f = await adminFixture(w);
    const id = (await receiveAdmin(f, throwingScanner())).id;
    await expect(
      w.owner.query(`UPDATE inbound_messages SET quarantined = false, quarantine_reason = NULL, released_at = now(), released_by = $2, released_from = 'injection_risk' WHERE id = $1`, [id, randomUUID()]),
    ).rejects.toThrow();
  });
  it('[R-108] 보이는 메일에 풀기 칸만 채우기 금지', async () => {
    const f = await adminFixture(w);
    const id = (await receiveAdmin(f, fakeScanner('none', []).scan)).id;
    await expect(w.owner.query(`UPDATE inbound_messages SET released_at = now(), released_by = $2, released_from = 'injection_risk' WHERE id = $1`, [id, randomUUID()])).rejects.toThrow();
  });
  it('[R-109] 복제 INSERT 로 풀린 칸을 채워 넣기 금지', async () => {
    const f = await adminFixture(w);
    const id = (await receiveAdmin(f, fakeScanner('none', []).scan)).id;
    await expect(cloneInbound(id, { released_at: 'now()', released_by: `'${randomUUID()}'`, released_from: `'injection_risk'` })).rejects.toThrow();
  });
  it('[R-110] 위험 보류(risk_hold)를 injection_risk 로 풀었다고 거짓 기록 금지(released_from 은 원래 사유)', async () => {
    const f = await adminFixture(w);
    await setAgent(f, 'hold', null);
    const id = (await receiveAdmin(f, fakeScanner('low', RISKY).scan)).id;
    await expect(
      w.owner.query(`UPDATE inbound_messages SET quarantined = false, quarantine_reason = NULL, released_at = now(), released_by = $2, released_from = 'injection_risk' WHERE id = $1`, [id, randomUUID()]),
    ).rejects.toThrow();
  });
  it('[R-111] admin 롤이 webhook_deliveries 에 직접 쓰기 금지', async () => {
    await expect(w.admin.query(`INSERT INTO webhook_deliveries (event_id, endpoint_id, event_type, dedupe_key, body, next_attempt_at) VALUES (gen_random_uuid(), gen_random_uuid(), 'message.received', 'x', '{}', now())`)).rejects.toThrow(/permission denied/);
  });
});
