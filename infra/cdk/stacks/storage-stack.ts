/**
 * AtmarkStorage — 메일 객체 저장소 (P2 마무리: 발신 본문 · P3: 수신 원문).
 *
 * 버킷 하나에 접두사 둘이다 — `src/storage/object-store.ts` 의 키 설계 표 참조:
 *   - `outbound/content/` : 발신 본문(`src/storage/s3-object-store.ts` 가 쓴다)
 *   - `inbound/raw/`      : 수신 원문(**SES receipt rule 의 S3 액션이 쓴다**, P3)
 *   - `inbound/parsed/`·`inbound/attachments/` : 수신 파생물(**수신 소비자가 쓴다**, P3a — SES 는 쓰지 않는다)
 *
 * ---
 *
 * **판단 기록**
 *
 * - **SSE-S3(AES256), KMS 아님.** SES receipt rule 의 S3 액션에 KMS 키를 주면 그것은 SSE-KMS
 *   가 아니라 **클라이언트측 암호화**다 — 읽는 쪽이 S3 암호화 클라이언트로 복호해야 한다.
 *   SSE-KMS 를 버킷 기본값으로 두는 길도 있지만 그러면 키 정책에 SES 서비스 주체를 넣어야 하고,
 *   그것은 confused deputy 표면을 버킷 정책 하나에서 둘로 늘린다. 저장 시 암호화라는 요구는
 *   SSE-S3 로 충족된다. 접근 감사(CloudTrail 의 KMS Decrypt 기록)가 필요해지면 그때 올린다 —
 *   런타임은 `S3ServerSideEncryption` 의 `sse-kms` 분기로 이미 준비돼 있다.
 * - **버전 관리 켬.** 런타임 쓰기는 `If-None-Match: *` 로 덮어쓰지 않지만, 삭제는 그 조건과
 *   무관하다. 원문과 승인 대기 본문은 잃으면 되돌릴 수 없는 것이고, 버전 관리가 삭제를 복구
 *   가능하게 만든다. 덮어쓰기가 없으므로 비현재 버전은 **삭제에서만** 생긴다 — 비용이 폭주할 경로가 없다.
 * - **`RemovalPolicy.RETAIN`.** 스택 삭제 한 번이 수신 원문 전체의 삭제가 되면 안 된다.
 *   `autoDeleteObjects` 도 켜지 않는다(켜면 RETAIN 이 무의미해지는 커스텀 리소스가 붙는다).
 * - **수명주기 규칙 — 메일 본문 1년 (US-008, 2026-09-24 결정, 진윤겸).** "메일 본문은 1년 보관 후
 *   자동 삭제, 감사·DB 기록은 그대로 남는다" — 이 결정이 `docs/adr/0006-login-mail-principal.md`
 *   "US-008 추가" 와 `src/site/privacy.ts` 보유 기간 문구의 근거다. **메일 본문 네 접두사**
 *   (`INBOUND_RAW_PREFIX` 수신 원문 · `INBOUND_PARSED_PREFIX` 수신 파싱 결과 · `INBOUND_ATTACHMENTS_PREFIX`
 *   수신 첨부 · `OUTBOUND_CONTENT_PREFIX` 발신 본문)에 **현재 버전 365일 뒤 만료**를 건다. 비현재
 *   버전(삭제로만 생긴다 — 위 버전 관리 항목)은 **7일 뒤 만료**(복구 창은 두되 무한정 쌓지 않는다).
 *   미완료 멀티파트 업로드는 **7일 뒤 중단**(버킷 전체 — 위생 규칙, 보존 결정과 무관). `outbound/scheduled/`
 *   (예약 발송 본문, P3c)는 이 결정의 범위 밖이다 — 발송되면 `outbound/content/` 로 옮겨 적히므로
 *   같은 규칙이 뒤늦게 적용된다. 발신 본문을 읽는 승인 릴리스(최대 TTL 7일, ADR-0006 "US-004 추가")는
 *   365일보다 훨씬 짧으므로 이 규칙과 충돌하지 않는다.
 * - **SES 쓰기 권한을 지금 넣는다.** SES 는 receipt rule 을 **만들 때** 버킷 쓰기 권한을 검사하고
 *   없으면 규칙 생성이 실패한다. P3 가 이 스택을 고치지 않고 규칙만 더하게 한다. 범위:
 *   `s3:PutObject` 하나, `inbound/raw/*` 하나, **`aws:SourceAccount` = 이 계정**(confused deputy —
 *   다른 계정의 SES 규칙이 우리 버킷을 표적으로 삼는 경로를 닫는다), `aws:SourceArn` = 이 계정·
 *   리전의 receipt rule. 역할(IAM)은 여기 없다 — 읽는 주체(수신 Lambda·발송 워커)가 생기는
 *   단계에서 그 스택이 `grantRead`/`grantPut` 으로 접두사 단위 최소 권한을 붙인다.
 */

import * as cdk from 'aws-cdk-lib';
import * as guardduty from 'aws-cdk-lib/aws-guardduty';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';

/**
 * 수신 원문 접두사. **`src/storage/object-store.ts` 의 `INBOUND_RAW_PREFIX` 와 같은 값이어야 한다** —
 * 갈라지면 SES 가 쓸 수 있는 범위와 런타임이 읽는 범위가 어긋나고, 그 어긋남은 첫 수신에서야
 * 드러난다. `test/unit/storage/storage-stack.test.ts` 가 일치를 단언한다.
 */
export const INBOUND_RAW_PREFIX = 'inbound/raw/';

/** 발신 본문 접두사. `src/storage/object-store.ts` 의 `OUTBOUND_CONTENT_PREFIX` 와 같은 값. */
export const OUTBOUND_CONTENT_PREFIX = 'outbound/content/';

/** support@ 문의 전달 문서 접두사. `src/contact/intake.ts` 의 `CONTACT_DOCUMENT_PREFIX` 와 같은 값(ADR-0009) — 메일 본문과 같이 1년. */
export const CONTACT_DOCUMENT_PREFIX = 'contact/forward/';

/**
 * 수신 파생물 접두사 둘 (P3a) — `src/storage/object-store.ts` 의 `INBOUND_PARSED_PREFIX`·
 * `INBOUND_ATTACHMENTS_PREFIX` 와 같은 값(테스트가 단언한다). **SES 는 여기 쓰지 않는다** — 버킷 정책의
 * SES 허용은 `inbound/raw/*` 하나로 남는다. 쓰는 주체는 수신 소비자이고, 그 컴퓨트 유닛이 생기는 단계에서
 * 그 스택이 이 두 접두사에 `grantPut`, `inbound/raw/*` 에 `grantRead` 를 붙인다(접두사 단위 최소 권한).
 * 보존은 원문과 같은 값(365일, US-008)을 쓴다 — 파생물이 원문보다 오래 남으면 "본문은 1년" 이라는
 * 이용자 안내가 거짓이 된다.
 */
export const INBOUND_PARSED_PREFIX = 'inbound/parsed/';
export const INBOUND_ATTACHMENTS_PREFIX = 'inbound/attachments/';

/**
 * 발신 첨부 접두사 둘(메일 기본기 2차 A2) — `src/storage/object-store.ts` 의 `OUTBOUND_UPLOADS_PREFIX`·`OUTBOUND_ATTACHMENTS_PREFIX` 와 같은 값.
 * 스테이징(에이전트가 서명된 PUT 으로 올린다 · GuardDuty 보호 범위)은 **2일** 뒤 만료, 영구본(발송된 메일의 첨부)은 발신 본문과 같이 **1년**.
 */
export const OUTBOUND_UPLOADS_PREFIX = 'outbound/uploads/';
export const OUTBOUND_ATTACHMENTS_PREFIX = 'outbound/attachments/';
/**
 * 초안 본문 접두사(묶음 B) — `src/storage/object-store.ts` 의 `OUTBOUND_DRAFTS_PREFIX` 와 같은 값. 메일 본문과 같이 **1년**(배포 전 보안 리뷰 2026-10-08 — 판마다 새
 * 객체라 버린 초안 · 옛 판이 끝없이 쌓였다). 1년 넘게 고치지 않은 초안의 본문은 사라진다(API 410 `draft_content_expired`).
 */
export const OUTBOUND_DRAFTS_PREFIX = 'outbound/drafts/';
/** 스테이징 수명(일) — `outbound_attachments.expires_at`(생성 + 2일) · 서명 URL 15분과 짝. */
export const OUTBOUND_UPLOADS_RETENTION_DAYS = 2;

/** GuardDuty Malware Protection for S3 의 서비스 주체 — 보호 계획이 이 역할을 맡아 스캔·태그를 한다. */
export const GUARDDUTY_MALWARE_PROTECTION_PRINCIPAL = 'malware-protection-plan.guardduty.amazonaws.com';

/** 메일 본문 보존 기간(일) — US-008, 진윤겸 결정(2026-09-24). 네 접두사 전부 같은 값. */
export const MAIL_BODY_RETENTION_DAYS = 365;

/** 비현재 버전(삭제로만 생긴다) 보존 — 복구 창은 두되 무한정 쌓지 않는다. */
const NONCURRENT_VERSION_RETENTION_DAYS = 7;

/** 미완료 멀티파트 업로드 중단 — 보존 결정과 무관한 위생 규칙. */
const ABORT_INCOMPLETE_MULTIPART_DAYS = 7;

/** 메일 본문 접두사 하나에 거는 만료 규칙 — 현재 버전 365일, 비현재 버전 7일. */
function mailBodyExpirationRule(id: string, prefix: string): s3.LifecycleRule {
  return {
    id,
    enabled: true,
    prefix,
    expiration: cdk.Duration.days(MAIL_BODY_RETENTION_DAYS),
    noncurrentVersionExpiration: cdk.Duration.days(NONCURRENT_VERSION_RETENTION_DAYS),
  };
}

export class StorageStack extends cdk.Stack {
  public readonly mailBucket: s3.Bucket;

  public constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    this.mailBucket = new s3.Bucket(this, 'MailStoreBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      // ACL 비활성 — SES 가 쓴 객체도 버킷 소유 계정이 소유한다.
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      // 평문 HTTP 요청을 거부하는 Deny 문을 버킷 정책에 넣는다.
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      // 수명주기 — 메일 본문 넷(수신 원문·파싱 결과·첨부, 발신 본문) 365일 만료 (US-008). 머리말 참조.
      // `outbound/scheduled/` 는 이 결정의 범위 밖 — 발송되면 `outbound/content/` 로 옮겨 적힌다.
      lifecycleRules: [
        {
          id: 'AbortIncompleteMultipartUploads',
          enabled: true,
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(ABORT_INCOMPLETE_MULTIPART_DAYS),
        },
        mailBodyExpirationRule('ExpireInboundRaw', INBOUND_RAW_PREFIX),
        mailBodyExpirationRule('ExpireInboundParsed', INBOUND_PARSED_PREFIX),
        mailBodyExpirationRule('ExpireInboundAttachments', INBOUND_ATTACHMENTS_PREFIX),
        mailBodyExpirationRule('ExpireOutboundContent', OUTBOUND_CONTENT_PREFIX),
        mailBodyExpirationRule('ExpireContactDocuments', CONTACT_DOCUMENT_PREFIX),
        // 메일 기본기 2차 A2 — 발신 첨부 영구본은 발신 본문과 같이 1년, 스테이징은 2일(스캔 전·미사용 업로드가 쌓이지 않게).
        mailBodyExpirationRule('ExpireOutboundAttachments', OUTBOUND_ATTACHMENTS_PREFIX),
        // 묶음 B 초안 본문 — 1년(배포 전 보안 리뷰). AtmarkStorage 는 손 배포다(런북 deploy §46 · §47).
        mailBodyExpirationRule('ExpireOutboundDrafts', OUTBOUND_DRAFTS_PREFIX),
        {
          id: 'ExpireOutboundUploads',
          enabled: true,
          prefix: OUTBOUND_UPLOADS_PREFIX,
          expiration: cdk.Duration.days(OUTBOUND_UPLOADS_RETENTION_DAYS),
          noncurrentVersionExpiration: cdk.Duration.days(1),
        },
      ],
    });

    // ── GuardDuty Malware Protection for S3 — 발신 첨부 스테이징만(메일 기본기 2차 A2, 계획 §4 A2) ────────────────
    // 새 객체(PutObject)마다 GuardDuty 가 스캔하고 객체 태그 `GuardDutyMalwareScanStatus` 를 붙인다. 발송 준비는 `NO_THREATS_FOUND` 만
    // 통과시킨다(`src/api/outbound-attachments.ts`). 보호 범위 = `outbound/uploads/` 하나 — 받은 메일·본문은 스캔하지 않는다(비용·범위).
    // 비용(2025-02 인하 뒤): 스캔 데이터 GB 당 약 $0.09 + 평가 객체 1,000개당 요금, 월 1 GB·1,000건 무료 — 계획 추정 월 $3~8 이하.
    // 역할은 AWS 문서의 보호 계획 역할 그대로이되 **객체 권한은 스테이징 접두사로** 좁혔다(검증 객체 하나 · 버킷 알림 · EventBridge 관리 규칙).
    const malwareRole = new iam.Role(this, 'AttachmentMalwareProtectionRole', {
      roleName: 'atmark-guardduty-malware-protection',
      description: 'GuardDuty Malware Protection for S3 - scans outbound/uploads/ (agent attachment staging) and tags results.',
      assumedBy: new iam.ServicePrincipal(GUARDDUTY_MALWARE_PROTECTION_PRINCIPAL, {
        conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
      }),
    });
    const managedRuleArn = `arn:aws:events:${this.region}:${this.account}:rule/DO-NOT-DELETE-AmazonGuardDutyMalwareProtectionS3*`;
    malwareRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AllowManagedRuleToSendS3EventsToGuardDuty',
        actions: ['events:PutRule', 'events:DeleteRule', 'events:PutTargets', 'events:RemoveTargets'],
        resources: [managedRuleArn],
        conditions: { StringLike: { 'events:ManagedBy': GUARDDUTY_MALWARE_PROTECTION_PRINCIPAL } },
      }),
    );
    malwareRole.addToPolicy(
      new iam.PolicyStatement({ sid: 'AllowGuardDutyToMonitorEventBridgeManagedRule', actions: ['events:DescribeRule', 'events:ListTargetsByRule'], resources: [managedRuleArn] }),
    );
    malwareRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AllowPostScanTag',
        actions: ['s3:PutObjectTagging', 's3:GetObjectTagging', 's3:PutObjectVersionTagging', 's3:GetObjectVersionTagging'],
        resources: [this.mailBucket.arnForObjects(`${OUTBOUND_UPLOADS_PREFIX}*`)],
      }),
    );
    malwareRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AllowEnableS3EventBridgeEvents',
        actions: ['s3:PutBucketNotification', 's3:GetBucketNotification'],
        resources: [this.mailBucket.bucketArn],
      }),
    );
    malwareRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AllowPutValidationObject',
        actions: ['s3:PutObject'],
        resources: [this.mailBucket.arnForObjects('malware-protection-resource-validation-object')],
      }),
    );
    malwareRole.addToPolicy(new iam.PolicyStatement({ sid: 'AllowCheckBucketOwnership', actions: ['s3:ListBucket'], resources: [this.mailBucket.bucketArn] }));
    malwareRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AllowMalwareScan',
        actions: ['s3:GetObject', 's3:GetObjectVersion'],
        resources: [this.mailBucket.arnForObjects(`${OUTBOUND_UPLOADS_PREFIX}*`)],
      }),
    );
    const plan = new guardduty.CfnMalwareProtectionPlan(this, 'AttachmentMalwareProtectionPlan', {
      role: malwareRole.roleArn,
      protectedResource: { s3Bucket: { bucketName: this.mailBucket.bucketName, objectPrefixes: [OUTBOUND_UPLOADS_PREFIX] } },
      actions: { tagging: { status: 'ENABLED' } },
    });
    // 역할의 정책이 붙은 뒤에 계획을 만든다 — 계획 생성이 역할 권한(검증 객체 쓰기·버킷 알림)을 바로 쓴다.
    plan.node.addDependency(malwareRole);

    // 스캔 판정 태그는 **GuardDuty 역할만** 쓴다(보안 리뷰 L1) — 발송 역할(업로드 URL 을 서명한다)이 `x-amz-tagging` 으로 업로드와 함께
    // `NO_THREATS_FOUND` 를 붙이거나 나중에 고쳐 쓰지 못한다(PutObject 의 태그도 `s3:PutObjectTagging` 권한을 본다). 버킷 정책의 명시 Deny 라
    // 어떤 IAM 허용도 이기지 못한다.
    this.mailBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'DenyScanTagWritesOutsideGuardDuty',
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['s3:PutObjectTagging', 's3:PutObjectVersionTagging', 's3:DeleteObjectTagging', 's3:DeleteObjectVersionTagging'],
        resources: [this.mailBucket.arnForObjects(`${OUTBOUND_UPLOADS_PREFIX}*`)],
        conditions: { ArnNotEquals: { 'aws:PrincipalArn': malwareRole.roleArn } },
      }),
    );

    this.mailBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowSesReceiptRuleWriteInboundRaw',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('ses.amazonaws.com')],
        actions: ['s3:PutObject'],
        resources: [this.mailBucket.arnForObjects(`${INBOUND_RAW_PREFIX}*`)],
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          ArnLike: {
            'aws:SourceArn': `arn:aws:ses:${this.region}:${this.account}:receipt-rule-set/*:receipt-rule/*`,
          },
        },
      }),
    );

    new cdk.CfnOutput(this, 'MailStoreBucketName', {
      value: this.mailBucket.bucketName,
      description:
        'createS3ObjectStore({ bucket }) 에 넣을 값. P3 의 SES receipt rule S3 액션도 이 버킷에 ' +
        `ObjectKeyPrefix="${INBOUND_RAW_PREFIX}" 로 쓴다.`,
    });
  }
}
