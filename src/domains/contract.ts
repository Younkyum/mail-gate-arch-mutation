/**
 * src/domains/contract.ts — **고객 도메인 계약**(ADR-0014).
 *
 * 여기 있는 것:
 *   - 상태·사유·사가 단계의 **닫힌 유니온**(DB CHECK 와 같은 값 — `test/integration/db/custom-domains-triggers.test.ts` 가 대조한다).
 *   - DNS·MX 판정 코드, `domain-control` Lambda 의 요청/응답 판별 유니온과 호출 **포트**(`DomainControlInvoker`).
 *   - 주기 작업 예산(P/R)·타임아웃·시계 상수, SES identity policy 한도, 평판 동결 임계(J6), 알림 종류, 로그 지표 이름, API 오류 코드.
 *   - 관문이 읽는 도메인 상태 접기(`domainGateStatusOf`) — 순수 함수.
 *
 * **주소 행은 v1 그대로 별칭만**(진윤겸 2026-09-29): 고객 도메인 주소 행은 언제나 별칭(`is_primary = false`)이고 `is_primary` 는 `@atmark.ai`
 * **앵커**다(DB 가드 P0A06). **2026-10 개정(진윤겸 결정 2 — 포인터 모델)**: "대표 주소" 는 `agent_primary_changes` 의 마지막 선택이고
 * `effectivePrimaryOf`(= SQL `atmark_agent_primary_address`)가 판정한다 — 고객 도메인 별칭도 대표가 될 수 있다(아래 "대표 주소" 절).
 */

// ---------------------------------------------------------------------------
// 상태 기계(§3.3) — DB `custom_domains` CHECK 와 같은 값
// ---------------------------------------------------------------------------

export const CUSTOM_DOMAIN_STATUSES = ['pending', 'verifying', 'verified', 'suspended', 'removed'] as const;
export type CustomDomainStatus = (typeof CUSTOM_DOMAIN_STATUSES)[number];

/**
 * 정지 사유 — `status = 'suspended'` ⇔ 사유 NOT NULL(DB CHECK).
 *   - `ownership_lost` · `dkim_failed` — 확정 실패 2회 연속(자동 복귀 있음). 수신도 거부.
 *   - `reputation` · `operator` — 사람만 푼다(`pnpm admin:domain --unfreeze`). 수신은 받는다.
 *   - `plan_limit` — 요금제 강등(업그레이드로 자동 복귀). 관문은 transient(`domain_plan_limit`), 수신은 받는다, 여권은 true 유지.
 */
export const CUSTOM_DOMAIN_SUSPENDED_REASONS = ['ownership_lost', 'dkim_failed', 'reputation', 'operator', 'plan_limit'] as const;
export type CustomDomainSuspendedReason = (typeof CUSTOM_DOMAIN_SUSPENDED_REASONS)[number];

/**
 * 정지 사유의 **세기**(보안 리뷰 M3 · 계획 critic 2) — suspended 안에서 사유는 **세지는 쪽으로만** 바뀐다(소유자 롤 = 운영자 CLI 는 예외).
 * `reputation`·`operator` 정지는 **소유자 롤만** 푼다(틱은 verified 로 되돌리지 못한다). DB `custom_domains_transition_guard` 와 같은 표.
 */
export const CUSTOM_DOMAIN_SUSPENSION_STRENGTH: Readonly<Record<CustomDomainSuspendedReason, number>> = {
  plan_limit: 1,
  dkim_failed: 2,
  ownership_lost: 3,
  reputation: 4,
  operator: 5,
};
/** 소유자 롤(운영자 CLI `pnpm admin:domain --unfreeze`)만 푸는 사유. */
export const OWNER_ONLY_LIFT_REASONS = ['reputation', 'operator'] as const satisfies readonly CustomDomainSuspendedReason[];

/** 허용 전이(DB 트리거 `custom_domains_transition_guard` 와 같다). `removed` 는 종착. */
export const CUSTOM_DOMAIN_TRANSITIONS: Readonly<Record<CustomDomainStatus, readonly CustomDomainStatus[]>> = {
  pending: ['verifying', 'removed'],
  verifying: ['verified', 'removed'],
  verified: ['suspended', 'removed'],
  suspended: ['verified', 'removed'],
  removed: [],
};

/** pending 에 머무는 이유(콘솔 표시). `null` = 소유 증명 TXT 를 기다린다. */
export const CUSTOM_DOMAIN_PENDING_REASONS = [
  /** 서브도메인 MX 가 SES 가 아닌 곳을 가리킨다 — 사람 메일이 있는 서브도메인은 v1 에서 받지 않는다(H3). */
  'subdomain_has_mail',
  /**
   * 같은 apex 를 다른 조직이 쥐고 있다(양도 조건 불충족). 콘솔 문구는 **다른 조직을 밝히지 않고** "이 apex 에 남아 있는 다른
   * `_atmark-challenge` TXT 레코드를 지우세요 — 그래도 안 되면 운영자에게 문의" 를 한·영으로 말한다(단계 4).
   */
  'registrable_taken',
] as const;
export type CustomDomainPendingReason = (typeof CUSTOM_DOMAIN_PENDING_REASONS)[number];

/** 생성 사가(verifying, 멱등 — 한 단계씩 커밋). */
export const CUSTOM_DOMAIN_SAGA_STEPS = ['none', 'identity', 'mail_from', 'config_set', 'policy', 'done'] as const;
export type CustomDomainSagaStep = (typeof CUSTOM_DOMAIN_SAGA_STEPS)[number];

/** 제거 사가(removed) — 정책 → identity 순서. identity 를 가진 적 없는 행(pending 만료)은 SES 호출 0 으로 곧장 `done`. */
export const CUSTOM_DOMAIN_REMOVAL_STEPS = ['none', 'policy', 'identity', 'done'] as const;
export type CustomDomainRemovalStep = (typeof CUSTOM_DOMAIN_REMOVAL_STEPS)[number];

/** SES `DkimAttributes.Status` · MAIL FROM 상태를 옮긴 값(`unknown` = 아직 읽지 않았다). */
export const CUSTOM_DOMAIN_SES_STATUSES = ['unknown', 'not_started', 'pending', 'success', 'failed', 'temporary_failure'] as const;
export type CustomDomainSesStatus = (typeof CUSTOM_DOMAIN_SES_STATUSES)[number];

/** 서브도메인 MX 판정의 **기록값**(`error` 는 기록하지 않는다 — 상태를 바꾸지 않는 인프라 오류). */
export const INBOUND_MX_STATUSES = ['unknown', 'missing', 'ses', 'other'] as const;
export type InboundMxStatus = (typeof INBOUND_MX_STATUSES)[number];

/** 기능 허용 목록(`org_features.feature` CHECK). 운영자 CLI(`pnpm admin:feature`)만 쓴다. 기본 비어 있음(M13). */
export const CUSTOM_DOMAINS_FEATURE = 'custom_domains';

/**
 * 고객 도메인 길이 상한(보안·critic 4) — 253 이 아니라 **100**. 도메인이 길수록 identity policy 하나에 들어가는 주소가 줄어(아래
 * `customDomainAddressCeiling`) 발급 천장이 무너진다. DB CHECK(`custom_domains_domain_shape`)와 같다.
 */
export const CUSTOM_DOMAIN_MAX_LENGTH = 100;

/**
 * 틱 DB 롤(보안 리뷰 M2) — 상태·확인 칸(status · txt_verified_at · verified_at · suspended_* · 사가 칸 …)은 **이 롤만** 고친다. admin(콘솔·
 * 조직 API)은 행 만들기 · 수동 확인 칸 · 제거 요청(`removal_requested_at`)만.
 */
export const DOMAIN_TICK_ROLE = 'atmark_domain_tick';
/**
 * 틱 롤의 `CONNECTION LIMIT`(#13 보안 리뷰 L4) — 틱 풀 크기(1)와 같다. 연결 예산(73/75)을 DB 가 집행하고, Scheduler 가 같은 과제를 겹쳐 보내도(재시도 ·
 * 중복 전달) 두 번째 틱은 연결을 얻지 못해 실패한다 — 틱끼리의 상호 배제를 겸한다(다음 틱이 잇는다). `bootstrap-roles` 가 걸고 migrate status 가 본다.
 */
export const DOMAIN_TICK_ROLE_CONNECTION_LIMIT = 1;

// ---------------------------------------------------------------------------
// DNS 판정(§3.3 M11·M12) — domain-control 이 낸다
// ---------------------------------------------------------------------------

/**
 * 소유 증명 TXT 판정(2026-10 one-shot · ADR-0014 결정 2 개정 — 진윤겸 (b) 승인). 이름 둘의 **OR**: 서브도메인 `_atmark-challenge.<domain>`(기본 ·
 * 콘솔·존 파일·Domain Connect 가 보여 주는 하나) 또는 apex `_atmark-challenge.<registrable>`(기존 행 호환).
 * 이름 하나의 판정: `present` = **모든 권한 NS** 가 정확한 토큰을 돌려줌 · `absent` = 모든 NS 가 NXDOMAIN/NODATA 또는 토큰 없음(확정) · 그 밖(일부 NS 만
 * 응답 · SERVFAIL · 타임아웃 · NS 조회 실패 · CNAME 답)은 `error`.
 * 두 이름의 합: 하나라도 `present` → `present` · 둘 다 `absent` → `absent` · 그 밖 `error` — **소유권 상실로 세지 않는다**(원칙 3). 재확인 · 양도의
 * "옛 토큰 부재" 도 같은 합(양쪽 다 없어야 부재). `combineChallengeVerdicts` 가 그 표다.
 */
export type DnsVerdict = 'present' | 'absent' | 'error';

/** 서브도메인 MX 판정. `missing` = MX 없음, `ses` = SES 수신 엔드포인트만, `other` = 다른 곳(사람 메일), `error` = 확정 못 함. */
export type MxVerdict = 'missing' | 'ses' | 'other' | 'error';

/** SES 수신 엔드포인트(ap-northeast-2 고정, N3). */
export const SES_INBOUND_MX_HOST = 'inbound-smtp.ap-northeast-2.amazonaws.com';
/** 커스텀 MAIL FROM 의 MX 값 호스트. */
export const SES_MAIL_FROM_MX_HOST = 'feedback-smtp.ap-northeast-2.amazonses.com';
/** 소유 증명 레코드 이름의 앞머리 — 기본은 서브도메인 아래(`_atmark-challenge.<domain>`), apex(`_atmark-challenge.<registrable>`)도 인정한다. */
export const CHALLENGE_RECORD_PREFIX = '_atmark-challenge';
/** 소유 증명 TXT 값의 앞머리(`atmark-domain-verification=<token>`). */
export const CHALLENGE_VALUE_PREFIX = 'atmark-domain-verification=';
/** 커스텀 MAIL FROM 하위 도메인 라벨(`bounce.<sub>`). */
export const MAIL_FROM_LABEL = 'bounce';
/** 도전 토큰 모양 — 32바이트 base64url(43자). DB CHECK 와 같다. */
export const CHALLENGE_TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** 보여 주는 소유 증명 이름(기본) — 서브도메인 아래. */
export function challengeRecordName(domain: string): string {
  return `${CHALLENGE_RECORD_PREFIX}.${domain}`;
}

/** 인정하는 소유 증명 이름 전부 — [서브도메인, apex]. apex 도메인 자체를 등록했으면(domain = registrable) 하나. 순수 — domain-control 이 이 순서로 묻는다. */
export function challengeRecordNames(domain: string, registrable: string): readonly string[] {
  return domain === registrable ? [challengeRecordName(domain)] : [challengeRecordName(domain), challengeRecordName(registrable)];
}

/** 이름별 판정의 합(위 `DnsVerdict` 주석의 표). 빈 목록은 `error`(묻지 못했다). */
export function combineChallengeVerdicts(verdicts: readonly DnsVerdict[]): DnsVerdict {
  if (verdicts.includes('present')) return 'present';
  if (verdicts.length > 0 && verdicts.every((verdict) => verdict === 'absent')) return 'absent';
  return 'error';
}

/**
 * DMARC 권장 레코드(2026-10-06 진윤겸 결정 — 운영 e2e 에서 SPF·DKIM 은 통과했지만 DMARC 레코드가 없어 Gmail 이 DMARC fail 로 봤다.
 * Gmail·Yahoo 는 대량 발신자에게 DMARC 를 요구한다). 이름 `_dmarc.<domain>`, 값은 최소(`p=none`) — **`rua=` 를 넣지 않는다**:
 * 우리는 고객 도메인의 집계 리포트 메일함을 운영하지 않고, 남의 주소를 rua 로 적으면 외부 도메인 인가(`_report._dmarc`)도 필요하다.
 * **확인 · 상태와 무관하다** — 수명주기(`lifecycle.ts` · `dns-lookup.ts`)는 이 레코드를 묻지 않는다(`DNS_RECORD_REQUIRED` 가 false).
 */
export const DMARC_RECORD_LABEL = '_dmarc';
export const DMARC_RECOMMENDED_VALUE = 'v=DMARC1; p=none';

export type DnsRecordPurpose = 'ownership' | 'dkim' | 'mail_from_mx' | 'mail_from_spf' | 'inbound_mx' | 'dmarc';

/** 목적별 "확인에 필요한가" — false 는 권장(콘솔이 상태 대신 '권장' 을 보인다 · 확인 · 상태 기계는 보지 않는다). */
export const DNS_RECORD_REQUIRED: Readonly<Record<DnsRecordPurpose, boolean>> = {
  ownership: true,
  inbound_mx: true,
  mail_from_mx: true,
  mail_from_spf: true,
  dkim: true,
  dmarc: false,
};

/** 콘솔·안내 화면이 보여 주는 레코드 하나. 값은 텍스트 노드로만 그린다(CSP). `required:false` = 권장(확인과 무관). */
export interface DnsRecordSpec {
  readonly purpose: DnsRecordPurpose;
  readonly type: 'TXT' | 'CNAME' | 'MX';
  readonly name: string;
  readonly value: string;
  readonly required: boolean;
}

/**
 * 도메인 하나가 요구하는 레코드 전부(2026-10 one-shot) — 순서는 **소유 TXT → 수신 MX → MAIL FROM MX · SPF → DKIM CNAME → DMARC TXT(권장)**(존 파일 ·
 * 표 · Domain Connect 템플릿과 같은 순서). DMARC 는 `required:false` — 확인에 쓰지 않는다(위 `DMARC_RECOMMENDED_VALUE`). 소유 TXT 는 **서브도메인 이름 하나**(`challengeRecordName`)만 보여 준다 — apex 는 인정만 한다(`challengeRecordNames`).
 * `dkimTokens` 는 SES 가 준 셋(identity 를 아직 못 만들었으면 빈 배열 — DKIM 줄 없음. one-shot 에서는 추가 직후 `provisionDomainNow` 가 채운다).
 * 순수 함수 — 콘솔과 domain-control 이 같은 값을 쓴다.
 */
export function dnsRecordsFor(domain: string, challengeToken: string, dkimTokens: readonly string[]): readonly DnsRecordSpec[] {
  const spec = (purpose: DnsRecordPurpose, type: DnsRecordSpec['type'], name: string, value: string): DnsRecordSpec => ({
    purpose,
    type,
    name,
    value,
    required: DNS_RECORD_REQUIRED[purpose],
  });
  return [
    spec('ownership', 'TXT', challengeRecordName(domain), `${CHALLENGE_VALUE_PREFIX}${challengeToken}`),
    spec('inbound_mx', 'MX', domain, `10 ${SES_INBOUND_MX_HOST}`),
    spec('mail_from_mx', 'MX', `${MAIL_FROM_LABEL}.${domain}`, `10 ${SES_MAIL_FROM_MX_HOST}`),
    spec('mail_from_spf', 'TXT', `${MAIL_FROM_LABEL}.${domain}`, 'v=spf1 include:amazonses.com ~all'),
    ...dkimTokens.map((token) => spec('dkim', 'CNAME', `${token}._domainkey.${domain}`, `${token}.dkim.amazonses.com`)),
    spec('dmarc', 'TXT', `${DMARC_RECORD_LABEL}.${domain}`, DMARC_RECOMMENDED_VALUE),
  ];
}

// ---------------------------------------------------------------------------
// domain-control Lambda(§3.5 C1) — 요청/응답 판별 유니온 · 호출 포트
// ---------------------------------------------------------------------------

/** 배치 한 건의 공통 칸. **Principal 은 입력에 없다** — 발송 역할 ARN 은 domain-control 의 배포 환경변수(`SENDER_ROLE_ARN`)로만 조립한다. */
interface DomainControlBase {
  /** `custom_domains.id`. identity 태그 `atmark:row` 와 대조한다(변형 호출 전, H1 ②). */
  readonly rowId: string;
  readonly domain: string;
  readonly registrable: string;
}

export type DomainControlRequest =
  /** 소유 TXT(토큰 — `challengeRecordNames(domain, registrable)` 의 OR, `combineChallengeVerdicts`) + 서브도메인 MX 판정. SES 호출 없음. */
  | (DomainControlBase & { readonly op: 'check'; readonly token: string })
  /**
   * 생성 사가의 다음 단계 하나(멱등). `supersededRowId` = **채택해도 되는 직전 관리자 행**(없으면 null) — 2026-10 one-shot 에서 뜻을 넓혔다: 양도의 옛 행뿐
   * 아니라 선점 인수 · 넘겨주기로 identity 관리권을 이 행에 넘긴 행(`identity_handover_to = 이 행`). 틱은 DB 조회 `adoptableRowFor` 로만 채우고
   * domain-control 은 그 값을 믿고 태그를 이 행으로 바꾼다. **와이어 이름은 그대로**(엄격 파싱 — 이름을 바꾸면 배포 중 엇갈린다).
   * pending 행은 `identity` · `mail_from` · `config_set` 까지만 받는다(`policy` 는 verifying 에서만 — `PENDING_SAGA_LAST_STEP`).
   */
  | (DomainControlBase & { readonly op: 'saga_step'; readonly step: Exclude<CustomDomainSagaStep, 'none' | 'done'>; readonly supersededRowId: string | null })
  /** 제거 사가의 다음 단계 하나(멱등). 태그가 이 행이 아니면 SES 호출 0. */
  | (DomainControlBase & { readonly op: 'remove_step'; readonly step: Exclude<CustomDomainRemovalStep, 'none' | 'done'> })
  /**
   * I2+ 정책 동기화. `addresses` 는 그 도메인에서 **이 행의 조직(`custom_domains.organization_id`)이 가진** 살아 있는 발급 주소뿐이다(옛 조직의
   * 주소는 넣지 않는다 — critic minor 4). 모두 `@<domain>` · 로컬파트 문법 · 전역 예약 통과 · 수 ≤ `customDomainAddressCeiling(domain)` —
   * 어기면 domain-control 이 거부(`rejected_input`). 빈 배열 = 정책 삭제(발신 불가 상태). 정지·제거면 틱이 빈 배열을 보낸다.
   * 조립은 `identityPolicyChunks` 가 정한 대로다. 20개를 넘기면(`too_large`) **기존 정책을 그대로 두고**(지우지도 줄이지도 않는다) `too_large` 를
   * 돌려준다 — 틱은 `policy_sync_requested_at` 을 남기고 로그 `domain.policy_too_large` 를 낸다(알람). 발급 쪽이 천장으로 먼저 막으므로 정상
   * 경로에서는 나지 않는다.
   */
  | (DomainControlBase & { readonly op: 'sync_policy'; readonly addresses: readonly string[] })
  /** 정책 감사 — 기대 다이제스트와 SES 원문 정규화 다이제스트 비교. drift 면 기대 정책으로 덮어쓰고 `drift` 를 돌려준다. */
  | (DomainControlBase & { readonly op: 'audit_policy'; readonly addresses: readonly string[]; readonly expectedDigest: string | null })
  /** 등록 가능 apex 의 RDAP 만료일(24시간에 한 번, §3.13). 등록자 정보는 읽지도 싣지도 않는다. */
  | (DomainControlBase & { readonly op: 'check_expiry' })
  /**
   * **읽기 전용** identity 들여다보기(2026-10 one-shot) — `GetEmailIdentity` 하나, 태그 무관 · SES 변형 0. pending 행이 DKIM 레코드를 곧바로
   * 보여 주게 한다(관리자 행 = 상태 표시 · 관리자 아닌 행 = 토큰만). `identity_owned_elsewhere` 지표를 올리지 않는다.
   */
  | (DomainControlBase & { readonly op: 'peek_identity' });

export type DomainControlOp = DomainControlRequest['op'];
export const DOMAIN_CONTROL_OPS = [
  'check',
  'saga_step',
  'remove_step',
  'sync_policy',
  'audit_policy',
  'check_expiry',
  'peek_identity',
] as const satisfies readonly DomainControlOp[];

/** pending 행의 생성 사가는 여기서 멈춘다 — `policy`(발신 권한) 단계는 verifying 에서만(소유 증명 뒤). */
export const PENDING_SAGA_LAST_STEP = 'config_set' as const satisfies CustomDomainSagaStep;

/**
 * 응답 — 판정 코드와 DKIM 토큰·상태만. **DNS 원문은 싣지 않는다.** 모든 결과에 `errorCode`(코드 모양 문자열 — SES 예외 이름 · `dns_timeout`
 * 같은 것, 값·도메인명 없음)가 있고 오류가 아니면 `null` 이다(critic minor 6).
 */
export type DomainControlResult =
  | { readonly op: 'check'; readonly rowId: string; readonly txt: DnsVerdict; readonly mx: MxVerdict; readonly errorCode: string | null }
  | {
      readonly op: 'saga_step';
      readonly rowId: string;
      /** `advanced` = 그 단계를 마쳤다 · `identity_owned_elsewhere` = 태그가 다른 행 — 중단·알람(운영자 판단) · `error` = 재시도. */
      readonly outcome: 'advanced' | 'identity_owned_elsewhere' | 'error';
      /**
       * `identity_owned_elsewhere` 일 때 identity 에 붙은 행 태그(다른 행 id, critic minor 5) — 틱은 그 행이 `removal_step = 'done'`(identity 를
       * 지웠다)이 될 때까지 기다리거나, 양도 관계(`superseded_by`)면 채택한다. 그 밖에는 `null`.
       */
      readonly ownerRowTag: string | null;
      readonly dkimTokens: readonly string[];
      readonly dkimStatus: CustomDomainSesStatus;
      readonly mailFromStatus: CustomDomainSesStatus;
      readonly policyDigest: string | null;
      readonly errorCode: string | null;
    }
  | { readonly op: 'remove_step'; readonly rowId: string; readonly outcome: 'advanced' | 'not_owner' | 'error'; readonly errorCode: string | null }
  | {
      readonly op: 'sync_policy';
      readonly rowId: string;
      readonly outcome: 'synced' | 'rejected_input' | 'too_large' | 'not_owner' | 'error';
      readonly policyDigest: string | null;
      readonly errorCode: string | null;
    }
  | {
      readonly op: 'audit_policy';
      readonly rowId: string;
      readonly outcome: 'clean' | 'drift' | 'not_owner' | 'error';
      readonly dkimStatus: CustomDomainSesStatus;
      readonly errorCode: string | null;
    }
  | {
      readonly op: 'check_expiry';
      readonly rowId: string;
      readonly outcome: 'ok' | 'unsupported' | 'error';
      readonly expiresAt: string | null;
      readonly errorCode: string | null;
    }
  | {
      readonly op: 'peek_identity';
      readonly rowId: string;
      /** `found` = identity 가 있다 · `absent` = 없다(NotFoundException) · `error` = 재시도(상태 불변). */
      readonly outcome: 'found' | 'absent' | 'error';
      /** identity 의 `atmark:row` 태그 = 이 행 id. 거짓이면 아래 상태 칸은 언제나 `unknown`(다른 행의 진행을 보여 주지 않는다). */
      readonly ownerIsRow: boolean;
      /** 공개 DNS 이름일 뿐(비밀 아님) — 관리자 아닌 행에도 싣는다. `found` 가 아니면 빈 배열. */
      readonly dkimTokens: readonly string[];
      readonly dkimStatus: CustomDomainSesStatus;
      readonly mailFromStatus: CustomDomainSesStatus;
      readonly errorCode: string | null;
    };

/**
 * domain-control 을 부르는 **포트**. 확인 틱만 쓴다(admin λ 안에서 틱 롤 풀로 돈다 — 그 λ 역할에는 이 함수 ARN 하나에 대한
 * `lambda:InvokeFunction` 만).
 * 배치 하나 = Lambda 호출 하나(안에서 병렬, DNS 2초 1회, 호출 타임아웃 `DOMAIN_CONTROL_INVOKE_TIMEOUT_MS`). 결과는 요청과 같은 순서·같은 길이다.
 */
export interface DomainControlInvoker {
  invoke(batch: readonly DomainControlRequest[]): Promise<readonly DomainControlResult[]>;
}

/** domain-control 이 조립되지 않았다(설정 누락). 틱은 이 오류로 아무것도 바꾸지 않고 끝난다(닫힌 쪽). */
export class DomainControlUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DomainControlUnavailableError';
  }
}

/**
 * **비활성 포트**(domain-control 이 조립되지 않았을 때) — 부르면 던진다. 빈 결과를 돌려주지 않는 이유는 `unavailablePolicySource` 와 같다:
 * 빈 결과가 "확인 성공" 이나 "정책 없음" 으로 읽힐 여지를 두지 않는다.
 */
export const unavailableDomainControlInvoker: DomainControlInvoker = {
  invoke(batch) {
    return Promise.reject(new DomainControlUnavailableError(`domain-control 이 조립되지 않았다(요청 ${String(batch.length)}건) — ADR-0014 단계 2`));
  },
};

// ---------------------------------------------------------------------------
// 주기 작업·시계(§3.3·§3.4 — 진윤겸 J1~J6)
// ---------------------------------------------------------------------------

/** 한 틱의 pending 예산 P(pending·verifying·사가 진행) — 2026-10 one-shot 에서 5 → 8(pending 행이 요청 2개 — 사가/`check` + `peek_identity`). */
export const DOMAIN_TICK_PENDING_BUDGET = 8;
/** 한 틱의 재확인 예산 R(verified·suspended 재확인 + 제거 사가 + 정책 감사 + 만료 확인). */
export const DOMAIN_TICK_RECHECK_BUDGET = 10;
/** 틱 주기(EventBridge Scheduler `atmark-domain-recheck`). */
export const DOMAIN_TICK_INTERVAL_MS = 10 * 60_000;
/** admin 쪽 틱 예산 — 넘으면 멈추고 다음 틱이 잇는다. */
export const DOMAIN_TICK_BUDGET_MS = 20_000;
/** DNS 질의 하나의 타임아웃(재시도 없음 = 시도 1회, M12). */
export const DNS_QUERY_TIMEOUT_MS = 2_000;
/** domain-control 호출 하나의 타임아웃(Lambda 타임아웃 12초 안). */
export const DOMAIN_CONTROL_INVOKE_TIMEOUT_MS = 10_000;

/** pending 확인 간격. */
export const PENDING_CHECK_INTERVAL_MS = 30 * 60_000;
/** pending 이 TXT present 가 되지 않으면 removed(SES 호출 0). verifying 이 DKIM SUCCESS 가 되지 않을 때도 같은 창. */
export const PENDING_EXPIRY_MS = 72 * 3_600_000;
/** verified·suspended 재확인 간격. */
export const RECHECK_INTERVAL_MS = 6 * 3_600_000;
/** 확정 실패 뒤 재확인까지. */
export const DEFINITIVE_FAILURE_RETRY_MS = 30 * 60_000;
/** 연속 확정 실패 이 횟수에서 suspended(ownership_lost | dkim_failed). */
export const SUSPEND_AFTER_DEFINITIVE_FAILURES = 2;
/** ownership_lost 정지 뒤 removed 까지(`removal_due_at`). */
export const OWNERSHIP_LOST_REMOVAL_MS = 14 * 24 * 3_600_000;
/** 제거 예고 알림 — removal_due_at 의 며칠 전. */
export const REMOVAL_NOTICE_DAYS_BEFORE = 3;
/** 수동 확인 레이트 리밋 — 같은 도메인 60초에 1회 · 조직 시간당 20회(넘으면 429). */
export const MANUAL_CHECK_MIN_INTERVAL_MS = 60_000;
export const MANUAL_CHECKS_PER_ORG_PER_HOUR = 20;
/** RDAP 만료 확인 간격(등록 가능 apex 마다) · 예고 알림 날짜. 만료는 두 번 관측 · 하루 경과로 확정한다(`RDAP_EXPIRY_GRACE_MS`). */
export const EXPIRY_CHECK_INTERVAL_MS = 24 * 3_600_000;
export const EXPIRY_WARNING_DAYS = [30, 7] as const;
/**
 * RDAP 만료의 확정(#13 보안 리뷰 L1 · 리드 결정 2026-10) — ownership_lost 는 별칭을 되돌릴 수 없이 폐기하므로, 만료는 **서로 다른 틱에서 두 번** 관측하고
 * 만료일이 **이만큼 지났을 때만** 인정한다(갱신 반영 지연 · RDAP 한 번의 오답). 그 전에는 예고 알림만.
 */
export const RDAP_EXPIRY_GRACE_MS = 24 * 3_600_000;
/** 밀린 확인(next_check_at 이 이만큼 지난 행) — 0 보다 크게 1시간 지속되면 `atmark-domain-check-stale`(결측 = 위반). */
export const DUE_BACKLOG_STALE_AFTER_MS = 3_600_000;

// ---------------------------------------------------------------------------
// identity 관리자(steward) · 즉시 실행(2026-10 one-shot — 마이그레이션 202610061000~1002)
// ---------------------------------------------------------------------------

/**
 * 도메인당 **identity 관리자 하나**(DB 부분 UNIQUE `custom_domains_identity_claim_key`). 행의 세 칸으로 정한다:
 *   - `steward` — `identity_claimed_at` 있음 · `identity_released_at` 없음 · `identity_deleted_at` 없음(SES identity 를 만들거나 채택할 권리).
 *   - `released` — 관리권을 놓았다(`identity_handover_to` = 넘겨받은 행 · 없으면 identity 를 지웠다).
 *   - `none` — 클레임한 적 없음(pending 이 아직 클레임 전 · 다른 행이 관리 중 · 옛 행).
 * verifying · verified · suspended 행은 언제나 `steward` 다(CHECK `custom_domains_steward_shape`).
 */
export type DomainIdentityStewardship = 'steward' | 'released' | 'none';

export interface DomainStewardFacts {
  readonly identityClaimedAt: Date | null;
  readonly identityReleasedAt: Date | null;
  readonly identityDeletedAt: Date | null;
}

export function identityStewardshipOf(facts: DomainStewardFacts): DomainIdentityStewardship {
  if (facts.identityClaimedAt === null) return 'none';
  if (facts.identityReleasedAt !== null || facts.identityDeletedAt !== null) return 'released';
  return 'steward';
}

/**
 * **즉시 실행** — 도메인을 추가한 admin λ 호출 안에서(커밋 뒤 · 최선 노력) 그 행 하나에 대해 클레임 + `saga_step(identity)` 를 **틱 롤 풀**로 돈다.
 * 입력은 행 id 하나뿐이고 판단은 전부 틱 코드가 DB 에서 다시 읽는다(결정 12 — 콘솔 SQL 경로는 상태 칸을 못 바꾼다).
 *   - `provisioned` — DKIM 토큰이 행에 들어갔다(관리자 · identity 만듦/채택).
 *   - `peeked` — 다른 행이 관리 중 — 토큰만 들여다봐 행에 적었다.
 *   - `waiting` — 클레임할 수 없다(같은 apex 를 다른 조직이 쥠 → `registrable_taken`) · 또는 SES 가 아직 토큰을 주지 않았다. 예약 틱이 잇는다.
 *   - `busy` — 틱 롤 연결 상한(`CONNECTION LIMIT 1`, SQLSTATE 53300 — 예약 틱과 겹침) · 예산 초과. 예약 틱이 잇는다.
 *   - `skipped` — 행이 없거나 pending 이 아니다.
 *   - `unavailable` — domain-control 이 조립되지 않았거나 계약 밖 결과. 아무것도 바꾸지 않았다.
 * **던지지 않는다**(호출자는 추가 응답을 이미 정했다) — 예상 밖 오류도 `unavailable` 로 접고 로그만 남긴다.
 */
export type ProvisionDomainOutcome = 'provisioned' | 'peeked' | 'waiting' | 'busy' | 'skipped' | 'unavailable';

/** 즉시 실행 포트 — admin 조립(`src/admin/ops/domains.ts` 의 추가 경로)이 부른다. 구현은 `src/domains/lifecycle.ts` `provisionDomainNow`. */
export type ProvisionDomainNow = (rowId: string) => Promise<ProvisionDomainOutcome>;

/** 즉시 실행의 예산(ms) — domain-control 호출 하나(`DOMAIN_CONTROL_INVOKE_TIMEOUT_MS` 안). */
export const PROVISION_NOW_BUDGET_MS = 8_000;
/** 즉시 실행 뒤 콘솔이 상세를 다시 읽는 간격 · 상한(그 뒤엔 "DKIM 준비 중 — 몇 분 안에 나타납니다"). */
export const PROVISION_POLL_INTERVAL_MS = 2_000;
export const PROVISION_POLL_MAX_MS = 30_000;
/** 활성 identity 관리자 수(`domain.identities_held`) 알람 임계 — SES 리전 identity 할당량 10,000 의 10%. */
export const IDENTITIES_HELD_ALARM_THRESHOLD = 1_000;

// ---------------------------------------------------------------------------
// SES identity policy(I2+ — 스파이크 S1 실측 2026-09-29)
// ---------------------------------------------------------------------------

/** identity policy 하나의 크기 상한(바이트) — S1 ⑥: 4,000 통과 · 4,412 거부. 조립기는 **주소 수가 아니라 바이트로** 채운다. */
export const SES_IDENTITY_POLICY_MAX_BYTES = 4_000;
/** identity 하나의 정책 수 상한 — S1 ⑦: 21번째 LimitExceeded. 이 수를 넘기는 발급은 거부한다. */
export const SES_IDENTITY_POLICIES_MAX = 20;
/** 도메인 하나당 살아 있는 발급 주소의 **절대 천장**(진윤겸 J1). 실제 천장은 도메인 길이에 따라 더 낮다(`customDomainAddressCeiling`). */
export const CUSTOM_DOMAIN_ADDRESS_CEILING = 1_000;
/**
 * 발송 역할 ARN 길이 예산 — domain-control 은 이보다 긴 `SENDER_ROLE_ARN` 으로 기동하지 않는다(단계 2). 실제 값
 * `arn:aws:iam::<12>:role/atmark-runtime-sender` 는 52자다.
 */
export const SENDER_ROLE_ARN_MAX_LENGTH = 128;
/** AWS 계정 id 길이(12자리). */
export const AWS_ACCOUNT_ID_LENGTH = 12;
/** 주소 목록이 빈 정책 문서에서 ARN · 계정 · 도메인을 뺀 바이트(실측 — `identityPolicyDocument` 가 만든다, 단위 테스트가 대조). */
export const IDENTITY_POLICY_FRAME_BYTES = 258;
/** 로컬파트 최대 길이(RFC 5321 — `AGENT_LOCAL_PART_MAX_LENGTH` 와 같다). 천장은 가장 긴 로컬파트를 기준으로 셈한다. */
const WORST_LOCAL_PART_LENGTH = 64;

/** 발송 역할에 붙는 identity policy 의 고정 칸. */
export interface IdentityPolicyFrame {
  readonly senderRoleArn: string;
  readonly accountId: string;
  readonly domain: string;
}

/**
 * identity policy 문서 하나(I2+ — 계획 §3.5). **압축 JSON** 이고 키 순서가 고정이다 — 바이트 수가 곧 SES 의 정책 크기다. 순수 함수 —
 * domain-control(조립)과 감사(정규화 다이제스트)가 같은 문서를 만든다.
 */
export function identityPolicyDocument(frame: IdentityPolicyFrame, addresses: readonly string[]): string {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'AtmarkAgentAddresses',
        Effect: 'Allow',
        Principal: { AWS: frame.senderRoleArn },
        Action: ['ses:SendEmail', 'ses:SendRawEmail'],
        Resource: `arn:aws:ses:ap-northeast-2:${frame.accountId}:identity/${frame.domain}`,
        Condition: { StringEquals: { 'ses:FromAddress': [...addresses] } },
      },
    ],
  });
}

/**
 * 주소를 정책 여러 개로 나눈다 — 정렬한 주소를 앞에서부터 **바이트로** 채운다(문서 하나 ≤ 4,000바이트). 정책이 20개를 넘으면 `too_large`
 * (그때 domain-control 은 기존 정책을 건드리지 않는다). 빈 목록 = 정책 0개(발신 불가). 같은 입력이면 같은 결과(순서 무관).
 */
export function identityPolicyChunks(
  frame: IdentityPolicyFrame,
  addresses: readonly string[],
): { readonly kind: 'ok'; readonly chunks: readonly (readonly string[])[] } | { readonly kind: 'too_large' } {
  const sorted = [...new Set(addresses)].sort();
  const chunks: string[][] = [];
  let current: string[] = [];
  for (const address of sorted) {
    const candidate = [...current, address];
    if (Buffer.byteLength(identityPolicyDocument(frame, candidate), 'utf8') <= SES_IDENTITY_POLICY_MAX_BYTES) {
      current = candidate;
      continue;
    }
    if (current.length === 0) return { kind: 'too_large' }; // 주소 하나도 들어가지 않는다(길이 상한 밖의 입력).
    chunks.push(current);
    current = [address];
  }
  if (current.length > 0) chunks.push(current);
  return chunks.length > SES_IDENTITY_POLICIES_MAX ? { kind: 'too_large' } : { kind: 'ok', chunks };
}

/**
 * 도메인의 **살아 있는 주소 천장**(critic 4) — 최악의 경우(로컬파트 64자 · ARN 128자)에도 정책 20개에 들어가는 수, 그리고 1,000 이하.
 * 주소 하나의 최악 바이트 = 로컬파트 64 + `@` 1 + 도메인 + 따옴표 2 + 쉼표 1. SQL `atmark_custom_domain_address_ceiling(domain)` 과 같은 식이다
 * (통합 테스트가 길이 1~100 에서 대조). 예: 18자 → 820 · 50자 → 600 · 100자 → 400.
 */
export function customDomainAddressCeiling(domain: string): number {
  const length = domain.length;
  const frame = IDENTITY_POLICY_FRAME_BYTES + SENDER_ROLE_ARN_MAX_LENGTH + AWS_ACCOUNT_ID_LENGTH + length;
  const perPolicy = Math.floor((SES_IDENTITY_POLICY_MAX_BYTES - frame) / (WORST_LOCAL_PART_LENGTH + 1 + length + 3));
  return Math.max(0, Math.min(CUSTOM_DOMAIN_ADDRESS_CEILING, SES_IDENTITY_POLICIES_MAX * perPolicy));
}
/** 정책 이름 앞머리 — `atmark-sender-<rowId>-<n>`(n = 0..19). 감사는 이 앞머리 밖의 정책을 drift 로 본다. */
export const IDENTITY_POLICY_NAME_PREFIX = 'atmark-sender-';
/** identity 행 태그(H1) — 값 = 소유 행 id. 변형 호출 전 대조. */
export const IDENTITY_ROW_TAG = 'atmark:row';
export const IDENTITY_MANAGED_TAG = 'atmark:managed';
/**
 * 플랫폼 identity(`atmark.ai`) 표시 태그 — 손으로 붙인다(identity 가 스택 밖, deploy §41). domain-control 역할은 이 태그가 있는 identity 에 어떤 SES 명령도
 * 못 한다(IAM 이름 Deny 는 대소문자를 가리는데 SES 는 `ATMARK.AI` 를 `atmark.ai` 로 푼다 — 2026-10-05 실측).
 */
export const IDENTITY_PLATFORM_TAG = 'atmark:platform';
export const IDENTITY_PLATFORM_TAG_VALUE = 'true';
export const IDENTITY_MANAGED_TAG_VALUE = 'customer-domain';

// ---------------------------------------------------------------------------
// 평판 동결(§3.8 — 진윤겸 J6)
// ---------------------------------------------------------------------------

export const REPUTATION_THRESHOLDS = {
  /** 7일 창과 24시간 창에 같은 식. */
  windowsMs: [7 * 24 * 3_600_000, 24 * 3_600_000],
  /** complaint율 ≥ 0.08% **그리고** complaint ≥ 3건 → suspended(reputation). */
  freezeComplaintRate: 0.0008,
  freezeComplaintMinCount: 3,
  /** (영구) bounce율의 윌슨 95% 하한 ≥ 3% → suspended(reputation). */
  freezeBounceWilsonLower: 0.03,
  /** 계정 기여분 — 도메인 bounce ÷ 계정 전체 전달(7일)이 1.0%p 이상, complaint 0.02%p 이상이면 비율 조건과 무관하게 동결. */
  freezeAccountBounceContribution: 0.01,
  freezeAccountComplaintContribution: 0.0002,
  /**
   * 계정 기여분 경로의 **최소 건수**(진윤겸 결정 2026-10 · #13 M3) — 7일 창에서 complaint 3건 미만 · (영구) bounce 10건 미만이면 그 지표로는 동결하지
   * 않는다. 계정 전체 전달이 적은 시기에 한두 건이 기여분을 넘기는 과민을 막는다(complaint 는 비율 경로의 최소 건수와 같은 3).
   */
  freezeAccountComplaintMinCount: 3,
  freezeAccountBounceMinCount: 10,
  /** 경고(알람만). */
  warnComplaintRate: 0.0005,
  warnComplaintMinCount: 2,
  warnBounceWilsonLower: 0.02,
  /** 윌슨 하한의 z(95%). */
  wilsonZ: 1.96,
  /**
   * bounce 는 **영구(Permanent · hard)만** 센다(진윤겸 결정 2026-10 · #13 M3) — `ses_events.bounce_type = 'permanent'`(202610021104). 일시(Transient ·
   * 사서함 가득 등) · 판정 불가 · 칸 이전의 행(NULL)은 분자에 넣지 않는다(분모 = 전달 시도에는 남는다).
   */
  countedBounceType: 'permanent',
} as const;

// ---------------------------------------------------------------------------
// 알림(§3.11 M14) · 감사 · 로그 · API 오류 코드
// ---------------------------------------------------------------------------

/**
 * `domain_notices.kind` CHECK 와 같다(202610051000 이 `verified` 를 더했다 — 첫 확인 · ownership_lost/dkim_failed 정지에서 자동 복귀할 때 소유자에게
 * "도메인 확인 완료" 를 알린다. 요금제 복귀(plan_limit)는 소유자가 요금제를 바꾼 결과라 알리지 않는다).
 */
export const DOMAIN_NOTICE_KINDS = ['suspended', 'removal_d3', 'removed', 'expiry_warning', 'verified'] as const;
export type DomainNoticeKind = (typeof DOMAIN_NOTICE_KINDS)[number];

/** 도메인 알림의 **시스템 메일 경로 id**(관문 밖, `notify@atmark.ai`, 워밍업 캡 없음 — 매니페스트 `SYSTEM_MAIL_ENTRYPOINTS`). */
export const DOMAIN_NOTICE_ROUTE_ID = 'domain_notice';
/** 조직당 하루 도메인 알림 상한. */
export const DOMAIN_NOTICES_PER_ORG_PER_DAY = 10;

/** `owner_actions.action` 코드. `target_id` = `custom_domains.id`(도메인명 칸은 없다 — L5). */
export const DOMAIN_OWNER_ACTIONS = ['domain.add', 'domain.check', 'domain.remove'] as const;
export type DomainOwnerAction = (typeof DOMAIN_OWNER_ACTIONS)[number];

/** 로그 지표 이름 — 필드에 도메인명을 싣지 않는다(도메인 id 만 — 관측 PII 규칙). */
export const DOMAIN_LOG_EVENTS = {
  /** 확인 하나: `{ domainId, op, txt, mx, outcome }`. */
  check: 'domain.check',
  /** 틱마다 한 번(0 이어도): `{ dueBacklog, pending, recheck, elapsedMs }`. */
  backlog: 'domain.backlog',
  /** 상태 전이: `{ domainId, from, to, reason }`. */
  transition: 'domain.transition',
  /** 알림을 조직 하루 상한(종류 칸)에 걸려 적지 않았다: `{ domainId, kind }`. */
  noticeCapped: 'domain.notice_capped',
  /** 정책 감사: `{ domainId, outcome }`. */
  policyAudit: 'domain.policy_audit',
  /** 평판 판정: `{ domainId, window, action }`. */
  reputation: 'domain.reputation',
  /** 정책이 20개를 넘는다(기존 정책 유지): `{ domainId, addresses }` — 알람. */
  policyTooLarge: 'domain.policy_too_large',
  /** identity 관리권 이동(선점 인수 · 양도 · 넘겨주기): `{ domainId(받는 행), from(놓은 행), reason }`. */
  identityHandover: 'domain.identity_handover',
  /** 즉시 실행 한 번: `{ domainId, outcome }`(`ProvisionDomainOutcome`). */
  provision: 'domain.provision',
} as const;

/** API·콘솔 오류 코드. */
export const DOMAIN_API_ERRORS = {
  featureNotEnabled: 'feature_not_enabled',
  planLimitExceeded: 'plan_custom_domains_exceeded',
  pendingLimitExceeded: 'custom_domains_pending_exceeded',
  domainNotVerified: 'domain_not_verified',
  checkRateLimited: 'domain_check_rate_limited',
  notReady: 'not_ready',
  /**
   * P0A01 은 **어느 쪽에서도 전용 코드로 답하지 않는다**(보안 I2 · 재리뷰 L6) — 발급 쪽(에이전트 만들기 · 별칭 추가)은 기존 중립 409
   * (`conflict` · `address_taken`), 초대는 다른 잘못된 주소와 같은 400 `invalid_email`, 가입 확인 · 초대 수락은 이유를 가리지 않는 거부. 어떤 주소가
   * 에이전트 주소인지 · 누군가의 사람 이메일인지를 캐 보는 경로를 두지 않는다. 운영자 조직 만들기(CLI)만 입력 오류 문장으로 이유를 말한다.
   */
  billingEmailIsAgent: 'billing_email_is_agent',
} as const;

/** 도메인 계약 트리거의 SQLSTATE(ADR-0014). 앱은 이 코드로 오류를 번역한다 — 메시지 문자열로 분기하지 않는다. */
export const DOMAIN_SQLSTATES = {
  /** `atmark_claim_mail_identity` — 같은 판정형 키를 반대 kind(에이전트 ↔ 사람)가 쥐고 있다. 어디서도 전용 코드로 답하지 않는다(`DOMAIN_API_ERRORS` 주석). */
  mailIdentityConflict: 'P0A01',
  /** `custom_domains_registrable_guard` — 같은 등록 가능 apex 아래를 다른 조직이 verifying 이상으로 쥐고 있다. */
  registrableTaken: 'P0A02',
  /** `custom_domains_limits_guard` — 조직의 살아 있는 도메인 천장(20) 또는 pending 상한(2). */
  domainLimit: 'P0A03',
  /** `agent_addresses_verified_domain_guard` — 그 도메인의 살아 있는 주소 천장(1,000). */
  addressCeiling: 'P0A04',
  /** `agent_addresses_verified_domain_guard` — 같은 조직의 verified 고객 도메인이 아니다. → 400 `domain_not_verified`. */
  domainNotVerified: 'P0A05',
  /** `agent_addresses_verified_domain_guard` — 고객 도메인 주소를 대표 주소로 만들려 했다(v1 은 별칭만). */
  primaryOnCustomDomain: 'P0A06',
  /** `custom_domains_limits_guard` — 조직이 기능 허용 목록(`org_features`)에 없다. → 403 `feature_not_enabled`. */
  featureNotEnabled: 'P0A07',
  /**
   * `agent_primary_changes_guard`(ADR-0014 2026-10 개정) — 대표 주소가 될 수 없는 대상: @atmark.ai 별칭(앵커만 된다) · 폐기된 주소 · 이 에이전트의
   * 주소가 아님. 고객 도메인이 verified 가 아니면 P0A05 다.
   */
  primaryNotAllowed: 'P0A08',
  /** `agent_primary_changes_guard` — 대표 주소 변경 속도 상한(에이전트 24시간 5 · 조직 24시간 50). → 429. */
  primaryRateLimited: 'P0A09',
  /**
   * `atmark_provision_custom_primary` — 앵커 이름(`ax--` + 난수)이 활성 주소 · 사람 이메일 claim 과 겹쳤다. 앱만 보는 코드다 — 새 난수로 다시
   * 시도한다(`ANCHOR_PROVISION_MAX_ATTEMPTS`). 사용자에게 나가지 않는다.
   */
  anchorNameConflict: 'P0A10',
} as const;

/**
 * 메일 신원 claim 의 종류(critic 3 · 보안 M1).
 *   - `agent` — 에이전트 주소(대표·별칭). **톰스톤**(지우지 않는다).
 *   - `human_member` — 콘솔 사용자 중 멤버십이 **한 번이라도** 있었던 사람 · 가입자 · 조직 소유자 주소(`organizations.owner_email`).
 *     에이전트 주소와 충돌하면 P0A01(어느 쪽이 먼저든).
 *   - `human_invitee` — 초대만 받은 사용자. 초대는 아무 조직이나 아무 주소로 보낼 수 있으므로, 이 claim 이 에이전트 발급을 막으면 **다른 조직의
 *     에이전트 로컬파트를 초대로 선점**할 수 있다. 그래서 에이전트 발급이 이 claim 을 **이긴다**: 지우고 그 사용자의 대기 초대를 취소한다.
 *     초대 INSERT · 멤버십 INSERT(초대 수락) 는 에이전트 claim 을 다시 보고 있으면 P0A01(닫힌 쪽).
 * 사람 claim(두 종류 모두)은 그 주소의 도메인을 어느 조직이든 지금 쥐고 있으면(verifying·verified·suspended) P0A01 이다 — 에이전트
 * 서브도메인은 에이전트 전용이다(보안 M1).
 */
export const MAIL_CLAIM_KINDS = ['agent', 'human_member', 'human_invitee'] as const;
export type MailClaimKind = (typeof MAIL_CLAIM_KINDS)[number];

/** `atmark_claim_mail_identity` 가 반대 kind 의 claim 을 만났을 때의 SQLSTATE(ADR-0014 결정 7). */
export const MAIL_IDENTITY_CONFLICT_SQLSTATE = DOMAIN_SQLSTATES.mailIdentityConflict;

// ---------------------------------------------------------------------------
// 관문 스냅샷 접기(§3.7 M10) — 로더가 쓴다
// ---------------------------------------------------------------------------

/**
 * 바인딩 주소 도메인의 관문 상태(계획 §3.7) — `src/policy/types.ts` 가 다시 내보낸다(엔진 소비자는 그 파일 하나만 import). 여기서 정의하는 이유:
 * `src/db/schema.ts` 가 이 파일의 유니온을 쓰므로, 이 파일이 `policy/types.ts`(→ schema)를 import 하면 순환이 된다.
 *   - `platform` — `atmark.ai`(도메인 축 없음).
 *   - `verified` — 같은 조직의 고객 도메인이 verified.
 *   - `plan_limit` — suspended(plan_limit). Stage 0 → `domain_plan_limit`(transient).
 *   - `blocked` — 그 밖 전부(정지·제거·행 없음). Stage 0 → `domain_suspended`(PERMANENT).
 */
export type DomainGateStatus = 'platform' | 'verified' | 'plan_limit' | 'blocked';

/**
 * 로더가 에이전트의 살아 있는 주소 도메인마다 고른 `custom_domains` 행(같은 조직, `status <> 'removed'` 우선 · 없으면 removed · 그것도 없으면
 * `missing`). `atmark.ai` 는 여기 오지 않는다(`platform`).
 */
export interface BoundDomainState {
  readonly status: CustomDomainStatus | 'missing';
  readonly suspendedReason: CustomDomainSuspendedReason | null;
}

/**
 * 관문이 읽는 도메인 상태 — `verified` → 통과, `suspended(plan_limit)` → `plan_limit`(transient), **그 밖 전부 → `blocked`**(PERMANENT —
 * pending·verifying 은 주소 트리거 때문에 도달 불가지만 방어적으로 막는다, `domain_pending` 사유는 두지 않는다 L4). 모르는 값도 `blocked`.
 */
export function domainGateStatusOf(state: BoundDomainState): Exclude<DomainGateStatus, 'platform'> {
  if (state.status === 'verified') return 'verified';
  if (state.status === 'suspended' && state.suspendedReason === 'plan_limit') return 'plan_limit';
  return 'blocked';
}

/**
 * 수신 판정(계획 §3.6, critic minor 6) — 같은 조직의 도메인이 verified 이거나 suspended(reputation · operator · plan_limit)면 받는다. 소유권을
 * 잃었거나(ownership_lost · dkim_failed) 제거됐거나 행이 없으면 받지 않는다(`domain_not_active`). 수신 소비자의 EXISTS 술어와 같은 표다(단계 3).
 */
export function domainAcceptsInboundOf(state: BoundDomainState): boolean {
  if (state.status === 'verified') return true;
  return state.status === 'suspended' && (state.suspendedReason === 'reputation' || state.suspendedReason === 'operator' || state.suspendedReason === 'plan_limit');
}

// ---------------------------------------------------------------------------
// 대표 주소 포인터 모델(ADR-0014 2026-10 개정 · 진윤겸 결정 2) — 마이그레이션 202610021100 · 1101
// ---------------------------------------------------------------------------

/** 대표 주소 변경(원인 `owner` — 콘솔·조직 API)의 에이전트당 속도 상한(DB 가드 `agent_primary_changes_guard` — 넘으면 P0A09, 조직 상한 50 은 SQL 에만). */
export const PRIMARY_CHANGES_PER_AGENT_PER_DAY = 5;

/**
 * **앵커 이름 공간**(진윤겸 2026-10-02 "겹치지 않도록 꼭") — 고객 도메인을 대표로 고른 에이전트의 @atmark.ai 앵커 로컬파트 = `ax--` + 암호학적 난수
 * 20자(RFC 4648 base32 소문자 `[a-z2-7]` — 100비트). 에이전트 id 에서 파생하지 않는다(did:web 에 공개된 id 로 역추적되지 않게). 사용자 입력은
 * 이 접두사를 형식 오류로 거부한다(`buildAgentAddress` · DB `agent_addresses_anchor_namespace_guard`).
 */
export const ANCHOR_LOCAL_PART_PREFIX = 'ax--';
export const ANCHOR_RANDOM_LENGTH = 20;
export const ANCHOR_LOCAL_PART_PATTERN = /^ax--[a-z2-7]{20}$/;
/** 앵커 이름 충돌(P0A10) 재시도 상한 — 넘으면 오류(100비트 난수라 실제로는 닿지 않는다). */
export const ANCHOR_PROVISION_MAX_ATTEMPTS = 5;

/** 유효 대표 판정의 입력 — 한 에이전트의 앵커 · 마지막 선택 · 그 선택이 가리키는 주소 행과 그 도메인의 행 상태들(같은 조직). */
export interface PrimaryFacts {
  /** `is_primary` 활성 행. 없으면(있을 수 없는 상태) 대표도 없다. */
  readonly anchor: { readonly id: string; readonly address: string } | null;
  /** `agent_primary_changes` 의 마지막 선택(created_at DESC, id DESC). 없으면 `null`. */
  readonly lastChoice: { readonly addressId: string } | null;
  /**
   * 마지막 선택이 가리키는 주소 행(그 에이전트의 것일 때만 — 아니면 `null`) · 폐기 여부 · 같은 조직의 그 도메인 `custom_domains` 행 상태들(removed 포함
   * 전부 — 하나라도 verified · suspended 면 살아 있다). atmark.ai 주소면 `domainStatuses` 는 보지 않는다.
   */
  readonly target: { readonly address: string; readonly domain: string; readonly retired: boolean; readonly domainStatuses: readonly CustomDomainStatus[] } | null;
}

/**
 * 유효 대표 주소(SQL `atmark_agent_primary_address` 와 같은 표 — 통합 테스트가 대조). 선택 없음 · 앵커 선택 → 앵커. 살아 있는 선택(atmark.ai 이거나
 * 같은 조직의 그 도메인이 verified · suspended) → 그 주소. **그 밖 → `null`**(에이전트는 "주소 없음" — 자동으로 앵커로 옮기지 않는다, 진윤겸 결정).
 * 평판·운영자 정지(suspended)는 주소를 그대로 두고 관문이 막는다.
 */
export function effectivePrimaryOf(facts: PrimaryFacts): string | null {
  if (facts.lastChoice === null || (facts.anchor !== null && facts.lastChoice.addressId === facts.anchor.id)) return facts.anchor?.address ?? null;
  const target = facts.target;
  if (target === null || target.retired) return null;
  if (target.domain === 'atmark.ai') return target.address;
  return target.domainStatuses.some((status) => status === 'verified' || status === 'suspended') ? target.address : null;
}

/**
 * **잠든 앵커** — 마지막 선택이 앵커가 아니면(고객 도메인 주소를 대표로 골랐다) 앵커는 보이지 않고 받지 않고 보내지 않는다. 그 선택이 무효가 돼도
 * 앵커는 깨어나지 않는다(소유자가 "@atmark.ai 주소 켜기" = 앵커를 대표로 선택해야 깬다). 정책 소스 `usable` · 수신 조회의 SQL 술어와 같다.
 */
export function anchorDormantOf(facts: Pick<PrimaryFacts, 'anchor' | 'lastChoice'>): boolean {
  return facts.anchor !== null && facts.lastChoice !== null && facts.lastChoice.addressId !== facts.anchor.id;
}
