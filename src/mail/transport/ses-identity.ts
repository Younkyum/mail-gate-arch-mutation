/**
 * src/mail/transport/ses-identity.ts — **SES 제어면(identity) 명령만** 쓰는 파일(ADR-0014 단계 2 · 계획 §3.5 "파일 경계").
 *
 * SES SDK 를 import 하는 두 번째 파일이다. 첫째(`ses-transport.ts`)는 발송, 이 파일은 **고객 도메인 identity 의 생애**(만들기 · 읽기 · 태그 ·
 * MAIL FROM · 구성 세트 · identity policy · 지우기)다. 규칙:
 *   - **발송 명령(`Send*`)을 import 하지 않는다** — `test/arch/ses-import-boundary.arch.test.ts` 가 import 이름을 본다. 이 파일로는 메일을 보낼 수 없다.
 *   - 이 파일의 export 를 쓰는 곳은 둘이다(같은 arch 테스트): `src/runtime/handlers/domain-control.ts`(VPC 밖 · DB 없는 domain-control λ — 변형은
 *     IAM 이 그 역할에만 · 관리 태그가 있는 identity 에만 준다)와 `src/runtime/handlers/domain-policy-audit.ts`(읽기 전용 감사 λ — 역할은 Get·List 만).
 *   - 값은 판정에 필요한 것만 돌려준다(DKIM 토큰·상태 · MAIL FROM 상태 · 태그 · 정책 원문). 오류는 SDK 예외를 그대로 던진다 — 부르는 쪽이
 *     예외 **이름**만 `errorCode` 로 싣는다(값·도메인명 없음).
 */

import {
  CreateEmailIdentityCommand,
  CreateEmailIdentityPolicyCommand,
  DeleteEmailIdentityCommand,
  DeleteEmailIdentityPolicyCommand,
  GetEmailIdentityCommand,
  ListEmailIdentitiesCommand,
  PutEmailIdentityConfigurationSetAttributesCommand,
  PutEmailIdentityMailFromAttributesCommand,
  SESv2Client,
  TagResourceCommand,
  UpdateEmailIdentityPolicyCommand,
} from '@aws-sdk/client-sesv2';

/** identity 하나를 읽은 결과 — 판정에 쓰는 칸만. */
export interface SesIdentitySnapshot {
  /** 태그(키 → 값). `atmark:row` 대조에 쓴다. */
  readonly tags: Readonly<Record<string, string>>;
  /** 정책 이름 → 원문(JSON 문자열). */
  readonly policies: Readonly<Record<string, string>>;
  readonly dkimTokens: readonly string[];
  /** SES `DkimAttributes.Status` 원값(없으면 `null`). */
  readonly dkimStatus: string | null;
  /** SES `MailFromAttributes.MailFromDomainStatus` 원값(없으면 `null`). */
  readonly mailFromStatus: string | null;
}

/** domain-control 이 쓰는 SES 제어면 — 테스트는 이 면만 가짜로 준다. */
export interface SesIdentityControl {
  /** 없으면 `null`(NotFoundException). */
  getIdentity(domain: string): Promise<SesIdentitySnapshot | null>;
  /** Easy DKIM(RSA 2048) + 태그. 이미 있으면 SDK 의 `AlreadyExistsException` 을 그대로 던진다. */
  createIdentity(domain: string, tags: Readonly<Record<string, string>>): Promise<void>;
  /** 태그 덮어쓰기(채택 — 옛 행 → 새 행). */
  tagIdentity(identityArn: string, tags: Readonly<Record<string, string>>): Promise<void>;
  /** `BehaviorOnMxFailure = USE_DEFAULT_VALUE`(MAIL FROM MX 가 사라져도 발신은 계속 · SPF 정렬만 잃는다). */
  putMailFrom(domain: string, mailFromDomain: string): Promise<void>;
  putConfigurationSet(domain: string, configurationSetName: string): Promise<void>;
  createPolicy(domain: string, policyName: string, policy: string): Promise<void>;
  updatePolicy(domain: string, policyName: string, policy: string): Promise<void>;
  deletePolicy(domain: string, policyName: string): Promise<void>;
  deleteIdentity(domain: string): Promise<void>;
  /** 계정의 identity 이름 전부(페이지를 끝까지) — 읽기 전용 정책 감사(`domain-policy-audit` λ)가 쓴다. */
  listIdentities(): Promise<readonly string[]>;
}

/** SDK 클라이언트의 `send` 중 여기서 쓰는 모양. */
interface SesIdentityClient {
  send(command: object): Promise<unknown>;
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && error.name === 'NotFoundException';
}

/** 클라이언트를 받아 제어면을 만든다(테스트는 가짜 `send` 를 준다). */
export function sesIdentityControlOf(client: SesIdentityClient): SesIdentityControl {
  return {
    async getIdentity(domain) {
      let output: {
        Tags?: readonly { Key?: string; Value?: string }[];
        Policies?: Record<string, string>;
        DkimAttributes?: { Tokens?: readonly string[]; Status?: string };
        MailFromAttributes?: { MailFromDomainStatus?: string };
      };
      try {
        output = (await client.send(new GetEmailIdentityCommand({ EmailIdentity: domain }))) as typeof output;
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
      const tags: Record<string, string> = {};
      for (const tag of output.Tags ?? []) {
        if (typeof tag.Key === 'string' && typeof tag.Value === 'string') tags[tag.Key] = tag.Value;
      }
      return {
        tags,
        policies: { ...(output.Policies ?? {}) },
        dkimTokens: [...(output.DkimAttributes?.Tokens ?? [])],
        dkimStatus: output.DkimAttributes?.Status ?? null,
        mailFromStatus: output.MailFromAttributes?.MailFromDomainStatus ?? null,
      };
    },
    async createIdentity(domain, tags) {
      await client.send(
        new CreateEmailIdentityCommand({
          EmailIdentity: domain,
          DkimSigningAttributes: { NextSigningKeyLength: 'RSA_2048_BIT' },
          Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
        }),
      );
    },
    async tagIdentity(identityArn, tags) {
      await client.send(new TagResourceCommand({ ResourceArn: identityArn, Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })) }));
    },
    async putMailFrom(domain, mailFromDomain) {
      await client.send(
        new PutEmailIdentityMailFromAttributesCommand({ EmailIdentity: domain, MailFromDomain: mailFromDomain, BehaviorOnMxFailure: 'USE_DEFAULT_VALUE' }),
      );
    },
    async putConfigurationSet(domain, configurationSetName) {
      await client.send(new PutEmailIdentityConfigurationSetAttributesCommand({ EmailIdentity: domain, ConfigurationSetName: configurationSetName }));
    },
    async createPolicy(domain, policyName, policy) {
      await client.send(new CreateEmailIdentityPolicyCommand({ EmailIdentity: domain, PolicyName: policyName, Policy: policy }));
    },
    async updatePolicy(domain, policyName, policy) {
      await client.send(new UpdateEmailIdentityPolicyCommand({ EmailIdentity: domain, PolicyName: policyName, Policy: policy }));
    },
    async deletePolicy(domain, policyName) {
      await client.send(new DeleteEmailIdentityPolicyCommand({ EmailIdentity: domain, PolicyName: policyName }));
    },
    async deleteIdentity(domain) {
      await client.send(new DeleteEmailIdentityCommand({ EmailIdentity: domain }));
    },
    async listIdentities() {
      const names: string[] = [];
      let token: string | undefined;
      // 상한 — 계정 identity 한도(리전당 10,000)를 페이지 1,000 으로 넘지 않는다. 그 너머는 비정상(무한 페이지)으로 본다.
      for (let page = 0; page < 20; page += 1) {
        const output = (await client.send(new ListEmailIdentitiesCommand({ PageSize: 1000, NextToken: token }))) as {
          EmailIdentities?: readonly { IdentityName?: string }[];
          NextToken?: string;
        };
        for (const identity of output.EmailIdentities ?? []) if (typeof identity.IdentityName === 'string') names.push(identity.IdentityName);
        token = output.NextToken;
        if (token === undefined || token === '') return names;
      }
      throw new Error('ListEmailIdentities 페이지가 끝나지 않는다');
    },
  };
}

/** 실제 SES 제어면. **부르는 순간 자격증명이 필요하다**(만들기만 해서는 네트워크를 타지 않는다). */
export function createSesIdentityControl(region: string): SesIdentityControl {
  const client = new SESv2Client({ region });
  return sesIdentityControlOf({ send: (command) => client.send(command as never) });
}
