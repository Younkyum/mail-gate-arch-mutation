/**
 * src/passport/custody-local.ts — **개발 전용** 구현. 운영에서 선택되면 던진다.
 *
 * 로컬 데모와 통합 테스트가 실제로 에이전트를 프로비저닝하므로 AWS 없이도 개인키가 갈 곳이 필요하다.
 *
 * **이 파일이 지켜야 하는 것은 하나다: 운영에서 여기로 떨어지지 않는다.**
 * `assertNotProduction()` 을 **팩토리와 `store()` 양쪽에서** 부르고, arch 테스트가
 * 그 두 호출의 존재를 단언한다. 조용히 평문 보관으로 떨어지는 폴백은 없다 —
 * 그런 폴백은 사고가 난 뒤에야 드러나고 그때는 이미 전 에이전트의 키가 평문이다.
 *
 * **보관 방식(개발): 파일 하나, 0600, `wx` 플래그.**
 *   - `wx` 는 "이미 있으면 실패" 다. **덮어쓰기 경로가 존재하지 않는다** — 로컬에서도
 *     키 교체는 일어나지 않는다. DB 트리거와 같은 성질을 파일시스템에서 얻는다.
 *   - 디렉터리는 `ATMARK_DEV_KEY_DIR`. 기본값은 리포 밖이 아니라 `.atmark-dev-keys/`
 *     이고 `.gitignore` 에 들어 있다. 테스트는 OS 임시 디렉터리를 넘긴다.
 *   - **평문이다.** 개발용이므로 그렇고, 그 사실을 숨기지 않는다. 운영에서 이 경로가
 *     선택되지 않는다는 보증이 이 평문성을 감당 가능하게 만드는 전부다.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AgentId } from '../db/schema';
import {
  assertNotProduction,
  toKeyRef,
  type KeyCustody,
  type KeyRef,
  type PrivateKeyMaterial,
} from './custody';

const DEV_KEY_DIR_ENV = 'ATMARK_DEV_KEY_DIR';

/** 기본 보관 디렉터리(리포 상대). `.gitignore` 에 등재돼 있다. */
const DEFAULT_DEV_KEY_DIR = '.atmark-dev-keys';

export interface LocalDevKeyCustodyOptions {
  /** 명시하지 않으면 `ATMARK_DEV_KEY_DIR` → `DEFAULT_DEV_KEY_DIR` 순으로 결정된다. */
  readonly directory?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export function resolveDevKeyDirectory(options: LocalDevKeyCustodyOptions = {}): string {
  if (options.directory !== undefined && options.directory.trim() !== '') return options.directory;
  const fromEnv = (options.env ?? process.env)[DEV_KEY_DIR_ENV];
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv;
  return DEFAULT_DEV_KEY_DIR;
}

/**
 * 개발 전용 키 보관소.
 *
 * `key_ref` 는 `devfile://{agentId}` 다 — **호스트 절대 경로를 DB 에 넣지 않는다.**
 * 경로를 넣으면 그 DB 덤프가 다른 기계에서 의미를 잃고, 더 나쁘게는 운영 DB 에
 * 개발자 홈 디렉터리 문자열이 들어간다. 디렉터리는 환경이 정하는 값이다.
 */
export function createLocalDevKeyCustody(options: LocalDevKeyCustodyOptions = {}): KeyCustody {
  const env = options.env ?? process.env;
  assertNotProduction('createLocalDevKeyCustody', env);
  const directory = resolveDevKeyDirectory(options);

  return {
    kind: 'local-dev',

    // **`async` 다.** 시그니처가 `Promise<KeyRef>` 인데 동기로 던지면 호출자는
    // try/catch 와 `.catch()` 를 **둘 다** 써야 한다 — 그리고 한쪽만 쓴 호출자가
    // 생긴다. 실패를 전부 거부(rejection)로 통일한다.
    async store(agentId: AgentId, privateKey: PrivateKeyMaterial): Promise<KeyRef> {
      // 팩토리에서 한 번 봤어도 다시 본다. 장기 실행 프로세스가 나중에 운영 설정을
      // 받는 구성에서는 팩토리 시점의 판정이 이미 낡았다.
      assertNotProduction('createLocalDevKeyCustody().store', env);

      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(join(directory, `${agentId}.pkcs8`), privateKey.expose(), {
        // `wx`: 이미 있으면 EEXIST 로 실패한다. 덮어쓰기 = 키 교체이고, 그 경로는
        // 개발에서도 존재하면 안 된다.
        flag: 'wx',
        mode: 0o600,
      });

      return toKeyRef('devfile', agentId);
    },
  };
}
