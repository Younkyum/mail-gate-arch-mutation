/**
 * `scripts/admin/secrets-to-ssm.sh` — Secrets Manager → SSM 값 이전(2026-10-12 · 배포 런북 §49). **오프라인으로 돌린다**(AWS 호출 0): `aws` 를
 * 가짜 실행 파일로 바꿔 끼우고, 가짜는 비밀·파라미터를 임시 디렉터리의 파일로 흉내 낸다.
 *
 *   - 이름 목록 = `SSM_SECRET_NAMES`(런타임·CDK 와 같은 20 개) · 남기는 넷은 없다.
 *   - `--dry-run` 은 AWS 를 부르지 않고 이름만.
 *   - 복사: 값이 **바이트 그대로**(CLI 의 끝 줄바꿈만 뗀다) SecureString · standard · `--overwrite` · KMS 키 지정 없음(`alias/aws/ssm`).
 *   - 값은 stdout·stderr 어디에도 찍히지 않는다 · `--value` 는 `file:///dev/stdin` 뿐(명령줄에 값 없음).
 *   - 다시 돌리면 SKIP(이미 같은 값) · 4096 바이트를 넘는 값은 FAIL · 계정이 다르면 멈춘다.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SSM_SECRET_NAMES } from '../../../src/runtime/ssm-secret-names';
import { repoPath } from '../../arch/support/project';

const SCRIPT = repoPath('scripts/admin/secrets-to-ssm.sh');

/**
 * 가짜 `aws` — `configure get …` 또는 `--profile P --region R <service> <op> …`. 저장소는 `$FAKE_AWS_DIR/{sm,ssm}/<이름의 / 를 __ 로>`
 * (SSM 은 `.type` · `.key` 곁 파일). 호출 기록(값 없음)은 `calls.log`. KMS 키는 `$FAKE_AWS_DIR/kms-key` 가 있을 때만 있다.
 */
const FAKE_AWS = `#!/usr/bin/env bash
set -u
dir="$FAKE_AWS_DIR"
echo "$*" >> "$dir/calls.log"
if [[ "$1" == "configure" ]]; then
  if [[ -n "\${FAKE_CLI_HISTORY:-}" ]]; then echo "$FAKE_CLI_HISTORY"; exit 0; fi
  exit 1
fi
shift 4
service="$1"; op="$2"; shift 2
key() { printf '%s' "$1" | sed 's#/#__#g'; }
arg() { local want="$1"; shift; while [[ $# -gt 0 ]]; do if [[ "$1" == "$want" ]]; then echo "$2"; return; fi; shift; done; }
case "$service $op" in
  "sts get-caller-identity") echo "\${FAKE_ACCOUNT:-123456789012}" ;;
  "kms describe-key")
    [[ -f "$dir/kms-key" && "$(arg --key-id "$@")" == "alias/atmark-ssm-secrets" ]] || { echo "NotFoundException" >&2; exit 254; }
    printf 'k-123\\tarn:aws:kms:ap-northeast-2:123456789012:key/k-123\\n' ;;
  "secretsmanager describe-secret")
    [[ -f "$dir/sm/$(key "$(arg --secret-id "$@")")" ]] || { echo "ResourceNotFoundException" >&2; exit 254; }
    arg --secret-id "$@" ;;
  "secretsmanager get-secret-value")
    f="$dir/sm/$(key "$(arg --secret-id "$@")")"
    [[ -f "$f" ]] || { echo "ResourceNotFoundException" >&2; exit 254; }
    cat "$f"; echo ;;
  "secretsmanager put-secret-value")
    [[ "$(arg --secret-string "$@")" == "file:///dev/stdin" ]] || { echo "value must come from stdin" >&2; exit 9; }
    f="$dir/sm/$(key "$(arg --secret-id "$@")")"
    [[ -f "$f" ]] || { echo "ResourceNotFoundException" >&2; exit 254; }
    cat /dev/stdin > "$f"
    echo '{"VersionId":"v"}' ;;
  "ssm describe-parameters")
    filter="$(arg --parameter-filters "$@")"
    f="$dir/ssm/$(key "\${filter#*Values=}")"
    if [[ -f "$f" ]]; then printf '%s\\t%s\\n' "$(cat "$f.type")" "$(cat "$f.key")"; else echo None; fi ;;
  "ssm get-parameter")
    f="$dir/ssm/$(key "$(arg --name "$@")")"
    [[ -f "$f" ]] || { echo "ParameterNotFound" >&2; exit 254; }
    cat "$f"; echo ;;
  "ssm put-parameter")
    [[ "$(arg --value "$@")" == "file:///dev/stdin" ]] || { echo "value must come from stdin" >&2; exit 9; }
    f="$dir/ssm/$(key "$(arg --name "$@")")"
    cat /dev/stdin > "$f"
    printf '%s' "$(arg --type "$@")" > "$f.type"
    printf '%s' "$(arg --key-id "$@")" > "$f.key"
    echo '{"Version": 1, "Tier": "Standard"}' ;;
  *) echo "unexpected: $service $op" >&2; exit 3 ;;
esac
`;

interface Fake {
  readonly dir: string;
  readonly bin: string;
}

function fakeAws(secrets: Record<string, string>, options: { readonly key?: boolean } = {}): Fake {
  const dir = mkdtempSync(join(tmpdir(), 'secrets-to-ssm-'));
  if (options.key !== false) writeFileSync(join(dir, 'kms-key'), '');
  mkdirSync(join(dir, 'sm'));
  mkdirSync(join(dir, 'ssm'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'aws'), FAKE_AWS);
  chmodSync(join(bin, 'aws'), 0o755);
  writeFileSync(join(dir, 'calls.log'), '');
  for (const [name, value] of Object.entries(secrets)) writeFileSync(join(dir, 'sm', name.replaceAll('/', '__')), value);
  return { dir, bin };
}

function run(fake: Fake, args: readonly string[] = [], env: Record<string, string> = {}) {
  return spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { PATH: `${fake.bin}:${process.env['PATH'] ?? ''}`, FAKE_AWS_DIR: fake.dir, HOME: fake.dir, ...env },
  });
}

function smValue(fake: Fake, name: string): string {
  return readFileSync(join(fake.dir, 'sm', name.replaceAll('/', '__')), 'utf8');
}

function ssmValue(fake: Fake, name: string): string | null {
  const file = join(fake.dir, 'ssm', `/${name}`.replaceAll('/', '__'));
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

/** 비밀마다 다른 값 — 줄바꿈·따옴표·공백이 든 값도 섞는다(바이트 그대로 옮기는지). */
function allSecrets(): Record<string, string> {
  return Object.fromEntries(
    SSM_SECRET_NAMES.map((name, index) => [
      name,
      index === 0
        ? JSON.stringify({ engine: 'postgres', username: 'atmark_owner', password: `pw-"quoted" ${String(index)}` })
        : index === 12
          ? `k1:${'A'.repeat(43)},k0:${'B'.repeat(43)}\n`
          : `secret-value-${String(index)}-${name}`,
    ]),
  );
}

describe('scripts/admin/secrets-to-ssm.sh', () => {
  it('이름 목록 = SSM_SECRET_NAMES(20) · 남기는 넷은 없다', () => {
    const text = readFileSync(SCRIPT, 'utf8');
    const block = /SECRET_NAMES=\(\n([\s\S]*?)\n\)/.exec(text)?.[1] ?? '';
    const names = block.split('\n').map((line) => line.trim()).filter((line) => line !== '');
    expect(names).toEqual([...SSM_SECRET_NAMES]);
    expect(names).toHaveLength(20);
    for (const kept of ['atmark/db/master', 'atmark/webhook-secret-keys', 'atmark/dlp-keys']) expect(names).not.toContain(kept);
    expect(names.some((name) => name.startsWith('atmark/agent-keypairs'))).toBe(false);
    expect(text).toMatch(/^set \+x$/m);
    expect(text).toContain('KEY_ALIAS="alias/atmark-ssm-secrets"'); // 고객 관리형 키 — AWS 관리형 alias/aws/ssm 아님
    expect(text).not.toMatch(/alias\/aws\/ssm"/);
    expect(text).not.toMatch(/delete-/); // 아무것도 지우지 않는다
  });

  it('--dry-run — AWS 를 부르지 않고 이름만', () => {
    const fake = fakeAws(allSecrets());
    const result = run(fake, ['--dry-run']);
    expect(result.status).toBe(0);
    expect(readFileSync(join(fake.dir, 'calls.log'), 'utf8')).toBe('');
    for (const name of SSM_SECRET_NAMES) expect(result.stdout).toContain(`${name} -> /${name}`);
  });

  it('복사 — 바이트 그대로 · SecureString · --overwrite · 값은 출력·명령줄에 없다 · 다시 돌리면 SKIP', () => {
    const secrets = allSecrets();
    const fake = fakeAws(secrets);
    const first = run(fake);
    expect(first.stderr).toBe('');
    expect(first.status).toBe(0);
    for (const name of SSM_SECRET_NAMES) {
      expect(ssmValue(fake, name)).toBe(secrets[name]);
      expect(readFileSync(join(fake.dir, 'ssm', `/${name}.type`.replaceAll('/', '__')), 'utf8')).toBe('SecureString');
      expect(readFileSync(join(fake.dir, 'ssm', `/${name}.key`.replaceAll('/', '__')), 'utf8')).toBe('alias/atmark-ssm-secrets');
      expect(first.stdout).toContain(`OK   ${name} -> /${name}`);
    }
    expect(first.stdout).toContain('OK 20 · SKIP 0 · FAIL 0');
    const calls = readFileSync(join(fake.dir, 'calls.log'), 'utf8');
    for (const value of Object.values(secrets)) {
      expect(first.stdout + first.stderr).not.toContain(value.trim());
      expect(calls).not.toContain(value.trim());
    }
    const puts = calls.split('\n').filter((line) => line.includes('ssm put-parameter'));
    expect(puts).toHaveLength(20);
    for (const line of puts) {
      expect(line).toMatch(/^--profile atmark --region ap-northeast-2 ssm put-parameter /);
      expect(line).toContain('--type SecureString');
      expect(line).toContain('--tier Standard');
      expect(line).toContain('--overwrite');
      expect(line).toContain('--value file:///dev/stdin');
      expect(line).toContain('--key-id alias/atmark-ssm-secrets');
    }

    const second = run(fake);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('OK 0 · SKIP 20 · FAIL 0');
  });

  it('값이 다르면 덮어쓴다 · 4096 바이트를 넘으면 그 항목만 FAIL · 없는 비밀은 FAIL', () => {
    const secrets = allSecrets();
    secrets['atmark/ops-keys'] = 'x'.repeat(4097);
    delete secrets['atmark/contact-forward-to'];
    const fake = fakeAws(secrets);
    writeFileSync(join(fake.dir, 'ssm', '__atmark__db__app'), 'stale');
    writeFileSync(join(fake.dir, 'ssm', '__atmark__db__app.type'), 'SecureString');
    writeFileSync(join(fake.dir, 'ssm', '__atmark__db__app.key'), 'alias/atmark-ssm-secrets');
    // 같은 값이지만 AWS 관리형 키로 들어가 있으면 SKIP 하지 않고 고객 관리형 키로 다시 쓴다.
    writeFileSync(join(fake.dir, 'ssm', '__atmark__db__owner'), secrets['atmark/db/owner'] ?? '');
    writeFileSync(join(fake.dir, 'ssm', '__atmark__db__owner.type'), 'SecureString');
    writeFileSync(join(fake.dir, 'ssm', '__atmark__db__owner.key'), 'alias/aws/ssm');
    const result = run(fake);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('FAIL atmark/ops-keys -> /atmark/ops-keys (4097 바이트 > 4096');
    expect(result.stdout).toContain('FAIL atmark/contact-forward-to -> /atmark/contact-forward-to (Secrets Manager 에서 읽지 못함)');
    expect(ssmValue(fake, 'atmark/ops-keys')).toBeNull();
    expect(ssmValue(fake, 'atmark/db/app')).toBe(secrets['atmark/db/app']);
    expect(result.stdout).toContain('OK   atmark/db/owner -> /atmark/db/owner');
    expect(readFileSync(join(fake.dir, 'ssm', '__atmark__db__owner.key'), 'utf8')).toBe('alias/atmark-ssm-secrets');
    expect(result.stdout).toContain('OK 18 · SKIP 0 · FAIL 2');
  });

  it('고객 관리형 키(alias/atmark-ssm-secrets)가 없으면 아무것도 쓰지 않고 멈춘다 — AtmarkSecretsKey 를 먼저', () => {
    const fake = fakeAws(allSecrets(), { key: false });
    const result = run(fake);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('AtmarkSecretsKey');
    expect(readFileSync(join(fake.dir, 'calls.log'), 'utf8')).not.toMatch(/put-parameter|get-secret-value/);
  });

  it('AWS CLI 기록(cli_history)이 켜져 있으면 AWS 를 부르기 전에 거부한다', () => {
    for (const value of ['enabled', 'Enabled']) {
      const fake = fakeAws(allSecrets());
      const result = run(fake, [], { FAKE_CLI_HISTORY: value });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('cli_history');
      expect(readFileSync(join(fake.dir, 'calls.log'), 'utf8')).not.toMatch(/sts|secretsmanager|ssm /);
    }
    const disabled = run(fakeAws(allSecrets()), [], { FAKE_CLI_HISTORY: 'disabled' });
    expect(disabled.status).toBe(0);
  });

  it('--reverse — SSM 값을 **이미 있는** Secrets Manager 비밀로 되돌린다(바이트 그대로 · 값 무출력 · 없는 비밀은 만들지 않는다) · 다시 돌리면 SKIP', () => {
    const secrets = allSecrets();
    const fake = fakeAws(secrets);
    expect(run(fake).status).toBe(0);
    // SSM 쪽이 바뀌었다(예: 전환 뒤 bootstrap-roles 가 SSM 에만 쓴 값).
    writeFileSync(join(fake.dir, 'ssm', '__atmark__db__ops'), 'rotated-in-ssm\n');
    const reverse = run(fake, ['--reverse']);
    expect(reverse.status).toBe(0);
    expect(reverse.stdout).toContain('OK   /atmark/db/ops -> atmark/db/ops');
    expect(reverse.stdout).toContain('OK 1 · SKIP 19 · FAIL 0');
    expect(smValue(fake, 'atmark/db/ops')).toBe('rotated-in-ssm\n');
    expect(reverse.stdout + reverse.stderr).not.toContain('rotated-in-ssm');
    const calls = readFileSync(join(fake.dir, 'calls.log'), 'utf8').split('\n').filter((line) => line.includes('put-secret-value'));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('--secret-string file:///dev/stdin');
    expect(run(fake, ['--reverse']).stdout).toContain('OK 0 · SKIP 20 · FAIL 0');
    // 옛 비밀이 없으면 FAIL — 새로 만들지 않는다.
    const missing = fakeAws({});
    for (const name of SSM_SECRET_NAMES) {
      writeFileSync(join(missing.dir, 'ssm', `/${name}`.replaceAll('/', '__')), 'v');
    }
    const noTarget = run(missing, ['--reverse']);
    expect(noTarget.status).toBe(1);
    expect(noTarget.stdout).toContain('FAIL 20');
    expect(readFileSync(join(missing.dir, 'calls.log'), 'utf8')).not.toContain('create-secret');
  });

  it('계정이 다르면 아무것도 쓰지 않고 멈춘다', () => {
    const fake = fakeAws(allSecrets());
    const result = run(fake, [], { FAKE_ACCOUNT: '111111111111' });
    expect(result.status).toBe(1);
    expect(readFileSync(join(fake.dir, 'calls.log'), 'utf8')).not.toContain('put-parameter');
  });
});
