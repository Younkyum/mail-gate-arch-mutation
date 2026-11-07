/**
 * `pnpm tsx scripts/realtime-smoke.ts [wss-url]` — 실시간 WebSocket(묶음 E) 배포 스모크(wscat 대신). deploy §46.
 *
 * 토큰은 **파일에서만** 읽는다(`ATMARK_SMOKE_TOKEN_FILE` — 0600, `messages:read` 가 있는 에이전트 토큰). 화면 · 로그에 토큰을 찍지 않는다 — 실패 메시지에도.
 * 주소는 인자 · `ATMARK_REALTIME_URL` · 기본 `wss://realtime.atmark.ai` 순. 커스텀 도메인 전이면 CDK 출력 `RealtimeUrl`(execute-api)을 넘긴다.
 *
 * 확인하는 것:
 *   ① 쿼리 문자열 토큰은 **거부된다**(핸드셰이크 실패) — 가짜 토큰 모양으로 시험한다(진짜 토큰을 URL 에 싣지 않는다).
 *   ② 토큰 없는 연결은 거부된다.
 *   ③ 하위 프로토콜 `atmark.v1, bearer.<토큰>` → 열린다 · 서버가 고른 프로토콜 = `atmark.v1`.
 *   ④ `{"action":"ping"}` → `{"type":"pong"}` · `{"action":"subscribe"}` → `{"type":"subscribed"}`.
 *   ⑤ (선택) `ATMARK_SMOKE_LISTEN_SECONDS` 동안 들어온 이벤트의 종류 · id 만 보인다(본문은 애초에 없다).
 */

import { readFileSync, statSync } from 'node:fs';

const DEFAULT_URL = 'wss://realtime.atmark.ai';
const TIMEOUT_MS = 10_000;

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function readToken(): string {
  const path = process.env['ATMARK_SMOKE_TOKEN_FILE'];
  if (path === undefined || path === '') fail('ATMARK_SMOKE_TOKEN_FILE 이 없다(0600 파일에 에이전트 토큰 하나).');
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) fail(`${path} 권한이 ${mode.toString(8)} 이다 — chmod 600 으로.`);
  const token = readFileSync(path, 'utf8').trim();
  if (!/^atk_agent_[A-Za-z0-9_-]{43}$/.test(token)) fail('토큰 파일의 내용이 에이전트 토큰 모양이 아니다(값은 출력하지 않는다).');
  return token;
}

/** 열리면 소켓, 거부되면 null. */
function open(url: string, protocols: string[] | undefined): Promise<WebSocket | null> {
  return new Promise((resolve) => {
    const socket = protocols === undefined ? new WebSocket(url) : new WebSocket(url, protocols);
    const timer = setTimeout(() => {
      socket.close();
      resolve(null);
    }, TIMEOUT_MS);
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

function next(socket: WebSocket, wanted: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${wanted} 응답이 ${String(TIMEOUT_MS)}ms 안에 오지 않았다`)), TIMEOUT_MS);
    const onMessage = (event: MessageEvent): void => {
      const parsed = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (parsed['type'] !== wanted) return;
      clearTimeout(timer);
      socket.removeEventListener('message', onMessage);
      resolve(parsed);
    };
    socket.addEventListener('message', onMessage);
  });
}

async function main(): Promise<void> {
  const url = process.argv[2] ?? process.env['ATMARK_REALTIME_URL'] ?? DEFAULT_URL;
  if (!/^wss:\/\//.test(url)) fail(`wss:// 주소가 아니다: ${url}`);
  const token = readToken();
  console.log(`대상: ${url}`);

  const fakeQueryToken = `atk_agent_${'0'.repeat(43)}`;
  const viaQuery = await open(`${url}?token=${fakeQueryToken}`, undefined);
  if (viaQuery !== null) {
    viaQuery.close();
    fail('① 쿼리 문자열 토큰 연결이 열렸다 — 거부돼야 한다');
  }
  console.log('✓ ① 쿼리 문자열 토큰 → 거부');

  const anonymous = await open(url, undefined);
  if (anonymous !== null) {
    anonymous.close();
    fail('② 토큰 없는 연결이 열렸다');
  }
  console.log('✓ ② 토큰 없음 → 거부');

  const socket = await open(url, ['atmark.v1', `bearer.${token}`]);
  if (socket === null) fail('③ 하위 프로토콜 토큰 연결이 열리지 않았다(토큰 권한 messages:read · 에이전트/조직 상태 · 5개 상한 확인)');
  if (socket.protocol !== 'atmark.v1') fail(`③ 서버가 고른 프로토콜이 atmark.v1 이 아니다: "${socket.protocol}"`);
  console.log('✓ ③ 하위 프로토콜 → 열림 · protocol=atmark.v1');

  const events: string[] = [];
  socket.addEventListener('message', (event: MessageEvent) => {
    const parsed = JSON.parse(String(event.data)) as { type?: string; id?: string; data?: { message_id?: string; approval_id?: string; risk?: { level?: string } } };
    if (parsed.type === 'message.received' || parsed.type === 'approval.resolved') {
      events.push(`${parsed.type} ${parsed.data?.message_id ?? parsed.data?.approval_id ?? '?'}${parsed.data?.risk?.level === undefined ? '' : ` risk=${parsed.data.risk.level}`}`);
    }
  });

  const pong = next(socket, 'pong');
  socket.send(JSON.stringify({ action: 'ping' }));
  await pong;
  const subscribed = next(socket, 'subscribed');
  socket.send(JSON.stringify({ action: 'subscribe' }));
  console.log(`✓ ④ ping → pong · subscribe → ${JSON.stringify((await subscribed)['events'])}`);

  const listen = Number(process.env['ATMARK_SMOKE_LISTEN_SECONDS'] ?? '0');
  if (Number.isFinite(listen) && listen > 0) {
    console.log(`… ${String(listen)}초 동안 이벤트를 기다린다(이 에이전트에게 메일을 한 통 보내 보라)`);
    await new Promise((resolve) => setTimeout(resolve, listen * 1000));
    console.log(events.length === 0 ? '  (이벤트 없음)' : events.map((line) => `  ← ${line}`).join('\n'));
  }
  socket.close(1000);
  console.log('스모크 통과');
}

main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
