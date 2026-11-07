/**
 * scripts/ops-web/audit-log.ts — 운영자 웹 화면의 **쓰기 기록**(성공·실패 모두). 한 쓰기 = stderr 한 줄 + `~/.atmark/ops-web-audit.jsonl` 한 줄.
 *
 * 무엇을: 누가(행위자) · 언제 · 무엇(행위) · 대상 id(조직 uuid · 에이전트 hex — 모양이 아니면 `invalid`) · 결과(`ok` 또는 거부 코드) · 요약(바뀌었나 · 버전).
 * 싣지 않는 것: 토큰·비밀 · 조직 이름·이메일·사유 문구(사용자가 고른 문자열 — 터미널을 흐리거나 개인정보다) · 확인 입력.
 * 파일은 0600, 디렉터리는 0700 — 시작할 때 만들고(이미 있으면 권한을 좁힌다) 쓸 수 없으면 서버를 띄우지 않는다.
 * DB 의 감사 행(`billing_audit` 등)을 대신하지 않는다 — 그건 CLI 와 같은 함수가 그대로 쓴다. 이 기록은 "웹에서 누가 무엇을 눌렀나" 의 노트북 쪽 짝이다.
 */

import { appendFileSync, chmodSync, closeSync, fchmodSync, mkdirSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { AuditSink, WriteRecord } from '../../src/ops/console/audit';

export const DEFAULT_AUDIT_DIR = join(homedir(), '.atmark');
export const AUDIT_FILE_NAME = 'ops-web-audit.jsonl';

/** 기록 모양은 라우트 코어와 같이 쓴다(`src/ops/console/audit.ts`). */
export type { AuditSink, WriteRecord };

/** 한 줄 표현(stderr) — 모든 값은 이미 모양이 정해진 id·코드라 정화가 필요 없다. */
export function formatRecord(record: WriteRecord): string {
  return `[ops-web] ${record.at} ${record.actor} ${record.action} ${record.target} → ${record.result}${record.summary === undefined ? '' : ` (${record.summary})`}`;
}

/**
 * 디렉터리(0700)·파일(0600)을 준비하고 싱크를 돌려준다. 준비에 실패하면 던진다(서버를 띄우지 않는다).
 * 쓰기 중 실패는 stderr 에만 알린다 — 연산은 이미 DB 에서 끝났다.
 */
export function createAuditSink(err: (line: string) => void, dir: string = DEFAULT_AUDIT_DIR): { readonly sink: AuditSink; readonly path: string } {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = join(dir, AUDIT_FILE_NAME);
  const fd = openSync(path, 'a', 0o600);
  try {
    fchmodSync(fd, 0o600);
  } finally {
    closeSync(fd);
  }
  const sink: AuditSink = (record) => {
    err(formatRecord(record));
    try {
      appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    } catch (error) {
      err(`[ops-web] 기록 파일에 쓰지 못했다(${path}): ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  return { sink, path };
}
