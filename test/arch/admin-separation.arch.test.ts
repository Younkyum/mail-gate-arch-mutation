/**
 * **관리 표면 권한 분리** (관리 백엔드, 2026-09-23 — console.atmark.ai). 인프라 층(`test/unit/infra/compute-stack.test.ts`:
 * 별도 HTTP API·별도 역할·SES 0·소유자 비밀)과 짝을 이루는 **코드 층**이다.
 *
 *   ① api 번들(`handlers/api.ts`)의 런타임 import 폐포에 `src/admin/**`·`admin-composition` 이 없다 — 에이전트 토큰이 닿는
 *      Lambda 에 소유자 세션·프로비저닝·sender_marks 쓰기 코드가 **들어 있지도 않다**. (MCP 가 api 에 얹혀도 같은 단언이 본다.)
 *   ② admin 번들(`handlers/admin.ts`)의 폐포에 SES 전송단·알림 모듈·운영 조립 루트(`composition.ts`)가 없다 — admin 이 메일을
 *      보내거나 에이전트 전송단을 쥘 길이 코드에 없다(IAM 도 0 — 인프라 층). S3 는 **읽기 전용 리더 하나**(US-004 — 발신 본문):
 *      폐포 안에서 `s3-object-store` 에서 가져오는 이름은 `createS3Client`·`createS3ObjectReader`(와 그 타입)뿐이다 —
 *      쓰기 저장소(`createS3ObjectStore`)·서명기·신원 문서 쓰기는 import 조차 없다(IAM 도 `s3:GetObject` on `outbound/content/*` 하나).
 *   ③ **소유자 DB 롤 비밀**(`RUNTIME_ENV.dbMigrationSecretArn`)을 읽는 조립은 migrate 둘뿐이고(ADR-0006 — admin 은 소유자 롤이
 *      아니다, 검증 H2), 그 조립을 부르는 핸들러는 migrate 뿐이다. admin 조립은 **admin 롤 비밀**(`dbAdminSecretArn`)만 읽고
 *      앱·소유자 롤 비밀을 읽지 않는다. 로그인 메일 롤 비밀(`dbLoginMailerSecretArn`)은 login-mailer 조립(과 그 비밀을 쓰는 부트스트랩)만.
 *   ④ 관리 라우터 표: 모든 세션 변경 경로가 CSRF 를 켠다 · 승인 **결정** 경로가 없다.
 *   ⑤ login-mailer 번들(`handlers/login-mailer.ts`)의 폐포에 운영 조립 루트(`composition.ts` — 에이전트 전송단·S3·관문)·관문·
 *      S3·관리 코드가 없다 — 로그인 키를 쥔 Lambda 에 외부 입력을 받는 코드가 실리지 않는다. 그리고 로그인 키 변수
 *      (`ownerLoginKeysSecretArn`)를 읽는 조립은 admin·login-mailer 둘뿐이다(H1 — 발송 역할 조립은 읽지 않는다).
 */

import { describe, expect, it } from 'vitest';
import { SyntaxKind, type SourceFile } from 'ts-morph';

import { ADMIN_ROUTES } from '../../src/admin/router';
import { FAVICON_PATHS } from '../../src/ui/favicon';
import { getProject, toRepoRelative } from './support/project';

const HANDLERS = 'src/runtime/handlers';

function source(path: string): SourceFile {
  const found = getProject().getSourceFiles().find((file) => toRepoRelative(file.getFilePath()) === path);
  if (found === undefined) throw new Error(`${path} 를 ts-morph 가 읽지 못했다 — 이 층이 공허해진다.`);
  return found;
}

/** 런타임 import 폐포(타입 전용 import 제외 — 번들에 들어가지 않는다). */
function runtimeClosure(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [source(entry)];
  while (queue.length > 0) {
    const file = queue.pop() as SourceFile;
    const path = toRepoRelative(file.getFilePath());
    if (seen.has(path)) continue;
    seen.add(path);
    for (const declaration of file.getImportDeclarations()) {
      if (declaration.isTypeOnly()) continue;
      const named = declaration.getNamedImports();
      if (named.length > 0 && named.every((n) => n.isTypeOnly()) && !declaration.getDefaultImport() && !declaration.getNamespaceImport()) continue;
      const target = declaration.getModuleSpecifierSourceFile();
      if (target !== undefined && toRepoRelative(target.getFilePath()).startsWith('src/')) queue.push(target);
    }
    for (const declaration of file.getExportDeclarations()) {
      const target = declaration.getModuleSpecifierSourceFile();
      if (target !== undefined && toRepoRelative(target.getFilePath()).startsWith('src/')) queue.push(target);
    }
  }
  return seen;
}

/** `RUNTIME_ENV.<name>` 을 읽는 `파일#함수` 목록(정렬, 중복 제거). `config.ts`(선언)는 뺀다. */
function readersOf(name: string): string[] {
  const readers: string[] = [];
  for (const file of getProject().getSourceFiles()) {
    const path = toRepoRelative(file.getFilePath());
    if (!path.startsWith('src/') || path === 'src/runtime/config.ts') continue;
    for (const access of file.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
      if (access.getName() !== name) continue;
      const fn = access.getFirstAncestor((node) => node.getKind() === SyntaxKind.FunctionDeclaration);
      readers.push(`${path}#${fn?.asKind(SyntaxKind.FunctionDeclaration)?.getName() ?? '?'}`);
    }
  }
  return [...new Set(readers)].sort();
}

describe('관리 표면 권한 분리 — 코드 층', () => {
  it('① api 번들의 import 폐포에 src/admin/** 와 admin 조립이 없다(비공허: 라우터·조립 루트는 있다)', () => {
    const closure = runtimeClosure(`${HANDLERS}/api.ts`);
    expect(closure.has('src/runtime/router.ts')).toBe(true);
    expect(closure.has('src/runtime/composition.ts')).toBe(true);
    expect([...closure].filter((path) => path.startsWith('src/admin/') || path === 'src/runtime/admin-composition.ts')).toEqual([]);
    // 워커 번들도 마찬가지 — 에이전트 토큰이 닿지 않아도, 발송 역할 Lambda 에 소유자 코드를 싣지 않는다.
    for (const handler of ['approval-notifier', 'approval-release', 'scheduled-sender', 'inbound', 'migrate']) {
      const workerClosure = runtimeClosure(`${HANDLERS}/${handler}.ts`);
      expect([...workerClosure].filter((path) => path.startsWith('src/admin/')), handler).toEqual([]);
    }
  });

  it('② admin 번들의 import 폐포에 SES 전송단·알림 모듈·운영 조립 루트가 없다 · S3 는 읽기 전용 리더만(비공허: 관리 라우터·admin 조립은 있다)', () => {
    const closure = runtimeClosure(`${HANDLERS}/admin.ts`);
    expect(closure.has('src/admin/router.ts')).toBe(true);
    expect(closure.has('src/runtime/admin-composition.ts')).toBe(true);
    for (const forbidden of [
      'src/mail/transport/ses-transport.ts',
      'src/notify/approval-notifier.ts',
      'src/notify/owner-login-notifier.ts',
      'src/runtime/composition.ts',
      'src/policy/gate.ts',
    ]) {
      expect(closure.has(forbidden), forbidden).toBe(false);
    }
    // ★ S3 — 폐포 안에서 `s3-object-store` 로부터 가져오는 이름은 읽기 리더 조립에 필요한 것뿐이다(US-004).
    const S3_MODULE = 'src/storage/s3-object-store.ts';
    expect(closure.has(S3_MODULE)).toBe(true);
    const imported = new Set<string>();
    for (const path of closure) {
      for (const declaration of source(path).getImportDeclarations()) {
        const target = declaration.getModuleSpecifierSourceFile();
        if (target === undefined || toRepoRelative(target.getFilePath()) !== S3_MODULE) continue;
        expect(declaration.getNamespaceImport(), path).toBeUndefined();
        for (const named of declaration.getNamedImports()) imported.add(named.getName());
      }
    }
    expect([...imported].sort()).toEqual(['S3ObjectReadClient', 'createS3Client', 'createS3ObjectReader']);
  });

  it('③ 소유자 DB 롤 비밀을 읽는 조립은 migrate 둘뿐 · admin 은 admin 롤 비밀 · 그 조립을 부르는 핸들러는 각자 하나', () => {
    expect(readersOf('dbMigrationSecretArn')).toEqual(
      ['src/runtime/composition.ts#composeMigration', 'src/runtime/composition.ts#composeRoleBootstrap'].sort(),
    );
    expect(readersOf('dbAdminSecretArn')).toEqual(
      ['src/runtime/admin-composition.ts#composeAdmin', 'src/runtime/composition.ts#composeRoleBootstrap'].sort(),
    );
    expect(readersOf('dbLoginMailerSecretArn')).toEqual(
      ['src/runtime/composition.ts#composeRoleBootstrap', 'src/runtime/login-mailer-composition.ts#composeLoginMailer'].sort(),
    );

    const composers = new Map([
      ['composeAdmin', 'src/runtime/admin-composition.ts'],
      ['composeLoginMailer', 'src/runtime/login-mailer-composition.ts'],
      ['composeMigration', 'src/runtime/composition.ts'],
      ['composeRoleBootstrap', 'src/runtime/composition.ts'],
    ]);
    const callers: string[] = [];
    for (const file of getProject().getSourceFiles()) {
      const path = toRepoRelative(file.getFilePath());
      if (!path.startsWith('src/')) continue;
      for (const declaration of file.getImportDeclarations()) {
        const target = declaration.getModuleSpecifierSourceFile();
        if (target === undefined) continue;
        for (const named of declaration.getNamedImports()) {
          if (composers.get(named.getName()) === toRepoRelative(target.getFilePath())) callers.push(path);
        }
      }
    }
    expect([...new Set(callers)].sort()).toEqual([`${HANDLERS}/admin.ts`, `${HANDLERS}/login-mailer.ts`, `${HANDLERS}/migrate.ts`]);

    // admin·login-mailer 조립은 앱·소유자 롤 비밀을 읽지도 요구하지도 않는다.
    for (const path of ['src/runtime/admin-composition.ts', 'src/runtime/login-mailer-composition.ts']) {
      const names = source(path).getDescendantsOfKind(SyntaxKind.PropertyAccessExpression).map((access) => access.getName());
      expect(names.filter((name) => name === 'dbSecretArn' || name === 'dbMigrationSecretArn' || name === 'dbMasterSecretArn'), path).toEqual([]);
    }
  });

  it('⑤ login-mailer 번들: 운영 조립 루트·관문·S3·관리 코드가 없다 · 로그인 키를 읽는 조립은 admin·login-mailer 둘뿐 (H1)', () => {
    const closure = runtimeClosure(`${HANDLERS}/login-mailer.ts`);
    expect(closure.has('src/runtime/login-mailer-composition.ts')).toBe(true);
    expect(closure.has('src/notify/owner-login-notifier.ts')).toBe(true);
    expect(closure.has('src/workers/owner-login-notifier.ts')).toBe(true);
    for (const forbidden of ['src/runtime/composition.ts', 'src/policy/gate.ts', 'src/storage/s3-object-store.ts', 'src/notify/approval-notifier.ts']) {
      expect(closure.has(forbidden), forbidden).toBe(false);
    }
    expect([...closure].filter((path) => path.startsWith('src/admin/') || path.startsWith('src/api/'))).toEqual([]);
    expect(readersOf('ownerLoginKeysSecretArn')).toEqual(
      ['src/runtime/admin-composition.ts#composeAdmin', 'src/runtime/login-mailer-composition.ts#composeLoginMailer'].sort(),
    );
    // 로그인 알림 워커를 import 하는 핸들러는 login-mailer 하나다(approval-notifier 는 더 이상 돌리지 않는다).
    const importers = getProject()
      .getSourceFiles()
      .map((file) => toRepoRelative(file.getFilePath()))
      .filter((path) => path.startsWith(`${HANDLERS}/`) && runtimeClosure(path).has('src/workers/owner-login-notifier.ts'));
    expect(importers).toEqual([`${HANDLERS}/login-mailer.ts`]);
  });

  it('④ 관리 라우터 표: 세션 변경 경로는 전부 CSRF · 승인 결정(approve·reject·decision) 경로 없음 · 관리 경로는 /admin 접두어 없음', () => {
    const mutating = ADMIN_ROUTES.filter((route) => route.auth === 'session' && route.method !== 'GET');
    expect(mutating.length).toBeGreaterThan(5);
    for (const route of mutating) expect(route.csrf, `${route.method} ${route.path}`).toBe(true);
    // 콘솔 웹훅 관리(2026-09-30) — 여덟 경로(인증 헤더 둘 포함)가 표에 있고 전부 세션 라우트다(쓰기 넷은 위 단언대로 CSRF). 시크릿이 나가는 두 경로(등록·회전)는 POST.
    const webhookRoutes = ADMIN_ROUTES.filter((route) => route.path.startsWith('/api/agents/{agentId}/webhooks'))
      .map((route) => `${route.method} ${route.path} ${route.auth} csrf=${String(route.csrf)}`)
      .sort();
    expect(webhookRoutes).toEqual(
      [
        'GET /api/agents/{agentId}/webhooks session csrf=false',
        'POST /api/agents/{agentId}/webhooks session csrf=true',
        'GET /api/agents/{agentId}/webhooks/deliveries session csrf=false',
        'POST /api/agents/{agentId}/webhooks/deliveries/{deliveryId}/redeliver session csrf=true',
        'DELETE /api/agents/{agentId}/webhooks/{webhookId} session csrf=true',
        'POST /api/agents/{agentId}/webhooks/{webhookId}/rotate session csrf=true',
        // 인증 헤더(202610141400) — 설정·교체 · 지우기. 콘솔만(에이전트 토큰은 등록 때만).
        'POST /api/agents/{agentId}/webhooks/{webhookId}/authorization session csrf=true',
        'DELETE /api/agents/{agentId}/webhooks/{webhookId}/authorization session csrf=true',
      ].sort(),
    );
    // **발송** 승인의 결정은 서명 링크 한 경로뿐이다 — 콘솔에 approve · reject 경로가 있으면 안 된다. 예외는 **정책 변경 요청**(ADR-0007 2026-10-13)의 결정
    //   둘뿐이다: 발송이 아니라 소유자가 정책을 바꾸는 관리 연산(PATCH /policy · POST /rules 와 같은 admin 역할 · 세션 · CSRF)이다.
    const POLICY_REQUEST_DECISIONS = [
      'POST /api/agents/{agentId}/change-requests/{requestId}/approve',
      'POST /api/agents/{agentId}/change-requests/{requestId}/reject',
    ];
    const decisions = ADMIN_ROUTES.filter((route) => /approve|reject|decision/.test(route.path));
    expect(decisions.map((route) => `${route.method} ${route.path}`).sort()).toEqual(POLICY_REQUEST_DECISIONS);
    for (const route of decisions) expect([route.auth, route.csrf, route.role], route.path).toEqual(['session', true, 'admin']);
    for (const route of ADMIN_ROUTES) {
      if (!POLICY_REQUEST_DECISIONS.includes(`${route.method} ${route.path}`)) expect(route.path, route.path).not.toMatch(/approve|reject|decision/);
      if (/approvals/.test(route.path)) expect(route.method).toBe('GET');
      expect(route.path.startsWith('/admin')).toBe(false);
    }
    // 세션 없이 도는 경로는 로그인 둘 + 셀프 가입 둘(signup-contract.md §5) + 초대 claim(확장성 P1 — 토큰만, 이 브라우저에 결속된 로그인
    //   링크를 초대받은 주소로) + 페이지 여섯(초대 착지 포함) + 파비콘 여섯(콘솔 v5 — 정적 그림, 세션·DB 무관) + 세션 힌트 하나
    //   (2026-09-30 — 읽기 전용 `{signedIn}`, 쓰기·쿠키 없음)뿐이다.
    expect(ADMIN_ROUTES.filter((route) => route.auth !== 'session').map((route) => `${route.method} ${route.path}`).sort()).toEqual(
      [
        'GET /',
        // 파비콘 여섯(2026-09-30 — 해시 경로 셋 + 옛 고정 경로 셋, `src/ui/favicon.ts`).
        ...FAVICON_PATHS.map((path) => `GET ${path}`),
        'GET /app',
        'GET /invite',
        'POST /api/invites/claim',
        'GET /login',
        'GET /signup',
        'GET /signup/verify',
        'POST /api/login',
        'POST /api/login/verify',
        'POST /api/signup',
        'POST /api/signup/verify',
        // 대기자 명단 등록(202609301520) — 세션 전 · 홈 출처.
        'POST /api/waitlist',
        'GET /api/session/hint',
      ].sort(),
    );
  });
});
