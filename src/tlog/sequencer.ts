/**
 * src/tlog/sequencer.ts — **outbox → 잎** (ADR-0008 §2.3·§2.4). 롤 `atmark_tlog` 로 돈다.
 *
 * 순서 키와 멱등:
 *   - outbox 를 `processed_at IS NULL` 로 고르고 **id 순서**로 처리한다. 커서(마지막 id)를 쓰지 않는 이유: id 는 INSERT 때 매겨지고
 *     커밋은 그 뒤라, 늦게 커밋된 작은 id 를 커서가 건너뛴다. 처리 표시는 그 사건의 잎과 **같은 트랜잭션**이다 — 둘 다 있거나 둘 다 없다
 *     (DB 가 한 번 더 본다: 잎 없는 처리 표시는 거부, 같은 사건의 잎 둘은 UNIQUE).
 *   - 조직 안 `seq` 는 서열 시점에 연속으로 매긴다(DB 트리거가 연속을 강제). 원천 시각이 아니라 **커밋된 순서**다 — 잎의 `at` 이 원천 시각.
 *   - 서열기·에폭 마감은 같은 advisory lock 을 잡는다(예약 동시성 1 위의 두 번째 벽).
 *
 * 원천 행이 서열 시점에 **없으면**(트리거를 끄고 지웠다) 잎 `source.missing(not_found)` 을 쓴다 — 그 사실 자체가 커밋된다. 행은 있지만 잎 모양으로
 * 옮길 수 없으면(무한대 시각 등) `source.missing(unrepresentable)` — 행 하나가 전 조직의 로그를 멈추게 하지 않고, 조용히 건너뛰지도 않는다.
 * 폐기된 조직(솔트 키 NULL)의 사건은 처리하지 않고 남긴다(migrate `status` 의 `transparency.pendingOutbox` 가 보인다) — 커밋을
 * 열 수 없는 키로 새 잎을 만들 수 없다.
 */

import { randomBytes } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { withTransaction } from '../db/client';
import { JcsInputError } from '../passport/jcs';
import { ORG_LOG_ID_BYTES, SALT_KEY_BYTES, type TlogSourceTable } from './constants';
import { buildOrgLeaf, ENTITLEMENT_LATE_LIMIT_FIELDS, ENTITLEMENT_LIMIT_FIELDS, type BuiltLeaf, type LeafSource, type OrgEvent } from './leaf';
import { instantOf, instantSql } from './time';

/** 서열기·에폭 마감이 함께 잡는 advisory lock 키('tlog'). */
export const TLOG_ADVISORY_LOCK = 0x746c6f67;

export const SEQUENCER_BATCH_SIZE = 200;
export const SEQUENCER_MAX_BATCHES = 25;

export interface SequencerDependencies {
  readonly db: Pool;
  readonly now: () => Date;
  readonly batchSize?: number;
  readonly maxBatches?: number;
}

export interface SequencerCounts {
  readonly processed: number;
  readonly logsCreated: number;
  readonly missingSources: number;
}

interface OutboxRow {
  id: string;
  source_table: TlogSourceTable;
  source_id: string;
  event: 'insert' | 'update';
  rev: number;
  organization_id: string;
  /** audit_logs: 변경 가능한 4칸 · agents: 이름·상태·정지 주체·바뀐 칸(202609242200). 그때 값이다 — 서열 시점의 행이 아니다. */
  snapshot: {
    decision?: string;
    resolved_at?: string | null;
    resolution_reason?: string | null;
    approved_by?: string | null;
    name?: string;
    status?: string;
    suspended_by?: string | null;
    changed?: string[];
    /** org_entitlements(202609250300) — 요금제 코드 · 원인 · 버전 · 한도 칸 · 유예 끝 · 행의 updated_at(= 잎의 at). */
    plan_code?: string;
    cause?: string;
    version?: number;
    grace_until?: string | null;
    at?: string;
    /** custom_domains(202609291130, ADR-0014) — 상태 · 정지 사유 · 수신 MX 판정 · 행의 updated_at(= 잎의 at). `status`·`at` 은 위 칸을 같이 쓴다. */
    suspended_reason?: string | null;
    inbound_mx_status?: string;
    [limit: string]: unknown;
  } | null;
  enqueued: string;
}

interface LogState {
  readonly log: Buffer;
  readonly saltKey: Buffer;
  next: number;
}

async function ensureLogs(client: PoolClient, organizations: readonly string[], now: Date): Promise<{ states: Map<string, LogState>; created: number }> {
  const states = new Map<string, LogState>();
  let created = 0;
  const found = await client.query<{ organization_id: string; org_log_id: Buffer; salt_key: Buffer | null; next: string }>(
    `SELECT l.organization_id, l.org_log_id, k.salt_key,
            (SELECT coalesce(max(seq), -1) + 1 FROM tlog_leaves t WHERE t.org_log_id = l.org_log_id)::text AS next
       FROM tlog_logs l JOIN tlog_salt_keys k ON k.org_log_id = l.org_log_id
      WHERE l.organization_id = ANY ($1::uuid[])`,
    [organizations],
  );
  for (const row of found.rows) {
    if (row.salt_key === null) continue;
    states.set(row.organization_id, { log: row.org_log_id, saltKey: row.salt_key, next: Number(row.next) });
  }
  for (const organization of organizations) {
    if (states.has(organization) || found.rows.some((row) => row.organization_id === organization)) continue;
    const log = randomBytes(ORG_LOG_ID_BYTES);
    const saltKey = randomBytes(SALT_KEY_BYTES);
    const at = instantOf(now);
    await client.query('INSERT INTO tlog_logs (org_log_id, organization_id, created_at) VALUES ($1, $2, $3)', [log, organization, at]);
    await client.query('INSERT INTO tlog_salt_keys (org_log_id, salt_key) VALUES ($1, $2)', [log, saltKey]);
    const genesis = buildOrgLeaf({ log: log.toString('hex'), seq: 0, saltKey }, { kind: 'org.genesis', at });
    await client.query(
      `INSERT INTO tlog_leaves (org_log_id, seq, kind, leaf_json, leaf_hash) VALUES ($1, 0, 'org.genesis', $2, $3)`,
      [log, genesis.json, genesis.hash],
    );
    states.set(organization, { log, saltKey, next: 1 });
    created += 1;
  }
  return { states, created };
}

/**
 * outbox 의 원천 테이블을 이 코드가 모른다 — **스키마가 코드보다 새롭다**(새 원천을 넓히는 마이그레이션이 새 서열기보다 먼저 배포됐다, 런북
 * deploy §19). `TypeError` 가 아니다: 서열기의 `unrepresentable` 분기가 잡지 않아 배치 트랜잭션이 통째로 되돌아가고 다음 틱이 다시 시도한다.
 * 모르는 원천을 `source.missing(unrepresentable)` 로 커밋하면 되돌릴 수 없는 "원천 없음" 사실이 로그에 영원히 남는다(적대적 검증 M1).
 */
export class UnknownSourceTableError extends Error {
  readonly sourceTable: string;

  constructor(sourceTable: string) {
    super(`tlog sequencer: unknown source_table ${JSON.stringify(sourceTable).slice(0, 80)} (code older than schema) — 배치를 되돌리고 다음 틱에 다시 시도한다`);
    this.name = 'UnknownSourceTableError';
    this.sourceTable = sourceTable;
  }
}

/** outbox 한 행 → 사건. 원천 행이 없으면 `source.missing`. 모르는 원천 테이블은 `UnknownSourceTableError`(되돌리고 재시도). */
async function eventOf(client: PoolClient, row: OutboxRow): Promise<OrgEvent> {
  const src: LeafSource = { t: row.source_table, id: row.source_id, e: row.event, r: row.rev };
  const missing: OrgEvent = { kind: 'source.missing', src, at: row.enqueued, reason: 'not_found' };
  switch (row.source_table) {
    case 'audit_logs': {
      const snapshot = row.snapshot ?? {};
      const decision = snapshot.decision ?? '';
      const resolvedAt = snapshot.resolved_at ?? null;
      const resolutionReason = snapshot.resolution_reason ?? null;
      const approvedBy = snapshot.approved_by ?? null;
      if (row.event === 'update') {
        const exists = await client.query('SELECT 1 FROM audit_logs WHERE id = $1::uuid', [row.source_id]);
        if (exists.rowCount === 0) return missing;
        return { kind: 'audit.updated', src, at: row.enqueued, auditId: row.source_id, decision, resolutionReason, resolvedAt, approvedBy };
      }
      const result = await client.query<{
        agent_id: string;
        message_id: string | null;
        reasons: string[];
        policy_version: number | null;
        approval_id: string | null;
        at: string;
        rfc822_id: string | null;
        recipients: string[] | null;
      }>(
        `SELECT a.agent_id, a.message_id, a.reasons, a.policy_version, a.approval_id, ${instantSql('a.evaluated_at')} AS at,
                m.message_id_header AS rfc822_id,
                (SELECT array_agg(r.address ORDER BY r.address) FROM outbound_recipients r WHERE r.message_id = a.message_id) AS recipients
           FROM audit_logs a LEFT JOIN messages m ON m.id = a.message_id
          WHERE a.id = $1::uuid`,
        [row.source_id],
      );
      const audit = result.rows[0];
      if (audit === undefined) return missing;
      return {
        kind: 'audit.evaluated',
        src,
        at: audit.at,
        auditId: row.source_id,
        agentId: audit.agent_id,
        decision,
        reasons: audit.reasons,
        policyVersion: audit.policy_version,
        approvalId: audit.approval_id,
        messageId: audit.message_id,
        resolutionReason,
        resolvedAt,
        approvedBy,
        recipients: audit.message_id === null ? null : (audit.recipients ?? []),
        rfc822Id: audit.rfc822_id,
      };
    }
    case 'owner_actions': {
      // 행위자 셋(202609250160 · 202610131610) — 세션 · 조직 API 키 · 운영자/시스템. 잎은 c.session | c.api_key | c.operator(ADR-0008 추가 절).
      const result = await client.query<{
        session_id: string | null;
        org_api_key_id: string | null;
        operator_actor: string | null;
        operator_reason: string | null;
        action: string;
        target_id: string | null;
        at: string;
      }>(
        `SELECT session_id, org_api_key_id, operator_actor, operator_reason, action, target_id, ${instantSql('created_at')} AS at FROM owner_actions WHERE id = $1::uuid`,
        [row.source_id],
      );
      const action = result.rows[0];
      if (action === undefined) return missing;
      return {
        kind: 'owner.action',
        src,
        at: action.at,
        action: action.action,
        targetId: action.target_id,
        sessionId: action.session_id,
        orgApiKeyId: action.org_api_key_id,
        operatorActor: action.operator_actor,
        operatorReason: action.operator_reason,
      };
    }
    case 'policy_versions': {
      const result = await client.query<{ agent_id: string; version: number; outbound_mode: string; inbound_mode: string | null; snapshot: unknown; at: string }>(
        `SELECT agent_id, version, outbound_mode::text AS outbound_mode, inbound_mode::text AS inbound_mode, snapshot,
                ${instantSql('created_at')} AS at
           FROM policy_versions WHERE id = $1::uuid`,
        [row.source_id],
      );
      const version = result.rows[0];
      if (version === undefined) return missing;
      return {
        kind: 'policy.version',
        src,
        at: version.at,
        agentId: version.agent_id,
        version: version.version,
        outboundMode: version.outbound_mode,
        inboundMode: version.inbound_mode,
        snapshot: version.snapshot,
      };
    }
    case 'inbound_messages': {
      const result = await client.query<{
        agent_id: string;
        quarantined: boolean;
        quarantine_reason: string | null;
        policy_reason: string | null;
        from_authenticated: boolean;
        from_address: string;
        message_id_header: string | null;
        at: string;
      }>(
        `SELECT agent_id, quarantined, quarantine_reason, policy_reason, from_authenticated, from_address, message_id_header,
                ${instantSql('received_at')} AS at
           FROM inbound_messages WHERE id = $1::uuid`,
        [row.source_id],
      );
      const inbound = result.rows[0];
      if (inbound === undefined) return missing;
      return {
        kind: 'inbound.verdict',
        src,
        at: inbound.at,
        agentId: inbound.agent_id,
        quarantined: inbound.quarantined,
        quarantineReason: inbound.quarantine_reason,
        policyReason: inbound.policy_reason,
        fromAuthenticated: inbound.from_authenticated,
        fromAddress: inbound.from_address,
        rfc822Id: inbound.message_id_header,
      };
    }
    case 'agents': {
      // 그때 값은 스냅샷에 있다(두 번 바뀐 행의 중간 상태를 잃지 않게). 행은 있는지와 생성 시각만 본다.
      const result = await client.query<{ at: string }>(`SELECT ${instantSql('created_at')} AS at FROM agents WHERE id = $1`, [row.source_id]);
      const agent = result.rows[0];
      if (agent === undefined) return missing;
      const snapshot = row.snapshot ?? {};
      const state = { agentId: row.source_id, name: snapshot.name ?? '', status: snapshot.status ?? '', suspendedBy: snapshot.suspended_by ?? null };
      if (row.event === 'insert') return { kind: 'identity.agent_created', src, at: agent.at, ...state };
      return { kind: 'identity.agent_updated', src, at: row.enqueued, ...state, changed: snapshot.changed ?? [] };
    }
    case 'agent_addresses': {
      if (row.event === 'update') {
        // tlog v4(202609270115) — 별칭 폐기. 폐기 칸은 쓰기 1회라 서열 시점의 행이 그때 값이다. 행이 없거나 폐기 시각이 없으면(트리거를 끄고 되돌렸다)
        // 사건을 옮길 수 없다 — 없음은 not_found, 시각 없음은 빈 at(모양 아님 → unrepresentable).
        const retired = await client.query<{ agent_id: string; address: string; at: string | null }>(
          `SELECT agent_id, address, ${instantSql('retired_at')} AS at FROM agent_addresses WHERE id = $1::uuid`,
          [row.source_id],
        );
        const address = retired.rows[0];
        if (address === undefined) return missing;
        return { kind: 'identity.address_retired', src, at: address.at ?? '', agentId: address.agent_id, address: address.address };
      }
      const result = await client.query<{ agent_id: string; address: string; is_primary: boolean; at: string }>(
        `SELECT agent_id, address, is_primary, ${instantSql('created_at')} AS at FROM agent_addresses WHERE id = $1::uuid`,
        [row.source_id],
      );
      const address = result.rows[0];
      if (address === undefined) return missing;
      return { kind: 'identity.address_assigned', src, at: address.at, agentId: address.agent_id, address: address.address, primary: address.is_primary };
    }
    case 'agent_primary_changes': {
      // 대표 주소 선택(ADR-0014 개정 — 포인터 모델). append-only 라 서열 시점의 행이 그때 값이다. 표·GRANT 는 M3a 마이그레이션 — 그 전에는 outbox
      // 원천 CHECK 가 이 원천을 막아 여기 오지 않는다.
      const result = await client.query<{ agent_id: string; address: string; cause: string; at: string }>(
        `SELECT agent_id, address, cause, ${instantSql('created_at')} AS at FROM agent_primary_changes WHERE id = $1::uuid`,
        [row.source_id],
      );
      const change = result.rows[0];
      if (change === undefined) return missing;
      return { kind: 'identity.primary_set', src, at: change.at, agentId: change.agent_id, cause: change.cause, address: change.address };
    }
    case 'agent_keypairs': {
      const result = await client.query<{ public_key: string; algorithm: string; at: string }>(
        `SELECT public_key, algorithm::text AS algorithm, ${instantSql('created_at')} AS at FROM agent_keypairs WHERE agent_id = $1`,
        [row.source_id],
      );
      const keypair = result.rows[0];
      if (keypair === undefined) return missing;
      return { kind: 'identity.key_bound', src, at: keypair.at, agentId: row.source_id, algorithm: keypair.algorithm, publicKey: keypair.public_key };
    }
    case 'passport_documents': {
      const result = await client.query<{ agent_id: string; version: number; status: string; content_hash: string | null; at: string }>(
        `SELECT p.agent_id, p.version, p.status::text AS status, p.content_hash, ${instantSql('d.created_at')} AS at
           FROM passport_documents d JOIN passports p ON p.id = d.passport_id
          WHERE d.passport_id = $1::uuid`,
        [row.source_id],
      );
      const passport = result.rows[0];
      if (passport === undefined) return missing;
      return {
        kind: 'identity.passport_version',
        src,
        at: passport.at,
        agentId: passport.agent_id,
        version: passport.version,
        status: passport.status,
        // 문서가 붙은 버전은 해시가 있다(passport_documents_match 트리거) — 없으면 잎 모양이 아니다(unrepresentable).
        contentHash: passport.content_hash ?? '',
      };
    }
    case 'org_entitlements': {
      // 그때 값은 스냅샷에 있다(두 번 바뀐 행의 중간 버전을 잃지 않게). 행은 있는지만 본다 — 서열 롤은 organization_id 칸만 읽는다.
      const exists = await client.query('SELECT 1 FROM org_entitlements WHERE organization_id = $1::uuid', [row.source_id]);
      if (exists.rowCount === 0) return missing;
      const snapshot = row.snapshot ?? {};
      const limits: Record<string, number> = {};
      // 스냅샷에 **있는 키만** 옮긴다 — v4 전 9칸 스냅샷은 9칸 잎, v4 스냅샷은 11칸 잎(빌더가 늦은 두 칸을 "둘 다 있거나 둘 다 없음" 으로 받는다).
      for (const field of [...ENTITLEMENT_LIMIT_FIELDS, ...ENTITLEMENT_LATE_LIMIT_FIELDS]) {
        const value = snapshot[field];
        if (typeof value === 'number') limits[field] = value;
      }
      return {
        kind: 'billing.entitlement',
        src,
        at: typeof snapshot.at === 'string' ? snapshot.at : row.enqueued,
        planCode: snapshot.plan_code ?? '',
        cause: snapshot.cause ?? '',
        version: typeof snapshot.version === 'number' ? snapshot.version : -1,
        limits,
        graceUntil: snapshot.grace_until ?? null,
      };
    }
    case 'custom_domains': {
      // 고객 도메인(202609291130, ADR-0014) — 그때 값은 스냅샷에 있다(두 번 바뀐 행의 중간 상태를 잃지 않게). 도메인 이름은 불변 칸이라 서열 시점의
      // 행에서 읽는다(서열 롤은 id · domain 두 칸만 읽는다). 행이 없으면 not_found.
      const found = await client.query<{ domain: string }>('SELECT domain FROM custom_domains WHERE id = $1::uuid', [row.source_id]);
      const domainRow = found.rows[0];
      if (domainRow === undefined) return missing;
      const snapshot = row.snapshot ?? {};
      return {
        kind: 'domain.status',
        src,
        at: typeof snapshot.at === 'string' ? snapshot.at : row.enqueued,
        domainId: row.source_id,
        status: snapshot.status ?? '',
        reason: snapshot.suspended_reason ?? null,
        inbound: snapshot.inbound_mx_status ?? '',
        domain: domainRow.domain,
      };
    }
    default: {
      const unknownTable: never = row.source_table;
      throw new UnknownSourceTableError(String(unknownTable));
    }
  }
}

async function drainBatch(client: PoolClient, batchSize: number, clock: () => Date): Promise<SequencerCounts & { readonly selected: number }> {
  await client.query('SELECT pg_advisory_xact_lock($1)', [TLOG_ADVISORY_LOCK]);
  // 시각은 잠금 **뒤에** 잡는다 — 창세 잎의 `at` 이 잠금을 먼저 잡은 에폭 마감보다 앞서지 않게(검증기 L1: 첫 헤드 직전 에폭은 창세 전에 닫혔다).
  const now = clock();
  const pending = await client.query<OutboxRow>(
    `SELECT o.id::text AS id, o.source_table, o.source_id, o.event, o.rev, o.organization_id, o.snapshot, ${instantSql('o.enqueued_at')} AS enqueued
       FROM tlog_outbox o
      WHERE o.processed_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM tlog_logs l JOIN tlog_salt_keys k ON k.org_log_id = l.org_log_id
                         WHERE l.organization_id = o.organization_id AND k.salt_key IS NULL)
      ORDER BY o.id
      LIMIT $1`,
    [batchSize],
  );
  if (pending.rows.length === 0) return { selected: 0, processed: 0, logsCreated: 0, missingSources: 0 };
  const { states, created } = await ensureLogs(client, [...new Set(pending.rows.map((row) => row.organization_id))], now);
  let processed = 0;
  let missingSources = 0;
  for (const row of pending.rows) {
    const state = states.get(row.organization_id);
    if (state === undefined) continue;
    const context = { log: state.log.toString('hex'), seq: state.next, saltKey: state.saltKey };
    const event = await eventOf(client, row);
    let leaf: BuiltLeaf;
    try {
      leaf = buildOrgLeaf(context, event);
    } catch (error) {
      // 원천 행 하나를 잎 모양으로 옮길 수 없다(무한대 시각 · JSON 이 아닌 수 등) — 그 행 하나가 전 조직의 로그를 멈추게 두지 않는다.
      // 조용히 건너뛰지도 않는다: `source.missing(unrepresentable)` 잎으로 그 사실을 커밋한다(소유자 검증기가 오류로 보고한다).
      if (!(error instanceof TypeError || error instanceof JcsInputError)) throw error;
      leaf = buildOrgLeaf(context, { kind: 'source.missing', src: { t: row.source_table, id: row.source_id, e: row.event, r: row.rev }, at: row.enqueued, reason: 'unrepresentable' });
    }
    if (leaf.kind === 'source.missing') missingSources += 1;
    await client.query(
      `INSERT INTO tlog_leaves (org_log_id, seq, kind, source_table, source_id, event, rev, outbox_id, leaf_json, leaf_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [state.log, state.next, leaf.kind, row.source_table, row.source_id, row.event, row.rev, row.id, leaf.json, leaf.hash],
    );
    await client.query('UPDATE tlog_outbox SET processed_at = clock_timestamp(), snapshot = NULL WHERE id = $1', [row.id]);
    state.next += 1;
    processed += 1;
  }
  return { selected: pending.rows.length, processed, logsCreated: created, missingSources };
}

/**
 * 이 서열기가 잎으로 옮길 수 있는 것(202610131610 `tlog_capabilities` · 적대 검토 M-1). 틱의 첫 배치가 정의자로 적는다 — DB 는 운영자 행위자
 * `owner_actions` 행을 이 능력이 적힌 뒤에만 받는다(옛 서열기는 그 행을 되돌릴 수 없는 `source.missing(unrepresentable)` 로 만든다).
 */
export const TLOG_SEQUENCER_CAPABILITIES = ['owner_action_operator_actor'] as const;

/** outbox 를 비운다(배치마다 한 트랜잭션). 한 틱의 상한 = batchSize × maxBatches. */
export async function drainOutbox(deps: SequencerDependencies): Promise<SequencerCounts> {
  const batchSize = deps.batchSize ?? SEQUENCER_BATCH_SIZE;
  const maxBatches = deps.maxBatches ?? SEQUENCER_MAX_BATCHES;
  let processed = 0;
  let logsCreated = 0;
  let missingSources = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const result = await withTransaction(deps.db, async (client) => {
      if (batch === 0) await client.query('SELECT atmark_tlog_record_capabilities($1::text[])', [[...TLOG_SEQUENCER_CAPABILITIES]]);
      return drainBatch(client, batchSize, deps.now);
    });
    processed += result.processed;
    logsCreated += result.logsCreated;
    missingSources += result.missingSources;
    if (result.selected < batchSize) break;
  }
  return { processed, logsCreated, missingSources };
}
