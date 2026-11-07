/**
 * 키 불변 chokepoint — AC-13 의 AC-8 대응물 (계획 §5.0b Layer P2 4번 · §4B.1).
 *
 * **주장 넷:**
 *   ① `agent_keypairs` 의 `public_key`·**`key_ref`**·`algorithm` 에 쓰는 코드 경로가
 *      `src/passport/keypair.ts#issueAtProvisioning` 외에 **0개**다.
 *   ② 회전·재발급·삭제 함수가 **아예 존재하지 않는다**.
 *   ③ **체인 SDK import 0건** (ethers·viem·web3 …). 승격은 P6 이후의 일이고, SDK 가
 *      들어온 순간 "지금 앵커하지 않는다"는 §3.6 의 판단이 코드로 반증된다.
 *   ④ **개인키가 DB 에 들어가는 경로가 0개**다 — 로컬 개발 구현에도 적용된다.
 *
 * ---
 *
 * **참조 집합(reference-set)으로 쓴다. 호출 지점 스캔(`isCallee()`)은 쓰지 않는다.**
 *
 * 이 리포에서 호출 지점 스캔은 **두 번 뚫렸다**(`test/unit/policy/type-discipline.test.ts`
 * 머리말의 구멍 ④): `const { x } = M` 구조분해와 `const y = x` 재바인딩은 **새 심볼**을
 * 만들어서 선언의 참조 목록에 호출 지점이 나타나지 않는다. 근본 원인은 "호출"을 세려는
 * 순간 **호출의 모양**에 의존하게 된다는 것이고, 모양은 언제든 다르게 쓸 수 있다.
 *
 * 참조 집합은 그 축이 없다: **`issueAtProvisioning` 이 아닌 파일이 `InsertAgentKeypairInput`
 * 이라는 이름을 안다는 것 자체가 실패할 가치가 있는 일**이다. 구성상 표기법 독립적이다.
 *
 * **이 층이 못 잡는 것** (다음 사람이 같은 실수를 반복하지 않도록 적어 둔다):
 *   - 문자열로 조립한 동적 SQL(`'UPDATE ' + table + ' SET ...'`). 식별자가 아니라
 *     문자열이므로 해석되지 않는다. 그 우회는 DB 트리거와 앱 롤 권한이 막는다
 *     (`test/integration/passport/keypair-immutability.test.ts` 가 실측한다).
 *   - `src/` **밖**. `scripts/`·`infra/`·`test/` 는 대상이 아니다 — 이들은 앱 롤로
 *     돌지만 발급 경로가 아니고, 발급이 거기서 일어나면 그건 Layer C 의 문제다.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Node, SyntaxKind, type SourceFile } from 'ts-morph';

import { AGENT_KEYPAIR_COLUMNS } from '../../src/db/schema';
import { getProject, moduleSpecifiersOf, repoPath, srcSourceFiles, toRepoRelative } from './support/project';

const KEYPAIR_FILE = 'src/passport/keypair.ts';
const CUSTODY_FILE = 'src/passport/custody.ts';
const LOCAL_CUSTODY_FILE = 'src/passport/custody-local.ts';
const DID_FILE = 'src/passport/did.ts';
const STORE_FILE = 'src/api/provisioning-store.ts';
const PROVISIONING_FILE = 'src/identity/provisioning.ts';
const MIGRATION = 'src/db/migrations/202609221600_agent_keypairs_and_passports.sql';

function sourceFile(relativePath: string): SourceFile {
  const found = getProject()
    .getSourceFiles()
    .find((file) => toRepoRelative(file.getFilePath()) === relativePath);
  if (!found) throw new Error(`${relativePath} 을 ts-morph 가 읽지 못했다 — 이 층이 통째로 공허해진다.`);
  return found;
}

/**
 * 선언된 이름을 **참조하는** `src/**` 파일 목록 (선언부 자신은 제외).
 *
 * `findReferencesAsNodes()` 는 식별자를 **해석**하므로 별칭 import·네임스페이스 접근에
 * 흔들리지 않는다. 정규식으로 글자를 세는 것과의 차이가 여기다.
 */
function filesReferencing(declaringFile: string, name: string): string[] {
  const file = sourceFile(declaringFile);
  const declaration =
    file.getInterface(name) ??
    file.getFunction(name) ??
    file.getClass(name) ??
    file.getTypeAlias(name) ??
    file.getVariableDeclaration(name);
  if (!declaration) {
    throw new Error(`${declaringFile} 에 ${name} 선언이 없다 — 이 가드가 통째로 공허해진다.`);
  }

  return referrersOf(declaration, declaringFile);
}

/**
 * 선언 노드의 이름 식별자를 해석해 참조 파일 집합을 만든다.
 *
 * `getNameNodeOrThrow` 를 쓰지 않는 이유: ts-morph 에서 그 메서드는 선언 종류마다
 * 있기도 없기도 하다(인터페이스·프로퍼티 시그니처에는 없다). 없는 선언에서 던지면
 * 이 가드는 "위반 없음" 이 아니라 **에러**로 죽는데, 그 차이가 리뷰에서 흐려진다.
 */
function referrersOf(declaration: Node, declaringFile: string): string[] {
  const nameNode = (declaration as { getNameNode?: () => Node | undefined }).getNameNode?.();
  if (nameNode === undefined) {
    throw new Error(`${declaringFile} 의 선언에서 이름 노드를 얻지 못했다 — 이 가드가 공허해진다.`);
  }

  const files = new Set<string>();
  const referencable = nameNode as unknown as { findReferencesAsNodes: () => Node[] };
  for (const reference of referencable.findReferencesAsNodes()) {
    const relativePath = toRepoRelative(reference.getSourceFile().getFilePath());
    if (!relativePath.startsWith('src/')) continue;
    if (relativePath === declaringFile) continue;
    files.add(relativePath);
  }
  return [...files].sort();
}

/**
 * 파일 안의 **문자열 리터럴** 전부(템플릿 포함). 주석은 노드가 아니므로 들어오지 않는다 —
 * "주석에 적힌 예시"와 "코드가 실제로 조립하는 값"을 구분하려면 이 층위여야 한다.
 */
function stringLiteralsOf(file: SourceFile): string[] {
  const out: string[] = [];
  file.forEachDescendant((node) => {
    if (
      Node.isStringLiteral(node) ||
      Node.isNoSubstitutionTemplateLiteral(node) ||
      Node.isTemplateHead(node) ||
      Node.isTemplateMiddle(node) ||
      Node.isTemplateTail(node)
    ) {
      out.push(node.getLiteralText());
    }
  });
  return out;
}

/** `src/**` 의 모든 함수·메서드·인터페이스 메서드 시그니처 이름. */
function allDeclaredNames(): { readonly file: string; readonly name: string }[] {
  const out: { file: string; name: string }[] = [];
  for (const file of srcSourceFiles()) {
    const relative = toRepoRelative(file.getFilePath());
    file.forEachDescendant((node) => {
      if (Node.isFunctionDeclaration(node) || Node.isMethodDeclaration(node) || Node.isMethodSignature(node)) {
        const name = node.getName();
        if (name !== undefined && name.length > 0) out.push({ file: relative, name });
      }
      if (Node.isPropertyAssignment(node) || Node.isShorthandPropertyAssignment(node)) {
        // 객체 리터럴로 구현된 포트(`return { kind, store(...) {} }`)도 본다.
        out.push({ file: relative, name: node.getName() });
      }
    });
  }
  return out;
}

describe('AC-13 — agent_keypairs 쓰기 경로', () => {
  it('스캐너가 src 전체를 읽고 있다 (공허한 통과 방지)', () => {
    // 목록이 좁아지면 아래 단언들이 "아무것도 검사하지 않고 통과" 로 변한다.
    // 그 상태와 "위반 0건" 을 구분하는 단언이 이것 하나다.
    const files = srcSourceFiles().map((file) => toRepoRelative(file.getFilePath()));
    expect(files.length).toBeGreaterThan(30);
    expect(files).toContain(KEYPAIR_FILE);
    expect(files).toContain(STORE_FILE);
  });

  it('`InsertAgentKeypairInput` 을 아는 파일은 발급 함수와 그 저장소 구현뿐이다', () => {
    // **이 목록이 늘어나는 순간 "키를 쓰는 경로는 하나" 가 거짓이 된다.**
    // 참조 집합이므로 `import { InsertAgentKeypairInput as X }` 도, 구조분해도 잡힌다.
    expect(filesReferencing(KEYPAIR_FILE, 'InsertAgentKeypairInput')).toEqual([STORE_FILE]);
  });

  it('`issueAtProvisioning` 을 아는 파일은 프로비저닝 하나뿐이다 (§4B.1 소급 발급 경로 부재)', () => {
    expect(filesReferencing(KEYPAIR_FILE, 'issueAtProvisioning')).toEqual([PROVISIONING_FILE]);
  });

  it('`agent_keypairs` 에 UPDATE·DELETE 하는 SQL 은 src 전체에 0건이다', () => {
    // 동적 조립까지 덮지는 못하지만(머리말 참조), **리터럴 SQL 은 전부 덮는다.**
    // 그리고 실제로 키를 바꾸려는 코드가 취할 가장 자연스러운 형태가 리터럴이다.
    const offenders: string[] = [];
    for (const file of srcSourceFiles()) {
      const text = file.getFullText();
      if (/UPDATE\s+agent_keypairs|DELETE\s+FROM\s+agent_keypairs|TRUNCATE\s+agent_keypairs/i.test(text)) {
        offenders.push(toRepoRelative(file.getFilePath()));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('`agent_keypairs` 에 INSERT 하는 파일은 저장소 구현 하나뿐이다', () => {
    const writers = srcSourceFiles()
      .filter((file) => /INSERT\s+INTO\s+agent_keypairs/i.test(file.getFullText()))
      .map((file) => toRepoRelative(file.getFilePath()));
    expect(writers).toEqual([STORE_FILE]);
  });

  it('DID 문자열을 조립하는 파일은 did.ts 하나뿐이다 (ADR-0002 경로 동결)', () => {
    // 접두사가 두 곳에 적히면 한 곳만 고쳐지는 날이 온다. 그날 발급되는 DID 는
    // 해석되지 않고, DB CHECK 가 INSERT 에서 죽이기 전까지 아무도 모른다.
    const offenders = srcSourceFiles()
      .filter((file) => toRepoRelative(file.getFilePath()) !== DID_FILE)
      .filter((file) => stringLiteralsOf(file).some((literal) => literal.includes('did:web:')))
      .map((file) => toRepoRelative(file.getFilePath()));
    expect(offenders).toEqual([]);
    // 비공허성: did.ts 자신은 실제로 그 문자열을 들고 있다.
    expect(stringLiteralsOf(sourceFile(DID_FILE)).some((literal) => literal.includes('did:web:'))).toBe(true);
  });
});

describe('AC-13 — 회전·재발급·삭제 함수의 부재', () => {
  /**
   * 이름 패턴. **부재를 증명하는 단언이므로 목록이 곧 보증 범위다.**
   * 여기 없는 이름으로 회전 함수를 만들면 잡히지 않는다 — 그 한계를 알고 쓴다.
   */
  const FORBIDDEN = /^(rotate|regenerate|reissue|renewKey|replaceKey|revokeKey|deleteKeypair|dropKeypair)/i;

  /**
   * 에이전트 키와 **무관한** 이름 — `파일#이름` 정확히, 사유와 함께만 늘린다(와일드카드 없음 — 새 파일·새 이름의 회전 함수는 여전히 빨갛다).
   * 웹훅 시크릿 회전(2026-09-30, ADR-0013 개정)은 엔드포인트 서명 시크릿의 버전을 올릴 뿐 `agent_keypairs` 에 닿지 않는다 — 그 표의 쓰기는 위
   * SQL·참조 단언이 따로 본다. 함수 이름은 `supersede…` 로 피했고, 남는 것은 콘솔 계약(JSON 칸 이름)이 정한 것 하나다.
   */
  const NOT_KEYPAIR_ROTATION: ReadonlySet<string> = new Set([
    // 콘솔 웹훅 목록 계약의 칸 `rotatedAt`(마지막 시크릿 회전 시각 — `src/admin/routes/webhooks.ts` `AdminWebhookItem`).
    'src/admin/routes/webhooks.ts#rotatedAt',
  ]);

  it('src 전체에 회전·재발급·삭제 이름의 함수가 없다', () => {
    const offenders = allDeclaredNames()
      .filter((entry) => FORBIDDEN.test(entry.name))
      .map((entry) => `${entry.file}#${entry.name}`)
      .filter((key) => !NOT_KEYPAIR_ROTATION.has(key));
    expect(offenders).toEqual([]);
    // 예외는 실제로 있는 이름이어야 한다(죽은 예외를 남기지 않는다).
    const declared = new Set(allDeclaredNames().map((entry) => `${entry.file}#${entry.name}`));
    for (const key of NOT_KEYPAIR_ROTATION) expect(declared.has(key), key).toBe(true);
  });

  it('부재 단언이 공허하지 않다 — 같은 스캐너가 실재하는 이름을 찾아낸다', () => {
    // 위 단언은 빈 배열을 기대하므로 스캐너가 통째로 고장 나도 통과한다.
    // 여기서 실재하는 이름 하나를 못 박아 "해석이 실제로 선언을 세고 있다" 를 증명한다.
    const names = allDeclaredNames().filter((entry) => entry.name === 'issueAtProvisioning');
    expect(names.map((entry) => entry.file)).toEqual([KEYPAIR_FILE]);
  });

  it('키 보관 포트에 복호·회전·삭제 메서드가 없다 (§3.5 — 복호는 P6 signer.ts 하나)', () => {
    const custody = sourceFile(CUSTODY_FILE).getInterfaceOrThrow('KeyCustody');
    expect(custody.getMethods().map((method) => method.getName())).toEqual(['store']);
  });

  it('프로비저닝 트랜잭션에 keypair 갱신·삭제 연산이 없다', () => {
    const tx = sourceFile(PROVISIONING_FILE).getInterfaceOrThrow('ProvisioningTransaction');
    const inherited = sourceFile(KEYPAIR_FILE).getInterfaceOrThrow('KeypairIssueTransaction');
    const names = [...tx.getMethods(), ...inherited.getMethods()].map((method) => method.getName());
    expect(names.filter((name) => /keypair|passport/i.test(name)).sort()).toEqual([
      'insertAgentKeypair',
      'insertPassport',
    ]);
  });
});

describe('AC-13 — 체인 SDK import 0건 (§3.6 — 지금 체인을 고르지 않는다)', () => {
  const CHAIN_SDK =
    /^(ethers|viem|web3|wagmi|@ethersproject\/|@solana\/|@wagmi\/|near-api-js|@cosmjs\/|starknet|@alchemy\/|web3modal)/;

  it('src 어디에서도 체인 SDK 를 import 하지 않는다', () => {
    const offenders: string[] = [];
    for (const file of srcSourceFiles()) {
      for (const specifier of moduleSpecifiersOf(file)) {
        if (CHAIN_SDK.test(specifier)) {
          offenders.push(`${toRepoRelative(file.getFilePath())}: ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('package.json 의 의존성에도 체인 SDK 가 없다', () => {
    // import 가 0건이어도 의존성에 들어와 있으면 다음 사람은 "이미 있으니까" 쓴다.
    const manifest = JSON.parse(readFileSync(repoPath('package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const names = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
    ];
    expect(names.filter((name) => CHAIN_SDK.test(name))).toEqual([]);
  });
});

describe('§3.5 AC-e1 — 개인키가 DB 에 들어가는 경로 0개', () => {
  it('`PrivateKeyMaterial` 을 아는 파일은 src/passport/** 뿐이다', () => {
    // DB 저장소(`provisioning-store.ts`)가 이 타입을 **모른다**는 것이 요점이다.
    // 알면 언젠가 쿼리 파라미터 자리에 들어간다.
    const referrers = filesReferencing(CUSTODY_FILE, 'PrivateKeyMaterial');
    expect(referrers.filter((file) => !file.startsWith('src/passport/'))).toEqual([]);
    // 비공허성: 실제로 두 파일이 쓰고 있다(발급자와 운영 구현).
    // P6 — 서명기(signer.ts)가 복호한 키를 이 클래스에 담아 서명 직후 지운다.
    expect(referrers).toEqual([LOCAL_CUSTODY_FILE, 'src/passport/custody-aws.ts', KEYPAIR_FILE, 'src/passport/signer.ts'].sort());
  });

  it('DB 에 들어가는 것은 `KeyRef` 하나다 — 발급 입력에 개인키 필드가 없다', () => {
    const input = sourceFile(KEYPAIR_FILE).getInterfaceOrThrow('InsertAgentKeypairInput');
    expect(input.getProperties().map((property) => property.getName()).sort()).toEqual([
      'agentId',
      'algorithm',
      'keyRef',
      'publicKey',
    ]);
  });

  it('`agent_keypairs` 컬럼 화이트리스트에 개인키성 컬럼이 없다', () => {
    // 부분집합이 아니라 **동일**을 단언하는 이유는 `AGENT_KEYPAIR_COLUMNS` 주석에 있다:
    // 여기서 잡으려는 사고는 컬럼이 빠지는 것이 아니라 **늘어나는 것**이다.
    expect([...AGENT_KEYPAIR_COLUMNS]).toEqual([
      'agent_id',
      'public_key',
      'algorithm',
      'key_ref',
      'created_at',
    ]);
    const sql = readFileSync(repoPath(MIGRATION), 'utf8');
    for (const forbidden of ['private_key', 'secret_key', 'ciphertext', 'encrypted_key', 'key_material']) {
      expect(sql).not.toContain(forbidden);
    }
  });

  it('`PrivateKeyMaterial` 은 직렬화되지 않는다 — toJSON/toString 이 존재한다', () => {
    // 구조화 로그·에러 컨텍스트·vitest diff 어디에 실려도 평문이 나가지 않게 하는 층.
    const material = sourceFile(CUSTODY_FILE).getClassOrThrow('PrivateKeyMaterial');
    const methods = material.getMethods().map((method) => method.getName()).sort();
    expect(methods).toEqual(['expose', 'toJSON', 'toString', 'wipe']);
  });
});

describe('§3.5 — 로컬 개발 구현의 운영 가드', () => {
  it('`custody-local.ts` 가 운영 가드를 **두 번** 부른다 (팩토리 + store)', () => {
    // 팩토리에서만 부르면 장기 실행 프로세스가 나중에 운영 설정을 받는 구성에서
    // 통과한다. 두 호출의 존재를 세는 이유가 그것이다.
    //
    // **호출식을 센다. 정규식으로 글자를 세지 않는다.** 이전 판정은
    // `/assertNotProduction\(/g` 를 **파일 전문**(주석 포함)에 걸었고, 깨끗한 파일에서
    // 매칭 3개 중 하나가 머리말 주석이었다 — 실제 호출 하나를 지워도 2가 남아
    // **통과했다.** 그 단언의 존재 이유가 정확히 "하나만 부르는 상태의 검출" 이므로
    // 그 상태에서 이 단언은 거짓이었다. 바로 아래 `/decrypt/i` 스캔이 *"식별자와
    // 문자열만 본다"* 며 주석을 뺀 것과 같은 처리를 여기에도 한다.
    const calls = sourceFile(LOCAL_CUSTODY_FILE)
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .filter((call) => call.getExpression().getText() === 'assertNotProduction');
    expect(calls.length).toBeGreaterThanOrEqual(2);

    // **두 번이 서로 다른 자리여야 한다.** 첫 인자는 호출 지점의 이름이고, 같은 이름이
    // 두 번이면 "팩토리 + store" 가 아니라 한 자리에서 두 번 부른 것이다.
    const labels = new Set(calls.map((call) => call.getArguments()[0]?.getText() ?? '<없음>'));
    expect(labels.size).toBeGreaterThanOrEqual(2);
  });

  it('로컬 구현을 아는 프로덕션 코드가 없다 — 운영 배선에 등장할 수 없다', () => {
    // `src/**` 에서 이 파일을 import 하는 곳이 0이면, 로컬 구현이 운영 경로에 실리려면
    // 누군가 **명시적으로 배선을 바꿔야** 한다. 조용히 폴백되는 경로가 없다는 뜻이다.
    // (테스트·데모 스크립트는 `src/` 밖이므로 이 집합에 들어오지 않는다.)
    expect(filesReferencing(LOCAL_CUSTODY_FILE, 'createLocalDevKeyCustody')).toEqual([]);
  });

  it('`decrypt` 를 아는 파일은 signer.ts 하나뿐이다 (§3.5 AC-e2 — 복호는 P6 signer.ts)', () => {
    // **식별자와 문자열만 본다.** 주석에는 "복호는 signer.ts 가 한다" 는 설명이 당연히
    // 있고, 그것까지 세면 이 단언은 설명을 지우도록 압력을 가한다.
    const offenders: string[] = [];
    for (const file of srcSourceFiles()) {
      const relative = toRepoRelative(file.getFilePath());
      const identifiers = file
        .getDescendantsOfKind(SyntaxKind.Identifier)
        .map((node) => node.getText());
      const literals = stringLiteralsOf(file);
      // `WithDecryption` 은 SSM `GetParameter` 의 옵션(SecureString 을 SSM 이 풀어 준다 — `runtime/secrets.ts`, 2026-10-12 비밀 → SSM 이전)이다.
      //   envelope 키 복호가 아니므로 세지 않는다 — 그 밖의 `decrypt` 는 그대로 잡힌다.
      if ([...identifiers, ...literals].some((text) => text !== 'WithDecryption' && /decrypt/i.test(text))) offenders.push(relative);
    }
    // P6(2026-09-24) 전에는 빈 배열이었다 — 복호 경로가 아직 없었다. 이제 정확히 하나다. 비공허성: signer.ts 가 실제로 잡힌다.
    expect(offenders).toEqual(['src/passport/signer.ts']);
  });
});

describe('B5 — 게시되지 않은 passport 의 DID 는 외부 표면으로 나가지 않는다', () => {
  it('`PassportRow.did` 를 읽는 파일은 did.ts 와 저장소뿐이다', () => {
    const declaration = sourceFile('src/db/schema.ts')
      .getInterfaceOrThrow('PassportRow')
      .getPropertyOrThrow('did');

    // `provisioning-store.ts` 는 SELECT 목록 문자열을 만들 뿐 `row.did` 를 읽지 않는다.
    // API·로그·웹훅 어느 파일도 여기 없어야 한다.
    const readers = referrersOf(declaration, 'src/db/schema.ts');
    expect(readers.filter((file) => !file.startsWith('src/passport/'))).toEqual([]);
  });

  it('`ProvisionedAgent` 에 passport 자리가 없다', () => {
    const provisioned = sourceFile(PROVISIONING_FILE).getInterfaceOrThrow('ProvisionedAgent');
    expect(provisioned.getProperties().map((property) => property.getName()).sort()).toEqual([
      'address',
      'agent',
      'organization',
      'policy',
      'policyVersion',
      'token',
    ]);
  });

  it('외부 노출 판정은 `externalDidOf` 하나를 지난다', () => {
    // P1c 에는 호출자가 0곳이었다(외부 표면이 없었다). P6 의 외부 표면 둘 — 공개 신원 API 의 읽기와 콘솔 신원 탭 — 이 이 함수를
    // 지난다. 셋째 표면이 DID 를 내보내려면 여기를 지나야 하고, 그때 이 목록이 늘어난다(리뷰 지점).
    // 셋째(US-013): 콘솔 신원 탭의 카드 뒷면·수집 카드(`identity-blocks` 응답의 `card.did`) — draft 는 null.
    expect(filesReferencing(DID_FILE, 'externalDidOf')).toEqual(['src/passport/admin-view.ts', 'src/passport/public-directory.ts', 'src/tlog/identity-blocks.ts']);
  });
});
