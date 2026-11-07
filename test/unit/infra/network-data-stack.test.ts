/**
 * `AtmarkNetwork` · `AtmarkData` — 합성된 템플릿에 대한 단언. **배포하지 않는다.**
 *
 * RDS 는 밖에서 닿지 않고(격리 서브넷·퍼블릭 아님·SG 5432 는 Lambda SG 에서만), TLS 를 강제하고, 암호화되고,
 * 스택 삭제로 사라지지 않는다. 나가는 길은 NAT 인스턴스 하나 + S3 게이트웨이 엔드포인트이고, synth 는 AWS 를 부르지 않는다.
 * 비밀의 "자리" 는 고정 플레이스홀더다 — 그 문자열이 바뀌면 배포가 실제 값을 덮어쓴다.
 */

import { Match } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

import {
  APPROVAL_LINK_KEYS_SECRET_NAME,
  DB_ADMIN_SECRET_NAME,
  DB_APP_SECRET_NAME,
  DB_LOGIN_MAILER_SECRET_NAME,
  DB_MASTER_SECRET_NAME,
  DB_OWNER_SECRET_NAME,
  WEBHOOK_SECRET_KEYS_SECRET_NAME,
} from '../../../infra/cdk/stacks/data-stack';
import { NAT_AMI_ID, NAT_SSM_PARAMETER_DENY_SID, VPC_CIDR } from '../../../infra/cdk/stacks/network-stack';
import { OPS_SECRET_NAMES } from '../../../src/ops/contract';
import { runtimeMissingContext, runtimeTemplates } from './runtime-app';

interface SgRule {
  readonly CidrIp?: string;
  readonly IpProtocol: string;
  readonly FromPort?: number;
  readonly ToPort?: number;
}

describe('AtmarkNetwork — 나가는 길', () => {
  it('synth 가 AWS 를 부르지 않는다 — context lookup 0건 (CI 는 자격증명 없이 synth 한다)', () => {
    expect(runtimeMissingContext()).toEqual([]);
  });

  it('NAT 는 t4g.micro 인스턴스 하나(nano 는 첫 부팅 dnf 가 OOM) · NAT Gateway 없음 · IMDSv2 강제 · 크레딧 standard', () => {
    const network = runtimeTemplates().network;
    network.resourceCountIs('AWS::EC2::NatGateway', 0);
    network.resourceCountIs('AWS::EC2::Instance', 1);
    network.hasResourceProperties('AWS::EC2::Instance', {
      InstanceType: 't4g.micro',
      SourceDestCheck: false,
      CreditSpecification: { CPUCredits: 'standard' },
    });
    network.hasResourceProperties('AWS::EC2::LaunchTemplate', {
      LaunchTemplateData: { MetadataOptions: { HttpTokens: 'required' } },
    });
  });

  it('NAT AMI 는 배포된 이미지로 고정된다 — 최신 AMI SSM 조회(배포마다 교체 위험)가 아니다(2026-10-01)', () => {
    const network = runtimeTemplates().network;
    expect(NAT_AMI_ID).toBe('ami-093fb7e528aec34e5');
    network.hasResourceProperties('AWS::EC2::Instance', { ImageId: NAT_AMI_ID });
    // 최신 AMI 공개 파라미터를 CloudFormation 파라미터로 받던 자리가 사라졌다.
    expect(JSON.stringify(network.toJSON())).not.toContain('/aws/service/ami-amazon-linux-latest');
  });

  it('S3 게이트웨이 엔드포인트가 앱 서브넷 경로에 붙는다 — 수신 원문이 NAT 를 지나지 않는다', () => {
    runtimeTemplates().network.hasResourceProperties('AWS::EC2::VPCEndpoint', {
      VpcEndpointType: 'Gateway',
      ServiceName: Match.objectLike({ 'Fn::Join': ['', Match.arrayWith([Match.stringLikeRegexp('\\.s3$')])] }),
    });
  });

  it('NAT SG 인그레스는 VPC 내부 443 하나뿐이다 (기본값의 0.0.0.0/0 전 포트가 아니다)', () => {
    const groups = runtimeTemplates().network.findResources('AWS::EC2::SecurityGroup', {
      Properties: { GroupDescription: 'Security Group for NAT instances' },
    }) as Record<string, { Properties: { SecurityGroupIngress?: SgRule[] } }>;
    const ingress = Object.values(groups).flatMap((g) => g.Properties.SecurityGroupIngress ?? []);
    expect(ingress).toEqual([expect.objectContaining({ CidrIp: VPC_CIDR, IpProtocol: 'tcp', FromPort: 443, ToPort: 443 })]);
  });

  it('Lambda SG 나가는 길: 443(어디로든) + 5432(DB SG 로만). DB SG 들어오는 길: Lambda SG 의 5432 만', () => {
    const network = runtimeTemplates().network;
    network.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: Match.stringLikeRegexp('^Atmark runtime Lambdas'),
      SecurityGroupEgress: [Match.objectLike({ CidrIp: '0.0.0.0/0', IpProtocol: 'tcp', FromPort: 443, ToPort: 443 })],
    });
    network.resourceCountIs('AWS::EC2::SecurityGroupEgress', 1);
    network.hasResourceProperties('AWS::EC2::SecurityGroupEgress', { FromPort: 5432, ToPort: 5432 });
    // DB SG 의 인그레스는 둘 — Lambda SG 와 NAT SG(SSM 포트 포워딩, 아래 describe). 둘 다 SG 참조 5432, CIDR 없음.
    const ingress = Object.values(
      network.findResources('AWS::EC2::SecurityGroupIngress') as Record<string, { Properties: Record<string, unknown> }>,
    ).map((resource) => resource.Properties);
    expect(ingress).toHaveLength(2);
    for (const rule of ingress) {
      expect(rule).toMatchObject({ IpProtocol: 'tcp', FromPort: 5432, ToPort: 5432, SourceSecurityGroupId: expect.anything() });
      expect(rule).not.toHaveProperty('CidrIp');
      expect(JSON.stringify(rule['GroupId'])).toMatch(/DatabaseSecurityGroup/);
    }
    const sources = ingress.map((rule) => JSON.stringify(rule['SourceSecurityGroupId'])).sort();
    expect(sources).toEqual([expect.stringMatching(/LambdaSecurityGroup/), expect.stringMatching(/NatSecurityGroup/)]);
  });
});

describe('AtmarkNetwork — 운영 DB 관리 접속 (SSM 포트 포워딩, docs/runbooks/admin.md)', () => {
  const natRole = (): { logicalId: string; properties: Record<string, unknown> } => {
    const network = runtimeTemplates().network;
    const instances = Object.values(
      network.findResources('AWS::EC2::Instance') as Record<string, { Properties: { IamInstanceProfile: { Ref: string } } }>,
    );
    expect(instances).toHaveLength(1);
    const profileId = instances[0]?.Properties.IamInstanceProfile.Ref ?? '';
    const profile = network.findResources('AWS::IAM::InstanceProfile')[profileId] as { Properties: { Roles: { Ref: string }[] } };
    const roleId = profile.Properties.Roles[0]?.Ref ?? '';
    const role = network.findResources('AWS::IAM::Role')[roleId] as { Properties: Record<string, unknown> } | undefined;
    expect(role, 'NAT 인스턴스 프로파일의 역할').toBeDefined();
    return { logicalId: roleId, properties: role?.Properties ?? {} };
  };

  it('NAT 인스턴스 역할에 AmazonSSMManagedInstanceCore 하나 — 그 밖의 관리형·인라인 권한 없음(붙은 정책은 /atmark/* SSM 읽기 Deny 하나뿐)', () => {
    const { logicalId, properties } = natRole();
    const managed = JSON.stringify(properties['ManagedPolicyArns'] ?? []);
    expect(managed).toMatch(/:iam::aws:policy\/AmazonSSMManagedInstanceCore"/);
    expect((properties['ManagedPolicyArns'] as unknown[]).length).toBe(1);
    expect(properties).not.toHaveProperty('Policies');
    // 인스턴스 역할에 붙는 AWS::IAM::Policy 는 **Deny 하나뿐** — SES·Secrets·KMS 를 무엇으로도 받지 않는다. 관리형 정책이 주는 `ssm:GetParameter *` 가
    //   운영 비밀(`/atmark/*` SecureString, 2026-10-12)에 닿지 않게 하는 둘째 겹(첫 겹은 고객 관리형 키 — 이 역할엔 kms:Decrypt 가 없다).
    const attached = Object.values(
      runtimeTemplates().network.findResources('AWS::IAM::Policy') as Record<
        string,
        { Properties: { Roles?: { Ref: string }[]; PolicyDocument: { Statement: { Sid?: string; Effect: string; Action: string[]; Resource: unknown }[] } } }
      >,
    ).filter((policy) => (policy.Properties.Roles ?? []).some((role) => role.Ref === logicalId));
    expect(attached).toHaveLength(1);
    const statements = attached[0]?.Properties.PolicyDocument.Statement ?? [];
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatchObject({
      Sid: NAT_SSM_PARAMETER_DENY_SID,
      Effect: 'Deny',
      Action: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath', 'ssm:GetParameterHistory'],
    });
    const resources = JSON.stringify(statements[0]?.Resource);
    expect(resources).toContain(':parameter/atmark"');
    expect(resources).toContain(':parameter/atmark/*"');
    // 인스턴스는 그 정책에 기대지(DependsOn) 않는다 — NAT 인스턴스 diff 0 으로 들어간다.
    const instances = runtimeTemplates().network.findResources('AWS::EC2::Instance') as Record<string, { DependsOn?: string[] }>;
    for (const instance of Object.values(instances)) expect(JSON.stringify(instance.DependsOn ?? [])).not.toMatch(/NatInstanceDenyAtmarkParameters/);
  });

  it('Layer E — NAT 인스턴스 역할이 SES 를 부를 수 있는 문장은 0개다', () => {
    const { properties } = natRole();
    expect(JSON.stringify(properties)).not.toMatch(/ses:|"\*"/);
  });

  it('NAT SG 인그레스는 늘지 않았다 — 세션은 인스턴스가 밖으로 연 SSM 연결 위로 온다(공개 포트·SSH 없음)', () => {
    const network = runtimeTemplates().network;
    const groups = network.findResources('AWS::EC2::SecurityGroup', {
      Properties: { GroupDescription: 'Security Group for NAT instances' },
    }) as Record<string, { Properties: { SecurityGroupIngress?: SgRule[] } }>;
    const inline = Object.values(groups).flatMap((g) => g.Properties.SecurityGroupIngress ?? []);
    expect(inline).toEqual([expect.objectContaining({ CidrIp: VPC_CIDR, FromPort: 443, ToPort: 443 })]);
    // 별도 SecurityGroupIngress 리소스 중 NAT SG 를 **대상**으로 하는 것은 없다(위 DB SG 규칙 둘만 있다).
    const standalone = Object.values(
      network.findResources('AWS::EC2::SecurityGroupIngress') as Record<string, { Properties: { GroupId: unknown } }>,
    ).filter((rule) => /NatSecurityGroup/.test(JSON.stringify(rule.Properties.GroupId)));
    expect(standalone).toEqual([]);
    // 키페어 없음 = SSH 없음.
    network.hasResourceProperties('AWS::EC2::LaunchTemplate', {
      LaunchTemplateData: Match.not(Match.objectLike({ KeyName: Match.anyValue() })),
    });
  });

  it('경유지 인스턴스 id 가 출력된다 — 런북의 aws ssm start-session --target', () => {
    runtimeTemplates().network.hasOutput('NatInstanceId', { Value: { Ref: Match.stringLikeRegexp('NatInstance') } });
  });
});

describe('AtmarkData — RDS', () => {
  it('PostgreSQL 17 · db.t4g.micro · 20GB gp3 · 단일 AZ', () => {
    runtimeTemplates().data.hasResourceProperties('AWS::RDS::DBInstance', {
      Engine: 'postgres',
      EngineVersion: '17',
      DBInstanceClass: 'db.t4g.micro',
      AllocatedStorage: '20',
      StorageType: 'gp3',
      MultiAZ: false,
    });
  });

  it('퍼블릭 아님 · 저장 시 암호화 · 삭제 보호 · 삭제 시 스냅숏 · 백업 14일(GATE 기간 PITR)', () => {
    const data = runtimeTemplates().data;
    data.hasResource('AWS::RDS::DBInstance', {
      DeletionPolicy: 'Snapshot',
      Properties: Match.objectLike({
        PubliclyAccessible: false,
        StorageEncrypted: true,
        DeletionProtection: true,
        BackupRetentionPeriod: 14,
      }),
    });
  });

  it('파라미터 그룹이 rds.force_ssl=1 을 명시한다', () => {
    const data = runtimeTemplates().data;
    data.hasResourceProperties('AWS::RDS::DBParameterGroup', {
      Family: 'postgres17',
      Parameters: { 'rds.force_ssl': '1' },
    });
    data.hasResourceProperties('AWS::RDS::DBInstance', { DBParameterGroupName: Match.anyValue() });
  });

  it('서브넷 그룹은 격리 서브넷(기본 경로 없음)만 쓴다', () => {
    const groups = runtimeTemplates().data.findResources('AWS::RDS::DBSubnetGroup') as Record<
      string,
      { Properties: { SubnetIds: unknown[] } }
    >;
    const ids = JSON.stringify(Object.values(groups).map((g) => g.Properties.SubnetIds));
    expect(ids).toMatch(/dataSubnet1/);
    expect(ids).toMatch(/dataSubnet2/);
    expect(ids).not.toMatch(/appSubnet|publicSubnet/);
  });
});

describe('AtmarkData — 비밀의 자리', () => {
  const secretsByName = (): Map<string, { DeletionPolicy?: string; Properties: Record<string, unknown> }> => {
    const secrets = runtimeTemplates().data.findResources('AWS::SecretsManager::Secret') as Record<
      string,
      { DeletionPolicy?: string; Properties: Record<string, unknown> }
    >;
    return new Map(Object.values(secrets).map((s) => [String(s.Properties['Name']), s]));
  };

  it('비밀이 전부 RETAIN 이다 — 스택 삭제가 자격증명·키링 삭제가 되면 안 된다 (admin·login-mailer DB 비밀 포함, ADR-0006)', () => {
    const secrets = secretsByName();
    for (const name of [
      DB_MASTER_SECRET_NAME,
      DB_OWNER_SECRET_NAME,
      DB_APP_SECRET_NAME,
      DB_ADMIN_SECRET_NAME,
      DB_LOGIN_MAILER_SECRET_NAME,
      APPROVAL_LINK_KEYS_SECRET_NAME,
      WEBHOOK_SECRET_KEYS_SECRET_NAME,
    ]) {
      expect(secrets.get(name)?.DeletionPolicy, name).toBe('Retain');
    }
  });

  it('자리만 만든 비밀은 고정 플레이스홀더다 — **이 문자열이 바뀌면 배포가 실제 값을 덮어쓴다**', () => {
    const secrets = secretsByName();
    // 상수를 import 하지 않고 리터럴로 적는다: 상수를 고치면 여기가 빨개져야 한다.
    const pinned = '{"_unset":"placeholder - filled by migrate handler or deploy runbook (docs/runbooks/deploy.md)"}';
    for (const name of [
      DB_OWNER_SECRET_NAME,
      DB_APP_SECRET_NAME,
      DB_ADMIN_SECRET_NAME,
      DB_LOGIN_MAILER_SECRET_NAME,
      APPROVAL_LINK_KEYS_SECRET_NAME,
      WEBHOOK_SECRET_KEYS_SECRET_NAME,
    ]) {
      const properties = secrets.get(name)?.Properties ?? {};
      expect(properties['SecretString'], name).toBe(pinned);
      expect(properties, name).not.toHaveProperty('GenerateSecretString');
    }
  });

  it('배포된 소유자 비밀의 설명은 그대로다 — 자리 비밀의 속성이 바뀌면 CloudFormation 이 그 리소스를 갱신한다', () => {
    // HEAD 869b837(첫 운영 배포) 의 값. 이 문자열을 바꾸는 변경은 운영 비밀 리소스를 건드린다 — 이유가 있어야 한다.
    expect(secretsByName().get(DB_OWNER_SECRET_NAME)?.Properties['Description']).toBe(
      'Postgres owner role credentials (DDL/GRANT). Written by the migrate handler; read by migrate only.',
    );
  });

  it('운영자 콘솔(ADR-0015) 자리 셋 — 이름은 계약(OPS_SECRET_NAMES) · RETAIN · 고정 플레이스홀더 · 생성값 아님', () => {
    const secrets = secretsByName();
    const pinned = '{"_unset":"placeholder - filled by migrate handler or deploy runbook (docs/runbooks/deploy.md)"}';
    expect(Object.values(OPS_SECRET_NAMES).sort()).toEqual(['atmark/db/ops', 'atmark/ops-keys', 'atmark/ops-login-keys']);
    for (const name of Object.values(OPS_SECRET_NAMES)) {
      const secret = secrets.get(name);
      expect(secret?.DeletionPolicy, name).toBe('Retain');
      expect(secret?.Properties['SecretString'], name).toBe(pinned);
      expect(secret?.Properties, name).not.toHaveProperty('GenerateSecretString');
    }
  });

  it('마스터 비밀만 생성값이다(RDS 가 그 값으로 인스턴스를 만든다)', () => {
    expect(secretsByName().get(DB_MASTER_SECRET_NAME)?.Properties).toHaveProperty('GenerateSecretString');
  });
});
