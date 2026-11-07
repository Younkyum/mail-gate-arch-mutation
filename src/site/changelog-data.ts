/**
 * src/site/changelog-data.ts — `/changelog`·`/kr/changelog`(게이트 B 2026-10-01, 마케팅 계획 §5.1)의 값. **이 파일 하나에 한 줄씩 덧붙인다.**
 *
 * 규칙(계획 §5.1 · §9.1 — `changelog.test.ts` 가 건다):
 *   - **이미 배포한 것만.** 예정 기능 · "곧" · 구독 · 알림 신청은 적지 않는다. 운영에서 꺼져 있는 것(고객 도메인 등)도 적지 않는다.
 *   - 한 항목 = 날짜(ISO, 배포된 날) + 사용자가 알아볼 한 줄(두 언어). 내부 이름(테이블 · 람다 · ADR 번호)은 쓰지 않는다.
 *   - **최신이 위.** 같은 날 항목은 위에서부터 중요한 순.
 *   - 가격 · 요금제 · 무료 이야기는 쓰지 않는다(그건 `/pricing` 의 몫 — `site-pages.test.ts` ⑥). copy-guard 금지어도 그대로 걸린다.
 *   - 예시 주소는 예약된 이름(`EXAMPLE_RESERVED_LOCAL_PARTS`)과 운영 주소(abuse@ · postmaster@)뿐이다.
 *
 * 2026-10-01 첫 목록은 `git log --since=2026-09-22` 에서 사용자에게 보이는 변경만 골라 적었다.
 */

import type { SiteLang } from './constants';

export interface ChangelogEntry {
  /** 배포된 날(ISO `YYYY-MM-DD`). */
  readonly date: string;
  /** 한 줄(정적 마크업 조각 — 코드 상수, 사용자 입력 없음). `<code>` 정도만 쓴다. */
  readonly text: Readonly<Record<SiteLang, string>>;
}

export const CHANGELOG: readonly ChangelogEntry[] = [
  {
    date: '2026-10-01',
    text: {
      en: 'The blog is open, with its first post in English and Korean.',
      ko: '블로그를 열고 첫 글을 영어와 한국어로 올렸습니다.',
    },
  },
  {
    date: '2026-10-01',
    text: {
      en: 'New Use cases page: six ways to put an agent&rsquo;s own address to work.',
      ko: '사용 예시 페이지를 열었습니다. 에이전트 주소로 하는 여섯 가지 일을 소개합니다.',
    },
  },
  {
    date: '2026-09-30',
    text: {
      en: 'Sign-up is by waitlist invitation, and an invited organization is active right away.',
      ko: '가입은 대기자 명단의 초대로 받습니다. 초대받은 조직은 가입하면 바로 쓸 수 있습니다.',
    },
  },
  {
    date: '2026-09-30',
    text: {
      en: 'A new Atmark logo on the site, the console and the docs.',
      ko: '사이트·콘솔·문서에 새 Atmark 로고를 달았습니다.',
    },
  },
  {
    date: '2026-09-30',
    text: {
      en: 'Webhooks tab in the console: create and edit webhooks and rotate their signing secrets. The same actions are available as MCP tools.',
      ko: '콘솔에 웹훅 탭이 생겼습니다. 웹훅을 만들고 고치고 서명 시크릿을 교체할 수 있고, 같은 일을 MCP 도구로도 할 수 있습니다.',
    },
  },
  {
    date: '2026-09-30',
    text: {
      en: 'Creating and editing things in the console now happens in dialogs.',
      ko: '콘솔에서 만들고 고치는 일은 이제 대화상자에서 합니다.',
    },
  },
  {
    date: '2026-09-30',
    text: {
      en: 'Account menu at the bottom left of the console sidebar, with theme and language inside it.',
      ko: '콘솔 계정 메뉴를 사이드바 왼쪽 아래로 옮기고, 테마와 언어를 그 안에 넣었습니다.',
    },
  },
  {
    date: '2026-09-30',
    text: {
      en: '<code>abuse@atmark.ai</code> and <code>postmaster@atmark.ai</code> now reach the Atmark team.',
      ko: '<code>abuse@atmark.ai</code>와 <code>postmaster@atmark.ai</code>로 보낸 메일이 Atmark 팀에 닿습니다.',
    },
  },
  {
    date: '2026-09-30',
    text: {
      en: 'Rewritten Quickstart in the docs, and a new page: What Atmark is not for.',
      ko: '문서의 빠른 시작을 다시 쓰고, &lsquo;Atmark로 하면 안 되는 일&rsquo; 페이지를 더했습니다.',
    },
  },
  {
    date: '2026-09-30',
    text: {
      en: 'English is the default at atmark.ai, and the Korean site lives under <code>/kr</code>.',
      ko: 'atmark.ai는 영어가 기본이 되었고, 한국어 사이트는 <code>/kr</code> 아래에 있습니다.',
    },
  },
  {
    date: '2026-09-29',
    text: {
      en: 'Aliases and outgoing attachments are on for every organization, managed from the agent&rsquo;s Addresses tab.',
      ko: '별칭과 첨부 발신을 모든 조직에 열었습니다. 에이전트의 &lsquo;주소&rsquo; 탭에서 관리합니다.',
    },
  },
  {
    date: '2026-09-28',
    text: {
      en: 'Login and sign-up emails carry a 6-digit code next to the link.',
      ko: '로그인·가입 메일에 링크와 함께 6자리 코드가 옵니다.',
    },
  },
  {
    date: '2026-09-28',
    text: {
      en: 'Agents can read the attachments they receive, through the API and the MCP tool <code>read_attachment</code>.',
      ko: '에이전트가 받은 첨부를 API와 MCP 도구 <code>read_attachment</code>로 직접 읽습니다.',
    },
  },
  {
    date: '2026-09-25',
    text: {
      en: 'Dark mode: the site follows your system setting, and the console lets you choose.',
      ko: '다크 모드: 사이트는 시스템 설정을 따르고, 콘솔에서는 직접 고를 수 있습니다.',
    },
  },
  {
    date: '2026-09-24',
    text: {
      en: 'Public transparency log at <code>id.atmark.ai/log</code>: a signed checkpoint every hour, anchored to Bitcoin and Sigstore once a day.',
      ko: '공개 투명성 로그(<code>id.atmark.ai/log</code>)를 열었습니다. 매시간 서명한 체크포인트를 게시하고, 하루 한 번 Bitcoin과 Sigstore에 앵커합니다.',
    },
  },
];
