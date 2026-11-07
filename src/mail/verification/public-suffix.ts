/**
 * src/mail/verification/public-suffix.ts — `sender_domain` 이 **공개 접미사이거나 그 위**인지, 호스트의 **등록 가능한 도메인(eTLD+1)** 이
 * 무엇인지, 그리고 **공용 메일 도메인**인지(메일 기본기 A1 · AC-A1-2 · 1차 수정 X1).
 *
 * 확정 모드는 호출자가 준 도메인과 발신 도메인(`from_domain`)을 정확히(선택적으로 하위까지) 맞춘다. 그런데 `co.kr`·`github.io`
 * 같은 **공개 접미사**를 주면 "그 아래 누구든" 이 되고, `include_subdomains` 까지 켜면 남의 사이트 메일이 확정 코드가 된다
 * (`attacker.github.io` 가 보낸 메일). 그래서 등록 가능한 도메인(eTLD+1) 이상만 받는다 — 접미사 자체와 그 위(`kr`)는 400.
 * `include_subdomains` 로 하위를 받을 때도 **등록 가능 경계를 넘지 않는다**(`registrableDomain` 이 같아야 한다 — `amazonaws.com` 아래의
 * `evil.s3.amazonaws.com` 은 남의 것이다).
 *
 * **공용 메일 도메인**(`SHARED_MAILBOX_DOMAINS` — gmail·outlook·naver·kakao 등)은 누구나 그 도메인 주소를 만들어 **DMARC pass** 로 보낼 수
 * 있다. 확정 모드의 전제("그 도메인에서 DMARC pass 로 온 메일 = 그 사이트") 가 apex 에서는 무너지므로, 발신 도메인이 공용 apex 이면
 * **공급자의 시스템 발신 주소**(`isSharedMailboxSystemSender`)에서 온 메일만 확정 모드가 본다(2회차 수정 Y1, 코드 N2). 공용 판정은 **apex 와
 * 정확히 같을 때만**이다 — `accounts.kakao.com` 같은 하위 도메인은 공급자 자신의 발신 호스트이지 사용자 메일함이 아니다.
 *
 * **스냅샷이다(네트워크 없음, 새 의존성 없음).** Public Suffix List(publicsuffix.org 의 `public_suffix_list.dat`)에서 인증 메일을 보낼
 * 법한 영역만 **손으로 옮긴 부분 집합**이다(ICANN 절 + PRIVATE 절). 원본 파일을 내려받아 대조하지 않았으므로 원본 해시는 없다.
 *   - 최초 작성 2026-09-26(W1). 1차 수정 2026-09-26(X1, 보안 L1): 누락 접미사 추가 — `eu.org`·`us.kg`·`pp.ua`·CentralNic 계열
 *     (`co.com`·`uk.com`·`us.com`·`com.de`·`br.com`·`cn.com`·`de.com`·`eu.com`·`ru.com`·`sa.com`·`za.com`·`jpn.com`·`gb.net`·`uk.net`·
 *     `us.org`)·`co.at` 계열·`com.pk` 계열·`com.ng` 계열. PSL 에 없는 항목 제거 — `substack.com`·`medium.com`·`tumblr.com`·`wordpress.com`
 *     (이 넷은 사이트 자신이 가입 메일을 보내는 도메인이라 400 이면 오히려 막힌다)·`netlify.com`·`railway.app`(`up.railway.app` 만 남김).
 *   - 확인 근거는 작성자(모델)의 PSL 지식이다(2026-06 기준). **불확실한 것**: `wordpress.com`(Automattic 은 `wpcomstaging.com` 등을
 *     올렸지만 `wordpress.com` 자체는 없다고 판단) · `netlify.com`(PSL 에는 `netlify.app` 만 있다고 판단) · `us.kg`(2024 년 DigitalPlat
 *     추가로 기억) · `framer.website`·`no-ip.org`·`azurestaticapps.net`(있다고 판단해 남김 — 틀려도 더 엄격한 방향이다: 그 도메인을
 *     `sender_domain` 으로 주면 400).
 * 목록 전체(약 1만 규칙)는 옮기지 않았다 — 빠진 접미사는 "등록 가능한 도메인" 으로 잘못 받아들여진다(확정 모드에서 그 접미사 아래 모든
 * 발신자를 한 사이트로 본다). 그래서 **목록에 없는 다단 접미사는 DMARC pass 라는 두 번째 조건이 남는다**: 접미사 아래 각 발신자는 자기
 * 도메인의 DMARC 로 통과하므로, 틀린 경우의 피해는 "같은 접미사 아래 다른 사이트의 코드도 확정으로 보인다" 이다. 전체 목록으로 바꾸는
 * 것은 진윤겸 승인 뒤 후속 과제다(ADR-0013 후속 — 그때 스냅샷 날짜·원본 해시를 이 머리말에 적는다).
 *
 * 규칙 표기는 PSL 과 같다: 평범한 규칙(`co.kr`), 와일드카드(`*.ck`), 예외(`!www.ck`). 한 라벨짜리(TLD)는 PSL 의 기본 규칙 `*` 로
 * 전부 접미사다 — 목록에 적지 않는다.
 */

const RULES: readonly string[] = [
  // ---- ICANN: 한국(.kr 2단 — 인증 메일 발신자가 가장 많은 곳) ----
  'ac.kr', 'co.kr', 'es.kr', 'go.kr', 'hs.kr', 'kg.kr', 'mil.kr', 'ms.kr', 'ne.kr', 'or.kr', 'pe.kr', 're.kr', 'sc.kr',
  'busan.kr', 'chungbuk.kr', 'chungnam.kr', 'daegu.kr', 'daejeon.kr', 'gangwon.kr', 'gwangju.kr', 'gyeongbuk.kr', 'gyeonggi.kr',
  'gyeongnam.kr', 'incheon.kr', 'jeju.kr', 'jeonbuk.kr', 'jeonnam.kr', 'seoul.kr', 'ulsan.kr',
  // ---- ICANN: 흔한 국가 2단 ----
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'ltd.uk', 'me.uk', 'net.uk', 'plc.uk', 'sch.uk',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp', 'ad.jp', 'ed.jp', 'gr.jp', 'lg.jp',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au', 'asn.au',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn',
  'com.tw', 'net.tw', 'org.tw', 'edu.tw', 'gov.tw', 'idv.tw',
  'com.hk', 'net.hk', 'org.hk', 'edu.hk', 'gov.hk', 'idv.hk',
  'com.sg', 'net.sg', 'org.sg', 'edu.sg', 'gov.sg',
  'co.in', 'net.in', 'org.in', 'firm.in', 'gen.in', 'ind.in', 'ac.in', 'edu.in', 'gov.in', 'res.in',
  'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br',
  'com.mx', 'net.mx', 'org.mx', 'gob.mx', 'edu.mx',
  'co.nz', 'net.nz', 'org.nz', 'ac.nz', 'govt.nz',
  'co.za', 'net.za', 'org.za', 'gov.za', 'ac.za',
  'com.tr', 'net.tr', 'org.tr', 'gov.tr', 'edu.tr',
  'co.id', 'or.id', 'ac.id', 'go.id', 'web.id',
  'com.my', 'net.my', 'org.my', 'gov.my', 'edu.my',
  'com.ph', 'net.ph', 'org.ph', 'gov.ph', 'edu.ph',
  'co.th', 'in.th', 'or.th', 'ac.th', 'go.th',
  'com.vn', 'net.vn', 'org.vn', 'gov.vn', 'edu.vn',
  'com.ar', 'net.ar', 'org.ar', 'gob.ar',
  'co.il', 'org.il', 'net.il', 'ac.il', 'gov.il',
  'com.ua', 'net.ua', 'org.ua', 'gov.ua',
  'com.ru', 'net.ru', 'org.ru',
  'com.es', 'nom.es', 'org.es', 'gob.es', 'edu.es',
  'com.pl', 'net.pl', 'org.pl',
  'com.sa', 'net.sa', 'org.sa', 'gov.sa',
  'co.ke', 'or.ke', 'ac.ke', 'go.ke',
  'com.eg', 'net.eg', 'org.eg', 'gov.eg', 'edu.eg',
  'com.co', 'net.co', 'org.co', 'gov.co', 'edu.co',
  'com.pe', 'net.pe', 'org.pe', 'gob.pe',
  'com.cl', 'gob.cl',
  'ac.at', 'co.at', 'gv.at', 'or.at',
  'com.pk', 'net.pk', 'org.pk', 'edu.pk', 'gov.pk', 'biz.pk', 'web.pk', 'fam.pk', 'info.pk',
  'com.ng', 'net.ng', 'org.ng', 'edu.ng', 'gov.ng', 'name.ng', 'sch.ng', 'mobi.ng',
  // PSL 의 와일드카드 ccTLD(예시) — 그 아래 한 라벨이 전부 접미사다.
  '*.ck', '!www.ck', '*.bd', '*.np', '*.kh', '*.er', '*.fk', '*.jm', '*.mm', '*.pg',
  // ---- PRIVATE: 누구나 하위 도메인을 받는 호스팅(가입 확인 메일을 이 아래에서 보낼 수 있다) ----
  'github.io', 'githubusercontent.com', 'gitlab.io', 'bitbucket.io',
  'vercel.app', 'now.sh', 'netlify.app', 'pages.dev', 'workers.dev', 'r2.dev',
  'herokuapp.com', 'herokussl.com', 'fly.dev', 'onrender.com', 'up.railway.app',
  'web.app', 'firebaseapp.com', 'appspot.com', 'blogspot.com', 'run.app', 'cloudfunctions.net',
  'azurewebsites.net', 'azurestaticapps.net', 'cloudapp.net', 'trafficmanager.net', 'blob.core.windows.net',
  'cloudfront.net', 'elasticbeanstalk.com', 's3.amazonaws.com', 'amplifyapp.com', 'awsapprunner.com',
  'glitch.me', 'repl.co', 'replit.app', 'replit.dev', 'ngrok.io', 'ngrok-free.app', 'ngrok.app', 'surge.sh',
  'wixsite.com', 'myshopify.com', 'notion.site', 'webflow.io', 'framer.website', 'carrd.co', 'readthedocs.io',
  'deno.dev', 'deta.dev', 'supabase.co', 'pythonanywhere.com', 'hf.space', 'streamlit.app', 'dyndns.org',
  'duckdns.org', 'no-ip.org', 'ddns.net',
  // PRIVATE: 무료·재판매 하위 도메인 등록소(누구나 그 아래 도메인을 받는다).
  'eu.org', 'us.kg', 'pp.ua',
  'co.com', 'uk.com', 'us.com', 'com.de', 'br.com', 'cn.com', 'de.com', 'eu.com', 'ru.com', 'sa.com', 'za.com', 'jpn.com',
  'gb.net', 'uk.net', 'us.org',
];

const EXACT = new Set<string>();
const WILDCARD = new Set<string>();
const EXCEPTION = new Set<string>();
for (const rule of RULES) {
  if (rule.startsWith('!')) EXCEPTION.add(rule.slice(1));
  else if (rule.startsWith('*.')) WILDCARD.add(rule.slice(2));
  else EXACT.add(rule);
}

/** 스냅샷 규칙 수(테스트가 비공허성으로 본다). */
export const PUBLIC_SUFFIX_RULE_COUNT = RULES.length;

/** ASCII 호스트 이름(LDH 라벨, 소문자, punycode 허용). 길이 ≤253, 라벨 1~63, 앞뒤 하이픈 없음, 두 라벨 이상, TLD 는 숫자만이 아니다. */
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

export function isHostname(value: string): boolean {
  if (value.length === 0 || value.length > 253) return false;
  const labels = value.split('.');
  if (labels.length < 2 || labels.some((label) => !LABEL.test(label))) return false;
  return !/^[0-9]+$/.test(labels[labels.length - 1] as string);
}

/** `domain` 이 공개 접미사 그 자체인가(PSL 규칙 + 기본 규칙 `*`). 소문자 호스트 이름을 받는다. */
export function isPublicSuffix(domain: string): boolean {
  if (EXCEPTION.has(domain)) return false;
  if (EXACT.has(domain)) return true;
  const dot = domain.indexOf('.');
  if (dot < 0) return true; // 한 라벨 — 기본 규칙 `*`.
  return WILDCARD.has(domain.slice(dot + 1));
}

/**
 * 호스트의 **등록 가능한 도메인(eTLD+1)** — 가장 긴 공개 접미사 + 한 라벨. 접미사 자체(또는 그 위)면 `null`. PSL 알고리즘과 같다: 예외 규칙이
 * 이기고(`!www.ck` → 접미사 `ck`), 그다음 가장 긴 평범한 규칙·와일드카드, 없으면 기본 규칙 `*`(마지막 라벨). 소문자 호스트 이름을 받는다.
 * `include_subdomains` 가 등록 가능 경계를 넘지 않게 하는 데 쓴다(`amazonaws.com` 과 `evil.s3.amazonaws.com` 은 등록 가능 도메인이 다르다).
 */
export function registrableDomain(host: string): string | null {
  const labels = host.split('.');
  let suffixLength = 1; // 기본 규칙 `*`.
  for (let index = 0; index < labels.length; index += 1) {
    const candidate = labels.slice(index).join('.');
    if (EXCEPTION.has(candidate)) {
      suffixLength = labels.length - index - 1;
      break;
    }
    const parent = labels.slice(index + 1).join('.');
    if (EXACT.has(candidate) || (index + 1 < labels.length && WILDCARD.has(parent))) {
      suffixLength = labels.length - index;
      break;
    }
  }
  if (labels.length <= suffixLength) return null;
  return labels.slice(labels.length - suffixLength - 1).join('.');
}

/**
 * **공용 메일 도메인** — 누구나 그 도메인 주소를 만들어 DMARC pass 로 메일을 보낼 수 있는 곳(보안 M2). 목록은 상수이고 테스트가 고정한다
 * (`test/unit/mail/verification/extract.test.ts`). 넓힐 때는 테스트도 같이 바꾼다.
 */
export const SHARED_MAILBOX_DOMAINS: readonly string[] = [
  // Google · Microsoft · Yahoo · Apple · AOL
  'gmail.com', 'googlemail.com',
  'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'outlook.kr', 'hotmail.co.kr', 'hotmail.co.uk', 'live.co.kr', 'live.co.uk',
  'yahoo.com', 'yahoo.co.kr', 'yahoo.co.jp', 'yahoo.co.uk', 'ymail.com', 'rocketmail.com',
  'icloud.com', 'me.com', 'mac.com',
  'aol.com',
  // 한국
  'naver.com', 'daum.net', 'hanmail.net', 'kakao.com', 'nate.com',
  // 보안·기타 전역
  'proton.me', 'protonmail.com', 'protonmail.ch', 'pm.me', 'tutanota.com', 'tuta.io', 'gmx.com', 'gmx.de', 'gmx.net', 'web.de',
  'mail.com', 'zoho.com', 'fastmail.com', 'yandex.com', 'yandex.ru', 'mail.ru',
  // 중국
  'qq.com', 'foxmail.com', '163.com', '126.com', 'yeah.net', 'sina.com', 'sohu.com',
];

const SHARED_MAILBOX = new Set(SHARED_MAILBOX_DOMAINS);

/**
 * `domain`(소문자 호스트 이름)이 공용 메일 도메인의 **apex 와 정확히 같은가**(2회차 수정 Y1, 코드 N2 — 리드 결정). 하위 도메인
 * (`accounts.kakao.com`·`mail.naver.com`)은 공용이 아니다: 사용자는 apex 주소(`someone@naver.com`)만 받고, 하위 호스트는 공급자 자신이
 * 운영한다. 그래서 `sender_domain=accounts.kakao.com` 은 보통 사이트 도메인처럼 확정 모드가 된다.
 */
export function isSharedMailboxDomain(domain: string): boolean {
  return SHARED_MAILBOX.has(domain);
}

/**
 * 공용 apex 에서 **공급자 시스템 발신**으로 보는 로컬파트(모든 공용 apex 공통, 소문자 정확 일치). 리드 예시(noreply·no-reply·
 * do-not-reply·donotreply·account(s)·accounts-noreply·verify·verification·security·auth·login·notice·info·help)에 구분자 변형을 더했다.
 *
 * **가정(ADR-0013 에 적는다): 공급자는 이런 이름의 사용자 가입을 막는다.** 그래서 `noreply@naver.com` 처럼 공용 apex 에서 DMARC pass 로
 * 온 이 이름의 메일은 공급자 자신이 보낸 것으로 본다. 가정이 틀린 공급자(과거에 이런 이름을 사용자에게 내준 곳)에서는 그 주소의 주인이
 * 확정 코드를 흉내 낼 수 있다 — 잔여 위험이다. 실메일 표본으로 공급자별 목록을 좁히거나 넓힐 때는 테스트도 같이 바꾼다.
 */
export const SYSTEM_SENDER_LOCAL_PARTS: readonly string[] = [
  'noreply', 'no-reply', 'no_reply', 'do-not-reply', 'do_not_reply', 'donotreply',
  'account', 'accounts', 'accounts-noreply', 'account-noreply',
  'verify', 'verification', 'security', 'auth', 'login', 'notice', 'info', 'help',
];

/**
 * 공급자별 보강 — 공급자가 자기 이름으로 예약해 둔 것으로 보는 로컬파트(같은 가정). 작성자(모델) 지식 기준이고 실메일 표본으로 확인하지
 * 않았다 — 공급자 이름 자체(`naver@naver.com`)만 둔다.
 */
export const PROVIDER_SYSTEM_SENDER_LOCAL_PARTS: Readonly<Record<string, readonly string[]>> = {
  'naver.com': ['naver'],
  'kakao.com': ['kakao'],
  'daum.net': ['daum'],
  'hanmail.net': ['daum', 'hanmail'],
  'nate.com': ['nate'],
};

const SYSTEM_SENDER = new Set(SYSTEM_SENDER_LOCAL_PARTS);

/**
 * `fromAddress`(소문자 `local@domain`, 행의 CHECK 와 같은 모양)가 공용 apex 의 **공급자 시스템 발신 주소**인가. 도메인이 공용 apex 가
 * 아니면 `false`(이 함수의 질문이 아니다 — 호출자가 `isSharedMailboxDomain` 을 먼저 본다). 로컬파트는 정확 일치다(`+태그`·점 변형을
 * 풀지 않는다 — `noreply+x`·`no.reply` 는 목록에 없다).
 */
export function isSharedMailboxSystemSender(fromAddress: string): boolean {
  const at = fromAddress.lastIndexOf('@');
  if (at <= 0) return false;
  const local = fromAddress.slice(0, at);
  const domain = fromAddress.slice(at + 1);
  if (!isSharedMailboxDomain(domain)) return false;
  return SYSTEM_SENDER.has(local) || (PROVIDER_SYSTEM_SENDER_LOCAL_PARTS[domain] ?? []).includes(local);
}
