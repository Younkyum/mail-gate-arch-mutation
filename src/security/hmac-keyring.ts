/**
 * src/security/hmac-keyring.ts — HMAC 키 묶음. 승인 매직링크 · 초대 토큰 · 로그인 코드 · 웹훅 서명 비밀 파생 · DLP 지문이 쓴다.
 *
 * ---------------------------------------------------------------------------
 * ## 왜 "키 하나" 가 아니라 "키 묶음(keyring)" 인가
 * ---------------------------------------------------------------------------
 *
 * 지금은 키 회전이 필요 없다. 그러나 **회전이 불가능한 형태**로 만들면 필요해지는 날
 * (키 유출, 퇴사자, 저장소 이동) 선택지가 "모든 링크를 한 번에 무효화" 하나뿐이다.
 * 그래서 서명물에 **`kid`(키 식별자)** 를 싣고, 검증은 `kid` 로 키를 고른다.
 *
 *   - **서명은 첫 번째 키(`active`)로만 한다.**
 *   - **검증은 묶음 안의 모든 키로 한다.** — 회전 절차: 새 키를 **앞에** 추가 → 배포 →
 *     구 키로 서명된 것의 최대 수명(승인 TTL 최대 7일)이 지나면 구 키 제거.
 *
 * ---------------------------------------------------------------------------
 * ## 왜 부재 시 던지는가 (fail-closed)
 * ---------------------------------------------------------------------------
 *
 * 키가 없을 때 "빈 키" 나 "개발용 기본 키" 로 떨어지면, 그 기본 키는 **저장소에 적혀
 * 있으므로 공개 키**다 — 누구나 승인 링크를 위조할 수 있다. `src/db/client.ts` 가
 * 접속 문자열 부재 시 기본값을 만들지 않는 것과 같은 규율이다.
 *
 * **키가 짧으면 거부한다(32바이트 미만).** HMAC-SHA256 의 키 강도는 키 길이에 묶인다.
 * 사람이 손으로 친 `"secret"` 같은 값이 여기 들어오면 오프라인 사전 공격 대상이 된다.
 *
 * 환경 변수 형식: `kid:base64url키,kid2:base64url키` (쉼표 구분, 첫 항목이 active).
 */

/** 키 식별자 형식. 토큰·헤더에 그대로 실리므로 구분자(`.` `:` `,`)를 포함하지 않는다. */
const KID_PATTERN = /^[a-z0-9]{1,16}$/;

/** HMAC-SHA256 키의 최소 길이. 해시 출력 길이와 같다(RFC 2104 §3 권고). */
export const MIN_HMAC_KEY_BYTES = 32;

/** 키가 없거나 형식이 틀리다. **읽을 수 없으면 서명도 검증도 하지 않는다.** */
export class HmacKeyUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HmacKeyUnavailableError';
  }
}

export interface HmacKeyring {
  /** 서명에 쓰는 키의 `kid`. 항상 `keys` 안에 있다. */
  readonly activeKid: string;
  /** `kid` → 키 바이트. 검증은 여기서 고른다. */
  readonly keys: ReadonlyMap<string, Buffer>;
}

/** 표준 base64url 이고 재인코딩해도 같은 문자열인가 — 비정규 인코딩은 거부한다. */
export function decodeCanonicalBase64Url(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.toString('base64url') === value ? bytes : null;
}

/**
 * 문자열 → 키 묶음. **오류 메시지에 키 값을 싣지 않는다** — 이 메시지는 배포 로그로 간다.
 */
export function parseHmacKeyring(raw: string | undefined, variable: string): HmacKeyring {
  if (raw === undefined || raw.trim() === '') {
    throw new HmacKeyUnavailableError(`${variable} 이 비어 있다. 키 없이는 서명·검증을 하지 않는다.`);
  }

  const keys = new Map<string, Buffer>();
  let activeKid: string | undefined;

  for (const entry of raw.split(',')) {
    const separator = entry.indexOf(':');
    const kid = separator === -1 ? '' : entry.slice(0, separator).trim();
    const encoded = separator === -1 ? '' : entry.slice(separator + 1).trim();

    if (!KID_PATTERN.test(kid)) {
      throw new HmacKeyUnavailableError(`${variable} 의 kid 형식이 틀리다(소문자·숫자 1~16자).`);
    }
    if (keys.has(kid)) {
      // 같은 kid 가 둘이면 어느 키로 검증할지가 입력 순서에 달린다 — 회전 중 사고의 전형.
      throw new HmacKeyUnavailableError(`${variable} 에 kid '${kid}' 가 중복됐다.`);
    }
    const key = decodeCanonicalBase64Url(encoded);
    if (key === null || key.length < MIN_HMAC_KEY_BYTES) {
      throw new HmacKeyUnavailableError(
        `${variable} 의 kid '${kid}' 키가 base64url ${MIN_HMAC_KEY_BYTES}바이트 이상이 아니다.`,
      );
    }
    keys.set(kid, key);
    activeKid ??= kid;
  }

  if (activeKid === undefined) {
    throw new HmacKeyUnavailableError(`${variable} 에 키가 없다.`);
  }
  return { activeKid, keys };
}

/** 서명용 키. `activeKid` 는 생성 시점에 `keys` 안에 있음이 보장된다. */
export function activeKey(keyring: HmacKeyring): { readonly kid: string; readonly key: Buffer } {
  const key = keyring.keys.get(keyring.activeKid);
  if (key === undefined) throw new HmacKeyUnavailableError('active kid 의 키가 묶음에 없다.');
  return { kid: keyring.activeKid, key };
}
