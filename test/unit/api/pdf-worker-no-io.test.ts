/**
 * PDF 워커의 **바깥 접근 0**(`src/api/pdf-text-worker.ts` ③, 리뷰 L-1) — 한국어 CID PDF 를 뽑는 동안 파일 열기 · 읽기 · 네트워크 호출이 한 번도 없다.
 *
 * 해석기 옵션 이름이 바뀌면(`BinaryDataFactory` 등) 조용히 기본값 — Node 용 공급자가 `fs` 로 CMap 을 읽는다 — 으로 돌아간다.
 * 타입 검사(`DocumentInitParameters`)가 1차 방어이고, 이 테스트가 런타임 증거다. 워커 소스(.ts)를 그대로 띄우되 `test/support/pdf-io-probe.mjs`
 * 를 먼저 적재해 fs · fs/promises · http(s) · net · fetch 진입점이 불리면 `{type:'io'}` 로 알리게 한다.
 */

import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import { describe, expect, it } from 'vitest';

import { koreanCidPdf } from '../../support/minimal-pdf';

const WORKER = new URL('../../../src/api/pdf-text-worker.ts', import.meta.url);
const CONTROL = fileURLToPath(new URL('../../support/pdf-io-control.mjs', import.meta.url));
const PROBE = fileURLToPath(new URL('../../support/pdf-io-probe.mjs', import.meta.url));

type Seen = { readonly type: 'io'; readonly call: string; readonly arg: string } | { readonly type: string; readonly text?: string };

function run(bytes: Uint8Array): Promise<Seen[]> {
  return new Promise((resolve, reject) => {
    const seen: Seen[] = [];
    const worker = new Worker(WORKER, { execArgv: ['--import', PROBE], workerData: { bytes, maxPages: 5, maxChars: 1000 }, env: {} });
    worker.on('message', (message: Seen) => {
      seen.push(message);
      if (message.type === 'end' || message.type === 'fail') void worker.terminate().then(() => resolve(seen), reject);
    });
    worker.on('error', reject);
  });
}

describe('PDF 워커 — 한국어 CID PDF 를 뽑는 동안 파일 · 네트워크 접근 0', () => {
  it('안녕(CP949, KSCms-UHC-H)을 읽고 io 기록은 비어 있다', async () => {
    const seen = await run(koreanCidPdf(Uint8Array.from([0xbe, 0xc8, 0xb3, 0xe7])));
    // 워커 소스를 불러오는 Node 자신의 파일 읽기(타입 지우기)는 `open` 앞에서 끝난다 — 해석기를 불러온 뒤(`open` 이후)가 검사 대상이다.
    const afterOpen = seen.slice(seen.findIndex((message) => message.type === 'open') + 1);
    expect(seen.some((message) => message.type === 'open')).toBe(true);
    expect(afterOpen.filter((message) => message.type === 'io')).toEqual([]);
    expect(seen.find((message) => message.type === 'page')).toMatchObject({ text: '안녕' });
    expect(seen.at(-1)).toMatchObject({ type: 'end' });
  }, 30_000);

  it('탐침이 살아 있다 — 감싼 fs 를 워커에서 부르면 기록된다(비공허)', async () => {
    const seen = await new Promise<Seen[]>((resolve, reject) => {
      const messages: Seen[] = [];
      const worker = new Worker(CONTROL, { execArgv: ['--import', PROBE] });
      worker.on('message', (message: Seen) => {
        messages.push(message);
        if (message.type === 'end') void worker.terminate().then(() => resolve(messages), reject);
      });
      worker.on('error', reject);
    });
    expect(seen).toContainEqual({ type: 'io', call: 'fs.existsSync', arg: '/' });
  }, 30_000);
});
