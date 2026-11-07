# 블로그 원문 (`atmark.ai/blog`)

글 하나 = 폴더 하나: `posts/<slug>/en.md`(필수) · `posts/<slug>/ko.md`(선택, `/kr/blog/<slug>`).
slug 는 소문자·숫자·하이픈. 그림은 `figures/<이름>.svg`, 스크린샷 등록부는 `shots.ts`.

## 머리말

```yaml
---
title: "Stop giving your AI agent your Gmail"
description: "160자 이하. 목록·검색 결과·링크 미리보기에 그대로 나간다."
date: 2026-10-19          # YYYY-MM-DD
updated: 2026-10-21       # 선택
author: "Younkyum 'Onve' Jin"  # 선택(기본값이 이것)
tags: [agents, email]
draft: true               # 기본 true — false 라고 적어야 공개된다
cover: gmail-oauth-vs-own-address  # 선택: 목록 머리기사·OG 카드에 싣는 그림
---
```

## 본문

`##`·`###` 헤딩(`{#id}` 로 앵커 고정) · 문단 · 목록 · GFM 표(`:--:` 정렬) · ```` ```bash title="…" ```` 코드 · `>` 인용 · `---` 가로줄 ·
`**굵게**` · `*기울임*` · `` `코드` `` · 링크. 원시 HTML 은 쓰지 않는다. `<!-- 주석 -->` 은 원문에만 남는다(공개 글에 `TODO` 주석이 있으면 오류).

- 그림: `![대체 글](figure:<이름>)` · 캡션을 따로: `![대체 글](figure:<이름> "캡션")`
- 스크린샷: `![대체 글](shot:<id>)` — id 는 `shots.ts`(블로그 전용, `blog-` 로 시작) 또는 `src/docs/shots.ts`(문서) 에 있어야 한다.
- 링크: 사이트 `/pricing`, 문서 `https://docs.atmark.ai/en/...#앵커`(있는 페이지·앵커인지 검사), 외부 `https://…`(자동으로 `rel="noopener"`).

## 그림(SVG) 규칙 — 인라인으로 싣고 밝은·어두운 화면을 따라간다

- 뿌리 `<svg viewBox="…">` 필수. `width`·`height` 는 최대 폭(px). 뿌리에는 `fill`·`stroke`·`font-*`·`aria-labelledby` 같은 기본값만.
- 색은 글자로 적지 않는다: `fill`·`stroke` 는 `none` · `currentColor`(잉크) 뿐. 회색·면은 클래스로:
  `ink` 잉크 면 · `paper` 카드 면 · `band` 옅은 띠 면 · `mute` 보조 회색(면·글자) · `line` 잉크 선 · `hair` 가는 회색 선 · `soft` 중간 회색 선 ·
  `dash` 점선 · `thick` 굵은 선 · `label` 13px · `small` 11px 회색 · `title` 15px 굵게 · `mono` · `bold` · `inv` 잉크 면 위 글자 · `mid`/`end` 정렬.
- 쓰지 않는 것: `style=""`, `<style>`, `<script>`, `on*=`, `<image>`, `<foreignObject>`, 외부 `href`(그림 안 `#id` 만). 도형에는 칠이 있어야 한다.

## 명령

```bash
pnpm gen:blog          # 검사 + 공개 글만 src/site/blog-data.ts 로(초안 문제는 보고만, --strict 면 실패)
pnpm gen:blog-images   # 글이 쓰는 콘솔 스크린샷 + 공개 글의 OG 카드(헤드리스 Chrome)
pnpm gen:blog-images --preview <폴더>   # 초안까지 OG 카드를 PNG 로(값 파일은 그대로)
pnpm ui:preview        # http://127.0.0.1:4174/blog — 초안까지 원문에서 바로 그린다
```

공개 = `draft: false` → `pnpm gen:blog` → `pnpm gen:blog-images` → 테스트 → 배포. 공개 글이 하나도 없으면 `/blog` 는 404 이고 머리·꼬리에 링크가 없다.
