/**
 * 콘솔 문구 규칙(비평 9회전 — 명세 §6.4 용어집). 한 개념 = 한 이름. 두 언어 여섯 페이지의 렌더 결과에서 금지어가 나오지 않는지,
 * 한국어 조사가 라틴 낱말 뒤에 띄어 쓰이지 않는지 본다(표시되는 글과 스크립트 안 문구 모두 — 스크립트의 한국어는 그대로 화면 문구다).
 */
import { describe, expect, it } from 'vitest';

import {
  renderAppPage,
  renderInvitePage,
  renderLoginLandingPage,
  renderLoginPage,
  renderSignupLandingPage,
  renderSignupPage,
  UI_SOURCES,
  type Lang,
} from '../../../src/admin/ui/index';
import { MESSAGES } from '../../../src/admin/ui/i18n';

import { inlined } from './console-harness';

const PAGES = [renderAppPage, renderLoginPage, renderLoginLandingPage, renderSignupPage, renderSignupLandingPage, renderInvitePage] as const;
const html = (lang: Lang): string => PAGES.map((render) => inlined(render(lang))).join('\n');

const KO_BANNED = ['화이트리스트', '블랙리스트', '전부 X', '관리 화면', 'Atmark 관리', '비상 정지', '발송 정지', '게이트'];
const EN_BANNED = [/kill switch/i, /sign-in/i, /\bsign in\b/i, /Sending pause/, /Old mode/, /\bGATE\b/, /Suspend agent/, /Suspend organization/, /Recipients per email/];
/** 라틴 낱말·숫자·코드 끝·닫는 따옴표·자리표시(`{e}`) 뒤에 띄어 쓴 조사(R9-12 · 리뷰). */
const SPACED_PARTICLE = /[A-Za-z0-9)"'”’>%}] (으로|에서|에게|까지|부터|처럼|보다|는|은|이|가|을|를|로|에|의|와|과|나|도|만)(?![가-힣])/;

describe('콘솔 문구 — 용어집(§6.4)', () => {
  it('Ⓦ-1 한국어 페이지에 금지어가 없다(허용 목록·차단 목록·모두 막기·콘솔·긴급 정지·메일함 인계 시험 하나씩)', () => {
    const ko = html('ko');
    expect(KO_BANNED.filter((w) => ko.includes(w))).toEqual([]);
  });

  it('Ⓦ-2 영어 페이지에 금지어가 없다(login link · Emergency stop · Mailbox handover trial · 사이트와 같은 한도 이름)', () => {
    const en = html('en');
    expect(EN_BANNED.filter((re) => re.test(en)).map(String)).toEqual([]);
  });

  it('Ⓦ-3 한국어 조사는 라틴 낱말·코드 뒤에 붙여 쓴다(Atmark는 · API로 · <code>seen</code>으로)', () => {
    const lines = html('ko')
      .split(/(?<=[.!?。])\s|\n/)
      .filter((l) => /[가-힣]/.test(l) && SPACED_PARTICLE.test(l));
    expect(lines.map((l) => l.match(SPACED_PARTICLE)?.[0])).toEqual([]);
  });

  it('Ⓦ-4 영어 번역이 조각으로 붙지 않는다 — 사전 키 둘이 공백 하나(또는 없이)로 맞닿으면 그 구절은 통째 키가 있어야 한다(비평 R10-01)', () => {
    // localize 와 같은 순서(긴 키 먼저)로 키를 자리표시로 바꾼 뒤, 자리표시 둘이 맞닿은 곳을 찾는다.
    // 예: "긴급 정지 해제" 에 통째 키가 없으면 "긴급 정지"+"해제" → "Emergency stop Unmark".
    const keys = Object.keys(MESSAGES.en).sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
    let out = UI_SOURCES.map((p) => `${p.title}\n${p.body}\n${p.script}`).join('\n');
    keys.forEach((k, i) => {
      if (out.includes(k)) out = out.split(k).join(`\u0000${String(i)}\u0001`);
    });
    const glued = [...out.matchAll(/\u0000(\d+)\u0001([ \u00a0]?)\u0000(\d+)\u0001/g)].map((m) => `${keys[Number(m[1])]}${m[2]}${keys[Number(m[3])]}`);
    expect([...new Set(glued)]).toEqual([]);
  });

  it('Ⓦ-5 에이전트 긴급 정지 해제 안내는 코드와 같다 — 정지 중에 막힌 메일은 해제해도 다시 보내지 않는다(release-deferral 의 agent_not_active 는 영구)', () => {
    const script = UI_SOURCES.map((p) => p.script).join('\n');
    const ko = '발신이 다시 정책을 따릅니다. 정지 중에 막힌 메일은 해제해도 다시 보내지 않습니다.';
    expect(script).toContain(ko);
    expect(MESSAGES.en[ko]).toBe("Sending follows the policy again. Mail blocked during the stop won't be sent when you resume.");
    // 옛 문구(막힌 발송이 다시 흐를 수 있다)는 어느 언어로도 남지 않는다.
    expect(script).not.toContain('다시 흐를');
    expect(Object.values(MESSAGES.en).join('\n')).not.toMatch(/may start flowing again/);
  });
});
