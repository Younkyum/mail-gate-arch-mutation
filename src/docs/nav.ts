/**
 * src/docs/nav.ts — 문서의 뼈대: 머리 탭 넷과 사이드바 그룹의 순서·이름(두 언어). 페이지 순서는 그룹 순서 → 머리말 `order` 다.
 * 콘텐츠(`src/docs/content/**`)는 그룹 id 만 적고, 이름은 여기서 온다. import 가 없는 값 파일이다.
 */

import type { DocsLang } from './constants';

export const DOCS_GROUPS = ['get-started', 'agents', 'email', 'identity', 'team', 'connect', 'api', 'plans', 'security', 'help'] as const;
export type DocsGroup = (typeof DOCS_GROUPS)[number];

export function isDocsGroup(value: string): value is DocsGroup {
  return (DOCS_GROUPS as readonly string[]).includes(value);
}

export const DOCS_TABS = ['guides', 'connect', 'plans', 'help'] as const;
export type DocsTab = (typeof DOCS_TABS)[number];

/** 탭 → 그룹(이 순서가 사이드바·이전/다음 순서다). 모든 그룹이 정확히 한 탭에 있다(테스트). */
export const TAB_GROUPS: Readonly<Record<DocsTab, readonly DocsGroup[]>> = {
  guides: ['get-started', 'agents', 'email', 'identity', 'team'],
  connect: ['connect', 'api'],
  plans: ['plans', 'security'],
  help: ['help'],
};

export function tabOfGroup(group: DocsGroup): DocsTab {
  const tab = DOCS_TABS.find((t) => TAB_GROUPS[t].includes(group));
  if (tab === undefined) throw new Error(`tabOfGroup: 탭에 없는 그룹 ${group}`);
  return tab;
}

export const TAB_LABELS: Readonly<Record<DocsLang, Readonly<Record<DocsTab, string>>>> = {
  ko: { guides: '가이드', connect: '연결·API', plans: '요금제', help: '도움말' },
  en: { guides: 'Guides', connect: 'Connect & API', plans: 'Plans', help: 'Help' },
};

export const GROUP_LABELS: Readonly<Record<DocsLang, Readonly<Record<DocsGroup, string>>>> = {
  ko: {
    'get-started': '시작하기',
    agents: '에이전트',
    email: '이메일 설정',
    identity: '에이전트 신원',
    team: '팀·조직',
    connect: '에이전트 연결',
    api: 'API 레퍼런스',
    plans: '요금제·결제',
    security: '보안·개인정보',
    help: '도움말',
  },
  en: {
    'get-started': 'Get started',
    agents: 'Agents',
    email: 'Email settings',
    identity: 'Agent identity',
    team: 'Team and organization',
    connect: 'Connect agents',
    api: 'API reference',
    plans: 'Plans and billing',
    security: 'Security and privacy',
    help: 'Help',
  },
};

/** 그룹의 전역 순서(탭 순서 → 탭 안 그룹 순서). */
export const GROUP_ORDER: readonly DocsGroup[] = DOCS_TABS.flatMap((t) => TAB_GROUPS[t]);
