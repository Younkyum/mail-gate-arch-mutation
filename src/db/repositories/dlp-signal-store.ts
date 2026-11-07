/**
 * src/db/repositories/dlp-signal-store.ts — 발신 DLP 가 비교할 **지문**(ADR-0016 B, 202610041000). 발송 서비스(`api/outbound-service.ts`)가 관문 앞에서
 * 한 번 부른다.
 *
 *   - 코드 지문 — 이 에이전트가 최근 24시간에 읽은 인증 코드의 HMAC(`agent_code_fingerprints`). 기준은 발송 시각(`now`).
 *   - 복사 지문 — 이 에이전트가 최근 30일에 받은 메일의 winnowing 지문(`inbound_fingerprints`). 가장 최근 `COPY_SOURCE_LIMIT` 통까지.
 *     **참여자**(ADR-0016 M1 배선 계약 5 · 리뷰 L3 · 재검증 R2)는 그 메일이 **도착하기 전에** 그 스레드로 보낸(sent) 발신의 수신자 ∪ 그 전에 도착한
 *     인증된 수신 발신자 ∪ 그 메일 자체의 인증된 발신자다(받은 메일의 To/Cc 아님 — `participantsOf`).
 *
 * 원문은 없다 — 지문(HMAC)과 주소·도메인뿐. 비교는 순수 함수(`security/dlp/scan.ts`)가 한다.
 */

import type { AgentId } from '../schema';
import type { CodeFingerprint } from '../../security/dlp/codes';
import type { InboundCopySource } from '../../security/dlp/scan';
import type { Queryable } from '../client';
import { selectRows } from './rows';

/** 코드 지문 보존(= 비교 창) — 24시간. */
export const CODE_FINGERPRINT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** 복사 지문 보존(= 비교 창) — 30일. */
export const COPY_FINGERPRINT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * 한 번에 비교하는 받은 메일 상한 — 가장 최근 것부터. 넘친 옛 메일은 이 발송의 복사 판정에서 빠진다(알려진 한계 — 30일에 2 000 통을 넘게 받는
 * 에이전트는 그보다 오래된 메일의 복사를 보지 못한다). 비교 비용은 발신 지문 집합 하나 × 이 수의 집합 겹침이라 선형이다.
 */
export const COPY_SOURCE_LIMIT = 2_000;

export interface DlpSignals {
  readonly codeFingerprints: readonly CodeFingerprint[];
  readonly inboundCopies: readonly InboundCopySource[];
  /**
   * 요청한 메일(`load` 의 `targets`)의 참여자(소문자) — 회신 라우트가 그 자리에서 지문화한 대상 메일(재검증 N2 ①)에 저장된 지문과 같은 제외를 쓰려고.
   * 키는 메일 id. 없으면 빈 목록으로 친다(제외 없음 — 엄한 쪽).
   */
  readonly targetParticipants?: ReadonlyMap<string, readonly string[]>;
}

/** 즉석 비교할 받은 메일 하나 — 참여자를 그 메일 기준으로 계산한다. */
export interface DlpTarget {
  readonly inboundMessageId: string;
  readonly threadId: string;
}

export interface DlpSignalStore {
  load(agentId: AgentId, now: Date, targets?: readonly DlpTarget[]): Promise<DlpSignals>;
}

interface CodeRow {
  kid: string;
  mac: string;
  origin_domain: string;
}

interface CopyRow {
  inbound_message_id: string;
  sender: string;
  thread_id: string;
  received_at: Date;
  kid: string;
  fingerprints: string[];
}

interface ParticipantRow {
  thread_id: string;
  address: string;
  at: Date;
  /** 수신 발신자 행이면 그 메일 id, 우리 발신 수신자 행이면 `null`. */
  inbound_id: string | null;
}

/**
 * 받은 메일 한 통의 **참여자**(배선 계약 5 · 리뷰 L3 · 재검증 R2): 같은 권한용 스레드에서 그 메일이 **도착하기 전에** 우리가 보낸(sent) 발신의 수신자 ∪
 * 그 전에 도착한 **인증된** 수신 발신자 ∪ 그 메일 자체의 인증된 발신자. 시각을 자르지 않으면 에이전트가 공격자를 넣은 무해한 회신을 한 번 보내는 것만으로
 * 공격자가 참여자가 되고, 그 뒤 전문 복사가 통과한다(참여자 세탁, Q13).
 */
function participantsOf(rows: readonly ParticipantRow[], source: { readonly id: string; readonly threadId: string; readonly receivedAt: Date }): string[] {
  const out = new Set<string>();
  for (const row of rows) {
    if (row.thread_id !== source.threadId) continue;
    if (row.at.getTime() < source.receivedAt.getTime() || row.inbound_id === source.id) out.add(row.address.toLowerCase());
  }
  return [...out];
}

export function createPostgresDlpSignalStore(db: Queryable): DlpSignalStore {
  return {
    async load(agentId, now, targets = []) {
      const [codes, copies, targetRows] = await Promise.all([
        selectRows<CodeRow>(
          db,
          `SELECT kid, mac, origin_domain FROM agent_code_fingerprints WHERE agent_id = $1 AND created_at > $2`,
          [agentId, new Date(now.getTime() - CODE_FINGERPRINT_WINDOW_MS)],
        ),
        selectRows<CopyRow>(
          db,
          `SELECT f.inbound_message_id, f.sender, f.thread_id, m.received_at, f.kid, f.fingerprints
             FROM inbound_fingerprints f JOIN inbound_messages m ON m.id = f.inbound_message_id
            WHERE f.agent_id = $1 AND f.created_at > $2
            ORDER BY f.created_at DESC
            LIMIT $3`,
          [agentId, new Date(now.getTime() - COPY_FINGERPRINT_WINDOW_MS), COPY_SOURCE_LIMIT],
        ),
        targets.length === 0
          ? Promise.resolve([] as { id: string; thread_id: string; received_at: Date }[])
          : selectRows<{ id: string; thread_id: string; received_at: Date }>(
              db,
              `SELECT id, thread_id, received_at FROM inbound_messages WHERE agent_id = $1 AND id = ANY($2::uuid[])`,
              [agentId, targets.map((target) => target.inboundMessageId)],
            ),
      ]);
      const threads = [...new Set([...copies.map((row) => row.thread_id), ...targetRows.map((row) => row.thread_id)])];
      const participantRows =
        threads.length === 0
          ? []
          : await selectRows<ParticipantRow>(
              db,
              `SELECT m.thread_id, r.address, m.sent_at AS at, NULL::uuid AS inbound_id
                 FROM messages m JOIN outbound_recipients r ON r.message_id = m.id
                WHERE m.agent_id = $1 AND m.thread_id = ANY($2::uuid[]) AND m.direction = 'outbound' AND m.status = 'sent'
                  AND m.sent_at IS NOT NULL
               UNION ALL
               SELECT i.thread_id, i.from_address, i.received_at, i.id
                 FROM inbound_messages i
                WHERE i.agent_id = $1 AND i.thread_id = ANY($2::uuid[]) AND i.from_authenticated`,
              [agentId, threads],
            );
      return {
        codeFingerprints: codes.map((row) => ({ kid: row.kid, mac: row.mac, originDomain: row.origin_domain })),
        inboundCopies: copies.map((row) => ({
          inboundMessageId: row.inbound_message_id,
          senderAddress: row.sender,
          threadId: row.thread_id,
          threadParticipants: participantsOf(participantRows, { id: row.inbound_message_id, threadId: row.thread_id, receivedAt: row.received_at }),
          shingles: { kid: row.kid, fingerprints: row.fingerprints },
        })),
        targetParticipants: new Map(
          targetRows.map((row) => [row.id, participantsOf(participantRows, { id: row.id, threadId: row.thread_id, receivedAt: row.received_at })]),
        ),
      };
    },
  };
}
