/**
 * SDK 게시 스위치(런북 `docs/runbooks/sdk-publish.md`) — 문서 플래그 `DOCS_FEATURES.sdkPublished` 와 발견 문서 `SDK_PUBLISHED` 는 **같은 커밋에서 같이** 뒤집는다.
 *   ① 둘이 같다.
 *   ② 꺼짐: "준비 중" 절이 보이고 설치 줄(`npm install atmark-sdk` · `pip install atmark-sdk`)은 없다.
 *   ③ 켜짐: 설치 줄이 보이고 "준비 중" 절은 사라진다 — 두 상태 모두 엄격 빌드가 통과한다.
 *   ④ 어디에도 옛 이름 `pip install atmark`(배포 이름은 `atmark-sdk`)이 없다.
 */

import { describe, expect, it } from 'vitest';

import { readContentSources } from '../../../scripts/gen-docs';
import { SDK_PUBLISHED } from '../../../src/api/discovery';
import { DOCS_FEATURES, DOCS_LANGS } from '../../../src/docs/constants';
import { buildDocsSite } from '../../../src/docs/site';

const sources = readContentSources();
const build = (sdkPublished: boolean) => buildDocsSite(sources, { features: { ...DOCS_FEATURES, sdkPublished } });
const md = (site: ReturnType<typeof build>, lang: string, id: string): string => site.markdown.get(`${lang === 'en' ? '/en' : ''}/${id}.md`) ?? '';

const INSTALL = ['npm install atmark-sdk', 'pip install atmark-sdk', 'pip install "atmark-sdk[realtime]"'];
const PENDING: Record<string, string[]> = { ko: ['준비 중', '미리 보기'], en: ['Coming soon', 'coming soon', 'preview'] };

describe('SDK 게시 스위치', () => {
  it('① 문서 플래그 sdkPublished 와 discovery SDK_PUBLISHED 가 같다', () => {
    expect(DOCS_FEATURES.sdkPublished).toBe(SDK_PUBLISHED);
  });

  it('② 꺼짐 — 준비 중 안내만, 설치 줄 없음', () => {
    const site = build(false);
    expect(site.problems).toEqual([]);
    for (const lang of DOCS_LANGS) {
      const page = md(site, lang, 'connect/sdks');
      for (const line of INSTALL) expect(page, `${lang} ${line}`).not.toContain(line);
      expect(PENDING[lang]?.some((word) => page.includes(word)), lang).toBe(true);
      expect(md(site, lang, 'api/overview')).not.toContain('npm install atmark-sdk');
    }
  });

  it('③ 켜짐 — 설치 줄이 보이고 준비 중 안내는 사라진다', () => {
    const site = build(true);
    expect(site.problems).toEqual([]);
    for (const lang of DOCS_LANGS) {
      const page = md(site, lang, 'connect/sdks');
      for (const line of INSTALL) expect(page, `${lang} ${line}`).toContain(line);
      for (const id of ['connect/sdks', 'api/overview', 'api/realtime']) {
        for (const word of PENDING[lang] ?? []) expect(md(site, lang, id), `${lang} ${id} ${word}`).not.toContain(word);
      }
      expect(md(site, lang, 'api/overview')).toContain('pip install atmark-sdk');
    }
  });

  it('④ 원문 어디에도 pip install atmark(배포 이름 아님)이 없다', () => {
    for (const lang of DOCS_LANGS) {
      for (const [id, text] of Object.entries(sources[lang])) expect(text, `${lang}/${id}`).not.toMatch(/pip install ["']?atmark(?!-sdk)/);
    }
  });
});
