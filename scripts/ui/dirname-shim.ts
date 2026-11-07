/**
 * scripts/ui/dirname-shim.ts — `test/unit/admin/console-harness.ts` 는 vitest 아래서만 돈다고 가정하고 맨 위에서
 * `__dirname` 을 한 번 쓴다(`UI_DIR = join(__dirname, …)` — `uiSources()` 를 부를 때만 실제로 쓰이는 값이고, 이 미리보기
 * 서버는 그 함수를 부르지 않는다). 순수 ESM(`tsx`) 에는 그 전역이 없어 **모듈을 불러오는 것만으로** 던진다.
 *
 * 값 자체는 안 쓰므로 아무 문자열이면 된다 — 다만 하네스를 import 하기 **전에** 이 부작용이 돌아야 한다. 정적 import 는
 * 선언 순서대로 평가되므로(`fake-api.ts` 에서 이 파일을 하네스보다 먼저 import 한다), 순서만 지키면 된다.
 */
if (typeof (globalThis as Record<string, unknown>)['__dirname'] === 'undefined') {
  (globalThis as Record<string, unknown>)['__dirname'] = process.cwd();
}
export {};
