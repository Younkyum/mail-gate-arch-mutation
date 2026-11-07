/**
 * src/api/transition-announcement-template.ts — 전환 공지 본문 (계획 §3.2 2단계).
 *
 * **치환 값은 둘뿐이다 — 에이전트 주소와 소유자 이름.** 에이전트가 문구를 고르지 않는다: 이 경로의
 * 수신자는 소유자가 적은 seed 전원이고 발송은 소유자 승인 한 번으로 20통이 나간다. 문구를 본문에서
 * 받으면 그 한 번의 승인이 "임의 문구 20통" 의 승인이 된다 — 사람이 본 것은 수신자 목록이지 문구가 아닐
 * 수 있다. 고정 템플릿이면 승인의 대상이 "이 공지를 이 20명에게" 하나로 좁혀진다.
 *
 * 문구가 "기존 주소로 보내도 **당분간** 전달된다" 고 말하는 이유: 런북 3단계의 전달 규칙은 AC-0 게이트
 * 8일차에 반드시 꺼진다(§3.2 C1). 상대에게 "계속 전달된다" 고 약속하면 그 날 약속이 깨진다.
 */

export type AnnouncementLanguage = 'ko' | 'en';

export const ANNOUNCEMENT_LANGUAGES: readonly AnnouncementLanguage[] = ['ko', 'en'];

/** 소유자 이름 상한. 제목에 들어가므로 짧게 둔다(`messages.subject` 998자 CHECK 한참 아래). */
const MAX_OWNER_NAME_LENGTH = 80;

/**
 * 제어·서식 문자. 제목(헤더)에 들어가는 값이므로 `\r\n` 은 헤더 인젝션이고, 서식 문자(`\p{Cf}` —
 * 폭 없는 문자·양방향 재정렬)는 받는 사람 화면에서 이름을 다른 글자로 보이게 만든다.
 */
const FORBIDDEN_NAME_CHARACTERS = /[\p{Cc}\p{Cf}\u2028\u2029]/u;

/** 소유자 이름 검사. 문제가 없으면 `null`, 있으면 사람이 읽는 사유. */
export function ownerNameProblem(name: string): string | null {
  if (name.length === 0) return 'owner_name must not be empty.';
  if (name.length > MAX_OWNER_NAME_LENGTH) return `owner_name must be at most ${String(MAX_OWNER_NAME_LENGTH)} characters.`;
  if (FORBIDDEN_NAME_CHARACTERS.test(name)) return 'owner_name must not contain control or formatting characters.';
  return null;
}

export interface AnnouncementContent {
  readonly subject: string;
  readonly text: string;
}

export function renderTransitionAnnouncement(input: {
  readonly agentAddress: string;
  readonly ownerName: string;
  readonly language: AnnouncementLanguage;
}): AnnouncementContent {
  const { agentAddress: agent, ownerName: owner } = input;
  if (input.language === 'en') {
    return {
      subject: `${owner}'s work email is moving to ${agent}`,
      text: [
        'Hello,',
        '',
        `This is ${owner}. From now on, please send work-related email for me to ${agent}.`,
        `That address belongs to an agent that handles my work on my behalf. I still review and stay responsible for it.`,
        '',
        'Mail sent to my old address will be forwarded for a short while, but that forwarding will stop soon.',
        `Please save ${agent} in your contacts.`,
        '',
        'Thank you,',
        owner,
      ].join('\n'),
    };
  }
  return {
    subject: `[연락처 변경 안내] ${owner}의 업무 메일은 앞으로 ${agent} 로 보내 주세요`,
    text: [
      '안녕하세요.',
      '',
      `${owner}입니다. 앞으로 저와 진행하는 업무 메일은 ${agent} 로 보내 주시면 됩니다.`,
      '이 주소는 제 업무를 대신 처리하는 에이전트의 주소이며, 제가 계속 확인하고 책임집니다.',
      '',
      '기존 주소로 보내셔도 당분간은 전달되지만, 곧 전달이 중단됩니다.',
      `주소록에 ${agent} 를 저장해 주시면 감사하겠습니다.`,
      '',
      `${owner} 드림`,
    ].join('\n'),
  };
}
