/**
 * AC-0 통합 테스트의 원자료 심기 — 과거 시각은 SQL 로 직접 넣는다(저장소·CLI 에는 시각 인자가 없다).
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

import type { AgentId } from '../../../../src/db/schema';
import { hex64 } from '../../db/support/harness';

export type DayFn = (n: number, h?: number) => Date;

export async function newThread(db: Pool, agentId: AgentId): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO threads (agent_id, started_by, starter_address) VALUES ($1, 'agent', NULL) RETURNING id`,
    [agentId],
  );
  return (result.rows[0] as { id: string }).id;
}

/** 성공 발송 한 통(`status='sent'`) + 수신자. */
export async function sent(db: Pool, agentId: AgentId, sentAt: Date, recipients: readonly string[], threadId?: string): Promise<void> {
  const thread = threadId ?? (await newThread(db, agentId));
  const result = await db.query<{ id: string }>(
    `INSERT INTO messages
       (agent_id, direction, from_address_hash, from_domain, status, message_id_header, idempotency_key,
        request_hash, recipient_count, created_at, ses_message_id, sent_at, thread_id)
     VALUES ($1, 'outbound', $2, 'atmark.ai', 'sent', $3, $4, $5, $6, $7, $8, $7, $9) RETURNING id`,
    [agentId, hex64(), `<${randomUUID()}@atmark.ai>`, randomUUID(), hex64(), recipients.length, sentAt, `ses-${randomUUID()}`, thread],
  );
  const messageId = (result.rows[0] as { id: string }).id;
  for (const address of recipients) {
    await db.query('INSERT INTO outbound_recipients (message_id, address) VALUES ($1, $2)', [messageId, address]);
  }
}

export interface InboundSeed {
  readonly receivedAt: Date;
  readonly from: string;
  readonly envelopeSender: string | null;
  readonly recipient: string;
  readonly forwardedFor?: string;
  readonly forwardedTo?: string;
  readonly threadId?: string;
}

export async function inbound(db: Pool, agentId: AgentId, seed: InboundSeed): Promise<void> {
  const thread = seed.threadId ?? (await newThread(db, agentId));
  const ses = `0100${randomUUID().replace(/-/g, '')}`;
  await db.query(
    `INSERT INTO inbound_messages
       (agent_id, envelope_recipient, ses_message_id, thread_id, new_thread_reason, from_address, from_domain,
        from_authenticated, auto_submitted, envelope_sender, forwarded_for_header, forwarded_to_header,
        spf_verdict, dkim_verdict, dmarc_verdict, spam_verdict, virus_verdict, headers_truncated,
        raw_storage_key, parsed_storage_key, text_source, has_html_text, attachment_count, received_at,
        scanner_version, injection_risk, quarantined, sender_trust)
     VALUES ($1, $2, $3, $4, 'no_header_ids', $5, split_part($5, '@', 2), false, false, $6, $8, $9,
             'pass', 'pass', 'fail', 'pass', 'pass', false,
             'inbound/raw/' || $3, 'inbound/parsed/' || $3 || '.json', 'plain', false, 0, $7,
             'test-v0', 'none', false, 'unknown')`,
    [agentId, seed.recipient, ses, thread, seed.from, seed.envelopeSender, seed.receivedAt, seed.forwardedFor ?? null, seed.forwardedTo ?? null],
  );
}

/** `firstDay` 부터 7일에 활동 분모 3종을 채운다(신규 외부 8명 · 성공 36 · 3턴 스레드 3). */
export async function busyWeek(
  db: Pool,
  { agentId, agentAddress, day }: { readonly agentId: AgentId; readonly agentAddress: string; readonly day: DayFn },
  firstDay: number,
): Promise<void> {
  for (let i = 0; i < 30; i += 1) await sent(db, agentId, day(firstDay + (i % 7), 10), [`new${String(i % 5)}@client.kr`]);
  for (let t = 0; t < 3; t += 1) {
    const thread = await newThread(db, agentId);
    const peer = `thread${String(t)}@client.kr`;
    await sent(db, agentId, day(firstDay + 1 + t, 9), [peer], thread);
    await inbound(db, agentId, { receivedAt: day(firstDay + 1 + t, 11), from: peer, envelopeSender: peer, threadId: thread, recipient: agentAddress });
    await sent(db, agentId, day(firstDay + 1 + t, 13), [peer], thread);
  }
}
