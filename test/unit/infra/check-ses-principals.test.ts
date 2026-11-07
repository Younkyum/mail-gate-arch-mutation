/**
 * `scripts/check-ses-principals.sh` — **오프라인으로 돌린다**(AWS 호출 0). `aws` 를 가짜 실행 파일로 바꿔 끼우고, 그 가짜의
 * `simulate-principal-policy` 답은 **합성된 AtmarkCompute 템플릿의 실제 IAM 문장**을 여기서 평가해 만든다(Allow·Deny·
 * `StringLike`/`StringEquals` 의 `ses:FromAddress`·리소스). 그래서 이 테스트는 스크립트의 판정 규칙과 스택의 정책을 **함께** 본다.
 *
 *   - 실제 템플릿: 런타임 발송 역할 **2개 = mustEqual 2** · login-mailer 는 `login@atmark.ai` 로만(probe@·에이전트 모양·notify@ 거부)
 *     · 발송 역할은 `login@` 거부(Deny) → exit 0.
 *   - login-mailer 조건을 `*@atmark.ai` 로 넓히면 → FAIL(다른 주소로 보낼 수 있다).
 *   - 발송 역할의 Deny 를 지우면 → FAIL(deniedFromAddress).
 *   - US-009(ADR-0009): 발송 역할은 `support@` 를 contact-forwarder 함수 문맥(`lambda:SourceFunctionArn`) 밖에서 거부 — 시뮬레이터는 그
 *     키 없이 묻는다(키 없음: `ArnNotEquals` 참 · `ArnEquals` 거짓). 그 Deny 만 지우면 → FAIL. login-mailer 는 `support@` 도 거부.
 *   - allowlist 밖 역할이 발송 가능하면 → FAIL.
 *   - 2026-09-24 검증 F1: 예약 주소의 대소문자·하위 주소 변형(`LOGIN@`·`Login@`·`login+x@`·`Support@`·`support+x@`)을 모든 런타임 역할이 거부.
 *     Deny 를 대소문자 구분 `StringEquals` 로 되돌리거나 정규형 밖 문자 Deny 를 지우면 → FAIL(reservedVariant).
 *   - 2026-09-24 최종 검증 M3a: 접힘 공백·제어문자 변형(`\tlogin@`·`\r\n\tlogin@`·`\vlogin@`·`\flogin@`·ESC·DEL·`lo\tgin@`·`\tsupport@`…)도
 *     전부 거부. 제어문자 패턴·예약 접미사 Deny 를 지우면 → FAIL. 스크립트는 문맥 항목을 JSON 으로 넘긴다(가짜 `aws` 가 JSON 으로 읽는다).
 *   - ADR-0014 단계 2: **SES identity 자원 정책**(identity policy) — 고객 identity 의 정책은 Principal = 발송 역할 하나 · Action ⊆ Send{Email,RawEmail} ·
 *     Resource = 그 identity · Condition = StringEquals ses:FromAddress(그 도메인 주소)뿐 · 이름 접두사 `atmark-sender-`. 플랫폼 identity(atmark.ai)에는
 *     정책 0. 하나라도 어기면 FAIL(가짜 `aws sesv2` 가 픽스처 정책을 돌려준다 — 드라이런). 발송 주체 수는 그대로 2.
 * jq·bash 가 필요하다(스크립트의 전제). 없으면 건너뛴다.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

import { CONTACT_ROUTING_DEFAULT, SENDER_ROLE_NAME } from '../../../infra/cdk/stacks/compute-stack';
import { IDENTITY_POLICY_NAME_PREFIX, identityPolicyDocument } from '../../../src/domains/contract';

import { repoPath } from '../../arch/support/project';
import { actionsOf, forwardRoutingCompute, runtimeTemplates, statementsByRole, type IamStatement } from './runtime-app';

const ACCOUNT = '123456789012';
const IDENTITY = `arn:aws:ses:ap-northeast-2:${ACCOUNT}:identity/atmark.ai`;
const BASE_PROBES = [
  'probe@atmark.ai',
  'login@atmark.ai',
  'agent-probe@atmark.ai',
  'notify@atmark.ai',
  'support@atmark.ai',
  'onve@atmark.ai',
  // 202609301540 — 수신 전용(allowlist `deniedFromAddresses`).
  'abuse@atmark.ai',
  'postmaster@atmark.ai',
];
/** 스크립트 `RESERVED_VARIANT_PROBES` 의 앞 여섯(F1 — 대소문자·하위 주소). */
const F1_PROBES = ['LOGIN@atmark.ai', 'Login@atmark.ai', 'login+x@atmark.ai', 'Support@atmark.ai', 'SUPPORT@atmark.ai', 'support+x@atmark.ai'];
/** 스크립트 `RESERVED_VARIANT_PROBES` 의 나머지(M3a — 접힘 공백·제어문자). 표시는 bash `printf %q` 꼴. */
const M3A_PROBES: readonly (readonly [string, string])[] = [
  ['\tlogin@atmark.ai', "$'\\tlogin@atmark.ai'"],
  ['\r\n\tlogin@atmark.ai', "$'\\r\\n\\tlogin@atmark.ai'"],
  ['\u000blogin@atmark.ai', "$'\\vlogin@atmark.ai'"],
  ['\u000clogin@atmark.ai', "$'\\flogin@atmark.ai'"],
  ['\u001blogin@atmark.ai', "$'\\Elogin@atmark.ai'"],
  ['\u007flogin@atmark.ai', "$'\\177login@atmark.ai'"],
  ['\tsupport@atmark.ai', "$'\\tsupport@atmark.ai'"],
  ['\u000bsupport@atmark.ai', "$'\\vsupport@atmark.ai'"],
  ['\u000csupport@atmark.ai', "$'\\fsupport@atmark.ai'"],
];
/** 스크립트 `RESERVED_VARIANT_PROBES` 의 끝(2026-09-30 — 환영 메일·지원 에이전트 별칭 onve@). */
const ONVE_PROBES = ['ONVE@atmark.ai', 'Onve@atmark.ai', 'onve+x@atmark.ai', '\tonve@atmark.ai', '\u000bonve@atmark.ai', '\u000conve@atmark.ai'];
/** 스크립트 `RESERVED_VARIANT_PROBES` 의 끝(202609301540 — 수신 전용 abuse@·postmaster@ 의 대소문자·하위 주소 변형). */
const RECEIVE_ONLY_PROBES = ['ABUSE@atmark.ai', 'Abuse@atmark.ai', 'abuse+x@atmark.ai', 'POSTMASTER@atmark.ai', 'Postmaster@atmark.ai', 'postmaster+x@atmark.ai'];
/** 스크립트 `RESERVED_VARIANT_PROBES` 와 같은 목록. */
const VARIANT_PROBES = [...F1_PROBES, ...M3A_PROBES.map(([probe]) => probe), ...ONVE_PROBES, ...RECEIVE_ONLY_PROBES];
const PROBES = [...BASE_PROBES, ...VARIANT_PROBES];

function hasTool(name: string): boolean {
  return spawnSync('sh', ['-c', `command -v ${name}`]).status === 0;
}
const TOOLS = hasTool('jq') && hasTool('bash');

/** IAM `StringLike` — `*` 여러 글자 · `?` 한 글자 · 대소문자 구분 · 개행도 한 글자(`s`). */
function glob(pattern: string): RegExp {
  const escape = (text: string): string => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${pattern.split('*').map((part) => part.split('?').map(escape).join('.')).join('.*')}$`, 's');
}

function conditionHolds(condition: IamStatement['Condition'], from: string): boolean {
  if (condition === undefined) return true;
  return Object.entries(condition).every(([operator, entries]) =>
    Object.entries(entries).every(([key, expected]) => {
      // 시뮬레이터 요청에는 `lambda:SourceFunctionArn` 이 없다(스크립트가 싣지 않는다) — 키가 없을 때 부정 연산자는 참, 긍정은 거짓.
      if (key === 'lambda:SourceFunctionArn') return operator === 'ArnNotEquals';
      if (key !== 'ses:FromAddress') return false;
      const values = (Array.isArray(expected) ? expected : [expected]) as string[];
      if (operator === 'StringEquals') return values.includes(from);
      if (operator === 'StringEqualsIgnoreCase') return values.some((value) => value.toLowerCase() === from.toLowerCase());
      if (operator === 'StringLike') return values.some((value) => glob(value).test(from));
      // 부정 연산자는 값 목록 **전부**와 어긋날 때 참이다.
      if (operator === 'StringNotLike') return !values.some((value) => glob(value).test(from));
      return false;
    }),
  );
}

function applies(statement: IamStatement, from: string): boolean {
  const actionOk = actionsOf(statement).some((action) => action === '*' || action === 'ses:*' || action === 'ses:SendEmail');
  const resources = (Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource]) as unknown[];
  const resourceOk = resources.some((resource) => resource === '*' || resource === IDENTITY);
  return actionOk && resourceOk && conditionHolds(statement.Condition, from);
}

/** IAM 평가 규칙(명시 Deny > Allow > 암묵 Deny)을 이 입력 범위에서 흉내 낸다. */
function decide(statements: readonly IamStatement[], from: string): string {
  if (statements.some((s) => s.Effect === 'Deny' && applies(s, from))) return 'explicitDeny';
  return statements.some((s) => s.Effect === 'Allow' && applies(s, from)) ? 'allowed' : 'implicitDeny';
}

type Mutate = (byRoleName: Map<string, IamStatement[]>) => void;

/** 템플릿의 역할(물리 이름) → 문장. 배포 역할·사람은 무조건 발송 가능(AdministratorAccess 모양)으로 더한다. */
function decisionTable(mutate: Mutate = () => undefined, compute: Template = runtimeTemplates().compute): { table: Record<string, Record<string, string>>; roles: string[] } {
  const roleResources = compute.findResources('AWS::IAM::Role') as Record<string, { Properties: { RoleName?: string } }>;
  const byLogical = statementsByRole(compute);
  const byName = new Map<string, IamStatement[]>();
  for (const [logicalId, role] of Object.entries(roleResources)) {
    const name = role.Properties.RoleName;
    if (typeof name === 'string') byName.set(name, [...(byLogical.get(logicalId) ?? [])]);
  }
  const admin: IamStatement[] = [{ Effect: 'Allow', Action: '*', Resource: '*' }];
  byName.set(`cdk-hnb659fds-cfn-exec-role-${ACCOUNT}-ap-northeast-2`, admin);
  mutate(byName);
  const table: Record<string, Record<string, string>> = {};
  for (const [name, statements] of byName) {
    table[`arn:aws:iam::${ACCOUNT}:role/${name}`] = Object.fromEntries(PROBES.map((from) => [from, decide(statements, from)]));
  }
  table[`arn:aws:iam::${ACCOUNT}:user/atmark-admin`] = Object.fromEntries(PROBES.map((from) => [from, decide(admin, from)]));
  return { table, roles: [...byName.keys()] };
}

/** 가짜 `aws` — 스크립트가 부르는 iam 다섯 명령 + sesv2 둘(identity 목록 · identity 정책 — 픽스처 `FAKE_AWS_IDENTITIES`)만 안다. */
const FAKE_AWS = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i < 0 ? '' : args[i + 1]; };
const table = JSON.parse(fs.readFileSync(process.env.FAKE_AWS_TABLE, 'utf8'));
const roles = JSON.parse(process.env.FAKE_AWS_ROLES);
const identities = JSON.parse(process.env.FAKE_AWS_IDENTITIES || '{"atmark.ai":{}}');
const [service, command] = args;
if (service === 'sesv2' && command === 'list-email-identities') { console.log(Object.keys(identities).join('\\t')); process.exit(0); }
if (service === 'sesv2' && command === 'get-email-identity-policies') {
  const policies = identities[opt('--email-identity')];
  if (policies === undefined) process.exit(6);
  console.log(JSON.stringify({ Policies: policies }));
  process.exit(0);
}
if (service !== 'iam') process.exit(3);
if (command === 'list-users') { console.log('atmark-admin'); }
else if (command === 'get-user') { console.log('arn:aws:iam::${ACCOUNT}:user/' + opt('--user-name')); }
else if (command === 'list-mfa-devices') { console.log('1'); }
else if (command === 'list-roles') { console.log(roles.join('\\t')); }
else if (command === 'get-role') { console.log('arn:aws:iam::${ACCOUNT}:role/' + opt('--role-name')); }
else if (command === 'simulate-principal-policy') {
  if (opt('--resource-arns') !== '${IDENTITY}') process.exit(4);
  // 스크립트는 문맥 항목을 JSON 으로 넘긴다(M3a — 제어문자·공백이 단축 문법에서 바뀌지 않게).
  const from = JSON.parse(opt('--context-entries'))[0].ContextKeyValues[0];
  console.log((table[opt('--policy-source-arn')] || {})[from] || 'implicitDeny');
} else process.exit(5);
`;

function runScript(
  mutate?: Mutate,
  options: { readonly compute?: Template; readonly routing?: string; readonly identities?: Readonly<Record<string, Readonly<Record<string, string>>>> } = {},
): { status: number; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'atmark-ses-principals-'));
  writeFileSync(join(dir, 'aws'), FAKE_AWS);
  chmodSync(join(dir, 'aws'), 0o755);
  const { table, roles } = decisionTable(mutate, options.compute);
  writeFileSync(join(dir, 'table.json'), JSON.stringify(table));
  const { ATMARK_CONTACT_ROUTING: _ignored, ...inherited } = process.env;
  const result = spawnSync('bash', [repoPath('scripts/check-ses-principals.sh')], {
    env: {
      ...inherited,
      ...(options.routing === undefined ? {} : { ATMARK_CONTACT_ROUTING: options.routing }),
      PATH: `${dir}:${process.env['PATH'] ?? ''}`,
      AWS_PROFILE: 'fake',
      FAKE_AWS_TABLE: join(dir, 'table.json'),
      FAKE_AWS_ROLES: JSON.stringify(roles),
      FAKE_AWS_IDENTITIES: JSON.stringify(options.identities ?? { 'atmark.ai': {} }),
    },
    encoding: 'utf8',
  });
  return { status: result.status ?? -1, output: `${result.stdout}${result.stderr}` };
}

// 한 건이 bash 스크립트 하나(역할마다 jq·가짜 aws 호출)를 끝까지 돌린다 — 혼자 약 3.5s, infra 파일을 함께 돌리면 CPU 경합으로 5s(기본 상한)를
//   넘는다(2026-09-28, Compute 역할 16 — ops 추가). 동기 작업이라 멈춤이 아니다: 상한을 넉넉히 둔다.
describe.skipIf(!TOOLS)('check-ses-principals.sh — 합성 템플릿의 IAM 문장으로 오프라인 판정 (Layer E, ADR-0006)', { timeout: 20_000 }, () => {
  it('실제(기본) 템플릿: 런타임 발송 역할 2개 = 기대 2개 · login-mailer 는 login@ 로만 · 스크립트 기본 기대 = CDK 기본(agent_and_notify) · exit 0', () => {
    const { status, output } = runScript();
    // 스크립트의 ATMARK_CONTACT_ROUTING 기본은 compute-stack 의 CONTACT_ROUTING_DEFAULT(운영 배포값)와 같아야 운영에 그대로 돌려 통과한다.
    expect(CONTACT_ROUTING_DEFAULT).toBe('agent_and_notify');
    expect(output).toContain(`문의 라우팅: ${CONTACT_ROUTING_DEFAULT}`);
    expect(output).toContain('ok    런타임 역할 2개 = 기대 2개');
    expect(output).toMatch(/ok {3}atmark-runtime-login-mailer\s+런타임 역할\(allowlist\) — login@atmark\.ai · onve@atmark\.ai 로만/);
    expect(output).toMatch(/ok {3}atmark-runtime-sender\s+런타임 역할\(allowlist\)/);
    expect(output).not.toContain('FAIL');
    expect(status).toBe(0);
  });

  it('실제 템플릿(forward 명시): 스크립트를 forward 로 돌리면 통과 — 발송 역할은 support@ 를 못 보내고 그 밖의 검사는 같다 · exit 0', () => {
    const { status, output } = runScript(undefined, { compute: forwardRoutingCompute(), routing: 'forward' });
    expect(output).toContain('문의 라우팅: forward');
    expect(output).toMatch(/ok {3}atmark-runtime-sender\s+런타임 역할\(allowlist\)/);
    expect(output).not.toContain('FAIL');
    expect(status).toBe(0);
  });

  it('템플릿 평가 자체(기본 agent_and_notify): login-mailer 는 probe@·에이전트 모양·notify@ 로 못 보내고, 발송 역할은 login@ 로 못 보내되 support@ 는 보낸다', () => {
    const { table } = decisionTable();
    const mailer = table[`arn:aws:iam::${ACCOUNT}:role/atmark-runtime-login-mailer`];
    const sender = table[`arn:aws:iam::${ACCOUNT}:role/atmark-runtime-sender`];
    expect(mailer).toEqual({
      'probe@atmark.ai': 'implicitDeny',
      'login@atmark.ai': 'allowed',
      'agent-probe@atmark.ai': 'implicitDeny',
      'notify@atmark.ai': 'implicitDeny',
      'support@atmark.ai': 'implicitDeny',
      // 환영 메일(ADR-0006 2026-09-30 개정).
      'onve@atmark.ai': 'allowed',
      'abuse@atmark.ai': 'implicitDeny',
      'postmaster@atmark.ai': 'implicitDeny',
      // 소문자 정확 일치 허용만 있다 — 변형은 전부 암묵 거부.
      ...Object.fromEntries(VARIANT_PROBES.map((probe) => [probe, 'implicitDeny'])),
    });
    expect(sender).toEqual({
      'probe@atmark.ai': 'allowed',
      'login@atmark.ai': 'explicitDeny',
      'agent-probe@atmark.ai': 'allowed',
      'notify@atmark.ai': 'allowed',
      // 기본 라우팅(agent_and_notify)에서는 support@ 가 지원 에이전트의 대표 주소라 발송 역할이 보낸다 — 함수 밖 Deny 가 없다.
      'support@atmark.ai': 'allowed',
      // 지원 에이전트의 별칭 — 발송 역할도 보낸다.
      'onve@atmark.ai': 'allowed',
      // 202609301540 — 지원 에이전트의 별칭이어도 수신 전용이라 명시 Deny.
      'abuse@atmark.ai': 'explicitDeny',
      'postmaster@atmark.ai': 'explicitDeny',
      // 2026-09-24 검증 F1 — 대소문자·하위 주소 변형도 명시 Deny(support@ 변형 포함 — 예약 접미사·정규형 밖 문자 Deny 는 라우팅과 무관).
      ...Object.fromEntries(VARIANT_PROBES.map((probe) => [probe, 'explicitDeny'])),
    });
  });

  it('템플릿 평가 자체(forward 명시): 발송 역할은 support@ 도 함수 밖에서 명시 Deny(ADR-0009) — 나머지는 기본과 같다', () => {
    const { table } = decisionTable(undefined, forwardRoutingCompute());
    const sender = table[`arn:aws:iam::${ACCOUNT}:role/atmark-runtime-sender`];
    expect(sender).toEqual({
      'probe@atmark.ai': 'allowed',
      'login@atmark.ai': 'explicitDeny',
      'agent-probe@atmark.ai': 'allowed',
      'notify@atmark.ai': 'allowed',
      'support@atmark.ai': 'explicitDeny',
      'onve@atmark.ai': 'allowed',
      'abuse@atmark.ai': 'explicitDeny',
      'postmaster@atmark.ai': 'explicitDeny',
      ...Object.fromEntries(VARIANT_PROBES.map((probe) => [probe, 'explicitDeny'])),
    });
  });

  it('login-mailer 조건을 *@atmark.ai 로 넓히면 FAIL — 다른 주소로 보낼 수 있다', () => {
    const { status, output } = runScript((roles) => {
      const widened = (roles.get('atmark-runtime-login-mailer') ?? []).map((statement) =>
        statement.Effect === 'Allow' && statement.Condition !== undefined
          ? { ...statement, Condition: { StringLike: { 'ses:FromAddress': '*@atmark.ai' } } }
          : statement,
      );
      roles.set('atmark-runtime-login-mailer', widened);
    });
    expect(output).toMatch(/FAIL atmark-runtime-login-mailer\s+probe@atmark\.ai 로 보낼 수 있다/);
    expect(output).toMatch(/FAIL atmark-runtime-login-mailer\s+agent-probe@atmark\.ai 로 보낼 수 있다/);
    expect(status).toBe(1);
  });

  it('발송 역할의 login@ Deny 를 지우면 FAIL (deniedFromAddress)', () => {
    const { status, output } = runScript((roles) => {
      roles.set('atmark-runtime-sender', (roles.get('atmark-runtime-sender') ?? []).filter((statement) => statement.Effect !== 'Deny'));
    });
    expect(output).toMatch(/FAIL atmark-runtime-sender\s+login@atmark\.ai 로 보낼 수 있다/);
    expect(status).toBe(1);
  });

  it('발송 역할의 support@ Deny(함수 밖) 만 지우면 FAIL — api 등이 문의 주소를 사칭할 수 있다 (US-009)', () => {
    // forward 로 합성한 템플릿 + forward 기대(기본 agent_and_notify 는 그 Deny 가 없는 게 정상이다).
    const { status, output } = runScript(
      (roles) => {
        roles.set(
          'atmark-runtime-sender',
          (roles.get('atmark-runtime-sender') ?? []).filter((statement) => !(statement.Effect === 'Deny' && JSON.stringify(statement.Condition ?? {}).includes('support@atmark.ai'))),
        );
      },
      { compute: forwardRoutingCompute(), routing: 'forward' },
    );
    expect(output).toMatch(/FAIL atmark-runtime-sender\s+support@atmark\.ai 로 보낼 수 있다/);
    expect(output).not.toMatch(/FAIL atmark-runtime-sender\s+login@atmark\.ai/);
    expect(status).toBe(1);
  });

  it('발송 역할의 수신 전용 Deny(abuse@·postmaster@) 를 지우면 FAIL — deniedFromAddresses (202609301540)', () => {
    const { status, output } = runScript((roles) => {
      roles.set('atmark-runtime-sender', (roles.get('atmark-runtime-sender') ?? []).filter((statement) => statement.Sid !== 'SesDenyReceiveOnlyFromAddress'));
    });
    expect(output).toMatch(/FAIL atmark-runtime-sender\s+abuse@atmark\.ai 로 보낼 수 있다 — 그 주소는 다른 역할·함수 전용이다/);
    expect(output).toMatch(/FAIL atmark-runtime-sender\s+postmaster@atmark\.ai 로 보낼 수 있다/);
    // 대문자·하위 주소 변형은 정규형 밖 문자 Deny 가 여전히 막는다 — 되돌림이 드러내는 것은 소문자 정확 주소뿐이다.
    expect(output).not.toMatch(/FAIL atmark-runtime-sender\s+ABUSE@atmark\.ai/);
    expect(output).not.toMatch(/FAIL atmark-runtime-sender\s+abuse\+x@atmark\.ai/);
    expect(output).not.toMatch(/FAIL atmark-runtime-sender\s+login@atmark\.ai/);
    expect(status).toBe(1);
  });

  it('F1 되돌림: 예약 주소 Deny 를 대소문자 구분 StringEquals 로 · 정규형 밖 문자 Deny 를 지우면 FAIL (reservedVariant)', () => {
    const { status, output } = runScript((roles) => {
      const reverted = (roles.get('atmark-runtime-sender') ?? [])
        .filter((statement) => !(statement.Effect === 'Deny' && JSON.stringify(statement.Condition ?? {}).includes('*+*')))
        .map((statement) => {
          if (statement.Effect !== 'Deny' || statement.Condition === undefined) return statement;
          const { StringEqualsIgnoreCase: ignoreCase, ...rest } = statement.Condition as Record<string, Record<string, unknown>>;
          return ignoreCase === undefined ? statement : { ...statement, Condition: { StringEquals: ignoreCase, ...rest } };
        });
      roles.set('atmark-runtime-sender', reverted);
    });
    for (const probe of F1_PROBES) {
      expect(output).toMatch(new RegExp(`FAIL atmark-runtime-sender\\s+${probe.replace(/[.+]/g, '\\$&')} 로 보낼 수 있다 — 예약 주소의`));
    }
    // 소문자 정확 일치는 여전히 막힌다 — 되돌림이 드러내는 것은 변형뿐이다.
    expect(output).not.toMatch(/FAIL atmark-runtime-sender\s+login@atmark\.ai/);
    expect(status).toBe(1);
  });

  it('F1: 정규형 밖 문자 Deny 만 지워도 하위 주소(login+x@·support+x@)가 FAIL', () => {
    const { status, output } = runScript((roles) => {
      roles.set(
        'atmark-runtime-sender',
        (roles.get('atmark-runtime-sender') ?? []).filter((statement) => !(statement.Effect === 'Deny' && JSON.stringify(statement.Condition ?? {}).includes('*+*'))),
      );
    });
    expect(output).toMatch(/FAIL atmark-runtime-sender\s+login\+x@atmark\.ai 로 보낼 수 있다/);
    expect(output).toMatch(/FAIL atmark-runtime-sender\s+support\+x@atmark\.ai 로 보낼 수 있다/);
    // IgnoreCase 정확 일치 Deny 가 남아 있으니 대소문자 변형은 여전히 막힌다.
    expect(output).not.toMatch(/FAIL atmark-runtime-sender\s+LOGIN@atmark\.ai/);
    expect(status).toBe(1);
  });

  it('M3a 되돌림: 예약 접미사 Deny 를 지우면 앞에 제어문자·접힘 공백이 붙은 예약 주소가 전부 FAIL (reservedVariant)', () => {
    // 제어문자 패턴(`*\t*` 등)은 정책에 없다 — IAM API 가 인쇄 가능 ASCII 밖을 거부한다(2026-09-24 운영 배포 실측). 앞에 붙은 제어문자의
    // 방어는 이 접미사 Deny 하나다. 사이에 낀 제어문자(`lo\tgin@`)는 IAM 이 못 막는다 — 런타임 assertHeaderSafe·알람 10 의 몫이라 probe 에 없다.
    const { status, output } = runScript((roles) => {
      roles.set('atmark-runtime-sender', (roles.get('atmark-runtime-sender') ?? []).filter((statement) => statement.Sid !== 'SesDenyReservedSuffixFromAddress'));
    });
    for (const [, shown] of M3A_PROBES) {
      expect(output).toMatch(new RegExp(`FAIL atmark-runtime-sender\\s+${shown.replace(/[$\\.'+]/g, '\\$&')} 로 보낼 수 있다 — 예약 주소의`));
    }
    // F1 변형은 여전히 막힌다 — 되돌림이 드러내는 것은 제어문자 변형뿐이다.
    expect(output).not.toMatch(/FAIL atmark-runtime-sender\s+LOGIN@atmark\.ai/);
    expect(status).toBe(1);
  });

  it('M3a: 합성된 발송 역할 정책에는 제어문자 패턴이 없고 예약 접미사 Deny 가 있다 — 둘이 함께여야 배포되고 막힌다', () => {
    const statements = [...statementsByRole(runtimeTemplates().compute).values()].flat().filter((statement) => String(statement.Sid ?? '').startsWith('SesDeny'));
    const values = (statements.flatMap((statement) => Object.values(statement.Condition ?? {}).flatMap((entries) => Object.values(entries as Record<string, unknown>))) as unknown[]).flat();
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) expect(/[^\x20-\x7e]/.test(String(value)), JSON.stringify(value)).toBe(false);
    expect(statements.some((statement) => statement.Sid === 'SesDenyReservedSuffixFromAddress' && statement.Effect === 'Deny')).toBe(true);
  });

  it('allowlist 밖 역할이 login@ 로만 보낼 수 있어도 발송 가능 주체로 세고 FAIL 한다', () => {
    const { status, output } = runScript((roles) => {
      roles.set('atmark-runtime-rogue', [
        { Effect: 'Allow', Action: ['ses:SendEmail'], Resource: [IDENTITY], Condition: { StringEquals: { 'ses:FromAddress': 'login@atmark.ai' } } },
      ]);
    });
    expect(output).toMatch(/FAIL atmark-runtime-rogue\s+발송 가능하나 allowlist 에 없음/);
    expect(status).toBe(1);
  });

  it('문의 라우팅 — 기본(agent_and_notify) 합성: 같은 값·기본 → exit 0 · forward 기대면 support@ FAIL / forward 합성: forward 기대 → exit 0 · agent 기대면 support@ 로 못 보내 FAIL', () => {
    // 기본 템플릿(agent_and_notify) — 컨텍스트 없이 합성한 그대로가 운영 배포값이다.
    const ok = runScript(undefined, { routing: 'agent_and_notify' });
    expect(ok.output).toContain('문의 라우팅: agent_and_notify');
    expect(ok.output).not.toContain('FAIL');
    expect(ok.status).toBe(0);

    // 기대를 forward 로 두면(옛 기본) 기본 템플릿의 발송 역할은 support@ 를 보낼 수 있어 FAIL — 스크립트가 옛 기대를 조용히 통과시키지 않는다.
    const staleExpectation = runScript(undefined, { routing: 'forward' });
    expect(staleExpectation.output).toMatch(/FAIL atmark-runtime-sender\s+support@atmark\.ai 로 보낼 수 있다/);
    expect(staleExpectation.status).toBe(1);

    // forward 로 합성 + agent_and_forward 기대 — Deny 가 남아 있어 support@ 로 못 보낸다.
    const denyStillThere = runScript(undefined, { compute: forwardRoutingCompute(), routing: 'agent_and_forward' });
    expect(denyStillThere.output).toMatch(/FAIL atmark-runtime-sender\s+support@atmark\.ai 로 보낼 수 없다 — 보낼 수 있어야 한다/);
    expect(denyStillThere.status).toBe(1);

    // forward 로 합성 + 기대 없음(스크립트 기본 agent_and_notify)도 같은 FAIL — 기본이 forward 로 되돌아가지 않았음을 굳힌다.
    const forwardDeployedVsDefault = runScript(undefined, { compute: forwardRoutingCompute() });
    expect(forwardDeployedVsDefault.status).toBe(1);

    expect(runScript(undefined, { routing: 'bogus' }).status).toBe(2);
  }, 180_000);

  describe('SES identity 자원 정책(ADR-0014 단계 2 — 드라이런 픽스처)', () => {
    const SENDER_ARN = `arn:aws:iam::${ACCOUNT}:role/atmark-runtime-sender`;
    const DOMAIN = 'agents.example.com';
    const NAME = 'atmark-sender-11111111-1111-4111-8111-111111111111-0';
    const docFor = (domain: string): string => identityPolicyDocument({ senderRoleArn: SENDER_ARN, accountId: ACCOUNT, domain }, [`a@${domain}`, `b@${domain}`]);
    const good = docFor(DOMAIN);
    const patched = (domain: string, patch: (statement: Record<string, unknown>) => Record<string, unknown>): string => {
      const doc = JSON.parse(docFor(domain)) as { Version: string; Statement: Record<string, unknown>[] };
      return JSON.stringify({ ...doc, Statement: doc.Statement.map(patch) });
    };

    it('정상: 플랫폼 identity 정책 0 · 고객 identity 정책이 계약 모양(계약의 identityPolicyDocument 그대로) · 태그 없는 identity 정책 0 → exit 0', () => {
      const { status, output } = runScript(undefined, { identities: { 'atmark.ai': {}, [DOMAIN]: { [NAME]: good }, 'agents.younkyum.me': {} } });
      expect(output).toContain('[SES identity 자원 정책]');
      expect(output).toMatch(/ok {3}atmark\.ai\s+플랫폼 identity — 자원 정책 0/);
      expect(output).toMatch(new RegExp(`ok {3}${DOMAIN.replace(/\./g, '\\.')}\\s+정책 1개`));
      expect(output).toContain('identity 3개 검사');
      expect(output).toContain('ok    런타임 역할 2개 = 기대 2개');
      expect(output).not.toContain('FAIL');
      expect(status).toBe(0);
    });

    // 위반마다 identity 하나(스크립트 한 번 — bash 실행이 건당 수 초라 묶는다). 각 identity 의 FAIL 줄이 그 사유를 말해야 한다.
    const VIOLATIONS: readonly (readonly [string, (domain: string) => string, string])[] = [
      ['principal-star', (d) => patched(d, (s) => ({ ...s, Principal: '*' })), 'Principal 이 발송 역할 하나가 아니다'],
      ['principal-admin', (d) => patched(d, (s) => ({ ...s, Principal: { AWS: `arn:aws:iam::${ACCOUNT}:role/atmark-runtime-admin` } })), 'Principal 이 발송 역할 하나가 아니다'],
      ['principal-foreign', (d) => patched(d, (s) => ({ ...s, Principal: { AWS: 'arn:aws:iam::999999999999:root' } })), 'Principal 이 발송 역할 하나가 아니다'],
      ['bulk', (d) => patched(d, (s) => ({ ...s, Action: ['ses:SendEmail', 'ses:SendBulkEmail'] })), '허용 밖 Action'],
      ['ses-star', (d) => patched(d, (s) => ({ ...s, Action: 'ses:*' })), '허용 밖 Action'],
      ['no-condition', (d) => patched(d, ({ Condition: _c, ...s }) => s), '조건이 StringEquals ses:FromAddress 하나가 아니다'],
      ['string-like', (d) => patched(d, (s) => ({ ...s, Condition: { StringLike: { 'ses:FromAddress': `*@${d}` } } })), '조건이 StringEquals ses:FromAddress 하나가 아니다'],
      ['foreign-address', (d) => patched(d, (s) => ({ ...s, Condition: { StringEquals: { 'ses:FromAddress': ['ceo@example.com'] } } })), '발신 주소가 이 도메인의 주소 목록이 아니다'],
      ['double-at', (d) => patched(d, (s) => ({ ...s, Condition: { StringEquals: { 'ses:FromAddress': [`x@evil.com@${d}`] } } })), '발신 주소가 이 도메인의 주소 목록이 아니다'],
      ['wildcard-resource', (d) => patched(d, (s) => ({ ...s, Resource: `arn:aws:ses:ap-northeast-2:${ACCOUNT}:identity/*` })), 'Resource 가 이 identity 가 아니다'],
      ['deny', (d) => patched(d, (s) => ({ ...s, Effect: 'Deny' })), 'Allow 가 아닌 문장'],
      ['not-principal', (d) => patched(d, (s) => ({ ...s, NotPrincipal: { AWS: SENDER_ARN } })), 'Not* 칸'],
      ['not-json', () => 'not json', 'JSON 이 아니다'],
    ];

    it('고객 identity 정책 위반(Principal * · 다른 역할 · 다른 계정 · 대량 액션 · ses:* · 조건 없음 · StringLike · 남의 주소 · identity/* · Deny · NotPrincipal · JSON 아님) → 각각 FAIL', () => {
      const identities: Record<string, Record<string, string>> = { 'atmark.ai': {} };
      for (const [id, build] of VIOLATIONS) {
        const domain = `${id}.example.com`;
        identities[domain] = { [NAME]: build(domain) };
      }
      // 이름 접두사 밖 · 플랫폼 identity(와 하위)에 붙은 정책.
      identities['named.example.com'] = { 'console-test': docFor('named.example.com') };
      identities['tx.atmark.ai'] = { y: good };
      const { status, output } = runScript(undefined, { identities });
      for (const [id, , problem] of VIOLATIONS) {
        expect(output, id).toMatch(new RegExp(`FAIL ${id.replace(/-/g, '\\-')}\\.example\\.com\\s+${NAME}: ${problem.replace(/[*.+]/g, '\\$&')}`));
      }
      expect(output).toContain('console-test: 이름이 atmark-sender- 로 시작하지 않는다');
      expect(output).toMatch(/FAIL tx\.atmark\.ai\s+y: 플랫폼 identity 에 자원 정책이 있다/);
      expect(output).toMatch(/ok {3}atmark\.ai\s+플랫폼 identity — 자원 정책 0/);
      expect(status).toBe(1);
    }, 60_000);

    it('allowlist 의 기대값은 계약·스택과 같다 — 발송 역할 이름 · 정책 이름 접두사 · 액션 둘', () => {
      const allowlist = JSON.parse(readFileSync(repoPath('docs/ops/ses-principals-allowlist.json'), 'utf8')) as {
        runtimeRoles: { mustEqual: number };
        resourcePolicyGrants: { allowedPrincipalRole: string; policyNamePrefix: string; allowedActions: string[]; platformIdentities: string[] };
      };
      expect(allowlist.runtimeRoles.mustEqual).toBe(2);
      expect(allowlist.resourcePolicyGrants.allowedPrincipalRole).toBe(SENDER_ROLE_NAME);
      expect(allowlist.resourcePolicyGrants.policyNamePrefix).toBe(IDENTITY_POLICY_NAME_PREFIX);
      expect(allowlist.resourcePolicyGrants.allowedActions).toEqual(JSON.parse(good).Statement[0].Action);
      expect(allowlist.resourcePolicyGrants.platformIdentities).toEqual(['atmark.ai']);
    });
  });

  it('bash 문법 검사', () => {
    expect(() => execFileSync('bash', ['-n', repoPath('scripts/check-ses-principals.sh')])).not.toThrow();
  });
});
