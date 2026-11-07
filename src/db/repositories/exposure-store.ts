/**
 * src/db/repositories/exposure-store.ts — **노출 기록**(ADR-0016 A — `agent_exposures` · `agent_code_fingerprints`, 202610041000).
 *
 * 읽기 라우트(상세 · 스레드 · 첨부 content · 첨부 URL · 인증 코드)가 본문을 돌려주기 **전에** 부른다. 던지면 라우트가 503 이다(fail closed — 기록 없이
 * 본문을 주지 않는다, `api/exposure.ts`). 한 번의 호출 = 한 트랜잭션:
 *   ① 노출된 메일의 신뢰 사실을 **DB 에서 다시 읽는다**(위험도 · 스캐너 적중 계열 · SPF/DKIM/DMARC · 인증 · sender_trust · 스레드 · 발신자). 호출자가
 *      등급을 주장하지 못한다 — 첨부 내용 판정(`contentRisk`)만 호출자가 준다(첨부 텍스트는 읽을 때 처음 스캔된다).
 *   ② 등급(`security/taint.ts` `classifyTaint`) → `agent_exposures` UPSERT(등급은 내려가지 않는다 — 트리거).
 *   ③ 코드 지문(`security/dlp/codes.ts` `fingerprintCode`) · 링크 토큰 지문(`fingerprintLink`, 재검증 N2) → `agent_code_fingerprints` UPSERT(다시
 *      읽으면 시각을 민다). 코드·토큰 원문은 저장하지 않는다.
 *      출처 등록 도메인은 PSL(`domains/psl.ts`)로 — 무료·공용 메일 도메인의 예외는 DLP 가 비교 때 한다.
 *
 * 메일이 이 에이전트의 것이 아니면(호출자 버그) 던진다 — 남의 메일로 노출을 쓰지 않는다.
 */

import type { Pool } from 'pg';

import type { AgentId, InboundSenderTrust, InjectionRisk, SesVerdict } from '../schema';
import { registrableDomainOf } from '../../domains/psl';
import { fingerprintCode, fingerprintLink } from '../../security/dlp/codes';
import type { HmacKeyring } from '../../security/hmac-keyring';
import type { RuleFamily } from '../../security/injection/rules';
import { classifyTaint, type ExposureField, type ExposureSurface, type TaintFinding, type TaintLevel } from '../../security/taint';
import { withTransaction } from '../client';
import { selectRows } from './rows';

/** 노출 한 건 — 무엇이 보였나. */
export interface ExposureItem {
  readonly inboundMessageId: string;
  /**
   * `body`(제목 포함 — 상세) · `subject`(제목·발신자만 — 목록 · 스레드 보기, 재검증 N1) · `verification_code` · `attachment:<part_index>`.
   * `subject` 행은 T1 이하면 다시 기록해도 `last_at` 을 밀지 않는다(아래 UPSERT) — 같은 내용을 다시 보는 폴링이 창을 늘리지 않게. T2 제목은 민다.
   */
  readonly part: 'body' | 'subject' | 'verification_code' | `attachment:${number}`;
  readonly field: ExposureField;
  /**
   * 첨부 텍스트 면만 — 이번에 뽑은 텍스트의 스캐너 판정과 적중. `risk: null` = 판정 없음(이미지 · 다운로드 URL — 우리가 보지 않은 바이트) → T2.
   * 다른 면은 `null`(메일의 판정을 DB 에서 읽는다).
   */
  readonly content: { readonly risk: InjectionRisk | null; readonly findings: readonly TaintFinding[] } | null;
  /**
   * 그 메일의 Reply-To 주소(리뷰 M4) — 공격자가 고르는 값이라 발신자 7일 창에 함께 넣는다(좁히는 방향이라 호출자 값을 써도 된다). 모양이 아닌 값은
   * 버리고, 소문자 · 최대 16.
   */
  readonly replyTo?: readonly string[];
}

/** 에이전트에게 준 인증 코드 하나, 또는 받은 메일 URL 안의 토큰 하나(재검증 N2 — `kind: 'link'`) — 지문만 남는다. */
export interface ExposedCode {
  readonly inboundMessageId: string;
  readonly code: string;
  /** 없으면 `code`. */
  readonly kind?: 'code' | 'link';
}

export interface ExposureRecordInput {
  readonly agentId: AgentId;
  readonly surface: ExposureSurface;
  readonly items: readonly ExposureItem[];
  readonly codes: readonly ExposedCode[];
}

/** 기록 결과 — 메트릭용 등급 목록(항목 순서). */
export interface ExposureRecordResult {
  readonly levels: readonly TaintLevel[];
}

export interface ExposureRecorder {
  record(input: ExposureRecordInput): Promise<ExposureRecordResult>;
}

interface FactRow {
  id: string;
  thread_id: string;
  from_address: string;
  from_domain: string;
  from_authenticated: boolean;
  spf_verdict: SesVerdict;
  dkim_verdict: SesVerdict;
  dmarc_verdict: SesVerdict;
  injection_risk: InjectionRisk | null;
  sender_trust: InboundSenderTrust | null;
  findings: string[];
  /** 소유자가 풀어 준 메일(202610081000) — 노출은 늘 T2. */
  released: boolean;
  /** 신뢰 발신자 우회 — 본문 · 제목 면의 메일 판정을 보지 않는다(`classifyTaint`). */
  trusted_bypass: boolean;
}

const LEVEL_NUMBER: Readonly<Record<TaintLevel, number>> = { T0: 0, T1: 1, T2: 2 };

/** `family:damped(0|1)` → 적중. 모양이 틀리면 버리지 않고 완화되지 않은 적중으로 읽는다(fail closed). */
function findingOf(raw: string): TaintFinding {
  const at = raw.lastIndexOf(':');
  return { family: raw.slice(0, at) as RuleFamily, damped: raw.slice(at + 1) === '1' };
}

export class ExposureOwnershipError extends Error {
  constructor(readonly inboundMessageId: string) {
    super(`노출할 메일이 이 에이전트의 것이 아니다 (inbound_message_id=${inboundMessageId})`);
    this.name = 'ExposureOwnershipError';
  }
}

export function createPostgresExposureRecorder(pool: Pool, options: { readonly keyring: HmacKeyring }): ExposureRecorder {
  return {
    async record(input: ExposureRecordInput): Promise<ExposureRecordResult> {
      if (input.items.length === 0 && input.codes.length === 0) return { levels: [] };
      const ids = [...new Set([...input.items.map((item) => item.inboundMessageId), ...input.codes.map((code) => code.inboundMessageId)])];
      return withTransaction(pool, async (client) => {
        const facts = await selectRows<FactRow>(
          client,
          `SELECT m.id, m.thread_id, m.from_address, m.from_domain, m.from_authenticated,
                  m.spf_verdict, m.dkim_verdict, m.dmarc_verdict, m.injection_risk, m.sender_trust,
                  (m.released_at IS NOT NULL) AS released, m.trusted_bypass,
                  coalesce((SELECT array_agg(f.family || ':' || CASE WHEN f.damped THEN '1' ELSE '0' END ORDER BY f.ordinal)
                              FROM security_findings f
                             WHERE f.inbound_message_id = m.id AND f.scanner_version = m.scanner_version), '{}') AS findings
             FROM inbound_messages m
            WHERE m.id = ANY($1::uuid[]) AND m.agent_id = $2`,
          [ids, input.agentId],
        );
        const byId = new Map(facts.map((row) => [row.id, row]));
        const factOf = (id: string): FactRow => {
          const row = byId.get(id);
          if (row === undefined) throw new ExposureOwnershipError(id);
          return row;
        };

        const levels: TaintLevel[] = [];
        const computed = input.items.map((item) => {
          const fact = factOf(item.inboundMessageId);
          const findings = item.content === null ? fact.findings.map(findingOf) : [...item.content.findings];
          const level = classifyTaint({
            surface: input.surface,
            field: item.field,
            injectionRisk: item.content === null ? fact.injection_risk : item.content.risk,
            findings,
            auth: {
              spf: fact.spf_verdict,
              dkim: fact.dkim_verdict,
              dmarc: fact.dmarc_verdict,
              fromAuthenticated: fact.from_authenticated,
            },
            senderTrust: fact.sender_trust,
            released: fact.released,
            trustedBypass: fact.trusted_bypass,
          });
          levels.push(level);
          return {
            id: item.inboundMessageId,
            part: item.part,
            level: LEVEL_NUMBER[level],
            families: [...new Set(findings.filter((f) => !f.damped).map((f) => f.family))].sort().slice(0, 32),
            threadId: fact.thread_id,
            sender: fact.from_address,
            replyTo: [...new Set((item.replyTo ?? []).map((a) => a.trim().toLowerCase()))]
              .filter((a) => /^[^@\s]+@[^@\s]+$/u.test(a) && !/\p{Cc}/u.test(a))
              .slice(0, 16),
          };
        });

        // 같은 (메일, 부분)이 한 번에 두 번 오면 한 행으로 — 높은 등급이 이긴다(ON CONFLICT 는 한 문장에서 같은 행을 두 번 고치지 못한다).
        const merged = new Map<string, (typeof computed)[number]>();
        for (const row of computed) {
          const key = `${row.id}|${row.part}`;
          const seen = merged.get(key);
          if (seen === undefined) merged.set(key, row);
          else merged.set(key, { ...(row.level > seen.level ? row : seen), replyTo: [...new Set([...seen.replyTo, ...row.replyTo])].slice(0, 16) });
        }
        // 본문 행(상세 · 첨부 · 코드)은 다시 받으면 시각을 민다 — 실제 내용을 다시 받았다. 제목 행(목록 · 스레드 보기, 재검증 N1 리드 결정)은 T1 이하면
        // 다시 봐도 쓰지 않는다(창은 처음 본 때 기준 — 폴링 쓰기 0, 등급이 오를 때만 고친다). T2 제목은 다시 보이면 시각을 민다(리드 결정 — 아래).
        const content = [...merged.values()].filter((row) => row.part !== 'subject');
        const subjects = [...merged.values()].filter((row) => row.part === 'subject');
        const conflict = {
          content: `DO UPDATE
               SET level = GREATEST(agent_exposures.level, EXCLUDED.level),
                   families = CASE WHEN EXCLUDED.level >= agent_exposures.level THEN EXCLUDED.families ELSE agent_exposures.families END,
                   surface = EXCLUDED.surface,
                   reply_to = (SELECT coalesce(array_agg(DISTINCT r), '{}') FROM (
                                 SELECT unnest(agent_exposures.reply_to || EXCLUDED.reply_to) AS r LIMIT 16) u),
                   last_at = GREATEST(agent_exposures.last_at, now())`,
          // 리드 결정(재검증) — T2 제목은 다시 보이면 시각을 민다(위험한 제목이 4시간 뒤 다시 보이면 창이 다시 열린다). T1 이하는 그대로 — 폴링 폭주는
          // T1(미인증 뉴스레터)에서 생기므로 쓰기 증폭은 T2 제목에만 남는다.
          subject: `DO UPDATE
               SET level = GREATEST(agent_exposures.level, EXCLUDED.level),
                   families = CASE WHEN EXCLUDED.level >= agent_exposures.level THEN EXCLUDED.families ELSE agent_exposures.families END,
                   last_at = CASE WHEN GREATEST(agent_exposures.level, EXCLUDED.level) >= 2 THEN GREATEST(agent_exposures.last_at, now())
                                  ELSE agent_exposures.last_at END
             WHERE EXCLUDED.level > agent_exposures.level OR EXCLUDED.level >= 2`,
        } as const;
        for (const [rows, onConflict] of [
          [content, conflict.content],
          [subjects, conflict.subject],
        ] as const) {
          if (rows.length === 0) continue;
          await client.query(
            `INSERT INTO agent_exposures (agent_id, inbound_message_id, part, surface, level, families, thread_id, sender, reply_to)
             SELECT $1, e.id, e.part, $2, e.level, string_to_array(e.families, ','), e.thread_id, e.sender, string_to_array(e.reply_to, ' ')
               FROM unnest($3::uuid[], $4::text[], $5::smallint[], $6::text[], $7::uuid[], $8::text[], $9::text[])
                 AS e(id, part, level, families, thread_id, sender, reply_to)
             ON CONFLICT (agent_id, inbound_message_id, part) ${onConflict}`,
            [
              input.agentId,
              input.surface,
              rows.map((row) => row.id),
              rows.map((row) => row.part),
              rows.map((row) => row.level),
              // 빈 목록은 `string_to_array('', ',')` = `{}` — 계열 이름에는 쉼표가 없다(모양 CHECK).
              rows.map((row) => row.families.join(',')),
              rows.map((row) => row.threadId),
              rows.map((row) => row.sender),
              // 빈 목록은 `string_to_array('', ' ')` = `{}` — 주소에는 공백이 없다(모양 검사).
              rows.map((row) => row.replyTo.join(' ')),
            ],
          );
        }

        const prints = input.codes.flatMap((exposed) => {
          const fact = factOf(exposed.inboundMessageId);
          const domain = fact.from_domain.toLowerCase();
          const origin = registrableDomainOf(domain) ?? domain;
          const print =
            exposed.kind === 'link' ? fingerprintLink(options.keyring, exposed.code, origin) : fingerprintCode(options.keyring, exposed.code, origin);
          return print === null ? [] : [{ ...print, inboundMessageId: exposed.inboundMessageId }];
        });
        if (prints.length > 0) {
          await client.query(
            `INSERT INTO agent_code_fingerprints (agent_id, kid, mac, origin_domain, inbound_message_id)
             SELECT DISTINCT ON (c.kid, c.mac, c.origin_domain) $1, c.kid, c.mac, c.origin_domain, c.inbound_message_id
               FROM unnest($2::text[], $3::text[], $4::text[], $5::uuid[]) AS c(kid, mac, origin_domain, inbound_message_id)
             ON CONFLICT (agent_id, kid, mac, origin_domain) DO UPDATE
               SET created_at = GREATEST(agent_code_fingerprints.created_at, now())`,
            [
              input.agentId,
              prints.map((p) => p.kid),
              prints.map((p) => p.mac),
              prints.map((p) => p.originDomain),
              prints.map((p) => p.inboundMessageId),
            ],
          );
        }
        return { levels };
      });
    },
  };
}
