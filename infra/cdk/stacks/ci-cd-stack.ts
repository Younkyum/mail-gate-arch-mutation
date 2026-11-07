/**
 * AtmarkCiCd — GitHub Actions 가 장기 키 없이(OIDC) 배포하기 위한 IAM(2026-10-01). 런북: `docs/runbooks/ci-cd.md`.
 *
 * **만드는 것은 셋뿐이다.** GitHub OIDC 공급자(`token.actions.githubusercontent.com`, 계정에 아직 없었다 — 2026-10-01
 * `aws iam list-open-id-connect-providers` 가 빈 목록) · 역할 둘.
 *
 *   - `atmark-gha-deploy-web` — 신뢰는 `sub = repo:Younkyum@83539914/Atmark@1379438442:ref:refs/heads/main`(변경 불가 subject — 아래 GITHUB_SUBJECT_PREFIX) **정확히**(StringEquals · 와일드카드 없음) + `aud = sts.amazonaws.com`.
 *     `.github/workflows/deploy-web.yml` 이 AtmarkSite · AtmarkSiteCdn · AtmarkDocs 를 `--exclusively` 로 배포할 때 쓴다.
 *   - `atmark-gha-deploy-compute` — 신뢰는 `sub = repo:Younkyum@83539914/Atmark@1379438442:environment:production` **정확히** + 같은 `aud`. GitHub 환경
 *     `production` 은 필수 검토자(Younkyum)를 건다 — 승인 전에는 job 이 시작하지 않으므로 토큰도 발급되지 않는다.
 *     `.github/workflows/deploy-compute.yml` 이 AtmarkCompute 배포 · `atmark-migrate` 호출 · 웹훅 디스패처 스케줄 멈춤/재개 · 스모크 로그 조회에 쓴다.
 *
 * **두 역할 모두 CDK 부트스트랩 역할(`cdk-hnb659fds-*`)을 assume 한다 — 그 너머는 IAM 으로 스택 단위로 좁혀지지 않는다.**
 * 부트스트랩 deploy 역할은 아무 스택이나 바꿀 수 있고 cfn-exec 역할(AdministratorAccess)을 넘긴다. 그래서 "web 역할은 세 스택만" 은
 * **워크플로가 지키는 약속**이고 IAM 경계가 아니다 — 경계는 신뢰 조건(누가 이 역할을 받을 수 있나)이다. `docs/ops/ses-principals-allowlist.json`
 * `deploymentRoles._why` 와 같은 판단: 배포 권한을 가진 주체는 어차피 자신에게 무엇이든 줄 수 있으므로, assume 할 수 있는 주체를 좁게 유지한다.
 * 더 좁히려면 부트스트랩 역할 대신 스택 ARN 으로 묶은 CloudFormation 권한을 직접 주는 길이 있다(런북 ci-cd §8).
 *
 * **이 스택은 CD 가 배포하지 않는다**(역할이 자기 자신의 신뢰를 고칠 수 있게 되므로). 리드가 손으로 `--exclusively` 배포한다.
 */

import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import { denySesSendingInStack } from './ses-send-deny';

export const GITHUB_OIDC_HOST = 'token.actions.githubusercontent.com';
export const GITHUB_OIDC_AUDIENCE = 'sts.amazonaws.com';
/**
 * 이 리포는 GitHub 의 **변경 불가 subject**(`use_immutable_subject: true`)로 토큰을 낸다 — `sub` 앞부분이 이름이 아니라
 * `소유자@소유자ID/리포@리포ID` 다(`gh api repos/Younkyum/Atmark/actions/oidc/customization/sub` 의 `sub_claim_prefix`).
 * 이름 형식(`repo:Younkyum/Atmark:…`)으로 신뢰를 걸었던 첫 배포가 `Not authorized to perform sts:AssumeRoleWithWebIdentity`
 * 로 거절됐다(2026-10-01, deploy-web 36837117524). ID 를 묶으면 리포 이름이 바뀌거나 지워진 뒤 같은 이름을 남이 만들어도 신뢰가 넘어가지 않는다.
 * 리포를 다른 계정·조직으로 옮기면 소유자 ID 가 바뀌므로 이 값을 고치고 AtmarkCiCd 를 다시 배포한다(런북 ci-cd §1).
 */
export const GITHUB_SUBJECT_PREFIX = 'repo:Younkyum@83539914/Atmark@1379438442';

export const DEPLOY_WEB_ROLE_NAME = 'atmark-gha-deploy-web';
export const DEPLOY_COMPUTE_ROLE_NAME = 'atmark-gha-deploy-compute';

/** web 역할의 `sub` — main 브랜치의 push·workflow_run·workflow_dispatch(환경을 쓰지 않는 job). */
export const DEPLOY_WEB_SUBJECT = `${GITHUB_SUBJECT_PREFIX}:ref:refs/heads/main`;
/** compute 역할의 `sub` — GitHub 환경 `production` 을 쓰는 job 만(환경을 쓰면 `sub` 가 ref 대신 환경 이름이 된다). */
export const DEPLOY_COMPUTE_SUBJECT = `${GITHUB_SUBJECT_PREFIX}:environment:production`;

/** `cdk.json` 기본 부트스트랩 qualifier(2026-09-22 부트스트랩, 버전 32 — `infra/cdk/app.ts`). */
export const CDK_BOOTSTRAP_QUALIFIER = 'hnb659fds';
export const CDK_BOOTSTRAP_REGIONS = ['ap-northeast-2', 'us-east-1'] as const;

export const MIGRATE_FUNCTION_NAME = 'atmark-migrate';
export const WEBHOOK_DISPATCHER_SCHEDULE_NAME = 'atmark-webhook-dispatcher';
/** web 역할이 배포하는 스택(`.github/workflows/deploy-web.yml` 의 STACKS 와 같다). */
export const WEB_STACKS = ['AtmarkSite', 'AtmarkSiteCdn', 'AtmarkDocs'] as const;
/** compute 역할이 배포하는 스택. */
export const COMPUTE_STACKS = ['AtmarkCompute'] as const;

/** 스모크가 에러 로그를 세는 함수(deploy §5 스모크와 같은 넷). */
export const SMOKE_LOG_FUNCTIONS = ['atmark-api', 'atmark-admin', 'atmark-inbound', 'atmark-login-mailer'] as const;

export interface CiCdStackProps extends cdk.StackProps {
  readonly env: { readonly account: string; readonly region: string };
}

function bootstrapRoleArns(account: string, kinds: readonly string[]): string[] {
  return CDK_BOOTSTRAP_REGIONS.flatMap((region) =>
    kinds.map((kind) => `arn:aws:iam::${account}:role/cdk-${CDK_BOOTSTRAP_QUALIFIER}-${kind}-role-${account}-${region}`),
  );
}

/**
 * 배포 뒤 스택 상태 확인(읽기만, 자기 스택만). `cdk deploy` 는 실패해도 exit 0 을 낸 적이 있다(infra/cdk/README.md "겪은 것" 2) —
 * 워크플로는 종료 코드가 아니라 `describe-stacks` 의 상태로 판정한다(deploy §0-1 `stack_ok`).
 */
function stackStatusRead(account: string, region: string, stacks: readonly string[]): iam.PolicyStatement {
  return new iam.PolicyStatement({
    sid: 'StackStatusRead',
    actions: ['cloudformation:DescribeStacks', 'cloudformation:DescribeStackEvents'],
    resources: stacks.map((stack) => `arn:aws:cloudformation:${region}:${account}:stack/${stack}/*`),
  });
}

export class CiCdStack extends cdk.Stack {
  public readonly webRole: iam.Role;
  public readonly computeRole: iam.Role;

  constructor(scope: Construct, id: string, props: CiCdStackProps) {
    super(scope, id, props);
    // 발송하지 않는 역할 전부에 SES 발송 명시 Deny(ADR-0014 단계 2 · 재검증 INFO — `ses-send-deny.ts`, 비용 0).
    denySesSendingInStack(this);
    const { account, region } = props.env;

    const provider = new iam.OidcProviderNative(this, 'GitHubOidcProvider', {
      url: `https://${GITHUB_OIDC_HOST}`,
      clientIds: [GITHUB_OIDC_AUDIENCE],
    });

    const trust = (subject: string): iam.WebIdentityPrincipal =>
      new iam.WebIdentityPrincipal(provider.oidcProviderArn, {
        StringEquals: {
          [`${GITHUB_OIDC_HOST}:aud`]: GITHUB_OIDC_AUDIENCE,
          [`${GITHUB_OIDC_HOST}:sub`]: subject,
        },
      });

    // web: 부트스트랩 deploy · file-publishing · lookup 역할만(두 리전). 컨테이너 자산이 없으므로 image-publishing 은 주지 않는다.
    const bootstrapAssume = new iam.PolicyStatement({
      sid: 'AssumeCdkBootstrapRoles',
      actions: ['sts:AssumeRole', 'sts:TagSession'],
      resources: bootstrapRoleArns(account, ['deploy', 'file-publishing', 'lookup']),
    });

    this.webRole = new iam.Role(this, 'DeployWebRole', {
      roleName: DEPLOY_WEB_ROLE_NAME,
      description: 'GitHub Actions deploy-web.yml (main only): cdk deploy AtmarkSite AtmarkSiteCdn AtmarkDocs via CDK bootstrap roles',
      assumedBy: trust(DEPLOY_WEB_SUBJECT),
      maxSessionDuration: cdk.Duration.hours(1),
    });
    this.webRole.addToPolicy(bootstrapAssume);
    this.webRole.addToPolicy(stackStatusRead(account, region, WEB_STACKS));

    this.computeRole = new iam.Role(this, 'DeployComputeRole', {
      roleName: DEPLOY_COMPUTE_ROLE_NAME,
      description: 'GitHub Actions deploy-compute.yml (environment production, reviewer required): AtmarkCompute + atmark-migrate',
      assumedBy: trust(DEPLOY_COMPUTE_SUBJECT),
      maxSessionDuration: cdk.Duration.hours(1),
    });
    this.computeRole.addToPolicy(bootstrapAssume);
    this.computeRole.addToPolicy(stackStatusRead(account, region, COMPUTE_STACKS));
    this.computeRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'InvokeMigrate',
        actions: ['lambda:InvokeFunction'],
        resources: [`arn:aws:lambda:${region}:${account}:function:${MIGRATE_FUNCTION_NAME}`],
      }),
    );
    this.computeRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PauseResumeWebhookDispatcher',
        actions: ['scheduler:GetSchedule', 'scheduler:UpdateSchedule'],
        resources: [`arn:aws:scheduler:${region}:${account}:schedule/default/${WEBHOOK_DISPATCHER_SCHEDULE_NAME}`],
      }),
    );
    // update-schedule 은 전체 치환이라 대상 역할(AtmarkCompute 가 만든 스케줄러 역할)을 다시 넘긴다 — 그 역할 이름 접두사로만, Scheduler 에게만.
    this.computeRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PassSchedulerTargetRole',
        actions: ['iam:PassRole'],
        resources: [`arn:aws:iam::${account}:role/AtmarkCompute-SchedulerRoleForTarget*`],
        conditions: { StringEquals: { 'iam:PassedToService': 'scheduler.amazonaws.com' } },
      }),
    );
    this.computeRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SmokeLogsRead',
        actions: ['logs:FilterLogEvents'],
        resources: SMOKE_LOG_FUNCTIONS.flatMap((name) => [
          `arn:aws:logs:${region}:${account}:log-group:/aws/lambda/${name}`,
          `arn:aws:logs:${region}:${account}:log-group:/aws/lambda/${name}:*`,
        ]),
      }),
    );

    new cdk.CfnOutput(this, 'DeployWebRoleArn', { value: this.webRole.roleArn });
    new cdk.CfnOutput(this, 'DeployComputeRoleArn', { value: this.computeRole.roleArn });
  }
}
