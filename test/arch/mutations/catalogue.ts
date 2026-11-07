/**
 * Layer F — 알려진 위반 패치 (계획 §5.0 "Layer F" — 처음 13종, 이후 층마다 더했다. WP-2 결제 경계는 `BL-1`~`BL-4`).
 *
 * **새 arch 층을 만들면 여기에 변이도 만든다.** 층만 추가하면 그 층이 잠들어 있는지
 * 아무도 모르고, 그 상태가 정확히 Layer F 가 막으려는 것이다. P1c 의 키 불변 층
 * (AC-13)이 변이 H 로 들어와 있는 이유다.
 *
 * **그리고 P1c 는 그 규칙을 한 번 어겼다 (2026-09-22 검증).** `observability-pii`
 * (13 단언)와 `observability-alarms`(13 단언)를 새로 세우면서 변이를 0개 만들었다.
 * 검증자가 두 층을 **동시에 재운 채** 러너를 돌리자 러너는
 * `✓ Layer F: 변이 8종 전부를 겨냥한 층이 잡았다` 를 출력했다 — 그 상태에서
 * `atmark-gate-silence` 의 `BREACHING → NOT_BREACHING`, **알람 스택 주석이 "여기만
 * 결측이 위반이다" 라고 못 박은 그 한 글자**가 13 passed 로 통과했다.
 * 변이 I·J(PII)와 K(알람)가 그 구멍을 메운다. 변이 L 은 같은 검증에서 드러난
 * 키 불변 층의 거짓 단언(주석을 세던 호출 카운트)을 겨냥한다.
 *
 * **P2 는 층 하나(`approval-boundary`)를 세웠고 변이 M 을 함께 넣는다** — 같은 실수를 두 번 하지 않는다.
 *
 * 각 패치는 **정확히 한 단언을 겨냥한다.** 패치를 적용했는데 그 단언이 통과하면
 * 그 층은 잠들어 있는 것이고, CI 는 그것을 실패로 보고한다.
 *
 * 패치가 겨냥한 층 **외의** 층이 함께 실패하는 것은 정상이다(예: 새 진입점 파일은
 * Layer C 에도 걸린다). 따라서 판정 기준은 "스위트가 실패했다"가 아니라
 * **"겨냥한 테스트가 실패했다"** 이다 — `targetTest` 가 그 판정의 유일한 근거다.
 * 이 구분이 없으면 "아무 이유로든 빨간불"이 통과 근거가 되어, Layer F 자신이 공허해진다.
 *
 * **`targetTest` 는 vitest JSON 리포트의 `fullName` 에 대한 부분 문자열이다.**
 * 이전 판정은 정규식을 **vitest stdout 전체**에 걸었는데, 기본 리포터가 300ms 를 넘는
 * **통과한** 테스트의 이름도 출력하기 때문에 표적 테스트가 green 인 채로도 매칭됐다.
 * 실제로 Layer B 정방향 단언을 `if (false && ...)` 로 무력화해도 변이 B 가 "잡혔다"로
 * 판정됐다 — 같은 변이가 Layer C 를 대신 실패시켰기 때문이다. 문자열은 stdout 이
 * 아니라 **그 테스트의 status 에만** 걸어야 한다.
 *
 * 러너는 기동 시 두 가지를 더 확인한다: 표적 이름이 서로 포함 관계가 아닐 것,
 * 그리고 각 표적이 **기준선 실행에 실제로 존재하는 테스트 정확히 1개**와 매칭될 것.
 */

export interface MutationFile {
  /** 리포 루트 기준 경로. 이미 있으면 내용을 덮고, 되돌릴 때 원본을 복원한다. */
  readonly path: string;
  readonly content: string;
}

export interface Mutation {
  readonly id: string;
  /**
   * 겨냥하는 층.
   *
   * `'K'` 는 §5.0 의 A–E 가 아니라 **§5.0b 의 키 불변 chokepoint**
   * (`test/arch/keypair-immutability.arch.test.ts`, AC-13)다. 같은 러너가 판정하지만
   * 증명하는 명제가 다르므로 이름을 나눈다 — "Layer F 가 A–E 를 덮는다" 는 문장이
   * 조용히 "전부를 덮는다" 로 읽히지 않게 하기 위해서다.
   *
   * `'OP'`·`'OA'` 는 P1c 의 관측 두 층이다 — PII 규율
   * (`test/arch/observability-pii.arch.test.ts`)과 알람 동결표
   * (`test/arch/observability-alarms.arch.test.ts`). 같은 이유로 이름을 나눈다:
   * 한 글자로 묶으면 "관측을 덮는다" 가 되고, 실제로 덮이는 것은 둘 중 하나뿐일 수 있다.
   *
   * `'AP'` 는 P2 의 승인 경계 층(`test/arch/approval-boundary.arch.test.ts`) — "만료·거절 경로의
   * 전이적 import 폐포에 관문이 없다"(§3.4 4조, auto-send 불허).
   *
   * `'ST'` 는 P4 의 Sender Trust 선언 전용 신호 층(`test/arch/security-trust.arch.test.ts`, §4B.4 AC-f1).
   *
   * `'SB'` 는 P4 의 보안 경계 층(`test/arch/security-boundary.arch.test.ts`) — `src/security/**` 의 LLM SDK·
   * 네트워크 0건과 injection 스캐너의 순수성.
   *
   * `'BL'` 은 WP-2 의 결제 경계 층(`test/arch/billing-boundary.arch.test.ts` · 송출 허용 목록) — 웹훅 λ 의 DB 0 · 서명 상수 시간 비교 ·
   * 웹훅 역할의 VPC·관리형 정책 0 · SQS SDK 한 파일(변이 `BL-1`~`BL-4`).
   *
   * `'VB'` 는 메일 기본기 1차의 인증코드 추출 경계 층(`test/arch/verification-boundary.arch.test.ts`, AC-A1-7) — 관문·정책·발송·승인·
   * 워커의 폐포에 `src/mail/verification/**` 0(변이 `VB-1`). 같은 1차의 `policy_blocked` 리터럴 부재(`inbound-visibility` ⑤)는 `'SB'`,
   * 예약 취소 경로 리터럴(`mcp-adapter` ⑤-2)은 `'C'` 를 재사용한다.
   */
  readonly targetLayer: 'A' | 'B' | 'C' | 'D' | 'E' | 'K' | 'OP' | 'OA' | 'AP' | 'ST' | 'SB' | 'BL' | 'VB';
  readonly description: string;
  readonly files: readonly MutationFile[];
  /**
   * 기존 파일의 문자열 치환. 앵커가 없으면 러너가 즉시 에러를 낸다 —
   * 매니페스트 모양이 바뀌었는데 패치가 조용히 no-op 이 되는 것을 막는다.
   */
  readonly replacements?: readonly { readonly path: string; readonly find: string; readonly replace: string }[];
  /**
   * 겨냥한 **테스트 제목**(또는 그 고유한 일부). 이 이름의 테스트가
   * `status === 'failed'` 여야 "겨냥한 층이 잡았다"로 판정한다.
   * 정규식이 아니라 리터럴이다 — `kind:"http"` 같은 제목을 이스케이프 없이 그대로 쓴다.
   */
  readonly targetTest: string;
}

/**
 * 관문 스텁 — 변이 D 가 `src/policy/gate.ts` 를 이걸로 덮어 진입점이 관문을 지나게 만든다.
 *
 * **이 스텁은 Layer B 역방향 단언을 만족시키지 않는다.** 예전에는 `auditWrite(evaluate())`
 * 로 그 단언을 *만족시키도록* 설계돼 있었는데, 그 설계가 가능했다는 사실 자체가
 * 역방향 단언이 문자열 매칭이었다는 증거였다(지금은 `engine.evaluate` 와 `AuditSink.record`
 * 를 식별자 해석으로 판정한다). 그래서 변이 D 실행에서는 Layer B 역방향 단언도 함께
 * 빨간불이 된다 — **겨냥한 층 외의 층이 함께 실패하는 것은 정상**이고, 판정은 변이 D 의
 * `targetTest`(Layer D) 하나만 본다.
 */
const GATE_STUB = `// Layer F 변이 픽스처. 러너가 되돌린다. 커밋되면 안 된다.
export function dispatch(): string {
  return 'denied';
}
`;

export const MUTATIONS: readonly Mutation[] = [
  {
    id: 'A-ses-import-outside-transport',
    targetLayer: 'A',
    description: '허용되지 않은 파일에서 SES SDK 를 직접 import 한다',
    files: [
      {
        path: 'src/api/routes/mutation-ses-import.ts',
        content: `// Layer F 변이 픽스처.
import { SESv2Client } from '@aws-sdk/client-sesv2';
export const client = new SESv2Client({});
`,
      },
    ],
    targetTest: 'SES SDK 를 정적 import 하는 파일은 허용 목록뿐이다',
  },
  {
    id: 'B-transport-referenced-outside-gate',
    targetLayer: 'B',
    description: '관문 밖(워커)에서 전송단의 send 를 직접 참조한다',
    files: [
      {
        path: 'src/mail/transport/ses-transport.ts',
        content: `// Layer F 변이 픽스처. SDK 는 부르지 않는다 — Layer A 와 표적을 섞지 않기 위해서다.
export const sesTransport = {
  send(payload: string): string {
    return payload;
  },
};
`,
      },
      {
        path: 'src/workers/mutation-rogue-sender.ts',
        content: `// Layer F 변이 픽스처.
import { sesTransport } from '../mail/transport/ses-transport';
export function run(): string {
  return sesTransport.send('rogue');
}
`,
      },
    ],
    targetTest: '전송단의 export 를 참조하는 프로덕션 파일은 관문뿐이다',
  },
  {
    id: 'C-unregistered-entrypoint',
    targetLayer: 'C',
    description: '매니페스트에도 허용목록에도 없는 진입점 파일을 추가한다',
    files: [
      {
        path: 'src/api/routes/mutation-unregistered.ts',
        content: `// Layer F 변이 픽스처.
export function handle(): string {
  return 'ok';
}
`,
      },
    ],
    targetTest: '모든 진입점 파일은 등록 또는 허용목록 중 정확히 하나에 속한다',
  },
  {
    id: 'D-http-route-without-idempotency-key',
    targetLayer: 'D',
    description: 'Idempotency-Key 를 요구하지 않는 http 경로를 매니페스트에 등록한다',
    files: [
      { path: 'src/policy/gate.ts', content: GATE_STUB },
      {
        path: 'src/api/routes/mutation-unkeyed.ts',
        content: `// Layer F 변이 픽스처. 관문은 지나므로 Layer C 는 통과하고, §4.5 위반만 남는다.
import { dispatch } from '../../policy/gate';
export function handle(): string {
  return dispatch();
}
`,
      },
    ],
    replacements: [
      {
        // **앵커는 배열의 여는 줄이다 (P1b 정정).** 이전 앵커는
        // `... = [];` **빈 배열 한 줄**이었는데, 그 문자열은 매니페스트에 첫 경로가
        // 등록되는 순간 사라진다 — 즉 P1b 의 첫 커밋에서 러너가 "앵커를 찾지 못했다"로
        // 죽게 돼 있었다. 그 결합은 이 변이가 겨냥하는 명제(§4.5-1)와 아무 상관이 없고,
        // 매니페스트가 빈 동안에만 성립하는 우연이었다.
        //
        // 여는 줄에 걸면 **미등록 http 경로를 맨 앞에 끼워 넣는** 형태가 되어, 경로가
        // 몇 개든 변이의 뜻이 같다: "Idempotency-Key 를 요구하지 않는 http 경로가
        // 매니페스트에 있다." 겨냥 테스트(Layer D)도 그대로다.
        path: 'src/policy/manifest.ts',
        find: 'export const OUTBOUND_ROUTES: readonly OutboundRoute[] = [',
        replace: `export const OUTBOUND_ROUTES: readonly OutboundRoute[] = [
  {
    id: 'mutation_unkeyed',
    kind: 'http',
    file: 'src/api/routes/mutation-unkeyed.ts',
    ref: 'POST /v1/mutation/unkeyed',
  } as unknown as OutboundRoute,`,
      },
    ],
    targetTest: 'kind:"http" 경로는 전부 Idempotency-Key 를 요구한다',
  },
  {
    id: 'E-extra-ses-sending-principal',
    targetLayer: 'E',
    description: 'ses:SendEmail 을 허용하는 IAM 역할을 synth 산출물에 추가한다',
    files: [
      {
        path: 'cdk.out/MutationRogue.template.json',
        content: `${JSON.stringify(
          {
            Resources: {
              RogueSenderRole: {
                Type: 'AWS::IAM::Role',
                Properties: {
                  AssumeRolePolicyDocument: {
                    Statement: [
                      {
                        Effect: 'Allow',
                        Principal: { Service: 'lambda.amazonaws.com' },
                        Action: 'sts:AssumeRole',
                      },
                    ],
                  },
                  Policies: [
                    {
                      PolicyName: 'RogueSend',
                      PolicyDocument: {
                        Statement: [{ Effect: 'Allow', Action: ['ses:SendEmail'], Resource: '*' }],
                      },
                    },
                  ],
                },
              },
            },
          },
          null,
          2,
        )}\n`,
      },
    ],
    targetTest: '발송 권한 주체 집합이 기대 집합과 정확히 일치한다',
  },
  {
    id: 'F-gate-skips-audit-record',
    targetLayer: 'B',
    description: '관문의 dispatch 에서 audit 기록 호출을 들어낸다 (Layer B 역방향 단언 표적)',
    files: [],
    replacements: [
      {
        // 앵커는 **한 줄**이다. 인자 블록까지 통째로 잡으면 gate.ts 의 포맷이 바뀌는 날
        // 변이가 조용히 no-op 이 되는 대신 러너가 에러를 내긴 하지만, 그 에러가
        // 잦아지면 변이가 주석 처리되는 쪽으로 기운다. 호출 자체만 바꾼다.
        path: 'src/policy/gate.ts',
        find: 'await deps.audit.record({',
        replace: 'await mutationSkippedAudit({',
      },
    ],
    // **P1a 에서 이 변이가 처음으로 역방향 단언을 겨냥한다.** 그전까지 역방향 단언은
    // 어떤 변이의 표적도 아니었고, 게다가 `gate.ts` 파일 전체의 호출식 텍스트를
    // `/audit/i` 로 훑었기 때문에 `send()` 의 `deps.audit.resolve` 에 매칭돼
    // **dispatch 에서 audit.record 를 통째로 지워도 통과했다.**
    targetTest: 'gate.dispatch 는 평가와 audit 기록을 모두 호출한다',
  },
  {
    id: 'G-transport-referenced-from-new-test-file',
    targetLayer: 'B',
    description: '`test/` 아래 새 파일이 전송단을 직접 참조한다 (Layer B 테스트 허용목록 표적)',
    files: [
      {
        // **`.test.ts` 가 아니다.** vitest 수집 대상이 되면 이 픽스처가 자기 이름으로
        // 실패하거나 통과해 판정을 흐린다. 여기서 검사하는 것은 **참조의 존재**뿐이다.
        path: 'test/integration/outbound/support/mutation-transport-referrer.ts',
        content: `// Layer F 변이 픽스처. 러너가 되돌린다. 커밋되면 안 된다.
import { createSesTransport } from '../../../../src/mail/transport/ses-transport';
export const rogueAssembly = createSesTransport;
`,
      },
    ],
    // **P1b 에서 이 변이가 처음으로 테스트 쪽 허용목록을 겨냥한다.** 그전까지 Layer B 는
    // \`relative.startsWith('test/')\` 로 `test/**` 전체를 통과시켰고, 바로 위 크기 단언은
    // 그 와일드카드를 세지 않았다. 즉 **실발송 조립 루트가 `test/` 아래 있다는 사실에
    // 대해 CI 가 아무 말도 하지 않았다.** 변이가 수정보다 먼저 값싸다는 말의 실례다.
    targetTest: '전송단을 참조하는 test 파일은 이름으로 허용된 것뿐이다',
  },
  {
    id: 'H-keypair-rotation-outside-issuer',
    targetLayer: 'K',
    description: '`keypair.ts` 밖에서 `agent_keypairs` 의 public_key·key_ref 를 UPDATE 하는 회전 함수를 추가한다',
    files: [
      {
        // **`src/passport/` 에 둔다.** `src/api/routes/`·`src/workers/` 에 두면 Layer C
        // 까지 함께 빨간불이 되고, 그 자체는 정상이지만(겨냥한 층 외의 실패) 이 변이가
        // 무엇을 증명하는지가 흐려진다. 여기는 분할 대상 디렉터리가 아니므로
        // **키 불변 층만** 반응한다.
        path: 'src/passport/mutation-keypair-rotator.ts',
        content: `// Layer F 변이 픽스처. 러너가 되돌린다. 커밋되면 안 된다.
import type { AgentId } from '../db/schema';

/**
 * 침해 대응 시 가장 자연스러운 동작 — 그리고 §4B.1 이 "가장 위험한 구멍"이라 부른 것.
 * 공개키는 그대로 두고 Secrets Manager 포인터만 교체하면 겉보기엔 아무것도 안 바뀌었는데
 * 발급된 전 서명이 조용히 무효화된다.
 */
export async function rotateAgentKeyRef(
  client: { query(text: string, values: unknown[]): Promise<unknown> },
  agentId: AgentId,
  keyRef: string,
): Promise<void> {
  await client.query('UPDATE agent_keypairs SET key_ref = $2 WHERE agent_id = $1', [agentId, keyRef]);
}
`,
      },
    ],
    // **표적은 SQL 단언 하나다.** 이 픽스처는 회전 *이름*(rotate…) 단언에도 걸리지만,
    // 판정 단위는 `targetTest` 하나이므로 그 중복은 판정을 흐리지 않는다 — 오히려
    // 두 단언이 독립적으로 같은 위반을 덮고 있다는 뜻이다.
    targetTest: '`agent_keypairs` 에 UPDATE·DELETE 하는 SQL 은 src 전체에 0건이다',
  },
  {
    id: 'I-log-fields-spread-at-callsite',
    targetLayer: 'OP',
    description: '관측 호출부의 필드 리터럴에 스프레드를 넣는다 (닫힌 어휘를 타입 수준에서 뚫는 형태)',
    files: [
      {
        // **`src/identity/` 에 둔다.** `ARCH_PARTITIONED_DIRS`(`src/api/routes`,
        // `src/workers`)가 아니므로 Layer C 는 반응하지 않고, 관문·전송단·키를
        // 건드리지 않으므로 B·K 도 조용하다. 변이 H 가 `src/passport/` 를 고른 것과
        // 같은 이유다 — 겨냥한 층 외의 빨간불은 정상이지만, 그 소음이 많을수록
        // 이 변이가 무엇을 증명하는지가 흐려진다.
        path: 'src/identity/mutation-log-spread.ts',
        content: `// Layer F 변이 픽스처. 러너가 되돌린다. 커밋되면 안 된다.
import { log } from '../observability/logger';

/** \`{ ...error }\` 한 줄이면 오류 객체의 모든 필드가 로그로 간다. */
export function reportMutation(extra: Record<string, string>): void {
  log('info', 'mutation.spread', { route_id: 'send', ...extra });
}
`,
      },
    ],
    targetTest: '필드 리터럴에 스프레드가 없다 — 닫힌 어휘를 타입 수준에서 뚫는 유일한 구멍이다',
  },
  {
    id: 'J-log-fields-hoisted-bag',
    targetLayer: 'OP',
    description: '필드 가방을 변수로 올려 넘긴다 (스프레드·계산된 키·어휘 단언 셋을 동시에 우회하는 형태)',
    files: [
      {
        path: 'src/identity/mutation-log-hoisted-bag.ts',
        content: `// Layer F 변이 픽스처. 러너가 되돌린다. 커밋되면 안 된다.
import { log } from '../observability/logger';

/**
 * **P1c 검증이 실제로 지적한 형태다.** 가방이 인라인 리터럴이 아니므로 ③의 세 단언은
 * 볼 것이 없고, \`redact\` 가 비스칼라를 통과시키던 동안에는 이것이 배달 수단이었다.
 */
export function reportMutation(): void {
  const bag = { route_id: 'send', detail: 'hoisted out of the call' };
  log('info', 'mutation.hoisted', bag);
}
`,
      },
    ],
    targetTest: '필드 가방은 인라인 객체 리터럴이다 — 변수로 올리면 아래 세 단언이 전부 우회된다',
  },
  {
    id: 'K-alarm-gate-silence-missing-data',
    targetLayer: 'OA',
    description: '`atmark-gate-silence` 의 결측 처리를 BREACHING → NOT_BREACHING 으로 뒤집는다',
    files: [],
    replacements: [
      {
        // **알람 6의 심장이 이 한 글자다.** 나머지 다섯은 카운터라 결측을
        // `notBreaching` 으로 두지만, 6번은 "방출이 멈췄다" 자체를 보는 알람이다.
        // `notBreaching` 이 되는 순간 **관문이 통째로 죽어도 알람은 영원히 조용하다** —
        // 그리고 그 상태는 `cdk:synth` 도 typecheck 도 통과한다. 리뷰에서 한 글자로 지나간다.
        //
        // 앵커에 앞선 `.` 이 있어야 한다: `TreatMissingData.NOT_BREACHING` 은
        // `TreatMissingData.BREACHING` 을 포함하지 않으므로 나머지 다섯과 헷갈리지 않는다.
        path: 'infra/cdk/stacks/observability-stack.ts',
        find: 'treatMissingData: cloudwatch.TreatMissingData.BREACHING,',
        replace: 'treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,',
      },
    ],
    targetTest: 'atmark-gate-silence — 메트릭·임계값·비교·기간·결측처리가 동결값과 같다',
  },
  {
    id: 'L-custody-local-single-production-guard',
    targetLayer: 'K',
    description: '`custody-local.ts` 의 운영 가드 호출 하나(store 쪽)를 들어낸다',
    files: [],
    replacements: [
      {
        // **이 변이가 P1c 검증의 [MINOR] 를 못 박는다.** 예전 판정은
        // `/assertNotProduction\\(/g` 를 파일 **전문**에 걸었고 매칭 3개 중 하나가
        // 머리말 주석이었다 — 이 치환을 넣어도 2가 남아 **통과했다.** 즉 그 단언은
        // 자신의 존재 이유("하나만 부르는 상태의 검출")에 대해 거짓이었다.
        // 지금은 호출식을 센다.
        path: 'src/passport/custody-local.ts',
        find: "assertNotProduction('createLocalDevKeyCustody().store', env);",
        replace: 'void env;',
      },
    ],
    targetTest: '`custody-local.ts` 가 운영 가드를 **두 번** 부른다 (팩토리 + store)',
  },
  {
    id: 'M-approval-service-reaches-gate',
    targetLayer: 'AP',
    description: '승인 상태 전이 모듈이 관문을 런타임 import 한다 — 만료·거절 경로가 발송에 닿을 수 있게 된다',
    files: [],
    replacements: [
      {
        // **직접 import 한 줄이면 충분하다.** Layer C 는 이 파일을 보지 않는다(`src/approval/` 는
        // `ARCH_PARTITIONED_DIRS` 밖이다) — 그래서 스위퍼(`workers/approval-expiry`)는 Layer C 에서
        // 여전히 "관문을 import 하지 않는 비발송 진입점" 으로 초록이다. 그 한 단계 간접을 잡는 것이
        // 겨냥한 층의 존재 이유이고, 이 변이가 그 층이 깨어 있는지를 본다.
        path: 'src/approval/service.ts',
        // 앵커는 관측 import 줄이다 — 2026-09-23 A-fix 가 정책 import(`normalizeAddress` → `comparableAddress`)를 바꿔
        // 옛 앵커가 사라졌고, 러너가 "적용 실패" 로 멈췄다(잡았다로 넘어가지 않는 것이 맞는 동작이다).
        find: "import { log } from '../observability/logger';",
        replace:
          "import { log } from '../observability/logger';\nimport { unserialized } from '../policy/gate';\nexport const mutationReachesGate = unserialized;",
      },
    ],
    targetTest: 'src/approval/service.ts 의 런타임 import 폐포에 관문·전송단이 없다',
  },
  {
    id: 'N-approval-link-assembly-reaches-gate',
    targetLayer: 'AP',
    description: '매직링크 결정의 트랜잭션 조립이 관문을 런타임 import 한다 — "승인 = 즉시 발송" 경로가 열린다',
    files: [],
    replacements: [
      {
        // **P2 T1.** 매직링크 라우트(`api/routes/approval-link.ts`)는 Layer C 가 직접 import 를 보지만,
        // 결정 트랜잭션을 조립하는 이 저장소는 `src/db/` 라 Layer C 밖이다. 여기서 관문을 부르면 승인이
        // 릴리스 워커의 재평가(kill-switch·억제·캡)를 건너뛰고 곧장 발송할 수 있게 된다. 그 한 단계를
        // 겨냥한 층(승인 경계의 전이적 폐포)이 깨어 있는지를 본다.
        path: 'src/db/repositories/approval-link-use-store.ts',
        find: "import { selectRow, selectRows } from './rows';",
        replace:
          "import { selectRow, selectRows } from './rows';\nimport { unserialized } from '../../policy/gate';\nexport const mutationReachesGate = unserialized;",
      },
    ],
    targetTest: 'src/db/repositories/approval-link-use-store.ts 의 런타임 import 폐포에 관문·전송단이 없다',
  },
  {
    id: 'O-notifier-exports-recipient-parameter',
    targetLayer: 'B',
    description: '소유자 알림 모듈에 수신자를 인자로 받는 export 를 추가한다 — 관문 밖 발송면이 에이전트 메일의 우회로가 된다',
    files: [],
    replacements: [
      {
        // **P2 T2.** 알림 모듈은 Layer B 의 전송단 참조 허용목록에 이름으로 올라 있다 — 그 대가가 "공개 API 는
        // approvalId 하나" 다. 수신자·본문을 받는 export 가 하나라도 생기면 그 함수는 관문을 거치지 않고
        // 아무에게나 메일을 보내는 문이다. 인자의 이름·타입을 추측하지 않고 **호출 가능한 export 의 존재**를
        // 막는 단언이 깨어 있는지를 본다(export 동결 목록 단언도 함께 빨개지는 것은 정상이다).
        path: 'src/notify/approval-notifier.ts',
        find: 'export function createApprovalNotifier(',
        replace:
          'export async function notifyRecipient(recipient: string, approvalId: string): Promise<string> {\n' +
          '  return `${recipient}:${approvalId}`;\n' +
          '}\n\n' +
          'export function createApprovalNotifier(',
      },
    ],
    targetTest: '알림 모듈에서 호출 가능한 export 는 createApprovalNotifier 하나이고 인자는 의존성 하나다',
  },
  {
    id: 'P-entrypoint-reaches-notifier-outside-system-mail',
    targetLayer: 'C',
    description: '시스템 메일 범주가 아닌 진입점이 소유자 알림 모듈을 import 한다 — outbox·속도 상한 밖의 두 번째 입구',
    files: [
      {
        path: 'src/workers/mutation-notify-bypass.ts',
        content: `// Layer F 변이 픽스처. 워커가 알림기를 직접 쥐고 approvalId 를 골라 부른다.
import type { ApprovalNotifier } from '../notify/approval-notifier';
export function run(notifier: ApprovalNotifier, approvalId: string): Promise<string> {
  return notifier.notify(approvalId);
}
`,
      },
    ],
    targetTest: '시스템 메일 발송 모듈을 import 하는 진입점은 시스템 메일 범주뿐이다',
  },
  {
    id: 'Q-naive-passport-collector',
    targetLayer: 'ST',
    description: '수집기 없이 선언만 된 passport_verified 신호를 만드는 순진한 수집기를 추가한다 — 판정 의미 없이 신뢰 입력이 생긴다',
    files: [
      {
        // **P4 Sender Trust.** §4B.4 가 경계하는 미래 — DID 를 보고 "검증됐다" 신호를 만드는 코드. 단위 테스트는
        // 기존 수집기만 보므로 새 파일의 생산자를 모른다. 파일을 가리지 않는 값-위치 단언이 깨어 있는지를 본다.
        path: 'src/security/mutation-passport-collector.ts',
        content: `// Layer F 변이 픽스처. 발신자 DID 를 받아 곧장 passport 신호를 만든다.
import type { TrustSignal } from './trust-signals';
export function collectPassport(did: string): TrustSignal {
  return { kind: 'passport_verified', did };
}
`,
      },
    ],
    targetTest: 'src/** 어디에도 passport_verified 신호를 값으로 만드는 코드가 없다',
  },
  {
    id: 'R-security-imports-llm-sdk',
    targetLayer: 'SB',
    description: 'src/security 에 LLM SDK 를 import 하는 파일을 넣는다 — 결정론적 판정기가 탈취 가능한 판정기가 된다',
    files: [
      {
        path: 'src/security/mutation-llm-judge.ts',
        content: `// Layer F 변이 픽스처. 패키지가 설치돼 있지 않아도 import 선언만으로 층이 잡아야 한다.
import Anthropic from '@anthropic-ai/sdk';
export const judge = Anthropic;
`,
      },
    ],
    targetTest: 'src/security 의 어떤 파일도 LLM SDK 를 import 하지 않는다',
  },
  {
    id: 'S-security-naive-did-fetch',
    targetLayer: 'SB',
    description: 'src/security 에서 전역 fetch 로 외부 문서를 받는다 — 계획이 봉쇄하려는 "순진한 동기 DID fetch"(SSRF)',
    files: [
      {
        path: 'src/security/mutation-did-fetch.ts',
        content: `// Layer F 변이 픽스처. network-egress 층도 함께 빨개지는 것은 정상이다.
export async function resolveDid(url: string): Promise<unknown> {
  return (await fetch(url)).json();
}
`,
      },
    ],
    targetTest: 'src/security 의 어떤 파일도 네트워크 원시 모듈·전역 송출 API 를 쓰지 않는다',
  },
  {
    id: 'T-injection-scanner-reads-files',
    targetLayer: 'SB',
    description: 'injection 스캐너 디렉터리에서 파일 시스템을 import 한다 — 판정이 인자 밖의 것(예: 코퍼스)에 기댈 수 있게 된다',
    files: [
      {
        path: 'src/security/injection/mutation-fs.ts',
        content: `// Layer F 변이 픽스처.
import { readFileSync } from 'node:fs';
export const read = readFileSync;
`,
      },
    ],
    targetTest: 'injection 스캐너는 자기 디렉터리와 node:crypto 만 import 한다(순수 함수 묶음)',
  },
  // ---- P4 통합: sender_marks 쓰기 표면 · Stage 7 분리 (test/arch/sender-marks-surface.arch.test.ts) ----
  // 'ST' 층을 재사용한다 — 같은 Sender Trust 경계의 다른 면이다(선언 전용 신호 ↔ 수동 분류의 쓰기 표면).
  {
    id: 'U-route-writes-sender-marks',
    targetLayer: 'ST',
    description:
      'HTTP 라우트가 recordSenderMark 를 import 한다 — 에이전트 토큰으로 seen 을 올리는 경로(에이전트가 자기 신뢰를 올린다)',
    files: [
      {
        path: 'src/api/routes/mutation-sender-marks.ts',
        content: `// Layer F 변이 픽스처. Layer C(미분류 진입점)도 함께 빨개지는 것은 정상이다.
import { recordSenderMark } from '../../db/repositories/sender-marks-store';
export const markSeen = recordSenderMark;
`,
      },
    ],
    targetTest: '① recordSenderMark 를 가져다 쓰는 프로덕션 파일은 공유 연산 하나이고, 그 연산을 부르는 곳은 소유자 표면 둘(CLI·관리 API)뿐이다',
  },
  {
    id: 'V-stage7-reads-sender-marks',
    targetLayer: 'ST',
    description:
      'Stage 7 의 관계 조회가 sender_marks 를 함께 읽는다 — 수신 신뢰(seen)가 승인 없는 발신 허가가 된다',
    files: [],
    replacements: [
      {
        path: 'src/db/repositories/policy-source.ts',
        find: "(scope = 'recipient' AND address = ANY($2::text[]))",
        replace:
          "(scope = 'recipient' AND address = ANY($2::text[]))\n             OR EXISTS (SELECT 1 FROM sender_marks m WHERE m.agent_id = $1 AND m.address = ANY($2::text[]))",
      },
    ],
    targetTest: '③ Stage 7 의 소스(src/policy/**, policy-source.ts)는 sender_marks 를 모른다',
  },
  // ---- P3c: 격리 메일의 에이전트 컨텍스트 제외 (test/arch/inbound-visibility.arch.test.ts) ----
  // 'SB' 층을 재사용한다 — 보안 경계의 다른 면이다(스캐너의 순수성 ↔ 스캐너 판정이 에이전트 표면에서 지켜지는가).
  {
    id: 'W-read-store-drops-quarantine-predicate',
    targetLayer: 'SB',
    description:
      '에이전트 수신 목록 조회가 visibleToAgent 술어를 뺀다 — 격리(injection high·판정 없음) 메일이 에이전트 컨텍스트에 들어간다',
    files: [],
    replacements: [
      // 목록 조회는 2026-10-06(AI 감시 since 겹침)부터 UNION ALL 가지들 + 바깥 재확인(2026-10-08 풀린 메일 가지 추가) — 모든 곳에서 술어를 뺀다(한 곳만 빼면 나머지가 지켜 변이가 의미 없다).
      {
        path: 'src/db/repositories/inbound-read-store.ts',
        find: "WHERE a.agent_id = $1 AND ${visibleToAgent('a')} AND ${releasedToAgent('a')}",
        replace: "WHERE a.agent_id = $1 AND ${releasedToAgent('a')}",
      },
      {
        path: 'src/db/repositories/inbound-read-store.ts',
        find: "b.agent_id = $1 AND ${visibleToAgent('b')} AND ${releasedToAgent('b')}",
        replace: "b.agent_id = $1 AND ${releasedToAgent('b')}",
      },
      // 셋째 가지(2026-10-08 — 소유자가 풀어 준 메일의 since 겹침, `released_at >= since`).
      {
        path: 'src/db/repositories/inbound-read-store.ts',
        find: "c.agent_id = $1 AND ${visibleToAgent('c')} AND ${releasedToAgent('c')}",
        replace: "c.agent_id = $1 AND ${releasedToAgent('c')}",
      },
      {
        path: 'src/db/repositories/inbound-read-store.ts',
        find: "LIMIT $4))\n            AND ${visibleToAgent('m')} AND ${releasedToAgent('m')}",
        replace: "LIMIT $4))\n            AND ${releasedToAgent('m')}",
      },
    ],
    targetTest: '① inbound-read-store 의 inbound_messages 조회는 전부 visibleToAgent 술어(또는 그 위의 countedAsQuarantine)를 품는다',
  },
  {
    id: 'X-forward-reads-raw-inbound-store',
    targetLayer: 'SB',
    description:
      'forward 가 원시 수신 저장소(inbound-store)를 import 한다 — 격리 행을 거르지 않는 조회로 원 메일을 찾을 수 있게 된다',
    files: [],
    replacements: [
      {
        path: 'src/api/routes/forward.ts',
        find: "import type { InboundReadStore } from '../../db/repositories/inbound-read-store';",
        replace:
          "import type { InboundReadStore } from '../../db/repositories/inbound-read-store';\nimport { createPostgresInboundVerdictLookup } from '../../db/repositories/inbound-store';\nexport const rawLookup = createPostgresInboundVerdictLookup;",
      },
    ],
    targetTest: '② 에이전트 표면은 원시 수신 저장소를 import 하지 않고 inbound_messages SQL 을 직접 품지 않는다',
  },
  // ---- MCP 전송 어댑터 (test/arch/mcp-adapter.arch.test.ts, 2026-09-23) ----
  // 'C' 층을 재사용한다 — 같은 진입점 분할의 네 번째 범주(전송 어댑터)가 지키는 계약이다. 셋 다 Layer C 의 기존 단언
  // (직접 import)으로는 **잡히지 않는** 모양으로 골랐다: 간접 폐포·라우트 허용목록·주입 슬롯.
  {
    id: 'Y-mcp-reaches-transport-indirectly',
    targetLayer: 'C',
    description:
      'MCP 도구 표가 운영 조립 루트(composition)를 import 한다 — 관문을 직접 import 하지 않고도 전송단이 폐포에 들어온다(Layer C 초록)',
    files: [],
    replacements: [
      {
        path: 'src/mcp/tools.ts',
        find: "import { errorResult, renderResult, renderWarnedResult, type ExternalField, type ToolResult } from './render';",
        replace:
          "import { errorResult, renderResult, renderWarnedResult, type ExternalField, type ToolResult } from './render';\nimport { composeApi } from '../runtime/composition';\nexport const assemble = composeApi;",
      },
    ],
    targetTest: 'MCP 의 런타임 import 폐포(라우트 파일에서 멈춤)에 관문·전송단·시스템 메일 모듈·SES SDK 가 없다',
  },
  {
    id: 'Z-mcp-imports-owner-route',
    targetLayer: 'C',
    description: 'MCP 도구 표가 승인 결정 라우트(/approve)를 import 한다 — 에이전트가 injection 으로 자기 발송을 승인하는 도구의 입구',
    files: [],
    replacements: [
      {
        path: 'src/mcp/tools.ts',
        find: "import { handleGetThread } from '../api/routes/threads';",
        replace:
          "import { handleGetThread } from '../api/routes/threads';\nimport { handleApprovalLink } from '../api/routes/approval-link';\nexport const decide = handleApprovalLink;",
      },
    ],
    targetTest: 'MCP 가 닿는 라우트 파일은 에이전트 도구 허용목록과 정확히 같다 (소유자 권한 라우트 0)',
  },
  {
    id: 'AA-mcp-opens-transport-slot',
    targetLayer: 'C',
    description: 'MCP 가 주입받은 라우트 의존성의 전송단 슬롯을 연다 — import 없이 관문을 건너뛰어 전송단에 닿는 길',
    files: [],
    replacements: [
      {
        path: 'src/mcp/tools.ts',
        find: '      const response = await context.deps.send(routeRequest(context, { body, idempotencyKey: key.key }));',
        replace:
          '      void context.deps.send.transport;\n      const response = await context.deps.send(routeRequest(context, { body, idempotencyKey: key.key }));',
      },
    ],
    targetTest: '④ src/mcp 는 라우트 의존성의 발송 슬롯(transport·service)을 열지 않는다',
  },
  {
    id: 'AB-mcp-destructures-transport-slot',
    targetLayer: 'C',
    description: 'MCP 가 라우트 의존성의 전송단 슬롯을 **구조 분해로** 꺼낸다 — 속성 접근만 보던 ④ 가 놓치던 모양(검증 M4)',
    files: [],
    replacements: [
      {
        path: 'src/mcp/tools.ts',
        find: '      const response = await context.deps.send(routeRequest(context, { body, idempotencyKey: key.key }));',
        replace:
          '      const { transport: slot } = context.deps.send;\n      void slot;\n      const response = await context.deps.send(routeRequest(context, { body, idempotencyKey: key.key }));',
      },
    ],
    targetTest: '④-2 속성 접근 밖의 길도 없다',
  },
  {
    id: 'AC-router-passes-full-deps-to-mcp',
    targetLayer: 'C',
    description: '라우터가 /mcp 에 ApiDependencies 통째를 넘긴다 — 승인 링크·초안·예약 의존성이 MCP 손에 들어간다(검증 M4)',
    files: [],
    replacements: [
      {
        path: 'src/runtime/router.ts',
        // 2026-09-23 두 번째 검증 M2 뒤: 라우터는 `mcpDependenciesOf(d)`(함수뿐)를 넘긴다. 변이는 그 자리에 통째 객체를 섞는다.
        find: '    h(mcpDependenciesOf(d), { headers: r.api.headers, rawBody: r.rawBody }),',
        replace: '    h({ ...d, ...mcpDependenciesOf(d) } as never, { headers: r.api.headers, rawBody: r.rawBody }),',
      },
    ],
    targetTest: '⑤ 라우터는 MCP 에 함수만 넘긴다',
  },
  // ---- ADR-0006 로그인 메일 주체 분리 · admin DB 롤 (2026-09-23) ----
  // 'C' 층을 재사용한다(MCP 와 같은 이유) — admin-separation 은 진입점 분할의 권한 쪽 짝이다. E 는 Layer E 의 주체별 조건.
  {
    id: 'AD-login-mailer-bundles-runtime-composition',
    targetLayer: 'C',
    description:
      'login-mailer 핸들러가 운영 조립 루트(composition — 에이전트 전송단·S3·관문)를 import 한다 — 로그인 키를 쥔 Lambda 에 외부 입력 코드가 실린다',
    files: [],
    replacements: [
      {
        path: 'src/runtime/handlers/login-mailer.ts',
        find: "import { composeLoginMailer, type LoginMailerDependencies } from '../login-mailer-composition';",
        replace:
          "import { composeLoginMailer, type LoginMailerDependencies } from '../login-mailer-composition';\nimport { composeApi } from '../composition';\nexport const assemble = composeApi;",
      },
    ],
    targetTest: '⑤ login-mailer 번들: 운영 조립 루트·관문·S3·관리 코드가 없다',
  },
  {
    id: 'AE-admin-back-on-owner-role',
    targetLayer: 'C',
    description: 'admin 조립이 다시 소유자 DB 롤 비밀로 붙는다(H2 — DDL·GRANT·감사 트리거 DROP 이 가능한 롤)',
    files: [],
    replacements: [
      {
        path: 'src/runtime/admin-composition.ts',
        find: '  const adminRaw = await secrets.readSecretString(requireEnv(env, RUNTIME_ENV.dbAdminSecretArn));',
        replace: '  const adminRaw = await secrets.readSecretString(requireEnv(env, RUNTIME_ENV.dbMigrationSecretArn));',
      },
    ],
    targetTest: '③ 소유자 DB 롤 비밀을 읽는 조립은 migrate 둘뿐',
  },
  {
    id: 'AF-login-mailer-from-address-widened',
    targetLayer: 'E',
    description:
      '로그인 메일 역할의 발신 조건을 *@atmark.ai 로 넓힌다 — 주체 수는 그대로 2(집합 단언은 초록), 둘째 주체가 에이전트·알림 주소로도 보낼 수 있게 된다',
    files: [
      {
        path: 'cdk.out/AtmarkCompute.template.json',
        content: `${JSON.stringify(
          {
            Resources: Object.fromEntries(
              (['SesSenderRole', 'SesLoginMailerRole'] as const).flatMap((role) => [
                [
                  role,
                  {
                    Type: 'AWS::IAM::Role',
                    Properties: {
                      AssumeRolePolicyDocument: {
                        Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }],
                      },
                    },
                  },
                ],
                [
                  `${role}Policy`,
                  {
                    Type: 'AWS::IAM::Policy',
                    Properties: {
                      PolicyName: `${role}Policy`,
                      Roles: [{ Ref: role }],
                      PolicyDocument: {
                        Statement: [
                          {
                            Effect: 'Allow',
                            Action: ['ses:SendEmail', 'ses:SendRawEmail'],
                            Resource: ['arn:aws:ses:ap-northeast-2:123456789012:identity/atmark.ai'],
                            // 둘 다 `*@atmark.ai` — 로그인 메일 역할의 `StringEquals login@atmark.ai` 가 사라졌다.
                            Condition: { StringLike: { 'ses:FromAddress': '*@atmark.ai' } },
                          },
                        ],
                      },
                    },
                  },
                ],
              ]),
            ),
          },
          null,
          2,
        )}\n`,
      },
    ],
    targetTest: '모든 발송 문장은 주체·문장별 모양',
  },
  // ---- MCP 의존성 — 두 번째 적대 검증 M2 (test/arch/mcp-adapter.arch.test.ts ④-3·⑤·⑥, 2026-09-23) ----
  // 검증자의 두 우회(`(x as any).approve(...)`·`Object.values(deps…)`)를 그대로 옮긴 것 둘 + 라우터가 객체 칸을 되살리는 것 +
  // 도구와 라우트 칸의 짝이 어긋나는 것. 'C' 층을 재사용한다(위 MCP 변이와 같은 이유).
  {
    id: 'M2a-mcp-deps-any-cast',
    targetLayer: 'C',
    description: 'MCP 가 의존성을 any 로 캐스트해 승인 저장소의 approve 에 닿으려 한다 — 이름 기반 ④ 가 놓치던 모양(검증 M2)',
    files: [],
    replacements: [
      {
        path: 'src/mcp/tools.ts',
        find: '      const response = await context.deps.getApproval(routeRequest(context, {}), { approvalId });',
        replace:
          '      void (context.deps as any).approvals?.approvals?.approve;\n      const response = await context.deps.getApproval(routeRequest(context, {}), { approvalId });',
      },
    ],
    targetTest: '④-3 이름을 모르는 길도 없다',
  },
  {
    id: 'M2b-mcp-deps-object-values',
    targetLayer: 'C',
    description: 'MCP 가 Object.values 로 의존성 안을 훑는다 — 금지된 이름을 한 번도 쓰지 않고 전송단에 닿는 길(검증 M2)',
    files: [],
    replacements: [
      {
        path: 'src/mcp/tools.ts',
        find: '      const response = await context.deps.send(routeRequest(context, { body, idempotencyKey: key.key }));',
        replace:
          '      for (const slot of Object.values(context.deps)) void slot;\n      const response = await context.deps.send(routeRequest(context, { body, idempotencyKey: key.key }));',
      },
    ],
    targetTest: 'Reflect·Object.values·any 캐스트 0',
  },
  {
    id: 'M2c-router-mcp-object-slot',
    targetLayer: 'C',
    description: '라우터가 MCP 의존성에 객체 칸(approvals: d.approvals)을 되살린다 — 타입만 좁고 런타임 값은 통째인 예전 모양(검증 M2)',
    files: [],
    replacements: [
      {
        path: 'src/runtime/router.ts',
        find: '    getApproval: (request: ApiRequest, params: { readonly approvalId: string }) => handleGetApproval(d.approvals, request, params),',
        replace:
          '    getApproval: (request: ApiRequest, params: { readonly approvalId: string }) => handleGetApproval(d.approvals, request, params),\n    approvals: d.approvals,',
      },
    ],
    targetTest: '라우트 칸은 HTTP 라우트와 같은 handle*',
  },
  {
    id: 'M2d-mcp-tool-route-mismatch',
    targetLayer: 'C',
    description: 'send_email 의 route.handler 가 부르는 칸(send)과 다른 라우트 함수를 가리킨다 — 표 대조가 엉뚱한 라우트를 승인한다',
    files: [],
    replacements: [
      {
        path: 'src/mcp/tools.ts',
        find: "    route: { file: `${ROUTES}/send.ts`, handler: handleSend },",
        replace: "    route: { file: `${ROUTES}/send.ts`, handler: handleReply },",
      },
    ],
    targetTest: '⑥ 도구마다 route.handler 와',
  },
  // ---- 정책 v2(계약 v2 §1 · ADR-0007) — `test/arch/policy-v2.arch.test.ts` 를 겨냥한다 ----
  {
    id: 'PV1-allowlist-allows-off-list',
    targetLayer: 'D',
    description: '화이트리스트(allowlist_only)가 목록 밖 수신자를 허용한다 — 진윤겸 결정 ①(목록 밖은 그냥 막는다)의 반대',
    files: [],
    replacements: [
      {
        path: 'src/policy/rules/outbound-mode.ts',
        find: "        : toDeniedDecision(deny(['recipient_not_allowlisted']), stamp);",
        replace: "        : allowed(['allowlist_match'], stamp);",
      },
    ],
    targetTest: '① 화이트리스트는 목록 밖을 허용하지 않는다',
  },
  {
    id: 'PV2-inbound-allowlist-trusts-unauthenticated-from',
    targetLayer: 'D',
    description: '수신 화이트리스트가 DMARC 인증 없는 From 을 목록과 맞춘다 — 허락된 상대를 사칭하면 에이전트 컨텍스트에 들어온다',
    files: [],
    replacements: [
      {
        path: 'src/policy/inbound-policy.ts',
        find: "      if (!sender.authenticated) return quarantine('sender_not_allowlisted');",
        replace: '      void sender.authenticated;',
      },
    ],
    targetTest: '② 수신 화이트리스트는 인증되지 않은 From',
  },
  {
    id: 'PV3-inbound-policy-quarantine-visible-to-agent',
    targetLayer: 'D',
    description: '수신 정책이 막은 메일을 저장소가 격리로 쓰지 않는다 — 소유자가 막은 메일이 에이전트 API·MCP 에 보인다(결정 ③의 반대)',
    files: [],
    replacements: [
      {
        path: 'src/db/repositories/inbound-store.ts',
        find: "  if (record.policyBlocked !== null) return 'policy_blocked';",
        replace: '  // (변이) 정책 사유를 격리로 쓰지 않는다',
      },
    ],
    targetTest: '③ 정책 격리는 격리다',
  },
  // ---- 정책 v2 보정(202609241040 — POLICY V2 리뷰 M2·M3·L1·L2) — 같은 파일의 ⑥⑦⑧⑨ 를 겨냥한다 ----
  {
    id: 'PV4-recipient-shape-loose',
    targetLayer: 'D',
    description: '본문 파서가 수신자를 옛 넓은 모양(`[^@\\s]+@[^@\\s]+`)으로만 본다 — 따옴표 로컬파트·끝 점 도메인이 차단·억제를 비껴간다(M2)',
    files: [],
    replacements: [
      {
        path: 'src/api/outbound-http.ts',
        find: '  const malformed = recipients.filter((address) => !isOutboundRecipientAddress(address));',
        replace: '  const malformed = recipients.filter((address) => !isAddressShape(address));',
      },
    ],
    targetTest: '⑥ 발신 수신자는 dot-atom 만',
  },
  {
    id: 'PV5-gate-ignores-version-snapshot-lists',
    targetLayer: 'D',
    description: '관문이 버전 스냅샷의 목록을 판정 근거로 쓰지 않는다 — 스탬프된 버전과 판정이 갈라진다(M3, AC-9)',
    files: [],
    replacements: [
      {
        path: 'src/policy/policy-loader.ts',
        find: "  const outboundRules = snapshotContactRules(policyVersion.snapshot).filter((rule) => rule.direction === 'outbound');",
        replace: '  const outboundRules: readonly SnapshotRule[] = [];',
      },
    ],
    targetTest: '⑦ 관문의 목록은 버전 스냅샷에서',
  },
  {
    id: 'PV6-send-to-self-allowed',
    targetLayer: 'D',
    description: '자기 주소로 보내는 것을 막지 않는다 — "전체" 에서 자기 입력을 자기 컨텍스트로 되먹이는 루프가 열린다(L1)',
    files: [],
    replacements: [
      {
        path: 'src/policy/rules/identity.ts',
        find: "  if (ctx.attempt.recipients.some((recipient) => own.has(recipient))) return deny(['recipient_is_self']);",
        replace: '  void own;',
      },
    ],
    targetTest: '⑧ 자기 주소로는 어느 모드에서도',
  },
  {
    id: 'PV7-inbound-block-header-from-only',
    targetLayer: 'D',
    description: '수신 차단이 헤더 From 만 본다 — 차단된 상대가 From 을 바꿔 쓰고 자기 봉투로 보내 들어온다(L2)',
    files: [],
    replacements: [
      {
        path: 'src/policy/inbound-policy.ts',
        find: '  const mailboxes = [sender.address, sender.envelopeSender ?? null]',
        replace: '  const mailboxes = [sender.address, null]',
      },
    ],
    targetTest: '⑨ 수신 차단은 봉투 발신자',
  },
  // ── 신원(PP-B/PP-C) 2026-09-24 검증 반영 — Layer P3(§5.0b). 겨냥 층 표기는 같은 §5.0b 의 'K' 를 빌린다(타입을 넓히지 않고 끝에 더하기만) ──
  {
    id: 'PP1-public-identity-accepts-noncanonical-address',
    targetLayer: 'K',
    description: '공개 조회가 비정규 주소(대문자·공백)를 고쳐 받는다 — 변형마다 다른 CDN 캐시 키가 정지·폐기 뒤에도 옛 published 응답을 남긴다',
    files: [],
    replacements: [
      {
        path: 'src/passport/public-directory.ts',
        find: '  return ADDRESS_SHAPE.test(raw) ? raw : null;',
        replace: '  const address = raw.trim().toLowerCase();\n  return ADDRESS_SHAPE.test(address) ? address : null;',
      },
    ],
    targetTest: '⑥ 공개 조회는 비정규 주소를 고쳐 받지 않는다',
  },
  {
    id: 'PP2-revoked-did-document-keeps-keys',
    targetLayer: 'K',
    description: '폐기돼도 did.json 에 검증 수단을 남긴다 — 폐기 이전 JWS·침해된 키로 새로 만든 JWS 가 did.json 으로 계속 검증된다',
    files: [],
    replacements: [
      {
        path: 'src/passport/publisher.ts',
        find: "row.status === 'revoked' ? buildRevokedDidDocument(",
        replace: "row.status === ('never' as string) ? buildRevokedDidDocument(",
      },
    ],
    targetTest: '⑦ 폐기된 DID 의 did.json 에는 검증 수단이 없고',
  },
  {
    id: 'PP3-owner-policy-denial-counted-as-violation',
    targetLayer: 'K',
    description: '화이트리스트 밖 거부(소유자 정책이 일한 것)를 no_policy_violations 위반으로 센다 — 설계된 동작이 공개 "나쁜 행동" 표지가 된다',
    files: [],
    replacements: [
      {
        path: 'src/passport/attestations.ts',
        find: "  'recipient_ceiling_exceeded',\n];",
        replace: "  'recipient_ceiling_exceeded',\n  'recipient_not_allowlisted',\n];",
      },
    ],
    targetTest: '⑧ no_policy_violations 는 소유자 정책이 막은 거부를 세지 않는다',
  },
  // ── 투명성 로그(US-010 · ADR-0008 Phase A) — `test/arch/transparency-log.arch.test.ts`. 겨냥 층 표기는 같은 §5.0b 의 'K' 를 빌린다
  //    (타입을 넓히지 않고 끝에 더하기만 — PP 항목과 같은 규칙). ADR-0008 §5 의 변이 이름 J~N 을 그대로 쓴다 ──
  {
    id: 'TL-J-tlog-trigger-dropped',
    targetLayer: 'K',
    description: '원천 테이블(owner_actions)의 outbox 트리거를 뺀다 — 그 테이블의 행은 잎 없이 쌓이고 완결성이 조용히 깨진다',
    files: [],
    replacements: [
      {
        path: 'src/db/migrations/202609241600_transparency_log.sql',
        find: 'CREATE TRIGGER owner_actions_tlog_enqueue AFTER INSERT ON owner_actions FOR EACH ROW EXECUTE FUNCTION tlog_enqueue();',
        replace: '',
      },
    ],
    targetTest: '원천 테이블마다 AFTER INSERT outbox 트리거(tlog_enqueue)가 있다',
  },
  {
    id: 'TL-J2-new-audit-table-unlogged',
    targetLayer: 'K',
    description: '새 append-only 감사 테이블을 로그 대상에도 제외 목록에도 올리지 않는다 — 새 감사 표면이 로그 밖에서 태어난다',
    files: [
      {
        path: 'src/db/migrations/209912310000_mutation_unlogged_audit.sql',
        content: `-- Layer F 변이 픽스처. 러너가 지운다.
CREATE TABLE mutation_unlogged_audit (id uuid PRIMARY KEY);
CREATE TRIGGER mutation_unlogged_audit_no_delete BEFORE DELETE ON mutation_unlogged_audit FOR EACH ROW EXECUTE FUNCTION reject_row_delete();
`,
      },
    ],
    targetTest: 'append-only 테이블은 전부 로그 대상이거나 이름 붙은 제외 목록(사유)에 있다',
  },
  {
    id: 'TL-K-leaf-prefix-changed',
    targetLayer: 'K',
    description: 'RFC 9162 잎 해시 접두사 0x00 을 다른 값으로 — 두 번째 원상 공격 방어가 사라지고 외부 검증기와 루트가 갈라진다',
    files: [],
    replacements: [{ path: 'src/tlog/merkle.ts', find: 'export const LEAF_HASH_PREFIX = 0x00;', replace: 'export const LEAF_HASH_PREFIX = 0x02;' }],
    targetTest: '잎 해시 = SHA-256(0x00 ‖ data) · 노드 해시 = SHA-256(0x01 ‖ l ‖ r)',
  },
  {
    id: 'TL-L-pii-field-in-body',
    targetLayer: 'K',
    description: '수신 판정 잎의 보낸 사람 주소를 커밋이 아니라 평문(body)으로 싣는다 — 주소가 잎·번들에 그대로 남는다',
    files: [],
    replacements: [{ path: 'src/tlog/leaf.ts', find: "      builder.commit('from', event.fromAddress);", replace: "      builder.body['from'] = event.fromAddress;" }],
    targetTest: '모든 잎 종류 · 에폭 트리 잎 · 전역 잎에 센티넬 평문이 하나도 없다',
  },
  {
    id: 'TL-M-epoch-skips-unchanged-org',
    targetLayer: 'K',
    description: '에폭이 헤드 수 < 로그 수를 받아들인다(바뀐 조직만 담는다) — 조직을 조용히 빼도 아무도 모른다',
    files: [],
    replacements: [
      {
        path: 'src/tlog/epoch.ts',
        find: '  if (heads.length !== logs.length || heads.some((head, index) => head.log !== logs[index])) {',
        replace: '  if (heads.length > logs.length) {',
      },
    ],
    targetTest: '바뀐 조직만 담은 에폭(헤드가 로그보다 적다)은 epoch_incomplete',
  },
  {
    id: 'TL-N-inconsistent-checkpoint-signed',
    targetLayer: 'K',
    description: '직전 체크포인트와의 일관성을 보지 않고 서명한다 — 되감긴(분기한) 역사에 로그 키가 서명한다',
    files: [],
    replacements: [{ path: 'src/tlog/epoch.ts', find: '  if (input.previousRoot !== null) {', replace: "  if (input.previousRoot === ('never' as unknown)) {" }],
    targetTest: '되감긴(직전 체크포인트와 일관되지 않은) 역사에는 서명하지 않는다',
  },
  {
    id: 'TL-O-kms-sign-outside-checkpoint-signer',
    targetLayer: 'K',
    description: '체크포인트 서명기 밖에서 KMS Sign 을 부른다 — 로그 키로 서명하는 두 번째 경로',
    files: [
      {
        path: 'src/tlog/mutation-rogue-signer.ts',
        content: `// Layer F 변이 픽스처.
import { SignCommand } from '@aws-sdk/client-kms';
export const rogue = new SignCommand({ KeyId: 'x', Message: new Uint8Array(1), SigningAlgorithm: 'ED25519_SHA_512', MessageType: 'RAW' });
`,
      },
    ],
    targetTest: 'KMS SignCommand · GetPublicKeyCommand 를 import 하는 src 파일 = checkpoint-signer.ts',
  },
  {
    id: 'TL-P-verifier-imports-server-code',
    targetLayer: 'K',
    description: '오프라인 검증기가 서버 코드(src/tlog)를 import 한다 — 우리 코드로 우리를 통과시키는 검증기가 된다(R15)',
    files: [],
    replacements: [
      {
        path: 'scripts/tlog-verify/verifier.ts',
        find: "import { createHash, createHmac, createPublicKey, verify as cryptoVerify } from 'node:crypto';",
        replace:
          "import { createHash, createHmac, createPublicKey, verify as cryptoVerify } from 'node:crypto';\nimport { leafHash as serverLeafHash } from '../../src/tlog/merkle';\nexport const mutationServerLeafHash = serverLeafHash;",
      },
    ],
    targetTest: 'scripts/tlog-verify/** · scripts/log-verify.ts · 두 번째 검증기 · 참조 구현',
  },
  // ── 결제 경계(WP-2 · Paddle) — `test/arch/billing-boundary.arch.test.ts` · `network-egress`. 계획 Step 2 의 BL-1~4 ──
  {
    id: 'BL-1-webhook-imports-db-client',
    targetLayer: 'BL',
    description: '인터넷에 열린 결제 웹훅 핸들러가 DB 클라이언트를 import 한다 — 번들에 pg 가 실리고 공개 함수가 DB 로 가는 코드 경로를 얻는다',
    files: [],
    replacements: [
      {
        path: 'src/runtime/handlers/billing-webhook.ts',
        find: "import { log } from '../../observability/logger';",
        replace: "import { log } from '../../observability/logger';\nimport { createPool } from '../../db/client';\nexport const mutationPool = createPool;",
      },
    ],
    targetTest: 'billing-webhook 번들 입력에 pg·src/db·조립 루트가 0 이다',
  },
  {
    id: 'BL-2-sqs-sdk-outside-runtime-sqs',
    targetLayer: 'BL',
    description: 'src/runtime/sqs.ts 밖에서 SQS SDK 를 직접 쓴다 — 중복 제거 id·그룹 id 를 필수로 받는 면을 비켜 가는 둘째 송출 문',
    files: [
      {
        path: 'src/billing/mutation-sqs-direct.ts',
        content: `// Layer F 변이 픽스처.
import { SQSClient } from '@aws-sdk/client-sqs';
export const client = new SQSClient({});
`,
      },
    ],
    targetTest: '송출 원시 모듈·전역·AWS SDK 클라이언트를 쓰는 src 파일 = 허용 파일 정확히',
  },
  {
    id: 'BL-3-webhook-role-vpc-managed-policy',
    targetLayer: 'BL',
    description: '결제 웹훅 역할에 VPC 관리형 정책을 붙인다 — VPC 밖·권한 셋이라는 설계가 조용히 넓어진다(다음 단계는 함수를 VPC 에 넣는 것)',
    files: [],
    replacements: [
      {
        path: 'infra/cdk/stacks/compute-stack.ts',
        find: "        description: 'Paddle webhook receiver. Own log group write, webhook secret read, billing queue SendMessage only. No VPC, no DB, no SES.',",
        replace:
          "        description: 'Paddle webhook receiver. Own log group write, webhook secret read, billing queue SendMessage only. No VPC, no DB, no SES.',\n        managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole')],",
      },
    ],
    targetTest: 'atmark-runtime-billing-webhook 역할에 관리형 정책이 없고 atmark-billing-webhook 함수에 VpcConfig 가 없다',
  },
  {
    id: 'BL-4-signature-compare-not-constant-time',
    targetLayer: 'BL',
    description: 'Paddle 서명 비교를 === 로 바꾼다 — 첫 다른 바이트에서 멈춰 서명을 한 바이트씩 맞혀 가는 타이밍 창이 열린다',
    files: [],
    replacements: [
      {
        path: 'src/billing/paddle/signature.ts',
        find: '      if (timingSafeEqual(given, digest)) matched = true;',
        replace: "      if (given.toString('hex') === digest.toString('hex')) matched = true;",
      },
    ],
    targetTest: 'verifyPaddleSignature 는 timingSafeEqual 을 부르고',
  },
  // ---- 메일 기본기 1차(2026-09-26, `.omc/plans/mail-basics.md` §7.1 C0) — 새 층 하나(VB)와 기존 두 층의 새 단언 ----
  {
    id: 'VB-1-policy-imports-verification',
    targetLayer: 'VB',
    description: '정책 쪽 파일이 인증코드 추출 모듈을 런타임 import 한다 — "인증 메일이면 허용" 같은 편의로 받은 메일의 값이 결정 입력이 된다',
    files: [
      {
        path: 'src/policy/mutation-verification-shortcut.ts',
        content:
          "// Layer F 변이 픽스처. 러너가 되돌린다. 커밋되면 안 된다.\n" +
          "import { VERIFICATION_MODES } from '../mail/verification';\n" +
          'export const mutationTrustsVerification = VERIFICATION_MODES;\n',
      },
    ],
    targetTest: '금지 시작점들의 런타임 import 폐포에 인증코드 추출 모듈(src/mail/verification/**)이 0개다',
  },
  {
    id: 'PB-1-webhook-names-policy-blocked',
    targetLayer: 'SB',
    description: '웹훅 모듈이 policy_blocked 를 이름으로 부른다 — 소유자가 수신 정책으로 막은 메일이 웹훅 이벤트로 에이전트에게 새는 입구(AC-A4-3)',
    files: [
      {
        path: 'src/webhooks/mutation-quarantine-event.ts',
        content:
          "// Layer F 변이 픽스처. 러너가 되돌린다. 커밋되면 안 된다.\n" +
          "export const mutationQuarantineReason = 'policy_blocked';\n",
      },
    ],
    targetTest: '⑤ policy_blocked 리터럴은 에이전트 표면·웹훅·MCP·인증코드 추출 소스에 0건이다',
  },
  {
    id: 'MC-1-mcp-cancel-channel-not-mcp',
    targetLayer: 'C',
    description: "라우터가 MCP 예약 취소를 경로 'http' 로 넘긴다 — MCP 취소가 `cancelled_via='http'` 로 기록돼 소유자 로그·알람이 경로를 잘못 본다(완화 ② 경로 기록 훼손)",
    files: [],
    replacements: [
      {
        path: 'src/runtime/router.ts',
        find: "      handleCancelScheduledMessage(d.scheduledQueries, request, params, 'mcp'),",
        replace: "      handleCancelScheduledMessage(d.scheduledQueries, request, params, 'http'),",
      },
    ],
    targetTest: '⑤-2 예약 취소 경로는 라우터가 리터럴로 정한다',
  },
];
