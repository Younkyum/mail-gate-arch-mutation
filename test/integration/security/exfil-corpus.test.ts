/**
 * ADR-0016 **적대 코퍼스**(`test/fixtures/exfil/cases.json`) — 받은 메일에 홀린 에이전트의 유출 모양을 끝에서 끝까지:
 * 수신 소비자(복사 지문) → 읽기 라우트(노출 · 코드 지문) → 발송 라우트(발신 DLP) → 관문(Stage 7 위험 보류). 모드는 `unrestricted` —
 * 수신자 제한 없이 **위험 보류만으로** 사람에게 가야 한다. 기대: audit 의 위험 사유 집합이 같고, 전송단 호출 0.
 *
 * 남는 한계(ADR-0016): 의역·base64·단어 숫자는 이 그물에 걸리지 않는다 — 그 몫은 오염 맥락(A)이다. 이 코퍼스는 "잡겠다고 한 것은 잡는다" 를 지킨다.
 *
 * **`TEST_DATABASE_URL` 이 없으면 통째로 건너뛴다.**
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { InboundMessageRow } from '../../../src/db/schema';
import { closeTestPool, DATABASE_AVAILABLE } from '../db/support/harness';
import { auditOf, readCode, readDetail, receive, reply, riskReasonsOf, send, world } from './support';

afterAll(async () => {
  if (DATABASE_AVAILABLE) await closeTestPool();
});

interface InboundSpec {
  readonly from: string;
  readonly subject?: string;
  readonly text: string;
  readonly authenticated?: boolean;
}

interface ExfilCase {
  readonly name: string;
  readonly note: string;
  readonly inbound: readonly InboundSpec[];
  readonly read: 'detail' | 'verification_code' | 'none';
  readonly senderDomain?: string;
  readonly send?: { readonly to: readonly string[]; readonly text: string; readonly html?: string };
  readonly reply?: { readonly toInbound: number; readonly text: string };
  readonly expect: readonly string[];
}

const CORPUS = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'fixtures', 'exfil', 'cases.json'), 'utf8')) as {
  readonly cases: readonly ExfilCase[];
};

describe.skipIf(!DATABASE_AVAILABLE)('ADR-0016 적대 코퍼스 — 유출 모양이 전부 사람에게 간다', { timeout: 120_000 }, () => {
  it('코퍼스가 비어 있지 않고 이름이 겹치지 않는다', () => {
    expect(CORPUS.cases.length).toBeGreaterThanOrEqual(10);
    expect(new Set(CORPUS.cases.map((c) => c.name)).size).toBe(CORPUS.cases.length);
  });

  for (const testCase of CORPUS.cases) {
    it(`${testCase.name} — ${testCase.note}`, async () => {
      const w = await world({ mode: 'unrestricted' });
      const received: InboundMessageRow[] = [];
      for (const mail of testCase.inbound) {
        received.push(
          await receive(w, { from: mail.from, subject: mail.subject ?? 'hello', text: mail.text, authenticated: mail.authenticated ?? true }),
        );
      }
      if (testCase.read === 'detail') {
        for (const mail of received) expect((await readDetail(w, mail.id)).status).toBe(200);
      } else if (testCase.read === 'verification_code') {
        const code = await readCode(w, testCase.senderDomain ?? '');
        expect(code.status, JSON.stringify(code.body)).toBe(200);
      }

      let response;
      if (testCase.reply !== undefined) {
        const target = received[testCase.reply.toInbound];
        if (target === undefined) throw new Error('회신 대상이 없다');
        response = await reply(w, target, { text: testCase.reply.text });
      } else if (testCase.send !== undefined) {
        response = await send(w, { to: testCase.send.to, text: testCase.send.text, ...(testCase.send.html === undefined ? {} : { html: testCase.send.html }) });
      } else {
        throw new Error('send 또는 reply 가 있어야 한다');
      }
      expect(response.status, JSON.stringify(response.body)).toBe(202);
      expect(riskReasonsOf((await auditOf(w, response)).reasons).sort()).toEqual([...testCase.expect].sort());
      expect(w.transport.calls()).toBe(0);
    });
  }
});
