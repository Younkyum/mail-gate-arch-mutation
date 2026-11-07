/** src/admin/ui/console/data.ts — 스크립트에 박는 서버 상수 · 사유/다음 할 일 문구. */

import { AC0_ACTIVITY_THRESHOLDS } from '../../../observability/ac0-metrics';
import { AC0_MIN_TURNS } from '../../../mail/thread/turns';
import { AC0_MIN_BASELINE_SENDERS, AC0_OBSERVATION_DAYS, AC0_PROOF_DAYS, INTERVENTION_CATEGORIES, type Ac0NextStepCode } from '../../../gate/ac0-verdict';
import { MAX_AGENTS_PER_PENDING_ORG } from '../../ops/agents';

/** 판정 코드의 상수 — 화면과 `check:ac0` 가 같은 숫자를 말한다. */
export const GATE_CONSTANTS = JSON.stringify({
  minBaselineSenders: AC0_MIN_BASELINE_SENDERS,
  observationDays: AC0_OBSERVATION_DAYS,
  proofDays: AC0_PROOF_DAYS,
  newExternalContacts: AC0_ACTIVITY_THRESHOLDS.newExternalContacts,
  outboundSuccess: AC0_ACTIVITY_THRESHOLDS.outboundSuccess,
  multiTurnThreads: AC0_ACTIVITY_THRESHOLDS.multiTurnThreads,
  minTurns: AC0_MIN_TURNS,
  categories: INTERVENTION_CATEGORIES,
});

/**
 * 검토 전 조직의 에이전트 상한 — 서버 상수를 박는다(화면과 서버가 다른 숫자를 말하지 않게). 활성 조직의 상한은 요금제가 정하므로
 * (ADR-0011) 상수가 아니라 `GET /api/plan` 의 `limits.maxAgents` 다(스크립트 `agentLim`).
 */
export const AGENT_LIMITS = JSON.stringify({ pending: MAX_AGENTS_PER_PENDING_ORG });

/**
 * 로그의 사유 코드 → 사람 말(원문 한국어 — 영어는 `i18n.ts` 사전). 관문·감사가 남기는 **모든** 사유 코드를 싣는다:
 * 거부(`DenyReason`) · 허용(`AllowReason`) · 승인 대기(`PendingReason`) · 유예(`GraceReason`) · 수신 보류/거절 사유 ·
 * 이름이 바뀌기 전의 옛 코드(옛 감사 행에 남는다). 빠진 코드는 화면에 날것(`unrestricted_mode`)으로 보인다 —
 * `admin-console-v2.test.ts` Ⓡⓒ 가 정책 타입 원문의 유니온 전부와 대조해 빨개진다.
 */
export const REASON_LABELS: Readonly<Record<string, string>> = {
  // 거부 — Stage 0
  org_billing_blocked: '결제 문제로 조직 발송 막힘',
  org_abuse_freeze: '플랫폼 동결(운영자)',
  org_owner_paused: '조직 긴급 정지',
  org_pending_review: '검토 전 조직',
  org_review_rejected: '가입이 승인되지 않은 조직',
  agent_not_active: '에이전트가 활성 아님',
  outbound_disabled: '발신 꺼짐(모두 막기)',
  // 거부 — 신원 · suppression · 목록
  from_forgery: '보낸 주소 위조',
  from_inactive: '지금 쓸 수 없는 보낸 주소',
  suppression_list: '수신 거부 목록(suppression)',
  ses_account_level_suppression: '플랫폼 수신 거부 목록',
  recipient_blocklisted: '차단 목록의 수신자',
  recipient_is_self: '자기 주소로 보내기',
  invalid_recipient: '올바르지 않은 수신 주소',
  // 거부 — 한도 · 예산 · 내용
  rate_limit_per_minute: '분당 한도 초과',
  rate_limit_per_hour: '시간당 한도 초과',
  rate_limit_per_day: '하루 한도 초과',
  recipients_per_message: '메일당 수신자 수 초과',
  plan_recipients_per_message: '요금제의 메일당 수신자 한도 초과',
  warmup_daily_cap: '새 조직의 하루 상한 초과(단계적 증량)',
  plan_daily_cap: '요금제 하루 한도 초과',
  budget_exhausted: '예산 소진',
  attachment_bytes_exceeded: '첨부 용량 초과',
  mime_type_not_allowed: '허용되지 않는 첨부 형식',
  recipient_ceiling_exceeded: '수신자 상한 초과',
  // 거부 — 발신 모드
  recipient_not_allowlisted: '허용 목록에 없는 수신자',
  reply_only_no_inbound_thread: '회신 전용: 받은 메일의 스레드가 아님(예전)',
  reply_only_inbound_quarantined: '회신 전용: 답할 메일이 보류됨(예전)',
  // 거부 — 관문
  unregistered_route: '등록되지 않은 발송 경로',
  evaluation_error: '판정 오류(안전하게 거부)',
  release_window_expired: '승인 뒤 발송 기한 지남',
  // 허용
  allowlist_match: '허용 목록에 있음',
  unrestricted_mode: '발신 전체 모드',
  not_blocklisted: '차단 목록에 없음',
  seed_relationship: '처음 등록한 상대(예전)',
  standing_approval: '예전에 승인한 상대(예전)',
  auto_approve_reply_within_thread: '에이전트 스레드 안 회신 자동 승인(예전)',
  auto_approve_verification_sender: '인증 메일 발신자 자동 승인(예전)',
  auto_approve_domain: '자동 승인 도메인(예전)',
  approval_granted: '사람이 승인함',
  reply_within_thread: '스레드 안 회신(예전)',
  // 승인 대기 · 유예
  new_recipient: '새 수신자: 승인 필요(예전)',
  transition_announcement: '전환 공지: 승인 필요',
  bootstrap_grace: '시작 유예 기간',
  // 옛 이름(정책 v2 전 감사 행)
  recipient_not_in_allowlist: '허용 목록에 없는 수신자',
  outbound_mode_disabled: '발신 꺼짐(모두 막기)',
  blocklist: '차단 목록의 수신자',
  // 수신 — 보류 · 정책 · 거절
  policy_blocked: '수신 정책으로 보류',
  sender_not_allowlisted: '허용 목록에 없는 발신자',
  sender_blocklisted: '차단 목록의 발신자',
  inbound_disabled: '수신 꺼짐(모두 막기)',
  injection_risk: '인젝션 위험으로 보류',
  scanner_error: '검사 실패로 보류',
  risk_hold: '위험 등급으로 보류',
  unknown_recipient: '모르는 수신 주소',
  virus: '바이러스',
  mime_rejected: '메일 형식 거부',
  raw_too_large: '너무 큰 메일',
  unstorable: '저장 불가',
  org_not_active: '활성화되지 않은 조직',
  domain_suspended: '발신 도메인 정지',
  domain_plan_limit: '요금제 한도로 도메인 정지',
  domain_warmup_daily_cap: '새 도메인의 하루 발송 한도',
  domain_not_active: '쓸 수 없는 도메인으로 온 메일',
  contact_not_forwarded: '운영자에게 전달하지 않은 문의',
  // 위험 보류(ADR-0016)
  tainted_context: '위험한 메일을 읽은 뒤의 발송: 확인 필요',
  dlp_atmark_credential: 'Atmark 자격 증명이 담김: 확인 필요',
  dlp_third_party_secret: '다른 서비스의 비밀 키가 담김: 확인 필요',
  dlp_verification_code: '받은 인증 코드가 담김: 확인 필요',
  dlp_secret_link: '받은 메일의 비밀 링크(공유·재설정 링크 등)가 담김: 확인 필요',
  dlp_inbound_copy: '받은 메일 내용이 크게 옮겨짐: 확인 필요',
  dlp_scan_limit: '본문이 너무 커 끝까지 검사하지 못함: 확인 필요',
  reply_only_risk_hold: '회신 전용: 위험 신호(위험 메일 · 민감 내용)로 막힘(예전)',
  // 소유자 발신 승인(ADR-0016 2026-10-08)
  owner_requires_approval: '발신 승인: 모든 발송은 소유자 확인',
  reply_only_owner_approval: '회신 전용: 발신 승인 설정으로 막힘(예전)',
};
export const REASONS_JSON = JSON.stringify(REASON_LABELS);

/**
 * GATE "다음 할 일" 코드(`Ac0NextStepCode`) → 콘솔 문구(원문 한국어 — 영어는 `i18n.ts` 사전). 서버의 `next` 는 CLI 용
 * 한국어 문장이라(`pnpm ac0:forwarding on` …) 콘솔은 `nextSteps` 코드를 이 문구로 그린다: 콘솔에 버튼이 있는 일(ON/OFF 기록 ·
 * 개입 기록 · 새 인계 시험 시작)은 버튼을 가리키고, 콘솔에 없는 일은 운영자 요청으로 적는다 — 재시작은 CLI 명령을 적지 않고(`admin-ui.test.ts` ⑲), 원자료 확인만
 * `pnpm ac0:probe` 를 함께 적는다(판정 보류 상태 문구와 같다).
 * `{이름}` 은 `params` 의 값으로 바뀐다(`status` 는 상태 이름, `cause` 는 ` · 원인` 또는 빈 글). 모르는 코드나 채울 수 없는
 * 자리가 있으면 서버 문장을 그대로 보인다. `Record<Ac0NextStepCode, …>` 라 코드가 늘면 타입 검사가 먼저 빨개진다.
 * 문구 안에는 큰따옴표를 쓰지 않는다(JSON 으로 박히면 `\"` 가 되어 번역 사전 키와 어긋난다) — ‘ ’ 를 쓴다.
 */
export const GATE_NEXT_STEP_TEXT: Readonly<Record<Ac0NextStepCode, string>> = {
  restart_signal:
    '재시작 {restarts}회. {threshold}회를 넘으면 인계 시험 실패가 아니라 AC-0이 아직 참이 아니라는 신호입니다. P3·P4로 돌아가 원인을 고칩니다. ' +
    '이 인계 시험에 재시작을 더 쌓지 않습니다. 고친 뒤 아래 ‘인계 시험 시작’에서 ‘새 인계 시험으로 따로 엽니다’를 체크해 새 인계 시험을 엽니다.',
  restart_signal_counterfactual: '(신호가 없었다면: {status}{cause})',
  held_classifier_mismatch:
    '판정 보류: 인계 시험 구간에 판정식 불일치 의심 {count}건(X-Forwarded-*는 사람 메일함이나 에이전트를 가리키는데 봉투가 판정식이 아는 전달 형태가 아닙니다). ' +
    '판정식이 틀렸다면 전달·누수가 보이지 않는 것이라 지금은 알 수 없습니다. 원자료 확인(pnpm ac0:probe)과 판정식 교체(런북 ac0-shadow-log §4)는 콘솔에서 하지 않습니다. 운영자에게 요청하세요. ' +
    '고치면 소급 적용되어 누수로 1일차가 되거나 보류가 풀립니다.',
  held_counterfactual: '(보류가 없었다면: {status})',
  wait_day1_forwarding_on: '1일차 00:00 KST를 기다립니다. 전달 규칙 ON이 기록돼 있습니다.',
  forwarding_on_before_day1: '1일차 00:00 KST 전에 Gmail 전달 규칙을 켜고, 아래 전달 규칙에서 ‘ON 기록’을 누릅니다.',
  observation_no_on_restart:
    'Gmail 전달 규칙을 켜고 아래 ‘ON 기록’을 누른 뒤, 운영자에게 재시작(1일차 복귀)을 요청합니다. 재시작은 콘솔에서 하지 않습니다.',
  observation_early_off_restart:
    'Gmail 전달 규칙을 다시 켜고 아래 ‘ON 기록’을 누른 뒤, 운영자에게 재시작(1일차 복귀)을 요청합니다. 재시작은 콘솔에서 하지 않습니다.',
  observation_only_days: '1~5일차는 관측 전용입니다. 개입 원인을 고치는 것 말고는 아무 작업도 하지 않습니다(§3.2 V1③).',
  baseline_not_yet:
    '아직 서로 다른 외부 발신자 {minSenders}명 이상에게서 전달이 온 날이 없습니다. 기준일이 없으면 추세도 없습니다(B2①). 전달 규칙을 끄지 않습니다.',
  observation_extended_check_classifier:
    '관측 연장 중입니다. 전달이 계속 0 이면 판정식(+caf_=)부터 의심합니다. 운영자에게 원자료 확인(pnpm ac0:probe · 런북 §4 실측 절차)을 요청하세요.',
  observation_pending_comparison:
    '기준일 {baselineDay}일차 → 비교일 {comparisonDay}일차. 비교일이 끝나기 1시간 전까지 전달 규칙을 끄지 않습니다.',
  observation_trend_failed_reannounce:
    '옛 주소로 보내는 상대에게 다시 공지합니다(런북 2단계, 새 Idempotency-Key). 그다음 운영자에게 재시작(1일차 복귀)을 요청합니다. 재시작은 콘솔에서 하지 않습니다.',
  forwarding_off_now: 'AC-b3 추세 통과. 이제 Gmail 전달 규칙을 끄고(필터 삭제 + 전달 주소 삭제) 바로 아래 ‘OFF 기록’을 누릅니다.',
  off_record_required: 'OFF 기록이 없으면 증명 구간은 시작하지 않습니다. 그 전의 개입 0건은 세지 않습니다.',
  leak_verify_removed: 'Gmail 필터와 전달 주소가 정말 삭제됐는지 확인합니다(런북 ‘끄는 절차’).',
  leak_reannounce_restart:
    '메일을 보낸 상대에게 다시 공지하고, Gmail 전달 규칙을 켠 뒤 아래 ‘ON 기록’을 누릅니다. 그다음 운영자에게 재시작(1일차 복귀)을 요청합니다.',
  reenabled_restart:
    '증명 구간에 전달 규칙이 다시 켜졌습니다. 운영자에게 재시작(1일차 복귀)을 요청합니다. 관측을 규칙 ON으로 다시 합니다.',
  intervention_transition_reannounce_restart:
    '해당 상대에게 다시 공지하고, Gmail 전달 규칙을 켠 뒤 아래 ‘ON 기록’을 누릅니다. 그다음 운영자에게 재시작(1일차 복귀)을 요청합니다.',
  intervention_fix_restart_day8:
    '원인을 이슈로 만들어 고치고 배포한 뒤, 운영자에게 재시작(8일차 복귀, 다음 KST 자정부터)을 요청합니다. 전달 규칙은 OFF 그대로 둡니다.',
  proof_starts_next_midnight: '전달 규칙 OFF가 기록됐습니다. 증명 구간(8일차)은 다음 KST 자정에 시작합니다.',
  proving_progress: '증명 {completeDays}/{proofDays}일 무개입. 사람 메일함에서 처리한 일이 생기면 바로 아래 ‘개입 기록’에 남깁니다.',
  proof_activity_shortfall:
    '개입은 0건이지만 활동 분모가 모자랍니다(위 AC-b5). 아무 일도 하지 않은 7일도 개입 0 입니다. 전달 규칙 OFF를 유지하고 증명을 연장합니다(연속 7일 창 가운데 하나라도 채우면 통과).',
  passed_keep_off: 'AC-0 통과. 전달 규칙은 OFF 그대로 둡니다. 다시 켜는 순간 이 판정의 전제가 사라집니다.',
};
export const GATE_NEXT_JSON = JSON.stringify(GATE_NEXT_STEP_TEXT);
