/**
 * observability — **PII 규율과 audit/log 경계를 기계가 지킨다.**
 *
 * 이 파일이 존재하는 이유는 `src/observability/logger.ts` 의 머리말 세 문단이
 * **주석이기 때문**이다. 주석은 다음 사람이 `detail: JSON.stringify(request)` 를
 * 한 줄 적는 것을 막지 못한다. 여기서 막는다.
 *
 * **세 겹 중 ①과 ③을 단언한다** (②는 `test/unit/observability/logger.test.ts` 의 몫):
 *   ① 닫힌 어휘가 실제로 닫혀 있고, 넓히는 행위가 **리뷰 대상**이 된다(골든 스냅샷).
 *   ③ 호출부가 그 어휘를 우회하지 못한다(관측 함수는 **호출 자리에만** 등장하고,
 *      필드 가방은 **인라인 객체 리터럴**이며, 그 안에 스프레드·계산된 키가 없다)
 *      + 로거가 **본문과 주소를 쥔 모듈에 닿을 수 없다**(import 금지).
 *
 * 그리고 **audit/log 경계**: 이 디렉터리는 `src/db/**` 도 `pg` 도 import 하지 않는다.
 * 쓸 수 있는 저장소가 없으므로 로그가 §4.3 의 법적 기록을 대신한다고 주장할 수 없다.
 */

import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';
import {
  Node,
  SyntaxKind,
  type CallExpression,
  type FunctionDeclaration,
  type ObjectLiteralExpression,
} from 'ts-morph';
import { LOG_FIELD_KEYS } from '../../src/observability/logger';
import { METRIC_DIMENSION_KEYS } from '../../src/observability/metrics';
import { OPS_METRIC_DIMENSION_KEYS } from '../../src/ops/metrics';
import { moduleSpecifiersOf, repoFileExists, repoPath, srcSourceFiles, toRepoRelative } from './support/project';

/**
 * **골든 스냅샷.** 어휘를 넓히는 것은 금지가 아니라 **선언**이어야 한다 —
 * 이 배열에 한 줄을 추가하는 행위가 리뷰어 앞에 놓이는 것이 이 단언의 전부다.
 * (`.dependency-cruiser.cjs` 의 허용목록, `NON_SENDING_ENTRYPOINTS` 의 `reason` 과
 *  같은 장치다: 예외 통로는 하나뿐이고 사람이 본다.)
 */
const FROZEN_LOG_FIELD_KEYS: readonly string[] = [
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
];

// `lane` — 문의 전달 차선(support|role, 202610021000). 닫힌 두 값이라 기수는 2배가 상한이고 `contactRateGlobal` 하나만 싣는다.
const FROZEN_METRIC_DIMENSION_KEYS: readonly string[] = ['route_id', 'verdict', 'reason', 'outcome', 'lane'];

/**
 * 금지 어간. 키 이름이 이 중 하나를 포함하면 그 키는 **내용물**을 담을 자리다.
 *
 * 이름 기반 검사가 완전하지 않다는 것은 안다(`d1` 이라는 키에 본문을 담을 수 있다).
 * 그래서 이것이 유일한 방어선이 아니다 — 런타임 치환(②)이 키를 보지 않고 값을 본다.
 * 이 검사가 잡는 것은 **선의의 실수**이며, 그것이 실제로 가장 흔한 경로다.
 */
const FORBIDDEN_KEY_STEMS = [
  'subject',
  'body',
  'text',
  'html',
  'content',
  'payload',
  'recipient_address',
  'recipients',
  'address',
  'email',
  'mail_to',
  'from_address',
  'headers',
  'raw',
];

/** 관측 모듈이 닿으면 안 되는 것 — 본문·주소를 쥔 모듈과 모든 저장소. */
const FORBIDDEN_IMPORT_PATTERNS: readonly { readonly label: string; readonly test: (spec: string) => boolean }[] = [
  { label: 'pg (Postgres 드라이버)', test: (s) => s === 'pg' || s.startsWith('pg/') },
  { label: 'src/db/** (저장소)', test: (s) => s.includes('/db/') || s.startsWith('../db') },
  { label: 'content-store (본문)', test: (s) => s.includes('content-store') },
  { label: 'mail/mime (본문·헤더 조립)', test: (s) => s.includes('mime') },
  { label: 'mail/transport (전송단)', test: (s) => s.includes('transport') },
  { label: '@aws-sdk/** (네트워크 I/O)', test: (s) => s.startsWith('@aws-sdk/') },
];

/**
 * 필드 가방을 받는 함수와 **그 가방의 인자 위치.**
 *
 * 위치를 표로 두는 대신 "객체 리터럴인 인자를 아무거나 집는" 방식이었는데, 그러면
 * **가방이 아닌 인자가 객체 리터럴일 때**와 **가방이 객체 리터럴이 아닐 때**를
 * 둘 다 구분하지 못한다. 후자가 이 층이 뚫린 자리였다(`const bag = {…}; log('x', bag)`).
 * 위치가 시그니처와 어긋나면 아래 표류 단언이 즉시 죽는다.
 */
interface ObservabilityFunction {
  readonly file: string;
  readonly name: string;
  readonly fieldIndex: number;
  readonly parameterName: string;
}

const OBSERVABILITY_FUNCTIONS: readonly ObservabilityFunction[] = [
  { file: 'src/observability/logger.ts', name: 'log', fieldIndex: 2, parameterName: 'fields' },
  { file: 'src/observability/metrics.ts', name: 'countMetric', fieldIndex: 1, parameterName: 'dimensions' },
  { file: 'src/observability/metrics.ts', name: 'emitMetric', fieldIndex: 3, parameterName: 'dimensions' },
];

const DEFINITION_FILES = new Set(['src/observability/logger.ts', 'src/observability/metrics.ts']);

function observabilityFiles(): string[] {
  return srcSourceFiles()
    .map((file) => toRepoRelative(file.getFilePath()))
    .filter((path) => path.startsWith('src/observability/'))
    .sort();
}

function declaredFunction(entry: ObservabilityFunction): FunctionDeclaration {
  const source = srcSourceFiles().find((file) => toRepoRelative(file.getFilePath()) === entry.file);
  if (source === undefined) throw new Error(`${entry.file} 을 ts-morph 가 읽지 못했다 — 이 층이 공허해진다.`);
  return source.getFunctionOrThrow(entry.name);
}

interface Reference {
  readonly file: string;
  readonly entry: ObservabilityFunction;
  readonly node: Node;
}

/**
 * `src/**` 에서 관측 함수 이름을 **참조하는** 노드 전부 (정의 파일 자신은 제외).
 *
 * `findReferencesAsNodes()` 는 식별자를 **해석**한다 — `src/db/migrate.ts` 의
 * `console.log` 는 다른 심볼이므로 들어오지 않고, 별칭 import 는 들어온다.
 * (`keypair-immutability.arch.test.ts` 가 참조 집합을 쓰는 것과 같은 이유다:
 *  "호출" 을 세려는 순간 **호출의 모양**에 의존하게 되고, 모양은 다르게 쓸 수 있다.)
 */
function observabilityReferences(
  entries: readonly ObservabilityFunction[] = OBSERVABILITY_FUNCTIONS,
  definitionFiles: ReadonlySet<string> = DEFINITION_FILES,
): Reference[] {
  const out: Reference[] = [];
  for (const entry of entries) {
    for (const node of declaredFunction(entry).getNameNodeOrThrow().findReferencesAsNodes()) {
      const file = toRepoRelative(node.getSourceFile().getFilePath());
      if (!file.startsWith('src/')) continue;
      if (definitionFiles.has(file)) continue;
      out.push({ file, entry, node });
    }
  }
  return out;
}

/** 참조가 **호출식의 피호출자 자리**에 있는가. */
function calleePositionOf(reference: Reference): CallExpression | undefined {
  const parent = reference.node.getParent();
  if (parent === undefined || !Node.isCallExpression(parent)) return undefined;
  return parent.getExpression() === reference.node ? parent : undefined;
}

/** 참조가 **별칭 없는 import 이름** 자리에 있는가. */
function isPlainImportName(reference: Reference): boolean {
  const parent = reference.node.getParent();
  if (parent === undefined || !Node.isImportSpecifier(parent)) return false;
  return parent.getAliasNode() === undefined && parent.getNameNode() === reference.node;
}

interface CallSite {
  readonly file: string;
  readonly callee: string;
  /** 필드 가방 자리의 인자. 생략 가능하므로 `undefined` 일 수 있다(기본값 `{}`). */
  readonly argument: Node | undefined;
}

/** `src/**` 의 관측 호출부 전부. */
function observabilityCallSites(references: readonly Reference[] = observabilityReferences()): CallSite[] {
  const sites: CallSite[] = [];
  for (const reference of references) {
    const call = calleePositionOf(reference);
    if (call === undefined) continue;
    sites.push({
      file: reference.file,
      callee: reference.entry.name,
      argument: call.getArguments()[reference.entry.fieldIndex],
    });
  }
  return sites;
}

/** 필드 가방이 **인라인 객체 리터럴인** 호출부만. */
function fieldLiterals(): { readonly file: string; readonly callee: string; readonly literal: ObjectLiteralExpression }[] {
  const out: { file: string; callee: string; literal: ObjectLiteralExpression }[] = [];
  for (const site of observabilityCallSites()) {
    if (site.argument !== undefined && Node.isObjectLiteralExpression(site.argument)) {
      out.push({ file: site.file, callee: site.callee, literal: site.argument });
    }
  }
  return out;
}

describe('observability — PII 규율 ① 닫힌 어휘', () => {
  it('로그 필드 어휘가 골든 스냅샷과 일치한다 (넓히려면 이 배열을 함께 고쳐라)', () => {
    expect([...LOG_FIELD_KEYS]).toEqual(FROZEN_LOG_FIELD_KEYS);
  });

  it('메트릭 차원 어휘가 골든 스냅샷과 일치한다', () => {
    expect([...METRIC_DIMENSION_KEYS]).toEqual(FROZEN_METRIC_DIMENSION_KEYS);
  });

  it('어떤 키도 내용물 어간을 포함하지 않는다', () => {
    const offenders = [...LOG_FIELD_KEYS, ...METRIC_DIMENSION_KEYS].filter((key) =>
      FORBIDDEN_KEY_STEMS.some((stem) => key.includes(stem)),
    );
    // `recipient_count` 는 통과해야 한다 — 수(數)는 내용물이 아니다.
    // 그래서 금지 어간은 `recipient` 가 아니라 `recipients`·`recipient_address` 다.
    expect(offenders).toEqual([]);
  });

  it('메트릭 차원은 로그 어휘의 부분집합이고, agent_id 를 포함하지 않는다', () => {
    // 차원이 로그보다 **넓으면** 기수 규율이 로그 규율과 어긋난다.
    const logKeys = new Set<string>(LOG_FIELD_KEYS);
    expect(METRIC_DIMENSION_KEYS.filter((key) => !logKeys.has(key))).toEqual([]);
    expect(METRIC_DIMENSION_KEYS).not.toContain('agent_id');
  });
});

/**
 * **제목이 참이 되려면 두 가지가 더 필요하다** (P1c 검증 지적 ②).
 *
 * 스프레드·계산된 키·어휘 단언은 셋 다 **인라인 객체 리터럴**만 봤다. 그래서
 * 가방을 변수로 올리는 한 줄이 셋 전부를 우회했다:
 *
 * ```ts
 * const bag = { subject, to } as unknown as LogFields;
 * log('info', 'x', bag);   // ③ 무반응
 * ```
 *
 * 그 형태 단독으로는 런타임 `sanitize` 가 모르는 키를 버려 막았지만, `redact` 가
 * 비스칼라를 통과시키던 동안에는 **`detail: {…}` 이 그 배달 수단**이었다.
 *
 * 그래서 두 축을 닫는다:
 *   (a) 관측 함수는 **호출식의 피호출자 자리에만** 등장한다 — 별칭 import·재바인딩·
 *       고차 전달이 전부 위반이다. 이름이 다른 심볼로 갈아타면 참조 해석이 끊기고,
 *       그 순간 이 층은 보고 있다고 믿으면서 아무것도 보지 않는다.
 *   (b) 필드 가방은 **인라인 객체 리터럴**이다 — 변수든 함수 호출이든 스프레드든,
 *       리터럴이 아니면 키 집합을 정적으로 볼 수 없다.
 *
 * **여전히 못 잡는 것**(제목을 과장하지 않기 위해 적는다):
 *   - `src/**` **밖**. `test/`·`scripts/` 는 대상이 아니다 — 거기서 새는 것은 PII 가
 *     아니라 테스트 픽스처다.
 *   - 동적 `import()` 후 인덱스 접근(`(await import('…'))['log'](…)`). 식별자 해석이
 *     닿지 않는다. `.dependency-cruiser.cjs` 의 순환·고아 규칙과 `no-orphans` 가
 *     그런 모듈을 별도로 시끄럽게 만든다.
 *   - 리터럴 **안의 값**이 무엇인지. `detail: someObject` 는 키가 어휘 안이므로 여기를
 *     통과한다 — 그것이 ②(`redact`)의 몫이고, 비스칼라 거부가 거기 있다.
 */
describe('observability — PII 규율 ③ 호출부가 어휘를 우회할 수 없다', () => {
  it('검사 대상 호출부가 존재한다 — 0건이면 이 층은 공허하다', () => {
    // Layer F 와 같은 이유의 단언이다. 배선이 빠지거나 함수 이름이 바뀌면
    // 아래 단언들은 빈 배열을 빈 배열과 비교하며 영원히 초록이 된다.
    expect(observabilityCallSites().length).toBeGreaterThan(0);

    // **세 함수가 각각 실제로 불린다.** 합계만 보면 `log` 만 남고 메트릭 두 함수가
    // 호출부에서 사라져도 이 단언이 통과한다.
    const byCallee = new Set(observabilityCallSites().map((site) => site.callee));
    expect([...byCallee].sort()).toEqual(['countMetric', 'emitMetric', 'log']);
  });

  it('필드 가방의 인자 위치가 실제 시그니처와 일치한다 (표류 방지)', () => {
    // 이 표가 틀리면 아래 단언들이 **엉뚱한 인자**를 검사하며 조용히 통과한다.
    const mismatched: string[] = [];
    for (const entry of OBSERVABILITY_FUNCTIONS) {
      const parameter = declaredFunction(entry).getParameters()[entry.fieldIndex];
      const actual = parameter?.getName();
      if (actual !== entry.parameterName) {
        mismatched.push(`${entry.file}#${entry.name}[${String(entry.fieldIndex)}] = ${actual ?? '<없음>'}`);
      }
    }
    expect(mismatched).toEqual([]);
  });

  it('관측 함수는 호출 자리에만 등장한다 — 별칭·재바인딩으로 이름을 갈아탈 수 없다', () => {
    const offenders: string[] = [];
    for (const reference of observabilityReferences()) {
      if (calleePositionOf(reference) !== undefined) continue;
      if (isPlainImportName(reference)) continue;
      offenders.push(
        `${reference.file}:${String(reference.node.getStartLineNumber())}: ${reference.entry.name} 이 호출이 아닌 자리에 있다`,
      );
    }

    // `import { log as l }` 도, `const l = log` 도 여기서 죽는다. 둘 다 새 심볼을
    // 만들고, 새 심볼로 간 호출은 아래 단언들의 참조 집합에 들어오지 않는다.
    expect(offenders).toEqual([]);
  });

  it('필드 가방은 인라인 객체 리터럴이다 — 변수로 올리면 아래 세 단언이 전부 우회된다', () => {
    const offenders: string[] = [];
    for (const site of observabilityCallSites()) {
      // 생략은 허용된다 — 기본값 `{}` 이고, 담긴 것이 없으므로 셀 것도 없다.
      if (site.argument === undefined) continue;
      if (Node.isObjectLiteralExpression(site.argument)) continue;
      offenders.push(`${site.file}: ${site.callee}(… ${site.argument.getText().slice(0, 40)})`);
    }
    expect(offenders).toEqual([]);
  });

  it('필드 리터럴에 스프레드가 없다 — 닫힌 어휘를 타입 수준에서 뚫는 유일한 구멍이다', () => {
    const offenders = fieldLiterals()
      .filter((site) => site.literal.getProperties().some((property) => Node.isSpreadAssignment(property)))
      .map((site) => `${site.file}: ${site.callee}(... { ...spread })`);

    // `log('x', { ...error })` 한 줄이면 오류 객체의 모든 필드가 로그로 간다.
    expect(offenders).toEqual([]);
  });

  it('필드 리터럴에 계산된 키가 없다 — 키가 런타임 값이면 어휘는 어휘가 아니다', () => {
    const offenders = fieldLiterals()
      .filter((site) =>
        site.literal
          .getProperties()
          .some((property) => property.getFirstChildByKind(SyntaxKind.ComputedPropertyName) !== undefined),
      )
      .map((site) => `${site.file}: ${site.callee}`);

    expect(offenders).toEqual([]);
  });

  it('호출부가 쓰는 키는 전부 어휘 안에 있다', () => {
    const vocabulary = new Set<string>([...LOG_FIELD_KEYS, ...METRIC_DIMENSION_KEYS]);
    const offenders: string[] = [];

    for (const site of fieldLiterals()) {
      for (const property of site.literal.getProperties()) {
        if (!Node.isPropertyAssignment(property) && !Node.isShorthandPropertyAssignment(property)) continue;
        const name = property.getName().replace(/^['"]|['"]$/g, '');
        if (!vocabulary.has(name)) offenders.push(`${site.file}: ${site.callee}({ ${name} })`);
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe('observability — audit 과 log 의 경계 (§4.3)', () => {
  it('관측 모듈 파일이 실재한다', () => {
    // ac0-metrics.ts (GATE): AC-0 지표의 **순수 계산**만 있다 — 조회는 `src/gate/ac0-store.ts` 가 한다.
    //   이 디렉터리에 들어왔으므로 아래 "저장소를 import 하지 않는다" 단언을 똑같이 받는다.
    expect(observabilityFiles()).toEqual([
      'src/observability/ac0-metrics.ts',
      'src/observability/logger.ts',
      'src/observability/metrics.ts',
    ]);
  });

  it('저장소·본문·전송단·AWS SDK 를 import 하지 않는다', () => {
    const project = srcSourceFiles();
    const offenders: string[] = [];

    for (const file of observabilityFiles()) {
      const source = project.find((candidate) => toRepoRelative(candidate.getFilePath()) === file);
      if (source === undefined) continue;

      for (const specifier of moduleSpecifiersOf(source)) {
        for (const pattern of FORBIDDEN_IMPORT_PATTERNS) {
          if (pattern.test(specifier)) offenders.push(`${file} → ${specifier} (${pattern.label})`);
        }
      }
    }

    // **쓸 수 있는 저장소가 없다는 것이 이 단언의 내용이다.** 로그가 audit 을 대신할
    // 수 있다고 읽히는 순간 audit INSERT 실패가 시도를 멈출 이유가 없어지고,
    // 다음 장애에서 법적 기록은 0행이 된다(§4.3 · Principle P3).
    expect(offenders).toEqual([]);
  });

  it('dependency-cruiser 가 같은 금지를 이중으로 집행한다 (단일 집행 해소)', () => {
    // Layer A 의 SES 경계는 *"증명이 단일 설정에 의존하면 증명이 아니다"* 라며 ts-morph 와
    // dependency-cruiser 두 구현을 뒀는데, 바로 위 단언은 **한쪽뿐이었다.**
    // `.dependency-cruiser.cjs` 에 `no-storage-in-observability` 를 더해 대칭을 맞춘다.
    const config = createRequire(import.meta.url)(repoPath('.dependency-cruiser.cjs')) as {
      readonly forbidden?: readonly {
        readonly name?: string;
        readonly to?: { readonly path?: string | readonly string[] };
      }[];
    };
    const rule = (config.forbidden ?? []).find((entry) => entry.name === 'no-storage-in-observability');
    expect(rule, '`no-storage-in-observability` 규칙이 없다 — 이 금지는 다시 단일 집행이다').toBeDefined();

    const targets = [rule?.to?.path ?? []].flat();
    expect(targets).toContain('^src/db/');

    // **npm 표적은 `node_modules/<name>/` 여야 한다.** dependency-cruiser 는 모듈 이름이
    // 아니라 **해석된 경로**에 대조하므로 `'^pg'` 같은 패턴은 어떤 의존성과도 매칭되지
    // 않는다 — 그리고 "위반 0건" 과 "검사 0건" 이 같은 출력이라 아무도 모른다.
    // 실제로 `no-ses-sdk-outside-transport` 가 그 상태로 P0 이래 잠들어 있었다(2026-09-22).
    expect(targets.some((target) => target.startsWith('node_modules/'))).toBe(true);
  });
});

/**
 * **운영자 콘솔 메트릭(ADR-0015 · 계획 §3.8 "PII 검사 대상에 `src/ops/**`·ops 핸들러·메일러 운영 워커를 더한다").**
 *
 * `src/ops/metrics.ts` 는 전역 차원 어휘(`METRIC_DIMENSION_KEYS` — 위 골든 스냅샷)를 넓히지 않으려고 **자기 EMF 한 줄**을 쓴다
 * (`emitOpsMetric`·`countOpsMetric`, 차원 `action`·`reason`·`code` — 전부 닫힌 유니온). 그 우회로가 이 파일의 ③ 규율 밖에 있으면
 * 운영자 주소·조직 id 를 차원으로 싣는 한 줄이 아무 단언에도 걸리지 않는다. 그래서 같은 규율을 이 두 함수에도 건다:
 * 닫힌 어휘 골든 스냅샷 · 금지 어간 · 호출 자리 전용 · 인라인 리터럴 · 스프레드·계산된 키 없음 · 어휘 안의 키만 · 저장소 import 없음.
 * `log()` 호출은 `src/ops/**`·핸들러·메일러 워커에서도 이미 위 ③ 이 본다(참조 해석은 `src/**` 전체다).
 */
const OPS_METRICS_FILE = 'src/ops/metrics.ts';
const OPS_OBSERVABILITY_FUNCTIONS: readonly ObservabilityFunction[] = [
  { file: OPS_METRICS_FILE, name: 'countOpsMetric', fieldIndex: 1, parameterName: 'dimensions' },
  { file: OPS_METRICS_FILE, name: 'emitOpsMetric', fieldIndex: 2, parameterName: 'dimensions' },
];
const FROZEN_OPS_METRIC_DIMENSION_KEYS: readonly string[] = ['action', 'reason', 'code'];

describe('observability — 운영자 콘솔 메트릭(src/ops/metrics.ts)도 같은 PII 규율 (ADR-0015)', () => {
  const references = (): Reference[] => observabilityReferences(OPS_OBSERVABILITY_FUNCTIONS, new Set([OPS_METRICS_FILE]));
  const sites = (): CallSite[] => observabilityCallSites(references());

  it('차원 어휘가 골든 스냅샷과 같다 · 내용물 어간·식별자(주소·운영자·조직·세션·요청자) 없음', () => {
    expect([...OPS_METRIC_DIMENSION_KEYS]).toEqual(FROZEN_OPS_METRIC_DIMENSION_KEYS);
    const offenders = OPS_METRIC_DIMENSION_KEYS.filter(
      (key) => FORBIDDEN_KEY_STEMS.some((stem) => key.includes(stem)) || /agent|operator|org|session|client|user|ip|id$/.test(key),
    );
    expect(offenders).toEqual([]);
  });

  it('필드 가방의 인자 위치가 실제 시그니처와 일치한다 (표류 방지)', () => {
    for (const entry of OPS_OBSERVABILITY_FUNCTIONS) {
      expect(declaredFunction(entry).getParameters()[entry.fieldIndex]?.getName(), `${entry.name}[${String(entry.fieldIndex)}]`).toBe(entry.parameterName);
    }
  });

  it('호출부 비공허 — ops 핸들러가 있으면 호출부가 있다', () => {
    // 호스팅 입구(`handlers/ops.ts`, W-APP)가 들어오면 메트릭 호출이 반드시 있다 — 0건이면 아래 단언은 공허하다.
    if (repoFileExists('src/runtime/handlers/ops.ts')) expect(sites().length).toBeGreaterThan(0);
    // 정의 파일은 늘 있다(알람의 이름 원천).
    expect(repoFileExists(OPS_METRICS_FILE)).toBe(true);
  });

  it('호출 자리에만 등장 · 인라인 리터럴 · 스프레드·계산된 키 없음 · 키는 ops 어휘 안', () => {
    const offenders: string[] = [];
    for (const reference of references()) {
      if (calleePositionOf(reference) === undefined && !isPlainImportName(reference)) {
        offenders.push(`${reference.file}:${String(reference.node.getStartLineNumber())}: ${reference.entry.name} 이 호출이 아닌 자리에 있다`);
      }
    }
    const vocabulary = new Set<string>(OPS_METRIC_DIMENSION_KEYS);
    for (const site of sites()) {
      if (site.argument === undefined) continue;
      if (!Node.isObjectLiteralExpression(site.argument)) {
        offenders.push(`${site.file}: ${site.callee}(… ${site.argument.getText().slice(0, 40)})`);
        continue;
      }
      for (const property of site.argument.getProperties()) {
        if (Node.isSpreadAssignment(property)) offenders.push(`${site.file}: ${site.callee}({ ...spread })`);
        if (property.getFirstChildByKind(SyntaxKind.ComputedPropertyName) !== undefined) offenders.push(`${site.file}: ${site.callee}({ [computed] })`);
        if (!Node.isPropertyAssignment(property) && !Node.isShorthandPropertyAssignment(property)) continue;
        const name = property.getName().replace(/^['"]|['"]$/g, '');
        if (!vocabulary.has(name)) offenders.push(`${site.file}: ${site.callee}({ ${name} })`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('src/ops/metrics.ts 는 저장소·본문·전송단·AWS SDK 를 import 하지 않는다', () => {
    const source = srcSourceFiles().find((file) => toRepoRelative(file.getFilePath()) === OPS_METRICS_FILE);
    expect(source, `${OPS_METRICS_FILE} 을 ts-morph 가 읽지 못했다`).toBeDefined();
    if (source === undefined) return;
    const offenders: string[] = [];
    for (const specifier of moduleSpecifiersOf(source)) {
      for (const pattern of FORBIDDEN_IMPORT_PATTERNS) if (pattern.test(specifier)) offenders.push(`${specifier} (${pattern.label})`);
    }
    expect(offenders).toEqual([]);
  });
});
