/**
 * ops/ai-watch/worker/model.ts — 네이티브 런타임(onnxruntime-node · npm `tokenizers` 0.23.2) 위의 분류기.
 *
 * 네이티브 모듈은 **동적 import + 이 파일의 좁은 인터페이스**로 연다. 이유: 루트 `pnpm typecheck`·CI 에는 두 모듈이 없다(`ops/ai-watch/package.json`
 * 의 별도 설치 — 모델 런타임이 λ 번들·루트 의존성으로 새지 않게, 설계 §6.4 ④). 지정자를 변수로 두면 tsc·esbuild 가 해석하지 않는다.
 *
 * `@huggingface/transformers` 의 JS 토크나이저는 쓰지 않는다 — 공백·개행에서 ids 가 달라 골든 6/24 불일치(모델 산출물 사양).
 */

import { join } from 'node:path';

import { buildInputIds, type SequenceSpec } from './preprocess';

interface OrtTensor {
  readonly data: ArrayLike<number>;
}
interface OrtSession {
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensor>>;
}
interface OrtModule {
  readonly InferenceSession: { create(path: string, options: Record<string, unknown>): Promise<OrtSession> };
  readonly Tensor: new (type: 'int64', data: BigInt64Array, dims: readonly number[]) => unknown;
  readonly env?: { logLevel?: string };
}
interface TokenizerEncoding {
  getIds(): ArrayLike<number>;
}
interface TokenizerInstance {
  encode(text: string, pair: null, options: { addSpecialTokens: boolean }): Promise<TokenizerEncoding>;
}
interface TokenizersModule {
  readonly Tokenizer: { fromFile(path: string): TokenizerInstance };
}

/** 네이티브 모듈 위치를 바꿀 일이 있으면 여기만. */
const ORT_SPECIFIER = 'onnxruntime-node';
const TOKENIZERS_SPECIFIER = 'tokenizers';

export interface Classifier {
  /** 텍스트 → 토큰 id(본문 부분, 특수 토큰 없음). */
  tokenize(text: string): Promise<number[]>;
  /** 완성된 input_ids → 로짓 3개. */
  logitsOf(inputIds: readonly number[]): Promise<number[]>;
  /** 텍스트 → 로짓(tokenize + buildInputIds + logitsOf). */
  classify(text: string): Promise<number[]>;
}

export interface ModelFiles {
  readonly dir: string;
  readonly modelFile: string;
  readonly spec: SequenceSpec;
  readonly threads: number;
}

export async function loadClassifier(files: ModelFiles): Promise<Classifier> {
  const ort = (await import(ORT_SPECIFIER)) as OrtModule;
  const tokenizers = (await import(TOKENIZERS_SPECIFIER)) as TokenizersModule;
  // ORT 자체 경고(예: 샌드박스가 막은 텔레메트리 기기 id 저장 — "Failed to persist telemetry device ID")가 stderr 로 새지 않게.
  if (ort.env !== undefined) ort.env.logLevel = 'error';
  const tokenizer = tokenizers.Tokenizer.fromFile(join(files.dir, 'tokenizer', 'tokenizer.json'));
  const session = await ort.InferenceSession.create(join(files.dir, files.modelFile), {
    executionProviders: ['cpu'],
    intraOpNumThreads: files.threads,
    interOpNumThreads: 1,
    // 메모리 패턴·arena 는 기본값 — 배치 1 · 길이 ≤ 384 라 작다.
  });

  const tokenize = async (text: string): Promise<number[]> => Array.from((await tokenizer.encode(text, null, { addSpecialTokens: false })).getIds());
  const logitsOf = async (inputIds: readonly number[]): Promise<number[]> => {
    const ids = new BigInt64Array(inputIds.map((id) => BigInt(id)));
    const mask = new BigInt64Array(inputIds.length).fill(1n);
    const out = await session.run({
      input_ids: new ort.Tensor('int64', ids, [1, inputIds.length]),
      attention_mask: new ort.Tensor('int64', mask, [1, inputIds.length]),
    });
    const logits = out['logits'];
    if (logits === undefined) throw new TypeError('missing_logits');
    return Array.from(logits.data);
  };
  return {
    tokenize,
    logitsOf,
    classify: async (text) => logitsOf(buildInputIds(files.spec, await tokenize(text))),
  };
}
