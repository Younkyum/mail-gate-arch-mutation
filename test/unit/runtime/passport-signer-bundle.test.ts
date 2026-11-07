/**
 * **복호 코드는 서명 Lambda 번들에만 들어간다** (§3.5 AC-e2 — 런타임판). import 규칙(dependency-cruiser · arch 테스트)이 소스 그래프를
 * 막는다면, 이 테스트는 **배포되는 바이트**를 본다: api·admin 번들에 KMS `DecryptCommand`·AES-GCM 복호·개인키 파싱이 없고, passport-signer
 * 번들에는 있다(비공허). `pnpm build:lambda` 와 같은 설정으로 메모리 번들을 만든다(디스크에 쓰지 않는다).
 */

import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

import { lambdaBuildOptions } from '../../../scripts/build-lambda';

async function bundleText(name: string): Promise<string> {
  const result = await build({ ...lambdaBuildOptions(name), write: false, outfile: `/virtual/${name}/index.js`, logLevel: 'silent' });
  return result.outputFiles?.[0]?.text ?? '';
}

/**
 * 표지는 **우리 코드**(signer.ts)에만 있는 문자열이다. SDK 이름(`DecryptCommand`)은 표지가 될 수 없다 — KMS 클라이언트 패키지는 CJS 한 덩어리라
 * admin 번들(GenerateDataKey 만 쓰는)에도 명령 클래스 전부가 실린다. 막아야 하는 것은 SDK 가 아니라 **복호하는 우리 코드 경로**다.
 */
const DECRYPT_MARKERS = [/envelope_decrypt_failed/, /private_key_public_key_mismatch/, /key_ref_not_agent_secret/];

describe('복호 코드의 번들 격리', () => {
  it.each(['api', 'admin', 'login-mailer', 'migrate'])('%s 번들에는 복호·개인키 파싱 코드가 없다', async (name) => {
    const text = await bundleText(name);
    expect(text.length).toBeGreaterThan(10_000);
    for (const marker of DECRYPT_MARKERS) expect(text, `${name}: ${String(marker)}`).not.toMatch(marker);
  }, 60_000);

  it('passport-signer 번들에는 있다(비공허) · SES SDK 는 없다', async () => {
    const text = await bundleText('passport-signer');
    for (const marker of DECRYPT_MARKERS) expect(text).toMatch(marker);
    // SES SDK 가 번들에 없다 — 이 Lambda 는 메일을 보낼 코드가 아예 없다(역할의 SES 권한 0 과 짝).
    expect(text).not.toMatch(/SendEmailCommand/);
  }, 60_000);
});
