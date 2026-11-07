/**
 * src/admin/ui/client-sanitize.ts — 브라우저 쪽 표시 정화 `clean(value, max)`.
 *
 * 관리 화면에는 **에이전트가 정한 문자열**이 나온다 — 에이전트 이름, 승인 대기의 제목·수신자, 발신자 주소,
 * seed 주소. `textContent` 는 HTML 을 막지만 U+202E 같은 양방향 제어·제로폭·줄바꿈은 막지 못한다(소유자가 보는
 * 주소가 뒤집혀 읽힌다 — `moc.live@bob`). 그래서 **표시 직전에** 승인 페이지와 같은 규칙을 한 번 더 건다:
 * `src/notify/approval-notification-template.ts` 의 `sanitizeDisplayText`(I1 한 줄 · I4 보이지 않는 문자 제거 ·
 * I6 코드포인트 상한). 관리 API 가 정화된 값을 준다는 약속은 계약(`admin-mcp-contract.md`)에 없다 — 받는 쪽에서
 * 건다.
 *
 * **두 벌이다 — 그래서 낡으면 테스트가 빨개진다.** 이 문자열은 브라우저에서 돌아야 하므로 서버 함수를 import 할
 * 수 없다. `test/unit/admin/admin-ui.test.ts` 가 이 소스를 `node:vm` 으로 실행해 BMP 전체와 태그·변이 선택자
 * 평면에 대해 `sanitizeDisplayText` 와 **같은 출력**인지 단언한다. 서버 쪽 정규식이 바뀌면 여기도 바꿔야 초록이다.
 *
 * 한 가지 다른 점: 입력이 문자열이 아니면(`null`·숫자·객체) 먼저 문자열로 만든다 — API 응답은 믿지 않는다.
 *
 * `cleanBlock(value, max)` 는 **여러 줄** 판이다(발신 로그 상세의 본문 — `<pre>` 에 `textContent`). 서버 `sanitizeDisplayBlock` 과
 * 같은 규칙(줄바꿈·탭은 살리고, 나머지 제어문자와 같은 `INV` 를 지운다)에 코드포인트 상한만 더한다 — 같은 출력인지는
 * `admin-console-v3.test.ts` 가 BMP 전체에서 단언한다.
 */

/** ASCII 만. `String.raw` — 역슬래시가 그대로 JS 정규식으로 간다. */
export const CLIENT_SANITIZE_JS = String.raw`var LB=/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu;
var INV=/[\u00ad\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufffb\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;
function clean(v,max){
  var s=(v===null||v===undefined)?'':String(v);
  s=s.replace(LB,' ').replace(INV,'').replace(/\s+/gu,' ').trim();
  var cps=Array.from(s);
  if(cps.length<=max)return s;
  return cps.slice(0,max).join('')+'\u2026(\uc798\ub9bc)';
}
var BLOCK_CTL=/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu;
function cleanBlock(v,max){
  var s=(v===null||v===undefined)?'':String(v);
  s=s.replace(/\r\n?|[\u2028\u2029]/gu,'\n').replace(BLOCK_CTL,'').replace(INV,'');
  var cps=Array.from(s);
  if(cps.length<=max)return s;
  return cps.slice(0,max).join('')+'\u2026(\uc798\ub9bc)';
}
`;
