/**
 * `pnpm smoke:prod [API 기본 URL]` — 배포 직후 리드가 돌린다. **메일을 보내지 않는다** — POST 발송 경로를 부르지 않는다.
 *
 * 기본 URL 은 첫 인자 또는 `ATMARK_API_URL`(예: `https://api.atmark.ai`). AWS 자격증명이 필요 없다 — 공개 HTTP 만 쓴다.
 *
 * 확인하는 것(하나라도 틀리면 종료 코드 1):
 *   ① `GET /healthz` 200 · 네 검사 전부 참 — **비밀 로드**(조립이 끝나야 이 라우트가 선다) · **DB 왕복** ·
 *      **TLS**(서버 측 `pg_stat_ssl`) · **앱 롤이 소유자가 아니다**.
 *   ② 모르는 경로가 **우리 라우터의** 404(`route_not_found`)다 — API Gateway 기본 404 가 아니다(통합이 붙어 있다).
 *   ③ 형식이 맞는 **가짜** 에이전트 토큰으로 `GET /v1/audit` → 401 `unauthorized` — 인증 경로가 DB(`agent_api_keys`)를
 *      앱 롤 권한으로 읽는다(권한이 없으면 500 이다). 발송도 쓰기도 없다.
 *   ④ `GET /approve` 200 HTML + CSP, `HEAD /approve` 200 빈 본문 — 매직링크 페이지가 이 API 에 있다.
 *   ⑤ 어떤 응답에도 스택 프레임(`at …:줄`)이나 `.ts` 경로가 없다.
 */

import { randomBytes, randomUUID } from 'node:crypto';

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

const checks: Check[] = [];

function record(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail === '' ? '' : ` — ${detail}`}`);
}

function leaks(body: string): boolean {
  return /\bat \S+:\d+:\d+/.test(body) || /\.ts\b/.test(body);
}

async function call(base: string, method: string, path: string, headers: Record<string, string> = {}) {
  const response = await fetch(new URL(path, base), { method, headers, redirect: 'manual' });
  const body = await response.text();
  return { status: response.status, headers: response.headers, body };
}

function parse(body: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(body);
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  const base = (process.argv[2] ?? process.env['ATMARK_API_URL'] ?? '').trim();
  // 평문 http 는 로컬 리허설(localhost)만 — 운영 URL 을 http 로 두드리면 TLS 가 빠진 경로를 초록으로 볼 수 있다.
  if (base === '' || !/^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$))/.test(base)) {
    console.error('사용법: pnpm smoke:prod https://<api 호스트>   (또는 ATMARK_API_URL) — https 만(로컬 리허설은 http://localhost).');
    process.exitCode = 2;
    return;
  }
  console.log(`smoke:prod — ${base} (메일을 보내지 않는다)`);
  const bodies: string[] = [];

  // ①
  const health = await call(base, 'GET', '/healthz');
  bodies.push(health.body);
  const report = parse(health.body);
  const detail = JSON.stringify(report['checks'] ?? health.body.slice(0, 200));
  record('① /healthz 200 · 비밀·DB·TLS·앱 롤', health.status === 200 && report['status'] === 'ok', `${String(health.status)} ${detail}`);

  // ②
  const unknown = await call(base, 'GET', `/v1/__smoke_${randomUUID()}`);
  bodies.push(unknown.body);
  record('② 모르는 경로 = 라우터의 404', unknown.status === 404 && parse(unknown.body)['error'] === 'route_not_found', String(unknown.status));

  // ③
  const fakeToken = `atk_agent_${randomBytes(32).toString('base64url')}`;
  const audit = await call(base, 'GET', `/v1/audit?message_id=${randomUUID()}`, { authorization: `Bearer ${fakeToken}` });
  bodies.push(audit.body);
  record('③ 가짜 토큰 → 401 (인증이 DB 를 읽는다)', audit.status === 401, `${String(audit.status)} ${String(parse(audit.body)['error'])}`);

  // ④
  const page = await call(base, 'GET', '/approve');
  const head = await call(base, 'HEAD', '/approve');
  bodies.push(page.body);
  record(
    '④ /approve 페이지 + CSP',
    page.status === 200 &&
      (page.headers.get('content-type') ?? '').startsWith('text/html') &&
      (page.headers.get('content-security-policy') ?? '').includes("default-src 'none'") &&
      head.status === 200 &&
      head.body === '',
    `GET ${String(page.status)} · HEAD ${String(head.status)}`,
  );

  // ⑤
  record('⑤ 응답에 스택·소스 경로 없음', !bodies.some(leaks), '');

  const failed = checks.filter((check) => !check.ok);
  console.log(failed.length === 0 ? '\n✓ smoke:prod 통과' : `\n✗ smoke:prod 실패 ${String(failed.length)}건`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error('✗ smoke:prod 가 예외로 끝났다:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
