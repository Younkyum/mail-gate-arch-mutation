/**
 * `src/mail/transport/ses-identity.ts` — SES 제어면 명령의 **입력 모양**(가짜 `send`, AWS 호출 0). 발송 명령이 없다는 것은
 * `test/arch/ses-import-boundary.arch.test.ts` 가 import 이름으로 본다.
 */

import { describe, expect, it } from 'vitest';

import { sesIdentityControlOf } from '../../../src/mail/transport/ses-identity';

function recorder(respond: (name: string) => unknown = () => ({})) {
  const sent: { name: string; input: Record<string, unknown> }[] = [];
  const control = sesIdentityControlOf({
    send(command) {
      const typed = command as { constructor: { name: string }; input: Record<string, unknown> };
      sent.push({ name: typed.constructor.name, input: typed.input });
      const out = respond(typed.constructor.name);
      return out instanceof Error ? Promise.reject(out) : Promise.resolve(out);
    },
  });
  return { control, sent };
}

describe('SES 제어면(ses-identity)', () => {
  it('만들기: Easy DKIM RSA 2048 · 태그 둘 — 구성 세트·발송 칸 없음', async () => {
    const { control, sent } = recorder();
    await control.createIdentity('agents.example.com', { 'atmark:row': 'r', 'atmark:managed': 'customer-domain' });
    expect(sent).toEqual([
      {
        name: 'CreateEmailIdentityCommand',
        input: {
          EmailIdentity: 'agents.example.com',
          DkimSigningAttributes: { NextSigningKeyLength: 'RSA_2048_BIT' },
          Tags: [
            { Key: 'atmark:row', Value: 'r' },
            { Key: 'atmark:managed', Value: 'customer-domain' },
          ],
        },
      },
    ]);
  });

  it('읽기: 태그·정책·DKIM·MAIL FROM 만 옮긴다 · NotFoundException 이면 null · 다른 오류는 던진다', async () => {
    const { control } = recorder(() => ({
      Tags: [{ Key: 'atmark:row', Value: 'r' }, { Key: 'x' }],
      Policies: { p: '{}' },
      DkimAttributes: { Tokens: ['a', 'b', 'c'], Status: 'SUCCESS' },
      MailFromAttributes: { MailFromDomainStatus: 'PENDING' },
    }));
    await expect(control.getIdentity('agents.example.com')).resolves.toEqual({
      tags: { 'atmark:row': 'r' },
      policies: { p: '{}' },
      dkimTokens: ['a', 'b', 'c'],
      dkimStatus: 'SUCCESS',
      mailFromStatus: 'PENDING',
    });
    const missing = recorder(() => Object.assign(new Error('nf'), { name: 'NotFoundException' }));
    await expect(missing.control.getIdentity('x.example.com')).resolves.toBeNull();
    const broken = recorder(() => Object.assign(new Error('t'), { name: 'TooManyRequestsException' }));
    await expect(broken.control.getIdentity('x.example.com')).rejects.toThrow('t');
  });

  it('MAIL FROM 은 USE_DEFAULT_VALUE · 정책·태그·지우기 명령의 입력', async () => {
    const { control, sent } = recorder();
    await control.putMailFrom('a.example.com', 'bounce.a.example.com');
    await control.putConfigurationSet('a.example.com', 'atmark-default');
    await control.createPolicy('a.example.com', 'n', 'doc');
    await control.updatePolicy('a.example.com', 'n', 'doc2');
    await control.deletePolicy('a.example.com', 'n');
    await control.tagIdentity('arn:x', { k: 'v' });
    await control.deleteIdentity('a.example.com');
    expect(sent.map((s) => s.name)).toEqual([
      'PutEmailIdentityMailFromAttributesCommand',
      'PutEmailIdentityConfigurationSetAttributesCommand',
      'CreateEmailIdentityPolicyCommand',
      'UpdateEmailIdentityPolicyCommand',
      'DeleteEmailIdentityPolicyCommand',
      'TagResourceCommand',
      'DeleteEmailIdentityCommand',
    ]);
    expect(sent[0]?.input).toEqual({ EmailIdentity: 'a.example.com', MailFromDomain: 'bounce.a.example.com', BehaviorOnMxFailure: 'USE_DEFAULT_VALUE' });
    expect(sent[5]?.input).toEqual({ ResourceArn: 'arn:x', Tags: [{ Key: 'k', Value: 'v' }] });
  });
});
