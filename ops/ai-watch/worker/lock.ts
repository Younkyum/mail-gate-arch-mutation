/**
 * ops/ai-watch/worker/lock.ts — `models.lock` 읽기 · 모델 디렉터리 무결성 확인.
 *
 * 워커는 기동 때 `models/current`(심볼릭 링크)가 가리키는 버전 디렉터리의 **모든 파일**을 sha256 으로 대조한다. 하나라도 다르면 모델을 열지
 * 않는다(자기 시험 실패 — 하트비트 `self_test:"fail"`). 버전 이름은 링크 대상 디렉터리 이름이고, 그 이름이 곧 선로의 `model_version` 이다.
 */

import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';

import { isAiWatchModelVersion } from '../../../src/inbound/ai-watch/contract';
import type { BandThresholds } from './score';

export interface LockedModel {
  readonly version: string;
  readonly files: Readonly<Record<string, string>>;
  readonly temperature: number;
  readonly bands: BandThresholds;
}

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_REL_PATH = /^[A-Za-z0-9_][A-Za-z0-9._-]*(\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/;

/** `models.lock` 본문 → 버전 표. 모양이 하나라도 어긋나면 던진다. */
export function parseModelsLock(body: string): ReadonlyMap<string, LockedModel> {
  const parsed = JSON.parse(body) as { lock_version?: unknown; models?: unknown };
  if (parsed.lock_version !== 1) throw new TypeError('bad_lock_version');
  if (parsed.models === null || typeof parsed.models !== 'object') throw new TypeError('bad_lock_models');
  const out = new Map<string, LockedModel>();
  for (const [version, raw] of Object.entries(parsed.models as Record<string, unknown>)) {
    if (!isAiWatchModelVersion(version)) throw new TypeError('bad_lock_version_name');
    const entry = raw as { files?: unknown; temperature?: unknown; bands?: { high?: unknown; mid?: unknown } };
    if (entry.files === null || typeof entry.files !== 'object') throw new TypeError('bad_lock_files');
    const files: Record<string, string> = {};
    for (const [path, hash] of Object.entries(entry.files as Record<string, unknown>)) {
      if (!SAFE_REL_PATH.test(path) || path.split('/').includes('..')) throw new TypeError('bad_lock_path');
      if (typeof hash !== 'string' || !SHA256.test(hash)) throw new TypeError('bad_lock_hash');
      files[path] = hash;
    }
    if (Object.keys(files).length === 0) throw new TypeError('bad_lock_files');
    const temperature = entry.temperature;
    const high = entry.bands?.high;
    const mid = entry.bands?.mid;
    if (typeof temperature !== 'number' || !(temperature > 0)) throw new TypeError('bad_lock_temperature');
    if (typeof high !== 'number' || typeof mid !== 'number' || !(mid > 0 && mid < high && high < 1)) throw new TypeError('bad_lock_bands');
    out.set(version, { version, files, temperature, bands: { high, mid } });
  }
  return out;
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/** 디렉터리 안 파일들이 잠금과 같은가. 다른 파일 이름(닫힌 어휘가 아닌 경로)은 결과에 싣지 않는다 — 개수만. */
export async function verifyModelDir(dir: string, locked: LockedModel): Promise<{ readonly ok: boolean; readonly mismatched: number }> {
  let mismatched = 0;
  for (const [path, expected] of Object.entries(locked.files)) {
    try {
      if ((await sha256File(join(dir, path))) !== expected) mismatched += 1;
    } catch {
      mismatched += 1;
    }
  }
  return { ok: mismatched === 0, mismatched };
}

/** `models/current` → (버전 이름, 실제 디렉터리). */
export function resolveCurrentModel(modelsRoot: string): { readonly version: string; readonly dir: string } {
  const dir = realpathSync(join(modelsRoot, 'current'));
  return { version: basename(dir), dir };
}

/** 잠금과 `release_config.json` 이 같은 숫자를 말하는가(온도 · 경고 임계 = mid). */
export function lockMatchesReleaseConfig(locked: LockedModel, releaseConfig: unknown): boolean {
  const config = releaseConfig as { temperature?: unknown; recommended_threshold_attack_score?: unknown };
  return config.temperature === locked.temperature && config.recommended_threshold_attack_score === locked.bands.mid;
}

export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}
