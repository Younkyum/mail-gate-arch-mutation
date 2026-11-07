/**
 * src/mail/verification/keywords.ts — 인증코드 추출의 **어휘**(메일 기본기 A1, `.omc/plans/mail-basics.md` §4 A1 "코드 규칙").
 *
 * 추출 규칙(`extract.ts`)은 이 어휘만 본다. 어휘를 넓히면 재현율이 오르고 정밀도가 내려간다 — `high` 정밀도 100% 가 수용 기준이라
 * (AC-A1-1) **코드 키워드는 좁게, 제외 문맥은 넓게** 둔다. 넓힐 때는 `test/fixtures/verification/` 코퍼스에 교란 메일을 먼저 더한다.
 *
 *   - `CODE_KEYWORD` — 이 가까이의 후보만 `high` 다. 맨 단어 `code` 는 없다(`promo code SAVE20` 이 `high` 가 된다).
 *   - `EXCLUDE_CONTEXT` — 후보 바로 앞(같은 줄 `EXCLUDE_WINDOW` 글자)에 있으면 후보가 아니다: 주문·송장·사업자·계좌·카드·쿠폰·예약·
 *     참조 번호 같은 "우리가 만든 코드가 아닌 번호". 인증 키워드보다 **가까이** 있으면 이긴다.
 *   - `PHONE_CONTEXT` — 전화번호 표지(같은 줄 앞).
 *   - `CURRENCY_BEFORE`·`CURRENCY_AFTER` — 금액.
 *   - `LINK_KIND_*` — 확정 모드 링크의 종류. **URL 의 경로·쿼리로만** 정한다(2회차 수정 Y1, 보안 R1 — 링크 앞 글(라벨)은 알림 메일에서
 *     남이 쓴 글이라 종류의 근거가 되지 않는다). 종류가 없는 링크(수신 거부·약관·로고)는 싣지 않는다.
 *   - `NOTIFICATION_LOCAL_PARTS` — 확정 모드에서 빼는 **알림형 발신 로컬파트**(`notifications@github.com` 등, 보안 R1). 사이트가 남의 글을
 *     자기 도메인으로 보내는 주소라 제목까지 남이 정한다(이슈 제목 "Your verification code").
 *   - `SUBJECT_KEYWORD`·`REPLY_PREFIX` — 확정 모드는 **제목에 인증 키워드가 있는 메일**만 본다(1차 수정 X1, 보안 M2). DMARC pass 는 "그
 *     도메인이 보냈다" 일 뿐이다 — GitHub 알림처럼 사이트가 **남이 쓴 글**(이슈 댓글)을 자기 도메인으로 보내면 본문의 "Verification code:
 *     123456" 은 사이트의 코드가 아니다. 사이트가 만든 인증 메일은 제목부터 인증 메일이다. 답장·전달 제목(`Re:`·`Fwd:`)은 인증 메일이 아니다.
 *   - `REDIRECT_PARAM_KEYS`·`EXCLUDED_LINK_PATH` — 확정 모드 링크에서 뺀다: 다른 곳으로 보내는 파라미터가 붙은 링크(열린 리다이렉트)와
 *     OAuth 동의·기기 로그인 화면(여는 순간 남에게 권한을 준다).
 *
 * 모든 정규식은 **상한 있는 수량자**만 쓴다(입력은 인터넷에서 온다 — 선형 시간).
 */

/** 인증코드 키워드(대소문자 무시). ko: 인증번호·인증 코드·확인 코드·보안 코드·일회용 비밀번호·OTP · en: verification code·security code·one-time·passcode·confirm·login code. */
export const CODE_KEYWORD = new RegExp(
  [
    // ko
    '인증\\s?번호',
    '인증\\s?코드',
    '확인\\s?코드',
    '보안\\s?코드',
    '일회용\\s?(?:비밀\\s?번호|암호|코드|패스워드)',
    '로그인\\s?코드',
    '본인\\s?확인\\s?(?:번호|코드)',
    // en
    'verification\\s(?:code|pin|number)',
    'verify\\s(?:code|pin)',
    'code\\sto\\sverify',
    'security\\scode',
    'one[-\\s]time\\s(?:code|password|passcode|pass\\scode|pin|login\\scode)',
    '\\bOTP\\b',
    'passcode',
    'confirmation\\scode',
    'confirm\\scode',
    'code\\sto\\sconfirm',
    'log[-\\s]?in\\scode',
    'sign[-\\s]?in\\scode',
    'authentication\\scode',
    '2FA\\scode',
    // "482913 is your Instagram code" · "Your Slack code is 482913" — 서비스 이름 ≤2 단어. 그 안에 제외 문맥(`promo` 등)이 있으면
    // 키워드가 아니다(`extract.ts` 가 거른다).
    'is\\syour\\s(?:[\\p{L}\\p{N}.-]{1,30}\\s){0,2}code\\b',
    // "Your code: 482913" · "Your Slack code: 482913" 도(코드 리뷰 M1 예시). 서비스 이름 자리에 제외 문맥(`promo`·`referral`·`invite` …)이
    // 있으면 키워드가 아니다.
    '\\byour\\s(?:[\\p{L}\\p{N}.-]{1,30}\\s){0,2}code(?:\\sis\\b|\\s?[:：])',
    'two[-\\s]factor\\s(?:authentication\\s)?code',
  ].join('|'),
  'giu',
);

/** 이 글자 수 안(같은 줄, 후보 앞)에 제외 문맥이 있으면 후보가 아니다. */
export const EXCLUDE_WINDOW = 32;

/** 인증 키워드보다 가까이 있으면 이기는 "다른 번호" 표지. */
export const EXCLUDE_CONTEXT = new RegExp(
  [
    // ko
    '주문', '송장', '운송장', '배송', '사업자', '등록\\s?번호', '통신\\s?판매', '계좌', '카드', '쿠폰', '할인', '프로모션', '추천',
    '초대\\s?코드', '회원\\s?번호', '고객\\s?번호', '예약\\s?번호', '접수\\s?번호', '우편\\s?번호', '승인\\s?번호', '거래\\s?번호',
    '결제', '환불', '문의\\s?번호', '영수증', '상품', '모델',
    // en
    '\\border', '\\binvoice', '\\breceipt', '\\btracking', '\\bshipment', '\\baccount', '\\bcustomer', '\\bmember(?:ship)?',
    '\\breference', '\\bref\\b', '\\bticket', '\\bcase\\b', '\\bbooking', '\\breservation', 'confirmation\\s(?:number|no)',
    '\\btransaction', '\\bpayment', '\\bcard\\b', '\\bzip\\b', '\\bpostal', '\\bpromo', '\\bcoupon', '\\bdiscount', '\\breferral',
    '\\binvite\\scode', '\\bredeem', '\\bredemption', '\\blicen[cs]e', '\\bgift', '\\bvoucher', '\\berror', '\\bstatus\\scode', '\\bserial', '\\bmodel', '\\bsku\\b', '\\bversion',
    '\\bbuild\\b', '\\bpatch', '\\bitem', '\\bproduct', '\\bpart\\s(?:no|number)', '\\bflight', '\\bseat', '\\broom',
  ].join('|'),
  'iu',
);

/** 전화번호 표지 — 후보 앞 같은 줄 `EXCLUDE_WINDOW` 글자 안. */
export const PHONE_CONTEXT = /전화|연락처|고객\s?센터|대표\s?번호|콜\s?센터|휴대\s?폰|핸드폰|팩스|\btel\b|\bphone|\bfax\b|\bcall\b|\bmobile|whatsapp/iu;

/** 후보 바로 앞(공백 ≤1 사이)의 통화 표지. */
export const CURRENCY_BEFORE = /(?:[$€£¥₩]|\b(?:KRW|USD|EUR|JPY|GBP|CNY)\b)\s?$/iu;
/** 후보 바로 뒤의 통화 표지. */
export const CURRENCY_AFTER = /^\s?(?:원|달러|엔|유로|won\b|krw\b|usd\b|eur\b|jpy\b|dollars?\b)/iu;

/** 링크 종류 — 확정 모드 링크에만 쓴다. URL 의 경로·쿼리에서만 본다(라벨 아님 — 보안 R1). 먼저 맞는 것이 이긴다. */
export const LINK_KINDS = ['password_reset', 'login', 'verify'] as const;
export type VerificationLinkKind = (typeof LINK_KINDS)[number];

export const LINK_KIND_PATTERNS: Readonly<Record<VerificationLinkKind, RegExp>> = {
  password_reset: /reset[-_\s]?password|password[-_\s]?reset|reset|비밀\s?번호\s?(?:재설정|변경|초기화)|recover/iu,
  login: /magic[-_\s]?link|log[-_\s]?in|sign[-_\s]?in|로그인|auth(?:enticate)?\b/iu,
  verify: /verif|confirm|activat|validat|인증|확인|활성화|가입\s?완료/iu,
};

/**
 * 알림형 발신 로컬파트의 **조각**(2회차 수정 Y1, 보안 R1). 로컬파트를 `-`·`_`·`.`·`+` 로 나눈 조각 하나라도 이 가운데 하나면 알림
 * 주소다 — `notifications`·`notification+x`·`comments-noreply`·`noreply-comments`·`mention`·`digest-noreply`. 확정 모드는 이 주소의 메일을
 * 보지 않는다: GitHub 이슈 알림처럼 **제목과 본문을 남(이슈 작성자)이 정한다**. 조각 단위라 `noreply` 는 알림이 아니다.
 */
export const NOTIFICATION_LOCAL_PARTS: readonly string[] = [
  'notification', 'notifications', 'comment', 'comments', 'mention', 'mentions', 'digest', 'discussion', 'discussions',
];

/**
 * 이 말이 URL 이나 바로 앞 글에 있으면 인증 링크가 아니다(수신 거부·설정·약관·도움말). 종류보다 먼저 본다. 앞 글(라벨)은 **빼는 쪽으로만**
 * 쓴다 — 라벨이 링크를 인증 링크로 만들지는 못한다(보안 R1).
 */
export const LINK_EXCLUDE = /unsubscribe|opt[-_\s]?out|preferences|수신\s?거부|구독\s?해지|privacy|terms|policy|약관|개인\s?정보|help|support|고객\s?센터|faq/iu;

/**
 * 인증 메일 제목의 표지(대소문자 무시) — 코드 키워드(`CODE_KEYWORD`) 더하기 링크형 인증 메일의 말(확인·활성화·재설정·로그인). 확정 모드의
 * **문**이다(코드·링크 둘 다) — 넓게 두되, 사용자 글이 제목이 되는 알림(`[owner/repo] Issue title`)은 대개 이 말이 없다.
 */
export const SUBJECT_KEYWORD = new RegExp(
  [
    CODE_KEYWORD.source,
    // ko
    '인증', '본인\\s?확인', '(?:이메일|메일|계정)\\s?확인', '확인\\s?(?:메일|요청|번호)', '비밀\\s?번호', '로그인', '가입', '활성화',
    '일회용', '보안\\s?코드',
    // en
    'verif', 'confirm', 'activat', 'passcode', 'one[-\\s]?time', '\\bOTP\\b', 'magic\\s?link', 'sign[-\\s]?(?:in|up)\\b',
    'log[-\\s]?in\\b', '\\breset\\b', 'password', '\\b2FA\\b', 'two[-\\s](?:factor|step)', 'authenticat', '\\byour\\s(?:[\\p{L}\\p{N}.-]{1,30}\\s){0,2}code\\b',
    '\\bnew\\s(?:device|sign[-\\s]?in|login)',
  ].join('|'),
  'iu',
);

/** 답장·전달 제목 — 인증 메일이 아니다(사람이 쓴 대화). */
export const REPLY_PREFIX = /^\s{0,8}(?:re|fwd?|fw|aw|sv|답장|회신|전달)\s{0,4}(?:\[\d{1,4}\]\s{0,4})?[:：]/iu;

/**
 * 이 쿼리(또는 조각) 파라미터 키가 붙은 링크는 싣지 않는다 — 열린 리다이렉트의 흔한 이름. 키는 소문자로 바꾸고 `_`·`-` 를 빼고 비교한다
 * (`returnTo`·`redirect_uri`·`redirect-url` 이 같다). 값이 URL 모양인 파라미터(`LINK_PARAM_VALUE_IS_URL`)는 이름과 무관하게 뺀다.
 */
export const REDIRECT_PARAM_KEYS: readonly string[] = [
  'redirect', 'redirecturi', 'redirecturl', 'redirectto',
  'return', 'returnto', 'returnurl',
  'next', 'continue', 'url', 'dest', 'destination', 'goto', 'target', 'r', 'u',
];

/** 파라미터 값이 URL 모양 — 스킴(`https:`·`javascript:` 등)·`//`·`/\\` 로 시작, 또는 `://`(한 번 더 인코딩된 것까지) 가 든다. */
export const LINK_PARAM_VALUE_IS_URL =
  /^\s{0,8}(?:(?:https?|javascript|vbscript|data|file|ftp|intent|mailto):|\/\/|\/\\|\\\\)|:\/\/|%3a%2f%2f|%2f%2f/iu;

/** OAuth 동의·기기 로그인 경로 — 여는 순간 남(공격자가 시작한 흐름)에게 권한을 준다. 경로 조각 단위로 본다(소문자). */
export const EXCLUDED_LINK_PATH = /(?:^|\/)oauth2?\/(?:v\d{1,2}(?:\.\d{1,2})?\/)?authorize(?:\/|$)|(?:^|\/)(?:device|devicelogin|activate-device)(?:\/|$)/iu;
