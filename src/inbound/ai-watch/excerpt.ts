/**
 * src/inbound/ai-watch/excerpt.ts — 발췌문 `aw-in/1`(계약 `AI_WATCH_INPUT_VERSION`). **Mac 으로 나가는 유일한 메일 내용.**
 *
 * 학습 전처리 `render_email` 과 같은 함수다(laya-train REPORT2 §8 · `release_config.json` `state_text`):
 *   `"Subject: " + subject.strip() + "\n\n" + body.strip()` — 제목이 비면 본문만. 본문은 파서의 `text`(plain 이 없으면 이미 HTML 태그 제거본 —
 *   `mail/mime/parse.ts` `textSource`). 첨부 이름·주소·헤더는 넣지 않는다(학습에 없었고, 송출 최소화).
 * 그 위에 둘만 더한다: C0 제어문자(탭·LF·CR 제외)·DEL 제거(학습 데이터에 사실상 없고 JSON·로그 경로에서 사고만 낸다), 길이 상한(앞 2,997 + `"\n…\n"` +
 * 뒤 1,000 코드 포인트 — 서명 아래 숨긴 지시 대비, 모델 쪽 토큰 절단 head 152 / tail 128 보다 넉넉하다). **NFKC 는 하지 않는다**(학습 입력에
 * 없었다 — 리드 승인 2026-10-06).
 *
 * I/O 없음 · 던지지 않음. 너무 짧으면(승격 규칙 6) `null`.
 */

import { AI_WATCH_EXCERPT } from './contract';

// C0(탭 \t · LF \n · CR \r 제외)와 DEL.
const STRIPPED = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export interface ExcerptSource {
  readonly subject: string | null;
  /** 파서의 `text`(plain, 없으면 HTML 변환 텍스트). */
  readonly text: string;
}

export function buildAiWatchExcerpt(source: ExcerptSource): string | null {
  const subject = (source.subject ?? '').replace(STRIPPED, '').trim();
  const body = source.text.replace(STRIPPED, '').trim();
  const rendered = subject === '' ? body : `Subject: ${subject}\n\n${body}`;
  const codePoints = [...rendered];
  let excerpt = rendered;
  if (codePoints.length > AI_WATCH_EXCERPT.maxChars) {
    const joiner = [...AI_WATCH_EXCERPT.joiner];
    const head = AI_WATCH_EXCERPT.maxChars - AI_WATCH_EXCERPT.tailChars - joiner.length;
    excerpt = codePoints.slice(0, head).join('') + AI_WATCH_EXCERPT.joiner + codePoints.slice(-AI_WATCH_EXCERPT.tailChars).join('');
  }
  return [...excerpt].length >= AI_WATCH_EXCERPT.minChars ? excerpt : null;
}
