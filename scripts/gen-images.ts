/**
 * `pnpm gen:images` — 홈(atmark.ai)의 OG 이미지를 **실제 화면에서** 만들어 값 파일 하나(`src/site/image-data.ts`)로 쓴다.
 *
 *   1. 콘솔 스크린샷(OG 재료) — 콘솔 개요 화면(`/app#/overview`)을 로컬 미리보기(`scripts/ui/preview.ts` · 가짜 API 시나리오 `landing`)로
 *      띄워 찍는다(언어별 밝은 한 장, WebP — 값 파일에는 싣지 않고 OG 틀에만 끼운다). 목업이 아니라 지금 콘솔 코드가 그리는 그대로다.
 *      데이터는 예시 조직(Example Labs)· `*.example` 상대뿐이라 사람·회사 실명이 없다. 시계는 `LANDING_NOW` 에 고정한다.
 *      (2026-09-29 홈 개편 — 히어로는 사진 + 유리 카드(`home.ts`)가 되어 콘솔 스크린샷을 페이지에 싣지 않는다. 사진은 `pnpm gen:photos`.)
 *   2. OG 이미지 — 1200×630 PNG, 언어별 한 장. 굵은 Pretendard 헤드라인(홈 h1 과 같은 글) + 위 스크린샷 조각 + 로고 가로 조합(`src/ui/brand.ts`), 흑백.
 *
 * 헤드리스 Chrome 을 쓴다 — **한 기계에 Chrome 하나** 규칙이 있으면 부르는 쪽이 잠금을 먼저 잡는다(`scripts/ui/README.md`).
 * 미리보기는 이 프로세스 안에서 빈 포트 짝으로 띄운다(다른 작업자의 4173·4174 미리보기와 부딪히지 않고, 늘 지금 코드로 그린다).
 * 결과는 같은 기계·같은 Chrome 이면 같은 바이트다(글꼴·데이터·시계·모션이 고정). 다른 기계의 안티앨리어싱 차이는 커밋된 파일이 흡수한다 —
 * 테스트는 다시 찍지 않고 커밋된 바이트의 모양(형식·크기·해시·경로)만 본다(`test/unit/site/site-seo.test.ts`).
 * 콘솔 화면·홈 헤드라인이 눈에 띄게 바뀌면 다시 돌린다.
 */

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';

import { HOME_COPY } from '../src/site/home';
import { brandLockupSvg } from '../src/ui/brand';
import { handleSiteRequest } from '../src/site/http';
import { FONT_FACE_CSS } from '../src/ui/fonts';
import { screenAddressProblems } from './gen-docs-shots';
import { Cdp, delay, killChrome, launchChrome, REPO_ROOT, type ChromeHandle } from './ui/browser';
import { LANDING_NOW } from './ui/fake-api';
import { startPreview } from './ui/preview';

export const IMAGE_DATA_OUT = join(REPO_ROOT, 'src/site/image-data.ts');
export const OG_VERSION_OUT = join(REPO_ROOT, 'src/ui/og-version.ts');

type Lang = 'ko' | 'en';
type Theme = 'light' | 'dark';

/**
 * 콘솔을 찍는 창(CSS px)과 배율 — 히어로 칸(최대 ~640 CSS px)에서 2배 화면도 흐리지 않게 1.5배.
 * 이미지는 창 전체가 아니라 **에이전트 표가 끝난 곳 + `bottomPad`** 에서 자른다(아래 "최근 활동" 표가 반쯤 잘린 채 걸리지 않게).
 */
const SHOT = { width: 1200, height: 880, scale: 1.5, quality: 86, bottomPad: 40 } as const;
const OG = { width: 1200, height: 630 } as const;

interface Captured {
  readonly bytes: Buffer;
  readonly width: number;
  readonly height: number;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = address !== null && typeof address === 'object' ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** 브라우저 시계를 `LANDING_NOW` 에 멈춘다 — `Date.now()`·`new Date()` 가 늘 같은 값(인자 있는 `new Date(x)` 는 그대로). */
const FREEZE_CLOCK = `(function(){var T=Date.parse(${JSON.stringify(LANDING_NOW)}),D=Date;
function F(){if(!(this instanceof F))return new D(T).toString();var a=Array.prototype.slice.call(arguments);return a.length?new (Function.prototype.bind.apply(D,[null].concat(a)))():new D(T);}
F.prototype=D.prototype;F.now=function(){return T;};F.parse=D.parse;F.UTC=D.UTC;window.Date=F;})();`;

async function load(cdp: Cdp, url: string): Promise<void> {
  await cdp.send('Page.navigate', { url: 'about:blank' });
  await delay(100);
  const loaded = new Promise<void>((resolve) => cdp.on('Page.loadEventFired', () => resolve()));
  await cdp.send('Page.navigate', { url });
  await Promise.race([loaded, delay(10000)]);
  await cdp.send('Runtime.evaluate', { expression: 'document.fonts.ready.then(function(){return true;})', awaitPromise: true });
  await delay(1500);
}

async function text(cdp: Cdp): Promise<string> {
  const r = await cdp.send<{ result: { value: string } }>('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true });
  return r.result.value;
}

async function captureConsole(cdp: Cdp, consolePort: number, lang: Lang, theme: Theme): Promise<Captured> {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: SHOT.width, height: SHOT.height, deviceScaleFactor: SHOT.scale, mobile: false });
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [
      { name: 'prefers-color-scheme', value: theme },
      { name: 'prefers-reduced-motion', value: 'reduce' },
    ],
  });
  await load(cdp, `http://127.0.0.1:${String(consolePort)}/app?lang=${lang}&_scn=landing#/overview`);
  // 가짜 API 시나리오가 실제로 탔는지(다른 데이터로 찍힌 광고 이미지를 막는다).
  const body = await text(cdp);
  for (const needle of ['Example Labs', 'scout', 'help-desk', 'scout@atmark.ai', 'maya@acme.example']) {
    if (!body.includes(needle)) throw new Error(`콘솔 화면에 '${needle}' 가 없다 — landing 시나리오가 안 탔다(${lang}/${theme})`);
  }
  if (body.includes('Chronostasis')) throw new Error('기본 데이터(Chronostasis)가 찍혔다');
  // 보안 검토 F1 — 실제 서비스 주소(support@ 등 예약된 이름)나 예시 규칙 밖의 @atmark.ai 주소가 고객 에이전트처럼 찍히지 않게.
  const bad = screenAddressProblems(body);
  if (bad.length > 0) throw new Error(`예시가 아닌 @atmark.ai 주소가 화면에 있다 — ${bad.join(', ')}`);
  // 자를 높이 — 에이전트 표 블록의 아래 끝 + 여백, 단 다음 블록(최근 활동)이 시작하는 곳을 넘지 않는다(짝수 CSS px → 1.5배에서도 정수 픽셀).
  const edge = await cdp.send<{ result: { value: { agents: number; next: number } | null } }>('Runtime.evaluate', {
    expression:
      "(function(){var a=document.querySelector('#ov-agents-b'),n=document.querySelector('#ov-log-b');if(!a||!n)return null;" +
      'return {agents:a.getBoundingClientRect().bottom+window.scrollY,next:n.getBoundingClientRect().top+window.scrollY};})()',
    returnByValue: true,
  });
  const box = edge.result.value;
  if (box === null) throw new Error(`개요 화면의 에이전트 표(#ov-agents-b)·최근 활동(#ov-log-b)을 찾지 못했다(${lang}/${theme})`);
  const height = Math.floor(Math.min(box.agents + SHOT.bottomPad, box.next) / 2) * 2;
  if (height < box.agents + 16 || height > SHOT.height) {
    throw new Error(`자를 높이 ${String(height)} 가 에이전트 표 끝(${String(box.agents)})에 너무 붙거나 창(${String(SHOT.height)})을 넘는다(${lang}/${theme})`);
  }
  const shot = await cdp.send<{ data: string }>('Page.captureScreenshot', {
    format: 'webp',
    quality: SHOT.quality,
    clip: { x: 0, y: 0, width: SHOT.width, height, scale: 1 },
  });
  return { bytes: Buffer.from(shot.data, 'base64'), width: SHOT.width * SHOT.scale, height: height * SHOT.scale };
}

/** OG 한 장의 HTML — 스크립트 없음, 글꼴은 같은 출처 `/_fonts/…`(사이트 핸들러가 낸다), 스크린샷은 `/shot-<lang>.webp`. */
export function ogHtml(lang: Lang): string {
  const h1 = HOME_COPY[lang]['h1'] ?? '';
  const kicker = lang === 'ko' ? 'AI 에이전트의 신원과 이메일' : 'Identity and email for AI agents';
  const css = `${FONT_FACE_CSS}
*{box-sizing:border-box;margin:0}
html,body{width:${String(OG.width)}px;height:${String(OG.height)}px;overflow:hidden;background:#FFFFFF}
body{position:relative;font-family:"Pretendard Variable",sans-serif;color:#171717;-webkit-font-smoothing:antialiased;word-break:keep-all}
.logo{position:absolute;left:72px;top:64px;display:block;width:auto;height:36px;color:#171717}
h1{position:absolute;left:72px;top:168px;width:${lang === 'ko' ? '560' : '520'}px;font-size:${lang === 'ko' ? '70' : '66'}px;line-height:${lang === 'ko' ? '1.2' : '1.08'};font-weight:800;letter-spacing:${lang === 'ko' ? '-0.035em' : '-0.045em'}}
.foot{position:absolute;left:72px;bottom:64px;display:flex;align-items:center;gap:14px;font-size:22px;line-height:1;color:#6B6B6B}
.pill{display:inline-flex;align-items:center;height:40px;padding:0 18px;border-radius:9999px;box-shadow:inset 0 0 0 1.5px #171717;color:#171717;font-weight:600}
.shot{position:absolute;left:668px;bottom:64px;width:760px;overflow:hidden;border-radius:18px;background:#FFFFFF;box-shadow:0 0 0 1px #E8E8E8,0 24px 48px -16px rgba(0,0,0,.18)}
.shot img{display:block;width:760px;height:auto}`;
  return (
    `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><style>${css}</style></head><body>` +
    brandLockupSvg({ className: 'logo', height: 36 }) +
    `<h1>${h1}</h1>` +
    `<p class="foot"><span class="pill">${kicker}</span><span>atmark.ai</span></p>` +
    `<div class="shot"><img src="/shot-${lang}.webp" alt=""></div>` +
    '</body></html>'
  );
}

/** OG 틀을 내는 작은 서버 — `/og/<lang>.html` · `/shot-<lang>.webp`(방금 찍은 밝은 스크린샷) · 그 밖은 사이트 핸들러(글꼴). */
function startOgServer(port: number, shots: Readonly<Record<Lang, Buffer>>): Promise<Server> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const og = /^\/og\/(ko|en)\.html$/.exec(url.pathname);
    if (og !== null) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(ogHtml(og[1] as Lang));
      return;
    }
    const shot = /^\/shot-(ko|en)\.webp$/.exec(url.pathname);
    if (shot !== null) {
      res.writeHead(200, { 'content-type': 'image/webp' });
      res.end(shots[shot[1] as Lang]);
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

async function captureOg(cdp: Cdp, port: number, lang: Lang): Promise<Captured> {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: OG.width, height: OG.height, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await load(cdp, `http://127.0.0.1:${String(port)}/og/${lang}.html`);
  await cdp.send('Runtime.evaluate', { expression: "document.querySelector('.shot img').decode().then(function(){return true;})", awaitPromise: true });
  await delay(300);
  const shot = await cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: OG.width, height: OG.height, scale: 1 } });
  return { bytes: Buffer.from(shot.data, 'base64'), width: OG.width, height: OG.height };
}

export function imageHash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

function entry(path: string, contentType: string, c: Captured): string {
  return (
    '{\n' +
    `    path: '${path}',\n` +
    `    contentType: '${contentType}',\n` +
    `    width: ${String(c.width)},\n` +
    `    height: ${String(c.height)},\n` +
    `    hash: '${imageHash(c.bytes)}',\n` +
    `    bytes: ${String(c.bytes.length)},\n` +
    `    base64: '${c.bytes.toString('base64')}',\n` +
    '  }'
  );
}

/** `src/ui/og-version.ts` — OG 이미지 해시만(문서 번들이 읽는다). */
export function renderOgVersion(og: Readonly<Record<Lang, Captured>>): string {
  return (
    '/**\n' +
    ' * 생성 파일 — 손으로 고치지 않는다. `pnpm gen:images` 가 `src/site/image-data.ts` 와 함께 쓴다. OG 이미지(링크 미리보기)의 내용 해시.\n' +
    ' * 홈과 문서가 `og:image` 를 `/og/<해시>/<lang>.png` 로 가리킨다 — 카카오톡·슬랙·X 는 이미지를 **URL 로** 오래 기억하므로, 그림이 바뀌면\n' +
    ' * URL 도 바뀌어야 새 미리보기가 뜬다(2026-09-30 진윤겸: 새 로고가 공유 미리보기에 안 보였다). 문서 번들은 사이트 모듈을 싣지 않으므로 여기 둔다.\n' +
    ' */\n\n' +
    `export const OG_IMAGE_HASH = { ko: '${imageHash(og.ko.bytes)}', en: '${imageHash(og.en.bytes)}' } as const;\n`
  );
}

export function renderImageData(og: Readonly<Record<Lang, Captured>>): string {
  return (
    '/**\n' +
    ' * 생성 파일 — 손으로 고치지 않는다. `pnpm gen:images`(`scripts/gen-images.ts`)가 OG 틀(홈 h1 + 실제 콘솔 화면 조각, 가짜 API 시나리오\n' +
    ' * `landing`)을 헤드리스 Chrome 으로 찍어 만든다. import 는 없다(값 파일). OG 는 1200×630 PNG(언어별). 홈 사진은 `photo-data.ts`.\n' +
    ' */\n\n' +
    'export interface SiteImage {\n' +
    '  readonly path: string;\n' +
    '  readonly contentType: string;\n' +
    '  readonly width: number;\n' +
    '  readonly height: number;\n' +
    '  readonly hash: string;\n' +
    '  readonly bytes: number;\n' +
    '  readonly base64: string;\n' +
    '}\n\n' +
    "export const OG_IMAGES: Readonly<Record<'ko' | 'en', SiteImage>> = {\n" +
    `  ko: ${entry('/og/ko.png', 'image/png', og.ko)},\n` +
    `  en: ${entry('/og/en.png', 'image/png', og.en)},\n` +
    '};\n'
  );
}

async function main(): Promise<void> {
  const [consolePort, sitePort, ogPort] = [await freePort(), await freePort(), await freePort()];
  const preview = await startPreview(consolePort, sitePort);
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
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: FREEZE_CLOCK });

    const shots = {} as Record<Lang, Captured>;
    for (const lang of ['ko', 'en'] as const) {
      shots[lang] = await captureConsole(cdp, consolePort, lang, 'light');
      console.log(`✓ 콘솔 ${lang} ${(shots[lang].bytes.length / 1024).toFixed(0)} KiB`);
    }
    ogServer = await startOgServer(ogPort, { ko: shots.ko.bytes, en: shots.en.bytes });
    const og = { ko: await captureOg(cdp, ogPort, 'ko'), en: await captureOg(cdp, ogPort, 'en') };
    console.log(`✓ OG ko ${(og.ko.bytes.length / 1024).toFixed(0)} KiB · en ${(og.en.bytes.length / 1024).toFixed(0)} KiB`);
    writeFileSync(IMAGE_DATA_OUT, renderImageData(og));
    writeFileSync(OG_VERSION_OUT, renderOgVersion(og));
    console.log(`✓ 씀: ${IMAGE_DATA_OUT.slice(REPO_ROOT.length)}`);
  } finally {
    cdp?.close();
    if (chrome !== null) killChrome(chrome);
    ogServer?.close();
    preview.close();
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
