/**
 * 공개 표면의 사람용 문장(`detail`·안내·MCP 도구 설명)에 **내부 사정이 새지 않는다**.
 *
 * 공개 API(`/v1/**`)·MCP 도구 결과·공개 신원(`/v1/identity`)의 `detail` 은 에이전트 컨텍스트와 사용자 문서로 그대로 복제된다. 그 문장에
 * 공급자 이름(SES·SQS·S3 …)·테이블/컬럼/역할 이름·계획/ADR/런북 절 번호·관문 단계 번호·파일 경로·환경 변수 이름이 있으면 우리 구조를
 * 밖에 적어 주는 셈이다. 또 공개 API 는 영어가 계약이다(`/en/api` 문서 · MCP 도구 문구) — 한국어 문장도 남지 않는다.
 *
 * **모으는 법(정적).** 공개 모듈의 TypeScript AST 에서 "응답으로 나가는 자리" 의 문자열만 모은다:
 *   ① 오류 응답을 만드는 호출(`errorResponse`·`failure`·`badRequest`·`reject` …)의 인자,
 *   ② `detail`·`next_step`·`secret_notice`·`description`·`message` 속성 값,
 *   ③ 이름이 안내 문장임을 말하는 상수·함수(`…_HINT`·`…Detail`·`SEND_OUTCOMES` …)의 값·반환.
 * 로그·메트릭 호출 안은 뺀다(운영자용이다). 템플릿 리터럴은 글자 부분만 보고 `${…}` 는 자리표시로 둔다.
 * **모으는 법(실행).** MCP 도구 목록(`MCP_TOOLS`)의 설명·인자 설명을 그대로 본다.
 *
 * 수집기가 조용히 비지 않게 — 총량 하한과 "이 파일은 적어도 하나를 내야 한다" 목록을 함께 단언한다.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { MCP_TOOLS } from '../../../src/mcp/tools';
import { PUBLIC_IDENTITY_NOT_FOUND } from '../../../src/passport/public-view';

const ROOT = join(__dirname, '..', '..', '..');

function walk(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : entry.name.endsWith('.ts') ? [join(dir, entry.name)] : [],
  );
}

/** 공개 표면의 소스. 콘솔 관리 API(`src/admin/**`)는 범위 밖이다. */
const PUBLIC_FILES = [...walk('src/api'), ...walk('src/mcp'), 'src/runtime/router.ts', 'src/passport/public-view.ts'].sort();

/** 오류 응답·도구 오류를 만드는 호출 — 인자 안의 문자열은 전부 응답으로 나간다. */
const SINK_CALLS = new Set([
  'errorResponse',
  'failure',
  'badRequest',
  'reject',
  'invalid',
  'fail',
  'errorResult',
  'routeError',
  'rpcError',
  'jsonRpcError',
  'toolError',
  'ToolArgumentError',
]);
/** 값이 사람용 문장인 속성. */
const SINK_PROPERTIES = new Set(['detail', 'next_step', 'secret_notice', 'notice', 'description', 'message']);
/** 이름이 안내 문장임을 말하는 상수·함수. */
const SINK_NAME = /(HINT|Hint|DETAIL|Detail|NOTICE|Notice|OUTCOMES|UNTRUSTED|Pointer|Rejection)$/;
/** 운영자용 — 밖으로 나가지 않는다. */
const SKIP_CALLS = new Set(['log', 'countMetric', 'emitMetric', 'record', 'reportBudget']);

function calleeName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

function propertyName(name: ts.PropertyName): string | null {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null;
}

function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.map((span) => `\${…}${span.literal.text}`)].join('');
  return null;
}

interface Collected {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

function collect(file: string): Collected[] {
  const source = readFileSync(join(ROOT, file), 'utf8');
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const out: Collected[] = [];

  const take = (node: ts.Node): void => {
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
        const name = calleeName(n.expression);
        if (name !== null && SKIP_CALLS.has(name)) return;
      }
      const text = literalText(n);
      if (text !== null) {
        // 텍스트 조각끼리의 `+` 결합은 이어진 한 문장이지만 조각별로 봐도 단어 단위 검사에는 충분하다.
        if (text.trim() !== '') out.push({ file, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, text });
        return;
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const name = calleeName(node.expression);
      if (name !== null && SKIP_CALLS.has(name)) return;
      // 맨 이름 호출만(`reject(…)`) — `Promise.reject(…)` 같은 메서드는 응답 문장이 아니다.
      if (name !== null && SINK_CALLS.has(name) && ts.isIdentifier(node.expression)) {
        for (const arg of node.arguments ?? []) take(arg);
        return;
      }
    }
    if (ts.isPropertyAssignment(node)) {
      const name = propertyName(node.name);
      if (name !== null && SINK_PROPERTIES.has(name)) {
        take(node.initializer);
        return;
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && SINK_NAME.test(node.name.text) && node.initializer !== undefined) {
      take(node.initializer);
      return;
    }
    if (ts.isFunctionDeclaration(node) && node.name !== undefined && SINK_NAME.test(node.name.text) && node.body !== undefined) {
      take(node.body);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const STATIC = PUBLIC_FILES.flatMap(collect);

/** MCP 도구 설명 — 실행 값 그대로(설명은 여러 상수를 이어 붙여 만든다). */
const RUNTIME: Collected[] = MCP_TOOLS.flatMap((tool) => {
  const properties = (tool.inputSchema as { properties?: Record<string, { description?: string }> }).properties ?? {};
  return [
    { file: `MCP_TOOLS.${tool.name}`, line: 0, text: tool.description },
    ...Object.entries(properties).flatMap(([key, value]) =>
      value.description === undefined ? [] : [{ file: `MCP_TOOLS.${tool.name}.${key}`, line: 0, text: value.description }],
    ),
  ];
});

const ALL = [...STATIC, ...RUNTIME, { file: 'PUBLIC_IDENTITY_NOT_FOUND', line: 0, text: PUBLIC_IDENTITY_NOT_FOUND.detail }];

/** DB 테이블 이름 — 마이그레이션의 `CREATE TABLE` 에서 읽는다. */
const ALL_TABLES = [
  ...new Set(
    readdirSync(join(ROOT, 'src/db/migrations'))
      .filter((name) => name.endsWith('.sql'))
      .flatMap((name) => [...readFileSync(join(ROOT, 'src/db/migrations', name), 'utf8').matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(?:public\.)?"?([a-z_]+)"?/g)])
      .map((match) => match[1] ?? ''),
  ),
].filter((name) => name !== '');
/** 이름만으로 금지하는 것은 밑줄이 있는 이름뿐이다(`messages`·`threads` 같은 한 단어는 일반 영어와 겹친다). `테이블.컬럼` 은 전부 금지. */
const TABLES = ALL_TABLES.filter((name) => name.includes('_'));

const FORBIDDEN: readonly { readonly why: string; readonly re: RegExp }[] = [
  {
    why: 'AWS·인프라 이름',
    re: /\b(?:AWS|SES|SQS|SNS|S3|KMS|RDS|Aurora|DynamoDB|Lambda|GuardDuty|CloudFront|CloudWatch|EventBridge|API Gateway|Postgres(?:QL)?|pgvector)\b/,
  },
  { why: '계획·ADR·런북 참조', re: /계획\s*§|§|\bADR-?\d|런북|\brunbooks?\b|\.omc\b/i },
  { why: '관문 단계·내부 단계 번호', re: /\bStage\s*\d|관문|단계\s*\d|\bP\d[a-z]?\b|\bAC-[a-z]?\d|\bUS-\d{3}\b/ },
  { why: '파일 경로', re: /\bsrc\/|\btest\/|\.tsx?\b|\.sql\b/ },
  { why: 'SQL·스키마 용어', re: /\b(?:CHECK|INSERT|UPDATE|SELECT|DELETE FROM|UNIQUE)\b|\b(?:table|column)s?\b|\brows?\b|\bschema\b/ },
  { why: 'DB 역할', re: /\batmark_(?:app|owner|migrator|admin|readonly|[a-z]+_role)\b/ },
  { why: '환경 변수·플래그 이름', re: /process\.env|\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+\b/ },
  { why: '내부 구현 용어', re: /\b(?:manifest|lease|at-least-once|exactly-once|outbox|warm-?up|snapshot|thin slice)\b|매니페스트|워밍업|멱등 키 충돌/i },
  { why: '테이블 이름', re: new RegExp(`\\b(?:${TABLES.join('|')})\\b`) },
  { why: '테이블.컬럼', re: new RegExp(`\\b(?:${ALL_TABLES.join('|')})\\.[a-z_]+\\b`) },
  { why: '한국어(공개 API 는 영어)', re: /[가-힣]/ },
];

function violations(items: readonly Collected[]): string[] {
  return items.flatMap((item) =>
    FORBIDDEN.filter(({ re }) => re.test(item.text)).map(({ why }) => `${item.file}:${String(item.line)} [${why}] ${item.text}`),
  );
}

describe('공개 detail 장막(veil) — 내부 사정이 새지 않는다', () => {
  it('수집기가 비지 않는다 — 총량 하한과 반드시 문장을 내는 파일', () => {
    expect(TABLES.length).toBeGreaterThan(20);
    expect(STATIC.length).toBeGreaterThan(200);
    expect(RUNTIME.length).toBeGreaterThan(30);
    const mustContribute = [
      'src/api/http.ts',
      'src/api/auth.ts',
      'src/api/outbound-http.ts',
      'src/api/outbound-service.ts',
      'src/api/outbound-attachments.ts',
      'src/runtime/router.ts',
      'src/mcp/tools.ts',
      'src/mcp/server.ts',
      // 오류 응답을 내는 공개 라우트 전부.
      ...walk('src/api/routes').filter((file) => /errorResponse\(|badRequest\(|fail\(/.test(readFileSync(join(ROOT, file), 'utf8'))),
    ];
    const contributing = new Set(STATIC.map((item) => item.file));
    expect(mustContribute.filter((file) => !contributing.has(file))).toEqual([]);
    expect(mustContribute.length).toBeGreaterThan(15);
  });

  it('금지어 검사기가 실제로 잡는다(자기 검사)', () => {
    const planted = [
      'Idempotency-Key 헤더가 필요하다 (계획 §4.5-1). SQS 는 at-least-once 이고',
      'must be 1~255 (messages.idempotency_key CHECK)',
      'blocked at Stage 6',
      'see src/api/http.ts',
      'set ATMARK_ATTACHMENTS_ENABLED',
      'policy_versions snapshot is broken',
      'see ADR-0007',
      'subject must be short (messages.subject)',
    ].map((text) => ({ file: 'planted', line: 0, text }));
    expect(planted.filter((item) => violations([item]).length === 0).map((item) => item.text)).toEqual([]);
  });

  it('공개 detail·안내·도구 설명에 공급자·DB·계획 참조·단계·경로·환경 변수 이름이 없고 영어다', () => {
    expect(violations(ALL)).toEqual([]);
  });

  it('수집 대상 파일은 공개 표면 전부다(admin 제외)', () => {
    expect(PUBLIC_FILES.some((file) => file.startsWith('src/admin'))).toBe(false);
    expect(PUBLIC_FILES.map((file) => relative('.', file))).toContain('src/api/routes/identity.ts');
  });
});
