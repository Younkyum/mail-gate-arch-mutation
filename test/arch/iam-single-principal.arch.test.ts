/**
 * Layer E — IAM 단일 주체 (계획 §5.0 "Layer E").
 *
 * **주장:** `ses:SendEmail` / `ses:SendRawEmail` 을 허용하는 IAM 주체는 기대 집합과
 * 정확히 일치한다. P1a~P4 의 기대 집합은 공집합이었다. **배포 준비 D2(2026-09-23)부터 하나** —
 * `AtmarkCompute` 의 발송 역할(`atmark-runtime-sender`)을 발송 4핸들러(api·approval-release·approval-notifier·
 * scheduled-sender)가 공유한다(`infra/cdk/stacks/compute-stack.ts` 머리말). **ADR-0006(2026-09-23)부터 둘** — 로그인 메일
 * 전용 역할(`atmark-runtime-login-mailer`)이 더해졌고, 그 역할의 발송 문장은 `ses:FromAddress` **= 정확히 `login@atmark.ai`**
 * 이다. 주체마다 발송 문장은 발신 주소 조건과 구체 리소스를 가져야 한다 — 주체 수가 맞아도 `Resource: *` 무조건 발송이면
 * 이 층은 반쪽이다. 그래서 조건은 **주체별로** 못 박는다(둘째 주체가 `*@atmark.ai` 로 넓어지면 빨개진다).
 *
 * **이 층이 잡는 것**
 * - TypeScript 호출 그래프가 **원리적으로 볼 수 없는** 경로: 다른 Lambda 가 AWS CLI /
 *   HTTPS 로 SES 를 직접 때리는 것. Layer A·B 는 우리 소스의 import 만 본다.
 * - 편의를 위해 넓게 붙인 `ses:*` / `*` 와일드카드 권한.
 * - 인프라 변경으로 새 역할에 발송 권한이 붙는 것(기대 집합에 추가하지 않는 한 실패).
 *
 * **이 층이 못 잡는 것**
 * - synth 산출물 **밖**에서 만들어진 권한 — 콘솔 수동 부여, 다른 리포의 스택, SCP.
 *   CDK 가 모르는 것은 이 층도 모른다. 그 구멍은 계정 수준 감사(§3.3)의 일이다.
 * - 권한을 가진 주체가 실제로 발송하는지 여부. 이 층은 **가능성**만 본다.
 *
 * **왜 skip 하지 않는가:** `cdk.out/` 이 없을 때 조용히 통과하면 이 층은 공허해진다.
 * CI 는 테스트 전에 `cdk synth` 를 돌리므로(.github/workflows/ci.yml) 산출물이 없다는
 * 것은 파이프라인이 깨졌다는 뜻이고, 그건 실패로 보고돼야 한다.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoPath } from './support/project';

/** synth 산출물 디렉터리. CI 는 테스트 직전에 이걸 생성한다. */
const CDK_OUT = process.env['ATMARK_CDK_OUT'] ?? repoPath('cdk.out');

/**
 * 발송 권한을 가져도 되는 IAM 주체 — `<템플릿 스택명>#<논리 ID>` 표기.
 *
 * **P1a: 공집합.** P1b 에서 dispatcher 역할 하나가 여기 들어오고, 그때 이 배열에
 * 한 줄을 추가하는 행위가 곧 "발송 주체를 늘린다"는 선언이 된다.
 *
 * **P2 — 소유자 승인 알림(`src/notify/approval-notifier.ts`, 워커 `workers/approval-notifier`)은
 * 주체를 늘리지 않는다.** 관문 밖의 두 번째 발송면이지만 **같은 런타임 역할**(dispatcher)에서 돈다고
 * 가정한다 — 알림 전용 역할·람다를 따로 만들지 않는다. 그 가정이 깨져 알림 워커에 별도 IAM 역할이 붙는
 * 날, 이 배열에 그 역할을 넣지 않는 한 아래 단언이 빨개진다. 그것이 의도다: 알림 경로의 정적 보증
 * (Layer B "알림 경로" 절)은 TypeScript 안의 것이고, 알림 워커만의 역할에 `ses:SendEmail` 이 붙으면
 * 그 역할로 **알림 모듈을 거치지 않는** 발송(CLI·다른 코드)이 가능해진다 — Layer E 가 보는 바로 그 구멍이다.
 *
 * **D2(2026-09-23): 발송 역할 하나가 들어왔다.** 알림 워커(`approval-notifier`)는 위 가정대로 **같은 역할**을 쓴다.
 * 논리 ID 는 `overrideLogicalId` 로 고정했다(`SENDER_ROLE_LOGICAL_ID`) — 해시 접미사가 붙으면 이 목록이 CDK 내부 사정으로
 * 바뀌고, 그런 변경은 "주체를 늘린다" 는 선언과 구별되지 않는다. `docs/ops/ses-principals-allowlist.json` 의
 * `runtimeRoles.mustEqual` 도 같은 커밋에서 1 이 됐다.
 *
 * **ADR-0006(2026-09-23): 둘째 주체 — 로그인 메일 역할.** 위 P2 문단의 가정(알림은 발송 역할에서 돈다)을 **로그인 메일에 한해**
 * 의도적으로 깬 것이다. 이유: 로그인 메일 토큰을 만드는 키 + 링크 id·만료를 쥔 주체는 소유자 세션을 만들 수 있고, 발송 역할은
 * 에이전트 토큰이 닿는 api Lambda 의 역할이다(검증 H1 이 실증). 위 문단이 경고한 구멍("알림 모듈을 거치지 않는 발송")은
 * 발신 주소 **하나**(`login@atmark.ai`, StringEquals)로 닫는다 — 그 역할로는 에이전트 주소도, 승인 알림 주소도 쓸 수 없다.
 * allowlist 의 `mustEqual` 도 같은 변경에서 2 가 됐다.
 */
const EXPECTED_SES_SENDING_PRINCIPALS: readonly string[] = ['AtmarkCompute#SesLoginMailerRole', 'AtmarkCompute#SesSenderRole'];

/**
 * 역할에 붙어도 되는 AWS 관리형 정책. 관리형 정책은 ARN 참조라 문장이 템플릿에 없다 — `AmazonSESFullAccess` 를
 * 붙이면 위 ①② 는 보지 못한다. 그래서 목록으로 닫는다. 전부 SES 액션이 없다.
 */
const ALLOWED_AWS_MANAGED_POLICIES: readonly string[] = [
  'service-role/AWSLambdaBasicExecutionRole',
  'service-role/AWSLambdaVPCAccessExecutionRole',
  // NAT 인스턴스 = SSM 포트 포워딩 경유지(운영 DB 관리 접속, `network-stack.ts` 머리말). ssm·ssmmessages·ec2messages·
  // s3:GetEncryptionConfiguration 뿐이고 SES 액션은 없다 — 이 줄을 더한 것이 "그 역할은 발송 주체가 아니다" 라는 선언이다.
  'AmazonSSMManagedInstanceCore',
];

/**
 * 발송 문장이 가져야 하는 모양 — **주체별 · 문장별**(Sid). 둘째 주체는 주소 둘에 묶인다(와일드카드 없음 — 로그인 `login@` · 환영 메일 `onve@`,
 * ADR-0006 2026-09-30 개정).
 *
 * **ADR-0014 단계 2(I2+) — 발송 역할은 문장이 둘이다.** identity 문장(`atmark.ai` identity **하나** · `*@atmark.ai`)과 구성 세트 문장(구성 세트
 * **하나** · 조건 없음 — 스파이크 S1 ③: 구성 세트 권한은 identity policy 로 줄 수 없다). SES 는 발송 요청마다 identity 와 구성 세트 둘 다의
 * 허락을 요구하므로, 조건 없는 문장은 identity 를 하나도 허락하지 않는 한(자원이 구성 세트뿐인 한) 발신 주소를 넓히지 않는다 — 그래서
 * 아래 단언은 그 문장의 **자원이 구성 세트 ARN 하나뿐**임을 못 박는다. 고객 identity 는 IAM 에 없다(identity policy 로만 — `identity/*` 부재 단언).
 */
const REQUIRED_SENDING_STATEMENTS: Readonly<Record<string, Readonly<Record<string, { readonly condition: unknown; readonly resource: RegExp }>>>> = {
  'AtmarkCompute#SesSenderRole': {
    SesSendAsAtmarkIdentity: { condition: { StringLike: { 'ses:FromAddress': '*@atmark.ai' } }, resource: /^arn:aws:ses:[a-z0-9-]+:\d{12}:identity\/atmark\.ai$/ },
    SesUseDefaultConfigurationSet: { condition: undefined, resource: /^arn:aws:ses:[a-z0-9-]+:\d{12}:configuration-set\/atmark-default$/ },
  },
  'AtmarkCompute#SesLoginMailerRole': {
    SesSendAsLoginOnly: {
      condition: { StringEquals: { 'ses:FromAddress': ['login@atmark.ai', 'onve@atmark.ai'] } },
      resource: /^arn:aws:ses:[a-z0-9-]+:\d{12}:(identity\/atmark\.ai|configuration-set\/atmark-default)$/,
    },
  },
};

/** 비발송 역할의 SES 발송 명시 Deny(ADR-0014 단계 2 — `infra/cdk/stacks/ses-send-deny.ts`). 런타임 Lambda 역할이 있는 스택. */
const SEND_DENY_SID = 'SesSendDenyNonSendingRole';
const RUNTIME_ROLE_STACKS: readonly string[] = ['AtmarkCompute', 'AtmarkTransparency', 'AtmarkInbound', 'AtmarkSite', 'AtmarkDocs', 'AtmarkCiCd'];

/** 발송 액션 — IAM 와일드카드(`ses:Send*` · `ses:SendE*` · `ses:*Email` · `*` …)가 이 중 하나에라도 맞으면 발송으로 센다(재검증 INFO — 예전 정규식은
 * 정확한 이름·`ses:*`·`*` 만 봐서 `ses:Send*` 같은 Allow 를 놓쳤다). IAM 액션 이름은 대소문자를 가리지 않는다. */
const SENDING_ACTIONS: readonly string[] = ['ses:SendEmail', 'ses:SendRawEmail', 'ses:SendBulkEmail', 'ses:SendTemplatedEmail', 'ses:SendBulkTemplatedEmail'];

function isSendingAction(action: string): boolean {
  const pattern = new RegExp(`^${action.split('*').map((part) => part.split('?').map((p) => p.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('.')).join('.*')}$`, 'i');
  return SENDING_ACTIONS.some((sending) => pattern.test(sending));
}

interface PolicyStatement {
  readonly Sid?: string;
  readonly Effect?: string;
  readonly Action?: unknown;
  readonly Resource?: unknown;
  readonly Condition?: unknown;
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value === undefined ? [] : [value];
}

function allowsSending(statement: PolicyStatement): boolean {
  if (statement.Effect !== 'Allow') return false;
  return asArray(statement.Action).some((action) => typeof action === 'string' && isSendingAction(action));
}

/** `{ Ref: 'X' }` / `{ 'Fn::GetAtt': ['X', ...] }` / 문자열 → 주체 이름. */
function principalName(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record['Ref'] === 'string') return record['Ref'];
    const getAtt = record['Fn::GetAtt'];
    if (Array.isArray(getAtt) && typeof getAtt[0] === 'string') return getAtt[0];
  }
  return JSON.stringify(value);
}

type TemplateResources = Record<string, { Type?: string; Properties?: Record<string, unknown> }>;

function readTemplates(): { stack: string; resources: TemplateResources }[] {
  const templates = existsSync(CDK_OUT)
    ? readdirSync(CDK_OUT).filter((name) => name.endsWith('.template.json'))
    : [];
  return templates.map((templateFile) => ({
    stack: templateFile.replace(/\.template\.json$/, ''),
    resources:
      (JSON.parse(readFileSync(join(CDK_OUT, templateFile), 'utf8')) as { Resources?: TemplateResources }).Resources ?? {},
  }));
}

/** 템플릿 전체의 발송 허용 문장(관리형·인라인 정책 모두). `principals` 는 그 문장이 붙은 주체(`<스택>#<논리 ID>`). */
function collectSendingStatements(): { where: string; principals: string[]; statement: PolicyStatement }[] {
  const found: { where: string; principals: string[]; statement: PolicyStatement }[] = [];
  for (const { stack, resources } of readTemplates()) {
    for (const [logicalId, resource] of Object.entries(resources)) {
      const properties = resource.Properties ?? {};
      const documents: unknown[] = [];
      let principals: string[] = [];
      if (resource.Type === 'AWS::IAM::Policy' || resource.Type === 'AWS::IAM::ManagedPolicy') {
        documents.push(properties['PolicyDocument']);
        const attached = [...asArray(properties['Roles']), ...asArray(properties['Users']), ...asArray(properties['Groups'])];
        principals = (attached.length > 0 ? attached.map(principalName) : [logicalId]).map((name) => `${stack}#${name}`);
      }
      if (resource.Type === 'AWS::IAM::Role') {
        for (const policy of asArray(properties['Policies']) as Array<{ PolicyDocument?: unknown }>) {
          documents.push(policy.PolicyDocument);
        }
        principals = [`${stack}#${logicalId}`];
      }
      for (const document of documents) {
        const statements = asArray((document as { Statement?: unknown } | undefined)?.Statement) as PolicyStatement[];
        for (const statement of statements.filter(allowsSending)) found.push({ where: `${stack}#${logicalId}`, principals, statement });
      }
    }
  }
  return found;
}

function collectSendingPrincipals(): string[] {
  const templates = existsSync(CDK_OUT)
    ? readdirSync(CDK_OUT).filter((name) => name.endsWith('.template.json'))
    : [];

  const found = new Set<string>();

  for (const templateFile of templates) {
    const stack = templateFile.replace(/\.template\.json$/, '');
    const parsed = JSON.parse(readFileSync(join(CDK_OUT, templateFile), 'utf8')) as {
      Resources?: Record<string, { Type?: string; Properties?: Record<string, unknown> }>;
    };

    for (const [logicalId, resource] of Object.entries(parsed.Resources ?? {})) {
      const properties = resource.Properties ?? {};

      // ① AWS::IAM::Policy / ManagedPolicy — 붙어 있는 Role/User/Group 이 주체다.
      if (resource.Type === 'AWS::IAM::Policy' || resource.Type === 'AWS::IAM::ManagedPolicy') {
        const document = properties['PolicyDocument'] as { Statement?: unknown } | undefined;
        const statements = asArray(document?.Statement) as PolicyStatement[];
        if (!statements.some(allowsSending)) continue;

        const attached = [
          ...asArray(properties['Roles']),
          ...asArray(properties['Users']),
          ...asArray(properties['Groups']),
        ];
        const names = attached.length > 0 ? attached.map(principalName) : [logicalId];
        for (const name of names) found.add(`${stack}#${name}`);
        continue;
      }

      // ② AWS::IAM::Role 의 인라인 정책 — 역할 자신이 주체다.
      if (resource.Type === 'AWS::IAM::Role') {
        const policies = asArray(properties['Policies']) as Array<{ PolicyDocument?: { Statement?: unknown } }>;
        const statements = policies.flatMap((policy) => asArray(policy.PolicyDocument?.Statement)) as PolicyStatement[];
        if (statements.some(allowsSending)) found.add(`${stack}#${logicalId}`);
      }
    }
  }

  return [...found].sort();
}

describe('Layer E — SES 발송 권한을 가진 IAM 주체', () => {
  it('synth 산출물이 존재한다 — 없으면 이 층은 아무것도 증명하지 못한다', () => {
    const templates = existsSync(CDK_OUT)
      ? readdirSync(CDK_OUT).filter((name) => name.endsWith('.template.json'))
      : [];

    expect(
      templates.length,
      `${CDK_OUT} 에 *.template.json 이 없다. 'pnpm exec cdk synth' 를 먼저 돌려라 — ` +
        '산출물 없이 통과시키면 Layer E 는 공허한 green 이 된다.',
    ).toBeGreaterThan(0);
  });

  it('발송 권한 주체 집합이 기대 집합과 정확히 일치한다 (ADR-0006 기대값: 2개 — 발송 역할 · 로그인 메일 역할)', () => {
    expect(collectSendingPrincipals()).toEqual([...EXPECTED_SES_SENDING_PRINCIPALS].sort());
  });

  it('모든 발송 문장은 주체·문장별 모양(발송 역할: atmark.ai identity + *@atmark.ai · 구성 세트 하나 / 로그인 메일 역할: login@·onve@)과 구체 리소스를 가진다 — 와일드카드 발송 없음 · identity/* 없음', () => {
    const statements = collectSendingStatements();
    expect(statements.length, '발송 문장이 0개면 위 단언과 어긋난다 — 산출물을 확인하라').toBeGreaterThan(0);
    // 주체마다 발송 문장이 있다(비공허) — 둘째 주체의 조건이 실제로 검사된다.
    expect([...new Set(statements.flatMap(({ principals }) => principals))].sort()).toEqual([...EXPECTED_SES_SENDING_PRINCIPALS].sort());
    for (const principal of EXPECTED_SES_SENDING_PRINCIPALS) {
      const sids = statements.filter(({ principals }) => principals.includes(principal)).map(({ statement }) => statement.Sid ?? '?').sort();
      expect(sids, principal).toEqual(Object.keys(REQUIRED_SENDING_STATEMENTS[principal] ?? {}).sort());
    }
    for (const { where, principals, statement } of statements) {
      expect(principals.length, where).toBe(1);
      const required = REQUIRED_SENDING_STATEMENTS[principals[0] ?? '']?.[statement.Sid ?? ''];
      expect(required, `${where} ${String(statement.Sid)}`).toBeDefined();
      expect(statement.Condition, where).toEqual(required?.condition);
      const resources = asArray(statement.Resource);
      expect(resources.length, where).toBeGreaterThan(0);
      for (const resource of resources) {
        // 계정·리전이 고정된 합성(app.ts)이라 자원은 글자 ARN 이다 — 그래야 `identity/*` 같은 넓힘이 글자로 보인다.
        expect(typeof resource, where).toBe('string');
        expect(resource, where).not.toBe('*');
        expect(resource, where).not.toMatch(/identity\/\*/);
        expect(resource, where).toMatch(required?.resource ?? /^$/);
      }
      for (const action of asArray(statement.Action)) expect(action, where).toMatch(/^ses:Send(Email|RawEmail)$/);
    }
  });

  it('발송 액션 판정은 IAM 와일드카드를 펼친다 — ses:Send* · ses:SendE* · ses:*Email · * 는 발송 · ses:Get* · ses:SendCustomVerificationEmail 은 아니다', () => {
    for (const action of ['ses:Send*', 'ses:SendE*', 'ses:*Email', '*', 'ses:*', 'SES:SENDEMAIL', 'ses:SendRawEmail']) expect(isSendingAction(action), action).toBe(true);
    for (const action of ['ses:Get*', 'ses:SendCustomVerificationEmail', 'ses:CreateEmailIdentity', 's3:*']) expect(isSendingAction(action), action).toBe(false);
  });

  it('★ 비발송 런타임 역할 전부에 ses:Send* 명시 Deny 가 있다 — 발송 주체 둘에는 없다(ADR-0014 단계 2 — 자원 정책으로 받은 발송 권한을 identity 기반 Deny 로 닫는다)', () => {
    let checked = 0;
    for (const { stack, resources } of readTemplates().filter(({ stack }) => RUNTIME_ROLE_STACKS.includes(stack))) {
      const denyHolders = new Set<string>();
      for (const [logicalId, resource] of Object.entries(resources)) {
        if (resource.Type !== 'AWS::IAM::Policy') continue;
        const statements = asArray((resource.Properties?.['PolicyDocument'] as { Statement?: unknown } | undefined)?.Statement) as PolicyStatement[];
        const deny = statements.find((statement) => statement.Sid === SEND_DENY_SID);
        if (deny === undefined) continue;
        expect(deny.Effect, logicalId).toBe('Deny');
        expect(asArray(deny.Action), logicalId).toEqual(['ses:Send*']);
        expect(asArray(deny.Resource), logicalId).toEqual(['*']);
        expect(deny.Condition, logicalId).toBeUndefined();
        for (const role of asArray(resource.Properties?.['Roles'])) denyHolders.add(principalName(role));
      }
      for (const [logicalId, resource] of Object.entries(resources)) {
        if (resource.Type !== 'AWS::IAM::Role') continue;
        checked += 1;
        const principal = `${stack}#${logicalId}`;
        expect(denyHolders.has(logicalId), principal).toBe(!EXPECTED_SES_SENDING_PRINCIPALS.includes(principal));
      }
    }
    // 비공허: 런타임 Lambda 역할(Compute 14 · Transparency 2) + Scheduler 대상 · 커스텀 리소스 · 홈·문서 λ · CI/CD 배포 역할(재검증 INFO — 모든 역할).
    expect(checked).toBeGreaterThanOrEqual(22);
  });

  it('★ domain-control 역할(atmark-runtime-domain-control): atmark.ai·그 하위·주소 identity 의 ses:* 명시 Deny 가 있다 · 발송 Allow 가 없다', () => {
    const compute = readTemplates().find(({ stack }) => stack === 'AtmarkCompute');
    const role = Object.entries(compute?.resources ?? {}).find(
      ([, resource]) => resource.Type === 'AWS::IAM::Role' && resource.Properties?.['RoleName'] === 'atmark-runtime-domain-control',
    );
    expect(role, 'atmark-runtime-domain-control 역할이 산출물에 없다').toBeDefined();
    const roleId = role?.[0] ?? '?';
    expect(collectSendingPrincipals()).not.toContain(`AtmarkCompute#${roleId}`);
    const statements = Object.values(compute?.resources ?? {})
      .filter((resource) => resource.Type === 'AWS::IAM::Policy' && asArray(resource.Properties?.['Roles']).some((r) => principalName(r) === roleId))
      .flatMap((resource) => asArray((resource.Properties?.['PolicyDocument'] as { Statement?: unknown } | undefined)?.Statement) as PolicyStatement[]);
    const platform = statements.find((statement) => statement.Sid === 'SesDenyPlatformAndAddressIdentities');
    expect(platform?.Effect).toBe('Deny');
    expect(asArray(platform?.Action)).toEqual(['ses:*']);
    const resources = asArray(platform?.Resource).map((resource) => JSON.stringify(resource));
    expect(resources.some((r) => r.includes('identity/atmark.ai'))).toBe(true);
    expect(resources.some((r) => r.includes('identity/*.atmark.ai'))).toBe(true);
    expect(resources.some((r) => r.includes('identity/*@*'))).toBe(true);
    expect(statements.find((statement) => statement.Sid === SEND_DENY_SID)?.Effect).toBe('Deny');
    // ★ 보안 리뷰 M1 — 이름 Deny(ARN 대소문자 변형 여지)에만 기대지 않는다: 읽기 말고 SES 를 바꾸는 Allow 는 전부 관리 태그 조건을 갖는다
    //   (구성 세트 자원 하나에 붙이는 문장만 예외 — 그 자원에는 태그가 없고 identity 쪽 허락은 따로 필요하다).
    const mutating = statements.filter(
      (statement) =>
        statement.Effect === 'Allow' &&
        asArray(statement.Action).some((action) => typeof action === 'string' && action.startsWith('ses:') && action !== 'ses:GetEmailIdentity'),
    );
    expect(mutating.length).toBeGreaterThan(0);
    for (const statement of mutating) {
      if (statement.Sid === 'SesAttachDefaultConfigurationSet') {
        expect(asArray(statement.Resource).map((r) => JSON.stringify(r)).join(' ')).toMatch(/configuration-set\/atmark-default/);
        expect(asArray(statement.Resource).map((r) => JSON.stringify(r)).join(' ')).not.toMatch(/identity\//);
        continue;
      }
      expect(JSON.stringify(statement.Condition), statement.Sid).toMatch(/aws:(Resource|Request)Tag\/atmark:managed/);
    }
  });

  it('운영자 콘솔 역할(atmark-runtime-ops, ADR-0015)은 발송 주체가 아니다 — 운영자 코드 메일도 login-mailer 가 보낸다(주체 수 그대로 2)', () => {
    // 비공허: 역할이 산출물에 **있어야** 한다 — 없으면 "발송 문장 0" 은 아무것도 증명하지 않는다.
    const compute = readTemplates().find(({ stack }) => stack === 'AtmarkCompute');
    expect(compute, 'AtmarkCompute 템플릿이 없다').toBeDefined();
    const opsRole = Object.entries(compute?.resources ?? {}).find(
      ([, resource]) => resource.Type === 'AWS::IAM::Role' && resource.Properties?.['RoleName'] === 'atmark-runtime-ops',
    );
    expect(opsRole, 'atmark-runtime-ops 역할이 산출물에 없다 — cdk synth 를 다시 돌려라').toBeDefined();
    const principal = `AtmarkCompute#${opsRole?.[0] ?? '?'}`;
    expect(collectSendingPrincipals()).not.toContain(principal);
    expect(EXPECTED_SES_SENDING_PRINCIPALS).toHaveLength(2);
  });

  it('역할에 붙은 AWS 관리형 정책은 허용 목록 안에 있다 — ARN 참조로 SES 가 새어 들어올 틈을 닫는다', () => {
    const attached = new Set<string>();
    for (const { stack, resources } of readTemplates()) {
      for (const [logicalId, resource] of Object.entries(resources)) {
        if (resource.Type !== 'AWS::IAM::Role') continue;
        for (const arn of asArray(resource.Properties?.['ManagedPolicyArns'])) {
          const serialized = JSON.stringify(arn);
          const awsManaged = /:iam::aws:policy\/([^"]+)"/.exec(serialized)?.[1];
          // 고객 관리형 정책(템플릿 안 AWS::IAM::ManagedPolicy)은 ①이 문장을 직접 본다.
          if (awsManaged === undefined) continue;
          attached.add(awsManaged);
          expect(ALLOWED_AWS_MANAGED_POLICIES, `${stack}#${logicalId} → ${awsManaged}`).toContain(awsManaged);
        }
      }
    }
    expect(attached.size, '관리형 정책이 하나도 안 보이면 이 단언은 공허하다').toBeGreaterThan(0);
  });
});
