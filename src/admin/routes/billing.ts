/**
 * src/admin/routes/billing.ts — 콘솔 결제(WP-2, 계획 §3-8): `GET /api/billing`(member) · `POST /api/billing/checkout`(admin 이상) ·
 * `POST /api/billing/portal`(admin 이상). 역할은 라우트 표가 먼저 막고(member → 403 `forbidden_role`), 연산이 한 번 더 본다.
 *
 * **메일을 보내지 않는다** — 체크아웃은 Paddle 거래 하나와 `billing_checkouts` 한 행 + 감사 1행, 포털은 Paddle 세션 하나 + 감사 1행이다
 * (관문·전송단 import 없음 — Layer C `NON_SENDING_ENTRYPOINTS`). 공급자 실패와 "우리 결제 페이지가 아닌 URL" 은 502 `billing_provider_error`.
 * 포털 URL 은 응답으로만 나간다(저장·로그 없음).
 */

import { objectBody, recordOwnerAction, sessionOf, type AdminCall } from '../context';
import { errorResponse, jsonResponse, type AdminResponse } from '../http';
import { billingOverviewOp, BillingProviderFailure, createCheckoutOp, createPortalOp } from '../ops/billing';
import { pageLang } from './pages';

function providerFailure(error: unknown): AdminResponse {
  if (error instanceof BillingProviderFailure) return errorResponse(502, error.code, '결제 서비스가 응답하지 않았거나 예상 밖의 응답이다.');
  throw error;
}

/** `GET /api/billing` */
export async function handleBillingOverview(call: AdminCall): Promise<AdminResponse> {
  const session = sessionOf(call);
  return jsonResponse(200, await billingOverviewOp(call.deps.pool, call.deps.billing, session, call.deps.now()));
}

/** `POST /api/billing/checkout {plan}` → `{url, reused}` */
export async function handleBillingCheckout(call: AdminCall): Promise<AdminResponse> {
  const session = sessionOf(call);
  const body = objectBody(call.request.body);
  try {
    const result = await createCheckoutOp(
      call.deps.pool,
      call.deps.billing,
      {
        organizationId: session.organizationId,
        userId: session.userId,
        role: session.role,
        plan: body['plan'],
        lang: pageLang(call),
        audit: (tx, checkoutId) => recordOwnerAction(tx, session, 'billing.checkout', checkoutId),
      },
      call.deps.now(),
    );
    return jsonResponse(200, result);
  } catch (error) {
    return providerFailure(error);
  }
}

/** `POST /api/billing/portal` → `{url}` */
export async function handleBillingPortal(call: AdminCall): Promise<AdminResponse> {
  const session = sessionOf(call);
  try {
    const result = await createPortalOp(call.deps.pool, call.deps.billing, session);
    await recordOwnerAction(call.deps.pool, session, 'billing.portal', null);
    return jsonResponse(200, result);
  } catch (error) {
    return providerFailure(error);
  }
}
