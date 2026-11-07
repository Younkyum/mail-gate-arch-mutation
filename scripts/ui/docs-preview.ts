/**
 * `pnpm ui:docs` — 문서 사이트(`docs.atmark.ai`)를 로컬에서 띄운다(`http://127.0.0.1:4175`, 127.0.0.1 에만 묶인다).
 *
 * 진짜 핸들러(`src/docs/http.ts` `handleDocsRequest`)를 그대로 부르되, 원문은 생성 값 파일이 아니라 **디스크의 콘텐츠 폴더**
 * (`src/docs/content/**`)에서 매 요청 다시 읽는다 — 작성자가 파일을 저장하고 새로 고치면 바로 보인다(`pnpm gen:docs` 없이).
 * 링크 오류는 멈추지 않고(`strict: false`) 터미널에 적는다(깨진 링크는 `#`). 문법 오류는 500 과 함께 메시지를 낸다.
 * 라우팅·헤더·CSP 는 운영과 같다. 다른 포트는 `--port <n>`. 꺼진 문서 플래그를 미리 보려면 `--features customDomains`(쉼표로 여럿 —
 * `DOCS_FEATURES` 위에 켠다, 미리보기에서만).
 */

import { createServer, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';

import { createDocsRuntime, handleDocsRequest, type DocsRuntime } from '../../src/docs/http';
import { DOCS_FEATURES } from '../../src/docs/constants';
import { readContentSources } from '../gen-docs';

export const DOCS_PORT = 4175;

let lastProblems = '';
/** `--features a,b` — 미리보기에서만 켜는 문서 플래그(운영 값 `DOCS_FEATURES` 위에). */
let extraFeatures: Readonly<Record<string, boolean>> = {};

function freshRuntime(): DocsRuntime {
  const rt = createDocsRuntime(readContentSources(), { strict: false, features: { ...DOCS_FEATURES, ...extraFeatures } });
  const problems = rt.site.problems.join('\n');
  if (problems !== lastProblems) {
    lastProblems = problems;
    if (problems !== '') console.warn(`[ui:docs] 링크 문제 ${String(rt.site.problems.length)}건:\n${problems}`);
  }
  return rt;
}

let cached: { at: number; rt: DocsRuntime } | undefined;

export function startDocsPreview(port: number = DOCS_PORT): Promise<Server> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    try {
      // HTML 요청마다 다시 읽는다(자산 요청은 1초 안의 것을 재사용 — 한 페이지가 폰트 여럿을 부른다).
      const now = Date.now();
      if (cached === undefined || now - cached.at > 1000) cached = { at: now, rt: freshRuntime() };
      const result = handleDocsRequest(
        {
          rawPath: url.pathname,
          rawQueryString: url.search.startsWith('?') ? url.search.slice(1) : '',
          headers: { host: 'docs.atmark.ai' },
          requestContext: { http: { method: req.method ?? 'GET' } },
        },
        cached.rt,
      );
      const headers: Record<string, string> = { ...result.headers };
      // 로컬은 http 라 HSTS 를 걸지 않는다. 301 의 정본 출처는 로컬 출처로 바꾼다.
      delete headers['strict-transport-security'];
      // 작성 중 미리보기 — 브라우저가 5분 캐시로 옛 페이지를 보이지 않게(자산은 해시 경로라 그대로).
      if (!url.pathname.startsWith('/_')) headers['cache-control'] = 'no-store';
      if (headers['location'] !== undefined) headers['location'] = headers['location'].replace('https://docs.atmark.ai', `http://127.0.0.1:${String(port)}`);
      res.writeHead(result.statusCode, headers);
      res.end(result.isBase64Encoded ? Buffer.from(result.body, 'base64') : result.body);
    } catch (error) {
      cached = undefined;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[ui:docs] ${message}`);
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`docs build error\n\n${message}\n`);
    }
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  const i = process.argv.indexOf('--port');
  const port = i >= 0 ? Number(process.argv[i + 1]) : DOCS_PORT;
  const f = process.argv.indexOf('--features');
  if (f >= 0) extraFeatures = Object.fromEntries((process.argv[f + 1] ?? '').split(',').filter((x) => x !== '').map((x) => [x, true]));
  void startDocsPreview(port).then(() => console.log(`[ui:docs] http://127.0.0.1:${String(port)}/  (영어 /en)`));
}
