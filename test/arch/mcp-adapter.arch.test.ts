/**
 * MCP 전송 어댑터 — **MCP 는 새 발송 경로가 아니다** (2026-09-23, Hermes 원격 MCP).
 *
 * **주장:**
 *   ① `src/mcp/**` 의 런타임 import 폐포를 **라우트 파일(`src/api/routes/**`)에서 멈춰** 계산하면 관문
 *      (`src/policy/gate.ts`)·전송단(`src/mail/transport/**`)·시스템 메일 모듈(`SYSTEM_MAIL_ENTRYPOINTS[].sender`)·
 *      SES SDK 가 **하나도 없다.** 즉 MCP 가 발송에 닿는 길은 등록된 라우트 함수를 지나는 길뿐이다 — 멱등 키·인증·
 *      인가·관문의 순서가 그 라우트 안에 있다.
 *   ② MCP 가 닿는 라우트 파일은 **에이전트 도구 허용목록과 정확히 같다.** 소유자 권한 라우트(승인 결정 `/approve`·
 *      전환 공지·예약 **생성**·초안·audit)는 0 — 에이전트가 injection 으로 자기 권한을 올리는 도구가 생기지 않는다.
 *      **웹훅 관리는 에이전트 도구로 확대했다**(2026-09-30 진윤겸 승인 — ADR-0013 개정): `webhook-endpoints.ts`·`webhook-deliveries.ts` 가
 *      허용목록에 있고, 쓰기 도구는 전용 권한 `webhooks:manage`(기본 토큰에 없다)와 "소유자가 시킨 URL 만" 설명으로 주입 유도를 막는다.
 *      **예약 조회·취소는 에이전트 도구로 확대했다**(메일 기본기 D2, 2026-09-26 — 근거 ADR-0013): `scheduled-queries.ts` 가 허용목록에
 *      있고 생성(`scheduled-messages.ts`)은 여전히 밖이다. 취소가 주입 메일에 유도되는 위험은 라우트 쪽 완화(사유 필수·경로 기록·MCP
 *      시간당 상한·`agent_cancellable`)가 막고, 취소 경로(`'mcp'`)는 라우터가 리터럴로 묶는다(⑤).
 *   ③ 멈춘 폐포에 소유자 권한 모듈(발신자 표시 쓰기·승인 전이·토큰 발급·프로비저닝·관리 표면·GATE 기록)이 없다.
 *
 * **Layer C 와 무엇이 다른가.** Layer C 는 `src/mcp/**` 를 `TRANSPORT_ADAPTER_ENTRYPOINTS` 로 분류하고 "관문을
 * **직접** import 하지 않는다" 를 본다. 그런데 MCP 가 `outbound-service` 같은 중간 모듈을 거쳐 관문에 닿으면 Layer C
 * 는 초록이다. 이 층이 그 간접을 닫는다(`approval-boundary.arch.test.ts` 와 같은 폐포 계산, 멈춤 규칙만 더했다).
 *
 * **못 잡는 것:** 동적 import·문자열 경로, 그리고 **주입받은 의존성의 메서드 호출**(`deps.send.transport.send(...)`)
 * — import 그래프 밖이다. 후자는 아래 ④·④-2 가 AST 로 본다: `src/mcp` 에 발송 슬롯 이름(`transport`·`service`)이
 * **식별자로도 문자열 리터럴로도** 0건이다(④ 는 속성 접근, ④-2 는 그 밖 — 변이 표적을 나누려고 둘이다) — 속성 접근·구조 분해(`const { transport } = deps.send`)·원소 접근
 * (`deps.send['transport']`)·캐스트 뒤 접근(`(deps.send as any).transport`)이 전부 그 이름을 지난다. 이름을 조립하는
 * 코드(`'trans' + 'port'`)·이름 없이 훑는 코드(`Object.values`)는 ④ 가 못 잡는다 — ④-3 과 ⑤ 가 닫는다(아래).
 *
 * ④-3 **이름을 모르는 길도 없다 — 의존성은 "칸을 골라 곧바로 부르기" 로만 쓴다(2026-09-23 적대 검증 M2).** ④·④-2 는
 *   이름으로 본다. `(x as any).approve(...)` 나 `Object.values(deps.send)` 는 금지된 이름을 쓰지 않고 객체 안을 연다.
 *   그래서 `src/mcp` 에서 `deps` 는 `deps.<McpDependencies 멤버>(…)` 호출 모양으로만 나타나야 한다(매개변수 선언·
 *   `ToolContext` 로 옮겨 담는 단축 속성·타입 선언 제외). 거기에 더해 `Reflect.*`, 인자에 `deps` 가 있는
 *   `Object.values|entries|keys|getOwnPropertyNames|getOwnPropertyDescriptors|assign`, `deps` 를 `any`·`unknown`·`never`
 *   로 캐스트하는 식을 이름으로도 막는다. **이 층만으로 막는 것이 아니다** — 의존성이 이제 런타임에도 함수뿐이라(⑤)
 *   캐스트해도 열 객체가 없다. ④-3 은 누가 다시 객체를 넘기려 할 때 그 코드를 쓰는 쪽에서 빨갛게 한다.
 *
 * ⑤ **라우터가 MCP 에 넘기는 것은 함수뿐이다(M2).** 예전에는 `{ send: d.send, … }` 일곱 칸 — 타입은 좁았지만 런타임
 *   값은 통째 객체였다(`send.transport`, 승인 저장소의 `approve`·`reject`·`expire`, 토큰 저장소의 `insert`·`revoke`).
 *   이제 `/mcp` 항목은 `h(mcpDependenciesOf(d), …)` 이고, `mcpDependenciesOf` 가 돌려주는 객체 리터럴은 키 집합 =
 *   `McpDependencies` 멤버, 값은 전부 화살표 함수, 라우트 칸은 **HTTP 라우트와 같은 `handle*` 를 같은 `d.<칸>` 으로**
 *   부른다. 인자는 화살표의 매개변수 그대로이고, 표가 정한 칸만 그 뒤에 **정해진 리터럴 하나**를 더 넘긴다(예약 취소의 경로 `'mcp'`
 *   — 헤더로 받으면 HTTP 클라이언트가 위조한다). 런타임 모양(함수뿐·허용 키)은 `test/unit/mcp/mcp-dependencies.test.ts` 가 본다.
 * ⑥ **도구 하나 = 라우트 칸 하나 = 표의 라우트 함수 하나.** 도구 정의의 `route.handler` 와 그 도구가 부르는 라우트 칸이
 *   ⑤ 의 표에서 같은 함수를 가리킨다. `route.handler` ↔ 라우터 표 `ROUTE_TABLE` 의 동일성은
 *   `test/unit/runtime/router-table.test.ts` 가 값으로 본다 — 둘을 이으면 "MCP 도구가 부르는 것 = HTTP 가 부르는 것".
 *
 * type-only import 는 따라가지 않는다(런타임에 아무것도 부르지 않는다) — 선언 전체가 `import type` 인 것만.
 */

import { describe, expect, it } from 'vitest';
import { SyntaxKind, type Node, type SourceFile } from 'ts-morph';

import { SYSTEM_MAIL_ENTRYPOINTS, TRANSPORT_ADAPTER_ENTRYPOINTS } from '../../src/policy/manifest';
import { getProject, listTsFilesUnder, toRepoRelative } from './support/project';

const GATE_FILE = 'src/policy/gate.ts';
const TRANSPORT_DIR = 'src/mail/transport/';
const ROUTES_DIR = 'src/api/routes/';
const SES_SDK = /^@aws-sdk\/client-sesv2($|\/)/;

/**
 * MCP 가 부를 수 있는 라우트 파일 — **이름으로 못 박는다.** 줄을 더하는 것은 "에이전트 도구가 하나 늘었다" 는 뜻이고,
 * 그 라우트가 소유자 권한이 아닌지는 리뷰가 본다. 이 목록 밖의 라우트를 import 하면 ② 가 빨갛다.
 */
const AGENT_TOOL_ROUTES = [
  'src/api/routes/agent-policy.ts',
  'src/api/routes/approvals.ts',
  'src/api/routes/attachments.ts',
  'src/api/routes/forward.ts',
  'src/api/routes/inbound-messages.ts',
  'src/api/routes/reply.ts',
  // 메일 기본기 1차(D2 확대) — 예약 조회·취소. 생성(`scheduled-messages.ts`)은 여기 없다.
  'src/api/routes/scheduled-queries.ts',
  'src/api/routes/send.ts',
  'src/api/routes/threads.ts',
  // 메일 기본기 1차(A1) — 인증코드 조회(읽기).
  'src/api/routes/verification-code.ts',
  // 웹훅 관리(2026-09-30 — ADR-0013 개정). 쓰기 도구는 `webhooks:manage`.
  'src/api/routes/webhook-deliveries.ts',
  'src/api/routes/webhook-endpoints.ts',
  // 묶음 B(2026-10-08) — 초안(만들기 · 고치기 · 버리기 · 보내기 — 보내기는 관문을 지나는 OUTBOUND 경로) · 라벨 · 발견(읽기).
  'src/api/routes/draft-send.ts',
  'src/api/routes/drafts.ts',
  'src/api/routes/labels.ts',
  'src/api/routes/discovery.ts',
  // 묶음 D(2026-10-08) — 자가 등록(`agents:enroll` — 소유자가 토큰마다 준다 · 조직 설정 기본 꺼짐). 라우트는 admin λ 이벤트 하나만 부른다(정책 쓰기 ·
  //   토큰 저장소 쓰기 · 다른 에이전트 읽기 없음 — 판정은 admin λ 가 DB 에서). 소유자 권한이 아니라 소유자가 위임한 좁은 권한이다.
  'src/api/routes/agents-enroll.ts',
  // 정책 변경 요청(2026-10-13 — ADR-0007 개정, `policy:request`). 요청 한 행을 남길 뿐 정책을 **바꾸지 않는다** — 바꾸는 것은 콘솔의 소유자 승인(관리 연산)이다.
  //   요청할 수 없는 것(정지 · 위험 보류 · 발신 승인 · 신뢰 발신자 · 토큰 · 권한)은 칸이 없다. 상태 읽기는 같은 파일(`agent:read_self`).
  'src/api/routes/policy-requests.ts',
].sort();

/**
 * MCP 가 받는 함수(⑤) — 이름 → 부르는 라우트 함수와 그 의존성 칸. `null` 은 라우트 함수가 아닌 읽기 칸(인증·회신 대상·
 * 전달 원 제목·발신 주소)이다. 줄을 더하는 것은 "MCP 가 새 능력을 받는다" 는 뜻이다 — 리뷰가 소유자 권한이 아닌지 본다.
 * `literal` 은 매개변수 뒤에 라우터가 덧붙이는 **소스 그대로의 리터럴**이다(없으면 매개변수만 넘긴다).
 */
const MCP_DEPENDENCIES: Readonly<
  Record<string, { readonly handler: string; readonly slot: string; readonly literal?: string } | null>
> = {
  authenticate: null,
  send: { handler: 'handleSend', slot: 'send' },
  reply: { handler: 'handleReply', slot: 'reply' },
  findReplyTarget: null,
  forward: { handler: 'handleForward', slot: 'forward' },
  forwardOriginal: null,
  listInbox: { handler: 'handleListInboundMessages', slot: 'inboundRead' },
  readEmail: { handler: 'handleGetInboundMessage', slot: 'inboundRead' },
  getThread: { handler: 'handleGetThread', slot: 'inboundRead' },
  getAttachment: { handler: 'handleGetInboundAttachment', slot: 'attachments' },
  // 첨부 내용(텍스트 · PDF 텍스트 · 이미지) — 같은 첨부 라우트 파일, 같은 의존성 칸(읽기).
  readAttachment: { handler: 'handleGetInboundAttachmentContent', slot: 'attachments' },
  getApproval: { handler: 'handleGetApproval', slot: 'approvals' },
  getAgentPolicy: { handler: 'handleGetAgentPolicy', slot: 'agentPolicy' },
  sendingAddresses: null,
  // 메일 기본기 1차 — 인증코드 조회 · 예약 조회·취소. 취소는 경로 리터럴 `'mcp'` 를 네 번째 인자로 넘긴다(HTTP 표 항목은 `'http'`).
  verificationCode: { handler: 'handleGetVerificationCode', slot: 'verificationCode' },
  listScheduled: { handler: 'handleListScheduledMessages', slot: 'scheduledQueries' },
  cancelScheduled: { handler: 'handleCancelScheduledMessage', slot: 'scheduledQueries', literal: "'mcp'" },
  // 웹훅 관리(2026-09-30) — HTTP 표와 같은 라우트 함수 · 같은 칸.
  listWebhooks: { handler: 'handleListWebhookEndpoints', slot: 'webhookEndpoints' },
  createWebhook: { handler: 'handleRegisterWebhookEndpoint', slot: 'webhookEndpoints' },
  deleteWebhook: { handler: 'handleDeleteWebhookEndpoint', slot: 'webhookEndpoints' },
  listWebhookDeliveries: { handler: 'handleListWebhookDeliveries', slot: 'webhookDeliveries' },
  redeliverWebhook: { handler: 'handleRedeliverWebhookDelivery', slot: 'webhookDeliveries' },
  // 묶음 B — 초안(같은 칸 `drafts` · 보내기는 `draftSend`) · 라벨 · 발견(정책 칸 `agentPolicy` — 읽기).
  createDraft: { handler: 'handleCreateDraft', slot: 'drafts' },
  listDrafts: { handler: 'handleListDrafts', slot: 'drafts' },
  getDraft: { handler: 'handleGetDraft', slot: 'drafts' },
  updateDraft: { handler: 'handleUpdateDraft', slot: 'drafts' },
  discardDraft: { handler: 'handleDiscardDraft', slot: 'drafts' },
  sendDraft: { handler: 'handleSendDraft', slot: 'draftSend' },
  setLabels: { handler: 'handleSetMessageLabels', slot: 'labels' },
  listLabels: { handler: 'handleListLabels', slot: 'labels' },
  getCapabilities: { handler: 'handleGetCapabilities', slot: 'agentPolicy' },
  // 묶음 D — 자가 등록(칸 `agentEnroll`).
  createAgent: { handler: 'handleEnrollAgent', slot: 'agentEnroll' },
  getRealtimeConnection: { handler: 'handleGetRealtimeConnection', slot: 'agentPolicy' },
  // 정책 변경 요청(칸 `policyRequests` — 요청 · 상태 읽기). 바꾸는 함수는 이 표에 없다.
  requestPolicyChange: { handler: 'handleCreatePolicyRequest', slot: 'policyRequests' },
  getPolicyRequest: { handler: 'handleGetPolicyRequest', slot: 'policyRequests' },
};
const MCP_DEPENDENCY_KEYS = Object.keys(MCP_DEPENDENCIES).sort();

/** 라우트 의존성의 발송 슬롯 — MCP 가 열면 관문을 건너뛰어 전송단에 닿는다(④). */
const SEND_SLOTS = new Set(['transport', 'service']);

/** 소유자 권한 모듈 — 에이전트 표면의 폐포에 있으면 안 된다(③). 디렉터리는 `/` 로 끝난다. */
const OWNER_POWER_MODULES = [
  'src/db/repositories/sender-marks-store.ts',
  'src/approval/service.ts',
  'src/approval/magic-link.ts',
  'src/db/repositories/approval-link-use-store.ts',
  'src/db/repositories/agent-token-store.ts',
  'src/identity/provisioning.ts',
  'src/admin/',
  'src/gate/',
];

function sourceFileOf(relativePath: string): SourceFile {
  const file = getProject()
    .getSourceFiles()
    .find((candidate) => toRepoRelative(candidate.getFilePath()) === relativePath);
  if (!file) throw new Error(`${relativePath} 를 ts-morph 프로젝트가 로드하지 못했다 — 이 층이 공허해진다.`);
  return file;
}

interface Closure {
  /** 닿은 `src/**` 파일(라우트 파일 포함, 라우트 **안쪽**은 제외). */
  readonly files: Set<string>;
  /** 닿은 npm 모듈 스펙. */
  readonly packages: Set<string>;
}

/** 런타임 import·re-export 폐포. `stopAtRoutes` 면 라우트 파일에 닿되 그 안으로 들어가지 않는다. */
function runtimeClosure(entries: readonly string[], stopAtRoutes: boolean): Closure {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue: SourceFile[] = entries.map(sourceFileOf);
  while (queue.length > 0) {
    const file = queue.pop() as SourceFile;
    const path = toRepoRelative(file.getFilePath());
    if (files.has(path) || !path.startsWith('src/')) continue;
    files.add(path);
    if (stopAtRoutes && path.startsWith(ROUTES_DIR)) continue;

    for (const declaration of [...file.getImportDeclarations(), ...file.getExportDeclarations()]) {
      if (declaration.isTypeOnly()) continue;
      const target = declaration.getModuleSpecifierSourceFile();
      if (target) queue.push(target);
      else {
        const specifier = declaration.getModuleSpecifierValue();
        if (specifier !== undefined && !specifier.startsWith('.')) packages.add(specifier);
      }
    }
  }
  return { files, packages };
}

function mcpFiles(): string[] {
  return listTsFilesUnder('src/mcp');
}

describe('MCP 전송 어댑터 — 발송은 등록된 라우트 함수를 지나는 길뿐이다', () => {
  it('비공허성: src/mcp 에 파일이 있고 전부 전송 어댑터로 분류돼 있다', () => {
    const files = mcpFiles();
    expect(files.length).toBeGreaterThanOrEqual(3);
    expect(TRANSPORT_ADAPTER_ENTRYPOINTS.map((entry) => entry.file).sort()).toEqual(files);
  });

  it('양성 대조군: 라우트에서 멈추지 않으면 MCP 폐포에 관문이 있다 — 폐포 계산이 살아 있다', () => {
    // 이 단언이 없으면 아래 단언은 "폐포가 비어서" 초록일 수 있다. send_email 은 실제로 관문까지 간다.
    expect(runtimeClosure(mcpFiles(), false).files.has(GATE_FILE)).toBe(true);
  });

  it('MCP 의 런타임 import 폐포(라우트 파일에서 멈춤)에 관문·전송단·시스템 메일 모듈·SES SDK 가 없다', () => {
    const closure = runtimeClosure(mcpFiles(), true);
    const senders = new Set(SYSTEM_MAIL_ENTRYPOINTS.map((entry) => entry.sender));
    const offenders = [
      ...[...closure.files].filter((path) => path === GATE_FILE || path.startsWith(TRANSPORT_DIR) || senders.has(path)),
      ...[...closure.packages].filter((specifier) => SES_SDK.test(specifier)),
    ].sort();
    expect(offenders).toEqual([]);
  });

  it('MCP 가 닿는 라우트 파일은 에이전트 도구 허용목록과 정확히 같다 (소유자 권한 라우트 0)', () => {
    const reached = [...runtimeClosure(mcpFiles(), true).files].filter((path) => path.startsWith(ROUTES_DIR)).sort();
    expect(reached).toEqual(AGENT_TOOL_ROUTES);
  });

  it('MCP 폐포(라우트에서 멈춤)에 소유자 권한 모듈이 없다', () => {
    const closure = runtimeClosure(mcpFiles(), true);
    // 비공허성: 폐포가 라우트 파일 밖으로도 실제로 뻗는다(발송 본문 파서 — 멱등 키가 라우트의 파서를 부른다).
    expect(closure.files.has('src/api/outbound-http.ts')).toBe(true);
    const offenders = [...closure.files].filter((path) =>
      OWNER_POWER_MODULES.some((module) => (module.endsWith('/') ? path.startsWith(module) : path === module)),
    );
    expect(offenders).toEqual([]);
  });

  it('④ src/mcp 는 라우트 의존성의 발송 슬롯(transport·service)을 열지 않는다 — 주입받은 전송단을 직접 부르는 길', () => {
    const offenders: string[] = [];
    let accesses = 0;
    for (const path of mcpFiles()) {
      for (const access of sourceFileOf(path).getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
        accesses += 1;
        // 캐스트 뒤 접근(`(deps.send as any).transport`)도 이름은 같은 자리에 있다.
        if (SEND_SLOTS.has(access.getName())) offenders.push(`${path}: ${access.getText()}`);
      }
    }
    expect(accesses).toBeGreaterThan(20); // 비공허성
    expect(offenders).toEqual([]);
  });

  it('④-2 속성 접근 밖의 길도 없다 — 구조 분해·단축 속성·원소 접근·문자열 리터럴에 발송 슬롯 이름이 0건', () => {
    const offenders: string[] = [];
    let identifiers = 0;
    for (const path of mcpFiles()) {
      const file = sourceFileOf(path);
      // 식별자 — 구조 분해(`const { transport } = deps.send`, `{ transport: t }`)·단축 속성이 전부 Identifier 노드다.
      // 속성 접근의 이름은 ④ 가 본다(표적을 나눠 두어야 변이 판정이 테스트 단위로 선다).
      for (const identifier of file.getDescendantsOfKind(SyntaxKind.Identifier)) {
        identifiers += 1;
        const parent = identifier.getParentOrThrow();
        if (parent.isKind(SyntaxKind.PropertyAccessExpression) && parent.getNameNode() === identifier) continue;
        if (SEND_SLOTS.has(identifier.getText())) offenders.push(`${path}: ${parent.getText()}`);
      }
      // 문자열 리터럴 — 원소 접근(`x['transport']`)·계산된 구조 분해 키.
      for (const literal of [
        ...file.getDescendantsOfKind(SyntaxKind.StringLiteral),
        ...file.getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral),
      ]) {
        if (SEND_SLOTS.has(literal.getLiteralText())) offenders.push(`${path}: ${literal.getParentOrThrow().getText()}`);
      }
    }
    expect(identifiers).toBeGreaterThan(200); // 비공허성
    expect(offenders).toEqual([]);
  });

  it('④-3 이름을 모르는 길도 없다 — src/mcp 에서 deps 는 칸을 골라 곧바로 부르는 모양뿐 · Reflect·Object.values·any 캐스트 0', () => {
    const members = new Set(Object.keys(MCP_DEPENDENCIES));
    const offenders: string[] = [];
    let calls = 0;
    const mentionsDeps = (node: Node): boolean =>
      node.getDescendantsOfKind(SyntaxKind.Identifier).some((identifier) => identifier.getText() === 'deps') ||
      (node.isKind(SyntaxKind.Identifier) && node.getText() === 'deps');
    for (const path of mcpFiles()) {
      const file = sourceFileOf(path);
      for (const identifier of file.getDescendantsOfKind(SyntaxKind.Identifier)) {
        if (identifier.getText() !== 'deps') continue;
        const parent = identifier.getParentOrThrow();
        // 선언·타입 자리: `deps: McpDependencies` 매개변수, `readonly deps: …` 속성 서명, `{ deps, … }` 로 옮겨 담기.
        if (parent.isKind(SyntaxKind.Parameter) && parent.getNameNode() === identifier) continue;
        if (parent.isKind(SyntaxKind.PropertySignature)) continue;
        if (parent.isKind(SyntaxKind.ShorthandPropertyAssignment)) continue;
        // 쓰는 자리: `deps` 또는 `….deps` 가 곧바로 `.칸` 이고 그 칸이 곧바로 호출된다.
        const holder = parent.isKind(SyntaxKind.PropertyAccessExpression) && parent.getNameNode() === identifier ? parent : identifier;
        const member = holder.getParent();
        const call = member?.getParent();
        const ok =
          member?.isKind(SyntaxKind.PropertyAccessExpression) === true &&
          member.getExpression() === holder &&
          members.has(member.getName()) &&
          call?.isKind(SyntaxKind.CallExpression) === true &&
          call.getExpression() === member;
        if (ok) calls += 1;
        else offenders.push(`${path}:${String(identifier.getStartLineNumber())}: ${(call ?? member ?? holder).getText().slice(0, 120)}`);
      }
      for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const callee = call.getExpression().getText();
        if (/^Reflect\./.test(callee)) offenders.push(`${path}: ${call.getText().slice(0, 120)}`);
        if (
          /^Object\.(values|entries|keys|getOwnPropertyNames|getOwnPropertyDescriptors|getOwnPropertySymbols|assign)$/.test(callee) &&
          call.getArguments().some(mentionsDeps)
        ) {
          offenders.push(`${path}: ${call.getText().slice(0, 120)}`);
        }
      }
      for (const cast of [...file.getDescendantsOfKind(SyntaxKind.AsExpression), ...file.getDescendantsOfKind(SyntaxKind.TypeAssertionExpression)]) {
        const target = cast.getTypeNode()?.getText() ?? '';
        if (['any', 'unknown', 'never'].includes(target) && mentionsDeps(cast.getExpression())) {
          offenders.push(`${path}: ${cast.getText().slice(0, 120)}`);
        }
      }
    }
    expect(calls).toBeGreaterThanOrEqual(12); // 비공허성 — 도구·서버가 실제로 칸을 부른다
    expect(offenders).toEqual([]);
  });

  it('⑤ 라우터는 MCP 에 함수만 넘긴다 — 라우트 칸은 HTTP 라우트와 같은 handle* 를 같은 의존성 칸으로 부른다', () => {
    const router = sourceFileOf('src/runtime/router.ts');
    const entry = router
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .filter((call) => call.getExpression().getText() === 'route')
      .find((call) => call.getArguments()[1]?.getText() === "'/mcp'");
    expect(entry, '라우터 표에 /mcp 항목이 없다 — 이 단언이 공허해진다').toBeDefined();
    const adapter = entry?.getArguments()[5]?.asKind(SyntaxKind.ArrowFunction);
    expect(adapter, '/mcp 항목의 여섯째 인자가 화살표 함수가 아니다').toBeDefined();
    const [handlerParam, depsParam] = adapter?.getParameters().map((parameter) => parameter.getName()) ?? [];
    const calls = (adapter?.getDescendantsOfKind(SyntaxKind.CallExpression) ?? []).filter(
      (call) => call.getExpression().getText() === handlerParam,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.getArguments()[0]?.getText()).toBe(`mcpDependenciesOf(${String(depsParam)})`);

    const builder = router.getFunctionOrThrow('mcpDependenciesOf');
    const [builderParam] = builder.getParameters().map((parameter) => parameter.getName());
    // 본문은 `return Object.freeze({ … })` 한 문장뿐 — 앞에서 객체를 만들어 섞을 자리가 없다.
    const statements = builder.getStatements();
    expect(statements).toHaveLength(1);
    const frozen = statements[0]?.asKind(SyntaxKind.ReturnStatement)?.getExpression()?.asKind(SyntaxKind.CallExpression);
    expect(frozen?.getExpression().getText()).toBe('Object.freeze');
    const literal = frozen?.getArguments()[0]?.asKind(SyntaxKind.ObjectLiteralExpression);
    expect(literal, 'mcpDependenciesOf 가 객체 리터럴을 돌려주지 않는다').toBeDefined();

    const keys: string[] = [];
    const malformed: string[] = [];
    for (const property of literal?.getProperties() ?? []) {
      // `이름: (…) => …` 모양만 — 전개(`...d`)·단축(`send`)·값(`send: d.send`)은 객체를 넘기는 길이다.
      const assignment = property.asKind(SyntaxKind.PropertyAssignment);
      const name = assignment?.getName();
      const arrow = assignment?.getInitializer()?.asKind(SyntaxKind.ArrowFunction);
      if (name === undefined || arrow === undefined) {
        malformed.push(property.getText().slice(0, 120));
        continue;
      }
      keys.push(name);
      const expected = MCP_DEPENDENCIES[name];
      if (expected === undefined || expected === null) continue;
      // 라우트 칸: 본문이 곧바로 `handleX(d.칸, 매개변수…[, 정해진 리터럴])` 한 호출.
      const body = arrow.getBody().asKind(SyntaxKind.CallExpression);
      const params = arrow.getParameters().map((parameter) => parameter.getName());
      const args = body?.getArguments().map((argument) => argument.getText()) ?? [];
      const expectedArgs = expected.literal === undefined ? params : [...params, expected.literal];
      if (
        body?.getExpression().getText() !== expected.handler ||
        args[0] !== `${String(builderParam)}.${expected.slot}` ||
        args.slice(1).join(',') !== expectedArgs.join(',')
      ) {
        malformed.push(`${name}: ${arrow.getText().slice(0, 120)}`);
      }
    }
    expect(malformed).toEqual([]);
    expect(keys.sort()).toEqual(MCP_DEPENDENCY_KEYS);

    const declared = sourceFileOf('src/mcp/tools.ts')
      .getInterfaceOrThrow('McpDependencies')
      .getProperties()
      .map((property) => property.getName())
      .sort();
    expect(declared).toEqual(MCP_DEPENDENCY_KEYS);
  });

  it("⑤-2 예약 취소 경로는 라우터가 리터럴로 정한다 — HTTP 표 항목은 'http', MCP 칸은 'mcp' (헤더·인자로 고를 수 없다)", () => {
    const router = sourceFileOf('src/runtime/router.ts');
    // HTTP 표: 취소 경로 항목의 invoke 화살표가 `h(…, 'http')` 한 번을 부른다.
    const entry = router
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .filter((call) => call.getExpression().getText() === 'route')
      .find((call) => call.getArguments()[1]?.getText() === "'/v1/messages/scheduled/{scheduleId}/cancel'");
    expect(entry, '라우터 표에 예약 취소 항목이 없다 — 이 단언이 공허해진다').toBeDefined();
    const invoke = entry?.getArguments()[5]?.asKind(SyntaxKind.ArrowFunction);
    const [handlerParam] = invoke?.getParameters().map((parameter) => parameter.getName()) ?? [];
    const calls = (invoke?.getDescendantsOfKind(SyntaxKind.CallExpression) ?? []).filter(
      (call) => call.getExpression().getText() === handlerParam,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.getArguments()[3]?.getText()).toBe("'http'");

    // MCP 칸: `cancelScheduled` 의 본문 호출 마지막 인자가 `'mcp'` 리터럴이다(⑤ 가 칸 모양 전체를 본다 — 여기는 그 값만).
    const literal = router
      .getFunctionOrThrow('mcpDependenciesOf')
      .getDescendantsOfKind(SyntaxKind.PropertyAssignment)
      .find((property) => property.getName() === 'cancelScheduled')
      ?.getInitializer()
      ?.asKind(SyntaxKind.ArrowFunction)
      ?.getBody()
      .asKind(SyntaxKind.CallExpression)
      ?.getArguments()
      .at(-1)
      ?.getText();
    expect(literal).toBe("'mcp'");
  });

  it('⑥ 도구마다 route.handler 와 그 도구가 부르는 라우트 칸이 같은 라우트 함수다', () => {
    const tools = sourceFileOf('src/mcp/tools.ts');
    const definitions = tools
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .filter((call) => call.getExpression().getText() === 'tool')
      .map((call) => call.getArguments()[0]?.asKind(SyntaxKind.ObjectLiteralExpression))
      .filter((literal): literal is NonNullable<typeof literal> => literal !== undefined);
    expect(definitions.length).toBe(31); // 비공허성 — 동결된 서른하나(D 자가 등록 · E 실시간 연결 안내 포함) 도구(메일 기본기 1차가 셋을, 첨부 내용 읽기가 하나를, 웹훅 관리(2026-09-30)가 여섯을, 묶음 B(2026-10-08)가 아홉을, 묶음 D 가 하나(create_agent)를, 정책 변경 요청(2026-10-13)이 둘(request_policy_change · get_policy_request)을 더했다)
    const routePorts = new Map(
      Object.entries(MCP_DEPENDENCIES).flatMap(([name, target]) => (target === null ? [] : [[name, target.handler] as const])),
    );
    const mismatched: string[] = [];
    for (const definition of definitions) {
      const name = definition.getProperty('name')?.asKind(SyntaxKind.PropertyAssignment)?.getInitializer()?.getText();
      const route = definition.getProperty('route')?.asKind(SyntaxKind.PropertyAssignment)?.getInitializer();
      const handler = route
        ?.asKind(SyntaxKind.ObjectLiteralExpression)
        ?.getProperty('handler')
        ?.asKind(SyntaxKind.PropertyAssignment)
        ?.getInitializer()
        ?.getText();
      const run = definition.getProperty('run');
      const used = new Set(
        (run?.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression) ?? [])
          .filter((access) => access.getExpression().getText().endsWith('deps') && routePorts.has(access.getName()))
          .map((access) => access.getName()),
      );
      const handlers = [...used].map((port) => routePorts.get(port));
      if (handlers.length !== 1 || handlers[0] !== handler) mismatched.push(`${String(name)}: route.handler=${String(handler)} calls=${[...used].join(',')}`);
    }
    expect(mismatched).toEqual([]);
  });
});
