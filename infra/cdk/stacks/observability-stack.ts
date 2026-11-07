/**
 * AtmarkObservability — **알람 63종**(54~61 = AI 의심 메일 감시 — ADR-0017 초안, 아래 `AI_WATCH_ALARMS_LIVE_DEFAULT` · 62·63 = 공유 도메인 조직 평판) (계획 §6 P1c 항목 12 의 6종 + P2 검증 V1 MINOR-6 의 7번 + 2026-09-24 검증 F6 의 8·9번
 * + 2026-09-24 최종 검증 M3b·L2·L6 의 10~13번 + 2026-09-25 ADR-0010 L7 적대적 검토 M1 의 14번 + 2026-09-25 WP-2 결제의 15~23번
 * + 2026-09-26 메일 기본기 1차의 24~27번 — Contributor Insights 규칙 2개 포함 + 같은 날 재검토 N5 의 28번
 * + 2026-09-28 호스팅 운영자 콘솔(ADR-0015)의 29~37번 + 2026-10 고객 도메인(ADR-0014 단계 2)의 38~48번
 * + 2026-10-04 인젝션 구조 방어(ADR-0016)의 49~52번 — 에이전트별 위험 보류 급증(Contributor Insights 규칙 1개) · Atmark 자격 증명 DLP · 노출 기록 실패 · DLP 키 조기 제거)
 * + 2026-10 고객 도메인 한 번에 설정의 53번(활성 SES identity 수)
 * + **CloudTrail 관리 이벤트 트레일 하나**와 **SES identity 변경 감시 규칙 하나**(ADR-0014 결정 15 · 계획 §3.5 — 알람이 아니라 EventBridge → 같은 토픽).
 *
 * 계획은 "알람 6종" 이라고만 썼고 목록을 주지 않았다. 고르는 기준은 하나였다:
 * **조용히 실패하면 가장 아픈 것.** 시끄럽게 실패하는 것(클라이언트가 502 를 받는
 * 전송 실패, 403 을 받는 정책 거부)은 이미 누군가 신고한다. 알람은 **아무도
 * 신고하지 않는 사건**을 위한 것이다.
 *
 * 그 기준으로 고른 여섯:
 *
 * | # | 무엇이 조용한가 | 임계값 | 근거 |
 * |---|---|---|---|
 * | 1 | 메일은 나갔는데 **법적 기록에 구멍**이 났다 | `>= 1` / 5분 | §4.3 은 "시도당 **정확히** 1행". 등식이므로 1건이 곧 위반 |
 * | 2 | **워밍업 캡이 뚫렸다** — R22 의 마지막 제동장치 | `> 1000` 수신자 / 24h | 코드 상수 `WARMUP_STEADY_STATE_DAILY_CAP` |
 * | 3 | 조직 잠금이 죽어 **전건이 막힌다**(fail-closed) | `>= 3` / 5분 | 1건은 경합으로 회복 가능, 3건은 경로가 죽은 것 |
 * | 4 | **bounce 율** — SES 계정 정지로 직결 | `>= 4%` / 15분 | AWS 검토 개시선 5% 의 80% |
 * | 5 | **complaint 율** — 같은 축, 더 가파르다 | `>= 0.1%` / 15분 | AWS 검토 개시선 그 자체 |
 * | 6 | **관문이 침묵했다** — 1~5 가 전부 거짓말이 된다 | `< 1` 시도 / 24h | 아래 "왜 6번이 필요한가" |
 * | 7 | **승인분이 아무도 닫지 않은 채 남았다** — §4.3 보조 불변식 위반 | `>= 1` 행 / 15분(Maximum) | 아래 "왜 7번인가" |
 * | 8 | **문의가 전역 상한에 걸려 전달되지 않았다**(US-009) | `>= 1` 건 / 1시간 | 아래 "왜 8·9번인가" |
 * | 9 | **문의 전달이 막혔다** — 전달 주소 비밀 없음·시도 소진(US-009) | `>= 1` 건 / 15분 | 아래 "왜 8·9번인가" |
 * | 10 | **나간 메일의 헤더 From 이 발신 주소와 다르다·예약 주소를 사칭했다**(M3b) | `>= 1` 건 / 5분 | 아래 "왜 10~13번인가" |
 * | 11 | **스니펫 보존 스윕이 비우지 못한 행이 있다**(L2) | `>= 1` 행 / 15분(Maximum) | 아래 "왜 10~13번인가" |
 * | 12 | **SES 이벤트 DLQ 에 메시지가 있다**(L6) | `>= 1` / 5분(Maximum) | 아래 "왜 10~13번인가" |
 * | 13 | **수신 메일 DLQ 에 메시지가 있다**(L6) | `>= 1` / 5분(Maximum) | 아래 "왜 10~13번인가" |
 * | 14 | **초대만 받은 사람의 주소를 약속(30일)보다 7일 넘게 못 지웠다**(ADR-0010 L7 M1) | `>= 1` 명 / 1일(Maximum) | 아래 "왜 14번인가" |
 * | 15 | **결제 이벤트 DLQ 에 메시지가 있다**(WP-2) | `>= 1` / 5분(Maximum) | 아래 "왜 15~23번인가" |
 * | 16 | **웹훅 서명 거부가 몰린다** — 비밀 오입력·공격 | `>= 5` / 5분 | 아래 |
 * | 17 | **sync 가 메시지 처리에 실패했다** | `>= 1` / 15분 | 아래 |
 * | 18 | **Paddle API 인증 실패** — 키 자리표시·만료·권한 | `>= 1` / 15분 | 아래 |
 * | 19 | **모르는 가격 id 의 구독** — 돈은 받았는데 요금제가 안 오른다 | `>= 1` / 15분 | 아래 |
 * | 20 | **결속되지 않은 구독** — 우리 거래에서 나오지 않았다 | `>= 1` / 15분 | 아래 |
 * | 21 | **운영자 행이 결제 결과를 막았다**(D-3) | `>= 1` / 15분 | 아래 |
 * | 22 | **Paddle 쪽 변화에 웹훅이 오지 않았다** | `>= 1` / 15분 | 아래 |
 * | 23 | **reconcile 이 한 조직의 재계산에 실패해 건너뛰었다**(WP-2 수정) | `>= 1` / 15분 | 아래 |
 * | 24 | **웹훅 전달의 dead 비율이 높다**(메일 기본기 A4) | `> 20%` / 1시간(분모 ≥ 5) | 아래 "왜 24~27번인가" |
 * | 25 | **SES 이벤트 큐가 밀린다** — 반송·신고 웹훅·억제가 늦는다(A4) | 가장 오래된 메시지 `> 600s` × 5분 3기간 | 아래 |
 * | 26 | **한 에이전트가 하루 50번 넘게 인증코드를 조회했다**(D10 — 관측만) | 최대 기여자 `> 50` / 24시간 | 아래 |
 * | 27 | **한 에이전트의 예약 취소 시도가 1시간에 3번 이상 막혔다**(A3 완화 ③ — http·mcp, 거부만) | 최대 기여자 `>= 3` / 1시간 | 아래 |
 * | 28 | **reconcile 이 26시간 넘게 판을 끝내지 못했거나 틱이 멈췄다**(재검토 N5) | 완료 나이 `> 26h` / 1시간(Maximum) · 결측 = 위반 | 아래 "왜 28번인가" |
 * | 29 | **누가 운영자 접근을 요청했다**(코드 검증을 통과한 requested 만) | `>= 1` / 5분 | 아래 "왜 29~36번인가" |
 * | 30 | **운영자가 승인·폐기됐다** | 승인 + 폐기 `>= 1` / 5분 | 아래 |
 * | 31 | **활성 운영자 수가 늘었다** | `DIFF(census_active) > 0` / 5분 × 2기간 중 1 · 결측 = 위반(식이 1 로 · 게이트 `productionTrafficExpected`) | 아래 |
 * | 32 | **운영자 로그인 코드 대입·주소 잠금** | `code_invalid >= 20` / 15분 또는 잠긴 주소 `>= 1` 또는 오늘 실패 주소 `>= 3` | 아래 |
 * | 33 | **콘솔에서 조직을 거절했다**(P2 부터 동결 켜기 포함) | `privileged_action{action=org.reject} >= 1` / 5분 | 아래 |
 * | 34 | **ops λ 오류·스로틀** | Errors `>= 5` 또는 Throttles `>= 10` / 5분 | 아래 |
 * | 35 | **api λ 스로틀**(예약 9 → 8 의 대가) | Throttles `>= 5` / 5분 | 아래 |
 * | 36 | **운영자 코드 메일을 못 보낸다**(키 자리표시·형식 오류·권한) | `mailer_skipped{reason ∈ placeholder·key_invalid·permission} >= 1` / 15분 · 게이트 `atmark:opsLive` | 아래 |
 * | 37 | **콘솔 쓰기가 티켓 가드에 걸렸다**(`ticket_violation` — 코드 결함 신호) | `write_failed{code=ticket_violation} >= 1` / 5분 | 아래 |
 * | 38 | **고객 도메인 확인이 인프라 오류를 낸다** 또는 사가가 다른 행의 identity 를 만났다 | `check_error >= 5` 또는 `identity_owned_elsewhere >= 1` / 30분 | 아래 "왜 38~45번인가" |
 * | 39 | **확인 틱이 밀렸거나 멈췄다** | `due_backlog` 최솟값 `> 0` / 1시간 · 결측 = 위반 · 게이트 `atmark:domainRecheckEnabled` | 아래 |
 * | 40 | **도메인 평판 경고·동결**(J6) | `reputation_flagged >= 1` / 1시간 | 아래 |
 * | 41 | **고객 도메인에 모르는 수신자가 몰린다**(수신 소비자 — 도메인 합) | `unknown_recipient_custom_domain >= 500` / 1시간 | 아래 |
 * | 42 | **verified 도메인의 MX 가 SES 밖으로 바뀌었다** | `mx_conflict >= 1` / 1시간 | 아래 |
 * | 43 | **identity policy 가 기대와 다르다**(drift — 덮어쓰기 + operator 정지) | `policy_drift >= 1` / 15분 | 아래 |
 * | 44 | **정책이 20개를 넘어 동기화하지 못했다**(기존 정책 유지) | `policy_too_large >= 1` / 15분 | 아래 |
 * | 45 | **독립 감사가 계약 모양이 아닌 자원 정책을 찾았다**(읽기 전용 λ — 보안 리뷰 M2) | `policy_shape_violation >= 1` / 15분 | 아래 |
 * | 46·47 | **domain-control · 독립 감사 λ 가 던졌다** | Lambda `Errors >= 1` / 5분 | 아래 |
 * | 48 | **독립 감사 하트비트가 끊겼다** | `policy_audit_audited` 표본 `< 1` / 1일 · 결측 = 위반 | 아래 |
 * | 53 | **고객 도메인 SES identity 가 너무 많다**(2026-10 one-shot — 증명 전에도 identity 를 만든다) | `identities_held` 최댓값 `> 1,000` / 1시간 | 아래 |
 * | 62 | **공유 도메인(`atmark.ai`) 조직 평판 경고 · 자동 동결**(2026-10-13 보안 후속) | `platform_flagged >= 1` / 1시간 | 아래 "왜 62·63번인가" |
 * | 63 | **조직 평판 판정이 던졌다**(이벤트는 재전달 — 판정이 멈추면 동결도 멈춘다) | `platform_check_failed >= 1` / 1시간 | 아래 |
 *
 * ---------------------------------------------------------------------------
 * ## 왜 62·63번(2026-10-13 공유 도메인 조직 평판 — `src/mail/events/platform-reputation.ts`)인가
 * ---------------------------------------------------------------------------
 *
 * 새 에이전트의 기본값이 "발신 전체" 가 된 뒤(ADR-0007 2026-10-13) `atmark.ai` 로 나가는 메일에는 조직 단위 자동 제동이 필요했다 — 계정 알람(4·5)은
 * 모든 조직의 합이라 한 조직의 사고를 가리키지 못하고, 가리킬 때는 이미 계정 평판이 깎였다. SES 이벤트 소비자가 bounce · complaint 마다 그 조직을
 * 판정하고 선을 넘으면 조직을 플랫폼 동결한다(운영자만 푼다). 62 는 사람이 볼 차례라는 신호다 — 경고(선의 60~65%), 이번 동결, 동결선을 넘었지만
 * 운영자 조직이라 얼리지 않은 경우(`freeze_exempt`). 로그 `ses_event.platform_reputation` 의 organization_id · reasons 로 조직을 찾는다.
 * 63 은 판정 자체가 실패한 것이다 — 기록은 됐고 SQS 가 재전달하지만, 계속 실패하면 DLQ(12)로 가고 그동안 자동 동결이 멈춘다.
 *
 * ---------------------------------------------------------------------------
 * ## 왜 38~45번(2026-10 고객 도메인, ADR-0014 단계 2 · 계획 §3.4·§3.5·§3.6·§3.8)인가
 * ---------------------------------------------------------------------------
 *
 * 고객 도메인의 실패는 **고객 쪽 DNS·평판에서 시작해 우리 계정 전체로 번진다** — 권한 NS 의 일시 오류는 정지 사유로 세지 않으므로(소유권 상실과
 * 구별) 조용히 쌓이고(38), 틱이 멈추면 소유권을 잃은 도메인이 계속 보낸다(39 — 사전 부검 2). 평판(40)은 계정 정지의 앞선 신호이고, 시끄러운 수신(41)과
 * MX 충돌(42)은 사람이 판단할 일이다(자동 차단 없음). 43·44 는 Layer E 의 자원 정책 쪽 눈이다 — 43 은 누가 정책을 넓혔다는 뜻, 44 는 발급 쪽
 * 천장이 뚫렸다는 뜻이다(정상 경로에서는 나지 않는다). 45 는 같은 질문을 **다른 주체**(읽기 전용 감사 λ)가 묻는다 — 정책을 쓰는 domain-control 이 탈취되면 43 도 거짓말하므로.
 * 수치는 `src/domains/metrics.ts` `DOMAIN_METRIC_NAMES`(차원 없음 — 도메인 id·이름은 로그 `DOMAIN_LOG_EVENTS` 에만)이고, 방출은 확인 틱(단계 4)이다 — 41 만 예외로 수신 소비자가 `METRIC_NAMES.inboundUnknownCustomDomain` 을 낸다.
 * **39 만 결측을 위반으로 읽는다** — 틱은 backlog 가 0 이어도 매번 낸다. 액션은 확인 틱 스케줄과 같은 값(`atmark:domainRecheckEnabled`, compute-stack
 * `domainRecheckEnabledOf` — M5 부터 기본 켜짐)에 묶는다: 스케줄이 DISABLED 였던 동안(M1~M4)은 방출이 없는 것이 정상이었다. 나머지는 `NOT_BREACHING`.
 *
 * **identity 변경 감시**(ADR-0014 결정 15 · 스파이크 S5 — 계정에 트레일 0개였다): 관리 이벤트 트레일(S3 · 90일 수명주기 — 첫 사본 관리 이벤트는
 * CloudTrail 요금 0)을 두고, EventBridge 규칙이 SES identity·정책·태그를 바꾸는 호출 중 **domain-control 역할 세션이 아닌 것**을 같은 토픽으로 보낸다
 * (`atmark-ses-identity-change-outside-control`). 틱의 정책 감사(43)가 감사 주기 사이의 창을 남기므로 이것이 두 번째 눈이다(사전 부검 3).
 *
 * ---------------------------------------------------------------------------
 * ## 왜 29~37번(2026-09-28 호스팅 운영자 콘솔, ADR-0015 · `.omc/plans/ops-console.md` §3.8)인가
 * ---------------------------------------------------------------------------
 *
 * 운영자 콘솔은 전 테넌트 특권을 공용 인터넷에 놓는다 — 결정 D 로 **운영자에게 메일은 0통**이고 알림은 콘솔 배지와 이 알람뿐이다. 그래서
 * "권한 지형이 바뀌는 사건" 은 전부 1건이 곧 알람이다: 접근 요청(29), 승인·폐기(30), 활성 운영자 증가(31 — 30 을 우회한 증가까지, 예: 소유자
 * 셸의 `--add`), 조직 거절(33 — 되돌리기 어려운 쓰기). 32 는 사전 부검 2("창업자가 잠겼다")의 조기 신호다 — 대입 시도(코드 불일치)와
 * 주소 실패 누적·잠금(하루 50 → 24시간 발급 중지)을 한 알람으로 본다. 해제는 `pnpm admin:ops-operator --unlock <email>`.
 * 34 는 ops λ 자체(오류 · 스로틀 — `atmark:opsLocked` 로 예약 0 이면 모든 요청이 스로틀이므로 잠근 동안은 이 알람이 운다, 런북).
 * 35 는 api 예약을 9 → 8 로 줄인 대가를 지켜본다(스로틀이 곧 에이전트의 503).
 * 37 은 심층 방어(`zz_ops_require_ticket`)가 **definer 안에서** 걸린 경우다 — definer 를 거치면 일어날 수 없으므로 1건이 곧 코드 결함이다. 호스팅 λ 는
 * 500 을 답할 뿐 Lambda 오류가 아니라 34 에 잡히지 않는다. 게이트는 33 과 같다(없음 — 사건이 없으면 방출도 없다).
 * 36 은 login-mailer 운영 워커가 **예외 없이 건너뛰는** 사유 중 사람이 고칠 것(키 자리표시·키 형식·권한)이다 — go-live 전에는 자리표시가
 * 정상이므로 액션은 컨텍스트 `atmark:opsLive`(기본 `OPS_LIVE_DEFAULT` — 2026-09-28 go-live 뒤 참)에 묶는다. `schema`·`config` 사유는 배포 순서의 정상 중간 상태라 보지 않는다.
 * 31 만 결측을 위반으로 읽는다 — census 는 스위퍼(approval-expiry)가 5분마다 내므로, 끊기면 "운영자가 몰래 늘어도 모른다" 가 된다. 그래서
 * 6·7·28번과 같은 게이트(`productionTrafficExpected`)에 묶는다. 나머지는 `NOT_BREACHING`(사건이 없으면 방출도 없다).
 * 메트릭 이름은 `src/ops/metrics.ts` `OPS_METRIC_NAMES`(단일 진실 원천)에서 온다. 차원은 닫힌 키(`action`·`reason`)만 쓴다 — 식별자 0(N6).
 *
 * ---------------------------------------------------------------------------
 * ## 왜 28번(2026-09-26 재검토 N5)인가
 * ---------------------------------------------------------------------------
 *
 * reconcile 은 웹훅이 놓친 결제 변화(해지·유예 만료)를 잡는 **마지막 그물**인데, 그물이 멈춘 것은 아무 데도 드러나지 않는다 — 틱이 `concurrent`
 * 로 계속 건너뛰거나(풀리지 않은 잠금), 스케줄러·함수가 멈추면 오류도 메트릭도 없다. 그래서 매 틱 마지막 완료의 나이
 * (`billing.reconcile_completed_age_seconds`)를 내고, 26시간(판 간격 24시간 + 여유 2시간)을 넘거나 **1시간 동안 한 번도 나오지 않으면**
 * (틱 4번을 놓쳤다) 운다. 스위치 꺼짐·결제 표 전은 0 을 낸다(대조를 기대하지 않는다 — 결측이 아니다). 6·7번처럼 결측을 위반으로 읽으므로
 * 액션은 같은 게이트(`productionTrafficExpected`)에 묶는다 — 컴퓨트 배포 전에는 방출이 없는 것이 정상이다.
 *
 * ---------------------------------------------------------------------------
 * ## 왜 24~27번(2026-09-26 메일 기본기 1차, `.omc/plans/mail-basics.md` §3·§4)인가
 * ---------------------------------------------------------------------------
 *
 *   - 24번 웹훅 dead 비율 — 새 이벤트 셋(delivered·bounced·complained)이 opt-in 으로 붙으면 수신측 장애가 dead 로만 쌓인다. 에이전트는
 *     폴링하지 않으므로(§3.4 1조) 그 유실은 조용하다. 비율로 보고 분모가 5 미만이면 0 으로 읽는다(한두 건의 실패로 울리지 않게).
 *     소유자가 지운 엔드포인트의 dead(`endpoint_disabled`)는 분자에 없다 — 디스패처가 `webhookDead` 를 내지 않는다(코드 리뷰 M7-b).
 *     **남은 한계:** 전 테넌트 합산이라 한 고객의 수신측이 오래 죽어 있으면 이 알람이 운영자를 부른다. 메트릭에는 엔드포인트·에이전트 차원을
 *     둘 수 없다("기수"). 보강은 ADR-0013 후속 — 디스패처 결말 로그에 엔드포인트 키를 싣고 Contributor Insights `UniqueContributors`
 *     (dead 를 낸 서로 다른 엔드포인트 수 ≥ N)를 이 식에 AND 로 건다. 그 전까지 설명의 첫 확인이 "한 엔드포인트뿐인가" 다.
 *   - 25번 ses-events 지연 — 적재는 ses-events 트랜잭션 안의 savepoint 다(기록 우선). 소비자가 느려지면 반송·신고 웹훅과 억제 목록이
 *     함께 늦는다. `AWS/SQS` 메트릭이라 큐 이름 차원이 있다(DLQ 깊이 12번과 같은 큐 계열).
 *   - 26·27번은 **에이전트별**이다. 메트릭 차원에 `agent_id` 를 둘 수 없으므로(`metrics.ts` "기수") api 로그 그룹의 구조화 로그
 *     (`ALARM_LOG_EVENTS`)를 Contributor Insights 규칙이 `$.agent_id` 로 세고, 알람은 규칙의 최대 기여자 값(`INSIGHT_RULE_METRIC …
 *     MaxContributorValue`)을 본다. 26번은 D10(남용 — 우선 관측만), 27번은 주입 메일이 에이전트 취소를 유도하는 위험(R5)의 이상 탐지다 —
 *     하드 상한(429)과 `agent_cancellable`(403)은 라우트가 **에이전트 토큰의 모든 채널(http·mcp)** 에 집행하고(보안 M1 리드 결정), 이 알람은
 *     그 보호에 **막힌** 시도(`scheduled.cancel_rejected` — 코드 리뷰 M7-a)만 **채널 무관하게** 센다(진윤겸 결정 2026-09-26). 성공한 취소는
 *     정상 사용이라 세지 않는다 — 성공까지 세면 상한(시간당 5)을 정상적으로 쓰는 에이전트가 울린다. 거부는 보호가 막아 준 시도 자체이고,
 *     한 시간에 3번이면 같은 지시가 되풀이되는 것이다. 소유자 콘솔 취소(owner·admin, 상한 없음)는 로그를 내지 않으므로 세지 않는다.
 * 넷 다 결측은 `NOT_BREACHING` 이다(사건이 없으면 로그·방출도 없다).
 *
 * ---------------------------------------------------------------------------
 * ## 왜 15~23번(2026-09-25 WP-2 — Paddle 결제, 계획 §3-10)인가
 * ---------------------------------------------------------------------------
 *
 * 결제의 실패는 **양쪽 모두 조용하다** — 고객은 Paddle 에서 결제 완료 화면을 봤고, 우리는 웹훅이 오지 않았다는 것을 모른다(사전 부검 1·2).
 * 막는 장치(재조회 · 결속 검증 · 운영자 행 보존 · 모르는 가격 noop)는 전부 **요금제를 바꾸지 않는 쪽**으로 실패하므로, 알람이 없으면
 * "돈은 받았는데 요금제가 안 올랐다" 가 고객 문의로만 드러난다. 그래서 noop 이유마다 알람 하나를 둔다.
 *   - 15번 DLQ — 10번 받고도 처리 못 한 메시지(가시성 6분 × 10 = 약 1시간 — `billing-stack.ts`). FIFO 는 그룹이 막히므로 1건이 곧 일이다.
 *   - 16번 `webhook_rejected` 만 임계값이 5 다 — 인터넷에 열린 엔드포인트라 스캐너 한두 건은 정상이고, 5분 5건은 비밀 오입력(모든 웹훅 거부)
 *     이거나 두드림이다.
 *   - 17~23번은 1건이 곧 사람이 볼 일이다. 결제는 드물다(하루 몇 건) — 임계값을 올리면 알람이 영원히 울리지 않는다.
 *   - 23번 `reconcile_org_failed` — reconcile 은 한 조직의 재계산이 던져도 그 조직만 건너뛰고 틱을 잇는다(한 조직이 전부를 막지 않게).
 *     그 대가로 실패가 **틱이 성공한 것처럼** 조용해진다 — Lambda Errors 도 `sync_failed` 도 없다. 같은 조직이 매 틱 실패하면 그 조직의
 *     요금제는 영영 결제와 어긋난다. 그래서 따로 센다(15분 = reconcile 한 틱).
 * 전부 **차원 없는 EMF**(빈 집합 롤업 — `metrics.ts`)이고 결측은 `NOT_BREACHING`(결제가 없으면 실패도 없다). 방출의 생사는 6번이 본다.
 * 정보 메트릭(`billing.webhook_accepted`·`billing.customer_shared` 등 10종)에는 알람이 없다.
 *
 * ---------------------------------------------------------------------------
 * ## 왜 14번(2026-09-25 ADR-0010 L7 적대적 검토 M1)인가
 * ---------------------------------------------------------------------------
 *
 * 개인정보 안내는 "들어오지 않은 초대 대상의 주소는 마지막 초대가 끝나고 30일 뒤 지운다" 고 약속한다. 지우기는 하루 한 번(03:00 KST)
 * 배치이고 막힌 행(잠금·제약·대기 메일)은 조용히 건너뛴다 — 11번과 같은 종류의 조용한 약속 위반이다. 스위퍼가 같은 창에서
 * `invited_user_erasure_backlog()`(마지막 초대가 끝난 지 37일이 지났는데 안 지운 사용자 수)를 매일 낸다. 하루에 한 번 나오는 값이라 기간이
 * 하루(`Maximum`)이고 결측은 `NOT_BREACHING`(창 틱을 놓친 날 — 스위퍼 실패는 로그 `retention_step.failed` 가 본다). *
 * ---------------------------------------------------------------------------
 * ## 왜 10~13번(2026-09-24 최종 검증)인가
 * ---------------------------------------------------------------------------
 *
 *   - 10번 `ses.from_mismatch` — IAM 은 `FromEmailAddress` 만 보고, raw MIME 의 `From` 이 달라도 SES 가 거부하는지는 문서에 없다
 *     (ADR-0006 M3b). 사칭 메일은 **이미 나갔고** 받는 사람만 안다. SES 이벤트의 `commonHeaders.from` 대 `source` 가 그것을 아는
 *     유일한 창이다(`src/mail/events/from-alignment.ts`). 1건이 곧 사고다.
 *   - 11번 `snippet.retention_stuck` — 다른 트리거가 한 행의 UPDATE 를 거부하면 스윕은 그 행을 건너뛰고 나머지를 비운다(L2). 건너뛴
 *     행은 개인정보 문구("1년 뒤 삭제")를 어긴 채 남는다. 매 스윕(5분) 값을 내므로 `Maximum`.
 *   - 12·13번 DLQ 깊이 — DLQ 에 쌓이는 것은 파싱 불가·연속 실패·소비자 사망이고(`ses-stack.ts`·`inbound-stack.ts`), 둘 다 **아무도
 *     보지 않는 더미**였다. SES 이벤트 소비자는 예약 동시성 1 < SQS 최대 동시성 2 라 스로틀 재전달이 수신 횟수를 올린다 — 가시성
 *     180s 로 막았지만 막혔는지는 DLQ 깊이만 말한다. `AWS/SQS` 메트릭이라 차원(`QueueName`)이 있다 — 큐 이름은 스택 상수에서 온다.
 * 넷 다 결측은 `NOT_BREACHING` 이다(사건이 없으면 방출·메시지도 없다).
 *
 * ---------------------------------------------------------------------------
 * ## 왜 8·9번(문의 전달, US-009 · ADR-0009)인가
 * ---------------------------------------------------------------------------
 *
 * 문의 창구(`support@atmark.ai`)의 실패는 **조용하다** — 보낸 사람은 SES 수신 응답(250)을 받았고, 운영자는 메일이 없다는 사실을
 * 모른다. 원문은 S3 에, 사유는 `inbound_rejections`·`contact_forwards` 에 남지만 아무도 그 표를 보지 않는다(검증 F6).
 *   - 8번 `rate_global` — 차선 시간당 상한(support 30 · role 10, 차원 `lane` — 알람은 두 차선의 롤업)이 찼다. 폭탄(주소 돌려 막기)이거나 정상 문의가
 *     버려지는 중이다. 1건이 곧 신호다.
 *   - 9번 `forward_blocked` — 전달 주소 비밀이 비었거나(배포 직후 자리값) 전송 시도를 다 썼다. 비밀이 빈 채로 문의가 오면
 *     1분마다 오른다.
 * 둘 다 카운터라 결측은 `NOT_BREACHING`(문의가 없으면 실패도 없다) — 6번이 EMF 방출의 생사를 본다.
 *
 * ---------------------------------------------------------------------------
 * ## 왜 7번(보조 불변식)이 알람 한 자리를 차지하는가
 * ---------------------------------------------------------------------------
 *
 * §4.3 보조 불변식(재정의, `audit_pending_overdue`)은 "승인 대기도 릴리스 대기도 아닌 `pending_approval` 행은
 * 0" 이다. 위반은 **닫는 주체가 멈췄다**는 뜻이다 — TTL 스위퍼가 죽으면 요청이 만료되지 않고, 릴리스 스윕이
 * 죽으면 사람이 승인한 메일이 아무 데도 적히지 않은 채 창을 넘긴다(V1 MINOR-1 의 "워커가 멈췄다가 72시간 뒤").
 * 두 워커는 발송 실패처럼 **시끄럽게** 실패하지 않는다 — 에이전트는 202 를 받았고 소유자는 승인을 눌렀다.
 * 그래서 이 알람의 기준(조용히 실패하면 가장 아픈 것)에 든다.
 *
 * 측정은 두 워커가 **서로** 한다(`approval/service.measurePendingOverdue`): 한쪽이 멈추면 다른 쪽이 그 위반을
 * 잰다. 둘 다 멈추면 방출이 끊기므로 **결측을 위반으로 읽는다**(6번과 같은 이유). 그 대가로 액션은 6번과
 * 같은 게이트(`productionTrafficExpected`)에 묶는다 — 컴퓨트 배포 전에는 방출이 없는 것이 정상이다.
 *
 * ---------------------------------------------------------------------------
 * ## 왜 6번(관문 침묵)이 알람 한 자리를 차지하는가
 * ---------------------------------------------------------------------------
 *
 * 1~3 은 **카운터 알람**이고, 카운터 알람의 결측은 `NOT_BREACHING` 으로 다룰 수밖에
 * 없다(트래픽이 없으면 실패도 0이다). 그 결과 **방출이 멈추면 다섯 개가 동시에,
 * 조용히, 영원히 초록이 된다.** 배포 실수로 로그 그룹 권한이 빠지거나 EMF 파서가
 * 이름을 못 찾으면 그 상태가 된다.
 *
 * 6번은 그 상태를 잡는 유일한 장치다 — Layer F(알려진 위반 패치로 "잠든 층"을
 * 검출)가 arch 스위트에 대해 하는 일을, 알람 스위트에 대해 한다.
 *
 * **`actionsEnabled` 가 `productionTrafficExpected` 에 묶인 이유:** 프로덕션 트래픽이
 * 개시되기 전에는 "24시간 동안 0건" 이 정상이다. 그 기간에 켜 두면 알람 피로를
 * 만들고, 알람 피로는 이 계획이 승인 경로에 대해 이미 최대 실패 요인으로 지목한
 * 것이다(§4.2). **리소스는 언제나 존재하고**(arch 테스트가 그것을 단언한다)
 * 켜는 시점만 프로덕션 개시 체크리스트로 옮긴다.
 *
 * ---------------------------------------------------------------------------
 * ## 임계값의 출처 — "적당히 5%" 를 쓰지 않은 자리
 * ---------------------------------------------------------------------------
 *
 * 알람 4·5 는 **외부에서 정해진 수치**가 있다. AWS SES 는 발신 계정의 bounce 율이
 * **5%**, complaint 율이 **0.1%** 를 넘으면 계정을 검토(review) 대상으로 올리고,
 * 악화되면 발송을 정지한다(AWS SES 문서 "Reputation metrics" / Sending review process).
 *
 *  - **bounce 는 4%** — 5% 의 80%. AWS 가 우리를 보기 **전에** 우리가 본다.
 *    계획 §3.3 모니터링 표의 "위험 4%" 와 같은 값이다.
 *  - **complaint 는 0.1%** — 검토 개시선 그 자체를 쓴다. 계획 §3.3 은 위험선을 0.2%
 *    로 적었는데 그건 AWS 가 이미 검토를 시작한 **뒤**라 늦다. 외부 수치가 우리
 *    문서와 어긋날 때는 외부 수치를 따른다 — 계정을 정지시키는 쪽이 AWS다.
 *
 * 알람 2 도 추정이 아니다. `WARMUP_STEADY_STATE_DAILY_CAP` 을 **코드에서 import**
 * 하므로, 캡이 바뀌면 알람도 같이 바뀐다. 캡이 집행되는 한 이 임계값은 구조적으로
 * 도달 불가능하다(`isWarmupCapExceeded` 가 `합 + n > cap` 에서 막으므로 성공한
 * 발송의 합은 `cap` 을 넘을 수 없다). 즉 **이 알람이 울렸다 = 제동장치가 없었다.**
 *
 * ---------------------------------------------------------------------------
 * ## 이 스택이 하지 않는 것
 * ---------------------------------------------------------------------------
 *
 * 메트릭을 **방출**하지 않는다. 방출은 `src/observability/metrics.ts` 가 EMF
 * 한 줄로 한다(그 파일의 "왜 EMF 인가" 참조 — 발송 성공 직후 경로에 네트워크
 * 호출을 두지 않기 위해서다). 이 스택은 그 줄이 만든 시계열 위에 **판정**만 얹는다.
 *
 * 메트릭 **이름**은 `METRIC_NAMES` 를 import 한다. 문자열을 두 번 적으면 한쪽을
 * 고치는 날 알람은 존재하지만 아무 데이터도 보지 않는다.
 *
 * ---------------------------------------------------------------------------
 * ## 알람이 누구에게 가는가 — 이메일 구독 하나(2026-10-01)
 * ---------------------------------------------------------------------------
 *
 * 2026-10-01 점검에서 토픽 `atmark-observability-alarms` 에 알람 37종의 액션이 모이는데 **구독이 0개**였다 — "구독은
 * 스택 밖에서 붙인다" 고 적어 두고 아무도 붙이지 않았다. 알람이 울려도 아무에게도 가지 않으면 37종 전부가 없는 것과 같다.
 * 그래서 구독을 **이 스택이 만든다.** 주소는 리포에 쓰지 않는다(리포는 공개될 수 있다) — SSM String 파라미터
 * `ALARM_EMAIL_SSM_PARAMETER`(`/atmark/ops/alarm-email`, CLI 로 손으로 만든다 · 런북 deploy §35)를 CloudFormation 동적 참조
 * (`{{resolve:ssm:…}}`)로 읽어 **배포 시점에** 푼다. synth 는 AWS 를 부르지 않는다(CI 는 자격증명이 없다).
 * **주소 변경은 파라미터만 고쳐서는 반영되지 않는다** — 템플릿이 같으면 CloudFormation 이 리소스를 갱신하지 않아 동적 참조도 다시 풀지
 * 않는다. 파라미터를 고친 뒤 구독의 논리 id 를 바꾸는 커밋과 함께 배포한다(새 구독 생성 · 옛 구독 삭제 — 런북 deploy §35).
 * 새 구독은 AWS 가 그 주소로 보내는 확인 링크를 누르기 전까지 `PendingConfirmation` 이고 그동안은 아무것도 받지 않는다.
 */

import * as cdk from 'aws-cdk-lib';
import * as cloudtrail from 'aws-cdk-lib/aws-cloudtrail';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventTargets from 'aws-cdk-lib/aws-events-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';

import { RECONCILE_STALE_AFTER_MS } from '../../../src/billing/reconcile';
import { AGENT_SCHEDULED_CANCEL_HOURLY_LIMIT } from '../../../src/db/schema';
import { IDENTITIES_HELD_ALARM_THRESHOLD } from '../../../src/domains/contract';
import { DOMAIN_METRIC_NAMES } from '../../../src/domains/metrics';
import { ALARM_LOG_EVENTS, METRIC_NAMES, METRIC_NAMESPACE } from '../../../src/observability/metrics';
import { OPS_FUNCTION_NAME } from '../../../src/ops/contract';
import { OPS_METRIC_NAMES, type OpsMailerSkipReason, type OpsWriteFailureCode } from '../../../src/ops/metrics';
import { WARMUP_STEADY_STATE_DAILY_CAP } from '../../../src/policy/rules/limits';
import { BILLING_DLQ_NAME } from './billing-stack';
import {
  DOMAIN_CONTROL_HANDLER,
  DOMAIN_CONTROL_ROLE_NAME,
  DOMAIN_POLICY_AUDIT_HANDLER,
  DOMAIN_RECHECK_ENABLED_CONTEXT_KEY,
  contextFlagOf,
  domainRecheckEnabledOf,
  type HandlerName,
} from './compute-stack';

const DOMAIN_CONTROL_FUNCTION_NAME = `atmark-${DOMAIN_CONTROL_HANDLER}`;
const DOMAIN_POLICY_AUDIT_FUNCTION_NAME = `atmark-${DOMAIN_POLICY_AUDIT_HANDLER}`;
import { INBOUND_DLQ_NAME } from './inbound-stack';
import { AI_WATCH_IAM_USER, AI_WATCH_QUEUES } from '../../../src/inbound/ai-watch/contract';
import { SES_EVENT_DLQ_NAME, SES_EVENT_QUEUE_NAME } from './ses-stack';

/** 알람이 모이는 SNS 토픽 이름. */
export const ALARM_TOPIC_NAME = 'atmark-observability-alarms';

/** 알람 이메일 구독의 주소를 담은 SSM String 파라미터 — 주소는 리포에 쓰지 않는다(머리말 "알람이 누구에게 가는가"). */
export const ALARM_EMAIL_SSM_PARAMETER = '/atmark/ops/alarm-email';

/** SES 가 bounce 율로 계정을 검토 대상에 올리는 선. 출처: AWS SES sending review process. */
export const SES_BOUNCE_REVIEW_RATE = 0.05;

/** 우리가 먼저 보는 선 — 위 값의 80%. 계획 §3.3 "위험 4%" 와 같다. */
export const BOUNCE_ALARM_RATE = 0.04;

/**
 * SES 가 complaint 율로 계정을 검토 대상에 올리는 선. 출처: 위와 같음.
 * **여기서는 이 값을 그대로 쓴다** — 더 내리면 표본이 적은 초기에 잡음이 되고,
 * 더 올리면 AWS 가 이미 검토를 시작한 뒤가 된다.
 */
export const COMPLAINT_ALARM_RATE = 0.001;

/** 직렬화 실패가 "경합" 이 아니라 "경로 사망" 으로 읽히는 건수 / 5분. */
export const SERIALIZATION_FAILURE_THRESHOLD = 3;

/** 결제 웹훅 서명 거부가 "스캐너" 가 아니라 "비밀 오입력·두드림" 으로 읽히는 건수 / 5분(알람 16). */
export const BILLING_WEBHOOK_REJECTED_THRESHOLD = 5;

/**
 * 고객 도메인의 모르는 수신자(`unknown_recipient`) 수 / 1시간(알람 41 — ADR-0014 계획 §3.6 의 "시간당 500"). 수신 소비자가 건마다 내는 값의 **모든 고객
 * 도메인 합**이라 도메인 하나의 500 보다 먼저 울린다(도메인이 적은 지금은 같은 뜻).
 */
export const NOISY_INBOUND_HOURLY_THRESHOLD = 500;

/** 웹훅 전달 dead 비율 알람선(알람 24) — 1시간 dead / (delivered + dead) 가 이 값을 **넘으면**. */
export const WEBHOOK_DEAD_RATIO_THRESHOLD = 0.2;

/** 알람 24 의 분모 하한 — 1시간 전달 시도(delivered + dead)가 이보다 적으면 비율을 0 으로 읽는다(한두 건의 실패로 울리지 않게). */
export const WEBHOOK_DEAD_RATIO_MIN_ATTEMPTS = 5;

/** ses-events 큐의 가장 오래된 메시지 나이(초) 알람선(알람 25) — 5분 기간 3번 연속으로 넘으면. */
export const SES_EVENTS_LAG_SECONDS = 600;

/** 한 에이전트의 하루 인증코드 조회 수 알람선(알람 26, 메일 기본기 D10) — 최대 기여자가 이 값을 **넘으면**. */
export const VERIFICATION_LOOKUPS_AGENT_DAILY_THRESHOLD = 50;

/**
 * 한 에이전트의 1시간 예약 취소 **거부** 수 알람선(알람 27, 진윤겸 결정 2026-09-26) — 최대 기여자가 이 값 **이상이면**. 성공한 취소는 세지 않는다.
 * 한 번의 거부는 실수(보호된 예약을 모르고 건드렸다)일 수 있고, 한 시간에 세 번은 같은 지시를 되풀이하는 것 — 주입된 메일이 취소를 조르는 모양이다.
 */
export const SCHEDULED_CANCEL_REJECTIONS_AGENT_HOURLY_THRESHOLD = 3;

/** reconcile 완료 나이 알람선(알람 28, 초) — `RECONCILE_STALE_AFTER_MS`(26시간)와 같다. */
export const RECONCILE_STALE_SECONDS = RECONCILE_STALE_AFTER_MS / 1000;

/**
 * 에이전트별 두 규칙이 읽는 로그 그룹 — api Lambda(`atmark-api`, MCP 도 같은 함수다)의 로그 그룹. 이름은 compute 스택의 규칙
 * (`/aws/lambda/atmark-${handler}`)과 같아야 한다 — 다르면 규칙이 아무 줄도 보지 않는다(알람 arch 테스트가 대조한다).
 */
const API_HANDLER: HandlerName = 'api';
export const API_LOG_GROUP_NAME = `/aws/lambda/atmark-${API_HANDLER}`;

/** 운영자 콘솔 알람 임계값(알람 32 — 15분 코드 불일치 수, 34 — ops λ 오류·스로틀 / 5분, 35 — api λ 스로틀 / 5분). */
export const OPS_CODE_INVALID_THRESHOLD = 20;
/** 알람 32 — 오늘 코드 실패가 있는 **서로 다른 주소** 수. 1 이면 운영자 본인의 오타 한 번에도 하루 내내 울린다(게이지가 하루 값) — 3 부터 분산 시도로 읽는다. */
export const OPS_FAILING_ADDRESSES_THRESHOLD = 3;
export const OPS_LAMBDA_ERRORS_THRESHOLD = 5;
export const OPS_LAMBDA_THROTTLES_THRESHOLD = 10;
export const API_LAMBDA_THROTTLES_THRESHOLD = 5;

/** 알람 33 이 보는 특권 행위(P1: 거절. P2 에 `org.freeze_on` 을 더한다 — 그때 식 알람으로 바꾼다). */
export const OPS_PRIVILEGED_ALARM_ACTION = 'org.reject';

/** 알람 37 이 보는 쓰기 실패 코드(`OPS_WRITE_FAILURE_CODES` 의 한 값 — definer 안의 42501). */
export const OPS_TICKET_VIOLATION_CODE: OpsWriteFailureCode = 'ticket_violation';

/** 알람 36 이 보는 건너뜀 사유 — 사람이 고칠 것만(`schema`·`config` 는 배포 순서의 정상 중간 상태). */
export const OPS_MAILER_SKIP_ALARM_REASONS: readonly OpsMailerSkipReason[] = ['placeholder', 'key_invalid', 'permission'];

/**
 * go-live 게이트(알람 36) — `-c atmark:opsLive=true` 로 켠다. 콘솔을 연 뒤(런북 `docs/runbooks/ops-console.md` go-live) 켜고, 확인되면
 * `OPS_LIVE_DEFAULT` 를 `true` 로 커밋해 굳힌다(결제 스위치와 같은 규율 — 컨텍스트를 빠뜨린 다음 배포가 끄지 않게).
 */
export const OPS_LIVE_DEFAULT = true;
export const OPS_LIVE_CONTEXT_KEY = 'atmark:opsLive';

/**
 * AI 의심 메일 감시(ADR-0017 초안 · 설계 ai-mail-watch §2.4) — 알람 54~61. **Mac 가용성 알람 셋**(요청 큐 나이 · 하트비트 침묵 · fail-skip 률)의 액션은
 * 컨텍스트 `atmark:aiWatchAlarmsLive` ?? `AI_WATCH_ALARMS_LIVE_DEFAULT`(false) — 감시를 켠 조직이 생기면(롤아웃 3단계 `on`) 켜고, 확인되면 상수를
 * true 로 커밋한다(opsLive 와 같은 규율). 그 전에는 Mac 이 꺼져 있는 것이 정상이라 울리면 알람 피로다. 나머지 다섯(자기 시험 실패 · 판정 지연 ·
 * 큐 송신 실패 · 결과 거부 · 결과 DLQ)은 사건이 있어야 데이터가 생기므로(notBreaching) 처음부터 켠다.
 */
export const AI_WATCH_ALARMS_LIVE_DEFAULT = false;
export const AI_WATCH_ALARMS_LIVE_CONTEXT_KEY = 'atmark:aiWatchAlarmsLive';
/** 요청 큐의 가장 오래된 메시지(초) — 판정 마감 30초의 2/3. 넘으면 Mac 이 당겨 가지 않고 있다. */
export const AI_WATCH_QUEUE_AGE_SECONDS = 20;
/** 하트비트 침묵 창(분) — 워커는 60초마다 보낸다. */
export const AI_WATCH_HEARTBEAT_SILENCE_MINUTES = 10;
/** 판정 지연 p95(ms) — `now − enqueued_at`. 마감 30초의 1/3. */
export const AI_WATCH_VERDICT_LATENCY_P95_MS = 10_000;
/** fail-skip 률(1시간) — 1 − 마감 안 판정 / 보낸 작업. 작업이 이보다 적은 시간은 보지 않는다(한두 건의 지연이 100% 가 되지 않게). */
export const AI_WATCH_FAIL_SKIP_RATE = 0.2;
export const AI_WATCH_FAIL_SKIP_MIN_ENQUEUED = 5;
/** Mac IAM 사용자의 예상 밖 호출 감시(CloudTrail → EventBridge → 알람 토픽). */
export const AI_WATCH_USER_UNEXPECTED_RULE_NAME = 'atmark-ai-watch-user-unexpected-call';
export const AI_WATCH_USER_ERROR_RULE_NAME = 'atmark-ai-watch-user-error';
/** 그 사용자가 정상적으로 닿는 서비스(SQS 데이터 호출 · SQS 가 대신 부르는 KMS Decrypt). */
export const AI_WATCH_USER_EXPECTED_EVENT_SOURCES: readonly string[] = ['sqs.amazonaws.com', 'kms.amazonaws.com'];

/** 알람 38 — 30분 확인 인프라 오류(`check_error`) 수. 한두 건(권한 NS 하나의 순간 장애)은 다음 틱이 다시 본다 — 틱 셋에 걸친 5건부터. */
export const DOMAIN_CHECK_ERRORS_THRESHOLD = 5;

/** CloudTrail 관리 이벤트 트레일(ADR-0014 결정 15) — 이름 · S3 보존 일수. */
export const MANAGEMENT_TRAIL_NAME = 'atmark-management-events';
export const MANAGEMENT_TRAIL_RETENTION_DAYS = 90;

/** domain-control 밖 SES identity 변경 감시 규칙(계획 §3.5 "CloudTrail"). */
export const SES_IDENTITY_CHANGE_RULE_NAME = 'atmark-ses-identity-change-outside-control';

/**
 * 감시하는 SES 관리 이벤트 — identity·정책·태그·DKIM·MAIL FROM 을 **바꾸는** 호출(SES v2 이름은 접두사로 · v1 이름은 정확히). 읽기 호출은 EventBridge 로
 * 오지 않는다(CloudTrail 의 쓰기 관리 이벤트만 기본 버스로 온다).
 */
export const SES_IDENTITY_CHANGE_EVENT_PREFIXES: readonly string[] = [
  'CreateEmailIdentity',
  'DeleteEmailIdentity',
  'UpdateEmailIdentity',
  'PutEmailIdentity',
  'SetIdentity',
  'VerifyDomain',
  'VerifyEmail',
];
export const SES_IDENTITY_CHANGE_EVENT_NAMES: readonly string[] = [
  'TagResource',
  'UntagResource',
  'PutIdentityPolicy',
  'DeleteIdentityPolicy',
  'DeleteIdentity',
  'DeleteVerifiedEmailAddress',
];
/** 구성 세트(이벤트 대상 · 평판 · 억제 등) 변경 — 이름 가운데 `ConfigurationSet` 이 든 호출 전부(보안 리뷰 L1). */
export const SES_IDENTITY_CHANGE_EVENT_WILDCARDS: readonly string[] = ['*ConfigurationSet*'];

/** 두 번째 규칙 — 호출자 ARN 칸이 없는 이벤트(`anything-but` 은 칸이 없으면 맞지 않는다)를 `userIdentity.type` 으로 잡는다(보안 리뷰 L1). */
export const SES_IDENTITY_CHANGE_NON_ROLE_RULE_NAME = 'atmark-ses-identity-change-non-role-caller';
/** 태그 변경 규칙(재검증 LOW-1 — 호출자 무관). */
export const SES_IDENTITY_TAG_RULE_NAME = 'atmark-ses-identity-tag-change';
/** 호출자 ARN 이 늘 있는 `userIdentity.type` — 규칙 ① 이 본다. */
export const SES_CHANGE_ARN_BEARING_TYPES: readonly string[] = ['AssumedRole', 'IAMUser', 'Root', 'FederatedUser'];

/** Contributor Insights 규칙 이름(알람 26·27 이 `INSIGHT_RULE_METRIC` 으로 부른다). */
export const INSIGHT_RULE_NAMES = {
  verificationLookupsByAgent: 'atmark-verification-lookups-by-agent',
  scheduledCancelsByAgent: 'atmark-scheduled-cancels-by-agent',
  riskHoldsByAgent: 'atmark-risk-holds-by-agent',
} as const;

/**
 * 한 에이전트의 위험 보류(ADR-0016 — 강제 `held` · 관찰 `observed`)가 1시간에 이 수 이상이면 알람 — 같은 에이전트가 오염 맥락에서 계속 새 상대에게 쓰려
 * 한다(인젝션이 에이전트를 반복해 움직이는 흔적이거나, 소유자 승인 메일이 쏟아진다). 정상 워크로드(인증 메일 받기)는 0 이다.
 */
export const RISK_HOLDS_AGENT_HOURLY_THRESHOLD = 10;

export interface ObservabilityStackProps extends cdk.StackProps {
  /**
   * 프로덕션 트래픽이 개시됐는가. 결측을 위반으로 읽는 알람(6 관문 침묵 · 7 승인 방치 · 28 reconcile 정지)의 액션 활성화 여부만 정한다 —
   * **리소스는 값과 무관하게 항상 만들어진다.**
   */
  readonly productionTrafficExpected: boolean;
}

export class ObservabilityStack extends cdk.Stack {
  public readonly alarmTopic: sns.Topic;

  /** arch 테스트가 개수를 세는 대상(`test/arch/observability-alarms.arch.test.ts`). */
  public readonly alarms: readonly cloudwatch.Alarm[];

  public constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props);

    this.alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      topicName: ALARM_TOPIC_NAME,
      displayName: 'Atmark observability alarms',
      // 이 토픽에는 수신자 주소가 흐르지 않는다(메트릭에는 PII 차원이 없다).
      // 그래도 평문 publish 를 막는 것은 `ses-stack.ts` 와 같은 규율이다.
      enforceSSL: true,
    });

    // 구독 0개였던 토픽(2026-10-01)에 이메일 구독 하나. 주소는 SSM 동적 참조로 배포 시점에 푼다 — 리포에 개인 연락처를 박지 않는다(머리말).
    new sns.Subscription(this, 'AlarmEmailSubscription', {
      topic: this.alarmTopic,
      protocol: sns.SubscriptionProtocol.EMAIL,
      endpoint: ssm.StringParameter.fromStringParameterAttributes(this, 'AlarmEmailParameter', {
        parameterName: ALARM_EMAIL_SSM_PARAMETER,
        forceDynamicReference: true,
      }).stringValue,
    });

    new cdk.CfnOutput(this, 'AlarmTopicArn', {
      value: this.alarmTopic.topicArn,
      description: `알람 63종과 SES identity · AI 감시 Mac 사용자 감시가 발화하는 SNS 토픽. 이메일 구독 하나(주소 = SSM ${ALARM_EMAIL_SSM_PARAMETER}).`,
    });

    const custom = (metricName: string, statistic: string, period: cdk.Duration): cloudwatch.Metric =>
      new cloudwatch.Metric({
        namespace: METRIC_NAMESPACE,
        metricName,
        statistic,
        period,
        // **차원을 지정하지 않는다 = 빈 차원 집합의 롤업을 본다.**
        // `metrics.ts` 의 `emitMetric` 이 빈 집합을 항상 함께 방출하는 이유가 이것이다.
      });

    // 기본 모양: 한 기간에 1건 이상이면 울리고, 결측은 사건 없음으로 읽는다(발송이 없으면 실패도 없다 — 결측을 위반으로 치면 야간마다 운다).
    // 이 모양이 아닌 알람만 칸을 덮어쓴다.
    const newAlarm = (
      id: string,
      spec: Omit<cloudwatch.AlarmProps, 'threshold' | 'evaluationPeriods'> & { readonly threshold?: number; readonly evaluationPeriods?: number },
    ): cloudwatch.Alarm =>
      new cloudwatch.Alarm(this, id, {
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        ...spec,
      });

    // ── 알람 1 — audit 해소 실패 = 법적 기록의 구멍 ────────────────────────────
    //
    // BLOCKER 에서 배운 것: 메일이 나간 **뒤** audit 기록이 실패하는 경로가 있다.
    // 그 실패는 이제 결말을 뒤집지 않지만(그게 BLOCKER 수정이었다) **여전히 일어난다.**
    // 예전에는 `gate.ts` 의 `console.error` 한 줄이 그 사건의 전부였다 —
    // 아무도 stdout 을 보고 있지 않으면 구멍은 발견되지 않는다.
    const auditResolveFailed = newAlarm('AuditResolveFailure', {
      alarmName: 'atmark-audit-resolve-failure',
      alarmDescription:
        '전송 성공 뒤 audit 해소가 실패했다. 메일은 나갔고 audit 행은 미해소 allowed 로 ' +
        '남았다 — §4.3 "시도당 정확히 1행" 은 등식이므로 1건이 곧 위반이다. ' +
        'audit_logs 에서 resolved_at IS NULL AND decision=\'allowed\' 인 행을 찾아 손으로 메운다.',
      metric: custom(METRIC_NAMES.auditResolveFailed, 'Sum', cdk.Duration.minutes(5)),
    });

    // ── 알람 2 — 워밍업 캡 돌파 (R22) ──────────────────────────────────────────
    //
    // R22: SES 샌드박스가 46초 만에 풀려 계정 한도가 **하루 5만 통**이다.
    // 남은 제동장치는 워밍업 캡 하나이고, 그것이 꺼지거나 뚫리면 알아야 한다.
    //
    // **눈금이 수신자 수인 것이 요점이다** — 캡도 계정 한도도 메일 수가 아니라
    // 수신자 수로 센다. 메일 수로 재면 10명짜리 메일 100통을 보고도 조용하다.
    const warmupCapBreached = newAlarm('WarmupCapBreached', {
      alarmName: 'atmark-warmup-cap-breached',
      alarmDescription:
        `24시간 발송 수신자 수가 워밍업 램프의 정상상태 캡(${String(WARMUP_STEADY_STATE_DAILY_CAP)})을 ` +
        '넘었다. 캡이 집행되는 한 구조적으로 도달할 수 없는 값이므로, 울렸다는 것은 ' +
        '제동장치가 없었다는 뜻이다 — 직렬화가 꺼졌거나(unserialized), sending_started_at 이 ' +
        '잘못 세팅됐거나, 캡 검사를 지나지 않는 발송 경로가 생겼다. SES 계정 한도는 50,000/day 다.',
      metric: custom(METRIC_NAMES.recipients, 'Sum', cdk.Duration.days(1)),
      threshold: WARMUP_STEADY_STATE_DAILY_CAP,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });

    // ── 알람 3 — 평가~lease 구간을 잠그지 못한다 ───────────────────────────────
    //
    // fail-closed 라 메일은 나가지 않는다. 대신 **전부 막힌다** — 그 조직의 모든
    // 발송이 `evaluation_error` 로 거부되고, 클라이언트가 보는 403 은 "정책이 막았다"
    // 와 구별되지 않는다. 사용자는 정책을 의심하고, 진짜 원인(풀 고갈·lock timeout)은
    // 아무 데도 안 적힌다.
    //
    // **임계값이 1이 아닌 이유:** advisory lock 경합·풀 회수 지연으로 1건이 나는 것은
    // 회복 가능한 정상 범위다. 3건/5분은 그 설명이 더 이상 통하지 않는 지점이다.
    const serializationUnavailable = newAlarm('DispatchSerializationUnavailable', {
      alarmName: 'atmark-dispatch-serialization-unavailable',
      alarmDescription:
        '평가~lease 구간의 조직 단위 직렬화에 실패하고 있다(R22). fail-closed 라 오발송은 ' +
        '없지만 해당 조직의 발송이 전건 차단된다. 커넥션 풀 고갈 · lock_timeout · ' +
        'agents 행 부재를 본다.',
      metric: custom(METRIC_NAMES.serializationUnavailable, 'Sum', cdk.Duration.minutes(5)),
      threshold: SERIALIZATION_FAILURE_THRESHOLD,
    });

    // ── 알람 4·5 — deliverability. **우리가 정하지 않은 숫자다.** ───────────────
    //
    // `AWS/SES` 의 `Reputation.*` 는 **계정 수준**이고 차원이 없다. 정지되는 단위가
    // 계정이므로 그것이 옳은 눈금이다 — 설정 세트별로 쪼개면 각 비율은 낮은데
    // 계정은 정지되는 상태가 표현 가능해진다.
    //
    // 이 두 메트릭은 `AtmarkSes` 스택의 `reputationMetrics: true` 가 켜 준 것이다.
    // 그것이 꺼지면 두 알람은 데이터 없이 남는다(알람 6이 그 상태를 직접 잡지는
    // 못한다 — 알려진 한계이며, 그 플래그는 `ses-stack.ts` 의 리뷰 대상이다).
    const reputation = (metricName: string): cloudwatch.Metric =>
      new cloudwatch.Metric({
        namespace: 'AWS/SES',
        metricName,
        statistic: 'Average',
        period: cdk.Duration.minutes(15),
      });

    const bounceRate = newAlarm('SesBounceRate', {
      alarmName: 'atmark-ses-bounce-rate',
      alarmDescription:
        `계정 bounce 율이 ${String(BOUNCE_ALARM_RATE * 100)}% 를 넘었다. AWS SES 는 ` +
        `${String(SES_BOUNCE_REVIEW_RATE * 100)}% 에서 계정을 검토 대상에 올린다 — 이 알람은 그 80% 지점이다. ` +
        '발송을 멈추고 수신자 목록의 출처를 본다. 여기서 정지되면 복구는 우리 손에 없다.',
      metric: reputation('Reputation.BounceRate'),
      threshold: BOUNCE_ALARM_RATE,
    });

    const complaintRate = newAlarm('SesComplaintRate', {
      alarmName: 'atmark-ses-complaint-rate',
      alarmDescription:
        `계정 complaint 율이 ${String(COMPLAINT_ALARM_RATE * 100)}% 를 넘었다 — AWS SES 의 ` +
        '검토 개시선 그 자체다. 계획 §3.3 의 위험선 0.2% 는 AWS 가 이미 보기 시작한 뒤라 늦다. ' +
        '에이전트가 보낸 메일이 스팸 신고를 받고 있다는 뜻이므로 approval 경로부터 본다.',
      metric: reputation('Reputation.ComplaintRate'),
      threshold: COMPLAINT_ALARM_RATE,
    });

    // ── 알람 6 — 관문이 침묵했다 (알람 스위트의 비공허성) ──────────────────────
    //
    // 위 다섯 중 셋이 `NOT_BREACHING` 이다. 방출이 멈추면 그 셋은 동시에, 조용히,
    // 영원히 초록이 된다. 이 알람만이 그 상태를 위반으로 읽는다 —
    // **그래서 여기만 `treatMissingData: BREACHING` 이다.**
    const gateSilence = newAlarm('GateSilence', {
      alarmName: 'atmark-gate-silence',
      alarmDescription:
        '24시간 동안 관문을 지난 발송 시도가 0건이다. 제품이 쓰이지 않고 있거나, ' +
        `${METRIC_NAMESPACE} 네임스페이스로의 EMF 방출이 죽었다. 후자라면 나머지 알람 5종이 ` +
        '전부 거짓으로 초록이므로, 이 알람은 알람 스위트 자신의 생사 신호다.',
      metric: custom(METRIC_NAMES.attempts, 'Sum', cdk.Duration.days(1)),
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      // 프로덕션 트래픽 개시 전에는 0건이 정상이다. **리소스는 항상 존재하고**
      // 켜는 시점만 체크리스트로 옮긴다 — 끄는 것이 아니라 아직 켜지 않은 것이다.
      actionsEnabled: props.productionTrafficExpected,
    });

    // ── 알람 7 — §4.3 보조 불변식 위반 (승인분이 아무도 닫지 않은 채 남았다) ─────────
    //
    // 값은 **허용 폭(30분)보다 오래 된** 위반 수다(`PENDING_OVERDUE_TOLERANCE_SECONDS`) — 주기의 지연은 이미 빠졌다.
    // 그래서 임계값이 1이다. `Maximum` 인 이유: 두 워커가 같은 값을 내므로 `Sum` 은 두 배를 센다.
    const pendingOverdue = newAlarm('ApprovalPendingOverdue', {
      alarmName: 'atmark-approval-pending-overdue',
      alarmDescription:
        '§4.3 보조 불변식 위반 — 승인 대기(요청 pending, TTL 전)도 릴리스 대기(요청 approved, 일정 scheduled, ' +
        '창 전)도 아닌 pending_approval audit 행이 30분 넘게 남았다. TTL 스위퍼(atmark-approval-expiry) 또는 ' +
        '릴리스 스윕(atmark-approval-release)이 멈췄거나 결함이다. SELECT * FROM audit_pending_overdue(now()) 로 ' +
        '행을 보고, 결측(두 워커 모두 방출 없음)이면 두 스케줄부터 본다.',
      metric: custom(METRIC_NAMES.approvalPendingOverdue, 'Maximum', cdk.Duration.minutes(15)),
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      actionsEnabled: props.productionTrafficExpected,
    });

    // ── 알람 8 — 문의가 차선 상한에 걸렸다 (검증 F6, US-009 · 차선 202610021000) ─────────
    const contactRateGlobal = newAlarm('ContactRateGlobal', {
      alarmName: 'atmark-contact-rate-global',
      alarmDescription:
        '문의(support@ · abuse@ · postmaster@)가 차선 시간당 상한(CONTACT_FORWARD_LANE_HOURLY_CAP — support 30 · role 10, 메트릭 차원 lane)에 걸려 운영자에게 전달되지 않았다. ' +
        '문의 폭탄이거나 정상 문의가 버려지는 중이다. 원문은 S3 inbound/raw/ 에 있다 — inbound_rejections 에서 ' +
        "reason='contact_not_forwarded' AND detail='rate_global' 인 행을 보고, 필요하면 원문을 손으로 확인한다.",
      metric: custom(METRIC_NAMES.contactRateGlobal, 'Sum', cdk.Duration.hours(1)),
    });

    // ── 알람 9 — 문의 전달이 막혔다 (검증 F6, US-009) ──────────────────────────────
    const contactForwardBlocked = newAlarm('ContactForwardBlocked', {
      alarmName: 'atmark-contact-forward-blocked',
      alarmDescription:
        '문의 전달(atmark-contact-forwarder)이 막혔다 — 전달 주소 비밀(atmark/contact-forward-to)이 비었거나 모양이 틀렸거나, ' +
        '전송 시도를 다 써 dead 가 됐다. contact_forwards 의 pending·dead 행을 보고 비밀을 채운다(docs/runbooks/deploy.md).',
      metric: custom(METRIC_NAMES.contactForwardBlocked, 'Sum', cdk.Duration.minutes(15)),
    });

    // ── 알람 10 — 헤더 From 이 발신 주소와 다르다·예약 주소 사칭 (최종 검증 M3b) ─────────────
    const sesFromMismatch = newAlarm('SesFromMismatch', {
      alarmName: 'atmark-ses-from-mismatch',
      alarmDescription:
        '나간 메일의 헤더 From 이 SES 발신 주소(FromEmailAddress)와 다르거나 예약 주소(login@·support@atmark.ai)를 담았는데 발신 주소가 ' +
        '그 예약 주소가 아니다 — 발송 역할(atmark-runtime-sender) 탈취·전송단 결함을 의심한다. 로그 ses_event.from_mismatch(atmark-ses-events)를 ' +
        '보고 SES 이벤트의 mail.messageId 로 발송 행을 찾는다. ADR-0006 M3b — 근본 조치는 예약 주소를 별도 identity 로 옮기는 것이다.',
      metric: custom(METRIC_NAMES.sesFromMismatch, 'Sum', cdk.Duration.minutes(5)),
    });

    // ── 알람 11 — 스니펫 보존 스윕이 비우지 못한 행 (최종 검증 L2) ─────────────────────────
    const snippetRetentionStuck = newAlarm('SnippetRetentionStuck', {
      alarmName: 'atmark-snippet-retention-stuck',
      alarmDescription:
        '365일이 지난 발신 스니펫(messages.snippet)을 비우지 못한 행이 있다 — 다른 트리거·제약이 UPDATE 를 거부했다. 스윕은 그 행을 ' +
        '건너뛰고 나머지를 비운다. 로그 snippet_retention.stuck(atmark-approval-expiry)의 message_id 로 행을 보고 거부한 트리거를 찾는다.',
      metric: custom(METRIC_NAMES.snippetRetentionStuck, 'Maximum', cdk.Duration.minutes(15)),
    });

    // ── 알람 14 — 초대만 받은 사용자 주소 지우기가 약속을 넘겼다 (ADR-0010 L7 · 적대적 검토 M1) ──────────
    // 값은 TTL 스위퍼가 하루 창(03:00 KST)에서 **하루 한 번** 낸다 — 그래서 기간이 하루다. 결측(창 틱을 놓친 날)은 위반으로 치지 않는다
    //   (다음 날 값이 다시 본다 · 스위퍼 실패는 Lambda Errors 가 따로 본다).
    const privacyErasureBacklog = newAlarm('PrivacyErasureBacklog', {
      alarmName: 'atmark-privacy-erasure-backlog',
      alarmDescription:
        '초대만 받고 들어오지 않은 사람의 주소를 약속(마지막 초대가 끝나고 30일)보다 7일 넘게 지우지 못한 사용자가 있다 — 개인정보 안내의 ' +
        '보유 기간 위반이다. 로그 invited_user_erasure.done(atmark-approval-expiry)의 건너뜀 수를 보고, 소유자 셸에서 ' +
        'SELECT * FROM erase_invited_only_users(500) 을 손으로 돌린 뒤 남는 행의 막힘(대기 메일·잠금·제약)을 찾는다(docs/runbooks/admin.md).',
      metric: custom(METRIC_NAMES.privacyErasureBacklog, 'Maximum', cdk.Duration.days(1)),
    });

    // ── 알람 12·13 — DLQ 깊이 (최종 검증 L6) ──────────────────────────────────────────────
    const dlqDepth = (id: string, alarmName: string, queueName: string, description: string): cloudwatch.Alarm =>
      newAlarm(id, {
        alarmName,
        alarmDescription: description,
        metric: new cloudwatch.Metric({
          namespace: 'AWS/SQS',
          metricName: 'ApproximateNumberOfMessagesVisible',
          dimensionsMap: { QueueName: queueName },
          statistic: 'Maximum',
          period: cdk.Duration.minutes(5),
        }),
      });
    const sesEventDlqDepth = dlqDepth(
      'SesEventDlqDepth',
      'atmark-ses-events-dlq-depth',
      SES_EVENT_DLQ_NAME,
      `${SES_EVENT_DLQ_NAME} 에 메시지가 있다 — SES 이벤트가 파싱 불가이거나 5회 연속 실패했거나 소비자(atmark-ses-events)가 죽었다. ` +
        '이 이벤트가 없으면 lease 만료 재전송이 유보되고 bounce·complaint 기록이 빈다(ADR-0004). 메시지를 열어 원인을 보고 큐로 되돌린다.',
    );
    const inboundDlqDepth = dlqDepth(
      'InboundDlqDepth',
      'atmark-inbound-mail-dlq-depth',
      INBOUND_DLQ_NAME,
      `${INBOUND_DLQ_NAME} 에 메시지가 있다 — 수신 메일 처리가 연속 실패했다. 그 메일은 에이전트 수신함에 없다(원문은 S3 inbound/raw/). ` +
        '메시지를 열어 원인을 보고 큐로 되돌린다.',
    );

    // ── 알람 15~23 — 결제(WP-2, 계획 §3-10) ─────────────────────────────────────────────
    const billingDlqDepth = dlqDepth(
      'BillingDlqDepth',
      'atmark-billing-dlq-depth',
      BILLING_DLQ_NAME,
      `${BILLING_DLQ_NAME} 에 메시지가 있다 — 결제 이벤트를 sync(atmark-billing-sync)가 10번 받고도(약 1시간) 처리하지 못했다. 그 구독의 요금제가 ` +
        '결제와 어긋나 있을 수 있다. 메시지(event_id)로 로그를 보고 원인을 고친 뒤 큐로 되돌리거나 sync-org 로 다시 맞춘다(docs/runbooks/billing.md).',
    );
    const counterAlarm = (id: string, alarmName: string, metricName: string, period: cdk.Duration, description: string, threshold = 1): cloudwatch.Alarm =>
      newAlarm(id, { alarmName, alarmDescription: description, metric: custom(metricName, 'Sum', period), threshold });
    const billingWebhookRejected = counterAlarm(
      'BillingWebhookRejected',
      'atmark-billing-webhook-rejected',
      METRIC_NAMES.billingWebhookRejected,
      cdk.Duration.minutes(5),
      '결제 웹훅(atmark-billing-webhook)이 5분에 5건 넘게 거부했다(서명·타임스탬프 창·헤더·크기·봉투). 비밀 오입력이면 모든 웹훅이 거부되고 ' +
        'Paddle 은 재시도하다 멈춘다. 로그 billing.webhook 의 reason 을 보고, signature_mismatch 뿐이면 atmark/billing/paddle/webhook-secret 을 대조한다.',
      BILLING_WEBHOOK_REJECTED_THRESHOLD,
    );
    const billingSyncFailed = counterAlarm(
      'BillingSyncFailed',
      'atmark-billing-sync-failed',
      METRIC_NAMES.billingSyncFailed,
      cdk.Duration.minutes(15),
      '결제 sync(atmark-billing-sync)가 처리에 실패했다 — SQS 가 재시도하고 10회면 DLQ 로 간다. 로그 billing.sync_threw·billing.reconcile_failed 의 ' +
        'error_kind·error_code(SQLSTATE 또는 Paddle 코드)를 먼저 보고 원인을 가른다(DB·키·Paddle·NAT — docs/runbooks/billing.md 대응표).',
    );
    const billingProviderAuthFailed = counterAlarm(
      'BillingProviderAuthFailed',
      'atmark-billing-provider-auth-failed',
      METRIC_NAMES.billingProviderAuthFailed,
      cdk.Duration.minutes(15),
      'Paddle API 가 401/403 을 돌려줬다 — sync·admin 키가 자리표시·만료·권한 부족이다(결제 스위치가 켜진 뒤). 키를 교체한다(docs/runbooks/billing.md 키 교체).',
    );
    const billingUnknownPrice = counterAlarm(
      'BillingUnknownPrice',
      'atmark-billing-unknown-price',
      METRIC_NAMES.billingUnknownPrice,
      cdk.Duration.minutes(15),
      '우리가 모르는 가격 id 의 구독이 있다 — 요금제를 바꾸지 않았다(noop). 돈은 받았는데 요금제가 안 올랐을 수 있다. src/billing/paddle/prices.ts 와 Paddle 가격을 대조한다.',
    );
    const billingUnboundSubscription = counterAlarm(
      'BillingUnboundSubscription',
      'atmark-billing-unbound-subscription',
      METRIC_NAMES.billingUnboundSubscription,
      cdk.Duration.minutes(15),
      '원 거래가 우리 billing_checkouts 에 없는 구독이 들어왔다 — 공개 클라이언트 토큰으로 연 체크아웃이거나 조직 불일치다. 결속하지 않았다. ' +
        'billing_events 의 failed(unbound_subscription) 행과 Paddle 거래를 대조한다.',
    );
    const billingEntitlementHeld = counterAlarm(
      'BillingEntitlementHeld',
      'atmark-billing-entitlement-held',
      METRIC_NAMES.billingEntitlementHeld,
      cdk.Duration.minutes(15),
      '운영자·백필 요금제 행이 결제 결과를 막았다(D-3 — 칸별 지배 실패). 결제한 조직의 한도가 오르지 않았다. 확인 뒤 pnpm admin:plan --release-to-provider 로 넘긴다.',
    );
    const billingWebhookMissed = counterAlarm(
      'BillingWebhookMissed',
      'atmark-billing-webhook-missed',
      METRIC_NAMES.billingWebhookMissed,
      cdk.Duration.minutes(15),
      'reconcile 이 본 Paddle 구독 변화에 2시간 안에 웹훅이 오지 않았다 — 알림 목적지 URL·구독 이벤트·웹훅 λ 를 본다. reconcile 이 상태는 맞췄다.',
    );

    const billingReconcileOrgFailed = counterAlarm(
      'BillingReconcileOrgFailed',
      'atmark-billing-reconcile-org-failed',
      METRIC_NAMES.billingReconcileOrgFailed,
      cdk.Duration.minutes(15),
      'reconcile 이 한 조직의 요금제 재계산에 실패해 그 조직만 건너뛰었다 — 틱은 성공으로 끝나 Lambda Errors·sync-failed 가 없다. ' +
        'atmark-billing-sync 로그 billing.reconcile_org_failed 의 error_code(SQLSTATE)를 보고 고친 뒤 sync-org 로 맞춘다(docs/runbooks/billing.md).',
    );

    // ── 알람 24~27 — 메일 기본기 1차(A1·A3·A4) ──────────────────────────────────────────
    // 24 — 웹훅 dead 비율. 두 카운터(차원 없음)를 FILL 로 0 채움한 뒤 분모 하한 아래는 0 으로 읽는다.
    const webhookDeadRatio = newAlarm('WebhookDeadRatio', {
      alarmName: 'atmark-webhook-dead-ratio',
      alarmDescription:
        `1시간 웹훅 전달 중 dead 비율이 ${String(WEBHOOK_DEAD_RATIO_THRESHOLD * 100)}% 를 넘었다(전달 시도 ${String(WEBHOOK_DEAD_RATIO_MIN_ATTEMPTS)}건 이상일 때). ` +
        '수신측 장애·목적지 거부·서명 불일치를 의심한다. webhook_deliveries 의 dead 행(last_error·last_http_status)을 엔드포인트별로 묶어 본다. ' +
        '에이전트는 폴링하지 않으므로 dead 는 조용한 유실이다 — 필요하면 재전송(POST …/webhook-deliveries/{id}/redeliver)을 안내한다. ' +
        '전 테넌트 합산이다: 먼저 dead 가 한 엔드포인트(한 고객)에 몰렸는지 본다 — 그렇다면 운영 장애가 아니라 그 고객의 수신측 문제다. ' +
        '소유자가 지운 엔드포인트의 dead(endpoint_disabled)는 이 비율에 들어가지 않는다.',
      metric: new cloudwatch.MathExpression({
        expression:
          `IF((FILL(delivered, 0) + FILL(dead, 0)) >= ${String(WEBHOOK_DEAD_RATIO_MIN_ATTEMPTS)}, ` +
          'FILL(dead, 0) / (FILL(delivered, 0) + FILL(dead, 0)), 0)',
        usingMetrics: {
          delivered: custom(METRIC_NAMES.webhookDelivered, 'Sum', cdk.Duration.hours(1)),
          dead: custom(METRIC_NAMES.webhookDead, 'Sum', cdk.Duration.hours(1)),
        },
        period: cdk.Duration.hours(1),
        label: 'webhook dead ratio',
      }),
      threshold: WEBHOOK_DEAD_RATIO_THRESHOLD,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });

    // 25 — ses-events 큐 지연. 한 번 튀는 것(배치 재시도)이 아니라 15분 내내 밀린 것만 본다.
    const sesEventsLag = newAlarm('SesEventsLag', {
      alarmName: 'atmark-ses-events-lag',
      alarmDescription:
        `${SES_EVENT_QUEUE_NAME} 큐의 가장 오래된 메시지가 ${String(SES_EVENTS_LAG_SECONDS)}초보다 오래 15분 동안 남아 있다 — 소비자(atmark-ses-events)가 ` +
        '느리거나 멈췄다. 반송·신고 기록, 억제 목록, message.delivered·bounced·complained 웹훅이 함께 늦는다. 소비자 로그·스로틀·DB 잠금을 본다.',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/SQS',
        metricName: 'ApproximateAgeOfOldestMessage',
        dimensionsMap: { QueueName: SES_EVENT_QUEUE_NAME },
        statistic: 'Maximum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: SES_EVENTS_LAG_SECONDS,
      evaluationPeriods: 3,
      datapointsToAlarm: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });

    // 26·27 — 에이전트별(Contributor Insights). 규칙은 api 로그 그룹의 JSON 줄을 `$.event` 로 거르고 `$.agent_id` 로 센다.
    const insightRule = (id: string, ruleName: string, filters: readonly Record<string, unknown>[]): cloudwatch.CfnInsightRule =>
      new cloudwatch.CfnInsightRule(this, id, {
        ruleName,
        ruleState: 'ENABLED',
        ruleBody: JSON.stringify({
          Schema: { Name: 'CloudWatchLogRule', Version: 1 },
          LogGroupNames: [API_LOG_GROUP_NAME],
          LogFormat: 'JSON',
          Contribution: { Keys: ['$.agent_id'], Filters: filters },
          AggregateOn: 'Count',
        }),
      });
    const verificationRule = insightRule('VerificationLookupsByAgent', INSIGHT_RULE_NAMES.verificationLookupsByAgent, [
      { Match: '$.event', In: [ALARM_LOG_EVENTS.verificationLookup] },
    ]);
    // 27 — 채널 무관(http·mcp): 보호가 에이전트 토큰의 모든 채널에 걸린다(보안 M1). **거부(M7-a)만** 센다(진윤겸 결정 2026-09-26).
    const cancelRule = insightRule('ScheduledCancelsByAgent', INSIGHT_RULE_NAMES.scheduledCancelsByAgent, [
      { Match: '$.event', In: [ALARM_LOG_EVENTS.scheduledCancelRejected] },
    ]);
    // 49 — 위험 보류 급증(ADR-0016). 강제 · 관찰 둘 다 센다(관찰 모드에서도 "보류했을" 수가 급증하면 알아야 한다).
    const riskHoldRule = insightRule('RiskHoldsByAgent', INSIGHT_RULE_NAMES.riskHoldsByAgent, [
      { Match: '$.event', In: [ALARM_LOG_EVENTS.riskHold] },
    ]);
    const topContributor = (ruleName: string, period: cdk.Duration, label: string): cloudwatch.MathExpression =>
      new cloudwatch.MathExpression({
        expression: `INSIGHT_RULE_METRIC('${ruleName}', 'MaxContributorValue')`,
        usingMetrics: {},
        period,
        label,
      });

    const verificationLookupsAgentDaily = newAlarm('VerificationLookupsAgentDaily', {
      alarmName: 'atmark-verification-lookups-agent-daily',
      alarmDescription:
        `한 에이전트가 24시간 동안 인증코드 조회(GET /v1/messages/verification-code · MCP get_verification_code)를 ` +
        `${String(VERIFICATION_LOOKUPS_AGENT_DAILY_THRESHOLD)}번 넘게 했다(D10 — 우선 관측만, 하드 상한 없음). Contributor Insights 규칙 ` +
        `${INSIGHT_RULE_NAMES.verificationLookupsByAgent} 에서 상위 agent_id 를 보고, 대량 가입·자동화 남용인지 소유자와 확인한다. 반복되면 하드 상한을 검토한다(ADR-0013).`,
      metric: topContributor(INSIGHT_RULE_NAMES.verificationLookupsByAgent, cdk.Duration.days(1), 'verification lookups — top agent'),
      threshold: VERIFICATION_LOOKUPS_AGENT_DAILY_THRESHOLD,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });
    verificationLookupsAgentDaily.node.addDependency(verificationRule);

    const scheduledCancelsAgentHourly = newAlarm('ScheduledCancelsAgentHourly', {
      alarmName: 'atmark-scheduled-cancels-agent-hourly',
      alarmDescription:
        `한 에이전트의 예약 취소 시도가 1시간에 ${String(SCHEDULED_CANCEL_REJECTIONS_AGENT_HOURLY_THRESHOLD)}번 이상 **거부**됐다(HTTP·MCP 합산) — ` +
        `하드 상한(시간당 ${String(AGENT_SCHEDULED_CANCEL_HOURLY_LIMIT)}건, 429 cancel_rate_limited)을 넘기려 했거나 agent_cancellable:false 예약(403)을 건드렸다. ` +
        '받은 메일의 지시로 취소를 조르고 있을 수 있다(주입 — 계획 R5). 성공한 취소와 소유자 콘솔 취소는 세지 않는다. ' +
        `Contributor Insights 규칙 ${INSIGHT_RULE_NAMES.scheduledCancelsByAgent} 에서 agent_id 를 보고, 로그 ${ALARM_LOG_EVENTS.scheduledCancelRejected} 의 ` +
        `route_id·outcome 과 ${ALARM_LOG_EVENTS.scheduledCancelled}(같은 에이전트의 성공), 콘솔 로그(type=scheduled)를 소유자와 확인한다. ` +
        '취소가 필요한 예약이면 소유자가 콘솔에서 취소한다(docs/runbooks/hermes.md).',
      metric: topContributor(INSIGHT_RULE_NAMES.scheduledCancelsByAgent, cdk.Duration.hours(1), 'agent scheduled cancel rejections — top agent'),
      threshold: SCHEDULED_CANCEL_REJECTIONS_AGENT_HOURLY_THRESHOLD,
    });
    scheduledCancelsAgentHourly.node.addDependency(cancelRule);

    // ── 알람 28 — reconcile 정지(재검토 N5). 결측 = 위반(틱이 멈췄다) — 6·7번과 같은 게이트.
    const billingReconcileStale = newAlarm('BillingReconcileStale', {
      alarmName: 'atmark-billing-reconcile-stale',
      alarmDescription:
        `결제 reconcile 이 ${String(RECONCILE_STALE_SECONDS / 3600)}시간 넘게 판을 끝내지 못했거나(billing_reconcile_state.completed_at) 1시간 동안 틱이 ` +
        '나이를 내지 않았다(스케줄러·atmark-billing-sync 정지). 웹훅이 놓친 해지·유예 만료가 요금제에 반영되지 않는다. 로그 billing.reconcile 의 outcome ' +
        '(concurrent 가 이어지면 billing.reconcile_lock_release_missed · 메트릭 billing.reconcile_concurrent), billing.reconcile_failed, Scheduler 를 본다. ' +
        '원인을 고친 뒤 {"action":"reconcile","restart":true} 로 새 판을 연다(응답 restartApplied 가 true 인지 확인 — docs/runbooks/billing.md).',
      metric: custom(METRIC_NAMES.billingReconcileCompletedAgeSeconds, 'Maximum', cdk.Duration.hours(1)),
      threshold: RECONCILE_STALE_SECONDS,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      actionsEnabled: props.productionTrafficExpected,
    });

    // ── 알람 29~37 — 호스팅 운영자 콘솔(ADR-0015 · 계획 §3.8) ─────────────────────────────────────────
    const opsLive = contextFlagOf(this.node, OPS_LIVE_CONTEXT_KEY, OPS_LIVE_DEFAULT);
    const opsCounter = (metricName: string, period: cdk.Duration, dimensionsMap?: Record<string, string>): cloudwatch.Metric =>
      new cloudwatch.Metric({ namespace: METRIC_NAMESPACE, metricName, statistic: 'Sum', period, ...(dimensionsMap === undefined ? {} : { dimensionsMap }) });
    const opsGauge = (metricName: string, period: cdk.Duration): cloudwatch.Metric =>
      new cloudwatch.Metric({ namespace: METRIC_NAMESPACE, metricName, statistic: 'Maximum', period });
    const lambdaMetric = (functionName: string, metricName: 'Errors' | 'Throttles'): cloudwatch.Metric =>
      new cloudwatch.Metric({
        namespace: 'AWS/Lambda',
        metricName,
        dimensionsMap: { FunctionName: functionName },
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      });

    // 29 — 검증된 접근 요청(코드 검증 뒤 requested 만 — I-9). 1건이 곧 사람이 볼 일(대기 최대 5 · 7일 뒤 만료).
    const opsAccessRequested = newAlarm('OpsAccessRequested', {
      alarmName: 'atmark-ops-access-requested',
      alarmDescription:
        '누군가 운영자 콘솔(ops.atmark.ai) 접근을 요청했다 — 메일 코드 검증을 통과한 새 요청(requested)이다. 콘솔의 운영자 탭에서 주소를 보고 ' +
        '아는 사람이면 승인(1회용 step-up + 대상 참조), 아니면 거절한다. 모르는 요청이 몰리면 docs/runbooks/ops-console.md 의 남용 절.',
      metric: opsCounter(OPS_METRIC_NAMES.accessRequested, cdk.Duration.minutes(5)),
    });

    // 30 — 승인·폐기(권한 지형 변화). 두 카운터를 FILL 로 0 채움해 더한다.
    const opsOperatorChanged = newAlarm('OpsOperatorChanged', {
      alarmName: 'atmark-ops-operator-changed',
      alarmDescription:
        '운영자 콘솔에서 운영자가 승인·거절되거나 폐기됐다. 본인이 한 일이 아니면 즉시 소프트 킬 스위치(pnpm admin:ops-operator --disable-console)를 걸고 ' +
        'ops_actions·ops_operator_events 에서 행위자 세션을 본다(docs/runbooks/ops-console.md 사고 절).',
      metric: new cloudwatch.MathExpression({
        expression: 'FILL(decided, 0) + FILL(revoked, 0)',
        usingMetrics: {
          decided: opsCounter(OPS_METRIC_NAMES.operatorDecided, cdk.Duration.minutes(5)),
          revoked: opsCounter(OPS_METRIC_NAMES.operatorRevoked, cdk.Duration.minutes(5)),
        },
        period: cdk.Duration.minutes(5),
        label: 'ops operators decided + revoked',
      }),
    });

    // 31 — 활성 운영자 수 증가(30 을 우회한 증가 포함). census 는 5분마다 → 결측 = 위반(6·7·28번과 같은 게이트).
    //   **DIFF 를 한 기간 창으로 평가하면 앞 점이 없어 늘 빈 값 → BREACHING → 영구 ALARM 이다**(G4 CR). 그래서 창을 두 기간으로 넓히고
    //   (`evaluationPeriods: 2` · `datapointsToAlarm: 1`), 창 첫 점의 빈 DIFF 는 0 으로 채운다. 결측(census 정지)은 식이 직접 1 로 만든다:
    //   `FILL(active, -1) < 0` — 그 기간에 census 가 없으면 -1 이 된다. 증가 한 번은 두 기간(≤ 10분) 동안 ALARM 이고 그 뒤 OK 로 돌아온다.
    const opsActiveOperatorsIncreased = newAlarm('OpsActiveOperatorsIncreased', {
      alarmName: 'atmark-ops-active-operators-increased',
      alarmDescription:
        '활성 운영자 수(ops_operator_census().active)가 늘었다 — 콘솔 승인이든 소유자 셸의 --add·--reinstate 든. 모르는 증가면 소프트 킬 스위치 뒤 ' +
        'pnpm admin:ops-operator --list 로 누가 언제 active 가 됐는지 본다. 결측(스위퍼 atmark-approval-expiry 정지·census 실패)도 위반으로 읽는다.',
      metric: new cloudwatch.MathExpression({
        expression: 'IF(FILL(active, -1) < 0, 1, FILL(DIFF(active), 0))',
        usingMetrics: { active: opsGauge(OPS_METRIC_NAMES.censusActive, cdk.Duration.minutes(5)) },
        period: cdk.Duration.minutes(5),
        label: 'ops active operators delta (1 = census missing)',
      }),
      threshold: 0,
      evaluationPeriods: 2,
      datapointsToAlarm: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      actionsEnabled: props.productionTrafficExpected,
    });

    // 32 — 코드 대입·주소 실패 누적·잠금(사전 부검 2). 셋 중 하나라도.
    const opsLoginAbuse = newAlarm('OpsLoginAbuse', {
      alarmName: 'atmark-ops-login-abuse',
      alarmDescription:
        `운영자 로그인 코드 불일치가 15분에 ${String(OPS_CODE_INVALID_THRESHOLD)}건 이상이거나, 오늘 코드 실패가 있는 주소가 ${String(OPS_FAILING_ADDRESSES_THRESHOLD)}개 이상이거나, 실패 누적으로 ` +
        '잠긴 주소(24시간 코드 발급 중지)가 있다. 운영자 본인의 오타가 아니면 대입 공격이다 — 잠긴 주소가 운영자면 확인 뒤 ' +
        'pnpm admin:ops-operator --unlock <email>. 로그인이 막히면 CLI·pnpm ops 가 break-glass 다(docs/runbooks/ops-console.md H12).',
      metric: new cloudwatch.MathExpression({
        expression:
          `IF(FILL(invalid, 0) >= ${String(OPS_CODE_INVALID_THRESHOLD)} OR FILL(locked, 0) >= 1 OR FILL(failing, 0) >= ${String(OPS_FAILING_ADDRESSES_THRESHOLD)}, 1, 0)`,
        usingMetrics: {
          invalid: opsCounter(OPS_METRIC_NAMES.codeInvalid, cdk.Duration.minutes(15)),
          locked: opsGauge(OPS_METRIC_NAMES.censusAddressesLocked, cdk.Duration.minutes(15)),
          failing: opsGauge(OPS_METRIC_NAMES.censusAddressesFailingToday, cdk.Duration.minutes(15)),
        },
        period: cdk.Duration.minutes(15),
        label: 'ops login abuse',
      }),
    });

    // 33 — 콘솔 특권 행위(되돌리기 어려운 쓰기). 차원 `action` 은 닫힌 값(`OpsAction`).
    const opsPrivilegedAction = newAlarm('OpsPrivilegedAction', {
      alarmName: 'atmark-ops-privileged-action',
      alarmDescription:
        '운영자 콘솔에서 조직을 거절했다(에이전트 정지 · 토큰 폐기가 함께 일어난다). 본인이 한 일이 아니면 소프트 킬 스위치 뒤 ops_actions 의 티켓과 ' +
        'ops_action_effects 로 대상과 효과를 본다. 되돌리기는 CLI(pnpm admin:org-review --org <id> --activate — 에이전트 운영자 정지는 따로 푼다)로 한다(docs/runbooks/ops-console.md).',
      metric: opsCounter(OPS_METRIC_NAMES.privilegedAction, cdk.Duration.minutes(5), { action: OPS_PRIVILEGED_ALARM_ACTION }),
    });

    // 34 — ops λ 오류·스로틀. 잠금(`atmark:opsLocked` → 예약 0) 중에는 모든 요청이 스로틀이라 운다(런북 — 잠금 중에는 예상된 상태).
    const opsLambdaHealth = newAlarm('OpsLambdaHealth', {
      alarmName: 'atmark-ops-lambda-health',
      alarmDescription:
        `운영자 콘솔 λ(${OPS_FUNCTION_NAME})의 오류가 5분에 ${String(OPS_LAMBDA_ERRORS_THRESHOLD)}건 이상이거나 스로틀이 ` +
        `${String(OPS_LAMBDA_THROTTLES_THRESHOLD)}건 이상이다. 오류면 로그(ops.*)의 error_code 를, 스로틀이면 예약 동시성(2 — 하드 잠금 중이면 0 이 정상)과 ` +
        '인증 라우트 홍수(H12 — 계정 전체 버킷)를 본다. 콘솔을 못 쓰면 CLI·pnpm ops 로 한다(docs/runbooks/ops-console.md).',
      metric: new cloudwatch.MathExpression({
        expression:
          `IF(FILL(errors, 0) >= ${String(OPS_LAMBDA_ERRORS_THRESHOLD)} OR FILL(throttles, 0) >= ${String(OPS_LAMBDA_THROTTLES_THRESHOLD)}, 1, 0)`,
        usingMetrics: { errors: lambdaMetric(OPS_FUNCTION_NAME, 'Errors'), throttles: lambdaMetric(OPS_FUNCTION_NAME, 'Throttles') },
        period: cdk.Duration.minutes(5),
        label: 'ops lambda errors or throttles',
      }),
    });

    // 35 — api λ 스로틀(예약 9 → 8, 2026-09-28). 스로틀은 에이전트에게 곧 503 이다.
    const apiThrottles = newAlarm('ApiThrottles', {
      alarmName: 'atmark-api-throttles',
      alarmDescription:
        `에이전트 API λ(atmark-${API_HANDLER})가 5분에 ${String(API_LAMBDA_THROTTLES_THRESHOLD)}번 이상 스로틀됐다 — 예약 동시성(8, 2026-09-28 에 9 → 8 · ` +
        'ADR-0015)이 모자라다. 에이전트는 503 을 받는다. 지속되면 DB 연결 예산(72/75 — compute-stack.ts 머리말)을 다시 나누는 결정이 필요하다.',
      metric: lambdaMetric(`atmark-${API_HANDLER}`, 'Throttles'),
      threshold: API_LAMBDA_THROTTLES_THRESHOLD,
    });

    // 36 — 운영자 코드 메일을 못 보낸다(사람이 고칠 사유만). go-live 전에는 자리표시가 정상 → `opsLive` 게이트.
    const skipIds = OPS_MAILER_SKIP_ALARM_REASONS.map((reason) => reason.replace(/[^a-z]/g, ''));
    const opsMailerSkipped = newAlarm('OpsMailerSkipped', {
      alarmName: 'atmark-ops-mailer-skipped',
      alarmDescription:
        `login-mailer 의 운영자 코드 워커가 메일을 건너뛰었다(사유 ${OPS_MAILER_SKIP_ALARM_REASONS.join('·')}) — 운영자가 로그인 코드를 받지 못한다. ` +
        'placeholder·key_invalid 면 atmark/ops-login-keys 값을, permission 이면 migrate status(atmark_login_mailer 의 ops 권한)를 본다. ' +
        '소유자 로그인·가입·초대 메일은 영향이 없다(docs/runbooks/ops-console.md).',
      metric: new cloudwatch.MathExpression({
        expression: skipIds.map((id) => `FILL(${id}, 0)`).join(' + '),
        usingMetrics: Object.fromEntries(
          OPS_MAILER_SKIP_ALARM_REASONS.map((reason, i) => [skipIds[i], opsCounter(OPS_METRIC_NAMES.mailerSkipped, cdk.Duration.minutes(15), { reason })]),
        ),
        period: cdk.Duration.minutes(15),
        label: 'ops mailer skipped (actionable reasons)',
      }),
      actionsEnabled: opsLive,
    });

    // 37 — 콘솔 쓰기가 티켓 가드(`zz_ops_require_ticket`)에 걸렸다: definer 안의 42501 → 500 `ticket_violation`. 코드 결함 신호라 1건이 곧 알람.
    //   게이트는 33(특권 행위)과 같다 — 없음(결측 = 사건 없음).
    const opsTicketViolation = newAlarm('OpsTicketViolation', {
      alarmName: 'atmark-ops-ticket-violation',
      alarmDescription:
        '운영자 콘솔의 쓰기(활성화·거절·운영자 결정·폐기)가 심층 방어 트리거 zz_ops_require_ticket 에 막혔다 — 티켓 없는(또는 다른 조직의 티켓을 쥔) ' +
        'atmark_ops 도메인 쓰기. definer 를 거치면 일어날 수 없으므로 코드 결함이다. 소프트 킬 스위치(pnpm admin:ops-operator --disable-console) 뒤 ' +
        '같은 조직은 CLI 로 처리하고, atmark-ops 로그 ops.ticket_violation 과 ops_actions(kind=failure)로 재현한다(docs/runbooks/ops-console.md §7).',
      metric: opsCounter(OPS_METRIC_NAMES.writeFailed, cdk.Duration.minutes(5), { code: OPS_TICKET_VIOLATION_CODE }),
    });

    // ── 알람 38~44 — 고객 도메인(ADR-0014 단계 2). 차원 없는 EMF(`DOMAIN_METRIC_NAMES`) — 방출은 확인 틱(단계 4) ─────────────────────
    const domainRecheckEnabled = domainRecheckEnabledOf(this.node);

    // 38 — 확인 인프라 오류(소유권 상실로 세지 않는 error) 누적 · 사가가 다른 행의 identity 를 만났다(1건이 곧 운영자 판단).
    const domainCheckErrors = newAlarm('DomainCheckErrors', {
      alarmName: 'atmark-domain-check-errors',
      alarmDescription:
        `고객 도메인 확인이 30분에 ${String(DOMAIN_CHECK_ERRORS_THRESHOLD)}건 이상 인프라 오류(error — 권한 NS 무응답·비권한 응답·SES·RDAP 오류)를 냈거나, ` +
        '생성 사가가 다른 행이 태그한 identity 를 만났다(identity_owned_elsewhere — 사가 중단, 행은 verifying). 오류면 로그 domain.check 의 errorCode 를 ' +
        '본다(error 는 정지 사유로 세지 않는다 — NAT·리졸버 장애면 기다린다). owned_elsewhere 면 그 태그의 행(제거 사가가 끝나기를 기다리는지 · 태그 없는 ' +
        '수동 identity 인지)을 보고 운영자가 정한다(docs/runbooks/custom-domains.md).',
      metric: new cloudwatch.MathExpression({
        expression: `IF(FILL(errors, 0) >= ${String(DOMAIN_CHECK_ERRORS_THRESHOLD)} OR FILL(elsewhere, 0) >= 1, 1, 0)`,
        usingMetrics: {
          errors: custom(DOMAIN_METRIC_NAMES.checkError, 'Sum', cdk.Duration.minutes(30)),
          elsewhere: custom(DOMAIN_METRIC_NAMES.identityOwnedElsewhere, 'Sum', cdk.Duration.minutes(30)),
        },
        period: cdk.Duration.minutes(30),
        label: 'domain check errors or identity owned elsewhere',
      }),
    });

    // 39 — 밀린 확인(next_check_at 이 1시간 넘게 지난 행)이 1시간 내내 0 보다 컸거나, 틱이 아예 값을 내지 않았다(결측 = 위반 — 사전 부검 2).
    const domainCheckStale = newAlarm('DomainCheckStale', {
      alarmName: 'atmark-domain-check-stale',
      alarmDescription:
        '고객 도메인 확인 틱이 밀렸거나(due_backlog 가 1시간 내내 0 보다 큼 — 재확인 용량 R × 36 을 넘었다) 멈췄다(1시간 동안 값이 없다 — Scheduler ' +
        'atmark-domain-recheck · admin λ 오류·스로틀). 멈춘 동안 소유권을 잃은 도메인이 계속 보낸다. Scheduler 상태와 admin 로그(domain.backlog)를 보고, ' +
        `밀림이면 R·주기를 다시 정한다(런북). 액션은 ${DOMAIN_RECHECK_ENABLED_CONTEXT_KEY} 와 같이 켜진다.`,
      metric: custom(DOMAIN_METRIC_NAMES.dueBacklog, 'Minimum', cdk.Duration.hours(1)),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      actionsEnabled: domainRecheckEnabled,
    });

    const domainReputationFreeze = counterAlarm(
      'DomainReputationFreeze',
      'atmark-domain-reputation-freeze',
      DOMAIN_METRIC_NAMES.reputationFlagged,
      cdk.Duration.hours(1),
      '고객 도메인 하나가 평판 경고선(complaint 0.05%·2건 · bounce 윌슨 하한 2%) 또는 동결선(0.08%·3건 · 3% · 계정 기여분)을 넘었다(J6). 동결이면 그 도메인은 ' +
        'suspended(reputation) — 운영자만 푼다. 로그 domain.reputation 의 domainId·window 로 조직을 찾고 발송 목록의 출처를 본다. 계정 bounce·complaint 알람(4·5)과 함께 본다.',
    );
    const platformReputationFreeze = counterAlarm(
      'PlatformReputationFreeze',
      'atmark-platform-reputation-freeze',
      METRIC_NAMES.platformReputationFlagged,
      cdk.Duration.hours(1),
      '공유 도메인(atmark.ai) 조직 하나가 평판 경고선(신고자 2명·0.05% · 영구 bounce 5·윌슨 하한 2%) 또는 동결선(전달 50 이상에서 신고자 3명·도메인 계열 2·0.08% · ' +
        'bounce 10·3% · 계정 기여분)을 넘었다(수신자 단위). 동결이면 그 조직은 abuse_freeze — 운영자만 푼다(admin:kill-switch --org <id> off --reason … 또는 운영자 웹). ' +
        'freeze_exempt = 운영자 예약 주소 조직 · freeze_deferred = 서열기 능력 없음(deploy §54) — 얼리지 않았다, 사람이 판단한다. 응답 목표: 업무 시간 4시간 · 최대 24시간. ' +
        '로그 ses_event.platform_reputation 의 organization_id·reasons, ' +
        'owner_actions(org.abuse_freeze)를 본다(docs/runbooks/admin.md §3-10). 계정 bounce·complaint 알람(4·5)과 함께 본다.',
    );
    const platformReputationCheckFailed = counterAlarm(
      'PlatformReputationCheckFailed',
      'atmark-platform-reputation-check-failed',
      METRIC_NAMES.platformReputationCheckFailed,
      cdk.Duration.hours(1),
      '공유 도메인 조직 평판 판정(atmark_platform_reputation_check)이 던졌다 — 이벤트 기록은 됐고 SQS 가 재전달해 판정만 다시 돈다. 계속 실패하면 ' +
        'ses-events DLQ(알람 12)로 가고 그동안 자동 동결이 멈춘다. 로그 ses_event.platform_reputation_failed 의 error_code(SQLSTATE)를 본다 — 42883·42501 이면 ' +
        '마이그레이션 202610131620 · 앱 롤 EXECUTE 를 확인한다(migrate status).',
    );
    const domainInboundNoisy = counterAlarm(
      'DomainInboundNoisy',
      'atmark-domain-inbound-noisy',
      METRIC_NAMES.inboundUnknownCustomDomain,
      cdk.Duration.hours(1),
      '고객 도메인(atmark.ai 밖)의 모르는 수신자(unknown_recipient) 메일이 1시간에 500건 이상이다(모든 고객 도메인 합). SES 층 차단은 identity 삭제뿐이라 ' +
        '자동화하지 않는다 — inbound_rejections(reason=unknown_recipient, 최근 1시간)의 봉투 수신자 도메인으로 조직을 찾아 알리고 필요하면 정지한다(docs/runbooks/custom-domains.md).',
      NOISY_INBOUND_HOURLY_THRESHOLD,
    );
    const domainMxConflict = counterAlarm(
      'DomainMxConflict',
      'atmark-domain-mx-conflict',
      DOMAIN_METRIC_NAMES.mxConflict,
      cdk.Duration.hours(1),
      'verified 고객 도메인의 MX 가 SES 수신 엔드포인트 밖을 가리킨다 — 그 서브도메인의 메일이 우리에게 오지 않는다(사람 메일 피해는 없다). 콘솔이 경고를 ' +
        '보이고, 고객이 MX 를 되돌리거나 도메인을 제거한다. 로그 domain.check 의 mx=other.',
    );
    const domainPolicyDrift = counterAlarm(
      'DomainPolicyDrift',
      'atmark-domain-policy-drift',
      DOMAIN_METRIC_NAMES.policyDrift,
      cdk.Duration.minutes(15),
      '고객 identity 의 identity policy 가 기대(발송 역할 하나 · 발급 주소 StringEquals)와 달랐다 — 덮어쓰고 그 도메인을 suspended(operator)로 멈췄다. ' +
        '누가 바꿨는지 CloudTrail(atmark-ses-identity-change-outside-control 알림)에서 찾고, domain-control 탈취가 의심되면 런북 "domain-control 탈취" 절(봉쇄 → 정책 일괄 삭제).',
    );
    const domainPolicyTooLarge = counterAlarm(
      'DomainPolicyTooLarge',
      'atmark-domain-policy-too-large',
      DOMAIN_METRIC_NAMES.policyTooLarge,
      cdk.Duration.minutes(15),
      '고객 도메인의 발급 주소가 identity policy 20개(4,000바이트씩)에 들어가지 않는다 — 기존 정책을 그대로 두고 동기화를 미뤘다(새 주소는 SES 가 거부). ' +
        '발급 천장(customDomainAddressCeiling)이 먼저 막으므로 정상 경로에서는 나지 않는다 — 천장 계산·발급 가드를 본다.',
    );

    // 45 — 독립 감사(읽기 전용 λ — 보안 리뷰 M2)가 계약 모양이 아닌 자원 정책을 찾았다. 1건이 곧 사고 신호(정책이 넓어졌다).
    const domainPolicyShape = counterAlarm(
      'DomainPolicyShape',
      'atmark-domain-policy-shape',
      DOMAIN_METRIC_NAMES.policyShapeViolation,
      cdk.Duration.minutes(15),
      '읽기 전용 감사 λ(atmark-domain-policy-audit)가 SES identity 자원 정책 중 계약 모양(발송 역할 하나 · Send 둘 · 그 identity · StringEquals 발급 주소)이 ' +
        '아니거나 플랫폼 identity 에 붙은 정책을 찾았다. 로그 domain_policy_audit.result 의 problems 를 보고 scripts/check-ses-principals.sh 로 identity 를 찾는다 — ' +
        '의도하지 않은 정책이면 docs/runbooks/custom-domains.md §2(봉쇄).',
    );

    // 46·47 — 고객 도메인 λ 둘의 오류(재검증 MEDIUM-2 — 감사가 던지면 위반 메트릭이 없어 45 가 조용하다). 5분 1건이 곧 알람.
    const domainLambdaErrors = (id: string, alarmName: string, functionName: string, description: string): cloudwatch.Alarm =>
      newAlarm(id, {
        alarmName,
        alarmDescription: description,
        metric: lambdaMetric(functionName, 'Errors'),
      });
    const domainControlErrors = domainLambdaErrors(
      'DomainControlErrors',
      'atmark-domain-control-errors',
      DOMAIN_CONTROL_FUNCTION_NAME,
      `고객 도메인 제어면 λ(${DOMAIN_CONTROL_FUNCTION_NAME})가 던졌다 — 입력이 계약 밖(엄격 파싱 거부)이거나 기동 실패(SENDER_ROLE_ARN·리전). 틱은 아무것도 바꾸지 않고 ` +
        '끝난다(닫힌 쪽). 로그의 DomainControlInputError·RuntimeConfigError 를 본다 — 입력 거부가 이어지면 admin 쪽 결함 또는 탈취를 의심한다.',
    );
    const domainPolicyAuditErrors = domainLambdaErrors(
      'DomainPolicyAuditErrors',
      'atmark-domain-policy-audit-errors',
      DOMAIN_POLICY_AUDIT_FUNCTION_NAME,
      `자원 정책 독립 감사 λ(${DOMAIN_POLICY_AUDIT_FUNCTION_NAME})가 던졌다 — identity 목록을 못 읽었거나(권한·SES 장애) 입력이 계약 밖이다. 그동안 정책 위반(45)은 ` +
        '보이지 않는다 — 원인을 고친 뒤 {"source":"atmark.schedule"} 로 한 번 돌리고 scripts/check-ses-principals.sh 로 손 대조한다.',
    );
    const riskHoldsAgentHourly = newAlarm('RiskHoldsAgentHourly', {
      alarmName: 'atmark-risk-holds-agent-hourly',
      alarmDescription:
        `한 에이전트의 위험 보류(오염 맥락 · 발신 DLP — ADR-0016)가 1시간에 ${String(RISK_HOLDS_AGENT_HOURLY_THRESHOLD)}번 이상이다(api 로그 ` +
        `${ALARM_LOG_EVENTS.riskHold}, 강제 held · 관찰 observed 합산). 받은 메일의 지시로 에이전트가 새 상대에게 반복해 쓰려 하거나, 소유자에게 승인 메일이 ` +
        `쏟아지는 중이다. Contributor Insights 규칙 ${INSIGHT_RULE_NAMES.riskHoldsByAgent} 에서 agent_id 를 보고, audit_logs 의 reasons(tainted_context · dlp_*)와 ` +
        'agent_exposures(최근 T2 노출)를 확인한 뒤 소유자와 이야기한다. 필요하면 소유자가 에이전트를 멈춘다(운영자는 보류된 메일을 승인하지 않는다).',
      metric: topContributor(INSIGHT_RULE_NAMES.riskHoldsByAgent, cdk.Duration.hours(1), 'risk holds — top agent'),
      threshold: RISK_HOLDS_AGENT_HOURLY_THRESHOLD,
    });
    riskHoldsAgentHourly.node.addDependency(riskHoldRule);

    // 50 — Atmark 자격 증명이 발송 본문에 실렸다(ADR-0016 B · dlp_atmark_credential). 차원 reason 하나로 낸다(`outbound-service.ts`).
    const dlpAtmarkCredential = newAlarm('DlpAtmarkCredential', {
      alarmName: 'atmark-dlp-atmark-credential',
      alarmDescription:
        '발신 DLP 가 발송 내용에서 Atmark 자격 증명(atk_ API 키 · whsec_ 웹훅 비밀 · 서명 링크 토큰)을 찾았다 — 메일은 소유자 승인 대기다(가장 강한 경고). ' +
        '로그 outbound.dlp(reason=dlp_atmark_credential)의 agent_id · trace_id 로 audit_logs 를 보고, 소유자에게 키 교체를 권한다. 값은 어디에도 기록되지 않는다.',
      metric: new cloudwatch.Metric({
        namespace: METRIC_NAMESPACE,
        metricName: METRIC_NAMES.dlpFindings,
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
        dimensionsMap: { reason: 'dlp_atmark_credential' },
      }),
    });

    // 51 — 노출 기록 실패(ADR-0016 A — 읽기 라우트 fail closed 503). 에이전트가 받은 메일을 읽지 못하고 있다.
    const exposureWriteFailed = newAlarm('ExposureWriteFailed', {
      alarmName: 'atmark-exposure-write-failed',
      alarmDescription:
        '읽기 라우트(상세 · 스레드 · 첨부 · 인증 코드)가 노출을 기록하지 못해 503 을 돌려줬다(fail closed — 기록 없이 본문을 주지 않는다). 에이전트가 받은 메일을 ' +
        '읽지 못한다. 로그 exposure.write_failed(atmark-api)의 error_kind 를 보고 DB(agent_exposures · agent_code_fingerprints 권한 · 트리거)와 ' +
        'DLP 키 비밀(atmark/dlp-keys)을 확인한다.',
      metric: custom(METRIC_NAMES.exposureWriteFailed, 'Sum', cdk.Duration.minutes(5)),
    });

    // 52 — DLP 지문 키를 보존 기간보다 일찍 뺐다(ADR-0016 리뷰 L1 · 키링 운영 계약). 비교하지 못한 지문이 하나라도 있으면.
    const dlpDroppedFingerprints = newAlarm('DlpDroppedFingerprints', {
      alarmName: 'atmark-dlp-dropped-fingerprints',
      alarmDescription:
        '발신 DLP 가 키 묶음에 없는 kid 의 지문을 비교하지 못했다 — atmark/dlp-keys 에서 옛 키를 지문 보존 기간(복사 30일 · 코드 24시간)보다 일찍 뺐다. ' +
        '그 지문의 메일 복사·코드 유출은 보이지 않는다. 옛 키를 키 묶음 뒤에 되돌려 넣는다(런북 deploy §39 "키 회전"). 로그 outbound.dlp_fingerprints_dropped.',
      metric: custom(METRIC_NAMES.dlpDroppedFingerprints, 'Sum', cdk.Duration.hours(1)),
    });

    // 48 — 감사 하트비트 결측(재검증 MEDIUM-2). 12시간마다 전수가 하트비트를 낸다 — 하루(경보 평가 상한) 동안 한 번도 없으면 위반.
    const domainPolicyAuditSilence = newAlarm('DomainPolicyAuditSilence', {
      alarmName: 'atmark-domain-policy-audit-silence',
      alarmDescription:
        '자원 정책 독립 감사의 정기 전수(12시간마다)가 하루 동안 하트비트를 내지 않았다 — Scheduler atmark-domain-policy-audit · 감사 λ 오류·스로틀을 본다. ' +
        '멈춘 동안 넓혀진 정책은 이벤트 감사에만 기댄다. 고친 뒤 {"source":"atmark.schedule"} 로 한 번 돌린다.',
      metric: custom(DOMAIN_METRIC_NAMES.policyAuditAudited, 'SampleCount', cdk.Duration.days(1)),
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });

    // 53 — 활성 identity 관리자 수(2026-10 one-shot · 설계 §2.1). 소유 증명 전(pending)에도 SES identity 를 만들므로 증명 없는 추가가 리전 identity
    //   할당량(10,000)을 먹을 수 있다 — 상한(기능 허용 목록 · 조직 pending 2 · 하루 추가 10 · 72시간 만료)이 막아야 하는 값이 10% 를 넘으면 사람이 본다.
    //   틱이 매번 낸다(0 이어도). 결측은 틱 정지(39 가 따로 본다) — 여기서는 위반으로 읽지 않는다.
    const domainIdentitiesHeld = newAlarm('DomainIdentitiesHeld', {
      alarmName: 'atmark-domain-identities-held',
      alarmDescription:
        `고객 도메인의 SES identity(활성 관리자 행 — DB identity_claimed_at 있음 · 놓지 않음)가 ${String(IDENTITIES_HELD_ALARM_THRESHOLD)} 개를 넘었다 — 리전 ` +
        'identity 할당량 10,000 의 10%. 한 번에 설정(2026-10)은 소유 증명 전에도 identity 를 만든다. 로그 domain.backlog 의 claims · identities_held 와 ' +
        'custom_domains 의 pending 관리자 행을 조직별로 세어 한 조직의 반복 추가인지 본다 — 그렇다면 기능 허용 목록에서 빼고(pnpm admin:feature --org <id> --disable custom_domains) ' +
        '72시간 만료 · 제거 사가가 정리하기를 기다린다. 정상 성장이면 SES 할당량 증액을 요청한다(docs/runbooks/custom-domains.md).',
      metric: custom(DOMAIN_METRIC_NAMES.identitiesHeld, 'Maximum', cdk.Duration.hours(1)),
      threshold: IDENTITIES_HELD_ALARM_THRESHOLD,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });

    // ── 54~61 — AI 의심 메일 감시(ADR-0017 초안 · 설계 §2.4) ─────────────────────────────────────────────────────────────────
    const aiWatchAlarmsLive = contextFlagOf(this.node, AI_WATCH_ALARMS_LIVE_CONTEXT_KEY, AI_WATCH_ALARMS_LIVE_DEFAULT);
    const aiWatchRunbook = 'docs/runbooks/ai-watch.md §9';
    // 54 — 요청 큐가 밀린다(Mac 이 당겨 가지 않는다). 5분 중 3분.
    const aiWatchQueueAge = newAlarm('AiWatchQueueAge', {
      alarmName: 'atmark-ai-watch-queue-age',
      alarmDescription:
        `${AI_WATCH_QUEUES.request} 의 가장 오래된 메시지가 ${String(AI_WATCH_QUEUE_AGE_SECONDS)}초를 넘었다(5분 중 3분) — Mac 워커가 당겨 가지 않는다(잠자기 · 네트워크 · ` +
        `키 · 일시 정지). 메일은 30초 뒤 판정 없이 전달된다(fail-skip). ${aiWatchRunbook}.`,
      metric: new cloudwatch.Metric({
        namespace: 'AWS/SQS',
        metricName: 'ApproximateAgeOfOldestMessage',
        dimensionsMap: { QueueName: AI_WATCH_QUEUES.request },
        statistic: 'Maximum',
        period: cdk.Duration.minutes(1),
      }),
      threshold: AI_WATCH_QUEUE_AGE_SECONDS,
      evaluationPeriods: 5,
      datapointsToAlarm: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      actionsEnabled: aiWatchAlarmsLive,
    });
    // 55 — 하트비트 침묵(결측 = 위반). 결과 λ 가 유효 하트비트마다 1 을 낸다.
    const aiWatchHeartbeatSilence = newAlarm('AiWatchHeartbeatSilence', {
      alarmName: 'atmark-ai-watch-heartbeat-silence',
      alarmDescription:
        `AI 감시 워커의 하트비트가 ${String(AI_WATCH_HEARTBEAT_SILENCE_MINUTES)}분 동안 없다 — Mac Studio 가 꺼졌거나 잤거나 워커가 죽었다(launchd 재시작 반복 · 키체인 키 없음). ` +
        `inbound 는 5분 뒤부터 보류 없이 기록한다. ${aiWatchRunbook}.`,
      metric: custom(METRIC_NAMES.aiWatchHeartbeat, 'Sum', cdk.Duration.minutes(AI_WATCH_HEARTBEAT_SILENCE_MINUTES)),
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      actionsEnabled: aiWatchAlarmsLive,
    });
    // 56 — 자기 시험 실패 하트비트(모델 무결성 · 골든 24 불일치). 워커는 작업을 받지 않는다.
    const aiWatchSelfTestFail = newAlarm('AiWatchSelfTestFail', {
      alarmName: 'atmark-ai-watch-self-test-fail',
      alarmDescription:
        'AI 감시 워커가 self_test:"fail" 하트비트를 보냈다 — 모델 파일이 models.lock 과 다르거나 골든 24 가 어긋났다. 작업을 받지 않는다(전부 fail-skip). ' +
        `직전 모델로 되돌린다(setup.sh --model <이전 버전>). ${aiWatchRunbook}.`,
      metric: custom(METRIC_NAMES.aiWatchSelfTestFail, 'Sum', cdk.Duration.minutes(15)),
    });
    // 57 — 판정 지연 p95(5분 중 3).
    const aiWatchVerdictLatency = newAlarm('AiWatchVerdictLatency', {
      alarmName: 'atmark-ai-watch-verdict-latency',
      alarmDescription:
        `AI 감시 판정 지연 p95 가 ${String(AI_WATCH_VERDICT_LATENCY_P95_MS / 1000)}초를 넘었다(5분 중 3) — 목표 p95 3초. Mac 부하(CI VM 과 겹침) · 큐 밀림 · 결과 λ 스로틀을 본다. ` +
        `${aiWatchRunbook}.`,
      metric: custom(METRIC_NAMES.aiWatchVerdictLatencyMs, 'p95', cdk.Duration.minutes(5)),
      threshold: AI_WATCH_VERDICT_LATENCY_P95_MS,
      evaluationPeriods: 5,
      datapointsToAlarm: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });
    // 58 — fail-skip 률(1시간) = 1 − 마감 안 판정(verdicts{outcome=ontime}) / 보낸 작업(enqueued). 작업이 적은 시간은 0.
    const aiWatchFailSkipRate = newAlarm('AiWatchFailSkipRate', {
      alarmName: 'atmark-ai-watch-fail-skip-rate',
      alarmDescription:
        `AI 감시 fail-skip 률이 1시간 동안 ${String(AI_WATCH_FAIL_SKIP_RATE * 100)}% 를 넘었다(작업 ${String(AI_WATCH_FAIL_SKIP_MIN_ENQUEUED)}건 이상인 시간만) — 마감 30초 안에 판정이 오지 ` +
        `않은 메일은 경고 없이 전달됐다. Mac 가용성 · 지연을 본다. ${aiWatchRunbook}.`,
      metric: new cloudwatch.MathExpression({
        expression: `IF(FILL(enqueued, 0) >= ${String(AI_WATCH_FAIL_SKIP_MIN_ENQUEUED)}, 1 - FILL(ontime, 0) / enqueued, 0)`,
        usingMetrics: {
          enqueued: custom(METRIC_NAMES.aiWatchEnqueued, 'Sum', cdk.Duration.hours(1)),
          ontime: new cloudwatch.Metric({
            namespace: METRIC_NAMESPACE,
            metricName: METRIC_NAMES.aiWatchVerdicts,
            dimensionsMap: { outcome: 'ontime' },
            statistic: 'Sum',
            period: cdk.Duration.hours(1),
          }),
        },
        period: cdk.Duration.hours(1),
        label: 'ai watch fail-skip rate',
      }),
      threshold: AI_WATCH_FAIL_SKIP_RATE,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      actionsEnabled: aiWatchAlarmsLive,
    });
    // 59 — 요청 큐 송신 실패(inbound). 그 메일은 보류 없이 전달됐다.
    const aiWatchEnqueueFailed = newAlarm('AiWatchEnqueueFailed', {
      alarmName: 'atmark-ai-watch-enqueue-failed',
      alarmDescription:
        `inbound 가 ${AI_WATCH_QUEUES.request} 에 작업을 보내지 못했다 — 큐 없음(AtmarkAiWatch 미배포) · KMS 키 정책 · IAM. 그 메일은 판정 없이 전달됐다. ${aiWatchRunbook}.`,
      metric: custom(METRIC_NAMES.aiWatchEnqueueFailed, 'Sum', cdk.Duration.minutes(15)),
    });
    // 60 — 결과 거부(스키마 · 모르는 키 · 밴드 불일치) — 위조 · 버전 불일치의 흔적.
    const aiWatchResultRejected = newAlarm('AiWatchResultRejected', {
      alarmName: 'atmark-ai-watch-result-rejected',
      alarmDescription:
        '결과 λ 가 결과 큐 메시지를 계약 위반으로 버렸다 — 워커와 서버의 계약 판이 다르거나(배포 순서) 누군가 결과 큐에 위조 메시지를 넣었다(Mac 키 유출 의심 — ' +
        `차원 reason 을 본다 · 키 회전). ${aiWatchRunbook}.`,
      metric: custom(METRIC_NAMES.aiWatchResultRejected, 'Sum', cdk.Duration.hours(1)),
    });
    // 61 — 결과 DLQ(본문 없음 — 판정·하트비트뿐). 결과 λ 가 DB 일시 장애로 3번 실패했다.
    const aiWatchResultDlqDepth = dlqDepth(
      'AiWatchResultDlqDepth',
      'atmark-ai-watch-result-dlq-depth',
      AI_WATCH_QUEUES.resultDlq,
      `${AI_WATCH_QUEUES.resultDlq} 에 메시지가 있다 — 결과 λ(atmark-ai-watch-result)가 판정을 3번 기록하지 못했다(DB · 롤 · 비밀). 본문은 없다(판정 · 하트비트). ` +
        `10분 넘은 판정은 어차피 버려지므로 원인만 고치고 비운다. ${aiWatchRunbook}.`,
    );

    this.alarms = [
      auditResolveFailed,
      warmupCapBreached,
      serializationUnavailable,
      bounceRate,
      complaintRate,
      gateSilence,
      pendingOverdue,
      contactRateGlobal,
      contactForwardBlocked,
      sesFromMismatch,
      snippetRetentionStuck,
      sesEventDlqDepth,
      inboundDlqDepth,
      privacyErasureBacklog,
      billingDlqDepth,
      billingWebhookRejected,
      billingSyncFailed,
      billingProviderAuthFailed,
      billingUnknownPrice,
      billingUnboundSubscription,
      billingEntitlementHeld,
      billingWebhookMissed,
      billingReconcileOrgFailed,
      webhookDeadRatio,
      sesEventsLag,
      verificationLookupsAgentDaily,
      scheduledCancelsAgentHourly,
      billingReconcileStale,
      opsAccessRequested,
      opsOperatorChanged,
      opsActiveOperatorsIncreased,
      opsLoginAbuse,
      opsPrivilegedAction,
      opsLambdaHealth,
      apiThrottles,
      opsMailerSkipped,
      opsTicketViolation,
      domainCheckErrors,
      domainCheckStale,
      domainReputationFreeze,
      platformReputationFreeze,
      platformReputationCheckFailed,
      domainInboundNoisy,
      domainMxConflict,
      domainPolicyDrift,
      domainPolicyTooLarge,
      domainPolicyShape,
      domainControlErrors,
      domainPolicyAuditErrors,
      domainPolicyAuditSilence,
      riskHoldsAgentHourly,
      dlpAtmarkCredential,
      exposureWriteFailed,
      dlpDroppedFingerprints,
      domainIdentitiesHeld,
      aiWatchQueueAge,
      aiWatchHeartbeatSilence,
      aiWatchSelfTestFail,
      aiWatchVerdictLatency,
      aiWatchFailSkipRate,
      aiWatchEnqueueFailed,
      aiWatchResultRejected,
      aiWatchResultDlqDepth,
    ];

    for (const alarm of this.alarms) {
      alarm.addAlarmAction(new actions.SnsAction(this.alarmTopic));
      // 복구도 알린다. 복구 통지가 없으면 "아직 울리고 있는가" 를 콘솔에 들어가야
      // 알 수 있고, 그 마찰이 곧 알람을 무시하는 습관이 된다.
      alarm.addOkAction(new actions.SnsAction(this.alarmTopic));
    }

    // ── CloudTrail 관리 이벤트 트레일 하나(ADR-0014 결정 15 · 스파이크 S5 — 계정에 트레일 0개) ─────────────────────────────
    // 첫 사본 관리 이벤트는 CloudTrail 요금이 없다. S3 는 90일 뒤 지운다(월 $1 미만). 데이터 이벤트·Insights·CloudWatch Logs 전송은 켜지 않는다.
    //   아래 EventBridge 규칙의 전제다 — "AWS API Call via CloudTrail" 이벤트는 활성 트레일이 있어야 기본 버스로 온다.
    const trailBucket = new s3.Bucket(this, 'ManagementTrailBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      // 삭제 보호(보안 리뷰 L6) — Object Lock 거버넌스 90일: 계정 자격이 새어도 보존 기간 안의 기록을 지우거나 덮지 못한다(거버넌스 우회 권한
      //   `s3:BypassGovernanceRetention` 은 아무 역할에도 없다). Object Lock 은 버킷을 **만들 때만** 켤 수 있다 — 이 버킷은 아직 없다(M1 첫 배포).
      //   수명주기: 90일에 삭제 표시 → 이전 버전 1일 뒤 삭제(그때는 보존 기간이 끝났다). 비용은 버전 하루치 — 무시할 만하다.
      objectLockEnabled: true,
      objectLockDefaultRetention: s3.ObjectLockRetention.governance(cdk.Duration.days(MANAGEMENT_TRAIL_RETENTION_DAYS)),
      lifecycleRules: [
        {
          id: 'expire-management-events',
          expiration: cdk.Duration.days(MANAGEMENT_TRAIL_RETENTION_DAYS),
          noncurrentVersionExpiration: cdk.Duration.days(1),
        },
      ],
      // 감사 기록이다 — 스택을 지워도 남긴다(수명주기가 90일 뒤 비운다).
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    new cloudtrail.Trail(this, 'ManagementTrail', {
      trailName: MANAGEMENT_TRAIL_NAME,
      bucket: trailBucket as s3.IBucket,
      managementEvents: cloudtrail.ReadWriteType.ALL,
      isMultiRegionTrail: true,
      includeGlobalServiceEvents: true,
      enableFileValidation: true,
      sendToCloudWatchLogs: false,
    });

    // ── domain-control 밖의 SES identity 변경 → 같은 토픽(계획 §3.5 "CloudTrail") ─────────────────────────────────────────
    // 기준은 호출자 ARN(`detail.userIdentity.arn`) — IAM 사용자·루트·다른 역할 세션은 모두 이 칸이 있다. domain-control 의 세션은
    //   `arn:aws:sts::<계정>:assumed-role/atmark-runtime-domain-control/<세션>` 이고 그 접두사만 뺀다(`anything-but` 접두사).
    const sesChangeNames = [
      ...SES_IDENTITY_CHANGE_EVENT_PREFIXES.map((prefix) => ({ prefix })),
      ...SES_IDENTITY_CHANGE_EVENT_WILDCARDS.map((wildcard) => ({ wildcard })),
      ...SES_IDENTITY_CHANGE_EVENT_NAMES,
    ];
    const sesChangeTarget = (): eventTargets.SnsTopic =>
      new eventTargets.SnsTopic(this.alarmTopic, {
        // 요청 파라미터(정책 원문·주소)는 싣지 않는다 — 무엇을 · 누가(ARN 또는 종류) · 언제만. 원문은 CloudTrail 에서 본다.
        message: events.RuleTargetInput.fromText(
          `SES identity 변경이 domain-control 밖에서 일어났다(ADR-0014): ${events.EventField.fromPath('$.detail.eventName')} by ` +
            `${events.EventField.fromPath('$.detail.userIdentity.type')} ${events.EventField.fromPath('$.detail.userIdentity.arn')} at ${events.EventField.fromPath('$.detail.eventTime')}. ` +
            'CloudTrail 이벤트 기록에서 요청 파라미터를 보고, 의도하지 않은 변경이면 docs/runbooks/custom-domains.md §2(봉쇄).',
        ),
      });
    const sesChangeDetail = { eventSource: ['ses.amazonaws.com'], eventName: sesChangeNames };
    // ① 역할 세션·사용자·루트 — 호출자 ARN 이 domain-control 역할 세션이 아니면.
    new events.Rule(this, 'SesIdentityChangeOutsideControl', {
      ruleName: SES_IDENTITY_CHANGE_RULE_NAME,
      description: 'SES identity/policy/tag/configuration-set changes made outside the domain-control role (ADR-0014) - CloudTrail management events',
      eventPattern: {
        source: ['aws.ses'],
        detailType: ['AWS API Call via CloudTrail'],
        detail: { ...sesChangeDetail, userIdentity: { arn: [{ 'anything-but': { prefix: `arn:aws:sts::${this.account}:assumed-role/${DOMAIN_CONTROL_ROLE_NAME}/` } }] } },
      },
      targets: [sesChangeTarget()],
    });
    // ③ 태그 쓰기·지우기는 **호출자와 무관하게**(domain-control 포함 — 재검증 LOW-1): 태그가 IAM 의 경계(관리 표시)이자 소유(atmark:row)라 채택 한 번도
    //   사람이 본다(양도는 드물다).
    new events.Rule(this, 'SesIdentityTagChange', {
      ruleName: SES_IDENTITY_TAG_RULE_NAME,
      description: 'Any SES TagResource/UntagResource (including domain-control) - identity tags are the IAM boundary (ADR-0014)',
      eventPattern: {
        source: ['aws.ses'],
        detailType: ['AWS API Call via CloudTrail'],
        detail: { eventSource: ['ses.amazonaws.com'], eventName: ['TagResource', 'UntagResource'] },
      },
      targets: [sesChangeTarget()],
    });
    // ② ARN 칸이 없을 수 있는 호출자 종류(AWSService · AWSAccount · Unknown 등) — ARN 이 늘 있는 종류(① 이 본다)는 빼서 알림이 겹치지 않게.
    new events.Rule(this, 'SesIdentityChangeNonRoleCaller', {
      ruleName: SES_IDENTITY_CHANGE_NON_ROLE_RULE_NAME,
      description: 'SES identity/policy/tag/configuration-set changes by a caller type without an ARN field (AWSService, AWSAccount, ...) (ADR-0014)',
      eventPattern: {
        source: ['aws.ses'],
        detailType: ['AWS API Call via CloudTrail'],
        detail: { ...sesChangeDetail, userIdentity: { type: [{ 'anything-but': [...SES_CHANGE_ARN_BEARING_TYPES] }] } },
      },
      targets: [sesChangeTarget()],
    });

    // ── AI 감시 Mac IAM 사용자의 예상 밖 호출(설계 §2.4 — CloudWatch 권한을 주지 않으므로 CloudTrail 로 본다) ─────────────────────────
    //   SQS 데이터 호출은 관리 이벤트가 아니라 트레일에 없다 — 여기 오는 것은 그 밖의 서비스 호출(키 유출 뒤 정찰 · 권한 상승 시도)과 오류다.
    const aiWatchUserArn = `arn:aws:iam::${this.account}:user/${AI_WATCH_IAM_USER}`;
    const aiWatchUserTarget = (): eventTargets.SnsTopic =>
      new eventTargets.SnsTopic(this.alarmTopic, {
        message: events.RuleTargetInput.fromText(
          `AI 감시 Mac IAM 사용자(${AI_WATCH_IAM_USER})의 예상 밖 호출: ${events.EventField.fromPath('$.detail.eventSource')} ` +
            `${events.EventField.fromPath('$.detail.eventName')} (${events.EventField.fromPath('$.detail.errorCode')}) at ${events.EventField.fromPath('$.detail.eventTime')}. ` +
            '키 유출을 의심한다 — 액세스 키를 비활성화하고(docs/runbooks/ai-watch.md §4) CloudTrail 에서 출발 IP 를 본다.',
        ),
      });
    new events.Rule(this, 'AiWatchUserUnexpectedCall', {
      ruleName: AI_WATCH_USER_UNEXPECTED_RULE_NAME,
      description: 'AI mail watch Mac IAM user calling anything other than SQS/KMS (ADR-0017 draft) - CloudTrail management events',
      eventPattern: {
        detailType: ['AWS API Call via CloudTrail'],
        detail: { userIdentity: { arn: [aiWatchUserArn] }, eventSource: [{ 'anything-but': [...AI_WATCH_USER_EXPECTED_EVENT_SOURCES] }] },
      },
      targets: [aiWatchUserTarget()],
    });
    new events.Rule(this, 'AiWatchUserError', {
      ruleName: AI_WATCH_USER_ERROR_RULE_NAME,
      description: 'AI mail watch Mac IAM user API call that failed (AccessDenied etc., ADR-0017 draft) - CloudTrail management events',
      eventPattern: {
        detailType: ['AWS API Call via CloudTrail'],
        detail: { userIdentity: { arn: [aiWatchUserArn] }, errorCode: [{ exists: true }] },
      },
      targets: [aiWatchUserTarget()],
    });
  }
}
