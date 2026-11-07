/**
 * ops/ai-watch/worker/main.ts — Mac Studio AI 의심 메일 감시 워커(LaunchDaemon `ai.atmark.aiwatch`, 설계 §5).
 *
 * 기동 순서(되돌릴 수 없는 것부터):
 *   1. FD 3 에서 자격 증명을 읽고 닫는다(래퍼 `run.sh` 가 root 로 시스템 키체인에서 꺼내 파이프로 준다 — env·파일·argv 에 없다).
 *   2. root 면 `_atmarkaiwatch` 로 내려간다(setgroups → setgid → setuid, 되돌아올 수 없는지 확인). 메시지·모델은 그 뒤에만 연다.
 *   3. `models/current` → 잠금 대조 → 로드 → 골든 24 자기 시험. 실패하면 **작업을 받지 않고** 하트비트에 `self_test:"fail"`.
 *   4. 하트비트 60초 · 자기 시험 재실행(통과 6시간 / 실패 10분) · RSS 감시(상한 넘으면 종료 → launchd 재시작).
 *   5. 요청 큐 long poll(20초) → `WorkerCore.handle`.
 * 신호: SIGTERM·SIGINT = 배수 하트비트 후 종료 · SIGUSR1 = 일시 정지(`teardown.sh --pause` — 하트비트 `draining:true`) · SIGUSR2 = 재개.
 */

import { closeSync, readFileSync } from 'node:fs';

import { AI_WATCH_HEARTBEAT_INTERVAL_SECONDS } from '../../../src/inbound/ai-watch/contract';
import { loadConfig, parseCredentials, type WorkerConfig } from './config';
import { WorkerCore } from './core';
import { loadEngine, type Engine } from './engine';
import { createLogger, errorKind, type Logger } from './log';
import { parseModelsLock, resolveCurrentModel } from './lock';
import { createSqsWorkQueue } from './queue';

const SELF_TEST_PASS_INTERVAL_MS = 6 * 60 * 60_000;
const SELF_TEST_FAIL_INTERVAL_MS = 10 * 60_000;
const RSS_CHECK_INTERVAL_MS = 30_000;
const IDLE_SLEEP_MS = 5_000;
const RECEIVE_ERROR_BACKOFF_MS = 5_000;
/** 버전을 알 수 없을 때(링크 없음) 선로에 싣는 이름 — 계약 모양을 지킨다. */
const UNKNOWN_MODEL_VERSION = 'none';

function readCredentials(fd: number): { accessKeyId: string; secretAccessKey: string } {
  try {
    return parseCredentials(readFileSync(fd, 'utf8'));
  } finally {
    try {
      closeSync(fd);
    } catch {
      // 이미 닫힘.
    }
  }
}

function dropPrivileges(config: WorkerConfig): void {
  const uid = process.getuid?.();
  if (uid !== 0) return;
  if (config.runAs === null) throw new Error('refusing_to_run_as_root');
  process.setgroups?.([config.runAs.gid]);
  process.setgid?.(config.runAs.gid);
  process.setuid?.(config.runAs.uid);
  if (process.getuid?.() !== config.runAs.uid || process.geteuid?.() !== config.runAs.uid || process.getgid?.() !== config.runAs.gid) {
    throw new Error('privilege_drop_failed');
  }
  try {
    process.setuid?.(0);
  } catch {
    return; // 기대한 결과 — root 로 돌아갈 수 없다.
  }
  throw new Error('privilege_drop_reversible');
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

async function prepareEngine(config: WorkerConfig, logger: Logger): Promise<{ engine: Engine | null; version: string }> {
  let version = UNKNOWN_MODEL_VERSION;
  try {
    const current = resolveCurrentModel(config.modelsRoot);
    const locked = parseModelsLock(readFileSync(config.lockPath, 'utf8')).get(current.version);
    if (locked === undefined) {
      logger.log('error', { event: 'model_load', outcome: 'not_locked' });
      return { engine: null, version };
    }
    version = locked.version;
    const loaded = await loadEngine({ dir: current.dir, locked, threads: config.threads });
    if (!loaded.ok) {
      logger.log('error', { event: 'model_load', outcome: 'rejected', reason: loaded.reason, model_version: version });
      return { engine: null, version };
    }
    return { engine: loaded.engine, version };
  } catch (error) {
    logger.log('error', { event: 'model_load', outcome: 'error', error_kind: errorKind(error), model_version: version });
    return { engine: null, version };
  }
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const credentials = readCredentials(config.credentialsFd);
  dropPrivileges(config);
  const logger = createLogger();
  logger.log('info', { event: 'start', worker_id: config.workerId });

  const { engine: firstEngine, version } = await prepareEngine(config, logger);
  let engine = firstEngine;
  const core = new WorkerCore({
    queue: createSqsWorkQueue({ region: config.region, requestQueueUrl: config.requestQueueUrl, resultQueueUrl: config.resultQueueUrl, credentials, endpoint: config.sqsEndpoint }),
    bandOf: (text) => {
      if (engine === null) return Promise.reject(new Error('engine_unavailable'));
      return engine.bandOf(text);
    },
    logger,
    modelVersion: version,
    workerId: config.workerId,
    now: () => Date.now(),
  });

  let selfTestTimer: NodeJS.Timeout | undefined;
  let firstSelfTest = true;
  const selfTest = async (): Promise<void> => {
    if (engine === null) {
      // 기동 때 모델을 못 열었다 — 다시 연다(진윤겸이 모델을 고쳐 넣은 뒤 재시작 없이도 돌아오게). 버전이 바뀌었으면 재시작이 맞다.
      const again = await prepareEngine(config, logger);
      if (again.version === version) engine = again.engine;
    }
    let pass = false;
    if (engine !== null) {
      try {
        const report = await engine.selfTest();
        pass = report.pass;
        logger.log(pass ? 'info' : 'error', {
          event: 'self_test',
          self_test: pass ? 'pass' : 'fail',
          count: report.fixtures,
          failed: report.idMismatch + report.logitMismatch + report.decisionFlips,
          model_version: version,
        });
      } catch (error) {
        logger.log('error', { event: 'self_test', self_test: 'fail', error_kind: errorKind(error) });
      }
    }
    const changed = core.state.selfTest !== (pass ? 'pass' : 'fail');
    core.state.selfTest = pass ? 'pass' : 'fail';
    // 상태가 바뀌면 곧바로 알린다(기동 때는 아래 첫 하트비트가 한다).
    if (changed && !firstSelfTest) await core.heartbeat();
    firstSelfTest = false;
    selfTestTimer = setTimeout(() => void selfTest(), pass ? SELF_TEST_PASS_INTERVAL_MS : SELF_TEST_FAIL_INTERVAL_MS);
  };
  await selfTest();
  await core.heartbeat();

  const heartbeatTimer = setInterval(() => void core.heartbeat(), AI_WATCH_HEARTBEAT_INTERVAL_SECONDS * 1000);
  const rssTimer = setInterval(() => {
    const rssMb = Math.round(process.memoryUsage.rss() / 1_048_576);
    if (rssMb > config.rssLimitMb) {
      logger.log('error', { event: 'rss_limit', rss_mb: rssMb });
      process.exit(75); // launchd KeepAlive 가 다시 띄운다.
    }
  }, RSS_CHECK_INTERVAL_MS);

  const stop = new AbortController();
  let receiveAbort = new AbortController();
  const shutdown = (): void => {
    if (stop.signal.aborted) return;
    core.state.draining = true;
    stop.abort();
    receiveAbort.abort();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGUSR1', () => {
    core.state.draining = true;
    receiveAbort.abort();
    logger.log('info', { event: 'pause', draining: true });
    void core.heartbeat();
  });
  process.on('SIGUSR2', () => {
    if (stop.signal.aborted) return;
    core.state.draining = false;
    logger.log('info', { event: 'resume', draining: false });
    void core.heartbeat();
  });

  while (!stop.signal.aborted) {
    if (!core.accepting) {
      await sleep(IDLE_SLEEP_MS, stop.signal);
      continue;
    }
    receiveAbort = new AbortController();
    let messages;
    try {
      messages = await core.receive(receiveAbort.signal);
    } catch (error) {
      if (receiveAbort.signal.aborted) continue;
      logger.log('warn', { event: 'receive_failed', error_kind: errorKind(error) });
      await sleep(RECEIVE_ERROR_BACKOFF_MS, stop.signal);
      continue;
    }
    for (const message of messages) {
      // 받은 뒤 정지·일시 정지가 오면 남은 것은 손대지 않는다 — 가시성(15초) 뒤 큐로 돌아가고, 마감이 지나면 다음 워커가 지운다.
      if (!core.accepting) break;
      await core.handle(message);
    }
  }

  clearInterval(heartbeatTimer);
  clearInterval(rssTimer);
  if (selfTestTimer !== undefined) clearTimeout(selfTestTimer);
  await core.heartbeat();
  logger.log('info', { event: 'stop', draining: true });
}

main().catch((error: unknown) => {
  // 이 파일이 던지는 사유는 닫힌 이름(`refusing_to_run_as_root` 등)뿐 — 그 모양일 때만 싣는다.
  const reason = error instanceof Error && /^[a-z_]{1,40}$/.test(error.message) ? error.message : 'unknown';
  createLogger().log('error', { event: 'fatal', error_kind: errorKind(error), reason });
  process.exit(1);
});
