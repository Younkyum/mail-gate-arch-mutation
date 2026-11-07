/**
 * `https-transport.ts` — **소켓 수준에서** 연결이 고정된 IP 로 가는지 본다.
 *
 * 외부로 나가지 않는다: 루프백(127.0.0.1)에 TCP 서버를 띄우고, 존재할 수 없는 이름
 * (`*.invalid`, RFC 6761 — 어떤 리졸버도 풀지 않는다)을 그 IP 에 고정해 보낸다.
 * 서버에 연결이 도착했다면 **DNS 를 거치지 않고** 고정 IP 로 갔다는 뜻이다(이름을 풀었다면
 * ENOTFOUND 였다). TLS 는 성립하지 않지만(서버가 TLS 를 말하지 않는다) 여기서 보는 것은
 * 연결 목적지와 SNI 다 — 둘 다 핸드셰이크 첫 바이트에 있다.
 */

import { createServer, type Server, type Socket } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { createPinnedHttpsTransport, pinnedLookup } from '../../../src/webhooks/https-transport';

const HOSTNAME = 'webhook.atmark-test.invalid';

let server: Server | undefined;
const sockets: Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

/** 첫 청크를 받아 돌려주는 루프백 서버. `hold` 면 아무 말도 하지 않고 붙잡는다. */
async function listen(mode: 'close' | 'hold'): Promise<{ port: number; firstChunk: Promise<Buffer> }> {
  let deliver: (chunk: Buffer) => void = () => undefined;
  const firstChunk = new Promise<Buffer>((resolve) => {
    deliver = resolve;
  });
  server = createServer((socket) => {
    sockets.push(socket);
    socket.once('data', (chunk: Buffer) => {
      deliver(chunk);
      if (mode === 'close') socket.destroy();
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('주소 없음');
  return { port: address.port, firstChunk };
}

function request(port: number) {
  return {
    url: new URL(`https://${HOSTNAME}:${port}/hook`),
    hostname: HOSTNAME,
    address: '127.0.0.1',
    family: 4 as const,
    headers: { 'content-type': 'application/json' },
    body: '{}',
  };
}

describe('pinnedLookup', () => {
  it('어떤 이름을 물어도 고정 IP 를 돌려준다 (all 형태와 단일 형태 둘 다)', async () => {
    const lookup = pinnedLookup('93.184.215.14', 4);
    const single = await new Promise((resolve) =>
      lookup('evil.example.com', {}, (error, address, family) => resolve({ error, address, family })),
    );
    expect(single).toEqual({ error: null, address: '93.184.215.14', family: 4 });
    const all = await new Promise((resolve) => lookup('evil.example.com', { all: true }, (error, address) => resolve({ error, address })));
    expect(all).toEqual({ error: null, address: [{ address: '93.184.215.14', family: 4 }] });
  });
});

describe('고정 IP HTTPS 전송단 (루프백만)', () => {
  it('풀 수 없는 이름이어도 고정 IP 로 연결하고, SNI 에는 원래 이름을 싣는다', async () => {
    const { port, firstChunk } = await listen('close');
    const result = await createPinnedHttpsTransport({ timeoutMs: 2000 }).post(request(port));

    const hello = await firstChunk;
    // TLS ClientHello 의 첫 바이트는 0x16(handshake). 연결이 여기 왔다 = DNS 를 거치지 않았다.
    expect(hello[0]).toBe(0x16);
    // SNI 확장은 평문이다 — 인증서 검증이 원래 이름으로 이뤄진다는 증거.
    expect(hello.includes(Buffer.from(HOSTNAME))).toBe(true);
    // TLS 가 성립하지 않았으므로 네트워크 오류이고, **코드만** 남는다(메시지는 호스트명을 싣는다).
    expect(result.kind).toBe('network_error');
    if (result.kind === 'network_error') expect(result.code).toMatch(/^[A-Z0-9_]+$/);
  });

  it('응답이 없으면 상한 안에서 timeout 으로 끝난다', async () => {
    const { port } = await listen('hold');
    const started = Date.now();
    const result = await createPinnedHttpsTransport({ timeoutMs: 200 }).post(request(port));
    expect(result).toEqual({ kind: 'timeout' });
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
