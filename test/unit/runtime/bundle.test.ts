/**
 * `pnpm build:lambda` 의 설정으로 **메모리 번들**을 만든다 — 번들이 깨지는 변경(ESM 에서 안 되는 의존성, 해석 실패)을
 * CI 가 배포 전에 본다. 디스크에 쓰지 않는다.
 *
 *   - 핸들러 디렉터리 = 계약의 열(D2 와 공유한 이름 — 관리 백엔드가 `admin` 을, ADR-0006 이 `login-mailer` 를, 홈이 `site` 를,
 *     WP-2 가 `billing-webhook`·`billing-sync` 를, 사용자 문서가 `docs` 를 더했다).
 *   - 각 번들이 `handler` 를 export 한다.
 *   - ★ 어떤 번들에도 로컬 개발 구현(`createLocalObjectStore`·`createLocalDevKeyCustody`)이 들어가지 않는다.
 *   - `@aws-sdk/*` 는 번들 안에 있다(런타임 내장 SDK 에 기대지 않는다 — 버전 고정). `site` 밖은 전부 비밀 읽기 SDK 둘(SSM Parameter Store ·
 *     Secrets Manager — `src/runtime/secrets.ts` 가 식별자 모양으로 고른다, 2026-10-12 비밀 → SSM 이전)을 싣는다
 *     (`billing-webhook` 은 DB 비밀이 아니라 웹훅 서명 비밀을 읽는다).
 *   - ★ **`billing-webhook` 은 DB 를 모른다**(계획 원칙 1 · L6 — 인터넷에 열린 함수): 번들 metafile 의 입력에 `node_modules/pg/`·`src/db/` 가
 *     **0** 이다. 핸들러가 DB 클라이언트를 import 하면(변이 BL-1) 여기서 빨개진다 — 타입 전용 import 는 esbuild 가 지우므로 세지 않는다.
 *   - ★ **api 의 PDF 워커**(`LAMBDA_WORKER_ENTRIES`): 같은 설정으로 묶인 `pdf-text-worker.js` 가 api 번들이 찾는 이름(`PDF_WORKER_FILES` 의 첫째)이고,
 *     해석기·한국어 CMap 을 싣고, **디스크에 쓴 그 파일을 실제 워커로 띄우면** PDF 텍스트(한국어 CID 글꼴 포함)가 나온다. api 번들 자체에는
 *     해석기가 없다(워커에만).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

import { discoveredHandlers, LAMBDA_HANDLERS, LAMBDA_WORKER_ENTRIES, lambdaBuildOptions, lambdaWorkerBuildOptions } from '../../../scripts/build-lambda';
import { PDF_WORKER_FILES } from '../../../src/api/attachment-content';
import type { PdfWorkerMessage } from '../../../src/api/pdf-text-worker';
import { koreanCidPdf, minimalPdf } from '../../support/minimal-pdf';

/** 번들한 워커 파일을 띄워 끝 메시지까지 모은다. */
function runWorker(file: string, bytes: Uint8Array): Promise<PdfWorkerMessage[]> {
  return new Promise((resolve, reject) => {
    const messages: PdfWorkerMessage[] = [];
    const worker = new Worker(file, { workerData: { bytes, maxPages: 20, maxChars: 1000 } });
    worker.on('message', (message: PdfWorkerMessage) => {
      messages.push(message);
      if (message.type === 'end' || message.type === 'fail') {
        void worker.terminate().then(() => resolve(messages), reject);
      }
    });
    worker.on('error', reject);
  });
}

describe('Lambda 번들', () => {
  it('핸들러 디렉터리는 계약의 열과 같다', () => {
    expect(discoveredHandlers()).toEqual([...LAMBDA_HANDLERS].sort());
    // 19 — 투명성 로그(transparency-log, US-010) · 앵커를 별도 함수로(transparency-anchor, M5 2026-09-24) · 결제 웹훅·sync(WP-2) · 사용자 문서(docs).
    // 20 — 호스팅 운영자 콘솔(ops, ops.atmark.ai — `.omc/plans/ops-console.md`).
    // 21 — 고객 도메인 제어면(domain-control, ADR-0014 단계 2 — DB·비밀 없음 · VPC 밖).
    // 22 — 고객 도메인 자원 정책 독립 감사(domain-policy-audit — 읽기 전용, 보안 리뷰 M2).
    // 23 — AI 의심 메일 감시 결과 소비자(ai-watch-result, ADR-0017 초안 — 롤 atmark_ai_watch · SES 0 · S3 0).
    // 24 — 실시간 WebSocket(realtime, 묶음 E — 앱 롤 · 풀 1 · SES 0 · S3 0).
    expect(LAMBDA_HANDLERS).toHaveLength(24);
  });

  it.each([...LAMBDA_HANDLERS])('%s — 번들된다 · handler export · 로컬 구현 없음 · SDK 내장', async (name) => {
    const result = await build({ ...lambdaBuildOptions(name), write: false, outfile: `/virtual/${name}/index.js`, logLevel: 'silent' });
    expect(result.errors).toEqual([]);
    const text = result.outputFiles?.[0]?.text ?? '';
    expect(text.length).toBeGreaterThan(10_000);
    expect(text).toMatch(/export\s*\{[^}]*\bhandler\b[^}]*\}/);
    expect(text).not.toContain('function createLocalObjectStore');
    expect(text).not.toContain('function createLocalDevKeyCustody');
    expect(text).not.toMatch(/from\s+["']@aws-sdk\//); // 외부 import 로 남지 않았다
    // 홈(`site`)·문서(`docs`)·고객 도메인 제어면(`domain-control`)만 예외 — DB·비밀이 없다. 나머지는 전부 비밀을 SSM(옮긴 20) · Secrets Manager(남긴 넷)에서 읽는다.
    if (name === 'site' || name === 'docs' || name === 'domain-control' || name === 'domain-policy-audit') {
      expect(text).not.toContain('GetSecretValueCommand');
      expect(text).not.toContain('GetParameterCommand');
    } else {
      expect(text).toContain('GetSecretValueCommand');
      expect(text).toContain('GetParameterCommand');
    }
  }, 30_000);

  it('★ billing-webhook — 번들 입력에 pg·src/db 가 0 · SQS SendMessage 는 있고 SES·S3·KMS 는 없다', async () => {
    const result = await build({
      ...lambdaBuildOptions('billing-webhook'),
      write: false,
      metafile: true,
      outfile: '/virtual/billing-webhook/index.js',
      logLevel: 'silent',
    });
    expect(result.errors).toEqual([]);
    const inputs = Object.keys(result.metafile?.inputs ?? {});
    // 비공허: 입력이 실제로 모였고 핸들러·서명 모듈이 그 안에 있다.
    expect(inputs).toContain('src/runtime/handlers/billing-webhook.ts');
    expect(inputs).toContain('src/billing/paddle/signature.ts');
    expect(inputs.filter((input) => input.includes('node_modules/pg/') || input.includes('node_modules/pg-'))).toEqual([]);
    expect(inputs.filter((input) => input.startsWith('src/db/'))).toEqual([]);
    expect(inputs.filter((input) => /src\/runtime\/(composition|admin-composition)\.ts$/.test(input))).toEqual([]);
    expect(inputs.filter((input) => /node_modules\/@aws-sdk\/client-(sesv2|s3|kms)\//.test(input))).toEqual([]);
    const text = result.outputFiles?.[0]?.text ?? '';
    expect(text).toContain('SendMessageCommand');
    expect(text).not.toMatch(/SendEmailCommand|PutObjectCommand|GenerateDataKeyCommand/);
  }, 30_000);

  it('★ domain-control — 번들 입력에 pg·src/db·조립 루트·발송 전송단이 0 · SES 제어면 명령은 있고 발송 명령·비밀·S3·KMS 는 없다(ADR-0014 단계 2)', async () => {
    const result = await build({
      ...lambdaBuildOptions('domain-control'),
      write: false,
      metafile: true,
      outfile: '/virtual/domain-control/index.js',
      logLevel: 'silent',
    });
    expect(result.errors).toEqual([]);
    const inputs = Object.keys(result.metafile?.inputs ?? {});
    // 비공허: 핸들러·제어면·DNS 가 입력에 있다.
    expect(inputs).toContain('src/runtime/handlers/domain-control.ts');
    expect(inputs).toContain('src/mail/transport/ses-identity.ts');
    expect(inputs).toContain('src/domains/dns-lookup.ts');
    expect(inputs.filter((input) => input.includes('node_modules/pg/') || input.includes('node_modules/pg-'))).toEqual([]);
    expect(inputs.filter((input) => input.startsWith('src/db/'))).toEqual([]);
    expect(inputs.filter((input) => /src\/runtime\/(composition|admin-composition)\.ts$/.test(input))).toEqual([]);
    expect(inputs).not.toContain('src/mail/transport/ses-transport.ts');
    expect(inputs.filter((input) => /node_modules\/@aws-sdk\/client-(s3|kms|secrets-manager|ssm|lambda|sqs)\//.test(input))).toEqual([]);
    const text = result.outputFiles?.[0]?.text ?? '';
    expect(text).toContain('CreateEmailIdentityCommand');
    expect(text).toContain('CreateEmailIdentityPolicyCommand');
    expect(text).not.toContain('GetSecretValueCommand');
    // 발송 명령 **클래스**는 SDK 묶음(`client-sesv2` 의 집계 모듈)에 같이 실린다 — 번들 글자로는 막을 수 없다. 막는 것은 두 겹이다:
    //   우리 코드의 import(`test/arch/ses-import-boundary.arch.test.ts` — `ses-identity.ts` 에 `Send*` import 0)와 IAM(역할의 SendEmail 명시 Deny).
  }, 30_000);

  it('★ api — PDF 워커가 번들 옆 이름으로 묶이고, 디스크의 그 파일이 워커로 돌아 텍스트(한국어 CID 포함)를 뽑는다', async () => {
    expect(Object.keys(LAMBDA_WORKER_ENTRIES)).toEqual(['api']);
    const entries = LAMBDA_WORKER_ENTRIES['api'] ?? [];
    expect(entries).toEqual(['src/api/pdf-text-worker.ts']);
    const { options, fileName } = lambdaWorkerBuildOptions(entries[0] as string);
    expect(fileName).toBe(PDF_WORKER_FILES[0]);

    const result = await build({ ...options, write: false, metafile: true, outfile: `/virtual/api/${fileName}`, logLevel: 'silent' });
    expect(result.errors).toEqual([]);
    const text = result.outputFiles?.[0]?.text ?? '';
    const inputs = Object.keys(result.metafile?.inputs ?? {});
    // 해석기는 공식 pdfjs-dist legacy 빌드 하나뿐 — unpdf 가 싣던 옛 판(GHSA-hq66-cqwq-w95j)이 번들에 남지 않는다.
    expect(inputs.some((input) => input.includes('node_modules/pdfjs-dist/legacy/build/pdf.mjs'))).toBe(true);
    expect(inputs.some((input) => input.includes('node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'))).toBe(true);
    expect(inputs.filter((input) => input.includes('node_modules/unpdf/'))).toEqual([]);
    expect(inputs).toContain('src/api/pdf-korean-cmaps.json');
    expect(text).not.toMatch(/from\s+["']pdfjs-dist[^"']*["']/); // 외부 import 로 남지 않았다
    expect(text).not.toMatch(/import\(\s*["']pdfjs-dist/);
    expect(text).not.toMatch(/\bnew Function\(|\beval\(/); // 해석기에 코드 실행 경로 0(③)
    expect(text).toContain('KSCms-UHC-H');

    // api 핸들러 번들에는 해석기가 없다(워커에만).
    const api = await build({ ...lambdaBuildOptions('api'), write: false, metafile: true, outfile: '/virtual/api/index.js', logLevel: 'silent' });
    expect(Object.keys(api.metafile?.inputs ?? {}).filter((input) => input.includes('node_modules/pdfjs-dist/'))).toEqual([]);

    const dir = mkdtempSync(join(tmpdir(), 'atmark-pdf-worker-'));
    try {
      writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ type: 'module' })}\n`);
      writeFileSync(join(dir, fileName), text);
      const latin = await runWorker(join(dir, fileName), minimalPdf(['Bundled worker reads this']));
      expect(latin).toEqual([
        { type: 'open', pages: 1 },
        { type: 'page', text: 'Bundled worker reads this' },
        { type: 'end', stoppedAtCharLimit: false },
      ]);
      const korean = await runWorker(join(dir, fileName), koreanCidPdf(Uint8Array.from([0xbe, 0xc8, 0xb3, 0xe7]))); // 안녕(CP949)
      expect(korean).toContainEqual({ type: 'page', text: '안녕' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
