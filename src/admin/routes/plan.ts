/**
 * src/admin/routes/plan.ts — 콘솔 설정 "요금제·사용량"(ADR-0011): `GET /api/plan` → `PlanUsageView`(`ops/plan.ts`).
 *
 * **읽기만** — 요금제를 바꾸는 라우트는 없다(admin 롤은 `org_entitlements` 를 SELECT 만 가진다). 결제 공급자(WP-2)가 붙기 전까지
 * `upgradeAvailable: false` 이고 콘솔의 "업그레이드" 는 잠긴다. 멤버 누구나 본다 — 숫자(한도·사용량)뿐이고 금액·결제 정보가 없다.
 *
 * `features.addressAliases` — 별칭 주소가 **이 조직에** 열려 있나(단계 공개 `ATMARK_ADDRESS_ALIASES_ENABLED`). 닫혀 있으면 콘솔이 요금제 표의
 * 별칭 행과 주소 탭의 `별칭 추가` 버튼을 숨긴다(추가 POST 의 404 와 같은 판정 — 목록·폐기는 닫혀도 된다, 보안 리뷰 L-4). 다른 조직의
 * 공개 여부는 싣지 않는다.
 *
 * `features.customDomains` — 설정의 `도메인` 메뉴를 보일까(ADR-0014 단계 4 M4). 기능 허용 목록(`org_features`)에 있거나, 목록에서 빠졌어도
 * 아직 제거하지 않은 도메인이 있으면 참이다(빠진 조직도 이미 만든 도메인을 보고 끊을 수 있어야 한다 — `ops/domains.ts` 목록 · 제거와 같은 이유).
 * 추가 · 지금 확인이 열려 있는지는 `GET /api/domains` 의 `enabled` 가 말한다. 멤버도 읽는다(보기 전용).
 */

import { rolloutAllows } from '../../runtime/feature-rollout';
import { sessionOf, type AdminCall } from '../context';
import { jsonResponse, type AdminResponse } from '../http';
import { customDomainsEnabled } from '../ops/domains';
import { planUsageOp } from '../ops/plan';

/** 이 조직에 설정의 `도메인` 메뉴를 보일까 — 허용 목록에 있거나, 제거하지 않은 도메인이 남아 있다. */
async function customDomainsVisible(call: AdminCall, organizationId: string): Promise<boolean> {
  if (await customDomainsEnabled(call.deps.pool, organizationId)) return true;
  const live = await call.deps.pool.query(`SELECT 1 FROM custom_domains WHERE organization_id = $1 AND status <> 'removed' LIMIT 1`, [organizationId]);
  return (live.rowCount ?? 0) > 0;
}

/** `GET /api/plan` */
export async function handlePlan(call: AdminCall): Promise<AdminResponse> {
  const session = sessionOf(call);
  const view = await planUsageOp(call.deps.pool, session.organizationId, call.deps.now());
  return jsonResponse(200, {
    ...view,
    features: {
      addressAliases: rolloutAllows(call.deps.features?.addressAliases ?? false, session.organizationId),
      customDomains: await customDomainsVisible(call, session.organizationId),
    },
  });
}
