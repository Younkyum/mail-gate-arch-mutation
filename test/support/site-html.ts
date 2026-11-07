/**
 * 홈(`src/site/`) 테스트가 같이 쓰는 HTML·CSP 읽기 도우미. 코드의 함수를 다시 쓰지 않고 응답 문자열에서 직접 읽는다.
 */

import { createHash } from 'node:crypto';

/** CSP 해시 값(`'sha256-…'` 의 본문) — base64. */
export const sha256Base64 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('base64');

/** CSP 의 한 지시어 값 목록(이름 제외). 지시어가 없으면 `undefined`. */
export function cspDirective(csp: string, name: string): string[] | undefined {
  const part = csp
    .split(';')
    .map((p) => p.trim())
    .find((p) => p === name || p.startsWith(`${name} `));
  return part?.split(/\s+/).slice(1);
}

/** `<meta name|property="key" content="…">` 의 `content` 값들. */
export const metaContents = (html: string, attr: 'name' | 'property', key: string): string[] =>
  [...html.matchAll(new RegExp(`<meta ${attr}="${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" content="([^"]*)">`, 'g'))].map((m) => m[1] ?? '');
