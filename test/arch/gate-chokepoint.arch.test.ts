/**
 * Layer B — Call-graph chokepoint (계획 §5.0 "Layer B").
 *
 * **주장 (정방향):** 전송단 `src/mail/transport/ses-transport.ts` 의 export 를 참조하는
 * 프로덕션 파일은 `src/policy/gate.ts` 하나뿐이다.
 * **주장 (역방향):** `gate.dispatch` 는 평가(`evaluate`)와 audit 기록을 **건너뛰는 분기 없이**
 * 호출한다.
 *
 * **이 층이 잡는 것**
 * - 프리모템 시나리오 1: 워커가 관문을 거치지 않고 `sesTransport.send` 를 직접 부르는 코드.
 *   Layer C 는 이것을 못 잡는다 — 그 워커는 진입점 분할에서 (i) 을 만족할 수도 있기 때문이다.
 * - 관문 안에서 평가나 기록을 빼먹는 경로(역방향 단언).
 *
 * **이 층이 못 잡는 것**
 * - 전송단을 아예 거치지 않는 발송(직접 SDK 사용 → Layer A, IAM 우회 → Layer E).
 * - gate 를 import 조차 하지 않는 새 진입점 → **Layer C**.
 * - `dispatch` 안에서 호출은 하지만 결과를 무시하는 코드. AST 는 호출 유무만 본다.
 *   그 층은 Layer D(런타임 deny-all 매트릭스)가 맡는다.
 * - **호출이 어떤 분기 안에 있는지.** 역방향 단언은 `dispatch` 에서 도달 가능한
 *   호출 그래프에 그 호출이 *존재하는지*만 본다. `if (never) audit.record(...)` 처럼
 *   실행되지 않는 분기에 놓인 호출은 여전히 만족으로 센다. 실행 여부는 Layer D 와
 *   단위 테스트가 맡는다.
 * - `gate.ts` **밖으로** 옮겨진 중간 함수. 호출 그래프 추적은 `gate.ts` 안에서만
 *   전이한다(`dispatch` → `safeEvaluate` → `evaluate` 가 그 경로다). 관문 로직이
 *   다른 파일로 흩어지면 그 사실 자체가 AC-8 의 문제이고, 여기서는 빨간불이 된다.
 *
 * **P1a 현재 상태:** 전송단도 관문도 아직 없다(P1b/P1a 후반). 그래서 정방향 단언의
 * 대상은 0건이며, **그 사실 자체를 아래에서 명시적으로 단언한다** — "파일이 없어서
 * 조용히 통과"가 아니라 "파일이 없음을 확인하고 통과"여야 나중에 파일이 생긴 순간
 * 규칙이 자동으로 켜진다.
 */

import { describe, expect, it } from 'vitest';
import { Node, SyntaxKind, type CallExpression, type SourceFile } from 'ts-morph';
import { getProject, importsModule, repoFileExists, toRepoRelative } from './support/project';

const TRANSPORT_FILE = 'src/mail/transport/ses-transport.ts';
const GATE_FILE = 'src/policy/gate.ts';

/**
 * 소유자 승인 알림 모듈(P2, 리드 결정 (b)) — **관문 밖에서 전송단을 참조하는 유일한 프로덕션 파일.**
 * 와일드카드(`src/notify/**`)가 아니라 **파일 이름**이다: 디렉터리를 열면 그 아래 새 파일이 검사 없이
 * 전송단에 닿는다 — P1b 가 `test/**` 와일드카드로 한 번 치른 교훈이다.
 */
const NOTIFIER_FILE = 'src/notify/approval-notifier.ts';

/**
 * 소유자 **로그인 링크** 알림 모듈(관리 백엔드, 2026-09-23) — 승인 알림과 **같은 규율**의 두 번째 시스템 메일. 표면 동결은
 * 아래 "로그인 알림 경로" 절이 본다. 이 모듈은 approval-notifier Lambda(발송 역할 하나)에서만 돈다 — admin Lambda 는 SES 0.
 */
const LOGIN_NOTIFIER_FILE = 'src/notify/owner-login-notifier.ts';

/**
 * **가입 확인** 알림 모듈(셀프 가입, 2026-09-24) — 세 번째 시스템 메일. 로그인 알림과 같은 전용 Lambda(`atmark-login-mailer`)에서
 * 돈다. 수신자가 `signup_links.email`(요청자 입력)이라는 점이 다르다 — 표면 동결은 아래 "가입 알림 경로" 절이 본다.
 */
const SIGNUP_NOTIFIER_FILE = 'src/notify/signup-notifier.ts';

/**
 * **조직 초대** 알림 모듈(확장성 P1 R-1, 2026-09-25) — 다섯 번째 시스템 메일. 로그인·가입 메일과 같은 전용 Lambda(`atmark-login-mailer`)
 * 에서 돈다. 수신자가 owner 가 입력한 주소(`users.email ← org_invites.user_id`)다 — 표면 동결은 아래 "초대 알림 경로" 절이 본다.
 */
const INVITE_NOTIFIER_FILE = 'src/notify/invite-notifier.ts';

/**
 * **셀프 가입 환영** 알림 모듈(2026-09-30, 202609301510) — 일곱째 시스템 메일. 로그인 메일과 같은 전용 Lambda 에서 기능 플래그가 켜졌을 때만 돈다.
 * 수신자는 새 가입자(`users.email ← welcome_mails.user_id`)이고 본문은 상수 문구다 — 표면 동결은 아래 "환영 알림 경로" 절이 본다.
 */
const WELCOME_NOTIFIER_FILE = 'src/notify/welcome-notifier.ts';

/**
 * **대기 확인 · 초대** 알림 모듈(202609301520) — 여덟째 시스템 메일. 로그인 메일과 같은 전용 Lambda 에서 돈다. 수신자는 보내는 순간의
 * `waitlist_entries.email`(메일 행 → 항목)이고 본문은 상수 문구다(보간 = 초대 링크의 fragment 하나) — 표면 동결은 아래 "대기자 명단 알림 경로" 절.
 */
const WAITLIST_NOTIFIER_FILE = 'src/notify/waitlist-notifier.ts';

/**
 * **고객 도메인 알림** 모듈(ADR-0014 단계 4 M3b) — 아홉째 시스템 메일. 승인 알림과 같은 Lambda · 같은 발송 역할에서 돈다. 수신자는 정의자 함수
 * `atmark_claim_domain_notice` 가 돌려주는 그 조직의 owner · admin 이고 본문은 상수 문구 + 도메인 이름 · 그 조직 에이전트 이름 — 표면 동결은 아래
 * "도메인 알림 경로" 절이 본다.
 */
const DOMAIN_NOTIFIER_FILE = 'src/notify/domain-notifier.ts';

/**
 * **격리 알림** 모듈(ADR-0016 2026-10-07 개정 · 202610071000) — 열째 시스템 메일. 승인 알림과 같은 Lambda · 같은 발송 역할에서 돈다. 수신자는 정의자
 * 함수 `atmark_claim_quarantine_notice` 가 돌려주는 그 조직의 owner_email(승인 알림과 같은 수신자)이고 본문은 상수 문구 + 에이전트 이름 · 수 · 검사한
 * 도메인 — 표면 동결은 아래 "격리 알림 경로" 절이 본다.
 */
const QUARANTINE_NOTIFIER_FILE = 'src/notify/quarantine-notifier.ts';

/**
 * **운영자 콘솔 코드** 알림 모듈(`.omc/plans/ops-console.md` §3.4, 2026-09-28) — 여섯째 시스템 메일. 로그인 메일과 같은 전용 Lambda 에서 돈다.
 * 공개 API 는 `challengeId` 하나 · 수신자는 DB(운영자 행 · 도전 주소) — 표면은 `test/unit/notify/ops-code-template.test.ts` 와
 * `test/integration/ops/mailer-isolation.test.ts` 가 본다.
 */
const OPS_CODE_NOTIFIER_FILE = 'src/notify/ops-code-notifier.ts';

/** 멤버 목록(`src/admin/ops/members.ts`) — 주 소유자 표시를 위해 `owner_email` 을 **대조만** 한다(수신자를 고르지 않는다). */
const ADMIN_MEMBERS_FILE = 'src/admin/ops/members.ts';

/**
 * **문의 전달** 모듈(US-009, ADR-0009) — 네 번째 시스템 메일. 발송 역할 Lambda(`atmark-contact-forwarder`)에서 돈다. 수신자가 운영자
 * 한 곳(비밀)이고 원 발신자는 Reply-To 로만 간다 — 표면 동결은 아래 "문의 전달 경로" 절이 본다.
 */
const CONTACT_FORWARDER_FILE = 'src/notify/contact-forwarder.ts';

/** 관리 로그인 — 입력 이메일을 `owner_email` 과 **대조만** 한다(수신자를 고르지 않는다 — 메일은 위 모듈이 DB 에서 다시 읽는다). */
const ADMIN_SESSION_FILE = 'src/admin/session.ts';
/**
 * 운영자 화면의 표시 읽기(`.omc/plans/ops-console.md` P0 — `scripts/ops-web`·`scripts/admin/org-review` 에서 `src/ops/**` 로 옮겼다. P1 에 읽기는
 * `console/reads.ts` 하나로 모았다 — 로컬 화면(소유자 롤)과 호스팅 콘솔(`atmark_ops` 컬럼 GRANT)이 같이 쓴다). 조직 소유자 주소 · 멤버 주소를 **화면에 그리기만** 한다(발송면이 아니다 — 전송단·알림 모듈을 import 하지 않는다, 아래 단언). 이름으로 더한다.
 */
const OPS_DISPLAY_FILES: readonly string[] = ['src/ops/console/reads.ts', 'src/ops/console/api.ts', 'src/ops/core/review.ts'];

/** 제한 롤 권한 허용 목록(ADR-0006) — `owner_email` 을 **권한 표기**로 언급한다(SQL 아님). */
const ROLE_BOOTSTRAP_FILE = 'src/runtime/role-bootstrap.ts';

/**
 * **로그인 메일 Lambda 의 조립 루트**(ADR-0006) — SES **클라이언트**(`createSesClient`)를 만들어 로그인 알림 모듈에 넘긴다.
 * 에이전트 전송단(`createSesTransport`)은 참조하지 않는다(아래 단언) — 운영 조립 루트(`composition.ts`)와 같은 자리의 두 번째
 * 파일이다. api·워커 조립(`composition.ts`)에 두지 않은 이유: 그 번들에 에이전트 전송단·S3·관문이 함께 실린다.
 */
const LOGIN_MAILER_COMPOSITION_FILE = 'src/runtime/login-mailer-composition.ts';

/**
 * **운영 조립 루트**(D1 배포 준비) — Lambda 핸들러의 의존성을 만드는 유일한 프로덕션 파일. 에이전트 전송단
 * (`createSesTransport`)을 조립해 라우트·워커의 `transport` 슬롯에 넣고, 그 슬롯은 관문으로만 흐른다. 알림 모듈에는
 * SES 클라이언트(`createSesClient`)만 준다. **파일 이름**이다 — `src/runtime/**` 가 아니다: 핸들러·라우터가 전송단에
 * 닿으면 이 목록 밖이라 빨개진다. 이 파일이 전송단의 `send` 를 직접 부르지 않는다는 것은
 * `test/unit/runtime/composition.test.ts` 가 AST 로 본다.
 */
const RUNTIME_COMPOSITION_FILE = 'src/runtime/composition.ts';

/**
 * 전송단 export 를 참조해도 되는 **프로덕션** 파일.
 *
 * **P2 에서 셋이 됐다.** 알림 모듈이 들어온 대가로 "관문이 유일한 발송면" 은 "관문 + 표면이 동결된 알림
 * 모듈" 이 됐다. 알림 모듈의 표면(공개 API 가 `approvalId` 만 받는다·의존성에 문자열이 없다·전송단에서
 * 알림면만 쓴다)은 아래 "알림 경로" 절이 단언한다 — 그 절이 없으면 이 한 줄은 두 번째 관문을 허락하는 것이다.
 */
const TRANSPORT_REFERRER_ALLOWLIST: readonly string[] = [
  TRANSPORT_FILE,
  GATE_FILE,
  NOTIFIER_FILE,
  LOGIN_NOTIFIER_FILE,
  SIGNUP_NOTIFIER_FILE,
  INVITE_NOTIFIER_FILE,
  OPS_CODE_NOTIFIER_FILE,
  WELCOME_NOTIFIER_FILE,
  WAITLIST_NOTIFIER_FILE,
  DOMAIN_NOTIFIER_FILE,
  QUARANTINE_NOTIFIER_FILE,
  CONTACT_FORWARDER_FILE,
  RUNTIME_COMPOSITION_FILE,
  LOGIN_MAILER_COMPOSITION_FILE,
];

/**
 * 전송단 export 를 참조해도 되는 **테스트** 파일 — **이름으로 못 박는다.**
 *
 * > **P1b 정정.** 예전 판정은 `relative.startsWith('test/')` 였다. 그 한 줄이
 * > 허용목록을 사실상 무한대로 만들었고, 바로 아래 크기 단언(*"이 층의 강도는 전적으로
 * > 허용목록의 크기다"*)은 그 와일드카드를 **세지 않았다.** 실제 크기는 `2 + |test/**|`
 * > 였다.
 * >
 * > 그게 이론적 결함이 아닌 이유: `createSesClient()` + `createSesTransport()` 를
 * > 조립해 실제로 `.send()` 를 내는 **유일한 코드가 아래 첫 항목**이고, 2026-09-22 의
 * > 첫 실발송이 그 경로로 나갔다. 즉 `src/` 에는 실발송 조립 루트가 없었고, AC-8 의
 * > "우회 경로 0개" 는 `src/` 에 대해서만 참이었다. 와일드카드 아래에서는 `test/` 에
 * > 새 조립 루트가 생겨도 **CI 가 아무 말도 하지 않는다.**
 *
 * 이 목록에 줄을 더하는 것은 "전송단을 직접 조립하는 코드가 하나 늘었다" 는 뜻이고,
 * 그 판단은 리드의 것이다. 크기 단언이 그 추가를 반드시 리뷰로 끌어온다.
 * (변이 G 가 이 단언이 깨어 있는지를 매 CI 에서 확인한다.)
 */
const TRANSPORT_TEST_REFERRER_ALLOWLIST: readonly string[] = [
  // 실발송 조립 루트. 프로덕션 조립 루트(람다 핸들러 등)가 생기는 날 이 자리가 옮겨간다.
  'test/integration/outbound/support/transport.ts',
  // 전송단 자신의 단위 테스트.
  'test/unit/mail/ses-transport.test.ts',
];

function isAllowedReferrer(relative: string): boolean {
  return (
    TRANSPORT_REFERRER_ALLOWLIST.includes(relative) ||
    TRANSPORT_TEST_REFERRER_ALLOWLIST.includes(relative)
  );
}

/** 전송단 export 를 참조하는 파일 전부(리포 상대 경로). 허용 여부는 호출자가 가른다. */
function transportReferrers(): readonly string[] | null {
  const project = getProject();
  const transport = project.getSourceFiles().find((f) => toRepoRelative(f.getFilePath()) === TRANSPORT_FILE);
  if (!transport) return null;

  const referrers = new Set<string>();
  for (const [, declarations] of transport.getExportedDeclarations()) {
    for (const declaration of declarations) {
      const identifiers = [
        ...(declaration.getKind() === SyntaxKind.Identifier ? [declaration] : []),
        ...declaration.getDescendantsOfKind(SyntaxKind.Identifier),
      ];
      const named = identifiers.find((node) => node.getParent() === declaration) ?? identifiers[0];
      if (!named || named.getKind() !== SyntaxKind.Identifier) continue;

      const referencable = named.asKindOrThrow(SyntaxKind.Identifier);
      for (const reference of referencable.findReferencesAsNodes()) {
        referrers.add(toRepoRelative(reference.getSourceFile().getFilePath()));
      }
    }
  }
  return [...referrers];
}

describe('Layer B — transport chokepoint (정방향)', () => {
  it('참조 허용목록은 관문과 전송단 자신뿐이다 — 목록이 늘면 리뷰로 끌어온다', () => {
    // 이 층의 강도는 전적으로 허용목록의 크기다. 목록에 한 줄이 조용히 추가되면
    // 관문이 둘이 되고 AC-8("단일 관문")은 그 순간 거짓이 된다. 숫자를 못 박아
    // 목록 변경이 반드시 이 단언의 변경과 함께 리뷰에 올라오게 한다.
    // D1: 운영 조립 루트가 넷째다(이름으로). 관리 백엔드: 로그인 링크 알림 모듈이 다섯째다(표면 동결 — 아래 절).
    // ADR-0006: 로그인 메일 Lambda 의 조립 루트가 여섯째다(SES 클라이언트만 — 에이전트 전송단 참조 0, 아래 단언).
    // 셀프 가입: 가입 확인 알림 모듈이 일곱째다(표면 동결 — 아래 "가입 알림 경로" 절).
    // US-009: 문의 전달 모듈이 여덟째다(표면 동결 — 아래 "문의 전달 경로" 절).
    // 확장성 P1: 조직 초대 알림 모듈이 아홉째다(표면 동결 — 아래 "초대 알림 경로" 절).
    // 운영자 콘솔: 운영 코드 알림 모듈이 열째다(공개 API challengeId 하나 · 수신자는 DB).
    // 셀프 가입 환영 메일: 환영 알림 모듈이 열한째다(표면 동결 — 아래 "환영 알림 경로" 절).
    // 대기자 명단: 대기 확인 · 초대 알림 모듈이 열두째다(표면 동결 — 아래 "대기자 명단 알림 경로" 절).
    // 고객 도메인(ADR-0014 M3b): 도메인 알림 모듈이 열셋째다(표면 동결 — 아래 "도메인 알림 경로" 절).
    // 격리 알림(ADR-0016 2026-10-07): 격리 알림 모듈이 열넷째다(표면 동결 — 아래 "격리 알림 경로" 절).
    expect([...TRANSPORT_REFERRER_ALLOWLIST].sort()).toEqual(
      [
        'src/mail/transport/ses-transport.ts',
        'src/notify/domain-notifier.ts',
        'src/notify/quarantine-notifier.ts',
        'src/policy/gate.ts',
        'src/notify/approval-notifier.ts',
        'src/notify/owner-login-notifier.ts',
        'src/notify/signup-notifier.ts',
        'src/notify/invite-notifier.ts',
        'src/notify/ops-code-notifier.ts',
        'src/notify/welcome-notifier.ts',
        'src/notify/waitlist-notifier.ts',
        'src/notify/contact-forwarder.ts',
        'src/runtime/composition.ts',
        'src/runtime/login-mailer-composition.ts',
      ].sort(),
    );
  });

  it('테스트 쪽 허용목록도 이름 2개로 못 박혀 있다 — 와일드카드가 없다', () => {
    // 위 단언과 같은 취지이며, **와일드카드가 이 단언 밖에 있었다는 것이 P1b 의 결함이었다.**
    expect([...TRANSPORT_TEST_REFERRER_ALLOWLIST].sort()).toEqual([
      'test/integration/outbound/support/transport.ts',
      'test/unit/mail/ses-transport.test.ts',
    ]);
  });

  it('전송단의 export 를 참조하는 프로덕션 파일은 관문뿐이다', () => {
    const referrers = transportReferrers();
    if (referrers === null) {
      // 대상 0건. P1b 에서 전송단이 들어오면 이 분기는 더 이상 타지 않는다.
      expect(repoFileExists(TRANSPORT_FILE)).toBe(false);
      return;
    }

    const offenders = referrers.filter((relative) => !relative.startsWith('test/') && !isAllowedReferrer(relative));
    expect(offenders.sort()).toEqual([]);
  });

  it('전송단을 참조하는 test 파일은 이름으로 허용된 것뿐이다', () => {
    const referrers = transportReferrers();
    if (referrers === null) {
      expect(repoFileExists(TRANSPORT_FILE)).toBe(false);
      return;
    }

    const offenders = referrers.filter((relative) => relative.startsWith('test/') && !isAllowedReferrer(relative));
    expect(
      offenders.sort(),
      '전송단을 직접 참조하는 test 파일이 늘었다. 실발송 조립 루트가 하나 더 생겼다는 뜻이고, ' +
        'AC-8 의 "우회 경로 0개" 는 그 파일에 대해 아직 증명되지 않았다 — ' +
        'TRANSPORT_TEST_REFERRER_ALLOWLIST 에 이름으로 올리고 그 추가를 리뷰에 걸어라.',
    ).toEqual([]);
  });
});

/**
 * **역방향 단언의 판정 도구 — 문자열이 아니라 식별자 해석이다.**
 *
 * 예전 구현은 `gate.ts` **파일 전체**의 호출식 텍스트를 모아 `/evaluate/` 와 `/audit/i`
 * 를 훑었다. 그 판정에는 두 구멍이 있었다:
 *   ① `/audit/i` 가 `send()` 의 `deps.audit.resolve(...)` 에 매칭돼, `dispatch` 에서
 *      `audit.record` 를 통째로 지워도 통과했다.
 *   ② `/evaluate/` 가 `safeEvaluate` **내부**의 `evaluate(...)` 에 매칭돼, `dispatch` 가
 *      `safeEvaluate` 를 부르지 않아도 통과했다.
 * 즉 "관문이 평가·기록을 건너뛰지 않는다" 는 명제가 한 번도 검증되지 않았다.
 * 지금은 `dispatch` 본문에서 출발해 **`gate.ts` 안의 호출만 전이**하며, 각 호출의
 * callee 를 선언까지 해석해서 대조한다.
 */
const ENGINE_FILE = 'src/policy/engine.ts';

/** 호출식의 callee 가 가리키는 **선언** 노드들. import 별칭·네임스페이스를 따라간다. */
function calleeDefinitions(call: CallExpression): Node[] {
  const expression = call.getExpression();
  const identifier =
    expression.asKind(SyntaxKind.Identifier) ??
    expression.asKind(SyntaxKind.PropertyAccessExpression)?.getNameNode().asKind(SyntaxKind.Identifier);
  if (!identifier) return [];
  return identifier.getDefinitionNodes();
}

/** `src/policy/engine.ts` 의 `evaluate` 인가. gate 안의 동명 지역 함수는 여기 안 걸린다. */
function isPolicyEvaluate(definition: Node): boolean {
  return (
    Node.isFunctionDeclaration(definition) &&
    definition.getName() === 'evaluate' &&
    toRepoRelative(definition.getSourceFile().getFilePath()) === ENGINE_FILE
  );
}

/**
 * `AuditSink.record` 인가.
 * 파일 경로가 아니라 **선언의 소속 인터페이스 이름**으로 판정한다 — audit 모듈이 P1b 에
 * 별도 파일로 빠져도(§6 P1b 9번) 이 단언이 거짓 실패하지 않게 하기 위해서다.
 * 반대로 `resolve` 는 이름이 달라 걸리지 않는다: 그 구분이 예전 `/audit/i` 에는 없었다.
 */
function isAuditRecord(definition: Node): boolean {
  if (!Node.isMethodSignature(definition) && !Node.isMethodDeclaration(definition)) return false;
  if (definition.getName() !== 'record') return false;
  const owner = definition.getParent();
  return Node.isInterfaceDeclaration(owner) && owner.getName() === 'AuditSink';
}

interface ReverseReach {
  readonly callsPolicyEvaluate: boolean;
  readonly callsAuditRecord: boolean;
}

/**
 * `dispatch` 에서 도달 가능한 호출 그래프를 `gate.ts` 안에서만 전이하며 두 표적을 찾는다.
 * `dispatch` → `safeEvaluate` → `engine.evaluate` 가 P1a 의 실제 경로다.
 */
function reverseReach(entry: Node, gateRelative: string): ReverseReach {
  const visited = new Set<Node>();
  let callsPolicyEvaluate = false;
  let callsAuditRecord = false;

  const walk = (node: Node): void => {
    if (visited.has(node)) return;
    visited.add(node);

    for (const call of node.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      for (const definition of calleeDefinitions(call)) {
        if (isPolicyEvaluate(definition)) {
          callsPolicyEvaluate = true;
          continue;
        }
        if (isAuditRecord(definition)) {
          callsAuditRecord = true;
          continue;
        }
        const sameFile = toRepoRelative(definition.getSourceFile().getFilePath()) === gateRelative;
        if (sameFile && (Node.isFunctionDeclaration(definition) || Node.isVariableDeclaration(definition))) {
          walk(definition);
        }
      }
    }
  };

  walk(entry);
  return { callsPolicyEvaluate, callsAuditRecord };
}

describe('Layer B — gate 내부 불변식 (역방향)', () => {
  it('gate.dispatch 는 평가와 audit 기록을 모두 호출한다 (관문 부재 시: 적용 대상 없음)', () => {
    const project = getProject();
    const gate = project.getSourceFiles().find((f) => toRepoRelative(f.getFilePath()) === GATE_FILE);

    if (!gate) {
      // **관문 부재를 명시적으로 단언한다.** `.skip` 을 쓰지 않는 이유: 스킵은 CI 요약에서
      // 노란불로 남아 "언젠가 켜질 것"처럼 보이지만 아무도 다시 켜지 않는다. 그리고
      // Layer F 의 사전 점검이 `test/arch/**` 의 스킵 마커를 금지한다 — 그 금지의 취지가
      // 바로 이것이다.
      //
      // 이 단언은 두 가지를 구분한다:
      //   (a) 관문이 아직 없다 → 적용 대상 없음.
      //   (b) 관문 파일은 디스크에 있는데 ts-morph 프로젝트가 로드하지 못했다 → tsconfig 나
      //       include 글롭이 깨진 것이고, 그 상태에서는 이 층 전체가 공허해진다. **실패해야 한다.**
      expect(
        repoFileExists(GATE_FILE),
        `${GATE_FILE} 이 디스크에는 있는데 ts-morph 프로젝트에 없다. tsconfig include 가 깨졌다 — ` +
          '이 상태에서는 Layer B 가 아무것도 검사하지 못한다.',
      ).toBe(false);
      return;
    }

    // **범위를 `dispatch` 로 못 박는다.** 파일 전체를 훑으면 관문 밖의 호출이 단언을
    // 대신 만족시킨다 — 그게 이 단언이 한 번도 아무것도 증명하지 못했던 이유다.
    const dispatch = gate.getFunction('dispatch');
    expect(
      dispatch,
      `${GATE_FILE} 에 dispatch 함수 선언이 없다. 관문의 진입 함수 이름이 바뀌었다면 ` +
        '이 단언의 범위도 함께 옮겨야 한다 — 그러지 않으면 역방향 단언이 공허해진다.',
    ).toBeDefined();
    if (!dispatch) return;

    const reach = reverseReach(dispatch, GATE_FILE);

    expect(
      reach.callsPolicyEvaluate,
      `dispatch 에서 ${ENGINE_FILE} 의 evaluate 로 가는 호출 경로가 없다 — 관문이 평가를 건너뛴다.`,
    ).toBe(true);
    expect(
      reach.callsAuditRecord,
      'dispatch 에서 AuditSink.record 로 가는 호출 경로가 없다 — 관문이 기록을 건너뛴다. ' +
        '(`resolve` 는 같은 인터페이스라도 기록이 아니다: 그건 이미 쓴 행의 갱신이다.)',
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 알림 경로 — 관문 밖의 두 번째 발송면이 에이전트 메일의 우회로가 되지 않는다 (P2)
// ---------------------------------------------------------------------------

/**
 * **주장:** `src/notify/approval-notifier.ts` 는 전송단을 참조할 수 있는(위 허용목록) 대신 표면이 동결돼 있다.
 *   ① export 가 정확히 동결 목록이다 — 새 export 는 리뷰로 끌려온다.
 *   ② 호출 가능한 export 는 `createApprovalNotifier` 하나이고, 그 인자는 의존성 하나다.
 *   ③ 그 의존성에 **문자열 속성이 없고** 이름이 동결돼 있다 — 수신자·발신자·URL·본문이 들어올 자리가 없다.
 *   ④ 공개 API(`ApprovalNotifier`)는 `notify(approvalId: string)` 하나다.
 *   ⑤ 이 모듈이 전송단에서 가져오는 것은 **알림면**뿐이다 — 에이전트 전송단(`createSesTransport`)을 쥐면
 *      이 파일이 `TransportRequest` 를 조립하는 두 번째 관문이 된다.
 *   ⑥ `owner_email` 을 다루는 SQL 은 알림 모듈(읽기)과 프로비저닝 저장소(INSERT)뿐이다 — 수신자가 나오는 곳이
 *      한 군데다.
 *
 * **이 절이 못 잡는 것:** 알림 모듈 **안에서** 수신자를 DB 가 아닌 곳에서 고르는 코드(예: 상수 주소로 바꿔치기).
 * 공개 표면이 닫혀 있으므로 그런 코드는 이 파일 자신의 diff 로만 들어올 수 있고, 그 diff 는 이 파일의
 * 이름이 허용목록에 올라 있다는 사실 때문에 리뷰 대상이다. 런타임 쪽은 통합 테스트
 * (`test/integration/approval/approval-notifier.test.ts` — "수신자는 owner_email 이다") 가 본다.
 */
const NOTIFIER_FROZEN_EXPORTS: readonly string[] = [
  'APPROVAL_NOTIFY_FROM_ADDRESS',
  'APPROVAL_NOTIFY_FROM_HEADER',
  'APPROVAL_NOTIFY_HOURLY_CAP_PER_ORG',
  'APPROVAL_NOTIFY_ROUTE_ID',
  'APPROVAL_PAGE_URL',
  'ApprovalNotifier',
  'ApprovalNotifierDependencies',
  'ApprovalNotifyOutcome',
  'createApprovalNotifier',
];

/** 의존성 속성의 동결 목록. 늘리는 것은 "알림 모듈이 바깥에서 받는 것이 늘었다" 는 선언이다. */
const NOTIFIER_FROZEN_DEPENDENCIES: readonly string[] = ['client', 'keyring', 'now', 'pool'];

/** 전송단에서 알림 모듈이 가져와도 되는 이름. */
const NOTIFIER_TRANSPORT_IMPORTS: readonly string[] = ['SesSendClient', 'createSesNotificationTransport'];

/** 의존성 속성 이름에 있으면 안 되는 어간 — 내용물·주소를 나르는 자리다. */
const NOTIFIER_FORBIDDEN_DEPENDENCY_STEMS = /(to|recipient|address|email|from|subject|body|text|html|url|link|template)/i;

const PROVISIONING_STORE_FILE = 'src/api/provisioning-store.ts';

/** SQL 문자열의 표지. 대문자 키워드는 이 저장소의 SQL 작성 규약이다. */
const SQL_VERB = /\b(SELECT|INSERT|UPDATE|DELETE|RETURNING|WHERE|JOIN)\b/;

function notifierSource(): SourceFile {
  const source = getProject()
    .getSourceFiles()
    .find((file) => toRepoRelative(file.getFilePath()) === NOTIFIER_FILE);
  if (!source) throw new Error(`${NOTIFIER_FILE} 을 ts-morph 가 읽지 못했다 — 이 절이 공허해진다.`);
  return source;
}

/** 선언이 **호출 가능한 값**인가 — 함수·클래스·호출 시그니처를 가진 변수. 타입 선언은 아니다. */
function isCallableExport(declaration: Node): boolean {
  if (Node.isFunctionDeclaration(declaration) || Node.isClassDeclaration(declaration)) return true;
  if (Node.isVariableDeclaration(declaration)) return declaration.getType().getCallSignatures().length > 0;
  return false;
}

describe('Layer B — 알림 경로: 관문 밖 발송면의 표면이 동결돼 있다 (P2)', () => {
  it('알림 모듈의 export 는 동결 목록과 정확히 같다', () => {
    const names = [...notifierSource().getExportedDeclarations().keys()].sort();
    expect(names).toEqual([...NOTIFIER_FROZEN_EXPORTS].sort());
  });

  it('알림 모듈에서 호출 가능한 export 는 createApprovalNotifier 하나이고 인자는 의존성 하나다', () => {
    const callable: string[] = [];
    for (const [name, declarations] of notifierSource().getExportedDeclarations()) {
      if (declarations.some(isCallableExport)) callable.push(name);
    }
    // **여기가 "수신자를 인자로 받는 export" 를 잡는 자리다.** 어떤 이름이든 호출 가능한 export 가 하나 더
    // 생기면 목록이 늘어난다 — 인자의 이름·타입을 추측하는 것이 아니라 **존재 자체**를 막는다.
    expect(callable.sort()).toEqual(['createApprovalNotifier']);

    const factory = notifierSource().getFunctionOrThrow('createApprovalNotifier');
    expect(factory.getParameters().map((parameter) => parameter.getType().getText(parameter))).toEqual([
      'ApprovalNotifierDependencies',
    ]);
    expect(factory.getReturnType().getText(factory)).toBe('ApprovalNotifier');
  });

  it('의존성에는 문자열 속성이 없고 속성 이름이 동결돼 있다 — 수신자·URL·본문이 들어올 자리가 없다', () => {
    const dependencies = notifierSource().getInterfaceOrThrow('ApprovalNotifierDependencies');
    const properties = dependencies.getProperties();
    expect(properties.map((property) => property.getName()).sort()).toEqual([...NOTIFIER_FROZEN_DEPENDENCIES]);
    // 확장(`extends`)으로 속성을 몰래 들이는 경로도 닫는다.
    expect(dependencies.getExtends()).toEqual([]);

    const offenders: string[] = [];
    for (const property of properties) {
      const type = property.getType();
      const stringish = type.isString() || type.isStringLiteral() || type.isTemplateLiteral() ||
        type.getUnionTypes().some((member) => member.isString() || member.isStringLiteral());
      if (stringish) offenders.push(`${property.getName()}: 문자열`);
      if (NOTIFIER_FORBIDDEN_DEPENDENCY_STEMS.test(property.getName())) offenders.push(`${property.getName()}: 금지 어간`);
      // 함수형 의존성(`now`)은 인자를 받지 않아야 한다 — 인자를 받는 콜백은 호출자가 값을 흘려 넣는 통로다.
      for (const signature of type.getCallSignatures()) {
        if (signature.getParameters().length > 0) offenders.push(`${property.getName()}: 인자를 받는 콜백`);
        if (signature.getReturnType().isString()) offenders.push(`${property.getName()}: 문자열을 돌려주는 콜백`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('공개 API ApprovalNotifier 는 notify(approvalId: string) 하나뿐이다', () => {
    const api = notifierSource().getInterfaceOrThrow('ApprovalNotifier');
    expect(api.getExtends()).toEqual([]);
    expect(api.getProperties().map((property) => property.getName())).toEqual([]);
    expect(api.getCallSignatures()).toEqual([]);
    const methods = api.getMethods();
    expect(methods.map((method) => method.getName())).toEqual(['notify']);
    const parameters = methods[0]?.getParameters() ?? [];
    expect(parameters.map((parameter) => `${parameter.getName()}: ${parameter.getType().getText(parameter)}`)).toEqual([
      'approvalId: string',
    ]);
  });

  it('알림 모듈이 전송단에서 가져오는 것은 알림면뿐이다 — 에이전트 전송단을 쥐지 않는다', () => {
    const imported: string[] = [];
    for (const declaration of notifierSource().getImportDeclarations()) {
      const target = declaration.getModuleSpecifierSourceFile();
      if (!target || toRepoRelative(target.getFilePath()) !== TRANSPORT_FILE) continue;
      // 네임스페이스·기본 import 는 무엇이든 꺼낼 수 있다 — 이름 목록 단언이 공허해진다.
      if (declaration.getNamespaceImport() || declaration.getDefaultImport()) imported.push('*');
      imported.push(...declaration.getNamedImports().map((named) => named.getName()));
    }
    expect(imported.sort()).toEqual([...NOTIFIER_TRANSPORT_IMPORTS].sort());
  });

  it('owner_email 을 다루는 SQL 은 승인 알림 모듈(읽기)과 프로비저닝 저장소(INSERT) · admin 대조뿐이다', () => {
    // 관리 백엔드(2026-09-23)가 둘을 **이름으로** 더했다: 로그인 링크 알림 모듈(수신자 읽기 — 승인 알림과 같은 규율)과
    // 관리 로그인(`admin/session.ts` — 입력 이메일 대조와 세션 조직의 `me` 표시). 뒤의 것은 **발송면이 아니다** — 전송단·
    // 알림 모듈을 import 하지 않는다(아래 단언). 대조 결과는 링크 행(조직 id)뿐이고 메일 주소는 알림 모듈이 DB 에서 다시 읽는다.
    const offenders: string[] = [];
    let notifierReads = 0;
    let loginNotifierReads = 0;
    let adminReads = 0;
    for (const source of getProject().getSourceFiles()) {
      const file = toRepoRelative(source.getFilePath());
      if (!file.startsWith('src/')) continue;
      const literals = [
        ...source.getDescendantsOfKind(SyntaxKind.StringLiteral),
        ...source.getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral),
        ...source.getDescendantsOfKind(SyntaxKind.TemplateExpression),
      ]
        // SQL 만 본다 — 매니페스트 `reason` 같은 설명 문장이 컬럼 이름을 언급하는 것은 읽기가 아니다.
        .filter((literal) => literal.getText().includes('owner_email') && SQL_VERB.test(literal.getText()));

      for (const literal of literals) {
        if (file === NOTIFIER_FILE) {
          notifierReads += 1;
          continue;
        }
        if (file === LOGIN_NOTIFIER_FILE) {
          loginNotifierReads += 1;
          continue;
        }
        if (file === ADMIN_SESSION_FILE || file === ADMIN_MEMBERS_FILE || OPS_DISPLAY_FILES.includes(file)) {
          adminReads += 1;
          continue;
        }
        // 프로비저닝은 **쓰기만** 한다 — 되읽는(RETURNING·SELECT) 순간 수신자를 아는 코드가 둘이 된다.
        if (file === PROVISIONING_STORE_FILE && /^.INSERT INTO organizations \(name, owner_email\)/.test(literal.getText())) {
          if (/RETURNING[^$]*owner_email/.test(literal.getText())) offenders.push(`${file}: RETURNING owner_email`);
          continue;
        }
        offenders.push(file);
      }
    }
    // 비공허성: 알림 모듈들이 실제로 그 컬럼을 읽고 있어야 이 단언이 무언가를 가른다.
    expect(notifierReads).toBeGreaterThan(0);
    // 로그인 알림 모듈은 202609250110 부터 owner_email 을 읽지 않는다 — 수신자는 링크 → 사용자(users.email). 다시 읽으면(= 조직 주소로
    //   회귀) 이 단언이 빨개진다(아래 "users.email" 절이 새 수신자 경로를 본다).
    expect(loginNotifierReads).toBe(0);
    expect(adminReads).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
    // 관리 로그인은 발송면이 아니다 — 전송단·알림 모듈을 import 하지 않는다.
    const admin = getProject().getSourceFiles().find((file) => toRepoRelative(file.getFilePath()) === ADMIN_SESSION_FILE);
    expect(admin).toBeDefined();
    if (admin === undefined) return;
    for (const forbidden of [TRANSPORT_FILE, NOTIFIER_FILE, LOGIN_NOTIFIER_FILE]) expect(importsModule(admin, forbidden), forbidden).toBe(false);
    // 운영자 화면의 표시 읽기도 발송면이 아니다.
    for (const path of OPS_DISPLAY_FILES) {
      const display = getProject().getSourceFiles().find((file) => toRepoRelative(file.getFilePath()) === path);
      expect(display, path).toBeDefined();
      if (display === undefined) continue;
      for (const forbidden of [TRANSPORT_FILE, NOTIFIER_FILE, LOGIN_NOTIFIER_FILE, INVITE_NOTIFIER_FILE]) expect(importsModule(display, forbidden), `${path} → ${forbidden}`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 로그인 알림 경로 (관리 백엔드, 2026-09-23) — 승인 알림 절과 같은 단언을 두 번째 시스템 메일에
// ---------------------------------------------------------------------------

const LOGIN_NOTIFIER_FROZEN_EXPORTS: readonly string[] = [
  'OWNER_LOGIN_FROM_ADDRESS',
  'OWNER_LOGIN_NOTIFY_HOURLY_CAP_PER_USER',
  'OWNER_LOGIN_NOTIFY_ROUTE_ID',
  // OWNER_LOGIN_PAGE_URL 은 2026-10-10 에 거뒀다 — 로그인 메일에 링크가 없다(코드만).
  'OwnerLoginNotifier',
  'OwnerLoginNotifierDependencies',
  'OwnerLoginNotifyOutcome',
  'createOwnerLoginNotifier',
];

function loginNotifierSource(): SourceFile {
  const source = getProject()
    .getSourceFiles()
    .find((file) => toRepoRelative(file.getFilePath()) === LOGIN_NOTIFIER_FILE);
  if (!source) throw new Error(`${LOGIN_NOTIFIER_FILE} 을 ts-morph 가 읽지 못했다 — 이 절이 공허해진다.`);
  return source;
}

describe('Layer B — 로그인 알림 경로: 두 번째 시스템 메일의 표면이 동결돼 있다 (관리 백엔드)', () => {
  it('export 는 동결 목록과 정확히 같고, 호출 가능한 export 는 createOwnerLoginNotifier(의존성 하나) 하나다', () => {
    expect([...loginNotifierSource().getExportedDeclarations().keys()].sort()).toEqual([...LOGIN_NOTIFIER_FROZEN_EXPORTS].sort());
    const callable: string[] = [];
    for (const [name, declarations] of loginNotifierSource().getExportedDeclarations()) {
      if (declarations.some(isCallableExport)) callable.push(name);
    }
    expect(callable).toEqual(['createOwnerLoginNotifier']);
    const factory = loginNotifierSource().getFunctionOrThrow('createOwnerLoginNotifier');
    expect(factory.getParameters().map((parameter) => parameter.getType().getText(parameter))).toEqual(['OwnerLoginNotifierDependencies']);
    expect(factory.getReturnType().getText(factory)).toBe('OwnerLoginNotifier');
  });

  it('의존성에 문자열 속성이 없고 이름이 승인 알림과 같은 넷으로 동결돼 있다', () => {
    const dependencies = loginNotifierSource().getInterfaceOrThrow('OwnerLoginNotifierDependencies');
    expect(dependencies.getExtends()).toEqual([]);
    const properties = dependencies.getProperties();
    expect(properties.map((property) => property.getName()).sort()).toEqual([...NOTIFIER_FROZEN_DEPENDENCIES]);
    const offenders: string[] = [];
    for (const property of properties) {
      const type = property.getType();
      if (type.isString() || type.isStringLiteral() || type.getUnionTypes().some((m) => m.isString() || m.isStringLiteral())) offenders.push(property.getName());
      if (NOTIFIER_FORBIDDEN_DEPENDENCY_STEMS.test(property.getName())) offenders.push(`${property.getName()}: 금지 어간`);
      for (const signature of type.getCallSignatures()) if (signature.getParameters().length > 0) offenders.push(`${property.getName()}: 인자 콜백`);
    }
    expect(offenders).toEqual([]);
  });

  it('공개 API OwnerLoginNotifier 는 notify(loginLinkId: string) 하나뿐이다', () => {
    const api = loginNotifierSource().getInterfaceOrThrow('OwnerLoginNotifier');
    expect(api.getExtends()).toEqual([]);
    expect(api.getProperties()).toEqual([]);
    const methods = api.getMethods();
    expect(methods.map((method) => method.getName())).toEqual(['notify']);
    expect((methods[0]?.getParameters() ?? []).map((p) => `${p.getName()}: ${p.getType().getText(p)}`)).toEqual(['loginLinkId: string']);
  });

  it('전송단에서 가져오는 것은 알림면뿐이다 — 에이전트 전송단을 쥐지 않는다', () => {
    const imported: string[] = [];
    for (const declaration of loginNotifierSource().getImportDeclarations()) {
      const target = declaration.getModuleSpecifierSourceFile();
      if (!target || toRepoRelative(target.getFilePath()) !== TRANSPORT_FILE) continue;
      if (declaration.getNamespaceImport() || declaration.getDefaultImport()) imported.push('*');
      imported.push(...declaration.getNamedImports().map((named) => named.getName()));
    }
    expect(imported.sort()).toEqual([...NOTIFIER_TRANSPORT_IMPORTS].sort());
  });

  it('로그인 메일 조립 루트(ADR-0006)가 전송단에서 가져오는 것은 SES 클라이언트·상수뿐이다 — 에이전트 전송단 없음', () => {
    const composition = getProject()
      .getSourceFiles()
      .find((file) => toRepoRelative(file.getFilePath()) === LOGIN_MAILER_COMPOSITION_FILE);
    expect(composition).toBeDefined();
    if (composition === undefined) return;
    const imported: string[] = [];
    for (const declaration of composition.getImportDeclarations()) {
      const target = declaration.getModuleSpecifierSourceFile();
      if (!target || toRepoRelative(target.getFilePath()) !== TRANSPORT_FILE) continue;
      if (declaration.getNamespaceImport() || declaration.getDefaultImport()) imported.push('*');
      imported.push(...declaration.getNamedImports().map((named) => named.getName()));
    }
    expect(imported.sort()).toEqual(['SES_CONFIGURATION_SET', 'SES_REGION', 'SesSendClient', 'createSesClient'].sort());
    // 관문도 import 하지 않는다 — 이 Lambda 는 에이전트 메일을 보내지 않는다.
    expect(importsModule(composition, GATE_FILE)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 가입 알림 경로 (셀프 가입, 2026-09-24) — 같은 단언을 세 번째 시스템 메일에. **수신자가 요청자 입력이다**
// ---------------------------------------------------------------------------

const SIGNUP_NOTIFIER_FROZEN_EXPORTS: readonly string[] = [
  'SIGNUP_MAIL_GLOBAL_HOURLY_CAP',
  'SIGNUP_NOTIFY_ROUTE_ID',
  // SIGNUP_PAGE_URL 은 2026-10-10 에 거뒀다 — 가입 확인 메일에 링크가 없다(코드만).
  'SignupNotifier',
  'SignupNotifierDependencies',
  'SignupNotifyOutcome',
  'createSignupNotifier',
];

function signupNotifierSource(): SourceFile {
  const source = getProject()
    .getSourceFiles()
    .find((file) => toRepoRelative(file.getFilePath()) === SIGNUP_NOTIFIER_FILE);
  if (!source) throw new Error(`${SIGNUP_NOTIFIER_FILE} 을 ts-morph 가 읽지 못했다 — 이 절이 공허해진다.`);
  return source;
}

describe('Layer B — 가입 알림 경로: 세 번째 시스템 메일의 표면이 동결돼 있다 (셀프 가입)', () => {
  it('export 는 동결 목록과 정확히 같고, 호출 가능한 export 는 createSignupNotifier(의존성 하나) 하나다', () => {
    expect([...signupNotifierSource().getExportedDeclarations().keys()].sort()).toEqual([...SIGNUP_NOTIFIER_FROZEN_EXPORTS].sort());
    const callable: string[] = [];
    for (const [name, declarations] of signupNotifierSource().getExportedDeclarations()) {
      if (declarations.some(isCallableExport)) callable.push(name);
    }
    expect(callable).toEqual(['createSignupNotifier']);
    const factory = signupNotifierSource().getFunctionOrThrow('createSignupNotifier');
    expect(factory.getParameters().map((parameter) => parameter.getType().getText(parameter))).toEqual(['SignupNotifierDependencies']);
    expect(factory.getReturnType().getText(factory)).toBe('SignupNotifier');
  });

  it('의존성에 문자열 속성이 없고 이름이 다른 알림의 넷 + 숫자 상한(capPerHour) 하나로 동결돼 있다', () => {
    const dependencies = signupNotifierSource().getInterfaceOrThrow('SignupNotifierDependencies');
    expect(dependencies.getExtends()).toEqual([]);
    const properties = dependencies.getProperties();
    expect(properties.map((property) => property.getName()).sort()).toEqual([...NOTIFIER_FROZEN_DEPENDENCIES, 'capPerHour'].sort());
    // 상한은 숫자 하나 — 수신자·문자열이 들어올 자리가 아니다.
    expect(dependencies.getPropertyOrThrow('capPerHour').getType().isNumber()).toBe(true);
    const offenders: string[] = [];
    for (const property of properties) {
      const type = property.getType();
      if (type.isString() || type.isStringLiteral() || type.getUnionTypes().some((m) => m.isString() || m.isStringLiteral())) offenders.push(property.getName());
      if (NOTIFIER_FORBIDDEN_DEPENDENCY_STEMS.test(property.getName())) offenders.push(`${property.getName()}: 금지 어간`);
      for (const signature of type.getCallSignatures()) if (signature.getParameters().length > 0) offenders.push(`${property.getName()}: 인자 콜백`);
    }
    expect(offenders).toEqual([]);
  });

  it('운영 조립은 가입 알림기에 상한 상수(SIGNUP_MAIL_GLOBAL_HOURLY_CAP)를 그대로 넘긴다 — 주입이 운영 상한을 느슨하게 할 자리가 아니다', () => {
    const composition = getProject()
      .getSourceFiles()
      .find((file) => toRepoRelative(file.getFilePath()) === LOGIN_MAILER_COMPOSITION_FILE);
    if (!composition) throw new Error(`${LOGIN_MAILER_COMPOSITION_FILE} 을 ts-morph 가 읽지 못했다 — 이 단언이 공허해진다.`);
    const values: string[] = [];
    for (const call of composition.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      if (call.getExpression().getText() !== 'createSignupNotifier') continue;
      const argument = call.getArguments()[0];
      if (argument === undefined || !Node.isObjectLiteralExpression(argument)) {
        values.push('<객체 리터럴 아님>');
        continue;
      }
      const cap = argument.getProperty('capPerHour');
      values.push(cap !== undefined && Node.isPropertyAssignment(cap) ? cap.getInitializerOrThrow().getText() : '<없음>');
    }
    expect(values).toEqual(['SIGNUP_MAIL_GLOBAL_HOURLY_CAP']);
  });

  it('공개 API SignupNotifier 는 notify(signupLinkId: string) 하나뿐이다', () => {
    const api = signupNotifierSource().getInterfaceOrThrow('SignupNotifier');
    expect(api.getExtends()).toEqual([]);
    expect(api.getProperties()).toEqual([]);
    const methods = api.getMethods();
    expect(methods.map((method) => method.getName())).toEqual(['notify']);
    expect((methods[0]?.getParameters() ?? []).map((p) => `${p.getName()}: ${p.getType().getText(p)}`)).toEqual(['signupLinkId: string']);
  });

  it('전송단에서 가져오는 것은 알림면뿐이다 — 에이전트 전송단을 쥐지 않는다 · 관문도 import 하지 않는다', () => {
    const imported: string[] = [];
    for (const declaration of signupNotifierSource().getImportDeclarations()) {
      const target = declaration.getModuleSpecifierSourceFile();
      if (!target || toRepoRelative(target.getFilePath()) !== TRANSPORT_FILE) continue;
      if (declaration.getNamespaceImport() || declaration.getDefaultImport()) imported.push('*');
      imported.push(...declaration.getNamedImports().map((named) => named.getName()));
    }
    expect(imported.sort()).toEqual([...NOTIFIER_TRANSPORT_IMPORTS].sort());
    expect(importsModule(signupNotifierSource(), GATE_FILE)).toBe(false);
  });

  it('signup_links.email(수신자)을 읽는 SQL 은 가입 알림 모듈과 admin 가입 코드뿐이다 — 수신자가 나오는 곳이 한 군데다', () => {
    // admin(`src/admin/**`)은 요청 행을 **쓰고** 상한을 센다(같은 주소 계수) — 메일을 보내지 않는다(전송단·알림 모듈 import 0,
    // 위 owner_email 절과 같은 단언). 그 밖의 src 파일이 이 컬럼을 SQL 로 다루면 수신자를 아는 두 번째 코드다.
    const offenders: string[] = [];
    let notifierReads = 0;
    for (const source of getProject().getSourceFiles()) {
      const file = toRepoRelative(source.getFilePath());
      if (!file.startsWith('src/')) continue;
      const literals = [
        ...source.getDescendantsOfKind(SyntaxKind.StringLiteral),
        ...source.getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral),
        ...source.getDescendantsOfKind(SyntaxKind.TemplateExpression),
      ]
        .filter((literal) => /\bsignup_links\b/.test(literal.getText()) && /\bemail\b/.test(literal.getText()) && SQL_VERB.test(literal.getText()))
        // 제한 롤 권한 허용 목록의 **표기**(`'signup_links.email:SELECT'`, role-bootstrap)는 SQL 이 아니다 — 정확히 그 모양만 비킨다.
        .filter((literal) => !(file === ROLE_BOOTSTRAP_FILE && /^'signup_links\.[a-z_]+:[A-Z]+'$/.test(literal.getText())));
      if (literals.length === 0) continue;
      if (file === SIGNUP_NOTIFIER_FILE) notifierReads += literals.length;
      else if (file !== 'src/workers/signup-mailer.ts' && !file.startsWith('src/admin/')) offenders.push(file);
    }
    expect(notifierReads).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
    for (const file of getProject().getSourceFiles()) {
      const path = toRepoRelative(file.getFilePath());
      if (!path.startsWith('src/admin/')) continue;
      for (const forbidden of [TRANSPORT_FILE, SIGNUP_NOTIFIER_FILE]) expect(importsModule(file, forbidden), `${path} → ${forbidden}`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 초대 알림 경로 (확장성 P1 R-1, 2026-09-25) — 같은 단언을 다섯 번째 시스템 메일에. **수신자가 owner 입력 주소다**
// ---------------------------------------------------------------------------

const INVITE_NOTIFIER_FROZEN_EXPORTS: readonly string[] = [
  'INVITE_NOTIFY_ROUTE_ID',
  'INVITE_PAGE_URL',
  'InviteNotifier',
  'InviteNotifierDependencies',
  'InviteNotifyOutcome',
  'createInviteNotifier',
];

function inviteNotifierSource(): SourceFile {
  const source = getProject()
    .getSourceFiles()
    .find((file) => toRepoRelative(file.getFilePath()) === INVITE_NOTIFIER_FILE);
  if (!source) throw new Error(`${INVITE_NOTIFIER_FILE} 을 ts-morph 가 읽지 못했다 — 이 절이 공허해진다.`);
  return source;
}

describe('Layer B — 초대 알림 경로: 다섯 번째 시스템 메일의 표면이 동결돼 있다 (확장성 P1)', () => {
  it('export 는 동결 목록과 정확히 같고, 호출 가능한 export 는 createInviteNotifier(의존성 하나) 하나다', () => {
    expect([...inviteNotifierSource().getExportedDeclarations().keys()].sort()).toEqual([...INVITE_NOTIFIER_FROZEN_EXPORTS].sort());
    const callable: string[] = [];
    for (const [name, declarations] of inviteNotifierSource().getExportedDeclarations()) {
      if (declarations.some(isCallableExport)) callable.push(name);
    }
    expect(callable).toEqual(['createInviteNotifier']);
    const factory = inviteNotifierSource().getFunctionOrThrow('createInviteNotifier');
    expect(factory.getParameters().map((parameter) => parameter.getType().getText(parameter))).toEqual(['InviteNotifierDependencies']);
    expect(factory.getReturnType().getText(factory)).toBe('InviteNotifier');
  });

  it('의존성에 문자열 속성이 없고 이름이 다른 알림의 넷 + 숫자 상한(capPerHour) 하나로 동결돼 있다', () => {
    const dependencies = inviteNotifierSource().getInterfaceOrThrow('InviteNotifierDependencies');
    expect(dependencies.getExtends()).toEqual([]);
    const properties = dependencies.getProperties();
    expect(properties.map((property) => property.getName()).sort()).toEqual([...NOTIFIER_FROZEN_DEPENDENCIES, 'capPerHour'].sort());
    expect(dependencies.getPropertyOrThrow('capPerHour').getType().isNumber()).toBe(true);
    const offenders: string[] = [];
    for (const property of properties) {
      const type = property.getType();
      if (type.isString() || type.isStringLiteral() || type.getUnionTypes().some((m) => m.isString() || m.isStringLiteral())) offenders.push(property.getName());
      if (NOTIFIER_FORBIDDEN_DEPENDENCY_STEMS.test(property.getName())) offenders.push(`${property.getName()}: 금지 어간`);
      for (const signature of type.getCallSignatures()) if (signature.getParameters().length > 0) offenders.push(`${property.getName()}: 인자 콜백`);
    }
    expect(offenders).toEqual([]);
  });

  it('운영 조립은 초대 알림기에 가입 메일과 같은 상한 상수(SIGNUP_MAIL_GLOBAL_HOURLY_CAP)를 넘긴다', () => {
    const composition = getProject()
      .getSourceFiles()
      .find((file) => toRepoRelative(file.getFilePath()) === LOGIN_MAILER_COMPOSITION_FILE);
    if (!composition) throw new Error(`${LOGIN_MAILER_COMPOSITION_FILE} 을 ts-morph 가 읽지 못했다 — 이 단언이 공허해진다.`);
    const values: string[] = [];
    for (const call of composition.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      if (call.getExpression().getText() !== 'createInviteNotifier') continue;
      const argument = call.getArguments()[0];
      if (argument === undefined || !Node.isObjectLiteralExpression(argument)) {
        values.push('<객체 리터럴 아님>');
        continue;
      }
      const cap = argument.getProperty('capPerHour');
      values.push(cap !== undefined && Node.isPropertyAssignment(cap) ? cap.getInitializerOrThrow().getText() : '<없음>');
    }
    expect(values).toEqual(['SIGNUP_MAIL_GLOBAL_HOURLY_CAP']);
  });

  it('공개 API InviteNotifier 는 notify(inviteId: string) 하나뿐이다', () => {
    const api = inviteNotifierSource().getInterfaceOrThrow('InviteNotifier');
    expect(api.getExtends()).toEqual([]);
    expect(api.getProperties()).toEqual([]);
    const methods = api.getMethods();
    expect(methods.map((method) => method.getName())).toEqual(['notify']);
    expect((methods[0]?.getParameters() ?? []).map((p) => `${p.getName()}: ${p.getType().getText(p)}`)).toEqual(['inviteId: string']);
  });

  it('전송단에서 가져오는 것은 알림면뿐이다 — 에이전트 전송단을 쥐지 않는다 · 관문도 import 하지 않는다', () => {
    const imported: string[] = [];
    for (const declaration of inviteNotifierSource().getImportDeclarations()) {
      const target = declaration.getModuleSpecifierSourceFile();
      if (!target || toRepoRelative(target.getFilePath()) !== TRANSPORT_FILE) continue;
      if (declaration.getNamespaceImport() || declaration.getDefaultImport()) imported.push('*');
      imported.push(...declaration.getNamedImports().map((named) => named.getName()));
    }
    expect(imported.sort()).toEqual([...NOTIFIER_TRANSPORT_IMPORTS].sort());
    expect(importsModule(inviteNotifierSource(), GATE_FILE)).toBe(false);
  });

  it('users 를 SQL 로 다루는 곳은 로그인·초대 알림 모듈(수신자 읽기)과 admin 뿐이다 — admin 은 메일 모듈을 import 하지 않는다', () => {
    // 사용자 주소(users.email)는 로그인 링크·초대 메일의 수신자다(202609250110·0120). 그 밖의 src 파일이 users 를 SQL 로 다루면 수신자를
    //   아는 또 하나의 코드다. admin(`src/admin/**`)은 대조·표시·초대 대상 upsert 만 하고 메일을 보내지 않는다(import 단언).
    const offenders: string[] = [];
    let loginReads = 0;
    let inviteReads = 0;
    let welcomeReads = 0;
    let opsLocaleReads = 0;
    for (const source of getProject().getSourceFiles()) {
      const file = toRepoRelative(source.getFilePath());
      if (!file.startsWith('src/')) continue;
      const literals = [
        ...source.getDescendantsOfKind(SyntaxKind.StringLiteral),
        ...source.getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral),
        ...source.getDescendantsOfKind(SyntaxKind.TemplateExpression),
      ].filter((literal) => /\b(FROM|JOIN|INTO|UPDATE) users\b/.test(literal.getText()) && SQL_VERB.test(literal.getText()));
      if (literals.length === 0) continue;
      if (file === LOGIN_NOTIFIER_FILE) loginReads += literals.length;
      else if (file === INVITE_NOTIFIER_FILE) inviteReads += literals.length;
      else if (file === WELCOME_NOTIFIER_FILE) welcomeReads += literals.length;
      // 운영 코드 메일의 언어(202610101000) — 받는 주소의 사용자 설정 한 칸(`users.mail_locale`)만 읽는다. 수신자는 여전히 운영자 행 · 도전의 주소다.
      else if (file === OPS_CODE_NOTIFIER_FILE && literals.every((literal) => /SELECT u\.mail_locale FROM users u/.test(literal.getText()))) opsLocaleReads += literals.length;
      else if (!file.startsWith('src/admin/') && !OPS_DISPLAY_FILES.includes(file)) offenders.push(file);
    }
    expect(loginReads).toBeGreaterThan(0);
    expect(inviteReads).toBeGreaterThan(0);
    expect(welcomeReads).toBeGreaterThan(0);
    expect(opsLocaleReads).toBe(1);
    expect(offenders).toEqual([]);
    for (const file of getProject().getSourceFiles()) {
      const path = toRepoRelative(file.getFilePath());
      if (!path.startsWith('src/admin/')) continue;
      for (const forbidden of [TRANSPORT_FILE, INVITE_NOTIFIER_FILE, LOGIN_NOTIFIER_FILE, WELCOME_NOTIFIER_FILE, WAITLIST_NOTIFIER_FILE]) {
        expect(importsModule(file, forbidden), `${path} → ${forbidden}`).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 환영 알림 경로 (셀프 가입, 2026-09-30) — 같은 단언을 일곱째 시스템 메일에. **수신자는 새 가입자 · 본문은 상수 문구**
// ---------------------------------------------------------------------------

const WELCOME_NOTIFIER_FROZEN_EXPORTS: readonly string[] = [
  'WELCOME_FROM_ADDRESS',
  'WELCOME_FROM_HEADER',
  'WELCOME_MAIL_HOURLY_CAP',
  'WELCOME_NOTIFY_ROUTE_ID',
  'WelcomeNotifier',
  'WelcomeNotifierDependencies',
  'WelcomeNotifyOutcome',
  'createWelcomeNotifier',
];

function welcomeNotifierSource(): SourceFile {
  const source = getProject()
    .getSourceFiles()
    .find((file) => toRepoRelative(file.getFilePath()) === WELCOME_NOTIFIER_FILE);
  if (!source) throw new Error(`${WELCOME_NOTIFIER_FILE} 을 ts-morph 가 읽지 못했다 — 이 절이 공허해진다.`);
  return source;
}

describe('Layer B — 환영 알림 경로: 일곱째 시스템 메일의 표면이 동결돼 있다 (셀프 가입 환영)', () => {
  it('export 는 동결 목록과 정확히 같고, 호출 가능한 export 는 createWelcomeNotifier(의존성 하나) 하나다', () => {
    expect([...welcomeNotifierSource().getExportedDeclarations().keys()].sort()).toEqual([...WELCOME_NOTIFIER_FROZEN_EXPORTS].sort());
    const callable: string[] = [];
    for (const [name, declarations] of welcomeNotifierSource().getExportedDeclarations()) {
      if (declarations.some(isCallableExport)) callable.push(name);
    }
    expect(callable).toEqual(['createWelcomeNotifier']);
    const factory = welcomeNotifierSource().getFunctionOrThrow('createWelcomeNotifier');
    expect(factory.getParameters().map((parameter) => parameter.getType().getText(parameter))).toEqual(['WelcomeNotifierDependencies']);
    expect(factory.getReturnType().getText(factory)).toBe('WelcomeNotifier');
  });

  it('의존성에 문자열 속성이 없고 이름이 pool · client · now + 숫자 상한(capPerHour)으로 동결돼 있다(키링 없음 — 토큰을 만들지 않는다)', () => {
    const dependencies = welcomeNotifierSource().getInterfaceOrThrow('WelcomeNotifierDependencies');
    expect(dependencies.getExtends()).toEqual([]);
    const properties = dependencies.getProperties();
    expect(properties.map((property) => property.getName()).sort()).toEqual(['capPerHour', 'client', 'now', 'pool']);
    expect(dependencies.getPropertyOrThrow('capPerHour').getType().isNumber()).toBe(true);
    const offenders: string[] = [];
    for (const property of properties) {
      const type = property.getType();
      if (type.isString() || type.isStringLiteral() || type.getUnionTypes().some((m) => m.isString() || m.isStringLiteral())) offenders.push(property.getName());
      if (NOTIFIER_FORBIDDEN_DEPENDENCY_STEMS.test(property.getName())) offenders.push(`${property.getName()}: 금지 어간`);
      for (const signature of type.getCallSignatures()) if (signature.getParameters().length > 0) offenders.push(`${property.getName()}: 인자 콜백`);
    }
    expect(offenders).toEqual([]);
  });

  it('운영 조립은 환영 알림기에 상한 상수(WELCOME_MAIL_HOURLY_CAP)를 넘긴다', () => {
    const composition = getProject()
      .getSourceFiles()
      .find((file) => toRepoRelative(file.getFilePath()) === LOGIN_MAILER_COMPOSITION_FILE);
    if (!composition) throw new Error(`${LOGIN_MAILER_COMPOSITION_FILE} 을 ts-morph 가 읽지 못했다 — 이 단언이 공허해진다.`);
    const values: string[] = [];
    for (const call of composition.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      if (call.getExpression().getText() !== 'createWelcomeNotifier') continue;
      const argument = call.getArguments()[0];
      if (argument === undefined || !Node.isObjectLiteralExpression(argument)) {
        values.push('<객체 리터럴 아님>');
        continue;
      }
      const cap = argument.getProperty('capPerHour');
      values.push(cap !== undefined && Node.isPropertyAssignment(cap) ? cap.getInitializerOrThrow().getText() : '<없음>');
    }
    expect(values).toEqual(['WELCOME_MAIL_HOURLY_CAP']);
  });

  it('공개 API WelcomeNotifier 는 send(welcomeId: string) 하나뿐이다', () => {
    const api = welcomeNotifierSource().getInterfaceOrThrow('WelcomeNotifier');
    expect(api.getExtends()).toEqual([]);
    expect(api.getProperties()).toEqual([]);
    const methods = api.getMethods();
    expect(methods.map((method) => method.getName())).toEqual(['send']);
    expect((methods[0]?.getParameters() ?? []).map((p) => `${p.getName()}: ${p.getType().getText(p)}`)).toEqual(['welcomeId: string']);
  });

  it('전송단에서 가져오는 것은 알림면뿐이다 — 에이전트 전송단을 쥐지 않는다 · 관문도 import 하지 않는다', () => {
    const imported: string[] = [];
    for (const declaration of welcomeNotifierSource().getImportDeclarations()) {
      const target = declaration.getModuleSpecifierSourceFile();
      if (!target || toRepoRelative(target.getFilePath()) !== TRANSPORT_FILE) continue;
      if (declaration.getNamespaceImport() || declaration.getDefaultImport()) imported.push('*');
      imported.push(...declaration.getNamedImports().map((named) => named.getName()));
    }
    expect(imported.sort()).toEqual([...NOTIFIER_TRANSPORT_IMPORTS].sort());
    expect(importsModule(welcomeNotifierSource(), GATE_FILE)).toBe(false);
  });

  it('발신 헤더는 상수 하나 — "Onve (Atmark)" <onve@atmark.ai> · 알림면의 fromHeader 를 채우는 곳은 이 모듈 · 대기자 명단 모듈(같은 상수)과 notify@ 알림 셋("Atmark" 상수)뿐이다', async () => {
    const { WELCOME_FROM_ADDRESS, WELCOME_FROM_HEADER } = await import('../../src/notify/welcome-notifier');
    expect(WELCOME_FROM_ADDRESS).toBe('onve@atmark.ai');
    expect(WELCOME_FROM_HEADER).toBe('"Onve (Atmark)" <onve@atmark.ai>');
    const users: string[] = [];
    for (const source of getProject().getSourceFiles()) {
      const file = toRepoRelative(source.getFilePath());
      if (!file.startsWith('src/') || file === TRANSPORT_FILE) continue;
      for (const assignment of source.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
        if (assignment.getName() === 'fromHeader') users.push(file);
      }
    }
    expect(users.sort()).toEqual(
      [WAITLIST_NOTIFIER_FILE, WELCOME_NOTIFIER_FILE, NOTIFIER_FILE, DOMAIN_NOTIFIER_FILE, QUARANTINE_NOTIFIER_FILE].sort(),
    );
    const { APPROVAL_NOTIFY_FROM_HEADER } = await import('../../src/notify/approval-notifier');
    const { DOMAIN_NOTICE_FROM_HEADER } = await import('../../src/notify/domain-notifier');
    const { QUARANTINE_NOTICE_FROM_HEADER } = await import('../../src/notify/quarantine-notifier');
    for (const header of [APPROVAL_NOTIFY_FROM_HEADER, DOMAIN_NOTICE_FROM_HEADER, QUARANTINE_NOTICE_FROM_HEADER]) {
      expect(header).toBe('"Atmark" <notify@atmark.ai>');
    }
  });
});

// ---------------------------------------------------------------------------
// 대기자 명단 알림 경로 (202609301520) — 같은 단언을 여덟째 시스템 메일에. **수신자는 항목의 주소 · 본문은 상수 문구 · 발신은 환영 메일 상수**
// ---------------------------------------------------------------------------

const WAITLIST_NOTIFIER_FROZEN_EXPORTS: readonly string[] = [
  'WAITLIST_CONFIRMATION_HOURLY_CAP',
  'WAITLIST_MAIL_HOURLY_CAP',
  'WAITLIST_NOTIFY_ROUTE_ID',
  'WaitlistNotifier',
  'WaitlistNotifierDependencies',
  'WaitlistNotifyOutcome',
  'createWaitlistNotifier',
];

function waitlistNotifierSource(): SourceFile {
  const source = getProject()
    .getSourceFiles()
    .find((file) => toRepoRelative(file.getFilePath()) === WAITLIST_NOTIFIER_FILE);
  if (!source) throw new Error(`${WAITLIST_NOTIFIER_FILE} 을 ts-morph 가 읽지 못했다 — 이 절이 공허해진다.`);
  return source;
}

describe('Layer B — 대기자 명단 알림 경로: 여덟째 시스템 메일의 표면이 동결돼 있다 (대기 확인 · 초대)', () => {
  it('export 는 동결 목록과 정확히 같고, 호출 가능한 export 는 createWaitlistNotifier(의존성 하나) 하나다', () => {
    expect([...waitlistNotifierSource().getExportedDeclarations().keys()].sort()).toEqual([...WAITLIST_NOTIFIER_FROZEN_EXPORTS].sort());
    const callable: string[] = [];
    for (const [name, declarations] of waitlistNotifierSource().getExportedDeclarations()) {
      if (declarations.some(isCallableExport)) callable.push(name);
    }
    expect(callable).toEqual(['createWaitlistNotifier']);
    const factory = waitlistNotifierSource().getFunctionOrThrow('createWaitlistNotifier');
    expect(factory.getParameters().map((parameter) => parameter.getType().getText(parameter))).toEqual(['WaitlistNotifierDependencies']);
    expect(factory.getReturnType().getText(factory)).toBe('WaitlistNotifier');
  });

  it('의존성에 문자열 속성이 없고 이름이 pool · client · now + 숫자 상한 둘(초대 capPerHour · 확인 confirmationCapPerHour)로 동결돼 있다', () => {
    const dependencies = waitlistNotifierSource().getInterfaceOrThrow('WaitlistNotifierDependencies');
    expect(dependencies.getExtends()).toEqual([]);
    const properties = dependencies.getProperties();
    expect(properties.map((property) => property.getName()).sort()).toEqual(['capPerHour', 'client', 'confirmationCapPerHour', 'now', 'pool']);
    const offenders: string[] = [];
    for (const property of properties) {
      const type = property.getType();
      if (type.isString() || type.isStringLiteral() || type.getUnionTypes().some((m) => m.isString() || m.isStringLiteral())) offenders.push(property.getName());
      if (NOTIFIER_FORBIDDEN_DEPENDENCY_STEMS.test(property.getName())) offenders.push(`${property.getName()}: 금지 어간`);
      for (const signature of type.getCallSignatures()) if (signature.getParameters().length > 0) offenders.push(`${property.getName()}: 인자 콜백`);
    }
    expect(offenders).toEqual([]);
  });

  it('운영 조립은 대기자 명단 알림기에 상한 상수 둘(WAITLIST_MAIL_HOURLY_CAP · WAITLIST_CONFIRMATION_HOURLY_CAP)을 넘긴다', () => {
    const composition = getProject()
      .getSourceFiles()
      .find((file) => toRepoRelative(file.getFilePath()) === LOGIN_MAILER_COMPOSITION_FILE);
    if (!composition) throw new Error(`${LOGIN_MAILER_COMPOSITION_FILE} 을 ts-morph 가 읽지 못했다 — 이 단언이 공허해진다.`);
    const values: string[] = [];
    for (const call of composition.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      if (call.getExpression().getText() !== 'createWaitlistNotifier') continue;
      const argument = call.getArguments()[0];
      if (argument === undefined || !Node.isObjectLiteralExpression(argument)) {
        values.push('<객체 리터럴 아님>');
        continue;
      }
      for (const name of ['capPerHour', 'confirmationCapPerHour']) {
        const cap = argument.getProperty(name);
        values.push(cap !== undefined && Node.isPropertyAssignment(cap) ? cap.getInitializerOrThrow().getText() : '<없음>');
      }
    }
    expect(values).toEqual(['WAITLIST_MAIL_HOURLY_CAP', 'WAITLIST_CONFIRMATION_HOURLY_CAP']);
  });

  it('공개 API WaitlistNotifier 는 send(mailId: string) 하나뿐이다', () => {
    const api = waitlistNotifierSource().getInterfaceOrThrow('WaitlistNotifier');
    expect(api.getExtends()).toEqual([]);
    expect(api.getProperties()).toEqual([]);
    const methods = api.getMethods();
    expect(methods.map((method) => method.getName())).toEqual(['send']);
    expect((methods[0]?.getParameters() ?? []).map((p) => `${p.getName()}: ${p.getType().getText(p)}`)).toEqual(['mailId: string']);
  });

  it('전송단에서 가져오는 것은 알림면뿐이다 · 관문을 import 하지 않는다 · 발신은 환영 메일의 상수(onve@atmark.ai)를 그대로 쓴다', () => {
    const imported: string[] = [];
    for (const declaration of waitlistNotifierSource().getImportDeclarations()) {
      const target = declaration.getModuleSpecifierSourceFile();
      if (!target || toRepoRelative(target.getFilePath()) !== TRANSPORT_FILE) continue;
      if (declaration.getNamespaceImport() || declaration.getDefaultImport()) imported.push('*');
      imported.push(...declaration.getNamedImports().map((named) => named.getName()));
    }
    expect(imported.sort()).toEqual([...NOTIFIER_TRANSPORT_IMPORTS].sort());
    expect(importsModule(waitlistNotifierSource(), GATE_FILE)).toBe(false);
    expect(importsModule(waitlistNotifierSource(), WELCOME_NOTIFIER_FILE)).toBe(true);
    for (const assignment of waitlistNotifierSource().getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
      if (assignment.getName() === 'fromAddress') expect(assignment.getInitializerOrThrow().getText()).toBe('WELCOME_FROM_ADDRESS');
      if (assignment.getName() === 'fromHeader') expect(assignment.getInitializerOrThrow().getText()).toBe('WELCOME_FROM_HEADER');
    }
  });
});

// ---------------------------------------------------------------------------
// 문의 전달 경로 (US-009, ADR-0009) — 네 번째 시스템 메일. **수신자는 비밀 하나, 원 발신자는 Reply-To 로만**
// ---------------------------------------------------------------------------

const CONTACT_FORWARDER_FROZEN_EXPORTS: readonly string[] = [
  'CONTACT_FORWARD_FROM_ADDRESS',
  'CONTACT_FORWARD_HOURLY_SEND_CAP',
  'CONTACT_FORWARD_NOTIFY_ROUTE_ID',
  'ContactForwardOutcome',
  'ContactForwarder',
  'ContactForwarderDependencies',
  'createContactForwarder',
];

/** 의존성 이름 동결 — `destination` 은 인자 없는 로더(조립 루트가 비밀로 만든다), `documents` 는 문서 리더, `notifyOnly` 는 불리언(알림만 모드, 2026-09-30). */
const CONTACT_FORWARDER_FROZEN_DEPENDENCIES: readonly string[] = ['client', 'destination', 'documents', 'notifyOnly', 'now', 'pool'];

/** 전송단에서 문의 전달 모듈이 가져와도 되는 이름 — 문의 전달면 하나(알림면·에이전트 전송단 없음). */
const CONTACT_FORWARDER_TRANSPORT_IMPORTS: readonly string[] = ['SesSendClient', 'createSesContactForwardTransport'];

function contactForwarderSource(): SourceFile {
  const source = getProject()
    .getSourceFiles()
    .find((file) => toRepoRelative(file.getFilePath()) === CONTACT_FORWARDER_FILE);
  if (!source) throw new Error(`${CONTACT_FORWARDER_FILE} 을 ts-morph 가 읽지 못했다 — 이 절이 공허해진다.`);
  return source;
}

describe('Layer B — 문의 전달 경로: 네 번째 시스템 메일의 표면이 동결돼 있다 (US-009)', () => {
  it('export 는 동결 목록과 정확히 같고, 호출 가능한 export 는 createContactForwarder(의존성 하나) 하나다', () => {
    expect([...contactForwarderSource().getExportedDeclarations().keys()].sort()).toEqual([...CONTACT_FORWARDER_FROZEN_EXPORTS].sort());
    const callable: string[] = [];
    for (const [name, declarations] of contactForwarderSource().getExportedDeclarations()) {
      if (declarations.some(isCallableExport)) callable.push(name);
    }
    expect(callable).toEqual(['createContactForwarder']);
    const factory = contactForwarderSource().getFunctionOrThrow('createContactForwarder');
    expect(factory.getParameters().map((parameter) => parameter.getType().getText(parameter))).toEqual(['ContactForwarderDependencies']);
    expect(factory.getReturnType().getText(factory)).toBe('ContactForwarder');
  });

  it('의존성에 문자열 속성이 없고 이름이 동결돼 있다 · 콜백은 인자를 받지 않는다 — 수신자가 호출자 인자로 들어올 자리가 없다', () => {
    const dependencies = contactForwarderSource().getInterfaceOrThrow('ContactForwarderDependencies');
    expect(dependencies.getExtends()).toEqual([]);
    const properties = dependencies.getProperties();
    expect(properties.map((property) => property.getName()).sort()).toEqual([...CONTACT_FORWARDER_FROZEN_DEPENDENCIES]);
    const offenders: string[] = [];
    for (const property of properties) {
      const type = property.getType();
      if (type.isString() || type.isStringLiteral() || type.getUnionTypes().some((m) => m.isString() || m.isStringLiteral())) offenders.push(property.getName());
      if (NOTIFIER_FORBIDDEN_DEPENDENCY_STEMS.test(property.getName())) offenders.push(`${property.getName()}: 금지 어간`);
      for (const signature of type.getCallSignatures()) if (signature.getParameters().length > 0) offenders.push(`${property.getName()}: 인자 콜백`);
    }
    expect(offenders).toEqual([]);
  });

  it('공개 API ContactForwarder 는 forward(forwardId: string) 하나뿐이다', () => {
    const api = contactForwarderSource().getInterfaceOrThrow('ContactForwarder');
    expect(api.getExtends()).toEqual([]);
    expect(api.getProperties()).toEqual([]);
    const methods = api.getMethods();
    expect(methods.map((method) => method.getName())).toEqual(['forward']);
    expect((methods[0]?.getParameters() ?? []).map((p) => `${p.getName()}: ${p.getType().getText(p)}`)).toEqual(['forwardId: string']);
  });

  it('전송단에서 가져오는 것은 문의 전달면뿐이다 · 관문을 import 하지 않는다 · 다른 알림 모듈은 문의 전달면을 쥐지 않는다', () => {
    const imported: string[] = [];
    for (const declaration of contactForwarderSource().getImportDeclarations()) {
      const target = declaration.getModuleSpecifierSourceFile();
      if (!target || toRepoRelative(target.getFilePath()) !== TRANSPORT_FILE) continue;
      if (declaration.getNamespaceImport() || declaration.getDefaultImport()) imported.push('*');
      imported.push(...declaration.getNamedImports().map((named) => named.getName()));
    }
    expect(imported.sort()).toEqual([...CONTACT_FORWARDER_TRANSPORT_IMPORTS].sort());
    expect(importsModule(contactForwarderSource(), GATE_FILE)).toBe(false);

    // 문의 전달면(Reply-To 칸이 있는 유일한 면)을 참조하는 프로덕션 파일은 이 모듈뿐이다(선언 자신은 참조 목록에 없다).
    const transport = getProject().getSourceFiles().find((f) => toRepoRelative(f.getFilePath()) === TRANSPORT_FILE);
    if (!transport) throw new Error('전송단을 읽지 못했다');
    const factory = transport.getFunctionOrThrow('createSesContactForwardTransport');
    const name = factory.getNameNode();
    if (name === undefined) throw new Error('createSesContactForwardTransport 에 이름이 없다');
    const referrers = new Set(name.findReferencesAsNodes().map((node) => toRepoRelative(node.getSourceFile().getFilePath())));
    expect([...referrers].filter((file) => file.startsWith('src/') && file !== TRANSPORT_FILE)).toEqual([CONTACT_FORWARDER_FILE]);
  });

  it('운영 조립은 전달 주소를 비밀 로더(createContactDestinationLoader)로만 넘긴다 — 문자열 상수·환경 변수 값이 아니다', () => {
    const composition = getProject()
      .getSourceFiles()
      .find((file) => toRepoRelative(file.getFilePath()) === RUNTIME_COMPOSITION_FILE);
    if (!composition) throw new Error(`${RUNTIME_COMPOSITION_FILE} 을 ts-morph 가 읽지 못했다`);
    const values: string[] = [];
    for (const call of composition.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      if (call.getExpression().getText() !== 'createContactForwarder') continue;
      const argument = call.getArguments()[0];
      if (argument === undefined || !Node.isObjectLiteralExpression(argument)) {
        values.push('<객체 리터럴 아님>');
        continue;
      }
      const destination = argument.getProperty('destination');
      values.push(
        destination !== undefined && Node.isPropertyAssignment(destination)
          ? destination.getInitializerOrThrow().getText().replace(/\s+/g, ' ')
          : '<없음>',
      );
    }
    expect(values).toEqual([
      'createContactDestinationLoader(() => runtime.secrets.readSecretString(destinationArn))',
    ]);
    // 그 ARN 은 전달 주소 비밀 변수에서 온다.
    expect(composition.getText()).toMatch(/const destinationArn = requireEnv\(runtime\.env, RUNTIME_ENV\.contactForwardToSecretArn\);/);
  });
});


// ---------------------------------------------------------------------------
// 도메인 알림 경로 (ADR-0014 단계 4 M3b) — 같은 단언을 아홉째 시스템 메일에. **수신자는 정의자 함수 · 본문은 상수 문구 + 도메인 · 그 조직 에이전트 이름**
// ---------------------------------------------------------------------------

const DOMAIN_NOTIFIER_FROZEN_EXPORTS: readonly string[] = [
  'DOMAIN_NOTICE_FROM_ADDRESS',
  'DOMAIN_NOTICE_FROM_HEADER',
  'DOMAIN_NOTICE_ROUTE_ID',
  'DomainNoticeOutcome',
  'DomainNotifier',
  'DomainNotifierDependencies',
  'createDomainNotifier',
];

function domainNotifierSource(): SourceFile {
  const source = getProject()
    .getSourceFiles()
    .find((file) => toRepoRelative(file.getFilePath()) === DOMAIN_NOTIFIER_FILE);
  if (!source) throw new Error(`${DOMAIN_NOTIFIER_FILE} 을 ts-morph 가 읽지 못했다 — 이 절이 공허해진다.`);
  return source;
}

describe('Layer B — 도메인 알림 경로: 아홉째 시스템 메일의 표면이 동결돼 있다 (ADR-0014 M3b)', () => {
  it('export 는 동결 목록과 정확히 같고, 호출 가능한 export 는 createDomainNotifier(의존성 하나) 하나다', () => {
    expect([...domainNotifierSource().getExportedDeclarations().keys()].sort()).toEqual([...DOMAIN_NOTIFIER_FROZEN_EXPORTS].sort());
    const callable: string[] = [];
    for (const [name, declarations] of domainNotifierSource().getExportedDeclarations()) {
      if (declarations.some(isCallableExport)) callable.push(name);
    }
    expect(callable).toEqual(['createDomainNotifier']);
    const factory = domainNotifierSource().getFunctionOrThrow('createDomainNotifier');
    expect(factory.getParameters().map((parameter) => parameter.getType().getText(parameter))).toEqual(['DomainNotifierDependencies']);
    expect(factory.getReturnType().getText(factory)).toBe('DomainNotifier');
  });

  it('의존성에 문자열 속성이 없고 이름이 pool · client · now 로 동결돼 있다', () => {
    const dependencies = domainNotifierSource().getInterfaceOrThrow('DomainNotifierDependencies');
    expect(dependencies.getExtends()).toEqual([]);
    const properties = dependencies.getProperties();
    expect(properties.map((property) => property.getName()).sort()).toEqual(['client', 'now', 'pool']);
    const offenders: string[] = [];
    for (const property of properties) {
      const type = property.getType();
      if (type.isString() || type.isStringLiteral() || type.getUnionTypes().some((m) => m.isString() || m.isStringLiteral())) offenders.push(property.getName());
      if (NOTIFIER_FORBIDDEN_DEPENDENCY_STEMS.test(property.getName())) offenders.push(`${property.getName()}: 금지 어간`);
      for (const signature of type.getCallSignatures()) if (signature.getParameters().length > 0) offenders.push(`${property.getName()}: 인자 콜백`);
    }
    expect(offenders).toEqual([]);
  });

  it('공개 API DomainNotifier 는 send(noticeId: string) 하나뿐이다', () => {
    const api = domainNotifierSource().getInterfaceOrThrow('DomainNotifier');
    expect(api.getExtends()).toEqual([]);
    expect(api.getProperties()).toEqual([]);
    const methods = api.getMethods();
    expect(methods.map((method) => method.getName())).toEqual(['send']);
    expect((methods[0]?.getParameters() ?? []).map((p) => `${p.getName()}: ${p.getType().getText(p)}`)).toEqual(['noticeId: string']);
  });

  it('전송단에서 가져오는 것은 알림면뿐이다 — 에이전트 전송단을 쥐지 않는다 · 관문도 import 하지 않는다 · 발신은 notify@atmark.ai 상수', async () => {
    const imported: string[] = [];
    for (const declaration of domainNotifierSource().getImportDeclarations()) {
      const target = declaration.getModuleSpecifierSourceFile();
      if (!target || toRepoRelative(target.getFilePath()) !== TRANSPORT_FILE) continue;
      if (declaration.getNamespaceImport() || declaration.getDefaultImport()) imported.push('*');
      imported.push(...declaration.getNamedImports().map((named) => named.getName()));
    }
    expect(imported.sort()).toEqual([...NOTIFIER_TRANSPORT_IMPORTS].sort());
    expect(importsModule(domainNotifierSource(), GATE_FILE)).toBe(false);
    const { DOMAIN_NOTICE_FROM_ADDRESS, DOMAIN_NOTICE_ROUTE_ID } = await import('../../src/notify/domain-notifier');
    expect(DOMAIN_NOTICE_FROM_ADDRESS).toBe('notify@atmark.ai');
    expect(DOMAIN_NOTICE_ROUTE_ID).toBe('domain_notice');
  });

  it('수신자는 정의자 함수에서만 나온다 — 모듈 안의 SQL 은 users · memberships · owner_email 을 읽지 않는다', () => {
    const text = domainNotifierSource().getFullText();
    expect(text).toContain('atmark_claim_domain_notice');
    expect(/\bFROM\s+(users|memberships)\b|JOIN\s+(users|memberships)\b|owner_email/.test(text)).toBe(false);
  });
});


// ---------------------------------------------------------------------------
// 격리 알림 경로 (ADR-0016 2026-10-07 개정) — 같은 단언을 열째 시스템 메일에. **수신자는 정의자 함수(owner_email) · 본문에 격리된 메일의 글자가 없다**
// ---------------------------------------------------------------------------

const QUARANTINE_NOTIFIER_FROZEN_EXPORTS: readonly string[] = [
  'QUARANTINE_NOTICE_FROM_ADDRESS',
  'QUARANTINE_NOTICE_FROM_HEADER',
  'QUARANTINE_NOTICE_ROUTE_ID',
  'QuarantineNoticeOutcome',
  'QuarantineNotifier',
  'QuarantineNotifierDependencies',
  'createQuarantineNotifier',
];

function quarantineNotifierSource(): SourceFile {
  const source = getProject()
    .getSourceFiles()
    .find((file) => toRepoRelative(file.getFilePath()) === QUARANTINE_NOTIFIER_FILE);
  if (!source) throw new Error(`${QUARANTINE_NOTIFIER_FILE} 을 ts-morph 가 읽지 못했다 — 이 절이 공허해진다.`);
  return source;
}

describe('Layer B — 격리 알림 경로: 열째 시스템 메일의 표면이 동결돼 있다 (ADR-0016 2026-10-07)', () => {
  it('export 는 동결 목록과 정확히 같고, 호출 가능한 export 는 createQuarantineNotifier(의존성 하나) 하나다', () => {
    expect([...quarantineNotifierSource().getExportedDeclarations().keys()].sort()).toEqual([...QUARANTINE_NOTIFIER_FROZEN_EXPORTS].sort());
    const callable: string[] = [];
    for (const [name, declarations] of quarantineNotifierSource().getExportedDeclarations()) {
      if (declarations.some(isCallableExport)) callable.push(name);
    }
    expect(callable).toEqual(['createQuarantineNotifier']);
    const factory = quarantineNotifierSource().getFunctionOrThrow('createQuarantineNotifier');
    expect(factory.getParameters().map((parameter) => parameter.getType().getText(parameter))).toEqual(['QuarantineNotifierDependencies']);
    expect(factory.getReturnType().getText(factory)).toBe('QuarantineNotifier');
  });

  it('의존성에 문자열 속성이 없고 이름이 pool · client · now 로 동결돼 있다', () => {
    const dependencies = quarantineNotifierSource().getInterfaceOrThrow('QuarantineNotifierDependencies');
    expect(dependencies.getExtends()).toEqual([]);
    const properties = dependencies.getProperties();
    expect(properties.map((property) => property.getName()).sort()).toEqual(['client', 'now', 'pool']);
    const offenders: string[] = [];
    for (const property of properties) {
      const type = property.getType();
      if (type.isString() || type.isStringLiteral() || type.getUnionTypes().some((m) => m.isString() || m.isStringLiteral())) offenders.push(property.getName());
      if (NOTIFIER_FORBIDDEN_DEPENDENCY_STEMS.test(property.getName())) offenders.push(`${property.getName()}: 금지 어간`);
      for (const signature of type.getCallSignatures()) if (signature.getParameters().length > 0) offenders.push(`${property.getName()}: 인자 콜백`);
    }
    expect(offenders).toEqual([]);
  });

  it('공개 API QuarantineNotifier 는 send(noticeId: string) 하나뿐이다', () => {
    const api = quarantineNotifierSource().getInterfaceOrThrow('QuarantineNotifier');
    expect(api.getExtends()).toEqual([]);
    expect(api.getProperties()).toEqual([]);
    const methods = api.getMethods();
    expect(methods.map((method) => method.getName())).toEqual(['send']);
    expect((methods[0]?.getParameters() ?? []).map((p) => `${p.getName()}: ${p.getType().getText(p)}`)).toEqual(['noticeId: string']);
  });

  it('전송단에서 가져오는 것은 알림면뿐이다 — 에이전트 전송단을 쥐지 않는다 · 관문도 import 하지 않는다 · 발신은 notify@atmark.ai 상수', async () => {
    const imported: string[] = [];
    for (const declaration of quarantineNotifierSource().getImportDeclarations()) {
      const target = declaration.getModuleSpecifierSourceFile();
      if (!target || toRepoRelative(target.getFilePath()) !== TRANSPORT_FILE) continue;
      if (declaration.getNamespaceImport() || declaration.getDefaultImport()) imported.push('*');
      imported.push(...declaration.getNamedImports().map((named) => named.getName()));
    }
    expect(imported.sort()).toEqual([...NOTIFIER_TRANSPORT_IMPORTS].sort());
    expect(importsModule(quarantineNotifierSource(), GATE_FILE)).toBe(false);
    const { QUARANTINE_NOTICE_FROM_ADDRESS, QUARANTINE_NOTICE_ROUTE_ID } = await import('../../src/notify/quarantine-notifier');
    expect(QUARANTINE_NOTICE_FROM_ADDRESS).toBe('notify@atmark.ai');
    expect(QUARANTINE_NOTICE_ROUTE_ID).toBe('quarantine_notice');
  });

  it('수신자는 정의자 함수에서만 나온다 — 모듈 안의 SQL 은 users · memberships · owner_email 을 읽지 않는다', () => {
    const text = quarantineNotifierSource().getFullText();
    expect(text).toContain('atmark_claim_quarantine_notice');
    expect(/\bFROM\s+(users|memberships)\b|JOIN\s+(users|memberships)\b|owner_email/.test(text)).toBe(false);
  });

  it('격리된 메일의 글자를 읽지 않는다 — 모듈 안의 SQL 은 inbound_messages(제목 · 본문 키 · 주소)에 닿지 않는다', () => {
    const sql = quarantineNotifierSource()
      .getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral)
      .map((literal) => literal.getText())
      .concat(quarantineNotifierSource().getDescendantsOfKind(SyntaxKind.TemplateExpression).map((literal) => literal.getText()));
    expect(sql.length).toBeGreaterThan(0);
    expect(sql.filter((text) => /inbound_messages|\bsubject\b|from_address|parsed_storage_key|raw_storage_key|\bthreads\b/.test(text))).toEqual([]);
  });
});
