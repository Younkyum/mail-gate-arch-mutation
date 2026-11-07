/**
 * src/passport/admin-view.ts — 콘솔(admin Lambda, DB 롤 `atmark_admin`)의 신원 탭: **상태 읽기**와 **게시·정지 요청 넣기**.
 *
 * 콘솔은 서명하지 않는다 — 키도 KMS 도 S3 도 없다(admin 역할에 그 권한이 없다, ADR-0006 · compute-stack). 하는 일은 outbox
 * (`passport_publish_requests`)에 요청 한 줄을 넣는 것뿐이고, 서명 Lambda 가 1분 안에 집어 서명·게시한다. 모양은 계약 T4 메모.
 *
 * **B5:** draft 의 DID·URL 은 `null` 이다 — 대시보드도 외부 표면이다(ADR-0002 B5 표). 판정은 `externalDidOf` 하나.
 * 공개키 **지문**(`keyFingerprint`)은 상태와 무관하게 싣는다(콘솔 v4 E8 — 카드 아트의 씨앗). DID·URL 이 아니고, 같은 값이 신원 블록
 * API(`/identity-blocks` `card`)로 draft 에서도 이미 나간다.
 */

import type { Queryable } from '../db/client';
import type { AgentId, PassportStatus } from '../db/schema';
import { publicKeyFingerprint } from '../tlog/leaf';
import { externalDidOf } from './did';
import { identityFileUrl } from './document';

export type IdentityRequestKind = 'publish' | 'suspend' | 'revoke' | 'resign';

export interface IdentityRequestSummary {
  readonly id: string;
  readonly kind: IdentityRequestKind;
  readonly status: 'pending' | 'signed';
  readonly requestedAt: string;
  readonly lastError: string | null;
}

export interface IdentityLastResult {
  readonly kind: IdentityRequestKind;
  readonly outcome: 'published' | 'suspended' | 'revoked' | 'unchanged' | 'rejected';
  readonly reason: string | null;
  readonly completedAt: string;
}

/** `GET /api/agents/{id}/identity` 의 본문(계약 T4 메모). */
export interface IdentityView {
  readonly status: PassportStatus;
  readonly did: string | null;
  readonly version: number;
  readonly publishedAt: string | null;
  readonly issuedAt: string | null;
  readonly validUntil: string | null;
  readonly didDocumentUrl: string | null;
  readonly passportUrl: string | null;
  readonly passportJwsUrl: string | null;
  readonly contentHash: string | null;
  readonly pending: IdentityRequestSummary | null;
  readonly lastResult: IdentityLastResult | null;
  /** `hex(SHA-256(원시 32바이트 공개키))` — 신원 블록 잎의 `key_fp` 와 같은 값. 키가 없거나 모양이 아니면 `null`. */
  readonly keyFingerprint: string | null;
  /** `agent_keypairs.algorithm`(지금은 `ed25519`). 키가 없으면 `null`. */
  readonly keyAlgorithm: string | null;
}

/** 요청을 받을 수 없다 — 라우트가 409 로 바꾼다(`code` 는 계약의 오류 이름). */
export class IdentityRequestConflict extends Error {
  readonly code: 'identity_revoked' | 'identity_not_published' | 'identity_request_pending' | 'identity_missing' | 'identity_org_not_active';

  constructor(code: IdentityRequestConflict['code'], message: string) {
    super(message);
    this.name = 'IdentityRequestConflict';
    this.code = code;
  }
}

interface CurrentRow {
  did: string;
  status: PassportStatus;
  version: number;
  content_hash: string | null;
  valid_from: Date | null;
  valid_until: Date | null;
  first_published_at: Date | null;
}

interface RequestRow {
  id: string;
  kind: IdentityRequestKind;
  status: 'pending' | 'signed' | 'done' | 'rejected' | 'failed';
  created_at: Date;
  last_error: string | null;
  outcome: IdentityLastResult['outcome'] | null;
  outcome_reason: string | null;
  completed_at: Date | null;
}

export async function readIdentityView(db: Queryable, agentId: AgentId): Promise<IdentityView | null> {
  const current = await db.query<CurrentRow>(
    `SELECT p.did, p.status, p.version, p.content_hash, d.valid_from, d.valid_until,
            (SELECT min(d1.valid_from) FROM passports p1 JOIN passport_documents d1 ON d1.passport_id = p1.id
              WHERE p1.agent_id = p.agent_id) AS first_published_at
       FROM passports p LEFT JOIN passport_documents d ON d.passport_id = p.id
      WHERE p.agent_id = $1 AND p.superseded_at IS NULL`,
    [agentId],
  );
  const row = current.rows[0];
  if (row === undefined) return null;
  // 처리 중이 여럿일 수 있다(대기 칸 둘 + 업로드 대기 `signed` — 202609241210). 보여 줄 하나: 대기 중 우선(정지·폐기) > 대기 중 > 최근 signed.
  const requests = await db.query<RequestRow>(
    `(SELECT id, kind, status, created_at, last_error, outcome, outcome_reason, completed_at
        FROM passport_publish_requests WHERE agent_id = $1 AND status IN ('pending', 'signed')
       ORDER BY (status = 'pending') DESC, (kind IN ('suspend', 'revoke')) DESC, created_at DESC, id DESC LIMIT 1)
     UNION ALL
     (SELECT id, kind, status, created_at, last_error, outcome, outcome_reason, completed_at
        FROM passport_publish_requests WHERE agent_id = $1 AND status IN ('done', 'rejected', 'failed')
       ORDER BY completed_at DESC, id DESC LIMIT 1)`,
    [agentId],
  );
  const pendingRow = requests.rows.find((request) => request.status === 'pending' || request.status === 'signed');
  const lastRow = requests.rows.find((request) => request.status !== 'pending' && request.status !== 'signed');

  const keypair = (
    await db.query<{ public_key: string; algorithm: string }>('SELECT public_key, algorithm::text AS algorithm FROM agent_keypairs WHERE agent_id = $1', [agentId])
  ).rows[0];
  let keyFingerprint: string | null = null;
  try {
    keyFingerprint = keypair === undefined ? null : publicKeyFingerprint(keypair.public_key);
  } catch {
    keyFingerprint = null;
  }

  const did = externalDidOf({ did: row.did, status: row.status });
  const published = did !== null;
  return {
    status: row.status,
    did,
    version: row.version,
    publishedAt: published && row.first_published_at !== null ? row.first_published_at.toISOString() : null,
    issuedAt: published && row.valid_from !== null ? row.valid_from.toISOString() : null,
    validUntil: published && row.valid_until !== null ? row.valid_until.toISOString() : null,
    didDocumentUrl: published ? identityFileUrl(agentId, 'did.json') : null,
    passportUrl: published ? identityFileUrl(agentId, 'passport.json') : null,
    passportJwsUrl: published ? identityFileUrl(agentId, 'passport.jws') : null,
    contentHash: published ? row.content_hash : null,
    pending:
      pendingRow === undefined
        ? null
        : {
            id: pendingRow.id,
            kind: pendingRow.kind,
            status: pendingRow.status as 'pending' | 'signed',
            requestedAt: pendingRow.created_at.toISOString(),
            lastError: pendingRow.last_error,
          },
    lastResult:
      lastRow === undefined || lastRow.completed_at === null
        ? null
        : {
            kind: lastRow.kind,
            // failed 는 outcome 이 비어 있을 수 있다(업로드 재시도 소진 전 서명 실패) — 콘솔에는 rejected 로 보인다.
            outcome: lastRow.outcome ?? 'rejected',
            reason: lastRow.outcome_reason ?? lastRow.last_error,
            completedAt: lastRow.completed_at.toISOString(),
          },
    keyFingerprint,
    keyAlgorithm: keypair?.algorithm ?? null,
  };
}

export interface RequestedIdentityChange {
  readonly request: { readonly id: string; readonly kind: IdentityRequestKind; readonly status: 'pending' | 'signed'; readonly requestedAt: string };
  /** 새로 넣었으면 `true`(감사 대상), 같은 종류가 이미 처리 중이라 그것을 돌려줬으면 `false`. */
  readonly created: boolean;
}

/**
 * 게시·정지 요청을 넣는다. **열린 트랜잭션 안에서** 부른다(감사 행과 같이 — `admin/context.ts` `audited`).
 *
 * 현재 상태로 불가능한 요청은 409 — 워커도 같은 규칙으로 거부하지만(`publisher.ts` `decide`), 콘솔이 먼저 알려야 사람이 1분을
 * 기다려 "거부됨" 을 보지 않는다:
 *   - `identity_revoked`(종단) · 정지는 `published` 에서만(`identity_not_published`).
 *   - **게시는 조직 검토가 끝난(`review_status = 'active'`) 조직만**(`identity_org_not_active`). 정지는 조직 상태와
 *     무관하게 된다(내리는 쪽은 언제나 열려 있다).
 *
 * 대기 중(pending) 요청과의 관계(202609241210 — 에이전트당 대기 칸은 일반(publish·resign) 하나 + 우선(suspend·revoke) 하나):
 *   - 같은 종류가 대기 중이면 그 요청을 돌려준다(새 행·감사 없음 — 두 번 누르기 멱등).
 *   - **정지는 대기 중인 게시·재서명과 나란히 들어간다**(우선 칸) — 서명 워커가 정지를 먼저 처리하고 그 게시·재서명을 대체한다.
 *     백오프 중인 게시 뒤에 비상 정지가 줄 서지 않는다. 대기 중인 폐기(운영자)가 있으면 409.
 *   - 게시는 정지·폐기가 대기 중이면 409(정지가 이긴다 — 사람이 1분 뒤 다시 누른다).
 *   - 게시와 대기 중인 재서명: 현재가 `published` 면 재서명이 곧 "현재 내용으로 게시" 라 그것을 돌려준다. **현재가 `suspended` 면
 *     돌려주지 않는다** — suspended 의 재서명은 suspended 를 이어 갈 뿐이라, 돌려주면 게시가 조용히 사라진다. 409.
 *   - 업로드만 남은(`signed`) 요청은 막지 않는다 — 버전은 이미 커밋됐고 업로드는 현재 버전을 올린다.
 */
export async function requestIdentityChange(
  db: Queryable,
  agentId: AgentId,
  kind: 'publish' | 'suspend',
  requestedBy: string,
): Promise<RequestedIdentityChange> {
  const current = await db.query<{ status: PassportStatus; organization_active: boolean }>(
    `SELECT p.status, (o.review_status = 'active') AS organization_active
       FROM passports p JOIN agents a ON a.id = p.agent_id JOIN organizations o ON o.id = a.organization_id
      WHERE p.agent_id = $1 AND p.superseded_at IS NULL`,
    [agentId],
  );
  const row = current.rows[0];
  if (row === undefined) throw new IdentityRequestConflict('identity_missing', '이 에이전트에는 신원(passport) 행이 없다.');
  const { status } = row;
  if (status === 'revoked') throw new IdentityRequestConflict('identity_revoked', '폐기된 신원은 다시 게시할 수 없다(종단).');
  if (kind === 'suspend' && status !== 'published') {
    throw new IdentityRequestConflict('identity_not_published', '게시(published) 상태에서만 정지할 수 있다.');
  }
  if (kind === 'publish' && !row.organization_active) {
    throw new IdentityRequestConflict('identity_org_not_active', '운영자 검토가 끝난(active) 조직의 에이전트만 신원을 게시할 수 있다.');
  }

  const pendingConflict = (): IdentityRequestConflict =>
    new IdentityRequestConflict('identity_request_pending', '이 에이전트의 다른 신원 요청이 처리 중이다 — 1~2분 뒤 다시 시도하라.');
  const returned = (request: InflightRow): RequestedIdentityChange => ({
    request: { id: request.id, kind: request.kind, status: request.status, requestedAt: request.created_at.toISOString() },
    created: false,
  });
  const readPending = async (): Promise<InflightRow[]> =>
    (
      await db.query<InflightRow>(
        `SELECT id, kind, status, created_at FROM passport_publish_requests WHERE agent_id = $1 AND status = 'pending' ORDER BY created_at, id`,
        [agentId],
      )
    ).rows;

  const pending = await readPending();
  const same = pending.find((request) => request.kind === kind);
  if (same !== undefined) return returned(same);
  if (kind === 'publish') {
    if (pending.some((request) => request.kind === 'suspend' || request.kind === 'revoke')) throw pendingConflict();
    const resign = pending.find((request) => request.kind === 'resign');
    if (resign !== undefined) {
      // published 의 재서명 = 현재 내용으로 게시. suspended 의 재서명은 suspended 를 이어 갈 뿐 — 게시를 충족하지 않는다.
      if (status === 'published') return returned(resign);
      throw pendingConflict();
    }
  } else if (pending.some((request) => request.kind === 'revoke')) {
    throw pendingConflict();
  }

  const inserted = await db.query<{ id: string; kind: IdentityRequestKind; status: 'pending'; created_at: Date }>(
    `INSERT INTO passport_publish_requests (agent_id, kind, requested_by) VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING
     RETURNING id, kind, status, created_at`,
    [agentId, kind, requestedBy],
  );
  const created = inserted.rows[0];
  if (created !== undefined) {
    return { request: { id: created.id, kind: created.kind, status: created.status, requestedAt: created.created_at.toISOString() }, created: true };
  }
  // 경쟁에서 졌다(방금 다른 요청이 칸을 잡았다) — 같은 종류면 그것, 아니면 409.
  const raced = (await readPending()).find((request) => request.kind === kind);
  if (raced !== undefined) return returned(raced);
  throw pendingConflict();
}

interface InflightRow {
  id: string;
  kind: IdentityRequestKind;
  status: 'pending';
  created_at: Date;
}
