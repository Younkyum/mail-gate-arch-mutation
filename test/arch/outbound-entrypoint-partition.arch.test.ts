/**
 * Layer C — 진입점 전수 분할 (계획 §5.0 "Layer C", r3 재설계).
 *
 * **주장:** `ARCH_PARTITIONED_DIRS` 아래의 **모든 파일**은 다음 셋 중 **정확히 하나**다.
 *   (i) `src/policy/gate.ts` 를 import 하고 `OUTBOUND_ROUTES` 에 등록돼 있다
 *   (ii) `NON_SENDING_ENTRYPOINTS` 허용목록에 명시돼 있다
 *   (iii) **P2** — `SYSTEM_MAIL_ENTRYPOINTS` 에 명시돼 있다: 관문을 import 하지 **않고**, 지정된 시스템 메일
 *        모듈(`sender`)을 import 한다. 메일을 보내지만 에이전트 메일이 아닌 경로(소유자 승인 알림)다.
 *        (i) 로 넣으면 "관문을 import 한다" 가 거짓이고, (ii) 로 넣으면 "발송하지 않는다" 가 거짓이다.
 *   (iv) **MCP (2026-09-23)** — `TRANSPORT_ADAPTER_ENTRYPOINTS` 에 명시돼 있다: 발송을 일으키지만 관문을 import 하지
 *        **않고** 등록된 라우트 함수를 부르는 전송 어댑터(`src/mcp/**`). 폐포·라우트 허용목록은
 *        `test/arch/mcp-adapter.arch.test.ts` 가 본다.
 *
 * **이것은 발견(discovery)이 아니라 분할(partition)이다.** r2 설계는 "`gate.dispatch` 를
 * 호출하는 핸들러를 찾아 매니페스트와 대조"였는데, **관문을 우회하는 경로는 정의상
 * `gate.dispatch` 를 호출하지 않으므로 애초에 발견 집합에 들어오지 않는다.** 그 설계가
 * 실제로 잡는 것은 "성실한 경로의 등록 누락"뿐이었다.
 *
 * **이 층이 잡는 것**
 * - gate 를 import 하지 않고 등록도 안 된 새 진입점 → (i) 도 (ii) 도 아니므로 즉시 실패.
 * - **새 파일이 기본 실패한다(fail-closed).** "못 찾아서 통과"가 구조적으로 불가능하다.
 * - 매니페스트에 등록됐지만 실제로는 관문을 import 하지 않는 라우트(등록만 한 위장).
 * - 허용목록에 넣어 두고 실제로는 관문을 통해 발송하는 파일(분류 위반).
 *
 * **이 층이 못 잡는 것**
 * - 관문을 import 하면서 **동시에** 전송단을 직접 부르는 파일 → **Layer B** 가 잡는다.
 *   C(관문을 안 거치는 진입점) 와 B(관문을 거치면서 전송단을 직접 부름) 의 **합집합이
 *   우회 경로 전체**다.
 * - **선언되지 않은 디렉터리.** `src/jobs/` 가 생겨도 `ARCH_PARTITIONED_DIRS` 에 넣지
 *   않으면 덮이지 않는다. 파일 단위는 fail-closed 지만 **디렉터리 단위는 사람이 닫는다** —
 *   이것이 이 층의 알려진 사각지대이며, 선언 자체가 리뷰 체크리스트 항목이다.
 *
 * **P1a 현재 상태:** `src/api/routes/**` 와 `src/workers/**` 는 아직 존재하지 않는다.
 * 그래서 분할 대상이 0건이고 매니페스트도 비어 있다 — **정합적인 0건**이다.
 * 진입점 파일이 하나라도 생기면 그 순간 (i)/(ii) 중 하나를 요구받는다.
 */

import { describe, expect, it } from 'vitest';
import {
  ARCH_PARTITIONED_DIRS,
  NON_SENDING_ENTRYPOINTS,
  OUTBOUND_ROUTES,
  SYSTEM_MAIL_ENTRYPOINTS,
  TRANSPORT_ADAPTER_ENTRYPOINTS,
} from '../../src/policy/manifest';
import { getProject, importsModule, listTsFilesUnder, repoFileExists, toRepoRelative } from './support/project';

const GATE_FILE = 'src/policy/gate.ts';

function entrypointFiles(): string[] {
  return ARCH_PARTITIONED_DIRS.flatMap((dir) => listTsFilesUnder(dir)).sort();
}

describe('Layer C — 진입점 전수 분할', () => {
  it('분할 대상 디렉터리 선언이 비어 있지 않다', () => {
    // 선언이 비면 이 층 전체가 조용히 무력화된다. 0건 통과와 무력화를 구분하는 단언.
    expect([...ARCH_PARTITIONED_DIRS]).not.toEqual([]);
  });

  // 제목의 앞부분은 변이 C 의 `targetTest` 다(catalogue.ts) — 바꾸지 마라. P2 의 세 번째 범주는 괄호로 덧붙인다.
  it('모든 진입점 파일은 등록 또는 허용목록 중 정확히 하나에 속한다 (P2: 시스템 메일 범주 포함 · MCP: 전송 어댑터 범주 포함 — 넷 중 하나)', () => {
    const registered = new Set<string>(OUTBOUND_ROUTES.map((route) => route.file));
    const allowlisted = new Set<string>(NON_SENDING_ENTRYPOINTS.map((entry) => entry.file));
    const systemMail = new Set<string>(SYSTEM_MAIL_ENTRYPOINTS.map((entry) => entry.file));
    const adapters = new Set<string>(TRANSPORT_ADAPTER_ENTRYPOINTS.map((entry) => entry.file));

    const unclassified: string[] = [];
    const doubleClassified: string[] = [];

    for (const file of entrypointFiles()) {
      const memberships = [registered.has(file), allowlisted.has(file), systemMail.has(file), adapters.has(file)].filter(Boolean)
        .length;
      if (memberships > 1) doubleClassified.push(file);
      if (memberships === 0) unclassified.push(file);
    }

    // 미분류: 새로 추가된 진입점이 아무 데도 등록되지 않았다 — 이 층의 주된 표적.
    expect(unclassified).toEqual([]);
    // 이중 분류: "발송한다"와 "발송하지 않는다"를 동시에 주장하는 파일. 분할이 아니게 된다.
    expect(doubleClassified).toEqual([]);
  });

  it('등록된 진입점은 실제로 관문을 import 한다', () => {
    const project = getProject();
    const offenders: string[] = [];

    for (const route of OUTBOUND_ROUTES) {
      const source = project
        .getSourceFiles()
        .find((file) => toRepoRelative(file.getFilePath()) === route.file);
      if (!source) continue; // 파일 존재 여부는 아래 단언이 따로 본다.
      if (!importsModule(source, GATE_FILE)) offenders.push(route.file);
    }

    // 등록만 해 두고 관문을 거치지 않으면 매니페스트가 알리바이가 된다.
    expect(offenders).toEqual([]);
  });

  it('허용목록 진입점은 관문을 import 하지 않는다', () => {
    const project = getProject();
    const offenders: string[] = [];

    // 전송 어댑터도 관문을 **직접** import 하지 않는다 — 간접(폐포)은 mcp-adapter.arch.test.ts 가 본다.
    for (const entry of [...NON_SENDING_ENTRYPOINTS, ...TRANSPORT_ADAPTER_ENTRYPOINTS]) {
      const source = project
        .getSourceFiles()
        .find((file) => toRepoRelative(file.getFilePath()) === entry.file);
      if (!source) continue;
      if (importsModule(source, GATE_FILE)) offenders.push(entry.file);
    }

    // 관문을 만지는 파일은 발송 경로다. 허용목록이 아니라 OUTBOUND_ROUTES 로 가야 한다.
    expect(offenders).toEqual([]);
  });

  it('매니페스트와 허용목록의 경로는 실재하고 분할 대상 안에 있다', () => {
    const declared = [
      ...OUTBOUND_ROUTES.map((route) => route.file),
      ...NON_SENDING_ENTRYPOINTS.map((entry) => entry.file),
      ...SYSTEM_MAIL_ENTRYPOINTS.map((entry) => entry.file),
      ...TRANSPORT_ADAPTER_ENTRYPOINTS.map((entry) => entry.file),
    ];

    // 유령 등록(존재하지 않는 파일을 등록해 두는 것)은 나중에 같은 이름의 파일이
    // 생겼을 때 검사 없이 통과시키는 백도어가 된다.
    expect(declared.filter((file) => !repoFileExists(file))).toEqual([]);
    expect(
      declared.filter((file) => !ARCH_PARTITIONED_DIRS.some((dir) => file.startsWith(`${dir}/`))),
    ).toEqual([]);
  });

  it('매니페스트 id 는 유일하다 — 시스템 메일 id 도 같은 이름공간이다(관측의 route_id)', () => {
    const ids = [...OUTBOUND_ROUTES.map((route) => route.id), ...SYSTEM_MAIL_ENTRYPOINTS.map((entry) => entry.id)];
    expect(ids.length).toBe(new Set(ids).size);
  });

  it('시스템 메일 진입점은 관문을 import 하지 않고, 지정된 발송 모듈을 import 한다', () => {
    const project = getProject();
    const importsGate: string[] = [];
    const missingSender: string[] = [];

    for (const entry of SYSTEM_MAIL_ENTRYPOINTS) {
      const source = project
        .getSourceFiles()
        .find((file) => toRepoRelative(file.getFilePath()) === entry.file);
      if (!source) continue; // 존재 여부는 위 단언이 본다.
      // 관문을 만지면 에이전트 발송 경로다 — 이 범주가 아니라 OUTBOUND_ROUTES 다.
      if (importsModule(source, GATE_FILE)) importsGate.push(entry.file);
      // 발송 모듈을 import 하지 않는 "시스템 메일" 은 등록만 한 위장이다(i 의 역방향 단언과 같은 취지).
      if (!importsModule(source, entry.sender)) missingSender.push(entry.file);
    }

    expect(importsGate).toEqual([]);
    expect(missingSender).toEqual([]);
    // 발송 모듈 경로도 유령이면 안 된다 — 나중에 그 이름으로 생긴 파일이 검사 없이 통과한다.
    expect(SYSTEM_MAIL_ENTRYPOINTS.map((entry) => entry.sender).filter((file) => !repoFileExists(file))).toEqual([]);
  });

  it('시스템 메일 발송 모듈을 import 하는 진입점은 시스템 메일 범주뿐이다', () => {
    // 허용목록(발송 없음)이나 에이전트 라우트가 알림 모듈을 부르면 그 파일은 **분류와 다른 방식으로 메일을
    // 보낸다.** 예: HTTP 라우트가 notify(approvalId) 를 직접 부르면 outbox·속도 상한을 도는 워커 밖에서
    // 소유자 메일함을 두드리는 두 번째 입구가 된다.
    const project = getProject();
    const senders = new Set(SYSTEM_MAIL_ENTRYPOINTS.map((entry) => entry.sender));
    const systemMail = new Set(SYSTEM_MAIL_ENTRYPOINTS.map((entry) => entry.file));
    const offenders: string[] = [];

    for (const file of entrypointFiles()) {
      if (systemMail.has(file)) continue;
      const source = project.getSourceFiles().find((candidate) => toRepoRelative(candidate.getFilePath()) === file);
      if (!source) continue;
      if ([...senders].some((sender) => importsModule(source, sender))) offenders.push(file);
    }

    expect(senders.size).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});
