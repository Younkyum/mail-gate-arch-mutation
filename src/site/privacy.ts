/**
 * src/site/privacy.ts — `GET /privacy`(한국어)·`GET /en/privacy`(영어) 개인정보 처리 안내.
 *
 * **두 언어 모두 법률 검토 전 초안이다** — 페이지에는 "초안" 표시를 하지 않고(계약 §6), 저장소 문서(`docs/runbooks/site.md`)에 기록한다.
 * 공개 전에 진윤겸 검토가 필요하다.
 *
 * 사실 근거(지어낸 항목 없음):
 *   - 가입 이메일·조직 이름: `signup_links`·`organizations.owner_email/name`(`signup-contract.md` §1).
 *   - 요청자 IP: DB 에는 HMAC(`client_key`)만. 원문 IP 는 DB 에 두지 않는다. 단, API Gateway 접근 로그(`/atmark/console-access`·
 *     `/atmark/api-access`)는 요청 IP 를 싣는다 — 그래서 "접속 기록" 항목을 따로 둔다(숨기지 않는다).
 *   - 메일: 원문·첨부는 S3(SSE-S3), 메타데이터는 RDS(storageEncrypted) — `storage-stack.ts`·`data-stack.ts`.
 *   - 감사: `owner_actions`(append-only)·관문 판정 기록.
 *   - 위탁: AWS 서울 리전(ap-northeast-2) — 계산·DB·저장소, 메일 발송·수신은 Amazon SES(같은 리전). (2026-10-01 진윤겸: Anthropic 항목은
 *     넣지 않는다 — 운영자가 개인적으로 쓰는 도구는 이 문서가 관리하는 위탁이 아니다.)
 *   - 투명성 로그(ADR-0008, 운영 중): 잎은 5분마다(`TLOG_SCHEDULES` log 5분) · 에폭 마감·서명 체크포인트는 매시(`epoch.ts` — UTC 시 경계) ·
 *     `id.atmark.ai/log/checkpoint` 게시 · OTS 앵커 예약은 하루 1회(`anchor.ts`) · 게시 버킷 Object Lock COMPLIANCE 365일(`TLOG_OBJECT_LOCK_DAYS`,
 *     버저닝 — 다시 써도 이전 판이 남는다). 잎 평문은 모양이 정해진 코드·id·시각뿐, 주소 등은 솔트 커밋(`leaf.ts`). 공개 표면은 에폭 번호·시각·해시뿐(`publisher.ts`).
 *   - 대기자 신청서(202609301530): `waitlist_entries.use_case`·`heard_from`·`ref`(닫힌 값) → 가입 때 `organizations.signup_*` 로 한 번 복사(주소·메모 제외).
 *   - 쿠키: 홈은 쿠키 없음. 콘솔은 로그인 유지·브라우저 결속용 `__Host-` 쿠키만(분석·광고 쿠키 없음).
 *   - 초대받은 사람의 주소: `users.email`(초대할 때 만든다). 멤버가 된 적 없으면 마지막 초대가 끝나고(취소·만료) 30일 뒤 지운다 —
 *     `erase_invited_only_user`(마이그레이션 202609250220, ADR-0010 L7) · 하루 한 번 TTL 스위퍼.
 *   - 쓰이지 않은 가입 링크(`signup_links` — 주소·조직 이름): 발송이 끝났고 만료 30일이 지나면 지운다 — `purge_expired_signup_links`
 *     (202609250240, ADR-0010 L7 M2) · 같은 하루 창.
 *   - 예외(M2): 반송·수신 거부 목록(`system_mail_suppressions`·`suppression_entries` — 원문 주소, 해시하지 않는다: 운영자가 오탐을 복구하려면
 *     읽어야 한다) · DB 자동 백업 14일(`DB_BACKUP_RETENTION_DAYS`). 이 값이 바뀌면 문구도 바꾼다.
 * 보관 기간은 숫자를 정하지 않는다(정책 결정은 검토 몫) — "탈퇴 또는 목적 달성 시까지, 법령상 의무가 있으면 그 기간".
 */

import { effectiveDateText, PRIVACY_EFFECTIVE_DATE, type SiteLang } from './constants';
import { buildSitePage, contactHtml, type SitePage } from './page';

type Section = readonly [id: string, title: string, body: string];

const KO: readonly Section[] = [
  [
    'items',
    '처리하는 개인정보',
    '<p>Atmark는 서비스를 제공하는 데 필요한 정보만 처리합니다.</p>' +
      '<dl class="items">' +
      '<div><dt>가입 이메일</dt><dd>가입과 로그인에 쓰는 조직 소유자의 이메일 주소. <b>가입 확인·로그인 링크</b> 같은 서비스 메일을 이 주소로 보냅니다.</dd></div>' +
      '<div><dt>대기자 명단</dt><dd>대기자 명단에 올린 이메일 주소와, 적었다면 한 줄 메모("Atmark로 무엇을 하고 싶으세요?"). 확인·초대 메일을 보내고 초대 순서를 정하는 데 씁니다. 신청할 때 고른 <b>이용 목적</b>, 답했다면 <b>Atmark를 알게 된 곳</b>, 그리고 신청 페이지 주소에 붙어 온 <b>유입 경로 값</b>(정해 둔 값만 — 그 밖은 "없음"으로 적습니다)도 함께 저장합니다. 이 셋은 초대 순서를 정하고 어떤 경로로 알려졌는지 가늠하는 데 씁니다. 가입하면 이 세 값(이메일 주소와 메모는 제외)을 조직 정보에 옮겨 적습니다.</dd></div>' +
      '<div><dt>조직 이름</dt><dd>가입할 때 적은 이름. 콘솔 표시와 운영자 검토에 씁니다.</dd></div>' +
      '<div><dt>초대받은 사람의 이메일</dt><dd>조직 소유자가 다른 사람을 조직에 초대하면, 초대 메일과 로그인 링크를 보내는 데 그 사람의 이메일 주소를 씁니다.</dd></div>' +
      '<div><dt>요청 IP 주소의 HMAC 값</dt><dd>가입·로그인 요청이 지나치게 잦은지 가리기 위해, 요청한 IP 주소를 비밀 키로 변환한 값만 저장합니다. <b>IP 주소 원문은 데이터베이스에 보관하지 않습니다.</b></dd></div>' +
      '<div><dt>에이전트가 주고받는 메일</dt><dd>에이전트가 보내거나 받은 메일의 원문과 첨부파일은 저장소에, 보낸 사람·받는 사람·제목·시각 같은 메타데이터는 데이터베이스에 저장합니다. 여기에는 <b>에이전트와 메일을 주고받는 상대방의 이메일 주소와 메일 내용</b>이 포함됩니다.</dd></div>' +
      '<div><dt>감사 기록</dt><dd>콘솔에서 한 일(누가, 무엇을, 언제, 어느 대상에)과 발송 관문의 판정 기록. 비밀번호·토큰 같은 비밀 값은 기록하지 않습니다.</dd></div>' +
      '<div><dt>접속 기록</dt><dd>서비스 보안과 장애 대응을 위해 요청 시각, 요청 경로, 응답 결과, 요청 IP 주소가 서버 접속 기록에 남습니다.</dd></div>' +
      '</dl>' +
      '<p>이 홈페이지(atmark.ai)는 언어를 바꾸면 고른 언어를 기억하는 쿠키 하나(<code>atmark_lang</code>)만 씁니다. 콘솔은 로그인 상태를 유지하고 요청한 브라우저를 확인하는 데 필요한 쿠키만 쓰며, 분석·광고용 쿠키나 외부 추적 도구는 쓰지 않습니다.</p>',
  ],
  [
    'purpose',
    '처리 목적',
    '<ol class="list">' +
      '<li>회원 가입, 본인 확인, 로그인과 계정 관리</li>' +
      '<li>에이전트 메일의 발송·수신·보관과 에이전트의 조회</li>' +
      '<li>수신·발신 정책(허용·차단 목록)의 적용, 차단된 수신 메일의 격리·기록, 긴급 정지 등 서비스 통제</li>' +
      '<li>스팸·사칭·남용 방지와 보안 사고 대응, 가입 조직의 운영자 검토</li>' +
      '<li>서비스 운영에 필요한 공지와 문의 응대</li>' +
      '</ol>',
  ],
  [
    'retention',
    '보유 기간',
    '<p>개인정보는 회원 탈퇴 또는 처리 목적을 달성할 때까지 보유합니다. 관계 법령이 일정 기간 보관을 요구하면 그 기간 동안 보관하고, 그 목적으로만 씁니다. 항목별 보관 기간은 다음과 같습니다.</p>' +
      '<dl class="items">' +
      '<div><dt>메일 본문</dt><dd>에이전트가 받은 메일의 원문·첨부파일, 에이전트가 보낸 메일의 본문은 저장한 날로부터 <b>1년</b>이 지나면 자동으로 삭제합니다. 보낸 사람·받는 사람·제목·시각 같은 메타데이터와 발송 판정 기록은 본문과 별도로, 서비스 제공에 필요한 기간 동안 보관합니다.</dd></div>' +
      '<div><dt>접속 기록</dt><dd>요청 시각·경로·응답 결과·요청 IP 주소가 담긴 서버 접속 기록은 <b>3개월</b> 보관한 뒤 삭제합니다.</dd></div>' +
      '<div><dt>초대받은 사람의 이메일</dt><dd>초대를 받고 조직에 들어오지 않은 사람의 이메일 주소는, 마지막 초대가 취소되거나 만료된 날로부터 <b>30일</b>이 지나면 지웁니다.</dd></div>' +
      '<div><dt>대기자 명단</dt><dd>대기 중인 항목은 가입하거나 명단에서 빼 달라고 요청할 때까지 보관합니다. 가입하면 대기자 항목은 지웁니다. 초대를 받고 가입하지 않았다면 초대가 만료된 날로부터 <b>30일</b>이 지나면 지웁니다.</dd></div>' +
      '<div><dt>완료되지 않은 가입 신청</dt><dd>가입을 신청하고 확인 링크를 쓰지 않았다면, 신청한 이메일 주소와 조직 이름은 링크가 만료된 날로부터 <b>30일</b>이 지나면 지웁니다.</dd></div>' +
      '<div><dt>감사 기록</dt><dd>콘솔 행위(누가, 언제, 무엇을 했는지)와 발송 관문의 판정 기록에는 메일 본문이 들어가지 않습니다. 회원 탈퇴 또는 서비스 제공 종료까지 보관합니다.</dd></div>' +
      '</dl>' +
      '<p>위 기간과 별도로 보관하는 것이 두 가지 있습니다.</p>' +
      '<dl class="items">' +
      '<div><dt>반송·수신 거부 목록</dt><dd>메일이 영구적으로 반송되었거나 받은 사람이 스팸으로 신고한 이메일 주소는, 그 주소로 다시 메일을 보내지 않기 위해 반송·수신 거부 목록에 <b>주소 원문 그대로</b> 보관합니다. 위 항목의 주소를 지운 뒤에도 이 목록에는 남습니다. 일시적인 반송은 정해진 만료 시각까지, 영구 반송과 스팸 신고는 해제를 요청하거나 서비스 제공을 종료할 때까지 보관합니다.</dd></div>' +
      '<div><dt>백업</dt><dd>데이터베이스는 장애 복구를 위해 매일 자동으로 백업하며, 백업은 <b>14일</b> 보관합니다. 지운 정보도 그 기간 동안 백업에는 남아 있다가 백업이 교체되면서 사라집니다. 백업은 장애 복구에만 씁니다.</dd></div>' +
      '</dl>' +
      '<p>감사 기록이 나중에 바뀌지 않았는지 공개된 값과 대조해 확인할 수 있도록 투명성 로그를 운영합니다. 발송 판정, 수신 판정, 콘솔 행위, 정책·신원 변경 같은 감사 기록을 5분마다 해시로 이어 로그에 더하고, 매시간 서명한 체크포인트를 <code>id.atmark.ai/log/checkpoint</code>에 공개하며, 하루 한 번 OpenTimestamps로 그 시각을 외부에 고정합니다. 공개되는 것은 서명한 체크포인트와 해시값뿐입니다. 로그 항목에는 메일 내용이나 개인정보가 평문으로 담기지 않고, 주소 같은 값은 솔트를 섞은 해시(커밋값)로만 담깁니다. 공개한 파일은 1년 동안 지울 수 없도록 잠가 두며, 같은 이름으로 다시 써도 이전 판이 남습니다.</p>',
  ],
  [
    'third-party',
    '제3자 제공',
    '<p>Atmark는 개인정보를 제3자에게 제공하지 않습니다. 다만 법령에 특별한 규정이 있거나 수사기관이 법령에 정한 절차에 따라 요구하는 경우는 예외로 합니다.</p>' +
      '<p>에이전트가 보내는 메일은 소유자와 에이전트가 정한 수신자에게 전달됩니다. 이것은 서비스의 기능이며 Atmark가 따로 제공하는 것이 아닙니다.</p>',
  ],
  [
    'processors',
    '처리 위탁',
    '<p>서비스 운영을 위해 다음 업무를 위탁합니다.</p>' +
      '<dl class="items">' +
      '<div><dt>Amazon Web Services, Inc.</dt><dd>서버·데이터베이스·파일 저장소 운영. 데이터는 <b>AWS 서울 리전(ap-northeast-2)</b>에 저장합니다.</dd></div>' +
      '<div><dt>Amazon Web Services, Inc. (Amazon SES)</dt><dd>이메일 발송과 수신 처리(서울 리전).</dd></div>' +
      '</dl>' +
      '<p>위탁 계약에서 개인정보가 안전하게 처리되도록 필요한 사항을 정하고, 수탁자가 바뀌면 이 안내를 고칩니다.</p>',
  ],
  [
    'rights',
    '이용자의 권리',
    '<p>이용자는 언제든지 자기 개인정보의 열람·정정·삭제·처리 정지를 요구할 수 있습니다. 아래 문의처로 요청하면 본인 여부를 확인한 뒤 지체 없이 조치합니다. 법령상 보관 의무가 있는 정보는 삭제 요구에 응하지 못할 수 있으며, 그 사유를 알립니다.</p>',
  ],
  [
    'destruction',
    '파기',
    '<p>보유 기간이 끝났거나 처리 목적을 달성한 개인정보는 지체 없이 파기합니다. 전자 파일은 복구할 수 없는 방법으로 삭제합니다.</p>',
  ],
  [
    'security',
    '안전성 확보 조치',
    '<ul class="list">' +
      '<li>전송 구간 암호화(HTTPS)와 저장 데이터 암호화</li>' +
      '<li>기능별로 나눈 최소 권한의 접근 통제 — 발송·조회·관리가 서로 다른 권한으로 동작합니다</li>' +
      '<li>IP 주소 원문 대신 HMAC 값 저장, 로그인·가입 링크의 단일 사용과 짧은 만료</li>' +
      '<li>콘솔 행위와 발송 판정의 감사 기록</li>' +
      '</ul>',
  ],
  [
    'contact',
    '문의처',
    `<p>개인정보 처리에 관한 문의, 열람·정정·삭제 요구, 피해 구제 요청을 받습니다.</p><p>문의처: ${contactHtml('ko')}</p>` +
      '<p>개인정보 침해에 대한 신고나 상담은 개인정보침해신고센터(국번 없이 118), 개인정보분쟁조정위원회(1833-6972)에도 할 수 있습니다.</p>',
  ],
  [
    'changes',
    '안내의 변경',
    `<p>이 안내는 ${effectiveDateText('ko', PRIVACY_EFFECTIVE_DATE)}부터 적용됩니다. 내용이 바뀌면 시행 전에 이 페이지에 알립니다.</p>`,
  ],
];

const EN: readonly Section[] = [
  [
    'items',
    'What we collect',
    '<p>Atmark processes only the information it needs to run the service.</p>' +
      '<dl class="items">' +
      '<div><dt>Sign-up email</dt><dd>The organization owner&rsquo;s email address, used to sign up and log in. We send service mail such as <b>sign-up confirmations and login links</b> to this address.</dd></div>' +
      '<div><dt>Waitlist</dt><dd>The email address you add to the waitlist and, if you wrote one, your one-line note (&ldquo;What do you want to do with Atmark?&rdquo;). We use them to send the confirmation and invitation emails and to decide the order of invitations. We also store the <b>intended use</b> you choose, <b>where you heard about Atmark</b> if you answer, and the <b>referral value</b> attached to the sign-up page address (only values we have set &mdash; anything else is recorded as &ldquo;none&rdquo;). We use these three to decide the order of invitations and to learn which channels work. When you sign up, we copy these three values (not your email address or note) to your organization&rsquo;s record.</dd></div>' +
      '<div><dt>Organization name</dt><dd>The name you enter at sign-up. Shown in the console and used for operator review.</dd></div>' +
      '<div><dt>Invitee email</dt><dd>When an organization owner invites someone to their organization, we use that person&rsquo;s email address to send the invite and their login link.</dd></div>' +
      '<div><dt>HMAC of the requesting IP address</dt><dd>To detect sign-up and login requests that come too often, we store only a keyed hash of the requesting IP address. <b>The IP address itself is not stored in our database.</b></dd></div>' +
      '<div><dt>Mail your agents send and receive</dt><dd>The raw messages and attachments are kept in file storage; metadata such as sender, recipients, subject and time is kept in our database. This includes <b>the email addresses and message content of the people your agents correspond with</b>.</dd></div>' +
      '<div><dt>Audit records</dt><dd>Actions taken in the console (who did what, when, to which item) and the decisions of the sending gate. Secret values such as tokens are never recorded.</dd></div>' +
      '<div><dt>Access logs</dt><dd>For security and troubleshooting, server access logs record the request time, path, result and the requesting IP address.</dd></div>' +
      '</dl>' +
      '<p>This website (atmark.ai) uses a single cookie (<code>atmark_lang</code>), set only when you switch languages, to remember your choice. The console uses only the cookies it needs to keep you logged in and to confirm the browser that made a request. We use no analytics or advertising cookies and no third-party trackers.</p>',
  ],
  [
    'purpose',
    'Why we process it',
    '<ol class="list">' +
      '<li>Sign-up, identity confirmation, login and account management</li>' +
      '<li>Sending, receiving and storing your agents&rsquo; mail, and letting your agents read it</li>' +
      '<li>Applying receive and send policy (allow and block lists), quarantining and recording blocked inbound mail, and controls such as the emergency stop</li>' +
      '<li>Preventing spam, impersonation and abuse, responding to security incidents, and reviewing new organizations</li>' +
      '<li>Service notices and answering your inquiries</li>' +
      '</ol>',
  ],
  [
    'retention',
    'How long we keep it',
    '<p>We keep personal information until you close your account or the purpose it was collected for has been fulfilled. Where a law requires us to keep it for a set period, we keep it for that period and use it for that purpose only. Retention periods by category:</p>' +
      '<dl class="items">' +
      '<div><dt>Mail bodies</dt><dd>The raw mail and attachments your agents receive, and the body of mail your agents send, are automatically deleted <b>one year</b> after they are stored. Metadata such as sender, recipients, subject and time, and the sending-gate decision record, are kept separately from the body for as long as needed to run the service.</dd></div>' +
      '<div><dt>Access logs</dt><dd>Server access logs (request time, path, result, and requesting IP address) are kept for <b>three months</b> and then deleted.</dd></div>' +
      '<div><dt>Invitee email</dt><dd>If someone is invited but never joins the organization, we erase their email address <b>30 days</b> after their last invite was revoked or expired.</dd></div>' +
      '<div><dt>Waitlist</dt><dd>A waiting entry is kept until you sign up or ask us to take you off the list. When you sign up, we delete the waitlist entry. If you were invited but never signed up, we delete it <b>30 days</b> after the invitation expired.</dd></div>' +
      '<div><dt>Unfinished sign-ups</dt><dd>If someone requests a sign-up but never uses the confirmation link, we delete the email address and organization name <b>30 days</b> after the link expired.</dd></div>' +
      '<div><dt>Audit records</dt><dd>Console actions (who did what, when) and sending-gate decisions never include mail bodies. We keep them until you close your account or we stop running the service.</dd></div>' +
      '</dl>' +
      '<p>Two things are kept separately from the periods above.</p>' +
      '<dl class="items">' +
      '<div><dt>Bounce and complaint lists</dt><dd>Email addresses that bounced permanently or whose recipient marked our mail as spam are kept on a suppression list <b>as the address itself</b>, so that we never send to them again. They stay on this list even after the address is erased elsewhere. Temporary bounces are kept until their set expiry; permanent bounces and spam complaints are kept until removal is requested or we stop running the service.</dd></div>' +
      '<div><dt>Backups</dt><dd>The database is backed up automatically every day for disaster recovery, and backups are kept for <b>14 days</b>. Information we have deleted remains in backups for that period and disappears as backups are replaced. Backups are used only to recover from failures.</dd></div>' +
      '</dl>' +
      '<p>We run a transparency log so that audit records can be checked against public values for later changes. Every five minutes, audit records such as sending decisions, inbound verdicts, console actions, and policy and identity changes are appended to the log as chained hashes. Every hour we publish a signed checkpoint at <code>id.atmark.ai/log/checkpoint</code>, and once a day we timestamp it externally with OpenTimestamps. What we publish is only signed checkpoints and hashes. Log entries never hold mail content or personal information in plain text; values such as addresses appear only as salted hashes (commitments). Published files are locked against deletion for one year, and rewriting a file keeps the earlier version.</p>',
  ],
  [
    'third-party',
    'Sharing with third parties',
    '<p>Atmark does not provide personal information to third parties, except where a law specifically requires it or an investigative authority requests it through legally prescribed procedures.</p>' +
      '<p>Mail your agents send is delivered to the recipients chosen by you and your agents. That is how the service works; it is not Atmark sharing your data.</p>',
  ],
  [
    'processors',
    'Service providers',
    '<p>We use the following providers to run the service.</p>' +
      '<dl class="items">' +
      '<div><dt>Amazon Web Services, Inc.</dt><dd>Servers, database and file storage. Data is stored in the <b>AWS Seoul Region (ap-northeast-2)</b>.</dd></div>' +
      '<div><dt>Amazon Web Services, Inc. (Amazon SES)</dt><dd>Sending and receiving email (Seoul Region).</dd></div>' +
      '</dl>' +
      '<p>Our agreements with these providers require them to handle personal information securely. If a provider changes, we will update this notice.</p>',
  ],
  [
    'rights',
    'Your rights',
    '<p>You can ask at any time to access, correct or delete your personal information, or to stop us processing it. Send your request to the contact below; we will verify your identity and act without delay. Information we are legally required to keep may not be deleted, and we will tell you why.</p>',
  ],
  [
    'destruction',
    'Destruction',
    '<p>When the retention period ends or the purpose has been fulfilled, we destroy the information without delay. Electronic files are deleted in a way that cannot be recovered.</p>',
  ],
  [
    'security',
    'How we protect it',
    '<ul class="list">' +
      '<li>Encryption in transit (HTTPS) and at rest</li>' +
      '<li>Least-privilege access split by function &mdash; sending, reading and administration run under separate permissions</li>' +
      '<li>A keyed hash instead of raw IP addresses; single-use, short-lived login and sign-up links</li>' +
      '<li>Audit records of console actions and sending decisions</li>' +
      '</ul>',
  ],
  [
    'contact',
    'Contact',
    '<p>Questions about how we handle personal information, requests to access, correct or delete it, and complaints are handled here.</p>' +
      `<p>Contact: ${contactHtml('en')}</p>` +
      '<p>You can also report a privacy violation or seek advice from the Korea Internet &amp; Security Agency&rsquo;s Privacy Infringement Report Center (118, within Korea) or the Personal Information Dispute Mediation Committee (1833-6972).</p>',
  ],
  [
    'changes',
    'Changes to this notice',
    `<p>This notice applies from ${effectiveDateText('en', PRIVACY_EFFECTIVE_DATE)}. If it changes, we will post the update on this page before it takes effect.</p>` +
      '<p>This English version is provided for convenience. If it differs from the Korean version, the Korean version prevails.</p>',
  ],
];

const SECTIONS: Readonly<Record<SiteLang, readonly Section[]>> = { ko: KO, en: EN };

const PAGE_COPY: Readonly<Record<SiteLang, Readonly<Record<string, string>>>> = {
  ko: {
    title: '개인정보 처리 안내 | Atmark',
    description: 'Atmark가 처리하는 개인정보의 항목, 목적, 보유 기간, 위탁, 이용자의 권리.',
    kicker: '안내',
    h1: '개인정보 처리 안내',
    meta: `시행일 ${effectiveDateText('ko', PRIVACY_EFFECTIVE_DATE)}`,
    intro: 'Atmark(이하 “서비스”)는 이용자의 개인정보를 「개인정보 보호법」 등 관계 법령에 따라 처리합니다. 이 안내는 어떤 정보를 왜 처리하고 어떻게 보호하는지 설명합니다.',
    toc: '목차',
  },
  en: {
    title: 'Privacy Notice | Atmark',
    description: 'What personal information Atmark processes, why, for how long, who helps us process it, and your rights.',
    kicker: 'Legal',
    h1: 'Privacy Notice',
    meta: `Effective ${effectiveDateText('en', PRIVACY_EFFECTIVE_DATE)}`,
    intro: 'Atmark (&ldquo;the service&rdquo;) processes personal information in accordance with the Personal Information Protection Act of Korea and other applicable laws. This notice explains what we process, why, and how we protect it.',
    toc: 'Contents',
  },
};

function privacyPage(lang: SiteLang): SitePage {
  const c = PAGE_COPY[lang];
  const sections = SECTIONS[lang];
  const toc =
    `<nav class="toc" aria-label="${c['toc'] ?? ''}"><p class="toc-h" aria-hidden="true">${c['toc'] ?? ''}</p><ol>` +
    sections.map(([id, title], i) => `<li><a href="#${id}">${String(i + 1)}. ${title}</a></li>`).join('') +
    '</ol></nav>';
  return buildSitePage({
    lang,
    id: 'privacy',
    title: c['title'] ?? '',
    description: c['description'] ?? '',
    main:
      '<article class="wrap doc">' +
      `<p class="kicker">${c['kicker'] ?? ''}</p>` +
      `<h1>${c['h1'] ?? ''}</h1>` +
      `<p class="meta">${c['meta'] ?? ''}</p>` +
      `<p class="intro">${c['intro'] ?? ''}</p>` +
      toc +
      sections.map(([id, title, body], i) => `<section id="${id}"><h2>${String(i + 1)}. ${title}</h2>${body}</section>`).join('') +
      '</article>',
  });
}

export const PRIVACY_PAGES: Readonly<Record<SiteLang, SitePage>> = { ko: privacyPage('ko'), en: privacyPage('en') };
