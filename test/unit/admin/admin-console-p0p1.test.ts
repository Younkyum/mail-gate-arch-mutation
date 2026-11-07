/**
 * 콘솔 P0/P1(`.omc/plans/extensibility-p0-p1.md` §4 · 계약 `.omc/handoffs/p0p1-api.md`) — 가짜 DOM 위에서 실제 앱 스크립트를 돌린다.
 *
 *   Ⓞ 조직 — 스위처(멤버십 · 역할 칩) · 전환(POST /api/session/org → 다른 탭 알림 → 전체 새로고침) · 다른 탭의 전환(BroadcastChannel ·
 *     403 csrf_mismatch → /api/me 다시 읽기) · 새 조직 · 조직 고르기 `#/select-org` · `#/o/{org}` 배너의 전환 버튼
 *   Ⓡ 역할 — member 읽기 전용(잠금 + 한 줄 + ⓘ) · admin 은 owner 전용만 잠김 · owner 전부
 *   Ⓜ 멤버와 초대 — 목록 · 역할 변경 · 제거 · 초대 · 초대 취소 · 주 소유자·나 자신은 컨트롤 없음
 *   Ⓚ 조직 API 키 — owner 만 부른다 · 발급(권한 하나 이상) → 평문 한 번 · 교체 · 폐기
 *   Ⓣ 새 토큰 권한 체크박스(R-7) — 0개면 발급이 잠기고 요청이 나가지 않는다
 *   Ⓟ 에이전트 목록 페이지(R-9) — 더 보기 · 서버 검색(q) · 딥링크 GET /api/agents/{id} · 채널 경로(R-5) · 콘솔 로그 "누가"
 *
 * 되돌려서 빨개지는지 확인한 것(2026-09-25): `can()` 이 늘 true → Ⓡ-1 · `ntCheck` 를 빼면 → Ⓣ-1 · `tellTabs()` 호출을 빼면 → Ⓞ-2 ·
 * `staleCheck()` 호출을 빼면 → Ⓞ-4 · `loadOrgKeys` 의 owner 검사를 빼면 → Ⓡ-1(GET /api/org-keys 가 나간다).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { renderAppPage, type Lang } from '../../../src/admin/ui/index';

import { AGENT, boot, type FakeNode, inlined, me, ORG_KEY, OVERRIDE, resetTeam, settle, t, TEAM, type World } from './console-harness';

beforeEach(() => resetTeam());
afterEach(() => OVERRIDE.clear());

const LANGS = ['ko', 'en'] as const;
const find = (root: FakeNode, pred: (n: FakeNode) => boolean): FakeNode[] => root.all().filter(pred);
const byText = (root: FakeNode, tag: string, text: string): FakeNode | undefined => find(root, (n) => n.tagName === tag && n.textContent === text)[0];
const posts = (w: World, url: string): unknown[] => w.calls.filter((c) => c.method !== 'GET' && c.url === url).map((c) => c.body);
const ok = (w: World): void => w.el('dc-ok').onclick?.();

async function as(lang: Lang, role: string, hash: string, init: Parameters<typeof boot>[2] = {}): Promise<World> {
  OVERRIDE.set('/api/me', me(role));
  return boot(lang, hash, init);
}

describe.each(LANGS)('Ⓞ 조직 (%s)', (lang) => {
  it('Ⓞ-1 스위처 — 멤버십 둘: 현재 조직(링크 · ✓ · 역할 칩) · 다른 조직(버튼 · 역할 칩) · 계정 메뉴는 로그인한 사용자 주소 + 역할', async () => {
    const w = await as(lang, 'owner', '#/overview');
    const rows = w.el('swo-list').children;
    expect(rows).toHaveLength(2);
    const cur = rows[0]?.children[0] as FakeNode;
    const other = rows[1]?.children[0] as FakeNode;
    expect(cur.tagName).toBe('A');
    expect(cur.getAttribute('aria-current')).toBe('true');
    expect(cur.textContent).toBe(`Chronostasis${t(lang, '소유자')}`); // ✓ 는 선 아이콘(비평 R10-06)
    expect(cur.all().some((n) => n.className === 'ck' && n.children.length === 1)).toBe(true);
    expect(other.tagName).toBe('BUTTON');
    expect(other.textContent).toBe(`Kairos Labs${t(lang, '운영자 검토 중')}${t(lang, '멤버')}`);
    expect(w.el('owner').textContent).toBe('me@example.com');
    expect(w.el('me-role').textContent).toBe(t(lang, '소유자'));
    // 적대적 검토 L4 — 윗줄 계정 버튼(열지 않아도 보인다)도 로그인한 사용자 주소. 조직 주 소유자 주소(owner@example.com)로 대신하지 않는다.
    expect(w.el('acct-email').textContent).toBe('me@example.com');
  });

  it('Ⓞ-1b /api/me에 사용자 주소가 없으면 계정 자리는 비운다 — 주 소유자 주소(organization.ownerEmail)를 로그인한 사람처럼 보이지 않는다', async () => {
    const withoutUser = { ...(me('member').json as Record<string, unknown>) };
    delete withoutUser['user'];
    OVERRIDE.set('/api/me', { status: 200, json: withoutUser });
    const w = await boot(lang, '#/overview');
    expect(w.el('acct-email').textContent).toBe('');
    expect(w.el('owner').textContent).toBe('');
  });

  it('Ⓞ-2 다른 조직을 고르면 POST /api/session/org {organizationId} + CSRF → 다른 탭에 알림 → 주소를 /app#/overview로 고치고 새로고침', async () => {
    const w = await as(lang, 'owner', '#/agents');
    const other = w.el('swo-list').children[1]?.children[0] as FakeNode;
    other.dispatch('click');
    await settle();
    expect(w.calls.filter((c) => c.url === '/api/session/org')).toEqual([{ method: 'POST', url: '/api/session/org', body: { organizationId: 'o2' }, csrf: 'csrf-1' }]);
    expect(w.channels.map((c) => c.name)).toEqual(['atmark-console']);
    expect(w.channels[0]?.posted).toEqual([{ type: 'org-switched' }]);
    expect(w.location.replaced).toEqual(['replace:/app#/overview', 'reload']);
  });

  it('Ⓞ-2b 전환이 실패하면(404 organization_not_found) 새로고침하지 않고 배너 한 줄', async () => {
    OVERRIDE.set('POST /api/session/org', { status: 404, json: { error: 'organization_not_found' } });
    const w = await as(lang, 'owner', '#/overview');
    (w.el('swo-list').children[1]?.children[0] as FakeNode).dispatch('click');
    await settle();
    expect(w.location.replaced).not.toContain('reload');
    expect(w.el('banner').hidden).toBe(false);
    expect(w.el('banner').textContent).toContain(t(lang, '이 조직의 멤버가 아닙니다. 새로고침하세요.'));
  });

  it('Ⓞ-3 다른 탭이 조직을 바꾸면(BroadcastChannel) 한 줄 알리고 새로고침 · BroadcastChannel이 없는 브라우저에서도 부팅된다', async () => {
    const w = await as(lang, 'owner', '#/overview', { timers: 'fast' });
    w.channels[0]?.onmessage?.({ data: { type: 'org-switched' } });
    expect(w.el('org-moved').hidden).toBe(false);
    await settle();
    expect(w.location.replaced).toEqual(['replace:/app#/overview', 'reload']);
    expect(w.delays).toContain(1200);
    const old = await boot(lang, '#/overview', { broadcast: false });
    expect(old.channels).toHaveLength(0);
    expect(old.el('org-name').textContent).toBe('Chronostasis');
  });

  it('Ⓞ-4 옛 CSRF(다른 탭에서 전환) — 변경이 403 csrf_mismatch로 닫히면 /api/me를 다시 읽고, 조직이 바뀌었으면 새로고침', async () => {
    const w = await as(lang, 'owner', '#/agents/a1/tokens', { timers: 'fast' });
    OVERRIDE.set('POST /api/agents/a1/tokens', { status: 403, json: { error: 'csrf_mismatch' } });
    OVERRIDE.set('/api/me', { status: 200, json: { ...(me('member').json as object), organization: { id: 'o2', name: 'Kairos Labs', role: 'member' }, csrf: 'csrf-2' } });
    w.el('tk-new').dispatch('click');
    w.el('nt-label').value = 'x';
    w.el('nt-form').dispatch('submit');
    await settle();
    await settle();
    expect(w.calls.filter((c) => c.url === '/api/me')).toHaveLength(2);
    expect(w.el('org-moved').hidden).toBe(false);
    expect(w.location.replaced).toContain('reload');
  });

  it('Ⓞ-5 새 조직 — 스위처 메뉴 끝 · 이름 검사(비면 요청 없음) → POST /api/organizations {name} → 새 조직으로 새로고침 · 409 org_limit 문구', async () => {
    const w = await as(lang, 'owner', '#/overview');
    w.el('swo-new').dispatch('click');
    expect(w.el('dlg-neworg').open).toBe(true);
    w.el('no-form').dispatch('submit');
    expect(posts(w, '/api/organizations')).toEqual([]);
    // 틀린 칸에 묶인 오류(비평 R7-06): aria-invalid + aria-describedby → 칸 바로 아래 메시지.
    expect(w.el('no-name').getAttribute('aria-invalid')).toBe('true');
    expect(w.el('no-name').getAttribute('aria-describedby')).toBe('no-name-err');
    expect(w.body.all().find((n) => n.id === 'no-name-err')?.textContent).toBe(t(lang, '조직 이름은 1~80자이고, 보이지 않는 문자는 쓸 수 없습니다.'));
    w.el('no-name').value = '  Side Project  ';
    w.el('no-form').dispatch('submit');
    await settle();
    expect(posts(w, '/api/organizations')).toEqual([{ name: 'Side Project' }]);
    expect(w.location.replaced).toEqual(['replace:/app#/overview', 'reload']);
    expect(w.channels[0]?.posted).toEqual([{ type: 'org-switched' }]);

    OVERRIDE.set('POST /api/organizations', { status: 409, json: { error: 'org_limit' } });
    const x = await as(lang, 'member', '#/overview');
    x.el('swo-new').dispatch('click');
    x.el('no-name').value = 'Third';
    x.el('no-form').dispatch('submit');
    await settle();
    expect(x.el('no-msg').textContent).toBe(t(lang, '더 만들 수 없습니다. 소유한 조직은 5개까지, 새 조직은 하루 2개까지입니다.'));
    expect(x.location.replaced).not.toContain('reload');
  });

  it('Ⓞ-6 조직 고르기 #/select-org — 행마다 이름 · 역할 칩 · 검토 상태 · 지금 조직 · 다른 조직을 누르면 전환', async () => {
    const w = await as(lang, 'admin', '#/select-org');
    expect(w.el('v-select-org').hidden).toBe(false);
    expect(w.el('v-overview').hidden).toBe(true);
    const picks = find(w.el('so-list'), (n) => n.className === 'orgpick');
    expect(picks.map((p) => p.textContent)).toEqual([
      `Chronostasis${t(lang, '관리자')}${t(lang, '지금 조직')}`,
      `Kairos Labs${t(lang, '멤버')}${t(lang, '운영자 검토 중')}`,
    ]);
    picks[0]?.dispatch('click');
    expect(w.location.hash).toBe('#/overview');
    picks[1]?.dispatch('click');
    await settle();
    expect(posts(w, '/api/session/org')).toEqual([{ organizationId: 'o2' }]);
    expect(w.location.replaced).toContain('reload');
  });

  it('Ⓞ-7 #/o/{내가 멤버인 다른 조직}/… — 자동 전환 없이 배너 + "이 조직으로 전환" → 누르면 전환하고 나머지 경로로 연다', async () => {
    const w = await as(lang, 'owner', '#/o/o2/agents');
    expect(w.el('org-other').hidden).toBe(false);
    expect(w.el('org-other-go').hidden).toBe(false);
    expect(posts(w, '/api/session/org')).toEqual([]);
    w.el('org-other-go').dispatch('click');
    await settle();
    expect(posts(w, '/api/session/org')).toEqual([{ organizationId: 'o2' }]);
    expect(w.location.replaced).toEqual(['replace:/app#/agents', 'reload']);
  });
});

describe.each(LANGS)('Ⓡ 역할 (%s)', (lang) => {
  it('Ⓡ-1 member — 읽기 전용 한 줄(ⓘ) · 변경 컨트롤은 잠기고 이유가 title에 · 행 동작(삭제·⋯)은 없다 · 조직 키는 부르지 않는다', async () => {
    const w = await as(lang, 'member', '#/agents/a1/tokens');
    expect(w.el('ro-bar').hidden).toBe(false);
    expect(w.body.classList.contains('role-ro')).toBe(true);
    for (const id of ['na-open', 'tk-new', 'tk-bulk', 'dz-kill', 'o-go', 'o-allow-add', 'om-all-i', 'im-none-i', 'mb-invite', 'ok-new', 'org-kill-on', 'org-kill-off']) {
      expect(w.el(id).disabled, id).toBe(true);
    }
    expect(w.el('tk-new').title).toBe(t(lang, '멤버는 바꿀 수 없습니다.'));
    expect(w.el('mb-invite').title).toBe(t(lang, '소유자만 할 수 있습니다.'));
    expect(find(w.el('tk-body'), (n) => n.className === 'icon-btn more-btn')).toHaveLength(0);
    await w.go('#/agents/a1/email');
    expect(find(w.el('o-allow-list'), (n) => n.tagName === 'BUTTON')).toHaveLength(0);
    await w.go('#/agents/a1/identity');
    expect(w.el('id-switch').getAttribute('aria-disabled')).toBe('true');
    await w.go('#/settings/keys');
    expect(w.calls.some((c) => c.url.startsWith('/api/org-keys'))).toBe(false);
    expect(w.el('ok-owner').hidden).toBe(false);
    expect(w.el('ok-ctl').hidden).toBe(true); // owner가 아니면 개수·발급 줄 대신 한 줄 이유만
    await w.go('#/settings/org');
    expect(w.el('so-role').textContent).toBe(t(lang, '멤버'));
    // 멤버 목록은 누구나 본다 — 다만 역할 칸은 칩이고 동작은 없다.
    await w.go('#/settings/members');
    expect(find(w.el('mb-body'), (n) => n.tagName === 'SELECT' || n.tagName === 'BUTTON')).toHaveLength(0);
    expect(w.el('mb-body').children).toHaveLength(3);
  });

  it('Ⓡ-2 admin — 에이전트·토큰은 바꾸고, owner 전용(멤버 초대 · 조직 키 · 조직 정지 해제)만 잠긴다', async () => {
    const w = await as(lang, 'admin', '#/agents/a1/tokens');
    expect(w.el('ro-bar').hidden).toBe(true);
    expect(w.el('tk-new').disabled).toBe(false);
    expect(w.el('dz-kill').disabled).toBe(false);
    expect(w.el('org-kill-on').disabled).toBe(false);
    expect(w.el('org-kill-off').disabled).toBe(true);
    expect(w.el('mb-invite').disabled).toBe(true);
    expect(w.el('ok-new').disabled).toBe(true);
    expect(find(w.el('tk-body'), (n) => n.className === 'icon-btn more-btn').length).toBeGreaterThan(0);
  });

  it('Ⓡ-3 역할이 없는 옛 서버(/api/me에 role 없음)는 소유자로 본다 — 잠금 없음', async () => {
    const w = await boot(lang, '#/settings/members');
    expect(w.el('ro-bar').hidden).toBe(true);
    expect(w.el('mb-invite').disabled).toBe(false);
    await w.go('#/settings/keys');
    expect(w.calls.some((c) => c.url === '/api/org-keys?status=all')).toBe(true);
  });

  it('Ⓡ-4 서버가 403 forbidden_role로 막으면 그 자리에 역할 문구(detail을 덧붙이지 않는다)', async () => {
    OVERRIDE.set('POST /api/agents/a1/tokens', { status: 403, json: { error: 'forbidden_role', detail: '관리자 이상', required: 'admin' } });
    const w = await as(lang, 'owner', '#/agents/a1/tokens');
    w.el('tk-new').dispatch('click');
    w.el('nt-label').value = 'x';
    w.el('nt-form').dispatch('submit');
    await settle();
    expect(w.el('nt-msg').textContent).toBe(t(lang, '내 역할로는 할 수 없는 작업입니다. 조직 소유자에게 역할을 요청하세요.'));
  });
});

describe.each(LANGS)('Ⓜ 멤버와 초대 (%s)', (lang) => {
  it('Ⓜ-1 목록 — 인원 3 / 5 · 주 소유자·나 자신은 역할 선택·제거가 없다 · 대기 초대 1 / 10 · 주 소유자는 나가기 버튼이 없다', async () => {
    const w = await as(lang, 'owner', '#/settings/members');
    expect(w.el('mb-count').textContent).toBe('3 / 5');
    const rows = w.el('mb-body').children;
    expect(rows).toHaveLength(3);
    expect(find(rows[0] as FakeNode, (n) => n.tagName === 'SELECT' || n.tagName === 'BUTTON')).toHaveLength(0);
    expect((rows[0] as FakeNode).textContent).toContain(t(lang, '주 소유자'));
    expect((rows[0] as FakeNode).textContent).toContain(t(lang, '내 계정'));
    expect(find(rows[1] as FakeNode, (n) => n.tagName === 'SELECT')[0]?.value).toBe('admin');
    expect(w.el('inv-w').hidden).toBe(false);
    expect(w.el('inv-n').textContent).toBe('1 / 10');
    expect(w.el('mb-leave').hidden).toBe(true);
  });

  it('Ⓜ-2 역할 변경 — 확인 뒤 PATCH /api/members/{userId} {role} · 취소하면 되돌아가고 요청 없음 · 409 last_owner 문구', async () => {
    const w = await as(lang, 'owner', '#/settings/members');
    const sel = find(w.el('mb-body').children[2] as FakeNode, (n) => n.tagName === 'SELECT')[0] as FakeNode;
    sel.value = 'admin';
    sel.dispatch('change');
    w.el('dc-cancel').onclick?.();
    await settle();
    expect(sel.value).toBe('member');
    expect(w.calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
    sel.value = 'admin';
    sel.dispatch('change');
    ok(w);
    await settle();
    expect(w.calls.filter((c) => c.method === 'PATCH')).toEqual([{ method: 'PATCH', url: '/api/members/u3', body: { role: 'admin' }, csrf: 'csrf-1' }]);
    expect(TEAM.members.find((m) => m.userId === 'u3')?.role).toBe('admin');

    OVERRIDE.set('PATCH /api/members/u2', { status: 409, json: { error: 'last_owner' } });
    const s2 = find(w.el('mb-body').children[1] as FakeNode, (n) => n.tagName === 'SELECT')[0] as FakeNode;
    s2.value = 'member';
    s2.dispatch('change');
    ok(w);
    await settle();
    expect(s2.value).toBe('admin');
    expect(w.el('mb-msg').textContent).toBe(t(lang, '조직에는 소유자가 한 명 이상 있어야 합니다.'));
  });

  it('Ⓜ-3 제거 — 확인(위험) 뒤 DELETE /api/members/{userId} → 목록 다시', async () => {
    const w = await as(lang, 'owner', '#/settings/members');
    const b = byText(w.el('mb-body').children[2] as FakeNode, 'BUTTON', t(lang, '제거')) as FakeNode;
    b.dispatch('click');
    expect(w.el('dc-head').className).toBe('dh hatch');
    ok(w);
    await settle();
    expect(w.calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual(['/api/members/u3']);
    expect(w.el('mb-body').children).toHaveLength(2);
  });

  it('Ⓜ-4 초대 — 주소 검사(요청 없음) · 역할(멤버 기본 | 관리자) → POST /api/members/invites {email, role} · 대기 목록이 는다 · 초대 취소', async () => {
    const w = await as(lang, 'owner', '#/settings/members');
    w.el('mb-invite').dispatch('click');
    expect(w.el('dlg-invite').open).toBe(true);
    expect(w.el('in-r-member').checked).toBe(true);
    w.el('in-email').value = 'not-an-address';
    w.el('in-form').dispatch('submit');
    expect(posts(w, '/api/members/invites')).toEqual([]);
    w.el('in-email').value = 'Pat@Example.com ';
    w.el('in-r-admin').checked = true;
    w.el('in-form').dispatch('submit');
    await settle();
    expect(posts(w, '/api/members/invites')).toEqual([{ email: 'pat@example.com', role: 'admin' }]);
    expect(w.el('dlg-invite').open).toBe(false);
    expect(w.el('inv-body').children).toHaveLength(2);
    const cancel = byText(w.el('inv-body').children[0] as FakeNode, 'BUTTON', t(lang, '초대 취소')) as FakeNode;
    cancel.dispatch('click');
    ok(w);
    await settle();
    expect(posts(w, '/api/members/invites/i1/revoke')).toHaveLength(1);
    expect(w.el('inv-body').children).toHaveLength(1);
  });

  it('Ⓜ-5 멤버 자리가 차면(멤버 + 대기 초대 ≥ 5) 초대 버튼이 잠기고 이유가 title에', async () => {
    TEAM.invites = [...TEAM.invites, { ...TEAM.invites[0]!, id: 'i2', email: 'b@example.com' }];
    const w = await as(lang, 'owner', '#/settings/members');
    expect(w.el('mb-invite').disabled).toBe(true);
    expect(w.el('mb-invite').title).toBe(t(lang, '조직 멤버가 가득 찼습니다(대기 중인 초대 포함).'));
  });

  it('Ⓜ-6 나가기 — 주 소유자가 아닌 나: 확인 뒤 POST /api/members/leave → 로그인 화면으로', async () => {
    TEAM.members = TEAM.members.map((m) => ({ ...m, you: m.userId === 'u2' }));
    const w = await as(lang, 'admin', '#/settings/members');
    expect(w.el('mb-leave').hidden).toBe(false);
    w.el('mb-leave').dispatch('click');
    ok(w);
    await settle();
    expect(posts(w, '/api/members/leave')).toHaveLength(1);
    expect(w.location.replaced).toContain('/');
  });
});

describe.each(LANGS)('Ⓚ 조직 API 키 (%s)', (lang) => {
  it('Ⓚ-1 목록 — 활성 1 / 5 · 이름 · 키 값(atk_org_ + 가림 + 끝 4자) · 권한 칩 · 만든 사람 · 폐기된 키는 흐리고 동작 없음', async () => {
    const w = await as(lang, 'owner', '#/settings/keys');
    expect(w.el('ok-count').textContent).toBe('1 / 5');
    const rows = w.el('ok-body').children;
    expect(rows).toHaveLength(2);
    expect((rows[0] as FakeNode).textContent).toContain('atk_org_••••••••Q7xa');
    expect((rows[0] as FakeNode).textContent).toContain(t(lang, '에이전트 읽기'));
    expect((rows[0] as FakeNode).textContent).toContain('owner@example.com');
    expect((rows[1] as FakeNode).className).toBe('off');
    expect(find(rows[1] as FakeNode, (n) => n.tagName === 'BUTTON')).toHaveLength(0);
  });

  it('Ⓚ-2 발급 — 권한 둘 다 끄면 발급이 잠기고 요청 없음 · 하나 → POST {label, capabilities, expiresDays} → 평문 창(한 번 · 확인 전 못 닫음 · 닫으면 지움)', async () => {
    const w = await as(lang, 'owner', '#/settings/keys');
    w.el('ok-new').dispatch('click');
    expect(w.el('dlg-orgkey').open).toBe(true);
    w.el('ko-label').value = 'deploy-bot';
    w.el('ko-cap-0').checked = false;
    w.el('ko-cap-1').checked = false;
    w.el('ko-cap-1').dispatch('change');
    expect(w.el('ko-go').disabled).toBe(true);
    w.el('ko-form').dispatch('submit');
    expect(posts(w, '/api/org-keys')).toEqual([]);
    w.el('ko-cap-0').checked = true;
    w.el('ko-cap-0').dispatch('change');
    expect(w.el('ko-go').disabled).toBe(false);
    w.el('ko-exp').value = '90';
    w.el('ko-form').dispatch('submit');
    await settle();
    expect(posts(w, '/api/org-keys')).toEqual([{ label: 'deploy-bot', capabilities: ['agents:read'], expiresDays: 90 }]);
    expect(w.el('dlg-okshow').open).toBe(true);
    expect(w.el('ks-key').textContent).toBe(ORG_KEY);
    expect(w.el('ks-ex').textContent).toBe(`curl -H "Authorization: Bearer ${ORG_KEY}" https://console.atmark.ai/org-api/v1/agents`);
    // 보통의 닫기 — 확인란 없이 버튼이 처음부터 눌린다 · Esc 로 닫혀도(close) 평문은 DOM 에서 지워진다.
    expect(() => w.el('ks-ack')).toThrow();
    expect(w.el('ks-close').disabled).toBeFalsy();
    expect(w.el('dlg-okshow').dispatch('cancel').defaultPrevented).toBe(false);
    w.el('dlg-okshow').close();
    expect(w.el('dlg-okshow').open).toBe(false);
    expect(w.el('ks-key').textContent).toBe('');
    expect(w.el('ks-ex').textContent).toBe('');
    expect(w.el('ok-body').textContent).not.toContain(ORG_KEY);
    // 에이전트 토큰 창은 쓰지 않는다(섞지 않는다 — §4-4).
    expect(w.el('dlg-token').open).toBe(false);
  });

  it('Ⓚ-3 행 ⋯ — 교체(평문 창) · 폐기(확인 → POST revoke)', async () => {
    const w = await as(lang, 'owner', '#/settings/keys');
    const row = w.el('ok-body').children[0] as FakeNode;
    (byText(row, 'BUTTON', t(lang, '교체')) as FakeNode).dispatch('click');
    ok(w);
    await settle();
    expect(posts(w, '/api/org-keys/k1/rotate')).toHaveLength(1);
    expect(w.el('dlg-okshow').open).toBe(true);
    expect(w.el('ks-kicker').textContent).toBe(t(lang, '새 키(이전 키는 폐기됨)'));
    w.el('ks-close').dispatch('click');
    expect(w.el('dlg-okshow').open).toBe(false);
    expect(w.el('ks-key').textContent).toBe('');
    const row2 = w.el('ok-body').children[0] as FakeNode;
    (byText(row2, 'BUTTON', t(lang, '폐기')) as FakeNode).dispatch('click');
    ok(w);
    await settle();
    expect(posts(w, '/api/org-keys/k9/revoke')).toHaveLength(1);
  });
});

describe.each(LANGS)('Ⓣ 토큰 권한 (%s)', (lang) => {
  it('Ⓣ-1 새 토큰 — 기본 권한 다섯(앞 넷 + 정책 변경 요청, 2026-10-13) · 전부 끄면 발급 잠김 + 한 줄 · 요청 없음 · 고른 것만 capabilities로', async () => {
    const w = await as(lang, 'owner', '#/agents/a1/tokens');
    w.el('tk-new').dispatch('click');
    expect([0, 1, 2, 3, 6].map((i) => w.el(`nt-cap-${String(i)}`).checked)).toEqual([true, true, true, true, true]);
    expect(w.el('nt-cap-6').value).toBe('policy:request');
    w.el('nt-label').value = 'reader';
    for (const i of [0, 1, 2, 3, 6]) w.el(`nt-cap-${String(i)}`).checked = false;
    w.el('nt-cap-3').dispatch('change');
    expect(w.el('nt-go').disabled).toBe(true);
    expect(w.el('nt-caps-none').hidden).toBe(false);
    w.el('nt-form').dispatch('submit');
    expect(posts(w, '/api/agents/a1/tokens')).toEqual([]);
    w.el('nt-cap-1').checked = true;
    w.el('nt-cap-1').dispatch('change');
    expect(w.el('nt-caps-none').hidden).toBe(true);
    w.el('nt-form').dispatch('submit');
    await settle();
    expect(posts(w, '/api/agents/a1/tokens')).toEqual([{ label: 'reader', capabilities: ['messages:read'] }]);
    expect(inlined(renderAppPage(lang))).toContain('value="messages:send" checked');
  });
});

describe.each(LANGS)('Ⓟ 페이지 · 채널 · 로그 (%s)', (lang) => {
  const MORE = { ...AGENT, id: 'a2', name: 'research-bot', address: 'research@atmark.ai' };

  it('Ⓟ-1 목록은 limit=50 한 쪽 → 다음 커서가 있으면 "더 보기" → cursor로 이어 붙인다 · 개수에 + 표시', async () => {
    OVERRIDE.set('/api/agents?limit=50', { status: 200, json: { items: [AGENT], nextCursor: 'c1' } });
    OVERRIDE.set('/api/agents?limit=50&cursor=c1', { status: 200, json: { items: [MORE], nextCursor: null } });
    const w = await as(lang, 'owner', '#/agents');
    expect(w.el('agents-body').children).toHaveLength(1);
    expect(w.el('ag-more').hidden).toBe(false);
    expect(w.el('ag-count').textContent).toBe('1+ / 10');
    w.el('ag-more').dispatch('click');
    await settle();
    expect(w.el('agents-body').children).toHaveLength(2);
    expect(w.el('ag-more').hidden).toBe(true);
  });

  it('Ⓟ-2 검색 — 다 받은 목록은 여기서 거른다(요청 없음) · 더 있으면 250ms 뒤 서버 q', async () => {
    OVERRIDE.set('/api/agents?limit=50', { status: 200, json: { items: [AGENT], nextCursor: 'c1' } });
    OVERRIDE.set('/api/agents?limit=50&q=research', { status: 200, json: { items: [MORE], nextCursor: null } });
    const w = await as(lang, 'owner', '#/agents', { timers: 'fast' });
    expect(w.el('ag-bar').hidden).toBe(false);
    w.el('ag-q').value = 'Research';
    w.el('ag-q').dispatch('input');
    await settle();
    expect(w.delays).toContain(250);
    expect(w.calls.filter((c) => c.url === '/api/agents?limit=50&q=research')).toHaveLength(1);
    expect(w.el('agents-body').textContent).toContain('research-bot');
    // 검색 결과의 에이전트로 가면 목록을 다시 받지 않고 그린다.
    await w.go('#/agents/a2');
    expect(w.el('a-name').textContent).toBe('research-bot');

    OVERRIDE.delete('/api/agents?limit=50');
    const local = await as(lang, 'owner', '#/agents');
    local.el('ag-q').value = 'zzz';
    local.el('ag-q').dispatch('input');
    await settle();
    expect(local.calls.some((c) => c.url.includes('&q='))).toBe(false);
    expect(local.el('agents-none').hidden).toBe(false);
  });

  it('Ⓟ-3 딥링크 — 첫 쪽에 없는 에이전트는 GET /api/agents/{id} 한 번으로 그린다 · 없으면 "찾지 못했습니다"', async () => {
    OVERRIDE.set('/api/agents/a2', { status: 200, json: MORE });
    const w = await as(lang, 'owner', '#/agents/a2');
    expect(w.calls.filter((c) => c.url === '/api/agents/a2')).toHaveLength(1);
    expect(w.el('a-body').hidden).toBe(false);
    expect(w.el('sc-name').textContent).toBe('research-bot');
    const gone = await as(lang, 'owner', '#/agents/zz');
    expect(gone.el('a-missing').hidden).toBe(false);
    expect(gone.calls.filter((c) => c.url === '/api/agents/zz')).toHaveLength(1);
  });

  it('Ⓟ-4 정책은 채널 경로(R-5) — GET·PATCH /api/agents/{id}/channels/email/policy · 규칙 POST/DELETE도 같은 접두사', async () => {
    const w = await as(lang, 'owner', '#/agents/a1/email');
    expect(w.calls.some((c) => c.url === '/api/agents/a1/channels/email/policy')).toBe(true);
    expect(w.calls.some((c) => /\/api\/agents\/a1\/(policy|rules)/.test(c.url))).toBe(false);
  });

  it('Ⓟ-5 콘솔 로그 "누가" — 사용자 주소 · 조직 키(이름 + atk_org_ + 가림 + 끝 4자) · 새 동작 이름(멤버·조직 키·전환)', async () => {
    OVERRIDE.set('/api/logs?type=console&limit=50', {
      status: 200,
      json: {
        items: [
          { id: 'c1', at: '2026-09-25T01:00:00Z', action: 'member.invite', targetId: 'i1', actor: { kind: 'user', email: 'owner@example.com' } },
          { id: 'c2', at: '2026-09-25T02:00:00Z', action: 'agent.create', targetId: 'a1', actor: { kind: 'org_key', label: 'github-actions', hint: 'Q7xa' } },
          { id: 'c3', at: '2026-09-25T03:00:00Z', action: 'session.switch', targetId: null },
        ],
        next: null,
      },
    });
    const w = await as(lang, 'owner', '#/logs/console');
    const text = w.el('lg-body').textContent;
    expect(text).toContain(t(lang, '멤버 초대'));
    expect(text).toContain('owner@example.com');
    expect(text).toContain('github-actions');
    expect(text).toContain('atk_org_••••••••Q7xa');
    expect(text).toContain(t(lang, '조직 전환'));
  });
});
