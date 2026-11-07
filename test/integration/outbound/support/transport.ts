/**
 * test/integration/outbound/support/transport.ts — 발송 실험용 전송단 조립.
 *
 * ---
 *
 * **왜 이 파일이 `test/` 아래에 있는가 — 리드 확인이 필요한 구조적 사실.**
 *
 * Layer B(`test/arch/gate-chokepoint.arch.test.ts`)는 *"`ses-transport.ts` 의 export 를
 * 참조하는 파일은 허용목록에 **이름으로** 올라온 것뿐"* 이라고 단언한다. 허용목록은
 * 그 테스트 안에 **리터럴로 고정**돼 있고, 목록이 늘어나는 것 자체를 별도 단언이 막는다
 * (*"이 층의 강도는 전적으로 허용목록의 크기다"*).
 *
 * > **P1b 리뷰 정정.** 이 파일이 처음 들어왔을 때 Layer B 의 판정에는
 * > `relative.startsWith('test/')` 라는 와일드카드가 있었고, 크기 단언은 그것을 세지
 * > 않았다. 즉 **실발송 조립 루트가 여기 있다는 사실에 대해 CI 가 아무 말도 하지
 * > 않았다.** 지금은 이 경로가 허용목록에 이름으로 올라가 있고, 변이 G 가 그 단언이
 * > 깨어 있는지를 매 CI 에서 확인한다.
 *
 * 그래서 `scripts/demo-p1b.ts` 가 `createSesTransport` 를 직접 부르면 **정적 import 든
 * 동적 import 든 Layer B 가 즉시 빨간불이 된다**(둘 다 실측으로 확인했다). 실발송을
 * 하려면 조립 지점이 (i) 관문 안이거나 (ii) `test/` 아래여야 하고, 관문은 평가·lease·
 * audit 의 자리이지 조립의 자리가 아니다. 그래서 (ii) 다.
 *
 * **이것은 우회가 아니라 P1b 가 드러낸 빈자리다.** 프로덕션 조립 루트(람다 핸들러 등)가
 * 생기는 날 그 파일은 Layer B 허용목록에 **이름으로** 추가돼야 하고, 그 추가는
 * `test/arch/**` 변경이므로 리드의 판단이다. P1b 는 그 판단을 대신하지 않는다.
 *
 * (`scripts/demo-p1a.ts` 가 `test/arch/support/deny-all-matrix` 와
 *  `test/arch/mutations/catalogue` 를 import 하는 것과 같은 방향의 선례다 — demo 가
 *  자기 목록·조립을 따로 들면 검증 대상과 갈라진다.)
 */

import type { Pool } from 'pg';

import { createPostgresSendingClock, noopSendingClock } from '../../../../src/db/repositories/sending-clock';
import type { SendingClock } from '../../../../src/db/repositories/sending-clock';
import type { MessageContentStore } from '../../../../src/api/content-store';
import { createSesClient, createSesTransport } from '../../../../src/mail/transport/ses-transport';
import type { OutboundTransport, TransportRequest } from '../../../../src/policy/gate';

/** 전송단이 실제로 무엇이었는지. 응답에 찍어 두면 "드라이런인 줄 알았는데" 가 없어진다. */
export type TransportMode = 'dry_run' | 'live_ses';

export interface CountingTransport extends OutboundTransport {
  /** `send` 가 불린 횟수. **AC-5 의 "SES 호출 0회" 는 이 값으로 판정한다.** */
  sesSendCalls(): number;
  mode(): TransportMode;
  /** 드라이런이 조립한 마지막 요청. 실발송 모드에서는 `null`. */
  lastRequest(): TransportRequest | null;
}

export interface DemoTransportOptions {
  readonly content: Pick<MessageContentStore, 'load'>;
  /**
   * **`true` 일 때만 진짜로 나간다.** 기본은 드라이런이다 — SES 계정 한도가
   * 50,000통/일이고(R22) 남은 제동장치는 워밍업 캡(Day 1 = 20 수신자)뿐이다.
   */
  readonly realSend: boolean;
  /** 실발송 모드에서 `organizations.sending_started_at` 을 1회 세팅한다(§3.3 M7). */
  readonly pool: Pool | null;
}

/**
 * 드라이런 전송단.
 *
 * **본문을 실제로 읽는다.** 읽지 않으면 `MessageContentSource` 구현이 한 번도 검증되지
 * 않은 채 실발송 모드에서 처음 돌게 되고, 그날 처음 도는 코드가 발송 경로 위에 있다.
 * 본문이 없으면 여기서 던지고, 관문이 `failed` 로 받아 audit 에 남긴다.
 */
function dryRunTransport(content: Pick<MessageContentStore, 'load'>): OutboundTransport {
  return {
    async send(request: TransportRequest): Promise<{ readonly sesMessageId: string }> {
      const loaded = await content.load(request.messageId);
      if (loaded.subject.trim() === '') throw new Error('제목이 빈 메일은 조립하지 않는다');
      // 접두사가 요점이다. `ses_message_id` 컬럼에 이 값이 들어가므로, 나중에 DB 를
      // 보는 사람이 "이건 실제로 나간 메일이 아니다" 를 **값만 보고** 알 수 있어야 한다.
      return { sesMessageId: `dryrun-${request.messageIdHeader.replace(/[<>]/g, '')}` };
    },
  };
}

function sendingClockFor(options: DemoTransportOptions): SendingClock {
  // 드라이런은 기준일을 세팅하지 않는다 — 나가지 않은 메일이 워밍업 램프를 시작시키면
  // 실발송을 시작하는 날 램프가 이미 며칠 소진돼 있다(§3.3 M7 이 P0 세팅을 금지한 이유).
  if (!options.realSend || options.pool === null) return noopSendingClock();
  return createPostgresSendingClock(options.pool);
}

export function createDemoTransport(options: DemoTransportOptions): CountingTransport {
  const mode: TransportMode = options.realSend ? 'live_ses' : 'dry_run';
  const inner: OutboundTransport = options.realSend
    ? createSesTransport({
        client: createSesClient(),
        content: options.content,
        sendingClock: sendingClockFor(options),
      })
    : dryRunTransport(options.content);

  let calls = 0;
  let last: TransportRequest | null = null;

  return {
    send(request: TransportRequest): Promise<{ readonly sesMessageId: string }> {
      // **위임 전에 센다.** 나중에 세면 던지는 전송단(미구현 스텁)의 호출이 0회로
      // 집계되고, 그러면 "호출되지 않았다" 와 "호출했는데 실패했다" 가 구별되지 않는다.
      calls += 1;
      last = request;
      return inner.send(request);
    },
    sesSendCalls: () => calls,
    mode: () => mode,
    lastRequest: () => last,
  };
}
