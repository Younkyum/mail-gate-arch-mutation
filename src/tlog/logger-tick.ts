/**
 * src/tlog/logger-tick.ts — 투명성 로그 Lambda 의 틱 하나: **outbox 비우기 → (시 경계면) 에폭 마감 → 밀린 에폭 게시**.
 * 순서가 의미다: 마감 직전에 비워야 그 시각까지 커밋된 사건이 그 에폭에 들어간다.
 */

import type { Pool } from 'pg';

import { closeEpoch } from './epoch';
import { publishPendingEpochs, type TlogObjectWriter, type TlogPublishedReader } from './publisher';
import { drainOutbox } from './sequencer';
import type { NoteSigner } from './signing';

export interface TransparencyLoggerDependencies {
  readonly db: Pool;
  readonly signer: NoteSigner;
  readonly writer: TlogObjectWriter;
  /** 게시된 최신 체크포인트 읽기 — 에폭 마감이 서명 전에 게시 수위를 본다. */
  readonly published: TlogPublishedReader;
  readonly now: () => Date;
}

export async function runTransparencyLoggerTick(deps: TransparencyLoggerDependencies): Promise<Readonly<Record<string, number>>> {
  const drained = await drainOutbox({ db: deps.db, now: deps.now });
  const epoch = await closeEpoch({ db: deps.db, signer: deps.signer, published: deps.published, now: deps.now, cadence: 'hourly' });
  const published = await publishPendingEpochs({ db: deps.db, writer: deps.writer });
  return {
    processed: drained.processed,
    logs_created: drained.logsCreated,
    missing_sources: drained.missingSources,
    epoch_closed: epoch.closed ? 1 : 0,
    epoch: epoch.epoch ?? -1,
    published: published.published,
  };
}
