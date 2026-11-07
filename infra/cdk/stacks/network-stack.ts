/**
 * AtmarkNetwork — VPC · 보안 그룹 · 나가는 길 (배포 준비 D2).
 *
 * ---
 *
 * **판단 기록 — 나가는 길**
 *
 * RDS 를 퍼블릭에서 떼려면 Lambda 가 VPC 안에 들어와야 하고, 그 순간 Lambda 는 SES·Secrets Manager·KMS
 * 에 닿지 못한다. 선택지 셋을 한 표로 본다(ap-northeast-2, 월, 2026-09 기준 **추정** — AWS 가격 조회 안 함):
 *
 * | 선택지 | 월 고정비 | 가용성 | 보안 | 웹훅(임의 HTTPS) |
 * |---|---|---|---|---|
 * | NAT Gateway ×1 | ≈ $43 + $0.059/GB | 관리형, AZ 내 이중화 | 관리형 — 패치 없음 | 가능 |
 * | **NAT 인스턴스 t4g.micro ×1** | **≈ $11** (인스턴스 $7 + EBS $0.7 + 공인 IPv4 $3.7 — nano 는 첫 부팅 OOM, 아래 instanceType 주석) | 단일 인스턴스 — 죽으면 나가는 길 전체가 멈춘다(자동 복구는 EC2 기본) | OS 패치가 우리 몫, SSH 없음·IMDSv2 강제·SG 443 만 | 가능 |
 * | 인터페이스 엔드포인트 (SES·Secrets·KMS·SQS) ×2 AZ | ≈ $76 | 관리형 | 트래픽이 AWS 밖으로 안 나감 | **불가** — 웹훅 목적지는 인터넷이다 |
 *
 * **NAT 인스턴스를 택한다.** ① 웹훅 디스패처가 임의 HTTPS 목적지로 나가야 하므로 엔드포인트만으로는 성립하지
 * 않는다 — 엔드포인트를 깔아도 NAT 는 어차피 필요하고, 그러면 엔드포인트는 순수 추가 비용이다. ② NAT 인스턴스가
 * 죽었을 때 일어나는 일은 **지연이지 유실이 아니다**: 발송·알림·웹훅은 전부 DB outbox 를 1분 주기로 집는 형태라
 * (gate-readiness "배포 시 스케줄이 필요한 워커") 나가는 길이 돌아오면 밀린 것이 나간다. 수신은 SES→S3→SQS 가
 * VPC 밖에서 받아 두고, 소비자는 SQS 재전달로 다시 집는다(원문 fetch 는 S3 게이트웨이 엔드포인트라 NAT 무관).
 * ③ GATE 는 사용자 한 명·14일이다. 1인 창업자가 월 $35 를 더 내고 사는 것은 "그 14일 중 NAT 인스턴스 장애 시간"
 * 의 제거인데, 위 ②로 그 시간의 비용은 지연뿐이다. **재개방 조건:** 외부 고객 트래픽 개시(SLA 가 생김) 또는
 * NAT 인스턴스 장애 1회 관측 — 그때 `natGatewayProvider` 한 줄을 `NatProvider.gateway()` 로 바꾼다.
 *
 * **S3 게이트웨이 엔드포인트는 무료이므로 둔다.** 수신 원문(최대 40 MiB)이 NAT 인스턴스의 대역폭·크레딧을 태우지 않는다.
 *
 * **IPv6(egress-only IGW, 무료)는 택하지 않았다.** 웹훅 목적지가 IPv6 를 갖는다는 보장이 없고, 한 서비스라도
 * IPv4 전용이면 결국 NAT 가 필요하다.
 *
 * **AZ 2개.** RDS 서브넷 그룹이 AZ 2개를 요구한다(단일 AZ 인스턴스여도). Lambda 서브넷도 2 AZ 에 두되 NAT 는 하나 —
 * 두 프라이빗 서브넷의 기본 경로가 같은 인스턴스를 본다. AZ 는 **명시한다**: 명시하지 않으면 CDK 가 synth 시점에
 * AZ 목록을 AWS 에 조회(context lookup)하고, CI 는 자격증명 없이 synth 한다(.github/workflows/ci.yml).
 *
 * **운영 DB 관리 접속 = NAT 인스턴스를 SSM 포트 포워딩 경유지로 쓴다** (docs/runbooks/admin.md). RDS 는 격리 서브넷이라
 * 대표 노트북에서 닿을 길이 없고, 관리 CLI(`pnpm admin:*`·`sender:mark`·`ac0:*`)는 DB 에 직접 붙는다. 인스턴스 역할에
 * `AmazonSSMManagedInstanceCore` 하나를 붙이고 DB SG 가 NAT SG 의 5432 를 받는다 — 그게 전부다:
 *   - **인그레스 규칙은 늘지 않는다.** SSM 에이전트가 인스턴스 **밖으로** SSM 엔드포인트에 붙고(공인 경로, 443) 세션은
 *     그 연결 위로 온다. 공개 포트·SSH·키페어 없음. 인증은 대표의 IAM(`atmark-admin` + MFA), 기록은 CloudTrail(`StartSession`).
 *   - 그 관리형 정책에 SES 액션은 없다 — Layer E(`test/arch/iam-single-principal.arch.test.ts`)의 관리형 정책 허용목록이
 *     이 한 줄을 명시적으로 받는다. 발송 주체는 여전히 하나다.
 *   - 새 인스턴스·바스천 없음(비용 0). 대안(바스천 t4g.nano 추가 ≈ $4/월, RDS 퍼블릭 + IP 허용)은 공격면을 늘린다.
 *
 * **NAT AMI 를 고정한다(2026-10-01).** `NatProvider.instanceV2` 의 기본 이미지는 "최신 AL2023 arm64" SSM 공개 파라미터라
 * 배포할 때마다 CloudFormation 이 다시 풀었다. AWS 가 새 AMI 를 내면(2026-10-01 실측: 배포된 `ami-093fb7e528aec34e5` ≠ 최신
 * `ami-0aa00e1a65838ccde`) 이 스택의 **아무 배포나** `ImageId` 변경 = NAT 인스턴스 교체가 되고, 교체 동안 나가는 길 전체가 끊긴다
 * (인스턴스 id 도 바뀌어 SSM 포트 포워딩 대상·라우트가 따라 바뀐다). 그래서 `NAT_AMI_ID` 로 지금 돌고 있는 이미지를 박는다 —
 * 패치(새 AMI)는 이제 **의도한 교체**다: 상수를 바꾸는 커밋 + 점검 창(런북 deploy §36).
 *
 * **보안 그룹을 이 스택에 모은다.** Lambda SG → DB SG 인그레스를 데이터 스택에 두면 컴퓨트·데이터가 서로의 SG 를
 * 참조하게 된다. 여기 두면 의존은 한 방향(네트워크 ← 데이터 ← 컴퓨트)이다.
 */

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

/** NAT 인스턴스 역할의 `/atmark/*` SSM 읽기 명시 Deny 문장 sid(테스트가 찾는다). */
export const NAT_SSM_PARAMETER_DENY_SID = 'DenyAtmarkSecretParameters';

/** 명시 AZ — synth 시 lookup 을 하지 않기 위해서다(머리말). */
export const NETWORK_AZS = ['ap-northeast-2a', 'ap-northeast-2c'] as const;

export const VPC_CIDR = '10.40.0.0/16';

export const POSTGRES_PORT = 5432;

/**
 * NAT 인스턴스 AMI — 2026-09-23 첫 배포가 풀어 쓴 AL2023 arm64(kernel 6.1) 이미지, 지금 돌고 있는 `i-07a7629db9418850a` 의 것이다.
 * 바꾸면 NAT 인스턴스가 **교체된다**(나가는 길 중단) — 머리말 "NAT AMI 를 고정한다" · 런북 deploy §36.
 */
export const NAT_AMI_ID = 'ami-093fb7e528aec34e5';

export class NetworkStack extends cdk.Stack {
  /**
   * `ec2.IVpc` 로 노출한다 — `exactOptionalPropertyTypes` 에서 `Vpc`(클래스)는 `IVpc` 에 대입되지 않는다
   * (`vpnGatewayId?: string` 대 `string | undefined`). CDK 타입 선언의 문제이고 값은 같다.
   */
  public readonly vpc: ec2.IVpc;
  /** 모든 런타임 Lambda 의 SG. 나가는 길: 443(어디로든) + 5432(DB SG 로만). */
  public readonly lambdaSecurityGroup: ec2.SecurityGroup;
  /** RDS 의 SG. 들어오는 길: Lambda SG 와 NAT SG(SSM 포트 포워딩)의 5432 만. */
  public readonly databaseSecurityGroup: ec2.SecurityGroup;
  public readonly natProvider: ec2.NatInstanceProviderV2;
  /** NAT 인스턴스 = SSM 포트 포워딩 경유지. `aws ssm start-session --target <이 id>` (docs/runbooks/admin.md). */
  public readonly natInstanceId: string;

  /**
   * `Vpc` 는 `availabilityZones` 를 받아도 스택의 AZ 목록과 대조하려고 context lookup 을 건다.
   * 스택이 AZ 를 스스로 답하게 해 synth 가 AWS 를 부르지 않게 한다(CI 는 자격증명이 없다).
   */
  public override get availabilityZones(): string[] {
    return [...NETWORK_AZS];
  }

  public constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    this.natProvider = ec2.NatProvider.instanceV2({
      // **t4g.micro — nano 가 아니다.** 2026-09-23 첫 배포에서 t4g.nano(512MB)의 첫 부팅 사용자 데이터가
      // `yum install iptables-services` 도중 OOM 으로 Killed 됐다(cloud-init-output.log). ip_forward 는 켜졌지만
      // MASQUERADE 규칙이 없어 사설 서브넷의 Lambda 가 Secrets Manager 에 닿지 못했다 — 스택·인스턴스 상태는
      // 전부 정상으로 보였고 트래픽을 흘려야만 드러났다. AL2023 의 dnf 메타데이터 적재가 512MB 를 넘는다.
      // 1GB 로 월 +$3. 스왑을 붙이는 우회는 첫 부팅 경합을 남긴다.
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      // 최신 AMI 조회가 아니라 고정 — 새 AMI 가 나올 때마다 배포가 NAT 를 교체하지 않게(머리말). 리전은 NETWORK_AZS 의 리전이다.
      machineImage: ec2.MachineImage.genericLinux({ 'ap-northeast-2': NAT_AMI_ID }),
      // 보안 그룹을 아래에서 손으로 좁힌다 — 기본값(INBOUND_AND_OUTBOUND)은 0.0.0.0/0 전 포트 인그레스다.
      defaultAllowedTraffic: ec2.NatTrafficDirection.OUTBOUND_ONLY,
      associatePublicIpAddress: true,
      // t4g 기본은 unlimited — 폭주 시 과금이 조용히 붙는다. standard 는 크레딧 소진 시 느려질 뿐이다.
      creditSpecification: ec2.CpuCredits.STANDARD,
      // 키페어 없음 = SSH 없음. 고장 나면 고치지 않고 교체한다.
    });

    const vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr(VPC_CIDR),
      availabilityZones: [...NETWORK_AZS],
      natGateways: 1,
      natGatewayProvider: this.natProvider,
      subnetConfiguration: [
        // NAT 인스턴스만 산다.
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        // Lambda ENI. 기본 경로 → NAT 인스턴스.
        { name: 'app', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 22 },
        // RDS. 기본 경로 없음 — 인터넷으로 나갈 길 자체가 없다.
        { name: 'data', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
      // 서브넷을 흐르는 트래픽 기록은 아직 없다 — GATE 규모에서 비용 대비 가치가 낮다. 사고 조사가 필요해지면 켠다.
    });

    this.vpc = vpc as ec2.IVpc;
    // synth 검증 보고서의 W3010(AZ 하드코딩) 경고 5건은 의도다 — availabilityZones getter 참조.

    vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
      subnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
    });

    // NAT 인스턴스: VPC 안에서 443 으로 오는 것만 받아 넘긴다. 나가는 쪽은 OUTBOUND_ONLY 가 전부 연다
    // (인스턴스 자신의 패키지 설치도 443 이지만 목적지 IP 가 미리 정해지지 않는다).
    this.natProvider.connections.allowFrom(ec2.Peer.ipv4(VPC_CIDR), ec2.Port.tcp(443), 'HTTPS from VPC to NAT');

    this.lambdaSecurityGroup = new ec2.SecurityGroup(this, 'LambdaSecurityGroup', {
      vpc: this.vpc,
      description: 'Atmark runtime Lambdas - egress 443 anywhere + 5432 to DB only',
      allowAllOutbound: false,
    });
    // SES·Secrets Manager·KMS·S3(게이트웨이)·웹훅 목적지 전부 443 이다. 웹훅 URL 은 https 만 받지만 포트는 열려 있다 —
    // 443 이 아닌 웹훅 목적지는 여기서 막힌다(의도: 사설 대역 우회 SSRF 의 두 번째 벽). 보고서의 계약 요청 참조.
    this.lambdaSecurityGroup.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS (AWS APIs via NAT, webhooks)');

    this.databaseSecurityGroup = new ec2.SecurityGroup(this, 'DatabaseSecurityGroup', {
      vpc: this.vpc,
      description: 'Atmark RDS - ingress 5432 from runtime Lambdas and NAT instance (SSM admin) only',
      allowAllOutbound: false,
    });
    this.databaseSecurityGroup.addIngressRule(
      this.lambdaSecurityGroup,
      ec2.Port.tcp(POSTGRES_PORT),
      'Postgres from runtime Lambdas',
    );
    this.lambdaSecurityGroup.addEgressRule(
      this.databaseSecurityGroup,
      ec2.Port.tcp(POSTGRES_PORT),
      'Postgres to RDS only',
    );

    // ── 운영 DB 관리 접속: SSM 포트 포워딩 (머리말) ────────────────────────────────
    const [natInstance, ...extraNat] = this.natProvider.gatewayInstances;
    if (natInstance === undefined || extraNat.length > 0) throw new Error('NAT 인스턴스는 정확히 하나여야 한다(머리말)');
    // 세션 관리자 에이전트 등록·세션 채널에 필요한 것만(ssm·ssmmessages·ec2messages). SES 없음 — Layer E 허용목록 참조.
    natInstance.role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'));
    // 그 관리형 정책은 `ssm:GetParameter(s)` 를 Resource `*` 로 준다 — 운영 비밀(`/atmark/*` SecureString, 2026-10-12 비밀 → SSM 이전)을 읽지 못하게
    //   명시 Deny(보안 리뷰 HIGH ⓐ). 실제 방어의 첫 겹은 고객 관리형 키(`secrets-key-stack.ts` — 이 역할에 kms:Decrypt 없음)다; 이 Deny 는 둘째 겹.
    //   역할의 기본 정책이 아니라 **따로 선 정책**으로 붙인다 — 인스턴스가 역할(과 그 기본 정책)에 거는 DependsOn 을 바꾸지 않게(NAT 인스턴스 diff 0).
    new iam.Policy(this, 'NatInstanceDenyAtmarkParameters', {
      roles: [natInstance.role],
      statements: [
        new iam.PolicyStatement({
          sid: NAT_SSM_PARAMETER_DENY_SID,
          effect: iam.Effect.DENY,
          actions: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath', 'ssm:GetParameterHistory'],
          resources: [
            `arn:${this.partition}:ssm:${this.region}:${this.account}:parameter/atmark`,
            `arn:${this.partition}:ssm:${this.region}:${this.account}:parameter/atmark/*`,
          ],
        }),
      ],
    });
    this.natInstanceId = natInstance.instanceId;
    // 포트 포워딩 세션은 NAT 인스턴스에서 RDS 로 5432 를 연다. 받는 쪽만 연다 — NAT SG 의 나가는 길은 이미 전부 열려 있다.
    this.databaseSecurityGroup.addIngressRule(
      this.natProvider.securityGroup,
      ec2.Port.tcp(POSTGRES_PORT),
      'Postgres from NAT instance (SSM port forwarding for admin CLI)',
    );

    // NAT 인스턴스의 메타데이터 서비스는 v2(세션 토큰)만. 인스턴스 역할(SSM)의 자격증명을 SSRF 로 읽을 길을 남기지 않는다.
    cdk.Aspects.of(this).add(new ec2.InstanceRequireImdsv2Aspect());

    new cdk.CfnOutput(this, 'VpcId', { value: this.vpc.vpcId, description: 'Atmark VPC' });
    new cdk.CfnOutput(this, 'NatInstanceId', {
      value: this.natInstanceId,
      description: 'SSM 포트 포워딩 경유지 — aws ssm start-session --target <이 값> (docs/runbooks/admin.md)',
    });
  }
}
