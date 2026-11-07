/**
 * src/docs/content-data.ts — 생성 값 파일(`generated/content.json`, `pnpm gen:docs`)을 원문으로 푼다. 값 파일은 원문의 base64 다
 * (`scripts/gen-docs.ts` `contentJson` 머리말 — 콘텐츠의 예시 문자열이 소스 트리의 문자열 리터럴이 되지 않게).
 */

import type { DocsLang } from './constants';
import type { DocsSources } from './site';

export function decodeDocsContent(encoded: Readonly<Record<DocsLang, Readonly<Record<string, string>>>>): DocsSources {
  const decode = (lang: DocsLang): Record<string, string> =>
    Object.fromEntries(Object.entries(encoded[lang]).map(([id, b64]) => [id, Buffer.from(b64, 'base64').toString('utf8')]));
  return { ko: decode('ko'), en: decode('en') };
}
