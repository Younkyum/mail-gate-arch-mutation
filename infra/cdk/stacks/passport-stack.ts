/**
 * AtmarkPassport — 개인키 보관 지반 (계획 §3.5 · §6 P1c PP-A 생성 파일).
 *
 * **이 스택이 담는 것은 CMK 하나뿐이다.** 그리고 그것이 PP-A 의 인프라 전부다 —
 * `did.json` 서빙(S3 + CloudFront)은 `identity-cdn-stack.ts` 가 P0 에 이미 깔았고,
 * 문서 생성·서명·공개 API 는 P6(PP-B/PP-C)이다(§4B.2: "서빙·서명·공개 API 없음").
 *
 * ---
 *
 * **왜 에이전트별 Secrets Manager 시크릿이 여기 없는가.**
 * 시크릿은 **에이전트 1개당 1개**이고 개수에 상한이 없다. CloudFormation 이 그것들을
 * 소유하면 세 가지가 동시에 나빠진다:
 *   ① 에이전트를 만들 때마다 스택 배포가 필요해진다 — 프로비저닝이 **트랜잭션 내부**여야
 *      한다는 §4B.1 의 요구와 정면으로 충돌한다.
 *   ② `cdk deploy` 가 드리프트를 "고치는" 동작은 리소스 **교체**다. 교체된 시크릿은
 *      새 개인키를 뜻하고, 그것이 정확히 AC-13 이 막으려는 회전이다.
 *   ③ 스택 삭제가 전 에이전트의 개인키 삭제가 된다.
 * 그래서 시크릿은 **런타임이 `CreateSecret` 로 만든다**(`src/passport/custody-aws.ts`).
 * 이 스택은 그 시크릿들이 쓸 **암호화 키**와 **이름 규칙**만 소유한다.
 */

import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import type { Construct } from 'constructs';

/**
 * 에이전트 개인키 시크릿의 이름 접두사.
 * **`src/passport/custody-aws.ts` 의 `AGENT_KEYPAIR_SECRET_PREFIX` 와 같은 값이어야 한다** —
 * 두 값이 갈라지면 CMK 를 쓸 수 있는 이름 범위와 런타임이 만드는 이름이 어긋나고,
 * 그 어긋남은 첫 운영 프로비저닝에서야 드러난다.
 */
export const AGENT_KEYPAIR_SECRET_PREFIX = 'atmark/agent-keypairs';

/** CMK 별칭. ARN 은 계정마다 다르므로 배선은 별칭으로 한다. */
export const AGENT_KEYPAIR_KEY_ALIAS = 'alias/atmark-agent-keypairs';

/**
 * 서명 Lambda 역할의 물리 이름(`compute-stack.ts` 가 다시 내보낸다). **envelope 의 DEK 를 직접 복호할 수 있는 유일한 주체** — 아래 키 정책의
 * Deny 가 이 이름 하나만 뺀다.
 */
export const PASSPORT_SIGNER_ROLE_NAME = 'atmark-runtime-passport-signer';

/** 키 정책의 Deny 문장 sid — 테스트가 이 이름으로 찾는다. */
export const DENY_DIRECT_DECRYPT_SID = 'DenyDirectDecryptExceptPassportSigner';

export class PassportStack extends cdk.Stack {
  public readonly agentKeypairKey: kms.IKey;

  public constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    this.agentKeypairKey = new kms.Key(this, 'AgentKeypairKey', {
      alias: AGENT_KEYPAIR_KEY_ALIAS,
      description:
        'Envelope encryption CMK for Atmark agent ed25519 private keys (plan §3.5). ' +
        'Data keys only — this CMK never signs.',

      // ★ **이 키를 잃으면 발급된 전 에이전트의 개인키가 복구 불가능하다.**
      //   DESTROY 면 스택 삭제 한 번이 그것을 한다. did:web 에서 도메인 상실이
      //   ADR-0002 의 최악 시나리오라면, CMK 상실은 그것과 같은 등급의 사건이다.
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      // 삭제가 시작돼도 최대 대기 창을 준다. 사고와 복구 사이의 시간이 유일한 방어선이다.
      pendingWindow: cdk.Duration.days(30),

      // **자동 회전을 켜도 안전하다 — 그리고 이것은 키 회전(§4B.1)과 무관하다.**
      //   KMS 는 회전 시 **이전 백킹 키를 보관**하므로 옛 암호문은 계속 복호된다.
      //   여기서 회전하는 것은 envelope 을 감싼 CMK 이고, 에이전트의 ed25519 키는
      //   바뀌지 않는다. 두 개념을 섞으면 "회전 금지"를 이유로 CMK 위생을 포기하게 된다.
      enableKeyRotation: true,

      keySpec: kms.KeySpec.SYMMETRIC_DEFAULT,
      keyUsage: kms.KeyUsage.ENCRYPT_DECRYPT,
    });

    // ★ 키 정책 Deny — **DEK 직접 복호(kms:Decrypt, Secrets Manager 경유가 아닌 것)는 서명 역할 하나만** (2026-09-24 검증 반영).
    //
    //   CDK 기본 키 정책은 계정 루트에 `kms:*` 를 준다 = 이 키의 권한을 IAM 에 위임한다. 그러면 계정 안의 **아무 IAM 주체**든
    //   `kms:Decrypt` on `*` 같은 넓은 신원 정책 하나로 envelope 의 DEK 를 풀 수 있다 — 코드(`signer.ts` 하나)·역할(compute-stack)의
    //   격리가 IAM 정책 오타 하나에 기댄다. 키 정책의 명시적 Deny 는 어떤 Allow 로도 뒤집히지 않는다.
    //
    //   무엇을 막고 무엇을 두는가:
    //     - 막는다: Secrets Manager 를 거치지 **않은** Decrypt(= envelope 의 DEK 를 푸는 호출) — 서명 역할이 아니면 전부.
    //       관리 역할(`atmark-runtime-admin`)도 여기에 걸린다(그 역할의 Decrypt 는 원래 ViaService=secretsmanager 조건부다).
    //     - 둔다: Secrets Manager 경유 Decrypt — 시크릿을 CMK 로 **만들 때**(CreateSecret) Secrets Manager 가 호출자의 Decrypt 를
    //       요구한다. 관리 역할(콘솔 프로비저닝)과 **운영자 IAM**(`pnpm admin:agent-provision` — CDK 가 이름을 모르는 주체)이 쓴다.
    //       이 경로로 얻을 수 있는 것은 시크릿 값 = envelope JSON 이고, 그 안의 DEK 는 여전히 이 CMK 로 싸여 있다 — 풀려면 다시
    //       직접 Decrypt 가 필요하고 그것이 위에서 막힌다. Secrets Manager 는 자기 데이터 키(암호화 컨텍스트 SecretARN)만 풀어 준다.
    //     - 둔다: GenerateDataKey(프로비저닝) · 키 관리(PutKeyPolicy 등 — 계정 루트가 비상 해제 경로다: 이 Deny 는 Decrypt 하나만 건다).
    //   역할 ARN 은 이름으로 만든다 — Passport 스택이 Compute 보다 먼저 배포되므로 역할을 참조할 수 없고, 이름은 고정이다.
    //   `aws:PrincipalArn` 은 역할 세션이어도 **역할 ARN** 이다(세션 이름과 무관).
    const signerRoleArn = `arn:${this.partition}:iam::${this.account}:role/${PASSPORT_SIGNER_ROLE_NAME}`;
    this.agentKeypairKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: DENY_DIRECT_DECRYPT_SID,
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['kms:Decrypt'],
        resources: ['*'],
        conditions: {
          // 두 조건은 AND 다: (Secrets Manager 경유가 아니다) AND (서명 역할이 아니다) → 거부. 부정 연산자는 키가 없으면(직접 호출) 참이다.
          StringNotEquals: { 'kms:ViaService': `secretsmanager.${this.region}.amazonaws.com` },
          ArnNotEquals: { 'aws:PrincipalArn': signerRoleArn },
        },
      }),
    );

    new cdk.CfnOutput(this, 'AgentKeypairKeyArn', {
      value: this.agentKeypairKey.keyArn,
      description:
        'src/passport/custody-aws.ts 의 createAwsKeyCustody({ cmkArn }) 에 넣을 값. ' +
        'GenerateDataKey 만 쓴다 — Decrypt 는 P6 의 signer.ts 하나가 갖는다 (§3.5 AC-e2).',
    });

    new cdk.CfnOutput(this, 'AgentKeypairSecretPrefix', {
      value: `${AGENT_KEYPAIR_SECRET_PREFIX}/*`,
      description:
        '에이전트 개인키 시크릿의 이름 범위. 시크릿 자체는 런타임이 CreateSecret 으로 만든다 — ' +
        'CloudFormation 이 소유하면 스택 배포가 프로비저닝 경로가 되고, 리소스 교체가 키 회전이 된다.',
    });

    // 왜 IAM 역할이 이 스택에 없는가: 키를 쓰는 주체(프로비저닝 API·P6 signer)는 아직
    // 배포되지 않았다. 지금 역할을 만들면 **아무도 assume 하지 않는 권한**이 서 있게 되고,
    // 그 권한은 다음 사람이 "이미 있으니까" 재사용하는 표면이 된다. 계산 리소스가 생기는
    // 단계에서 그 스택이 `agentKeypairKey.grantEncrypt(...)` 로 최소 권한을 붙인다.
  }
}
