/**
 * src/tlog/anchor.ts — **Phase B 외부 앵커 워커**(ADR-0008 §2.7 · Q3 OTS + Rekor · Q4 하루 1회). 롤 `atmark_tlog_anchor`.
 *
 * 틱 하나(매시):
 *   1. **예약** — 마지막 앵커 예약이 24시간 전보다 오래됐으면 가장 최근 **게시된** 에폭의 체크포인트를 캘린더마다 · Rekor 에 하나씩
 *      `pending` 으로 예약한다. digest = SHA-256(체크포인트 전문)(DB 트리거가 다시 계산해 대조).
 *   2. **제출** — 기한이 된 `pending` 을 보낸다. OTS: 캘린더 응답(대기 증명)을 **다시 계산해 본다**(우리 다이제스트에서 시작 · 증명으로
 *      끝남) → `submitted`. Rekor: 다이제스트에 앵커 키(KMS P-256)로 서명한 `hashedrekord` → 응답의 **Rekor 체크포인트를 고정한 샤드 키로
 *      열고**(설정 `ATMARK_TLOG_REKOR_VKEY` — 응답이 스스로 내민 키가 아니다) 그 루트·크기로 포함 증명을 RFC 9162 검증 · 본문에 우리
 *      다이제스트·서명이 있는지 → `confirmed`. 샤드 키가 설정되지 않았으면 Rekor 를 예약하지 않는다(자기 참조 "확인" 을 만들지 않는다).
 *      실패는 지수 백오프(5분 → 최대 6시간) · 8번이면 `failed`.
 *   3. **업그레이드** — `submitted` OTS 의 대기 증명마다 그 증명이 가리키는 캘린더에 commitment 를 묻는다 — 단 캘린더 URI 가 허용 모양
 *      (`anchor-http.ts` `OTS_UPGRADE_HOST_SHAPE`, ots 클라이언트의 기본 화이트리스트와 같은 범위)일 때만(요청 위조 방지).
 *      Bitcoin 증명이 붙으면 **`bitcoin_claimed`** — 캘린더가 "이 블록에 들어갔다" 고 **주장**한 상태다. 블록 헤더와 대조한 적이 없으므로
 *      `confirmed` 라 부르지 않는다(외부 HTTP 를 캘린더 말고 늘리지 않는다 — 블록 헤더 대조는 소유자의 `ots verify`, 런북 §5).
 *      아직이면 1시간 뒤 다시(24시간 넘게 대기면 런북 알람).
 *   틱은 **시간 예산**을 지킨다 — 남은 실행 시간이 행 하나의 최악(HTTP 시간 제한 × 호출 수)보다 적으면 멈추고 다음 틱에 넘긴다(L8).
 *   4. 영수증은 DB(원본) + 공개 버킷 `log/anchors/…`(`.ots` 파일 · Rekor 응답)에 둔다 — Rekor 샤드가 퇴역해도 증명은 우리가 보관한다.
 */

import { createHash } from 'node:crypto';

import type { Pool } from 'pg';

import { ANCHOR_HTTP_TIMEOUT_MS, AnchorHttpError, anchorEndpoint, type OtsCalendarClient, type RekorClient } from './anchor-http';
import { openCheckpoint, type VerifierKey } from './checkpoint';
import { ANCHOR_INTERVAL_MS } from './constants';
import { leafHash, verifyInclusion } from './merkle';
import { attestationsOf, detachedOts, mergeAt, OtsFormatError, parseTimestamp, serializeTimestamp, type OtsTimestamp } from './ots';
import { IMMUTABLE_CACHE_CONTROL, TILE_CONTENT_TYPE, type TlogObjectWriter } from './publisher';
import type { AnchorSigner } from './signing';

export const ANCHOR_MAX_ATTEMPTS = 8;
export const ANCHOR_BACKOFF_BASE_MS = 5 * 60 * 1000;
export const ANCHOR_BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;
export const OTS_UPGRADE_INTERVAL_MS = 60 * 60 * 1000;
/** 예약 판정의 여유 — 매시 틱이 24시간 경계를 몇 분 차이로 놓쳐 하루를 건너뛰지 않게. */
const SCHEDULE_SLACK_MS = 10 * 60 * 1000;
/**
 * 행 하나의 최악 시간 — OTS 업그레이드는 대기 증명(캘린더)마다 한 번 묻는다(보통 3곳) + 여유. 남은 실행 시간이 이보다 적으면 틱을 멈춘다
 * (Lambda 시간 제한에 걸려 반쯤 쓴 상태로 죽지 않게 — 멈춘 행은 다음 틱이 이어 간다).
 */
export const ANCHOR_ROW_BUDGET_MS = 4 * ANCHOR_HTTP_TIMEOUT_MS + 10_000;

export interface AnchorDependencies {
  readonly db: Pool;
  readonly ots: OtsCalendarClient;
  readonly rekor: RekorClient;
  readonly signer: AnchorSigner;
  readonly writer: TlogObjectWriter;
  /** OTS 캘린더(2곳 이상). */
  readonly calendars: readonly string[];
  /** Rekor v2 샤드. `null` 이면 Rekor 앵커를 예약하지 않는다(설정 전). */
  readonly rekorUrl: string | null;
  /** 그 샤드의 체크포인트 키(고정 — 설정). `null` 이면 Rekor 응답을 확인할 수 없으므로 Rekor 를 예약하지 않는다. */
  readonly rekorKey: VerifierKey | null;
  readonly now: () => Date;
  /** 남은 실행 시간(ms) — Lambda `getRemainingTimeInMillis`. 없으면 제한 없음(테스트). */
  readonly remainingMs?: () => number;
}

export function backoffMs(attempt: number): number {
  return Math.min(ANCHOR_BACKOFF_MAX_MS, ANCHOR_BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
}

function errorCode(error: unknown): string {
  if (error instanceof AnchorHttpError || error instanceof OtsFormatError) return error.message.slice(0, 120);
  if (error instanceof Error && /^[a-z0-9_:.-]{1,120}$/.test(error.message)) return error.message;
  return 'anchor_error';
}

async function ensureAnchorKey(deps: AnchorDependencies): Promise<Buffer> {
  const spki = await deps.signer.publicKeySpki();
  const keyId = `ecdsa-p256:${createHash('sha256').update(spki).digest('hex')}`;
  await deps.db.query(`INSERT INTO tlog_keys (key_id, purpose, public_key) VALUES ($1, 'anchor', $2) ON CONFLICT (key_id) DO NOTHING`, [keyId, spki]);
  return spki;
}

async function schedule(deps: AnchorDependencies): Promise<number> {
  const now = deps.now();
  const last = (await deps.db.query<{ created_at: Date | null }>('SELECT max(created_at) AS created_at FROM tlog_anchors')).rows[0]?.created_at ?? null;
  if (last !== null && now.getTime() - last.getTime() < ANCHOR_INTERVAL_MS - SCHEDULE_SLACK_MS) return 0;
  const latest = (
    await deps.db.query<{ epoch: string; checkpoint: string }>(
      'SELECT epoch, checkpoint FROM tlog_epochs WHERE published_at IS NOT NULL ORDER BY epoch DESC LIMIT 1',
    )
  ).rows[0];
  if (latest === undefined) return 0;
  const digest = createHash('sha256').update(latest.checkpoint, 'utf8').digest();
  const targets: { target: 'opentimestamps' | 'rekor'; endpoint: string }[] = [
    ...deps.calendars.map((calendar) => ({ target: 'opentimestamps' as const, endpoint: anchorEndpoint(calendar, 'opentimestamps') })),
    ...(deps.rekorUrl === null || deps.rekorKey === null ? [] : [{ target: 'rekor' as const, endpoint: anchorEndpoint(deps.rekorUrl, 'rekor') }]),
  ];
  let created = 0;
  for (const { target, endpoint } of targets) {
    const inserted = await deps.db.query(
      `INSERT INTO tlog_anchors (epoch, target, endpoint, digest) VALUES ($1, $2, $3, $4) ON CONFLICT (epoch, target, endpoint) DO NOTHING`,
      [latest.epoch, target, endpoint, digest],
    );
    created += inserted.rowCount ?? 0;
  }
  return created;
}

interface AnchorRow {
  id: string;
  epoch: string;
  target: 'opentimestamps' | 'rekor';
  endpoint: string;
  digest: Buffer;
  state: string;
  attempt_count: number;
  receipt: Buffer | null;
}

const hostOf = (endpoint: string): string => new URL(endpoint).hostname;

/**
 * Rekor 응답(TransparencyLogEntry, proto JSON)을 검증한다 — ① 본문에 우리 다이제스트·서명 ② `inclusionProof.checkpoint.envelope`(signed note)를
 * **고정한 샤드 키**로 열고 ③ 그 체크포인트의 크기·루트 = 증명의 `treeSize`·`rootHash` ④ 포함 증명(RFC 9162). 응답 안의 루트만 믿으면
 * 응답이 스스로를 확인하는 셈이다 — 샤드 키가 루트를 서명했을 때만 "Sigstore 에 기록됐다" 고 적는다.
 */
export function checkRekorResponse(response: unknown, digestB64: string, signatureB64: string, rekorKey: VerifierKey): void {
  const entry = response as {
    canonicalizedBody?: unknown;
    inclusionProof?: { logIndex?: unknown; treeSize?: unknown; rootHash?: unknown; hashes?: unknown; checkpoint?: { envelope?: unknown } };
  };
  if (typeof entry !== 'object' || entry === null || typeof entry.canonicalizedBody !== 'string') throw new Error('rekor_response_shape');
  const body = Buffer.from(entry.canonicalizedBody, 'base64');
  const text = body.toString('utf8');
  if (!text.includes(digestB64) || !text.includes(signatureB64)) throw new Error('rekor_entry_body_mismatch');
  const proof = entry.inclusionProof;
  if (proof === undefined || !Array.isArray(proof.hashes) || typeof proof.rootHash !== 'string') throw new Error('rekor_inclusion_proof_missing');
  const envelope = proof.checkpoint?.envelope;
  if (typeof envelope !== 'string') throw new Error('rekor_checkpoint_missing');
  let checkpoint: { readonly size: number; readonly root: Buffer };
  try {
    checkpoint = openCheckpoint(envelope, rekorKey, rekorKey.name);
  } catch {
    throw new Error('rekor_checkpoint_signature_invalid');
  }
  const root = Buffer.from(proof.rootHash, 'base64');
  const size = Number(proof.treeSize);
  if (!Number.isSafeInteger(size) || checkpoint.size !== size || !checkpoint.root.equals(root)) throw new Error('rekor_checkpoint_mismatch');
  const ok = verifyInclusion(
    Number(proof.logIndex),
    size,
    leafHash(body),
    (proof.hashes as unknown[]).map((hash) => Buffer.from(String(hash), 'base64')),
    checkpoint.root,
  );
  if (!ok) throw new Error('rekor_inclusion_proof_invalid');
}

async function submit(deps: AnchorDependencies, row: AnchorRow, spki: Buffer): Promise<'submitted' | 'confirmed'> {
  const epoch = Number(row.epoch);
  if (row.target === 'opentimestamps') {
    const bytes = await deps.ots.submit(row.endpoint, row.digest);
    const stamp = parseTimestamp(bytes, row.digest);
    if (!attestationsOf(stamp).some((found) => found.attestation.kind === 'pending' || found.attestation.kind === 'bitcoin')) {
      throw new OtsFormatError('ots_no_attestation');
    }
    await deps.writer.put(`anchors/ots/${String(epoch)}/${hostOf(row.endpoint)}.ots`, detachedOts(row.digest, stamp), TILE_CONTENT_TYPE, IMMUTABLE_CACHE_CONTROL);
    await deps.db.query(
      `UPDATE tlog_anchors SET state = 'submitted', receipt = $2, receipt_at = now(), attempt_count = attempt_count + 1, last_error = NULL,
              next_attempt_at = $3 WHERE id = $1`,
      [row.id, bytes, new Date(deps.now().getTime() + OTS_UPGRADE_INTERVAL_MS)],
    );
    return 'submitted';
  }
  const signature = await deps.signer.signDigest(row.digest);
  const digestB64 = row.digest.toString('base64');
  const signatureB64 = signature.toString('base64');
  const requestBody = {
    hashedRekordRequestV002: {
      digest: digestB64,
      signature: {
        content: signatureB64,
        verifier: { publicKey: { rawBytes: spki.toString('base64') }, keyDetails: 'PKIX_ECDSA_P256_SHA_256' },
      },
    },
  };
  if (deps.rekorKey === null) throw new Error('rekor_key_not_configured');
  const response = await deps.rekor.submit(row.endpoint, requestBody);
  checkRekorResponse(response, digestB64, signatureB64, deps.rekorKey);
  const receipt = Buffer.from(JSON.stringify({ request: requestBody, response }), 'utf8');
  await deps.writer.put(`anchors/rekor/${String(epoch)}.json`, receipt, 'application/json', IMMUTABLE_CACHE_CONTROL);
  await deps.db.query(
    `UPDATE tlog_anchors SET state = 'confirmed', receipt = $2, receipt_at = now(), confirmed_at = now(), attempt_count = attempt_count + 1,
            last_error = NULL WHERE id = $1`,
    [row.id, receipt],
  );
  return 'confirmed';
}

async function upgrade(deps: AnchorDependencies, row: AnchorRow): Promise<boolean> {
  const stamp: OtsTimestamp = parseTimestamp(row.receipt ?? Buffer.alloc(0), row.digest);
  for (const found of attestationsOf(stamp)) {
    if (found.attestation.kind !== 'pending') continue;
    const bytes = await deps.ots.upgrade(found.attestation.uri, found.msg);
    if (bytes === null) continue;
    mergeAt(stamp, found.msg, parseTimestamp(bytes, found.msg));
  }
  if (!attestationsOf(stamp).some((found) => found.attestation.kind === 'bitcoin')) {
    await deps.db.query(`UPDATE tlog_anchors SET attempt_count = attempt_count + 1, next_attempt_at = $2 WHERE id = $1`, [
      row.id,
      new Date(deps.now().getTime() + OTS_UPGRADE_INTERVAL_MS),
    ]);
    return false;
  }
  const upgraded = serializeTimestamp(stamp);
  await deps.writer.put(
    `anchors/ots/${row.epoch}/${hostOf(row.endpoint)}.ots`,
    detachedOts(row.digest, stamp),
    TILE_CONTENT_TYPE,
    IMMUTABLE_CACHE_CONTROL,
  );
  // 캘린더가 Bitcoin 증명을 붙였다 = **주장**. 블록 헤더와 대조하지 않았으므로 confirmed 가 아니다(머리말 3).
  await deps.db.query(`UPDATE tlog_anchors SET state = 'bitcoin_claimed', upgraded = $2, last_error = NULL WHERE id = $1`, [row.id, upgraded]);
  return true;
}

export interface AnchorCounts {
  readonly scheduled: number;
  readonly submitted: number;
  /** Rekor — 고정한 샤드 키로 확인한 기록. */
  readonly confirmed: number;
  /** OTS — 캘린더가 Bitcoin 증명을 붙였다(블록 헤더 대조 전). */
  readonly bitcoinClaimed: number;
  readonly retried: number;
  readonly failed: number;
  /** 시간 예산 때문에 다음 틱으로 넘긴 행. */
  readonly deferred: number;
}

export async function runAnchorTick(deps: AnchorDependencies): Promise<AnchorCounts> {
  const spki = await ensureAnchorKey(deps);
  const scheduled = await schedule(deps);
  const due = (
    await deps.db.query<AnchorRow>(
      `SELECT a.id, a.epoch, a.target, a.endpoint, a.digest, a.state, a.attempt_count, a.receipt
         FROM tlog_anchors a
        WHERE a.state IN ('pending', 'submitted') AND a.next_attempt_at <= $1
        ORDER BY a.next_attempt_at, a.id LIMIT 25`,
      [deps.now()],
    )
  ).rows;
  let submitted = 0;
  let confirmed = 0;
  let bitcoinClaimed = 0;
  let retried = 0;
  let failed = 0;
  let deferred = 0;
  for (const [index, row] of due.entries()) {
    if (deps.remainingMs !== undefined && deps.remainingMs() < ANCHOR_ROW_BUDGET_MS) {
      deferred = due.length - index;
      break;
    }
    try {
      if (row.state === 'pending') {
        const outcome = await submit(deps, row, spki);
        if (outcome === 'submitted') submitted += 1;
        else confirmed += 1;
      } else if (row.target === 'opentimestamps' && (await upgrade(deps, row))) {
        bitcoinClaimed += 1;
      }
    } catch (error) {
      const code = errorCode(error);
      if (row.state === 'pending' && row.attempt_count + 1 >= ANCHOR_MAX_ATTEMPTS) {
        await deps.db.query(`UPDATE tlog_anchors SET state = 'failed', attempt_count = attempt_count + 1, last_error = $2 WHERE id = $1`, [row.id, code]);
        failed += 1;
      } else {
        await deps.db.query(`UPDATE tlog_anchors SET attempt_count = attempt_count + 1, last_error = $2, next_attempt_at = $3 WHERE id = $1`, [
          row.id,
          code,
          new Date(deps.now().getTime() + backoffMs(row.attempt_count + 1)),
        ]);
        retried += 1;
      }
    }
  }
  return { scheduled, submitted, confirmed, bitcoinClaimed, retried, failed, deferred };
}
