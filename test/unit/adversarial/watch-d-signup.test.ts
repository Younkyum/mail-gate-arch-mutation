/**
 * 적대적 검증(묶음 D) 요소 3 — 바깥 가입 감지 분류기 (`detectSignup`). 순수 단위. 시도 ID `D3-U###`.
 * 안전 기대: 위조·애매한 입력은 `null`, 감지되더라도 결과는 (등록 가능 도메인 · 종류) 둘뿐이며 우리 도메인 · 공용 메일 · 공개 접미사가 아니다.
 */

import { describe, expect, it } from 'vitest';

import { detectSignup, SIGNUP_KINDS, type SignupMailInput } from '../../../src/mail/signup/classify';
import { registrableDomainOf } from '../../../src/domains/psl';

const base: SignupMailInput = { fromAddress: 'hello@svc.example.com', fromAuthenticated: true, subject: 'Welcome to Svc!', text: null };
const mail = (overrides: Partial<SignupMailInput>): SignupMailInput => ({ ...base, ...overrides });
const DOMAIN_SHAPE = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const SHARED = ['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com', 'naver.com', 'daum.net', 'kakao.com', 'proton.me', 'qq.com'];

function expectSafe(result: ReturnType<typeof detectSignup>, label: string): void {
  if (result === null) return;
  expect(Object.keys(result).sort(), label).toEqual(['kind', 'serviceDomain']);
  expect(result.serviceDomain, label).toMatch(DOMAIN_SHAPE);
  expect(result.serviceDomain.endsWith('atmark.ai'), label).toBe(false);
  expect(SHARED, label).not.toContain(result.serviceDomain);
  expect(registrableDomainOf(result.serviceDomain), `${label}: 공개 접미사 자체`).toBe(result.serviceDomain);
  expect(SIGNUP_KINDS, label).toContain(result.kind);
}

// ---------------------------------------------------------------------------
// A. 인증 · 입력 형태
// ---------------------------------------------------------------------------
describe('D3-A 인증 안 된 From · 빈 입력', () => {
  it('[D3-U001] DMARC 인증 안 된 From (위조) → null', () => {
    expect(detectSignup(mail({ fromAuthenticated: false }))).toBeNull();
  });
  it('[D3-U002] 인증 안 됨 + 계정 생성 제목 → null', () => {
    expect(detectSignup(mail({ fromAuthenticated: false, subject: 'Your account has been created' }))).toBeNull();
  });
  it('[D3-U003] 인증 안 됨 + 본문 확인 링크 → null', () => {
    expect(detectSignup(mail({ fromAuthenticated: false, subject: 'Confirm your email', text: 'confirm your email address https://svc.example.com/verify?t=1' }))).toBeNull();
  });
  it('[D3-U004] 제목 null → null', () => {
    expect(detectSignup(mail({ subject: null }))).toBeNull();
  });
  it('[D3-U005] 제목 빈 문자열 → null', () => {
    expect(detectSignup(mail({ subject: '' }))).toBeNull();
  });
  it('[D3-U006] 제목이 문자열이 아닌 값(숫자 · 객체)이어도 던지지 않는다', () => {
    for (const subject of [7, {}, ['Welcome'], true]) {
      let result: ReturnType<typeof detectSignup> = null;
      try {
        result = detectSignup(mail({ subject: subject as never }));
      } catch {
        result = null;
      }
      expectSafe(result, String(subject));
    }
  });
  it('[D3-U007] fromAddress 가 빈 문자열 → null', () => {
    expect(detectSignup(mail({ fromAddress: '' }))).toBeNull();
  });
  it('[D3-U008] text 가 undefined 여도 던지지 않는다', () => {
    expect(() => detectSignup(mail({ text: undefined as never }))).not.toThrow();
  });
  it('[D3-U009] 대조군: 인증된 정상 환영 메일은 감지된다', () => {
    expect(detectSignup(base)).toEqual({ serviceDomain: 'example.com', kind: 'welcome' });
  });
});

// ---------------------------------------------------------------------------
// B. 보낸 사람 주소 모양 · 도메인 접기
// ---------------------------------------------------------------------------
const ADDRESSES: readonly { label: string; from: string }[] = [
  { label: 'IPv4 리터럴 대괄호', from: 'user@[192.0.2.1]' },
  { label: 'IPv4 맨몸', from: 'user@192.0.2.1' },
  { label: 'IPv6 리터럴', from: 'user@[IPv6:2001:db8::1]' },
  { label: '16진 IP 0x7f.1', from: 'user@0x7f.1' },
  { label: '축약 IP 127.1', from: 'user@127.1' },
  { label: '10진 정수 IP', from: 'user@2130706433' },
  { label: 'localhost', from: 'user@localhost' },
  { label: '단일 라벨 com', from: 'user@com' },
  { label: '공개 접미사 co.uk 자체', from: 'user@co.uk' },
  { label: '공개 접미사 co.kr 자체', from: 'user@co.kr' },
  { label: '공개 접미사 github.io 자체', from: 'user@github.io' },
  { label: '다단 접미사 a.b.c.co.uk', from: 'user@a.b.c.co.uk' },
  { label: '다단 접미사 a.b.c.co.kr', from: 'user@a.b.c.co.kr' },
  { label: '다단 접미사 x.com.au', from: 'user@x.com.au' },
  { label: '사설 접미사 x.github.io', from: 'user@x.github.io' },
  { label: '사설 접미사 evil.blogspot.com', from: 'user@evil.blogspot.com' },
  { label: '사설 접미사 evil.vercel.app', from: 'user@evil.vercel.app' },
  { label: '퓨니코드 xn--bcher-kva.example', from: 'user@xn--bcher-kva.example' },
  { label: '비 ASCII 도메인 münchen.example', from: 'user@münchen.example' },
  { label: '키릴 동형 도메인 раураl.com', from: 'user@раураl.com' },
  { label: '대문자 EXAMPLE.COM', from: 'user@EXAMPLE.COM' },
  { label: '끝 점 example.com.', from: 'user@example.com.' },
  { label: '앞 점 .example.com', from: 'user@.example.com' },
  { label: '연속 점 example..com', from: 'user@example..com' },
  { label: '앞 하이픈', from: 'user@-example.com' },
  { label: '뒤 하이픈', from: 'user@example-.com' },
  { label: '밑줄 도메인', from: 'user@exa_mple.com' },
  { label: '라벨 64 자', from: `user@${'a'.repeat(64)}.com` },
  { label: '호스트 254 자', from: `user@${'a.'.repeat(126)}com` },
  { label: 'TLD 한 글자', from: 'user@example.c' },
  { label: '숫자 TLD', from: 'user@example.123' },
  { label: 'NUL 끝', from: 'user@example.com\u0000' },
  { label: '공백 끝', from: 'user@example.com ' },
  { label: '개행 끝', from: 'user@example.com\n' },
  { label: '공백 낀 호스트', from: 'user@ex ample.com' },
  { label: '골뱅이 둘 a@b@example.com', from: 'a@b@example.com' },
  { label: '인용 로컬파트', from: '"a@b"@example.com' },
  { label: '표시 이름 포함 "Bank <a@evil.example>"', from: '"Bank" <a@evil.example>' },
  { label: '주소 둘', from: 'a@example.com, b@bank.example' },
  { label: '꺾쇠 닫힘 남음', from: 'a@example.com>' },
  { label: '우리 도메인', from: 'hello@atmark.ai' },
  { label: '우리 하위 도메인', from: 'hello@mail.atmark.ai' },
  { label: '우리 도메인 대문자', from: 'hello@ATMARK.AI' },
  { label: '우리 도메인 끝 점', from: 'hello@atmark.ai.' },
  { label: '우리 도메인을 앞세운 남의 도메인', from: 'hello@atmark.ai.evil.example' },
  { label: '우리 이름을 닮은 도메인', from: 'hello@atmark-ai.com' },
  { label: 'gmail', from: 'hello@gmail.com' },
  { label: 'gmail 하위', from: 'hello@mail.gmail.com' },
  { label: 'googlemail', from: 'hello@googlemail.com' },
  { label: 'naver 하위', from: 'hello@x.naver.com' },
  { label: 'outlook.kr', from: 'hello@outlook.kr' },
  { label: 'icloud', from: 'hello@icloud.com' },
  { label: 'yahoo.co.jp', from: 'hello@yahoo.co.jp' },
  { label: 'proton', from: 'hello@proton.me' },
  { label: 'qq', from: 'hello@qq.com' },
  { label: '골뱅이만', from: '@' },
  { label: '골뱅이 없음', from: 'noatsign' },
  { label: '로컬파트 없음', from: '@example.com' },
  { label: '도메인 없음', from: 'user@' },
  { label: '퓨니코드 빈 xn--', from: 'user@xn--' },
  { label: '공백만', from: '   ' },
];

describe('D3-B 보낸 사람 주소 — 접힌 도메인이 안전하거나 감지 안 함', () => {
  const rows = ADDRESSES.map((row, index) => ({ ...row, id: `D3-U${String(10 + index).padStart(3, '0')}` }));
  it.each(rows)('[$id] $label', ({ from, label }) => {
    expectSafe(detectSignup(mail({ fromAddress: from })), label);
  });

  it.each([
    { id: 'D3-U073', from: 'hello@atmark.ai' },
    { id: 'D3-U074', from: 'hello@mail.atmark.ai' },
    { id: 'D3-U075', from: 'hello@gmail.com' },
    { id: 'D3-U076', from: 'hello@co.uk' },
    { id: 'D3-U077', from: 'user@[192.0.2.1]' },
    { id: 'D3-U078', from: 'user@localhost' },
  ])('[$id] 반드시 null: $from', ({ from }) => {
    expect(detectSignup(mail({ fromAddress: from }))).toBeNull();
  });

  it.each([
    { id: 'D3-U079', from: 'x@a.b.c.co.uk', expected: 'c.co.uk' },
    { id: 'D3-U080', from: 'x@accounts.shop.co.kr', expected: 'shop.co.kr' },
    { id: 'D3-U081', from: 'X@MAIL.Example.COM', expected: 'example.com' },
    { id: 'D3-U082', from: 'x@a.atmark.ai.evil.example', expected: 'evil.example' },
    { id: 'D3-U083', from: 'x@xn--bcher-kva.example', expected: 'xn--bcher-kva.example' },
  ])('[$id] 접힘 기대 $from → $expected', ({ from, expected }) => {
    expect(detectSignup(mail({ fromAddress: from }))?.serviceDomain).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// C. 알림형 로컬파트
// ---------------------------------------------------------------------------
describe('D3-C 알림형 발신(제목을 남이 쓴다)은 가입이 아니다', () => {
  const noisy = ['notifications', 'notification', 'Notifications', 'comments', 'comment', 'mention', 'mentions', 'digest', 'discussion', 'discussions', 'no-reply+digest', 'team.mentions', 'reply_notification', 'a-digest-b', 'noreply.comments', 'x+mentions'];
  it.each(noisy.map((local, index) => ({ local, id: `D3-U${String(84 + index).padStart(3, '0')}` })))('[$id] $local@ → null', ({ local }) => {
    expect(detectSignup(mail({ fromAddress: `${local}@svc.example.com` }))).toBeNull();
  });
  it.each([
    { id: 'D3-U100', local: 'welcome' },
    { id: 'D3-U101', local: 'digestive' },
    { id: 'D3-U102', local: 'mentionsx' },
    { id: 'D3-U103', local: 'no-reply' },
  ])('[$id] 대조군 $local@ → 감지된다(부분 문자열은 알림형이 아니다)', ({ local }) => {
    expect(detectSignup(mail({ fromAddress: `${local}@svc.example.com` }))?.serviceDomain).toBe('example.com');
  });
});

// ---------------------------------------------------------------------------
// D. 제목 — 가입 아닌 것 · 답장 · 위장
// ---------------------------------------------------------------------------
const NEGATIVE_SUBJECTS = [
  'Reset your password', 'Password reset requested', 'Your login code is 123456', 'Sign in to Svc', 'Log in to your account', 'New device sign-in detected',
  'New login from Chrome on Mac', 'Security alert: new sign-in', 'Two-factor authentication code', 'Your 2FA code', '비밀번호 재설정 안내', '로그인 코드 안내',
  '새 기기에서 로그인되었습니다', '보안 알림', 'パスワードのリセット', 'ログイン通知', '重置密码', '登录验证码', 'Restablecer contraseña', 'Réinitialiser votre mot de passe',
  'Passwort zurücksetzen', 'Your invoice for October', 'Your receipt', 'Weekly digest', 'Meeting tomorrow at 3pm', '회의 일정 확인 부탁드립니다', 'Order shipped', '',
  'Confirm your attendance', 'Verify your payment', 'Please confirm your appointment', 'Verification code: 482910',
];
const REPLIES = ['Re: Welcome to Svc', 'RE: Welcome to Svc', 'Re : Welcome to Svc', 'Re：Welcome to Svc', 'Fwd: Welcome to Svc', 'FW: Welcome to Svc', 'Fw: Your account has been created', 'Aw: Willkommen bei Svc', 'Sv: Welcome', '답장: 환영합니다', '회신: 가입이 완료되었습니다', '전달: 환영합니다', 'Re[2]: Welcome to Svc', 'RE:Welcome', '  Re: Welcome'];

describe('D3-D 제목 표', () => {
  const neg = NEGATIVE_SUBJECTS.map((subject, index) => ({ subject, id: `D3-U${String(104 + index).padStart(3, '0')}` }));
  it.each(neg)('[$id] 가입이 아닌 제목 "$subject" → null', ({ subject }) => {
    expect(detectSignup(mail({ subject }))).toBeNull();
  });

  const rep = REPLIES.map((subject, index) => ({ subject, id: `D3-U${String(136 + index).padStart(3, '0')}` }));
  it.each(rep)('[$id] 답장 · 전달 제목 "$subject" → null', ({ subject }) => {
    expect(detectSignup(mail({ subject }))).toBeNull();
  });

  const TRICKS: readonly { label: string; subject: string; expected: 'null' | 'any' }[] = [
    { label: '키릴 е 로 쓴 Wеlcome', subject: 'Wеlcome to Svc', expected: 'null' },
    { label: '제로폭 낀 Wel​come', subject: 'Wel​come to Svc', expected: 'null' },
    { label: '전각 Ｗｅｌｃｏｍｅ', subject: 'Ｗｅｌｃｏｍｅ', expected: 'null' },
    { label: 'unwelcome', subject: 'Unwelcome guest', expected: 'null' },
    { label: 'welcomed', subject: 'You were welcomed', expected: 'null' },
    { label: '계정 생성 위장: acc0unt created', subject: 'Your acc0unt has been created', expected: 'null' },
    { label: 'HTML 엔티티', subject: 'Welc&#111;me', expected: 'null' },
    { label: '긴 공백 + welcome', subject: `${' '.repeat(500)}Welcome`, expected: 'any' },
    { label: '300자 뒤의 welcome(잘림)', subject: `${'x'.repeat(300)} Welcome`, expected: 'null' },
    { label: 'Welcome back + 재설정 (환영이 먼저)', subject: 'Welcome back! Reset your password', expected: 'any' },
  ];
  const tricks = TRICKS.map((row, index) => ({ ...row, id: `D3-U${String(151 + index).padStart(3, '0')}` }));
  it.each(tricks)('[$id] $label', ({ subject, expected }) => {
    const result = detectSignup(mail({ subject }));
    if (expected === 'null') expect(result).toBeNull();
    else expectSafe(result, subject.slice(0, 30));
  });

  const POSITIVES: readonly [string, string][] = [
    ['Thank you for signing up', 'account_created'], ['Thanks for registering', 'account_created'], ['Registration is complete', 'account_created'],
    ["You're now registered", 'account_created'], ['가입해 주셔서 감사합니다', 'account_created'], ['가입이 완료되었습니다', 'account_created'],
    ['アカウントが作成されました', 'account_created'], ['账号已创建', 'account_created'], ['Registro completado', 'account_created'],
    ['Inscription confirmée', 'account_created'], ['Registrierung erfolgreich', 'account_created'], ['Welcome aboard', 'welcome'],
    ['WELCOME TO SVC', 'welcome'], ['Svc에 오신 것을 환영합니다', 'welcome'], ['Activate your account', 'verification'], ['Complete your registration', 'verification'],
    ['이메일 주소 인증', 'verification'], ['Verify your email', 'verification'], ['Confirm your e-mail', 'verification'], ['Active tu cuenta', 'null'],
  ];
  const positives = POSITIVES.map(([subject, kind], index) => ({ subject, kind, id: `D3-U${String(161 + index).padStart(3, '0')}` }));
  it.each(positives)('[$id] 정상 가입 제목 "$subject" → $kind (대조군)', ({ subject, kind }) => {
    const result = detectSignup(mail({ subject }));
    if (kind === 'null') expect(result).toBeNull();
    else expect(result?.kind).toBe(kind);
  });
});

// ---------------------------------------------------------------------------
// E. 본문 문 — 확인 링크
// ---------------------------------------------------------------------------
describe('D3-E 본문 확인 링크', () => {
  const lead = 'Please confirm your email address to finish.\n';
  const LINKS: readonly { label: string; text: string; expected: boolean }[] = [
    { label: 'verify 경로', text: `${lead}https://svc.example.com/verify?token=abc`, expected: true },
    { label: 'confirm 쿼리', text: `${lead}https://svc.example.com/a?confirm=1`, expected: true },
    { label: 'activate 경로', text: `${lead}https://svc.example.com/activate/xyz`, expected: true },
    { label: 'validate 경로', text: `${lead}https://svc.example.com/validate`, expected: true },
    { label: '재설정이 먼저(링크만)', text: `${lead}https://svc.example.com/reset-password?verify=1`, expected: false },
    { label: '로그인(magic link) 꼴', text: `${lead}https://svc.example.com/magic-link?verify=1`, expected: false },
    { label: '로그인 경로', text: `${lead}https://svc.example.com/login?confirm=1`, expected: false },
    { label: 'auth 경로', text: `${lead}https://svc.example.com/auth?verify=1`, expected: false },
    { label: '링크 없음', text: lead, expected: false },
    { label: '링크가 http 가 아님', text: `${lead}ftp://svc.example.com/verify`, expected: false },
    { label: '링크 글에만 verify(경로 아님)', text: `${lead}https://svc.example.com/home 'click to verify'`, expected: false },
    { label: '호스트에만 verify', text: `${lead}https://verify.svc.example.com/`, expected: false },
    { label: '링크가 41 번째', text: `${lead}${Array.from({ length: 40 }, (_, i) => `https://svc.example.com/p${String(i)}`).join('\n')}\nhttps://svc.example.com/verify`, expected: false },
    { label: '링크가 8000 자 뒤', text: `${lead}${'x'.repeat(8100)}\nhttps://svc.example.com/verify`, expected: false },
    { label: '잘못된 URL', text: `${lead}https://[::1/verify`, expected: false },
    { label: '2048 자 넘는 URL(잘려서 verify 가 사라진다 — 놓칠 뿐 위조는 아니다)', text: `${lead}https://svc.example.com/${'a'.repeat(3000)}/verify`, expected: false },
    { label: '재설정 + 확인 둘 다(재설정 먼저 건너뛰고 확인이 이김)', text: `${lead}https://svc.example.com/reset\nhttps://svc.example.com/verify`, expected: true },
  ];
  const rows = LINKS.map((row, index) => ({ ...row, id: `D3-U${String(181 + index).padStart(3, '0')}` }));
  it.each(rows)('[$id] $label', ({ text, expected }) => {
    const result = detectSignup(mail({ subject: 'Action required: confirm', text }));
    if (expected) expect(result?.kind).toBe('verification');
    else expect(result).toBeNull();
  });

  it('[D3-U198] 본문 문 제목이 인증형이 아니면(제목 "Hello") 본문이 verify 여도 감지하지 않는다', () => {
    expect(detectSignup(mail({ subject: 'Hello', text: `${lead}https://svc.example.com/verify` }))).toBeNull();
  });
  it('[D3-U199] 인증 안 된 From 의 본문 문은 감지하지 않는다', () => {
    expect(detectSignup(mail({ fromAuthenticated: false, subject: 'Confirm', text: `${lead}https://svc.example.com/verify` }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// F. 결과 위생 · 선형 시간
// ---------------------------------------------------------------------------
describe('D3-F 결과 위생 · 선형 시간', () => {
  it('[D3-U200] 결과에 제목 · 본문 · 로컬파트가 없다(키가 정확히 둘)', () => {
    const result = detectSignup(mail({ fromAddress: 'secret-local-part@svc.example.com', subject: 'Welcome SUBJ-SENTINEL', text: 'BODY-SENTINEL' }));
    expect(Object.keys(result ?? {}).sort()).toEqual(['kind', 'serviceDomain']);
    expect(JSON.stringify(result)).not.toMatch(/SENTINEL|secret-local-part/);
  });

  const PATHOLOGICAL: readonly { label: string; subject: string; text?: string }[] = [
    { label: '공백 10 만 + welcome', subject: `${' '.repeat(100_000)}welcome` },
    { label: 'a 10 만', subject: 'a'.repeat(100_000) },
    { label: 'account 반복', subject: 'account '.repeat(50_000) },
    { label: 'thanks for 반복', subject: 'thanks for '.repeat(30_000) },
    { label: '가입 반복', subject: '가입 '.repeat(50_000) },
    { label: '이메일 확인 반복', subject: '이메일 '.repeat(50_000) },
    { label: 'confirm your 반복', subject: 'confirm your '.repeat(30_000) },
    { label: 'Re 반복', subject: `${'Re: '.repeat(30_000)}Welcome` },
    { label: '본문 링크 폭탄', subject: 'Confirm', text: `Please confirm your email address\n${'http://a.example/x '.repeat(100_000)}` },
    { label: '본문 긴 URL', subject: 'Confirm', text: `Please confirm your email address\nhttp://${'a'.repeat(1_000_000)}` },
    { label: '본문 괄호 중첩', subject: 'Confirm', text: `Please confirm your email address\nhttps://a.example/${'('.repeat(500_000)}` },
    { label: '본문 개행만 100 만', subject: 'Confirm', text: '\n'.repeat(1_000_000) },
  ];
  const rows = PATHOLOGICAL.map((row, index) => ({ ...row, id: `D3-U${String(201 + index).padStart(3, '0')}` }));
  it.each(rows)('[$id] 병리적 입력 $label — 250ms 안에 끝난다', ({ subject, text }) => {
    const started = performance.now();
    const result = detectSignup(mail({ subject, text: text ?? null }));
    const elapsed = performance.now() - started;
    expect(elapsed, `${String(elapsed)}ms`).toBeLessThan(250);
    expectSafe(result, 'pathological');
  });

  it('[D3-U213] 같은 입력 1 만 번 — 결정적(같은 결과)', () => {
    const first = JSON.stringify(detectSignup(base));
    for (let i = 0; i < 10_000; i += 1) if (JSON.stringify(detectSignup(base)) !== first) throw new Error('비결정');
  });
});
