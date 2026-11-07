/**
 * src/runtime/feature-rollout.ts — **단계 공개 기능 플래그**(메일 기본기 2차 — 별칭 주소 · 발신 첨부, 런북 deploy §23-2 7단계).
 *
 * 값 세 모양:
 *   - `false`(또는 없음·빈 값) — 꺼짐.
 *   - `true` — 모든 조직.
 *   - `orgs:<uuid>[,<uuid>…]` — 적힌 조직만(테스트 조직부터 연다). uuid 는 8-4-4-4-12 hex(대소문자 무관 — 소문자로 맞춘다), 최대
 *     `MAX_ROLLOUT_ORGANIZATIONS` 개. 빈 칸·중복 쉼표·모양이 틀린 id 가 하나라도 있으면 **전체가 무효**다.
 *
 * **무효 값은 꺼짐이다(fail closed)** — 읽는 쪽(`config.ts` `readFeatureRollout`)이 기동 경고 한 줄을 남긴다. 결제 스위치처럼 기동을 거부하지
 * 않는 이유: 이 플래그는 새 기능을 **여는** 쪽이라 틀린 값이 여는 것보다 닫는 것이 언제나 안전하고, 기동 거부는 기존 표면까지 멈춘다.
 * CDK 합성(`infra/cdk/stacks/compute-stack.ts` `featureRolloutOf`)은 같은 파서로 **합성을 거부**한다 — 틀린 값은 배포 전에 멈춘다.
 *
 * 순수 모듈 — 아무것도 import 하지 않는다(admin · api · infra 가 함께 쓴다).
 */

/** `false` 꺼짐 · `true` 전체 · `{organizations}` 적힌 조직만. */
export type FeatureRollout = boolean | { readonly organizations: ReadonlySet<string> };

export const ROLLOUT_ORGS_PREFIX = 'orgs:';

/** 허용목록 상한 — Lambda 환경 변수 총량(4 KB)을 이 플래그 둘이 잡아먹지 않게. 넘기면 `true` 로 굳힐 때다. */
export const MAX_ROLLOUT_ORGANIZATIONS = 20;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type FeatureRolloutParse =
  | { readonly ok: true; readonly rollout: FeatureRollout; readonly canonical: string }
  | { readonly ok: false; readonly reason: 'not_a_rollout_value' | 'empty_allowlist' | 'invalid_organization_id' | 'too_many_organizations' };

/** 문자열 → 단계 공개 값. `canonical` 은 환경 변수에 싣는 정규형(`false` · `true` · `orgs:<소문자 uuid>,…` 정렬 · 중복 제거). */
export function parseFeatureRollout(raw: string): FeatureRolloutParse {
  const value = raw.trim();
  if (value === '' || value === 'false') return { ok: true, rollout: false, canonical: 'false' };
  if (value === 'true') return { ok: true, rollout: true, canonical: 'true' };
  if (!value.startsWith(ROLLOUT_ORGS_PREFIX)) return { ok: false, reason: 'not_a_rollout_value' };
  const list = value.slice(ROLLOUT_ORGS_PREFIX.length);
  if (list.trim() === '') return { ok: false, reason: 'empty_allowlist' };
  const ids = list.split(',').map((item) => item.trim().toLowerCase());
  if (ids.some((id) => !UUID.test(id))) return { ok: false, reason: 'invalid_organization_id' };
  const organizations = new Set(ids);
  if (organizations.size > MAX_ROLLOUT_ORGANIZATIONS) return { ok: false, reason: 'too_many_organizations' };
  return { ok: true, rollout: { organizations }, canonical: `${ROLLOUT_ORGS_PREFIX}${[...organizations].sort().join(',')}` };
}

/** 이 조직에 열려 있나. 조직을 모르면(`null`) 허용목록 모드에서는 닫힌다. */
export function rolloutAllows(rollout: FeatureRollout, organizationId: string | null): boolean {
  if (typeof rollout === 'boolean') return rollout;
  return organizationId !== null && rollout.organizations.has(organizationId.toLowerCase());
}
