/**
 * 투명성 로그 Lambda 조립·핸들러 · 오프라인 검증 CLI(`pnpm log:verify`) — AWS·DB·외부 호출 0.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { runCli, statePathFor } from '../../../scripts/log-verify';
import { RUNTIME_ENV } from '../../../src/runtime/config';
import { createTransparencyAnchorHandler } from '../../../src/runtime/handlers/transparency-anchor';
import { createTransparencyLogHandler } from '../../../src/runtime/handlers/transparency-log';
import {
  composeTransparencyAnchor,
  composeTransparencyLog,
  requireTask,
  TLOG_COMPOSITION_ENV,
  TRANSPARENCY_POOL_MAX,
  type TransparencyPlatform,
} from '../../../src/runtime/transparency-composition';
import { TLOG_ORIGIN } from '../../../src/tlog/constants';
import { FAKE_REKOR_HOST, FAKE_REKOR_VKEY } from '../../support/tlog-fixtures';
import { syntheticHistory } from '../../support/tlog-synthetic';

const CA_FILE = fileURLToPath(import.meta.url);
const TLOG_SECRET = 'arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:atmark/db/tlog';
const ANCHOR_SECRET = 'arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:atmark/db/tlog-anchor';
const credentials = (username: string): string => JSON.stringify({ host: 'db.internal', port: 5432, dbname: 'atmark', username, password: 'p'.repeat(43) });

function platform(overrides: Record<string, string | undefined> = {}): TransparencyPlatform {
  const env: Record<string, string | undefined> = {
    [RUNTIME_ENV.environment]: 'production',
    [RUNTIME_ENV.region]: 'ap-northeast-2',
    [RUNTIME_ENV.extraCaCerts]: CA_FILE,
    [RUNTIME_ENV.dbTlogSecretArn]: TLOG_SECRET,
    [RUNTIME_ENV.dbTlogAnchorSecretArn]: ANCHOR_SECRET,
    [RUNTIME_ENV.tlogSigningKeyArn]: 'arn:aws:kms:ap-northeast-2:123456789012:key/11111111-1111-1111-1111-111111111111',
    [RUNTIME_ENV.tlogAnchorKeyArn]: 'arn:aws:kms:ap-northeast-2:123456789012:key/22222222-2222-2222-2222-222222222222',
    [RUNTIME_ENV.tlogBucket]: 'atmark-tlog-123456789012',
    [RUNTIME_ENV.tlogOtsCalendars]: 'https://a.pool.opentimestamps.org,https://b.pool.opentimestamps.org',
    [RUNTIME_ENV.tlogRekorUrl]: 'https://log2026-1.rekor.sigstore.dev',
    ...overrides,
  };
  return {
    env: Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)),
    invokedFunctionArn: 'arn:aws:lambda:ap-northeast-2:123456789012:function:atmark-transparency-log',
    clients: {
      secrets: {
        readSecretString: (id: string) => Promise.resolve(id === TLOG_SECRET ? credentials('atmark_tlog') : credentials('atmark_tlog_anchor')),
      },
      kms: { send: () => Promise.reject(new Error('KMS 가 불리면 안 된다')) } as never,
      s3: { send: () => Promise.reject(new Error('S3 가 불리면 안 된다')) } as never,
    },
  };
}

describe('투명성 로그 Lambda — 과제별 조립', () => {
  it('함수마다 자기 과제만 받는다 — 다른 과제·오타·빈 입력은 던진다(배선 오타가 조용히 다른 일을 하지 않게)', async () => {
    expect(requireTask({ task: 'log' }, 'log')).toBe('log');
    expect(requireTask({ task: 'anchor' }, 'anchor')).toBe('anchor');
    for (const bad of [{}, null, { task: 'LOG' }, { task: 'sequence' }, { task: 'anchor' }]) expect(() => requireTask(bad, 'log')).toThrow(/과제는 log/);
    expect(() => requireTask({ task: 'log' }, 'anchor')).toThrow(/과제는 anchor/);
    // 핸들러 — 과제가 다르면 조립(비밀·KMS·DB)에 닿기 전에 던진다.
    const unreachable = (): TransparencyPlatform => {
      throw new Error('조립까지 가면 안 된다');
    };
    const context = { awsRequestId: 'r', invokedFunctionArn: 'arn:aws:lambda:ap-northeast-2:123456789012:function:x' } as never;
    await expect(createTransparencyLogHandler(unreachable)({ task: 'anchor' }, context)).rejects.toThrow(/과제는 log/);
    await expect(createTransparencyAnchorHandler(unreachable)({ task: 'log' }, context)).rejects.toThrow(/과제는 anchor/);
  });

  it('M5 — 함수마다 자기 환경만 있으면 조립된다: 로그는 앵커 키·앵커 비밀 없이, 앵커는 체크포인트 키·tlog 비밀 없이', async () => {
    const logOnly = await composeTransparencyLog(
      platform({
        [RUNTIME_ENV.dbTlogAnchorSecretArn]: undefined,
        [RUNTIME_ENV.tlogAnchorKeyArn]: undefined,
        [RUNTIME_ENV.tlogOtsCalendars]: undefined,
        [RUNTIME_ENV.tlogRekorUrl]: undefined,
      }),
    );
    expect(String((logOnly.pool as unknown as { options: Record<string, unknown> }).options['connectionString'])).toContain('//atmark_tlog:');
    await logOnly.pool.end();
    const anchorOnly = await composeTransparencyAnchor(platform({ [RUNTIME_ENV.dbTlogSecretArn]: undefined, [RUNTIME_ENV.tlogSigningKeyArn]: undefined }));
    expect(String((anchorOnly.pool as unknown as { options: Record<string, unknown> }).options['connectionString'])).toContain('//atmark_tlog_anchor:');
    await anchorOnly.pool.end();
  });

  it('log 과제는 atmark_tlog 비밀 하나만 · 풀 max 1 · TLS 검증', async () => {
    const composed = await composeTransparencyLog(platform());
    try {
      const options = (composed.pool as unknown as { options: Record<string, unknown> }).options;
      expect(options['max']).toBe(TRANSPARENCY_POOL_MAX);
      expect(options['ssl']).toEqual({ rejectUnauthorized: true });
      expect(String(options['connectionString'])).toContain('//atmark_tlog:');
      expect(composed.deps.signer.keyName).toBe(TLOG_ORIGIN);
    } finally {
      await composed.pool.end();
    }
  });

  it('anchor 과제는 atmark_tlog_anchor 비밀 · 캘린더 2곳 이상 · 허용 호스트만 · Rekor 는 비워 둘 수 있다', async () => {
    const composed = await composeTransparencyAnchor(platform());
    try {
      expect(String((composed.pool as unknown as { options: Record<string, unknown> }).options['connectionString'])).toContain('//atmark_tlog_anchor:');
      expect(composed.deps.calendars).toEqual(['https://a.pool.opentimestamps.org', 'https://b.pool.opentimestamps.org']);
      expect(composed.deps.rekorUrl).toBe('https://log2026-1.rekor.sigstore.dev');
    } finally {
      await composed.pool.end();
    }
    const noRekor = await composeTransparencyAnchor(platform({ [RUNTIME_ENV.tlogRekorUrl]: undefined }));
    expect(noRekor.deps.rekorUrl).toBeNull();
    await noRekor.pool.end();
    await expect(composeTransparencyAnchor(platform({ [RUNTIME_ENV.tlogOtsCalendars]: 'https://a.pool.opentimestamps.org' }))).rejects.toThrow(/2곳 이상/);
    await expect(composeTransparencyAnchor(platform({ [RUNTIME_ENV.tlogOtsCalendars]: 'https://evil.example,https://a.pool.opentimestamps.org' }))).rejects.toThrow(
      'anchor_endpoint_not_allowed',
    );
    await expect(composeTransparencyAnchor(platform({ [RUNTIME_ENV.tlogRekorUrl]: 'https://rekor.example' }))).rejects.toThrow('anchor_endpoint_not_allowed');
    await expect(composeTransparencyLog(platform({ [RUNTIME_ENV.tlogSigningKeyArn]: 'alias/atmark-tlog' }))).rejects.toThrow(/KMS 키 ARN/);
    await expect(composeTransparencyLog(platform({ [RUNTIME_ENV.environment]: 'development' }))).rejects.toThrow();
  });

  it('M2 — Rekor 샤드 키(vkey)를 고정해야 Rekor 를 쓴다 · 이름 = 샤드 호스트 · 키 없이는 rekorKey null(예약하지 않는다)', async () => {
    const pinned = await composeTransparencyAnchor(
      platform({ [RUNTIME_ENV.tlogRekorUrl]: `https://${FAKE_REKOR_HOST}`, [TLOG_COMPOSITION_ENV.rekorVkey]: FAKE_REKOR_VKEY }),
    );
    expect(pinned.deps.rekorKey?.name).toBe(FAKE_REKOR_HOST);
    await pinned.pool.end();
    const unpinned = await composeTransparencyAnchor(platform());
    expect(unpinned.deps.rekorKey).toBeNull();
    await unpinned.pool.end();
    await expect(
      composeTransparencyAnchor(platform({ [RUNTIME_ENV.tlogRekorUrl]: 'https://log2025-1.rekor.sigstore.dev', [TLOG_COMPOSITION_ENV.rekorVkey]: FAKE_REKOR_VKEY })),
    ).rejects.toThrow(/호스트와 다르다/);
    await expect(composeTransparencyAnchor(platform({ [TLOG_COMPOSITION_ENV.rekorVkey]: 'not-a-vkey' }))).rejects.toThrow(/vkey/);
    await expect(
      composeTransparencyAnchor(platform({ [RUNTIME_ENV.tlogRekorUrl]: undefined, [TLOG_COMPOSITION_ENV.rekorVkey]: FAKE_REKOR_VKEY })),
    ).rejects.toThrow(/함께/);
  });

  it('origin 은 설정(기본 운영 값) · 모양 검사 · 게시 수위는 log/checkpoint 하나를 읽는다(없으면 null)', async () => {
    const staging = await composeTransparencyLog(platform({ [TLOG_COMPOSITION_ENV.origin]: 'staging.id.atmark.ai/log/v1' }));
    expect(staging.deps.signer.keyName).toBe('staging.id.atmark.ai/log/v1');
    await staging.pool.end();
    await expect(composeTransparencyLog(platform({ [TLOG_COMPOSITION_ENV.origin]: 'id.atmark.ai/log v1' }))).rejects.toThrow(/origin 모양/);
    await expect(composeTransparencyLog(platform({ [TLOG_COMPOSITION_ENV.origin]: 'https://id.atmark.ai/log' }))).rejects.toThrow(/origin 모양/);

    const keys: string[] = [];
    const objects = new Map<string, string>([['log/checkpoint', 'note-bytes']]);
    const s3 = {
      send: (command: { input: { Key: string; Bucket: string; ExpectedBucketOwner: string } }) => {
        keys.push(`${command.input.Bucket}/${command.input.Key}@${command.input.ExpectedBucketOwner}`);
        const body = objects.get(command.input.Key);
        if (body === undefined) return Promise.reject(Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' }));
        return Promise.resolve({ ContentLength: body.length, Body: { transformToByteArray: () => Promise.resolve(Buffer.from(body)) } });
      },
    };
    const base = platform();
    const composed = await composeTransparencyLog({ ...base, clients: { ...base.clients, s3: s3 as never } });
    expect(await composed.deps.published.readCheckpoint()).toBe('note-bytes');
    objects.clear();
    expect(await composed.deps.published.readCheckpoint()).toBeNull();
    expect(keys).toEqual(['atmark-tlog-123456789012/log/checkpoint@123456789012', 'atmark-tlog-123456789012/log/checkpoint@123456789012']);
    await composed.pool.end();
  });
});

describe('pnpm log:verify — 오프라인 CLI', () => {
  const directory = mkdtempSync(join(tmpdir(), 'atmark-log-verify-'));
  const history = syntheticHistory({ tag: 'cli', epochs: 6 });

  it('통과하면 상태를 저장하고, 같은 에폭의 다른 루트(분기)는 저장한 상태와 어긋나 실패한다 · 사용법 오류는 2', () => {
    const bundlePath = join(directory, 'bundle.json');
    const stateDir = join(directory, 'state');
    mkdirSync(stateDir, { recursive: true });
    const good = history.bundle(0, 2);
    writeFileSync(bundlePath, JSON.stringify(good));
    const lines: string[] = [];
    expect(runCli([bundlePath, '--key', history.signer.vkey, '--state-dir', stateDir], (line) => lines.push(line))).toBe(0);
    expect(lines[0]).toBe('✓ 번들 검증 통과');
    const statePath = statePathFor(stateDir, TLOG_ORIGIN);
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as { checkpoint: { epoch: number } };
    expect(state.checkpoint.epoch).toBe(2);

    // 같은 키로 서명한 다른 역사(분기) — 저장한 에폭(2)이 범위 안이면 루트가 다르다.
    const forked = syntheticHistory({ tag: 'cli-fork', epochs: 6, signer: history.signer }).bundle(1, 3) as { org: { log: string } };
    forked.org.log = history.log;
    writeFileSync(bundlePath, JSON.stringify(forked));
    const out: string[] = [];
    expect(runCli([bundlePath, '--state-dir', stateDir, '--json'], (line) => out.push(line))).toBe(1);
    const report = JSON.parse(out.join('\n')) as { errors: { code: string }[] };
    expect(report.errors.map((issue) => issue.code)).toEqual(expect.arrayContaining(['state_checkpoint_inconsistent']));
    // 실패한 번들은 저장한 상태를 건드리지 않는다.
    expect((JSON.parse(readFileSync(statePath, 'utf8')) as { checkpoint: { epoch: number } }).checkpoint.epoch).toBe(2);

    expect(runCli([join(directory, 'missing.json')], () => undefined)).toBe(2);
    writeFileSync(bundlePath, '{"format":"other"}');
    expect(runCli([bundlePath, '--state-dir', stateDir], () => undefined)).toBe(1);
  });

  it('L1 — 모양이 틀린 번들은 스택 대신 실패(1)와 한 줄 이유', () => {
    const stateDir = join(directory, 'state-malformed');
    const bundlePath = join(directory, 'malformed.json');
    for (const malformed of [
      { format: 'atmark-tlog-bundle/v2', vkey: history.signer.vkey },
      { ...history.bundle(0, 1), anchor_keys: ['AAAA'], anchors: [{ epoch: 0, target: 'rekor', endpoint: 'x', state: 'confirmed', digest: '00', receipt: 'x', upgraded: null }] },
      { ...history.bundle(0, 1), heads: [{ epoch: 'x' }] },
      { ...history.bundle(0, 1), checkpoints: null },
      null,
      [],
    ]) {
      writeFileSync(bundlePath, JSON.stringify(malformed));
      const out: string[] = [];
      expect(runCli([bundlePath, '--key', history.signer.vkey, '--state-dir', stateDir], (line) => out.push(line))).toBe(1);
      expect(out[0]).toMatch(/^✗ 번들 검증 실패/);
    }
    // 상태 파일이 깨졌으면 사용법/파일 오류(2) — 검증을 건너뛰고 덮어쓰지 않는다.
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(statePathFor(stateDir, TLOG_ORIGIN), '{not json');
    writeFileSync(bundlePath, JSON.stringify(history.bundle(0, 1)));
    expect(runCli([bundlePath, '--state-dir', stateDir], () => undefined)).toBe(2);
    expect(readFileSync(statePathFor(stateDir, TLOG_ORIGIN), 'utf8')).toBe('{not json');
  });

  it('M1 — 새 조직 로그 id 를 단 분기 번들은 저장 상태를 건너뛰지 못한다(상태는 origin 으로 고른다 · 로그 id 고정 · --accept-new-log 도 전역 연결은 본다)', () => {
    const stateDir = join(directory, 'state-m1');
    const bundlePath = join(directory, 'm1.json');
    writeFileSync(bundlePath, JSON.stringify(history.bundle(0, 2)));
    expect(runCli([bundlePath, '--key', history.signer.vkey, '--state-dir', stateDir], () => undefined)).toBe(0);
    const statePath = statePathFor(stateDir, TLOG_ORIGIN);
    const saved = readFileSync(statePath, 'utf8');
    expect((JSON.parse(saved) as { org_log: string }).org_log).toBe(history.log);

    // Atmark 가 같은 키로 역사를 다시 쓰고 **새 로그 id** 로 내민다(예전 CLI 는 `<새 id>.json` 을 찾아 상태 없이 통과시켰다).
    const forked = syntheticHistory({ tag: 'cli-fork-m1', epochs: 6, signer: history.signer });
    expect(forked.log).not.toBe(history.log);
    writeFileSync(bundlePath, JSON.stringify(forked.bundle(1, 4)));
    for (const extra of [[], ['--accept-new-log']]) {
      const out: string[] = [];
      expect(runCli([bundlePath, '--key', history.signer.vkey, '--state-dir', stateDir, '--json', ...extra], (line) => out.push(line))).toBe(1);
      const codes = (JSON.parse(out.join('\n')) as { errors: { code: string }[] }).errors.map((issue) => issue.code);
      expect(codes).toContain(extra.length === 0 ? 'state_org_log_changed' : 'state_checkpoint_inconsistent');
      expect(readFileSync(statePath, 'utf8')).toBe(saved);
    }
    // 사람이 읽는 출력도 이유를 한 줄로 댄다.
    const human: string[] = [];
    expect(runCli([bundlePath, '--key', history.signer.vkey, '--state-dir', stateDir], (line) => human.push(line))).toBe(1);
    expect(human.join('\n')).toMatch(/state_org_log_changed: .*--accept-new-log/);
  });
});
