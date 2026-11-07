/**
 * src/ops/console/audit.ts — 운영자 화면의 **쓰기 기록** 모양(성공·실패 모두). 라우트 코어(`api.ts`)가 쓰기마다 싱크를 부른다.
 * 싱크 구현은 호출하는 셸이 고른다: 로컬 화면은 stderr + `~/.atmark/ops-web-audit.jsonl`(`scripts/ops-web/audit-log.ts`).
 *
 * 싣지 않는 것: 토큰·비밀 · 조직 이름·이메일·사유 문구 · 확인 입력. 값은 모양이 정해진 id·코드뿐이다.
 */

export interface WriteRecord {
  readonly at: string;
  readonly actor: string;
  readonly action: string;
  readonly target: string;
  /** `ok` 또는 거부·실패 코드(`confirmation_required` · `db_23514` …). */
  readonly result: string;
  /** 성공 요약 — 비밀·이름 없음(바뀌었나 · 버전 · 상태). */
  readonly summary?: string;
}

export type AuditSink = (record: WriteRecord) => void;
