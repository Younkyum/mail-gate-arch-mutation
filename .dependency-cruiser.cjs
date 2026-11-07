/**
 * .dependency-cruiser.cjs — AC-8 Layer A (계획 §5.0 "Layer A — Import boundary")
 *
 * 주장: `@aws-sdk/client-sesv2` 를 import하는 파일은
 *       `src/mail/transport/ses-transport.ts`(발송) · `src/mail/transport/ses-identity.ts`(제어면 — ADR-0014 단계 2, 발송 명령 0) 둘뿐이다.
 *
 * 이 규칙은 그 파일이 아직 존재하지 않는 P0에서도 유효하다 — 규칙이 먼저 서 있어야
 * 나중에 잘못된 위치에 SES import가 들어오는 순간 CI가 막는다. 규칙을 코드 뒤에
 * 세우면 이미 들어온 것을 걷어내는 일이 되고, 그때는 "일단 예외 하나만" 이 된다.
 *
 * 같은 주장을 ts-morph로 한 번 더 증명한다(test/arch/ses-import-boundary.arch.test.ts,
 * P1a). 두 구현을 둔 이유: **한 도구의 설정 파일이 잘못되어 룰이 아무 파일도 검사하지
 * 않게 되는 사고가 실제로 흔하다. 증명이 단일 설정에 의존하면 증명이 아니다.**
 * 그 "아무것도 검사하지 않는 상태"를 잡는 것이 Layer F(비공허성 검증)이며 P1a에 들어온다.
 *
 * ---------------------------------------------------------------------------
 * ## `to.path` 는 **해석된 경로**에 걸린다 — 모듈 이름이 아니다 (2026-09-22 실측)
 * ---------------------------------------------------------------------------
 *
 * 바로 위 문단이 경고한 그 사고가 **이 파일에서 실제로 일어나 있었다.**
 * `no-ses-sdk-outside-transport` 의 표적이 `'^@aws-sdk/client-sesv2'` 였는데,
 * dependency-cruiser 가 대조하는 값은 `resolved` 이고 그것은
 * `node_modules/.pnpm/@aws-sdk+client-sesv2@3.1137.0/node_modules/@aws-sdk/client-sesv2/dist-cjs/index.js`
 * 다. `^` 로 시작하는 그 패턴은 **어떤 npm 의존성과도 매칭될 수 없었다.**
 *
 * 실측: `src/observability/` 에 `@aws-sdk/client-sesv2` 를 import 하는 파일을 넣고
 * `pnpm arch:deps` 를 돌렸더니 `✔ no dependency violations found (67 modules, 198
 * dependencies cruised)`. Layer A 의 "두 구현" 중 이쪽 절반은 P0 이래 잠들어 있었고,
 * 그 사실을 아무도 몰랐던 이유는 **위반 0건과 검사 0건이 같은 출력**이기 때문이다.
 * (ts-morph 쪽 절반은 정상이었다 — 그래서 주장 자체는 무방비가 아니었다.)
 *
 * **그래서 npm 패키지 표적은 전부 `node_modules/<name>/` 로 적는다.** 이 형태는 pnpm 의
 * `.pnpm` 저장소 경로와 평평한 `node_modules/` 배치 **둘 다**에 매칭된다. 해석 자체가
 * 실패하는 경우(패키지 미설치)를 위해 모듈 이름 형태도 배열에 함께 둔다.
 *
 * **새 규칙을 추가하면 반드시 위반을 하나 심어 실제로 빨간불이 켜지는지 확인하라.**
 * Layer F 의 변이 러너는 `vitest run test/arch` 만 돌리므로 **이 파일에는 닿지 않는다** —
 * 여기서 비공허성을 보증하는 것은 그 수동 확인뿐이다.
 */

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-ses-sdk-outside-transport',
      comment:
        'AC-8 Layer A: SES SDK는 단일 전송 파일에만 존재한다. 여기서 예외를 만들면 ' +
        '관문(gate)을 우회하는 발송 경로가 생기고, AC-8("우회 가능한 경로 0개")이 무너진다.',
      severity: 'error',
      from: {
        // ADR-0014 단계 2 — `ses-identity.ts` 는 SES **제어면**(identity·정책·태그) 명령만 import 한다(발송 명령 0 — ses-import-boundary arch 테스트가
        // import 이름을 본다). 발송 경로는 여전히 `ses-transport.ts` 하나다.
        pathNot: ['^src/mail/transport/ses-transport\\.ts$', '^src/mail/transport/ses-identity\\.ts$'],
      },
      to: {
        // 첫째가 해석된 경로, 둘째가 해석 실패 시의 모듈 이름. 머리말 참조.
        path: ['node_modules/@aws-sdk/client-sesv2/', '^@aws-sdk/client-sesv2($|/)'],
      },
    },
    {
      name: 'ses-identity-only-from-domain-control',
      comment:
        'ADR-0014 단계 2: SES 제어면 파일(`src/mail/transport/ses-identity.ts` — 고객 identity 만들기·정책·태그·지우기)을 import 하는 곳은 ' +
        'domain-control λ 의 핸들러 하나다(VPC 밖 · DB 없음 · IAM 에 atmark.ai identity·발송 Deny). 다른 번들이 이 파일을 부르면 그 역할의 IAM 이 ' +
        '막더라도 코드 경로가 둘이 된다. 같은 주장을 test/arch/ses-import-boundary.arch.test.ts 가 ts-morph 로 한 번 더 본다.',
      severity: 'error',
      from: {
        // 읽기 전용 감사 λ(보안 리뷰 M2 — 역할은 SES Get·List 뿐)도 같은 파일의 읽기 면을 쓴다.
        pathNot: ['^src/runtime/handlers/domain-control\\.ts$', '^src/runtime/handlers/domain-policy-audit\\.ts$'],
      },
      to: {
        path: ['^src/mail/transport/ses-identity\\.ts$'],
      },
    },
    {
      name: 'no-secrets-sdk-outside-runtime-secrets',
      comment:
        'Secrets Manager SDK · SSM SDK(2026-10-12 비밀 → SSM 이전)는 `src/runtime/secrets.ts` 한 파일에만 존재한다(D1, 2026-09-23). 두 번째 파일이 비밀을 ' +
        '직접 읽으면 콜드 스타트 1회 캐시·placeholder(`_unset`) 거부·운영 가드를 거치지 않는 경로가 생긴다. ' +
        '같은 주장을 test/arch/network-egress.arch.test.ts 가 한 번 더 증명한다(이중화 — 단일 설정에 기대지 않는다).',
      severity: 'error',
      from: {
        pathNot: ['^src/runtime/secrets\\.ts$'],
      },
      to: {
        path: [
          'node_modules/@aws-sdk/client-secrets-manager/',
          '^@aws-sdk/client-secrets-manager($|/)',
          'node_modules/@aws-sdk/client-ssm/',
          '^@aws-sdk/client-ssm($|/)',
        ],
      },
    },
    {
      name: 'no-kms-sdk-outside-runtime-kms',
      comment:
        'KMS SDK 는 두 파일에만 존재한다: `src/runtime/kms.ts`(GenerateDataKey — 관리 백엔드 프로비저닝, 2026-09-23)와 ' +
        '`src/passport/signer.ts`(Decrypt — 개인키 envelope 복호, P6 PP-B · AC-e2) · `src/tlog/checkpoint-signer.ts`(Sign·GetPublicKey — ' +
        '투명성 로그 체크포인트·앵커, ADR-0008) · `src/domains/dc-kms-signer.ts`(Sign·GetPublicKey — Domain Connect URL 서명, 다른 키). 다섯째 파일이 KMS 를 직접 부르면 복호·서명 경로가 ' +
        '둘이 된다. 같은 주장을 test/arch/network-egress.arch.test.ts · test/arch/passport-signer-isolation.arch.test.ts 가 한 번 더 증명한다.',
      severity: 'error',
      from: {
        pathNot: ['^src/runtime/kms\\.ts$', '^src/passport/signer\\.ts$', '^src/tlog/checkpoint-signer\\.ts$', '^src/domains/dc-kms-signer\\.ts$'],
      },
      to: {
        path: ['node_modules/@aws-sdk/client-kms/', '^@aws-sdk/client-kms($|/)'],
      },
    },
    {
      name: 'no-sqs-sdk-outside-runtime-sqs',
      comment:
        'SQS SDK 는 `src/runtime/sqs.ts` 하나에만 존재한다(WP-2 — 결제 웹훅 λ 의 FIFO SendMessage). 소비는 Lambda 이벤트 소스 매핑이 하므로 ' +
        '코드에 받기·지우기가 없다. 둘째 파일이 SQS 를 직접 부르면 중복 제거 id·그룹 id 를 필수로 받는 면을 비켜 간다. ' +
        '같은 주장을 test/arch/network-egress.arch.test.ts 가 한 번 더 증명한다(변이 BL-2).',
      severity: 'error',
      from: {
        pathNot: ['^src/runtime/sqs\\.ts$'],
      },
      to: {
        path: ['node_modules/@aws-sdk/client-sqs/', '^@aws-sdk/client-sqs($|/)'],
      },
    },
    {
      name: 'no-apigw-management-sdk-outside-runtime-realtime',
      comment:
        'API Gateway Management API SDK 는 `src/runtime/realtime-transport.ts` 하나에만 존재한다(묶음 E — 실시간 WebSocket PostToConnection). ' +
        '둘째 파일이 연결에 직접 쓰면 대상 선택(정의 함수 — 보이는 메일 · 그 에이전트의 연결만)과 1초 상한을 비켜 간다. ' +
        '같은 주장을 test/arch/network-egress.arch.test.ts 가 한 번 더 증명한다.',
      severity: 'error',
      from: {
        pathNot: ['^src/runtime/realtime-transport\\.ts$'],
      },
      to: {
        path: ['node_modules/@aws-sdk/client-apigatewaymanagementapi/', '^@aws-sdk/client-apigatewaymanagementapi($|/)'],
      },
    },
    {
      name: 'no-lambda-sdk-outside-runtime-lambda-invoke',
      comment:
        'Lambda SDK 는 `src/runtime/lambda-invoke.ts` 하나에만 존재한다 — admin λ 가 커밋 뒤 login-mailer λ 를 깨우는 비동기 호출(고정 입력 ' +
        '`{"source":"atmark.kick"}`) · api λ 내부 이벤트 · domain-control 동기 호출(ADR-0014 — `runtime/domain-control-invoker.ts` 가 이 파일을 거친다). ' +
        '둘째 파일이 Lambda 를 직접 부르면 입력·시간 상한·오류 삼키기를 거치지 않는 호출이 생긴다. ' +
        '같은 주장을 test/arch/network-egress.arch.test.ts 가 한 번 더 증명한다.',
      severity: 'error',
      from: {
        pathNot: ['^src/runtime/lambda-invoke\\.ts$'],
      },
      to: {
        path: ['node_modules/@aws-sdk/client-lambda/', '^@aws-sdk/client-lambda($|/)'],
      },
    },
    {
      name: 'no-cloudfront-sdk-outside-runtime-cloudfront',
      comment:
        'CloudFront SDK 는 `src/runtime/cloudfront.ts` 한 파일에만 존재한다(P6 PP-B — 신원 문서 캐시 무효화). 그 파일의 공개 면은 ' +
        'CreateInvalidation 하나다. 같은 주장을 test/arch/network-egress.arch.test.ts 가 한 번 더 증명한다. ' +
        '**위반을 심어 error 가 뜨는 것을 실측했다(2026-09-24)**.',
      severity: 'error',
      from: {
        pathNot: ['^src/runtime/cloudfront\\.ts$'],
      },
      to: {
        path: ['node_modules/@aws-sdk/client-cloudfront/', '^@aws-sdk/client-cloudfront($|/)'],
      },
    },
    {
      name: 'passport-signer-only-from-signer-composition',
      comment:
        '★ `src/passport/signer.ts` — 에이전트 개인키를 복호할 수 있는 유일한 파일(계획 §3.5 AC-e2) — 을 import 하는 곳은 서명 Lambda 의 ' +
        '조립 루트(`src/runtime/passport-signer-composition.ts`) 하나다. 다른 번들(api·admin·워커)의 import 그래프에 복호 코드가 들어가지 ' +
        '않는다. 서명기를 받아 부르는 쪽(`publisher.ts`)은 포트(`signing.ts`)만 안다. 같은 주장을 ' +
        'test/arch/passport-signer-isolation.arch.test.ts 가 ts-morph 로 한 번 더 증명한다. **위반을 심어 error 가 뜨는 것을 실측했다(2026-09-24)**.',
      severity: 'error',
      from: {
        pathNot: ['^src/runtime/passport-signer-composition\\.ts$'],
      },
      to: {
        path: ['^src/passport/signer\\.ts$'],
      },
    },
    {
      name: 'no-s3-sdk-outside-storage',
      comment:
        'S3 SDK 는 `src/storage/s3-object-store.ts` 한 파일에만 존재한다. 두 번째 파일이 S3 를 직접 ' +
        '부르면 write-once(If-None-Match)·SSE·ExpectedBucketOwner·크기 상한을 거치지 않는 저장 ' +
        '경로가 생긴다. Layer A(SES SDK)와 별개의 규칙이다 — 같은 규칙에 묶으면 한쪽 예외가 다른 ' +
        '쪽 예외가 된다. 같은 주장을 ts-morph 가 네트워크 송출 층(test/arch/network-egress.arch.test.ts)' +
        '에서 한 번 더 증명한다. **위반을 심어 error 가 뜨는 것을 실측했다(2026-09-23)** — 머리말 참조.',
      severity: 'error',
      from: {
        pathNot: ['^src/storage/s3-object-store\\.ts$'],
      },
      to: {
        // 첫째가 해석된 경로, 둘째가 해석 실패 시의 모듈 이름. 머리말 참조.
        // P3c — presigner 도 S3 SDK 다(서명 규칙 = 응답 헤더 강제가 거기 있다). 같은 한 파일에만.
        path: [
          'node_modules/@aws-sdk/client-s3/',
          '^@aws-sdk/client-s3($|/)',
          'node_modules/@aws-sdk/s3-request-presigner/',
          '^@aws-sdk/s3-request-presigner($|/)',
        ],
      },
    },
    {
      name: 'no-storage-in-observability',
      comment:
        '§4.3 경계 ①: 관측 모듈에는 **쓸 수 있는 저장소가 없다.** 로그가 audit 을 대신할 ' +
        '수 있다고 읽히는 순간 audit INSERT 실패가 발송을 멈출 이유가 없어지고, 다음 ' +
        '장애에서 법적 기록은 0행이 된다(Principle P3). 같은 주장을 ts-morph 로 한 번 더 ' +
        '증명한다(test/arch/observability-pii.arch.test.ts) — Layer A 의 SES 경계와 같은 ' +
        '이유의 이중화다: 증명이 단일 설정에 의존하면 증명이 아니다.',
      severity: 'error',
      from: { path: '^src/observability/' },
      to: {
        // `src/db/**` 는 리포 상대 경로로 해석되고, `pg` 는 node_modules 아래로 해석된다.
        // 타입 전용 import 도 잡힌다 — `tsPreCompilationDeps: true` 가 켜져 있다.
        path: ['^src/db/', 'node_modules/pg/', '^pg($|/)'],
      },
    },
    {
      name: 'no-circular',
      comment:
        '순환 의존은 관문의 호출 순서를 추론 불가능하게 만든다 — Layer B(call-graph ' +
        'chokepoint)가 AST로 단일 호출자를 단언하는 전제를 깨뜨린다.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-src-to-test',
      comment:
        '프로덕션 코드가 테스트를 import하면 아키텍처 테스트가 자기 검증 대상을 ' +
        '오염시킨다. 단방향을 강제한다.',
      severity: 'error',
      from: { path: '^src/' },
      to: { path: '^test/' },
    },
    {
      name: 'no-orphans',
      comment:
        '어디서도 import되지 않는 모듈은 Layer C(진입점 전수 분할)의 매니페스트 밖에 ' +
        '있는 코드일 가능성이 높다. P1a 종료 시점(2026-09-22)에 error 로 올렸다 — ' +
        'gate.ts 가 manifest·schema 를 import 하면서 위반 0건이 됐기 때문이다.',
      severity: 'error',
      // `src/passport/promotion.ts` 는 예외다(P6, 2026-09-24): 체인 승격은 Phase 1 에 **호출자가 없다**(§3.6 — 체인을 지금 고르지
      //   않는다). 그 함수의 존재와 동결 픽스처 위의 단언(AC-13, test/integration/passport/promotion.test.ts)이 증명 대상이다.
      from: { orphan: true, pathNot: ['\\.d\\.ts$', '^src/passport/promotion\\.ts$'] },
      to: {},
    },
  ],

  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.js', '.mjs', '.cjs', '.json'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
