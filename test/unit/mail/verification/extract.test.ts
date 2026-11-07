/**
 * 메일 기본기 A1 — 인증코드·확인 링크 추출기(`src/mail/verification/`, 순수 함수).
 *
 *   - AC-A1-1 코퍼스(`test/fixtures/verification/synthetic.json`, 합성 ≥40 · 교란 ≥10): `high` 정밀도 100% · 재현율 ≥90% · 교란 `high` 0.
 *     실메일 표본(≥20, 진윤겸 테스트 에이전트 가입 메일 치환본)은 아직 없다 — 들어오면 같은 단언이 그 파일도 읽는다(`real-*.json`).
 *   - 코드 규칙: 모양 · 제외(날짜·시각·전화·금액·주문/송장/사업자·URL 안) · 제목은 제목 안의 키워드로만 `high`.
 *   - AC-A1-3 링크: http·userinfo·IP·8443·타 도메인·`badexample.com`·`javascript:` 0 · 종류 없는 링크 0 · 5개 상한.
 *     추출기 폐포에 `node:http(s)`·`fetch`·AWS SDK 0(소스 글자로 본다).
 *   - 1차 수정 X1(보안 M2): 링크 호스트는 `include_subdomains=false` 면 정확 일치만, `true` 여도 등록 가능 경계 안 · 리다이렉트 파라미터
 *     (값이 URL 인 것 포함)·OAuth 동의·기기 로그인 링크 0 · 확정 모드의 문은 제목(`isVerificationSubject`) · 공용 메일 도메인 목록 고정.
 *   - AC-A1-2 공개 접미사: `co.kr`·`github.io`·`kr` 은 접미사, `github.com`·`example.co.kr` 은 아니다 · 보정한 접미사(보안 L1).
 *   - 2회차 수정 Y1: 링크 종류는 URL 경로·쿼리로만(라벨 폴백 없음, 보안 R1) · 알림형 발신 로컬파트는 확정 모드 밖(보안 R1) · 공용 메일
 *     도메인은 apex 정확 일치만, 그 apex 에서는 공급자 시스템 발신 주소만(코드 N2).
 *   - 선형 시간(보안 H1 · 코드 H2 · 보안 L3) — 적대 입력(후보·키워드 수만 개, 점 수천 개 링크)이 시간 상한 안에 끝난다.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  extractCodes,
  extractLinks,
  hostInScope,
  isNotificationSender,
  isVerificationSubject,
  isVerifiedModeSender,
  MAX_LINKS,
  MAX_SCAN_CHARS,
  normalizeCode,
  type MailText,
  type SenderScope,
} from '../../../../src/mail/verification/extract';
import {
  isHostname,
  isPublicSuffix,
  isSharedMailboxDomain,
  isSharedMailboxSystemSender,
  PROVIDER_SYSTEM_SENDER_LOCAL_PARTS,
  PUBLIC_SUFFIX_RULE_COUNT,
  registrableDomain,
  SHARED_MAILBOX_DOMAINS,
  SYSTEM_SENDER_LOCAL_PARTS,
} from '../../../../src/mail/verification/public-suffix';

const FIXTURES = join(__dirname, '../../../fixtures/verification');
const SOURCE_DIR = join(__dirname, '../../../../src/mail/verification');

interface CorpusMail {
  readonly id: string;
  readonly from_domain: string;
  readonly subject: string | null;
  readonly text: string;
  readonly html_text: string | null;
  readonly expected_high?: readonly string[];
  readonly decoy?: boolean;
}

function corpus(): CorpusMail[] {
  return readdirSync(FIXTURES)
    .filter((name) => name.endsWith('.json'))
    .flatMap((name) => (JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as { mails: CorpusMail[] }).mails);
}

function mail(text: string, subject: string | null = null, htmlText: string | null = null): MailText {
  return { subject, text, htmlText };
}

const EXACT: SenderScope = { senderDomain: 'github.com', includeSubdomains: false };
const WITH_SUBDOMAINS: SenderScope = { senderDomain: 'github.com', includeSubdomains: true };

function highs(input: MailText): string[] {
  return extractCodes(input)
    .filter((code) => code.confidence === 'high')
    .map((code) => code.value);
}

describe('AC-A1-1 코퍼스 — high 정밀도 100% · 재현율 ≥90% · 교란 high 0', () => {
  const mails = corpus();

  it('비공허성: 합성 ≥40통, 교란 ≥10통', () => {
    expect(mails.length).toBeGreaterThanOrEqual(40);
    expect(mails.filter((m) => m.decoy === true).length).toBeGreaterThanOrEqual(10);
    expect(new Set(mails.map((m) => m.id)).size).toBe(mails.length);
  });

  it('정밀도·재현율·교란', () => {
    let truePositives = 0;
    let falsePositives = 0;
    let expected = 0;
    const wrong: string[] = [];
    for (const m of mails) {
      const got = highs({ subject: m.subject, text: m.text, htmlText: m.html_text }).map(normalizeCode);
      const want = new Set((m.expected_high ?? []).map(normalizeCode));
      expected += want.size;
      for (const value of got) {
        if (want.has(value)) truePositives += 1;
        else {
          falsePositives += 1;
          wrong.push(`${m.id}:${value}`);
        }
      }
      if (m.decoy === true) expect(got, m.id).toEqual([]);
    }
    expect(wrong).toEqual([]);
    expect(falsePositives).toBe(0);
    expect(truePositives / expected).toBeGreaterThanOrEqual(0.9);
  });

  it('확정 모드의 문 — 코드를 기대하는 코퍼스 메일은 전부 제목이 인증 메일이다(제목 문이 재현율을 깎지 않는다)', () => {
    const blocked = mails.filter((m) => (m.expected_high ?? []).length > 0 && !isVerificationSubject(m.subject)).map((m) => m.id);
    expect(blocked).toEqual([]);
  });
});

describe('코드 규칙', () => {
  it('모양: 숫자 4~8 · 123-456 · 영숫자 6~10(숫자·글자 둘 다) · 띄운 숫자는 붙인다', () => {
    expect(highs(mail('Verification code: 1234'))).toEqual(['1234']);
    expect(highs(mail('Verification code: 12345678'))).toEqual(['12345678']);
    expect(highs(mail('Verification code: 123456789'))).toEqual([]);
    expect(highs(mail('Verification code: 123'))).toEqual([]);
    expect(highs(mail('Verification code: 123-456'))).toEqual(['123-456']);
    expect(highs(mail('Verification code: AB12CD'))).toEqual(['AB12CD']);
    expect(highs(mail('Verification code: ABCDEF'))).toEqual([]);
    expect(highs(mail('Verification code:\n\n4 8 2 9 1 3'))).toEqual(['482913']);
  });

  it('제외: 날짜·시각·버전·IP·금액·전화·주문/송장/사업자·URL 안·# 번호', () => {
    const none = (text: string): void => expect(extractCodes(mail(text)), text).toEqual([]);
    none('Verification code 2026-09-26');
    none('인증번호 2026년 9월');
    none('Verification code valid until 10:30:15');
    none('Verification code v2.3.1');
    none('Verification code 192.168.0.1');
    none('Security code $4999');
    none('인증번호 요청 금액 39000원');
    none('Security code 12,000');
    none('인증번호 문의 1588-1234');
    none('인증번호 문의 전화 02-1234-5678');
    none('Your verification code for order 55667788');
    none('인증번호: 송장 684210395');
    none('인증 코드 사업자등록번호 123-45-67890');
    none('Verification code https://example.com/verify/482913');
    none('Verification code #482913');
    none('verification code 20260926');
  });

  it('키워드 가까이 첫 후보만 high · 나머지는 low · 키워드 없으면 low', () => {
    const result = extractCodes(mail('Your verification code is 482913. Reference ID 77AA99 is not a code. Also 553311.'));
    expect(result).toEqual([
      { value: '482913', confidence: 'high' },
      { value: '553311', confidence: 'low' },
    ]);
    expect(extractCodes(mail('Hello 482913 world'))).toEqual([{ value: '482913', confidence: 'low' }]);
    expect(highs(mail('482913 is your verification code'))).toEqual(['482913']);
    expect(highs(mail('SAVE20X is your promo code'))).toEqual([]);
    expect(highs(mail('Your promo code is SAVE20X'))).toEqual([]);
  });

  it('흔한 표현 "Your code: 482913"(코드 리뷰 M1) — high · 판촉·추천·초대·교환 코드는 아니다', () => {
    expect(highs(mail('Your code: 482913'))).toEqual(['482913']);
    expect(highs(mail('Your Slack code: 482913'))).toEqual(['482913']);
    expect(highs(mail('Hi there,\n\nYour code is 482913'))).toEqual(['482913']);
    for (const decoy of [
      'Your promo code: SAVE20X',
      'Your referral code: AB12CD',
      'Your invite code: AB12CD',
      'Your discount code: 482913',
      'Your gift code: 482913',
      'Your redemption code: AB12CD34',
      'Your license code: AB12CD34',
      'Your zip code: 94103',
      'Your order code: 55667788',
    ]) {
      expect(highs(mail(decoy)), decoy).toEqual([]);
    }
  });

  it('제목은 제목 안의 키워드로만 high — 본문 키워드가 제목 숫자를 high 로 만들지 않는다', () => {
    expect(extractCodes(mail('Your verification code is below.', 'Welcome 773311'))).toEqual([{ value: '773311', confidence: 'low' }]);
    expect(highs(mail('Welcome!', '773311 is your verification code'))).toEqual(['773311']);
  });

  it('text 와 html_text 를 정규형으로 합친다(같은 값이면 높은 신뢰도 하나)', () => {
    expect(extractCodes(mail('Code 482913', null, '인증 코드: 482913'))).toEqual([{ value: '482913', confidence: 'high' }]);
  });
});

describe('AC-A1-3 링크 — https·호스트 범위·종류만', () => {
  const text = [
    'Verify your email (https://github.com/users/verify?token=abc)',
    'Confirm on mobile (https://m.github.com/confirm/abc).',
    'http://github.com/verify?token=plain',
    'https://user:pw@github.com/verify',
    'https://1.2.3.4/verify',
    'https://[::1]/verify',
    'https://github.com:8443/verify',
    'https://badexample.com/verify',
    'https://evil.example/verify-account',
    'javascript:alert(1)',
    'Unsubscribe (https://github.com/unsubscribe?u=1)',
    'Logo (https://github.com/images/logo.png)',
  ].join('\n');

  it('include_subdomains=false — 정확 일치 https 인증 링크만 · 하위·타 도메인은 세고 버린다', () => {
    const result = extractLinks(mail(text), EXACT);
    expect(result.links).toEqual([{ url: 'https://github.com/users/verify?token=abc', kind: 'verify' }]);
    expect(result.droppedHostMismatch).toBe(3);
    const serialized = JSON.stringify(result.links);
    for (const bad of ['http://', 'user:pw', '1.2.3.4', '8443', 'badexample', 'evil.example', 'javascript', 'unsubscribe', 'logo', 'm.github']) {
      expect(serialized).not.toContain(bad);
    }
  });

  it('include_subdomains=true — 하위도 받는다(등록 가능 경계 안)', () => {
    const result = extractLinks(mail(text), WITH_SUBDOMAINS);
    expect(result.links).toEqual([
      { url: 'https://github.com/users/verify?token=abc', kind: 'verify' },
      { url: 'https://m.github.com/confirm/abc', kind: 'verify' },
    ]);
    expect(result.droppedHostMismatch).toBe(2);
  });

  it('하위를 받아도 PSL 등록 가능 경계를 넘지 않는다(amazonaws.com 아래 s3.amazonaws.com 의 버킷은 남의 것)', () => {
    const aws: SenderScope = { senderDomain: 'amazonaws.com', includeSubdomains: true };
    expect(hostInScope('amazonaws.com', aws)).toBe(true);
    expect(hostInScope('signin.amazonaws.com', aws)).toBe(true);
    expect(hostInScope('evil.s3.amazonaws.com', aws)).toBe(false);
    expect(hostInScope('s3.amazonaws.com', aws)).toBe(false);
    const result = extractLinks(
      mail('Verify https://evil.s3.amazonaws.com/verify?t=1\nVerify https://signin.amazonaws.com/verify?t=2'),
      aws,
    );
    expect(result.links).toEqual([{ url: 'https://signin.amazonaws.com/verify?t=2', kind: 'verify' }]);
    expect(result.droppedHostMismatch).toBe(1);
    // 정확 일치 모드는 하위를 받지 않는다 · 비슷한 이름도 아니다.
    expect(hostInScope('m.github.com', EXACT)).toBe(false);
    expect(hostInScope('badgithub.com', WITH_SUBDOMAINS)).toBe(false);
    expect(hostInScope('github.com.evil.example', WITH_SUBDOMAINS)).toBe(false);
  });

  it('리다이렉트 파라미터(키 · 값이 URL)·경로 안 URL·OAuth 동의·기기 로그인 링크는 싣지 않는다(보안 M2)', () => {
    const redirects = [
      'https://github.com/verify?token=a&redirect_uri=x',
      'https://github.com/verify?token=a&redirectUrl=x',
      'https://github.com/verify?token=a&return_to=%2Fsettings',
      'https://github.com/verify?token=a&returnTo=x',
      'https://github.com/verify?token=a&next=x',
      'https://github.com/verify?token=a&continue=x',
      'https://github.com/verify?token=a&url=x',
      'https://github.com/verify?token=a&dest=x',
      'https://github.com/verify?token=a&destination=x',
      'https://github.com/verify?token=a&goto=x',
      'https://github.com/verify?token=a&target=x',
      'https://github.com/verify?token=a&r=x',
      'https://github.com/verify?token=a&u=x',
      'https://github.com/verify?token=a&state=https%3A%2F%2Fevil.example',
      'https://github.com/verify?token=a&cb=%2F%2Fevil.example',
      'https://github.com/verify#token=a&back=https://evil.example',
      'https://github.com/verify/redirect/https://evil.example',
      'https://github.com/login/oauth/authorize?client_id=evil',
      'https://github.com/oauth2/v2.0/authorize?client_id=evil',
      'https://github.com/login/device',
      'https://github.com/device?code=ABCD-1234',
    ];
    for (const link of redirects) {
      expect(extractLinks(mail(`Verify your account: ${link}`), EXACT).links, link).toEqual([]);
    }
    // 흔한 인증 링크는 그대로 — 토큰·서명 파라미터·경로 안 `device` 글자(`verified-device`).
    const kept = [
      'https://github.com/users/verify?token=abc&sig=def',
      'https://github.com/sessions/verified-device?token=abc',
      'https://github.com/confirm/abc?utm_source=email',
    ];
    for (const link of kept) {
      expect(extractLinks(mail(`Verify your account: ${link}`), EXACT).links.map((l) => l.url), link).toEqual([link]);
    }
  });

  it('★ 보안 R1 — 종류는 URL 경로·쿼리로만: 라벨만 "Confirm your account" 인 링크는 인증 링크가 아니다', () => {
    const labelOnly = [
      'Confirm your account: https://github.com/octo/repo/issues/12',
      'Verify your email https://github.com/attacker',
      'Reset your password → https://github.com/octo/repo/pull/42',
      '로그인 확인: https://github.com/octo/repo',
    ];
    for (const text of labelOnly) {
      const result = extractLinks(mail(text), EXACT);
      expect(result.links, text).toEqual([]);
      expect(result.droppedHostMismatch, text).toBe(0);
    }
    // URL 자체에 종류가 있으면 라벨과 무관하게 그 종류 · 라벨의 제외 표지(수신 거부)는 여전히 뺀다.
    expect(extractLinks(mail('Click here https://github.com/users/verify?token=abc'), EXACT).links).toEqual([
      { url: 'https://github.com/users/verify?token=abc', kind: 'verify' },
    ]);
    expect(extractLinks(mail('Unsubscribe https://github.com/users/verify?token=abc'), EXACT).links).toEqual([]);
  });

  it('링크 끝 구두점을 뗀다(끝에서부터 자르는 루프)', () => {
    expect(extractLinks(mail('Verify: https://github.com/verify/abc.,;:!?\'"’”>'), EXACT).links).toEqual([
      { url: 'https://github.com/verify/abc', kind: 'verify' },
    ]);
  });

  it('2048자 초과 버림 · 5개 상한 · 종류(password_reset·login·verify)', () => {
    expect(extractLinks(mail(`Verify https://github.com/verify?t=${'a'.repeat(2100)}`), EXACT).links).toEqual([]);
    const many = Array.from({ length: 8 }, (_, index) => `https://github.com/verify/${String(index)}`).join('\n');
    expect(extractLinks(mail(many), EXACT).links).toHaveLength(MAX_LINKS);
    const kinds = extractLinks(
      mail('https://github.com/password/reset/x\nhttps://github.com/login/magic/x\nhttps://github.com/activate/x'),
      EXACT,
    ).links.map((link) => link.kind);
    expect(kinds).toEqual(['password_reset', 'login', 'verify']);
  });

  it('추출기 소스에 네트워크·AWS SDK 가 없다(링크를 따라가지 않는다)', () => {
    const files = readdirSync(SOURCE_DIR).filter((name) => name.endsWith('.ts'));
    expect(files.length).toBeGreaterThanOrEqual(4);
    for (const name of files) {
      const source = readFileSync(join(SOURCE_DIR, name), 'utf8');
      expect(source, name).not.toMatch(/from ['"](?:node:)?(?:https?|net|tls|dns)['"]/);
      expect(source, name).not.toMatch(/@aws-sdk|\bfetch\s*\(|XMLHttpRequest|from ['"]pg['"]/);
    }
  });
});

describe('확정 모드의 문 — 제목이 인증 메일인가(보안 M2)', () => {
  it('인증 메일 제목은 통과', () => {
    for (const subject of [
      '[GitHub] Please verify your device',
      '730215 is your Instagram code',
      '[카카오] 인증번호 안내',
      'Confirm your email address',
      'Reset your password',
      'Your magic link to sign in',
      'Sign in to Slack',
      'Your Notion login code',
      '이메일 인증을 완료해 주세요',
      '[네이버] 비밀번호 재설정',
      'Your one-time passcode',
      'Activate your account',
    ]) {
      expect(isVerificationSubject(subject), subject).toBe(true);
    }
  });

  it('GitHub 알림(이슈·PR 댓글)·답장·전달·제목 없음은 통과하지 않는다', () => {
    for (const subject of [
      'Re: [octo/repo] Add caching layer (PR #42)',
      '[octo/repo] Build fails on main (Issue #12)',
      '[octo/repo] New comment on issue #12',
      'Re: Verification code for your account',
      'Fwd: Your verification code is 482913',
      'RE[2]: confirm your email',
      '답장: 인증번호 안내',
      'Weekly digest',
      '',
      null,
    ]) {
      expect(isVerificationSubject(subject), String(subject)).toBe(false);
    }
  });
});

describe('확정 모드의 발신 주소 — 알림형 로컬파트 · 공용 apex 사용자 주소(2회차 수정 Y1)', () => {
  it('★ 보안 R1 — 알림형 로컬파트(조각 단위)는 확정 모드 밖 · noreply 는 알림이 아니다', () => {
    for (const address of [
      'notifications@github.com', 'notification@facebookmail.com', 'notification+abc@example.com', 'comments-noreply@docs.google.com',
      'noreply-comments@example.com', 'comment@example.com', 'mention@example.com', 'mentions@example.com', 'digest-noreply@quora.com',
      'discussions@example.com', 'Notifications@GitHub.com',
    ]) {
      expect(isNotificationSender(address), address).toBe(true);
      expect(isVerifiedModeSender(address.toLowerCase()), address).toBe(false);
    }
    for (const address of ['noreply@github.com', 'no-reply@accounts.google.com', 'security@github.com', 'notify-me@example.com', 'commentary@example.com']) {
      expect(isNotificationSender(address), address).toBe(false);
      expect(isVerifiedModeSender(address), address).toBe(true);
    }
  });

  it('★ 코드 N2 — 공용 apex 는 시스템 발신 주소만 · 하위 도메인은 보통 사이트처럼', () => {
    expect(isVerifiedModeSender('noreply@naver.com')).toBe(true);
    expect(isVerifiedModeSender('noreply@kakao.com')).toBe(true);
    expect(isVerifiedModeSender('noreply@accounts.kakao.com')).toBe(true);
    expect(isVerifiedModeSender('someone@accounts.kakao.com')).toBe(true);
    expect(isVerifiedModeSender('attacker@naver.com')).toBe(false);
    expect(isVerifiedModeSender('attacker@gmail.com')).toBe(false);
    expect(isVerifiedModeSender('notifications@naver.com')).toBe(false);
  });
});

describe('AC-A1-2 공개 접미사', () => {
  it('접미사와 그 위는 접미사 · 등록 가능한 도메인과 그 아래는 아니다', () => {
    expect(PUBLIC_SUFFIX_RULE_COUNT).toBeGreaterThan(100);
    for (const suffix of ['kr', 'com', 'co.kr', 'github.io', 'vercel.app', 'co.uk', 'anything.ck']) expect(isPublicSuffix(suffix), suffix).toBe(true);
    for (const domain of ['github.com', 'example.co.kr', 'me.github.io', 'www.ck', 'mail.google.com']) expect(isPublicSuffix(domain), domain).toBe(false);
  });

  it('보정(보안 L1) — 누락 접미사 추가 · PSL 에 없는 사이트 도메인 제거', () => {
    for (const suffix of ['eu.org', 'us.kg', 'pp.ua', 'co.com', 'uk.com', 'us.com', 'com.de', 'co.at', 'com.pk', 'com.ng', 'up.railway.app']) {
      expect(isPublicSuffix(suffix), suffix).toBe(true);
    }
    for (const site of ['substack.com', 'medium.com', 'wordpress.com', 'tumblr.com', 'netlify.com', 'railway.app']) {
      expect(isPublicSuffix(site), site).toBe(false);
    }
  });

  it('등록 가능한 도메인(eTLD+1) — 가장 긴 규칙 · 와일드카드 · 예외 · 접미사 자체는 null', () => {
    expect(registrableDomain('github.com')).toBe('github.com');
    expect(registrableDomain('mail.github.com')).toBe('github.com');
    expect(registrableDomain('a.b.example.co.kr')).toBe('example.co.kr');
    expect(registrableDomain('me.github.io')).toBe('me.github.io');
    expect(registrableDomain('x.me.github.io')).toBe('me.github.io');
    expect(registrableDomain('evil.s3.amazonaws.com')).toBe('evil.s3.amazonaws.com');
    expect(registrableDomain('amazonaws.com')).toBe('amazonaws.com');
    expect(registrableDomain('a.b.ck')).toBe('a.b.ck');
    expect(registrableDomain('x.www.ck')).toBe('www.ck');
    expect(registrableDomain('shop.eu.org')).toBe('shop.eu.org');
    for (const suffix of ['kr', 'co.kr', 'github.io', 'b.ck', 'eu.org']) expect(registrableDomain(suffix), suffix).toBeNull();
  });

  it('공용 메일 도메인 목록은 고정이다 — apex 정확 일치만 공용 · 하위 도메인·사이트 도메인은 아니다(코드 N2)', () => {
    expect([...SHARED_MAILBOX_DOMAINS].sort()).toEqual(
      [
        'gmail.com', 'googlemail.com',
        'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'outlook.kr', 'hotmail.co.kr', 'hotmail.co.uk', 'live.co.kr', 'live.co.uk',
        'yahoo.com', 'yahoo.co.kr', 'yahoo.co.jp', 'yahoo.co.uk', 'ymail.com', 'rocketmail.com',
        'icloud.com', 'me.com', 'mac.com',
        'aol.com',
        'naver.com', 'daum.net', 'hanmail.net', 'kakao.com', 'nate.com',
        'proton.me', 'protonmail.com', 'protonmail.ch', 'pm.me', 'tutanota.com', 'tuta.io', 'gmx.com', 'gmx.de', 'gmx.net', 'web.de',
        'mail.com', 'zoho.com', 'fastmail.com', 'yandex.com', 'yandex.ru', 'mail.ru',
        'qq.com', 'foxmail.com', '163.com', '126.com', 'yeah.net', 'sina.com', 'sohu.com',
      ].sort(),
    );
    for (const shared of ['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com', 'me.com', 'naver.com',
      'daum.net', 'hanmail.net', 'kakao.com', 'proton.me', 'protonmail.com', 'qq.com', '163.com']) {
      expect(isSharedMailboxDomain(shared), shared).toBe(true);
    }
    for (const site of ['github.com', 'google.com', 'accounts.google.com', 'microsoft.com', 'apple.com', 'navercorp.com', 'kakaocorp.com', 'notgmail.com',
      'mail.naver.com', 'accounts.kakao.com', 'mail.yahoo.com', 'gmail.com.evil.example']) {
      expect(isSharedMailboxDomain(site), site).toBe(false);
    }
  });

  it('공용 apex 의 시스템 발신 주소 — 목록 고정 · 로컬파트 정확 일치 · 공급자별 보강 · 공용 apex 가 아니면 거짓', () => {
    expect([...SYSTEM_SENDER_LOCAL_PARTS].sort()).toEqual(
      [
        'noreply', 'no-reply', 'no_reply', 'do-not-reply', 'do_not_reply', 'donotreply',
        'account', 'accounts', 'accounts-noreply', 'account-noreply',
        'verify', 'verification', 'security', 'auth', 'login', 'notice', 'info', 'help',
      ].sort(),
    );
    expect(PROVIDER_SYSTEM_SENDER_LOCAL_PARTS).toEqual({
      'naver.com': ['naver'],
      'kakao.com': ['kakao'],
      'daum.net': ['daum'],
      'hanmail.net': ['daum', 'hanmail'],
      'nate.com': ['nate'],
    });
    for (const address of ['noreply@naver.com', 'no-reply@kakao.com', 'accounts@gmail.com', 'naver@naver.com', 'kakao@kakao.com', 'help@hanmail.net']) {
      expect(isSharedMailboxSystemSender(address), address).toBe(true);
    }
    for (const address of [
      'attacker@naver.com', 'noreply+x@naver.com', 'no.reply@gmail.com', 'noreply1@naver.com', 'kakao@naver.com',
      'noreply@accounts.kakao.com', 'noreply@github.com', 'noreply', '@naver.com',
    ]) {
      expect(isSharedMailboxSystemSender(address), address).toBe(false);
    }
  });

  it('호스트 이름 모양', () => {
    for (const ok of ['github.com', 'xn--hq1bm8jm9l.kr', 'a-b.example']) expect(isHostname(ok), ok).toBe(true);
    for (const bad of ['', 'github', '-a.com', 'a..com', '1.2.3.4', 'a_b.com', 'Github.com', 'a b.com', `${'a'.repeat(64)}.com`]) {
      expect(isHostname(bad), bad).toBe(false);
    }
  });
});

describe('선형 시간(보안 H1 · 코드 H2 · 보안 L3)', () => {
  /** 한 입력의 추출 시간 상한(밀리초). 예전 구현(후보마다 줄 시작까지 `lastIndexOf` · 키워드 선형 탐색 · `[...]+$`)은 수 초~수십 초였다. */
  const LIMIT_MS = 1_000;

  function timed(label: string, run: () => void): void {
    const started = performance.now();
    run();
    expect(performance.now() - started, label).toBeLessThan(LIMIT_MS);
  }

  const dotLink = `https://a.com/verify${'.'.repeat(4_000)}x`;
  const adversarial: readonly (readonly [string, string])[] = [
    ["'1234 '.repeat(40_000)", '1234 '.repeat(40_000)],
    ["'인증번호 1234 '.repeat(15_000)", '인증번호 1234 '.repeat(15_000)],
    ["'order 1234 '×9천 + 'OTP '×2.5만", `${'order 1234 '.repeat(9_000)}${'OTP '.repeat(25_000)}`],
    // 스캔 상한(5만 자) 안에 둘 다 들어오게 — 후보 수천 개 뒤에 키워드 수천 개.
    ["'order 1234 '×2천 + 'OTP '×7천(5만 자 안)", `${'order 1234 '.repeat(2_000)}${'OTP '.repeat(7_000)}`],
    ["'OTP '×7천 + '1234 '×5천(5만 자 안)", `${'OTP '.repeat(7_000)}${'1234 '.repeat(5_000)}`],
    ['점 4천 개 링크 × 1', `Verify ${dotLink}`],
    ['점 4천 개 링크 × 50', Array.from({ length: 50 }, () => `Verify ${dotLink}`).join(' ')],
    ['점만 20만', `https://a.com/${'.'.repeat(200_000)}`],
    ['인증번호 × 10만', '인증번호 '.repeat(100_000)],
    ['1 × 100만', '1'.repeat(1_000_000)],
    ['1␠ × 50만', '1 '.repeat(500_000)],
    ['링크 × 7만', 'https://a.com/'.repeat(70_000)],
    ['링크(공백) × 5만', 'Verify https://a.com/verify?t=1 '.repeat(50_000)],
    ['a@ × 50만', 'a@'.repeat(500_000)],
    ['12- × 30만', `Verification code ${'12-'.repeat(300_000)}`],
    ['4 8 2 9 × 5만', '4 8 2 9 1 3 '.repeat(50_000)],
    ['your x code is × 2만', 'your a b code is 482913 '.repeat(20_000)],
  ];

  // 실측(2026-09-26, 로컬): 입력마다 0.2~28ms. 같은 입력에서 예전 구현은 '1234 '×4만 1.5초·'인증번호 1234 '×1.5만 0.57초(본문 하나).
  it('적대 입력 — 입력마다(제목·text·html 세 번 + 링크) 시간 상한 안', () => {
    for (const [label, input] of adversarial) {
      timed(label, () => {
        extractCodes(mail(input, input, `${input} `));
        extractLinks(mail(input, null, `${input} `), { senderDomain: 'a.com', includeSubdomains: true });
      });
    }
  });

  it('스캔 상한 — 5만 자 뒤는 보지 않는다', () => {
    expect(MAX_SCAN_CHARS).toBe(50_000);
    expect(highs(mail(`${' '.repeat(MAX_SCAN_CHARS)}Verification code: 482913`))).toEqual([]);
    expect(highs(mail(`${' '.repeat(MAX_SCAN_CHARS - 40)}Verification code: 482913`))).toEqual(['482913']);
  });
});
