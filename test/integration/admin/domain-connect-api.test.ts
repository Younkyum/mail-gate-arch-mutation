/**
 * Domain Connect(2026-10 one-shot: **템플릿 하나 `mail` · 동의 한 번** — `src/admin/ops/domains.ts`): `GET /api/domains/{id}/connect`(단추 표시 여부만 —
 * `domainConnectInfoOp`) · `POST …/connect`(누를 때 발급 — `domainConnectIssueOp` · 감사 · 조직 시간당 10)
 * 와 추가 직후 즉시 실행(`POST /api/domains` → `provisionAfterAdd`). 라우터 · atmark_admin 롤 풀.
 *
 *   ① 역할: member 403 `forbidden_role` · admin 200 · 다른 조직 · 없는 id = 같은 404 · 기능 꺼짐 403 · 옛 쿼리 `phase` 는 보지 않는다.
 *   ② 플래그 꺼짐(`deps.domainConnect` 없음) = `{supported:false}` · 업체 미지원 = `{supported:false}`(서명 0).
 *   ③ DKIM 토큰 전 409 · 토큰 뒤 서명 URL 하나(apex + host=서브도메인 · 소유 토큰 · t1..t3 · 복귀 `?dc=1&d=`) + 레코드 7줄 · verified · removed 409.
 *   ④ 즉시 실행: 포트가 없으면 `provision:'unavailable'` · `recordsReady:false` / `provisioned` 면 다시 읽어 DKIM 까지 실린다 · 던져도 201.
 *   ⑤ 다른 메일 서버 409 · 발급 감사(값 없음) · 429. ⑥ GET 은 {supported, providerName} 만 — 서명 · 감사 · 횟수 없음.
 */

import { createPublicKey, generateKeyPairSync, sign as rsaSign, verify } from 'node:crypto';

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AdminDependencies } from '../../../src/admin/context';
import type { ProvisionDomainNow } from '../../../src/domains/contract';
import type { DomainConnectDiscovery } from '../../../src/domains/dc-discovery';
import type { DcSigner } from '../../../src/domains/dc-url';
import { enableCustomDomains } from '../policy/support';
import { adminDeps, adminRolePool, authed, AVAILABLE, call, login, loginMailerPool, newOrganization, ownerPool, suffix, userIdOf, type Session } from './support';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

describe.skipIf(!AVAILABLE)('Domain Connect 엔드포인트 — atmark_admin 롤', { timeout: 180_000 }, () => {
  let owner: Pool;
  let admin: Pool;
  let mailer: Pool;
  let off: AdminDependencies;
  let on: AdminDependencies;
  let signs = 0;
  let supported = true;
  const discovered: [string, string][] = [];

  beforeAll(() => {
    owner = ownerPool();
    admin = adminRolePool();
    mailer = loginMailerPool();
    off = adminDeps(admin);
    const signer: DcSigner = { sign: (message) => ((signs += 1), Promise.resolve(rsaSign('sha256', message, privateKey))) };
    const discovery: DomainConnectDiscovery = {
      discover: (registrable, serviceId) => {
        discovered.push([registrable, serviceId]);
        return Promise.resolve(
          supported ? { supported: true, providerName: 'Cloudflare', urlSyncUX: 'https://dash.cloudflare.com/domainconnect' } : { supported: false, reason: 'template_unsupported' },
        );
      },
    };
    on = adminDeps(admin, { domainConnect: { discovery, signer } });
  });
  afterAll(async () => {
    await Promise.all([owner.end(), admin.end(), mailer.end()]);
  });

  async function org(enabled = true): Promise<{ id: string; session: Session }> {
    const organization = await newOrganization(owner, 'team');
    if (enabled) await enableCustomDomains(organization.id);
    return { id: organization.id, session: await login(off, mailer, organization) };
  }
  async function added(session: Session, registrable = `dc${suffix()}${suffix()}.com`): Promise<{ id: string; registrable: string; domain: string }> {
    const domain = `agents.${registrable}`;
    const result = await call(off, 'POST', '/api/domains', authed(session, { body: { domain } }));
    expect(result.statusCode, result.body).toBe(201);
    return { id: (result.json() as { item: { id: string } }).item.id, registrable, domain };
  }
  /** 발급(단추를 누를 때) — `POST`. */
  const connect = (deps: AdminDependencies, session: Session, id: string, query?: string) =>
    call(deps, 'POST', `/api/domains/${id}/connect`, authed(session, { body: {}, ...(query === undefined ? {} : { query }) }));
  /** 단추 표시 여부(화면을 열 때) — `GET`. 서명 · 감사 없음. */
  const info = (deps: AdminDependencies, session: Session, id: string) => call(deps, 'GET', `/api/domains/${id}/connect`, authed(session));
  const TOKENS = ['a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32)];
  /** 즉시 실행이 한 일을 흉내 낸다 — DKIM 토큰을 행에 적는다(소유자 롤). */
  const provisioned = async (id: string): Promise<void> => {
    await owner.query('UPDATE custom_domains SET dkim_tokens = $2 WHERE id = $1', [id, TOKENS]);
  };
  const errorOf = (result: { json: () => unknown }): string => (result.json() as { error: string }).error;

  it('① member 403 forbidden_role · admin 200 · 다른 조직 = 없는 id 404 · 옛 phase 쿼리는 무시 · 기능 꺼짐 403', async () => {
    const a = await org();
    const item = await added(a.session);
    await provisioned(item.id);
    const email = `dc-member-${suffix()}@example.com`;
    await owner.query('INSERT INTO users (email) VALUES ($1)', [email]);
    await owner.query(`INSERT INTO memberships (user_id, organization_id, role, joined_via) VALUES ($1, $2, 'member', 'invite')`, [await userIdOf(owner, email), a.id]);
    const member = await login(off, mailer, { id: a.id, ownerEmail: email });
    const denied = await connect(on, member, item.id);
    expect([denied.statusCode, errorOf(denied)]).toEqual([403, 'forbidden_role']);

    const b = await org();
    const foreign = await connect(on, b.session, item.id);
    const missing = await connect(on, b.session, '00000000-0000-4000-8000-000000000000');
    expect([foreign.statusCode, foreign.body]).toEqual([missing.statusCode, missing.body]);
    expect(foreign.statusCode).toBe(404);
    // 배포 사이 옛 콘솔이 붙이는 `phase` 는 보지 않는다 — 같은 하나의 적용.
    const legacy = await connect(on, a.session, item.id, 'phase=dkim');
    const plain = await connect(on, a.session, item.id);
    expect(legacy.statusCode, legacy.body).toBe(200);
    expect((legacy.json() as { records: unknown[] }).records).toEqual((plain.json() as { records: unknown[] }).records);
    await owner.query(`DELETE FROM org_features WHERE organization_id = $1`, [a.id]);
    const disabled = await connect(on, a.session, item.id);
    expect([disabled.statusCode, errorOf(disabled)]).toEqual([403, 'feature_not_enabled']);
  });

  it('② 플래그 꺼짐 · 업체 미지원 = {supported:false}(서명 0)', async () => {
    const a = await org();
    const item = await added(a.session);
    await provisioned(item.id);
    const before = signs;
    const flagOff = await connect(off, a.session, item.id);
    expect([flagOff.statusCode, flagOff.json()]).toEqual([200, { supported: false }]);
    supported = false;
    try {
      const unsupported = await connect(on, a.session, item.id);
      expect([unsupported.statusCode, unsupported.json()]).toEqual([200, { supported: false }]);
    } finally {
      supported = true;
    }
    expect(signs).toBe(before);
  });

  it('③ 토큰 전 409 · 뒤 서명 URL 하나(apex · host=agents · 소유 토큰 · t1..t3 · ?dc=1&d=) · 레코드 8줄(DMARC 권장 포함) · verified · removed 409', async () => {
    const a = await org();
    const item = await added(a.session);
    const early = await connect(on, a.session, item.id);
    expect([early.statusCode, errorOf(early)]).toEqual([409, 'domain_connect_phase_unavailable']);
    await provisioned(item.id);
    const result = await connect(on, a.session, item.id);
    expect(result.statusCode, result.body).toBe(200);
    const body = result.json() as { supported: true; providerName: string; applyUrl: string; records: { purpose: string; name: string; value: string }[] };
    expect(body).toMatchObject({ supported: true, providerName: 'Cloudflare' });
    expect(body).not.toHaveProperty('phase');
    const token = (await owner.query<{ t: string }>('SELECT challenge_token AS t FROM custom_domains WHERE id = $1', [item.id])).rows[0]?.t ?? '';
    const [base = '', query = ''] = body.applyUrl.split('?');
    expect(base).toBe('https://dash.cloudflare.com/domainconnect/v2/domainTemplates/providers/atmark.ai/services/mail/apply');
    const pairs = query.split('&');
    const signed = pairs.filter((pair) => !pair.startsWith('sig=') && !pair.startsWith('key=')).join('&');
    expect(signed).toBe(
      `domain=${item.registrable}&host=agents&token=${token}&t1=${TOKENS[0] ?? ''}&t2=${TOKENS[1] ?? ''}&t3=${TOKENS[2] ?? ''}` +
        `&redirect_uri=${encodeURIComponent(`https://console.atmark.ai/app?dc=1&d=${item.id}`)}`,
    );
    const sig = decodeURIComponent(pairs.find((pair) => pair.startsWith('sig='))?.slice(4) ?? '');
    expect(verify('sha256', Buffer.from(signed), createPublicKey(publicKey.export({ format: 'pem', type: 'spki' })), Buffer.from(sig, 'base64'))).toBe(true);
    expect(body.records.map((record) => record.purpose)).toEqual(['ownership', 'inbound_mx', 'mail_from_mx', 'mail_from_spf', 'dkim', 'dkim', 'dkim', 'dmarc']);
    expect(body.records[0]).toEqual({ purpose: 'ownership', type: 'TXT', name: `_atmark-challenge.${item.domain}`, value: `atmark-domain-verification=${token}`, required: true });
    expect(body.records.at(-1)).toEqual({ purpose: 'dmarc', type: 'TXT', name: `_dmarc.${item.domain}`, value: 'v=DMARC1; p=none', required: false });
    expect(discovered.at(-1)).toEqual([item.registrable, 'mail']);

    expect((await call(off, 'DELETE', `/api/domains/${item.id}`, authed(a.session, { body: {} }))).statusCode).toBe(200);
    const gone = await connect(on, a.session, item.id);
    expect([gone.statusCode, errorOf(gone)]).toEqual([409, 'domain_connect_phase_unavailable']);
  });

  it('④ 추가 직후 즉시 실행 — 포트 없음 unavailable · provisioned 면 DKIM 까지 · waiting 은 그대로 · 던져도 201', async () => {
    const a = await org();
    const plain = await call(off, 'POST', '/api/domains', authed(a.session, { body: { domain: `agents.np${suffix()}.com` } }));
    expect(plain.statusCode, plain.body).toBe(201);
    const plainBody = plain.json() as { provision: string; item: { recordsReady: boolean; records: { purpose: string }[] } };
    expect(plainBody.provision).toBe('unavailable');
    expect(plainBody.item.recordsReady).toBe(false);
    expect(plainBody.item.records.map((r) => r.purpose)).toEqual(['ownership', 'inbound_mx', 'mail_from_mx', 'mail_from_spf', 'dmarc']);

    const seen: string[] = [];
    const now: ProvisionDomainNow = async (rowId) => {
      seen.push(rowId);
      // 커밋 뒤에 불린다 — 다른 연결(소유자 롤)에서 행이 보인다.
      const visible = await owner.query('SELECT 1 FROM custom_domains WHERE id = $1', [rowId]);
      if (visible.rowCount !== 1) return 'skipped';
      await provisioned(rowId);
      return 'provisioned';
    };
    const ready = await call(adminDeps(admin, { provisionDomainNow: now }), 'POST', '/api/domains', authed(a.session, { body: { domain: `agents.pv${suffix()}.com` } }));
    expect(ready.statusCode, ready.body).toBe(201);
    const readyBody = ready.json() as { provision: string; item: { id: string; recordsReady: boolean; records: { purpose: string; value: string }[] } };
    expect(seen).toEqual([readyBody.item.id]);
    expect(readyBody.provision).toBe('provisioned');
    expect(readyBody.item.recordsReady).toBe(true);
    expect(readyBody.item.records.filter((r) => r.purpose === 'dkim').map((r) => r.value)).toEqual(TOKENS.map((t) => `${t}.dkim.amazonses.com`));

    const b = await org();
    const waiting = await call(adminDeps(admin, { provisionDomainNow: () => Promise.resolve('waiting') }), 'POST', '/api/domains', authed(b.session, { body: { domain: `agents.wt${suffix()}.com` } }));
    expect([waiting.statusCode, (waiting.json() as { provision: string }).provision]).toEqual([201, 'waiting']);
    const threw = await call(adminDeps(admin, { provisionDomainNow: () => Promise.reject(new Error('boom')) }), 'POST', '/api/domains', authed(b.session, { body: { domain: `agents.th${suffix()}.com` } }));
    expect([threw.statusCode, (threw.json() as { provision: string }).provision]).toEqual([201, 'unavailable']);
  });

  it('⑤ 보안 리뷰 M3 — 다른 메일 서버가 있는 서브도메인 409 · 발급마다 감사(값 없음) · 조직 시간당 10 → 429(감사 없음) · 미지원은 감사 없음', async () => {
    const a = await org();
    const mail = await added(a.session);
    await provisioned(mail.id);
    await owner.query(`UPDATE custom_domains SET inbound_mx_status = 'other' WHERE id = $1`, [mail.id]);
    const before = signs;
    const refused = await connect(on, a.session, mail.id);
    expect([refused.statusCode, errorOf(refused)]).toEqual([409, 'domain_connect_existing_mail']);
    expect(signs).toBe(before);

    const item = await added(a.session);
    await provisioned(item.id);
    const audits = async (): Promise<{ target_id: string; session_id: string | null; organization_id: string }[]> =>
      (
        await owner.query<{ target_id: string; session_id: string | null; organization_id: string }>(
          `SELECT target_id::text, session_id::text, organization_id::text FROM owner_actions WHERE organization_id = $1 AND action = 'domain.connect_issued' ORDER BY created_at`,
          [a.id],
        )
      ).rows;
    // 미지원(업체 없음)은 URL 이 없으므로 감사도 없다.
    supported = false;
    try {
      expect((await connect(on, a.session, item.id)).statusCode).toBe(200);
    } finally {
      supported = true;
    }
    expect(await audits()).toHaveLength(0);
    for (let i = 0; i < 10; i += 1) {
      const ok = await connect(on, a.session, item.id);
      expect(ok.statusCode, ok.body).toBe(200);
    }
    const rows = await audits();
    expect(rows).toHaveLength(10);
    expect(new Set(rows.map((r) => r.target_id))).toEqual(new Set([item.id]));
    expect(rows.every((r) => r.session_id !== null)).toBe(true);
    // 감사 행 어디에도 URL · 토큰 값이 없다.
    const raw = JSON.stringify((await owner.query(`SELECT * FROM owner_actions WHERE organization_id = $1 AND action = 'domain.connect_issued'`, [a.id])).rows);
    expect(raw).not.toMatch(/https?:|sig=|dkim|atmark-domain-verification/);
    const token = (await owner.query<{ t: string }>('SELECT challenge_token AS t FROM custom_domains WHERE id = $1', [item.id])).rows[0]?.t ?? '';
    expect(raw).not.toContain(token);
    const signed = signs;
    const limited = await connect(on, a.session, item.id);
    expect([limited.statusCode, errorOf(limited)]).toEqual([429, 'domain_connect_rate_limited']);
    expect(signs).toBe(signed);
    expect(await audits()).toHaveLength(10);
  });

  it('⑥ GET = 단추 표시 여부만 — {supported, providerName} · 서명 0 · 감사 0 · 몇 번을 열어도 횟수에 들지 않는다 · 다른 메일 서버 409', async () => {
    const a = await org();
    const item = await added(a.session);
    await provisioned(item.id);
    const before = signs;
    for (let i = 0; i < 12; i += 1) {
      const shown = await info(on, a.session, item.id);
      expect([shown.statusCode, shown.json()]).toEqual([200, { supported: true, providerName: 'Cloudflare' }]);
    }
    expect(signs).toBe(before);
    const audited = await owner.query(`SELECT 1 FROM owner_actions WHERE organization_id = $1 AND action = 'domain.connect_issued'`, [a.id]);
    expect(audited.rowCount).toBe(0);
    // 12번 열어도 발급은 열린다(상한은 발급만 센다).
    expect((await connect(on, a.session, item.id)).statusCode).toBe(200);
    expect((await info(off, a.session, item.id)).json()).toEqual({ supported: false });
    await owner.query(`UPDATE custom_domains SET inbound_mx_status = 'other' WHERE id = $1`, [item.id]);
    const mail = await info(on, a.session, item.id);
    expect([mail.statusCode, errorOf(mail)]).toEqual([409, 'domain_connect_existing_mail']);
  });
});
