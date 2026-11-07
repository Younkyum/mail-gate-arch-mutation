/**
 * src/ui/brand.ts — Atmark 로고의 **단일 원천**(로고 05 "Continuity", 진윤겸 2026-09-30). 홈(`atmark.ai`)·결제·콘솔·문서·운영 콘솔·OG 이미지·
 * 파비콘이 모두 이 파일의 도형을 쓴다 — 표면마다 로고를 따로 그리지 않는다(`test/unit/ui/brand.test.ts` 가 표면마다 확인한다).
 *
 * 도형(256×256 격자, 중심 (128,128)) — 원본 SVG(`05-continuity-symbol.svg`)의 경로를 **글자 그대로** 옮겼다:
 *   - 바깥 3/4 고리 r72–104, 안쪽 3/4 고리 r12–40 — 둘 다 **오른쪽 위 사분면**(x>128 · y<128)이 비었다.
 *   - 그 빈 자리의 L 자 모서리 괄호 `M160 24H232V96H200V56H160Z` = 직사각형 [160,232]×[24,56] ∪ [200,232]×[24,96].
 * 가로 조합(lockup, `05-continuity-horizontal.svg` 1080×256)은 심볼 + 도형으로 그린 소문자 "atmark" 워드마크다(글꼴이 아니다 — 페이지 글꼴과
 * 무관하게 같은 모양).
 *
 * 색은 `currentColor` 하나 — 부모의 글자색을 따른다(밝은·어두운 테마, 사진 히어로 위 머리). 브랜드는 완전 무채색이다(주황·파랑 없음).
 * viewBox 는 원본 캔버스에서 **여백만 잘라** 도형에 딱 맞춘다(심볼 `24 24 208 208`, 조합 `32 24 1024 208`) — 경로 좌표는 그대로라 도형은
 * 같고, 높이로 크기를 정하면 심볼의 위아래 끝이 곧 상자 끝이라 옆 글자와 가운데 맞추기 쉽다.
 */

/** 심볼의 두 경로(원본 그대로). `rings` 는 evenodd — 고리 둘. */
export const BRAND_SYMBOL_PATHS = {
  rings: 'M128 24A104 104 0 1 0 232 128H200A72 72 0 1 1 128 56ZM128 88A40 40 0 1 0 168 128H140A12 12 0 1 1 128 116Z',
  bracket: 'M160 24H232V96H200V56H160Z',
} as const;

/**
 * 심볼 도형의 수치 — 파비콘 래스터(`src/ui/favicon.ts`)가 점-도형 판정에 쓴다. 위 경로와 같은 값이다(`brand.test.ts` 가 경로 문자열에서
 * 다시 읽어 맞춰 본다).
 */
export const BRAND_SYMBOL_GEOMETRY = {
  center: 128,
  outer: [72, 104],
  inner: [12, 40],
  /** L 자 괄호 = 직사각형 둘의 합 — [x0, y0, x1, y1]. */
  bracket: [
    [160, 24, 232, 56],
    [200, 24, 232, 96],
  ],
} as const;

/**
 * 점 (x, y)(256 격자)가 심볼 안인가 — 두 고리 띠(오른쪽 위 사분면 제외) 또는 L 자 괄호. 경계는 안으로 친다.
 * 사분면 판정의 경계선은 고리 경로의 끝(위 `128 24`·`128 88` → 세로선 x=128, 오른쪽 `232 128`·`168 128` → 가로선 y=128)과 같다.
 */
export function inBrandSymbol(x: number, y: number): boolean {
  const { center, outer, inner, bracket } = BRAND_SYMBOL_GEOMETRY;
  for (const [x0, y0, x1, y1] of bracket) if (x >= x0 && x <= x1 && y >= y0 && y <= y1) return true;
  if (x > center && y < center) return false; // 오른쪽 위 사분면 — 고리가 열린 자리
  const d = Math.hypot(x - center, y - center);
  return (d >= outer[0] && d <= outer[1]) || (d >= inner[0] && d <= inner[1]);
}

/** 심볼의 도형 상자(256 격자) — 여백을 뺀 딱 맞는 viewBox. */
export const BRAND_SYMBOL_VIEWBOX = '24 24 208 208';

/** 워드마크 "atmark" 의 여섯 글자(원본 그대로 — 글자마다 evenodd 경로 + 자리 옮김). */
const WORDMARK_LETTERS: readonly (readonly [string, number])[] = [
  ['M50 0C20 0 0 20 0 50S20 100 50 100C64 100 76 94 82 86V100H102V0H82V14C76 6 64 0 50 0ZM50 20C69 20 82 33 82 50S69 80 50 80S20 67 20 50S31 20 50 20Z', 0],
  ['M20 -30H40V0H72V20H40V65Q40 80 56 80H72V100H53Q20 100 20 68V20H0V0H20Z', 118],
  ['M0 0H20V12Q31 0 49 0Q70 0 81 18Q93 0 115 0Q150 0 150 40V100H130V43Q130 20 113 20Q91 20 91 46V100H71V43Q71 20 50 20Q20 20 20 46V100H0Z', 207],
  ['M50 0C20 0 0 20 0 50S20 100 50 100C64 100 76 94 82 86V100H102V0H82V14C76 6 64 0 50 0ZM50 20C69 20 82 33 82 50S69 80 50 80S20 67 20 50S31 20 50 20Z', 376],
  ['M0 0H20V17Q32 0 54 0H68V21H54Q20 21 20 58V100H0Z', 495],
  ['M0 -38H20V44L64 0H92L46 46L100 100H72L20 48V100H0Z', 583],
];

/** 가로 조합의 도형 상자 — 심볼(x 32–240 · y 24–232) + 워드마크(x 304–1055.3 · y 57.2–209). 폭:높이 = 1024:208. */
export const BRAND_LOCKUP_VIEWBOX = '32 24 1024 208';

/** 폭 ÷ 높이. 높이로 크기를 정할 때 폭 계산에 쓴다. */
export const BRAND_SYMBOL_RATIO = 1;
export const BRAND_LOCKUP_RATIO = 1024 / 208;

const SYMBOL_BODY =
  `<path fill-rule="evenodd" d="${BRAND_SYMBOL_PATHS.rings}"/>` + `<path d="${BRAND_SYMBOL_PATHS.bracket}"/>`;

const WORDMARK_BODY =
  '<g transform="translate(304 99) scale(1.1)">' +
  WORDMARK_LETTERS.map(([d, dx]) => `<path fill-rule="evenodd" d="${d}"${dx === 0 ? '' : ` transform="translate(${String(dx)} 0)"`}/>`).join('') +
  '</g>';

export interface BrandSvgOptions {
  /** `class` 속성(표면의 스타일시트가 높이를 준다). */
  readonly className?: string;
  /** 기본 높이(px) — `width`·`height` 속성으로 싣는다(스타일이 없어도 제 비율로 선다). 스타일시트의 높이가 이긴다. */
  readonly height?: number;
  /**
   * 참이면 장식(`aria-hidden`) — 바로 옆에 같은 이름이 글자로 있거나, 감싼 링크가 자기 이름을 가질 때. 기본은 이름 있는 그림
   * (`role="img"` · `aria-label="Atmark"` · `<title>`).
   */
  readonly decorative?: boolean;
}

function svg(viewBox: string, ratio: number, body: string, options: BrandSvgOptions): string {
  const cls = options.className === undefined ? '' : ` class="${options.className}"`;
  const size =
    options.height === undefined ? '' : ` width="${String(Math.round(options.height * ratio * 100) / 100)}" height="${String(options.height)}"`;
  const a11y = options.decorative === true ? ' aria-hidden="true" focusable="false"' : ' role="img" aria-label="Atmark" focusable="false"';
  const title = options.decorative === true ? '' : '<title>Atmark</title>';
  return `<svg${cls} viewBox="${viewBox}"${size}${a11y}>${title}<g fill="currentColor">${body}</g></svg>`;
}

/** 심볼만(고리 둘 + L 괄호) — 좁은 자리(콘솔 상단 바의 스위처 앞 · 접힌 레일). */
export function brandSymbolSvg(options: BrandSvgOptions = {}): string {
  return svg(BRAND_SYMBOL_VIEWBOX, BRAND_SYMBOL_RATIO, SYMBOL_BODY, options);
}

/** 가로 조합(심볼 + "atmark") — 머리·꼬리·로그인 화면. */
export function brandLockupSvg(options: BrandSvgOptions = {}): string {
  return svg(BRAND_LOCKUP_VIEWBOX, BRAND_LOCKUP_RATIO, `<g transform="translate(8 0)">${SYMBOL_BODY}</g>${WORDMARK_BODY}`, options);
}

/** 기본 모양(클래스 `brand-s` / `brand` · 이름 있는 그림) — 표면이 따로 고를 것이 없을 때. */
export const BRAND_SYMBOL_SVG = brandSymbolSvg({ className: 'brand-s' });
export const BRAND_LOCKUP_SVG = brandLockupSvg({ className: 'brand' });
