/**
 * `pnpm ops` — 터널 · 접속 변수 · 운영자 화면을 한 명령으로(`scripts/admin/ops.ts`). AWS·자식 프로세스·화면은 전부 가짜(실제 AWS 호출 0).
 *
 * 되돌리면 빨개져야 하는 것:
 *   - 순서: 프로필 확인(sts) → 15432 검사 → 스택 출력 → 터널(런북 §0 과 같은 인자) → "Waiting for connections" → 접속 변수(프로세스 안) → 화면.
 *   - 15432 가 쓰이고 있으면 터널을 띄우지 않고 끝난다(아무것도 죽이지 않는다) · 프로필이 안 되면 터널 0.
 *   - 환경 변수 자격 증명(AWS_ACCESS_KEY_ID)이 있으면 거부.
 *   - 화면이 끝나든 · 터널이 먼저 끝나든 · 시간이 지나든 · 화면이 던지든 · Ctrl-C 든 **터널 그룹을 닫는다**(SIGINT → SIGTERM → SIGKILL) + terminate-session.
 *   - 터널이 화면 도중 끊기면 화면에 abort 가 간다.
 *   - 비밀(DB URL 의 비밀번호)은 출력에 없다 · 화면은 그 URL 을 env 로 받는다.
 */

import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';

import { describe, expect, it, vi } from 'vitest';

import { AdminInputError, type AdminIo } from '../../../scripts/admin/common';
import type { DbEnvOptions, DbEnvResult } from '../../../scripts/admin/db-env';
import { DATA_STACK, DB_OUTPUT, NAT_OUTPUT, NETWORK_STACK, ops, parseOpsArgs, tunnelArgs, type OpsDeps } from '../../../scripts/admin/ops';
import type { WebDeps } from '../../../scripts/admin/web';

const PASSWORD = 'S3cr3t-pw-do-not-print';
const OWNER_URL = `postgres://atmark_owner:${PASSWORD}@localhost:15432/atmark?sslmode=verify-ca`;
const NAT = 'i-0123456789abcdef0';
const DB = 'atmark-db.abc123.ap-northeast-2.rds.amazonaws.com';

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  /** 손자(plugin)가 살아 있나 — 그룹 생존 판정에 쓴다. */
  grandchild = true;
  /** 이 신호를 받으면 끝난다(없으면 무시 — 에스컬레이션을 본다). `grandchildDiesOn` 은 손자가 끝나는 신호. */
  constructor(
    readonly diesOn: readonly NodeJS.Signals[] = ['SIGINT'],
    readonly grandchildDiesOn: readonly NodeJS.Signals[] = diesOn,
  ) {
    super();
  }
  get groupAlive(): boolean {
    return (this.exitCode === null && this.signalCode === null) || this.grandchild;
  }
  finish(signal: NodeJS.Signals | null, code: number | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.signalCode = signal;
    this.exitCode = code;
    this.emit('exit', code, signal);
  }
  say(text: string): void {
    this.stdout.write(text);
  }
}

interface Harness {
  deps: OpsDeps;
  errs: string[];
  outs: string[];
  awsCalls: string[][];
  signals: NodeJS.Signals[];
  child: FakeChild | null;
  webCalls: { argv: readonly string[]; deps: WebDeps }[];
  fireSignal: () => void;
  exitHooks: number;
}

function harness(opts: {
  portBusy?: boolean;
  stsFails?: boolean;
  child?: () => FakeChild;
  onSpawn?: (child: FakeChild) => void;
  web?: (argv: readonly string[], deps: WebDeps, h: Harness) => Promise<number>;
  env?: NodeJS.ProcessEnv;
} = {}): Harness {
  const errs: string[] = [];
  const outs: string[] = [];
  const io: AdminIo = { out: (l) => outs.push(l), err: (l) => errs.push(l), interactive: false, ask: async () => '' };
  let signalHandler: (() => void) | null = null;
  const h: Harness = {
    errs,
    outs,
    awsCalls: [],
    signals: [],
    child: null,
    webCalls: [],
    fireSignal: () => signalHandler?.(),
    exitHooks: 0,
    deps: null as unknown as OpsDeps,
  };
  h.deps = {
    env: opts.env ?? { USER: 'jin', PATH: '/usr/bin' },
    io,
    aws: vi.fn(async (args: readonly string[]) => {
      h.awsCalls.push([...args]);
      if (args[0] === 'sts') {
        if (opts.stsFails === true) throw new Error('An error occurred (InvalidClientTokenId)\nmore');
        return JSON.stringify({ Arn: 'arn:aws:iam::111122223333:user/atmark-admin' });
      }
      if (args[0] === 'cloudformation') return args.includes('AtmarkNetwork') ? `${NAT}\n` : `${DB}\n`;
      return '';
    }),
    spawnTunnel: vi.fn(() => {
      const child = opts.child?.() ?? new FakeChild();
      h.child = child;
      if (opts.onSpawn !== undefined) opts.onSpawn(child);
      else
        setTimeout(() => {
          child.say('\nStarting session with SessionId: atmark-admin-0abc\n');
          child.say('Port 15432 opened for sessionId atmark-admin-0abc.\nWaiting for connections...\n');
        }, 5);
      return child as unknown as ChildProcess;
    }),
    signalGroup: vi.fn((pid: number, signal: NodeJS.Signals) => {
      expect(pid).toBe(4242);
      h.signals.push(signal);
      const child = h.child;
      if (child !== null && child.grandchildDiesOn.includes(signal)) child.grandchild = false;
      if (child !== null && child.diesOn.includes(signal)) setTimeout(() => child.finish(signal), 1);
    }),
    groupAlive: vi.fn(() => h.child?.groupAlive ?? false),
    portInUse: vi.fn(async () => opts.portBusy === true),
    dbEnv: vi.fn(async (options: DbEnvOptions): Promise<DbEnvResult> => ({
      exports: [
        ['DATABASE_MIGRATION_URL', OWNER_URL] as const,
        ['ATMARK_ENV', 'production'] as const,
        ...(options.billingOperator === true ? ([['DATABASE_BILLING_OPERATOR_URL', OWNER_URL.replace('atmark_owner', 'atmark_billing_operator')]] as const) : []),
      ],
      localPort: 15432,
      host: DB,
    })),
    runWeb: vi.fn(async (argv: readonly string[], deps: WebDeps) => {
      h.webCalls.push({ argv, deps });
      return opts.web === undefined ? 0 : opts.web(argv, deps, h);
    }),
    onSignal: (handler) => {
      signalHandler = handler;
      return () => {
        signalHandler = null;
      };
    },
    onExit: () => {
      h.exitHooks += 1;
      return () => {
        h.exitHooks -= 1;
      };
    },
    readyTimeoutMs: 200,
    stopGraceMs: 20,
  };
  return h;
}

const noSecret = (h: Harness) => expect([...h.errs, ...h.outs].join('\n')).not.toContain(PASSWORD);

describe('pnpm ops 인자', () => {
  it('화면 인자는 그대로 넘기고, 틀리면 터널 전에 거부', () => {
    expect(parseOpsArgs(['--by', 'jin', '--no-open', '--billing-operator'])).toEqual({
      profile: 'atmark',
      billingOperator: true,
      caBundle: undefined,
      readyTimeoutMs: undefined,
      webArgv: ['--by', 'jin', '--no-open'],
    });
    expect(() => parseOpsArgs(['--idle-minutes', '0'])).toThrow(AdminInputError);
    expect(() => parseOpsArgs(['--host', '0.0.0.0'])).toThrow();
    expect(() => parseOpsArgs(['--profile', 'a b'])).toThrow(AdminInputError);
    expect(() => parseOpsArgs(['--ready-timeout', '1'])).toThrow(AdminInputError);
  });

  it('터널 명령은 런북 §0 과 같다', () => {
    expect(tunnelArgs('atmark', 'ap-northeast-2', NAT, DB)).toEqual([
      'ssm', 'start-session', '--profile', 'atmark', '--region', 'ap-northeast-2', '--target', NAT,
      '--document-name', 'AWS-StartPortForwardingSessionToRemoteHost',
      '--parameters', `host=${DB},portNumber=5432,localPortNumber=15432`,
    ]);
  });

  it('스택·출력 이름은 CDK 와 같다(인프라를 import 하지 않고 소스로 대조)', () => {
    const app = readFileSync('infra/cdk/app.ts', 'utf8');
    expect(app).toContain(`new NetworkStack(app, '${NETWORK_STACK}'`);
    expect(app).toContain(`new DataStack(app, '${DATA_STACK}'`);
    expect(readFileSync('infra/cdk/stacks/network-stack.ts', 'utf8')).toContain(`new cdk.CfnOutput(this, '${NAT_OUTPUT}'`);
    expect(readFileSync('infra/cdk/stacks/data-stack.ts', 'utf8')).toContain(`new cdk.CfnOutput(this, '${DB_OUTPUT}'`);
  });
});

describe('pnpm ops 흐름', () => {
  it('정상: 순서대로 열고, 화면이 끝나면 터널을 닫는다(SIGINT · terminate-session) · 비밀은 출력에 없다', async () => {
    const h = harness();
    expect(await ops(['--by', 'jin', '--billing-operator'], h.deps)).toBe(0);
    expect(h.awsCalls.map((a) => a.slice(0, 2).join(' '))).toEqual([
      'sts get-caller-identity',
      'cloudformation describe-stacks',
      'cloudformation describe-stacks',
      'ssm terminate-session',
    ]);
    expect(h.awsCalls[0]).toContain('atmark');
    expect(h.awsCalls[3]).toEqual(['ssm', 'terminate-session', '--profile', 'atmark', '--region', 'ap-northeast-2', '--session-id', 'atmark-admin-0abc']);
    expect(h.deps.spawnTunnel).toHaveBeenCalledWith(tunnelArgs('atmark', 'ap-northeast-2', NAT, DB), expect.objectContaining({ AWS_PROFILE: 'atmark' }));
    // 화면은 접속 변수를 env 로 받는다(프로세스 안) — 셸 export 가 아니다.
    expect(h.webCalls).toHaveLength(1);
    expect(h.webCalls[0]?.argv).toEqual(['--by', 'jin']);
    expect(h.webCalls[0]?.deps.env['DATABASE_MIGRATION_URL']).toBe(OWNER_URL);
    expect(h.webCalls[0]?.deps.env['DATABASE_BILLING_OPERATOR_URL']).toContain('atmark_billing_operator');
    expect(h.webCalls[0]?.deps.env['AWS_PROFILE']).toBe('atmark');
    expect(h.deps.dbEnv).toHaveBeenCalledWith({ caBundle: undefined, billingOperator: true }, expect.objectContaining({ AWS_PROFILE: 'atmark' }));
    expect(h.signals).toEqual(['SIGINT']);
    expect(h.child?.signalCode).toBe('SIGINT');
    expect(h.exitHooks).toBe(0);
    expect(h.errs.some((l) => l.includes('터널을 닫았다'))).toBe(true);
    noSecret(h);
  });

  it('15432 가 쓰이고 있으면 터널을 띄우지 않고 설명하고 끝난다', async () => {
    const h = harness({ portBusy: true });
    await expect(ops([], h.deps)).rejects.toThrow(/15432 이 이미 쓰이고 있다[\s\S]*lsof/);
    expect(h.deps.spawnTunnel).not.toHaveBeenCalled();
    expect(h.signals).toEqual([]);
    expect(h.webCalls).toEqual([]);
  });

  it('프로필 인증이 안 되면 터널 0 · 첫 줄만 보인다', async () => {
    const h = harness({ stsFails: true });
    const error = await ops([], h.deps).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdminInputError);
    expect(String((error as Error).message)).toMatch(/InvalidClientTokenId/);
    expect(String((error as Error).message)).not.toContain('more');
    expect(h.deps.spawnTunnel).not.toHaveBeenCalled();
    expect(h.deps.portInUse).not.toHaveBeenCalled();
  });

  it('환경 변수 자격 증명이 있으면 거부', async () => {
    const h = harness({ env: { AWS_ACCESS_KEY_ID: 'AKIA…' } });
    await expect(ops([], h.deps)).rejects.toThrow(/AWS_ACCESS_KEY_ID/);
    expect(h.deps.aws).not.toHaveBeenCalled();
  });

  it('터널이 준비 전에 끝나면 화면 0 · 이유(플러그인 없음)를 알려 준다', async () => {
    const h = harness({
      onSpawn: (child) =>
        setTimeout(() => {
          child.stderr.write('SessionManagerPlugin is not found. Please refer to SessionManager Documentation\n');
          setTimeout(() => {
            child.grandchild = false;
            child.finish(null, 255);
          }, 2);
        }, 2),
    });
    await expect(ops([], h.deps)).rejects.toThrow(/열리지 않고 끝났다[\s\S]*§1-1/);
    expect(h.webCalls).toEqual([]);
    expect(h.deps.dbEnv).not.toHaveBeenCalled();
  });

  it('시간 안에 준비되지 않으면 터널을 닫는다 — SIGINT 를 무시하면 SIGTERM, 그다음 SIGKILL', async () => {
    const h = harness({ child: () => new FakeChild(['SIGKILL']), onSpawn: () => undefined });
    await expect(ops([], h.deps)).rejects.toThrow(/초 안에 열리지 않았다/);
    expect(h.signals).toEqual(['SIGINT', 'SIGTERM', 'SIGKILL']);
    expect(h.child?.signalCode).toBe('SIGKILL');
    expect(h.webCalls).toEqual([]);
    // 세션 id 를 못 받았으면 terminate-session 은 없다.
    expect(h.awsCalls.some((a) => a[1] === 'terminate-session')).toBe(false);
  });

  it('직접 자식(aws)이 SIGINT 로 끝나도 손자(plugin)가 남으면 그룹에 SIGTERM · SIGKILL 까지 올린다', async () => {
    const h = harness({ child: () => new FakeChild(['SIGINT'], ['SIGKILL']) });
    expect(await ops([], h.deps)).toBe(0);
    expect(h.signals).toEqual(['SIGINT', 'SIGTERM', 'SIGKILL']);
    expect(h.child?.groupAlive).toBe(false);
    expect(h.errs.some((l) => l.includes('터널을 닫았다'))).toBe(true);
  });

  it('화면이 던져도(롤 거부 등) 터널을 닫는다', async () => {
    const h = harness({
      web: async () => {
        throw new AdminInputError('관리 CLI 는 소유자 롤로 붙는다');
      },
    });
    await expect(ops([], h.deps)).rejects.toThrow(/소유자 롤/);
    expect(h.signals).toEqual(['SIGINT']);
    expect(h.child?.signalCode).toBe('SIGINT');
  });

  it('화면 도중 터널이 끊기면 화면에 abort 가 가고 exit 1', async () => {
    const h = harness({
      web: (_argv, deps, hh) =>
        new Promise<number>((resolve) => {
          deps.abort?.addEventListener('abort', () => resolve(1));
          setTimeout(() => {
            if (hh.child !== null) hh.child.grandchild = false;
            hh.child?.finish(null, 0);
          }, 5);
        }),
    });
    expect(await ops([], h.deps)).toBe(1);
    expect(h.errs.some((l) => l.includes('터널이 끊겼다'))).toBe(true);
    // 이미 끝난 그룹에는 신호를 보내지 않는다.
    expect(h.signals).toEqual([]);
  });

  it('준비를 기다리는 중 Ctrl-C 면 화면 없이 터널을 닫고 끝난다', async () => {
    let hh: Harness | null = null;
    const h = harness({
      onSpawn: () => {
        setTimeout(() => hh?.fireSignal(), 5);
      },
    });
    hh = h;
    expect(await ops([], h.deps)).toBe(2);
    expect(h.webCalls).toEqual([]);
    expect(h.signals).toEqual(['SIGINT']);
    expect(h.errs).toContain('중단했다.');
  });
});
