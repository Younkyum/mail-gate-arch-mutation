/**
 * 비색상 토큰(명세 `.omc/plans/vercel-redesign.md` §1.2) — 글꼴·반경·간격·그림자 재질·모션·층·치수. 콘솔(`src/admin/ui/styles.ts`)과
 * 홈(`src/site/styles.ts`)이 **이 한 문자열**을 각자의 인라인 `<style>` 에 넣는다 — 두 표면이 같은 재질·리듬을 갖게 하는 단일 원천.
 * 색 토큰 블록(첫 `:root{}` = 밝은 벌) **뒤에** 둔다 — 테마 테스트 파서가 첫 `:root{…}` 를 밝은 벌로 읽는다.
 * `--card-pad` — 모든 카드의 좌우 안쪽 여백 하나(24, ≤767 16 — 비평 2회전 R2-01). 카드 종류마다 20/24/16 으로 갈라져 한 화면에 글자 모서리가
 * 둘 생기던 것을 한 값으로 묶는다.
 * `--hatch-*` — Atmark 의 "위험·막힘" 서명인 빗금의 단일 원천(비평 R5-06). 면–면 두 단 채움(1.1:1 — 다크에서 사라짐) 대신 **바탕 + 1px 선**.
 * wide = 넓은 면(경고 배너·가격 Beta 칸·빠진 블록), pill = 배지, strong = 되돌릴 수 없는 버튼, raised = 떠 있는 면(대화상자 머리),
 * mode = 세그먼트 칸(`전부 X` — 바탕이 트랙이라 투명).
 */
export const BASE_TOKENS = `:root{
--font-sans:"Pretendard Variable","Pretendard",-apple-system,BlinkMacSystemFont,system-ui,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;
--font-mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
--radius-sm:6px;--radius-md:12px;--radius-lg:16px;--radius-full:9999px;
--space-1:4px;--space-2:8px;--space-3:12px;--space-4:16px;--space-5:20px;--space-6:24px;--space-8:32px;--space-10:40px;--space-12:48px;--space-16:64px;--space-20:80px;--space-24:96px;--space-32:128px;
--shadow-border:0 0 0 1px var(--gray-alpha-400);
--shadow-small:0 0 0 1px var(--gray-alpha-400),0 2px 2px var(--shadow-near);
--shadow-medium:0 0 0 1px var(--gray-alpha-400),0 2px 2px var(--shadow-near),0 8px 8px -8px var(--shadow-far);
--shadow-large:0 0 0 1px var(--gray-alpha-400),0 2px 2px var(--shadow-near),0 8px 16px -4px var(--shadow-far);
--shadow-menu:0 0 0 1px var(--gray-alpha-400),0 4px 8px -4px var(--shadow-near),0 16px 24px -8px var(--shadow-far);
--shadow-modal:0 0 0 1px var(--gray-alpha-400),0 1px 1px var(--shadow-near),0 8px 16px -4px var(--shadow-near),0 24px 32px -8px var(--shadow-far);
--ease-out:cubic-bezier(.23,1,.32,1);--ease-in-out:cubic-bezier(.65,0,.35,1);--dur-fast:150ms;--dur-base:200ms;
--z-sticky:10;--z-header:30;--z-sidebar:40;--z-popover:50;--z-toast:60;
--header-h:56px;--side-w:240px;--side-rail:56px;
--card-pad:24px;
--hatch-wide:repeating-linear-gradient(-45deg,var(--background-100) 0 7px,var(--gray-400) 7px 8px);
--hatch-pill:repeating-linear-gradient(-45deg,var(--background-100) 0 3px,var(--gray-500) 3px 4px);
--hatch-strong:repeating-linear-gradient(-45deg,var(--background-100) 0 5px,var(--gray-500) 5px 6px);
--hatch-raised:repeating-linear-gradient(-45deg,var(--background-raised) 0 7px,var(--gray-500) 7px 8px);
--hatch-mode:repeating-linear-gradient(-45deg,transparent 0 5px,var(--gray-500) 5px 6px);
}
@media (max-width:767px){:root{--card-pad:16px}}`;
