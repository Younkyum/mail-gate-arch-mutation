/**
 * AC-9 — **`GET /v1/audit?message_id=` 가 "왜 이 메일이 나갔는가" 에 답한다.**
 *
 * 답에 필요한 것은 셋이다: **판정**(`decision`), **근거**(`reasons`), **그 판정을 낸
 * 정책**(`policy_version`). 계획 §4.3 이 정책 스냅샷을 참조가 아니라 전문으로 저장하게
 * 한 이유가 이것이고, 그 저장이 쓸모를 갖는 지점이 이 엔드포인트다.
 *
 * **Postgres 조회 SQL 은 여기서 검증하지 않는다** — 그것은 `createPostgresAuditReader`
 * 의 명제이고 `demo:p1b` 가 실제 DB 위에서 지나간다. 여기서 보는 것은 **라우트의 계약**
 * 이다: 인가(남의 감사 기록을 못 본다), 부재(404), 응답 모양.
 */

import { describe, expect, it } from 'vitest';

import type { AuditReader, AuditRecord } from '../../../src/api/audit-reader';
import { handleAuditQuery } from '../../../src/api/routes/audit';
import type { ApiRequest } from '../../../src/api/http';
import { toAgentId, type AgentId } from '../../../src/db/schema';
import { AGENT_ID, NOW, issuedToken } from './support/fakes';

const OTHER_AGENT: AgentId = toAgentId('ffffffffffffffffffffffffffffffff');
const MESSAGE_ID = '274eb50e-fe72-48ff-bdf5-a7c01c123cc9';

function record(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    id: 'audit-1',
    agentId: AGENT_ID,
    messageId: MESSAGE_ID,
    decision: 'allowed',
    reasons: ['allowlist_match'],
    policyVersion: 1,
    policyVersionId: '22222222-2222-4222-8222-222222222222',
    evaluatedAt: NOW,
    latencyMs: 12,
    traceId: 'trace-1',
    resolvedAt: NOW,
    resolutionReason: 'sent',
    ...overrides,
  };
}

function reader(records: readonly AuditRecord[]): AuditReader {
  return {
    byMessageId: (messageId) => Promise.resolve(records.filter((r) => r.messageId === messageId)),
    byAgentId: (agentId) => Promise.resolve(records.filter((r) => r.agentId === agentId)),
  };
}

function query(token: string, messageId: string | null): ApiRequest {
  return {
    headers: { authorization: `Bearer ${token}` },
    query: messageId === null ? {} : { message_id: messageId },
    body: null,
  };
}

describe('GET /v1/audit — AC-9', () => {
  it('판정·사유·정책 버전을 돌려준다', async () => {
    const token = issuedToken();
    const response = await handleAuditQuery(
      { tokens: token.store, audit: reader([record()]), now: () => NOW },
      query(token.plaintext, MESSAGE_ID),
    );

    expect(response.status).toBe(200);
    const attempts = response.body['attempts'] as readonly Record<string, unknown>[];
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.['decision']).toBe('allowed');
    expect(attempts[0]?.['reasons']).toEqual(['allowlist_match']);
    expect(attempts[0]?.['policy_version']).toBe(1);
    // 해소 결과도 같은 행에 있다 — "허용됐고 실제로 나갔다" 가 한 행에서 읽힌다(§4.3).
    expect(attempts[0]?.['resolution_reason']).toBe('sent');
  });

  it('거부된 시도도 사유를 그대로 돌려준다 — 조용한 거부는 없다', async () => {
    const token = issuedToken();
    const denied = record({
      decision: 'denied',
      reasons: ['recipient_not_allowlisted'],
      resolvedAt: null,
      resolutionReason: null,
    });

    const response = await handleAuditQuery(
      { tokens: token.store, audit: reader([denied]), now: () => NOW },
      query(token.plaintext, MESSAGE_ID),
    );

    const attempts = response.body['attempts'] as readonly Record<string, unknown>[];
    expect(attempts[0]?.['decision']).toBe('denied');
    expect(attempts[0]?.['reasons']).toEqual(['recipient_not_allowlisted']);
  });

  it('사유와 해소 사유는 공개 이름으로 나간다 — 공급자·전송단 오류 원문이 새지 않는다(가림 정책)', async () => {
    const token = issuedToken();
    const failed = record({
      id: 'audit-failed',
      reasons: ['allowlist_match'],
      resolutionReason: 'failed:SES throttled: Maximum sending rate exceeded (arn:aws:ses:us-east-1:123456789012)',
    });
    const denied = record({
      id: 'audit-denied',
      decision: 'denied',
      reasons: ['suppression_list', 'ses_account_level_suppression', 'warmup_daily_cap'],
      resolvedAt: null,
      resolutionReason: null,
    });
    const releaseDenied = record({
      id: 'audit-release',
      decision: 'denied',
      reasons: ['new_recipient'],
      resolutionReason: 'release_denied:ses_account_level_suppression',
    });

    const response = await handleAuditQuery(
      { tokens: token.store, audit: reader([failed, denied, releaseDenied]), now: () => NOW },
      query(token.plaintext, MESSAGE_ID),
    );

    const attempts = response.body['attempts'] as readonly Record<string, unknown>[];
    expect(attempts[0]?.['resolution_reason']).toBe('send_failed');
    expect(attempts[1]?.['reasons']).toEqual(['suppression_list', 'daily_send_limit']);
    expect(attempts[2]?.['resolution_reason']).toBe('release_denied:suppression_list');
    expect(JSON.stringify(response.body)).not.toMatch(/ses_|\bses\b|aws|throttl|warmup/i);
  });

  it('message_id 가 없으면 400', async () => {
    const token = issuedToken();
    const response = await handleAuditQuery(
      { tokens: token.store, audit: reader([record()]), now: () => NOW },
      query(token.plaintext, null),
    );
    expect(response.status).toBe(400);
  });

  it('행이 없으면 404', async () => {
    const token = issuedToken();
    const response = await handleAuditQuery(
      { tokens: token.store, audit: reader([]), now: () => NOW },
      query(token.plaintext, MESSAGE_ID),
    );
    expect(response.status).toBe(404);
    expect(response.body['error']).toBe('audit_not_found');
  });

  it('남의 에이전트의 감사 기록은 403 — 인가는 행이 말하는 소유자로만 판정한다', async () => {
    const token = issuedToken();
    const response = await handleAuditQuery(
      { tokens: token.store, audit: reader([record({ agentId: OTHER_AGENT })]), now: () => NOW },
      query(token.plaintext, MESSAGE_ID),
    );
    expect(response.status).toBe(403);
    expect(response.body['detail']).toBe('not_own_agent');
  });

  it('토큰이 없으면 401', async () => {
    const response = await handleAuditQuery(
      { tokens: issuedToken().store, audit: reader([record()]), now: () => NOW },
      { headers: {}, query: { message_id: MESSAGE_ID }, body: null },
    );
    expect(response.status).toBe(401);
  });
});
