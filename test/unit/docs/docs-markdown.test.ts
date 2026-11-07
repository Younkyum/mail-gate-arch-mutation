/**
 * 문서 마크다운 부분집합(`src/docs/markdown.ts` · `render.ts`) — 컴포넌트마다 한 번씩, 거부해야 할 것(원시 HTML·모르는 지시어·모르는 머리말 키)과
 * 이스케이프(XSS 안전)를 단언한다. 렌더는 실제 빌드(`buildDocsSite`)를 통해 본다 — 링크 검증·앵커·자리표시까지 같은 길이다.
 */

import { describe, expect, it } from 'vitest';

import { DocsSyntaxError, parseSource } from '../../../src/docs/markdown';
import { outline, slugify } from '../../../src/docs/render';
import { buildDocsSite, type DocsSources } from '../../../src/docs/site';

const HOME = (lang: 'ko' | 'en'): string => `---\ntitle: ${lang === 'ko' ? '문서' : 'Docs'}\ndescription: home\n---\n\nHi.\n`;

function page(body: string, extra = ''): string {
  return `---\ntitle: Test page\ndescription: A test page.\ngroup: email\norder: 1\nupdated: 2026-09-27\n${extra}---\n\n${body}\n`;
}

/** 한 페이지를 두 언어에 같은 원문으로 넣어 빌드하고, 한국어 본문 HTML(`.prose`)을 돌려준다. */
function render(body: string, others: Record<string, string> = {}, extra = ''): string {
  const both: Record<string, string> = { index: HOME('ko'), 'email/test': page(body, extra), ...others };
  const sources: DocsSources = { ko: both, en: { ...both, index: HOME('en') } };
  const site = buildDocsSite(sources);
  const html = site.pages.get('/email/test')?.html ?? '';
  const m = /<div class="prose">([\s\S]*?)<\/div><(?:section class="related"|nav class="pn"|p class="fb")/.exec(html);
  return m?.[1] ?? '';
}

function parseError(body: string): string {
  try {
    parseSource(page(body), 'x.md', false);
  } catch (error) {
    expect(error).toBeInstanceOf(DocsSyntaxError);
    return (error as Error).message;
  }
  throw new Error('오류가 나야 한다');
}

describe('인라인', () => {
  it('굵게·기울임·코드·이스케이프·링크', () => {
    const html = render('**굵게** *기울임* `a<b>` \\*별\\* [링크](https://atmark.ai/pricing) [메일](mailto:support@atmark.ai)');
    expect(html).toBe(
      '<p><strong>굵게</strong> <em>기울임</em> <code>a&lt;b&gt;</code> *별* <a href="https://atmark.ai/pricing">링크</a> <a href="mailto:support@atmark.ai">메일</a></p>',
    );
  });

  it('글자는 전부 이스케이프한다 — & " > 와 속성 탈출 시도', () => {
    const html = render('A & B "q" > c. [x](https://atmark.ai/?a=1&b=2)');
    expect(html).toContain('A &amp; B &quot;q&quot; &gt; c.');
    expect(html).toContain('<a href="https://atmark.ai/?a=1&amp;b=2">x</a>');
    // 따옴표로 속성을 벗어나려는 주소는 빌드가 거부한다.
    expect(() => render('[x](https://atmark.ai/?a="b")')).toThrow(/이상한 외부 주소/);
  });

  it('원시 HTML·자동 링크·HTML 주석은 거부한다(코드 안은 괜찮다)', () => {
    expect(parseError('hello <script>alert(1)</script>')).toMatch(/원시 HTML/);
    expect(parseError('<img src=x onerror=alert(1)>')).toMatch(/원시 HTML/);
    expect(parseError('see <https://atmark.ai>')).toMatch(/원시 HTML/);
    expect(parseError('<!-- note -->')).toMatch(/원시 HTML/);
    expect(parseError('<b>bold</b>')).toMatch(/원시 HTML/);
    expect(render('`<script>` and a < b')).toBe('<p><code>&lt;script&gt;</code> and a &lt; b</p>');
    expect(render('```html\n<script>alert(1)</script>\n```')).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('javascript:·data:·상대 경로·/en 링크는 빌드 오류', () => {
    expect(() => render('[x](javascript:alert(1))')).toThrow(/내부 링크/);
    expect(() => render('[x](data:text/html,hi)')).toThrow(/내부 링크/);
    expect(() => render('[x](http://atmark.ai)')).toThrow(/내부 링크/);
    expect(() => render('[x](email/test)')).toThrow(/내부 링크/);
    expect(() => render('[x](/en/email/test)')).toThrow(/\/en/);
  });

  it('내부 링크는 있는 페이지·앵커만 — 언어 접두어는 빌드가 붙인다', () => {
    const other = { 'email/other': page('## 모드 {#modes}\n\n본문', '').replace('order: 1', 'order: 2') };
    const html = render('[a](/email/other#modes) [b](/) [c](#here)\n\n## 여기 {#here}', other);
    expect(html).toContain('<a href="/email/other#modes">a</a>');
    expect(html).toContain('<a href="/">b</a>');
    expect(html).toContain('<a href="#here">c</a>');
    expect(() => render('[a](/email/nope)')).toThrow(/없는/);
    expect(() => render('[a](/email/other#nope)', other)).toThrow(/앵커/);
    expect(() => render('[a](#nope)')).toThrow(/앵커/);
    // 영어 페이지는 /en 이 붙는다.
    const both = { index: HOME('ko'), 'email/test': page('[a](/email/other#modes)'), ...other };
    const site = buildDocsSite({ ko: both, en: { ...both, index: HOME('en') } });
    expect(site.pages.get('/en/email/test')?.html).toContain('<a href="/en/email/other#modes">a</a>');
  });

  it('인라인 이미지·{{}} 인라인·닫히지 않은 꾸밈은 오류', () => {
    expect(parseError('a ![x](shot:logs) b')).toMatch(/인라인 이미지/);
    expect(parseError('limits: {{plan-limits}}')).toMatch(/자리표시/);
    expect(parseError('**open')).toMatch(/굵게/);
    expect(parseError('`open')).toMatch(/인라인 코드/);
  });
});

describe('블록', () => {
  it('헤딩 — h2·h3, 자동·명시 앵커, 목차', () => {
    const html = render('## 발신 모드\n\n### Sub {#sub}\n\n## 발신 모드');
    const h = (tag: string, id: string, text: string): string => `<${tag} id="${id}">${text}<a class="ha" href="#${id}" aria-label="이 절로 가는 링크"><span aria-hidden="true">#</span></a></${tag}>`;
    expect(html).toBe(h('h2', '발신-모드', '발신 모드') + h('h3', 'sub', 'Sub') + h('h2', '발신-모드-2', '발신 모드'));
    expect(slugify('Send & receive: 2 modes')).toBe('send-receive-2-modes');
    const parsed = parseSource(page('## A\n\n### B'), 'x.md', false);
    expect(outline(parsed.blocks, 'x.md', () => false).toc.map((a) => `${String(a.level)}:${a.id}`)).toEqual(['2:a', '3:b']);
  });

  it('본문의 # h1 · #### · 겹치는 명시 앵커는 오류', () => {
    expect(parseError('# Title')).toMatch(/h1/);
    expect(parseError('#### deep')).toMatch(/####/);
    expect(() => render('## A {#x}\n\n## B {#x}')).toThrow(/겹친다/);
  });

  it('목록 — 순서 있는·없는, 한 단계 중첩, 이어지는 줄', () => {
    expect(render('- a\n- b\n  - c\n  이어짐\n- d')).toBe('<ul><li>a</li><li>b<ul><li>c 이어짐</li></ul></li><li>d</li></ul>');
    expect(render('1. one\n2. two')).toBe('<ol><li>one</li><li>two</li></ol>');
    expect(parseError('- a\n1. b')).toMatch(/섞지/);
    expect(parseError('- a\n      - too deep')).toMatch(/한 단계/);
  });

  it('표 — 머리·구분·몸, 가로 스크롤 영역(role=region · tabindex)', () => {
    const html = render('| 모드 | 뜻 |\n|---|---|\n| `all` | 전부 \\| 막음 |');
    expect(html).toBe(
      '<div class="tbl" role="region" tabindex="0" aria-label="표: 모드 · 뜻"><table><thead><tr><th scope="col">모드</th><th scope="col">뜻</th></tr></thead>' +
        '<tbody><tr><td><code>all</code></td><td>전부 | 막음</td></tr></tbody></table></div>',
    );
    expect(parseError('| a | b |\n| c | d |')).toMatch(/구분 줄/);
    expect(parseError('| a | b |\n|---|---|\n| c |')).toMatch(/칸 수/);
  });

  it('코드 펜스 — 언어·제목, 복사 버튼(스크립트 없으면 숨김), 원문 그대로', () => {
    const html = render('```bash title="Claude Code"\nclaude mcp add --transport http atmark https://api.atmark.ai/mcp\n  indented & <x>\n```');
    expect(html).toBe(
      '<div class="code"><div class="code-h"><span class="code-l">Claude Code</span><button type="button" class="copy" data-copy hidden>복사</button></div>' +
        '<pre tabindex="0"><code>claude mcp add --transport http atmark https://api.atmark.ai/mcp\n  indented &amp; &lt;x&gt;</code></pre></div>',
    );
    expect(parseError('```bash\nno close')).toMatch(/코드 펜스/);
  });

  it('콜아웃 넷 — 머리 단어(또는 제목), danger 만 c-danger', () => {
    expect(render(':::note\n본문\n:::')).toBe('<div class="callout c-note" role="note"><p class="c-t">참고</p><p>본문</p></div>');
    expect(render(':::tip\nx\n:::')).toContain('<p class="c-t">팁</p>');
    // 제목이 있어도 종류 낱말을 앞에 둔다.
    expect(render(':::warning 조심\nx\n:::')).toContain('<div class="callout c-warning" role="note"><p class="c-t">주의 · 조심</p>');
    expect(render(':::danger\n토큰 폐기는 되돌릴 수 없습니다.\n:::')).toContain('<div class="callout c-danger" role="note"><p class="c-t">되돌릴 수 없음</p>');
    expect(parseError(':::note\n## 헤딩\n:::')).toMatch(/지시어 안에는 헤딩/);
    expect(parseError(':::note\nx')).toMatch(/닫히지 않은/);
    expect(parseError(':::bogus\nx\n:::')).toMatch(/모르는 지시어/);
  });

  it('단계 — 번호 목록 + 앞 헤딩 아래 단계의 헤딩, 코드 펜스·콜아웃 중첩', () => {
    const html = render(':::steps\n### 가입하기\n가입 페이지로 갑니다.\n### 토큰 만들기 {#token}\n```bash\necho :::\n```\n:::tip\n한 번만 보입니다.\n:::\n:::');
    expect(html).toBe(
      '<ol class="steps"><li><h2 id="가입하기">가입하기<a class="ha" href="#가입하기" aria-label="이 절로 가는 링크"><span aria-hidden="true">#</span></a></h2><p>가입 페이지로 갑니다.</p></li>' +
        '<li><h2 id="token">토큰 만들기<a class="ha" href="#token" aria-label="이 절로 가는 링크"><span aria-hidden="true">#</span></a></h2><div class="code"><div class="code-h"><span class="code-l">bash</span><button type="button" class="copy" data-copy hidden>복사</button></div><pre tabindex="0"><code>echo :::</code></pre></div>' +
        '<div class="callout c-tip" role="note"><p class="c-t">팁</p><p>한 번만 보입니다.</p></div></li></ol>',
    );
    // 앞에 h2 가 있으면 단계 제목은 h3.
    expect(render('## 순서\n\n:::steps\n### 하나\nx\n:::')).toContain('<li><h3 id="하나">하나<a class="ha" href="#하나"');
    expect(parseError(':::steps\n본문 먼저\n### 하나\n:::')).toMatch(/첫 줄/);
  });

  it('카드 — 링크 카드 격자(화살표 아이콘), 틀린 줄은 오류', () => {
    const html = render(':::cards\n- [보내기](/email/test): 메일 보내기와 결과\n:::');
    expect(html).toBe(
      '<ul class="cards"><li><a class="card" href="/email/test"><span class="card-t">보내기<svg class="ico" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3 8h10M9 4l4 4-4 4"/></svg></span>' +
        '<span class="card-d">메일 보내기와 결과</span></a></li></ul>',
    );
    expect(parseError(':::cards\n- 링크 없음\n:::')).toMatch(/카드 줄/);
  });

  it('탭 — 스크립트 없이는 라벨을 단 패널이 차례로 보인다', () => {
    const html = render(':::tabs\n@tab Claude Code\n하나\n@tab Cursor\n둘\n:::');
    expect(html).toBe(
      '<div class="tabs" data-tabs="1"><div class="tab"><p class="tab-l">Claude Code</p><p>하나</p></div><div class="tab"><p class="tab-l">Cursor</p><p>둘</p></div></div>',
    );
    expect(parseError(':::tabs\n@tab 하나\nx\n:::')).toMatch(/둘 이상/);
  });

  it('접기(details) — 질문 요약 + 답', () => {
    expect(render(':::details 승인은 어디서 하나요?\n소유자 메일의 링크로 합니다.\n:::')).toBe(
      '<details><summary>승인은 어디서 하나요?</summary><div class="dt-b"><p>소유자 메일의 링크로 합니다.</p></div></details>',
    );
  });

  it('문서 플래그 절(:::feature) — 꺼져 있으면 숨는다', () => {
    const both = { index: HOME('ko'), 'email/test': page('앞\n\n:::feature aliases\n별칭 설명\n:::\n\n뒤') };
    const off = buildDocsSite({ ko: both, en: { ...both, index: HOME('en') } }, { features: { aliases: false, attachments: false } });
    expect(off.pages.get('/email/test')?.html).not.toContain('별칭 설명');
    const on = buildDocsSite({ ko: both, en: { ...both, index: HOME('en') } }, { features: { aliases: true, attachments: false } });
    expect(on.pages.get('/email/test')?.html).toContain('<p>별칭 설명</p>');
  });

  it('자리표시 — 요금제 한도 표 · MCP 도구 목록', () => {
    expect(render('{{plan-limits}}')).toContain('<table class="limits">');
    expect(render('{{mcp-tools}}')).toContain('<li><code>send_email</code></li>');
    expect(parseError('{{nope}}')).toMatch(/모르는 자리표시/);
  });

  it('스크린샷 — 등록부 id 만, 대체 글 필수', () => {
    expect(() => render('![화면](shot:not-registered)')).toThrow(/등록부/);
    expect(parseError('![](shot:logs)')).toMatch(/대체 글/);
    expect(parseError('![x](https://example.com/a.png)')).toMatch(/shot:/);
  });

  it('인용(>)·들여 쓴 코드는 쓰지 않는다', () => {
    expect(parseError('> quote')).toMatch(/인용/);
    expect(parseError('text\n\n    code')).toMatch(/들여 쓴 코드/);
  });
});

describe('머리말', () => {
  it('필수 키 · 모르는 키 · 형식', () => {
    const fm = (lines: string): string => `---\n${lines}\n---\n\nbody\n`;
    const err = (src: string): string => {
      try {
        parseSource(src, 'x.md', false);
      } catch (e) {
        return (e as Error).message;
      }
      return '';
    };
    const ok = 'title: T\ndescription: D\ngroup: email\norder: 1\nupdated: 2026-09-27';
    expect(err(fm(ok))).toBe('');
    expect(err(fm(`${ok}\nsources: [src/x]`))).toMatch(/모르는 머리말 키/);
    expect(err(fm(ok.replace('updated: 2026-09-27', 'updated: 27/09/2026')))).toMatch(/YYYY-MM-DD/);
    expect(err(fm(ok.replace('order: 1', 'order: first')))).toMatch(/order/);
    expect(err(fm(ok.replace('description: D', `description: ${'가'.repeat(161)}`)))).toMatch(/160/);
    expect(err(fm(ok.replace('title: T', 'title: <b>T</b>')))).toMatch(/< >/);
    expect(err('no front matter')).toMatch(/머리말/);
    const parsed = parseSource(fm(`${ok}\nrelated: [email/sending, "connect/tokens"]\nnav_title: 짧게`), 'x.md', false);
    expect(parsed.front.related).toEqual(['email/sending', 'connect/tokens']);
    expect(parsed.front.navTitle).toBe('짧게');
  });

  it('ko/en 짝 · 그룹 · id 규칙은 빌드가 막는다', () => {
    const one = { index: HOME('ko'), 'email/test': page('x') };
    expect(() => buildDocsSite({ ko: one, en: { index: HOME('en') } })).toThrow(/짝/);
    const wrongGroup = { index: HOME('ko'), 'agents/test': page('x') };
    expect(() => buildDocsSite({ ko: wrongGroup, en: { ...wrongGroup, index: HOME('en') } })).toThrow(/그룹/);
    const badGroup = { index: HOME('ko'), 'email/test': page('x').replace('group: email', 'group: nope') };
    expect(() => buildDocsSite({ ko: badGroup, en: { ...badGroup, index: HOME('en') } })).toThrow(/모르는 group/);
  });
});
