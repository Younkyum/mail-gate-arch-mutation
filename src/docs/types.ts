/**
 * src/docs/types.ts — 빌드된 문서 페이지 한 장의 모양. `site.ts`(만든다)와 `layout.ts`(그린다)가 같이 쓴다 — 둘 사이 순환 import 를 끊으려고 따로 둔다.
 */

import type { DocsLang } from './constants';
import type { Block, FrontMatter } from './markdown';
import type { DocsGroup, DocsTab } from './nav';
import type { Outline } from './render';

export interface DocPage {
  readonly lang: DocsLang;
  readonly id: string;
  readonly file: string;
  readonly path: string;
  readonly mdPath: string;
  readonly front: FrontMatter;
  readonly blocks: readonly Block[];
  readonly group: DocsGroup | null;
  readonly tab: DocsTab | null;
  readonly outline: Outline;
  readonly updated: string;
}
