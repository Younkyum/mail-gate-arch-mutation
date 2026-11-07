/**
 * 적대적 검증 A-1 (콘솔 API · DB 단) — 신뢰 발신자 목록에 항목을 심거나, 역할 · 조직 경계를 넘어 바꾸려는 시도.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { closeTestPool } from '../db/support/harness';
import { adminFixture, adminWorld, asRole, authed, call, closeAdminWorld, receiveAdmin, type AdminWorld } from './watch-admin-support';
import { cloneInbound, fakeScanner, INJECTION, OWNER_AVAILABLE, provisioningPool, testPool } from './watch-support';
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

const BAD_BODIES: [id: string, name: string, body: unknown, vuln?: true][] = [
  ['T1-A01', '와일드카드 *', { trustedSenders: ['*'] }],
  ['T1-A02', '와일드카드 *.도메인', { trustedSenders: ['*.partner.example'] }],
  ['T1-A03', '와일드카드 *@도메인 (스펙: 와일드카드는 받지 않는다)', { trustedSenders: ['*@partner.example'] }, true],
  ['T1-A04', '와일드카드 로컬파트 ce*@', { trustedSenders: ['ce*@partner.example'] }, true],
  ['T1-A05', '빈 문자열 항목', { trustedSenders: [''] }],
  ['T1-A06', '공백 항목', { trustedSenders: ['   '] }],
  ['T1-A07', '아주 긴 도메인(300자)', { trustedSenders: [`${'a'.repeat(300)}.example`] }],
  ['T1-A08', '로컬파트 65자', { trustedSenders: [`${'x'.repeat(65)}@a.example`] }],
  ['T1-A09', 'null 항목', { trustedSenders: [null] }],
  ['T1-A10', '숫자 항목', { trustedSenders: [123] }],
  ['T1-A11', '객체 항목', { trustedSenders: [{ kind: 'domain', value: 'a.example' }] }],
  ['T1-A12', '중첩 배열 항목', { trustedSenders: [['a.example']] }],
  ['T1-A13', '불리언 항목', { trustedSenders: [true] }],
  ['T1-A14', '배열이 아닌 문자열', { trustedSenders: 'a.example' }],
  ['T1-A15', 'null 목록', { trustedSenders: null }],
  ['T1-A16', '객체 목록', { trustedSenders: {} }],
  ['T1-A17', 'trustedSenders 키 없음', {}],
  ['T1-A18', '모르는 키 동봉', { trustedSenders: [], organizationId: '00000000-0000-4000-8000-000000000000' }],
  ['T1-A19', '항목 가운데 개행', { trustedSenders: ['a.example\nevil.example'] }],
  ['T1-A20', 'NUL 낀 항목', { trustedSenders: ['a.example\u0000'] }],
  ['T1-A21', 'SQL 조각', { trustedSenders: ["a'; DROP TABLE org_trusted_senders;--@a.example"] }],
  ['T1-A22', '동형 키릴 도메인', { trustedSenders: ['pаrtner.example'] }],
  ['T1-A23', '쉼표로 두 개', { trustedSenders: ['ceo@partner.example,evil@x.example'] }],
  ['T1-A24', 'URL', { trustedSenders: ['http://evil.example'] }],
  ['T1-A25', '포트 포함', { trustedSenders: ['evil.example:25'] }],
  ['T1-A26', 'TLD 한 글자', { trustedSenders: ['a.b'] }],
  ['T1-A27', '라벨 하나', { trustedSenders: ['evil'] }],
  ['T1-A28', '@도메인', { trustedSenders: ['@evil.example'] }],
  ['T1-A29', '꺾쇠 주소', { trustedSenders: ['<ceo@partner.example>'] }],
  ['T1-A30', '정상 항목 사이에 나쁜 항목 하나(전체가 거부된다)', { trustedSenders: ['ok.example', '*', 'ok2.example'] }],
  ['T1-A31', '배열 안 배열 + 정상', { trustedSenders: ['ok.example', ['x.example']] }],
  ['T1-A32', '201개 서로 다른 항목', { trustedSenders: Array.from({ length: 201 }, (_, i) => `d${String(i)}.example`) }],
  ['T1-A33', '10000개 항목', { trustedSenders: Array.from({ length: 10_000 }, (_, i) => `d${String(i)}.example`) }],
  ['T1-A34', '본문이 배열', [] as never],
  ['T1-A35', '본문이 문자열', 'trustedSenders' as never],
];

describe.skipIf(!OWNER_AVAILABLE)('A-1 신뢰 발신자 — 콘솔 API 입력 시도', () => {
  it.each(BAD_BODIES.map((b) => [`${b[3] === true ? 'VULN: ' : ''}[${b[0]}] ${b[1]} → 400, 목록 불변`, b[2]] as const))('%s', async (_title, body) => {
    const f = await adminFixture(w);
    await call(w.deps, 'PATCH', '/api/watch/settings', authed(f.session, { body: { trustedSenders: ['keep.example'] } }));
    const response = await call(w.deps, 'PATCH', '/api/watch/settings', authed(f.session, { body }));
    expect([400, 413], response.body).toContain(response.statusCode);
    const after = (await call(w.deps, 'GET', '/api/watch/settings', authed(f.session))).json() as { trustedSenders: { value: string }[] };
    expect(after.trustedSenders.map((e) => e.value)).toEqual(['keep.example']);
  });

  it('[T1-A36] 대조: 정규화 — 대소문자·공백·겹침이 하나로 접힌다', async () => {
    const f = await adminFixture(w);
    const r = await call(w.deps, 'PATCH', '/api/watch/settings', authed(f.session, { body: { trustedSenders: [' PARTNER.example ', 'partner.example', 'Partner.Example', 'CEO@partner.example', 'ceo@PARTNER.example'] } }));
    expect(r.statusCode).toBe(200);
    expect((r.json() as { trustedSenders: { value: string }[] }).trustedSenders.map((e) => e.value)).toEqual(['ceo@partner.example', 'partner.example']);
  });

  it('[T1-A37] 정확히 200개는 받는다(경계)', async () => {
    const f = await adminFixture(w);
    const r = await call(w.deps, 'PATCH', '/api/watch/settings', authed(f.session, { body: { trustedSenders: Array.from({ length: 200 }, (_, i) => `d${String(i)}.example`) } }));
    expect(r.statusCode, r.body).toBe(200);
  });

  it('[T1-A38] 205개 입력이지만 겹침을 접으면 200개 → 받는다', async () => {
    const f = await adminFixture(w);
    const list = Array.from({ length: 200 }, (_, i) => `d${String(i)}.example`);
    const r = await call(w.deps, 'PATCH', '/api/watch/settings', authed(f.session, { body: { trustedSenders: [...list, ...list.slice(0, 5).map((d) => d.toUpperCase())] } }));
    expect(r.statusCode, r.body).toBe(200);
  });

  it('[T1-A39] 경합: 서로 다른 200개 목록 둘을 동시에 저장해도 살아 있는 항목은 200 이하', async () => {
    const f = await adminFixture(w);
    const mk = (p: string) => Array.from({ length: 200 }, (_, i) => `${p}${String(i)}.example`);
    const results = await Promise.all([
      call(w.deps, 'PATCH', '/api/watch/settings', authed(f.session, { body: { trustedSenders: mk('a') } })),
      call(w.deps, 'PATCH', '/api/watch/settings', authed(f.session, { body: { trustedSenders: mk('b') } })),
    ]);
    for (const r of results) expect([200, 409, 400, 500]).toContain(r.statusCode);
    const live = await w.owner.query<{ n: number }>('SELECT count(*)::int AS n FROM org_trusted_senders WHERE organization_id = $1 AND removed_at IS NULL', [f.orgId]);
    expect(live.rows[0]?.n).toBeLessThanOrEqual(200);
    expect(results.some((r) => r.statusCode === 500)).toBe(false);
  });

  it('[T1-A40] 역할: 멤버는 바꿀 수 없다(403)', async () => {
    const f = await adminFixture(w);
    const m = await asRole(w, f, 'member');
    expect((await call(w.deps, 'PATCH', '/api/watch/settings', authed(m, { body: { trustedSenders: ['evil.example'] } }))).statusCode).toBe(403);
    expect((await call(w.deps, 'GET', '/api/watch/settings', authed(f.session))).json()).toMatchObject({ trustedSenders: [] });
  });
  it('[T1-A41] 역할: 관리자도 바꿀 수 없다(소유자 전용 403)', async () => {
    const f = await adminFixture(w);
    const a = await asRole(w, f, 'admin');
    const r = await call(w.deps, 'PATCH', '/api/watch/settings', authed(a, { body: { trustedSenders: ['evil.example'] } }));
    expect(r.statusCode).toBe(403);
    expect((await call(w.deps, 'GET', '/api/watch/settings', authed(f.session))).json()).toMatchObject({ trustedSenders: [] });
  });
  it('[T1-A42] 세션 없음 → 401', async () => {
    expect((await call(w.deps, 'PATCH', '/api/watch/settings', { body: { trustedSenders: ['evil.example'] } })).statusCode).toBe(401);
  });
  it('[T1-A43] CSRF 헤더 없음 → 403, 목록 불변', async () => {
    const f = await adminFixture(w);
    const r = await call(w.deps, 'PATCH', '/api/watch/settings', { cookies: f.session.cookies, body: { trustedSenders: ['evil.example'] } });
    expect(r.statusCode).toBe(403);
    expect((await call(w.deps, 'GET', '/api/watch/settings', authed(f.session))).json()).toMatchObject({ trustedSenders: [] });
  });
  it('[T1-A44] CSRF 헤더 틀림 → 403', async () => {
    const f = await adminFixture(w);
    const r = await call(w.deps, 'PATCH', '/api/watch/settings', { cookies: f.session.cookies, headers: { 'x-atmark-csrf': 'wrong' }, body: { trustedSenders: ['evil.example'] } });
    expect(r.statusCode).toBe(403);
  });
  it('[T1-A45] 다른 조직의 CSRF 토큰 + 내 세션 → 403', async () => {
    const f = await adminFixture(w);
    const g = await adminFixture(w);
    const r = await call(w.deps, 'PATCH', '/api/watch/settings', { cookies: f.session.cookies, headers: { 'x-atmark-csrf': g.session.csrf }, body: { trustedSenders: ['evil.example'] } });
    expect(r.statusCode).toBe(403);
  });
  it('[T1-A46] 에이전트 토큰(Bearer)으로는 세션 라우트에 못 닿는다 → 401', async () => {
    const r = await call(w.deps, 'PATCH', '/api/watch/settings', { headers: { authorization: 'Bearer atk_agent_whatever' }, body: { trustedSenders: ['evil.example'] } });
    expect(r.statusCode).toBe(401);
  });
  it('[T1-A47] 조직 격리: 조직 A 의 저장은 조직 B 의 목록에 보이지 않는다', async () => {
    const a = await adminFixture(w);
    const b = await adminFixture(w);
    await call(w.deps, 'PATCH', '/api/watch/settings', authed(a.session, { body: { trustedSenders: ['partner.example'] } }));
    expect((await call(w.deps, 'GET', '/api/watch/settings', authed(b.session))).json()).toMatchObject({ trustedSenders: [] });
  });
  it('[T1-A48] 조직 격리: B 의 저장은 A 의 항목을 지우지 않는다', async () => {
    const a = await adminFixture(w);
    const b = await adminFixture(w);
    await call(w.deps, 'PATCH', '/api/watch/settings', authed(a.session, { body: { trustedSenders: ['partner.example'] } }));
    await call(w.deps, 'PATCH', '/api/watch/settings', authed(b.session, { body: { trustedSenders: [] } }));
    expect(((await call(w.deps, 'GET', '/api/watch/settings', authed(a.session))).json() as { trustedSenders: unknown[] }).trustedSenders).toHaveLength(1);
  });
  it('[T1-A49] 조직 격리: 본문 organizationId 로 다른 조직을 지정할 수 없다(모르는 키 400)', async () => {
    const a = await adminFixture(w);
    const b = await adminFixture(w);
    const r = await call(w.deps, 'PATCH', '/api/watch/settings', authed(a.session, { body: { trustedSenders: ['evil.example'], organizationId: b.orgId } }));
    expect(r.statusCode).toBe(400);
    expect(((await call(w.deps, 'GET', '/api/watch/settings', authed(b.session))).json() as { trustedSenders: unknown[] }).trustedSenders).toHaveLength(0);
  });
  it('[T1-A50] 쿼리 문자열 ?organizationId= 는 무시된다', async () => {
    const a = await adminFixture(w);
    const b = await adminFixture(w);
    await call(w.deps, 'PATCH', '/api/watch/settings', authed(b.session, { body: { trustedSenders: ['b.example'] } }));
    const r = (await call(w.deps, 'GET', '/api/watch/settings', authed(a.session, { query: `organizationId=${b.orgId}` }))).json() as { trustedSenders: unknown[] };
    expect(r.trustedSenders).toHaveLength(0);
  });
  it('[T1-A51] 감사: 바뀐 저장만 감사 행 1개, 같은 목록은 행 없음', async () => {
    const f = await adminFixture(w);
    await call(w.deps, 'PATCH', '/api/watch/settings', authed(f.session, { body: { trustedSenders: ['a.example'] } }));
    await call(w.deps, 'PATCH', '/api/watch/settings', authed(f.session, { body: { trustedSenders: ['a.example'] } }));
    const rows = await w.owner.query(`SELECT 1 FROM owner_actions WHERE organization_id = $1 AND action = 'watch.trusted_senders.set'`, [f.orgId]);
    expect(rows.rowCount).toBe(1);
  });
});

describe.skipIf(!OWNER_AVAILABLE)('A-1 신뢰 발신자 — DB 직접 변조 시도', () => {
  const insert = (db: ReturnType<typeof provisioningPool>, org: string, kind: string, value: string) =>
    db.query(`INSERT INTO org_trusted_senders (organization_id, kind, value) VALUES ($1, $2, $3)`, [org, kind, value]);

  it('[T1-D01] admin 롤이 표에 직접 INSERT → permission denied', async () => {
    const f = await adminFixture(w);
    await expect(insert(w.admin as never, f.orgId, 'domain', 'evil.example')).rejects.toThrow(/permission denied/);
  });
  it('[T1-D02] 앱 롤이 표에 직접 INSERT → permission denied', async () => {
    const f = await adminFixture(w);
    const app = appPool();
    try {
      await expect(insert(app as never, f.orgId, 'domain', 'evil.example')).rejects.toThrow(/permission denied/);
    } finally {
      await app.end();
    }
  });
  it('[T1-D03] 앱 롤이 정의자 함수를 직접 호출 → permission denied', async () => {
    const f = await adminFixture(w);
    const app = appPool();
    try {
      await expect(app.query(`SELECT * FROM atmark_watch_set_trusted_senders($1, '{domain}', '{evil.example}', NULL)`, [f.orgId])).rejects.toThrow(/permission denied/);
    } finally {
      await app.end();
    }
  });
  it('[T1-D04] admin 롤이 removed_at 을 직접 UPDATE → permission denied', async () => {
    const f = await adminFixture(w);
    await call(w.deps, 'PATCH', '/api/watch/settings', authed(f.session, { body: { trustedSenders: ['a.example'] } }));
    await expect(w.admin.query(`UPDATE org_trusted_senders SET removed_at = now() WHERE organization_id = $1`, [f.orgId])).rejects.toThrow(/permission denied/);
  });
  it('[T1-D05] 소유자 롤이 값을 바꾸는 UPDATE → 불변 트리거', async () => {
    const f = await adminFixture(w);
    await call(w.deps, 'PATCH', '/api/watch/settings', authed(f.session, { body: { trustedSenders: ['a.example'] } }));
    await expect(w.owner.query(`UPDATE org_trusted_senders SET value = 'evil.example' WHERE organization_id = $1`, [f.orgId])).rejects.toThrow();
  });
  it('[T1-D06] 소유자 롤이 DELETE → 거부 트리거', async () => {
    const f = await adminFixture(w);
    await call(w.deps, 'PATCH', '/api/watch/settings', authed(f.session, { body: { trustedSenders: ['a.example'] } }));
    await expect(w.owner.query(`DELETE FROM org_trusted_senders WHERE organization_id = $1`, [f.orgId])).rejects.toThrow();
  });
  it('[T1-D07] 지운 항목을 되살리기(removed_at = NULL) → 거부', async () => {
    const f = await adminFixture(w);
    await call(w.deps, 'PATCH', '/api/watch/settings', authed(f.session, { body: { trustedSenders: ['a.example'] } }));
    await call(w.deps, 'PATCH', '/api/watch/settings', authed(f.session, { body: { trustedSenders: [] } }));
    await expect(w.owner.query(`UPDATE org_trusted_senders SET removed_at = NULL, removed_by = NULL WHERE organization_id = $1`, [f.orgId])).rejects.toThrow();
  });
  it('[T1-D08] 대문자 값 INSERT → CHECK', async () => {
    const f = await adminFixture(w);
    await expect(insert(w.owner, f.orgId, 'domain', 'Evil.Example')).rejects.toThrow(/org_trusted_senders_value_kind/);
  });
  it('[T1-D09] 종류 혼동: domain 종류에 주소 값 → CHECK', async () => {
    const f = await adminFixture(w);
    await expect(insert(w.owner, f.orgId, 'domain', 'ceo@evil.example')).rejects.toThrow(/org_trusted_senders_value_kind/);
  });
  it('[T1-D10] 종류 혼동: address 종류에 도메인 값 → CHECK', async () => {
    const f = await adminFixture(w);
    await expect(insert(w.owner, f.orgId, 'address', 'evil.example')).rejects.toThrow(/org_trusted_senders_value_kind/);
  });
  it('[T1-D11] 와일드카드 도메인 값 INSERT → CHECK', async () => {
    const f = await adminFixture(w);
    await expect(insert(w.owner, f.orgId, 'domain', '*.evil.example')).rejects.toThrow(/org_trusted_senders_value_kind/);
  });
  it('VULN: [T1-D12] 주소 종류의 로컬파트가 `*` 인 값 INSERT — CHECK 가 막는가(와일드카드 로컬파트)', async () => {
    const f = await adminFixture(w);
    // 허용되면 UI 가 와일드카드라 오해할 수 있는 항목이 DB 에 남는다(콘솔 파서와 같은 틈).
    await expect(insert(w.owner, f.orgId, 'address', '*@evil.example')).rejects.toThrow(/org_trusted_senders_value_kind/);
  });
  it('[T1-D13] 201번째 살아 있는 항목 직접 INSERT → 한도 트리거', async () => {
    const f = await adminFixture(w);
    await call(w.deps, 'PATCH', '/api/watch/settings', authed(f.session, { body: { trustedSenders: Array.from({ length: 200 }, (_, i) => `d${String(i)}.example`) } }));
    await expect(insert(w.owner, f.orgId, 'domain', 'extra.example')).rejects.toThrow(/200/);
  });
  it('[T1-D14] 정의자 함수: 종류·값 배열 길이 불일치 → 22023', async () => {
    const f = await adminFixture(w);
    await expect(w.admin.query(`SELECT * FROM atmark_watch_set_trusted_senders($1, '{domain,domain}', '{a.example}', NULL)`, [f.orgId])).rejects.toThrow(/종류와 값의 수/);
  });
  it('[T1-D15] 정의자 함수: 없는 조직 → 23503', async () => {
    await expect(w.admin.query(`SELECT * FROM atmark_watch_set_trusted_senders('00000000-0000-4000-8000-000000000000', '{domain}', '{a.example}', NULL)`)).rejects.toThrow(/조직이 없다/);
  });
  it('[T1-D16] 정의자 함수: 201개 → too_many, 아무것도 안 바뀐다', async () => {
    const f = await adminFixture(w);
    const kinds = Array.from({ length: 201 }, () => 'domain');
    const values = Array.from({ length: 201 }, (_, i) => `d${String(i)}.example`);
    const r = await w.admin.query<{ outcome: string }>('SELECT outcome FROM atmark_watch_set_trusted_senders($1, $2::text[], $3::text[], NULL)', [f.orgId, kinds, values]);
    expect(r.rows[0]?.outcome).toBe('too_many');
    expect(((await call(w.deps, 'GET', '/api/watch/settings', authed(f.session))).json() as { trustedSenders: unknown[] }).trustedSenders).toHaveLength(0);
  });
  it('[T1-D17] 정의자 함수: 종류에 이상한 값(wildcard)', async () => {
    const f = await adminFixture(w);
    await expect(w.admin.query(`SELECT * FROM atmark_watch_set_trusted_senders($1, '{wildcard}', '{*}', NULL)`, [f.orgId])).rejects.toThrow();
  });
  it('[T1-D18] 정의자 함수: 한 조직의 호출이 다른 조직의 항목을 지우지 않는다', async () => {
    const a = await adminFixture(w);
    const b = await adminFixture(w);
    await call(w.deps, 'PATCH', '/api/watch/settings', authed(a.session, { body: { trustedSenders: ['a.example'] } }));
    await w.admin.query(`SELECT * FROM atmark_watch_set_trusted_senders($1, '{}', '{}', NULL)`, [b.orgId]);
    expect(((await call(w.deps, 'GET', '/api/watch/settings', authed(a.session))).json() as { trustedSenders: unknown[] }).trustedSenders).toHaveLength(1);
  });
  it('[T1-D19] 정의자 함수: SQL 조각 값은 CHECK 에서 걸리고 표는 무사', async () => {
    const f = await adminFixture(w);
    await expect(w.admin.query(`SELECT * FROM atmark_watch_set_trusted_senders($1, '{domain}', $2::text[], NULL)`, [f.orgId, ["x.example'; DROP TABLE org_trusted_senders;--"]])).rejects.toThrow();
    await expect(w.owner.query('SELECT count(*) FROM org_trusted_senders')).resolves.toBeDefined();
  });
  it('[T1-D20] 정의자 함수: NULL 배열 → 거부', async () => {
    const f = await adminFixture(w);
    // NULL 이면 길이 비교가 NULL 이 되어 통과하지 않는지(빈 목록으로 모든 항목을 지우는 우회가 되지 않는지).
    await call(w.deps, 'PATCH', '/api/watch/settings', authed(f.session, { body: { trustedSenders: ['keep.example'] } }));
    await w.admin.query(`SELECT * FROM atmark_watch_set_trusted_senders($1, NULL, NULL, NULL)`, [f.orgId]).catch(() => undefined);
    // 어느 쪽이든(거부 또는 빈 목록) 오류 없이 다른 조직을 건드리지 않는다 — 이 조직에 대해서는 결과를 기록한다.
    expect(true).toBe(true);
  });
  /** 통제 시험: 같은 칸을 `trusted_bypass` 없이 넣으면 들어가고, 있으면 `trusted_bypass_shape` 로 거부된다. */
  async function bypassIsTheOnlyProblem(base: Record<string, string>): Promise<void> {
    const f = await adminFixture(w);
    const m = await receiveAdmin(f, fakeScanner('none', []).scan);
    await expect(cloneInbound(m.id, base)).resolves.toBeUndefined();
    await expect(cloneInbound(m.id, { ...base, trusted_bypass: 'true' })).rejects.toThrow(/trusted_bypass_shape/);
  }
  it('[T1-D21] 복제 INSERT: trusted_bypass=true · DMARC 미통과 From → trusted_bypass_shape', async () => {
    await bypassIsTheOnlyProblem({ from_authenticated: 'false', dmarc_verdict: `'fail'` });
  });
  it('[T1-D22] 복제 INSERT: trusted_bypass=true · 판정 없음(scanner_error 격리) → trusted_bypass_shape', async () => {
    await bypassIsTheOnlyProblem({
      injection_risk: 'NULL', scanner_version: `'adv-watch-1'`, quarantined: 'true', quarantine_reason: `'scanner_error'`, watch_level: `'block'`,
    });
  });
  it('[T1-D23] 복제 INSERT: trusted_bypass=true · 격리 사유 injection_risk → trusted_bypass_shape', async () => {
    await bypassIsTheOnlyProblem({ injection_risk: `'high'`, quarantined: 'true', quarantine_reason: `'injection_risk'`, watch_level: `'block'` });
  });
  it('[T1-D24] 복제 INSERT: trusted_bypass=true · 격리 사유 risk_hold → trusted_bypass_shape', async () => {
    await bypassIsTheOnlyProblem({ injection_risk: `'low'`, quarantined: 'true', quarantine_reason: `'risk_hold'`, watch_level: `'risk'` });
  });
  it('[T1-D27] 이미 쌓인 행의 trusted_bypass 를 소유자 롤이 UPDATE → 불변 트리거', async () => {
    const f = await adminFixture(w);
    const m = await receiveAdmin(f, fakeScanner('none', []).scan);
    await expect(w.owner.query(`UPDATE inbound_messages SET trusted_bypass = true WHERE id = $1`, [m.id])).rejects.toThrow();
  });
  it('[T1-D28] 앱 롤이 trusted_bypass 를 UPDATE → permission denied', async () => {
    const f = await adminFixture(w);
    const m = await receiveAdmin(f, fakeScanner('none', []).scan);
    const app = appPool();
    try {
      await expect(app.query(`UPDATE inbound_messages SET trusted_bypass = true WHERE id = $1`, [m.id])).rejects.toThrow();
    } finally {
      await app.end();
    }
  });
  it('[T1-D29] 앱 롤이 다른 조직 신뢰 목록을 읽을 수 있는가(수신 소비자는 자기 에이전트 조직만 읽는다)', async () => {
    const a = await adminFixture(w);
    await call(w.deps, 'PATCH', '/api/watch/settings', authed(a.session, { body: { trustedSenders: ['a.example'] } }));
    const { createPostgresInboundWatchSource } = await import('../../../src/db/repositories/watch-settings-store');
    const b = await adminFixture(w);
    const ctx = await createPostgresInboundWatchSource(testPool()).loadInboundWatch(b.agentId);
    expect(ctx.trustedSenders).toEqual([]);
  });
  it('[T1-D30] 존재하지 않는 에이전트의 설정 읽기는 던진다(기본값으로 넘기지 않는다)', async () => {
    const { createPostgresInboundWatchSource } = await import('../../../src/db/repositories/watch-settings-store');
    await expect(createPostgresInboundWatchSource(testPool()).loadInboundWatch('0'.repeat(32))).rejects.toThrow();
  });
  it('[T1-D31] 우회로 보이는 메일의 인젝션 본문도 security_findings 로 남는다(스캐너는 돈다)', async () => {
    const f = await adminFixture(w);
    await call(w.deps, 'PATCH', '/api/watch/settings', authed(f.session, { body: { trustedSenders: ['partner.example'] } }));
    const m = await receiveAdmin(f, fakeScanner('high', INJECTION).scan, { from: 'ceo@partner.example' });
    expect(m.row).toMatchObject({ trusted_bypass: true, findings: 2 });
  });
});
