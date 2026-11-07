/**
 * `pnpm ui:shots` — `targets.ts` 의 화면을 시스템 Chrome 헤드리스로 열어 전체 페이지 PNG 로 찍는다. 새 npm 의존성 없이
 * Node 22 의 전역 `WebSocket` 으로 Chrome DevTools 프로토콜(CDP)을 직접 말한다(퍼펫티어 없음).
 *
 * 흐름: `preview.ts` 서버(콘솔 4173·사이트 4174) 가 이미 떠 있으면 그대로 쓰고, 아니면 이 스크립트가 자식 프로세스로 띄운다 →
 * 격리된 `--user-data-dir` 로 Chrome 을 헤드리스로 띄운다(빈 포트 하나를 골라 `--remote-debugging-port`) → 탭 하나를 열어
 * 재사용한다(대상마다 새로 만들지 않는다 — 빠르고, `Page.addScriptToEvaluateOnNewDocument` 로 심은 CSP 위반 리스너가
 * 새 문서마다 다시 돈다) → 대상 × 너비 × 테마 × 언어 조합마다 에뮬레이션을 맞추고 이동 → 스텝 실행 → 전체 페이지 스크린샷 →
 * 콘솔·예외·CSP 위반·실패한 네트워크 요청·가로 스크롤 여부를 모아 `report.json`·`report.md` 로 쓴다.
 *
 * 끝나면(성공·실패·Ctrl-C 모두) Chrome 과 (이 스크립트가 띄웠다면) 미리보기 서버를 반드시 끈다.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Cdp, CONSOLE_PORT, delay, ensurePreviewServer, killChrome, launchChrome, REPO_ROOT, SITE_PORT, type ChromeHandle } from './browser';
import { ALL_THEMES, ALL_WIDTHS, TARGETS, WIDTHS, type LangName, type Step, type Target, type ThemeName, type WidthName } from './targets';


// ---------- CLI 인자 ----------

interface Args {
  readonly out: string;
  readonly only: string | null;
  readonly widths: readonly WidthName[];
  readonly themes: readonly ThemeName[];
  readonly langs: readonly LangName[];
}

function parseArgs(argv: readonly string[]): Args {
  const get = (name: string): string | null => {
    const flag = `--${name}`;
    const index = argv.indexOf(flag);
    if (index < 0) return null;
    return argv[index + 1] ?? null;
  };
  const list = <T extends string>(name: string, all: readonly T[]): readonly T[] => {
    const raw = get(name);
    if (raw === null) return all;
    return raw.split(',').map((s) => s.trim()) as T[];
  };
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return {
    out: get('out') ?? join(REPO_ROOT, '.omc', 'shots', timestamp),
    only: get('only'),
    widths: list('widths', ALL_WIDTHS),
    themes: list('themes', ALL_THEMES),
    langs: list('langs', ['ko']),
  };
}

// ---------- CSP 위반 리스너(새 문서마다 다시 심긴다) ----------

const CSP_LISTENER_SOURCE = `
window.__atmarkCsp = [];
document.addEventListener('securitypolicyviolation', function (e) {
  window.__atmarkCsp.push({ directive: e.violatedDirective, blockedURI: e.blockedURI, sourceFile: e.sourceFile, lineNumber: e.lineNumber });
});
`;

// ---------- 한 번 찍기 ----------

interface Collectors {
  consoleErrors: { level: string; text: string }[];
  exceptions: { text: string; url: string; line: number }[];
  cspFromLog: { text: string }[];
  networkFailures: { url: string; errorText: string }[];
  httpErrors: { url: string; status: number }[];
}

function freshCollectors(): Collectors {
  return { consoleErrors: [], exceptions: [], cspFromLog: [], networkFailures: [], httpErrors: [] };
}

function argText(arg: Record<string, unknown> | undefined): string {
  if (arg === undefined) return '';
  if ('value' in arg) return String(arg['value']);
  if ('description' in arg) return String(arg['description']);
  return '';
}

async function runStep(cdp: Cdp, step: Step): Promise<void> {
  if (step.click !== undefined) {
    await cdp.send('Runtime.evaluate', {
      expression: `(function(){var el=Array.prototype.find.call(document.querySelectorAll(${JSON.stringify(step.click)}),function(n){return n.getClientRects().length>0;});if(el){el.scrollIntoView({block:'center'});el.click();return true;}return false;})()`,
      returnByValue: true,
    });
    await delay(step.waitAfter ?? 250);
  } else if (step.select !== undefined) {
    // <select> 의 값을 고르고 change 를 낸다(헤드리스에는 열린 목록이 없어 클릭으로 고를 수 없다).
    const [selector, value] = step.select;
    await cdp.send('Runtime.evaluate', {
      expression: `(function(){var el=document.querySelector(${JSON.stringify(selector)});if(!el)return false;el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`,
      returnByValue: true,
    });
    await delay(step.waitAfter ?? 200);
  } else if (step.key !== undefined) {
    // 형식: "Tab" · "Shift+Tab" · "Tab*5"(5번) · "Escape" · "Enter" · "Space" · "ArrowDown". 가상 키코드를 같이 보내야 브라우저가
    // 기본 동작(포커스 이동·버튼 누름)을 한다 — 코드 0 이면 Tab 이 포커스를 옮기지 않는다.
    const [combo = '', times = '1'] = step.key.split('*');
    const parts = combo.split('+');
    const name = parts.pop() ?? '';
    const shift = parts.includes('Shift');
    const KEYS: Record<string, { code: string; vk: number; text?: string }> = {
      Tab: { code: 'Tab', vk: 9 },
      Escape: { code: 'Escape', vk: 27 },
      Enter: { code: 'Enter', vk: 13, text: '\r' },
      Space: { code: 'Space', vk: 32, text: ' ' },
      ArrowDown: { code: 'ArrowDown', vk: 40 },
      ArrowUp: { code: 'ArrowUp', vk: 38 },
      ArrowLeft: { code: 'ArrowLeft', vk: 37 },
      ArrowRight: { code: 'ArrowRight', vk: 39 },
    };
    const k = KEYS[name] ?? { code: name, vk: 0 };
    const key = name === 'Space' ? ' ' : name;
    const common = { key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers: shift ? 8 : 0 };
    for (let i = 0; i < Math.max(1, Number(times) || 1); i += 1) {
      await cdp.send('Input.dispatchKeyEvent', { type: k.text === undefined ? 'rawKeyDown' : 'keyDown', ...common, ...(k.text === undefined ? {} : { text: k.text }) });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
      await delay(60);
    }
    await delay(step.waitAfter ?? 150);
  } else if (step.type !== undefined) {
    await cdp.send('Input.insertText', { text: step.type });
    await delay(step.waitAfter ?? 150);
  } else if (step.wait !== undefined) {
    await delay(step.wait);
  }
}

function targetUrl(target: Target, lang: LangName): string {
  if (target.kind === 'site') return `http://127.0.0.1:${String(SITE_PORT)}${target.path}`;
  const [base, hash] = target.path.split('#');
  const sep = (base ?? '').includes('?') ? '&' : '?';
  const withLang = `${base ?? ''}${sep}lang=${lang}`;
  return `http://127.0.0.1:${String(CONSOLE_PORT)}${withLang}${hash !== undefined ? `#${hash}` : ''}`;
}

interface ShotResult {
  readonly id: string;
  readonly target: string;
  readonly kind: 'console' | 'site';
  readonly url: string;
  readonly width: WidthName;
  readonly theme: ThemeName;
  readonly lang: LangName;
  readonly file: string;
  readonly overflow: boolean;
  readonly consoleErrors: Collectors['consoleErrors'];
  readonly exceptions: Collectors['exceptions'];
  readonly cspViolations: unknown[];
  readonly networkFailures: Collectors['networkFailures'];
  readonly httpErrors: Collectors['httpErrors'];
}

async function captureOne(cdp: Cdp, collectors: Collectors, run: { target: Target; width: WidthName; theme: ThemeName; lang: LangName }, outDir: string): Promise<ShotResult> {
  collectors.consoleErrors.length = 0;
  collectors.exceptions.length = 0;
  collectors.cspFromLog.length = 0;
  collectors.networkFailures.length = 0;
  collectors.httpErrors.length = 0;

  const spec = WIDTHS[run.width];
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: spec.width, height: spec.height, deviceScaleFactor: 1, mobile: spec.mobile });
  // 켜고 끄기를 매번 명시한다 — 모바일 샷의 터치(pointer:coarse)가 뒤의 데스크톱 샷에 남지 않게.
  await cdp.send('Emulation.setTouchEmulationEnabled', spec.mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: run.theme }] });

  const url = targetUrl(run.target, run.lang);
  // 해시만 다른 URL 로 바로 가면 같은 문서 안의 이동이라 앞 대상의 열린 대화상자·서랍·메뉴가 남는다 — 매번 빈 문서를 거쳐 새로 싣는다.
  await cdp.send('Page.navigate', { url: 'about:blank' });
  await delay(100);
  const loaded = new Promise<void>((resolve) => {
    const handler = (): void => {
      resolve();
    };
    cdp.on('Page.loadEventFired', handler);
  });
  await cdp.send('Page.navigate', { url });
  await Promise.race([loaded, delay(8000)]);
  await delay(500);

  for (const step of run.target.steps ?? []) await runStep(cdp, step);
  await delay(150);

  const overflowResult = await cdp.send<{ result: { value: boolean } }>('Runtime.evaluate', {
    expression: '!!(document.scrollingElement && document.scrollingElement.scrollWidth > window.innerWidth + 1)',
    returnByValue: true,
  });
  const overflow = overflowResult.result.value === true;

  const cspResult = await cdp.send<{ result: { value: unknown[] } }>('Runtime.evaluate', {
    expression: 'window.__atmarkCsp || []',
    returnByValue: true,
  });
  const cspViolations = [...(cspResult.result.value ?? []), ...collectors.cspFromLog];

  const metrics = await cdp.send<{ cssContentSize: { width: number; height: number } }>('Page.getLayoutMetrics');
  const { width, height } = metrics.cssContentSize;
  const shot = await cdp.send<{ data: string }>('Page.captureScreenshot', {
    format: 'png',
    clip: { x: 0, y: 0, width, height, scale: 1 },
    captureBeyondViewport: true,
  });

  const file = `${run.target.id}.${run.width}.${run.theme}.${run.lang}.png`;
  writeFileSync(join(outDir, file), Buffer.from(shot.data, 'base64'));

  return {
    id: `${run.target.id}.${run.width}.${run.theme}.${run.lang}`,
    target: run.target.id,
    kind: run.target.kind,
    url,
    width: run.width,
    theme: run.theme,
    lang: run.lang,
    file,
    overflow,
    consoleErrors: [...collectors.consoleErrors],
    exceptions: [...collectors.exceptions],
    cspViolations,
    networkFailures: [...collectors.networkFailures],
    httpErrors: [...collectors.httpErrors],
  };
}

// ---------- 리포트 ----------

function writeReport(outDir: string, results: readonly ShotResult[]): void {
  writeFileSync(join(outDir, 'report.json'), JSON.stringify({ generatedAt: new Date().toISOString(), count: results.length, shots: results }, null, 2));

  const issues = results.filter((r) => r.overflow || r.consoleErrors.length > 0 || r.exceptions.length > 0 || r.cspViolations.length > 0 || r.networkFailures.length > 0);
  const lines: string[] = [
    `# UI 스크린샷 리포트`,
    ``,
    `- 찍은 수: ${String(results.length)}`,
    `- 문제 있는 샷: ${String(issues.length)}`,
    ``,
  ];
  if (issues.length === 0) {
    lines.push('문제 없음 — 콘솔 오류 · JS 예외 · CSP 위반 · 실패한 네트워크 요청 · 가로 스크롤 전부 0.');
  } else {
    lines.push('## 문제 있는 샷', '');
    for (const r of issues) {
      lines.push(`### ${r.id}`, '', `- 파일: \`${r.file}\``, `- URL: ${r.url}`);
      if (r.overflow) lines.push('- 가로 스크롤 있음');
      if (r.consoleErrors.length > 0) lines.push(`- 콘솔 오류/경고 ${String(r.consoleErrors.length)}건: ${r.consoleErrors.map((e) => e.text).join(' | ').slice(0, 300)}`);
      if (r.exceptions.length > 0) lines.push(`- JS 예외 ${String(r.exceptions.length)}건: ${r.exceptions.map((e) => e.text).join(' | ').slice(0, 300)}`);
      if (r.cspViolations.length > 0) lines.push(`- CSP 위반 ${String(r.cspViolations.length)}건`);
      if (r.networkFailures.length > 0) lines.push(`- 실패한 네트워크 요청 ${String(r.networkFailures.length)}건: ${r.networkFailures.map((n) => n.url).join(' | ').slice(0, 300)}`);
      lines.push('');
    }
  }
  writeFileSync(join(outDir, 'report.md'), lines.join('\n'));
}

// ---------- 메인 ----------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.out, { recursive: true });

  const preview = await ensurePreviewServer();
  let chrome: ChromeHandle | null = null;
  let cdp: Cdp | null = null;
  // 정리는 한 곳에서 한 번 — 정상 종료(finally)와 신호(SIGINT·SIGTERM) 모두 이 함수를 부른다.
  setCleanup(() => {
    cdp?.close();
    if (chrome !== null) killChrome(chrome);
    if (preview.proc !== null) preview.proc.kill('SIGTERM');
  });

  try {
    chrome = await launchChrome();
    const versionRes = await fetch(`http://127.0.0.1:${String(chrome.port)}/json/version`);
    const version = (await versionRes.json()) as { webSocketDebuggerUrl: string };
    const newTabRes = await fetch(`http://127.0.0.1:${String(chrome.port)}/json/new?about:blank`, { method: 'PUT' });
    const tab = (await newTabRes.json()) as { id: string; webSocketDebuggerUrl?: string };
    const wsUrl = tab.webSocketDebuggerUrl ?? version.webSocketDebuggerUrl;

    cdp = new Cdp();
    await cdp.connect(wsUrl);

    const collectors = freshCollectors();
    cdp.on('Runtime.consoleAPICalled', (params) => {
      const type = String(params['type'] ?? '');
      if (type !== 'error' && type !== 'warning') return;
      const args = (params['args'] as Record<string, unknown>[] | undefined) ?? [];
      collectors.consoleErrors.push({ level: type, text: args.map(argText).join(' ').slice(0, 500) });
    });
    cdp.on('Runtime.exceptionThrown', (params) => {
      const details = params['exceptionDetails'] as Record<string, unknown> | undefined;
      if (details === undefined) return;
      collectors.exceptions.push({
        text: String((details['exception'] as Record<string, unknown> | undefined)?.['description'] ?? details['text'] ?? ''),
        url: String(details['url'] ?? ''),
        line: Number(details['lineNumber'] ?? 0),
      });
    });
    cdp.on('Log.entryAdded', (params) => {
      const entry = params['entry'] as Record<string, unknown> | undefined;
      if (entry === undefined || entry['source'] !== 'security') return;
      collectors.cspFromLog.push({ text: String(entry['text'] ?? '') });
    });
    cdp.on('Network.loadingFailed', (params) => {
      collectors.networkFailures.push({ url: String(params['requestId'] ?? ''), errorText: String(params['errorText'] ?? '') });
    });
    cdp.on('Network.responseReceived', (params) => {
      const response = params['response'] as Record<string, unknown> | undefined;
      const status = Number(response?.['status'] ?? 0);
      if (status >= 400) collectors.httpErrors.push({ url: String(response?.['url'] ?? ''), status });
    });

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: CSP_LISTENER_SOURCE });

    const targets = TARGETS.filter((t) => args.only === null || args.only.split(',').some((part) => part !== '' && t.id.includes(part)));
    const results: ShotResult[] = [];
    for (const target of targets) {
      const widths = target.widths ?? args.widths;
      const langs = target.kind === 'site' ? [target.lang ?? 'ko'] : args.langs;
      for (const width of widths) {
        for (const theme of args.themes) {
          for (const lang of langs) {
            const label = `${target.id} · ${width} · ${theme} · ${lang}`;
            try {
              const result = await captureOne(cdp, collectors, { target, width, theme, lang }, args.out);
              results.push(result);
              const flags = [result.overflow ? 'overflow' : null, result.consoleErrors.length ? 'console' : null, result.exceptions.length ? 'exceptions' : null, result.cspViolations.length ? 'csp' : null]
                .filter((x): x is string => x !== null)
                .join(',');
              console.log(`[ui:shots] ${label}${flags ? ` ⚠ ${flags}` : ''}`);
            } catch (error) {
              console.error(`[ui:shots] 실패 ${label}:`, error instanceof Error ? error.message : error);
            }
          }
        }
      }
    }

    writeReport(args.out, results);
    console.log(`[ui:shots] ${String(results.length)}개 저장 → ${args.out}`);
  } finally {
    runCleanup();
  }
}

let cleanup: (() => void) | null = null;
function setCleanup(fn: () => void): void {
  cleanup = fn;
}
/** 정리 함수를 한 번만 부른다(신호와 finally 가 겹쳐도). */
function runCleanup(): void {
  const fn = cleanup;
  cleanup = null;
  try {
    fn?.();
  } catch (error) {
    console.error('[ui:shots] 정리 실패:', error instanceof Error ? error.message : error);
  }
}

let cleaningUp = false;
function installSignalHandlers(): void {
  const onSignal = (): void => {
    if (cleaningUp) return;
    cleaningUp = true;
    console.log('\n[ui:shots] 중단 — 정리 중…');
    // 신호로 끝낼 때도 Chrome·미리보기 서버·임시 프로필을 치운다(예전에는 곧장 exit 해 헤드리스 Chrome 이 남았다).
    runCleanup();
    process.exit(130);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
}

installSignalHandlers();
void main();
