/**
 * 활성 injection 홀드아웃의 봉인 digest — **평가 러너와 봉인 arch 테스트가 함께 읽는 단일 출처.**
 *
 * `ACTIVE_SEAL_DIGEST` 는 활성 세트의 `HOLDOUT.sha256` 파일 전체의 sha256 이다. 봉인 목록과 파일을 같이
 * 고치는 우회는 **이 파일의 diff** 로 드러난다 — 그 diff 는 리뷰에서 "세트를 다시 만들었다(소진)" 로만 읽혀야 한다.
 *
 * `null` = 활성 세트가 없다(2026-09-23: v1 소진, v2 는 소유자 결정으로 보류 — docs/security/injection-holdout.md).
 * 그동안 `scripts/eval-injection.ts --ac7` 은 판정을 거부하고(exit 2), 봉인 테스트는 봉인 안 된 세트의 유입을 막는다.
 */
export const ACTIVE_SEAL_DIGEST: string | null = null;

/** AC-7 판정에 필요한 최소 구성. 이보다 작으면 판정이 아니라 일화다. */
export const AC7_MIN_POSITIVES = 20;
export const AC7_MIN_HIGH = 12;
export const AC7_MIN_NEGATIVES = 30;
