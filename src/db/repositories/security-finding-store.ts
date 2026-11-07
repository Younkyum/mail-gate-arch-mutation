/**
 * src/db/repositories/security-finding-store.ts — injection 스캐너 적중의 **좌표** 기록 (계획 §6 P4).
 *
 * **원문을 받는 인자가 없다.** `SecurityFindingRecord` 에는 룰·축·필드·위치·가중치·버전뿐이다 — 스캐너
 * 결과(`SecurityFinding`)에도 원문이 없고, 그 규율을 저장소 인자와 DB CHECK(문자열 컬럼 전부 모양 제약)까지
 * 끈다. 받을 자리가 없으면 넣을 수도 없다(`inbound-store.ts` 머리말과 같은 방향).
 *
 * 기록은 수신 행과 **같은 트랜잭션**에서 한다(`inbound-store.recordMessage` 가 부른다) — findings 없는
 * 판정 행이나 행 없는 findings 가 생기지 않는다.
 */

import type { Pool } from 'pg';

import type { Queryable } from '../client';
import type { SecurityFindingRow } from '../schema';

/** 적중 하나. 스캐너의 `SecurityFinding` 에서 **이름 붙인 필드만** 옮긴다(원문 없음). */
export interface SecurityFindingRecord {
  readonly ruleId: string;
  readonly family: string;
  readonly field: string;
  readonly fieldIndex: number;
  readonly view: string;
  readonly start: number;
  readonly end: number;
  readonly weight: number;
  readonly damped: boolean;
}

/** `inboundMessageId` 의 적중을 `scannerVersion` 으로 덧붙인다. 같은 (행, 버전, 순서)는 한 번뿐이다. */
export async function insertSecurityFindings(
  db: Queryable,
  inboundMessageId: string,
  scannerVersion: string,
  findings: readonly SecurityFindingRecord[],
): Promise<void> {
  if (findings.length === 0) return;
  await db.query(
    `INSERT INTO security_findings
       (inbound_message_id, scanner_version, ordinal, rule_id, family, field, field_index, view,
        start_offset, end_offset, weight, damped)
     SELECT $1, $2, f.ordinal, f.rule_id, f.family, f.field, f.field_index, f.view,
            f.start_offset, f.end_offset, f.weight, f.damped
       FROM unnest($3::int[], $4::text[], $5::text[], $6::text[], $7::int[], $8::text[], $9::int[], $10::int[],
                   $11::numeric[], $12::boolean[])
         AS f(ordinal, rule_id, family, field, field_index, view, start_offset, end_offset, weight, damped)
     ON CONFLICT (inbound_message_id, scanner_version, ordinal) DO NOTHING`,
    [
      inboundMessageId,
      scannerVersion,
      findings.map((_, index) => index),
      findings.map((f) => f.ruleId),
      findings.map((f) => f.family),
      findings.map((f) => f.field),
      findings.map((f) => f.fieldIndex),
      findings.map((f) => f.view),
      findings.map((f) => f.start),
      findings.map((f) => f.end),
      findings.map((f) => f.weight),
      findings.map((f) => f.damped),
    ],
  );
}

/** 한 수신 행의 적중(버전·순서 순). 조사·테스트용 조회. */
export async function listSecurityFindings(pool: Pool, inboundMessageId: string): Promise<SecurityFindingRow[]> {
  const result = await pool.query<SecurityFindingRow>(
    `SELECT id, inbound_message_id, scanner_version, ordinal, rule_id, family, field, field_index, view,
            start_offset, end_offset, weight, damped, created_at
       FROM security_findings WHERE inbound_message_id = $1
      ORDER BY scanner_version, ordinal`,
    [inboundMessageId],
  );
  return result.rows;
}
