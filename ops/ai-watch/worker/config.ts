/**
 * ops/ai-watch/worker/config.ts — 워커 설정(launchd plist 의 `EnvironmentVariables` → 여기). 비밀은 여기 없다(FD 3 — `main.ts`).
 */

import { join } from 'node:path';

import { AI_WATCH_QUEUES, AI_WATCH_WORKER_ID_PATTERN } from '../../../src/inbound/ai-watch/contract';

export const AWS_ACCOUNT = '123456789012';
export const AWS_REGION = 'ap-northeast-2';
const DEFAULT_HOME = '/Library/Application Support/AtmarkAiWatch';

export interface WorkerConfig {
  readonly home: string;
  readonly modelsRoot: string;
  readonly lockPath: string;
  readonly region: string;
  readonly requestQueueUrl: string;
  readonly resultQueueUrl: string;
  readonly workerId: string;
  readonly threads: number;
  readonly rssLimitMb: number;
  /** root 로 떴을 때 내려갈 사용자(`_atmarkaiwatch`). 둘 다 있거나 둘 다 없다. */
  readonly runAs: { readonly uid: number; readonly gid: number } | null;
  readonly credentialsFd: number;
  /** 시험 전용 — 루프백 가짜 SQS(`test/e2e.ts`). 루프백이 아니면 기동을 거부한다. */
  readonly sqsEndpoint: string | null;
}

export function queueUrl(account: string, region: string, name: string): string {
  return `https://sqs.${region}.amazonaws.com/${account}/${name}`;
}

function loopbackEndpoint(raw: string | undefined): string | null {
  if (raw === undefined || raw === '') return null;
  if (!/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(raw)) throw new RangeError('bad_env_sqs_endpoint');
  return raw;
}

function intIn(raw: string | undefined, fallback: number, min: number, max: number, name: string): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new RangeError(`bad_env_${name}`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv): WorkerConfig {
  const home = env['AIWATCH_HOME'] ?? DEFAULT_HOME;
  const account = env['AIWATCH_ACCOUNT'] ?? AWS_ACCOUNT;
  if (!/^\d{12}$/.test(account)) throw new RangeError('bad_env_account');
  const workerId = env['AIWATCH_WORKER_ID'] ?? 'macstudio-1';
  if (!AI_WATCH_WORKER_ID_PATTERN.test(workerId)) throw new RangeError('bad_env_worker_id');
  const uidRaw = env['AIWATCH_RUN_AS_UID'];
  const gidRaw = env['AIWATCH_RUN_AS_GID'];
  if ((uidRaw === undefined) !== (gidRaw === undefined)) throw new RangeError('bad_env_run_as');
  // 빈 값은 "안 내린다" 가 아니다 — intIn 의 기본값(0 = root)으로 읽혀 엉뚱한 사유로 거부되지 않게 여기서 명확히 거부한다.
  if (uidRaw === '' || gidRaw === '') throw new RangeError('bad_env_run_as');
  const runAs =
    uidRaw === undefined || gidRaw === undefined
      ? null
      : { uid: intIn(uidRaw, 0, 1, 2_147_483_647, 'uid'), gid: intIn(gidRaw, 0, 1, 2_147_483_647, 'gid') };
  return {
    home,
    modelsRoot: join(home, 'models'),
    lockPath: join(home, 'app', 'models.lock'),
    region: AWS_REGION,
    requestQueueUrl: queueUrl(account, AWS_REGION, AI_WATCH_QUEUES.request),
    resultQueueUrl: queueUrl(account, AWS_REGION, AI_WATCH_QUEUES.result),
    workerId,
    // 설계 §5.2 — intraOp 4(CI VM 12 CPU 와 나눠 쓴다).
    threads: intIn(env['AIWATCH_THREADS'], 4, 1, 8, 'threads'),
    rssLimitMb: intIn(env['AIWATCH_RSS_LIMIT_MB'], 2048, 512, 8192, 'rss'),
    runAs,
    credentialsFd: intIn(env['AIWATCH_CREDENTIALS_FD'], 3, 3, 9, 'fd'),
    sqsEndpoint: loopbackEndpoint(env['AIWATCH_SQS_ENDPOINT']),
  };
}

/** 키체인 값 `ACCESS_KEY_ID:SECRET` → 자격 증명. 모양이 아니면 던진다(값은 에러에 싣지 않는다). */
export function parseCredentials(raw: string): { readonly accessKeyId: string; readonly secretAccessKey: string } {
  const value = raw.trim();
  const index = value.indexOf(':');
  const accessKeyId = index > 0 ? value.slice(0, index) : '';
  const secretAccessKey = index > 0 ? value.slice(index + 1) : '';
  if (!/^AKIA[A-Z0-9]{12,124}$/.test(accessKeyId) || !/^[A-Za-z0-9/+=]{20,128}$/.test(secretAccessKey)) throw new TypeError('bad_credentials');
  return { accessKeyId, secretAccessKey };
}
