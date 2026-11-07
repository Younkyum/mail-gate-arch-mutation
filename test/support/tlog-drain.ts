/**
 * 통합 테스트용 — outbox 를 **다 비울 때까지** 서열한다.
 *
 * 틱 하나(`drainOutbox`)는 `SEQUENCER_BATCH_SIZE × SEQUENCER_MAX_BATCHES`(5 000)행에서 멈춘다(설계 — 운영은 다음 틱이 이어받는다). 전체 실행에서는
 * 다른 파일들이 남긴 outbox 행(tlog 파일 말고는 아무도 비우지 않는다 — 한 번의 전체 실행에 1만 행 넘게)이 테스트 조직의 행보다 id 가 앞서서,
 * 틱 하나만 돌리면 테스트 조직의 행이 상한 뒤에 남았다(transparency-log ① `pending: '13'`, 2026-09-25). 상한을 다 쓴 틱이면 한 번 더 —
 * 상한보다 적게 처리한 틱에서 멈춘다.
 */

import type { Pool } from 'pg';

import { drainOutbox, SEQUENCER_BATCH_SIZE, SEQUENCER_MAX_BATCHES } from '../../src/tlog/sequencer';

export async function drainOutboxFully(db: Pool): Promise<void> {
  for (let round = 0; round < 100; round += 1) {
    const drained = await drainOutbox({ db, now: () => new Date() });
    if (drained.processed < SEQUENCER_BATCH_SIZE * SEQUENCER_MAX_BATCHES) return;
  }
  throw new Error('outbox 가 100 틱 안에 비지 않았다');
}
