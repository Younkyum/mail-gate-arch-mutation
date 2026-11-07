/**
 * 적대적 검증(감시 탭 A) 공용 지반 — 실제 Postgres 위 수신 소비자 · 콘솔 라우터 · 에이전트 읽기 핸들러.
 * 이 파일은 테스트가 아니다(시험 파일이 가져다 쓴다). 운영 소스는 건드리지 않는다.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import { expect } from 'vitest';

import type { ApiRequest } from '../../../src/api/http';
import type { AttachmentRouteDependencies } from '../../../src/api/inbound-view';
import { createPostgresAgentTokenStore } from '../../../src/db/repositories';
import { createPostgresExposureRecorder } from '../../../src/db/repositories/exposure-store';
import { createPostgresInboundReadStore } from '../../../src/db/repositories/inbound-read-store';
import { createPostgresMessageStateStore } from '../../../src/db/repositories/message-state-store';
import { createPostgresPdfParseSlots } from '../../../src/db/repositories/pdf-parse-slots';
import type { AgentId } from '../../../src/db/schema';
import { issueAgentToken } from '../../../src/identity/agent-token';
import type { InjectionScanInput, InjectionScanResult } from '../../../src/security/injection/scanner';
import { createInboundArtifactReader, createInboundAttachmentReader } from '../../../src/storage/inbound-artifact-store';
import { createLocalDownloadSigner, createLocalObjectStore } from '../../../src/storage/local-object-store';
import type { ObjectStore } from '../../../src/storage/object-store';
import { TEST_DLP_KEYRING } from '../../support/injection-doubles';
import { DATABASE_AVAILABLE, provisioningPool, seedFixture, testPool, type Fixture } from '../db/support/harness';
import { consumerDeps, deliver, eml, newObjectStore, newSesMessageId, type EmlOptions } from '../inbound/support';

export const OWNER_AVAILABLE = DATABASE_AVAILABLE && (process.env['TEST_MIGRATION_DATABASE_URL'] ?? '').trim() !== '';

export type Family = readonly [family: string, damped: boolean];
export const RISKY: readonly Family[] = [['narrative', false], ['ai_addressee', false]];
export const INJECTION: readonly Family[] = [['override', false], ['exfiltration', false]];

/** 결정론 스캐너 — 판정을 고정한다. */
export function fakeScanner(risk: InjectionScanResult['injectionRisk'], families: readonly Family[], quarantine = risk === 'medium' || risk === 'high') {
  const calls: InjectionScanInput[] = [];
  const scan = (input: InjectionScanInput): InjectionScanResult => {
    calls.push(input);
    return {
      injectionRisk: risk,
      scannerVersion: 'adv-watch-1',
      quarantine,
      findings: families.map(([family, damped], index) => ({
        ruleId: `adv.${family}`,
        family,
        field: 'text',
        view: 'raw',
        fieldIndex: 0,
        start: index,
        end: index + 1,
        weight: 1,
        damped,
      })),
    } as unknown as InjectionScanResult;
  };
  return { scan, calls };
}

export function throwingScanner(): (input: InjectionScanInput) => InjectionScanResult {
  return () => {
    throw new Error('scanner down');
  };
}

export interface MsgRow {
  id: string;
  thread_id: string;
  agent_id: string;
  quarantined: boolean;
  quarantine_reason: string | null;
  watch_level: string | null;
  trusted_bypass: boolean;
  injection_risk: string | null;
  released_at: Date | null;
  released_from: string | null;
  from_address: string;
  from_authenticated: boolean;
  findings: number;
}

export async function rowFor(agentId: string, sesMessageId: string): Promise<MsgRow | null> {
  const result = await provisioningPool().query<MsgRow>(
    `SELECT m.id, m.thread_id, m.agent_id, m.quarantined, m.quarantine_reason, m.watch_level, m.trusted_bypass, m.injection_risk,
            m.released_at, m.released_from, m.from_address, m.from_authenticated,
            (SELECT count(*)::int FROM security_findings s WHERE s.inbound_message_id = m.id) AS findings
       FROM inbound_messages m WHERE m.agent_id = $1 AND m.ses_message_id = $2`,
    [agentId, sesMessageId],
  );
  return result.rows[0] ?? null;
}

export async function setAgent(f: { organizationId: string; agentId: string }, handling: 'deliver' | 'hold' | null, notify: boolean | null): Promise<void> {
  // 위험 보류 풀기(hold → deliver)는 owner 멤버십의 사용자만(202610081103 — 묶음 D 적대 검증 후속). 조직의 owner 를 행위자로 쓴다(없으면 임의 id — 조이기만 된다).
  const owner = await provisioningPool().query<{ user_id: string }>(
    `SELECT user_id FROM memberships WHERE organization_id = $1 AND role = 'owner' AND removed_at IS NULL ORDER BY created_at LIMIT 1`,
    [f.organizationId],
  );
  const userId = owner.rows[0]?.user_id;
  if (userId === undefined) {
    // 시드 조직에는 멤버십이 없다 — 소유자 롤로 설정 행을 바로 적는다(이 도우미의 시험은 소비자 동작이지 권한이 아니다).
    await provisioningPool().query(
      `INSERT INTO agent_watch_settings (agent_id, risk_handling, risk_notify) VALUES ($1, coalesce($2, 'deliver'), coalesce($3, true))
       ON CONFLICT (agent_id) DO UPDATE SET risk_handling = coalesce($2, agent_watch_settings.risk_handling), risk_notify = coalesce($3, agent_watch_settings.risk_notify), updated_at = now()`,
      [f.agentId, handling, notify],
    );
    return;
  }
  await provisioningPool().query('SELECT * FROM atmark_watch_set_agent($1, $2, $3, $4, $5)', [f.organizationId, f.agentId, handling, notify, userId]);
}

export async function trust(f: { organizationId: string }, entries: readonly (readonly ['address' | 'domain', string])[]): Promise<void> {
  await provisioningPool().query('SELECT * FROM atmark_watch_set_trusted_senders($1, $2::text[], $3::text[], $4)', [
    f.organizationId,
    entries.map(([kind]) => kind),
    entries.map(([, value]) => value),
    randomUUID(),
  ]);
}

export async function withWebhook(f: { agentId: string }, eventTypes: string[] | null = null): Promise<string> {
  const result = await provisioningPool().query<{ id: string }>(
    `INSERT INTO webhook_endpoints (agent_id, url, secret_kid, event_types) VALUES ($1, $2, 'k1', $3::webhook_event_type[]) RETURNING id`,
    [f.agentId, `https://hook-${randomUUID()}.example.com/`, eventTypes],
  );
  return result.rows[0]?.id ?? '';
}

export async function webhookCount(inboundMessageId: string): Promise<number> {
  const result = await provisioningPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM webhook_deliveries WHERE dedupe_key = $1`, [
    `message.received:${inboundMessageId}`,
  ]);
  return result.rows[0]?.n ?? 0;
}

export interface ReceiveOptions {
  /** 헤더 From 줄 전체(표시 이름 포함). */
  from?: string;
  /** SES 가 DMARC 를 판정한 From(기본: 헤더 From 의 맨 주소 하나). */
  commonFrom?: readonly string[];
  dmarc?: string;
  spf?: string;
  dkim?: string;
  source?: string;
  extraHeaders?: readonly string[];
  subject?: string;
  text?: string;
  html?: string;
  attachment?: NonNullable<EmlOptions['attachment']>;
  recipients?: readonly string[];
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  receivedAt?: string;
}

/** `options` 에서 값이 있는 키만(exactOptionalPropertyTypes — `undefined` 를 넘기지 않게). */
function present<K extends keyof ReceiveOptions>(options: ReceiveOptions, keys: readonly K[]): Pick<ReceiveOptions, K> {
  return Object.fromEntries(keys.filter((key) => options[key] !== undefined).map((key) => [key, options[key]])) as Pick<ReceiveOptions, K>;
}

export function bareAddress(from: string): string {
  const angle = /<([^<>]*)>/.exec(from);
  return (angle?.[1] ?? from).trim();
}

/** 한 통 받는다. 결말과 첫 수신자 행(없으면 null)을 돌려준다. */
export async function receiveMail(
  f: { agentId: string; address: string },
  scanner: (input: InjectionScanInput) => InjectionScanResult,
  options: ReceiveOptions = {},
): Promise<{ ses: string; outcome: string; row: MsgRow | null }> {
  const from = options.from ?? `sender-${randomUUID().slice(0, 6)}@partner.example`;
  const ses = newSesMessageId();
  const deps = { ...consumerDeps(testPool(), newObjectStore()), scanner };
  const outcome = await deliver(
    deps,
    eml({
      from,
      subject: options.subject ?? 'hello',
      text: options.text ?? 'body text',
      ...present(options, ['html', 'attachment', 'extraHeaders', 'messageId', 'inReplyTo', 'references']),
    }),
    {
      sesMessageId: ses,
      recipients: options.recipients ?? [f.address],
      commonFrom: options.commonFrom ?? [bareAddress(from)],
      dmarc: options.dmarc ?? 'PASS',
      ...present(options, ['spf', 'dkim', 'source']),
    },
  );
  return { ses, outcome, row: await rowFor(f.agentId, ses) };
}

/** 우회가 서면 안 되는 결과: 행이 없거나(거부), 우회 표지 없이 숨었다. */
export function expectNotBypassed(result: { row: MsgRow | null }, label = ''): void {
  const row = result.row;
  if (row === null) return;
  expect(row.trusted_bypass, `${label} trusted_bypass`).toBe(false);
  expect(row.quarantined, `${label} quarantined`).toBe(true);
}

// ---------------------------------------------------------------------------
// 에이전트 읽기 표면
// ---------------------------------------------------------------------------

export interface World {
  readonly fixture: Fixture;
  readonly token: string;
  readonly directory: string;
  readonly deps: AttachmentRouteDependencies;
}

export async function tokenFor(agentId: AgentId, capabilities?: Parameters<typeof issueAgentToken>[1]): Promise<string> {
  const issued = issueAgentToken(agentId, capabilities);
  await createPostgresAgentTokenStore(provisioningPool()).insert({ agentId, tokenHash: issued.tokenHash, capabilities: issued.capabilities, expiresAt: null });
  return issued.plaintext;
}

export async function worldOf(fixture: Fixture): Promise<World> {
  const pool = testPool();
  const directory = mkdtempSync(join(tmpdir(), 'atmark-adv-'));
  const objects: ObjectStore = createLocalObjectStore({ directory, env: {} });
  return {
    fixture,
    token: await tokenFor(fixture.agentId),
    directory,
    deps: {
      tokens: createPostgresAgentTokenStore(pool),
      inbound: createPostgresInboundReadStore(pool),
      artifacts: createInboundArtifactReader(objects),
      signer: createLocalDownloadSigner({ directory, env: {} }),
      contents: createInboundAttachmentReader(objects),
      pdfSlots: createPostgresPdfParseSlots(pool),
      now: () => new Date(),
      exposures: createPostgresExposureRecorder(pool, { keyring: TEST_DLP_KEYRING }),
      riskHoldMode: 'enforce' as const,
      messageState: createPostgresMessageStateStore(pool),
    },
  };
}

/** 이 world 의 저장소(`directory`)를 쓰는 소비자로 한 통 받는다 — 읽기 표면이 같은 객체 저장소에서 본문을 읽게. */
export async function receiveInto(
  w: World,
  scanner: (input: InjectionScanInput) => InjectionScanResult,
  options: ReceiveOptions = {},
): Promise<{ ses: string; outcome: string; row: MsgRow }> {
  const from = options.from ?? 'noreply@service.example';
  const ses = newSesMessageId();
  const objects = createLocalObjectStore({ directory: w.directory, env: {} });
  const deps = { ...consumerDeps(testPool(), objects), scanner };
  const outcome = await deliver(
    deps,
    eml({
      from,
      subject: options.subject ?? 'Your verification code',
      text: options.text ?? 'Your verification code is 482913. Do not share it.',
      ...present(options, ['html', 'extraHeaders', 'inReplyTo', 'references']),
      attachment: options.attachment ?? { filename: 'a.txt', contentType: 'text/plain', bytes: new TextEncoder().encode('attachment text') },
    }),
    {
      sesMessageId: ses,
      recipients: options.recipients ?? [w.fixture.address],
      commonFrom: options.commonFrom ?? [bareAddress(from)],
      dmarc: options.dmarc ?? 'PASS',
      ...present(options, ['receivedAt']),
    },
  );
  const row = await rowFor(w.fixture.agentId, ses);
  if (row === null) throw new Error(`행이 없다 (${outcome})`);
  return { ses, outcome, row };
}

export function get(token: string, query: Record<string, string> = {}): ApiRequest {
  return { headers: { authorization: `Bearer ${token}` }, query, body: null };
}

export async function exposureLevels(agentId: string, inboundMessageId: string): Promise<{ part: string; level: number }[]> {
  const result = await provisioningPool().query<{ part: string; level: number }>(
    'SELECT part, level FROM agent_exposures WHERE agent_id = $1 AND inbound_message_id = $2 ORDER BY part',
    [agentId, inboundMessageId],
  );
  return result.rows;
}

export type { Pool };
export { seedFixture, testPool, provisioningPool, newObjectStore };

/**
 * 이미 있는 수신 행을 복제해 일부 칸만 바꿔 INSERT 한다(소유자 롤) — DB CHECK · 트리거가 위험한 조합을 막는지 시험한다.
 * 칸 목록은 information_schema 에서 읽는다(생성 칸 · id 제외). `overrides` 의 값은 SQL 조각(리터럴 포함)이다.
 */
export async function cloneInbound(sourceId: string, overrides: Record<string, string>): Promise<void> {
  const db = provisioningPool();
  const cols = await db.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'inbound_messages' AND is_generated = 'NEVER' AND column_name <> 'id'
      ORDER BY ordinal_position`,
  );
  const names = cols.rows.map((c) => c.column_name);
  const ses = `adv-${randomUUID()}`;
  const values = names.map((name) => {
    if (name in overrides) return overrides[name] as string;
    if (name === 'ses_message_id') return `'${ses}'`;
    if (name === 'raw_storage_key') return `'inbound/raw/${ses}'`;
    if (name === 'parsed_storage_key') return `'inbound/parsed/${ses}.json'`;
    if (name === 'message_id_header') return 'NULL';
    return `m.${name}`;
  });
  await db.query(`INSERT INTO inbound_messages (${names.join(', ')}) SELECT ${values.join(', ')} FROM inbound_messages m WHERE m.id = $1`, [sourceId]);
}
