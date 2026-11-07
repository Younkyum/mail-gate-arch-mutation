/**
 * src/api/pdf-text-worker.ts — **워커 스레드 안에서만** 도는 PDF 텍스트 추출. 부르는 쪽은 `attachment-content.ts` 의 `extractPdfText`.
 *
 * ---------------------------------------------------------------------------
 * ## 판단 기록
 * ---------------------------------------------------------------------------
 *
 * **① 왜 별도 스레드인가.** PDF 는 외부인이 만든 바이트다. 60KB 짜리 압축 PDF 가 20MB 의 `BT (AAAA…) Tj ET` 로 풀리면 같은 스레드의
 *   해석기는 텍스트 조각 42만 개 · RSS 362MB 를 만든다(179KB → 783MB). API 함수는 1024MB 이고 모든 테넌트가 동시 실행 8 칸을 나눠
 *   쓴다 — 한 통이 함수를 죽이거나 멈추게 하면 안 된다. 여기서 도는 코드는 부모가 건 **힙 상한**(`resourceLimits`) · **벽시계 상한**
 *   (`terminate()`) · **RSS 감시** 아래에 있다. 넘으면 이 스레드만 죽고 부모는 정상 결과를 만든다. 협조적 경주(`Promise.race`)는
 *   동기 구간을 끊지 못하고 버려진 약속이 파기 뒤에 거부되었다 — 그래서 쓰지 않는다.
 *
 * **② 스트림으로 읽고 상한에서 멈춘다.** 쪽마다 `streamTextContent()` 의 reader 로 조각을 받다가 글자 상한을 넘는 순간 `cancel()` 한다
 *   — 해석기는 내용 스트림을 필요한 만큼만 풀므로 폭탄의 나머지는 풀리지도 않는다. 쪽 수 상한도 여기서 건다.
 *
 * **③ 실행·바깥 접근 0.** 공식 `pdfjs-dist` 의 legacy 빌드(정확한 판 고정 — GHSA-hq66-cqwq-w95j 패치판 6.2.108 이상)를 직접 싣는다.
 *   예전에는 `unpdf` 가 번들한 서버리스 판(6.1.200 — 취약)을 썼는데 unpdf 에 새 판이 없어 걷어냈다. 해석기 코어(`pdf.worker.mjs`)는
 *   `globalThis.pdfjsWorker` 로 같은 스레드에 붙인다(가짜 워커 — 파일·URL 로 따로 불러오지 않으니 번들에 정적으로 들어간다).
 *   이 판에는 eval/`new Function` 경로가 아예 없다(`isEvalSupported` 는 옛 이름 — 그래도 끈다고 적어 둔다; 번들 테스트가 0 을 단언).
 *   시스템 글꼴·글꼴 면·WASM·워커 fetch·XFA 끔. 렌더링을 하지 않으니 `@napi-rs/canvas`(네이티브)는 설치도 하지 않는다(package.json
 *   `pnpm.ignoredOptionalDependencies`) — 해석기가 불러오면서 내는 "canvas·DOMMatrix·Path2D 없음" 경고 세 줄은 불러오는 동안만 삼킨다. CMap 은 번들 안의 한국어
 *   데이터(`pdf-korean-cmaps.json`, `scripts/gen-pdf-cmaps.ts`)로만 답한다 — 네트워크·파일 읽기 0. 나머지 CMap(일본어·중국어 등)과
 *   표준 글꼴 데이터는 없다고 답한다(해석기는 경고만 하고 계속한다).
 *
 * **④ 부모에게는 우리가 정한 모양만.** 예외 문장은 입력 조각을 담을 수 있다 — `fail` 은 사유 코드뿐이다.
 *
 * 이 파일은 두 모양으로 돈다: λ 번들(`scripts/build-lambda.ts` 가 api 번들 옆 `pdf-text-worker.js` 로 따로 묶는다)과 원본 `.ts`
 * (테스트 — Node 가 타입만 지우고 바로 돈다). 그래서 **지울 수 있는 타입 문법만** 쓰고, import 는 node 내장 · `pdfjs-dist` · JSON 뿐이다.
 */

import { parentPort, workerData } from 'node:worker_threads';

import type { DocumentInitParameters } from 'pdfjs-dist/types/src/display/api';

import KOREAN_CMAPS from './pdf-korean-cmaps.json' with { type: 'json' };

export interface PdfWorkerInput {
  readonly bytes: Uint8Array;
  readonly maxPages: number;
  /** 뽑을 글자 수 상한 — 넘으면 그 쪽에서 멈춘다(부모가 정확히 자른다). */
  readonly maxChars: number;
}

/** 워커 → 부모. `open` 한 번 → `page` 여러 번 → `end` 또는 `fail` 한 번. */
export type PdfWorkerMessage =
  | { readonly type: 'open'; readonly pages: number }
  | { readonly type: 'page'; readonly text: string }
  | { readonly type: 'end'; readonly stoppedAtCharLimit: boolean }
  | { readonly type: 'fail'; readonly reason: 'encrypted_pdf' | 'unreadable_pdf' };

const CMAP_TABLE: Readonly<Record<string, string>> = KOREAN_CMAPS.cmaps;

/**
 * 해석기의 바이너리 데이터 공급자 자리(`BinaryDataFactory`). CMap 만, 번들 안의 표에서만 답한다(③).
 * 생성자 인자(URL 들)는 쓰지 않는다 — 아무 데도 가지 않는다.
 */
class InlineCMapFactory {
  async fetch({ kind, filename }: { readonly kind: string; readonly filename: string }): Promise<Uint8Array> {
    const name = filename.endsWith('.bcmap') ? filename.slice(0, -'.bcmap'.length) : filename;
    const data = kind === 'cMapUrl' && Object.hasOwn(CMAP_TABLE, name) ? CMAP_TABLE[name] : undefined;
    if (data === undefined) throw new Error('데이터 없음');
    return new Uint8Array(Buffer.from(data, 'base64'));
  }
}

interface TextItemLike {
  readonly str?: unknown;
  readonly hasEOL?: unknown;
}

function post(message: PdfWorkerMessage): void {
  parentPort?.postMessage(message);
}

/** 해석기를 불러온다(③). 코어를 먼저 `pdfjsWorker` 로 붙여야 `getDocument` 가 같은 스레드의 가짜 워커로 돈다. */
async function loadPdfjs(): Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> {
  // @ts-expect-error — pdfjs-dist 는 워커 모듈의 타입 선언을 싣지 않는다(값은 `WorkerMessageHandler` 하나만 쓴다).
  const core: unknown = await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
  (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = core;
  const warn = console.warn;
  console.warn = () => undefined; // 렌더링용 전역이 없다는 모듈 최상위 경고(③) — 텍스트 추출과 무관하다
  try {
    return await import('pdfjs-dist/legacy/build/pdf.mjs');
  } finally {
    console.warn = warn;
  }
}

async function extract(input: PdfWorkerInput): Promise<void> {
  const { getDocument } = await loadPdfjs();
  // 옵션 이름을 해석기 타입으로 검사한다 — 이름이 바뀌면 조용히 기본값(파일·네트워크 읽기)으로 돌아가는 대신 타입 검사가 빨개진다.
  const params: DocumentInitParameters & { readonly isEvalSupported?: boolean } = {
    data: input.bytes,
    useSystemFonts: false,
    disableFontFace: true,
    useWasm: false,
    useWorkerFetch: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    enableXfa: false,
    isEvalSupported: false, // 옛 이름 — 타입에는 없어 교차 타입으로만 허용
    stopAtErrors: false,
    verbosity: 0,
    // CMap 은 번들 안 표에서만(③). URL 은 해석기가 "CMap 을 쓸 수 있다" 고 보게 하는 표지일 뿐 — 공급자가 쓰지 않는다.
    cMapUrl: 'inline-cmaps/',
    cMapPacked: true,
    BinaryDataFactory: InlineCMapFactory,
  };
  const task = getDocument(params);

  let pdf: Awaited<typeof task.promise>;
  try {
    pdf = await task.promise;
  } catch (error) {
    post({ type: 'fail', reason: error instanceof Error && error.name === 'PasswordException' ? 'encrypted_pdf' : 'unreadable_pdf' });
    return;
  }
  const pages = pdf.numPages;
  post({ type: 'open', pages });

  let length = 0;
  try {
    for (let number = 1; number <= Math.min(pages, input.maxPages); number += 1) {
      const page = await pdf.getPage(number);
      const reader = page.streamTextContent().getReader();
      let text = '';
      let stopped = false;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        for (const item of chunk.value.items as readonly TextItemLike[]) {
          text += (typeof item.str === 'string' ? item.str : '') + (item.hasEOL === true ? '\n' : '');
          if (length + text.length > input.maxChars) {
            stopped = true;
            break;
          }
        }
        if (stopped) {
          // 해석기는 이유 없는 취소를 거부한다. 취소가 실패해도 결과는 같다(곧 부모가 스레드째 끊는다).
          await reader.cancel(new Error('글자 상한')).catch(() => undefined);
          break;
        }
      }
      post({ type: 'page', text });
      length += text.length + 2; // 쪽 사이 빈 줄(부모가 '\n\n' 으로 잇는다)
      if (stopped) {
        post({ type: 'end', stoppedAtCharLimit: true });
        return;
      }
      page.cleanup();
    }
  } catch {
    // 쪽 도중의 오류 — 부모는 읽은 쪽이 있으면 부분 결과(잘림)로, 없으면 unreadable_pdf 로 만든다.
    post({ type: 'fail', reason: 'unreadable_pdf' });
    return;
  }
  post({ type: 'end', stoppedAtCharLimit: false });
}

if (parentPort !== null) {
  // 끝나면 부모가 `terminate()` 한다 — 해석기 정리(`destroy`)를 기다릴 이유가 없다(스레드째 사라진다).
  extract(workerData as PdfWorkerInput).catch(() => post({ type: 'fail', reason: 'unreadable_pdf' }));
}
