/**
 * src/passport/public-directory.ts — 공개 API(`GET /v1/identity/{address}`)의 **읽기**. 앱 롤(`atmark_app`)로 돈다(api Lambda).
 *
 * 읽는 칸을 **SQL 에서** 좁힌다 — 에이전트(이름 대신 서명 문서의 이름을 쓰므로 상태·생성 시각뿐) · 현재 passport 버전 · 서명 문서 ·
 * 공개키 · 발신·수신 모드 · 조직의 발송 차단 상태 네 칸(검토·결제·동결·소유자 정지 — **불리언 판정으로만** 넘긴다). `key_ref`·조직·정책 수치·목록은 **SELECT 목록에 없다**(행을 통째로 읽고 나중에 고르는 길이 없다).
 *
 * `draft`(한 번도 게시되지 않음)는 **없는 것과 같다**(`null`) — B5: 게시 전 DID 는 어떤 외부 표면에도 나가지 않는다. 판정은
 * `externalDidOf`(did.ts) 하나를 지난다(ADR-0002 B5 집행 지점). suspended·revoked 는 게시된 적이 있으므로 그대로 보인다(§4B.1b —
 * 문서를 내리지 않는다).
 *
 * **유효 대표 주소만 찾는다**(메일 기본기 1차 선행, 결정 D5 — 별칭은 비공개 · ADR-0014 2026-10 개정 — 대표 = `atmark_agent_primary_address`). 대표가
 * 아닌 주소는 없는 주소와 같은 404 다 — 공개 조회가 "이 주소도 같은 에이전트" 라는 연결을 드러내지 않는다. 고객 도메인을 대표로 고른 에이전트는 그
 * 고객 주소로만 찾히고, **잠든 앵커(`ax--`)는 404** 다(존재를 밝히지 않는다). 대표가 무효("주소 없음")면 어느 주소로도 찾히지 않는다.
 */

import type { Queryable } from '../db/client';
import { BILLING_STATUSES_BLOCKING_OUTBOUND, toAgentId, type AgentStatus, type PassportStatus } from '../db/schema';
import { externalDidOf } from './did';
import { identityFileUrl } from './document';
import type { PublicIdentitySource } from './public-view';

/**
 * 공개 API 가 받는 주소 모양. 틀리면 **없는 것과 같은 404**(400 이 아니다 — 형식 오류로 존재 여부를 가르지 않는다).
 * 로컬 파트에 대문자가 없다 — 저장 규약(`agent_addresses.address = lower(address)`)이 소문자다.
 */
const ADDRESS_SHAPE = /^[^@\sA-Z]{1,64}@[a-z0-9.-]{1,253}$/;

export interface PublicIdentityDirectory {
  findByAddress(address: string): Promise<PublicIdentitySource | null>;
}

interface DirectoryRow {
  agent_id: string;
  agent_status: AgentStatus;
  org_review_status: string;
  org_billing_status: string;
  org_abuse_freeze: boolean;
  org_owner_paused: boolean;
  did: string;
  passport_status: PassportStatus;
  version: number;
  content_hash: string;
  document: string;
  valid_from: Date;
  valid_until: Date;
  public_key: string;
  outbound_mode: string | null;
  inbound_mode: string | null;
}

/**
 * ★ **정규형만 받는다.** 저장 규약과 같은 모양(소문자·공백 없음)이 아니면 `null` → 404.
 *
 * 고쳐서(`trim().toLowerCase()`) 받으면 `A@x`·` a@x`·`a@x\n` 이 같은 신원을 돌려주면서 CloudFront 에는 **서로 다른 캐시 키**로 남아
 * 정지·폐기 뒤에도 옛 `published` 응답이 남을 수 있고, 대소문자 조합만으로 오리진(전역 5 rps 스로틀)을 두드릴 수 있다. 정규형이 아니면
 * **존재와 무관하게** 같은 404 이므로(존재 누설 없음) 그 응답은 캐시돼도 낡지 않는다.
 */
export function normalizePublicAddress(raw: string): string | null {
  return ADDRESS_SHAPE.test(raw) ? raw : null;
}

/** 조직 층의 발송 차단 — Stage 0 과 같은 조건(`src/policy/rules/kill-switch.ts`). 공개 `capabilities.can_send` 가 이것을 반영한다. */
function organizationBlocksSending(row: DirectoryRow): boolean {
  return (
    row.org_review_status !== 'active' ||
    row.org_abuse_freeze ||
    row.org_owner_paused ||
    (BILLING_STATUSES_BLOCKING_OUTBOUND as readonly string[]).includes(row.org_billing_status)
  );
}

export function createPostgresIdentityDirectory(db: Queryable): PublicIdentityDirectory {
  return {
    async findByAddress(raw: string): Promise<PublicIdentitySource | null> {
      const address = normalizePublicAddress(raw);
      if (address === null) return null;
      const result = await db.query<DirectoryRow>(
        `SELECT a.id AS agent_id, a.status AS agent_status,
                o.review_status::text AS org_review_status, o.billing_status::text AS org_billing_status,
                o.abuse_freeze AS org_abuse_freeze, o.owner_paused AS org_owner_paused,
                p.did, p.status AS passport_status, p.version, p.content_hash,
                d.document, d.valid_from, d.valid_until,
                k.public_key,
                pol.outbound_mode::text AS outbound_mode, pol.inbound_mode::text AS inbound_mode
           FROM agent_addresses addr
           JOIN agents a ON a.id = addr.agent_id
           JOIN organizations o ON o.id = a.organization_id
           JOIN passports p ON p.agent_id = a.id AND p.superseded_at IS NULL
           JOIN passport_documents d ON d.passport_id = p.id
           JOIN agent_keypairs k ON k.agent_id = a.id
           LEFT JOIN agent_policies pol ON pol.agent_id = a.id
          WHERE addr.address = $1 AND addr.retired_at IS NULL AND addr.address = atmark_agent_primary_address(addr.agent_id)`,
        [address],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      const did = externalDidOf({ did: row.did, status: row.passport_status });
      if (did === null || row.passport_status === 'draft') return null;

      // 서명 문서에서 이름·생성 월·attestation 을 꺼낸다 — 공개 값은 검증 가능한 값과 같아야 한다.
      let subject: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(row.document) as { credentialSubject?: unknown };
        if (typeof parsed.credentialSubject === 'object' && parsed.credentialSubject !== null) {
          subject = parsed.credentialSubject as Record<string, unknown>;
        }
      } catch {
        // 문서가 깨졌으면(있을 수 없는 일 — DB 가 해시를 대조한다) 공개하지 않는다.
        return null;
      }
      const agentId = toAgentId(row.agent_id);
      return {
        address,
        did,
        name: typeof subject['name'] === 'string' ? subject['name'] : '',
        agentStatus: row.agent_status,
        passportStatus: row.passport_status,
        version: row.version,
        issuedAt: row.valid_from,
        validUntil: row.valid_until,
        contentHash: row.content_hash,
        publicKey: row.public_key,
        createdMonth: typeof subject['createdMonth'] === 'string' ? subject['createdMonth'] : '',
        attestations: Array.isArray(subject['attestations']) ? (subject['attestations'] as unknown[]) : [],
        outboundMode: row.outbound_mode,
        inboundMode: row.inbound_mode,
        // 조직의 **사실**(검토 상태·결제·동결)은 공개하지 않는다 — 판정 결과 불리언 둘만 넘긴다.
        organizationSendingBlocked: organizationBlocksSending(row),
        // 수신은 검토 상태만 본다(`inbound-store.ts` — 검토 전·거절 조직의 수신은 `org_not_active` 로 거부).
        organizationReceivingBlocked: row.org_review_status !== 'active',
        didDocumentUrl: identityFileUrl(agentId, 'did.json'),
        passportUrl: identityFileUrl(agentId, 'passport.json'),
        passportJwsUrl: identityFileUrl(agentId, 'passport.jws'),
      };
    },
  };
}
