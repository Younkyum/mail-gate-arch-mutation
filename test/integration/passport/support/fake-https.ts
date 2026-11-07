/**
 * **가짜 HTTPS 오리진** — 독립 did:web 리졸버(`web-did-resolver` 3, 런타임 전역 `fetch` 를 쓴다)가 실제 네트워크 없이
 * `https://id.atmark.ai/...` 를 받게 한다. `globalThis.fetch` 를 잠시 바꿔 끼우고, 준비된 바이트만 돌려준다.
 * **목록에 없는 URL 은 404** — 리졸버가 엉뚱한 경로를 부르면(예: 경로 스킴 변경) 테스트가 빨개진다. 반드시 `restore()` 한다.
 * **한 번에 하나만.** 이미 설치돼 있으면 던진다 — 겹쳐 설치하면 나중 `restore()` 가 가짜를 "원래 fetch" 로 되돌려 놓는다.
 */

let installed = false;

export interface FakeHttps {
  readonly requested: string[];
  restore(): void;
}

export function serveOverFakeHttps(files: ReadonlyMap<string, string>): FakeHttps {
  if (installed) throw new Error('serveOverFakeHttps: 이미 설치돼 있다 — 먼저 restore() 한다');
  installed = true;
  const original = globalThis.fetch;
  const requested: string[] = [];
  const fake = (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requested.push(url);
    const body = files.get(url);
    return Promise.resolve(
      body === undefined
        ? new Response('', { status: 404, statusText: 'Not Found' })
        : new Response(body, { status: 200, statusText: 'OK', headers: { 'content-type': 'application/did+json' } }),
    );
  };
  globalThis.fetch = fake as typeof fetch;
  return {
    requested,
    restore() {
      if (globalThis.fetch !== fake) return; // 두 번째 restore 는 아무것도 하지 않는다.
      globalThis.fetch = original;
      installed = false;
    },
  };
}
