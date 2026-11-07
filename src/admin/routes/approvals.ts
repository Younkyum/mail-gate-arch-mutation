/**
 * src/admin/routes/approvals.ts — `GET /api/approvals?status=pending` → 목록 **조회만**.
 *
 * ★ **결정 엔드포인트가 없다.** 승인·거절은 소유자 메일의 서명 링크(`/approve`, api Lambda) 한 경로뿐이다(계약). 관리 화면에
 * 승인 버튼이 생기면 승인 권한의 입구가 둘이 되고, 그중 하나는 세션 쿠키 하나로 열린다. `test/integration/admin/admin-api.test.ts`
 * 가 이 경로에 POST·PATCH 가 없음(405)과 하위 결정 경로가 없음(404)을 본다.
 */

import { AdminInputError } from '../ops/errors';
import { sessionOf, type AdminCall } from '../context';
import { displayAddress, displaySubject } from '../display';
import { jsonResponse, type AdminResponse } from '../http';

const STATUSES = ['pending', 'approved', 'rejected', 'expired'] as const;

export async function handleListApprovals(call: AdminCall): Promise<AdminResponse> {
  const status = call.request.query['status'] ?? 'pending';
  if (!(STATUSES as readonly string[]).includes(status)) throw new AdminInputError(`status 는 ${STATUSES.join(' | ')} 다.`, 'invalid_status');
  const result = await call.deps.pool.query<{
    id: string;
    agent_id: string;
    recipients: string[] | null;
    subject: string | null;
    created_at: Date;
    expires_at: Date;
  }>(
    `SELECT r.id, r.agent_id, r.created_at, r.expires_at,
            (SELECT array_agg(DISTINCT x ORDER BY x) FROM approval_request_items i, unnest(i.recipients) AS x
              WHERE i.approval_id = r.id) AS recipients,
            (SELECT m.subject FROM approval_request_items i JOIN messages m ON m.id = i.message_id
              WHERE i.approval_id = r.id ORDER BY i.created_at, i.message_id LIMIT 1) AS subject
       FROM approval_requests r JOIN agents a ON a.id = r.agent_id
      WHERE a.organization_id = $1 AND r.status = $2::approval_status
      ORDER BY r.created_at DESC, r.id
      LIMIT 200`,
    [sessionOf(call).organizationId, status],
  );
  return jsonResponse(
    200,
    result.rows.map((row) => ({
      id: row.id,
      agentId: row.agent_id,
      // 수신자·제목은 **에이전트가 정한 문자열**이다 — 표시 규칙으로 한 번 거른다.
      recipients: (row.recipients ?? []).map(displayAddress),
      subject: row.subject === null ? null : displaySubject(row.subject),
      createdAt: row.created_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
    })),
  );
}
