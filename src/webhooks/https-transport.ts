/**
 * src/webhooks/https-transport.ts — 웹훅의 실제 네트워크 I/O. **`src/**` 에서 네트워크 원시
 * 모듈(`node:https`·`node:dns` 등)을 import 하는 유일한 파일이다**
 * (`test/arch/network-egress.arch.test.ts`).
 *
 * 단일 파일로 묶는 이유는 SES 전송단(Layer A)과 같다: 외부로 나가는 경로가 하나면
 * SSRF 검사를 **우회할 수 있는 경로도 하나**이고, 그 하나는 `dispatcher.ts` 가 고정한
 * IP 만 받는다.
 *
 * **DNS 재바인딩 방어의 실행 지점.** `https.request` 에 `lookup` 을 넘겨 **어떤 호스트명을
 * 물어도 검사 통과한 IP 를 돌려주게** 한다. 호스트명은 그대로 두므로 TLS SNI·인증서 검증·
 * `Host` 헤더는 원래 이름으로 이뤄진다 — IP 로 바꿔 쓰면 인증서 검증이 깨지고, 그것을
 * 끄는 순간(`rejectUnauthorized: false`) 중간자가 열린다.
 *
 * 하지 않는 것: 리다이렉트 추적(Node 는 원래 따라가지 않는다), 커넥션 재사용
 * (`agent: false` — 풀의 소켓이 다른 목적지의 것일 여지를 없앤다), 응답 본문 읽기
 * (상태 코드만 본다; 수신측이 큰 본문으로 워커를 붙잡지 못하게 즉시 끊는다).
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';

import type { HostResolver } from './destination';
import type { WebhookHttpRequest, WebhookTransport, WebhookTransportResult } from './dispatcher';

/** 한 시도의 전체 상한. `DEFAULT_LEASE_MS`(60초)보다 충분히 짧아야 한다. */
const WEBHOOK_TIMEOUT_MS = 10_000;

/** 시스템 리졸버(getaddrinfo). **모든** 주소를 돌려준다 — 하나라도 막힌 대역이면 거부해야 하므로. */
export function createSystemResolver(): HostResolver {
  return async (hostname) => {
    const results = await dnsLookup(hostname, { all: true, verbatim: true });
    return results.map((entry) => ({ address: entry.address, family: entry.family === 6 ? 6 : 4 }));
  };
}

/**
 * 어떤 이름을 물어도 `address` 를 돌려주는 lookup. Node 22 의 `net.connect` 는
 * `autoSelectFamily` 때문에 `all: true` 로 부르므로 두 형태를 다 답한다.
 */
export function pinnedLookup(address: string, family: 4 | 6): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all === true) {
      callback(null, [{ address, family }]);
      return;
    }
    callback(null, address, family);
  };
}

/** 오류에서 **코드만** 남긴다. 메시지에는 호스트명·URL 이 들어 있다 — 로그로 가면 샌다. */
function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? code : 'UNKNOWN';
}

export function createPinnedHttpsTransport(options: { readonly timeoutMs?: number } = {}): WebhookTransport {
  const timeoutMs = options.timeoutMs ?? WEBHOOK_TIMEOUT_MS;

  return {
    post(outgoing: WebhookHttpRequest): Promise<WebhookTransportResult> {
      return new Promise((resolve) => {
        let settled = false;
        let deadline: NodeJS.Timeout | undefined;
        const settle = (result: WebhookTransportResult): void => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          resolve(result);
        };

        const req = request({
          method: 'POST',
          protocol: 'https:',
          hostname: outgoing.hostname,
          port: outgoing.url.port === '' ? 443 : Number(outgoing.url.port),
          path: `${outgoing.url.pathname}${outgoing.url.search}`,
          headers: { ...outgoing.headers, 'content-length': String(Buffer.byteLength(outgoing.body, 'utf8')) },
          // IP 리터럴에는 SNI 를 보내지 않는다(RFC 6066 §3).
          ...(isIP(outgoing.hostname) === 0 ? { servername: outgoing.hostname } : {}),
          lookup: pinnedLookup(outgoing.address, outgoing.family),
          agent: false,
        });

        deadline = setTimeout(() => {
          settle({ kind: 'timeout' });
          req.destroy();
        }, timeoutMs);

        req.on('response', (response) => {
          settle({ kind: 'response', status: response.statusCode ?? 0 });
          response.destroy();
        });
        req.on('error', (error) => settle({ kind: 'network_error', code: errorCode(error) }));
        req.end(outgoing.body);
      });
    },
  };
}
