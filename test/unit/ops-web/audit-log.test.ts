/**
 * 운영자 웹 화면 쓰기 기록 — `~/.atmark/ops-web-audit.jsonl`(테스트는 임시 디렉터리).
 *
 * 되돌리면 빨개져야 하는 것: 디렉터리 0700(이미 있어도 좁힌다) · 파일 0600(이미 있어도) · 한 쓰기 = JSONL 한 줄 + stderr 한 줄 · 이어 쓴다.
 */

import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { AUDIT_FILE_NAME, createAuditSink, formatRecord, type WriteRecord } from '../../../scripts/ops-web/audit-log';

const record: WriteRecord = { at: '2026-09-27T00:00:00.000Z', actor: 'admin:web:jin', action: 'plan.set', target: '11111111-2222-4333-8444-555555555555', result: 'ok', summary: 'changed=true v=2' };

describe('쓰기 기록', () => {
  it('디렉터리 0700 · 파일 0600 · JSONL 한 줄 + stderr 한 줄', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'ops-web-audit-')), 'atmark');
    const lines: string[] = [];
    const { sink, path } = createAuditSink((line) => lines.push(line), dir);
    expect(path).toBe(join(dir, AUDIT_FILE_NAME));
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    sink(record);
    sink({ ...record, result: 'confirmation_required', summary: undefined as never });
    const rows = readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as WriteRecord);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(record);
    expect(lines).toEqual([formatRecord(record), expect.stringContaining('→ confirmation_required')]);
  });

  it('이미 있던 넓은 권한은 좁힌다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ops-web-audit-'));
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    writeFileSync(join(dir, AUDIT_FILE_NAME), '', { mode: 0o644 });
    createAuditSink(() => undefined, dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, AUDIT_FILE_NAME)).mode & 0o777).toBe(0o600);
  });
});
