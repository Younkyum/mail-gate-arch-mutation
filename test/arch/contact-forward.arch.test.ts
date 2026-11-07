/**
 * US-009(ADR-0009) — **문의 전달의 위상.** 에이전트 메일의 불변식(관문·Layer B·C·E)을 건드리지 않고 시스템 메일 하나를 더했다는 주장을
 * 코드 모양으로 단언한다.
 *
 *   ① 매니페스트: `contact_forward` 는 `SYSTEM_MAIL_ENTRYPOINTS` 에 있고(워커 → 전달 모듈), 수신 소비자는 여전히 `NON_SENDING_ENTRYPOINTS`.
 *   ② 수신 소비자(외부인 MIME 을 파싱하는 곳)의 **런타임 import 폐포**에 전송단·시스템 메일 모듈·전달 주소 로더가 없다 —
 *      수신 Lambda 는 보낼 수도, 전달 주소를 알 수도 없다(IAM 도 SES 0 · 비밀 0 — `contact-forward-stack.test.ts`).
 *   ③ 전달 주소 비밀 변수(`ATMARK_CONTACT_FORWARD_TO_SECRET_ARN`)를 읽는 src 파일은 운영 조립 루트 하나다.
 *   ④ `contact_forwards` 에 수신자 칸이 없다 — 수신자가 행(앱 롤이 쓸 수 있는 곳)에서 나올 길이 없다.
 *   ⑤ 이 기능의 파일(코드·마이그레이션·인프라·ADR·테스트)에 우리 도메인·예약 예시 도메인 밖의 메일 주소가 **없다** — 운영자 전달 주소는
 *      비밀에만 있다(테스트는 `ops@example.test` 같은 가짜만).
 *
 * 되돌리기 검증: 수신 소비자가 전달 모듈을 import 하면 ② · 다른 파일이 전달 주소 변수를 읽으면 ③ · 행에 `to_address` 칸을 더하면 ④ ·
 * 코드에 실제 주소를 적으면 ⑤ 가 빨개진다.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { SyntaxKind, type SourceFile } from 'ts-morph';

import { NON_SENDING_ENTRYPOINTS, SYSTEM_MAIL_ENTRYPOINTS } from '../../src/policy/manifest';
import { getProject, listTsFilesUnder, repoFileExists, repoPath, toRepoRelative } from './support/project';

const INBOUND_CONSUMER = 'src/workers/inbound-consumer.ts';
const CONTACT_FORWARDER_MODULE = 'src/notify/contact-forwarder.ts';
const CONTACT_FORWARDER_WORKER = 'src/workers/contact-forwarder.ts';
const TRANSPORT_FILE = 'src/mail/transport/ses-transport.ts';
const DESTINATION_FILE = 'src/contact/destination.ts';
const MIGRATION = 'src/db/migrations/202609241500_contact_forwards.sql';

function source(path: string): SourceFile {
  const file = getProject()
    .getSourceFiles()
    .find((candidate) => toRepoRelative(candidate.getFilePath()) === path);
  if (file === undefined) throw new Error(`${path} 을 ts-morph 가 읽지 못했다 — 이 단언이 공허해진다.`);
  return file;
}

/** 값 import 만 따라간 src 폐포(타입 전용 import 는 번들에 실리지 않는다). */
function runtimeClosure(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [source(entry)];
  while (queue.length > 0) {
    const file = queue.pop() as SourceFile;
    const path = toRepoRelative(file.getFilePath());
    if (seen.has(path)) continue;
    seen.add(path);
    for (const declaration of file.getImportDeclarations()) {
      if (declaration.isTypeOnly()) continue;
      const named = declaration.getNamedImports();
      if (named.length > 0 && named.every((n) => n.isTypeOnly()) && !declaration.getDefaultImport() && !declaration.getNamespaceImport()) continue;
      const target = declaration.getModuleSpecifierSourceFile();
      if (target !== undefined && toRepoRelative(target.getFilePath()).startsWith('src/')) queue.push(target);
    }
    for (const declaration of file.getExportDeclarations()) {
      const target = declaration.getModuleSpecifierSourceFile();
      if (target !== undefined && toRepoRelative(target.getFilePath()).startsWith('src/')) queue.push(target);
    }
  }
  return seen;
}

describe('문의 전달 위상 (US-009, ADR-0009)', () => {
  it('① contact_forward 는 시스템 메일 범주 · 수신 소비자는 발송 없음 범주 그대로', () => {
    expect(SYSTEM_MAIL_ENTRYPOINTS.filter((entry) => entry.id === 'contact_forward')).toEqual([
      expect.objectContaining({ file: CONTACT_FORWARDER_WORKER, sender: CONTACT_FORWARDER_MODULE }),
    ]);
    expect(NON_SENDING_ENTRYPOINTS.map((entry) => entry.file)).toContain(INBOUND_CONSUMER);
    expect(SYSTEM_MAIL_ENTRYPOINTS.map((entry) => entry.file)).not.toContain(INBOUND_CONSUMER);
  });

  it('② 수신 소비자의 런타임 폐포에 전송단·시스템 메일 모듈·전달 주소 로더가 없다 (문의 입구는 들어 있다)', () => {
    const closure = runtimeClosure(INBOUND_CONSUMER);
    // 비공허: 문의 입구가 실제로 폐포에 있다.
    expect(closure.has('src/contact/intake.ts')).toBe(true);
    const forbidden = [
      TRANSPORT_FILE,
      DESTINATION_FILE,
      'src/policy/gate.ts',
      ...SYSTEM_MAIL_ENTRYPOINTS.map((entry) => entry.sender),
      ...listTsFilesUnder('src/notify'),
    ];
    expect(forbidden.filter((file) => closure.has(file))).toEqual([]);
  });

  it('③ 전달 주소 비밀 변수를 읽는 src 파일은 운영 조립 루트 하나다(선언 config.ts 제외)', () => {
    const readers: string[] = [];
    for (const file of getProject().getSourceFiles()) {
      const path = toRepoRelative(file.getFilePath());
      if (!path.startsWith('src/') || path === 'src/runtime/config.ts') continue;
      const touches =
        file.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression).some((node) => node.getName() === 'contactForwardToSecretArn') ||
        file.getText().includes('ATMARK_CONTACT_FORWARD_TO_SECRET_ARN');
      if (touches) readers.push(path);
    }
    expect(readers).toEqual(['src/runtime/composition.ts']);
  });

  it('④ contact_forwards 에 수신자·내용 칸이 없다 — 수신자가 행에서 나올 길이 없다', () => {
    const sql = readFileSync(repoPath(MIGRATION), 'utf8');
    const table = /CREATE TABLE contact_forwards \(([\s\S]*?)\n\);/.exec(sql)?.[1] ?? '';
    expect(table.length).toBeGreaterThan(0);
    const columns = table
      .split('\n')
      .map((line) => /^\s{2}([a-z_]+)\s/.exec(line)?.[1])
      .filter((name): name is string => name !== undefined && name !== 'constraint');
    expect(columns.sort()).toEqual(
      [
        'attempt_count',
        'claimed_at',
        'created_at',
        'forward_ses_message_id',
        'id',
        'last_error',
        'next_attempt_at',
        'received_at',
        'sender_hash',
        'sent_at',
        'ses_message_id',
        'settled_at',
        'status',
      ].sort(),
    );
  });

  it('⑤ 이 기능의 파일에 우리 도메인·예약 예시 도메인 밖의 메일 주소가 없다 — 운영자 주소는 비밀에만', () => {
    const files = [
      ...listTsFilesUnder('src/contact'),
      CONTACT_FORWARDER_MODULE,
      'src/notify/contact-forward-template.ts',
      CONTACT_FORWARDER_WORKER,
      'src/runtime/handlers/contact-forwarder.ts',
      MIGRATION,
      'docs/adr/0009-contact-forwarding.md',
      'infra/cdk/stacks/data-stack.ts',
      'infra/cdk/stacks/compute-stack.ts',
      'docs/ops/ses-principals-allowlist.json',
      'test/arch/contact-forward.arch.test.ts',
      'test/unit/contact/contact-forward.test.ts',
      'test/unit/infra/contact-forward-stack.test.ts',
      'test/integration/inbound/contact-forward.test.ts',
    ];
    expect(files.filter((file) => !repoFileExists(file))).toEqual([]);
    const allowed = (address: string): boolean => {
      const domain = address.slice(address.lastIndexOf('@') + 1).toLowerCase();
      return (
        domain === 'atmark.ai' ||
        domain.endsWith('.atmark.ai') ||
        /(^|\.)example\.(test|com|org|net)$/.test(domain) ||
        // RFC 2606 예약 TLD — 실제 메일함일 수 없다.
        domain.endsWith('.invalid') ||
        domain.endsWith('.test') ||
        domain.endsWith('.example')
      );
    };
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(repoPath(file), 'utf8');
      for (const address of text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/g) ?? []) {
        if (!allowed(address)) offenders.push(`${file}: ${address}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
