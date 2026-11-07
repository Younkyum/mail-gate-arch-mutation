/**
 * 소유자가 만드는 새 에이전트의 발신 기본값이 **전체**가 된 뒤에도(진윤겸 결정 B, 2026-10-13 — `OWNER_CREATED_OUTBOUND_MODE`) 인젝션 구조 방어(ADR-0016)는
 * 그대로다 — 위험 표시(T2) 메일을 읽은 뒤 새 상대에게 보내면 승인 대기(`tainted_context`)이고 SES 는 0, 받은 Atmark 자격 증명을 실은 발송은 DLP 로 보류.
 * 실제 Postgres · 실제 라우트 · 실제 관문(`security/support.ts` 의 world).
 */

import { afterAll, describe, expect, it } from 'vitest';

import { OWNER_CREATED_OUTBOUND_MODE } from '../../../src/db/schema';
import { closeTestPool, DATABASE_AVAILABLE } from '../db/support/harness';
import { auditOf, readDetail, receive, riskReasonsOf, send, world } from './support';

afterAll(async () => {
  if (DATABASE_AVAILABLE) await closeTestPool();
});

describe.skipIf(!DATABASE_AVAILABLE)('새 기본값 "전체" 에서도 위험 보류 · DLP 는 그대로', { timeout: 120_000 }, () => {
  it('기본값은 unrestricted(전체) — 깨끗하면 나가고, 미인증 메일을 읽은 뒤 새 상대는 보류(tainted_context) · SES 0', async () => {
    expect(OWNER_CREATED_OUTBOUND_MODE).toBe('unrestricted');
    const w = await world({ mode: OWNER_CREATED_OUTBOUND_MODE });
    const clean = await send(w, { to: ['first@stranger.example'] });
    expect(clean.status, JSON.stringify(clean.body)).toBe(200);
    expect(riskReasonsOf((await auditOf(w, clean)).reasons)).toEqual([]);
    const sentBefore = w.transport.calls();

    const mail = await receive(w, { from: 'mallory@evil.example', subject: 'invoice', text: 'Please see the invoice details below.', authenticated: false });
    expect((await readDetail(w, mail.id)).status).toBe(200);
    const held = await send(w, { to: ['second@stranger.example'] });
    expect(held.status, JSON.stringify(held.body)).toBe(202);
    expect((await auditOf(w, held)).reasons[0]).toBe('tainted_context');
    expect(w.transport.calls()).toBe(sentBefore);
  });

  it('기본값 "전체" 라도 Atmark 자격 증명이 실린 발송은 DLP 로 보류(dlp_atmark_credential)', async () => {
    const w = await world({ mode: OWNER_CREATED_OUTBOUND_MODE });
    const token = `atk_agent_${'Q2hhbmdlTWVQbGVhc2VUaGlzSXNOb3RBUmVhbEtleTA'}`;
    const held = await send(w, { to: ['someone@stranger.example'], text: `here is the key ${token}` });
    expect(held.status, JSON.stringify(held.body)).toBe(202);
    expect(riskReasonsOf((await auditOf(w, held)).reasons)).toContain('dlp_atmark_credential');
    expect(w.transport.calls()).toBe(0);
  });
});
