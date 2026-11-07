/**
 * 운영 스택(Network · Data · ApiCertificate · Billing · Compute)과 그 입력 스택을 `infra/cdk/app.ts` 와 같은 배선으로
 * 한 App 에 세운다. **단언을 하지 않는다** — 단언은 각 테스트 파일에 있다.
 *
 * `app.ts` 를 import 하지 않는 이유: 그 파일은 import 되는 순간 App 을 만들고 운영 synth 규칙(빌드 산출물 필수)을
 * 따른다. 여기서는 Lambda 코드를 스텁으로 고정한다 — IAM·네트워크·스케줄은 코드와 무관하다.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import { expect } from 'vitest';

import { API_DOMAIN_NAME, ApiCertificateStack, CONSOLE_DOMAIN_NAME, OPS_DOMAIN_NAME } from '../../../infra/cdk/stacks/api-certificate-stack';
import { BillingStack } from '../../../infra/cdk/stacks/billing-stack';
import { ComputeStack } from '../../../infra/cdk/stacks/compute-stack';
import { DataStack } from '../../../infra/cdk/stacks/data-stack';
import { IDENTITY_DOMAIN_NAME, IdentityCdnStack, IdentityCertificateStack } from '../../../infra/cdk/stacks/identity-cdn-stack';
import { InboundStack } from '../../../infra/cdk/stacks/inbound-stack';
import type { LambdaCodeSource } from '../../../infra/cdk/stacks/lambda-code';
import { NetworkStack } from '../../../infra/cdk/stacks/network-stack';
import { PassportStack } from '../../../infra/cdk/stacks/passport-stack';
import { SecretsKeyStack } from '../../../infra/cdk/stacks/secrets-key-stack';
import { SesStack } from '../../../infra/cdk/stacks/ses-stack';
import { SES_SEND_DENY_SID } from '../../../infra/cdk/stacks/ses-send-deny';
import { SSM_DELETE_DENY_SID } from '../../../infra/cdk/stacks/ssm-secrets';
import { StorageStack } from '../../../infra/cdk/stacks/storage-stack';
import { TransparencyStack, transparencyLogBucketName } from '../../../infra/cdk/stacks/transparency-stack';
import { REALTIME_DOMAIN_NAME } from '../../../src/realtime/contract';

export const ACCOUNT = '123456789012';
export const REGION = 'ap-northeast-2';

export interface RuntimeApp {
  readonly app: cdk.App;
  readonly identityCdn: IdentityCdnStack;
  readonly network: NetworkStack;
  readonly data: DataStack;
  readonly compute: ComputeStack;
  readonly transparency: TransparencyStack;
  readonly billing: BillingStack;
  readonly secretsKey: SecretsKeyStack;
}

/** `opsDomain`: `app.ts` 의 `atmark:opsDomainReady=true` 와 같은 배선(인증서 발급 뒤). 기본은 도메인 없음(롤아웃 §5 2단계와 같다). */
export function buildRuntimeApp(
  lambdaCode: LambdaCodeSource = { kind: 'stub' },
  options: { readonly opsDomain?: boolean; readonly realtimeDomain?: boolean } = {},
): RuntimeApp {
  const app = new cdk.App();
  const env = { account: ACCOUNT, region: REGION };
  const ses = new SesStack(app, 'AtmarkSes', { env });
  const passport = new PassportStack(app, 'AtmarkPassport', { env });
  const secretsKey = new SecretsKeyStack(app, 'AtmarkSecretsKey', { env });
  const identityCertificate = new IdentityCertificateStack(app, 'AtmarkIdentityCertificate', {
    env: { account: ACCOUNT, region: 'us-east-1' },
    domainName: IDENTITY_DOMAIN_NAME,
    crossRegionReferences: true,
  });
  const identityCdn = new IdentityCdnStack(app, 'AtmarkIdentityCdn', {
    env,
    domainName: IDENTITY_DOMAIN_NAME,
    certificate: identityCertificate.certificate,
    apiOriginDomainName: API_DOMAIN_NAME,
    transparencyLogBucketName: transparencyLogBucketName(ACCOUNT, REGION),
    crossRegionReferences: true,
  });
  const storage = new StorageStack(app, 'AtmarkStorage', { env });
  const inbound = new InboundStack(app, 'AtmarkInbound', { env, mailBucketName: storage.mailBucket.bucketName });
  const network = new NetworkStack(app, 'AtmarkNetwork', { env });
  const data = new DataStack(app, 'AtmarkData', {
    env,
    vpc: network.vpc,
    databaseSecurityGroup: network.databaseSecurityGroup,
  });
  const transparency = new TransparencyStack(app, 'AtmarkTransparency', {
    env,
    vpc: network.vpc,
    lambdaSecurityGroup: network.lambdaSecurityGroup,
    identityDistribution: identityCdn.distribution,
    lambdaCode,
    ssmSecretsKey: secretsKey.key,
  });
  const certificate = new ApiCertificateStack(app, 'AtmarkApiCertificate', { env, domainName: API_DOMAIN_NAME });
  const consoleCertificate = new ApiCertificateStack(app, 'AtmarkConsoleCertificate', {
    env,
    domainName: CONSOLE_DOMAIN_NAME,
    certificateName: 'atmark-console',
  });
  const opsCertificate = new ApiCertificateStack(app, 'AtmarkOpsCertificate', {
    env,
    domainName: OPS_DOMAIN_NAME,
    certificateName: 'atmark-ops',
  });
  // 묶음 E — `app.ts` 의 `atmark:realtimeDomainReady=true` 와 같은 배선(인증서 발급 뒤). 기본은 도메인 없음.
  const realtimeCertificate = new ApiCertificateStack(app, 'AtmarkRealtimeCertificate', {
    env,
    domainName: REALTIME_DOMAIN_NAME,
    certificateName: 'atmark-realtime',
  });
  const billing = new BillingStack(app, 'AtmarkBilling', { env });
  const compute = new ComputeStack(app, 'AtmarkCompute', {
    env,
    vpc: network.vpc,
    lambdaSecurityGroup: network.lambdaSecurityGroup,
    mailBucket: storage.mailBucket as s3.IBucket,
    sesEventQueue: ses.eventQueue,
    inboundQueue: inbound.queue,
    secrets: {
      dbMaster: data.masterSecret,
      dbOwner: data.ownerSecret,
      dbApp: data.appSecret,
      dbAdmin: data.adminSecret,
      dbLoginMailer: data.loginMailerSecret,
      approvalLinkKeys: data.approvalLinkKeysSecret,
      webhookSecretKeys: data.webhookSecretKeysSecret,
      ownerLoginKeys: data.ownerLoginKeysSecret,
      contactForwardTo: data.contactForwardToSecret,
      dbPassportSigner: data.passportSignerSecret,
      dbTlog: transparency.dbSecret,
      dbTlogAnchor: transparency.dbAnchorSecret,
      dbOps: data.opsDbSecret,
      opsKeys: data.opsKeysSecret,
      opsLoginKeys: data.opsLoginKeysSecret,
    },
    passportKey: passport.agentKeypairKey,
    ssmSecretsKey: secretsKey.key,
    identityBucket: identityCdn.bucket as s3.IBucket,
    identityDistribution: identityCdn.distribution,
    apiDomain: { domainName: API_DOMAIN_NAME, certificate: certificate.certificate },
    consoleDomain: { domainName: CONSOLE_DOMAIN_NAME, certificate: consoleCertificate.certificate },
    ...(options.opsDomain === true ? { opsDomain: { domainName: OPS_DOMAIN_NAME, certificate: opsCertificate.certificate } } : {}),
    ...(options.realtimeDomain === true
      ? { realtimeDomain: { domainName: REALTIME_DOMAIN_NAME, certificate: realtimeCertificate.certificate } }
      : {}),
    billing: {
      queue: billing.queue,
      paddleWebhookSecret: billing.paddleWebhookSecret,
      paddleSyncApiKeySecret: billing.paddleSyncApiKeySecret,
      paddleAdminApiKeySecret: billing.paddleAdminApiKeySecret,
      dbBillingSecret: billing.dbBillingSecret,
      dbBillingOperatorSecret: billing.dbBillingOperatorSecret,
    },
    lambdaCode,
  });
  return { app, identityCdn, network, data, compute, transparency, billing, secretsKey };
}

/**
 * 기본(컨텍스트·props 없음 · 스텁 코드) 런타임 앱의 템플릿 — **테스트 실행 전체에서 synth 한 번.**
 *
 * 예전에는 파일마다(vitest 는 파일마다 모듈을 새로 읽는다) 이 함수가 `Template.fromStack` 세 번을 불렀고, `fromStack` 은
 * 부를 때마다 **앱 전체**를 다시 synth 한다(`force: true`). infra 테스트 ~12 파일이 각자 3~6번 전체 synth 를 했다.
 * 지금은 한 번 synth 한 결과를 `node_modules/.cache/atmark-cdk-test/<키>.json` 에 두고 모든 파일·워커가 읽는다.
 *
 * **캐시 키 = synth 결과를 바꿀 수 있는 입력 전부의 해시:** 이 파일에서 시작한 상대 import 폐포(스택 · 스택이 상수를 가져오는
 * `src/**` 파일)의 내용, `infra/**` 전체, `cdk.json`, aws-cdk-lib·constructs 버전, `CDK_*` 환경 변수(컨텍스트 주입 경로).
 * 하나라도 바뀌면 키가 바뀌어 다시 synth 한다. 판단이 서지 않는 입력은 키에 넣는 쪽으로 기운다 — 거짓 적중이 가장 비싸다.
 *
 * **캐시하지 않는 것:** `buildRuntimeApp()` 을 직접 부르는 경로(컨텍스트를 바꿔 synth 하는 테스트 — 콘솔 스위치, 투명성 로그
 * 스테이징 등)와 다른 스택을 스스로 세우는 테스트. 그 테스트들은 매번 자기 synth 를 한다.
 * 끄기: `ATMARK_CDK_TEST_CACHE=0` (디스크 캐시 없이 이 프로세스 안에서만 한 번 synth).
 */
type RuntimeStackKey = 'network' | 'data' | 'compute' | 'transparency' | 'identityCdn' | 'billing' | 'secretsKey';

interface RuntimeSynth {
  readonly templates: Record<RuntimeStackKey, Record<string, unknown>>;
  /** 어셈블리 매니페스트의 `missing`(context lookup 요청). 0건이어야 CI 가 자격증명 없이 synth 한다. */
  readonly missing: readonly unknown[];
}

const RUNTIME_STACK_KEYS: readonly RuntimeStackKey[] = ['network', 'data', 'compute', 'transparency', 'identityCdn', 'billing', 'secretsKey'];
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CACHE_DIR = join(REPO_ROOT, 'node_modules', '.cache', 'atmark-cdk-test');

function synthRuntime(): RuntimeSynth {
  const runtime = buildRuntimeApp();
  const assembly = runtime.app.synth();
  const templates = {} as Record<RuntimeStackKey, Record<string, unknown>>;
  for (const key of RUNTIME_STACK_KEYS) {
    templates[key] = assembly.getStackArtifact(runtime[key].artifactId).template as Record<string, unknown>;
  }
  return { templates, missing: assembly.manifest.missing ?? [] };
}

/** 이 파일에서 시작하는 상대 import 폐포(.ts · .json). 패키지 import 는 버전으로 따로 잡는다. */
function importClosure(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  const specifier = /(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!file.endsWith('.ts')) continue;
    for (const match of readFileSync(file, 'utf8').matchAll(specifier)) {
      const base = resolve(dirname(file), match[1]!);
      const candidates = [base, `${base}.ts`, join(base, 'index.ts'), base.replace(/\.js$/, '.ts')];
      const found = candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
      if (found !== undefined) queue.push(found);
    }
  }
  return [...seen].sort();
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

function packageVersion(name: string): string {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'node_modules', name, 'package.json'), 'utf8')) as { version: string };
  return manifest.version;
}

export function runtimeCacheKey(): string {
  const hash = createHash('sha256');
  const files = new Set([
    ...importClosure(fileURLToPath(import.meta.url)),
    ...filesUnder(join(REPO_ROOT, 'infra')),
    join(REPO_ROOT, 'cdk.json'),
  ]);
  for (const file of [...files].sort()) {
    hash.update(`${relative(REPO_ROOT, file)}\0`);
    if (existsSync(file)) hash.update(readFileSync(file));
    hash.update('\0');
  }
  hash.update(`aws-cdk-lib@${packageVersion('aws-cdk-lib')} constructs@${packageVersion('constructs')}\0`);
  for (const name of Object.keys(process.env).filter((key) => key.startsWith('CDK_')).sort()) {
    hash.update(`${name}=${process.env[name] ?? ''}\0`);
  }
  return hash.digest('hex').slice(0, 32);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readCached(file: string): RuntimeSynth | undefined {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as RuntimeSynth;
  } catch {
    return undefined;
  }
}

/**
 * 디스크 캐시. 여러 워커가 동시에 비어 있는 캐시를 만나면 **하나만** synth 한다 — `mkdir` 잠금(원자적)을 잡은 워커가
 * synth 해 임시 파일에 쓰고 `rename`(원자적)으로 게시한다. 나머지는 게시를 기다린다. 잠금이 10분 넘게 남아 있으면
 * (죽은 워커) 치우고 다시 시도한다. 기다림이 길어지면 스스로 synth 한다 — 캐시는 속도 장치일 뿐, 정답의 출처가 아니다.
 */
function loadRuntimeSynth(): RuntimeSynth {
  if (process.env['ATMARK_CDK_TEST_CACHE'] === '0') return synthRuntime();
  const key = runtimeCacheKey();
  const file = join(CACHE_DIR, `${key}.json`);
  const lock = join(CACHE_DIR, `${key}.lock`);
  mkdirSync(CACHE_DIR, { recursive: true });
  const deadline = Date.now() + 5 * 60_000;
  for (;;) {
    const hit = readCached(file);
    if (hit !== undefined) return hit;
    try {
      mkdirSync(lock);
    } catch {
      const held = statSync(lock, { throwIfNoEntry: false });
      if (held !== undefined && Date.now() - held.mtimeMs > 10 * 60_000) rmSync(lock, { recursive: true, force: true });
      if (Date.now() > deadline) return synthRuntime();
      sleepSync(200);
      continue;
    }
    try {
      const again = readCached(file);
      if (again !== undefined) return again;
      const synth = synthRuntime();
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(synth));
      renameSync(temp, file);
      // 이전 키의 캐시는 치운다 — 디렉터리가 끝없이 자라지 않게.
      for (const name of readdirSync(CACHE_DIR)) {
        if (name.endsWith('.json') && name !== `${key}.json`) rmSync(join(CACHE_DIR, name), { force: true });
      }
      return synth;
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  }
}

let cached: { readonly templates: Record<RuntimeStackKey, Template>; readonly missing: readonly unknown[] } | undefined;

function runtimeSynth(): NonNullable<typeof cached> {
  if (cached === undefined) {
    const synth = loadRuntimeSynth();
    const templates = {} as Record<RuntimeStackKey, Template>;
    for (const key of RUNTIME_STACK_KEYS) templates[key] = Template.fromJSON(synth.templates[key]);
    cached = { templates, missing: synth.missing };
  }
  return cached;
}

/** 기본 런타임 앱(스텁 코드)의 운영 세 스택 템플릿. 테스트 실행 전체에서 synth 한 번 — 위 설명. */
export function runtimeTemplates(): Record<'network' | 'data' | 'compute', Template> {
  const { network, data, compute } = runtimeSynth().templates;
  return { network, data, compute };
}

let forwardRoutedCompute: Template | undefined;

/**
 * 문의 라우팅을 `-c atmark:contactRouting=forward` 로 **명시**해 합성한 Compute 템플릿(2026-09-30 기본이 `forward` 를 떠난 뒤에도 — 지금 `agent_and_notify`
 * `forward` — support@ 는 전달만, 발송 역할에 `SesDenySupportFromOutsideForwarder` — 를 검증하려는 테스트용). 캐시하지 않는 별도 synth 라
 * 프로세스(파일)당 한 번만 한다.
 */
export function forwardRoutingCompute(): Template {
  if (forwardRoutedCompute === undefined) {
    const previous = process.env['CDK_CONTEXT_JSON'];
    process.env['CDK_CONTEXT_JSON'] = JSON.stringify({ 'atmark:contactRouting': 'forward' });
    try {
      forwardRoutedCompute = Template.fromStack(buildRuntimeApp().compute);
    } finally {
      if (previous === undefined) delete process.env['CDK_CONTEXT_JSON'];
      else process.env['CDK_CONTEXT_JSON'] = previous;
    }
  }
  return forwardRoutedCompute;
}

/** 같은 synth 의 다른 스택 템플릿(투명성 로그 · id.atmark.ai CDN · 결제 큐·비밀). */
export function runtimeStackTemplate(key: 'transparency' | 'identityCdn' | 'billing' | 'secretsKey'): Template {
  return runtimeSynth().templates[key];
}

/** 기본 런타임 앱 synth 의 context lookup 요청(`manifest.missing`). */
export function runtimeMissingContext(): readonly unknown[] {
  return runtimeSynth().missing;
}

export interface IamStatement {
  readonly Sid?: string;
  readonly Effect: string;
  readonly Action: string | readonly string[];
  readonly Resource?: unknown;
  readonly Condition?: Record<string, Record<string, unknown>>;
}

export function actionsOf(statement: IamStatement): string[] {
  return typeof statement.Action === 'string' ? [statement.Action] : [...statement.Action];
}

/** `AWS::IAM::Policy` 를 역할 논리 ID 별 문장 목록으로 모은다(전부 — 비발송 역할의 SES 발송 Deny 포함). */
export function allStatementsByRole(template: Template): Map<string, IamStatement[]> {
  const byRole = new Map<string, IamStatement[]>();
  const policies = template.findResources('AWS::IAM::Policy') as Record<
    string,
    { Properties: { Roles: { Ref: string }[]; PolicyDocument: { Statement: IamStatement[] } } }
  >;
  for (const policy of Object.values(policies)) {
    for (const role of policy.Properties.Roles) {
      byRole.set(role.Ref, [...(byRole.get(role.Ref) ?? []), ...policy.Properties.PolicyDocument.Statement]);
    }
  }
  return byRole;
}

/**
 * 역할별 문장 — **비발송 역할의 SES 발송 Deny(`ses-send-deny.ts`, Sid `SesSendDenyNonSendingRole`)를 뺀** 목록. 역할마다 "허용이 정확히 이것뿐"
 * 을 단언하는 기존 테스트들이 그 Deny 하나 때문에 모두 고쳐지지 않게 여기서 거른다 — Deny 의 존재는 `allStatementsByRole` 로 따로 전수 단언한다
 * (`compute-stack.test.ts` "비발송 역할 SES 발송 Deny" · `test/arch/iam-single-principal.arch.test.ts`). SSM 파라미터 삭제 Deny(`ssm-secrets.ts`,
 * Sid `SsmParameterDeleteDeny` — 모든 역할)도 같은 이유로 거른다 — 그 존재는 `compute-stack.test.ts` "SSM 비밀" 이 전수 단언한다.
 */
export function statementsByRole(template: Template): Map<string, IamStatement[]> {
  const blanket = new Set([SES_SEND_DENY_SID, SSM_DELETE_DENY_SID]);
  return new Map([...allStatementsByRole(template)].map(([role, statements]) => [role, statements.filter((s) => !blanket.has(s.Sid ?? ''))]));
}

/** SSM 비밀(2026-10-12 이전 — `ssm-secrets.ts`)을 이 문장이 **읽게** 하는가(Allow · `ssm:GetParameter` · 그 파라미터 ARN). 이름은 옛 이름(`atmark/…`). */
export function readsSsmSecret(statement: IamStatement, secretName: string): boolean {
  return (
    statement.Effect === 'Allow' &&
    actionsOf(statement).includes('ssm:GetParameter') &&
    JSON.stringify(statement.Resource).includes(`:parameter/${secretName}"`)
  );
}

/** 이 문장이 SSM 비밀에 **쓰게** 하는가(Allow · `ssm:PutParameter`). */
export function writesSsmSecret(statement: IamStatement, secretName: string): boolean {
  return (
    statement.Effect === 'Allow' &&
    actionsOf(statement).includes('ssm:PutParameter') &&
    JSON.stringify(statement.Resource).includes(`:parameter/${secretName}"`)
  );
}

export type Resources = Record<string, { Properties: Record<string, unknown> }>;

export function resourcesOf(template: Template, type: string): Resources {
  return template.findResources(type) as Resources;
}

/** 그 형식의 리소스가 정확히 하나라고 단언하고 그 `Properties` 를 돌려준다. */
export function onlyPropertiesOf(template: Template, type: string): Record<string, unknown> {
  const found = Object.values(resourcesOf(template, type));
  expect(found, type).toHaveLength(1);
  return found[0]?.Properties ?? {};
}
