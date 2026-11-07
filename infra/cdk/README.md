# CDK

## 부트스트랩 (2026-09-22 완료)

```
aws://123456789012/ap-northeast-2   버전 32   qualifier hnb659fds
```

`AWS_PROFILE=atmark pnpm exec cdk bootstrap aws://123456789012/ap-northeast-2`

**루트가 아니라 `atmark-admin` 자격으로 부트스트랩했다.** 루트로 만든 뒤 주체를 바꾸면
스택과 IAM 신뢰 관계를 다시 짜야 하므로(계획 D2 — 비가역적인 것을 먼저), 이 순서가 중요하다.

## 부트스트랩이 만든 역할

| 역할 | 정책 | AC-c8b 분류 |
|---|---|---|
| `cfn-exec-role` | `AdministratorAccess` | **배포 역할** — `ses:SendEmail` 행사 가능. allowlist 등재됨 |
| `deploy-role` | `AWSCloudFormationReadOnlyAccess` | — |
| `file-publishing-role` | (인라인) | — |
| `image-publishing-role` | (인라인) | — |
| `lookup-role` | `ReadOnlyAccess` | — |

`cfn-exec-role` 의 `AdministratorAccess` 는 CDK 기본값이다. 스택 구성이 안정된 뒤
(P1c 이후) `--cloudformation-execution-policies` 로 범위 축소를 검토한다 —
`docs/ops/ses-principals-allowlist.json` 의 `deploymentRoles._followUp` 참조.

## 검증

```
AWS_PROFILE=atmark ./scripts/check-ses-principals.sh
```

## 배포 기록 (2026-09-22)

| 스택 | 리전 | 결과 |
|---|---|---|
| `AtmarkSes` | ap-northeast-2 | Configuration Set `atmark-default` / SNS `atmark-ses-events` |
| `AtmarkIdentityCertificate` | **us-east-1** | ACM `id.atmark.ai` — **ISSUED**, 만료 2027-04-08 |
| `AtmarkIdentityCdn` | ap-northeast-2 | CloudFront `dsvbcl142fw74.cloudfront.net` (`E360KUA8ZUME9Y`) / S3 `atmarkidentitycdn-diddocumentbucket592845a6-gxylh1mgvkyf` |

### 겪은 것 두 가지

**1. `us-east-1` 부트스트랩을 빠뜨렸다.** CloudFront 인증서는 `us-east-1` 에만 있을 수 있는데
서울만 부트스트랩한 상태였다. `cdk deploy` 가 `SsmParameterNotFound` 로 실패했다.
두 리전 모두 부트스트랩되어 있어야 한다.

**2. 실패한 `cdk deploy` 가 exit code 0 을 냈다.** 출력을 읽지 않고 종료 코드만 봤다면
"배포 완료"로 오인했을 것이다. **배포 자동화 시 exit code 로 성공을 판정하면 안 된다** —
스택 상태(`describe-stacks`)나 출력 문자열을 확인해야 한다. 계획 Principle P2 와 같은 범주다.

### ACM DNS 검증 절차 (Route 53 가 없으므로 수동)

1. `pnpm cdk:deploy AtmarkIdentityCertificate` — `CREATE_IN_PROGRESS` 로 멈춘다
2. 다른 터미널에서 검증 레코드를 읽는다:
   `aws acm describe-certificate --certificate-arn <ARN> --region us-east-1 --query 'Certificate.DomainValidationOptions[0].ResourceRecord'`
3. 그 CNAME 을 Cloudflare 에 **프록시 OFF** 로 추가
4. 몇 분 내 검증 완료 → 스택 진행

`id.atmark.ai` 의 CAA 를 Amazon 전용으로 먼저 걸어 둔 덕에 발급이 통과했다.
순서가 반대였으면 CAA 가 발급을 거부했을 것이다.
