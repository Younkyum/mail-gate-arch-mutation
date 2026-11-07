/**
 * `pnpm gen:docs-shots` — 문서 스크린샷(`src/docs/shots.ts` 등록부)을 **실제 콘솔 화면**에서 찍어 값 파일 하나(`src/docs/generated/shots.ts`)로 쓴다.
 *
 * 홈 이미지(`scripts/gen-images.ts`)와 같은 방식: 로컬 미리보기(`scripts/ui/preview.ts`)를 이 프로세스 안에서 빈 포트 짝으로 띄우고, 가짜 API
 * 시나리오 `docs`(예시 조직 Example Labs · `*.example` 상대 · 발급 값은 토큰 모양이 아닌 예시 글자)로 연 콘솔을 헤드리스 Chrome 으로 찍는다.
 * 두 언어 × 두 테마, WebP. 브라우저 시계는 `LANDING_NOW` 에 멈춘다("n분 전" 이 매번 같다). 목업은 없다.
 *
 * 찍은 뒤 화면 글자를 검사한다: 기본 데이터(Chronostasis)가 아니라 예시 조직인지, 토큰·키 모양 문자열이 없는지(`TOKEN_SHAPE`). 걸리면 멈춘다.
 * **한 기계에 Chrome 하나** 규칙이 있으면 부르는 쪽이 잠금(`ui-shots.lock`)을 먼저 잡는다(`scripts/ui/README.md`).
 * `--only <id,id>` 는 그 샷만 다시 찍고 나머지는 기존 값을 둔다.
 */

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

import { EXAMPLE_RESERVED_LOCAL_PARTS } from '../src/identity/address';
import { DOCS_SHOT_IMAGES, type DocsShotImage, type DocsShotSet } from '../src/docs/generated/shots';
import { DOCS_SHOT_VIEW, DOCS_SHOTS, type DocsShotSpec } from '../src/docs/shots';
import { Cdp, delay, killChrome, launchChrome, REPO_ROOT, type ChromeHandle } from './ui/browser';
import { LANDING_NOW } from './ui/fake-api';
import { startPreview } from './ui/preview';

export const SHOTS_OUT = join(REPO_ROOT, 'src/docs/generated/shots.ts');

type Lang = 'ko' | 'en';
type Theme = 'light' | 'dark';

/** 토큰·키 모양 — 접두어 뒤에 예시 글자가 아닌 긴 무작위 꼬리. */
export const TOKEN_SHAPE = /atk_(?:agent|org)_(?!example-value-shown-once)[A-Za-z0-9._-]{8,}/;

export function freePort(): Promise<number> {
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

export const FREEZE_CLOCK = `(function(){var T=Date.parse(${JSON.stringify(LANDING_NOW)}),D=Date;
function F(){if(!(this instanceof F))return new D(T).toString();var a=Array.prototype.slice.call(arguments);return a.length?new (Function.prototype.bind.apply(D,[null].concat(a)))():new D(T);}
F.prototype=D.prototype;F.now=function(){return T;};F.parse=D.parse;F.UTC=D.UTC;window.Date=F;})();`;

async function evaluate<T>(cdp: Cdp, expression: string): Promise<T> {
  const r = await cdp.send<{ result: { value: T } }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r.result.value;
}

export async function load(cdp: Cdp, url: string): Promise<void> {
  await cdp.send('Page.navigate', { url: 'about:blank' });
  await delay(100);
  const loaded = new Promise<void>((resolve) => cdp.on('Page.loadEventFired', () => resolve()));
  await cdp.send('Page.navigate', { url });
  await Promise.race([loaded, delay(10000)]);
  await evaluate(cdp, 'document.fonts.ready.then(function(){return true;})');
  await delay(1500);
}

function shotUrl(port: number, spec: DocsShotSpec, lang: Lang): string {
  const [path = '/app', hash = ''] = spec.path.split('#');
  return `http://127.0.0.1:${String(port)}${path}?lang=${lang}&_scn=${spec.scenario ?? 'docs'}${hash === '' ? '' : `#${hash}`}`;
}

export async function capture(cdp: Cdp, port: number, id: string, spec: DocsShotSpec, lang: Lang, theme: Theme): Promise<{ bytes: Buffer; width: number; height: number }> {
  const height = DOCS_SHOT_VIEW.height;
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: spec.width ?? DOCS_SHOT_VIEW.width, height, deviceScaleFactor: DOCS_SHOT_VIEW.scale, mobile: false });
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [
      { name: 'prefers-color-scheme', value: theme },
      { name: 'prefers-reduced-motion', value: 'reduce' },
    ],
  });
  await load(cdp, shotUrl(port, spec, lang));
  for (const step of spec.steps ?? []) {
    if (step.click !== undefined) {
      const ok = await evaluate<boolean>(cdp, `(function(){var e=document.querySelector(${JSON.stringify(step.click)});if(!e)return false;e.click();return true;})()`);
      if (!ok) throw new Error(`${id}: 누를 요소가 없다 ${step.click}`);
    }
    if (step.fill !== undefined) {
      const [selector, value] = step.fill;
      const ok = await evaluate<boolean>(
        cdp,
        `(function(){var e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;e.focus();e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`,
      );
      if (!ok) throw new Error(`${id}: 채울 칸이 없다 ${selector}`);
    }
    await delay(step.wait ?? 250);
  }
  await delay(300);
  // 화면 글자 검사 — 예시 조직인지, 토큰·키 모양 문자열이 없는지(입력 칸 값 포함).
  const text = await evaluate<string>(
    cdp,
    "document.body.innerText+'\\n'+Array.prototype.map.call(document.querySelectorAll('input,textarea'),function(e){return e.value;}).join('\\n')",
  );
  if (text.includes('Chronostasis')) throw new Error(`${id} ${lang}/${theme}: 기본 데이터(Chronostasis)가 찍혔다 — 시나리오가 안 탔다`);
  if (!text.includes('Example Labs')) throw new Error(`${id} ${lang}/${theme}: 예시 조직(Example Labs)이 화면에 없다`);
  const bad = screenAddressProblems(text);
  if (bad.length > 0) throw new Error(`${id} ${lang}/${theme}: 예시가 아닌 @atmark.ai 주소가 화면에 있다 — ${bad.join(', ')}`);
  const leak = TOKEN_SHAPE.exec(text);
  if (leak !== null) throw new Error(`${id} ${lang}/${theme}: 토큰 모양 문자열이 화면에 있다 — ${leak[0].slice(0, 14)}…`);
  const rect = await clipRect(cdp, id, spec);
  const shot = await cdp.send<{ data: string }>('Page.captureScreenshot', {
    format: 'webp',
    quality: DOCS_SHOT_VIEW.quality,
    captureBeyondViewport: true,
    clip: { ...rect, scale: 1 },
  });
  return { bytes: Buffer.from(shot.data, 'base64'), width: Math.round(rect.width * DOCS_SHOT_VIEW.scale), height: Math.round(rect.height * DOCS_SHOT_VIEW.scale) };
}

/** 등록부의 `clip` → 문서 좌표의 사각형(CSS px, 정수). 요소가 없으면 멈춘다(마크업이 바뀌었으면 등록부를 고친다). */
async function clipRect(cdp: Cdp, id: string, spec: DocsShotSpec): Promise<{ x: number; y: number; width: number; height: number }> {
  const expr = `(function(){
    var pad=${String(DOCS_SHOT_VIEW.pad)},sx=window.scrollX,sy=window.scrollY;
    var el=document.querySelector(${JSON.stringify(spec.clip.selector)});if(!el)return null;
    var r=el.getBoundingClientRect(),bottom=r.bottom+sy+pad;
    var top=r.top,from=${JSON.stringify(spec.clip.from ?? null)};
    if(from){var fe=document.querySelector(from);if(!fe)return 'from';top=Math.min(top,fe.getBoundingClientRect().top);}
    var until=${JSON.stringify(spec.clip.until ?? null)};
    if(until){var u=document.querySelector(until);if(!u)return 'until';bottom=Math.min(bottom,u.getBoundingClientRect().top+sy-4);}
    var row=${JSON.stringify(spec.clip.untilRow ?? null)};
    if(row){var hit=Array.prototype.find.call(document.querySelectorAll(row.selector),function(e){return row.text.some(function(t){return e.textContent.indexOf(t)>=0;});});if(!hit)return 'row';bottom=Math.min(bottom,hit.getBoundingClientRect().top+sy);}
    var x=Math.max(0,Math.floor(r.left+sx-pad)),y=Math.max(0,Math.floor(top+sy-pad));
    var w=Math.min(document.documentElement.scrollWidth-x,Math.ceil(r.width+2*pad));
    return {x:x,y:y,width:w,height:Math.ceil(bottom-y)};
  })()`;
  const rect = await evaluate<{ x: number; y: number; width: number; height: number } | string | null>(cdp, expr);
  if (rect === null) throw new Error(`${id}: 자를 요소가 없다 ${spec.clip.selector}`);
  if (typeof rect === 'string') throw new Error(`${id}: 멈출 곳(${rect})을 찾지 못했다`);
  if (rect.width < 200 || rect.height < 80) throw new Error(`${id}: 자른 영역이 너무 작다 ${JSON.stringify(rect)}`);
  return rect;
}

/**
 * 화면에 찍힌 `…@atmark.ai` 주소 중 예시 이름이 아닌 것(보안 검토 F1). 예시 이름 = **예시 예약** 이름(`EXAMPLE_RESERVED_LOCAL_PARTS` —
 * scout·help-desk… 아무도 발급받을 수 없다). 그 밖의 이름은 누군가 가질 수 있는 주소이거나(광고가 남의 에이전트를 가리킨다) 실제 서비스
 * 주소(support·ops·billing·login 같은 예약된 이름 — 고객 에이전트처럼 찍히면 안 된다)라 막는다.
 */
export function screenAddressProblems(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/([a-z0-9][a-z0-9._-]*)@atmark\.ai/gi)) {
    const local = (m[1] ?? '').toLowerCase();
    if (!isExampleLocalPart(local)) out.push(m[0]);
  }
  return [...new Set(out)];
}

/** 문서·홈 스크린샷에 찍을 수 있는 예시 주소의 로컬 파트인가 — 예시 예약 목록 안(정확 일치). */
export function isExampleLocalPart(local: string): boolean {
  return (EXAMPLE_RESERVED_LOCAL_PARTS as readonly string[]).includes(local.toLowerCase());
}

export function imageHash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

export function renderShotData(images: Readonly<Record<string, DocsShotSet>>): string {
  const entry = (img: DocsShotImage): string =>
    `{ path: '${img.path}', width: ${String(img.width)}, height: ${String(img.height)}, hash: '${img.hash}', bytes: ${String(img.bytes)}, base64: '${img.base64}' }`;
  const ids = Object.keys(images).sort();
  return (
    '/**\n' +
    ' * 생성 파일 — 손으로 고치지 않는다. `pnpm gen:docs-shots`(`scripts/gen-docs-shots.ts`)가 실제 콘솔 화면(로컬 미리보기 + 가짜 API)을\n' +
    ' * 헤드리스 Chrome 으로 찍어 만든다. import 는 없다(값 파일). 등록부는 `src/docs/shots.ts`.\n' +
    ' */\n\n' +
    'export interface DocsShotImage {\n  readonly path: string;\n  readonly width: number;\n  readonly height: number;\n  readonly hash: string;\n  readonly bytes: number;\n  readonly base64: string;\n}\n\n' +
    "export type DocsShotSet = Readonly<Record<'ko' | 'en', Readonly<Record<'light' | 'dark', DocsShotImage>>>>;\n\n" +
    'export const DOCS_SHOT_IMAGES: Readonly<Record<string, DocsShotSet>> = {\n' +
    ids
      .map((id) => {
        const set = images[id];
        if (set === undefined) return '';
        const lang = (l: Lang): string => `    ${l}: {\n      light: ${entry(set[l].light)},\n      dark: ${entry(set[l].dark)},\n    },\n`;
        return `  ${JSON.stringify(id)}: {\n${lang('ko')}${lang('en')}  },\n`;
      })
      .join('') +
    '};\n'
  );
}

async function main(): Promise<void> {
  const onlyArg = process.argv.indexOf('--only');
  const only = onlyArg >= 0 ? new Set((process.argv[onlyArg + 1] ?? '').split(',').filter((s) => s !== '')) : null;
  const [consolePort, sitePort] = [await freePort(), await freePort()];
  const preview = await startPreview(consolePort, sitePort);
  let chrome: ChromeHandle | null = null;
  let cdp: Cdp | null = null;
  try {
    chrome = await launchChrome();
    const tab = (await (await fetch(`http://127.0.0.1:${String(chrome.port)}/json/new?about:blank`, { method: 'PUT' })).json()) as { webSocketDebuggerUrl: string };
    cdp = new Cdp();
    await cdp.connect(tab.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: FREEZE_CLOCK });

    const images: Record<string, DocsShotSet> = {};
    for (const [id, set] of Object.entries(DOCS_SHOT_IMAGES)) if (id in DOCS_SHOTS && (only === null || !only.has(id))) images[id] = set;
    for (const [id, spec] of Object.entries(DOCS_SHOTS) as [string, DocsShotSpec][]) {
      if (only !== null && !only.has(id)) continue;
      const out = { ko: {}, en: {} } as Record<Lang, Record<Theme, DocsShotImage>>;
      for (const lang of ['ko', 'en'] as const) {
        for (const theme of ['light', 'dark'] as const) {
          const c = await capture(cdp, consolePort, id, spec, lang, theme);
          const hash = imageHash(c.bytes);
          out[lang][theme] = { path: `/_img/${hash}/${id}-${lang}-${theme}.webp`, width: c.width, height: c.height, hash, bytes: c.bytes.length, base64: c.bytes.toString('base64') };
        }
      }
      images[id] = out;
      console.log(`✓ ${id.padEnd(18)} ${(['ko', 'en'] as const).map((l) => `${l} ${(out[l].light.bytes / 1024).toFixed(0)}/${(out[l].dark.bytes / 1024).toFixed(0)} KiB`).join(' · ')}`);
    }
    writeFileSync(SHOTS_OUT, renderShotData(images));
    console.log(`✓ 씀: ${SHOTS_OUT.slice(REPO_ROOT.length)} (${String(Object.keys(images).length)}장 × 4)`);
  } finally {
    cdp?.close();
    if (chrome !== null) killChrome(chrome);
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
