/**
 * src/tlog/publisher.ts — **공개 로그 게시**(`id.atmark.ai/log/…`, C2SP tlog-tiles). 롤 `atmark_tlog`.
 *
 * 게시되지 않은 에폭을 순서대로: 레벨마다 가장 오른쪽 타일 + 잎 묶음 → `checkpoints/<epoch>`(불변 이력) → `checkpoint`(최신) →
 * `key`(vkey) → `published_at`. 실패하면 표시하지 않으므로 다음 틱이 같은 에폭을 다시 쓴다(같은 바이트 — 버킷 버저닝이 판을
 * 남기고 Object Lock 이 지운다·덮는 것을 막는다). **게시 표면에 PII 가 없다**(P1): 전역 잎은 에폭 번호·시각·불투명 해시뿐이다.
 */

import type { Pool } from 'pg';

import { rightmostTiles } from './tiles';

/** 공개 로그 쓰기 면 — 운영은 `createS3TransparencyLogWriter`(Object Lock 버킷, `log/` 접두사 고정). */
export interface TlogObjectWriter {
  /** `path` 는 `log/` 아래 상대 경로. */
  put(path: string, body: Buffer, contentType: string, cacheControl: string): Promise<void>;
}

/**
 * 공개 로그 읽기 면 — **게시된 최신 체크포인트**(`log/checkpoint`) 하나만. 에폭 마감이 서명 전에 게시 수위를 본다(`epoch.ts` ③).
 * 운영은 로그 버킷의 `log/` 접두사 읽기(IAM: `s3:GetObject` on `log/checkpoint` 하나). 아직 게시된 것이 없으면 null.
 */
export interface TlogPublishedReader {
  readCheckpoint(): Promise<string | null>;
}

/** 체크포인트 객체 상한 — signed note(본문 + 서명 줄 몇 개). KMS RAW 서명 한도(4096)와 같은 눈금. */
export const PUBLISHED_CHECKPOINT_MAX_BYTES = 8192;

export const CHECKPOINT_CACHE_CONTROL = 'public, max-age=60';
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const TEXT_CONTENT_TYPE = 'text/plain; charset=utf-8';
export const TILE_CONTENT_TYPE = 'application/octet-stream';

export interface PublisherDependencies {
  readonly db: Pool;
  readonly writer: TlogObjectWriter;
  /** 한 틱에 게시할 에폭 상한(밀린 것을 따라잡을 때). */
  readonly maxEpochs?: number;
}

export async function publishPendingEpochs(deps: PublisherDependencies): Promise<{ readonly published: number }> {
  const pending = await deps.db.query<{ epoch: string }>(
    'SELECT epoch FROM tlog_epochs WHERE published_at IS NULL ORDER BY epoch LIMIT $1',
    [deps.maxEpochs ?? 48],
  );
  if (pending.rows.length === 0) return { published: 0 };
  const last = Number(pending.rows.at(-1)?.epoch);
  const rows = (
    await deps.db.query<{ epoch: string; global_leaf: string; global_leaf_hash: Buffer; checkpoint: string; key_id: string }>(
      'SELECT epoch, global_leaf, global_leaf_hash, checkpoint, key_id FROM tlog_epochs WHERE epoch <= $1 ORDER BY epoch',
      [last],
    )
  ).rows;
  const hashes = rows.map((row) => row.global_leaf_hash);
  const entries = rows.map((row) => Buffer.from(row.global_leaf, 'utf8'));
  let published = 0;
  for (const { epoch } of pending.rows) {
    const index = Number(epoch);
    const row = rows[index];
    if (row === undefined || Number(row.epoch) !== index) throw new Error('tlog_epochs 가 연속이 아니다');
    for (const tile of rightmostTiles(hashes, entries, index + 1)) {
      await deps.writer.put(tile.path, tile.bytes, TILE_CONTENT_TYPE, IMMUTABLE_CACHE_CONTROL);
    }
    const note = Buffer.from(row.checkpoint, 'utf8');
    await deps.writer.put(`checkpoints/${String(index)}`, note, TEXT_CONTENT_TYPE, IMMUTABLE_CACHE_CONTROL);
    await deps.writer.put('checkpoint', note, TEXT_CONTENT_TYPE, CHECKPOINT_CACHE_CONTROL);
    await deps.writer.put('key', Buffer.from(`${row.key_id}\n`, 'utf8'), TEXT_CONTENT_TYPE, CHECKPOINT_CACHE_CONTROL);
    await deps.db.query('UPDATE tlog_epochs SET published_at = now() WHERE epoch = $1 AND published_at IS NULL', [index]);
    published += 1;
  }
  return { published };
}
