/**
 * `pnpm ai-watch:e2e` — **번들된 워커**(`ops/ai-watch/dist/worker.mjs`)를 진짜 프로세스로 띄워 루프백 가짜 SQS 와 주고받는다. AWS 에 닿지 않는다.
 *
 * 보는 것: 자격 증명 FD 3 · `models/current` 링크 + 잠금 대조 · 자기 시험 통과 하트비트 · 정상 작업 → 판정 결과 + 요청 삭제(송신 **뒤**) ·
 * 마감 지난 작업 → 결과 없이 삭제 · 계약 위반(job_id 있음) → `verdict:"error"` + 삭제 · SIGUSR1 → `draining:true` 하트비트 · SIGTERM → 0 으로 종료 ·
 * 워커 출력(stdout)에 본문 조각이 없다.
 * 건너뛰기 규칙은 `golden.ts` 와 같다(`--require` 로 강제). 먼저 `pnpm ai-watch:bundle`.
 */

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, copyFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AI_WATCH_INPUT_VERSION, parseAiWatchResult, serializeAiWatchRequest, type AiWatchResult } from '../../../src/inbound/ai-watch/contract';
import { parseModelsLock } from '../worker/lock';
import { renderEmail } from '../worker/preprocess';
import { parseFixtures } from '../worker/selftest';

const AI_WATCH_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(AI_WATCH_DIR, '..', '..');
const BUNDLE = join(AI_WATCH_DIR, 'dist', 'worker.mjs');

function modelDir(): string | undefined {
  const fromEnv = process.env['AIWATCH_MODEL_DIR'];
  const rel = join('.omc', 'spikes', 'laya-release', 'model');
  const candidates = fromEnv ? [fromEnv] : [join(REPO_ROOT, rel)];
  const at = REPO_ROOT.indexOf(join('.claude', 'worktrees'));
  if (!fromEnv && at > 0) candidates.push(join(REPO_ROOT.slice(0, at), rel));
  return candidates.find((candidate) => existsSync(join(candidate, 'release_config.json')));
}

function skipOrFail(reason: string): never {
  if (process.argv.includes('--require')) {
    console.error(`✗ ai-watch e2e: ${reason}`);
    process.exit(1);
  }
  console.log(`SKIP ai-watch e2e: ${reason}`);
  process.exit(0);
}

const md5 = (text: string): string => createHash('md5').update(text, 'utf8').digest('hex');

interface FakeQueue {
  readonly pending: { body: string; handle: string; sent: number }[];
  readonly inflight: Map<string, string>;
  readonly deleted: string[];
  readonly results: AiWatchResult[];
  readonly rejectedResults: number;
}

function startFakeSqs(queue: FakeQueue & { rejectedResults: number }): Promise<{ url: string; close: () => void }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
    req.on('end', () => {
      const target = String(req.headers['x-amz-target'] ?? '');
      const body = JSON.parse(raw === '' ? '{}' : raw) as Record<string, unknown>;
      const reply = (payload: unknown): void => {
        res.writeHead(200, { 'content-type': 'application/x-amz-json-1.0' });
        res.end(JSON.stringify(payload));
      };
      if (target === 'AmazonSQS.ReceiveMessage') {
        if (!String(body['QueueUrl']).endsWith('/atmark-ai-watch-req')) throw new Error('wrong queue for receive');
        const batch = queue.pending.splice(0, Number(body['MaxNumberOfMessages'] ?? 1));
        for (const m of batch) queue.inflight.set(m.handle, m.body);
        const send = (): void =>
          reply({
            Messages: batch.map((m) => ({
              MessageId: randomUUID(),
              ReceiptHandle: m.handle,
              MD5OfBody: md5(m.body),
              Body: m.body,
              Attributes: { SentTimestamp: String(m.sent) },
            })),
          });
        // 빈 응답은 잠깐 붙잡는다(long poll 흉내 — 워커가 바쁘게 돌지 않는지).
        if (batch.length === 0) setTimeout(send, 300);
        else send();
        return;
      }
      if (target === 'AmazonSQS.DeleteMessage') {
        if (!String(body['QueueUrl']).endsWith('/atmark-ai-watch-req')) throw new Error('wrong queue for delete');
        queue.deleted.push(String(body['ReceiptHandle']));
        reply({});
        return;
      }
      if (target === 'AmazonSQS.SendMessage') {
        if (!String(body['QueueUrl']).endsWith('/atmark-ai-watch-result')) throw new Error('wrong queue for send');
        const message = String(body['MessageBody']);
        const parsed = parseAiWatchResult(message);
        if (parsed.ok) queue.results.push(parsed.value);
        else queue.rejectedResults += 1;
        reply({ MessageId: randomUUID(), MD5OfMessageBody: md5(message) });
        return;
      }
      res.writeHead(400, { 'content-type': 'application/x-amz-json-1.0' });
      res.end(JSON.stringify({ __type: 'UnsupportedOperation' }));
    });
  });
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      done({ url: `http://127.0.0.1:${String(port)}`, close: () => server.close() });
    });
  });
}

async function waitFor(check: () => boolean, ms: number, what: string): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error(`시간 초과: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

function assert(condition: boolean, what: string): void {
  if (!condition) throw new Error(`단언 실패: ${what}`);
}

async function main(): Promise<void> {
  if (!existsSync(join(AI_WATCH_DIR, 'node_modules', 'onnxruntime-node'))) skipOrFail('네이티브 의존성 없음');
  const source = modelDir();
  if (source === undefined) skipOrFail('모델 디렉터리 없음');
  if (!existsSync(BUNDLE)) skipOrFail('번들 없음 (pnpm ai-watch:bundle)');

  const lock = parseModelsLock(readFileSync(join(AI_WATCH_DIR, 'models.lock'), 'utf8'));
  const version = [...lock.keys()].at(-1)!;
  const home = mkdtempSync(join(tmpdir(), 'aiwatch-e2e-'));
  mkdirSync(join(home, 'app'), { recursive: true });
  mkdirSync(join(home, 'models'), { recursive: true });
  copyFileSync(join(AI_WATCH_DIR, 'models.lock'), join(home, 'app', 'models.lock'));
  // 324MB 를 복사하지 않는다 — 버전 디렉터리를 원본에 대한 링크로(워커는 realpath 의 basename 을 버전으로 읽으므로 한 단계 더 둔다).
  mkdirSync(join(home, 'models', version));
  for (const name of ['laya_mail_int8.onnx', 'release_config.json', 'fixtures.json', 'tokenizer']) symlinkSync(join(source, name), join(home, 'models', version, name));
  symlinkSync(join(home, 'models', version), join(home, 'models', 'current'));

  const fixtures = parseFixtures(JSON.parse(readFileSync(join(source, 'fixtures.json'), 'utf8')));
  // 발췌 상한(4,000자) 안의 픽스처 중 `attack_score` 가 가장 높은 것 / 낮은 것 — 잘림이 판정을 바꾸지 않게.
  const fits = fixtures.filter((f) => [...renderEmail(f.subject, f.text)].length <= 4000);
  const attack = [...fits].sort((a, b) => b.attack_score - a.attack_score)[0]!;
  const excerpt = [...renderEmail(attack.subject, attack.text).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')].slice(0, 4000).join('');
  const benign = [...fits].sort((a, b) => a.attack_score - b.attack_score)[0]!;
  const benignExcerpt = [...renderEmail(benign.subject, benign.text).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')].slice(0, 4000).join('');

  const queue = { pending: [], inflight: new Map(), deleted: [], results: [], rejectedResults: 0 } as FakeQueue & { rejectedResults: number };
  const now = Date.now();
  const job = (text: string, deadlineOffsetMs: number): { id: string; body: string } => {
    const id = randomUUID();
    const enqueued = new Date(now - 1000);
    return {
      id,
      body: serializeAiWatchRequest({
        v: 1,
        job_id: id,
        enqueued_at: enqueued.toISOString(),
        deadline: new Date(enqueued.getTime() + deadlineOffsetMs).toISOString(),
        input_version: AI_WATCH_INPUT_VERSION,
        text,
      }),
    };
  };
  const flagged = job(excerpt, 120_000);
  const clear = job(benignExcerpt, 120_000);
  const expired = job(benignExcerpt, 500); // enqueued 1초 전 + 0.5초 = 이미 지남
  const brokenId = randomUUID();
  const broken = JSON.stringify({ v: 1, job_id: brokenId, enqueued_at: 'x', deadline: 'y', input_version: AI_WATCH_INPUT_VERSION, text: 'short' });
  for (const [i, m] of [flagged, clear, expired, { id: brokenId, body: broken }].entries()) {
    queue.pending.push({ body: m.body, handle: `h${String(i)}`, sent: now - 2000 });
  }

  const fake = await startFakeSqs(queue);
  const child = spawn(process.execPath, [BUNDLE], {
    env: {
      PATH: process.env['PATH'] ?? '',
      AIWATCH_HOME: home,
      AIWATCH_SQS_ENDPOINT: fake.url,
      AIWATCH_WORKER_ID: 'e2e-1',
      AIWATCH_THREADS: '4',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  });
  const credentialPipe = child.stdio[3] as NodeJS.WritableStream;
  credentialPipe.end(`AKIA${'E2EFAKE0000000'.padEnd(16, '0')}:${'f'.repeat(40)}\n`);
  let stdout = '';
  let stderr = '';
  child.stdout!.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
  child.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
  const exited = new Promise<number | null>((done) => child.on('exit', (code) => done(code)));

  try {
    await waitFor(() => queue.results.some((r) => r.kind === 'heartbeat' && r.self_test === 'pass'), 120_000, '자기 시험 통과 하트비트');
    await waitFor(() => queue.deleted.length === 4, 60_000, '네 작업 삭제');
    const verdicts = queue.results.filter((r) => r.kind === 'verdict');
    const byJob = new Map(verdicts.map((r) => [r.job_id, r]));
    assert(byJob.get(flagged.id)?.verdict === 'flagged', '공격 픽스처 → flagged');
    assert(byJob.get(clear.id)?.verdict === 'clear' && byJob.get(clear.id)?.band === 'low', '정상 픽스처 → clear/low');
    assert(!byJob.has(expired.id), '마감 지난 작업은 결과가 없다');
    assert(byJob.get(brokenId)?.verdict === 'error' && byJob.get(brokenId)?.band === null, '계약 위반 → error');
    assert(verdicts.every((r) => r.model_version === version), 'model_version = 잠금 버전');
    assert(queue.rejectedResults === 0, '워커가 낸 결과는 전부 계약을 통과한다');

    child.kill('SIGUSR1');
    await waitFor(() => queue.results.some((r) => r.kind === 'heartbeat' && r.draining), 10_000, 'draining 하트비트');
    child.kill('SIGTERM');
    const code = await Promise.race([exited, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 30_000).unref())]);
    assert(code === 0, `SIGTERM 뒤 종료 코드 0 (실제 ${String(code)})`);

    // 본문이 로그에 없다 — 발췌문의 긴 조각이 stdout/stderr 어디에도 나오지 않는다.
    for (const text of [excerpt, benignExcerpt]) {
      const probe = text.slice(20, 60);
      assert(!stdout.includes(probe) && !stderr.includes(probe), '로그에 본문 조각이 없다');
    }
    assert(stderr.trim() === '', `stderr 가 비어 있다: ${stderr.slice(0, 200)}`);
    for (const line of stdout.trim().split('\n')) JSON.parse(line);
    console.log(
      `✓ ai-watch e2e — verdicts ${String(verdicts.length)} · deletes ${String(queue.deleted.length)} · heartbeats ${String(queue.results.filter((r) => r.kind === 'heartbeat').length)} · log lines ${String(stdout.trim().split('\n').length)}`,
    );
  } catch (error) {
    child.kill('SIGKILL');
    console.error(stdout.split('\n').slice(-20).join('\n'));
    throw error;
  } finally {
    fake.close();
    rmSync(home, { recursive: true, force: true });
  }
}

await main();
