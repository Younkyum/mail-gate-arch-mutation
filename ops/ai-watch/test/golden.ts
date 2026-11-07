/**
 * `pnpm ai-watch:selftest` — 워커의 전처리 + 토크나이저 + 추론이 laya-train 골든 24 와 같은가(설계 §5.1 · 모델 산출물 사양).
 *
 * 워커와 **같은 코드 경로**(`engine.ts` → 잠금 sha256 대조 → `release_config` 대조 → 네이티브 로드 → `runSelfTest`)를 돈다. 통과 기준:
 * 24/24 input_ids 정확히 같음 · 로짓 차 ≤ 1e-3 · 경고 판정 뒤집힘 0. 덤으로 단건 지연 p50/p95 를 잰다(본문·로짓은 출력하지 않는다).
 *
 * **건너뛰기:** 모델 디렉터리(324MB — git 에 없다)나 `ops/ai-watch/node_modules`(네이티브 — `pnpm --dir ops/ai-watch install`)가 없으면
 * `SKIP` 을 찍고 0 으로 끝난다(CI). `--require` 를 주면 없을 때 실패한다(Mac 설치 · 모델 갱신 때).
 *   모델 위치: `AIWATCH_MODEL_DIR` > `<리포>/.omc/spikes/laya-release/model` > (git worktree 면) 본 체크아웃의 같은 경로.
 *   버전: `AIWATCH_MODEL_VERSION`(기본 = `models.lock` 의 마지막 항목).
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEngine } from '../worker/engine';
import { parseModelsLock } from '../worker/lock';
import { buildInputIds, renderEmail } from '../worker/preprocess';
import { parseFixtures } from '../worker/selftest';

const AI_WATCH_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(AI_WATCH_DIR, '..', '..');
const RELEASE_REL = join('.omc', 'spikes', 'laya-release', 'model');

function modelDirCandidates(): string[] {
  const fromEnv = process.env['AIWATCH_MODEL_DIR'];
  if (fromEnv !== undefined && fromEnv !== '') return [fromEnv];
  const candidates = [join(REPO_ROOT, RELEASE_REL)];
  // `.claude/worktrees/<이름>` 안이면 본 체크아웃(세 단계 위)의 .omc 를 본다 — .omc/spikes 는 worktree 로 복사되지 않는다.
  const marker = `${join('.claude', 'worktrees')}`;
  const at = REPO_ROOT.indexOf(marker);
  if (at > 0) candidates.push(join(REPO_ROOT.slice(0, at), RELEASE_REL));
  return candidates;
}

function skipOrFail(reason: string, required: boolean): never {
  if (required) {
    console.error(`✗ ai-watch selftest: ${reason}`);
    process.exit(1);
  }
  console.log(`SKIP ai-watch selftest: ${reason}`);
  process.exit(0);
}

async function main(): Promise<void> {
  const required = process.argv.includes('--require');
  if (!existsSync(join(AI_WATCH_DIR, 'node_modules', 'onnxruntime-node')) || !existsSync(join(AI_WATCH_DIR, 'node_modules', 'tokenizers'))) {
    skipOrFail('네이티브 의존성 없음 (pnpm --dir ops/ai-watch install --frozen-lockfile)', required);
  }
  const dir = modelDirCandidates().find((candidate) => existsSync(join(candidate, 'release_config.json')));
  if (dir === undefined) skipOrFail('모델 디렉터리 없음 (AIWATCH_MODEL_DIR)', required);

  const lock = parseModelsLock(readFileSync(join(AI_WATCH_DIR, 'models.lock'), 'utf8'));
  const version = process.env['AIWATCH_MODEL_VERSION'] ?? [...lock.keys()].at(-1);
  const locked = version === undefined ? undefined : lock.get(version);
  if (locked === undefined) {
    console.error(`✗ models.lock 에 버전이 없다: ${String(version)}`);
    process.exit(1);
  }

  const loaded = await loadEngine({ dir, locked, threads: 4 });
  if (!loaded.ok) {
    console.error(`✗ 모델 로드 거부: ${loaded.reason}`);
    process.exit(1);
  }
  const { engine } = loaded;
  const report = await engine.selfTest();
  console.log(
    JSON.stringify({
      model_version: engine.version,
      fixtures: report.fixtures,
      token_id_mismatch: report.idMismatch,
      logit_mismatch: report.logitMismatch,
      decision_flips: report.decisionFlips,
      max_logit_diff: Number(report.maxLogitDiff.toExponential(2)),
      pass: report.pass,
    }),
  );

  // 지연(배치 1 · 4스레드) — 워커 경로(tokenize + infer) 그대로. 데우기 3번 뒤 24 × 5.
  const fixtures = parseFixtures(JSON.parse(readFileSync(join(dir, 'fixtures.json'), 'utf8')));
  const texts = fixtures.map((f) => renderEmail(f.subject, f.text));
  for (let i = 0; i < 3; i += 1) await engine.classifier.logitsOf(buildInputIds(engine.spec, await engine.classifier.tokenize(texts[0]!)));
  const samples: number[] = [];
  for (let round = 0; round < 5; round += 1) {
    for (const text of texts) {
      const started = performance.now();
      await engine.bandOf(text);
      samples.push(performance.now() - started);
    }
  }
  samples.sort((a, b) => a - b);
  const pick = (q: number): number => Number(samples[Math.min(samples.length - 1, Math.floor(samples.length * q))]!.toFixed(1));
  console.log(JSON.stringify({ latency_n: samples.length, p50_ms: pick(0.5), p95_ms: pick(0.95), rss_mb: Math.round(process.memoryUsage.rss() / 1_048_576) }));

  if (!report.pass) {
    console.error('✗ 골든 불일치 — 이 모델·토크나이저로 워커를 띄우지 않는다');
    process.exit(1);
  }
  console.log('✓ ai-watch selftest 24/24');
}

await main();
