#!/usr/bin/env tsx
/**
 * scripts/admin/ops.ts — **운영자 화면 한 줄로 열기**(`pnpm ops`). 터미널 둘(터널 · `eval "$(pnpm -s admin:db-env)"` + `pnpm admin:web`)을
 * 한 명령으로 묶는다(런북 admin §9-0).
 *
 *   pnpm ops [--billing-operator] [--profile atmark] [--by <운영자>] [--port 0] [--idle-minutes 30] [--max-hours 8] [--no-open]
 *
 * 순서(하나라도 실패하면 거기서 멈추고 연 것을 모두 닫는다):
 *   ① AWS 프로필(`atmark`)이 되는지 — `aws sts get-caller-identity`. 환경 변수 자격 증명(`AWS_ACCESS_KEY_ID`)이 있으면 거부(프로필보다 앞서서
 *      다른 계정으로 갈 수 있다).
 *   ② 로컬 15432 가 비었는지 — 쓰이고 있으면 무엇을 확인할지 알려 주고 끝낸다. **아무것도 죽이지 않는다.**
 *   ③ SSM 포트 포워딩을 자식 프로세스로 — 런북 §0 과 같은 명령(대상 = AtmarkNetwork `NatInstanceId`, 호스트 = AtmarkData `DbEndpointAddress`,
 *      5432 → 15432). `Waiting for connections` 가 나올 때까지(기본 60초) 기다린다.
 *   ④ 접속 변수를 **이 프로세스 안에서** 받는다(`admin:db-env` 와 같은 함수 `computeDbEnv` — 셸·화면·파일에 내지 않는다). `--billing-operator` 면
 *      요금제 쓰기 롤까지.
 *   ⑤ 운영자 웹 화면(`admin:web` 의 `web` 그대로 — 보안 설계 동일)을 띄우고 브라우저를 연다.
 * 끝(Ctrl-C · 화면이 스스로 닫힘(유휴·수명·부트스트랩 재사용) · 오류 · 터널이 끊김): 화면을 닫고 → 터널 프로세스 그룹(aws · session-manager-plugin)에
 * SIGINT → 안 끝나면 SIGTERM → SIGKILL → `aws ssm terminate-session`(서버 쪽 세션도). 두 번째 Ctrl-C 는 곧바로 SIGKILL.
 * 터널 자식은 자기 프로세스 그룹으로 띄운다(detached) — 그룹째 신호를 보내 손자(session-manager-plugin)까지 닫으려고. 그래서 이 프로세스가 어떻게
 * 끝나든(예외 포함) `exit` 훅이 그룹에 SIGKILL 을 보낸다.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import { parseArgs } from 'node:util';

import { DEFAULT_REGION } from './custody';
import { AdminInputError, EXIT_FAILURE, EXIT_INPUT_ERROR, EXIT_OK, isMain, runAdminMain, TUNNEL_LOCAL_PORT, type AdminDeps } from './common';
import { computeDbEnv, type DbEnvOptions, type DbEnvResult } from './db-env';
import { parseWebArgs, web, type WebDeps } from './web';

const USAGE =
  'pnpm ops [--billing-operator] [--profile atmark] [--ca-bundle <RDS CA 번들>] [--ready-timeout <초, 기본 60>] ' +
  '[--by <운영자>] [--port <포트>] [--idle-minutes <분>] [--max-hours <시간>] [--no-open]';

export const DEFAULT_PROFILE = 'atmark';
export const NETWORK_STACK = 'AtmarkNetwork';
export const DATA_STACK = 'AtmarkData';
export const NAT_OUTPUT = 'NatInstanceId';
export const DB_OUTPUT = 'DbEndpointAddress';
export const PORT_FORWARD_DOCUMENT = 'AWS-StartPortForwardingSessionToRemoteHost';
export const READY_MARKER = 'Waiting for connections';
export const DEFAULT_READY_TIMEOUT_MS = 60_000;
export const DEFAULT_STOP_GRACE_MS = 4_000;

const INSTANCE_ID = /^i-[0-9a-f]{8,17}$/;
const RDS_HOST = /^[a-z0-9.-]+\.rds\.amazonaws\.com$/;
const SESSION_ID = /SessionId:\s*([A-Za-z0-9._@-]+)/;

export interface OpsDeps extends AdminDeps {
  /** `aws <args>` — stdout 을 돌려준다. 실패하면 stderr 를 담은 Error. 셸을 거치지 않는다. */
  readonly aws: (args: readonly string[], env: NodeJS.ProcessEnv) => Promise<string>;
  /** `aws ssm start-session …` 을 **자기 프로세스 그룹**으로 띄운다(stdout·stderr 파이프). */
  readonly spawnTunnel: (args: readonly string[], env: NodeJS.ProcessEnv) => ChildProcess;
  /** 프로세스 그룹 전체에 신호(`process.kill(-pid, …)`). */
  readonly signalGroup: (pid: number, signal: NodeJS.Signals) => void;
  /** 그룹에 살아 있는 프로세스가 하나라도 있나(`process.kill(-pid, 0)`). 직접 자식이 먼저 끝나도 손자(plugin)가 남을 수 있다. */
  readonly groupAlive: (pid: number) => boolean;
  readonly portInUse: (port: number) => Promise<boolean>;
  readonly dbEnv: (options: DbEnvOptions, env: NodeJS.ProcessEnv) => Promise<DbEnvResult>;
  readonly runWeb: (argv: readonly string[], deps: WebDeps) => Promise<number>;
  /** SIGINT·SIGTERM 핸들러 등록 — 해제 함수를 돌려준다. */
  readonly onSignal: (handler: () => void) => () => void;
  /** 이 프로세스가 끝날 때(동기) — 터널 그룹이 살아 있으면 SIGKILL. 해제 함수를 돌려준다. */
  readonly onExit: (handler: () => void) => () => void;
  readonly readyTimeoutMs?: number;
  readonly stopGraceMs?: number;
}

interface OpsOptions {
  readonly profile: string;
  readonly billingOperator: boolean;
  readonly caBundle: string | undefined;
  readonly readyTimeoutMs: number | undefined;
  readonly webArgv: readonly string[];
}

export function parseOpsArgs(argv: readonly string[]): OpsOptions | 'help' {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      profile: { type: 'string' },
      'billing-operator': { type: 'boolean', default: false },
      'ca-bundle': { type: 'string' },
      'ready-timeout': { type: 'string' },
      by: { type: 'string' },
      port: { type: 'string' },
      'idle-minutes': { type: 'string' },
      'max-hours': { type: 'string' },
      'no-open': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (values.help) return 'help';
  const profile = (values.profile ?? DEFAULT_PROFILE).trim();
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(profile)) throw new AdminInputError(`--profile 은 영문·숫자·_.- 64자 이하. ${USAGE}`);
  let readyTimeoutMs: number | undefined;
  if (values['ready-timeout'] !== undefined) {
    const seconds = Number(values['ready-timeout']);
    if (!Number.isInteger(seconds) || seconds < 5 || seconds > 600) throw new AdminInputError(`--ready-timeout 은 5~600(초). ${USAGE}`);
    readyTimeoutMs = seconds * 1000;
  }
  const webArgv: string[] = [];
  for (const key of ['by', 'port', 'idle-minutes', 'max-hours'] as const) {
    const value = values[key];
    if (value !== undefined) webArgv.push(`--${key}`, value);
  }
  if (values['no-open']) webArgv.push('--no-open');
  // 화면 인자는 터널을 열기 전에 검사한다(틀린 인자로 터널만 열고 끝나지 않게).
  parseWebArgs(webArgv);
  return { profile, billingOperator: values['billing-operator'], caBundle: values['ca-bundle'], readyTimeoutMs, webArgv };
}

/** 런북 §0 의 `aws ssm start-session` 인자 그대로. */
export function tunnelArgs(profile: string, region: string, instanceId: string, dbHost: string): string[] {
  return [
    'ssm',
    'start-session',
    '--profile',
    profile,
    '--region',
    region,
    '--target',
    instanceId,
    '--document-name',
    PORT_FORWARD_DOCUMENT,
    '--parameters',
    `host=${dbHost},portNumber=5432,localPortNumber=${String(TUNNEL_LOCAL_PORT)}`,
  ];
}

function stackOutputArgs(profile: string, region: string, stack: string, output: string): string[] {
  return [
    'cloudformation',
    'describe-stacks',
    '--profile',
    profile,
    '--region',
    region,
    '--stack-name',
    stack,
    '--query',
    `Stacks[0].Outputs[?OutputKey=='${output}'].OutputValue`,
    '--output',
    'text',
  ];
}

const firstLine = (text: string): string => text.trim().split('\n')[0]?.trim() ?? '';
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 터널 자식 — 준비 신호·세션 id·끝을 한곳에서 본다. 출력은 늘 읽어 비운다(연결마다 한 줄씩 나온다 — 파이프가 차면 멈춘다). */
class Tunnel {
  readonly exited: Promise<void>;
  sessionId: string | null = null;
  private readonly lines: string[] = [];
  private readyResolve: (() => void) | null = null;
  private alive = true;

  constructor(readonly child: ChildProcess) {
    this.exited = new Promise<void>((resolve) => {
      child.once('exit', () => {
        this.alive = false;
        resolve();
      });
      child.once('error', (error) => {
        this.lines.push(error.message);
        this.alive = false;
        resolve();
      });
    });
    let buffer = '';
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        this.line(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
      }
      // 줄바꿈 없이 끝나는 준비 신호도 본다.
      if (buffer.includes(READY_MARKER)) {
        this.line(buffer);
        buffer = '';
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
  }

  get running(): boolean {
    return this.alive && this.child.exitCode === null && this.child.signalCode === null;
  }

  /** 마지막 몇 줄 — 실패 설명용(세션 id·포트 말고 비밀은 없다). */
  tail(): string {
    return this.lines.slice(-6).join(' / ');
  }

  ready(): Promise<void> {
    if (this.lines.some((line) => line.includes(READY_MARKER))) return Promise.resolve();
    return new Promise((resolve) => {
      this.readyResolve = resolve;
    });
  }

  private line(raw: string): void {
    const line = raw.trim();
    if (line === '') return;
    if (this.lines.length < 200) this.lines.push(line);
    else this.lines.splice(0, 1, line);
    const id = SESSION_ID.exec(line)?.[1];
    if (id !== undefined && this.sessionId === null) this.sessionId = id;
    if (line.includes(READY_MARKER) && this.readyResolve !== null) {
      const resolve = this.readyResolve;
      this.readyResolve = null;
      resolve();
    }
  }
}

function explainTunnelFailure(tail: string): string {
  const hints: string[] = [];
  if (/SessionManagerPlugin is not found|session-manager-plugin/i.test(tail)) hints.push('Session Manager 플러그인이 없다 — 런북 §1-1');
  if (/TargetNotConnected/i.test(tail)) hints.push('NAT 인스턴스가 SSM 에 연결돼 있지 않다 — 런북 §6-1');
  if (/AccessDenied|not authorized/i.test(tail)) hints.push('IAM 권한(ssm:StartSession) — 런북 §1-3');
  return hints.length === 0 ? '' : ` (${hints.join(' · ')})`;
}

export async function ops(argv: readonly string[], deps: OpsDeps): Promise<number> {
  const options = parseOpsArgs(argv);
  if (options === 'help') {
    deps.io.out(USAGE);
    return EXIT_OK;
  }
  const say = (line: string) => deps.io.err(line);
  if ((deps.env['AWS_ACCESS_KEY_ID'] ?? '').trim() !== '') {
    throw new AdminInputError(
      '환경 변수 AWS_ACCESS_KEY_ID 가 있다 — 프로필보다 앞서 쓰여 다른 계정으로 갈 수 있다. `unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN` 뒤 다시.',
    );
  }
  const region = deps.env['AWS_REGION']?.trim() || DEFAULT_REGION;
  const awsEnv: NodeJS.ProcessEnv = { ...deps.env, AWS_PROFILE: options.profile, AWS_REGION: region };

  const controller = new AbortController();
  let phase: 'setup' | 'web' | 'cleanup' = 'setup';
  let tunnel: Tunnel | null = null;
  let interrupted = false;
  const killNow = () => {
    const pid = tunnel?.child.pid;
    if (pid !== undefined && deps.groupAlive(pid)) {
      try {
        deps.signalGroup(pid, 'SIGKILL');
      } catch {
        // 이미 끝났다.
      }
    }
  };
  const offSignal = deps.onSignal(() => {
    if (phase === 'setup') {
      interrupted = true;
      controller.abort();
    } else if (phase === 'cleanup') {
      say('다시 Ctrl-C — 터널을 바로 끊는다.');
      killNow();
    }
    // 'web' 단계는 화면이 스스로 SIGINT 를 받아 닫는다(그다음 cleanup).
  });
  const offExit = deps.onExit(killNow);
  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(new AdminInputError('중단했다.')), { once: true });
  });
  aborted.catch(() => undefined);
  const step = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, aborted]);

  try {
    // ① AWS 프로필
    say(`AWS 프로필 ${options.profile} 확인…`);
    let arn: string;
    try {
      const out = await step(deps.aws(['sts', 'get-caller-identity', '--profile', options.profile, '--region', region, '--output', 'json'], awsEnv));
      arn = String((JSON.parse(out) as { Arn?: unknown }).Arn ?? '?');
    } catch (error) {
      if (controller.signal.aborted) throw error;
      throw new AdminInputError(
        `AWS 프로필 ${options.profile} 로 인증하지 못했다 — ${firstLine(error instanceof Error ? error.message : String(error))}. ` +
          `aws configure --profile ${options.profile} 를 확인한다(런북 §1-3).`,
      );
    }
    say(`✓ AWS ${arn}`);

    // ② 로컬 포트
    if (await step(deps.portInUse(TUNNEL_LOCAL_PORT))) {
      throw new AdminInputError(
        `로컬 포트 ${String(TUNNEL_LOCAL_PORT)} 이 이미 쓰이고 있다 — 다른 터미널에 터널(aws ssm start-session)이 열려 있으면 그 터미널에서 Ctrl-C 로 닫고 다시 한다. ` +
          `무엇이 쓰는지: lsof -nP -iTCP:${String(TUNNEL_LOCAL_PORT)} -sTCP:LISTEN (이 명령은 아무것도 끄지 않는다).`,
      );
    }

    // ③ 터널
    const lookup = async (stack: string, output: string, shape: RegExp): Promise<string> => {
      let value: string;
      try {
        value = (await step(deps.aws(stackOutputArgs(options.profile, region, stack, output), awsEnv))).trim();
      } catch (error) {
        if (controller.signal.aborted) throw error;
        throw new AdminInputError(`${stack} 스택 출력 ${output} 을 읽지 못했다 — ${firstLine(error instanceof Error ? error.message : String(error))}`);
      }
      if (!shape.test(value)) throw new AdminInputError(`${stack} 스택 출력 ${output} 이 예상한 모양이 아니다: ${value.slice(0, 80) || '(빈 값)'}`);
      return value;
    };
    const instanceId = await lookup(NETWORK_STACK, NAT_OUTPUT, INSTANCE_ID);
    const dbHost = await lookup(DATA_STACK, DB_OUTPUT, RDS_HOST);
    say(`터널 여는 중… (${instanceId} → ${dbHost}:5432 → localhost:${String(TUNNEL_LOCAL_PORT)})`);
    const current = new Tunnel(deps.spawnTunnel(tunnelArgs(options.profile, region, instanceId, dbHost), awsEnv));
    tunnel = current;
    const timeoutMs = options.readyTimeoutMs ?? deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await step(
        Promise.race([
          current.ready().then(() => 'ready' as const),
          current.exited.then(() => 'exited' as const),
          new Promise<'timeout'>((resolve) => {
            timer = setTimeout(() => resolve('timeout'), timeoutMs);
          }),
        ]),
      );
      if (outcome === 'exited') throw new AdminInputError(`터널이 열리지 않고 끝났다 — ${current.tail() || '출력 없음'}${explainTunnelFailure(current.tail())}`);
      if (outcome === 'timeout') {
        throw new AdminInputError(`터널이 ${String(Math.round(timeoutMs / 1000))}초 안에 열리지 않았다 — ${current.tail() || '출력 없음'}${explainTunnelFailure(current.tail())}`);
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    say(`✓ 터널 열림 localhost:${String(TUNNEL_LOCAL_PORT)}${current.sessionId === null ? '' : ` (세션 ${current.sessionId})`}`);

    // ④ 접속 변수 — 이 프로세스 안에서만
    const result = await step(deps.dbEnv({ caBundle: options.caBundle, billingOperator: options.billingOperator }, awsEnv));
    say(`✓ DB 접속 정보 받음(화면·셸에 내지 않는다)${options.billingOperator ? ' · 요금제 쓰기 롤 포함' : ''}`);
    const webEnv: NodeJS.ProcessEnv = { ...awsEnv, ...Object.fromEntries(result.exports) };

    // ⑤ 화면 — 터널이 끊기면 닫는다
    let tunnelLost = false;
    void current.exited.then(() => {
      if (phase !== 'web') return;
      tunnelLost = true;
      say('⚠ 터널이 끊겼다(SSM 세션 유휴 20분 · 네트워크) — 화면을 닫는다. 다시 쓰려면 pnpm ops.');
      controller.abort();
    });
    phase = 'web';
    const code = await deps.runWeb(options.webArgv, { env: webEnv, io: deps.io, abort: controller.signal });
    return tunnelLost ? EXIT_FAILURE : code;
  } catch (error) {
    if (interrupted) {
      say('중단했다.');
      return EXIT_INPUT_ERROR;
    }
    throw error;
  } finally {
    phase = 'cleanup';
    if (tunnel !== null) await closeTunnel(tunnel, deps, options.profile, region, awsEnv);
    offSignal();
    offExit();
  }
}

/** 터널 그룹에 SIGINT → (유예) SIGTERM → (유예) SIGKILL, 그다음 서버 쪽 세션도 끝낸다(best effort). */
async function closeTunnel(tunnel: Tunnel, deps: OpsDeps, profile: string, region: string, env: NodeJS.ProcessEnv): Promise<void> {
  const pid = tunnel.child.pid;
  const grace = deps.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
  // 직접 자식(aws)이 끝나도 그룹(손자 session-manager-plugin)이 남을 수 있다 — 그룹이 빌 때까지 올린다.
  const groupGone = async (): Promise<boolean> => {
    const until = Date.now() + grace;
    while (Date.now() < until) {
      if (!deps.groupAlive(pid as number)) return true;
      await delay(Math.min(100, grace));
    }
    return !deps.groupAlive(pid as number);
  };
  if (pid !== undefined) {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGKILL'] as const) {
      if (!deps.groupAlive(pid)) break;
      try {
        deps.signalGroup(pid, signal);
      } catch {
        break; // 그룹이 이미 없다.
      }
      if (await groupGone()) break;
    }
  }
  // 남은 파이프를 닫는다(끝난 뒤에도 이벤트 루프를 붙잡지 않게).
  tunnel.child.stdout?.destroy();
  tunnel.child.stderr?.destroy();
  const left = pid !== undefined && deps.groupAlive(pid);
  if (tunnel.sessionId !== null) {
    await deps
      .aws(['ssm', 'terminate-session', '--profile', profile, '--region', region, '--session-id', tunnel.sessionId], env)
      .catch(() => undefined);
  }
  deps.io.err(left ? `⚠ 터널 프로세스(그룹 ${String(pid)})가 아직 살아 있다 — 확인: ps -o pid,command -g ${String(pid)}` : '터널을 닫았다.');
}

// ---------------------------------------------------------------------------
// 실제 의존성
// ---------------------------------------------------------------------------

function realAws(args: readonly string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('aws', [...args], { env, timeout: 60_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error !== null) {
        const detail = (stderr || error.message).trim();
        reject(new Error((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'aws CLI 가 없다(PATH)' : detail));
        return;
      }
      resolve(stdout);
    });
  });
}

/** 127.0.0.1 에 묶어 보고(EADDRINUSE) · 127.0.0.1·::1 로 붙어 본다(다른 주소에 묶인 리스너). 어느 쪽이든 쓰이면 true. */
async function realPortInUse(port: number): Promise<boolean> {
  const bindFails = await new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(true));
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => server.close(() => resolve(false)));
  });
  if (bindFails) return true;
  const accepts = (host: string) =>
    new Promise<boolean>((resolve) => {
      const socket = createConnection({ port, host });
      const done = (value: boolean) => {
        socket.destroy();
        resolve(value);
      };
      socket.setTimeout(500, () => done(false));
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
    });
  return (await accepts('127.0.0.1')) || (await accepts('::1'));
}

function realDeps(base: AdminDeps): OpsDeps {
  return {
    ...base,
    aws: realAws,
    spawnTunnel: (args, env) => spawn('aws', [...args], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }),
    signalGroup: (pid, signal) => process.kill(-pid, signal),
    groupAlive: (pid) => {
      try {
        process.kill(-pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
      }
    },
    portInUse: realPortInUse,
    dbEnv: (options, env) => {
      // Secrets Manager SDK 는 기본 자격 증명 체인이 `process.env.AWS_PROFILE` 을 읽는다 — 확인한 그 프로필로 맞춘다(DB 비밀은 process.env 에 올리지 않는다).
      process.env['AWS_PROFILE'] = env['AWS_PROFILE'];
      return computeDbEnv(options, env);
    },
    runWeb: web,
    onSignal: (handler) => {
      process.on('SIGINT', handler);
      process.on('SIGTERM', handler);
      return () => {
        process.off('SIGINT', handler);
        process.off('SIGTERM', handler);
      };
    },
    onExit: (handler) => {
      process.on('exit', handler);
      return () => process.off('exit', handler);
    },
  };
}

export function opsMain(argv: readonly string[], deps: AdminDeps): Promise<number> {
  return ops(argv, realDeps(deps));
}

if (isMain(import.meta.url)) await runAdminMain(opsMain);
