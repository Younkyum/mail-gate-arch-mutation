#!/usr/bin/env node
/**
 * CDK 앱 엔트리 (계획 §6 P0 생성 파일).
 *
 * env 를 하드코딩한다 — `CDK_DEFAULT_ACCOUNT`/`CDK_DEFAULT_REGION` 을 쓰면 잘못된
 * 프로파일이 활성화된 터미널에서 다른 계정에 배포될 수 있다. 이 리포가 만드는 것은
 * **되돌릴 수 없는 것들**(도메인 identity, DID 서빙 지반)이므로 계정·리전을 환경에
 * 맡기지 않는다. 프로파일이 어긋나면 배포가 실패하는 쪽이 옳다.
 */

import { fileURLToPath } from 'node:url';

import * as cdk from 'aws-cdk-lib';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import { SesStack } from './stacks/ses-stack';
import {
  IDENTITY_DOMAIN_NAME,
  IdentityCdnStack,
  IdentityCertificateStack,
} from './stacks/identity-cdn-stack';
import { PassportStack } from './stacks/passport-stack';
import { SecretsKeyStack } from './stacks/secrets-key-stack';
import { ObservabilityStack } from './stacks/observability-stack';
import { StorageStack } from './stacks/storage-stack';
import { InboundStack } from './stacks/inbound-stack';
import { NetworkStack } from './stacks/network-stack';
import { DataStack } from './stacks/data-stack';
import { API_DOMAIN_NAME, ApiCertificateStack, CONSOLE_DOMAIN_NAME, OPS_DOMAIN_NAME } from './stacks/api-certificate-stack';
import { BillingStack } from './stacks/billing-stack';
import { AiWatchStack } from './stacks/ai-watch-stack';
import { CiCdStack } from './stacks/ci-cd-stack';
import { ComputeStack, opsDomainReadyOf, realtimeDomainReadyOf } from './stacks/compute-stack';
import type { LambdaCodeSource } from './stacks/lambda-code';
import { REALTIME_DOMAIN_NAME } from '../../src/realtime/contract';
import { DocsCdnCertificateStack, DocsCdnStack } from './stacks/docs-cdn-stack';
import { DOCS_DOMAIN_NAME, DocsCertificateStack, DocsStack } from './stacks/docs-stack';
import { SiteCdnCertificateStack, SiteCdnStack } from './stacks/site-cdn-stack';
import { SITE_DOMAIN_NAME, SITE_PAY_DOMAIN_NAME, SITE_WWW_DOMAIN_NAME, SiteCertificateStack, SiteStack } from './stacks/site-stack';
import { TransparencyStack, transparencyLogBucketName } from './stacks/transparency-stack';

/** 2026-09-22 부트스트랩 완료 (qualifier hnb659fds, 버전 32). */
const ACCOUNT = '123456789012';

/** 주 리전. SES 발신·수신 모두 지원됨을 §6.0 항목 4에서 확인했다. */
const PRIMARY_REGION = 'ap-northeast-2';

/** CloudFront 용 ACM 인증서만 여기 산다. CloudFront 의 하드 제약이다. */
const CLOUDFRONT_CERT_REGION = 'us-east-1';

const primaryEnv: cdk.Environment = { account: ACCOUNT, region: PRIMARY_REGION };
const certEnv: cdk.Environment = { account: ACCOUNT, region: CLOUDFRONT_CERT_REGION };

const app = new cdk.App();

const ses = new SesStack(app, 'AtmarkSes', {
  env: primaryEnv,
  description: 'Atmark SES configuration set + event fan-out (plan P0)',
});

const identityCertificate = new IdentityCertificateStack(app, 'AtmarkIdentityCertificate', {
  env: certEnv,
  domainName: IDENTITY_DOMAIN_NAME,
  // 이 스택의 인증서를 ap-northeast-2 배포가 참조한다. CDK 가 SSM 파라미터 +
  // 커스텀 리소스로 리전 경계를 넘긴다.
  crossRegionReferences: true,
  description: 'Atmark id.atmark.ai ACM certificate (must live in us-east-1)',
});

const identityCdn = new IdentityCdnStack(app, 'AtmarkIdentityCdn', {
  env: primaryEnv,
  domainName: IDENTITY_DOMAIN_NAME,
  certificate: identityCertificate.certificate,
  // 공개 신원 API 를 CloudFront 뒤에 둔다(계획 §4B.3 r3 "배치 위치") — `id.atmark.ai/v1/identity/*` → api.atmark.ai.
  apiOriginDomainName: API_DOMAIN_NAME,
  // 투명성 로그(ADR-0008) — `id.atmark.ai/log/*` → AtmarkTransparency 의 Object Lock 버킷(이름으로 정한다 — 스택 순환 없음).
  //   `app.node` 를 넘겨 컨텍스트 `atmark:tlogBucketName`(스테이징)이 두 스택에 같은 값으로 걸리게 한다.
  transparencyLogBucketName: transparencyLogBucketName(ACCOUNT, PRIMARY_REGION, app.node),
  crossRegionReferences: true,
  description: 'Atmark did:web document serving via S3 + CloudFront (ADR-0002)',
});

// PP-A (P1c, 계획 §3.5) — 개인키 envelope 암호화용 CMK 하나. 에이전트별 시크릿은
// 런타임이 만든다(스택이 소유하면 리소스 교체가 곧 키 회전이 된다).
const passport = new PassportStack(app, 'AtmarkPassport', {
  env: primaryEnv,
  description: 'Atmark agent keypair custody — KMS CMK for envelope encryption (plan §3.5)',
});

// 비밀 → SSM 이전(2026-10-12, 배포 런북 §49) — `/atmark/*` SecureString 의 고객 관리형 KMS 키 하나. **손 배포 1회**(CD 밖):
// 값 이전 스크립트가 이 키로 파라미터를 만든 뒤에야 Compute 가 SSM 을 읽기 시작할 수 있다. 순서: AtmarkSecretsKey → 스크립트 → Compute → Transparency.
const secretsKey = new SecretsKeyStack(app, 'AtmarkSecretsKey', {
  env: primaryEnv,
  description: 'Atmark SSM SecureString secrets KMS key (alias/atmark-ssm-secrets) - decrypt only by designated runtime roles via SSM',
});

// 알람. 메트릭 방출은 `src/observability/metrics.ts` 가 EMF 로 하고 이 스택은 그 위에 판정만 얹는다.
new ObservabilityStack(app, 'AtmarkObservability', {
  env: primaryEnv,
  // 프로덕션 트래픽 개시 전에는 "24h 0건" 이 정상이다. 알람 6(관문 침묵)의 액션만
  // 꺼지고 리소스는 항상 만들어진다 — 켜는 시점을 잊지 않도록 체크리스트로 옮긴 것이다.
  productionTrafficExpected: false,
  // 운영자 콘솔 알람 36번(코드 메일 건너뜀)의 액션은 컨텍스트 `atmark:opsLive`(기본 `OPS_LIVE_DEFAULT`)를 스택이 스스로 읽는다 — go-live 뒤 켠다.
  description: 'Atmark observability — alarms 37종 (plan P1c + P2 보조 불변식 + 검증 추가분 + WP-2 결제 + 메일 기본기 + 운영자 콘솔 9종)',
});

// 발신 본문(승인 릴리스가 다른 프로세스에서 읽는다)과 수신 원문의 저장소.
const storage = new StorageStack(app, 'AtmarkStorage', {
  env: primaryEnv,
  description: 'Atmark mail object store — outbound content + inbound raw (S3, SSE-S3, RETAIN)',
});

// SES 수신: receipt rule set(활성) → S3 원문 + SNS → SQS.
// MX 레코드는 이 앱 밖(Cloudflare DNS)이고 배포 단계에서 사람이 넣는다 — 출력 `InboundMxRecord` 참조.
const inbound = new InboundStack(app, 'AtmarkInbound', {
  env: primaryEnv,
  mailBucketName: storage.mailBucket.bucketName,
  description: 'Atmark inbound mail — SES receipt rule set → S3 inbound/raw + SNS → SQS (plan P3a)',
});

// 운영 스택.
// 배포 순서(의존이 강제한다): Ses·Storage·Passport·Inbound → Network → Data → ApiCertificate(DNS 검증 대기) → Compute.
const network = new NetworkStack(app, 'AtmarkNetwork', {
  env: primaryEnv,
  description: 'Atmark VPC — private subnets, NAT instance (t4g.nano), S3 gateway endpoint, security groups',
});

const data = new DataStack(app, 'AtmarkData', {
  env: primaryEnv,
  vpc: network.vpc,
  databaseSecurityGroup: network.databaseSecurityGroup,
  description: 'Atmark RDS PostgreSQL 17 (private, force_ssl) + runtime secret slots',
});

const apiCertificate = new ApiCertificateStack(app, 'AtmarkApiCertificate', {
  env: primaryEnv,
  domainName: API_DOMAIN_NAME,
  description: 'Atmark api.atmark.ai ACM certificate (ap-northeast-2, API Gateway regional domain)',
});

// 관리 화면 호스트 — api 와 다른 인증서·다른 스택(DNS 검증 CNAME 은 배포 때 리드가 Cloudflare 에 넣는다).
const consoleCertificate = new ApiCertificateStack(app, 'AtmarkConsoleCertificate', {
  env: primaryEnv,
  domainName: CONSOLE_DOMAIN_NAME,
  certificateName: 'atmark-console',
  description: 'Atmark console.atmark.ai ACM certificate (ap-northeast-2, owner console HTTP API)',
});

// 운영자 콘솔 호스트(ADR-0015) — 같은 클래스 · 별도 스택. **항상 만든다**(먼저 배포해 DNS 검증을 기다린다 — 롤아웃 §5 6단계).
// Compute 는 발급을 확인한 뒤 `-c atmark:opsDomainReady=true` 로 재배포할 때부터 이 인증서를 참조한다(아래) — 그 배포가 끝나면 `OPS_DOMAIN_READY_DEFAULT` 를 true 로 커밋한다. 그 전 Compute 는 도메인 없이 합성된다(경고 `atmark:ops-domain-absent`).
const opsCertificate = new ApiCertificateStack(app, 'AtmarkOpsCertificate', {
  env: primaryEnv,
  domainName: OPS_DOMAIN_NAME,
  certificateName: 'atmark-ops',
  description: 'Atmark ops.atmark.ai ACM certificate (ap-northeast-2, hosted operator console HTTP API, ADR-0015)',
});
/** 인증서가 ISSUED 인가(사람이 확인 — `describe-certificate`). 컨텍스트 `atmark:opsDomainReady` ?? `OPS_DOMAIN_READY_DEFAULT` — 붙인 뒤 상수를 true 로 커밋한다(CR-M3 · deploy §24). */
const opsDomainReady = opsDomainReadyOf(app.node);

// 실시간 WebSocket 호스트(묶음 E) — 같은 클래스 · 별도 스택. **항상 만든다**(먼저 배포해 DNS 검증을 기다린다 — deploy §46). Compute 는 발급을 확인한 뒤
// `-c atmark:realtimeDomainReady=true` 로 재배포할 때부터 이 인증서를 참조한다 — 그 배포가 끝나면 `REALTIME_DOMAIN_READY_DEFAULT` 를 true 로 커밋한다.
// 그 전 Compute 는 execute-api `wss://` 주소만 갖고, 발견 문서가 그 주소를 알린다.
const realtimeCertificate = new ApiCertificateStack(app, 'AtmarkRealtimeCertificate', {
  env: primaryEnv,
  domainName: REALTIME_DOMAIN_NAME,
  certificateName: 'atmark-realtime',
  description: 'Atmark realtime.atmark.ai ACM certificate (ap-northeast-2, realtime WebSocket API custom domain)',
});
const realtimeDomainReady = realtimeDomainReadyOf(app.node);

// Lambda 코드: 운영 synth 는 `dist/lambda/<name>/index.js`(D1 의 `pnpm build:lambda`)를 요구하고 없으면 실패한다.
// `-c atmark:lambdaStub=true` 는 빌드 전 synth(IAM·네트워크 검토용)이며, 그 템플릿은 CfnRule 로 배포가 거부된다.
const lambdaStub = String(app.node.tryGetContext('atmark:lambdaStub')) === 'true';
const lambdaCode: LambdaCodeSource = lambdaStub
  ? { kind: 'stub' }
  : { kind: 'assets', root: fileURLToPath(new URL('../../dist/lambda', import.meta.url)) };

// 투명성 로그(ADR-0008 Phase A+B, US-010) — Object Lock 공개 로그 버킷 · 비추출 KMS 서명 키 둘 · Lambda atmark-transparency-log.
// 순서: Network · IdentityCdn → Transparency → Compute(migrate 가 tlog DB 비밀에 쓴다).
const transparency = new TransparencyStack(app, 'AtmarkTransparency', {
  env: primaryEnv,
  vpc: network.vpc,
  lambdaSecurityGroup: network.lambdaSecurityGroup,
  identityDistribution: identityCdn.distribution,
  lambdaCode,
  ssmSecretsKey: secretsKey.key,
  description: 'Atmark transparency log (ADR-0008) - Object Lock log bucket, non-exportable KMS signing keys, transparency-log Lambda',
});

// 결제(WP-2, Paddle) — FIFO 큐 + DLQ · 비밀 자리 다섯(Paddle 웹훅 비밀·API 키 둘 · DB 롤 둘). 함수·HTTP API 는 Compute 에 있다.
// 순서: AtmarkBilling → AtmarkObservability → AtmarkSiteCertificate → AtmarkSite → AtmarkCompute(런북 deploy §21).
const billing = new BillingStack(app, 'AtmarkBilling', {
  env: primaryEnv,
  description: 'Atmark billing (Paddle) - billing events FIFO queue + DLQ, Paddle webhook secret / API key slots, billing DB role secret slots',
});

new ComputeStack(app, 'AtmarkCompute', {
  env: primaryEnv,
  vpc: network.vpc,
  lambdaSecurityGroup: network.lambdaSecurityGroup,
  // `exactOptionalPropertyTypes` 에서 `Bucket` 클래스는 `IBucket` 에 대입되지 않는다 — CDK 타입 선언의 사정.
  mailBucket: storage.mailBucket as s3.IBucket,
  sesEventQueue: ses.eventQueue,
  inboundQueue: inbound.queue,
  secrets: {
    dbMaster: data.masterSecret,
    dbOwner: data.ownerSecret,
    dbApp: data.appSecret,
    dbAdmin: data.adminSecret,
    dbLoginMailer: data.loginMailerSecret,
    approvalLinkKeys: data.approvalLinkKeysSecret,
    webhookSecretKeys: data.webhookSecretKeysSecret,
    ownerLoginKeys: data.ownerLoginKeysSecret,
    contactForwardTo: data.contactForwardToSecret,
    dbPassportSigner: data.passportSignerSecret,
    dbTlog: transparency.dbSecret,
    dbTlogAnchor: transparency.dbAnchorSecret,
    dbOps: data.opsDbSecret,
    opsKeys: data.opsKeysSecret,
    opsLoginKeys: data.opsLoginKeysSecret,
  },
  passportKey: passport.agentKeypairKey,
  ssmSecretsKey: secretsKey.key,
  // PP-B(계약 §3) — 서명 Lambda 가 did.json·passport 를 쓰고 무효화한다. 교차 스택 참조: AtmarkIdentityCdn 이 export 를 더하므로
  // 그 스택을 **먼저** 배포한다(docs/runbooks/identity.md §3).
  identityBucket: identityCdn.bucket as s3.IBucket,
  identityDistribution: identityCdn.distribution,
  apiDomain: { domainName: API_DOMAIN_NAME, certificate: apiCertificate.certificate },
  consoleDomain: { domainName: CONSOLE_DOMAIN_NAME, certificate: consoleCertificate.certificate },
  // ADR-0015 — 인증서 발급 뒤에만(위 `opsDomainReady`). 없으면 ops API 는 execute-api 호스트뿐이고 λ 가 421 로 거절한다.
  ...(opsDomainReady ? { opsDomain: { domainName: OPS_DOMAIN_NAME, certificate: opsCertificate.certificate } } : {}),
  // 묶음 E — 인증서 발급 뒤에만(위 `realtimeDomainReady`). 없으면 execute-api `wss://` 주소(λ 는 호스트를 보지 않는다 — 토큰이 인증이다).
  ...(realtimeDomainReady ? { realtimeDomain: { domainName: REALTIME_DOMAIN_NAME, certificate: realtimeCertificate.certificate } } : {}),
  billing: {
    queue: billing.queue,
    paddleWebhookSecret: billing.paddleWebhookSecret,
    paddleSyncApiKeySecret: billing.paddleSyncApiKeySecret,
    paddleAdminApiKeySecret: billing.paddleAdminApiKeySecret,
    dbBillingSecret: billing.dbBillingSecret,
    dbBillingOperatorSecret: billing.dbBillingOperatorSecret,
  },
  lambdaCode,
  description: 'Atmark runtime — 16 Lambdas, HTTP APIs (api + console + billing + ops), SQS sources, Scheduler, IAM (Layer E: SES sender role + login-mailer role)',
});

// 홈 atmark.ai(+ www → 301) — 운영 스택과 공유하는 것이 없다(VPC·DB·비밀·SES·S3 0). 인증서는 콘솔과 같은 이유로 별도 스택
// (DNS 검증 CNAME 은 배포 때 리드가 Cloudflare 에 넣는다). 배포·DNS 절차: docs/runbooks/site.md.
const siteCertificate = new SiteCertificateStack(app, 'AtmarkSiteCertificate', {
  env: primaryEnv,
  domainName: SITE_DOMAIN_NAME,
  alternativeNames: [SITE_WWW_DOMAIN_NAME],
  // WP-2 — pay.atmark.ai 는 별도 인증서(atmark-pay). 검증 CNAME 은 진윤겸 승인 뒤 리드가 넣는다(docs/runbooks/site.md).
  payDomainName: SITE_PAY_DOMAIN_NAME,
  description: 'Atmark atmark.ai + www.atmark.ai ACM certificate (ap-northeast-2, home HTTP API) + pay.atmark.ai certificate',
});

if (siteCertificate.payCertificate === undefined) throw new Error('pay.atmark.ai 인증서가 없다 — SiteCertificateStack payDomainName');

const site = new SiteStack(app, 'AtmarkSite', {
  env: primaryEnv,
  domains: {
    apex: SITE_DOMAIN_NAME,
    www: SITE_WWW_DOMAIN_NAME,
    certificate: siteCertificate.certificate,
    pay: { domainName: SITE_PAY_DOMAIN_NAME, certificate: siteCertificate.payCertificate },
  },
  lambdaCode,
  description: 'Atmark home atmark.ai + pay.atmark.ai - site Lambda (no VPC, no DB, logs only) + HTTP API atmark-site',
});

// 홈 앞 CloudFront(2026-09-27 — 첫 방문 폰트 버스트의 503). 별칭은 apex 하나, 오리진은 apex 커스텀 도메인의 리전 도메인 이름 + Host 전달
// (www·pay 는 API Gateway 그대로). 인증서는 us-east-1 별도 스택. **배포·DNS 는 리드가** — docs/runbooks/site.md §10.
if (site.apexDomain === undefined) throw new Error('atmark.ai 커스텀 도메인이 없다 — SiteStack domains');
const siteCdnCertificate = new SiteCdnCertificateStack(app, 'AtmarkSiteCdnCertificate', {
  env: certEnv,
  domainName: SITE_DOMAIN_NAME,
  alternativeNames: [SITE_WWW_DOMAIN_NAME],
  crossRegionReferences: true,
  description: 'Atmark atmark.ai + www.atmark.ai ACM certificate for the home CloudFront distribution (must live in us-east-1)',
});
const siteCdn = new SiteCdnStack(app, 'AtmarkSiteCdn', {
  env: primaryEnv,
  domainName: SITE_DOMAIN_NAME,
  certificate: siteCdnCertificate.certificate,
  originDomainName: site.apexDomain.regionalDomainName,
  crossRegionReferences: true,
  description: 'Atmark home atmark.ai CloudFront - edge cache for fonts/images/crawl files, pages pass through to HTTP API atmark-site',
});
siteCdn.addStackDependency(siteCdnCertificate);

// 사용자 문서 docs.atmark.ai(계획 .omc/plans/docs-site.md §5) — 새 스택 넷, 기존 스택과 공유하는 것이 없다(참조 0 → 기존 스택 diff 0).
// 순서: AtmarkDocsCertificate(DNS 검증 대기) → AtmarkDocs → AtmarkDocsCdnCertificate(us-east-1) → AtmarkDocsCdn. **배포·DNS 는 리드가** — docs/runbooks/docs.md.
const docsCertificate = new DocsCertificateStack(app, 'AtmarkDocsCertificate', {
  env: primaryEnv,
  domainName: DOCS_DOMAIN_NAME,
  description: 'Atmark docs.atmark.ai ACM certificate (ap-northeast-2, docs HTTP API)',
});
const docs = new DocsStack(app, 'AtmarkDocs', {
  env: primaryEnv,
  domain: { domainName: DOCS_DOMAIN_NAME, certificate: docsCertificate.certificate },
  lambdaCode,
  description: 'Atmark docs docs.atmark.ai - docs Lambda (no VPC, no DB, logs only) + HTTP API atmark-docs',
});
if (docs.domain === undefined) throw new Error('docs.atmark.ai 커스텀 도메인이 없다 — DocsStack domain');
const docsCdnCertificate = new DocsCdnCertificateStack(app, 'AtmarkDocsCdnCertificate', {
  env: certEnv,
  domainName: DOCS_DOMAIN_NAME,
  crossRegionReferences: true,
  description: 'Atmark docs.atmark.ai ACM certificate for the docs CloudFront distribution (must live in us-east-1)',
});
const docsCdn = new DocsCdnStack(app, 'AtmarkDocsCdn', {
  env: primaryEnv,
  domainName: DOCS_DOMAIN_NAME,
  certificate: docsCdnCertificate.certificate,
  originDomainName: docs.domain.regionalDomainName,
  crossRegionReferences: true,
  description: 'Atmark docs docs.atmark.ai CloudFront - edge cache for pages and assets in front of HTTP API atmark-docs',
});
docsCdn.addStackDependency(docsCdnCertificate);

// GitHub Actions OIDC(2026-10-01) — 공급자 하나 · 역할 둘(web: main 브랜치만 · compute: 환경 production 만). 다른 스택과 참조 0.
// **CD 가 배포하지 않는다** — 리드가 손으로 `--exclusively`. 절차: docs/runbooks/ci-cd.md.
new CiCdStack(app, 'AtmarkCiCd', {
  env: { account: ACCOUNT, region: PRIMARY_REGION },
  description: 'Atmark GitHub Actions OIDC provider + deploy roles (atmark-gha-deploy-web, atmark-gha-deploy-compute) - no long-lived keys',
});

// AI 의심 메일 감시(ADR-0017 초안) — CMK · 요청/결과 큐 · Mac IAM 사용자. 다른 스택과 참조 0(Compute 는 계약의 이름으로 맞춘다).
// **CD 가 배포하지 않는다** — 리드가 손으로 `--exclusively`(Mac 사용자의 권한을 CD 역할이 고치지 못하게). 절차: docs/runbooks/ai-watch.md §7.
new AiWatchStack(app, 'AtmarkAiWatch', {
  env: { account: ACCOUNT, region: PRIMARY_REGION },
  description: 'Atmark AI mail watch (ADR-0017 draft) - request queue (SSE-KMS CMK), result queue + DLQ, Mac worker IAM user (no access key in CDK)',
});

// 인증서가 ISSUED 상태가 되기 전에는 CloudFront 가 대체 도메인 이름을 받지 않는다.
// 배포 순서를 명시해 "인증서 검증 대기 중에 CDN 배포가 먼저 실패"하는 경로를 없앤다.
identityCdn.addStackDependency(identityCertificate);
