/**
 * src/passport/jcs.ts — **RFC 8785 JSON Canonicalization Scheme(JCS)** + `content_hash`.
 *
 * 규칙은 P1c 에서 동결됐다(`202609221600` `passports.content_hash` 주석, 계획 §4B.1): passport.json 을 JCS 로 정규 직렬화한 뒤
 * SHA-256, 소문자 hex 64자. **나중에 바꾸면 이미 발급된 문서의 해시를 재계산할 수 없다** — 그래서 이 파일은 작고, 외부 구현
 * (`canonicalize` 패키지 — RFC 8785 저자의 구현)과의 일치를 `test/unit/passport/jcs.test.ts` 가 본다.
 *
 * ADR-0003 B1 이 여기에 한 줄을 더했다: **이 함수의 출력 바이트가 곧 JWS 페이로드다.** 해시 대상과 서명 대상이 같은 바이트다.
 *
 * 받는 값은 JSON 값뿐이다(문자열·유한 수·불리언·null·배열·평범한 객체). `undefined`·함수·심볼·`NaN`·`Infinity`·`BigInt`·
 * 클래스 인스턴스(`Date` 포함)는 **던진다** — 조용히 빠지거나 `null` 이 되면 서명된 문서가 호출자가 뜻한 문서와 달라진다.
 *
 * 두 가지를 더 던진다:
 *   - **짝 없는 서로게이트**(문자열 값·객체 키 모두). RFC 8785 §3.2.2.2 는 유효한 Unicode 만 받는다. `JSON.stringify` 는 그것을
 *     `\ud800` 으로 이스케이프해 **통과시키므로**(ES2019 well-formed stringify), 그대로 두면 다른 JCS 구현(`canonicalize` 는 던진다)이
 *     거부하는 바이트에 서명하게 된다.
 *   - **희소 배열**(`[1,,3]`). `map`·`join` 이 구멍을 빈 문자열로 이어 `[1,,3]` — JSON 이 아닌 바이트 — 를 만든다. `canonicalize`
 *     는 `null` 로 채우지만 여기서는 `undefined` 멤버와 같은 이유로 던진다(조용히 채우면 호출자가 뜻한 문서가 아니다).
 * 차분 테스트(`test/unit/passport/jcs.test.ts`)가 이 둘과 무작위 값에서 `canonicalize` 와의 일치를 본다.
 */

import { createHash } from 'node:crypto';

/** JCS 가 받을 수 없는 값. */
export class JcsInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JcsInputError';
  }
}

/**
 * RFC 8785 §3.2:
 *   - 객체 키는 **UTF-16 코드 단위** 순서로 정렬(JS 의 기본 문자열 비교가 정확히 그것이다).
 *   - 문자열은 ECMAScript `JSON.stringify` 의 이스케이프 규칙(RFC 8785 §3.2.2.2 가 그대로 채택).
 *   - 수는 ECMAScript Number→String(§3.2.2.3 — `JSON.stringify` 의 수 출력과 같다). 유한 수만.
 *   - 공백 없음.
 */
export function canonicalize(value: unknown): string {
  return serialize(value, '$');
}

/** 짝 없는 서로게이트(상위 뒤에 하위가 없거나, 앞에 상위가 없는 하위). */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function serializeString(value: string, path: string): string {
  if (LONE_SURROGATE.test(value)) throw new JcsInputError(`${path}: 짝 없는 서로게이트는 유효한 Unicode 가 아니다(RFC 8785 §3.2.2.2).`);
  return JSON.stringify(value);
}

function serialize(value: unknown, path: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return serializeString(value, path);
    case 'number':
      if (!Number.isFinite(value)) throw new JcsInputError(`${path}: 유한하지 않은 수는 JSON 이 아니다.`);
      // -0 은 "0" 이다(ECMAScript Number::toString). JSON.stringify(-0) 도 "0".
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        const items: string[] = [];
        // `for` + `in` 검사 — `map` 은 구멍을 건너뛰어 희소 배열을 조용히 JSON 이 아닌 바이트로 만든다.
        for (let index = 0; index < value.length; index += 1) {
          if (!(index in value)) throw new JcsInputError(`${path}[${String(index)}]: 희소 배열의 구멍은 JSON 이 아니다.`);
          items.push(serialize(value[index], `${path}[${String(index)}]`));
        }
        return `[${items.join(',')}]`;
      }
      const prototype = Object.getPrototypeOf(value) as unknown;
      if (prototype !== Object.prototype && prototype !== null) {
        throw new JcsInputError(`${path}: 평범한 객체가 아니다(클래스 인스턴스는 직렬화 규칙이 암묵적이다).`);
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      const members: string[] = [];
      for (const key of keys) {
        const member = record[key];
        if (member === undefined) throw new JcsInputError(`${path}.${key}: undefined 는 JSON 이 아니다(빠뜨리려면 키를 지워라).`);
        members.push(`${serializeString(key, `${path}.<key>`)}:${serialize(member, `${path}.${key}`)}`);
      }
      return `{${members.join(',')}}`;
    }
    default:
      throw new JcsInputError(`${path}: ${typeof value} 는 JSON 이 아니다.`);
  }
}

/** `passports.content_hash` — JCS 문자열의 UTF-8 바이트 SHA-256, 소문자 hex 64자. */
export function contentHashOf(canonical: string): string {
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
