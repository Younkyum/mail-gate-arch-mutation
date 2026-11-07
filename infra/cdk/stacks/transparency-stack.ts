/**
 * AtmarkTransparency — 투명성 로그(ADR-0008 Phase A + B, US-010): **Object Lock 공개 로그 버킷 · 비추출 KMS 서명 키 둘 · DB 롤 비밀 둘 ·
 * Lambda 둘(`atmark-transparency-log` 5분 · `atmark-transparency-anchor` 매시) · 함수마다 전용 IAM 역할**.
 *
 * 배포·첫 체크포인트·키 고정 절차는 `docs/runbooks/transparency-log.md`.
 *
 * ## 공개 로그 버킷 — 왜 새 버킷인가
 * ADR-0008 §2.4 는 `/log/` 객체를 **S3 Object Lock compliance** 로 지키라고 한다(보존 기간 안에는 루트 사용자도 지우거나 덮거나 기간을
 * 줄이지 못한다 — AWS 문서 S13). 기존 identity 버킷(did.json)에 Object Lock 을 켜면 **기본 보존이 버킷 전체에** 걸려 신원 문서의 옛 판까지
 * 보존 기간 동안 잠긴다(정지·폐기 뒤에도 지울 수 없다 — 원하지 않는 성질). 그래서 `/log/*` 전용 버킷을 따로 두고, `id.atmark.ai` 배포의 `/log/*`
 * 동작이 이 버킷을 오리진으로 쓴다(`identity-cdn-stack.ts` `transparencyLogBucketName`). 버킷 이름을 **이름으로 정하는** 이유: 배포
 * (IdentityCdn)가 버킷 이름을, 버킷 정책(이 스택)이 배포 ARN 을 서로 참조하면 스택 순환이 된다 — 이름은 앱이 정하고(두 스택에 같은 값),
 * ARN 은 이 스택이 받는다. 기본 `atmark-tlog-<계정>-<리전>` · 컨텍스트 `atmark:tlogBucketName` 으로 바꾼다(스테이징 — 아래).
 *
 * **보존 모드 = COMPLIANCE, 1년**(진윤겸 2026-09-24 — Q4 의 7년에서 줄임 · ADR-0008 §9). 거버넌스 모드는 `s3:BypassGovernanceRetention` 을 가진 주체(곧 계정 관리자
 * = Atmark)가 지울 수 있어 "Atmark 를 믿어라" 로 되돌아간다. COMPLIANCE 가 지키는 것은 **이미 쓴 객체 판**이다 — 그 판의 보존 기한은 누구도
 * 줄이거나 지울 수 없다(늘리기만 된다). 버킷의 **기본 보존 설정 자체는** 바꿀 수 있고 바꾸면 그 뒤에 쓰는 객체에만 적용된다(이미 쓴 판은 그대로).
 * 대가: 잘못 게시한 객체도 보존 기간(1년) 동안 못 지운다 — 그래서 게시 표면에는 **불투명 해시·시각·서명뿐**(PII 0, 센티넬 테스트)이고, 쓰기 면
 * (`createS3TransparencyLogWriter`)은 로그 경로 모양만 받는다. 보존이 끝난 **옛 판**(매시 덮어쓰는 `checkpoint`·`key`·부분 타일의 이전 판)은
 * 수명 주기 규칙이 지운다(보존 1년 + 하루 — 보존 중인 판은 수명 주기도 지우지 못한다). 저장 비용은 사실상 0.
 *
 * **스테이징:** 버킷 이름은 계정·리전마다 하나이고 Object Lock 버킷은 1년 동안 비울 수 없다 — 스테이징은 **다른 계정**을 쓰거나, 같은 계정이면
 * `-c atmark:tlogBucketName=<다른 이름> -c atmark:tlogOrigin=<다른 origin>` 으로 **다른 버킷·다른 origin** 을 준다(같은 origin 의 두 로그가
 * 생기지 않게 — 검증기는 origin 을 고정한다). 운영 값은 테스트가 고정한다(`transparency-stack.test.ts`).
 *
 * ## 서명 키 — 비추출
 *   - 체크포인트 키 `ECC_NIST_EDWARDS25519` / `SIGN_VERIFY`(AWS KMS 키 사양 문서, 2026-09-24 확인 — `ED25519_SHA_512` 는 `MessageType: RAW`).
 *   - 앵커 키 `ECC_NIST_P256` / `SIGN_VERIFY` — Rekor v2 `hashedrekord` 전용(`src/tlog/signing.ts` 머리말 — 순수 Ed25519 는 다이제스트만으로
 *     검증되지 않는다).
 *   KMS 비대칭 개인키는 KMS 밖으로 나오지 않는다. 키 자료 출처는 AWS_KMS(가져온 키 아님) · 단일 리전(복제본 = 사본 없음). 키 정책의 **명시
 *   Deny** 가 `kms:Sign` 을 **그 키를 쓰는 역할 하나** 말고는 막는다 — 체크포인트 키는 로그 역할, 앵커 키는 앵커 역할(passport-stack 과 같은
 *   모양 — IAM 정책 오타 하나에 기대지 않는다).
 *
 * ## 함수 둘, 역할 둘 (M5 해소 — 2026-09-24 리드 결정 ①)
 *   - `atmark-transparency-log`(역할 `atmark-runtime-transparency-log`, DB 롤 `atmark_tlog`) — 서열·에폭·게시. 체크포인트 키(Ed25519)
 *     `kms:Sign` · `atmark/db/tlog` 비밀 · 로그 버킷 게시 키 모양(`TLOG_LOG_WRITE_KEYS`) PutObject + `log/checkpoint` GetObject(게시 수위). **외부 HTTP 없음.**
 *   - `atmark-transparency-anchor`(역할 `atmark-runtime-transparency-anchor`, DB 롤 `atmark_tlog_anchor`) — OTS·Rekor 응답을 **파싱하는 쪽**.
 *     앵커 키(P-256) `kms:Sign` · `atmark/db/tlog-anchor` 비밀 · 영수증 키 모양(`TLOG_ANCHOR_WRITE_KEYS`) PutObject 뿐. 체크포인트 키·`atmark_tlog` 비밀·체크포인트
 *     경로에 닿지 못한다 — 앵커 코드가 뚫려도 체크포인트에 서명하거나 로그를 고칠 수 없다(IAM · 키 정책 · DB 롤 세 겹).
 * 예전에는 DB 연결 예산(≤ 75, 75 였다) 때문에 한 함수·한 역할이었다(M5 잔여 위험). `ses-events` 예약 동시성을 2 → 1 로 줄여(연결 −3,
 * `compute-stack.ts`) 함수를 나눴다 — 각 예약 동시성 1 × 풀 1 = 연결 2. 합은 Compute 70 + 2 = 72(2026-09-28 ADR-0015 — api 9 → 8 · ops 2 × 1 · `transparency-stack.test.ts` 가 고정).
 * **SES 권한 0 · 다른 비밀 0 · Delete·보존 변경·Bypass 없음.**
 * 체크포인트 키는 키 정책이 `kms:ScheduleKeyDeletion`·`kms:DisableKey` 를 모두에게 막는다(break-glass: 키 정책 변경 — 런북 §6.1).
 */

import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import type * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import type * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as schedulerTargets from 'aws-cdk-lib/aws-scheduler-targets';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { SubnetType } from 'aws-cdk-lib/aws-ec2';
import type { Construct } from 'constructs';

import { lambdaCodeOf, refuseStubDeployment, type LambdaCodeSource } from './lambda-code';
import { SECRET_PLACEHOLDER_VALUE } from './data-stack';
import { denySesSendingInStack } from './ses-send-deny';
import { denySsmDeleteInStack, grantSsmSecretRead } from './ssm-secrets';
import { ssmParameterNameOf } from '../../../src/runtime/ssm-secret-names';

/** 컨텍스트 — 버킷 이름·origin(스테이징)·Rekor 샤드 키. */
export const TLOG_BUCKET_CONTEXT_KEY = 'atmark:tlogBucketName';
export const TLOG_ORIGIN_CONTEXT_KEY = 'atmark:tlogOrigin';
export const TLOG_REKOR_VKEY_CONTEXT_KEY = 'atmark:tlogRekorVkey';
/** 운영 origin — `src/tlog/constants.ts` `TLOG_ORIGIN` 과 같다(테스트가 고정). */
export const TLOG_DEFAULT_ORIGIN = 'id.atmark.ai/log/v1';

interface ContextReader {
  tryGetContext(key: string): unknown;
}

function contextString(node: ContextReader | undefined, key: string): string | undefined {
  const value: unknown = node?.tryGetContext(key);
  return value === undefined || value === null || String(value).trim() === '' ? undefined : String(value).trim();
}

/**
 * 공개 로그 버킷 이름 — IdentityCdn 의 `/log/*` 오리진과 이 스택이 **같은 함수로** 정한다(앱이 두 스택에 같은 값을 준다 — 머리말).
 * `node` 를 주면 컨텍스트 `atmark:tlogBucketName` 이 기본값을 바꾼다(S3 버킷 이름 규칙으로 검사).
 */
export function transparencyLogBucketName(account: string, region: string, node?: ContextReader): string {
  const override = contextString(node, TLOG_BUCKET_CONTEXT_KEY);
  if (override === undefined) return `atmark-tlog-${account}-${region}`;
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(override) || override.includes('..')) {
    throw new Error(`${TLOG_BUCKET_CONTEXT_KEY} 가 S3 버킷 이름 모양이 아니다: ${override.slice(0, 80)}`);
  }
  return override;
}

/** 체크포인트 origin — 기본 운영 값, 컨텍스트 `atmark:tlogOrigin`(호스트[/경로], 공백·+ 없음). */
export function transparencyLogOrigin(node?: ContextReader): string {
  const origin = contextString(node, TLOG_ORIGIN_CONTEXT_KEY) ?? TLOG_DEFAULT_ORIGIN;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(\/[A-Za-z0-9._-]+)*$/.test(origin)) {
    throw new Error(`${TLOG_ORIGIN_CONTEXT_KEY} 가 origin 모양이 아니다: ${origin.slice(0, 80)}`);
  }
  return origin;
}

export const TLOG_OBJECT_PREFIX = 'log/';
/**
 * 쓰기 역할의 S3 리소스 = **코드가 실제로 쓰는 키 모양**뿐(2026-09-24 적대적 검증 M2). `log/*` · `log/anchors/*` 통째면 역할이 뚫렸을 때
 * 아무 키(예: `log/anchors/x.html`)에나 쓸 수 있고, 그 판은 Object Lock COMPLIANCE 로 1년 동안 못 지운 채 `id.atmark.ai/log/*` 로 나간다.
 *   - 로그: `publisher.ts` — `checkpoint` · `key` · `checkpoints/<epoch>` · `tiles.ts` `tile/<L>/…` · `tile/entries/…`.
 *   - 앵커: `anchor.ts` — `anchors/ots/<epoch>/<캘린더 호스트>.ots` · `anchors/rekor/<epoch>.json`.
 * IAM 의 `*` 는 `/` 도 넘으므로 이것은 접두사·확장자까지만 좁힌다 — 정확한 모양은 읽는 쪽(`identity-cdn-stack.ts` 경로 가드 함수)이
 * 막는다: 모양 밖 키는 써도 404 다. S3 에는 Content-Type 조건 키가 없다 — 응답은 nosniff · CSP sandbox 로 내보낸다(같은 파일).
 */
export const TLOG_LOG_WRITE_KEYS: readonly string[] = ['log/checkpoint', 'log/key', 'log/checkpoints/*', 'log/tile/*'];
export const TLOG_ANCHOR_WRITE_KEYS: readonly string[] = ['log/anchors/ots/*.ots', 'log/anchors/rekor/*.json'];
export const TLOG_FUNCTION_NAME = 'atmark-transparency-log';
export const TLOG_RUNTIME_ROLE_NAME = 'atmark-runtime-transparency-log';
export const TLOG_ANCHOR_FUNCTION_NAME = 'atmark-transparency-anchor';
export const TLOG_ANCHOR_RUNTIME_ROLE_NAME = 'atmark-runtime-transparency-anchor';
/** `dist/lambda/<이 이름>/index.js` — `scripts/build-lambda.ts`. */
export const TLOG_HANDLER = 'transparency-log';
export const TLOG_ANCHOR_HANDLER = 'transparency-anchor';
/** 예약 동시성 — 함수마다 1(틱이 겹치지 않게 · DB 연결 예산 1씩). */
export const TLOG_RESERVED_CONCURRENCY = 1;
export const TLOG_ANCHOR_RESERVED_CONCURRENCY = 1;
export const TLOG_TIMEOUT_SECONDS = 240;
export const TLOG_MEMORY_MB = 512;
/** 과제·주기 — 서열은 5분(에폭 마감은 코드가 UTC 시 경계에서만), 앵커는 매시(예약은 코드가 하루 1회). 과제마다 자기 함수를 부른다. */
export const TLOG_SCHEDULES: readonly { readonly task: 'log' | 'anchor'; readonly minutes: number }[] = [
  { task: 'log', minutes: 5 },
  { task: 'anchor', minutes: 60 },
];
/**
 * Object Lock 기본 보존 — COMPLIANCE **1년**(진윤겸 2026-09-24: 7년 권장값을 1년으로 줄여 시작, 필요하면 늘린다).
 * COMPLIANCE 보존은 늘릴 수는 있고 줄일 수는 없다 — 짧게 시작하는 쪽이 되돌릴 수 있는 방향이다. 변조 탐지는 외부 앵커(OTS·Rekor)가 영구히 맡는다.
 */
export const TLOG_OBJECT_LOCK_DAYS = 365;
export const TLOG_CHECKPOINT_KEY_ALIAS = 'alias/atmark-tlog-checkpoint';
export const TLOG_ANCHOR_KEY_ALIAS = 'alias/atmark-tlog-anchor';
export const TLOG_DB_SECRET_NAME = 'atmark/db/tlog';
export const TLOG_ANCHOR_DB_SECRET_NAME = 'atmark/db/tlog-anchor';
/** 키 정책 Deny 문장 sid(키마다 그 키를 쓰는 역할 하나만 예외) — 테스트가 이 이름으로 찾는다. */
export const DENY_SIGN_EXCEPT_TLOG_SID = 'DenySignExceptTransparencyLogRole';
/** 체크포인트 키 — 삭제 예약·비활성화를 모두에게 막는다(L6). break-glass 는 키 정책 변경(런북 §6.1). */
export const DENY_CHECKPOINT_KEY_DESTRUCTION_SID = 'DenyCheckpointKeyDeletionOrDisable';
/** 보존 끝난 옛 판을 지우는 날 수 — 보존(365일) + 1. 옛 판이 된 시각 ≥ 만든 시각이라 보존 기한 뒤다. */
export const TLOG_NONCURRENT_EXPIRATION_DAYS = 366;
/** OTS 캘린더(opentimestamps-client 기본 집계기 넷 중 둘 이상 — `src/tlog/anchor-http.ts` 허용 목록). */
export const TLOG_OTS_CALENDARS = ['https://a.pool.opentimestamps.org', 'https://b.pool.opentimestamps.org', 'https://a.pool.eternitywall.com'];
/**
 * Rekor v2 샤드 기본값 — rekor-tiles README 가 운영 중이라고 적은 샤드(2026-09-24 확인). **해마다 바뀐다** — 배포 때 Sigstore
 * SigningConfig(TUF)로 현재 샤드를 확인하고 `-c atmark:tlogRekorUrl=https://logYYYY-N.rekor.sigstore.dev` 로 넣는다(런북 §5). **샤드 키를
 * `-c atmark:tlogRekorVkey=<vkey>` 로 고정하지 않으면 Rekor 를 켜지 않는다**(URL 도 비운다 — OTS 만).
 */
export const TLOG_REKOR_URL_DEFAULT = 'https://log2025-1.rekor.sigstore.dev';
export const TLOG_REKOR_CONTEXT_KEY = 'atmark:tlogRekorUrl';

export interface TransparencyStackProps extends cdk.StackProps {
  readonly vpc: ec2.IVpc;
  readonly lambdaSecurityGroup: ec2.ISecurityGroup;
  /** `id.atmark.ai` 배포 — 버킷 정책이 이 배포(OAC)의 읽기만 허락한다. */
  readonly identityDistribution: cloudfront.IDistribution;
  readonly lambdaCode: LambdaCodeSource;
  /** `/atmark/db/tlog*` SecureString 의 고객 관리형 키(AtmarkSecretsKey). */
  readonly ssmSecretsKey: kms.IKey;
}

export class TransparencyStack extends cdk.Stack {
  public readonly bucket: s3.Bucket;
  public readonly checkpointKey: kms.Key;
  public readonly anchorKey: kms.Key;
  public readonly dbSecret: secretsmanager.ISecret;
  public readonly dbAnchorSecret: secretsmanager.ISecret;
  /** 로그 함수의 역할 — 체크포인트 키 · `atmark/db/tlog` · `log/*`. */
  public readonly role: iam.Role;
  /** 앵커 함수의 역할 — 앵커 키 · `atmark/db/tlog-anchor` · `log/anchors/*`. */
  public readonly anchorRole: iam.Role;
  public readonly function: lambda.Function;
  public readonly anchorFunction: lambda.Function;

  public constructor(scope: Construct, id: string, props: TransparencyStackProps) {
    super(scope, id, props);

    // ── 공개 로그 버킷 (Object Lock COMPLIANCE 1년) ─────────────────────────
    this.bucket = new s3.Bucket(this, 'TransparencyLogBucket', {
      bucketName: transparencyLogBucketName(this.account, this.region, this.node),
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      objectLockEnabled: true,
      objectLockDefaultRetention: s3.ObjectLockRetention.compliance(cdk.Duration.days(TLOG_OBJECT_LOCK_DAYS)),
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      // 옛 판(매시 덮어쓰는 checkpoint·key·부분 타일)은 보존이 끝난 뒤 지운다. 현재 판(checkpoints/<epoch> 이력·완전 타일)은 지우지 않는다.
      lifecycleRules: [{ id: 'ExpireNoncurrentAfterRetention', noncurrentVersionExpiration: cdk.Duration.days(TLOG_NONCURRENT_EXPIRATION_DAYS) }],
    });
    // CloudFront(OAC) — `id.atmark.ai` 배포 하나만, `log/*` 읽기만.
    this.bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowIdentityDistributionReadLog',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
        actions: ['s3:GetObject'],
        resources: [this.bucket.arnForObjects(`${TLOG_OBJECT_PREFIX}*`)],
        conditions: {
          StringEquals: { 'AWS:SourceArn': `arn:${this.partition}:cloudfront::${this.account}:distribution/${props.identityDistribution.distributionId}` },
        },
      }),
    );

    // ── 역할 둘 — 함수마다 하나(M5: 외부 응답을 파싱하는 앵커 코드가 체크포인트 키·로그 DB 롤에 닿지 않게) ─────────
    const lambdaRole = (constructId: string, roleName: string, description: string): iam.Role =>
      new iam.Role(this, constructId, {
        roleName,
        description,
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
          iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
        ],
      });
    this.role = lambdaRole(
      'TransparencyLogRole',
      TLOG_RUNTIME_ROLE_NAME,
      'Transparency log (ADR-0008): checkpoint KMS Sign, log bucket PutObject, atmark/db/tlog secret. No anchor key, no SES, no other secrets.',
    );
    this.anchorRole = lambdaRole(
      'TransparencyAnchorRole',
      TLOG_ANCHOR_RUNTIME_ROLE_NAME,
      'Transparency log anchors (ADR-0008): anchor KMS Sign, log/anchors/* PutObject, atmark/db/tlog-anchor secret. No checkpoint key, no SES.',
    );
    // 비발송 역할의 SES 발송 명시 Deny(ADR-0014 단계 2 — `ses-send-deny.ts`, 스택의 모든 역할).
    denySesSendingInStack(this);
    // SSM 파라미터 삭제 명시 Deny(비밀 → SSM 이전 · `ssm-secrets.ts`) — 스택의 모든 역할.
    denySsmDeleteInStack(this);
    const roleArnOf = (roleName: string): string => `arn:${this.partition}:iam::${this.account}:role/${roleName}`;

    // ── KMS 키 둘 — 비추출 · 서명 전용 · 키 정책 Deny(그 키를 쓰는 역할 하나만 예외) ──────
    const signingKey = (constructId: string, alias: string, keySpec: kms.KeySpec, signerRoleName: string, description: string): kms.Key => {
      const key = new kms.Key(this, constructId, {
        alias,
        description,
        keySpec,
        keyUsage: kms.KeyUsage.SIGN_VERIFY,
        // 서명 키를 잃으면 새 키로 공동 서명 기간을 두고 넘어가야 한다(런북 §6) — 스택 삭제로 잃지 않게.
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        pendingWindow: cdk.Duration.days(30),
        // 비대칭 키는 자동 회전이 없다. 키 교체는 signed note 공동 서명(ADR-0008 §2.4).
        enableKeyRotation: false,
      });
      key.addToResourcePolicy(
        new iam.PolicyStatement({
          sid: DENY_SIGN_EXCEPT_TLOG_SID,
          effect: iam.Effect.DENY,
          principals: [new iam.AnyPrincipal()],
          actions: ['kms:Sign'],
          resources: ['*'],
          conditions: { ArnNotEquals: { 'aws:PrincipalArn': roleArnOf(signerRoleName) } },
        }),
      );
      return key;
    };
    this.checkpointKey = signingKey(
      'CheckpointKey',
      TLOG_CHECKPOINT_KEY_ALIAS,
      kms.KeySpec.ECC_NIST_EDWARDS25519,
      TLOG_RUNTIME_ROLE_NAME,
      'Atmark transparency log checkpoint key (C2SP signed note, Ed25519). Non-exportable. Sign only by atmark-runtime-transparency-log.',
    );
    // L6 — 체크포인트 키를 잃으면 로그를 이어 서명할 수 없다(새 origin 으로 새 로그). 삭제 예약·비활성화를 모두에게 막는다 — 계정 관리자도
    //   키 정책을 먼저 바꿔야 한다(검토된 CDK 변경 = break-glass, 런북 §6.1). PutKeyPolicy 는 막지 않는다(잠금 사고 방지).
    this.checkpointKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: DENY_CHECKPOINT_KEY_DESTRUCTION_SID,
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['kms:ScheduleKeyDeletion', 'kms:DisableKey'],
        resources: ['*'],
      }),
    );
    this.anchorKey = signingKey(
      'AnchorKey',
      TLOG_ANCHOR_KEY_ALIAS,
      kms.KeySpec.ECC_NIST_P256,
      TLOG_ANCHOR_RUNTIME_ROLE_NAME,
      'Atmark transparency log Rekor v2 anchor key (hashedrekord ECDSA P-256). Non-exportable. Sign only by atmark-runtime-transparency-anchor.',
    );
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CheckpointSignEd25519Raw',
        actions: ['kms:Sign'],
        resources: [this.checkpointKey.keyArn],
        conditions: { StringEquals: { 'kms:SigningAlgorithm': 'ED25519_SHA_512', 'kms:MessageType': 'RAW' } },
      }),
    );
    this.role.addToPolicy(new iam.PolicyStatement({ sid: 'CheckpointPublicKey', actions: ['kms:GetPublicKey'], resources: [this.checkpointKey.keyArn] }));
    this.anchorRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AnchorSignEcdsaDigest',
        actions: ['kms:Sign'],
        resources: [this.anchorKey.keyArn],
        conditions: { StringEquals: { 'kms:SigningAlgorithm': 'ECDSA_SHA_256', 'kms:MessageType': 'DIGEST' } },
      }),
    );
    this.anchorRole.addToPolicy(new iam.PolicyStatement({ sid: 'AnchorPublicKey', actions: ['kms:GetPublicKey'], resources: [this.anchorKey.keyArn] }));

    // ── DB 롤 비밀 둘(자리값 — migrate `bootstrap-roles` 가 채운다) — 함수마다 자기 것 하나 ─────────────
    const placeholder = (constructId: string, secretName: string, description: string): secretsmanager.ISecret =>
      new secretsmanager.Secret(this, constructId, {
        secretName,
        description,
        secretStringValue: cdk.SecretValue.unsafePlainText(SECRET_PLACEHOLDER_VALUE),
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      }) as secretsmanager.ISecret;
    this.dbSecret = placeholder('DbTlogSecret', TLOG_DB_SECRET_NAME, 'atmark_tlog DB role (transparency log sequencer/epoch/publisher). Filled by migrate bootstrap-roles.');
    this.dbAnchorSecret = placeholder('DbTlogAnchorSecret', TLOG_ANCHOR_DB_SECRET_NAME, 'atmark_tlog_anchor DB role (transparency log anchors). Filled by migrate bootstrap-roles.');
    // 읽기는 SSM 자리(`/atmark/db/tlog` · `/atmark/db/tlog-anchor`, 2026-10-12 비밀 → SSM 이전 — 배포 런북 §49). 위 Secrets Manager 자리는 다음 PR 에서
    //   지운다(되돌리기 가능하게 남겨 둔다). 쓰기는 AtmarkCompute 의 migrate 역할.
    grantSsmSecretRead(this.role, 'TlogDbSecretRead', [TLOG_DB_SECRET_NAME], props.ssmSecretsKey);
    grantSsmSecretRead(this.anchorRole, 'TlogAnchorDbSecretRead', [TLOG_ANCHOR_DB_SECRET_NAME], props.ssmSecretsKey);

    // ── S3 — 로그: 게시 키 모양 PutObject + `log/checkpoint` GetObject(게시 수위 — 에폭 마감이 서명 전에 읽는다, H4) · 앵커: 영수증 키 모양 PutObject ──
    this.role.addToPolicy(
      new iam.PolicyStatement({ sid: 'TransparencyLogPut', actions: ['s3:PutObject'], resources: TLOG_LOG_WRITE_KEYS.map((key) => this.bucket.arnForObjects(key)) }),
    );
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'TransparencyLogPublishedCheckpointRead',
        actions: ['s3:GetObject'],
        resources: [this.bucket.arnForObjects(`${TLOG_OBJECT_PREFIX}checkpoint`)],
      }),
    );
    // 첫 게시 전에는 `log/checkpoint` 가 없다. S3 는 ListBucket 이 없는 호출자에게 없는 키를 404(NoSuchKey)가 아니라 403 으로 돌려준다 —
    // 그러면 게시 수위 가드가 "게시본 없음" 과 "권한 오류" 를 가르지 못하고 첫 에폭을 영영 서명하지 않는다(2026-09-24 운영 첫 틱 실측:
    // `not authorized to perform: s3:ListBucket`). 목록은 공개 버킷의 키 이름뿐이라(전부 id.atmark.ai/log/ 로 서빙) 새로 드러나는 것이 없다.
    this.role.addToPolicy(
      new iam.PolicyStatement({ sid: 'TransparencyLogListForNotFound', actions: ['s3:ListBucket'], resources: [this.bucket.bucketArn] }),
    );
    this.anchorRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'TransparencyAnchorReceiptPut',
        actions: ['s3:PutObject'],
        resources: TLOG_ANCHOR_WRITE_KEYS.map((key) => this.bucket.arnForObjects(key)),
      }),
    );

    // ── 함수 둘 ──────────────────────────────────────────────────────────────
    const code = (handler: string): lambda.Code => lambdaCodeOf(props.lambdaCode, handler);
    // Rekor 는 샤드 키(vkey)를 고정했을 때만 켠다 — 키 없이 받은 응답은 스스로를 확인할 뿐이다(M2). 키가 없으면 URL 도 비운다(OTS 만).
    const rekorVkey = contextString(this.node, TLOG_REKOR_VKEY_CONTEXT_KEY) ?? '';
    const rekorUrl = rekorVkey === '' ? '' : (contextString(this.node, TLOG_REKOR_CONTEXT_KEY) ?? TLOG_REKOR_URL_DEFAULT);
    if (rekorVkey !== '') {
      const match = /^([^+\s]+)\+[0-9a-f]{8}\+[A-Za-z0-9+/]+={0,2}$/.exec(rekorVkey);
      if (match === null || match[1] !== new URL(rekorUrl).hostname) {
        throw new Error(`${TLOG_REKOR_VKEY_CONTEXT_KEY} 는 C2SP vkey 이고 이름이 Rekor 샤드 호스트(${rekorUrl})와 같아야 한다.`);
      }
    }
    const tlogFunction = (
      constructId: string,
      options: {
        readonly functionName: string;
        /** 로그 그룹 construct id — 로그 함수는 합칠 때의 id(`TransparencyLogLogs`)를 그대로 둔다(같은 이름 그룹의 교체 충돌 없음). */
        readonly logGroupId: string;
        readonly handler: string;
        readonly description: string;
        readonly role: iam.Role;
        readonly reserved: number;
        readonly environment: Record<string, string>;
      },
    ): lambda.Function =>
      new lambda.Function(this, constructId, {
        functionName: options.functionName,
        description: options.description,
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        handler: 'index.handler',
        code: code(options.handler),
        memorySize: TLOG_MEMORY_MB,
        timeout: cdk.Duration.seconds(TLOG_TIMEOUT_SECONDS),
        reservedConcurrentExecutions: options.reserved,
        role: options.role,
        vpc: props.vpc,
        vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: [props.lambdaSecurityGroup],
        environment: {
          ATMARK_ENV: 'production',
          ...options.environment,
          ATMARK_TLOG_BUCKET: this.bucket.bucketName,
          PGSSLMODE: 'require',
          NODE_EXTRA_CA_CERTS: '/var/runtime/ca-cert.pem',
        },
        logGroup: new logs.LogGroup(this, options.logGroupId, {
          logGroupName: `/aws/lambda/${options.functionName}`,
          retention: logs.RetentionDays.THREE_MONTHS,
        }),
      });
    this.function = tlogFunction('TransparencyLogFunction', {
      functionName: TLOG_FUNCTION_NAME,
      logGroupId: 'TransparencyLogLogs',
      handler: TLOG_HANDLER,
      description: 'Transparency log (ADR-0008): outbox->leaves, hourly signed checkpoint, publish id.atmark.ai/log. No anchors, no SES.',
      role: this.role,
      reserved: TLOG_RESERVED_CONCURRENCY,
      environment: {
        ATMARK_DB_TLOG_SECRET_ARN: ssmParameterNameOf(TLOG_DB_SECRET_NAME),
        ATMARK_TLOG_SIGNING_KEY_ARN: this.checkpointKey.keyArn,
        ATMARK_TLOG_ORIGIN: transparencyLogOrigin(this.node),
      },
    });
    this.anchorFunction = tlogFunction('TransparencyAnchorFunction', {
      functionName: TLOG_ANCHOR_FUNCTION_NAME,
      logGroupId: 'TransparencyAnchorLogs',
      handler: TLOG_ANCHOR_HANDLER,
      description: 'Transparency log anchors (ADR-0008 Phase B): daily OTS + Rekor v2 anchors of checkpoints, proof upgrades. No checkpoint key, no SES.',
      role: this.anchorRole,
      reserved: TLOG_ANCHOR_RESERVED_CONCURRENCY,
      environment: {
        ATMARK_DB_TLOG_ANCHOR_SECRET_ARN: ssmParameterNameOf(TLOG_ANCHOR_DB_SECRET_NAME),
        ATMARK_TLOG_ANCHOR_KEY_ARN: this.anchorKey.keyArn,
        ATMARK_TLOG_OTS_CALENDARS: TLOG_OTS_CALENDARS.join(','),
        ATMARK_TLOG_REKOR_URL: rekorUrl,
        ATMARK_TLOG_REKOR_VKEY: rekorVkey,
      },
    });

    for (const { task, minutes } of TLOG_SCHEDULES) {
      new scheduler.Schedule(this, `TransparencyLog${task === 'log' ? 'Log' : 'Anchor'}Schedule`, {
        scheduleName: `atmark-transparency-${task}`,
        description: `transparency-${task} every ${String(minutes)} min`,
        schedule: scheduler.ScheduleExpression.rate(cdk.Duration.minutes(minutes)),
        // 과제마다 자기 함수 — 핸들러는 입력의 task 가 자기 과제가 아니면 던진다(배선 오타가 조용히 다른 일을 하지 않게).
        target: new schedulerTargets.LambdaInvoke(task === 'log' ? this.function : this.anchorFunction, {
          input: scheduler.ScheduleTargetInput.fromObject({ task }),
          retryAttempts: 0,
          maxEventAge: cdk.Duration.minutes(5),
        }),
      });
    }

    // 알람 — 틱이 연속으로 실패하면(에폭 지연 · 완결성 불일치 · 서명 실패가 모두 예외로 드러난다) 사건이다(ADR-0008 §2.3 "공개 약속 위반").
    new cloudwatch.Alarm(this, 'TransparencyLogErrors', {
      alarmName: 'atmark-transparency-log-errors',
      alarmDescription: 'atmark-transparency-log 이 15분 동안 매 5분 실패했다 — 에폭 지연 또는 완결성 불일치. docs/runbooks/transparency-log.md §7',
      metric: this.function.metricErrors({ period: cdk.Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    // 앵커 틱은 행마다 실패를 DB 에 적고(백오프·failed) 던지지 않는다 — 던지는 것은 조립·DB·권한 오류다. 세 시간 연속이면 배선이 깨졌다.
    new cloudwatch.Alarm(this, 'TransparencyAnchorErrors', {
      alarmName: 'atmark-transparency-anchor-errors',
      alarmDescription: 'atmark-transparency-anchor 가 3시간 동안 매시 실패했다 — 조립·DB·IAM 오류. docs/runbooks/transparency-log.md §7',
      metric: this.anchorFunction.metricErrors({ period: cdk.Duration.hours(1) }),
      threshold: 1,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    refuseStubDeployment(this, props.lambdaCode, { warn: false });

    new cdk.CfnOutput(this, 'TransparencyLogBucketName', { value: this.bucket.bucketName, description: 'id.atmark.ai/log/* 오리진(Object Lock COMPLIANCE 1년)' });
    new cdk.CfnOutput(this, 'CheckpointKeyArn', {
      value: this.checkpointKey.keyArn,
      description: '체크포인트 서명 키(Ed25519, 비추출). 공개키 확인: aws kms get-public-key --key-id <이 값> (런북 §3 — vkey 고정)',
    });
    new cdk.CfnOutput(this, 'AnchorKeyArn', { value: this.anchorKey.keyArn, description: 'Rekor 앵커 서명 키(P-256, 비추출)' });
    new cdk.CfnOutput(this, 'TransparencyLogFunctionName', {
      value: this.function.functionName,
      description: `aws lambda invoke --function-name <이 값> --payload '{"task":"log"}' — 첫 체크포인트(런북 §3)`,
    });
    new cdk.CfnOutput(this, 'TransparencyAnchorFunctionName', {
      value: this.anchorFunction.functionName,
      description: `aws lambda invoke --function-name <이 값> --payload '{"task":"anchor"}' — 첫 앵커(런북 §5)`,
    });
  }
}
