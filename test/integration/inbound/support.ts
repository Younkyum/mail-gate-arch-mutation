/**
 * test/integration/inbound/support.ts — 수신 파이프라인을 **실제 Postgres + 로컬 객체 저장소**로 구동하는 지반.
 *
 * SES 가 하는 두 일(원문을 `inbound/raw/{id}` 에 쓰기, SNS 알림)을 `deliver` 가 흉내 낸다. 소비자는 운영과
 * 같은 코드(`consumeInboundMail`)이고, 저장소도 운영과 같은 구현(`inbound-store`·`thread-store`)이다 —
 * 가짜는 객체 저장소(S3 → 디스크) 하나뿐이다.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

import type { SendEmailCommand } from '@aws-sdk/client-sesv2';
import type { Pool } from 'pg';

import { createContactDocumentReader, createPostgresContactIntake } from '../../../src/contact/contact-store';
import { createContactDestinationLoader } from '../../../src/contact/destination';
import { createPostgresInboundPolicySource } from '../../../src/db/repositories/inbound-policy-store';
import { createPostgresInboundWatchSource } from '../../../src/db/repositories/watch-settings-store';
import { createPostgresAgentSignupStore } from '../../../src/db/repositories/agent-signup-store';
import { createPostgresInboundStore } from '../../../src/db/repositories/inbound-store';
import { createPostgresThreadLookup } from '../../../src/db/repositories/thread-store';
import { createPostgresTrustFacts } from '../../../src/db/repositories/trust-facts-store';
import { createInboundArtifactStore } from '../../../src/storage/inbound-artifact-store';
import { createLocalObjectStore } from '../../../src/storage/local-object-store';
import { ObjectNotFoundError, type ObjectStore } from '../../../src/storage/object-store';
import { createRawMailStore } from '../../../src/storage/raw-mail-store';
import type { InboundMessageRow } from '../../../src/db/schema';
import { createContactForwarder, type ContactForwarder, type ContactForwarderDependencies } from '../../../src/notify/contact-forwarder';
import {
  consumeInboundMail,
  type InboundConsumerDependencies,
  type InboundMailOutcome,
} from '../../../src/workers/inbound-consumer';
import { TEST_DLP_KEYRING } from '../../support/injection-doubles';
import { testPool } from '../db/support/harness';

export function newObjectStore(): ObjectStore {
  return createLocalObjectStore({ directory: mkdtempSync(join(tmpdir(), 'atmark-inbound-')), env: {} });
}

export function consumerDeps(pool: Pool, objects: ObjectStore): InboundConsumerDependencies {
  return {
    receipts: createPostgresInboundStore(pool),
    threads: createPostgresThreadLookup(pool),
    rawMail: createRawMailStore(objects),
    artifacts: createInboundArtifactStore(objects),
    trust: createPostgresTrustFacts(pool),
    inboundPolicy: createPostgresInboundPolicySource(pool),
    watch: createPostgresInboundWatchSource(pool),
    signups: createPostgresAgentSignupStore(pool),
    contact: createPostgresContactIntake(pool, objects),
    dlpKeys: TEST_DLP_KEYRING,
  };
}

/** SES 메시지 ID 모양(실측 형태를 흉내 낸다). */
export function newSesMessageId(): string {
  return `0100${randomBytes(6).toString('hex')}-${randomUUID()}-000000`;
}

export interface EmlOptions {
  readonly from: string;
  readonly to?: string;
  readonly subject?: string;
  readonly messageId?: string;
  readonly inReplyTo?: string;
  readonly references?: string;
  readonly text?: string;
  readonly html?: string;
  readonly attachment?: {
    readonly filename: string;
    readonly contentType: string;
    readonly bytes: Uint8Array;
    /** `Content-ID` 헤더 값(없으면 싣지 않는다). */
    readonly contentId?: string;
  };
  /** `Date` 헤더 값. 기본은 고정값. */
  readonly date?: string;
  /** 날 헤더 줄(`Name: value`) — 거부 경로(From 두 개 등)용. */
  readonly extraHeaders?: readonly string[];
}

/** 최소 RFC 5322 메일. CRLF. */
export function eml(options: EmlOptions): Uint8Array {
  const headers = [
    `From: ${options.from}`,
    `To: ${options.to ?? 'someone@atmark.ai'}`,
    `Subject: ${options.subject ?? 'hello'}`,
    `Date: ${options.date ?? 'Wed, 23 Sep 2026 10:00:00 +0900'}`,
    `Message-ID: ${options.messageId ?? `<${randomUUID()}@Mail.Example.COM>`}`,
    ...(options.inReplyTo === undefined ? [] : [`In-Reply-To: ${options.inReplyTo}`]),
    ...(options.references === undefined ? [] : [`References: ${options.references}`]),
    ...(options.extraHeaders ?? []),
    'MIME-Version: 1.0',
  ];
  const text = options.text ?? 'plain body';
  const boundary = `b-${randomUUID()}`;
  const parts: string[] = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(text, 'utf8').toString('base64'),
  ];
  if (options.html !== undefined) {
    parts.push(
      `--${boundary}`,
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(options.html, 'utf8').toString('base64'),
    );
  }
  if (options.attachment !== undefined) {
    parts.push(
      `--${boundary}`,
      `Content-Type: ${options.attachment.contentType}; name="${options.attachment.filename}"`,
      `Content-Disposition: attachment; filename="${options.attachment.filename}"`,
      ...(options.attachment.contentId === undefined ? [] : [`Content-ID: ${options.attachment.contentId}`]),
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(options.attachment.bytes).toString('base64'),
    );
  }
  parts.push(`--${boundary}--`, '');
  const raw = [...headers, `Content-Type: multipart/mixed; boundary="${boundary}"`, '', ...parts].join('\r\n');
  return new TextEncoder().encode(raw);
}

export interface NotifyOptions {
  readonly sesMessageId: string;
  readonly recipients: readonly string[];
  readonly source?: string;
  readonly dmarc?: string;
  readonly spf?: string;
  readonly dkim?: string;
  readonly spam?: string;
  readonly virus?: string;
  /** SES 가 DMARC 를 판정한 From(`commonHeaders.from`). */
  readonly commonFrom?: readonly string[];
  readonly headers?: readonly { readonly name: string; readonly value: string }[];
  readonly objectKey?: string;
  /** SES 가 받은 시각(`receipt.timestamp` = 행의 `received_at`). 기본은 고정값 — 시각 순서를 보는 테스트만 넘긴다. */
  readonly receivedAt?: string;
}

/** SES receipt(S3 액션) 알림을 SNS 봉투에 싼 SQS 본문. */
export function notification(options: NotifyOptions): string {
  const status = (value: string | undefined, fallback: string): { status: string } => ({ status: value ?? fallback });
  const body = {
    notificationType: 'Received',
    mail: {
      timestamp: '2026-09-23T01:00:00.000Z',
      source: options.source ?? 'bounce@mail.example.com',
      messageId: options.sesMessageId,
      destination: [...options.recipients],
      headersTruncated: false,
      headers: options.headers ?? [],
      commonHeaders: { from: options.commonFrom ?? [] },
    },
    receipt: {
      timestamp: options.receivedAt ?? '2026-09-23T01:00:01.000Z',
      recipients: [...options.recipients],
      spfVerdict: status(options.spf, 'PASS'),
      dkimVerdict: status(options.dkim, 'PASS'),
      dmarcVerdict: status(options.dmarc, 'PASS'),
      spamVerdict: status(options.spam, 'PASS'),
      virusVerdict: status(options.virus, 'PASS'),
      action: {
        type: 'S3',
        topicArn: 'arn:aws:sns:ap-northeast-2:123456789012:atmark-inbound-mail',
        bucketName: 'bucket',
        objectKeyPrefix: 'inbound/raw/',
        objectKey: options.objectKey ?? `inbound/raw/${options.sesMessageId}`,
      },
    },
  };
  return JSON.stringify({ Type: 'Notification', MessageId: randomUUID(), Message: JSON.stringify(body) });
}

/** SES 흉내: 원문을 쓰고(없을 때만) 알림을 소비자에게 준다. */
export async function deliver(
  deps: InboundConsumerDependencies,
  raw: Uint8Array | null,
  options: NotifyOptions,
): Promise<InboundMailOutcome> {
  if (raw !== null) {
    try {
      await deps.rawMail.put(options.sesMessageId, raw);
    } catch {
      // 재전달 시나리오 — SES 는 원문을 한 번만 쓴다.
    }
  }
  return consumeInboundMail(deps, { receiptId: randomUUID(), body: notification(options) });
}

export async function objectExists(objects: ObjectStore, key: string): Promise<boolean> {
  try {
    await objects.get(key, 50 * 1024 * 1024);
    return true;
  } catch (error) {
    if (error instanceof ObjectNotFoundError) return false;
    throw error;
  }
}

/** 저장된 행 하나(없으면 던진다). */
export async function storedRow(agentId: string, sesMessageId: string): Promise<InboundMessageRow> {
  const result = await testPool().query<InboundMessageRow>('SELECT * FROM inbound_messages WHERE agent_id = $1 AND ses_message_id = $2', [
    agentId,
    sesMessageId,
  ]);
  const row = result.rows[0];
  if (row === undefined) throw new Error('행이 없다');
  return row;
}

export async function storedCount(agentId: string, sesMessageId: string): Promise<number> {
  const result = await testPool().query<{ n: number }>('SELECT count(*)::int AS n FROM inbound_messages WHERE agent_id = $1 AND ses_message_id = $2', [
    agentId,
    sesMessageId,
  ]);
  return result.rows[0]?.n ?? -1;
}

/** `inbound_rejections` 를 `[reason, envelope_recipients]` 로(사유 순). */
export async function rejectionPairs(sesMessageId: string): Promise<[string, string[]][]> {
  const result = await testPool().query<{ reason: string; envelope_recipients: string[] }>(
    'SELECT reason, envelope_recipients FROM inbound_rejections WHERE ses_message_id = $1 ORDER BY reason',
    [sesMessageId],
  );
  return result.rows.map((row) => [row.reason, row.envelope_recipients]);
}

function quoteIdent(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

/** 앱 롤이 읽을 수 있는 `public` 의 모든 문자열·JSON·바이트·배열 컬럼에서 `needle` 이 나온 곳(`표.컬럼`). */
export async function scanForSentinel(needle: string): Promise<string[]> {
  const pool = testPool();
  const columns = await pool.query<{ table_name: string; column_name: string; data_type: string }>(
    `SELECT c.table_name, c.column_name, c.data_type
       FROM information_schema.columns c
       JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
        AND c.data_type IN ('text', 'character varying', 'character', 'json', 'jsonb', 'bytea', 'ARRAY')
        AND has_table_privilege(current_user, format('%I.%I', c.table_schema, c.table_name), 'SELECT')`,
  );
  // 비공허: 스캔 대상이 사라지면(권한·스키마 변화) "없다" 가 공허하게 참이 된다.
  if (columns.rows.length <= 20 || !columns.rows.some((column) => column.table_name === 'security_findings')) {
    throw new Error('센티널 스캔 대상 컬럼이 너무 적다');
  }
  // 테이블마다 한 번의 스캔(컬럼 조건을 OR 로) — 컬럼마다 한 번이면 수백 왕복이다.
  const byTable = new Map<string, { column_name: string; data_type: string }[]>();
  for (const column of columns.rows) byTable.set(column.table_name, [...(byTable.get(column.table_name) ?? []), column]);
  const hits: string[] = [];
  for (const [table, tableColumns] of byTable) {
    const predicates = tableColumns.map((column) =>
      column.data_type === 'bytea'
        ? `position(convert_to($1, 'UTF8') in ${quoteIdent(column.column_name)}) > 0`
        : `strpos(${quoteIdent(column.column_name)}::text, $1) > 0`,
    );
    const result = await pool.query<Record<string, boolean>>(
      `SELECT ${predicates.map((predicate, index) => `bool_or(${predicate}) AS c${String(index)}`).join(', ')} FROM ${quoteIdent(table)}`,
      [needle],
    );
    const found = result.rows[0] ?? {};
    tableColumns.forEach((column, index) => {
      if (found[`c${String(index)}`] === true) hits.push(`${table}.${column.column_name}`);
    });
  }
  return hits;
}

// ---------------------------------------------------------------------------
// 문의 전달(support@ · abuse@ · postmaster@)
// ---------------------------------------------------------------------------

/** 가짜 전달 주소 — 실제 주소는 비밀에만 있다. */
export const CONTACT_DESTINATION = 'ops@example.test';

/** SES 호출면 — 전송단 이름을 직접 참조하지 않는다(Layer B 테스트 허용목록). */
export type SesSendClient = ContactForwarderDependencies['client'];

export function fakeSes(): { client: SesSendClient; sent: SendEmailCommand['input'][] } {
  const sent: SendEmailCommand['input'][] = [];
  return {
    sent,
    client: {
      send: (command: SendEmailCommand) => {
        sent.push(command.input);
        return Promise.resolve({ MessageId: `0100fwd-${randomUUID()}`, $metadata: {} });
      },
    },
  };
}

/**
 * 테스트마다 겹치지 않는 1시간 창 — 공유 DB 에 남은 다른 실행의 행이 상한 계수에 섞이지 않게.
 * 파일마다 다른 해(`year`)를 써서 파일끼리도 겹치지 않게 한다.
 */
export function uniqueWindow(year: number): Date {
  return new Date(Date.UTC(year, 0, 1) + Math.floor(Math.random() * 3_000_000) * 3_600_000);
}

export function contactForwarder(
  objects: ObjectStore,
  client: SesSendClient,
  now: Date,
  options: { readonly secret?: string; readonly notifyOnly?: boolean } = {},
): ContactForwarder {
  const secret = options.secret ?? JSON.stringify({ to: CONTACT_DESTINATION });
  return createContactForwarder({
    pool: testPool(),
    client,
    documents: createContactDocumentReader(objects),
    destination: createContactDestinationLoader(() => Promise.resolve(secret)),
    now: () => now,
    notifyOnly: options.notifyOnly ?? false,
  });
}
