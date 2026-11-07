/**
 * injection 스캐너 **봉인 홀드아웃** — 세트가 바뀌면 빨개지고, 룰 코드는 세트를 모른다.
 *
 * 계획 §6 P4 r3 정정: 코퍼스를 쓴 사람이 그 코퍼스에 맞춰 룰을 튜닝하면 "고위험 미탐률 0%"
 * 는 학습셋 점수다. 그래서 룰 작성 **전에** 양성 20 / 음성 30 을 만들어 봉인했다
 * (`docs/security/injection-holdout.md`). 이 층이 지키는 것은 두 가지다.
 *
 * 1. **봉인** — 파일 한 바이트 변경·추가·삭제가 전부 빨간불이다. 누가 룰에 맞춰 홀드아웃을
 *    "고치면" 여기서 걸린다. 해시 목록(`HOLDOUT.sha256`)까지 같이 고치는 우회를 막으려고
 *    목록 자체의 digest 를 이 파일에 못 박는다 — 그러면 우회에는 **이 파일의 diff** 가
 *    남고, 그 diff 는 리뷰에서 "홀드아웃을 다시 만들었다(소진)" 는 뜻으로만 읽혀야 한다.
 * 2. **읽기 격리** — `src/**` 는 홀드아웃 경로를 문자열로도 모른다. 룰 코드가 세트를 import
 *    하거나 경로를 조립할 수 있으면 "보지 않고 튜닝했다" 는 전제가 코드 수준에서 무너진다.
 *    평가 스크립트는 `test/**`·`scripts/**` 에서 읽는다.
 *
 * **이 파일은 코퍼스 내용을 읽지 않는다**(바이트 해시와 라벨 개수만 본다). 여기에 본문
 * 단언을 추가하지 마라 — 단언을 쓰려면 본문을 봐야 하고, 본 사람은 룰을 쓰면 안 된다.
 *
 * 홀드아웃을 새로 만들면(소진 후 재생성) `HOLDOUT.sha256` 과 아래 `ACTIVE_SEAL_DIGEST` 를 함께
 * 갱신하고, 문서의 소진 기록 표에 한 줄을 남긴다.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ACTIVE_SEAL_DIGEST as SHARED_ACTIVE_SEAL_DIGEST } from '../../scripts/injection-seal';
import { repoPath, toRepoRelative } from './support/project';

const INJECTION_DIR = repoPath('test', 'fixtures', 'injection');
const HOLDOUT_DIR = join(INJECTION_DIR, 'holdout');
const SEAL_FILE = join(INJECTION_DIR, 'HOLDOUT.sha256');

// 활성 세트의 digest 는 평가 러너와 공유한다(scripts/injection-seal.ts — 단일 출처, 그 파일의 머리말 참조).
// `null` 인 동안 이 층은 "활성 세트가 없다" 를 단언한다(아래 두 번째 describe).
// 지역 const 로 받는다 — import 바인딩은 콜백 안에서 좁혀지지 않는다.
const ACTIVE_SEAL_DIGEST: string | null = SHARED_ACTIVE_SEAL_DIGEST;

/** 소진된 v1 의 봉인 목록 digest — 학습 자료로 풀렸어도 바이트가 바뀌면 "소진 전 결과" 의 재현이 깨진다. */
const CONSUMED_V1_SEAL_DIGEST = 'e3b2d15133b4f1b4ef0eee5e268b71e71739ec460b55415ef2c9f48beb6b2f2c';
const CONSUMED_V1_SEAL_FILE = join(INJECTION_DIR, 'consumed', 'v1', 'HOLDOUT.sha256');

const EXPECTED_POSITIVES = 20;
const EXPECTED_NEGATIVES = 30;

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 홀드아웃 하위 모든 파일(하위 디렉터리 포함, 숨김 파일 포함) — `holdout/...` 표기. */
function listHoldoutFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const rel = `${prefix}/${entry}`;
      if (statSync(full).isDirectory()) walk(full, rel);
      else out.push(rel);
    }
  };
  walk(HOLDOUT_DIR, 'holdout');
  return out.sort();
}

/** `sha256sum`/`shasum -a 256` 호환 형식: `<hex>  <path>`. */
function readSeal(): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of readFileSync(SEAL_FILE, 'utf8').split('\n')) {
    if (line.length === 0) continue;
    const match = /^([0-9a-f]{64}) {2}(\S.*)$/.exec(line);
    if (!match) throw new Error(`HOLDOUT.sha256 형식 위반: ${JSON.stringify(line)}`);
    const [, hash = '', path = ''] = match;
    if (entries.has(path)) throw new Error(`HOLDOUT.sha256 중복 항목: ${path}`);
    entries.set(path, hash);
  }
  return entries;
}

interface HoldoutCase {
  readonly file: string;
  readonly label: 'injection' | 'benign';
  readonly risk: 'high' | 'medium' | 'low' | null;
  readonly workload: string;
}

// 등록 자체를 조건으로 한다 — 빈 describe 는 vitest 가 "No test found in suite" 로 실패시킨다.
if (ACTIVE_SEAL_DIGEST === null) describe('injection 홀드아웃 — 활성 세트 없음', () => {

  it('활성 세트가 없으면 홀드아웃 디렉터리도 봉인 파일도 없다 (봉인 안 된 세트의 유입 차단)', () => {
    expect(existsSync(HOLDOUT_DIR)).toBe(false);
    expect(existsSync(SEAL_FILE)).toBe(false);
  });

  it('injection 픽스처 아래에는 dev·consumed·koset 만 있다 (다른 이름으로 들어온 세트 차단)', () => {
    // `holdout` 이름만 막으면 `holdout2/`·`eval/` 로 봉인 안 된 세트가 들어와 평가에 쓰인다(검증자 V3, B3).
    // `koset` 은 2026-10-08 더한 **한국어 독립 세트**다 — 봉인 홀드아웃이 아니라 공개 세트이고, dev 에서 튜닝한 뒤
    // 절반(b)을 보고용으로 쓴다(`docs/security/llmail-eval.md`). AC-7 dev 코퍼스와 섞지 않으려고 따로 둔다.
    const entries = readdirSync(INJECTION_DIR).filter((e) => !e.startsWith('.')).sort();
    expect(entries).toEqual(['consumed', 'dev', 'koset']);
    expect(readdirSync(join(INJECTION_DIR, 'consumed')).filter((e) => !e.startsWith('.')).sort()).toEqual(['v1']);
    // koset 은 a(튜닝)·b(보고) 두 반(半)으로만 나뉜다 — 봉인 파일이 없다(공개 세트).
    expect(readdirSync(join(INJECTION_DIR, 'koset')).filter((e) => !e.startsWith('.')).sort()).toEqual(['a', 'b']);
  });

  it('소진된 v1 의 봉인 목록 바이트가 그대로다 (소진 전 평가 결과의 재현 가능성)', () => {
    expect(sha256(readFileSync(CONSUMED_V1_SEAL_FILE))).toBe(CONSUMED_V1_SEAL_DIGEST);
  });
});

if (ACTIVE_SEAL_DIGEST !== null) describe('injection 홀드아웃 봉인', () => {
  const sealDigest: string = ACTIVE_SEAL_DIGEST;

  it('봉인 목록 자체가 못 박힌 digest 와 같다 (목록을 같이 고치는 우회 차단)', () => {
    expect(sha256(readFileSync(SEAL_FILE))).toBe(sealDigest);
  });

  it('디렉터리의 파일 집합이 봉인 목록과 정확히 같다 (추가·삭제 = 빨간불)', () => {
    const onDisk = listHoldoutFiles();
    const sealed = [...readSeal().keys()].sort();
    // 공허한 통과 방지: 50 케이스 + labels.json.
    expect(sealed).toHaveLength(EXPECTED_POSITIVES + EXPECTED_NEGATIVES + 1);
    expect(onDisk).toEqual(sealed);
  });

  it('모든 파일의 바이트가 봉인 해시와 같다 (한 글자 변경 = 빨간불)', () => {
    const mismatched: string[] = [];
    for (const [path, hash] of readSeal()) {
      const full = join(INJECTION_DIR, path);
      if (!existsSync(full) || sha256(readFileSync(full)) !== hash) mismatched.push(path);
    }
    expect(mismatched).toEqual([]);
  });

  it('라벨이 모든 케이스를 덮고 구성이 양성 20 / 음성 30 이다', () => {
    const labels = JSON.parse(readFileSync(join(HOLDOUT_DIR, 'labels.json'), 'utf8')) as {
      cases: HoldoutCase[];
    };
    const caseFiles = listHoldoutFiles()
      .filter((p) => p.endsWith('.txt'))
      .map((p) => p.slice('holdout/'.length));
    expect(labels.cases.map((c) => c.file).sort()).toEqual(caseFiles);

    const positives = labels.cases.filter((c) => c.label === 'injection');
    const negatives = labels.cases.filter((c) => c.label === 'benign');
    expect(positives).toHaveLength(EXPECTED_POSITIVES);
    expect(negatives).toHaveLength(EXPECTED_NEGATIVES);
    // 양성은 전부 위험도가 있고, 음성은 없다 — AC-7 "고위험 미탐률" 의 분모가 비면 공허하다.
    expect(positives.every((c) => c.risk !== null)).toBe(true);
    expect(negatives.every((c) => c.risk === null)).toBe(true);
    expect(positives.filter((c) => c.risk === 'high').length).toBeGreaterThanOrEqual(12);
    // 음성의 과반은 워크로드 1(인증·가입·재설정) — 제품이 실제로 받는 분포.
    expect(negatives.filter((c) => c.workload === 'w1-auth').length * 2).toBeGreaterThan(EXPECTED_NEGATIVES);
  });
});

describe('injection 홀드아웃 읽기 격리', () => {
  // `holdout` 이라는 단어 자체를 금지한다 — `join('fixtures','injection','holdout')` 처럼
  // 조각으로 조립하는 경로도 잡기 위해서다. src 에 이 단어가 필요해지면 그건 격리 위반이다.
  const FORBIDDEN = [/holdout/i, /fixtures[\\/]+injection/i];

  function listAllFilesUnder(relativeDir: string): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else out.push(full);
      }
    };
    walk(repoPath(relativeDir));
    return out.sort();
  }

  it('src/** 의 어떤 파일도 홀드아웃 경로를 참조하지 않는다', () => {
    const files = listAllFilesUnder('src');
    expect(files.length).toBeGreaterThan(0);
    const offenders = files
      .filter((file) => {
        const text = readFileSync(file, 'utf8');
        return FORBIDDEN.some((pattern) => pattern.test(text));
      })
      .map(toRepoRelative);
    expect(offenders).toEqual([]);
  });
});
