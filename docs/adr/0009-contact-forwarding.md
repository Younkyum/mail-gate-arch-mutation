# ADR-0009 — `support@atmark.ai` 문의는 발송 역할을 공유하는 전용 Lambda 가 운영자 메일함으로 **새 메일**로 보낸다

- **상태:** 채택 (2026-09-24, US-009 — 진윤겸 결정 "문의는 운영자 개인 메일함으로")
- **관련:** ADR-0006(발송 주체 2 · Layer E), `src/policy/manifest.ts` `SYSTEM_MAIL_ENTRYPOINTS`(`contact_forward`),
  `docs/runbooks/deploy.md` "문의 전달", 마이그레이션 `202609241500_contact_forwards.sql`
- **바꾸지 않는 것:** SES 발송 주체 수(Layer E `mustEqual: 2`), 관문·에이전트 메일 경로, 수신 역할의 SES 권한 0

## 맥락

홈 푸터와 개인정보 처리 안내·이용약관의 "문의·탈퇴 요청" 문구는 주소가 있어야 동작한다(`CONTACT_EMAIL`). 주소를 지어내면 아무도
읽지 않는 메일함이 공개 페이지에 박힌다. `support` 로컬파트는 이미 예약돼 에이전트가 가질 수 없고(`src/identity/address.ts`), 수신 규칙은
도메인 단위(`atmark.ai`)라 그 주소로 온 메일은 원문이 S3 `inbound/raw/` 에 쌓인 뒤 `unknown_recipient` 로 버려지고 있었다.

전달 주소(운영자 개인 메일함)는 **공개하지 않는다** — 코드·문서·테스트·커밋 메시지 어디에도 없다.

## 결정

1. **입구 — 수신 소비자가 에이전트 조회 앞에서 문의 주소를 떼어 낸다**(`src/contact/intake.ts`). 받아들이는 조건:
   - SES 스팸·바이러스 판정 **정확히 PASS**(gray·processing_failed 도 거부 — 운영자 메일함으로 옮기는 일이라 좁게).
   - DMARC `fail` 이 아님(DMARC 가 없는 개인 도메인은 통과).
   - 루프 아님: 봉투 발신자·헤더 From·SES 가 본 From 도메인이 `atmark.ai`(하위 포함)가 아님 · 자동 응답 헤더 없음. 전달 주소
     **자신**에서 온 메일은 주소를 아는 전달 모듈이 거른다(별칭·Gmail 점·`+태그` 무시 — `isHumanMailbox`).
   - 원문 ≤ 10 MiB · MIME 파싱 성공 · From 이 헤더에 안전한 주소 하나.
   - 시간당 상한(창 = SES 수신 시각): **같은 발신자 5 · 차선별 support 30 / role 10**(2026-10-02 개정 — 아래). advisory lock 아래 계수 + INSERT.
   - 어긋나면 `inbound_rejections(reason = 'contact_not_forwarded', detail = <사유 코드>)` — 코드는 `CONTACT_REJECTION_CODES`.
   받아들이면 ① 전달 문서(JSON — 발신자·날짜·To·제목·텍스트 본문 ≤ 50,000자·첨부 개수·DMARC)를 S3 `contact/forward/{sesMessageId}.json` 에
   write-once 로 쓰고 ② outbox 행 `contact_forwards` 하나를 적는다. **보내지 않는다** — 수신 역할은 여전히 SES 0 이고 전달 주소를 모른다.
2. **전달 — 전용 Lambda `atmark-contact-forwarder`(1분, 예약 동시성 1, 풀 1)가 발송 역할 `atmark-runtime-sender` 를 공유한다.** 네 번째
   시스템 메일(`SYSTEM_MAIL_ENTRYPOINTS` `contact_forward`: 워커 `src/workers/contact-forwarder.ts` → 모듈 `src/notify/contact-forwarder.ts`).
   모듈의 공개 API 는 `forward(forwardId)` 하나, 의존성에 문자열 없음(Layer B 동결). 이 함수만의 권한은 **함수 단위 조건**
   (`lambda:SourceFunctionArn` = 이 함수)으로 묶는다:
   - 전달 주소 비밀 `atmark/contact-forward-to` `GetSecretValue` — 이 함수만(api·알림·릴리스·예약은 같은 역할이어도 못 읽는다).
   - `contact/forward/*` `GetObject` — 이 함수만(ListBucket 없음). 쓰기는 inbound 역할만.
   - `support@atmark.ai` 발신은 이 함수 **밖에서 명시 Deny**(`SesDenySupportFromOutsideForwarder`, `ArnNotEquals` — 함수 밖으로 빼낸
     자격증명에는 키가 없어 역시 거부). api 가 탈취돼도 문의 주소를 사칭하지 못한다.
    **2026-09-30 개정:** 이 Deny 는 이제 `ATMARK_CONTACT_ROUTING = forward`(기본) 일 때만 만든다. 다른 모드에서는 support@ 가
    Chronostasis 의 지원 에이전트 주소가 되어 그 에이전트가 답장을 보내므로 Deny 를 걷는다 — api 탈취 시 support@ 사칭을 막지 못하는
    것은 다른 에이전트 주소와 같은 수준이다(ADR-0006 2026-09-30 개정 · deploy.md §29).
3. **새 메일로 보낸다(원문 재전송이 아니다).** From `support@atmark.ai`(우리 도메인 — DKIM·DMARC 정렬) · To 전달 주소 **하나** · Reply-To
   원 발신자 · 제목 `[Atmark 문의] <원 제목 — 제어·양방향·제로폭 제거, 200자>` · **text/plain 만**: 우리 머리 블록(보낸 사람·날짜·To·
   DMARC·첨부 개수·원문 위치) → 구분선 → 원 본문 텍스트. HTML·첨부는 싣지 않는다 — 원문은 S3 `inbound/raw/` 에 그대로 있다.
4. **수신자는 비밀 하나에서만.** `atmark/contact-forward-to`(Data 스택, RETAIN, 자리값으로 태어난다) = `{"to":"<주소>"}`. 배포 때
   운영자가 `put-secret-value` 로 채운다. 자리값·모양 틀림·우리 도메인·읽기 실패는 전부 **보내지 않는다**(`unconfigured` — 집기 전에 멈추고
   시도 수도 쓰지 않는다, `atmark.contact.forward_blocked` 메트릭). 로더는 유효한 값만 기억한다 — 값을 넣으면 다음 틱부터 나간다.
   메일 내용·헤더(To·Cc·Reply-To·Resent-To…)·DB 행 어디에서도 수신자를 읽지 않는다(`contact_forwards` 에 수신자 칸이 없다).
5. **전달 쪽에도 차선별 상한 support 30 · role 10 /시간**(시도 수, 2026-10-02 개정) — 수신 쪽 계수를 우회해 행이 쌓여도(앱 롤 INSERT) 나가는 양은 같다.
6. **멱등:** `contact_forwards.ses_message_id` 유니크(SES 메시지 하나당 한 행) · 집기 `FOR UPDATE SKIP LOCKED` + 임대 · 결말은 자기 시도에만
   조건부 UPDATE · 종단(`sent`·`suppressed`·`dead`)은 트리거가 동결한다. 알려진 창(승인 알림과 같다): SES 수락 뒤 `sent` 기록 전에 죽으면 임대
   만료 뒤 한 통 더 — 유실보다 중복이 낫다.
7. **관측:** 로그에 내용 없음(주소는 로거가 가린다, 사유 코드·SES 메시지 ID·결말만) · 메트릭 `atmark.contact.forward_sent`·`forward_blocked`.
   전달 메일은 알림 태그(`atmark_notification_id`)를 싣는다 — 하드 바운스·불만은 SES 이벤트 소비자가 시스템 억제 목록에 적는다.

## 기각한 대안

- **셋째 SES 주체(`support@` 에 묶인 전용 역할).** 가장 좁아 보이지만 Layer E 의 숫자를 3 으로 올리고(allowlist·스크립트·arch·ADR 전부),
  **새 역량은 0** 이다 — 발송 역할은 이미 `*@atmark.ai` 로 보낼 수 있다. 차이는 "누가 그 비밀을 읽는가" 뿐이고 그것은 함수 단위 조건으로
  같은 강도로 닫힌다. **재개방 조건:** 발송 역할을 함수별로 쪼개는 날(그때 이 함수의 역할이 자연히 생긴다), 또는 `lambda:SourceFunctionArn`
  조건이 운영에서 기대대로 평가되지 않는 것이 확인된 날.
- **수신 Lambda 가 직접 보낸다.** 외부인의 MIME 을 파싱하는 Lambda(가장 넓은 공격면)에 SES 발송권과 전달 주소를 준다. 기각.
- **원문 `.eml` 을 `message/rfc822` 로 첨부.** 운영자 메일 클라이언트가 원문의 HTML·첨부(악성 포함)를 렌더·열 수 있게 된다. 바이러스
  판정 PASS 여도 PASS 는 "알려진 것 없음" 이다. 텍스트만 옮기고 원문은 S3 에 둔다.
- **원 발신자를 From 으로 두는 진짜 전달(SRS 없이).** 우리 도메인에서 남의 From 은 DMARC 정렬이 깨져 Gmail 이 스팸·거부한다.
- **SNS 알림을 운영자 이메일로 구독.** 원문 JSON 이 필터 없이(스팸·바이러스·상한 없이) 운영자에게 간다.

## 결과 · 남은 위험

- **SES 발송 주체 2 그대로**(Layer E `mustEqual: 2`). 발송 역할을 쓰는 핸들러는 넷 → 다섯. `scripts/check-ses-principals.sh` 는 발송 역할이
  `support@` 를 (함수 문맥 없이) **거부**해야, login-mailer 가 `support@` 를 거부해야 통과한다(`deniedFromAddresses` · `FOREIGN_PROBES`).
- **`lambda:SourceFunctionArn` 에 기대는 세 문장.** 조건이 기대와 다르게 평가되면 닫힌 쪽으로 실패한다: 비밀·문서를 못 읽어 `unconfigured`/
  `retry`, `support@` 발신이 Deny. 배포 스모크에서 확인한다(런북).
- **앱 롤은 `contact_forwards` INSERT 를 가진다**(수신 소비자가 쓴다). api 탈취자는 행을 넣을 수 있지만 문서(S3 `contact/forward/`)를 쓸 수
  없다 — 문서 없는 행은 `document_unreadable` 재시도 뒤 `dead`, 이미 있는 문서의 SES ID 는 유니크에 걸린다. 수신자는 여전히 비밀이다.
- **전달 주소 하드 바운스는 억제 목록에 적히지만 전달 모듈은 그 표를 읽지 않는다**(앱 롤 SELECT 없음). 운영자 주소라 사람이 고친다 —
  후속: 전달 모듈이 억제 목록을 보게 하거나 `forward_blocked` 에 알람을 건다(관측 스택, 이 변경 밖).
- **보존:** `contact/forward/` 접두사에는 아직 수명주기 규칙이 없다(메일 버킷 수명주기 작업에 요청 — `.omc/handoffs/v2-contract.md` US-009 메모).
- 콘솔 로그: `contact_not_forwarded` 거부 행은 어느 조직 주소와도 겹치지 않아(`support` 예약) 고객 콘솔에 보이지 않는다. 사유 문구는 콘솔
  `REASON_LABELS` 에 필요하다(같은 메모).

## 2026-09-24 보안 검증 수정 — Reply-To 주소 문법(F4) · 보이지 않는 문자 한 벌(F5) · 알람(F6) · 남은 위험(F7·F10)

- **F4 (LOW-MED) — Reply-To 로 내보낼 주소는 ASCII dot-atom 하나.** `isForwardableAddress` 가 "제어·공백·꺾쇠 없음" 만 보던 것을 RFC 5322
  dot-atom(`atext` + 점, 도메인은 LDH 라벨 둘 이상, 로컬파트 64자)으로 좁히고 **`=?`·`?=` 를 거부**한다. 파서가 From 주소로 돌려준
  `=?utf-8?q?victim=40bank.example?=@attacker.example` 은 문법상 dot-atom 이지만 메일 클라이언트 다수가 encoded-word 를 풀어 `victim@bank.example` 처럼
  보인다 — 회신은 공격자 도메인으로 가면서 화면은 다른 주소다. 전달 틀은 **표시 이름을 주소와 다른 줄**에 "표시 이름(검증 안 됨)" 으로만 싣고
  (`"victim@bank.example" <x@attacker>` 가 `보낸 사람: victim@bank.example <…>` 로 읽히지 않게), DMARC 가 `pass` 가 아니면(없음·gray 포함) 맨 윗줄에
  위조 가능 경고를 싣는다. 테스트: `test/unit/contact/contact-forward.test.ts`(검토자 `ew.ts` 사례 포함).
- **F5 (LOW) — 보이지 않는 문자는 승인 알림 틀의 `INVISIBLE` 한 벌.** 전달 틀이 더 좁은 자체 목록을 쓰던 것을 `approval-notification-template.ts`
  의 `INVISIBLE`(내보냄)·`sanitizeDisplayBlock` 으로 바꿨다 — U+061C(ALM)·U+00AD·U+3164·변이 선택자·태그 문자 등이 제목·표시 이름·본문에서
  사라진다(두 벌이면 한쪽이 낡는다).
- **F6 (LOW) — 알람 둘.** 관측 스택 알람 8 `atmark-contact-rate-global`(새 메트릭 `atmark.contact.rate_global` — 수신 소비자가 전역 시간당 상한
  거부 때 낸다, `>= 1` / 1시간) · 알람 9 `atmark-contact-forward-blocked`(기존 `atmark.contact.forward_blocked`, `>= 1` / 15분). 둘 다 결측은
  `NOT_BREACHING`, 기존 SNS 토픽. 위 "결과 · 남은 위험" 의 "`forward_blocked` 에 알람" 후속은 이것으로 닫혔다.
- **F7 (남은 위험) — 전달 Lambda 는 발송 역할을 공유한다.** 함수 단위 조건(`lambda:SourceFunctionArn`)이 비밀·문서 읽기와 `support@` 발신을
  이 함수에 묶지만, **역할의 나머지 권한**(에이전트 주소 발신·발신 본문 S3 읽기/쓰기·수신 파생물 읽기)은 이 함수에도 있다. 전달 모듈의 코드 실행
  취약점(외부인 문서 JSON 을 모양 검사 뒤 텍스트로 조립 — MIME 파싱 없음)이 곧 발송 역할 탈취다. 줄이는 길: 전달 전용 역할(발송 주체 3 — Layer E
  `mustEqual` 변경과 ADR 필요)을 두고 `support@` 한 주소로만 묶는다.
- **F10 (남은 위험) — 앱 롤은 끝나지 않은 `contact_forwards` 행을 다시 줄 세울 수 있다.** 앱 롤은 결말 칸(`status`·`next_attempt_at`·
  `attempt_count`·`claimed_at`…) UPDATE 를 가진다(전달 워커가 쓴다). 종단(`sent`·`suppressed`·`dead`)은 트리거 `contact_forwards_terminal_frozen`
  이 모든 롤에 동결하므로 **끝난 문의를 다시 보내게 할 수는 없다.** 남는 것: api Lambda(같은 앱 롤) 탈취자가 **진행 중인** 행의 선점
  (`claimed_at`)을 풀어 한 문의를 두 번 보내게 하거나, `attempt_count` 를 되돌려 재시도를 늘리거나, `next_attempt_at` 을 먼 미래로 밀어 전달을
  미룰(사실상 숨길) 수 있다. 수신자는 여전히 비밀의 운영자 주소 하나이고 내용은 이미 있는 문서라 새 내용을 넣을 수 없으며, 전달 쪽 전역 상한이
  양을 묶는다. 줄이는 길: 전달 워커 전용 DB 롤(결말 칸 UPDATE 를 앱 롤에서 거둔다) 또는 `attempt_count` 감소·선점 중 해제 금지 트리거.

## 2026-09-24 최종 적대적 검증 — 문서 칸 상한 · 날짜 칸 한 줄 · punycode 경고(L7)

- **문서 칸 상한.** 전달 문서(`contact/forward/*`)는 앱 롤이 쓴 S3 객체다 — 쓰는 쪽을 믿지 않는다. `parseDocument`(`src/notify/contact-forwarder.ts`)
  가 수신 쪽(`buildContactDocument`)이 자른 길이를 다시 강제한다: 제목 998 · 표시 이름 200 · 받는 주소 한 칸 254(UTF-16 단위) · 본문
  `2 × CONTACT_TEXT_MAX_CHARS`(코드포인트 50,000 = UTF-16 100,000 이하). 넘으면 모양 오류 → `dead`(`document_invalid`) · SES 0 · 알람 9.
  전에는 본문·제목에 상한이 없어 수 MB 문자열이 정화 정규식·메일 본문까지 갔다(읽기 상한 512 KiB 안에서).
- **날짜 칸.** `보낸 날짜`·`받은 시각(SES)` 도 `oneLine`(40자)을 지난다 — 그 칸에 개행이 있으면 머리 블록의 `보낸 사람:`·`DMARC:` 줄을 흉내 낼 수 있었다.
- **punycode 회신 주소.** 보낸 사람(= Reply-To) 도메인의 라벨 하나라도 `xn--` 로 시작하면 머리 블록 맨 위(DMARC 경고 아래)에
  `CONTACT_FORWARD_PUNYCODE_WARNING` 과 도메인의 두 표기(ASCII · `domainToUnicode` — 정화 뒤)를 싣는다. **거부하지 않는다** — 국제화 도메인은 정상
  발신자일 수 있다. 운영자가 회신하는 곳이 `paypal.com` 이 아니라 `xn--pypal-4ve.com`(키릴 `а`)일 수 있다는 것을 보이게 할 뿐이다.
- 테스트: `test/unit/contact/contact-forward.test.ts` "최종 검증 L7"(날짜 칸 위조 줄 · punycode 경고 위치·두 표기·로컬파트 `xn--` 는 무시) ·
  `test/integration/inbound/contact-forward.test.ts` ⑨(칸마다 상한 +1 → `dead`, 상한 그대로 → `sent`).

## 2026-10-02 개정 — 차선별 상한(support 30 · role 10)

- **왜.** `abuse@`·`postmaster@`(202609301540)가 support@ 와 전역 상한 30 을 나눠 써서, support@ 폭탄이 스팸 신고·차단 해제 협의를 막고 그 반대도 같았다.
- **무엇.** `contact_forwards.lane`(`support` | `role`, 202610021000 · 검증 1001). 봉투 수신자 중 하나라도 수신 전용 역할 주소면 `role`(`laneOf`).
  수신 쪽 받아들이기와 전달 쪽 시도 수 둘 다 차선마다 센다 — **support 30 · role 10**(`CONTACT_FORWARD_LANE_HOURLY_CAP`). 같은 발신자 5 는 차선과 무관.
  `lane` 은 종단 동결 트리거가 정체성 칸으로 묶고(불변), 앱 롤은 INSERT 만 가진다.
- **advisory lock 은 하나 그대로**(`contact_forward:admit` · `contact_forward:send`). 발신자 상한이 차선을 가로지르므로 차선별 키로 나누면 같은 발신자의 두 차선
  동시 도착이 발신자 상한을 넘길 수 있다. 소비자·워커 동시성이 작아 경합 비용이 없다.
- **알람 8 은 그대로** — 메트릭 `atmark.contact.rate_global` 에 차원 `lane` 이 붙고(어느 차선이 찼는지), 알람은 차원 없는 롤업(두 차선의 합)을 본다. 거부 코드도
  `rate_global` 그대로(기존 거부 행·런북 SQL 과 맞춘다).
- **남은 위험.** 앱 롤 탈취자가 행을 직접 INSERT 하면 두 차선을 다 써서 전달 쪽 시간당 최대가 30 → 40 이 된다(수신자는 여전히 비밀의 운영자 주소 하나).
- **남은 위험 — 차선은 보내는 쪽이 고른다.** 차선은 봉투 수신자로 정해지므로 외부 발신자가 고를 수 있다. 일부러 막으려는 쪽은 **발신자 2명 · 10통**이면
  role 차선(abuse@/postmaster@)을 한 시간 동안 막는다(전에는 공유 상한 30통이 필요했다). 거부된 원문은 S3 `inbound/raw/` 에 남고 알람 8 이 울린다
  (메트릭 차원 `lane=role` 로 구분). 후속 후보: role 차선 거부를 버리지 않고 **늦추기**(상한을 넘은 행을 `pending` 으로 두고 다음 창에 보낸다).
