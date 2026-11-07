/**
 * `ATMARK_CONTACT_ROUTING`(2026-09-30, `src/contact/routing.ts`) — support@atmark.ai 문의가 **지원 에이전트 수신함**과 **운영자 전달** 중 어디로 가는가.
 * 실제 Postgres(앱 롤) + 로컬 객체 저장소 + 가짜 SES.
 *
 * 지원 에이전트(`support@atmark.ai`)는 공유 테스트 DB 에 영구히 만들 수 없다(주소는 전역 활성 UNIQUE · 운영자 허가 PK) — 그래서 에이전트 조회
 * 한 칸만 바꿔 끼운다: `findAgentsByAddresses` 가 support@ 를 **픽스처 에이전트**로 돌려준다(나머지는 운영 구현 그대로). DB 가 support@ 를 어떻게
 * 막고 허가하는지는 `test/integration/db/operator-reserved-addresses.test.ts` 가 본다.
 *
 * 되돌리면 빨개져야 하는 것:
 *   ① `forward`(기본 · 생략) — 전달 행 1 · 에이전트 행 0(support@ 를 에이전트 조회에 넘기지 않는다).
 *   ② `agent_and_forward` — 전달 행 1 **과** 에이전트 행 1(이중 수신). 재전달은 둘 다 멱등(SES 메시지 ID).
 *   ③ `agent` — 에이전트 행 1 · 전달 행 0.
 *   ④ 각 경로의 규칙: 스팸 FAIL 이면 intake 는 거부(`contact_not_forwarded`/`spam_verdict`)하고 에이전트 몫은 저장한다.
 *   ⑤ 섞인 수신자(support@ + 같은 에이전트의 다른 주소) — 에이전트 행은 하나.
 *   ⑥ `agent_and_notify` 의 전달 = 알림만: 원 제목 + 보낸 사람 도메인 · 본문·보낸 사람 주소 없음 · Reply-To 없음 · 두 언어.
 *   ⑦ 202609301540 — `abuse@`·`postmaster@` 도 support@ 와 같은 라우팅: `forward` 는 전달만 · `agent_and_forward` 는 전달 + 지원 에이전트(별칭) ·
 *      별칭이 아직 없으면 전달은 되고 에이전트 몫만 `unknown_recipient` · 여러 문의 주소로 온 같은 메일은 전달 한 통 · 거부 행의 수신자는 온 주소 그대로.
 */

import { randomBytes } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';

import { CONTACT_ADDRESS, CONTACT_RECIPIENT_ADDRESSES } from '../../../src/contact/intake';
import type { ContactRouting } from '../../../src/contact/routing';
import { CONTACT_NOTIFY_COPY } from '../../../src/notify/contact-forward-template';
import type { ObjectStore } from '../../../src/storage/object-store';
import type { InboundConsumerDependencies } from '../../../src/workers/inbound-consumer';
import { closeTestPool, DATABASE_AVAILABLE, seedFixture, testPool, type Fixture } from '../db/support/harness';
import { CONTACT_DESTINATION, consumerDeps, contactForwarder, deliver, eml, fakeSes, newObjectStore, newSesMessageId, uniqueWindow } from './support';

afterAll(async () => {
  if (DATABASE_AVAILABLE) await closeTestPool();
});

/**
 * 운영 소비자 + 라우팅 + 문의 주소 → 픽스처 에이전트(조회 한 칸만 바꾼다). `held` 는 지원 에이전트가 쥔 문의 주소(기본 support@ 하나 — abuse@·postmaster@ 는
 * 운영자가 별칭을 붙인 뒤에만, deploy §33).
 */
function routedDeps(
  objects: ObjectStore,
  routing: ContactRouting | undefined,
  supportAgent: Fixture,
  held: readonly string[] = [CONTACT_ADDRESS],
): InboundConsumerDependencies {
  const base = consumerDeps(testPool(), objects);
  return {
    ...base,
    ...(routing === undefined ? {} : { contactRouting: routing }),
    receipts: {
      ...base.receipts,
      findAgentsByAddresses: async (addresses) => {
        const real = await base.receipts.findAgentsByAddresses(addresses.filter((address) => !CONTACT_RECIPIENT_ADDRESSES.includes(address)));
        const support = addresses
          .filter((address) => held.includes(address))
          .map((address) => ({ agentId: supportAgent.agentId, address, organizationId: supportAgent.organizationId, organizationActive: true, domainActive: true }));
        return [...real, ...support];
      },
    },
  };
}

async function inquire(
  deps: InboundConsumerDependencies,
  options: {
    readonly recipients?: readonly string[];
    readonly spam?: string;
    readonly subject?: string;
    readonly sesMessageId?: string;
    readonly from?: string;
    readonly to?: string;
  } = {},
): Promise<{ sesMessageId: string; outcome: string; from: string; receivedAt: Date }> {
  const sesMessageId = options.sesMessageId ?? newSesMessageId();
  const from = options.from ?? `customer-${randomBytes(3).toString('hex')}@mail.example.com`;
  const receivedAt = uniqueWindow(2033);
  const outcome = await deliver(
    deps,
    eml({ from, to: options.to ?? CONTACT_ADDRESS, subject: options.subject ?? '결제 문의', text: '영수증을 다시 보내 주세요.' }),
    {
      sesMessageId,
      recipients: options.recipients ?? [CONTACT_ADDRESS],
      source: 'bounce@mail.example.com',
      commonFrom: [from],
      receivedAt: receivedAt.toISOString(),
      ...(options.spam === undefined ? {} : { spam: options.spam }),
    },
  );
  return { sesMessageId, outcome, from, receivedAt };
}

async function counts(sesMessageId: string, agentId: string): Promise<{ forwards: number; agentRows: number }> {
  const forwards = await testPool().query('SELECT 1 FROM contact_forwards WHERE ses_message_id = $1', [sesMessageId]);
  const agentRows = await testPool().query('SELECT 1 FROM inbound_messages WHERE ses_message_id = $1 AND agent_id = $2', [sesMessageId, agentId]);
  return { forwards: forwards.rowCount ?? 0, agentRows: agentRows.rowCount ?? 0 };
}

async function rejectionReasons(sesMessageId: string): Promise<string[]> {
  const result = await testPool().query<{ reason: string; detail: string | null }>(
    'SELECT reason, detail FROM inbound_rejections WHERE ses_message_id = $1 ORDER BY reason',
    [sesMessageId],
  );
  return result.rows.map((row) => `${row.reason}:${row.detail ?? ''}`);
}

describe.skipIf(!DATABASE_AVAILABLE)('문의 라우팅 — ATMARK_CONTACT_ROUTING', () => {
  it('① forward(생략·명시) — 전달 행 1 · 에이전트 행 0', async () => {
    const agent = await seedFixture(testPool());
    for (const routing of [undefined, 'forward'] as const) {
      const inquiry = await inquire(routedDeps(newObjectStore(), routing, agent));
      expect(inquiry.outcome, String(routing)).toBe('stored');
      expect(await counts(inquiry.sesMessageId, agent.agentId), String(routing)).toEqual({ forwards: 1, agentRows: 0 });
    }
  });

  it('② agent_and_forward — 전달 행 1 과 에이전트 행 1 · 재전달은 둘 다 멱등', async () => {
    const agent = await seedFixture(testPool());
    const deps = routedDeps(newObjectStore(), 'agent_and_forward', agent);
    const inquiry = await inquire(deps);
    expect(inquiry.outcome).toBe('stored');
    expect(await counts(inquiry.sesMessageId, agent.agentId)).toEqual({ forwards: 1, agentRows: 1 });
    const again = await inquire(deps, { sesMessageId: inquiry.sesMessageId, from: inquiry.from });
    expect(again.outcome).toBe('duplicate');
    expect(await counts(inquiry.sesMessageId, agent.agentId)).toEqual({ forwards: 1, agentRows: 1 });
    expect(await rejectionReasons(inquiry.sesMessageId)).toEqual([]);
  });

  it('③ agent — 에이전트 행 1 · 전달 행 0', async () => {
    const agent = await seedFixture(testPool());
    const inquiry = await inquire(routedDeps(newObjectStore(), 'agent', agent));
    expect(inquiry.outcome).toBe('stored');
    expect(await counts(inquiry.sesMessageId, agent.agentId)).toEqual({ forwards: 0, agentRows: 1 });
  });

  it('④ 각 경로의 규칙 — 스팸 FAIL: intake 는 거부(spam_verdict), 에이전트 몫은 저장한다', async () => {
    const agent = await seedFixture(testPool());
    const inquiry = await inquire(routedDeps(newObjectStore(), 'agent_and_forward', agent), { spam: 'FAIL' });
    expect(inquiry.outcome).toBe('stored');
    expect(await counts(inquiry.sesMessageId, agent.agentId)).toEqual({ forwards: 0, agentRows: 1 });
    expect(await rejectionReasons(inquiry.sesMessageId)).toEqual(['contact_not_forwarded:spam_verdict']);
  });

  it('⑤ 섞인 수신자(support@ + 같은 에이전트의 대표 주소) — 에이전트 행은 하나 · 전달 행 하나', async () => {
    const agent = await seedFixture(testPool());
    const inquiry = await inquire(routedDeps(newObjectStore(), 'agent_and_notify', agent), { recipients: [CONTACT_ADDRESS, agent.address] });
    expect(inquiry.outcome).toBe('stored');
    expect(await counts(inquiry.sesMessageId, agent.agentId)).toEqual({ forwards: 1, agentRows: 1 });
    expect(await rejectionReasons(inquiry.sesMessageId)).toEqual([]);
  });

  it('⑥ agent_and_notify 의 전달 = 알림만 — 원 제목 + 보낸 사람 도메인 · 본문·주소·Reply-To 없음 · 두 언어', async () => {
    const agent = await seedFixture(testPool());
    const objects = newObjectStore();
    const inquiry = await inquire(routedDeps(objects, 'agent_and_notify', agent), { subject: '환불 요청' });
    const row = await testPool().query<{ id: string }>('SELECT id FROM contact_forwards WHERE ses_message_id = $1', [inquiry.sesMessageId]);
    const { client, sent } = fakeSes();
    const forwarder = contactForwarder(objects, client, inquiry.receivedAt, { notifyOnly: true });
    expect(await forwarder.forward(row.rows[0]?.id ?? '')).toBe('sent');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.FromEmailAddress).toBe('support@atmark.ai');
    expect(sent[0]?.Destination).toEqual({ ToAddresses: [CONTACT_DESTINATION] });
    const raw = Buffer.from(sent[0]?.Content?.Raw?.Data ?? new Uint8Array()).toString('utf8');
    const [head = '', encoded = ''] = raw.split('\r\n\r\n');
    expect(head).not.toMatch(/^Reply-To:/im);
    // 전달 주소가 활성 운영자의 사용자 주소가 아니다 — 기본 영어 한 통(2026-10-10, 운영자 메일도 한 언어).
    expect(head).toContain(`Subject: =?UTF-8?B?${Buffer.from(`${CONTACT_NOTIFY_COPY.en.subjectPrefix}환불 요청`).toString('base64')}?=`);
    const body = Buffer.from(encoded, 'base64').toString('utf8');
    expect(body).toContain('Sender domain: mail.example.com');
    expect(body).toContain('Subject: 환불 요청');
    expect(body).toContain("Reply from the support agent's inbox in the console");
    expect(body).not.toContain('보낸 사람 도메인');
    expect(body).not.toContain('지원 에이전트 수신함');
    expect(body).not.toContain('영수증을 다시 보내 주세요.');
    expect(body).not.toContain(inquiry.from);
  });

  it('⑦ abuse@·postmaster@(202609301540) — support@ 와 같은 라우팅 · 별칭 전에는 에이전트 몫만 unknown_recipient · 여러 문의 주소는 전달 한 통', async () => {
    const agent = await seedFixture(testPool());
    const aliases = [CONTACT_ADDRESS, 'abuse@atmark.ai', 'postmaster@atmark.ai'];
    for (const address of ['abuse@atmark.ai', 'postmaster@atmark.ai']) {
      // forward — 운영자 메일함 전달만(에이전트 조회에 넘기지 않는다 — 별칭이 있어도).
      const forwarded = await inquire(routedDeps(newObjectStore(), 'forward', agent, aliases), { recipients: [address], to: address, subject: 'Spam report' });
      expect(forwarded.outcome, address).toBe('stored');
      expect(await counts(forwarded.sesMessageId, agent.agentId), address).toEqual({ forwards: 1, agentRows: 0 });
      expect(await rejectionReasons(forwarded.sesMessageId), address).toEqual([]);

      // agent_and_forward + 별칭 — 전달 1 · 지원 에이전트 수신함 1.
      const both = await inquire(routedDeps(newObjectStore(), 'agent_and_forward', agent, aliases), { recipients: [address], to: address });
      expect(both.outcome, address).toBe('stored');
      expect(await counts(both.sesMessageId, agent.agentId), address).toEqual({ forwards: 1, agentRows: 1 });
      const stored = await testPool().query<{ envelope_recipient: string }>(
        'SELECT envelope_recipient FROM inbound_messages WHERE ses_message_id = $1 AND agent_id = $2',
        [both.sesMessageId, agent.agentId],
      );
      expect(stored.rows.map((row) => row.envelope_recipient), address).toEqual([address]);

      // agent_and_forward, 별칭 전(§33 운영자 명령 전) — 사람에게는 전달로 닿고, 에이전트 몫만 unknown_recipient 로 남는다.
      const before = await inquire(routedDeps(newObjectStore(), 'agent_and_forward', agent), { recipients: [address], to: address });
      expect(before.outcome, address).toBe('stored');
      expect(await counts(before.sesMessageId, agent.agentId), address).toEqual({ forwards: 1, agentRows: 0 });
      expect(await rejectionReasons(before.sesMessageId), address).toEqual(['unknown_recipient:']);
    }

    // 같은 메일이 support@·abuse@·postmaster@ 로 함께 — 전달 한 통 · 에이전트 행 하나.
    const all = await inquire(routedDeps(newObjectStore(), 'agent_and_forward', agent, aliases), { recipients: aliases, to: 'abuse@atmark.ai' });
    expect(all.outcome).toBe('stored');
    expect(await counts(all.sesMessageId, agent.agentId)).toEqual({ forwards: 1, agentRows: 1 });

    // 스팸 FAIL — 전달 거부 행의 수신자는 온 주소(abuse@) 그대로 · 에이전트 몫은 저장.
    const spam = await inquire(routedDeps(newObjectStore(), 'agent_and_forward', agent, aliases), { recipients: ['abuse@atmark.ai'], to: 'abuse@atmark.ai', spam: 'FAIL' });
    expect(await counts(spam.sesMessageId, agent.agentId)).toEqual({ forwards: 0, agentRows: 1 });
    const rows = await testPool().query<{ recipients: string[] }>(
      `SELECT envelope_recipients AS recipients FROM inbound_rejections WHERE ses_message_id = $1 AND reason = 'contact_not_forwarded'`,
      [spam.sesMessageId],
    );
    expect(rows.rows.map((row) => row.recipients)).toEqual([['abuse@atmark.ai']]);
  });
});
