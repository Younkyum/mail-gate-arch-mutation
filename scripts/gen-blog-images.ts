/**
 * `pnpm gen:blog-images` — 블로그 이미지를 **실제 화면에서** 만들어 값 파일 둘에 쓴다. 헤드리스 Chrome 을 쓴다(한 기계에 Chrome 하나 규칙이 있으면
 * 부르는 쪽이 `ui-shots.lock` 을 먼저 잡는다 — `scripts/ui/README.md`). 미리보기는 이 프로세스 안에서 빈 포트로 띄운다(4173·4174 와 부딪히지 않음).
 *
 *   1. `--shots` — 글이 쓰는 콘솔 스크린샷(`![…](shot:<id>)`, 초안 포함)을 문서 스크린샷과 **같은 기계**(`scripts/gen-docs-shots.ts` `capture` —
 *      가짜 API 시나리오 `docs` · 고정 시계 · 화면 글자 검사)로 그 글의 언어 × 두 테마 WebP 로 찍어 `src/site/blog-shot-data.ts` 에 쓴다.
 *      등록부는 `src/site/blog/shots.ts`(블로그 전용) + `src/docs/shots.ts`(문서). 경로 `/img/<해시>/blog-<id>-<lang>-<theme>.webp`.
 *   2. `--og` — **공개 글마다** 링크 미리보기 카드(1200×630 PNG)를 그려 `src/site/blog-og-data.ts` 에 쓴다. 홈 OG(`gen-images.ts`)와 같은 틀:
 *      흰 바탕 · 로고 가로 조합 · 굵은 Pretendard 제목 · 아래 글쓴이·날짜, 흑백. 표지 그림(`cover`)이 있으면 오른쪽 회색 판 위에 싣는다.
 *      경로 `/og/blog/<해시>/<slug>-<lang>.png`. 카드에 제목을 같이 적어 두고, 글 제목이 바뀌면 사이트가 낡은 카드 대신 공통 OG 를 싣는다.
 *   인자가 없으면 둘 다. `--preview <폴더>` 는 값 파일을 건드리지 않고 **초안까지** OG 카드를 그 폴더에 PNG 로 쓴다(디자인 검토용).
 *   `--only <id,id>` 는 그 스크린샷만 다시 찍고 나머지는 기존 값을 둔다.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';

import { DOCS_SHOT_VIEW, DOCS_SHOTS, type DocsShotSpec } from '../src/docs/shots';
import { BLOG_SHOTS } from '../src/site/blog/shots';
import type { BlogPostRecord } from '../src/site/blog-data';
import { BLOG_SHOT_IMAGES, BLOG_SHOT_SCALE, type BlogShotImage, type BlogShotSet } from '../src/site/blog-shot-data';
import { effectiveDateText } from '../src/site/constants';
import { handleSiteRequest, SITE_ROUTES } from '../src/site/http';
import { brandLockupSvg } from '../src/ui/brand';
import { FONT_FACE_CSS } from '../src/ui/fonts';
import { buildBlog, escapeHtml as esc, readBlogSources, REPO_ROOT } from './blog/build';
import { capture, FREEZE_CLOCK, freePort, imageHash, load } from './gen-docs-shots';
import { Cdp, delay, killChrome, launchChrome, type ChromeHandle } from './ui/browser';
import { startPreview } from './ui/preview';

const BLOG_SHOT_OUT = join(REPO_ROOT, 'src/site/blog-shot-data.ts');
const BLOG_OG_OUT = join(REPO_ROOT, 'src/site/blog-og-data.ts');

type Lang = 'ko' | 'en';
const OG = { width: 1200, height: 630 } as const;

// ── OG 카드 ──────────────────────────────────────────────────────────────

const decode = (b64: string): string => Buffer.from(b64, 'base64').toString('utf8');

/** 카드 한 장의 HTML — 스크립트 없음, 글꼴은 같은 출처 `/_fonts/…`(사이트 핸들러). 그림 칠은 사이트 밝은 팔레트 값 그대로. */
function blogOgHtml(p: BlogPostRecord): string {
  const cover = p.cover === null ? '' : decode(p.cover);
  const long = [...p.title].length;
  const size = cover === '' ? (long > 70 ? 60 : long > 44 ? 70 : 80) : long > 60 ? 46 : long > 36 ? 54 : 62;
  const label = p.lang === 'ko' ? '블로그' : 'Blog';
  const css = `${FONT_FACE_CSS}
*{box-sizing:border-box;margin:0}
html,body{width:${String(OG.width)}px;height:${String(OG.height)}px;overflow:hidden;background:#FFFFFF}
body{position:relative;font-family:"Pretendard Variable",sans-serif;color:#171717;-webkit-font-smoothing:antialiased;word-break:keep-all}
.top{position:absolute;left:72px;top:64px;display:flex;align-items:center;gap:18px;font-size:24px;line-height:1;font-weight:600;color:#171717}
.top .logo{display:block;width:auto;height:34px}
.top .sep{width:1.5px;height:28px;background:#171717}
h1{position:absolute;left:72px;top:150px;width:${cover === '' ? '1000' : '500'}px;font-size:${String(size)}px;line-height:${p.lang === 'ko' ? '1.22' : '1.06'};font-weight:800;letter-spacing:${p.lang === 'ko' ? '-0.035em' : '-0.045em'};text-wrap:balance}
.foot{position:absolute;left:72px;bottom:60px;display:flex;align-items:center;gap:14px;font-size:22px;line-height:1;color:#666666}
.foot .dot{width:4px;height:4px;border-radius:50%;background:#808080}
.plate{position:absolute;right:0;top:64px;bottom:64px;width:584px;display:flex;align-items:center;justify-content:center;padding:28px 40px 28px 32px;border-radius:24px 0 0 24px;background:#EAEAEA;color:#171717}
.plate svg{display:block;width:100%;height:auto;max-height:100%}
.fig-svg text{fill:currentColor;font-family:inherit}
.fig-svg .ink{fill:#171717}.fig-svg .paper{fill:#FFFFFF}.fig-svg .band{fill:#EAEAEA}.fig-svg .mute{fill:#666666}
.fig-svg .line{fill:none;stroke:#171717}.fig-svg .hair{fill:none;stroke:#CCCCCC}.fig-svg .soft{fill:none;stroke:#808080}
.fig-svg .dash{stroke-dasharray:4 4}.fig-svg .thick{stroke-width:2}.fig-svg .label{font-size:13px}.fig-svg .small{font-size:11px;fill:#666666}
.fig-svg .title{font-size:15px;font-weight:700}.fig-svg .bold{font-weight:700}.fig-svg .inv{fill:#F3F3F3}.fig-svg .end{text-anchor:end}.fig-svg .mid{text-anchor:middle}`;
  return (
    `<!doctype html><html lang="${p.lang}"><head><meta charset="utf-8"><style>${css}</style></head><body>` +
    `<div class="top">${brandLockupSvg({ className: 'logo', height: 34 })}<span class="sep"></span><span>${label}</span></div>` +
    `<h1>${esc(p.title)}</h1>` +
    `<p class="foot"><span>${esc(p.author)}</span><span class="dot"></span><span>${effectiveDateText(p.lang, p.date)}</span><span class="dot"></span><span>atmark.ai</span></p>` +
    (cover === '' ? '' : `<div class="plate">${cover}</div>`) +
    '</body></html>'
  );
}

function startOgServer(port: number, posts: readonly BlogPostRecord[]): Promise<Server> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const m = /^\/card\/([a-z0-9-]+)\/(en|ko)\.html$/.exec(url.pathname);
    const post = m === null ? undefined : posts.find((p) => p.slug === m[1] && p.lang === m[2]);
    if (post !== undefined) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(blogOgHtml(post));
      return;
    }
    const result = handleSiteRequest({ rawPath: url.pathname, headers: { host: 'atmark.ai' }, requestContext: { http: { method: 'GET' } } });
    res.writeHead(result.statusCode, { 'content-type': result.headers['content-type'] ?? 'text/plain' });
    res.end(Buffer.from(result.body, result.isBase64Encoded ? 'base64' : 'utf8'));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

async function captureOg(cdp: Cdp, port: number, p: BlogPostRecord): Promise<Buffer> {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: OG.width, height: OG.height, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await load(cdp, `http://127.0.0.1:${String(port)}/card/${p.slug}/${p.lang}.html`);
  await delay(200);
  const shot = await cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: OG.width, height: OG.height, scale: 1 } });
  return Buffer.from(shot.data, 'base64');
}

function renderOgData(cards: readonly { readonly post: BlogPostRecord; readonly bytes: Buffer }[]): string {
  const sorted = [...cards].sort((a, b) => (`${a.post.slug}/${a.post.lang}` < `${b.post.slug}/${b.post.lang}` ? -1 : 1));
  const entry = ({ post, bytes }: { post: BlogPostRecord; bytes: Buffer }): string => {
    const hash = imageHash(bytes);
    return (
      `  ${JSON.stringify(`${post.slug}/${post.lang}`)}: {\n` +
      `    path: '/og/blog/${hash}/${post.slug}-${post.lang}.png',\n` +
      "    contentType: 'image/png',\n" +
      `    width: ${String(OG.width)},\n` +
      `    height: ${String(OG.height)},\n` +
      `    hash: '${hash}',\n` +
      `    bytes: ${String(bytes.length)},\n` +
      `    base64: '${bytes.toString('base64')}',\n` +
      `    title: ${JSON.stringify(post.title)},\n` +
      '  },\n'
    );
  };
  return (
    '/**\n' +
    ' * 생성 파일 — 손으로 고치지 않는다. `pnpm gen:blog-images --og`(`scripts/gen-blog-images.ts`)가 공개 글마다 링크 미리보기 카드(1200×630 PNG —\n' +
    ' * 로고 가로 조합 + 글 제목, 흑백)를 헤드리스 Chrome 으로 그려 쓴다. import 는 없다(값 파일). 키는 `<slug>/<lang>`.\n' +
    ' * `title` 은 카드를 그릴 때의 글 제목이다 — 글 제목이 바뀌었는데 다시 그리지 않았으면 사이트는 이 카드 대신 사이트 공통 OG 를 싣는다(낡은 제목 방지).\n' +
    ' */\n\n' +
    'export interface BlogOgImage {\n  readonly path: string;\n  readonly contentType: string;\n  readonly width: number;\n  readonly height: number;\n' +
    '  readonly hash: string;\n  readonly bytes: number;\n  readonly base64: string;\n  readonly title: string;\n}\n\n' +
    `export const BLOG_OG_IMAGES: Readonly<Record<string, BlogOgImage>> = {${sorted.length === 0 ? '' : `\n${sorted.map(entry).join('')}`}};\n`
  );
}

// ── 스크린샷 ─────────────────────────────────────────────────────────────

export function renderShotData(images: Readonly<Record<string, BlogShotSet>>): string {
  const entry = (img: BlogShotImage): string =>
    `{ path: '${img.path}', width: ${String(img.width)}, height: ${String(img.height)}, hash: '${img.hash}', bytes: ${String(img.bytes)}, base64: '${img.base64}' }`;
  const ids = Object.keys(images).sort();
  return (
    '/**\n' +
    ' * 생성 파일 — 손으로 고치지 않는다. `pnpm gen:blog-images`(`scripts/gen-blog-images.ts`)가 블로그 글이 쓰는 콘솔 스크린샷(등록부\n' +
    ' * `src/site/blog/shots.ts` · `src/docs/shots.ts`)을 실제 콘솔 화면(로컬 미리보기 + 가짜 API 시나리오 `docs`)에서 찍어 쓴다. import 는 없다(값 파일).\n' +
    ' * 경로는 `/img/<해시>/blog-<id>-<lang>-<theme>.webp`(1년 immutable). `width`·`height` 는 이미지 픽셀(1.5배로 찍었다 — 화면 폭은 2/3).\n' +
    ' */\n\n' +
    'export interface BlogShotImage {\n  readonly path: string;\n  readonly width: number;\n  readonly height: number;\n  readonly hash: string;\n  readonly bytes: number;\n  readonly base64: string;\n}\n\n' +
    '/** 찍은 배율 — 화면에 싣는 CSS 크기 = 픽셀 / 배율(문서 스크린샷 `DOCS_SHOT_VIEW.scale` 과 같다 — 테스트). */\n' +
    `export const BLOG_SHOT_SCALE = ${String(BLOG_SHOT_SCALE)};\n\n` +
    "/** 언어별 두 테마 — 그 언어의 글이 쓰는 언어만 찍는다(영어 글만 쓰면 `en` 만). */\n" +
    "export type BlogShotSet = Readonly<Partial<Record<'ko' | 'en', Readonly<Record<'light' | 'dark', BlogShotImage>>>>>;\n\n" +
    `export const BLOG_SHOT_IMAGES: Readonly<Record<string, BlogShotSet>> = {${ids.length === 0 ? '' : '\n'}` +
    ids
      .map((id) => {
        const set = images[id];
        if (set === undefined) return '';
        const lang = (l: Lang): string => {
          const v = set[l];
          return v === undefined ? '' : `    ${l}: {\n      light: ${entry(v.light)},\n      dark: ${entry(v.dark)},\n    },\n`;
        };
        return `  ${JSON.stringify(id)}: {\n${lang('ko')}${lang('en')}  },\n`;
      })
      .join('') +
    '};\n'
  );
}

function specFor(id: string): DocsShotSpec | undefined {
  return (BLOG_SHOTS as Readonly<Record<string, DocsShotSpec>>)[id] ?? (DOCS_SHOTS as Readonly<Record<string, DocsShotSpec>>)[id];
}

// ── 실행 ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const previewIdx = args.indexOf('--preview');
  const previewDir = previewIdx >= 0 ? args[previewIdx + 1] : undefined;
  const onlyIdx = args.indexOf('--only');
  const only = onlyIdx >= 0 ? new Set((args[onlyIdx + 1] ?? '').split(',').filter((s) => s !== '')) : null;
  const wantShots = previewDir === undefined && (args.includes('--shots') || !args.includes('--og'));
  const wantOg = previewDir !== undefined || args.includes('--og') || !args.includes('--shots');
  if (BLOG_SHOT_SCALE !== DOCS_SHOT_VIEW.scale) throw new Error('BLOG_SHOT_SCALE 가 DOCS_SHOT_VIEW.scale 과 다르다');

  const sitePaths = new Set(Object.keys(SITE_ROUTES));
  const all = buildBlog(readBlogSources(), { drafts: true, sitePaths }).posts;
  const published = all.filter((p) => !p.draft);

  const [consolePort, sitePort, ogPort] = [await freePort(), await freePort(), await freePort()];
  const preview = wantShots ? await startPreview(consolePort, sitePort) : null;
  let chrome: ChromeHandle | null = null;
  let cdp: Cdp | null = null;
  let ogServer: Server | null = null;
  try {
    chrome = await launchChrome();
    const tab = (await (await fetch(`http://127.0.0.1:${String(chrome.port)}/json/new?about:blank`, { method: 'PUT' })).json()) as { webSocketDebuggerUrl: string };
    cdp = new Cdp();
    await cdp.connect(tab.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    if (wantShots) {
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: FREEZE_CLOCK });
      // 글(초안 포함)이 쓰는 id × 그 글의 언어.
      const wanted = new Map<string, Set<Lang>>();
      for (const p of all) for (const id of p.shots) wanted.set(id, (wanted.get(id) ?? new Set()).add(p.lang));
      const images: Record<string, BlogShotSet> = {};
      for (const [id, set] of Object.entries(BLOG_SHOT_IMAGES)) if (wanted.has(id) && (only === null || !only.has(id))) images[id] = set;
      for (const [id, langs] of wanted) {
        if (only !== null && !only.has(id)) continue;
        const spec = specFor(id);
        if (spec === undefined) {
          console.warn(`! ${id}: 등록부에 없다 — 건너뜀(src/site/blog/shots.ts)`);
          continue;
        }
        const out: Partial<Record<Lang, { light: BlogShotImage; dark: BlogShotImage }>> = {};
        for (const lang of langs) {
          const pair = {} as { light: BlogShotImage; dark: BlogShotImage };
          for (const theme of ['light', 'dark'] as const) {
            const c = await capture(cdp, consolePort, id, spec, lang, theme);
            const hash = imageHash(c.bytes);
            pair[theme] = { path: `/img/${hash}/blog-${id}-${lang}-${theme}.webp`, width: c.width, height: c.height, hash, bytes: c.bytes.length, base64: c.bytes.toString('base64') };
          }
          out[lang] = pair;
        }
        images[id] = out;
        console.log(`✓ shot ${id.padEnd(28)} ${[...langs].join(',')}`);
      }
      writeFileSync(BLOG_SHOT_OUT, renderShotData(images));
      console.log(`✓ 씀: ${BLOG_SHOT_OUT.slice(REPO_ROOT.length)} (${String(Object.keys(images).length)}장)`);
    }

    if (wantOg) {
      const targets = previewDir === undefined ? published : all;
      ogServer = await startOgServer(ogPort, targets);
      const cards: { post: BlogPostRecord; bytes: Buffer }[] = [];
      for (const p of targets) {
        const bytes = await captureOg(cdp, ogPort, p);
        cards.push({ post: p, bytes });
        console.log(`✓ og ${p.slug}/${p.lang} ${(bytes.length / 1024).toFixed(0)} KiB`);
        if (previewDir !== undefined) {
          mkdirSync(previewDir, { recursive: true });
          writeFileSync(join(previewDir, `og-${p.slug}-${p.lang}.png`), bytes);
        }
      }
      if (previewDir === undefined) {
        writeFileSync(BLOG_OG_OUT, renderOgData(cards));
        console.log(`✓ 씀: ${BLOG_OG_OUT.slice(REPO_ROOT.length)} (${String(cards.length)}장)`);
      }
    }
  } finally {
    cdp?.close();
    if (chrome !== null) killChrome(chrome);
    ogServer?.close();
    preview?.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(error);
      process.exit(1);
    },
  );
}
