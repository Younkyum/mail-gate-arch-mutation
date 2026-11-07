/**
 * US-009(ADR-0009) — `support@atmark.ai` 문의 → 운영자 메일함 전달. 실제 Postgres(앱 롤) + 로컬 객체 저장소 + **가짜 SES**.
 * 전달 주소는 가짜(`ops@example.test`) — 실제 주소는 비밀에만 있다.
 *
 * 되돌리면 빨개져야 하는 것:
 *   ① 행복 경로: 받아들임 → 행 1 · 문서 1 → 전달 1통(From support@ · To 전달 주소 하나 · Reply-To 원 발신자 · 제목 `[Atmark inquiry]` — 운영자의 메일 언어, 없으면 en).
 *   ② 수신자 고정: 원 메일의 To·Cc·Reply-To·Resent-To·Bcc 가 무엇이든 SES Destination 과 raw To 는 전달 주소 하나.
 *   ③ 루프: 우리 도메인 From·봉투 · 자동 응답 헤더 → 거부 · 전달 주소 자신(+태그·대소문자)에서 온 문의 → `suppressed`, SES 0.
 *   ④ 판정: 스팸 FAIL · 바이러스 GRAY · DMARC FAIL → 거부(사유 코드) · 행 0.
 *   ⑤ 상한: 같은 발신자 6번째 → `rate_sender` · support 차선 30 뒤 → `rate_global` · 전달 쪽 차선 상한 → `deferred`(차선은 contact-forward-lanes.test.ts).
 *   ⑥ 멱등: 같은 알림 재전달 → `duplicate` · 행 1 · 전달 두 번 불러도 SES 1통 · 종단 행은 되돌릴 수 없다(트리거).
 *   ⑦ 비밀 없음(자리값) → `unconfigured` · SES 0 · 행 그대로(시도 0).
 *   ⑧ 문의 주소 + 모르는 주소가 함께 → 문의는 받아들이고 나머지만 `unknown_recipient`(support@ 는 거기 없다).
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { SendEmailCommand } from '@aws-sdk/client-sesv2';
import { afterAll, describe, expect, it } from 'vitest';

import { contactDocumentKey, createContactDocumentReader } from '../../../src/contact/contact-store';
import { createContactDestinationLoader } from '../../../src/contact/destination';
import { CONTACT_ADDRESS, CONTACT_FORWARD_LANE_HOURLY_CAP } from '../../../src/contact/intake';
import { setLogSink } from '../../../src/observability/logger';
import { METRIC_NAMES } from '../../../src/observability/metrics';
import { createContactForwarder } from '../../../src/notify/contact-forwarder';
import type { ObjectStore } from '../../../src/storage/object-store';
import { closeTestPool, DATABASE_AVAILABLE, testPool } from '../db/support/harness';
import { CONTACT_DESTINATION, consumerDeps, contactForwarder, deliver, eml, fakeSes, newObjectStore, newSesMessageId, uniqueWindow } from './support';

afterAll(async () => {
  if (DATABASE_AVAILABLE) await closeTestPool();
});

const PLACEHOLDER = JSON.stringify({ _unset: 'placeholder - filled by migrate handler or deploy runbook (docs/runbooks/deploy.md)' });

function rawOf(input: SendEmailCommand['input'] | undefined): string {
  const data = input?.Content?.Raw?.Data;
  return data === undefined ? '' : Buffer.from(data).toString('utf8');
}

async function forwardRow(sesMessageId: string): Promise<{ id: string; status: string; attempt_count: number; last_error: string | null } | null> {
  const result = await testPool().query<{ id: string; status: string; attempt_count: number; last_error: string | null }>(
    'SELECT id, status, attempt_count, last_error FROM contact_forwards WHERE ses_message_id = $1',
    [sesMessageId],
  );
  return result.rows[0] ?? null;
}

async function rejections(sesMessageId: string): Promise<[string, string | null, string[]][]> {
  const result = await testPool().query<{ reason: string; detail: string | null; envelope_recipients: string[] }>(
    'SELECT reason, detail, envelope_recipients FROM inbound_rejections WHERE ses_message_id = $1 ORDER BY reason',
    [sesMessageId],
  );
  return result.rows.map((row) => [row.reason, row.detail, row.envelope_recipients]);
}

interface Inquiry {
  readonly sesMessageId: string;
  readonly receivedAt: Date;
}

async function inquire(
  objects: ObjectStore,
  options: {
    readonly from?: string;
    readonly subject?: string;
    readonly text?: string;
    readonly extraHeaders?: readonly string[];
    readonly recipients?: readonly string[];
    readonly source?: string;
    readonly spam?: string;
    readonly virus?: string;
    readonly dmarc?: string;
    readonly commonFrom?: readonly string[];
    readonly headers?: readonly { name: string; value: string }[];
    readonly receivedAt?: Date;
    readonly sesMessageId?: string;
  } = {},
): Promise<Inquiry & { outcome: string }> {
  const sesMessageId = options.sesMessageId ?? newSesMessageId();
  const receivedAt = options.receivedAt ?? uniqueWindow(2031);
  const from = options.from ?? `customer-${randomBytes(3).toString('hex')}@mail.example.com`;
  const outcome = await deliver(
    consumerDeps(testPool(), objects),
    eml({
      from,
      to: CONTACT_ADDRESS,
      subject: options.subject ?? '탈퇴 요청',
      text: options.text ?? '계정을 지워 주세요.',
      ...(options.extraHeaders === undefined ? {} : { extraHeaders: options.extraHeaders }),
    }),
    {
      sesMessageId,
      recipients: options.recipients ?? [CONTACT_ADDRESS],
      source: options.source ?? 'bounce@mail.example.com',
      commonFrom: options.commonFrom ?? [from],
      receivedAt: receivedAt.toISOString(),
      ...(options.spam === undefined ? {} : { spam: options.spam }),
      ...(options.virus === undefined ? {} : { virus: options.virus }),
      ...(options.dmarc === undefined ? {} : { dmarc: options.dmarc }),
      ...(options.headers === undefined ? {} : { headers: options.headers }),
    },
  );
  return { sesMessageId, receivedAt, outcome };
}

describe.skipIf(!DATABASE_AVAILABLE)('문의 전달 — support@atmark.ai (US-009)', () => {
  it('① 행복 경로 — 받아들임 → 전달 1통: From support@ · To 전달 주소 하나 · Reply-To 원 발신자 · 제목 [Atmark inquiry]', async () => {
    const objects = newObjectStore();
    const from = `Customer.${randomBytes(3).toString('hex')}@mail.example.com`;
    const inquiry = await inquire(objects, { from, subject: '탈퇴 요청 드립니다', text: '안녕하세요.\n계정을 지워 주세요.' });
    expect(inquiry.outcome).toBe('stored');
    const row = await forwardRow(inquiry.sesMessageId);
    expect(row).toMatchObject({ status: 'pending', attempt_count: 0 });
    expect(await rejections(inquiry.sesMessageId)).toEqual([]);
    // 문서는 S3 `contact/forward/` 에 — 원 발신자·본문이 거기 있다(DB 에는 없다).
    const document = JSON.parse(Buffer.from(await objects.get(contactDocumentKey(inquiry.sesMessageId), 1_000_000)).toString('utf8')) as Record<string, unknown>;
    expect(document).toMatchObject({ fromAddress: from, subject: '탈퇴 요청 드립니다', attachmentCount: 0, dmarc: 'pass' });

    const ses = fakeSes();
    const outcome = await contactForwarder(objects, ses.client, inquiry.receivedAt).forward(row?.id ?? '');
    expect(outcome).toBe('sent');
    expect(ses.sent).toHaveLength(1);
    const input = ses.sent[0];
    expect(input?.FromEmailAddress).toBe('support@atmark.ai');
    expect(input?.Destination).toEqual({ ToAddresses: [CONTACT_DESTINATION] });
    expect(input?.ConfigurationSetName).toBe('atmark-default');
    const raw = rawOf(input);
    expect(raw).toContain(`\r\nReply-To: ${from}\r\n`);
    expect(raw).toContain(`\r\nTo: ${CONTACT_DESTINATION}\r\n`);
    expect(raw).toMatch(/^From: support@atmark\.ai\r\n/);
    // 전달 주소가 활성 운영자의 사용자 주소가 아니다 — 영어 한 통(2026-10-10). 원 제목 · 본문은 그대로.
    expect(raw).toContain(`Subject: =?UTF-8?B?${Buffer.from('[Atmark inquiry] 탈퇴 요청 드립니다').toString('base64')}?=`);
    expect(raw).not.toContain('text/html');
    const body = Buffer.from(raw.split('\r\n\r\n')[1] ?? '', 'base64').toString('utf8');
    expect(body).toContain('계정을 지워 주세요.');
    expect(body).toContain(`From: ${from}`);
    expect(body).toContain('Reply to this email to answer the sender.');
    expect(await forwardRow(inquiry.sesMessageId)).toMatchObject({ status: 'sent', attempt_count: 1 });
  });

  it('② 수신자 고정 — 원 메일의 To·Cc·Reply-To·Resent-To·Bcc·제목의 개행이 무엇이든 전달 주소 하나로만', async () => {
    const objects = newObjectStore();
    const inquiry = await inquire(objects, {
      subject: 'hi =?UTF-8?B?DQpCY2M6IGV2aWxAYXR0YWNrZXIuZXhhbXBsZQ==?=',
      extraHeaders: [
        'Cc: attacker@attacker.example',
        'Reply-To: redirect@attacker.example',
        'Resent-To: resent@attacker.example',
        'Bcc: hidden@attacker.example',
        'X-Forward-To: xfwd@attacker.example',
      ],
      text: 'To: body@attacker.example\nBcc: body2@attacker.example',
    });
    expect(inquiry.outcome).toBe('stored');
    const ses = fakeSes();
    const row = await forwardRow(inquiry.sesMessageId);
    expect(await contactForwarder(objects, ses.client, inquiry.receivedAt).forward(row?.id ?? '')).toBe('sent');
    expect(ses.sent[0]?.Destination).toEqual({ ToAddresses: [CONTACT_DESTINATION] });
    const raw = rawOf(ses.sent[0]);
    const headerBlock = raw.split('\r\n\r\n')[0] ?? '';
    expect(headerBlock.split('\r\n').filter((line) => /^(To|Cc|Bcc|Resent-To):/i.test(line))).toEqual([`To: ${CONTACT_DESTINATION}`]);
    // 영어 머리(`[Atmark inquiry] `, 2026-10-10 — 운영자 메일도 한 언어)면 제목이 ASCII 라 인코딩 없이 실린다. 원 제목의 개행은 공백으로 접혀 **제목 한 줄
    //   안에만** 남는다 — 그 밖의 머리 줄에는 공격자 주소가 없다(받는 사람을 바꾸는 머리 줄이 생기지 않는다).
    const subjects = headerBlock.split('\r\n').filter((line) => /^Subject:/i.test(line));
    expect(subjects).toEqual(['Subject: [Atmark inquiry] hi Bcc: evil@attacker.example']);
    expect(headerBlock.split('\r\n').filter((line) => !/^Subject:/i.test(line) && line.includes('attacker.example'))).toEqual([]);
  });

  it('③ 루프 — 우리 도메인 From·봉투 · 자동 응답 → 거부 · 전달 주소 자신(+태그·대소문자)에서 온 문의 → suppressed, SES 0', async () => {
    const objects = newObjectStore();
    const own = await inquire(objects, { from: 'someone@atmark.ai', commonFrom: ['someone@mail.example.com'] });
    expect(own.outcome).toBe('rejected');
    expect(await rejections(own.sesMessageId)).toEqual([['contact_not_forwarded', 'loop_own_domain', [CONTACT_ADDRESS]]]);
    expect(await forwardRow(own.sesMessageId)).toBeNull();

    const envelope = await inquire(objects, { source: 'bounces@send.atmark.ai' });
    expect(await rejections(envelope.sesMessageId)).toEqual([['contact_not_forwarded', 'loop_own_domain', [CONTACT_ADDRESS]]]);

    const auto = await inquire(objects, { headers: [{ name: 'Auto-Submitted', value: 'auto-replied' }] });
    expect(await rejections(auto.sesMessageId)).toEqual([['contact_not_forwarded', 'auto_submitted', [CONTACT_ADDRESS]]]);

    const self = await inquire(objects, { from: 'OPS+vacation@example.test' });
    expect(self.outcome).toBe('stored');
    const ses = fakeSes();
    const row = await forwardRow(self.sesMessageId);
    expect(await contactForwarder(objects, ses.client, self.receivedAt).forward(row?.id ?? '')).toBe('suppressed');
    expect(ses.sent).toEqual([]);
    expect(await forwardRow(self.sesMessageId)).toMatchObject({ status: 'suppressed', last_error: 'loop_destination' });
  });

  it('④ 판정 — 스팸 FAIL · 바이러스 GRAY · DMARC FAIL → 거부(사유 코드) · 행 0 · 문서 0', async () => {
    const objects = newObjectStore();
    for (const [options, code] of [
      [{ spam: 'FAIL' }, 'spam_verdict'],
      [{ virus: 'GRAY' }, 'virus_verdict'],
      [{ dmarc: 'FAIL' }, 'dmarc_fail'],
    ] as const) {
      const inquiry = await inquire(objects, options);
      expect(inquiry.outcome, code).toBe('rejected');
      expect(await rejections(inquiry.sesMessageId), code).toEqual([['contact_not_forwarded', code, [CONTACT_ADDRESS]]]);
      expect(await forwardRow(inquiry.sesMessageId), code).toBeNull();
      await expect(objects.get(contactDocumentKey(inquiry.sesMessageId), 1_000_000), code).rejects.toThrow();
    }
  });

  it('⑤ 상한 — 같은 발신자 6번째 rate_sender · 전역 30 뒤 rate_global · 전달 쪽 전역 상한 deferred', async () => {
    const objects = newObjectStore();
    const window = uniqueWindow(2031);
    const from = `repeat-${randomBytes(3).toString('hex')}@mail.example.com`;
    for (let i = 0; i < 5; i += 1) {
      const ok = await inquire(objects, { from, receivedAt: new Date(window.getTime() + i * 60_000) });
      expect(ok.outcome, String(i)).toBe('stored');
    }
    // 검증 F6 — 전역 상한 거부만 메트릭(알람 8)을 낸다. 발신자 상한은 내지 않는다.
    const lines: string[] = [];
    const restoreSink = setLogSink((line) => {
      lines.push(line);
    });
    const rateGlobalMetrics = (): number => lines.filter((line) => line.includes(`"${METRIC_NAMES.contactRateGlobal}":1`)).length;
    const sixth = await inquire(objects, { from, receivedAt: new Date(window.getTime() + 6 * 60_000) });
    expect(await rejections(sixth.sesMessageId)).toEqual([['contact_not_forwarded', 'rate_sender', [CONTACT_ADDRESS]]]);
    expect(rateGlobalMetrics()).toBe(0);
    // 한 시간 뒤에는 다시 받는다(창이 SES 수신 시각 축).
    const later = await inquire(objects, { from, receivedAt: new Date(window.getTime() + 2 * 3_600_000) });
    expect(later.outcome).toBe('stored');

    // 전역: 다른 창에 25행을 더 채워 30 을 만든다(앱 롤 INSERT — 수신 소비자와 같은 권한).
    const global = uniqueWindow(2031);
    for (let i = 0; i < CONTACT_FORWARD_LANE_HOURLY_CAP.support; i += 1) {
      await testPool().query(
        'INSERT INTO contact_forwards (ses_message_id, sender_hash, next_attempt_at, received_at) VALUES ($1, $2, $3, $3)',
        [newSesMessageId(), createHash('sha256').update(randomUUID()).digest('hex'), new Date(global.getTime() + i * 1000)],
      );
    }
    const over = await inquire(objects, { receivedAt: new Date(global.getTime() + 60_000) });
    expect(await rejections(over.sesMessageId)).toEqual([['contact_not_forwarded', 'rate_global', [CONTACT_ADDRESS]]]);
    restoreSink();
    expect(rateGlobalMetrics()).toBe(1);

    // 전달 쪽: 창 안에서 시도 30 이 이미 있으면 나가지 않고 미룬다.
    const sendWindow = uniqueWindow(2031);
    // 행 둘 × 시도 15 = 30(칸 CHECK 는 행당 20 이하).
    for (let i = 0; i < 2; i += 1) {
      const seeded = newSesMessageId();
      await testPool().query(
        `INSERT INTO contact_forwards (ses_message_id, sender_hash, next_attempt_at, received_at) VALUES ($1, $2, $3, $3)`,
        [seeded, createHash('sha256').update(randomUUID()).digest('hex'), sendWindow],
      );
      await testPool().query(
        `UPDATE contact_forwards SET attempt_count = $2, claimed_at = $3, next_attempt_at = $4 WHERE ses_message_id = $1`,
        [seeded, CONTACT_FORWARD_LANE_HOURLY_CAP.support / 2, new Date(sendWindow.getTime() + 60_000), new Date(sendWindow.getTime() + 10 * 3_600_000)],
      );
    }
    const queued = await inquire(objects, { receivedAt: new Date(sendWindow.getTime() + 60_000) });
    const ses = fakeSes();
    const row = await forwardRow(queued.sesMessageId);
    expect(await contactForwarder(objects, ses.client, new Date(sendWindow.getTime() + 120_000)).forward(row?.id ?? '')).toBe('deferred');
    expect(ses.sent).toEqual([]);
  });

  it('⑥ 멱등 — 재전달 duplicate · 행 1 · 전달 두 번 불러도 1통 · 종단 행은 되돌릴 수 없다', async () => {
    const objects = newObjectStore();
    const first = await inquire(objects);
    const again = await inquire(objects, { sesMessageId: first.sesMessageId, receivedAt: first.receivedAt });
    expect([first.outcome, again.outcome]).toEqual(['stored', 'duplicate']);
    const count = await testPool().query<{ n: number }>('SELECT count(*)::int AS n FROM contact_forwards WHERE ses_message_id = $1', [first.sesMessageId]);
    expect(count.rows[0]?.n).toBe(1);

    const ses = fakeSes();
    const forwarder = contactForwarder(objects, ses.client, first.receivedAt);
    const row = await forwardRow(first.sesMessageId);
    expect(await forwarder.forward(row?.id ?? '')).toBe('sent');
    expect(await forwarder.forward(row?.id ?? '')).toBe('not_due');
    expect(ses.sent).toHaveLength(1);
    await expect(
      testPool().query(`UPDATE contact_forwards SET status = 'pending', sent_at = NULL, forward_ses_message_id = NULL WHERE id = $1`, [row?.id]),
    ).rejects.toThrow(/terminal/);
  });

  it('⑦ 전달 주소 비밀이 자리값·모양 틀림 → unconfigured · SES 0 · 행 그대로(시도 0) — 값을 넣으면 다음 호출에 나간다', async () => {
    const objects = newObjectStore();
    const inquiry = await inquire(objects);
    const row = await forwardRow(inquiry.sesMessageId);
    for (const secret of [PLACEHOLDER, '{"to":"not-an-address"}', '{"to":"x@atmark.ai"}', 'ops@example.test', '{"to":"a@example.test","cc":"b@example.test"}']) {
      const ses = fakeSes();
      expect(await contactForwarder(objects, ses.client, inquiry.receivedAt, { secret }).forward(row?.id ?? ''), secret).toBe('unconfigured');
      expect(ses.sent, secret).toEqual([]);
    }
    expect(await forwardRow(inquiry.sesMessageId)).toMatchObject({ status: 'pending', attempt_count: 0 });

    // 로더는 유효한 값만 기억한다 — 자리값 뒤에 값이 들어오면 같은 로더로 나간다.
    let current = PLACEHOLDER;
    const ses = fakeSes();
    const forwarder = createContactForwarder({
      pool: testPool(),
      client: ses.client,
      documents: createContactDocumentReader(objects),
      destination: createContactDestinationLoader(() => Promise.resolve(current)),
      now: () => inquiry.receivedAt,
      notifyOnly: false,
    });
    expect(await forwarder.forward(row?.id ?? '')).toBe('unconfigured');
    current = JSON.stringify({ to: CONTACT_DESTINATION });
    expect(await forwarder.forward(row?.id ?? '')).toBe('sent');
    expect(ses.sent[0]?.Destination).toEqual({ ToAddresses: [CONTACT_DESTINATION] });
  });

  it('⑨ 문서 칸 상한(최종 검증 L7) — 제목 998·표시 이름 200·받는 주소 254·본문 2×50,000 단위를 넘는 문서는 dead(document_invalid) · SES 0 · 상한 그대로는 나간다', async () => {
    const source = newObjectStore();
    const cases: readonly [string, (doc: Record<string, unknown>) => Record<string, unknown>, 'dead' | 'sent'][] = [
      ['subject 999', (doc) => ({ ...doc, subject: 's'.repeat(999) }), 'dead'],
      ['fromName 201', (doc) => ({ ...doc, fromName: 'n'.repeat(201) }), 'dead'],
      ['to item 255', (doc) => ({ ...doc, to: ['t'.repeat(255)] }), 'dead'],
      ['text 100001', (doc) => ({ ...doc, text: 'x'.repeat(100_001) }), 'dead'],
      ['at caps', (doc) => ({ ...doc, subject: 's'.repeat(998), fromName: 'n'.repeat(200), to: ['t'.repeat(254)], text: 'x'.repeat(100_000) }), 'sent'],
    ];
    for (const [label, mutate, expected] of cases) {
      const inquiry = await inquire(source);
      const original = JSON.parse(new TextDecoder().decode(await source.get(contactDocumentKey(inquiry.sesMessageId), 1024 * 1024))) as Record<string, unknown>;
      // 앱 롤이 쓴 문서라 믿지 않는다 — 다른 저장소에 손댄 문서를 두고 전달 워커가 그것을 읽게 한다.
      const crafted = newObjectStore();
      await crafted.putIfAbsent(contactDocumentKey(inquiry.sesMessageId), new TextEncoder().encode(JSON.stringify(mutate(original))), 'application/json');
      const ses = fakeSes();
      const row = await forwardRow(inquiry.sesMessageId);
      expect(await contactForwarder(crafted, ses.client, inquiry.receivedAt).forward(row?.id ?? ''), label).toBe(expected);
      if (expected === 'dead') {
        expect(ses.sent, label).toEqual([]);
        expect(await forwardRow(inquiry.sesMessageId), label).toMatchObject({ status: 'dead', last_error: 'document_invalid' });
      } else {
        expect(ses.sent, label).toHaveLength(1);
      }
    }
  });

  it('⑧ 문의 주소 + 모르는 주소 → 문의는 받아들이고 나머지만 unknown_recipient', async () => {
    const objects = newObjectStore();
    const stranger = `nobody-${randomBytes(4).toString('hex')}@atmark.ai`;
    const inquiry = await inquire(objects, { recipients: [CONTACT_ADDRESS, stranger] });
    expect(inquiry.outcome).toBe('stored');
    expect(await forwardRow(inquiry.sesMessageId)).toMatchObject({ status: 'pending' });
    expect(await rejections(inquiry.sesMessageId)).toEqual([['unknown_recipient', null, [stranger]]]);
  });
});
