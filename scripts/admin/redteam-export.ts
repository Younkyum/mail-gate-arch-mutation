#!/usr/bin/env tsx
/**
 * scripts/admin/redteam-export.ts — **한국어 레드팀 수신 메일 내보내기**(읽기 전용, 2026-10-09).
 *
 *   pnpm admin:redteam-export [--since <ISO>] [--agent <id>] [--out <디렉터리>] [--dry-run] [--include-benign-label] [--bucket <메일 버킷>] [--yes]
 *   pnpm admin:redteam-export --hash-sender <주소>     # 삭제 요청 — 그 주소의 해시(로컬 소금). DB · S3 를 부르지 않는다.
 *
 * 신뢰하는 한국 디자인 파트너가 `redteam@atmark.ai`(수신 전용 에이전트)로 보낸 **사람이 쓴 공격 메일**을 로컬 JSONL 데이터셋으로 뽑는다.
 * 격리 · 보류 · 풀린 메일까지 **전부**(에이전트 컨텍스트 저장소 `inbound-read-store.ts` 를 쓰지 않는 이유 — 그 저장소는 격리 행을 행째 내지 않는다).
 *
 * **허용 목록 밖의 에이전트는 거부한다**(`REDTEAM_EXPORT_AGENTS` — 레드팀 에이전트 하나). 이 CLI 는 고객 메일함을 향할 수 없다:
 *   ① 인자 검사에서(접속 전에) 허용 목록 밖이면 exit 2 ② SQL 이 같은 id **그리고** 운영 조직(Chronostasis)을 한 번 더 건다
 *   ③ arch 테스트(`test/arch/redteam-export-allowlist.arch.test.ts`)가 목록 · 순서 · 읽기 전용을 지킨다.
 *
 * **읽기 전용이다.** 소유자 롤(`common.ts` — 관리 CLI 공통)로 붙되 한 트랜잭션을 `READ ONLY` 로 열어 쓰기가 DB 에서 거부된다. 운영이면 내보내기 전에
 * `yes` 확인(`--yes` 로 건너뛴다) — 운영 메일 본문이 이 노트북 디스크로 옮겨 가는 일이라서. `--dry-run` 은 개수만 세고 본문을 읽지 않는다.
 *
 * **출력 규율.** 표준 출력은 데이터셋 경로 한 줄, 표준 오류는 개수뿐 — 제목 · 본문 · 주소를 찍지 않는다. 보낸 사람은 **소금 친 SHA-256**
 * (`.omc/spikes/redteam-ko/salt`, 없으면 0600 으로 만든다)과 도메인만 남는다. 파일은 0600, 디렉터리는 0700. 기본 출력 위치
 * `.omc/spikes/redteam-ko/` 는 리포 밖 데이터 자리다 — 리포 안의 다른 곳(추적될 수 있는 곳)은 거부한다.
 *
 * 본문은 저장된 파싱 결과(S3 `inbound/parsed/<ses id>.json`)를 수신 파생물 리더(`createInboundArtifactReader` — 접두사 검사)로 읽는다.
 * 운영은 `--bucket`(또는 `ATMARK_MAIL_BUCKET` — AtmarkStorage 출력 `MailStoreBucketName`)과 `AWS_PROFILE=atmark` 가 필요하다.
 *
 * 한 줄 = 메일 한 통: 받은 때의 스캐너 판정(위험도 · 계열 · 등급 · 룰 버전) · **지금 룰로 다시 돌린 판정** · AI 감시 판정(있으면) · 라벨
 * (기본 1 = 공격, `--include-benign-label` 이면 제목이 `[정상]`/`[benign]` 으로 시작하는 대조 메일은 0). 평가는 `scripts/redteam-eval.ts`.
 * 삭제를 요청한 보낸 사람(해시 목록 `.omc/spikes/redteam-ko/deleted-senders`)의 메일은 건너뛴다.
 */

import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';

import type { PoolClient } from 'pg';

import { decodeParsedDocument } from '../../src/api/inbound-view';
import type { RuleFamily } from '../../src/security/injection/rule-types';
import { INJECTION_SCANNER_VERSION, scanForInjection, type InjectionRisk, type ParserC1Removal } from '../../src/security/injection/scanner';
import { classifyInboundLevel, type InboundLevel, type QuarantineReason, type ReleasedFrom } from '../../src/security/levels';
import { createInboundArtifactReader, type InboundArtifactReader } from '../../src/storage/inbound-artifact-store';
import { createLocalObjectStore } from '../../src/storage/local-object-store';
import { createS3Client, createS3ObjectReader } from '../../src/storage/s3-object-store';
import { AdminInputError, confirmProduction, EXIT_OK, isMain, runAdminMain, withAdminConnection, type AdminDeps } from './common';

/** 레드팀 수신 전용 에이전트 `redteam@atmark.ai`(Chronostasis, 발신 none · 수신 all). */
export const REDTEAM_AGENT_ID = 'd7770ab13168aa288d5eb1f69a4571d7';
/** 운영 조직 Chronostasis — SQL 이 에이전트 소속을 한 번 더 건다. */
export const REDTEAM_ORGANIZATION_ID = 'f37fa0fd-231f-4cfe-8540-067eee3e7538';
/**
 * **내보낼 수 있는 에이전트의 전부.** 고객 메일함은 여기에 들어오지 않는다 — 늘리려면 이 줄과 arch 테스트를 함께 고치고 리뷰를 받는다.
 */
export const REDTEAM_EXPORT_AGENTS: readonly string[] = Object.freeze([REDTEAM_AGENT_ID]);

/** 메일 버킷 소유 계정(`infra/cdk/app.ts` 의 ACCOUNT). */
export const MAIL_BUCKET_OWNER = '123456789012';
export const MAIL_BUCKET_ENV = 'ATMARK_MAIL_BUCKET';

/** 기본 출력 · 소금 자리(리포 루트 기준 — 리포 루트에서 실행한다). */
export const DEFAULT_OUT_DIR = join('.omc', 'spikes', 'redteam-ko');
export const SALT_FILE = 'salt';
/** 삭제 요청한 보낸 사람의 해시 목록(한 줄에 하나, `#` 주석). 내보내기가 이 사람들의 메일을 건너뛴다 — 런북 admin.md §10. */
export const DELETED_SENDERS_FILE = 'deleted-senders';
/** 데이터셋 줄 모양의 버전 — 평가 스크립트가 확인한다. */
export const ROW_SCHEMA = 'atmark-redteam-ko/1';

/** 대조(정상) 메일 표지 — 제목 맨 앞. */
const BENIGN_PREFIX = /^\s*\[(?:정상|benign)\]/i;
/** 파트너 안내서의 범주 표지(`docs/redteam/ko-guide.md`). */
export const REDTEAM_CATEGORIES = ['유출', '전달', '서술형', '역할극', '숨김', '인코딩', '기타', '정상'] as const;

const USAGE =
  'pnpm admin:redteam-export --hash-sender <주소> | [--since <ISO>] [--agent <id>] [--out <디렉터리>] [--dry-run] [--include-benign-label] [--bucket <메일 버킷>] [--yes]';

// ---------------------------------------------------------------------------
// 순수 부분 — 단위 테스트가 직접 부른다
// ---------------------------------------------------------------------------

/** 허용 목록 밖이면 거부(접속 전에 부른다). */
export function assertExportAllowed(agentId: string): void {
  if (!REDTEAM_EXPORT_AGENTS.includes(agentId)) {
    throw new AdminInputError(
      `이 CLI 는 레드팀 에이전트(${REDTEAM_EXPORT_AGENTS.join(', ')})만 내보낸다 — ${/^[0-9a-f]{32}$/.test(agentId) ? agentId : '(형식이 아닌 값)'} 는 허용 목록 밖이다. ` +
        '고객 메일함은 이 도구로 내보내지 않는다.',
      'agent_not_allowed',
    );
  }
}

/** 보낸 사람 → 소금 친 SHA-256(hex). 주소는 소문자 · 공백 제거 뒤. 원문 주소는 데이터셋에 남지 않는다. */
export function hashSender(salt: string, address: string): string {
  if (salt.length < 16) throw new Error('소금이 너무 짧다');
  return createHash('sha256').update(`atmark-redteam-sender-v1\0${salt}\0${address.trim().toLowerCase()}`, 'utf8').digest('hex');
}

/** 라벨 — 기본 1(공격). `includeBenign` 이면 제목이 `[정상]`/`[benign]` 으로 시작하는 메일은 0. */
export function labelFor(subject: string | null, includeBenign: boolean): 0 | 1 {
  return includeBenign && subject !== null && BENIGN_PREFIX.test(subject) ? 0 : 1;
}

/** 제목의 `[범주]` 표지(안내서의 것만, 나온 순서 · 중복 없음). */
export function categoryTags(subject: string | null): string[] {
  if (subject === null) return [];
  const out: string[] = [];
  for (const match of subject.matchAll(/\[([^\]\n]{1,12})\]/g)) {
    const raw = (match[1] ?? '').trim();
    const tag = /^benign$/i.test(raw) ? '정상' : raw;
    if ((REDTEAM_CATEGORIES as readonly string[]).includes(tag) && !out.includes(tag)) out.push(tag);
  }
  return out;
}

/**
 * 출력 디렉터리 검사 — 리포(현재 디렉터리) 안이면 `.omc/spikes/` 아래만 허용한다. 데이터셋이 추적되는 자리에 떨어져 커밋되지 않게.
 */
export function resolveOutDir(out: string | undefined, cwd: string): string {
  const dir = resolve(cwd, out ?? DEFAULT_OUT_DIR);
  const rel = relative(cwd, dir);
  const insideRepo = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  if (insideRepo && !`${rel.split(sep).join('/')}/`.startsWith('.omc/spikes/')) {
    throw new AdminInputError(`--out 이 리포 안의 추적될 수 있는 자리다(${rel || '.'}) — .omc/spikes/ 아래나 리포 밖을 쓴다.`);
  }
  return dir;
}

/** 삭제 요청 목록을 읽는다. 없으면 빈 집합. */
export function readDeletedSenders(path: string): Set<string> {
  if (!existsSync(path)) return new Set();
  const hashes = readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter((line) => line !== '');
  for (const hash of hashes) if (!/^[0-9a-f]{64}$/.test(hash)) throw new AdminInputError(`${path} 에 해시가 아닌 줄이 있다.`);
  return new Set(hashes);
}

/** 소금 파일을 읽는다. 없으면 32바이트 난수(hex)로 만든다(0600). */
export function ensureSalt(path: string): string {
  if (existsSync(path)) {
    const salt = readFileSync(path, 'utf8').trim();
    if (salt.length < 16) throw new AdminInputError(`소금 파일이 비었거나 너무 짧다: ${path}`);
    return salt;
  }
  const salt = randomBytes(32).toString('hex');
  writeFileSync(path, `${salt}\n`, { mode: 0o600, flag: 'wx' });
  chmodSync(path, 0o600);
  return salt;
}

export interface FindingFact {
  readonly ruleId: string;
  readonly family: RuleFamily;
  readonly damped: boolean;
}

/** DB 에서 읽은 한 통(본문 제외). */
export interface ExportMessageFacts {
  readonly id: string;
  readonly receivedAt: Date;
  readonly fromAddress: string;
  readonly fromDomain: string;
  readonly dmarc: string;
  readonly subject: string | null;
  readonly quarantined: boolean;
  readonly quarantineReason: QuarantineReason | null;
  readonly releasedFrom: ReleasedFrom | null;
  readonly injectionRisk: InjectionRisk | null;
  readonly scannerVersion: string | null;
  readonly trustedBypass: boolean;
  readonly findings: readonly FindingFact[];
  readonly attachmentNames: readonly (string | null)[];
  readonly aiWatch: {
    readonly state: string;
    readonly verdict: string | null;
    readonly band: string | null;
    readonly modelVersion: string | null;
    readonly shadow: boolean;
  } | null;
}

/** 파싱 결과에서 쓰는 부분. `null` = 본문을 읽지 못했다(`bodyError`). */
export interface ExportBody {
  readonly subject: string | null;
  readonly text: string;
  readonly htmlText: string | null;
  readonly hiddenText: string | null;
  readonly c1Removed: readonly ParserC1Removal[];
  readonly attachmentNames: readonly (string | null)[];
}

export interface RedteamRow {
  readonly schema: typeof ROW_SCHEMA;
  readonly message_id: string;
  readonly received_at: string;
  readonly sender_hash: string;
  readonly sender_domain: string;
  readonly dmarc: string;
  readonly subject: string | null;
  readonly text: string | null;
  readonly html_text: string | null;
  /** HTML 에서 숨긴 글 · 파서가 지운 C1 흔적 — 평가가 받을 때와 같은 입력으로 다시 돌리게. */
  readonly hidden_text: string | null;
  readonly c1_removed: readonly ParserC1Removal[];
  readonly attachment_names: readonly (string | null)[];
  readonly label: 0 | 1;
  readonly categories: readonly string[];
  readonly body_error: 'not_found' | 'unreadable' | null;
  readonly receipt: {
    readonly injection_risk: InjectionRisk | null;
    readonly quarantined: boolean;
    readonly quarantine_reason: QuarantineReason | null;
    readonly released_from: ReleasedFrom | null;
    readonly level: InboundLevel;
    readonly families: readonly RuleFamily[];
    readonly rule_ids: readonly string[];
    readonly ruleset_version: string | null;
  };
  readonly rescan: {
    readonly injection_risk: InjectionRisk;
    readonly level: InboundLevel;
    readonly families: readonly RuleFamily[];
    readonly rule_ids: readonly string[];
    readonly ruleset_version: string;
  } | null;
  readonly ai_watch: {
    readonly state: string;
    readonly verdict: string | null;
    readonly band: string | null;
    readonly model_version: string | null;
    readonly shadow: boolean;
  } | null;
}

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort();
}

/** 지금 룰로 다시 돌린 판정. 받을 때와 같은 입력 모양(제목 · 본문 · HTML · 첨부 파일명 · 숨긴 글 · C1 흔적). */
export function rescan(body: ExportBody): NonNullable<RedteamRow['rescan']> {
  const result = scanForInjection({
    subject: body.subject,
    text: body.text,
    htmlText: body.htmlText,
    attachmentNames: body.attachmentNames,
    hiddenText: body.hiddenText,
    c1Removed: body.c1Removed,
  });
  const level = classifyInboundLevel({
    quarantined: result.quarantine,
    quarantineReason: result.quarantine ? 'injection_risk' : null,
    injectionRisk: result.injectionRisk,
    findings: result.findings,
    trustedBypass: false,
  });
  return {
    injection_risk: result.injectionRisk,
    level: level.level,
    families: uniqueSorted(result.findings.map((f) => f.family)),
    rule_ids: uniqueSorted(result.findings.map((f) => f.ruleId)),
    ruleset_version: result.scannerVersion,
  };
}

/** 한 통 → 데이터셋 한 줄. `body` 가 없으면 본문 칸은 비우고 다시 돌리지 않는다. */
export function shapeRow(
  facts: ExportMessageFacts,
  body: ExportBody | null,
  options: { readonly salt: string; readonly includeBenignLabel: boolean; readonly bodyError?: 'not_found' | 'unreadable' },
): RedteamRow {
  const subject = body?.subject ?? facts.subject;
  const receipt = classifyInboundLevel({
    quarantined: facts.quarantined,
    quarantineReason: facts.quarantineReason,
    injectionRisk: facts.injectionRisk,
    findings: facts.findings,
    trustedBypass: facts.trustedBypass,
    releasedFrom: facts.releasedFrom,
  });
  return {
    schema: ROW_SCHEMA,
    message_id: facts.id,
    received_at: facts.receivedAt.toISOString(),
    sender_hash: hashSender(options.salt, facts.fromAddress),
    sender_domain: facts.fromDomain,
    dmarc: facts.dmarc,
    subject,
    text: body?.text ?? null,
    html_text: body?.htmlText ?? null,
    hidden_text: body?.hiddenText ?? null,
    c1_removed: body?.c1Removed ?? [],
    attachment_names: body?.attachmentNames ?? facts.attachmentNames,
    label: labelFor(subject, options.includeBenignLabel),
    categories: categoryTags(subject),
    body_error: body === null ? (options.bodyError ?? 'unreadable') : null,
    receipt: {
      injection_risk: facts.injectionRisk,
      quarantined: facts.quarantined,
      quarantine_reason: facts.quarantineReason,
      released_from: facts.releasedFrom,
      level: receipt.level,
      families: uniqueSorted(facts.findings.filter((f) => !f.damped).map((f) => f.family)),
      rule_ids: uniqueSorted(facts.findings.map((f) => f.ruleId)),
      ruleset_version: facts.scannerVersion,
    },
    rescan: body === null ? null : rescan(body),
    ai_watch:
      facts.aiWatch === null
        ? null
        : {
            state: facts.aiWatch.state,
            verdict: facts.aiWatch.verdict,
            band: facts.aiWatch.band,
            model_version: facts.aiWatch.modelVersion,
            shadow: facts.aiWatch.shadow,
          },
  };
}

/** 파싱 결과 문서 바이트 → 쓰는 부분. 기본 칸은 API 와 같은 해석기(`decodeParsedDocument`), 숨긴 글 · C1 · 첨부 이름은 있으면 쓴다. */
export function bodyOf(bytes: Uint8Array): ExportBody {
  const base = decodeParsedDocument(bytes);
  const message = (JSON.parse(new TextDecoder('utf-8').decode(bytes)) as { message?: Record<string, unknown> }).message ?? {};
  const hidden = message['hiddenText'];
  const c1 = message['c1Removed'];
  const attachments = message['attachments'];
  return {
    subject: base.subject,
    text: base.text,
    htmlText: base.htmlText,
    hiddenText: typeof hidden === 'string' ? hidden : null,
    c1Removed: Array.isArray(c1) ? (c1 as ParserC1Removal[]) : [],
    attachmentNames: Array.isArray(attachments)
      ? attachments.map((a) => {
          const name = (a as { filename?: unknown } | null)?.filename;
          return typeof name === 'string' ? name : null;
        })
      : [],
  };
}

// ---------------------------------------------------------------------------
// DB — 한 트랜잭션, READ ONLY
// ---------------------------------------------------------------------------

interface MessageRow {
  id: string;
  received_at: Date;
  from_address: string;
  from_domain: string;
  dmarc_verdict: string;
  subject: string | null;
  parsed_storage_key: string;
  quarantined: boolean;
  quarantine_reason: QuarantineReason | null;
  released_from: ReleasedFrom | null;
  injection_risk: InjectionRisk | null;
  scanner_version: string | null;
  trusted_bypass: boolean;
  findings: string[];
  attachment_names: (string | null)[];
  ai_state: string | null;
  ai_verdict: string | null;
  ai_band: string | null;
  ai_model_version: string | null;
  ai_shadow: boolean | null;
}

/** 레드팀 에이전트의 수신 전부(격리 · 보류 · 풀림 포함). 에이전트 id **와** 운영 조직을 함께 건다. */
const EXPORT_SQL = `SELECT m.id, m.received_at, m.from_address, m.from_domain, m.dmarc_verdict::text AS dmarc_verdict, m.subject, m.parsed_storage_key,
       m.quarantined, m.quarantine_reason, m.released_from, m.injection_risk, m.scanner_version, m.trusted_bypass,
       coalesce((SELECT array_agg(f.rule_id || '|' || f.family || '|' || CASE WHEN f.damped THEN '1' ELSE '0' END ORDER BY f.ordinal)
                   FROM security_findings f
                  WHERE f.inbound_message_id = m.id AND f.scanner_version = m.scanner_version), '{}') AS findings,
       coalesce((SELECT array_agg(x.filename ORDER BY x.part_index) FROM inbound_attachments x WHERE x.inbound_message_id = m.id), '{}') AS attachment_names,
       j.state AS ai_state, j.verdict AS ai_verdict, j.band AS ai_band, j.model_version AS ai_model_version, j.shadow AS ai_shadow
  FROM inbound_messages m
  JOIN agents a ON a.id = m.agent_id AND a.organization_id = $2::uuid
  LEFT JOIN ai_watch_jobs j ON j.job_id = m.ai_watch_job_id
 WHERE m.agent_id = $1::bpchar
   AND ($3::timestamptz IS NULL OR m.received_at >= $3::timestamptz)
 ORDER BY m.received_at, m.id`;

function findingOf(raw: string): FindingFact {
  const [ruleId = '', family = '', damped = '0'] = raw.split('|');
  return { ruleId, family: family as RuleFamily, damped: damped === '1' };
}

function factsOf(row: MessageRow): ExportMessageFacts {
  return {
    id: row.id,
    receivedAt: row.received_at,
    fromAddress: row.from_address,
    fromDomain: row.from_domain,
    dmarc: row.dmarc_verdict,
    subject: row.subject,
    quarantined: row.quarantined,
    quarantineReason: row.quarantine_reason,
    releasedFrom: row.released_from,
    injectionRisk: row.injection_risk,
    scannerVersion: row.scanner_version,
    trustedBypass: row.trusted_bypass,
    findings: row.findings.map(findingOf),
    attachmentNames: row.attachment_names,
    aiWatch:
      row.ai_state === null
        ? null
        : { state: row.ai_state, verdict: row.ai_verdict, band: row.ai_band, modelVersion: row.ai_model_version, shadow: row.ai_shadow === true },
  };
}

async function readOnly<T>(client: PoolClient, run: () => Promise<T>): Promise<T> {
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const result = await run();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 진입점
// ---------------------------------------------------------------------------

export interface RedteamExportOptions {
  /** 테스트가 가짜 리더를 준다. 없으면 운영 = S3, 로컬 = 개발 저장소. */
  readonly artifacts?: InboundArtifactReader;
  readonly cwd?: string;
  readonly now?: () => Date;
}

export async function redteamExport(argv: readonly string[], deps: AdminDeps, options: RedteamExportOptions = {}): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      since: { type: 'string' },
      agent: { type: 'string' },
      out: { type: 'string' },
      bucket: { type: 'string' },
      'hash-sender': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'include-benign-label': { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  if (values.help) {
    deps.io.out(USAGE);
    return EXIT_OK;
  }
  if (positionals.length > 0) throw new AdminInputError(USAGE);
  const cwd = options.cwd ?? process.cwd();

  // 삭제 요청 처리용 — 주소 하나의 해시(로컬 소금). DB · S3 를 부르지 않는다.
  if (values['hash-sender'] !== undefined) {
    const saltPath = join(resolve(cwd, DEFAULT_OUT_DIR), SALT_FILE);
    if (!existsSync(saltPath)) throw new AdminInputError(`소금 파일이 없다(${saltPath}) — 내보낸 적이 없으면 지울 데이터셋도 없다.`);
    deps.io.out(hashSender(ensureSalt(saltPath), values['hash-sender']));
    return EXIT_OK;
  }

  // ① 허용 목록 — 접속 전에.
  const agentId = (values.agent ?? REDTEAM_AGENT_ID).trim().toLowerCase();
  assertExportAllowed(agentId);

  let since: Date | null = null;
  if (values.since !== undefined) {
    since = new Date(values.since);
    if (Number.isNaN(since.getTime())) throw new AdminInputError('--since 는 ISO 시각(예: 2026-10-09 또는 2026-10-09T00:00:00+09:00).');
  }
  const outDir = resolveOutDir(values.out, cwd);
  const dryRun = values['dry-run'];
  const includeBenign = values['include-benign-label'];

  return withAdminConnection(deps, async ({ pool, target }) => {
    if (!dryRun) {
      await confirmProduction(target, `읽기 전용 — 레드팀 에이전트 수신 메일을 로컬 파일로 내보낸다(${outDir})`, values.yes, deps.io);
    }
    const client = await pool.connect();
    let rows: MessageRow[];
    try {
      rows = await readOnly(client, async () => (await client.query<MessageRow>(EXPORT_SQL, [agentId, REDTEAM_ORGANIZATION_ID, since])).rows);
    } finally {
      client.release();
    }

    const quarantined = rows.filter((r) => r.quarantined).length;
    const released = rows.filter((r) => r.released_from !== null).length;
    deps.io.err(`수신 ${String(rows.length)}통 · 격리/보류 ${String(quarantined)} · 풀림 ${String(released)}${since === null ? '' : ` (since ${since.toISOString()})`}`);
    if (dryRun) {
      deps.io.err('--dry-run — 본문을 읽지 않았고 아무것도 쓰지 않았다.');
      return EXIT_OK;
    }

    const artifacts = options.artifacts ?? artifactReaderFor(target.target, values.bucket, deps.env);
    mkdirSync(outDir, { recursive: true, mode: 0o700 });
    const saltDir = resolve(cwd, DEFAULT_OUT_DIR);
    mkdirSync(saltDir, { recursive: true, mode: 0o700 });
    const salt = ensureSalt(join(saltDir, SALT_FILE));
    const deleted = readDeletedSenders(join(saltDir, DELETED_SENDERS_FILE));

    const lines: string[] = [];
    let bodyErrors = 0;
    let benign = 0;
    let skipped = 0;
    for (const row of rows) {
      const facts = factsOf(row);
      if (deleted.has(hashSender(salt, facts.fromAddress))) {
        skipped += 1;
        continue;
      }
      let body: ExportBody | null = null;
      let bodyError: 'not_found' | 'unreadable' | undefined;
      try {
        body = bodyOf(await artifacts.readParsed(row.parsed_storage_key));
      } catch (error) {
        bodyError = error instanceof Error && error.name === 'ObjectNotFoundError' ? 'not_found' : 'unreadable';
        bodyErrors += 1;
      }
      const shaped = shapeRow(facts, body, { salt, includeBenignLabel: includeBenign, ...(bodyError === undefined ? {} : { bodyError }) });
      if (shaped.label === 0) benign += 1;
      lines.push(JSON.stringify(shaped));
    }

    const stamp = (options.now?.() ?? new Date()).toISOString().replace(/[:.]/g, '-');
    const file = join(outDir, `redteam-${stamp}.jsonl`);
    writeFileSync(file, lines.length === 0 ? '' : `${lines.join('\n')}\n`, { mode: 0o600, flag: 'wx' });
    deps.io.err(
      `${String(lines.length)}줄 · 라벨 0(대조) ${String(benign)} · 본문 못 읽음 ${String(bodyErrors)} · 삭제 요청으로 뺌 ${String(skipped)} · 지금 룰 ${INJECTION_SCANNER_VERSION}. 본문은 화면에 찍지 않았다.`,
    );
    deps.io.out(file);
    return EXIT_OK;
  });
}

function artifactReaderFor(target: 'local' | 'production', bucketFlag: string | undefined, env: NodeJS.ProcessEnv): InboundArtifactReader {
  if (target === 'local' && bucketFlag === undefined) return createInboundArtifactReader(createLocalObjectStore());
  const bucket = (bucketFlag ?? env[MAIL_BUCKET_ENV] ?? '').trim();
  if (bucket === '') {
    throw new AdminInputError(`메일 버킷이 없다 — --bucket 또는 ${MAIL_BUCKET_ENV}(AtmarkStorage 출력 MailStoreBucketName).`);
  }
  const region = env['AWS_REGION']?.trim() || 'ap-northeast-2';
  const reader = createS3ObjectReader({ client: createS3Client(region), bucket, expectedBucketOwner: MAIL_BUCKET_OWNER, prefix: 'inbound/parsed/' });
  return createInboundArtifactReader({ kind: 's3', get: reader.get, putIfAbsent: () => Promise.reject(new Error('읽기 전용')) });
}

if (isMain(import.meta.url)) await runAdminMain((argv, deps) => redteamExport(argv, deps));
