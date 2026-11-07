/**
 * src/admin/ui/console/terms.ts — 콘솔 용어 사전(2026-10-15 UI 일관성 감사 §3.15). 한 개념 = 한 이름, 영어 대응어도 함께 고정한다.
 *
 * 화면 문구는 이 표를 **읽어 만들지 않는다**(원문 한국어는 각 조각에 그대로 적는다 — 사전 번역 `i18n.ts` 의 키가 원문이다). 이 표는
 * 규칙의 정본이고, `admin-console-terms.test.ts` 가 두 언어 렌더 결과에서 `avoid` 가 나오지 않는지 본다 — 다른 낱말이 다시 들어오면 빨갛다.
 * `allow` 는 `avoid` 를 품지만 다른 뜻인 구절(예: Cloudflare 메뉴 이름 "가져오기 및 내보내기")이다 — 검사 전에 지운다.
 * 날짜·빈 값 형식(§3.10)은 `kit.ts` 와 스크립트 `fmtDate`·`fmtDateTime`·`EMPTY` 가 정본이다.
 */

export interface Term {
  /** 개념 — 이 낱말을 언제 쓰는가. */
  readonly use: string;
  readonly ko: string;
  readonly en: string;
  /** 한국어 화면에 나오면 안 되는 다른 이름. */
  readonly avoidKo: readonly string[];
  /** 영어 화면에 나오면 안 되는 다른 이름. */
  readonly avoidEn: readonly RegExp[];
  /** `avoidKo` 를 품은 다른 뜻의 구절(검사 전에 지운다). */
  readonly allowKo?: readonly string[];
}

export const TERMS: readonly Term[] = [
  // --- 없애는 동사 넷(F04) ------------------------------------------------------------------------------------------------
  {
    use: '기록을 남기지 않고 없앤다 — 에이전트 · 별칭 · 웹훅 · 웹훅 인증 헤더',
    ko: '삭제',
    en: 'Delete',
    avoidKo: ['인증 헤더 지우기', '인증 헤더를 지울', '인증 헤더를 지웠', '지운 값은'],
    avoidEn: [/Remove authorization header/, /authorization header removed/i],
  },
  {
    use: '목록 · 관계에서 뺀다 — 멤버 · 신뢰 발신자 · 허용/차단 목록 항목 · 도메인',
    ko: '제거',
    en: 'Remove',
    avoidKo: ['내보내기', '내보냅니다', '내보냈습니다', '내보낼', '빼기', '뺐습니다', '목록에서 지웁니다', '목록에서 삭제', '지웠습니다'],
    avoidEn: [/\bkick\b/i],
    allowKo: ['가져오기 및 내보내기'],
  },
  {
    use: '자격 증명을 무효로 만든다 — 에이전트 토큰 · 조직 API 키',
    ko: '폐기',
    en: 'Revoke',
    avoidKo: ['토큰 삭제', '키 삭제', '토큰을 삭제', '키를 삭제'],
    avoidEn: [/Delete token/i, /Delete key/i],
  },
  {
    use: '대기 중인 것을 거둔다 — 초대 · 예약 발송',
    ko: '취소',
    en: 'Cancel',
    avoidKo: ['초대 철회', '초대 삭제', '예약 삭제'],
    avoidEn: [/Withdraw invite/i, /Delete invite/i],
  },
  // --- 한 개념 한 이름(F15 · F31 · F32 · F33 · F51) -----------------------------------------------------------------------
  {
    use: '에이전트에게 보이지 않게 잡아 둔 받은 메일 — 수신 정책으로 막은 것 · 위험 등급 보류 모두(서버 이름 quarantined · held)',
    ko: '보류',
    en: 'Held',
    avoidKo: ['격리', '숨겨 둔'],
    avoidEn: [/quarantin/i],
  },
  {
    use: '에이전트를 조종하려는 글(첫 등장은 \'프롬프트 인젝션\')',
    ko: '인젝션',
    en: 'injection',
    avoidKo: ['주입'],
    avoidEn: [/\bprompt insertion\b/i],
  },
  {
    use: '정책의 방향 — 발신 · 수신(권한 · 동작 이름은 보내기 · 읽기)',
    ko: '발신 · 수신',
    en: 'Outbound · Inbound',
    avoidKo: ['받기 · 보내기 준비됨', '보내기: 허용 목록', '받기: 전체'],
    avoidEn: [/Ready to send and receive/],
  },
  {
    use: '표의 열 머리 — 생성은 만든 날(멤버만 참여한 날) · 최근은 마지막 사용 · 이벤트는 시각',
    ko: '만든 날',
    en: 'Created',
    avoidKo: ['추가한 날', '들어온 날', '처음 본 날', '받은 시각'],
    avoidEn: [/\bFirst seen\b/],
  },
  {
    use: '식별자 라벨',
    ko: 'ID',
    en: 'ID',
    avoidKo: ['<dt>id</dt>', 'id 복사', 'id 모양', '기록 id'],
    avoidEn: [/Copy id\b/, /\bagent id\b/, /Record id\b/],
  },
  // --- 내부 말투를 고객 말로(F52 · F53 · F54) --------------------------------------------------------------------------
  {
    use: '투명성 로그의 매시 체크포인트 번호(서버 이름 epoch)',
    ko: '체크포인트 #N',
    en: 'Checkpoint #N',
    avoidKo: ['에폭', '검증기 판', '트리 '],
    avoidEn: [/\bepochs?\b/i, /verifier version/i, /tree size/i],
  },
  {
    use: '새 조직의 하루 발송량을 단계적으로 늘리는 상한(서버 이름 warm-up)',
    ko: '단계적 증량',
    en: 'ramp-up',
    avoidKo: ['워밍업'],
    avoidEn: [/warm-?up/i],
  },
  {
    use: '사람 메일함을 에이전트가 맡는지 14일 동안 재는 시험(서버 이름 AC-0 GATE)',
    ko: '메일함 인계 시험',
    en: 'Mailbox handover trial',
    avoidKo: ['전달 시험'],
    avoidEn: [/Forwarding trial/i],
  },
];
