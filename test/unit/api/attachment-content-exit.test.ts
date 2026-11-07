/**
 * `extractPdfText`(`src/api/attachment-content.ts` ②) — **결과는 워커의 `'exit'` 뒤에 난다**(검증 M1: 끊긴 워커가 다 내려가기 전에 다음
 * 해석의 RSS 기준선을 재면 따뜻한 인스턴스에서 기준선이 계단처럼 올라갔다). 기다림에는 상한(500ms)이 있다.
 *
 *   - ★ 결정(`end`) 뒤 `terminate()` → `'exit'` 가 올 때까지 약속이 풀리지 않는다
 *   - ★ `'exit'` 가 오지 않으면 상한(500ms) 뒤에 풀린다
 *   - 결정 전의 종료(비정상 종료)는 곧바로 결정이다(기다리지 않는다)
 *   - 워커는 빈 환경 변수(`env: {}`)로 뜬다 — 부모의 자격 증명을 물려주지 않는다
 *
 * 진짜 워커는 exit 시점을 고를 수 없어 `node:worker_threads` 의 `Worker` 를 가짜로 바꾼다(이 파일에서만).
 */

import { EventEmitter } from 'node:events';

import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeWorkerOptions {
  readonly env?: unknown;
}

/** 부모가 쓰는 부분만 — `on`(EventEmitter) · `terminate()`. `terminate()` 가 무엇을 할지는 테스트가 고른다. */
class FakeWorker extends EventEmitter {
  static last: FakeWorker | null = null;
  static onTerminate: (worker: FakeWorker) => Promise<number> = () => Promise.resolve(1);
  readonly options: FakeWorkerOptions;
  terminated = 0;
  constructor(_url: URL, options: FakeWorkerOptions) {
    super();
    this.options = options;
    FakeWorker.last = this;
  }
  terminate(): Promise<number> {
    this.terminated += 1;
    return FakeWorker.onTerminate(this);
  }
}

vi.mock('node:worker_threads', () => ({ Worker: FakeWorker }));

const { ATTACHMENT_CONTENT_LIMITS, extractPdfText } = await import('../../../src/api/attachment-content');

const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 약속이 풀렸는지 — 기다리지 않고 본다. */
function watch<T>(promise: Promise<T>): { readonly settled: () => boolean; readonly promise: Promise<T> } {
  let done = false;
  void promise.then(() => {
    done = true;
  });
  return { settled: () => done, promise };
}

function currentWorker(): FakeWorker {
  const worker = FakeWorker.last;
  if (worker === null) throw new Error('워커가 뜨지 않았다');
  return worker;
}

describe('extractPdfText — 워커 exit 뒤에 결과', () => {
  beforeEach(() => {
    FakeWorker.last = null;
    FakeWorker.onTerminate = () => Promise.resolve(1);
  });

  it('★ 결정 뒤 exit 가 올 때까지 풀리지 않는다 · 워커는 빈 환경 변수로 뜬다', async () => {
    FakeWorker.onTerminate = () => new Promise(() => undefined); // exit 는 테스트가 직접 낸다
    const result = watch(extractPdfText(new Uint8Array([1, 2, 3]), ATTACHMENT_CONTENT_LIMITS));
    const worker = currentWorker();
    expect(worker.options.env).toEqual({});
    worker.emit('message', { type: 'open', pages: 1 });
    worker.emit('message', { type: 'page', text: 'Invoice total 99000 KRW for September' });
    worker.emit('message', { type: 'end', stoppedAtCharLimit: false });
    await tick(50);
    expect(worker.terminated).toBe(1);
    expect(result.settled()).toBe(false);
    worker.emit('exit', 1);
    expect(await result.promise).toMatchObject({ kind: 'pdf_text', text: 'Invoice total 99000 KRW for September', pagesRead: 1 });
  });

  it('★ exit 가 오지 않으면 상한(500ms) 뒤에 풀린다', async () => {
    FakeWorker.onTerminate = () => new Promise(() => undefined);
    const started = Date.now();
    const result = watch(extractPdfText(new Uint8Array([1]), ATTACHMENT_CONTENT_LIMITS));
    currentWorker().emit('message', { type: 'fail', reason: 'unreadable_pdf' });
    await tick(300);
    expect(result.settled()).toBe(false);
    expect(await result.promise).toEqual({ kind: 'unsupported', reason: 'unreadable_pdf' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(490);
  });

  it('결정 전의 종료(비정상 종료)는 곧바로 결정 — 기다리지 않는다 · 뒤늦은 exit·error 는 버린다', async () => {
    const result = watch(extractPdfText(new Uint8Array([1]), ATTACHMENT_CONTENT_LIMITS));
    const worker = currentWorker();
    worker.emit('exit', 1);
    await tick(0);
    expect(result.settled()).toBe(true);
    expect(await result.promise).toEqual({ kind: 'unsupported', reason: 'pdf_limit' });
    worker.emit('error', new Error('late'));
    worker.emit('exit', 1);
    expect(worker.terminated).toBe(0);
  });
});
