/**
 * src/observability/logger.ts — **운영자가 장애를 보는 창.** 법적 기록이 아니다.
 *
 * ## 경계 ① — audit 과 log 는 다르다 (§4.3)
 * `audit_logs`(Postgres)는 발송 시도당 정확히 1행인 법적 기록이고, 실패하면 시도가 멈춘다(P3).
 * 이 파일(CloudWatch)은 유실·중복이 허용되는 텔레메트리이고, 실패는 삼킨다.
 * 그래서 이 모듈은 audit 을 대신할 수 없게 만든다 — `src/db/**`·`pg` 를 import 하지 않고
 * (`test/arch/observability-pii.arch.test.ts`), 결정을 실을 때는 `audit_id` 포인터를 함께 싣는다.
 * "로그에 다 남으니까" 가 통하는 순간 audit INSERT 실패가 발송을 멈출 이유가 사라진다.
 *
 * ## 경계 ② — PII 를 싣지 않는다
 * 수신자 주소·제목·본문이 CloudWatch(리텐션·접근 통제가 DB 보다 느슨하다)에 눌러앉으면 안 된다.
 * 세 겹으로 막는다:
 *   ① 닫힌 키 어휘(`LOG_FIELD_KEYS`) — `subject`·`to` 같은 키가 없어 타입 에러다.
 *   ② 런타임 치환(`redact`) — 키와 무관하게 값 안의 주소·비밀 토큰을 지우고 길이를 자르며,
 *      스칼라가 아닌 값은 통째로 거부한다. `detail: String(error)` 처럼 값을 에코하는 경로 때문이다.
 *   ③ arch 테스트 — 어휘 골든 스냅샷 · 호출부 스프레드 금지(닫힌 어휘를 뚫는 유일한 구멍) ·
 *      본문·주소를 쥔 모듈 import 금지.
 * 참조는 ID·카운트로 한다(`agent_id` 는 불투명 hex 32, `recipient_count`, `message_id`).
 *
 * ## 경계 ③ — 관측은 결말을 뒤집지 않는다
 * `log`·`writeLine` 은 던지지 않는다. 전송 성공 뒤 코드가 던지면 나간 메일이 `failed` 로 기록되고
 * 재시도로 두 번 간다(BLOCKER, `test/unit/policy/gate.test.ts`). `console.*` 대신 명시적 싱크를 둔다.
 */

/** 로그 심각도. `fatal` 은 없다 — 이 모듈이 프로세스를 끝낼 권한은 없다. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * **실을 수 있는 필드의 전부.** 이 배열에 없는 키는 타입 에러다.
 * `subject`·`body`·`to`·`recipients`·`from_address`·`email` 이 **없는 것**이 요점이다.
 * `agent_id` 는 레코드 키라 로그에는 싣지만 메트릭 차원에는 싣지 않는다(기수, `metrics.ts`).
 */
export const LOG_FIELD_KEYS = [
  'agent_id',
  'approval_id',
  'audit_id',
  'detail',
  'error_code',
  'error_kind',
  'http_status',
  'lane',
  'latency_ms',
  'lease_id',
  'message_id',
  'outcome',
  'policy_version',
  'recipient_count',
  'reason',
  'route_id',
  'ses_message_id',
  'settled',
  'trace_id',
  'verdict',
] as const;

export type LogFieldKey = (typeof LOG_FIELD_KEYS)[number];

/** 스칼라만 싣는다. 중첩 객체를 허용하면 그 안쪽이 어휘 밖이 된다. */
export type LogValue = string | number | boolean | null;

/**
 * 로그 한 줄의 필드. optional 금지 규약(`src/policy/types.ts`)은 관문 입력 계약용이다 —
 * 여기는 가방이고, 규율은 키 집합이 닫혀 있다는 것이다.
 */
export type LogFields = Readonly<Partial<Record<LogFieldKey, LogValue>>>;

/** 직렬화된 한 줄을 받는 곳. 개행을 붙이는 것은 싱크의 몫이 아니라 `emit` 의 몫이다. */
export type LogSink = (line: string) => void;

/** 주소 형태 토큰. `local@domain.tld` 의 최소 형태를 잡는다. */
const ADDRESS_PATTERN = /[^\s<>@,;:"'()[\]]+@[^\s<>@,;:"'()[\]]+\.[^\s<>@,;:"'()[\]]+/g;

export const REDACTED_ADDRESS = '[redacted:address]';

/**
 * 우리가 발급하는 비밀 문자열: `atk_<종류>_…`(에이전트 토큰 `atk_agent_`, 승인 링크 `atk_link_`)와
 * 웹훅 시크릿 `whsec_…`. 승인 링크는 URL 에 실리고 HTTP 오류는 URL 을 에코해 `detail` 로 들어오므로(P2),
 * 주소와 같이 키를 보지 않고 값에서 지운다.
 */
const SECRET_TOKEN_PATTERN = /(?:atk_[a-z]+_[A-Za-z0-9._~-]+|whsec_[A-Za-z0-9+/=]+)/g;

export const REDACTED_TOKEN = '[redacted:token]';

/**
 * 스칼라가 아닌 값이 있던 자리에 남기는 표지. 키를 조용히 지우면 "안 실었다" 와 "거부했다" 가
 * 구별되지 않아 사고를 늦게 발견한다 — 값은 안 나가고 사실만 남는다.
 */
export const REDACTED_NONSCALAR = '[redacted:nonscalar]';

/**
 * 문자열 값의 상한. 본문 한 통이 `detail` 로 들어오는 경로의 마지막 문이다 — 오류 메시지 한 문단은
 * 남기고 메일 본문은 남기지 않는 눈금. 짧은 본문이어도 주소는 ①·② 에서 이미 지워진다.
 */
export const MAX_STRING_LENGTH = 512;

/** 잘렸다는 사실을 값 안에 남긴다 — 조용히 잘린 로그는 거짓말과 구별되지 않는다. */
export const TRUNCATION_MARKER = '…[truncated]';

/**
 * 값 하나의 PII 제거. **키를 보지 않는다** — 어휘(①)가 뚫렸을 때 남는 방어선이라 조건부가 아니어야 한다.
 * 그래서 주소를 닮은 우리 값(드라이런 `ses_message_id`, `Message-ID`)도 지워지지만 키별 예외는 두지
 * 않는다 — 예외 목록이 곧 구멍이다. 잃는 조인 키는 `message_id` 로 대체된다.
 *
 * 인자가 `unknown` 이고 **허용 타입 화이트리스트**로 거른다: 예전에는 문자열이 아니면 그대로 돌려줘
 * `{"detail":{"to":"victim@…"}}` 가 세 겹을 전부 통과했다(P1c 검증). 재귀 치환은 중첩을 허용하는
 * 설계라 쓰지 않는다. `bigint`(직렬화가 던져 줄을 통째로 삼킴)·`symbol`(키 증발)도 표지로 바뀐다.
 * `src/**` 호출부는 전부 스칼라를 넘긴다(arch 테스트가 단언) — 거부로 깨지는 호출부는 없다.
 */
export function redact(value: unknown): LogValue {
  // `typeof null === 'object'` 다. 먼저 보지 않으면 `null` 이 표지로 바뀐다.
  if (value === null) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value !== 'string') return REDACTED_NONSCALAR;

  const withoutAddresses = value
    .replace(SECRET_TOKEN_PATTERN, REDACTED_TOKEN)
    .replace(ADDRESS_PATTERN, REDACTED_ADDRESS);
  if (withoutAddresses.length <= MAX_STRING_LENGTH) return withoutAddresses;
  return withoutAddresses.slice(0, MAX_STRING_LENGTH) + TRUNCATION_MARKER;
}

const KNOWN_KEYS = new Set<string>(LOG_FIELD_KEYS);

/** 어휘 밖 키는 버린다 — 타입이 막지만 경계는 타입이 없는 쪽(JSON·`as` 캐스팅)과도 닿는다. */
function sanitize(fields: LogFields): Record<string, LogValue> {
  const out: Record<string, LogValue> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!KNOWN_KEYS.has(key)) continue;
    if (value === undefined) continue;
    out[key] = redact(value);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 싱크 — 프로세스 전역 하나
// ---------------------------------------------------------------------------

/**
 * 싱크를 `GateDependencies` 로 주입하지 않는 이유: 주입 가능한 관측기는 빠뜨릴 수 있는 관측기다
 * (`gate.ts` 가 `OUTBOUND_ROUTES` 를 직접 import 하는 것과 같은 이유, AC-8). 이음매는 `setLogSink` 하나다.
 */
let sink: LogSink = defaultSink();

function defaultSink(): LogSink {
  // 테스트 런타임 기본값은 무음(출력이 실패 메시지를 묻는다). 규율을 검증하는 테스트는 싱크를 직접 심는다.
  if (process.env['VITEST'] === 'true') return () => undefined;
  return (line: string): void => {
    process.stdout.write(`${line}\n`);
  };
}

/** 테스트·런타임 조립이 싱크를 바꾼다. 돌려주는 함수를 부르면 이전 싱크로 되돌린다. */
export function setLogSink(next: LogSink): () => void {
  const previous = sink;
  sink = next;
  return () => {
    sink = previous;
  };
}

/** 기본 싱크로 되돌린다. 테스트의 `afterEach` 용. */
export function resetLogSink(): void {
  sink = defaultSink();
}

/** 직렬화된 한 줄을 싱크로 보낸다. **던지지 않는다**(경계 ③). `metrics.ts` 의 EMF 도 이 문 하나로 나간다. */
export function writeLine(line: string): void {
  try {
    sink(line);
  } catch {
    // 다시 로그를 쓰면 재진입이고, 던지면 나간 메일의 결말을 뒤집는다.
  }
}

/** 로그 한 줄. `event` 는 닫힌 어휘가 아니지만 **값이 아니라 이름**이다(집계 축). */
export function log(level: LogLevel, event: string, fields: LogFields = {}): void {
  let line: string;
  try {
    line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      event,
      ...sanitize(fields),
    });
  } catch {
    return;
  }
  writeLine(line);
}
