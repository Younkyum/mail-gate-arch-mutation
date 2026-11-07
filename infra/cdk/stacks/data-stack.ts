/**
 * AtmarkData — RDS PostgreSQL 과 런타임 비밀의 **자리** (배포 준비 D2).
 *
 * ---
 *
 * **판단 기록**
 *
 * - **PostgreSQL 17** — 로컬 개발과 같은 메이저(`src/db/client.ts` 머리말). 마이너는 RDS 기본값에 맡기고
 *   `autoMinorVersionUpgrade` 를 켠다. db.t4g.micro · 20GB gp3 · 단일 AZ(PRD 스택).
 * - **퍼블릭 접근 불가.** 격리 서브넷(기본 경로 없음)에 두고 SG 는 Lambda SG 의 5432 만 받는다(`network-stack.ts`).
 * - **`rds.force_ssl=1`** — PG15+ RDS 기본값이 이미 1 이지만 기본값은 파라미터 그룹 교체 한 번에 바뀐다.
 *   명시하면 테스트가 단언할 수 있다. 클라이언트 쪽은 `PGSSLMODE=require` + `rejectUnauthorized: true`
 *   (`src/db/client.ts`) + Lambda 의 `NODE_EXTRA_CA_CERTS` 가 짝이다(`compute-stack.ts`).
 * - **백업 보존 14일.** GATE 가 14일이다 — 그 기간 어느 시점으로든 PITR 이 가능해야 "8일차에 무엇이 있었나" 를
 *   되살릴 수 있다. 백업 저장소는 할당 스토리지(20GB)만큼 무료이고 DB 는 그보다 훨씬 작다.
 * - **`deletionProtection` + `RemovalPolicy.SNAPSHOT`.** 스택 삭제는 먼저 삭제 보호에 막히고, 그걸 풀어도 스냅숏이 남는다.
 * - **저장 시 암호화는 `aws/rds` 관리형 키.** 고객 관리형 CMK 는 월 $1 과 키 정책 관리를 더하는데, 얻는 것(키 단위
 *   접근 감사)을 GATE 가 요구하지 않는다. 바꾸려면 인스턴스 교체가 필요하므로 **재개방 조건:** 외부 고객 데이터 수용 전.
 *
 * **비밀 — 누가 값을 소유하는가**
 *
 * | 비밀 | 만드는 것 | 값을 채우는 것 |
 * |---|---|---|
 * | `atmark/db/master` | 이 스택(`DatabaseSecret`, 생성값) | RDS — 마스터 자격증명. **migrate 핸들러만 읽는다** |
 * | `atmark/db/owner` | 이 스택(자리만) | migrate 핸들러 — 마스터로 소유자 롤을 만들고 그 자격증명을 쓴다 |
 * | `atmark/db/app` | 이 스택(자리만) | migrate 핸들러 — 앱 롤(`atmark_app`) 자격증명 |
 * | `atmark/db/admin` | 이 스택(자리만) | migrate 핸들러 — admin 롤(`atmark_admin`, ADR-0006) 자격증명. admin Lambda 만 읽는다 |
 * | `atmark/db/login-mailer` | 이 스택(자리만) | migrate 핸들러 — 로그인 메일 롤(`atmark_login_mailer`). login-mailer Lambda 만 읽는다 |
 * | `atmark/db/passport-signer` | 이 스택(자리만) | migrate 핸들러 — 서명 롤(`atmark_passport_signer`, 계약 §3). passport-signer Lambda 만 읽는다 |
 * | `atmark/approval-link-keys` | 이 스택(자리만) | 배포 런북 — 사람이 `put-secret-value` |
 * | `atmark/webhook-secret-keys` | 이 스택(자리만) | 배포 런북 — 사람이 `put-secret-value` |
 * | `atmark/owner-login-keys` | 이 스택(자리만) | 관리 런북(`docs/runbooks/admin.md`) — 사람이 `put-secret-value` |
 * | `atmark/db/ops` | 이 스택(자리만) | migrate 핸들러 — 운영자 콘솔 롤(`atmark_ops`, ADR-0015). ops Lambda 만 읽는다 |
 * | `atmark/ops-keys` | 이 스택(자리만) | 런북 `docs/runbooks/ops-console.md` — 사람이 `put-secret-value`. ops Lambda 만 읽는다 |
 * | `atmark/ops-login-keys` | 이 스택(자리만) | 같은 런북 — 사람이 `put-secret-value`. login-mailer Lambda 만 읽는다(운영자 코드 파생, 결정 C2) |
 *
 * "자리만" 의 뜻: 리소스는 CloudFormation 이 만들지만 **값은 고정 플레이스홀더**다. 스택이 값을 소유하면
 * (`generateSecretString`) 템플릿이 바뀌는 날 CloudFormation 이 값을 다시 만든다 — 그것은 곧 회전이고,
 * 웹훅 키링이 회전되면 저장된 웹훅 시크릿 전부가 복호 불가능해진다(PP-A 가 에이전트 개인키 시크릿을 스택에 두지
 * 않은 것과 같은 이유). 플레이스홀더 문자열이 바뀌지 않는 한 CloudFormation 은 이 리소스를 건드리지 않는다 —
 * `test/unit/infra/data-stack.test.ts` 가 그 문자열을 고정한다. 런타임은 플레이스홀더를 **거부해야 한다**(fail closed).
 * 모두 RETAIN — 스택 삭제가 키 삭제가 되면 안 된다.
 */

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';

import { OPS_SECRET_NAMES } from '../../../src/ops/contract';
import { POSTGRES_PORT } from './network-stack';

export const DB_MASTER_SECRET_NAME = 'atmark/db/master';
export const DB_OWNER_SECRET_NAME = 'atmark/db/owner';
export const DB_APP_SECRET_NAME = 'atmark/db/app';
/** admin Lambda 의 DB 롤(`atmark_admin`) — 소유자 롤 대신(ADR-0006). */
export const DB_ADMIN_SECRET_NAME = 'atmark/db/admin';
/** 로그인 메일 Lambda 의 DB 롤(`atmark_login_mailer`) — ADR-0006. */
export const DB_LOGIN_MAILER_SECRET_NAME = 'atmark/db/login-mailer';
/** passport 서명 Lambda 의 DB 롤(`atmark_passport_signer`) — 계약 §3(PP-B). */
export const DB_PASSPORT_SIGNER_SECRET_NAME = 'atmark/db/passport-signer';
export const APPROVAL_LINK_KEYS_SECRET_NAME = 'atmark/approval-link-keys';
export const WEBHOOK_SECRET_KEYS_SECRET_NAME = 'atmark/webhook-secret-keys';
/**
 * 소유자 로그인 링크 HMAC 키링(관리 백엔드). **승인 링크 키와 분리한다** — 승인 키를 읽는 쪽(api Lambda)이 로그인 토큰을
 * 만들 수 없게. 읽는 역할: admin(검증) · login-mailer(로그인 메일 토큰 발급). 발송 역할은 읽지 못한다(ADR-0006).
 */
export const OWNER_LOGIN_KEYS_SECRET_NAME = 'atmark/owner-login-keys';
/**
 * `support@atmark.ai` 문의의 전달 주소(운영자 메일함, US-009 · ADR-0009). **주소는 코드·템플릿 어디에도 없다** — 이 자리는 자리값으로
 * 태어나고 배포 때 운영자가 `put-secret-value --secret-string '{"to":"…"}'` 로 채운다. 읽는 것은 contact-forwarder Lambda 하나
 * (IAM `lambda:SourceFunctionArn` 조건 — `compute-stack.ts`). 자리값인 동안 전달은 **보내지 않는다**(`src/contact/destination.ts`).
 */
export const CONTACT_FORWARD_TO_SECRET_NAME = 'atmark/contact-forward-to';

export const DB_NAME = 'atmark';
export const DB_MASTER_USERNAME = 'atmark_master';
export const DB_BACKUP_RETENTION_DAYS = 14;

/**
 * 자리만 만든 비밀의 초기값. **이 문자열을 바꾸면 배포가 실제 값을 이것으로 덮어쓴다.** 테스트가 고정한다.
 * 런타임은 `_unset` 키를 보면 거부해야 한다.
 */
export const SECRET_PLACEHOLDER_VALUE = JSON.stringify({
  _unset: 'placeholder - filled by migrate handler or deploy runbook (docs/runbooks/deploy.md)',
});

export interface DataStackProps extends cdk.StackProps {
  readonly vpc: ec2.IVpc;
  readonly databaseSecurityGroup: ec2.ISecurityGroup;
}

export class DataStack extends cdk.Stack {
  public readonly database: rds.DatabaseInstance;
  public readonly masterSecret: secretsmanager.ISecret;
  public readonly ownerSecret: secretsmanager.ISecret;
  public readonly appSecret: secretsmanager.ISecret;
  public readonly adminSecret: secretsmanager.ISecret;
  public readonly loginMailerSecret: secretsmanager.ISecret;
  public readonly passportSignerSecret: secretsmanager.ISecret;
  public readonly approvalLinkKeysSecret: secretsmanager.ISecret;
  public readonly webhookSecretKeysSecret: secretsmanager.ISecret;
  public readonly ownerLoginKeysSecret: secretsmanager.ISecret;
  public readonly contactForwardToSecret: secretsmanager.ISecret;
  /** 운영자 콘솔(ADR-0015) — 자리 셋. 이름은 계약(`OPS_SECRET_NAMES`)에서. */
  public readonly opsDbSecret: secretsmanager.ISecret;
  public readonly opsKeysSecret: secretsmanager.ISecret;
  public readonly opsLoginKeysSecret: secretsmanager.ISecret;

  public constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    const engine = rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_17 });

    const parameterGroup = new rds.ParameterGroup(this, 'PostgresParameters', {
      engine,
      description: 'Atmark Postgres 17 - TLS required',
      parameters: { 'rds.force_ssl': '1' },
    });

    // 마스터 비밀을 직접 만든다 — `fromGeneratedSecret` 은 비밀을 스택 기본(DESTROY)으로 두고, 인스턴스의 `secret` 은
    // 비밀이 아니라 **첨부(SecretTargetAttachment)** 라서 거기 건 RETAIN 은 비밀에 닿지 않는다.
    const masterSecret = new rds.DatabaseSecret(this, 'MasterSecret', {
      username: DB_MASTER_USERNAME,
      secretName: DB_MASTER_SECRET_NAME,
    });
    // 스냅숏에서 복원할 때 마스터 자격증명이 있어야 한다. 인스턴스 삭제가 비밀 삭제가 되면 안 된다.
    masterSecret.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    this.database = new rds.DatabaseInstance(this, 'Postgres', {
      engine,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE4_GRAVITON, ec2.InstanceSize.MICRO),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [props.databaseSecurityGroup],
      publiclyAccessible: false,
      multiAz: false,
      port: POSTGRES_PORT,
      databaseName: DB_NAME,
      credentials: rds.Credentials.fromSecret(masterSecret as secretsmanager.ISecret),
      allocatedStorage: 20,
      // 자동 확장 없음 — 20GB 를 넘는 날은 "무엇이 그만큼 쌓였나" 를 먼저 봐야 한다(본문은 S3 에 있다).
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      parameterGroup,
      caCertificate: rds.CaCertificate.RDS_CA_RSA2048_G1,
      backupRetention: cdk.Duration.days(DB_BACKUP_RETENTION_DAYS),
      // 03:00–03:30 KST 백업, 일요일 04:00–04:30 KST 유지보수.
      preferredBackupWindow: '18:00-18:30',
      preferredMaintenanceWindow: 'Sat:19:00-Sat:19:30',
      autoMinorVersionUpgrade: true,
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
      // IAM DB 인증은 쓰지 않는다 — 롤 두 개(소유자·앱)의 분리가 §4.3 의 본체이고, 그 분리는 Postgres 롤로 한다.
      iamAuthentication: false,
    });

    // 첨부를 통해 참조한다 — 첨부가 host·port·dbname 을 비밀에 써 넣으므로, 이걸 참조하는 쪽(migrate)은
    // 그 값이 채워진 뒤에 만들어진다.
    const master = this.database.secret;
    if (master === undefined) throw new Error('RDS 가 마스터 비밀을 첨부하지 않았다');
    this.masterSecret = master;

    // `ISecret` 로 노출 — `exactOptionalPropertyTypes` 에서 `Secret`(클래스)는 `ISecret` 에 대입되지 않는다(network-stack 의 vpc 와 같은 사정).
    const placeholder = (constructId: string, secretName: string, description: string): secretsmanager.ISecret =>
      new secretsmanager.Secret(this, constructId, {
        secretName,
        description,
        secretStringValue: cdk.SecretValue.unsafePlainText(SECRET_PLACEHOLDER_VALUE),
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      }) as secretsmanager.ISecret;

    this.ownerSecret = placeholder(
      'DbOwnerSecret',
      DB_OWNER_SECRET_NAME,
      // ★ 배포된 문구 그대로 둔다(HEAD 869b837) — 자리 비밀의 속성이 바뀌면 CloudFormation 이 그 리소스를 갱신한다. ADR-0006 로
      //   이 문장이 다시 참이 됐다: admin 은 `atmark/db/admin` 을 읽는다.
      'Postgres owner role credentials (DDL/GRANT). Written by the migrate handler; read by migrate only.',
    );
    this.appSecret = placeholder(
      'DbAppSecret',
      DB_APP_SECRET_NAME,
      'Postgres app role (atmark_app) credentials. Written by the migrate handler; read by runtime Lambdas.',
    );
    this.adminSecret = placeholder(
      'DbAdminSecret',
      DB_ADMIN_SECRET_NAME,
      'Postgres admin role (atmark_admin, owns nothing, column-level grants) credentials. Written by the migrate handler; read by the admin Lambda only.',
    );
    this.loginMailerSecret = placeholder(
      'DbLoginMailerSecret',
      DB_LOGIN_MAILER_SECRET_NAME,
      'Postgres login-mailer role (atmark_login_mailer) credentials. Written by the migrate handler; read by the login-mailer Lambda only.',
    );
    this.passportSignerSecret = placeholder(
      'DbPassportSignerSecret',
      DB_PASSPORT_SIGNER_SECRET_NAME,
      'Postgres passport signer role (atmark_passport_signer, owns nothing, column-level grants) credentials. Written by the migrate handler; read by the passport-signer Lambda only.',
    );
    this.approvalLinkKeysSecret = placeholder(
      'ApprovalLinkKeysSecret',
      APPROVAL_LINK_KEYS_SECRET_NAME,
      'HMAC keyring for owner approval magic links (ATMARK_APPROVAL_LINK_KEYS). Filled by the deploy runbook.',
    );
    this.webhookSecretKeysSecret = placeholder(
      'WebhookSecretKeysSecret',
      WEBHOOK_SECRET_KEYS_SECRET_NAME,
      'Keyring encrypting stored webhook secrets (ATMARK_WEBHOOK_SECRET_KEYS). Filled by the deploy runbook. Never regenerate.',
    );
    this.ownerLoginKeysSecret = placeholder(
      'OwnerLoginKeysSecret',
      OWNER_LOGIN_KEYS_SECRET_NAME,
      'HMAC keyring for owner admin login links (ATMARK_OWNER_LOGIN_KEYS). Separate from approval link keys. Filled by the admin runbook.',
    );
    this.contactForwardToSecret = placeholder(
      'ContactForwardToSecret',
      CONTACT_FORWARD_TO_SECRET_NAME,
      'Operator mailbox for support@atmark.ai forwarding ({"to": "..."}). Read only by the contact-forwarder Lambda. Filled at deploy (ADR-0009).',
    );

    // 운영자 콘솔(ADR-0015 · 롤아웃 §5 1단계) — 자리만. 아무도 읽지 않는 동안 배포된다(Compute 가 뒤에 참조한다).
    this.opsDbSecret = placeholder(
      'DbOpsSecret',
      OPS_SECRET_NAMES.db,
      'Postgres operator console role (atmark_ops, owns nothing, no domain writes, CONNECTION LIMIT 3) credentials. Written by the migrate handler; read by the ops Lambda only.',
    );
    this.opsKeysSecret = placeholder(
      'OpsKeysSecret',
      OPS_SECRET_NAMES.opsKeys,
      'Operator console keyring (session / CSRF / client key derivation). Read by the ops Lambda only. Filled by docs/runbooks/ops-console.md.',
    );
    this.opsLoginKeysSecret = placeholder(
      'OpsLoginKeysSecret',
      OPS_SECRET_NAMES.loginKeys,
      'Operator login code keyring (6-digit code derivation). Read by the login-mailer Lambda only, never by the ops Lambda. Filled by docs/runbooks/ops-console.md.',
    );

    // 2026-10-12 비밀 → SSM 이전 — AtmarkCompute 가 이 다섯을 더는 참조하지 않는다(읽기는 SSM `/atmark/…`). 자동 교차 스택 export 가 템플릿에서
    //   사라지면 다음 AtmarkData 손 배포가 export 를 지우므로, 옛 비밀을 지우는 다음 PR 까지 **같은 이름의 export 를 그대로 고정**한다(되돌리기 가능하게).
    for (const secret of [this.approvalLinkKeysSecret, this.ownerLoginKeysSecret, this.contactForwardToSecret, this.opsKeysSecret, this.opsLoginKeysSecret]) {
      this.exportValue(secret.secretArn);
    }

    new cdk.CfnOutput(this, 'DbEndpointAddress', {
      value: this.database.dbInstanceEndpointAddress,
      description: 'RDS 엔드포인트(프라이빗). VPC 밖에서는 닿지 않는다.',
    });
    new cdk.CfnOutput(this, 'DbEndpointPort', { value: this.database.dbInstanceEndpointPort });
    new cdk.CfnOutput(this, 'DbMasterSecretArn', { value: master.secretArn, description: DB_MASTER_SECRET_NAME });
    new cdk.CfnOutput(this, 'DbOwnerSecretArn', { value: this.ownerSecret.secretArn, description: DB_OWNER_SECRET_NAME });
    new cdk.CfnOutput(this, 'DbAppSecretArn', { value: this.appSecret.secretArn, description: DB_APP_SECRET_NAME });
    new cdk.CfnOutput(this, 'DbAdminSecretArn', { value: this.adminSecret.secretArn, description: DB_ADMIN_SECRET_NAME });
    new cdk.CfnOutput(this, 'DbLoginMailerSecretArn', {
      value: this.loginMailerSecret.secretArn,
      description: DB_LOGIN_MAILER_SECRET_NAME,
    });
    new cdk.CfnOutput(this, 'DbPassportSignerSecretArn', {
      value: this.passportSignerSecret.secretArn,
      description: DB_PASSPORT_SIGNER_SECRET_NAME,
    });
    new cdk.CfnOutput(this, 'ApprovalLinkKeysSecretArn', {
      value: this.approvalLinkKeysSecret.secretArn,
      description: `${APPROVAL_LINK_KEYS_SECRET_NAME} — 런북이 put-secret-value 로 채운다`,
    });
    new cdk.CfnOutput(this, 'WebhookSecretKeysSecretArn', {
      value: this.webhookSecretKeysSecret.secretArn,
      description: `${WEBHOOK_SECRET_KEYS_SECRET_NAME} — 런북이 put-secret-value 로 채운다. 재생성 금지`,
    });
    new cdk.CfnOutput(this, 'OwnerLoginKeysSecretArn', {
      value: this.ownerLoginKeysSecret.secretArn,
      description: `${OWNER_LOGIN_KEYS_SECRET_NAME} — 런북(docs/runbooks/admin.md)이 put-secret-value 로 채운다`,
    });
    new cdk.CfnOutput(this, 'DbOpsSecretArn', { value: this.opsDbSecret.secretArn, description: OPS_SECRET_NAMES.db });
    new cdk.CfnOutput(this, 'OpsKeysSecretArn', {
      value: this.opsKeysSecret.secretArn,
      description: `${OPS_SECRET_NAMES.opsKeys} — 런북(docs/runbooks/ops-console.md)이 put-secret-value 로 채운다. ops Lambda 만 읽는다`,
    });
    new cdk.CfnOutput(this, 'OpsLoginKeysSecretArn', {
      value: this.opsLoginKeysSecret.secretArn,
      description: `${OPS_SECRET_NAMES.loginKeys} — 런북(docs/runbooks/ops-console.md)이 put-secret-value 로 채운다. login-mailer 만 읽는다`,
    });
    new cdk.CfnOutput(this, 'ContactForwardToSecretArn', {
      value: this.contactForwardToSecret.secretArn,
      description: `${CONTACT_FORWARD_TO_SECRET_NAME} — 배포 때 put-secret-value 로 채운다(docs/runbooks/deploy.md 문의 전달). 값은 문서에 적지 않는다`,
    });
  }
}
