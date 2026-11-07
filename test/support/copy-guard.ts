/**
 * copy-guard 금지어(마케팅 계획 `.omc/plans/marketing-plan-2026-09-30.md` §9.1 · §2.3 · §5.2 — 진윤겸 승인 2026-09-30).
 * 검증할 수 없는 주장과 경쟁사를 겨냥한 문구가 사용자에게 보이는 글자(홈·문서·시스템 메일·콘솔·MCP 도구 설명)에 다시 들어오지 않게 한다.
 * 목록은 여기 한 곳이다 — `test/unit/site/copy-guard.test.ts` 가 건다.
 *
 * 규칙:
 *   - 대소문자를 가리지 않는다. 글자는 태그를 벗기고 엔티티를 푼 뒤 본다.
 *   - "only"·"the first"·"유일" 은 **마케팅 주장 모양만** 막는다("the only service", "Atmark is the first …"). 기능 설명
 *     ("only people you allow", "reply only to …", "the first send", "이 메일의 유일한 링크")은 막지 않는다.
 *   - 계획의 조건부 금지어(tamper-evident · 변조 흔적 · 고치면 드러 · edits show)는 걸지 않는다 — 조건("공개 해시 로그가 운영되는 날부터")이
 *     이미 채워져 있다: `id.atmark.ai/log` 에 서명한 체크포인트가 매시 게시되고, OpenTimestamps 앵커가 하루 1회 붙는다(리드 확인 2026-09-30).
 *     과장하는 말(immutable · 변조 불가 · 누구나 검증 · cryptographically proven …)은 그대로 막는다.
 */

export interface BannedCopy {
  readonly name: string;
  readonly pattern: RegExp;
}

export const COPY_GUARD_BANNED: readonly BannedCopy[] = [
  { name: 'immutable', pattern: /\bimmutable\b/i },
  { name: '불변', pattern: /불변/ },
  { name: '고칠 수 없', pattern: /고칠\s*수\s*없/ },
  { name: "can't be altered", pattern: /can(?:['’]|no)?t\s+be\s+altered/i },
  { name: 'tamper-proof', pattern: /tamper[\s-]*(?:proof|resistant)/i },
  { name: '변조 불가', pattern: /변조\s*(?:가\s*)?불가/ },
  { name: 'safe/secure by default', pattern: /\b(?:safe|secure)\s+by\s+default\b/i },
  { name: 'prevents/blocks injection', pattern: /\b(?:prevent|block|stop)s?\s+(?:all\s+)?(?:prompt\s+)?injection/i },
  { name: '인젝션을 막는다/차단한다', pattern: /인젝션을?\s*(?:막|차단|방지)/ },
  { name: 'anyone can verify', pattern: /\banyone\s+can\s+verify\b/i },
  { name: '누구나 검증', pattern: /누구나\s*검증/ },
  { name: 'cryptographically proven', pattern: /cryptographically\s+proven/i },
  {
    name: 'the only (marketing)',
    pattern: /\bthe\s+only\s+(?:[\w-]+\s+){0,2}(?:service|platform|product|provider|solution|tool|company|option|choice)\b|\b(?:atmark|we)(?:\s+is|\s+are|['’]re)?\s+the\s+only\b/i,
  },
  {
    name: 'the first (marketing)',
    pattern: /\bthe\s+(?:world['’]s\s+|industry['’]s\s+)?first\s+(?:[\w-]+\s+){0,2}(?:service|platform|product|provider|solution|tool|company)\b|\b(?:atmark|we)(?:\s+is|\s+are|['’]re)?\s+the\s+first\b/i,
  },
  { name: 'unlike others', pattern: /\bunlike\s+(?:others|any\s+other|other\s+(?:services|platforms|providers|tools))\b/i },
  { name: '유일 (마케팅)', pattern: /유일한\s*(?:서비스|플랫폼|제품|솔루션|회사|방법)/ },
  { name: '최초', pattern: /최초/ },
  { name: 'launching soon', pattern: /\blaunching\s+soon\b/i },
  { name: '곧 공개', pattern: /곧\s*(?:공개|출시|런칭)/ },
  { name: "You're in", pattern: /\byou['’]re\s+in[.!]/i },
  { name: "when it's your turn", pattern: /\bwhen\s+it['’]?s\s+your\s+turn\b/i },
  { name: '차례가 오면', pattern: /차례가\s*(?:오|되)/ },
  // AI 의심 메일 감시(ADR-0017 · 설계 §4.3) — 모델 신호는 **경고 표시만**이다. 막는다 · 보호한다 · 전부 잡는다로 읽히는 말을 막는다.
  // 'AI가 [목적어 0~3어절] 막/차단/보호/걸러' — 부정('막지 않')은 허용(경고 전용이라고 말하는 문장).
  { name: 'AI가 막/차단/보호', pattern: /AI\s*(?:가|이|는)\s*(?:[^\s.,]+\s+){0,3}(?:막|차단|보호|걸러)(?!지\s*않)/i },
  { name: '자동으로 걸러', pattern: /자동으로\s*걸러/ },
  { name: 'AI blocks/protects', pattern: /\bAI\s+(?:blocks?|protects?|stops?|filters?\s+out)\b/i },
  { name: 'catches all/everything', pattern: /\bcatch(?:es)?\s+(?:all|every(?:thing)?)\b/i },
  { name: '100%', pattern: /(?<![\d.])100\s*%/ },
  { name: '완벽', pattern: /완벽/ },
  { name: 'perfect/flawless protection', pattern: /\b(?:perfect|flawless|complete|total)\s+(?:protection|security|detection|defen[cs]e)\b/i },
];

/** onve@ 가 보내는 메일(환영 · 대기자 명단)에만 더 거는 말 — 거래성 메일에 권유·기능 소개가 없게(§4.3 · §9.1). */
export const ONVE_MAIL_BANNED: readonly BannedCopy[] = [
  { name: 'upgrade', pattern: /\bupgrad/i },
  { name: '업그레이드', pattern: /업그레이드/ },
  { name: 'new feature', pattern: /\bnew\s+features?\b/i },
  { name: '새 기능', pattern: /새\s*기능/ },
  { name: 'Pro', pattern: /\bPro\b/ },
];

/** 글에서 걸린 항목 이름들. */
export function copyGuardHits(text: string, list: readonly BannedCopy[] = COPY_GUARD_BANNED): string[] {
  return list.filter((item) => item.pattern.test(text)).map((item) => item.name);
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '', zwj: '', zwnj: '', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', hellip: '…', middot: '·',
};

/** HTML → 보이는 글자(스타일·스크립트 블록 제외, 메타 설명 포함, 엔티티를 풀고 보이지 않는 글자를 지운다). */
export function visibleText(html: string): string {
  const meta = [...html.matchAll(/<meta name="description" content="([^"]*)">/g)].map((m) => m[1] ?? '').join(' ');
  const body = html.replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, ' ');
  return `${meta} ${body}`
    .replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (whole, entity: string) => {
      if (entity.startsWith('#')) {
        const code = entity[1] === 'x' || entity[1] === 'X' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
        return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
      }
      return NAMED_ENTITIES[entity.toLowerCase()] ?? whole;
    })
    .replace(/[­͏᠎​-‏⁠-⁤﻿]/g, '')
    .replace(/\s+/g, ' ');
}
