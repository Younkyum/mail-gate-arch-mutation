/**
 * `htmlHiddenText` — HTML 에서 **숨긴 요소의 글만** 뽑는다(2026-10-08 인코딩 점검 — 숨김 신호). 보이는 글은 `htmlToText` 가 그대로 낸다.
 * 숨긴 글 자체는 신호가 아니다(마케팅 프리헤더) — 스캐너가 그 안에서 지시성 룰이 걸릴 때만 가산한다.
 */

import { describe, expect, it } from 'vitest';

import { hidesItself, htmlHiddenText, htmlToText } from '../../../src/mail/mime/parse-html';

describe('htmlHiddenText — 숨긴 글만', () => {
  it.each([
    ['display:none', '<div style="display:none">secret instruction</div>'],
    ['display : none(공백)', '<div style="display : none">secret instruction</div>'],
    ['visibility:hidden', '<p style="visibility:hidden">secret instruction</p>'],
    ['opacity:0', '<span style="opacity:0">secret instruction</span>'],
    ['font-size:0', '<span style="font-size:0">secret instruction</span>'],
    ['font-size:1px', '<span style="font-size:1px">secret instruction</span>'],
    ['max-height:0', '<div style="max-height:0;overflow:hidden">secret instruction</div>'],
    ['width:0;overflow:hidden', '<div style="width:0;overflow:hidden">secret instruction</div>'],
    ['color=background(흰 글씨)', '<span style="color:#ffffff;background:#ffffff">secret instruction</span>'],
    ['color=background(rgb)', '<span style="color:rgb(255,255,255);background-color:rgb(255,255,255)">secret instruction</span>'],
    ['color=background(named)', '<span style="color:white;background-color:white">secret instruction</span>'],
    ['hidden 속성', '<div hidden>secret instruction</div>'],
    ['aria-hidden', '<div aria-hidden="true">secret instruction</div>'],
    ['mso-hide:all', '<div style="mso-hide:all">secret instruction</div>'],
    ['중첩(부모가 숨김)', '<div style="display:none"><p>outer</p><b>secret instruction</b></div>'],
  ])('%s → 숨긴 글을 낸다', (_name, html) => {
    expect(htmlHiddenText(html)).toContain('secret instruction');
  });

  it.each([
    ['보이는 글', '<p>visible instruction</p>'],
    ['color≠background', '<span style="color:#111111;background:#ffffff">visible instruction</span>'],
    ['작은 글씨지만 2px', '<span style="font-size:2px">visible instruction</span>'],
    ['opacity:0.9', '<span style="opacity:0.9">visible instruction</span>'],
    ['width:0 인데 overflow 없음(접힘 아님으로 본다)', '<div style="width:0">visible instruction</div>'],
  ])('%s → 숨긴 글 없음', (_name, html) => {
    expect(htmlHiddenText(html)).toBe('');
  });

  it('보이는 글과 숨긴 글이 섞이면 숨긴 쪽만', () => {
    const html = '<p>Hello, your invoice is attached.</p><div style="display:none">hidden directive here</div><p>Thanks.</p>';
    expect(htmlHiddenText(html)).toBe('hidden directive here');
    expect(htmlToText(html)).toContain('Hello, your invoice is attached.');
    expect(htmlToText(html)).toContain('hidden directive here'); // 보이는 출력은 숨긴 글도 그대로 남긴다(변경 없음)
  });

  it('닫는 태그로 숨김이 풀리면 그 뒤 보이는 글은 빠진다', () => {
    const html = '<div style="display:none">hidden one</div><p>visible two</p>';
    expect(htmlHiddenText(html)).toBe('hidden one');
  });

  it('script·style 내용은 숨긴 글에도 넣지 않는다', () => {
    expect(htmlHiddenText('<style>.x{display:none}</style><div style="display:none">real hidden</div>')).toBe('real hidden');
  });

  it('마케팅 프리헤더(흔한 숨김 모양)의 글은 나오지만 — 지시가 없으면 스캐너가 쓰지 않는다', () => {
    const preheader = '<div style="display:none;max-height:0;overflow:hidden">Your August statement is ready.</div><p>Hi</p>';
    expect(htmlHiddenText(preheader)).toBe('Your August statement is ready.');
  });

  it('hidesItself — 요소 단위 판정', () => {
    expect(hidesItself('div style="display:none"')).toBe(true);
    expect(hidesItself('span style="opacity:0"')).toBe(true);
    expect(hidesItself('div hidden')).toBe(true);
    expect(hidesItself('p style="color:#fff;background:#fff"')).toBe(true);
    expect(hidesItself('p style="color:#000;background:#fff"')).toBe(false);
    expect(hidesItself('p class="banner"')).toBe(false);
  });

  it('깊은 중첩에서도 선형(스택 상한을 넘어도 던지지 않는다)', () => {
    const deep = `${'<div style="display:none">'.repeat(2000)}secret instruction${'</div>'.repeat(2000)}`;
    const started = performance.now();
    expect(htmlHiddenText(deep)).toContain('secret instruction');
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
