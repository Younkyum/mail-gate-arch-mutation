/**
 * 검증 V2 결함 2·8 — **"입력 때문에는 던지지 않는다" 를 DB 제약 전부에 대해.** 실제 Postgres + 소비자.
 *
 * 소비자 규율 ②(`workers/inbound-consumer.ts` 머리말): 재전달해도 같은 실패는 poison pill 이다 — 인증 없이 누구나
 * 메일 한 통으로 일으키고 DLQ 로 사라진다. 그런데 소비자가 쓰는 컬럼의 CHECK 가 입력의 최대치보다 좁으면 그 규율이
 * 깨진다(V2: 파서는 제목을 2000자까지 두는데 `threads.subject_normalized` 는 998 — 소비자가 `subject` 는 자르고
 * `subjectNormalized` 는 안 잘랐다).
 *
 * 세 겹으로 본다:
 *   ① **제약 대조표** — 소비자가 쓰는 테이블의 CHECK·거부 트리거를 **DB 에서 읽어** 아래 `GUARDS` 와 같은지 본다.
 *      새 제약이 생기면(또는 사라지면) 이 테스트가 빨갛다 — 그 제약을 입력이 어길 수 있는지 판단하고 방어를 적어
 *      넣기 전에는 초록이 되지 않는다. 대조표의 각 줄은 "무엇이 그 제약을 입력과 무관하게 지키는가" 다.
 *   ② **최대치 입력** — 파서가 허용하는 최대치(제목 2000자, 긴 파일명·Content-Type·Content-ID, DB 범위 밖 Date)를
 *      한 통에 담아 보낸다 → `stored`. 소비자의 `slice` 하나를 지우면 빨갛다.
 *   ③ **남는 차이는 입력 거부로** — 소비자의 맞춤이 DB 와 어긋나는 경우(V2 의 U+038D: JS `toLowerCase` 와 DB
 *      `lower()` 의 로캘 차이)를 예측하는 대신, 실제 Postgres CHECK 위반을 일으켜 `rejected` + `inbound_rejections`
 *      (`unstorable`) 로 끝나는지 본다. 일시 장애는 여전히 `failed`(재전달)다.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';

import type { InboundStore } from '../../../src/db/repositories/inbound-store';
import { closeTestPool, DATABASE_AVAILABLE, seedFixture, testPool } from '../db/support/harness';
import { consumerDeps, deliver, eml, newObjectStore, newSesMessageId } from './support';

afterAll(async () => {
  if (DATABASE_AVAILABLE) await closeTestPool();
});

/** 소비자(`recordMessage`·`recordRejection` 트랜잭션)가 쓰는 테이블 전부. */
const CONSUMER_TABLES = [
  'threads',
  'inbound_messages',
  'inbound_attachments',
  'inbound_rejections',
  'security_findings',
  'webhook_deliveries',
  // US-009 — 문의 입구(`src/contact/contact-store.ts` admit)가 INSERT 한다.
  'contact_forwards',
] as const;

/**
 * 제약 → 그것을 **입력과 무관하게** 지키는 것. "입력이 어길 수 있는가" 를 판단한 기록이다.
 * 새 제약을 여기 넣을 때는 그 방어가 실제로 있는지(코드·테스트)를 함께 확인하라.
 */
const GUARDS: Readonly<Record<string, string>> = {
  // threads
  threads_starter_address_check: 'from_address 와 같은 값 — inbound_messages_from_address_check 와 같은 방어',
  threads_subject_normalized_check: '소비자가 normalizeSubject 결과를 998 로 자른다(V2-2)',
  // inbound_messages
  inbound_messages_attachment_count_check: '배열 길이(≥0)',
  inbound_messages_authentication_is_dmarc: 'isFromAuthenticated 가 DMARC pass 에서만 true',
  inbound_messages_check: 'raw 키는 sesMessageId 에서 유도(rawMail.keyFor)',
  inbound_messages_check1: 'parsed 키는 sesMessageId 에서 유도(artifacts.putParsed)',
  inbound_messages_envelope_recipient_check: 'agent_addresses.address 에서 온 값(소문자 CHECK 를 이미 통과한 값)',
  inbound_messages_envelope_sender_check: 'receipt.ts envelopeSenderOf — 제어문자·998 초과는 null',
  inbound_messages_forwarded_for_header_check: 'receipt.ts cleanHeaderValue — 998',
  inbound_messages_forwarded_to_header_check: 'receipt.ts cleanHeaderValue — 998',
  inbound_messages_from_address_check: '파서 isAddressShape + 소비자 소문자화. 로캘 차이(V2-8)는 ③ 입력 거부',
  inbound_messages_from_domain_matches: 'from_domain 은 INSERT 가 split_part 로 유도',
  inbound_messages_high_is_quarantined: '소비자가 임계(QUARANTINE_FROM) 이상을 격리로 겹친다',
  inbound_messages_in_reply_to_check: 'normalizeMessageId(MESSAGE_ID_HEADER_PATTERN) 통과값만, 아니면 null. 차이는 ③',
  inbound_messages_match_requires_authentication: '해석기: 권한 연결은 fromAuthenticated 일 때만',
  inbound_messages_match_shape: '저장소가 placement 종류로 넷을 한 벌로 쓴다',
  inbound_messages_matched_by_check: 'HeaderKeyKind 두 값뿐(타입)',
  inbound_messages_message_id_header_check: 'normalizeMessageId 통과값만, 아니면 null. 차이는 ③',
  inbound_messages_new_thread_reason_check: 'NewThreadReason 닫힌 값(타입)',
  inbound_messages_scanner_version_check: 'validateScanResult 의 VERSION_SHAPE, 실패면 INJECTION_SCANNER_VERSION',
  inbound_messages_sender_trust_decided_by_check: 'computeTrust 의 닫힌 decidedBy(타입)',
  inbound_messages_ses_message_id_check: 'receipt.ts SES_MESSAGE_ID_PATTERN 통과값만(아니면 unparsable)',
  inbound_messages_subject_check: '소비자가 998 로 자른다',
  inbound_messages_text_source_check: '파서의 닫힌 값(타입)',
  inbound_messages_trust_decided_shape: 'computeTrust: unknown 이면 decidedBy null',
  inbound_messages_trust_with_scan: '저장소가 스캔·신뢰를 항상 함께 쓴다',
  inbound_messages_unscanned_is_quarantined: '저장소 quarantineOf — 판정 없음은 격리',
  inbound_messages_verdict_has_version: 'scanned 기록은 항상 scannerVersion 을 갖는다',
  // 정책 v2(202609241010) — 저장소 quarantineOf 가 사유·격리·정책 사유를 한 함수로 쓴다(입력과 무관한 닫힌 값).
  inbound_messages_quarantine_reason_check: 'quarantineOf 의 닫힌 네 값(타입 InboundQuarantineReason — risk_hold 포함)',
  inbound_messages_policy_reason_check: 'evaluateInboundPolicy 의 닫힌 세 값(타입 InboundPolicyReason)',
  inbound_messages_quarantine_reason_shape: 'quarantineOf 가 사유를 줄 때만 quarantined = true 로 쓴다',
  inbound_messages_policy_reason_shape: 'policyBlocked ≠ null ⇔ quarantine_reason = policy_blocked(quarantineOf)',
  'trigger:inbound_messages_require_scan': '저장소가 scanner_version 을 항상 싣는다(스캐너 예외여도)',
  // 받기 등급(202610081000) — 소비자가 levels.ts 하나로 정한 값만 쓴다(입력과 무관한 닫힌 값). 풀린 칸은 INSERT 가 채우지 않는다.
  inbound_messages_watch_level_check: 'classifyInboundLevel 의 닫힌 세 값(타입 InboundWatchLevel)',
  inbound_messages_watch_level_shape: '소비자 watchRecordOf — 등급은 quarantineOf(보류 전)와 같은 사실로 계산, 보류는 risk 에만',
  inbound_messages_trusted_bypass_shape: 'matchesTrustedSender 는 fromAuthenticated 에만 참 · 저장소가 정책 차단 · 판정 없음 행에는 false 로 쓴다',
  inbound_messages_release_shape: '소비자는 풀린 칸을 쓰지 않는다(INSERT 목록에 없음)',
  inbound_messages_released_from_check: '소비자는 풀린 칸을 쓰지 않는다(INSERT 목록에 없음)',
  'trigger:inbound_messages_release_guard': '소비자는 풀린 칸을 쓰지 않는다(INSERT 목록에 없음)',
  // 투명성 로그(202609241600, ADR-0008) — 입력 제약이 아니라 수집 트리거(AFTER INSERT → tlog_outbox). 소비자 입력으로 실패하지 않는다:
  //   조직은 agent_id FK 가 이미 보장한다(없으면 INSERT 전에 FK 가 거부).
  'trigger:inbound_messages_tlog_enqueue': '수집 트리거 — 입력 값과 무관(조직은 agent_id FK 로 이미 존재)',
  // inbound_attachments
  inbound_attachments_content_id_check: '소비자가 998 로 자른다',
  inbound_attachments_content_type_check: "소비자가 trim·빈 값은 'application/octet-stream'·255 로 자른다",
  inbound_attachments_disposition_check: 'parse.ts closedDisposition — 낯선 토큰은 attachment',
  inbound_attachments_filename_check: '소비자가 1000 으로 자른다',
  inbound_attachments_part_index_check: '파서 index(≥0)',
  inbound_attachments_sha256_check: '소비자가 계산한 hex',
  inbound_attachments_size_bytes_check: '바이트 길이(≥0)',
  inbound_attachments_storage_key_check: 'artifacts.putAttachment 가 sesMessageId·index 로 유도',
  // inbound_rejections
  inbound_rejections_check: 'raw 키는 sesMessageId 에서 유도',
  inbound_rejections_detail_check: '사유 코드·SQLSTATE·제약 이름만(≤200) — 메일 내용 없음',
  inbound_rejections_reason_check: 'InboundRejectionReason 닫힌 값(타입, 202609230500)',
  inbound_rejections_ses_message_id_check: 'receipt.ts SES_MESSAGE_ID_PATTERN',
  // security_findings — validateScanResult 가 DB 와 같은 모양을 먼저 본다(틀리면 판정 없음 + 격리)
  security_findings_check: 'validateScanResult: end >= start',
  security_findings_family_check: 'validateScanResult: TOKEN_SHAPE',
  security_findings_field_check: 'validateScanResult: TOKEN_SHAPE',
  security_findings_field_index_check: 'validateScanResult: 정수 ≥0',
  security_findings_ordinal_check: 'insertSecurityFindings 가 배열 순서로 매긴다(≥0)',
  security_findings_rule_id_check: 'validateScanResult: RULE_ID_SHAPE',
  security_findings_scanner_version_check: 'validateScanResult: VERSION_SHAPE',
  security_findings_start_offset_check: 'validateScanResult: 정수 ≥0',
  security_findings_view_check: 'validateScanResult: TOKEN_SHAPE',
  security_findings_weight_check: 'validateScanResult: 유한 ≥0',
  'trigger:security_findings_no_update': 'INSERT 만 한다',
  'trigger:security_findings_no_delete': 'INSERT 만 한다',
  'trigger:security_findings_no_truncate': 'INSERT 만 한다',
  // webhook_deliveries — message.received 페이로드는 식별자·시각뿐(webhooks/events.ts)
  'trigger:webhook_deliveries_admin_write_guard': 'atmark_admin 롤의 직접 쓰기만 막는다(202609301410) — 소비자는 앱 롤',
  webhook_deliveries_attempt_count_check: '기본값 0',
  webhook_deliveries_body_check: '페이로드가 식별자·시각뿐 — 입력 길이와 무관',
  webhook_deliveries_dead_shape: '기본 상태(pending)',
  webhook_deliveries_dedupe_key_check: 'inboundMessageId(uuid) 에서 유도',
  webhook_deliveries_delivered_shape: '기본 상태(pending)',
  webhook_deliveries_last_error_check: 'INSERT 가 싣지 않는다(NULL)',
  webhook_deliveries_last_http_status_check: 'INSERT 가 싣지 않는다(NULL)',
  // 메일 기본기 A4(202609260115) — 재전송 행 모양. 소비자는 redelivery_of 를 싣지 않고(NULL) dedupe 키는 `message.received:` 로 시작한다.
  webhook_deliveries_redelivery_shape: 'redelivery_of 를 싣지 않는다(NULL) · dedupe 키가 `redelivery:` 로 시작하지 않는다',
  'trigger:webhook_deliveries_redelivery_guard': 'redelivery_of IS NOT NULL 일 때만 돈다 — 소비자 INSERT 는 해당 없음',
  'trigger:webhook_deliveries_immutable_core': 'INSERT 만 한다',
  'trigger:webhook_deliveries_no_delete': 'INSERT 만 한다',
  'trigger:webhook_deliveries_no_truncate': 'INSERT 만 한다',
  'trigger:webhook_deliveries_terminal_guard': 'INSERT 만 한다(상태 전이 없음)',
  // 갱신 전용 트리거 — 소비자는 INSERT 와 threads.last_message_at 갱신만 한다
  'trigger:threads_immutable_except_activity': '소비자는 last_message_at 만 갱신한다',
  'trigger:inbound_messages_immutable_except_display': '소비자는 갱신하지 않는다',
  // AI 의심 메일 감시(202610061100) — 소비자는 보류를 LEAST(작업 마감, now()+30s) 로만 적는다(DB 시계 — 입력과 무관하게 상한 안). 갱신은 하지 않는다.
  inbound_messages_ai_hold_max_30s: '소비자는 보류를 LEAST(작업 마감, now()+30s) 로만 적는다 — 입력이 값을 고르지 못한다',
  'trigger:inbound_messages_ai_watch_release_only': '소비자는 갱신하지 않는다(보류 풀기는 정의 함수)',
  // 격리 알림(202610071000) — AFTER INSERT 정의자 트리거. 실패는 함수 안에서 WARNING 으로 삼킨다 — 입력 때문에 INSERT 가 죽지 않는다(그 표의 CHECK 도 함수가
  //   모양을 먼저 보고 NULL 로 떨어뜨린다).
  'trigger:inbound_messages_quarantine_notice': '정의자 함수가 실패를 삼킨다(WARNING) — 메일 기록을 막지 않는다',
  'trigger:inbound_attachments_no_update': '소비자는 갱신하지 않는다',
  'trigger:inbound_rejections_no_update': '소비자는 갱신하지 않는다',
  // contact_forwards (US-009) — 소비자는 INSERT 다섯 칸만(ses_message_id·sender_hash·next_attempt_at·received_at·lane)
  contact_forwards_ses_message_id_check: 'receipt.ts SES_MESSAGE_ID_PATTERN 을 이미 통과한 값(intake 가 한 번 더 본다)',
  contact_forwards_sender_hash_check: 'contactSenderHash 가 만든 sha256 hex',
  contact_forwards_status_check: 'INSERT 는 기본값(pending) — 소비자가 정하지 않는다',
  contact_forwards_attempt_count_check: 'INSERT 는 기본값(0)',
  contact_forwards_forward_ses_message_id_check: '소비자는 쓰지 않는다(전달 워커의 SES 응답)',
  contact_forwards_last_error_check: '소비자는 쓰지 않는다(전달 워커의 사유 코드 상수)',
  contact_forwards_sent_shape: 'INSERT 는 pending · sent_at NULL',
  contact_forwards_lane_check: 'laneOf 가 닫힌 두 값(support|role) 중 하나만 돌려준다(202610021000)',
  'trigger:contact_forwards_terminal_frozen': '소비자는 갱신하지 않는다(전달 워커만 pending 행을 바꾼다)',
};

describe.skipIf(!DATABASE_AVAILABLE)('V2-2 ① 제약 대조표 — DB 에서 읽은 제약 = GUARDS', () => {
  it('소비자가 쓰는 테이블의 CHECK·트리거 집합이 대조표와 같다(새 제약은 방어를 적기 전까지 빨갛다)', async () => {
    const pool = testPool();
    const checks = await pool.query<{ name: string }>(
      `SELECT conname AS name FROM pg_constraint
        WHERE contype = 'c' AND conrelid = ANY (SELECT oid FROM pg_class WHERE relname = ANY($1::text[]) AND relnamespace = 'public'::regnamespace)`,
      [[...CONSUMER_TABLES]],
    );
    const triggers = await pool.query<{ name: string }>(
      `SELECT 'trigger:' || tgname AS name FROM pg_trigger
        WHERE NOT tgisinternal AND tgrelid = ANY (SELECT oid FROM pg_class WHERE relname = ANY($1::text[]) AND relnamespace = 'public'::regnamespace)`,
      [[...CONSUMER_TABLES]],
    );
    const inDb = [...checks.rows, ...triggers.rows].map((row) => row.name).sort();
    // 비공허성: 이 조회가 실제로 제약을 읽는다(V2 가 짚은 그 제약이 있다).
    expect(inDb).toContain('threads_subject_normalized_check');
    expect(inDb).toEqual(Object.keys(GUARDS).sort());
    for (const [name, guard] of Object.entries(GUARDS)) expect(guard.trim(), name).not.toBe('');
  });

  it('NOT NULL 컬럼에 입력 길이 제약이 숨어 있지 않다 — 소비자 테이블의 varchar(n) 는 agent_id(char 32)뿐', async () => {
    const result = await testPool().query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ANY($1::text[]) AND character_maximum_length IS NOT NULL`,
      [[...CONSUMER_TABLES]],
    );
    expect(result.rows.map((r) => `${r.table_name}.${r.column_name}`).sort()).toEqual(
      ['inbound_messages.agent_id', 'threads.agent_id'],
    );
  });
});

describe.skipIf(!DATABASE_AVAILABLE)('V2-2 ② 파서가 허용하는 최대치를 한 통에', () => {
  it('★ 제목 2000자(→ subject·subject_normalized 둘 다 998) · 긴 파일명·Content-Type·Content-ID · DB 범위 밖 Date → stored', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const deps = consumerDeps(pool, newObjectStore());
    const sesMessageId = newSesMessageId();
    const subject = `견적 ${'가'.repeat(1_996)}`; // 2000자 — 파서 상한(maxSubjectChars) 그대로
    const outcome = await deliver(
      deps,
      eml({
        from: 'sender@example.com',
        subject,
        // JS Date 는 받고(±275760년) Postgres timestamptz 는 못 받는(기원전 4713년 이전) 날짜 — 파서가 그대로 준다.
        date: '-005000-01-01T00:00:00Z',
        attachment: {
          filename: `${'f'.repeat(1_500)}.pdf`,
          contentType: `application/${'x'.repeat(400)}`,
          contentId: `<${'c'.repeat(1_200)}@example.com>`,
          bytes: new TextEncoder().encode('%PDF'),
        },
      }),
      { sesMessageId, recipients: [fixture.address] },
    );
    expect(outcome).toBe('stored');
    const row = await pool.query<{ subject: string; subject_normalized: string; header_date: Date | null }>(
      `SELECT m.subject, t.subject_normalized, m.header_date FROM inbound_messages m JOIN threads t ON t.id = m.thread_id
        WHERE m.agent_id = $1 AND m.ses_message_id = $2`,
      [fixture.agentId, sesMessageId],
    );
    expect(row.rows[0]?.subject).toHaveLength(998);
    expect(row.rows[0]?.subject_normalized).toHaveLength(998);
    expect(row.rows[0]?.header_date).toBeNull(); // 저장할 수 없는 날짜는 버린다(원문은 S3 에 있다)
    const attachment = await pool.query<{ filename: string; content_type: string; content_id: string }>(
      `SELECT a.filename, a.content_type, a.content_id FROM inbound_attachments a
         JOIN inbound_messages m ON m.id = a.inbound_message_id WHERE m.agent_id = $1 AND m.ses_message_id = $2`,
      [fixture.agentId, sesMessageId],
    );
    expect(attachment.rows[0]?.filename).toHaveLength(1_000);
    expect(attachment.rows[0]?.content_type.length).toBeLessThanOrEqual(255);
    expect(attachment.rows[0]?.content_id.length).toBeLessThanOrEqual(998);
  });
});

describe.skipIf(!DATABASE_AVAILABLE)('첨부 헤더의 발신자 값 — 낯선 disposition · Content-Type 제어문자 → stored', () => {
  const attachmentRow = async (agentId: string, sesMessageId: string) =>
    (
      await testPool().query<{ content_type: string; disposition: string | null }>(
        `SELECT a.content_type, a.disposition FROM inbound_attachments a
           JOIN inbound_messages m ON m.id = a.inbound_message_id WHERE m.agent_id = $1 AND m.ses_message_id = $2`,
        [agentId, sesMessageId],
      )
    ).rows;

  it('★ Content-Disposition: form-data → stored · disposition = attachment', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const sesMessageId = newSesMessageId();
    const raw = new TextDecoder().decode(
      eml({ from: 'sender@example.com', attachment: { filename: 'a.bin', contentType: 'application/octet-stream', bytes: new Uint8Array([1, 2]) } }),
    );
    expect(raw).toContain('Content-Disposition: attachment;');
    const formData = new TextEncoder().encode(raw.replace('Content-Disposition: attachment;', 'Content-Disposition: form-data;'));
    const outcome = await deliver(consumerDeps(pool, newObjectStore()), formData, { sesMessageId, recipients: [fixture.address] });
    expect(outcome).toBe('stored');
    expect(await attachmentRow(fixture.agentId, sesMessageId)).toEqual([{ content_type: 'application/octet-stream', disposition: 'attachment' }]);
  });

  it('★ Content-Type 에 NUL → stored(22021 unstorable 아님) · 제어문자는 공백', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const sesMessageId = newSesMessageId();
    const outcome = await deliver(
      consumerDeps(pool, newObjectStore()),
      eml({ from: 'sender@example.com', attachment: { filename: 'a.bin', contentType: 'application/x\u0000y', bytes: new Uint8Array([1, 2]) } }),
      { sesMessageId, recipients: [fixture.address] },
    );
    expect(outcome).toBe('stored');
    expect(await attachmentRow(fixture.agentId, sesMessageId)).toEqual([{ content_type: 'application/x y', disposition: 'attachment' }]);
  });
});

describe.skipIf(!DATABASE_AVAILABLE)('V2-2·8 ③ DB 가 입력 때문에 거부하면 — 던지지 않고 결말로', () => {
  /** 실제 저장소를 감싸 기록 한 필드를 바꾼다 — **실제 Postgres 의** 제약 위반을 일으키기 위해. */
  function tampered(store: InboundStore, mutate: (record: Parameters<InboundStore['recordMessage']>[0]) => Parameters<InboundStore['recordMessage']>[0]): InboundStore {
    return { ...store, recordMessage: (record) => store.recordMessage(mutate(record)) };
  }

  it('★ CHECK 위반(소비자 맞춤과 DB 판정의 차이) → rejected · inbound_rejections(unstorable, 제약 이름) · 재전달해도 같다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const base = consumerDeps(pool, newObjectStore());
    // V2-8 의 모양: 소비자가 소문자라 믿은 값을 DB 가 소문자가 아니라고 본다(로캘 차이). 여기서는 대문자로 흉내 낸다.
    const deps = { ...base, receipts: tampered(base.receipts, (r) => ({ ...r, fromAddress: r.fromAddress.toUpperCase() })) };
    const sesMessageId = newSesMessageId();
    const raw = eml({ from: 'sender@example.com' });

    expect(await deliver(deps, raw, { sesMessageId, recipients: [fixture.address] })).toBe('rejected');
    // 재전달 — 같은 결말, 여전히 던지지 않는다(행은 하나).
    expect(await deliver(deps, raw, { sesMessageId, recipients: [fixture.address] })).toBe('rejected');

    const rejections = await pool.query<{ reason: string; detail: string; envelope_recipients: string[] }>(
      'SELECT reason, detail, envelope_recipients FROM inbound_rejections WHERE ses_message_id = $1',
      [sesMessageId],
    );
    expect(rejections.rows).toHaveLength(1);
    // 새 스레드를 먼저 INSERT 하므로 그 행의 같은 CHECK(starter_address)가 먼저 걸린다 — 어느 쪽이든 제약 이름뿐이다.
    expect(rejections.rows[0]).toMatchObject({ reason: 'unstorable', envelope_recipients: [fixture.address] });
    expect(rejections.rows[0]?.detail).toMatch(
      /^sqlstate:23514 constraint:(threads_starter_address_check|inbound_messages_from_address_check)$/,
    );
    const stored = await pool.query('SELECT 1 FROM inbound_messages WHERE ses_message_id = $1', [sesMessageId]);
    expect(stored.rowCount).toBe(0);
  });

  it('데이터 예외(22xxx — 문자열에 NUL)도 입력 거부다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const base = consumerDeps(pool, newObjectStore());
    const deps = { ...base, receipts: tampered(base.receipts, (r) => ({ ...r, subject: 'a\u0000b' })) };
    const sesMessageId = newSesMessageId();
    expect(await deliver(deps, eml({ from: 'sender@example.com' }), { sesMessageId, recipients: [fixture.address] })).toBe('rejected');
    const rejection = await pool.query<{ detail: string }>('SELECT detail FROM inbound_rejections WHERE ses_message_id = $1', [sesMessageId]);
    expect(rejection.rows[0]?.detail).toMatch(/^sqlstate:22/);
  });

  it('통제군 — 입력이 아닌 실패(연결 오류·NOT NULL·FK)는 여전히 failed(재전달)다', async () => {
    const pool = testPool();
    const fixture = await seedFixture(pool);
    const base = consumerDeps(pool, newObjectStore());
    const failing = (error: Error & { code?: string }): InboundStore => ({
      ...base.receipts,
      recordMessage: () => Promise.reject(error),
    });
    const transient = Object.assign(new Error('Connection terminated unexpectedly'), { code: '08006' });
    const notNull = Object.assign(new Error('null value in column'), { code: '23502' });
    for (const error of [transient, notNull, new Error('boom')]) {
      const sesMessageId = newSesMessageId();
      expect(
        await deliver({ ...base, receipts: failing(error) }, eml({ from: 'sender@example.com' }), { sesMessageId, recipients: [fixture.address] }),
      ).toBe('failed');
      const rejections = await pool.query('SELECT 1 FROM inbound_rejections WHERE ses_message_id = $1', [sesMessageId]);
      expect(rejections.rowCount).toBe(0);
    }
    // FK 위반은 실제 Postgres 로 — 없는 스레드 id 를 "기존 스레드" 로 넘긴다(저장소의 에이전트 범위 UPDATE 가 먼저 던진다).
    const deps = {
      ...base,
      receipts: tampered(base.receipts, (r) => ({
        ...r,
        thread: { kind: 'existing' as const, threadId: randomUUID(), matchedBy: 'message_id_header' as const, matchedMessageId: randomUUID() },
      })),
    };
    expect(await deliver(deps, eml({ from: 'sender@example.com' }), { sesMessageId: newSesMessageId(), recipients: [fixture.address] })).toBe('failed');
  });
});
