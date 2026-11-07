/**
 * src/db/repositories/reply-target-store.ts — 회신 라우트가 "무엇에 답하는가" 를 찾는 조회 (P3b).
 *
 * **이 조회는 권한을 주지 않는다.** 라우트는 여기서 받은 값으로 헤더(`In-Reply-To`)·기본 수신자·제목을
 * 정할 뿐이고, 그 회신이 승인 없이 나가도 되는지는 관문의 로더가 **따로 다시** 읽어 판정한다
 * (`policy-source.ts` `loadThread` → `policy-loader.resolveThreadReply`). 두 조회를 합치지 않는 이유:
 * 라우트의 조회는 관문 밖(트랜잭션 밖)이고, 판정은 관문 안의 한 스냅샷에서 해야 한다.
 *
 * - **에이전트 범위로 찾는다.** 남의 에이전트의 수신 메일 id 는 `null`(→ 404) — 존재 여부도 새지 않는다.
 * - `thread_id` 는 **권한용**이다. `display_thread_id` 는 읽지 않는다.
 * - `Reply-To` 는 **저장돼 있지 않다**(`inbound_messages` 에 컬럼이 없다) — 공격자가 정하는 값이다.
 */

import { RECEIVE_ONLY_ADDRESSES } from '../../identity/address';
import type { Queryable } from '../client';
import { dormantAnchorSql, hasPrimaryChanges } from './primary-changes-probe';
import { selectRow } from './rows';
import { releasedToAgent } from './inbound-read-store';

/** 답하는 수신 메일에서 회신이 쓰는 것 전부. */
export interface ReplyTarget {
  readonly inboundMessageId: string;
  /** **권한용** `thread_id`. */
  readonly threadId: string;
  /** 소문자(`inbound_messages` CHECK). 기본 수신자다. */
  readonly fromAddress: string;
  /** DMARC pass. `false` 면 그 `From` 은 사칭일 수 있다 — 로더가 스레드 참여자로 치지 않는다. */
  readonly fromAuthenticated: boolean;
  readonly subject: string | null;
  /** `<…>`. 외부인이 정한 값 — 헤더에 쓰기 전에 `build.ts` 가 다시 검사한다. */
  readonly messageIdHeader: string | null;
  readonly inReplyTo: string | null;
  /**
   * 격리됐는가. 라우트는 격리 메일에 답하지 않는다(404 — 에이전트가 볼 수 없는 메일, `forward.ts` 와 같은 선).
   * 정책도 스레드의 최신 인증 수신이 격리면 자동 승인을 열지 않는다 — 두 층이 각자 막는다.
   */
  readonly quarantined: boolean;
  /**
   * 회신 `from` 을 생략했을 때의 발신 주소(메일 기본기 2차 — 리드 판정 2026-09-27): 이 메일을 받은 **봉투 주소가 이 에이전트의 활성 주소**면
   * 그것(별칭으로 받은 메일에는 별칭으로 답한다), 아니면(폐기한 별칭 · 옛 행 · **수신 전용 주소** `abuse@`·`postmaster@` — `RECEIVE_ONLY_ADDRESSES`,
   * 202609301540 · 잠든 앵커) **유효 대표 주소**(ADR-0014 2026-10 개정 — 고객 도메인을 대표로 골랐으면 그 주소). 둘 다 없으면 `null`(라우트가 400).
   * 선택 필드 — 가짜 조회(테스트)는 비워 둘 수 있다(그러면 `from` 이 필수다).
   */
  readonly defaultFromAddress?: string | null;
  /**
   * 파싱 결과 문서 키 — 수신자를 바꾼 회신이면 라우트가 원문을 읽어 복사 비교에 넣는다(ADR-0016 재검증 N2 ①). 가짜 조회(테스트)는 비울 수 있다 —
   * 그러면 라우트는 원문 없이(빈 글) 비교 대상만 싣는다.
   */
  readonly parsedStorageKey?: string;
}

export interface ReplyTargetLookup {
  find(agentId: string, inboundMessageId: string): Promise<ReplyTarget | null>;
}

interface ReplyTargetRow {
  id: string;
  thread_id: string;
  from_address: string;
  from_authenticated: boolean;
  subject: string | null;
  message_id_header: string | null;
  in_reply_to: string | null;
  quarantined: boolean;
  default_from: string | null;
  parsed_storage_key: string;
}

export function createPostgresReplyTargetLookup(db: Queryable): ReplyTargetLookup {
  return {
    async find(agentId: string, inboundMessageId: string): Promise<ReplyTarget | null> {
      // 대표 주소 = **유효 대표**(ADR-0014 2026-10 개정 — `atmark_agent_primary_address`, 무효한 고객 선택이면 NULL → 라우트 400) · 봉투 주소가 **잠든
      // 앵커**면 그 주소로 답하지 않는다(계약 `anchorDormantOf`). 선택 표가 없는 스키마에서는 예전 질의(그때는 잠든 앵커가 없다 — `hasPrimaryChanges`).
      const pointer = await hasPrimaryChanges(db, db);
      const primary = pointer ? 'atmark_agent_primary_address(i.agent_id)' : '(SELECT a.address FROM agent_addresses a WHERE a.agent_id = i.agent_id AND a.is_primary)';
      const dormant = pointer ? dormantAnchorSql('a') : 'false';
      const row = await selectRow<ReplyTargetRow>(
        db,
        // 폐기 칸은 행 JSON 에서 읽는다(202609270110 전 스키마에서도 돈다 — `policy-source.ts` 와 같은 규율).
        `SELECT i.id, i.thread_id, i.from_address, i.from_authenticated, i.subject, i.message_id_header, i.in_reply_to, i.quarantined, i.parsed_storage_key,
                coalesce(
                  (SELECT a.address FROM agent_addresses a
                    WHERE a.agent_id = i.agent_id AND a.address = i.envelope_recipient AND (to_jsonb(a) ->> 'retired_at') IS NULL
                      AND a.address <> ALL ($3::text[]) AND NOT ${dormant}),
                  ${primary}) AS default_from
           FROM inbound_messages i
          -- AI 감시 보류 중인 메일에는 답할 수 없다(보안 리뷰 M3 — 보이지 않는 메일 = 없는 메일, 404). 보류는 최대 30초.
          WHERE i.id = $1::uuid AND i.agent_id = $2 AND ${releasedToAgent('i')}`,
        [inboundMessageId, agentId, [...RECEIVE_ONLY_ADDRESSES]],
      );
      if (row === null) return null;
      return {
        inboundMessageId: row.id,
        threadId: row.thread_id,
        fromAddress: row.from_address,
        fromAuthenticated: row.from_authenticated,
        subject: row.subject,
        messageIdHeader: row.message_id_header,
        inReplyTo: row.in_reply_to,
        quarantined: row.quarantined,
        defaultFromAddress: row.default_from,
        parsedStorageKey: row.parsed_storage_key,
      };
    },
  };
}
