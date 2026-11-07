/**
 * src/admin/routes/org-keys.ts — 조직 API 키 **콘솔 관리**(owner 전용 — 라우트 표 `OWNER`, 확장성 P1 R-6 · 계약 `.omc/handoffs/p0p1-api.md` B4).
 *
 * 세션 조직 범위 · 본문 해석 · 감사 1행 · 응답 모양만 한다(로직은 `ops/org-keys.ts`). 행위와 감사 1행은 **한 트랜잭션**(`audited`).
 * 감사 대상 = 키 id(uuid) — `org_key.issue|revoke|rotate(새 키)|rename`. 평문은 발급·교체 응답에 **한 번** 실리고 어디에도 남지 않는다.
 * 키를 **쓰는** 표면(`/org-api/v1/*`)은 `routes/org-api.ts` 이고 이 파일과 섞지 않는다. 발송 없음.
 */

import { audited, objectBody, optionalBody, rejectUnknownKeys, sessionOf, type AdminCall } from '../context';
import { jsonResponse, type AdminResponse } from '../http';
import { expiryFromDays } from '../ops/agents';
import { AdminInputError } from '../ops/errors';
import {
  issueOrgKeyOp,
  limitOrgKeyChanges,
  listOrgKeysOp,
  renameOrgKeyOp,
  resolveOrgKeyCapabilities,
  revokeOrgKeyOp,
  supersedeOrgKeyOp,
  type OrgKeyView,
} from '../ops/org-keys';
import { resolveTokenLabel, TOKEN_LABEL_MAX_LENGTH } from '../ops/tokens';
import { sanitizeDisplayText } from '../../notify/approval-notification-template';

/** 표시 정화(이중 방어 — 이름은 저장 때 이미 검사됐다). */
function keyForDisplay(item: OrgKeyView): OrgKeyView {
  return { ...item, label: sanitizeDisplayText(item.label, TOKEN_LABEL_MAX_LENGTH) };
}

const ISSUE_KEYS: ReadonlySet<string> = new Set(['label', 'capabilities', 'expiresDays']);
const ROTATE_KEYS: ReadonlySet<string> = new Set(['expiresDays']);
const RENAME_KEYS: ReadonlySet<string> = new Set(['label']);

/** `GET /api/org-keys?status=active|all` → `{keys, activeCount, maxActive}` */
export async function handleListOrgKeys(call: AdminCall): Promise<AdminResponse> {
  const raw = call.request.query['status'] ?? 'active';
  if (raw !== 'active' && raw !== 'all') throw new AdminInputError("status 는 'active' | 'all' 이다.", 'invalid_status');
  const view = await listOrgKeysOp(call.deps.pool, sessionOf(call).organizationId, raw);
  return jsonResponse(200, { ...view, keys: view.keys.map(keyForDisplay) });
}

/** `POST /api/org-keys {label, capabilities, expiresDays?}` → 201 `{key, item}` — **평문은 이 응답 한 번뿐**. */
export async function handleIssueOrgKey(call: AdminCall): Promise<AdminResponse> {
  const session = sessionOf(call);
  const body = objectBody(call.request.body);
  rejectUnknownKeys(body, ISSUE_KEYS);
  const label = resolveTokenLabel(body['label'], true) ?? '';
  const capabilities = resolveOrgKeyCapabilities(body['capabilities']);
  const expiresAt = expiryFromDays(body['expiresDays'], call.deps.now());
  const issued = await audited(
    call.deps.pool,
    session,
    'org_key.issue',
    async (tx) => {
      await limitOrgKeyChanges(tx, session.organizationId);
      return issueOrgKeyOp(tx, { organizationId: session.organizationId, label, capabilities, createdByUserId: session.userId, expiresAt });
    },
    (result) => result.item.id,
  );
  return jsonResponse(201, { key: issued.key, item: keyForDisplay(issued.item) });
}

/** `POST /api/org-keys/{keyId}/revoke` → `{item}` — 멱등(이미 폐기면 그대로, 감사 없음). */
export async function handleRevokeOrgKey(call: AdminCall): Promise<AdminResponse> {
  const session = sessionOf(call);
  rejectUnknownKeys(optionalBody(call.request.body), new Set());
  const keyId = call.params['keyId'] ?? '';
  const result = await audited(
    call.deps.pool,
    session,
    'org_key.revoke',
    async (tx) => {
      await limitOrgKeyChanges(tx, session.organizationId);
      return revokeOrgKeyOp(tx, session.organizationId, keyId);
    },
    (change) => (change.changed ? change.item.id : undefined),
  );
  return jsonResponse(200, { item: keyForDisplay(result.item) });
}

/** `POST /api/org-keys/{keyId}/rotate {expiresDays?}` → 201 `{key, item, revoked}` — 같은 이름·권한 · 폐기+발급 한 트랜잭션. 감사 대상 = 새 키. */
export async function handleRotateOrgKey(call: AdminCall): Promise<AdminResponse> {
  const session = sessionOf(call);
  const body = optionalBody(call.request.body);
  rejectUnknownKeys(body, ROTATE_KEYS);
  const expiresAt = body['expiresDays'] === undefined || body['expiresDays'] === null ? undefined : expiryFromDays(body['expiresDays'], call.deps.now());
  const keyId = call.params['keyId'] ?? '';
  const rotated = await audited(
    call.deps.pool,
    session,
    'org_key.rotate',
    async (tx) => {
      await limitOrgKeyChanges(tx, session.organizationId);
      return supersedeOrgKeyOp(tx, { organizationId: session.organizationId, keyId, createdByUserId: session.userId, expiresAt });
    },
    (result) => result.item.id,
  );
  return jsonResponse(201, { key: rotated.key, item: keyForDisplay(rotated.item), revoked: keyForDisplay(rotated.revoked) });
}

/** `PATCH /api/org-keys/{keyId} {label}` → `{item}` — 활성 키만 · 같은 이름이면 감사 없음. */
export async function handleRenameOrgKey(call: AdminCall): Promise<AdminResponse> {
  const session = sessionOf(call);
  const body = objectBody(call.request.body);
  rejectUnknownKeys(body, RENAME_KEYS);
  const label = resolveTokenLabel(body['label'], true) ?? '';
  const keyId = call.params['keyId'] ?? '';
  const result = await audited(
    call.deps.pool,
    session,
    'org_key.rename',
    async (tx) => {
      await limitOrgKeyChanges(tx, session.organizationId);
      return renameOrgKeyOp(tx, session.organizationId, keyId, label);
    },
    (change) => (change.changed ? change.item.id : undefined),
  );
  return jsonResponse(200, { item: keyForDisplay(result.item) });
}
