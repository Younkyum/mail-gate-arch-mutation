/**
 * 네트워크 송출 경계 — **`src/**` 에서 네트워크 원시 모듈을 쓰는 파일은
 * `src/webhooks/https-transport.ts` 하나뿐이다.**
 *
 * 왜: 웹훅 SSRF 방어(`destination.ts`)는 "나가는 요청이 전부 검사된 IP 로만 간다" 에 기대고,
 * 그 명제는 **나가는 문이 하나**일 때만 참이다. 누군가 다른 파일에서 `fetch(url)` 한 줄을
 * 쓰면 검사도 고정도 없는 두 번째 문이 생긴다. Layer A(SES SDK 단일 파일)와 같은 형태이고,
 * 계획 P4 가 `src/inbound/**`·`src/security/**` 에 "외부 HTTP 0건" arch 테스트를 두려는 것과
 * 같은 축이다(이 단언은 그보다 넓다 — `src/**` 전체).
 *
 * **AWS SDK 클라이언트(`@aws-sdk/client-*`)도 송출이다** (P2 마무리, 2026-09-23). 이전 판은 AWS SDK 를
 * "Layer A·E 가 따로 지킨다" 며 뺐는데, Layer A 가 지키는 것은 **SES 하나**다. S3 SDK 가 들어오는 순간
 * 그 제외는 "S3·SQS·KMS 클라이언트를 아무 파일에서나 만들어도 이 층은 초록" 이 된다. 그래서 패키지
 * 계열 전체를 송출로 보고, 허용 파일을 **이름으로** 적는다(와일드카드 없음):
 *   - `src/mail/transport/ses-transport.ts` — SES (Layer A·E 가 한 번 더 지킨다)
 *   - `src/storage/s3-object-store.ts` — S3 (`.dependency-cruiser.cjs` 의 `no-s3-sdk-outside-storage` 가 한 번 더)
 *   - `src/runtime/secrets.ts` — Secrets Manager (D1 배포 준비, 2026-09-23) + SSM Parameter Store `GetParameter`·`PutParameter`(2026-10-12
 *     비밀 → SSM 이전 — 같은 파일, 비밀 SDK 는 둘 다 여기 하나). 운영 런타임이 비밀을 읽는 면 + 롤 부트스트랩 쓰기 + 에이전트 키 시크릿
 *     **생성**(관리 백엔드 프로비저닝, `atmark/agent-keypairs/*` 이름만).
 *   - `src/runtime/kms.ts` — KMS `GenerateDataKey` 만(관리 백엔드 프로비저닝의 envelope). `.dependency-cruiser.cjs` 의
 *     `no-kms-sdk-outside-runtime-kms` 가 한 번 더.
 *   - `src/passport/signer.ts` — KMS `Decrypt` 만(P6 PP-B — 에이전트 개인키 envelope 복호, 계획 §3.5 AC-e2). 복호하는 유일한 파일이라
 *     SDK 명령을 그 파일 안에 둔다(`test/arch/passport-signer-isolation.arch.test.ts`).
 *   - `src/runtime/cloudfront.ts` — CloudFront `CreateInvalidation` 만(P6 PP-B — 신원 문서 캐시 무효화).
 *   - `src/tlog/checkpoint-signer.ts` — KMS `Sign`·`GetPublicKey` 만(ADR-0008 — 투명성 로그 체크포인트 Ed25519 · Rekor 앵커 P-256, 비추출 키).
 *     `test/arch/transparency-log.arch.test.ts` 가 "KMS Sign 을 부르는 파일은 이것 하나" 를 한 번 더 본다.
 *   - `src/tlog/anchor-http.ts` — `fetch`(ADR-0008 Phase B — OpenTimestamps 캘린더 · Sigstore Rekor v2, 호스트 이름 고정). 다이제스트·서명만 나간다.
 *   - `src/runtime/sqs.ts` — SQS `SendMessage` 만(WP-2 — 결제 웹훅 λ 가 FIFO 에 넣는다). `.dependency-cruiser.cjs` 의
 *     `no-sqs-sdk-outside-runtime-sqs` 가 한 번 더(변이 BL-2).
 *   - `src/runtime/lambda-invoke.ts` — Lambda `Invoke`(InvocationType Event) 만 — admin λ 가 커밋 뒤 login-mailer λ 를 깨운다(고정 입력). `.dependency-cruiser.cjs` 의
 *     `no-lambda-sdk-outside-runtime-lambda-invoke` 가 한 번 더.
 *   - `src/runtime/realtime-transport.ts` — API Gateway Management `PostToConnection` 만(묶음 E — 실시간 WebSocket 힌트, 엔드포인트 하나에 묶음).
 *     `.dependency-cruiser.cjs` 의 `no-apigw-management-sdk-outside-runtime-realtime` 가 한 번 더.
 *   - `src/billing/paddle/http.ts` — `fetch`(WP-2 — Paddle API, 환경별 호스트 고정 · 시간 제한 · 응답 크기 상한). Paddle 로 나가는 문은 이것 하나다
 *     (`test/arch/billing-boundary.arch.test.ts` 가 `src/billing/**` 안에서 한 번 더 본다).
 *   - `src/mail/transport/ses-identity.ts` — SES 제어면(ADR-0014 단계 2 — 고객 identity·정책·태그, 발송 명령 0). domain-control λ 만(VPC 밖).
 *   - `src/domains/dns-lookup.ts` — `node:dns/promises`(공개 리졸버 — 위임·NS 주소) · `node:dgram`(권한 NS 직접 질의, 2초 1회). domain-control λ 만.
 *   - `src/domains/rdap.ts` — `node:https`(RDAP 만료일 — rdap.org · 레지스트리, https 리다이렉트만 · 크기·시간 상한). domain-control λ 와
 *     `scripts/check-domain-expiry.ts`(atmark.ai 감시). 수신 경로와 무관하다.
 *   - `src/domains/dc-discovery.ts` — `node:dns/promises`(TXT `_domainconnect` · 주소) · `node:https`(업체 설정 · 템플릿 지원 GET — https 만 ·
 *     공인 주소 고정 연결 · 리다이렉트 없음 · 3초 · 32KB). admin λ 만(Domain Connect, 기능 플래그).
 *   - `src/domains/dc-kms-signer.ts` — KMS `Sign`·`GetPublicKey` 만(Domain Connect 적용 URL 서명 — RSA 2048 비추출 키, admin 역할 하나).
 * `node:net` 은 `isIP` 류 순수 함수를 쓰는 파일이 있어 **연결 함수 이름**으로만 본다.
 */

import { describe, expect, it } from 'vitest';
import { SyntaxKind } from 'ts-morph';

import { srcSourceFiles, toRepoRelative } from './support/project';

const EGRESS_MODULES = /^((node:)?(http|https|http2|tls|dgram|dns|dns\/promises|undici)|@aws-sdk\/client-[a-z0-9-]+(\/.*)?)$/;
const NET_MODULE = /^(node:)?net$/;
const NET_EGRESS_MEMBERS = new Set(['connect', 'createConnection', 'Socket']);
const GLOBAL_EGRESS = new Set(['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest']);

const ALLOWED = [
  'src/billing/paddle/http.ts',
  'src/domains/dc-discovery.ts',
  'src/domains/dc-kms-signer.ts',
  'src/domains/dns-lookup.ts',
  'src/domains/rdap.ts',
  'src/mail/transport/ses-identity.ts',
  'src/mail/transport/ses-transport.ts',
  'src/passport/signer.ts',
  'src/runtime/cloudfront.ts',
  'src/runtime/kms.ts',
  'src/runtime/lambda-invoke.ts',
  'src/runtime/realtime-transport.ts',
  'src/runtime/secrets.ts',
  'src/runtime/sqs.ts',
  'src/storage/s3-object-store.ts',
  'src/tlog/anchor-http.ts',
  'src/tlog/checkpoint-signer.ts',
  'src/webhooks/https-transport.ts',
];

function egressFiles(): string[] {
  const offenders = new Set<string>();
  for (const source of srcSourceFiles()) {
    const file = toRepoRelative(source.getFilePath());
    for (const declaration of source.getImportDeclarations()) {
      const specifier = declaration.getModuleSpecifierValue();
      if (EGRESS_MODULES.test(specifier)) offenders.add(file);
      if (NET_MODULE.test(specifier)) {
        const named = declaration.getNamedImports().map((n) => n.getName());
        // 네임스페이스·기본 import 는 무엇이든 부를 수 있다 — 송출로 본다.
        if (declaration.getNamespaceImport() || declaration.getDefaultImport()) offenders.add(file);
        if (named.some((name) => NET_EGRESS_MEMBERS.has(name))) offenders.add(file);
      }
    }
    // 동적 import·require 로 같은 모듈을 부르는 경로.
    for (const call of source.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression().getText();
      const [first] = call.getArguments();
      const literal = first?.asKind(SyntaxKind.StringLiteral)?.getLiteralValue();
      if ((callee === 'import' || callee === 'require') && literal !== undefined) {
        if (EGRESS_MODULES.test(literal) || NET_MODULE.test(literal)) offenders.add(file);
      }
    }
    // 전역 `fetch` 등. 지역 변수로 가려진 이름까지 구별하지는 않는다 — 그런 이름을 짓지 마라.
    for (const identifier of source.getDescendantsOfKind(SyntaxKind.Identifier)) {
      if (!GLOBAL_EGRESS.has(identifier.getText())) continue;
      const parent = identifier.getParent();
      // `obj.fetch` 같은 속성 이름은 전역이 아니다.
      if (parent?.getKind() === SyntaxKind.PropertyAccessExpression && parent.getChildAtIndex(0) !== identifier) continue;
      if (parent?.getKind() === SyntaxKind.PropertyAssignment || parent?.getKind() === SyntaxKind.PropertySignature) continue;
      // 메서드 **선언**의 이름도 전역이 아니다 — `src/api/pdf-text-worker.ts` 의 CMap 공급자는 해석기가 부르는 `fetch({kind, filename})`
      // 자리를 채우지만 번들 안 표에서만 답한다(네트워크 0). 그 메서드 **안**의 전역 `fetch` 참조는 여전히 잡힌다.
      if (parent?.asKind(SyntaxKind.MethodDeclaration)?.getNameNode() === identifier) continue;
      offenders.add(file);
    }
  }
  return [...offenders].sort();
}

describe('네트워크 송출은 허용 파일 일곱뿐이다', () => {
  it('송출 원시 모듈·전역·AWS SDK 클라이언트를 쓰는 src 파일 = 허용 파일 정확히 일곱 (모자라면 이 검사가 잠든 것이다)', () => {
    // `toEqual(ALLOWED)` 가 두 방향을 다 본다: 다른 파일이 끼면 넘치고, 검사가 아무것도 못 찾으면
    // 허용 파일조차 빠져서 모자란다 — Layer F 의 비공허성을 같은 단언이 겸한다. 셋이 **각각 다른
    // 검출 경로**(node 원시 모듈 / `@aws-sdk/client-sesv2` / `@aws-sdk/client-s3`)로 잡히므로 한 경로가
    // 잠들면 그 파일이 빠져 빨개진다. (`src/runtime/secrets.ts` 는 `@aws-sdk/client-secrets-manager`·`@aws-sdk/client-ssm`, `src/runtime/kms.ts` 는
    // `@aws-sdk/client-kms` 경로다.)
    expect(egressFiles()).toEqual(ALLOWED);
  });
});
