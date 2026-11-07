/**
 * 주간 운영판 화면(202610010900) — 페이지 스크립트를 **가짜 DOM 위에서 실제로 돌려** 그린 글자를 본다(로컬 설정 · `#/board`).
 * API 응답은 서버와 같은 순수 함수(`ladderOf` · `cohortRowOf` · `ratio`)로 만든다 — 화면은 판정을 다시 하지 않고 그리기만 한다.
 *
 * 되돌리면 빨개져야 하는 것:
 *   - 하한 미달이면 "판정 불가 / insufficient volume"(초록 L0 문구가 아니다) · L1 이면 그 단계.
 *   - 분모 20 미만 칸에는 `%` 가 없다(`3/12`) · 20 이상이면 `30/40 (75%)`.
 *   - 7일 창이 닫히지 않은 코호트에 "창 미종료" · Beta 줄이 따로 · 수동 확인 링크는 https 만(새 창 · noopener noreferrer).
 *   - 조직 id 만 그린다 · 판정 한 줄은 자리 표시뿐(입력 · 저장 없음).
 */

import vm from 'node:vm';

import { describe, expect, it } from 'vitest';

import { BOARD_MANUAL_CHECKS, BOARD_RULES, cohortRowOf, ladderOf, type BoardGuardRaw } from '../../../src/ops/console/board-rules';
import { buildOpsPage, LOCAL_PAGE_CONFIG } from '../../../src/ops/console/page';

// ---------------------------------------------------------------------------
// 가짜 DOM — 스크립트가 쓰는 만큼만(getElementById · createElement · textContent · appendChild · 속성 · 리스너).
// ---------------------------------------------------------------------------

class FakeNode {
  parent: FakeElement | null = null;
  get textContent(): string {
    return '';
  }
}

class FakeText extends FakeNode {
  constructor(private readonly text: string) {
    super();
  }
  override get textContent(): string {
    return this.text;
  }
}

class FakeElement extends FakeNode {
  children: FakeNode[] = [];
  className = '';
  hidden = false;
  href = '';
  target = '';
  rel = '';
  type = '';
  value = '';
  title = '';
  colSpan = 1;
  disabled = false;
  readonly attrs = new Map<string, string>();
  readonly listeners = new Map<string, ((ev: unknown) => void)[]>();
  constructor(readonly tagName: string) {
    super();
  }
  override get textContent(): string {
    return this.children.map((c) => c.textContent).join('');
  }
  override set textContent(value: string) {
    this.children = [new FakeText(String(value))];
  }
  get firstChild(): FakeNode | null {
    return this.children[0] ?? null;
  }
  appendChild(child: FakeNode): FakeNode {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  removeChild(child: FakeNode): FakeNode {
    this.children = this.children.filter((c) => c !== child);
    return child;
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }
  addEventListener(type: string, fn: (ev: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener(): void {}
  focus(): void {}
  showModal(): void {}
  close(): void {}
  scrollIntoView(): void {}
  /** 자손 요소(깊이 우선). */
  all(): FakeElement[] {
    return this.children.flatMap((c) => (c instanceof FakeElement ? [c, ...c.all()] : []));
  }
}

interface Rendered {
  readonly view: FakeElement;
  readonly requests: string[];
}

async function renderBoard(boardBody: unknown): Promise<Rendered> {
  const page = buildOpsPage(LOCAL_PAGE_CONFIG);
  const script = page.html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
  const ids = new Map<string, FakeElement>();
  const byId = (id: string): FakeElement => {
    let el = ids.get(id);
    if (el === undefined) {
      el = new FakeElement('div');
      ids.set(id, el);
    }
    return el;
  };
  const requests: string[] = [];
  const answers: Record<string, unknown> = {
    '/api/session': { billingOperator: false, target: { where: '로컬 테스트', kind: 'local' }, actor: 'test', idleMinutes: 30, maxHours: 8 },
    '/api/board': boardBody,
    '/api/review': { items: [] },
  };
  const location = { hash: '#/board', pathname: '/' };
  const context = vm.createContext({
    document: {
      getElementById: byId,
      createElement: (tag: string) => new FakeElement(tag),
      createTextNode: (text: string) => new FakeText(text),
      querySelectorAll: () => [],
    },
    window: { addEventListener: () => undefined, scrollTo: () => undefined, innerWidth: 1440 },
    location,
    history: { replaceState: () => undefined },
    sessionStorage: { getItem: () => 'x'.repeat(43), setItem: () => undefined },
    fetch: (url: string) => {
      requests.push(url);
      const body = answers[url];
      return Promise.resolve({ ok: body !== undefined, status: body === undefined ? 404 : 200, json: () => Promise.resolve(body ?? { error: 'not_found' }) });
    },
    URLSearchParams,
    Node: FakeNode,
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(script, context);
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  return { view: byId('view'), requests };
}

// ---------------------------------------------------------------------------
// 응답 — 서버와 같은 순수 함수로 만든다.
// ---------------------------------------------------------------------------

const NOW = new Date('2026-10-16T01:00:00.000Z'); // 2주차 금요일 10:00 KST
const ORG = '33333333-3333-4333-8333-333333333333';
const zero = { signedUp: 0, agent: 0, mcp: 0, inbound: 0, read: 0, deny: 0, reply: 0, retained: 0 };

function guard(over: Partial<BoardGuardRaw> = {}): BoardGuardRaw {
  return {
    externalSends: { d7: 30, d14: 60, d28: 60, newOrgD7: 10 },
    sesComplaints: 0,
    sesBounces: 0,
    systemComplaints: 0,
    systemHardBounces: 0,
    waitlistHardBounces: 0,
    gmailDailyPeak: 4,
    allModeCount: 0,
    allModeOrgs: [],
    dailyRecipientsTop: [],
    harvestTop: [],
    ...over,
  };
}

function body(g: BoardGuardRaw, manual: readonly unknown[] = BOARD_MANUAL_CHECKS): unknown {
  const ladder = ladderOf(g);
  return {
    at: NOW.toISOString(),
    guardrail: {
      ...ladder,
      volume: { d7: g.externalSends.d7, d14: g.externalSends.d14, d28: g.externalSends.d28, floor14d: BOARD_RULES.volumeFloor14d, floor28d: BOARD_RULES.volumeFloor28d, launchFloorMet: false },
      manual,
    },
    northStar: { global: 2, beta: 1, internalExcluded: 1 },
    cohorts: {
      internalExcluded: 1,
      rows: [
        // 열린 주(이번 주) — 분모 20 미만.
        cohortRowOf({ week: '2026-W42', invited: 12, open7: 2, open14: 2, global: { ...zero, signedUp: 3, agent: 2 }, beta: zero }, NOW),
        // 닫힌 주(오래전) — 분모 20 이상 · Beta 2곳.
        cohortRowOf({ week: '2026-W36', invited: 40, open7: 0, open14: 0, global: { ...zero, signedUp: 30, agent: 21, retained: 9 }, beta: { ...zero, signedUp: 2, agent: 1 } }, NOW),
      ],
    },
    waitlist: { waiting: 7, invited: 3, expired: 1, joined: 4, grades: { A: 2, B: 3, hold: 1, unknown: 1 }, gradeASlaBreaches: 1 },
  };
}

const rowsOf = (view: FakeElement): string[][] =>
  view
    .all()
    .filter((el) => el.tagName === 'tr')
    .map((tr) => tr.children.map((td) => td.textContent));

describe('주간 운영판 화면 — 가짜 DOM 위에서 그린다', () => {
  it('하한 미달 → "판정 불가 / insufficient volume" · 0건 신호는 판정 불가 · 외부 발신량이 함께 보인다', async () => {
    const { view, requests } = await renderBoard(body(guard()));
    expect(requests).toContain('/api/board');
    const text = view.textContent;
    expect(text).toContain('주간 운영판');
    expect(text).toContain('판정 불가 / insufficient volume');
    expect(text).not.toContain('L0 이상 없음');
    expect(text).toContain('하한 200 미달');
    const complaint = rowsOf(view).find((r) => r[0]?.startsWith('관측된 불만'));
    expect(complaint?.[2]).toBe('판정 불가');
    expect(complaint?.[3]).toContain('외부 발신 30통/7일');
  });

  it('L1 신호 → 단계 L1 · 넘은 조직 id 가 그 줄에 · 하한을 넘으면 L0 문구', async () => {
    const fired = await renderBoard(body(guard({ allModeCount: 1, allModeOrgs: [ORG] })));
    expect(fired.view.textContent).toContain('L1 검토');
    const row = rowsOf(fired.view).find((r) => r[0]?.startsWith('가입 14일 안에'));
    expect(row?.[2]).toBe('넘음');
    expect(row?.[3]).toContain(ORG);
    const calm = await renderBoard(body(guard({ externalSends: { d7: 150, d14: 250, d28: 400, newOrgD7: 5 } })));
    expect(calm.view.textContent).toContain('L0 이상 없음');
    expect(calm.view.textContent).not.toContain('insufficient volume');
  });

  it('코호트 — 분모 20 미만은 n/N 만 · 20 이상은 퍼센트 · 열린 주에 "창 미종료" · Beta 줄 따로', async () => {
    const { view } = await renderBoard(body(guard()));
    const rows = rowsOf(view);
    const open = rows.find((r) => r[0]?.startsWith('2026-W42'));
    expect(open?.[0]).toContain('창 미종료');
    expect(open?.slice(1, 4)).toEqual(['12', '3/12', '2/3']);
    expect(open?.join('|')).not.toContain('%');
    const closed = rows.find((r) => r[0]?.startsWith('2026-W36'));
    expect(closed?.[0]).not.toContain('창 미종료');
    expect(closed?.slice(1, 4)).toEqual(['40', '30/40 (75%)', '21/30 (70%)']);
    expect(closed?.[9]).toBe('9/30 (30%)');
    const beta = rows[rows.indexOf(closed as string[]) + 1];
    expect(beta?.slice(0, 4)).toEqual(['Beta', '-', '2', '1/2']);
    expect(view.textContent).toContain('내부 조직 1곳 제외');
  });

  it('수동 확인 — https 링크만 새 창 · noopener noreferrer · 그 밖의 URL 은 링크가 아니다', async () => {
    const manual = [...BOARD_MANUAL_CHECKS, { key: 'evil', level: 'L3', label: '나쁜 링크', url: 'javascript:alert(1)' }];
    const { view } = await renderBoard(body(guard(), manual));
    const links = view.all().filter((el) => el.tagName === 'a' && el.textContent === '열기');
    expect(links.map((a) => a.href)).toEqual(BOARD_MANUAL_CHECKS.flatMap((c) => (c.url === null ? [] : [c.url])));
    for (const a of links) expect([a.target, a.rel]).toEqual(['_blank', 'noopener noreferrer']);
    expect(view.textContent).toContain('나쁜 링크');
    expect(view.all().some((el) => el.href.startsWith('javascript:'))).toBe(false);
  });

  it('북극성 · 대기자 명단(등급 후보 · A SLA 초과) · 판정 한 줄은 자리 표시(입력 없음)', async () => {
    const { view } = await renderBoard(body(guard()));
    const text = view.textContent;
    expect(text).toContain('북극성 · 주간 수신 활성 조직');
    expect(text).toContain('A 2 · B 3 · 보류 1 · 미정 1');
    const sla = view.all().find((el) => el.className.startsWith('stat') && el.textContent.startsWith('A 등급 SLA 초과'));
    expect(sla?.className).toBe('stat hot');
    expect(text).toContain('판정 한 줄');
    expect(text).toContain('증량 / 유지 / 동결 중 하나를 창업자가 직접 적는다');
    expect(view.all().some((el) => el.tagName === 'input' || el.tagName === 'textarea' || el.tagName === 'button')).toBe(false);
  });
});
