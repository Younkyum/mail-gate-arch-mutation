/**
 * **Layer C 의 런타임판** — 라우터 표 ↔ 라우트 파일 · 워커 ↔ 핸들러 전수 대조.
 *
 * Layer C(`test/arch/outbound-entrypoint-partition.arch.test.ts`)는 "진입점 파일은 분류돼 있다" 를 본다. 이 파일은
 * "분류된 진입점이 **실제로 배포 표면에 붙어 있다**" 를 본다 — 라우트 함수를 만들어 두고 라우터 표에 안 올리면 그
 * 기능은 운영에 없고, 워커를 만들어 두고 핸들러를 안 만들면 그 outbox 는 영원히 안 비워진다. 둘 다 조용하다.
 *
 * **문자열이 아니라 함수 값으로 대조한다.** 표의 `handler` 는 import 한 함수 자체이고, 여기서는 라우트 모듈을
 * 동적 import 해 export 된 `handle*` 함수와 **동일성(`===`)** 으로 맞춘다. 파일 이름을 틀리게 적거나 다른 함수를
 * 가리키면 빨개진다.
 *
 * 되돌리기(실측): `ROUTE_TABLE` 에서 한 항목(예: `handleGetThread`)을 지우면 ①이, 워커 대조 표에서 한 줄을 지우면
 * ⑤가 빨개진다.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { handleSendDraft } from '../../../src/api/routes/draft-send';
import { handleForward } from '../../../src/api/routes/forward';
import { handleReply } from '../../../src/api/routes/reply';
import { handleSend } from '../../../src/api/routes/send';
import { handleMcpRequest } from '../../../src/mcp/server';
import { MCP_TOOLS } from '../../../src/mcp/tools';
import { NON_SENDING_ENTRYPOINTS, OUTBOUND_ROUTES } from '../../../src/policy/manifest';
import { ROUTE_TABLE, resolvePath } from '../../../src/runtime/router';
import { getProject, importsModule, listTsFilesUnder, repoPath, toRepoRelative } from '../../arch/support/project';

const ROUTES_DIR = 'src/api/routes';
const HANDLERS_DIR = 'src/runtime/handlers';

/** `:id` · `{agentId}` → `{}` — 이름은 라우트마다 다르게 적혀 있다(매니페스트는 `:id`). */
function normalize(path: string): string {
  return path.replace(/\{[^}]+\}|:[A-Za-z]+/g, '{}');
}

async function exportedHandlers(file: string): Promise<{ readonly name: string; readonly fn: unknown }[]> {
  const module = (await import(repoPath(file))) as Record<string, unknown>;
  return Object.entries(module)
    .filter(([name, value]) => /^handle[A-Z]/.test(name) && typeof value === 'function')
    .map(([name, fn]) => ({ name, fn }));
}

describe('라우터 표 ↔ src/api/routes 전수 대조', () => {
  it('① src/api/routes 가 export 하는 handle* 함수는 전부 라우터 표에 있다 (등록 안 된 라우트 함수 = 빨강)', async () => {
    const files = listTsFilesUnder(ROUTES_DIR);
    expect(files.length).toBeGreaterThan(10); // 비공허성
    const missing: string[] = [];
    let seen = 0;
    for (const file of files) {
      for (const { name, fn } of await exportedHandlers(file)) {
        seen += 1;
        if (!ROUTE_TABLE.some((entry) => entry.handler === fn && entry.file === file)) missing.push(`${file}#${name}`);
      }
    }
    expect(seen).toBeGreaterThanOrEqual(16);
    expect(missing).toEqual([]);
  });

  it('② 표의 각 항목이 가리키는 함수는 그 파일의 export 다 (값으로 대조)', async () => {
    const offenders: string[] = [];
    for (const entry of ROUTE_TABLE.filter((candidate) => candidate.file.startsWith(`${ROUTES_DIR}/`))) {
      const handlers = await exportedHandlers(entry.file);
      if (!handlers.some(({ fn }) => fn === entry.handler)) offenders.push(`${entry.method} ${entry.path} → ${entry.file}`);
    }
    expect(offenders).toEqual([]);
  });

  it('③ 매니페스트의 http 발송 경로는 같은 메서드·경로·파일로 표에 있다', () => {
    const http = OUTBOUND_ROUTES.filter((route) => route.kind === 'http');
    expect(http.length).toBe(5); // send · reply · forward · transition_announcement · draft_send(묶음 B)
    const missing = http.filter((route) => {
      const [method, path] = route.ref.split(' ');
      return !ROUTE_TABLE.some(
        (entry) => entry.method === method && normalize(entry.path) === normalize(path ?? '') && entry.file === route.file,
      );
    });
    expect(missing.map((route) => route.id)).toEqual([]);
  });

  it('④ src/api/routes 의 NON_SENDING 진입점도 전부 표에 있다', () => {
    const routes = NON_SENDING_ENTRYPOINTS.filter((entry) => entry.file.startsWith(`${ROUTES_DIR}/`));
    expect(routes.length).toBeGreaterThanOrEqual(8);
    expect(routes.filter((entry) => !ROUTE_TABLE.some((route) => route.file === entry.file)).map((e) => e.file)).toEqual([]);
  });

  it('메서드+경로가 겹치는 항목이 없다 — 같은 요청이 두 항목에 맞으면 표의 순서가 동작이 된다', () => {
    const collisions: string[] = [];
    for (const [i, a] of ROUTE_TABLE.entries()) {
      for (const b of ROUTE_TABLE.slice(i + 1)) {
        if (a.method !== b.method) continue;
        const sa = a.path.split('/');
        const sb = b.path.split('/');
        if (sa.length !== sb.length) continue;
        const overlap = sa.every((part, k) => part === sb[k] || part.startsWith('{') || (sb[k] ?? '').startsWith('{'));
        if (overlap) collisions.push(`${a.method} ${a.path} ~ ${b.path}`);
      }
    }
    expect(collisions).toEqual([]);
  });

  it('표에 없는 경로는 어떤 항목에도 맞지 않는다(404 의 근거)', () => {
    expect(resolvePath('/v1/nope').entries).toEqual([]);
    expect(resolvePath('/v1/messages/').entries).toEqual([]);
    expect(resolvePath('/v1/threads/%E0%A4%A').entries).toEqual([]); // 깨진 퍼센트 인코딩
    expect(resolvePath('v1/messages').entries).toEqual([]);
  });
});

/**
 * 워커 → 핸들러. **새 워커가 생기면 이 표에 줄을 더하기 전까지 빨갛다** — 배포 표면이 없는 워커는 조용히 멈춘
 * outbox 다. 핸들러가 워커를 import 하는지는 AST 로 본다(표만 맞추고 import 를 빼면 역시 빨갛다).
 */
const WORKER_HANDLERS: Readonly<Record<string, string>> = {
  'src/workers/approval-expiry.ts': `${HANDLERS_DIR}/approval-expiry.ts`,
  'src/workers/approval-notifier.ts': `${HANDLERS_DIR}/approval-notifier.ts`,
  'src/workers/approval-release.ts': `${HANDLERS_DIR}/approval-release.ts`,
  // AI 의심 메일 감시 결과(ADR-0017 초안 · 경고 전용) — **전용 핸들러**(롤 atmark_ai_watch — 정의 함수 둘 EXECUTE 만 · SES 0 · S3 0).
  'src/workers/ai-watch-result.ts': `${HANDLERS_DIR}/ai-watch-result.ts`,
  // 문의 전달(US-009) — 전용 핸들러(contact-forwarder)지만 발송 역할을 공유한다(주체 수 그대로). 전달 주소 비밀은 이 함수만(함수 단위 IAM 조건).
  'src/workers/contact-forwarder.ts': `${HANDLERS_DIR}/contact-forwarder.ts`,
  // 고객 도메인 알림(ADR-0014 M3b) — 승인 알림과 **같은** 핸들러 · 같은 발송 역할의 1분 틱(발송 주체를 늘리지 않는다).
  'src/workers/domain-notifier.ts': `${HANDLERS_DIR}/approval-notifier.ts`,
  'src/workers/quarantine-notifier.ts': `${HANDLERS_DIR}/approval-notifier.ts`,
  'src/workers/inbound-consumer.ts': `${HANDLERS_DIR}/inbound.ts`,
  // 로그인 링크 워커는 **전용 핸들러**(login-mailer — 전용 역할·DB 롤)에서 돈다(ADR-0006). 발송 역할(api 와 공유)에서 돌면
  // api 탈취가 곧 소유자 세션이다. admin Lambda 는 SES 권한이 0 이다.
  'src/workers/owner-login-notifier.ts': `${HANDLERS_DIR}/login-mailer.ts`,
  // passport 게시·재서명(계약 §3) — **전용 핸들러**(passport-signer — 개인키를 복호하는 유일한 역할·DB 롤). SES 권한 0.
  'src/workers/passport-signer.ts': `${HANDLERS_DIR}/passport-signer.ts`,
  // 가입 확인 메일 워커(셀프 가입) — 로그인 메일과 **같은** 전용 핸들러다(발송 주체를 늘리지 않는다, 계약 §0).
  'src/workers/signup-mailer.ts': `${HANDLERS_DIR}/login-mailer.ts`,
  // 조직 초대 메일 워커(확장성 P1) — 같은 전용 핸들러(발송 주체를 늘리지 않는다, ADR-0006).
  'src/workers/invite-mailer.ts': `${HANDLERS_DIR}/login-mailer.ts`,
  // 호스팅 운영자 콘솔 코드 메일(.omc/plans/ops-console.md §3.4) — 같은 login-mailer 틱에서 가장 먼저(격리 · 던지지 않는다).
  'src/workers/ops-code-mailer.ts': `${HANDLERS_DIR}/login-mailer.ts`,
  // 셀프 가입 환영 메일(202609301510) — 같은 login-mailer 틱의 마지막 단계(기능 플래그 ATMARK_WELCOME_MAIL_ENABLED 가 켜졌을 때만).
  'src/workers/welcome-mailer.ts': `${HANDLERS_DIR}/login-mailer.ts`,
  // 대기 확인 · 초대 메일(202609301520) — 같은 login-mailer λ.
  'src/workers/waitlist-mailer.ts': `${HANDLERS_DIR}/login-mailer.ts`,
  'src/workers/scheduled-sender.ts': `${HANDLERS_DIR}/scheduled-sender.ts`,
  'src/workers/ses-event-consumer.ts': `${HANDLERS_DIR}/ses-events.ts`,
  'src/workers/webhook-dispatcher.ts': `${HANDLERS_DIR}/webhook-dispatcher.ts`,
  // 투명성 로그(US-010 · ADR-0008) — 워커마다 **전용 핸들러·전용 역할**(M5, 2026-09-24): 앵커(외부 응답 파싱)는 체크포인트 키를 갖지 않는다. SES 권한 0.
  'src/workers/transparency-anchor.ts': `${HANDLERS_DIR}/transparency-anchor.ts`,
  'src/workers/transparency-logger.ts': `${HANDLERS_DIR}/transparency-log.ts`,
};

describe('워커 ↔ Lambda 핸들러 전수 대조', () => {
  // ts-morph 프로젝트(tsconfig 전체) 적재는 동기 CPU 작업이라 2 vCPU CI 러너에서 30초를 넘었다(2026-10-01, 36821309080 — 37s).
  // composition.test.ts 와 같은 방식: 적재를 명시 상한(60s)의 beforeAll 로 치르고, ⑤ 는 캐시된 프로젝트(`getProject`)로 판정만 한다.
  beforeAll(() => {
    getProject();
  }, 60_000);

  it('⑤ src/workers 의 모든 파일에 핸들러가 있고, 그 핸들러는 실제로 워커를 import 한다', () => {
    const workers = listTsFilesUnder('src/workers');
    expect(Object.keys(WORKER_HANDLERS).sort()).toEqual(workers);

    const project = getProject();
    const offenders: string[] = [];
    for (const [worker, handlerFile] of Object.entries(WORKER_HANDLERS)) {
      const source = project.getSourceFiles().find((file) => toRepoRelative(file.getFilePath()) === handlerFile);
      if (source === undefined || !importsModule(source, worker)) offenders.push(`${handlerFile} ↛ ${worker}`);
    }
    expect(offenders).toEqual([]);
    // ts-morph 프로젝트(src 전체)를 처음 읽는 테스트라 기기 부하가 크면 기본 5초를 넘는다(2026-09-27, load 15 에서 5.3초) — 판정이 아니라 시간 문제다.
  }, 30_000);

  it('핸들러 파일은 계약의 열이다 — api·admin·migrate·site·docs·결제 둘(webhook·sync)·ops·domain-control + 워커 여덟 핸들러 (D2 와 공유한 이름)', () => {
    expect(listTsFilesUnder(HANDLERS_DIR)).toEqual(
      [
        ...new Set(Object.values(WORKER_HANDLERS)),
        `${HANDLERS_DIR}/admin.ts`,
        `${HANDLERS_DIR}/api.ts`,
        `${HANDLERS_DIR}/migrate.ts`,
        // 홈(atmark.ai) — DB·비밀·SES 없는 정적 페이지 핸들러(`src/site/**`, 스택 AtmarkSite).
        `${HANDLERS_DIR}/site.ts`,
        // 사용자 문서(docs.atmark.ai) — DB·비밀·SES 없는 정적 문서 핸들러(`src/docs/**`, 스택 AtmarkDocs).
        `${HANDLERS_DIR}/docs.ts`,
        // 결제(WP-2) — Paddle 웹훅 수신(VPC·DB 밖, HTTP API atmark-billing) · 재조회 동기화(SQS FIFO + reconcile 틱).
        `${HANDLERS_DIR}/billing-webhook.ts`,
        // 고객 도메인 제어면(ADR-0014 단계 2) — SES identity·DNS·RDAP(VPC·DB 밖, admin 만 부른다).
        `${HANDLERS_DIR}/domain-control.ts`,
        // 그 자원 정책의 독립 감사(읽기 전용 — 보안 리뷰 M2).
        `${HANDLERS_DIR}/domain-policy-audit.ts`,
        `${HANDLERS_DIR}/billing-sync.ts`,
        // 호스팅 운영자 콘솔(ops.atmark.ai) — 전용 λ · 역할 · DB 롤 atmark_ops(`.omc/plans/ops-console.md` §3.1).
        `${HANDLERS_DIR}/ops.ts`,
        // 실시간 WebSocket(묶음 E — realtime.atmark.ai) — `$connect`·`$disconnect`·`$default`(라우터 밖 — 경로가 없다).
        `${HANDLERS_DIR}/realtime.ts`,
      ].sort(),
    );
  });

  it('API 핸들러는 라우터를 import 한다 — 라우트 파일을 직접 부르지 않는다(표를 우회하지 않는다)', () => {
    const project = getProject();
    const api = project.getSourceFiles().find((file) => toRepoRelative(file.getFilePath()) === `${HANDLERS_DIR}/api.ts`);
    expect(api).toBeDefined();
    if (api === undefined) return;
    expect(importsModule(api, 'src/runtime/router.ts')).toBe(true);
    const direct = listTsFilesUnder(ROUTES_DIR).filter((file) => importsModule(api, file));
    expect(direct).toEqual([]);
  });
});

/**
 * **MCP 도구 ↔ 라우터 표** (2026-09-23). MCP 는 전송 계층이다 — 도구 하나가 표의 라우트 함수 하나를 **값으로**
 * 가리키고, 발송 도구는 정확히 매니페스트의 http 발송 경로를 가리킨다. 도구가 표에 없는 함수를 부르거나(새 발송 경로),
 * 발송 도구가 발송 경로가 아닌 함수를 부르면(분류와 다른 방식으로 보낸다) 빨갛다.
 */
describe('MCP 도구 ↔ 라우터 표 · 매니페스트', () => {
  it('POST /mcp 가 표에 있고 src/mcp/server.ts 의 handleMcpRequest 를 가리킨다', () => {
    const entries = ROUTE_TABLE.filter((entry) => entry.path === '/mcp');
    expect(entries.map((entry) => entry.method)).toEqual(['POST']);
    expect(entries[0]?.file).toBe('src/mcp/server.ts');
    expect(entries[0]?.handler).toBe(handleMcpRequest);
  });

  it('도구마다 route.handler 는 표의 핸들러(같은 파일)다 — 값으로 대조', () => {
    expect(MCP_TOOLS.length).toBeGreaterThan(0);
    const offenders = MCP_TOOLS.filter(
      (tool) => !ROUTE_TABLE.some((entry) => entry.handler === tool.route.handler && entry.file === tool.route.file),
    ).map((tool) => tool.name);
    expect(offenders).toEqual([]);
  });

  it('발송 도구 = 매니페스트 http 발송 경로를 가리키는 도구 = send·reply·forward·send_draft(묶음 B), 나머지는 NON_SENDING 라우트', () => {
    const outbound = new Set(OUTBOUND_ROUTES.filter((route) => route.kind === 'http').map((route) => route.file));
    const nonSending = new Set(NON_SENDING_ENTRYPOINTS.map((entry) => entry.file));
    const sending = MCP_TOOLS.filter((tool) => outbound.has(tool.route.file));
    expect(sending.map((tool) => tool.name).sort()).toEqual(['forward_email', 'reply_email', 'send_draft', 'send_email']);
    expect(sending.every((tool) => tool.capability === 'messages:send')).toBe(true);
    expect(MCP_TOOLS.filter((tool) => !outbound.has(tool.route.file) && !nonSending.has(tool.route.file)).map((t) => t.name)).toEqual([]);
    // 발송 도구의 route.handler 가 그 파일의 발송 함수인지(같은 파일의 다른 export 가 아닌지)도 본다.
    const handlers = new Map<string, unknown>([
      ['send_email', handleSend],
      ['reply_email', handleReply],
      ['forward_email', handleForward],
      ['send_draft', handleSendDraft],
    ]);
    expect(sending.filter((tool) => handlers.get(tool.name) !== tool.route.handler).map((tool) => tool.name)).toEqual([]);
  });
});
