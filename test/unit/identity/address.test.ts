/** 주소 발급(`{name}@atmark.ai`) — 전역 UNIQUE(AC-1)가 의미를 가지려면 **표현이 하나**여야 한다. */

import { describe, expect, it } from 'vitest';
import { normalizeAddress } from '../../../src/policy/policy-loader';
import {
  addressDomain,
  AgentAddressError,
  AGENT_ADDRESS_DOMAIN,
  AGENT_BRAND_RESERVED_KEYS,
  AGENT_BRAND_RESERVED_LOCAL_PARTS,
  brandKeyOf,
  AGENT_LOCAL_PART_MAX_LENGTH,
  AGENT_LOCAL_PART_PATTERN,
  buildAgentAddress,
  buildOperatorReservedAddress,
  GLOBAL_RESERVED_LOCAL_PARTS,
  isReceiveOnlyAddress,
  OPERATOR_ASSIGNABLE_ADDRESSES,
  RECEIVE_ONLY_ADDRESSES,
  RESERVED_LOCAL_PARTS,
  type AgentAddressRejection,
} from '../../../src/identity/address';
import { HERO_AGENT_NAMES } from '../../../src/site/hero-names';

/** 던져진 `AgentAddressError` 의 `reason` 을 꺼낸다. 안 던지면 테스트가 실패해야 한다. */
function rejectionOf(localPart: string): AgentAddressRejection {
  try {
    buildAgentAddress(localPart);
  } catch (error) {
    if (error instanceof AgentAddressError) return error.reason;
    throw error;
  }
  throw new Error(`거부되지 않았다: ${JSON.stringify(localPart)}`);
}

describe('buildAgentAddress', () => {
  it.each([
    ['도메인을 붙인다', 'assistant', `assistant@${AGENT_ADDRESS_DOMAIN}`],
    ['대문자·공백은 소문자·trim', '  Assistant  ', 'assistant@atmark.ai'],
    ['가운데 구두점 허용', 'sales.bot_2-x', 'sales.bot_2-x@atmark.ai'],
    ['상한 길이 자체는 허용(경계)', 'a'.repeat(AGENT_LOCAL_PART_MAX_LENGTH), `${'a'.repeat(AGENT_LOCAL_PART_MAX_LENGTH)}@atmark.ai`],
  ])('%s', (_label, localPart, expected) => {
    expect(buildAgentAddress(localPart)).toBe(expected);
  });

  it('발급한 주소는 정책 로더의 정규화형과 같다 — 어긋나면 Stage 1 이 자기 주소를 위조로 읽는다', () => {
    const address = buildAgentAddress('sales.bot');
    expect(normalizeAddress(address)).toBe(address);
  });

  it.each([
    ['빈 문자열', ''],
    ['공백만', '   '],
    ['@ 포함', 'a@b'],
    ['앞이 구두점', '.bot'],
    ['뒤가 구두점', 'bot-'],
    ['`..` 연속', 'a..b'],
    ['허용 밖 문자', 'bot!'],
    ['`+tag`', 'bot+x'],
    ['길이 초과', 'a'.repeat(AGENT_LOCAL_PART_MAX_LENGTH + 1)],
  ])('%s 은 거부한다', (_label, localPart) => {
    expect(() => buildAgentAddress(localPart)).toThrow(AgentAddressError);
  });

  it.each([
    ['길이', '', 'invalid_length'],
    ['문자', 'bot!', 'invalid_character'],
    ['연속 점', 'a..b', 'consecutive_dots'],
    ['예약어', 'postmaster', 'reserved_local_part'],
  ] as const)('%s 위반은 사유를 밝힌다 (조용히 실패하지 않는다)', (_label, localPart, reason) => {
    expect(rejectionOf(localPart)).toBe(reason);
  });
});

describe('예약 로컬파트', () => {
  it.each([...RESERVED_LOCAL_PARTS])('"%s" 는 발급할 수 없다', (localPart) => {
    expect(rejectionOf(localPart)).toBe('reserved_local_part');
  });

  it('대문자로 적어도 예약 판정을 피할 수 없다 — 정규화 뒤에 비교한다', () => {
    expect(rejectionOf('  PostMaster  ')).toBe('reserved_local_part');
  });

  it.each([
    'postmaster2', 'my-abuse', 'security-bot', 'no-reply-bot', 'blocked-test-2', 'dmarc.reports',
    // AI 에이전트 이름도 정확 일치만 막는다.
    'codex-helper', 'my-claude', 'hermes2', 'openclaw-bot',
  ])('예약어가 아닌 유사 이름 "%s" 는 통과한다 (정확히 일치할 때만 거부)', (localPart) => {
    expect(buildAgentAddress(localPart)).toBe(`${localPart}@${AGENT_ADDRESS_DOMAIN}`);
  });

  it.each(['postmaster', 'abuse', 'blocked-test'])('"%s" 는 반드시 예약 목록에 있다 (사람이 받는 역할 주소 · demo:p1b 차단 대상)', (localPart) => {
    expect(RESERVED_LOCAL_PARTS).toContain(localPart);
    expect(rejectionOf(localPart)).toBe('reserved_local_part');
  });

  it.each(['claude-code', 'codex', 'hermes', 'openclaw', 'claude', 'openai', 'anthropic', 'gemini-cli', 'github-copilot', 'v0'])(
    'AI 에이전트 이름 "%s" 는 atmark.ai 에서 발급할 수 없다 — 대소문자·공백으로도 피할 수 없다 (홈 예시 주소 사칭 방지)',
    (localPart) => {
      expect(AGENT_BRAND_RESERVED_LOCAL_PARTS).toContain(localPart);
      expect(rejectionOf(localPart)).toBe('reserved_local_part');
      expect(rejectionOf(`  ${localPart.toUpperCase()}  `)).toBe('reserved_local_part');
    },
  );

  it.each([
    'xai', 'grokbot', 'grok-bot', 'groq', 'deepmind', 'gpt-5', 'gpt4', 'claudebot', 'claude-ai', 'chatgpt-bot', 'codex-cli', 'microsoft-copilot',
    'amazon-q', 'siri', 'alexa', 'meta-llama', 'nous-research', 'hermes-agent', 'huggingface', 'midjourney', 'stable-diffusion', 'mistral-ai',
    'deepseek-ai', 'kimi-ai', 'devin-ai', 'naver', 'hyperclova-x', 'clova', 'kakao', 'kanana', 'exaone', 'lg-ai', 'wrtn', 'skt', 'a-dot', 'samsung-gauss',
  ])('AI 회사·제품 이름 확장(202610141200) "%s" 도 atmark.ai 에서 발급할 수 없다 — 대소문자·공백으로도 피할 수 없다', (localPart) => {
    expect(AGENT_BRAND_RESERVED_LOCAL_PARTS).toContain(localPart);
    expect(rejectionOf(localPart)).toBe('reserved_local_part');
    expect(rejectionOf(`  ${localPart.toUpperCase()}  `)).toBe('reserved_local_part');
  });

  it.each(['claude.code', 'claude_code', 'chat-gpt', 'open_ai', 'gpt_5', 'hyperclova_x', 'Chat.GPT', 'deep-seek', 'x.ai', 'c.l.a.u.d.e', 'grok_bot'])(
    '브랜드 이름의 구분자 변형 "%s" 도 막힌다 — 구분자(. _ -)를 뺀 키로 비교한다(리뷰 L2)',
    (localPart) => {
      expect(AGENT_BRAND_RESERVED_KEYS).toContain(brandKeyOf(localPart.toLowerCase()));
      expect(rejectionOf(localPart)).toBe('reserved_local_part');
    },
  );

  it('브랜드 키 — 구분자를 뺀 값 · 중복은 처음 자리만 · 운영 예약에는 쓰지 않는다(no_reply · post.master · help_desk 는 된다) · 고객 도메인에는 쓰지 않는다', () => {
    expect(AGENT_BRAND_RESERVED_KEYS).toEqual([...new Set(AGENT_BRAND_RESERVED_LOCAL_PARTS.map((name) => name.replace(/[._-]/g, '')))]);
    for (const key of AGENT_BRAND_RESERVED_KEYS) expect(key, key).toMatch(/^[a-z0-9]+$/);
    for (const local of ['no_reply', 'post.master', 'help_desk', 'mailer.daemon']) expect(buildAgentAddress(local), local).toBe(`${local}@atmark.ai`);
    expect(buildAgentAddress('chat-gpt', 'agents.example.com')).toBe('chat-gpt@agents.example.com');
  });

  it.each([
    // 흔한 낱말·사람 이름이라 일부러 넣지 않은 것(정상 사용자를 막는다) — 회사 접미 이름(`stability-ai` 등)만 막는다.
    'bard', 'whisper', 'bedrock', 'nous', 'stability', 'runway', 'inflection', 'poe', 'cody', 'zed', 'warp', 'bolt', 'lindy', 'adept', 'fireworks',
    'moonshot', 'minimax', 'glm', 'yi', 'ernie', 'cognition', 'upstage', 'solar', 'gauss', 'o1',
    // 정확 일치만 — 접두·접미가 붙은 이름은 된다.
    'grok-fan', 'naver-blog-helper', 'my-gpt5-notes', 'kakao-talk-bot', 'sora-studio', 'chat-gpt-helper', 'claude.code.fan',
  ])('확장에서 뺀 · 비슷한 이름 "%s" 는 발급된다', (localPart) => {
    expect(buildAgentAddress(localPart)).toBe(`${localPart}@${AGENT_ADDRESS_DOMAIN}`);
  });

  it('AI 에이전트 이름 목록: 로컬파트 규칙을 지키고, 다른 예약 그룹과 겹치지 않고, 전체 목록의 맨 끝에 같은 순서로 붙는다(SQL 과 같은 순서)', () => {
    for (const localPart of AGENT_BRAND_RESERVED_LOCAL_PARTS) {
      expect(localPart, localPart).toMatch(AGENT_LOCAL_PART_PATTERN);
      expect(localPart.length, localPart).toBeLessThanOrEqual(AGENT_LOCAL_PART_MAX_LENGTH);
      expect(localPart.includes('..'), localPart).toBe(false);
    }
    expect(new Set(AGENT_BRAND_RESERVED_LOCAL_PARTS).size).toBe(AGENT_BRAND_RESERVED_LOCAL_PARTS.length);
    expect(RESERVED_LOCAL_PARTS.slice(-AGENT_BRAND_RESERVED_LOCAL_PARTS.length)).toEqual([...AGENT_BRAND_RESERVED_LOCAL_PARTS]);
    // 홈 히어로가 보여 주는 이름(`src/site/hero-names.ts`)은 전부 이 목록 안이다 — 히어로에 이름을 더하면 여기서 예약을 요구한다.
    for (const name of HERO_AGENT_NAMES) expect(AGENT_BRAND_RESERVED_LOCAL_PARTS, name).toContain(name);
  });

  it('onve 는 서비스 예약이다(지원 에이전트 별칭 · 환영 메일 발신 — 2026-09-30) · SQL 과 같은 자리(www 다음)', () => {
    expect(rejectionOf('onve')).toBe('reserved_local_part');
    expect(rejectionOf(' ONVE ')).toBe('reserved_local_part');
    expect(RESERVED_LOCAL_PARTS[RESERVED_LOCAL_PARTS.indexOf('www') + 1]).toBe('onve');
    expect(buildAgentAddress('onve-bot')).toBe('onve-bot@atmark.ai');
  });

  it('운영자 예약 주소 — 목록 넷(abuse@·postmaster@ 는 202609301540 · claude@ 는 202610141200 에서 뺐다) · 전부 예약 로컬파트 · 공통 판정은 거부하고 운영자 판정만 만든다', () => {
    expect([...OPERATOR_ASSIGNABLE_ADDRESSES]).toEqual(['support@atmark.ai', 'onve@atmark.ai', 'abuse@atmark.ai', 'postmaster@atmark.ai']);
    for (const address of OPERATOR_ASSIGNABLE_ADDRESSES) {
      const [local, domain] = address.split('@');
      expect(domain).toBe(AGENT_ADDRESS_DOMAIN);
      expect(RESERVED_LOCAL_PARTS, address).toContain(local);
      expect(rejectionOf(local ?? '')).toBe('reserved_local_part');
      expect(buildOperatorReservedAddress(address)).toBe(address);
      expect(buildOperatorReservedAddress(`  ${address.toUpperCase()} `)).toBe(address);
    }
    for (const outside of ['billing@atmark.ai', 'support', 'support@agents.example.com', 'support+x@atmark.ai', 'codex@atmark.ai', 'claude@atmark.ai', '']) {
      expect(() => buildOperatorReservedAddress(outside), outside).toThrow(AgentAddressError);
    }
  });

  it('claude@ (진윤겸 2026-10-14 "claude는 없애주렴") — 운영자 목록 밖이지만 브랜드 예약에는 남는다: 지운 뒤 콘솔·운영자 CLI 어느 쪽으로도 다시 발급되지 않는다', () => {
    expect(OPERATOR_ASSIGNABLE_ADDRESSES as readonly string[]).not.toContain('claude@atmark.ai');
    expect(AGENT_BRAND_RESERVED_LOCAL_PARTS).toContain('claude');
    expect(rejectionOf('claude')).toBe('reserved_local_part');
    expect(() => buildOperatorReservedAddress('claude@atmark.ai')).toThrow(AgentAddressError);
  });

  it('수신 전용 주소 — abuse@·postmaster@ 뿐 · 운영자 목록 안 · RFC 2142 전역 예약(고객 도메인에서도) · 판정은 대소문자·공백 무시', () => {
    expect([...RECEIVE_ONLY_ADDRESSES]).toEqual(['abuse@atmark.ai', 'postmaster@atmark.ai']);
    for (const address of RECEIVE_ONLY_ADDRESSES) {
      expect(OPERATOR_ASSIGNABLE_ADDRESSES as readonly string[], address).toContain(address);
      expect(GLOBAL_RESERVED_LOCAL_PARTS, address).toContain(address.split('@')[0]);
      expect(isReceiveOnlyAddress(address)).toBe(true);
      expect(isReceiveOnlyAddress(` ${address.toUpperCase()} `)).toBe(true);
    }
    for (const other of ['support@atmark.ai', 'onve@atmark.ai', 'abuse@agents.example.com', 'xabuse@atmark.ai', 'abuse+x@atmark.ai', 'postmaster']) {
      expect(isReceiveOnlyAddress(other), other).toBe(false);
    }
  });

  it('예약 목록은 중복이 없고 전부 소문자다 — 비교는 정규화형끼리 한다', () => {
    expect(new Set(RESERVED_LOCAL_PARTS).size).toBe(RESERVED_LOCAL_PARTS.length);
    for (const localPart of RESERVED_LOCAL_PARTS) expect(localPart).toBe(localPart.toLowerCase());
  });
});

describe('addressDomain', () => {
  it('DB CHECK 와 같은 파생 규칙을 쓴다 (split_part(address, "@", 2))', () => {
    expect(addressDomain('assistant@atmark.ai')).toBe('atmark.ai');
  });

  it.each(['no-at-sign', '@atmark.ai', 'assistant@'])('%s 는 도메인을 얻을 수 없다', (address) => {
    expect(() => addressDomain(address)).toThrow(AgentAddressError);
  });
});
