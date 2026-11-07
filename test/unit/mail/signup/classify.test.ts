/**
 * 바깥 가입 감지 분류기(`src/mail/signup/classify.ts`, ADR-0016 2026-10-08) — 결정적 · 다국어 · 좁은 쪽.
 *
 *   ① 가입 메일 — ko · en · ja · zh · es · fr · de 의 계정 생성 · 환영 · 가입 확인 → 등록 가능 도메인 · 종류.
 *   ② 아닌 것 — 비밀번호 재설정 · 로그인 코드 · 새 기기 · 답장 · 인증 안 된 From · 알림형 발신 · 공용 메일 · 우리 도메인 · 공개 접미사 · 일반 메일.
 *   ③ 결과에 제목 · 본문이 없다(도메인 · 종류 두 칸).
 */

import { describe, expect, it } from 'vitest';

import { detectSignup, type SignupMailInput } from '../../../../src/mail/signup/classify';

const base: SignupMailInput = { fromAddress: 'no-reply@mail.example.com', fromAuthenticated: true, subject: null, text: null };
const mail = (subject: string, overrides: Partial<SignupMailInput> = {}): SignupMailInput => ({ ...base, subject, ...overrides });

describe('① 가입 메일 — 다국어', () => {
  it.each([
    ['Your account has been created', 'account_created'],
    ['Thanks for signing up to Example', 'account_created'],
    ['회원가입이 완료되었습니다', 'account_created'],
    ['계정이 생성되었습니다', 'account_created'],
    ['会員登録が完了しました', 'account_created'],
    ['注册成功', 'account_created'],
    ['Tu cuenta ha sido creada', 'account_created'],
    ['Votre compte a été créé', 'account_created'],
    ['Ihr Konto wurde erstellt', 'account_created'],
    ['Welcome to Example!', 'welcome'],
    ['Example에 오신 것을 환영합니다', 'welcome'],
    ['Exampleへようこそ', 'welcome'],
    ['欢迎加入 Example', 'welcome'],
    ['¡Bienvenido a Example!', 'welcome'],
    ['Bienvenue sur Example', 'welcome'],
    ['Willkommen bei Example', 'welcome'],
    ['Please confirm your email address', 'verification'],
    ['Verify your account', 'verification'],
    ['이메일 인증을 완료해 주세요', 'verification'],
    ['メールアドレスの確認', 'verification'],
    ['请验证您的邮箱', 'verification'],
    ['Confirma tu correo electrónico', 'verification'],
    ['Confirmez votre adresse e-mail', 'verification'],
    ['Bitte bestätigen Sie Ihre E-Mail-Adresse', 'verification'],
  ] as const)('%s → %s', (subject, kind) => {
    expect(detectSignup(mail(subject))).toEqual({ serviceDomain: 'example.com', kind });
  });

  it('등록 가능 도메인으로 접는다(PSL) — co.kr · 하위 도메인', () => {
    expect(detectSignup(mail('Welcome!', { fromAddress: 'hello@accounts.shop.co.kr' }))).toEqual({ serviceDomain: 'shop.co.kr', kind: 'welcome' });
  });

  it('본문 문 — 제목이 인증형이고 본문에 가입 확인 문장 + 확인 링크', () => {
    const text = 'Thanks! Please confirm your email address to finish.\nhttps://app.example.com/verify?token=abc\nhttps://app.example.com/unsubscribe';
    expect(detectSignup(mail('Action required: confirm', { text }))).toEqual({ serviceDomain: 'example.com', kind: 'verification' });
    // 링크가 재설정 꼴뿐이면 아니다.
    expect(detectSignup(mail('Action required: confirm', { text: 'Please confirm your email address https://x.example.com/reset-password?t=1' }))).toBeNull();
  });
});

describe('② 아닌 것', () => {
  it.each([
    ['Reset your password'],
    ['비밀번호 재설정'],
    ['Your login code is 123456'],
    ['New sign-in to your account'],
    ['로그인 인증번호'],
    ['Re: Welcome to the team'],
    ['Fwd: Your account has been created'],
    ['Weekly digest'],
    ['Invoice #1234'],
  ])('%s', (subject) => {
    expect(detectSignup(mail(subject))).toBeNull();
  });

  it('인증 안 된 From · 알림형 로컬파트 · 공용 메일 · 우리 도메인 · 공개 접미사 · 제목 없음', () => {
    expect(detectSignup(mail('Welcome!', { fromAuthenticated: false }))).toBeNull();
    expect(detectSignup(mail('Welcome to the repo', { fromAddress: 'notifications@github.com' }))).toBeNull();
    expect(detectSignup(mail('환영합니다', { fromAddress: 'friend@gmail.com' }))).toBeNull();
    expect(detectSignup(mail('Welcome!', { fromAddress: 'noreply@accounts.kakao.com' }))).toBeNull();
    expect(detectSignup(mail('Welcome to Atmark', { fromAddress: 'onve@atmark.ai' }))).toBeNull();
    expect(detectSignup(mail('Welcome!', { fromAddress: 'x@co.kr' }))).toBeNull();
    expect(detectSignup({ ...base })).toBeNull();
    expect(detectSignup(mail('Welcome!', { fromAddress: 'not-an-address' }))).toBeNull();
  });
});

describe('③ 결과 모양', () => {
  it('도메인 · 종류 두 칸뿐', () => {
    const result = detectSignup(mail('Welcome SECRET-SUBJECT', { text: 'BODY-SENTINEL' }));
    expect(Object.keys(result ?? {}).sort()).toEqual(['kind', 'serviceDomain']);
    expect(JSON.stringify(result)).not.toMatch(/SECRET|SENTINEL/);
  });

  it('긴 입력도 선형으로 끝난다', () => {
    const started = Date.now();
    detectSignup(mail('a'.repeat(100_000), { text: `${'confirm your email '.repeat(10_000)}${'https://x.example.com/'.repeat(5_000)}` }));
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
