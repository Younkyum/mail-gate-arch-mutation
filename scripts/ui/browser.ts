/**
 * scripts/ui/browser.ts — 헤드리스 Chrome 과 미리보기 서버를 다루는 공용 조각(`pnpm ui:shots` · `pnpm gen:images`). 새 npm 의존성 없이
 * Node 22 의 전역 `WebSocket` 으로 Chrome DevTools 프로토콜(CDP)을 직접 말한다(퍼펫티어 없음). 부작용이 없다 — import 만으로는 아무것도 띄우지 않는다.
 *
 * 한 기계에서 Chrome 은 하나만 — 여러 작업자가 동시에 찍을 때는 호출하는 쪽이 잠금 디렉터리를 먼저 잡는다(`scripts/ui/README.md`).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
/** 미리보기 포트 — 기본 4173 · 4174. 다른 작업자의 미리보기가 떠 있으면 `ATMARK_UI_CONSOLE_PORT` · `ATMARK_UI_SITE_PORT` 로 비켜 띄운다(자식 프로세스도 같은 값을 읽는다). */
export const CONSOLE_PORT = Number(process.env['ATMARK_UI_CONSOLE_PORT'] ?? 4173);
export const SITE_PORT = Number(process.env['ATMARK_UI_SITE_PORT'] ?? 4174);
/** Chrome 실행 파일 — `ATMARK_CHROME` 환경 변수가 있으면 그것(다른 경로·Chromium·CI), 없으면 macOS 기본 위치. */
export const CHROME_PATH = process.env['ATMARK_CHROME'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- 미리보기 서버: 있으면 재사용, 없으면 띄운다 ----------

async function isUp(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${String(port)}/`, { signal: AbortSignal.timeout(1000) });
    return res.status > 0;
  } catch {
    return false;
  }
}

async function waitUntilUp(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isUp(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`미리보기 서버가 ${String(timeoutMs)}ms 안에 뜨지 않음 (포트 ${String(port)})`);
}

export async function ensurePreviewServer(): Promise<{ readonly proc: ChildProcess | null }> {
  if ((await isUp(CONSOLE_PORT)) && (await isUp(SITE_PORT))) {
    console.log('[ui] 이미 떠 있는 미리보기 서버를 그대로 쓴다.');
    return { proc: null };
  }
  console.log('[ui] 미리보기 서버를 띄운다 (pnpm exec tsx scripts/ui/preview.ts)…');
  const proc = spawn('pnpm', ['exec', 'tsx', 'scripts/ui/preview.ts'], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'inherit'] });
  proc.stdout.on('data', (chunk: Buffer) => process.stdout.write(`[preview] ${chunk.toString()}`));
  await waitUntilUp(CONSOLE_PORT, 15000);
  await waitUntilUp(SITE_PORT, 15000);
  return { proc };
}

// ---------- Chrome 프로세스 ----------

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = address !== null && typeof address === 'object' ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

export interface ChromeHandle {
  readonly proc: ChildProcess;
  readonly port: number;
  readonly userDataDir: string;
}

async function waitForCdpHttp(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${String(port)}/json/version`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return;
    } catch {
      // 아직 준비 안 됨 — 재시도.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('Chrome CDP 가 준비되지 않음');
}

export async function launchChrome(): Promise<ChromeHandle> {
  const port = await getFreePort();
  const userDataDir = mkdtempSync(join(tmpdir(), 'atmark-ui-shots-'));
  const proc = spawn(
    CHROME_PATH,
    [
      '--headless=new',
      '--disable-gpu',
      `--remote-debugging-port=${String(port)}`,
      `--user-data-dir=${userDataDir}`,
      '--hide-scrollbars',
      '--force-color-profile=srgb',
      '--window-size=1440,900',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  const handle = { proc, port, userDataDir };
  try {
    await waitForCdpHttp(port, 15000);
  } catch (error) {
    // 떴지만 CDP 가 안 열렸으면 여기서 정리한다 — 호출자는 핸들을 받지 못하므로 치울 수 없다.
    killChrome(handle);
    throw error;
  }
  return handle;
}

export function killChrome(handle: ChromeHandle): void {
  try {
    handle.proc.kill('SIGKILL');
  } catch {
    // 이미 죽었으면 무시.
  }
  try {
    rmSync(handle.userDataDir, { recursive: true, force: true });
  } catch {
    // 정리 실패는 치명적이지 않다.
  }
}

// ---------- CDP 클라이언트(JSON-RPC over WebSocket, 도메인 이벤트 구독) ----------

interface CdpMessage {
  readonly id?: number;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly result?: unknown;
  readonly error?: { readonly message: string };
}

export class Cdp {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  private readonly listeners = new Map<string, ((params: Record<string, unknown>) => void)[]>();

  async connect(wsUrl: string): Promise<void> {
    const ws = new WebSocket(wsUrl);
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('CDP WebSocket 연결 실패')));
    });
    ws.addEventListener('message', (ev: MessageEvent) => {
      const msg = JSON.parse(String(ev.data)) as CdpMessage;
      if (msg.id !== undefined) {
        const waiting = this.pending.get(msg.id);
        if (waiting === undefined) return;
        this.pending.delete(msg.id);
        if (msg.error !== undefined) waiting.reject(new Error(msg.error.message));
        else waiting.resolve(msg.result);
      } else if (msg.method !== undefined) {
        for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params ?? {});
      }
    });
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    const ws = this.ws;
    if (ws === null) throw new Error('CDP 연결 전');
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method: string, fn: (params: Record<string, unknown>) => void): void {
    const arr = this.listeners.get(method) ?? [];
    arr.push(fn);
    this.listeners.set(method, arr);
  }

  close(): void {
    this.ws?.close();
  }
}
