/**
 * src/mail/signup/classify.ts — **바깥 가입 감지**(ADR-0016 2026-10-08 개정 · 계획 watch-and-dev-surface 묶음 D 항목 2b). 순수 · I/O 없음 · LLM 없음.
 *
 * 에이전트가 어떤 서비스에 가입한 것 같은지 받은 메일 한 통에서 결정적으로 고른다 — 가입 확인(인증) · 환영 · 계정 생성 메일. 결과는 **서비스 도메인
 * (등록 가능 도메인 eTLD+1, 전체 PSL `src/domains/psl.ts`) · 종류** 둘뿐이다. 제목 · 본문 · 주소는 결과에 없다(행 · 알림 · 로그 어디에도 실리지 않는다).
 *
 * 문(전부 참이어야 한다 — 하나라도 모르면 감지하지 않는다):
 *   - **DMARC 인증된 From**(`fromAuthenticated`) — 위조 From 으로 "에이전트가 bank.example 에 가입했다" 를 지어내지 못하게.
 *   - From 도메인의 등록 가능 도메인이 있다(공개 접미사 자체 · 그 위는 아니다) · `atmark.ai` 가 아니다(우리 시스템 메일).
 *   - 알림형 로컬파트(`notifications@github.com` — 제목을 남이 쓴다)가 아니고, 공용 메일 서비스(gmail · naver … — 등록 가능 도메인 비교)가 아니다
 *     (사람이 보낸 "환영합니다" 는 가입이 아니다).
 *   - 답장 · 전달 제목이 아니다.
 * 종류(제목 우선 · 먼저 맞는 것이 이긴다 — ko · en · ja · zh · es · fr · de):
 *   - `account_created` — 계정 생성 · 가입 완료 · 가입해 주셔서 감사합니다.
 *   - `welcome` — 환영 · ようこそ · 欢迎 · bienvenue · willkommen.
 *   - `verification` — 이메일 · 계정 · 가입 확인(인증). 또는 제목이 인증형(확인 · 인증 · 활성화)이고 본문에 확인 링크(경로 · 쿼리가 verify 꼴)가 있는데
 *     비밀번호 재설정 · 로그인 · 보안 알림 제목이 아닐 때.
 * 비밀번호 재설정 · 로그인 코드 · 새 기기 알림은 가입이 아니다(제외 — 이미 가진 계정의 일). 모든 정규식은 상한 있는 수량자만 쓴다(인터넷 입력 — 선형 시간).
 *
 * **`src/mail/verification/**` 를 import 하지 않는다**(arch `verification-boundary` — 워커 폐포에 인증코드 추출 모듈이 없다, AC-A1-7). 이 파일은 코드 · 링크를
 * **뽑지 않는다** — "이 메일이 가입 메일인가" 만 말하고, 결과는 기록 · 알림(정보)일 뿐 어떤 자동 행동의 입구도 아니다. 그래서 필요한 어휘(답장 제목 · 알림형
 * 로컬파트 · 공용 메일 도메인 · 확인 링크 꼴)는 이 목적에 맞게 따로 적는다(공용 메일 도메인은 등록 가능 도메인으로 비교 — 공급자의 시스템 메일도 건너뛴다: 좁은 쪽).
 */

import { registrableDomainOf } from '../../domains/psl';

export const SIGNUP_KINDS = ['verification', 'welcome', 'account_created'] as const;
export type SignupKind = (typeof SIGNUP_KINDS)[number];

export interface SignupDetection {
  /** 등록 가능 도메인(소문자). */
  readonly serviceDomain: string;
  readonly kind: SignupKind;
}

export interface SignupMailInput {
  readonly fromAddress: string;
  readonly fromAuthenticated: boolean;
  readonly subject: string | null;
  readonly text: string | null;
}

/** 우리 도메인 — 시스템 메일(환영 · 로그인 · 알림)은 가입 감지 대상이 아니다. */
const OWN_DOMAINS: ReadonlySet<string> = new Set(['atmark.ai']);
const MAX_SUBJECT = 300;
const MAX_TEXT = 8_000;
const MAX_URLS = 40;
const DOMAIN_SHAPE = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

const ACCOUNT_CREATED = new RegExp(
  [
    // en
    'account\\s(?:has\\sbeen\\s|is\\s|was\\s)?(?:created|ready|activated|set\\sup)',
    'thanks?\\s(?:you\\s)?for\\s(?:signing\\sup|registering|joining|creating\\san\\saccount|your\\sregistration)',
    'registration\\s(?:is\\s)?(?:complete|completed|confirmed|successful)',
    "you(?:'re|\\sare)\\s(?:now\\s)?(?:registered|signed\\sup)",
    // ko
    '가입(?:이)?\\s?(?:완료|되었|됐|을\\s?축하|해\\s?주셔서)',
    '계정(?:이)?\\s?(?:생성|만들어|개설)',
    // ja
    '(?:会員)?登録(?:が)?完了',
    'アカウント(?:が|の)?(?:作成|開設)',
    // zh
    '注册(?:成功|完成)',
    '(?:账户|帐户|账号|帳戶|帳號)(?:已)?(?:创建|建立|開通|开通)',
    // es
    'cuenta\\s(?:ha\\ssido\\s)?(?:creada|activada)',
    'registro\\s(?:completado|exitoso|confirmado)',
    'gracias\\spor\\s(?:registrarte|registrarse|unirte)',
    // fr
    'compte\\s(?:a\\sété\\s)?(?:créé|activé)',
    'inscription\\s(?:confirmée|réussie|terminée)',
    'merci\\s(?:de\\svous\\sêtre\\sinscrit|pour\\svotre\\sinscription)',
    // de
    'konto\\s(?:wurde\\s)?(?:erstellt|angelegt|eröffnet|aktiviert)',
    'registrierung\\s(?:erfolgreich|abgeschlossen)',
    'danke\\sfür\\s(?:ihre|deine)\\s(?:registrierung|anmeldung)',
  ].join('|'),
  'iu',
);

const WELCOME = /\bwelcome\b|환영(?:합니다|해요|해\s?드립니다)|오신\s?것을\s?환영|ようこそ|欢迎|歡迎|\bbienvenid[oa]s?\b|\bbienvenue\b|\bwillkommen\b/iu;

const SIGNUP_VERIFICATION = new RegExp(
  [
    // en
    '(?:confirm|verify)\\s(?:your\\s)?(?:e-?mail|email\\saddress|account|registration|sign[-\\s]?up|subscription)',
    'activate\\s(?:your\\s)?account',
    'complete\\s(?:your\\s)?(?:registration|sign[-\\s]?up)',
    // ko
    '(?:이메일|메일|계정)\\s?(?:주소\\s?)?(?:인증|확인)',
    '(?:회원\\s?)?가입\\s?(?:인증|확인)',
    // ja
    'メール(?:アドレス)?(?:の)?(?:確認|認証)',
    '本登録',
    // zh
    '(?:验证|確認|确认|驗證)(?:您的)?(?:邮箱|电子邮件|邮件地址|電子郵件|账户|帐户|账号)',
    '激活(?:您的)?(?:账户|帐户|账号)',
    // es
    '(?:confirma|verifica)r?\\s(?:tu|su)\\s(?:correo|cuenta|dirección|registro)',
    'activa\\s(?:tu|su)\\scuenta',
    // fr
    '(?:confirmez|vérifiez|confirmer|vérifier)\\s(?:votre\\s)?(?:adresse|e-?mail|compte|inscription)',
    'activez\\svotre\\scompte',
    // de
    '(?:bestätigen|verifizieren)\\ssie\\s(?:ihre|deine)\\s(?:e-?mail|e-?mail-adresse|registrierung|anmeldung|konto)',
    'bestätige\\sdeine\\s(?:e-?mail|registrierung|anmeldung)',
    'konto\\saktivieren',
  ].join('|'),
  'iu',
);

/** 가입이 아닌 계정 메일 — 비밀번호 재설정 · 로그인 · 보안 알림(이미 가진 계정의 일). 제목에 있으면 인증형 판정에서 뺀다. */
const NOT_SIGNUP = new RegExp(
  [
    'password', '\\breset\\b', 'sign[-\\s]?in\\b', 'log[-\\s]?in\\b', 'new\\s(?:device|login|sign[-\\s]?in)', 'security\\salert', 'two[-\\s](?:factor|step)', '\\b2FA\\b',
    '비밀\\s?번호', '로그인', '새\\s?기기', '보안\\s?알림',
    'パスワード', 'ログイン', '密码', '密碼', '登录', '登入',
    'contraseña', 'iniciar\\ssesión', 'mot\\sde\\spasse', 'connexion', 'passwort', 'anmeldung\\sbei',
  ].join('|'),
  'iu',
);

/** 답장 · 전달 제목(사람이 쓴 대화). */
const REPLY_PREFIX = /^\s{0,8}(?:re|fwd?|fw|aw|sv|답장|회신|전달)\s{0,4}(?:\[\d{1,4}\]\s{0,4})?[:：]/iu;
/** 알림형 로컬파트 조각 — 제목 · 본문을 남(사용자)이 쓴다(`notifications@github.com`). */
const NOTIFICATION_PARTS: ReadonlySet<string> = new Set(['notification', 'notifications', 'comment', 'comments', 'mention', 'mentions', 'digest', 'discussion', 'discussions']);
/** 공용 메일 서비스(누구나 그 도메인 주소로 DMARC pass 메일을 보낸다) — 등록 가능 도메인으로 비교. 가입 감지 대상이 아니다. */
const SHARED_MAILBOX: ReadonlySet<string> = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'outlook.kr', 'hotmail.co.kr', 'hotmail.co.uk', 'live.co.kr', 'live.co.uk',
  'yahoo.com', 'yahoo.co.kr', 'yahoo.co.jp', 'yahoo.co.uk', 'ymail.com', 'rocketmail.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com',
  'naver.com', 'daum.net', 'hanmail.net', 'kakao.com', 'nate.com',
  'proton.me', 'protonmail.com', 'protonmail.ch', 'pm.me', 'tutanota.com', 'tuta.io', 'gmx.com', 'gmx.de', 'gmx.net', 'web.de', 'mail.com', 'zoho.com',
  'fastmail.com', 'yandex.com', 'yandex.ru', 'mail.ru', 'qq.com', 'foxmail.com', '163.com', '126.com', 'yeah.net', 'sina.com', 'sohu.com',
]);
/** 인증형 제목의 넓은 표지(본문 판정의 문). */
const VERIFY_SUBJECT = /verif|confirm|activat|인증|확인|활성화|確認|認証|验证|確認|激活|confirma|vérif|bestätig/iu;
/** 확인 링크 꼴(URL 경로 · 쿼리) — 재설정 · 로그인 꼴이 먼저 이긴다. */
const LINK_RESET = /reset[-_\s]?password|password[-_\s]?reset|reset|recover/iu;
const LINK_LOGIN = /magic[-_\s]?link|log[-_\s]?in|sign[-_\s]?in|auth(?:enticate)?\b/iu;
const LINK_VERIFY = /verif|confirm|activat|validat/iu;

function isNotificationLocalPart(address: string): boolean {
  const local = address.slice(0, address.lastIndexOf('@'));
  return local.split(/[-_.+]/u).some((part) => NOTIFICATION_PARTS.has(part));
}

const URL_PATTERN = /https?:\/\/[^\s<>"'()]{1,2048}/giu;

function serviceDomainOf(fromAddress: string): string | null {
  const address = fromAddress.trim().toLowerCase();
  const at = address.lastIndexOf('@');
  if (at < 1) return null;
  const host = address.slice(at + 1);
  if (host.length > 253 || !DOMAIN_SHAPE.test(host)) return null;
  const registrable = registrableDomainOf(host);
  if (registrable === null || !DOMAIN_SHAPE.test(registrable) || OWN_DOMAINS.has(registrable) || SHARED_MAILBOX.has(registrable)) return null;
  return registrable;
}

/** 본문에 확인(verify 꼴) 링크가 있는가 — URL 의 경로 · 쿼리만 본다(링크 글은 남이 쓴다). 재설정 · 로그인 꼴이 먼저 이긴다. */
function hasVerifyLink(text: string): boolean {
  let seen = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    seen += 1;
    if (seen > MAX_URLS) break;
    let target: string;
    try {
      const url = new URL(match[0]);
      target = `${url.pathname}?${url.search}`;
    } catch {
      continue;
    }
    if (LINK_RESET.test(target) || LINK_LOGIN.test(target)) continue;
    if (LINK_VERIFY.test(target)) return true;
  }
  return false;
}

/** 메일 한 통 → 가입 감지(없으면 `null`). */
export function detectSignup(mail: SignupMailInput): SignupDetection | null {
  if (!mail.fromAuthenticated || mail.subject === null) return null;
  const address = mail.fromAddress.trim().toLowerCase();
  const serviceDomain = serviceDomainOf(address);
  if (serviceDomain === null || isNotificationLocalPart(address)) return null;
  const subject = mail.subject.slice(0, MAX_SUBJECT);
  if (REPLY_PREFIX.test(subject)) return null;

  if (ACCOUNT_CREATED.test(subject)) return { serviceDomain, kind: 'account_created' };
  if (WELCOME.test(subject)) return { serviceDomain, kind: 'welcome' };
  if (NOT_SIGNUP.test(subject)) return null;
  if (SIGNUP_VERIFICATION.test(subject)) return { serviceDomain, kind: 'verification' };
  const text = (mail.text ?? '').slice(0, MAX_TEXT);
  if (VERIFY_SUBJECT.test(subject) && (SIGNUP_VERIFICATION.test(text) || ACCOUNT_CREATED.test(text)) && hasVerifyLink(text)) {
    return { serviceDomain, kind: 'verification' };
  }
  return null;
}
