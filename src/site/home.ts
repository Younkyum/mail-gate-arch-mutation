/**
 * src/site/home.ts — `GET /`(영어)·`GET /kr`(한국어) 제품 소개.
 *
 * Atmark 는 **이메일도 주는 AI 에이전트 신원 시스템**이다. 메시지: **에이전트에게 자기만의 이메일을** — 에이전트의 메일은 당신의 메일과
 * 섞이지 않는다. 기둥 셋: (a) 자기 이메일 주소 (b) 변조 흔적이 남는 기록 (c) 쉬운 관리. 설명 문구는 최소로, 대신 그림과 움직임으로 보인다.
 *
 * 절(흑백 — 따뜻함은 사진이 맡는다, `@` 도 글자색):
 * ① 히어로 — 사진 위 가운데 정렬 헤드라인 · 한 줄 · CTA, 그 아래 무대: 가운데 신원 카드와 둘레의 유리 메일 카드 넷. 모션 줄이기면 정지 화면.
 * ② 분리 — 사서함 사진 위에 겹친 받은편지함 둘(당신 · 에이전트).
 * ②-2 두 겹 방어 — 받은 메일에 숨은 지시(프롬프트 인젝션)를 어떻게 다루는지. 사실만: ① 결정론 규칙이 모든 메일을 살펴 위험·차단 두 등급,
 *   위험한 메일을 읽은 뒤의 새 상대 발송과 비밀·받은 메일 복사가 담긴 발송은 소유자 승인(ADR-0016, 모두에게 켜짐) ② AI 의심 메일 감시
 *   (ADR-0017, 옵트인 · 베타) — **경고만** 붙이고 막거나 승인하거나 판정을 바꾸지 않는다. 모델 고유명·임계값·인프라 이름·수치는 쓰지 않는다
 *   (수치는 문서 보안 약속의 측정 절에만). "막는다/blocks"·"완벽"·"100%" 류는 copy-guard 가 막는다.
 * ③ 작동 방식 — 네 칸, 칸마다 움직이는 그림(CSS·SVG 만), 그 뒤 받는 사람의 받은편지함("이 에이전트, 누구죠?").
 * ④ 신원 카드 — 예시 ID 카드 앞·뒤 + 사실 셋. ⑤ 직접 확인 — 어두운 띠, 증거 셋 + 확인 절차 문서 링크.
 * ⑥ 자주 묻는 질문(`<details>`, 본문 = FAQPage JSON-LD) ⑦ 끝 CTA.
 * 실행 스크립트는 공통 머리 힌트 하나뿐(`session-hint.ts`). 움직임은 전부 CSS 다. 사진 출처(Unsplash License)는
 * `assets/site/photos/ATTRIBUTION.md` — 페이지에는 적지 않는다.
 *
 * 문구 규칙: 제품이 **지금 하는 일만** 적는다(ADR·계약 기준).
 *   - 주소: 에이전트를 만들면 키·DID·draft passport·주소가 한 트랜잭션에서 생긴다(`src/identity/provisioning.ts`). 메일은 그 주소로 받고 보낸다.
 *   - 신원: 공개 게시는 소유자·관리자가 콘솔에서 한다(운영자가 거절·보류한 조직은 못 한다) — 그래서 "게시하면 누구나 조회" 이지 "만들자마자 공개" 가 아니다.
 *     Passport: JWS compact · `alg: EdDSA` · `kid` = 에이전트 DID 의 `#key-1` · 유효 90일(`src/passport/document.ts`).
 *   - 기록: 발송 판정(`audit.evaluated`)·수신 판정(`inbound.verdict`)·소유자 조치·정책·신원 이벤트가 RFC 9162 공개 투명성 로그
 *     (`id.atmark.ai/log`)의 잎이 된다(잎은 해시·커밋먼트뿐 — 메일 내용 없음). 체크포인트는 매시(UTC 시 경계) 서명·게시되고, 외부 앵커
 *     (OpenTimestamps → Bitcoin)는 하루 1회다(`src/tlog/constants.ts` `ANCHOR_INTERVAL_MS`) — 그래서 "매시 앵커" 라고 쓰지 않는다.
 *     허용 문구: "변조 흔적이 남는"·"tamper-evident"(ADR-0008 Q10 — 공개 로그 운영 중). 신원에 대한 "독립 검증 가능"·
 *     "변조 불가"·"누구나 검증" 은 쓰지 않는다(copy-guard `test/support/copy-guard.ts`).
 *   - 관리: 소유자가 발신·수신을 따로 정한다(정책 v2, ADR-0007) · 에이전트·조직 긴급 정지(콘솔).
 * 금지 문구(`site-wording.test.ts`): 체인 발행 전의 "블록체인 신원"·NFT·민팅, 신원에 대한 "독립 검증 가능"(ADR-0008 Q10),
 * "변조 불가"·"tamper-proof", 가격·무료·인증·가용성 수치. 과장·검증할 수 없는 주장 전반은 `COPY_GUARD_BANNED`(`test/support/copy-guard.ts`).
 * 영어는 직역이 아니라 같은 사실을 자연스러운 제품 영어로 쓴다. 두 언어의 문구 키 집합은 같다(테스트).
 * 예시 상대는 `*.example.com` 뿐이다(실제 회사·서비스 이름 없음).
 */

import { docsUrl, SITE_IDENTITY_HOST, type SiteLang } from './constants';
import { HERO_AGENT_NAMES } from './hero-names';
import { photoImg } from './images';
import { agentAddress, ARROW_RIGHT_ICON, buildSitePage, contactHtml, lineIcon, LOGO_TEXT, sitePath, type SitePage } from './page';
import { faqNode, plainText, websiteNode, type FaqEntry } from './seo';
import { homeUseCaseCards } from './use-cases';

type HomeCopy = Readonly<Record<string, string>>;

/**
 * 히어로 한 줄의 주소 — 로컬파트가 에이전트 이름으로 차례로 바뀐다(`hero-names.ts`). 화면 읽기에는 첫 주소 하나만 읽힌다(바뀌는 글자는
 * aria-hidden). 모션 줄이기면 첫 이름에 멈춘다. 칸 폭은 지금 이름 길이를 따라가서 `@` 앞에 빈칸이 없다(`styles.ts` `rwidth`).
 */
function rotatingAddress(): string {
  const words = HERO_AGENT_NAMES.map((name, i) => `<span class="w${i + 1}">${name}</span>`).join('');
  return (
    `<span class="addr rot"><span class="sr">${HERO_AGENT_NAMES[0]}@atmark.ai</span>` +
    `<span aria-hidden="true"><span class="rw">${words}</span><span class="at">@</span>atmark.ai</span></span>`
  );
}

/** 문구 사전. 값은 정적 마크업 조각(코드 상수 — 사용자 입력 없음). */
export const HOME_COPY: Readonly<Record<SiteLang, HomeCopy>> = {
  ko: {
    title: 'Atmark | AI 에이전트 전용 이메일 주소와 신원',
    description: 'AI 에이전트에게 자기만의 @atmark.ai 이메일 주소를 줍니다. 당신의 받은편지함과 섞이지 않고, 서명된 신원과 변조 흔적이 남는 판정 기록이 함께 갑니다.',
    h1: '에이전트에게,<br>자기만의 이메일을.',
    lede: `당신의 받은편지함과 섞이지 않는 ${rotatingAddress()}`,
    waitlist: '대기자 명단',
    docs: '문서 보기',
    heroAlt: '창가 책상 위의 노트북. 얇은 커튼 사이로 오후 햇빛이 들어온다.',
    uiLabel: '예시: 에이전트 Scout의 신원 카드와, 그 주소로 오가는 메일 — 받은 인증 코드, 정책이 허용한 발송, 답장, 기록',
    inboxHead: '받은 메일',
    inboxTime: '방금',
    inboxSubject: '인증 코드',
    sentHead: '보냄',
    sentVerdict: '정책 허용',
    sentSubject: '이번 주 리포트 보내드립니다',
    replyHead: '답장',
    replyTime: '2분 전',
    replySubject: 'Re: 다음 주 미팅 일정',
    logHead: '기록',
    logNote: '해시 체인에 이어짐',
    to: '받는 사람',
    cardLabel: '예시: 에이전트 Scout의 신원 카드 앞면과 뒷면',
    cardKind: '에이전트 신원',
    cardIssued: '발급',
    cardIssuedValue: '2026.09.24',
    cardStatus: '상태',
    cardStatusValue: '게시됨',
    cardBackKind: '뒷면',
    cardKey: '공개키',
    cardOwner: '소유 조직',
    cardOwnerValue: '예시 연구소',
    cardOwnerNote: '비공개',
    splitTitle: '에이전트 메일은<br>에이전트 주소로.',
    splitBody: '다른 서비스 가입도 에이전트 주소로 합니다. 인증 코드와 답장은 에이전트가 직접 받아요.',
    splitLabel: '예시: 당신의 받은편지함과 에이전트 Scout의 받은편지함이 따로 있는 모습',
    splitAlt: '오래된 황동 사서함이 줄지어 있는 벽',
    youHead: '당신',
    agentHead: '에이전트',
    y1: '3분기 이사회 자료',
    y2: '목요일 점심 어때요?',
    y3: '계약서 초안 v2',
    r1: '가입 확인 · 인증 코드 482 913',
    r2: '가입을 환영합니다',
    r3: 'Re: 다음 주 미팅 일정',
    joinHead: '새 서비스 가입',
    joinEmail: '이메일',
    joinGo: '인증 코드 받기',
    howTitle: '이렇게 작동합니다',
    k1Title: '자기 주소',
    k1Body: `에이전트마다 ${agentAddress('이름')} 주소가 따로 생깁니다.`,
    k2Title: '서명된 신원',
    k2Body: 'did:web 식별자와 Passport에 에이전트 키로 서명합니다.',
    k3Title: '변조 흔적이 남는 기록',
    k3Body: '주고받은 메일의 판정이 해시로 이어진 공개 로그에 남고, 매시간 서명한 체크포인트가 공개됩니다.',
    k4Title: '스위치 하나로 관리',
    k4Body: '누구에게 보내고 누구에게서 받을지, 긴급 정지까지 콘솔에서 정합니다.',
    bridgeTitle: '받는 사람은 묻습니다.<br>&ldquo;이 에이전트, 누구 거죠?&rdquo;',
    bridgeBody: '보낸 주소만 있으면 신원을 조회할 수 있어요. 주인이 게시한 신원만 보이고, 비공개로 둔 신원은 아무에게도 보이지 않습니다.',
    lookHead: '주소로 신원 조회',
    lookPub: '게시됨',
    lookPubValue: 'Scout &middot; 예시 연구소',
    lookPriv: '비공개',
    lookPrivValue: '찾을 수 없음',
    bridgeLabel: '예시: 거래처의 받은편지함에 에이전트 Scout의 메일이 도착하고, 받은 사람이 신원을 열어 보는 모습',
    rinHead: '받은편지함',
    rinS1: '다음 주 미팅 시간 제안드립니다',
    rinF2: '월간 소식',
    rinS2: '10월 업데이트 모음',
    rinF3: '청구서',
    rinS3: '청구서 #2031이 발행되었습니다',
    rinAsk: '누가 보낸 거지?',
    getTitle: '에이전트의 신원 카드',
    getLede: '조회하면 나오는 Scout의 신원 카드입니다.',
    getAlt: '블라인드 사이로 든 햇빛이 나무 책상 위 종이에 줄무늬를 드리운 모습',
    f1Title: '게시하면 누구나 조회',
    f2Title: '에이전트 키로 서명, 90일 유효',
    f3Title: '콘솔에서 게시하고 멈춤',
    proofTitle: '직접 확인해 보세요',
    proofLede: '게시된 신원은 공개된 값으로 직접 확인해 볼 수 있어요.',
    p1Title: '누구의 에이전트인지',
    p1Body: '게시된 에이전트는 공개 주소에 신원 문서가 있습니다. 누구나 열어 공개 키와 주소를 볼 수 있어요.',
    p2Title: '신분증이 진짜인지',
    p2Body: 'Passport는 에이전트 키로 서명한 신분증입니다. 신원 문서의 공개 키로 서명을 검증하면 내용이 바뀌지 않았는지 알 수 있어요.',
    p3Title: '기록이 고쳐지지 않았는지',
    p3Body: '신원 변경은 모두 공개 기록에 이어 붙습니다. 체크포인트를 시간을 두고 두 번 받아 비교하면, 과거가 바뀌었을 때 드러납니다.',
    proofWhere: '여기서 확인',
    proofDocs: '확인하는 방법 자세히 보기',
    defKicker: '프롬프트 인젝션 방어',
    defTitle: '받은 메일이<br>에이전트를 움직이려 할 때',
    defLede: '메일 본문에 숨은 지시, 이메일 프롬프트 인젝션을 두 겹으로 다룹니다. 기본은 결정론 규칙, 원하면 AI가 한 번 더 봅니다.',
    defLabel: '예시: 받은 메일이 모두 한 검사선을 지나 세 갈래로 나뉜다 — 깨끗한 메일은 에이전트로, 위험 메일은 에이전트에 닿고 그 뒤 답장은 승인 문에서 소유자를 기다리며, 차단 메일은 보류 칸에 머물고 소유자에게 알림이 간다',
    l1Tag: '기본 &middot; 모든 에이전트',
    l1Title: '결정론 방어',
    l1Body: '다국어 인젝션 스캐너가 모든 수신 메일을 검사해 위험과 차단 두 등급으로 나눕니다. 차단은 늘 소유자에게 알리고 풀어 줄 때까지 기다립니다. 위험 메일을 바로 전달할지 보류할지, 발송을 자동으로 할지 승인 후에 할지는 에이전트마다 고릅니다. 위험한 발송은 발신 DLP가 잡아 승인을 기다립니다.',
    l2Tag: '옵트인 &middot; 베타',
    l2Title: 'AI 의심 메일 감시',
    l2Body: '분류 모델이 규칙이 놓친 의심 메일에 경고를 붙입니다. 경고 전용이라 차단·승인·판정에는 관여하지 않습니다.',
    l2Note: '소유자가 콘솔에서 켭니다.',
    bandTitle: '첫 에이전트 이메일을 만들어 보세요.',
    faqTitle: '자주 묻는 질문',
    faqNote: '다른 질문은 {contact}로 보내 주세요.',
    q1: 'Atmark는 어떤 서비스인가요?',
    a1: `Atmark는 AI 에이전트에게 자기만의 이메일 주소와 신원을 발급하는 서비스입니다. 에이전트를 만들면 ${agentAddress('이름')} 형식의 주소와 did:web 식별자, 에이전트 키로 서명한 Passport가 한꺼번에 생깁니다.`,
    q2: '에이전트 메일이 내 메일함과 섞이나요?',
    a2: `섞이지 않습니다. 에이전트는 자기 주소(${agentAddress('이름')})로 메일을 받고 보냅니다. 사람 계정을 빌리지 않으므로 인증 코드와 답장도 에이전트의 받은편지함으로 갑니다.`,
    q3: 'did:web 신원은 어떻게 확인하나요?',
    a3: `did:web 신원은 공개 HTTPS 주소에 올린 did.json 문서로 확인하는 식별자입니다. 게시된 에이전트의 did.json은 ${SITE_IDENTITY_HOST}에서 누구나 조회할 수 있습니다. passport.jws의 서명과 만료는 이 문서에 든 공개키로 확인합니다.`,
    q4: '에이전트가 아무에게나 메일을 보낼 수 있나요?',
    a4: '보낼 상대는 소유자가 정합니다. 콘솔에서 만든 에이전트는 누구에게나 보낼 수 있게 시작하고, 발신을 허용 목록으로 바꾸면 목록에 올린 상대에게만 보냅니다. 위험한 메일을 읽은 뒤 새 상대에게 보내는 메일과 자격 증명이 담긴 메일은 소유자가 승인해야 나갑니다. 모든 발송은 관문 하나를 지나고, 관문에서 수신 거부 목록과 발송 한도, 소유자 정책을 모두 확인합니다.',
    q5: '어떻게 쓰기 시작하나요?',
    a5: '가입은 대기자 명단의 초대로 받습니다. 초대 메일로 가입하면 조직이 바로 활성이 되어, 에이전트와 토큰을 만들고 허용한 상대에게 메일을 보낼 수 있습니다. 베타는 운영자가 초대한 조직에만 직접 드립니다.',
  },
  en: {
    title: 'Atmark | Email addresses and identity for AI agents',
    description: 'Give your AI agent its own @atmark.ai email address, never mixed with your inbox, with a signed identity and a tamper-evident log of its mail decisions.',
    h1: 'Give your agent<br>its own email.',
    lede: `${rotatingAddress()} &mdash; never mixed with your inbox.`,
    waitlist: 'Join the waitlist',
    docs: 'Read the docs',
    heroAlt: 'A laptop on a desk by the window, with afternoon sun coming through sheer curtains.',
    uiLabel: 'Example: the identity card of an agent named Scout, with mail moving to and from its address — a verification code, a message its policy allowed, a reply and a log entry',
    inboxHead: 'Inbox',
    inboxTime: 'Just now',
    inboxSubject: 'Verification code',
    sentHead: 'Sent',
    sentVerdict: 'Allowed by policy',
    sentSubject: 'This week&rsquo;s report',
    replyHead: 'Reply',
    replyTime: '2 min ago',
    replySubject: 'Re: Time to meet next week?',
    logHead: 'Log',
    logNote: 'Joined the hash chain',
    to: 'To',
    cardLabel: 'Example: front and back of the identity card for an agent named Scout',
    cardKind: 'Agent identity',
    cardIssued: 'Issued',
    cardIssuedValue: 'Sep 24, 2026',
    cardStatus: 'Status',
    cardStatusValue: 'Published',
    cardBackKind: 'Reverse',
    cardKey: 'Public key',
    cardOwner: 'Owner',
    cardOwnerValue: 'Example Labs',
    cardOwnerNote: 'Private',
    splitTitle: 'Its mail stays<br>out of your inbox.',
    splitBody: 'Sign it up for other services with its own address. Codes and replies go straight to the agent.',
    splitLabel: 'Example: your inbox and the inbox of an agent named Scout, kept apart',
    splitAlt: 'A wall of old brass post office boxes',
    youHead: 'You',
    agentHead: 'Agent',
    y1: 'Q3 board deck',
    y2: 'Lunch Thursday?',
    y3: 'Contract draft v2',
    r1: 'Confirm sign-up · code 482 913',
    r2: 'Welcome aboard',
    r3: 'Re: Time to meet next week?',
    joinHead: 'Sign up',
    joinEmail: 'Email',
    joinGo: 'Send code',
    howTitle: 'How it works',
    k1Title: 'Its own address',
    k1Body: `Every agent gets its own ${agentAddress('name')} address.`,
    k2Title: 'A signed identity',
    k2Body: 'A did:web identifier and a passport, signed with the agent&rsquo;s key.',
    k3Title: 'Tamper-evident records',
    k3Body: 'Every send decision and received-mail verdict joins a public hash-chained log, with a signed checkpoint every hour.',
    k4Title: 'Managed with a switch',
    k4Body: 'Who it writes to, who it hears from, and an emergency stop, all in the console.',
    bridgeTitle: 'The recipient asks:<br>&ldquo;Whose agent is this?&rdquo;',
    bridgeBody: 'All it takes is the sender&rsquo;s address. Only identities their owners have published show up; private ones stay hidden from everyone.',
    lookHead: 'Look up an identity by address',
    lookPub: 'Published',
    lookPubValue: 'Scout &middot; Example Labs',
    lookPriv: 'Private',
    lookPrivValue: 'Not found',
    bridgeLabel: 'Example: mail from an agent named Scout arrives in a partner&rsquo;s inbox, and the recipient opens its identity',
    rinHead: 'Inbox',
    rinS1: 'Proposing times for next week',
    rinF2: 'Monthly digest',
    rinS2: 'October updates',
    rinF3: 'Billing',
    rinS3: 'Invoice #2031 is ready',
    rinAsk: 'Who sent this?',
    getTitle: 'Its identity card',
    getLede: 'What a lookup shows for Scout.',
    getAlt: 'Window light through blinds, striping a sheet of paper on a wooden desk',
    f1Title: 'Anyone can resolve it once published',
    f2Title: 'Signed with its key, valid for 90 days',
    f3Title: 'Publish or stop it from the console',
    proofTitle: 'Check it yourself',
    proofLede: 'A published identity can be checked against public values.',
    p1Title: 'Whose agent is it',
    p1Body: 'A published agent has an identity document at a public address. Anyone can open it and see its public key and address.',
    p2Title: 'Is the passport real',
    p2Body: 'The passport is an ID signed with the agent’s key. Verify the signature with the public key from the identity document to know it hasn’t been changed.',
    p3Title: 'Was the history rewritten',
    p3Body: 'Every identity change is appended to a public log. Fetch the checkpoint twice, some time apart, and compare: a rewritten past shows.',
    proofWhere: 'Where',
    proofDocs: 'How to check, step by step',
    defKicker: 'Prompt-injection defense',
    defTitle: 'When an email tries<br>to steer your agent',
    defLede: 'Instructions hidden in an email body &mdash; email prompt injection &mdash; handled in two layers. Deterministic rules by default, an AI second look if you want it.',
    defLabel: 'Example: every incoming email passes one scanner and splits three ways — clean mail goes to the agent, Risk mail reaches the agent but its reply waits at an approval gate for the owner, and Block mail is held while the owner is notified',
    l1Tag: 'Default &middot; Every agent',
    l1Title: 'Deterministic defense',
    l1Body: 'A multilingual scanner checks all inbound mail, rating suspicious mail Risk or Block. Block is always held and the owner alerted. Per agent, owners pick: deliver or hold Risk, send automatically or after approval. Outbound DLP holds risky sends.',
    l2Tag: 'Opt-in &middot; Beta',
    l2Title: 'AI suspicious-mail watch',
    l2Body: 'A classifier flags suspicious mail the rules may miss. Warning only: it never blocks, approves or changes a decision.',
    l2Note: 'Owners turn it on in the console.',
    bandTitle: 'Create your first agent email.',
    faqTitle: 'Questions',
    faqNote: 'Anything else? Write to {contact}.',
    q1: 'What is Atmark?',
    a1: `Atmark is a service that gives AI agents an email address and an identity of their own. Each agent gets an address like ${agentAddress('name')}, a did:web identifier, and a passport signed with its own key.`,
    q2: 'Does my agent&rsquo;s mail mix with mine?',
    a2: `No. Your agent sends and receives from its own address, like ${agentAddress('name')}. It never borrows a human account, so its verification codes and replies go to its own inbox.`,
    q3: 'How do I check a did:web identity?',
    a3: `A did:web identity is an identifier you check against a did.json document at a public HTTPS address. Anyone can fetch a published agent&rsquo;s did.json from ${SITE_IDENTITY_HOST}, then verify the signature and expiry of its passport.jws with the key in that document.`,
    q4: 'Can an agent email anyone it wants?',
    a4: 'The owner decides. Agents you create in the console can email anyone at first; switch outbound to an allowlist and they only write to people on the list. After reading a risky email, a send to someone new waits for the owner&rsquo;s approval, and so does mail carrying credentials. Every send passes one gate that checks the suppression list, sending limits and the owner&rsquo;s policy.',
    q5: 'How do I get started?',
    a5: 'Sign-up is by invitation from the waitlist. When you sign up from an invitation, your organization is active right away, so you can create agents and tokens and email the people you allow. Beta is granted directly to organizations an operator invites.',
  },
};

// ---------------------------------------------------------------------------
// 예시 신원 카드 — 표시용 표본(실제 에이전트가 아니다). 두 언어가 같은 값을 쓴다.
// ---------------------------------------------------------------------------

/** 예시 에이전트. 주소 로컬파트는 `agentAddress` 가 `@` 를 `.at` 로 감싼다(색 없음). */
export const SAMPLE_AGENT = { name: 'Scout', localPart: 'scout', issued: '2026-09-24' } as const;

/**
 * 예시 DID 의 세그먼트(가운데를 줄인 agentId 포함). **DID 문자열을 조립하는 곳은 `src/passport/did.ts` 하나다**(ADR-0002 ·
 * `keypair-immutability.arch.test.ts`) — 여기서는 세그먼트를 하나씩 그리고 구분자 `:` 를 옅게 칠할 뿐 접두사 리터럴을 두지 않는다.
 * 렌더된 글자가 정본 접두사(`DID_WEB_PREFIX`)로 시작하는지는 `site-identity-card.test.ts` 가 본다(접두사가 바뀌면 빨강).
 */
const SAMPLE_DID_SEGMENTS: readonly string[] = ['did', 'web', SITE_IDENTITY_HOST, 'agents', '7c21&hellip;f5a1'];

/** 예시 공개키(multibase, 가운데 줄임)와 그 지문 막대의 원천 — 16진 32자리. 장식이다. */
const SAMPLE_KEY = 'z6MkqR8v&hellip;Vt9x';
const SAMPLE_KEY_HEX = '9d4f27a1c03e8b56f1a2d7c49e0b835f';

function didMarkup(): string {
  return `<span class="did">${SAMPLE_DID_SEGMENTS.map((s) => `<span>${s}</span>`).join('<span class="sep">:</span><wbr>')}</span>`;
}

/** 공개키 지문 막대(인라인 SVG — 리소스 요청이 아니다, CSP 무관). 16진 한 자리 = 막대 하나, 높이가 값. 보조기술에는 숨긴다. */
function fingerprintSvg(): string {
  const bars = [...SAMPLE_KEY_HEX]
    .map((ch, i) => {
      const h = 4 + parseInt(ch, 16) * 1.25;
      return `<rect x="${String(i * 5)}" y="${String((24 - h) / 2)}" width="3" height="${String(h)}"></rect>`;
    })
    .join('');
  return `<svg class="fp" viewBox="0 0 158 24" preserveAspectRatio="none" aria-hidden="true" focusable="false">${bars}</svg>`;
}

/**
 * 예시 카드의 신원 무늬(비평 R10-12 · 리드 판정) — 콘솔 ID 카드(`src/admin/ui/console/router.ts` `ART_JS` · `script/identity.ts` `drawCard`)와
 * **같은 공식**으로, 모듈 로드 때 한 번 정적 SVG 로 그린다(홈에는 스크립트가 없다). 예시 지문 `SAMPLE_ART_FP` 의 앞 두 바이트
 * 가 모양(꽃잎 수·진폭·위상)을 정한다. **색은 입히지 않는다** — 콘솔은 키 hue(보라-분홍 대역)로 칠하지만, 이 사이트는 완전 흑백
 * 뿐이라 예시 무늬는 잉크 선 + 평면 회색 바탕(`.idc .idc-art` — 토큰만, AI 티 감사 C1 · 2026-09-27). 선 수는 콘솔보다 적게(점 144개).
 */
const SAMPLE_ART_FP = '0087' + SAMPLE_KEY_HEX.slice(4) + SAMPLE_KEY_HEX;

function artByte(i: number): number {
  return parseInt(SAMPLE_ART_FP.slice(i * 2, i * 2 + 2), 16);
}

function rosette(cx: number, cy: number, R: number, A: number, n: number, A2: number, m: number, phi: number, steps: number): string {
  const r1 = (v: number): string => String(Math.round(v * 10) / 10);
  let d = '';
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * 2 * Math.PI;
    const r = R + A * Math.sin(n * t + phi) + A2 * Math.sin(m * t);
    d += `${i === 0 ? 'M' : 'L'}${r1(cx + r * Math.cos(t))} ${r1(cy + r * Math.sin(t))}`;
  }
  return `${d}Z`;
}

function artSvg(): string {
  const n = 5 + (artByte(2) % 8);
  const m = 2 + (artByte(3) % 3);
  const A = 4 + (artByte(4) % 6);
  const A2 = 1 + (artByte(5) % 3);
  const phi = (artByte(6) / 255) * 2 * Math.PI;
  const k = 7 + (artByte(7) % 5);
  const lines = Array.from({ length: k }, (_, j) => `<path class="rl" d="${rosette(50, 50, 14 + j * (26 / k), A, n, A2, m, phi, 144)}"></path>`).join('');
  return (
    '<div class="idc-art" aria-hidden="true"><svg class="idc-svg" viewBox="0 0 100 100" focusable="false">' +
    lines +
    `<path class="rim" d="${rosette(50, 50, 47, 1.2, 24, 0, 1, 0, 288)}"></path>` +
    '<circle class="disc" cx="50" cy="50" r="19"></circle>' +
    '</svg></div>'
  );
}

/** 신원 카드 앞면 — 히어로 무대의 가운데 카드와 ④ 의 예시 카드가 같은 조각을 쓴다(값이 하나). */
function idFront(c: (key: string) => string, extra = ''): string {
  return (
    `<div class="idc front${extra}">` +
    `<div class="idc-top"><span class="idc-logo">${LOGO_TEXT}</span><span>${c('cardKind')}</span></div>` +
    '<div class="idc-id"><div>' +
    `<p class="idc-name">${SAMPLE_AGENT.name}</p>` +
    `<p class="idc-addr">${agentAddress(SAMPLE_AGENT.localPart)}</p>` +
    '</div>' +
    artSvg() +
    '</div>' +
    '<dl class="idc-f">' +
    `<div class="w"><dt>DID</dt><dd>${didMarkup()}</dd></div>` +
    // 날짜는 언어별 표기(용어집 — ko 2026.09.24 · en Sep 24, 2026, 콘솔 ID 카드와 같은 모양). 값의 원천은 `SAMPLE_AGENT.issued`(테스트가 대조).
    `<div><dt>${c('cardIssued')}</dt><dd class="num">${c('cardIssuedValue')}</dd></div>` +
    `<div><dt>${c('cardStatus')}</dt><dd><span class="pill on"><span class="dot" aria-hidden="true"></span>${c('cardStatusValue')}</span></dd></div>` +
    '</dl>' +
    '</div>'
  );
}

/** ④ 의 예시 카드 한 벌(앞·뒤) — 창빛 사진 위에 비스듬히 겹쳐 놓는다. */
function idCard(c: (key: string) => string): string {
  const json =
    '<pre class="json"><code>' +
    '{\n' +
    '  <span class="k">"type"</span>: "AtmarkAgentPassport",\n' +
    '  <span class="k">"status"</span>: "published",\n' +
    '  <span class="k">"credentialSubject"</span>: {\n' +
    `    <span class="k">"name"</span>: "${SAMPLE_AGENT.name}",\n` +
    `    <span class="k">"address"</span>: "${SAMPLE_AGENT.localPart}<span class="at">@</span>atmark.ai"\n` +
    '  }\n' +
    '}</code></pre>';
  const back =
    '<div class="idc back">' +
    `<div class="idc-top"><span>${c('cardBackKind')} &middot; <code>passport.jws</code></span><span><code>EdDSA</code></span></div>` +
    `<dl class="idc-k"><div><dt>${c('cardKey')}</dt><dd class="key">${SAMPLE_KEY}</dd></div></dl>` +
    fingerprintSvg() +
    json +
    `<dl class="idc-k"><div><dt>${c('cardOwner')}</dt><dd>${c('cardOwnerValue')} <span class="priv">${c('cardOwnerNote')}</span></dd></div></dl>` +
    '</div>';
  return `<figure class="deck" aria-label="${c('cardLabel')}">${idFront(c)}${back}</figure>`;
}

/** ⑤ 의 각 줄 — 무엇을 보면 되는지(코드 조각이라 두 언어가 같다). 절대 URL 을 쓰지 않는다(`//` 없음). */
const PROOF_CODE: Readonly<Record<'p1' | 'p2' | 'p3', string>> = {
  p1: `${SITE_IDENTITY_HOST}/agents/&hellip;/did.json`,
  p2: `${SITE_IDENTITY_HOST}/agents/&hellip;/passport.jws`,
  p3: `${SITE_IDENTITY_HOST}/log/checkpoint`,
};

/** ④ 의 사실 셋 머리표 — 받는 것의 실물 이름. */
const FACT_TAGS: Readonly<Record<'f1' | 'f2' | 'f3', string>> = {
  f1: 'did.json',
  f2: 'passport.jws',
  f3: 'console',
};

/**
 * 홈 FAQ 의 질문 키 — 본문 `<details>` 와 FAQPage JSON-LD 가 이 순서 하나를 쓴다. 운영자 질문은 뺐다(진윤겸 2026-09-30 — 약관 제1조·구조화 데이터에만).
 * 2026-10-01: 5번만 대기자 명단 초대 사실에 맞게 고쳤다(히어로 개편은 진윤겸이 되돌렸다 — 홈은 글자를 적게).
 */
export const HOME_FAQ_KEYS = ['1', '2', '3', '4', '5'] as const;

/** 답 조각의 `{contact}` 자리 — 문의 주소 링크(없으면 "공개 전에 안내" 문구). */
function faqAnswerHtml(lang: SiteLang, key: (typeof HOME_FAQ_KEYS)[number]): string {
  return (HOME_COPY[lang][`a${key}`] ?? '').replace('{contact}', contactHtml(lang));
}

/** FAQ 평문(질문·답) — 구조화 데이터(FAQPage)와 llms.txt 가 쓴다. 본문의 글자와 같다(테스트가 대조). */
export function homeFaq(lang: SiteLang): FaqEntry[] {
  return HOME_FAQ_KEYS.map((key) => ({ question: plainText(HOME_COPY[lang][`q${key}`] ?? ''), answer: plainText(faqAnswerHtml(lang, key)) }));
}

/** FAQ 펼침 표시 — `<details open>` 이면 CSS 가 돌린다(스크립트 없음). */
const PLUS_ICON = lineIcon('M8 3v10M3 8h10', 'ico pm');

/** 유리 카드 머리의 선 아이콘(16 · 선 1.5) — 받은 메일(봉투) · 보냄(종이비행기) · 답장(굽은 화살표) · 기록(고리). 색은 글자색. */
const MAIL_ICON = lineIcon('M2.5 4h11v8h-11zM2.5 4.5 8 9l5.5-4.5');
const SENT_ICON = lineIcon('M14 2 7 9M14 2l-4.5 12L7 9 2 6.5z');
const REPLY_ICON = lineIcon('M6 4 2.5 7.5 6 11M2.5 7.5H10a3.5 3.5 0 0 1 3.5 3.5v1');
const ID_ICON = lineIcon('M2 3.5h12v9H2zM4.5 10.5c.4-1.2 1.4-1.8 2-1.8s1.6.6 2 1.8M6.5 7.6a1.3 1.3 0 1 0 0-2.6 1.3 1.3 0 0 0 0 2.6M10 6.5h2M10 8.5h2');
const LINK_ICON = lineIcon('M6.5 9.5l3-3M7 4.5l1-1a2.8 2.8 0 0 1 4 4l-1 1M9 11.5l-1 1a2.8 2.8 0 0 1-4-4l1-1');

/** 예시 상대(실제 회사·서비스 이름 없음 — `example.com` 만)와 예시 값. 기록의 해시는 장식용 16진 조각이다. */
const HERO_SAMPLE = {
  inboundFrom: 'verify@example.com',
  sentTo: 'team@example.com',
  replyFrom: 'partner@example.com',
  code: '482 913',
  logSeq: '#4821',
  logHash: 'a3f9&hellip;7c21',
  you: 'you@example.com',
} as const;

/**
 * ① 의 무대 — 가운데 신원 카드와 그 둘레의 유리 메일 카드 넷, 뒤에는 궤도 선(장식 SVG)과 빛점 셋. 한 `<figure>` 에 묶고 이름은 `aria-label`
 * 하나(카드 안의 글자는 그대로 읽힌다). 좁은 화면에서는 메일 카드 둘(받은 코드 · 보냄)만 카드 모서리에 겹친다.
 */
function heroStage(c: (key: string) => string): string {
  const mail =
    '<div class="glass m m1">' +
    `<div class="gh"><span class="gk">${MAIL_ICON}${c('inboxHead')}</span><span class="gt">${c('inboxTime')}</span></div>` +
    `<p class="gs">${c('inboxSubject')}</p>` +
    `<p class="gcode">${HERO_SAMPLE.code}</p>` +
    `<p class="gf"><span class="addr">${HERO_SAMPLE.inboundFrom}</span></p>` +
    '</div>';
  const sent =
    '<div class="glass m m2">' +
    `<div class="gh"><span class="gk">${SENT_ICON}${c('sentHead')}</span><span class="pill on"><span class="dot" aria-hidden="true"></span>${c('sentVerdict')}</span></div>` +
    `<p class="gs">${c('sentSubject')}</p>` +
    `<p class="gf">${c('to')} <span class="addr">${HERO_SAMPLE.sentTo}</span></p>` +
    '</div>';
  const reply =
    '<div class="glass m m3">' +
    `<div class="gh"><span class="gk">${REPLY_ICON}${c('replyHead')}</span><span class="gt">${c('replyTime')}</span></div>` +
    `<p class="gs">${c('replySubject')}</p>` +
    `<p class="gf"><span class="addr">${HERO_SAMPLE.replyFrom}</span></p>` +
    '</div>';
  const log =
    '<div class="glass m m4">' +
    `<div class="gh"><span class="gk">${LINK_ICON}${c('logHead')}</span><span class="gt">${HERO_SAMPLE.logSeq}</span></div>` +
    `<p class="gs">${c('logNote')}</p>` +
    `<p class="gf mono">prev ${HERO_SAMPLE.logHash}</p>` +
    '</div>';
  return `<figure class="stage" aria-label="${c('uiLabel')}">${idFront(c, ' hero-id')}${mail}${sent}${reply}${log}</figure>`;
}

// ---------------------------------------------------------------------------
// ③ 의 움직이는 그림 넷 — 인라인 SVG(장식 · 보조기술에 숨김 · 색은 스타일시트 토큰). 움직임은 CSS 키프레임이고, 모션 줄이기에서는 멈춘 첫
// 장면이 그 자체로 뜻이 통하게 그린다(주소 칸 · 서명된 카드 · 이어진 블록 · 켜진 스위치).
// ---------------------------------------------------------------------------

const svgOpen = (cls: string): string => `<svg class="il ${cls}" viewBox="0 0 240 160" aria-hidden="true" focusable="false">`;

/** 봉투 하나(28×20) — `x`·`y` 는 왼쪽 위. */
const envelope = (cls: string, x: number, y: number): string =>
  `<g class="env ${cls}"><rect x="${String(x)}" y="${String(y)}" width="28" height="20" rx="3"></rect><path d="M${String(x)} ${String(y + 1)}l14 10 14-10"></path></g>`;

/** 자기 주소 — 봉투가 에이전트 칸으로만 떨어진다(당신 칸은 옅게, 그대로). */
const IL_ADDRESS =
  svgOpen('il-addr') +
  '<rect class="slot dim" x="14" y="104" width="100" height="36" rx="18"></rect>' +
  '<text class="slot-t dim" x="64" y="127">you@</text>' +
  '<rect class="slot on" x="126" y="104" width="100" height="36" rx="18"></rect>' +
  '<text class="slot-t" x="176" y="127">scout@</text>' +
  envelope('e1', 162, 18) +
  envelope('e2', 162, 18) +
  '</svg>';

/** 서명된 신원 — 카드 · 서명 선이 그려지고 · 도장이 찍힌다. */
const IL_SIGN =
  svgOpen('il-sign') +
  '<rect class="card" x="30" y="22" width="180" height="112" rx="14"></rect>' +
  '<circle class="face" cx="62" cy="54" r="14"></circle>' +
  '<rect class="ln b1" x="86" y="44" width="74" height="8" rx="4"></rect>' +
  '<rect class="ln b2" x="86" y="58" width="52" height="6" rx="3"></rect>' +
  '<rect class="ln b3" x="46" y="84" width="96" height="5" rx="2.5"></rect>' +
  '<path class="sig" d="M48 116c10-14 16-14 18-4s8 8 14-4 10-6 12 2 10 4 18-6"></path>' +
  '<g class="seal"><circle cx="178" cy="106" r="17"></circle><path d="M170 106l6 6 10-12"></path></g>' +
  '</svg>';

/** 변조 흔적이 남는 기록 — 블록 넷이 고리로 이어지고, 다섯째가 이어 붙는다. */
const IL_CHAIN =
  svgOpen('il-chain') +
  [0, 1, 2, 3]
    .map((i) => {
      const x = 8 + i * 58;
      const hash = ['a3f9', '7c21', 'e04b', '19d6'][i] ?? '';
      return (
        `<g class="blk bk${String(i + 1)}"><rect x="${String(x)}" y="56" width="42" height="48" rx="8"></rect>` +
        `<text x="${String(x + 21)}" y="85">${hash}</text></g>` +
        (i < 3 ? `<path class="lnk lk${String(i + 1)}" d="M${String(x + 42)} 80h16"></path>` : '')
      );
    })
    .join('') +
  '<path class="tick" d="M8 128h216"></path>' +
  '<circle class="anchor" cx="216" cy="128" r="4"></circle>' +
  '</svg>';

/** 스위치 하나로 관리 — 스위치가 켜지면 메일 점이 관문을 지나고, 꺼지면 관문에서 멈춘다. */
const IL_SWITCH =
  svgOpen('il-switch') +
  '<rect class="tg" x="18" y="64" width="60" height="32" rx="16"></rect>' +
  '<circle class="knob" cx="62" cy="80" r="11"></circle>' +
  '<path class="rail" d="M100 80h124"></path>' +
  '<path class="gate" d="M172 50v60"></path>' +
  '<circle class="mdot" cx="108" cy="80" r="7"></circle>' +
  '<path class="stop" d="M180 70l-12 20M168 70l12 20"></path>' +
  '</svg>';

const ILLUSTRATIONS: Readonly<Record<'k1' | 'k2' | 'k3' | 'k4', string>> = { k1: IL_ADDRESS, k2: IL_SIGN, k3: IL_CHAIN, k4: IL_SWITCH };

/*
 * ⑤ 직접 확인의 그림 셋(어두운 띠 — `.il.inv`, 진윤겸 2026-09-30 "이렇게 작동합니다처럼"). 멈춘 모습(모션 줄이기)이 다 끝난 장면이다 —
 * 줄은 다 적혀 있고, 열쇠는 서명 위에, 확인 표시는 켜져 있다.
 */
/** 신원 문서 조회 — 주소창(did.json) 아래로 공개 키 · 주소 줄이 차례로 적히고, 돋보기가 훑는다. */
const IL_DID =
  svgOpen('inv il-did') +
  '<rect class="pdoc" x="40" y="18" width="160" height="124" rx="12"></rect>' +
  '<rect class="pbar" x="52" y="30" width="136" height="16" rx="8"></rect>' +
  '<text class="pbar-t" x="120" y="41.5">did.json</text>' +
  '<g class="key-g"><circle cx="62" cy="72" r="6"></circle><path d="M68 72h10M74 72v5"></path></g>' +
  '<rect class="dl d1" x="86" y="68" width="98" height="8" rx="4"></rect>' +
  '<rect class="dl d2" x="56" y="92" width="128" height="8" rx="4"></rect>' +
  '<rect class="dl d3" x="56" y="112" width="84" height="6" rx="3"></rect>' +
  '<g class="mag"><circle cx="170" cy="112" r="13"></circle><path d="M180 122l12 12"></path></g>' +
  '</svg>';
/** Passport 서명 확인 — 서명한 신분증 위로 공개 키가 들어와 서명에 맞물리면 확인 표시가 켜진다. */
const IL_VERIFY =
  svgOpen('inv il-verify') +
  '<rect class="pdoc" x="24" y="30" width="136" height="100" rx="12"></rect>' +
  '<rect class="dl" x="40" y="48" width="64" height="8" rx="4"></rect>' +
  '<rect class="dl dim" x="40" y="62" width="44" height="6" rx="3"></rect>' +
  '<path class="vsig" d="M40 106c10-14 16-14 18-4s8 8 14-4 10-6 12 2 10 4 18-6"></path>' +
  '<g class="vkey"><circle cx="196" cy="100" r="11"></circle><path d="M185 100h-30M163 100v8M171 100v6"></path></g>' +
  '<g class="vok"><circle cx="146" cy="44" r="16"></circle><path d="M138 44l6 6 10-12"></path></g>' +
  '</svg>';
/** 체크포인트 비교 — 시각 T1 의 기록 줄과 T2 의 줄. T2 는 T1 을 그대로 품고 뒤에 한 칸만 늘었다(앞부분이 같다 → 확인). */
const IL_CHECKPOINT = ((): string => {
  const block = (cls: string, x: number, y: number, t: string): string =>
    `<g class="cb ${cls}"><rect x="${String(x)}" y="${String(y)}" width="34" height="26" rx="6"></rect><text x="${String(x + 17)}" y="${String(y + 16.5)}">${t}</text></g>`;
  const hashes = ['a3f9', '7c21', 'e04b', '19d6'];
  const row1 = hashes.slice(0, 3).map((h, i) => block('r1', 56 + i * 42, 30, h)).join('');
  const row2 = hashes.map((h, i) => block(i === 3 ? 'r2 new' : 'r2', 56 + i * 42, 98, h)).join('');
  const links = [0, 1, 2].map((i) => `<path class="cm m${String(i + 1)}" d="M${String(73 + i * 42)} 58v38"></path>`).join('');
  return (
    svgOpen('inv il-ckpt') +
    '<text class="cl" x="30" y="47">T1</text><text class="cl" x="30" y="115">T2</text>' +
    row1 + links + row2 +
    '<g class="vok cok"><circle cx="212" cy="44" r="14"></circle><path d="M205 44l5 5 9-11"></path></g>' +
    '</svg>'
  );
})();
const PROOF_ILLUSTRATIONS: Readonly<Record<'p1' | 'p2' | 'p3', string>> = { p1: IL_DID, p2: IL_VERIFY, p3: IL_CHECKPOINT };

/**
 * ②-2 방어 그림(560×320, 2026-10-08 개정 — 진윤겸 "그 아이콘도 좀 달라져야할듯"). 왼쪽이 바깥, 가운데 위가 에이전트(`scout@`).
 * 모든 메일이 한 검사선(채운 막대 — 첫 겹)을 지나 세 갈래로 나뉜다:
 *   - 깨끗한 메일 — 위 갈래로 옅은 점선(둘째 겹, AI 감시)을 지나 에이전트 칸에 들어가 사라진다.
 *   - 위험 메일 — 가운데 갈래, **테두리 표**(빈 원 + !)를 달고 에이전트에 닿는다. 그 뒤 에이전트가 바깥으로 보내는 답장은 오른쪽 **승인 문**(막대 + 체크 원 —
 *     소유자 확인)에서 멈춘다.
 *   - 차단 메일 — 아래 갈래, **채운 표**(검은 원 + !)를 달고 보류 칸에 머문다. 칸 옆 종(소유자 알림)이 울린다 — 소유자가 풀 때까지 대기.
 * **좌표는 끝 장면**이다 — 키프레임은 시작 위치를 `translate` 로 준다. 그래서 모션 줄이기(애니메이션 없음)는 그대로 끝 장면: 테두리 표를 단 봉투 ·
 * 보류 칸의 검은 표 봉투와 종 · 승인 문 앞의 답장(깨끗한 메일은 에이전트 안으로 사라져 보이지 않는다). 글자는 `scout@` 하나(두 언어 공통). 색 없음.
 */
const defBadge = (cls: 'r' | 'k', cx: number, cy: number): string =>
  `<g class="bdg ${cls}"><circle cx="${String(cx)}" cy="${String(cy)}" r="7"></circle><path d="M${String(cx)} ${String(cy - 3.5)}v3.6M${String(cx)} ${String(cy + 2.6)}v.2"></path></g>`;
const IL_DEFENSE =
  '<svg class="il il-def" viewBox="0 0 560 320" aria-hidden="true" focusable="false">' +
  '<path class="lane" d="M16 156H132"></path>' +
  '<path class="lane" d="M144 100H300"></path>' +
  '<path class="lane" d="M144 156H300"></path>' +
  '<path class="lane" d="M144 244H312"></path>' +
  '<path class="lane" d="M420 156H544"></path>' +
  '<path class="lane" d="M408 244H436"></path>' +
  '<rect class="tray" x="312" y="218" width="96" height="52" rx="12"></rect>' +
  '<rect class="l1" x="132" y="48" width="12" height="224" rx="6"></rect>' +
  '<path class="l2" d="M232 80V176"></path>' +
  '<rect class="agent" x="300" y="72" width="120" height="112" rx="16"></rect>' +
  '<text class="agent-t" x="360" y="133">scout@</text>' +
  '<rect class="gate" x="488" y="134" width="8" height="44" rx="4"></rect>' +
  '<circle class="ring" cx="492" cy="112" r="13"></circle>' +
  '<g class="badge ok"><circle cx="492" cy="112" r="13"></circle><path d="M486 112l4 4 8-9"></path></g>' +
  '<circle class="ring rb" cx="450" cy="244" r="14"></circle>' +
  '<g class="badge bell"><circle cx="450" cy="244" r="14"></circle><path d="M444 249h12l-2-3v-5a4 4 0 0 0-8 0v5zM448.5 252.5h3"></path></g>' +
  envelope('ea', 320, 90) +
  `<g class="ec">${envelope('', 262, 146)}${defBadge('r', 290, 146)}</g>` +
  `<g class="eb">${envelope('bad', 346, 234)}${defBadge('k', 374, 234)}</g>` +
  envelope('ed', 452, 146) +
  '</svg>';

function homePage(lang: SiteLang): SitePage {
  const c = (key: string): string => HOME_COPY[lang][key] ?? '';
  const cta = (extra = ''): string =>
    `<div class="actions${extra}">` +
    `<a class="btn" href="${sitePath(lang, 'waitlist')}">${c('waitlist')} ${ARROW_RIGHT_ICON}</a>` +
    `<a class="btn ghost" href="${docsUrl(lang)}">${c('docs')}</a>` +
    '</div>';

  // ① 히어로 — 사진(첫 화면의 가장 큰 그림 — fetchpriority high) · 가운데 헤드라인 · 한 줄 · CTA · 무대(신원 카드 + 둘레의 메일).
  const hero =
    '<section class="hero" aria-labelledby="hero-title">' +
    `<div class="hero-media">${photoImg('desk-window', c('heroAlt'), { sizes: '100vw', priority: true })}</div>` +
    '<div class="hero-in">' +
    '<div class="hero-copy">' +
    `<h1 id="hero-title">${c('h1')}</h1>` +
    `<p class="lede">${c('lede')}</p>` +
    cta() +
    '</div>' +
    heroStage(c) +
    '</div></section>';

  // 절 제목에는 번호를 달지 않는다(장식 번호 금지 — 콘솔과 같은 규칙).
  const head = (id: string, key: string): string => `<div class="sec-head"><h2 id="${id}">${c(key)}</h2></div>`;

  // ② 분리 — 큰 두 줄 제목 · 한 줄, 오른쪽에 사서함 사진과 그 위에 겹친 받은편지함 둘(당신 — 옅게 · 에이전트 — 검은 면).
  const row = (key: string): string => `<li>${c(key)}</li>`;
  const split =
    '<section class="sec sep" aria-labelledby="split-title"><div class="sec-in sep-in">' +
    '<div class="sep-copy rv">' +
    `<h2 id="split-title">${c('splitTitle')}</h2>` +
    `<p class="sec-lede">${c('splitBody')}</p>` +
    '</div>' +
    `<figure class="sep-fig" aria-label="${c('splitLabel')}">` +
    `<div class="photo">${photoImg('post-boxes', c('splitAlt'), { sizes: '(min-width: 960px) 620px, 100vw' })}</div>` +
    '<div class="box you">' +
    `<p class="bh"><span>${c('youHead')}</span><span class="addr">${HERO_SAMPLE.you}</span></p>` +
    `<ul>${row('y1')}${row('y2')}${row('y3')}</ul>` +
    '</div>' +
    // 다른 서비스 가입 양식(진윤겸 2026-09-30) — 이메일 칸에 에이전트 주소, 그 인증 코드가 아래 에이전트 메일함 첫 줄로 온다. 좁은 화면에서는 숨긴다.
    '<div class="box join" aria-hidden="true">' +
    `<p class="bh"><span>${c('joinHead')}</span></p>` +
    `<p class="jf"><span class="jl">${c('joinEmail')}</span>${agentAddress(SAMPLE_AGENT.localPart)}</p>` +
    `<p class="jb">${c('joinGo')}</p>` +
    '</div>' +
    '<div class="box agent">' +
    `<p class="bh"><span>${c('agentHead')}</span>${agentAddress(SAMPLE_AGENT.localPart)}</p>` +
    `<ul>${row('r1')}${row('r2')}${row('r3')}</ul>` +
    '</div>' +
    '</figure>' +
    '</div></section>';

  // ③ 작동 방식 — 네 칸(구분선 없음): 움직이는 그림 · 제목 · 한 줄.
  const pillar = (key: keyof typeof ILLUSTRATIONS): string =>
    '<li class="pl rv">' +
    `<div class="pl-fig">${ILLUSTRATIONS[key]}</div>` +
    `<h3>${c(`${key}Title`)}</h3>` +
    `<p>${c(`${key}Body`)}</p>` +
    '</li>';
  const how =
    '<section class="sec tone" aria-labelledby="how-title"><div class="sec-in">' +
    head('how-title', 'howTitle') +
    `<ol class="pillars">${pillar('k1')}${pillar('k2')}${pillar('k3')}${pillar('k4')}</ol>` +
    // 사용 예시(2026-10-01) — 앞의 세 쓰임새를 작은 카드로, 전체는 `/use-cases`.
    homeUseCaseCards(lang) +
    '</div></section>';

  // ④ 신원 카드 — 창빛 사진 위에 놓인 예시 카드 앞·뒤 + 사실 셋(머리표 + 한 줄).
  const fact = (key: keyof typeof FACT_TAGS): string =>
    `<li class="rv"><span class="lbl">${FACT_TAGS[key]}</span><h3>${c(`${key}Title`)}</h3></li>`;
  // ③ 다리(진윤겸 2026-09-30 — 신원이 갑자기 나오지 않게): 받는 쪽 메일함에 Scout 의 메일이 오고 "누가 보낸 거지?" → 받은 사람이 **보낸 주소로
  //   조회**한다(메일에 버튼은 없다 — 실제 경로는 공개 조회 `id.atmark.ai/v1/identity/{address}`). 게시한 신원은 나오고, 비공개는 "찾을 수 없음"
  //   (게시 안 함과 없음은 구별되지 않는다 — 문서 identity/verify). 다음 절(신원 카드)이 그 조회 결과다. 움직임은 CSS 한 바퀴(6초), 멈춘 모습은 끝 장면.
  const bridge =
    '<section class="sec brg" aria-labelledby="bridge-title"><div class="sec-in brg-in">' +
    '<div class="brg-copy rv">' +
    `<h2 id="bridge-title">${c('bridgeTitle')}</h2>` +
    `<p class="sec-lede">${c('bridgeBody')}</p>` +
    '</div>' +
    `<figure class="rin" aria-label="${c('bridgeLabel')}">` +
    `<p class="rin-h"><span>${c('rinHead')}</span><span class="rin-to">partner@example.com</span></p>` +
    '<ul>' +
    '<li class="rin-row on">' +
    `<span class="rin-from"><b>${SAMPLE_AGENT.name}</b> ${agentAddress(SAMPLE_AGENT.localPart)}</span>` +
    `<span class="rin-s">${c('rinS1')}</span>` +
    `<span class="rin-q" aria-hidden="true">${c('rinAsk')}</span>` +
    '</li>' +
    `<li class="rin-row"><span class="rin-from"><b>${c('rinF2')}</b></span><span class="rin-s">${c('rinS2')}</span></li>` +
    `<li class="rin-row"><span class="rin-from"><b>${c('rinF3')}</b></span><span class="rin-s">${c('rinS3')}</span></li>` +
    '</ul>' +
    '<div class="look">' +
    `<p class="look-h">${ID_ICON}<span>${c('lookHead')}</span><span class="look-host">${SITE_IDENTITY_HOST}</span></p>` +
    `<p class="look-row l1"><span class="look-q">${agentAddress(SAMPLE_AGENT.localPart)}</span><span class="look-r"><span class="pill on"><span class="dot" aria-hidden="true"></span>${c('lookPub')}</span>${c('lookPubValue')}</span></p>` +
    `<p class="look-row l2"><span class="look-q">${agentAddress('research')}</span><span class="look-r"><span class="pill">${c('lookPriv')}</span>${c('lookPrivValue')}</span></p>` +
    '</div>' +
    '</figure>' +
    '</div></section>';

  const get =
    '<section class="sec" aria-labelledby="get-title"><div class="sec-in">' +
    `<div class="sec-head"><h2 id="get-title">${c('getTitle')}</h2><p class="sec-lede">${c('getLede')}</p></div>` +
    '<div class="desk">' +
    `<div class="desk-photo">${photoImg('window-light', c('getAlt'), { sizes: '(min-width: 1200px) 1136px, 100vw' })}</div>` +
    idCard(c) +
    '</div>' +
    `<ul class="facts">${fact('f1')}${fact('f2')}${fact('f3')}</ul>` +
    '</div></section>';

  // ⑤ 직접 확인 — 화면 가득한 어두운 띠, 큰 코드 줄 셋(제목만). **지금 실제로 동작하는 것만**(did:web 해석 · passport JWS · 로그 체크포인트).
  // 신원에 대해 "독립 검증 가능" 은 Phase C 전까지 쓰지 않는다(`site-wording.test.ts`).
  // 각 줄 = 무엇을 확인하나(쉬운 말 제목) · 한두 문장 · 어디서 보나(코드 칩). 끝에 문서의 확인 절차 링크(진윤겸 2026-09-30 — "뭐가 뭔지 모르겠다").
  const proof = (key: keyof typeof PROOF_CODE): string =>
    '<li class="proof rv">' +
    `<div class="pf-fig">${PROOF_ILLUSTRATIONS[key]}</div>` +
    `<h3>${c(`${key}Title`)}</h3><p>${c(`${key}Body`)}</p>` +
    `<div class="pw"><span class="pl-k">${c('proofWhere')}</span><code class="pc">${PROOF_CODE[key]}</code></div></li>`;
  const proofSec =
    '<section class="dark" aria-labelledby="proof-title"><div class="sec-in">' +
    `<div class="sec-head"><h2 id="proof-title">${c('proofTitle')}</h2><p class="sec-lede">${c('proofLede')}</p></div>` +
    `<ul class="proofs">${proof('p1')}${proof('p2')}${proof('p3')}</ul>` +
    `<p class="pdocs"><a href="${docsUrl(lang)}/identity/verify">${c('proofDocs')} ${ARROW_RIGHT_ICON}</a></p>` +
    '</div></section>';

  // ②-2 두 겹 방어(2026-10-07 · 분리 절 바로 다음) — 눈썹 · 제목 · 한 줄 · 그림 · 겹 둘. 겹 칸의 위 선이 그림의 겹 모양과 같다(첫 겹 = 단단한 선 · 둘째 겹 = 점선).
  const layer = (key: 'l1' | 'l2', note = ''): string =>
    `<li class="ly ${key} rv"><p class="ly-k">${c(`${key}Tag`)}</p><h3>${c(`${key}Title`)}</h3><p>${c(`${key}Body`)}</p>${note}</li>`;
  const defense =
    '<section class="sec def" aria-labelledby="def-title"><div class="sec-in def-in">' +
    '<div class="def-copy rv">' +
    `<p class="def-k">${c('defKicker')}</p>` +
    `<h2 id="def-title">${c('defTitle')}</h2>` +
    `<p class="sec-lede">${c('defLede')}</p>` +
    '</div>' +
    `<figure class="df-fig" aria-label="${c('defLabel')}">${IL_DEFENSE}</figure>` +
    `<ol class="layers">${layer('l1')}${layer('l2', `<p class="ly-n">${c('l2Note')}</p>`)}</ol>` +
    '</div></section>';

  // ⑥ 자주 묻는 질문(AEO) — 질문형 제목 + 정의형 첫 문장 답. 같은 질문·답이 FAQPage 구조화 데이터로도 실린다(`homeFaq`).
  const faqItem = (key: (typeof HOME_FAQ_KEYS)[number]): string =>
    `<details><summary><h3>${c(`q${key}`)}</h3>${PLUS_ICON}</summary><p>${faqAnswerHtml(lang, key)}</p></details>`;
  const faq =
    '<section class="sec" aria-labelledby="faq-title"><div class="sec-in split faq-in">' +
    `<div class="split-main"><div class="sec-head"><h2 id="faq-title">${c('faqTitle')}</h2>` +
    `<p class="sec-note">${c('faqNote').replace('{contact}', contactHtml(lang))}</p></div></div>` +
    `<div class="faq">${HOME_FAQ_KEYS.map(faqItem).join('')}</div>` +
    '</div></section>';

  // ⑦ 끝 CTA — 가운데 큰 한 줄 + 버튼 둘.
  const band =
    '<section class="cta" aria-labelledby="start-title"><div class="cta-card rv">' +
    `<h2 id="start-title">${c('bandTitle')}</h2>` +
    cta(' center') +
    '</div></section>';

  return buildSitePage({
    lang,
    id: 'home',
    hero: true,
    title: c('title'),
    description: c('description'),
    main: hero + split + defense + how + bridge + get + proofSec + faq + band,
    structured: [websiteNode(lang), faqNode(lang, homeFaq(lang))],
  });
}

export const HOME_PAGES: Readonly<Record<SiteLang, SitePage>> = { ko: homePage('ko'), en: homePage('en') };
