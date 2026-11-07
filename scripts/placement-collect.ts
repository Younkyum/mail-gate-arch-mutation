#!/usr/bin/env tsx
/**
 * placement-collect.ts — AC-c5 (계획 §3.3 "Seed 리스트 inbox placement 테스트")
 *
 * ┌────────────────────────────────────────────────────────────────────────┐
 * │ 이 스크립트는 메일을 발송하지 않는다. IMAP 수집만 한다.                  │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * r4 A1 결정 (계획 §3.3): r3는 이 항목을 두 이름으로 불렀다 — §3.3은 "5통 발송 →
 * IMAP 수집", 소유자표는 "placement 수집기(IMAP)". 같은 파일에 두 책임이었다.
 * 그런데 **P0에는 관문도 엔진도 ses-transport.ts도 없으므로, P0에서 발송까지 하면
 * 관문 밖에서 SES를 직접 호출하게 된다.** Layer A는 "@aws-sdk/client-sesv2 를
 * import하는 파일은 src/mail/transport/ses-transport.ts 하나뿐"을 단언하고 그
 * 테스트는 P1 커밋 #1에 들어간다 → 충돌.
 *
 * 따라서:
 *   - 이 파일은 IMAP 수집만 한다. **어떤 AWS SDK도 import하지 않는다.**
 *   - 발송은 P1 이후 `send` 라우트를 통해 관문을 지난다.
 *   - P0~P1 사이의 placement 측정은 수동 발송 + 자동 수집이다.
 * (scripts/** 를 Layer A 예외로 올리는 대안은 기각됐다 — AC-8의 증명 범위를
 *  조용히 축소하는 일이기 때문이다. 계획 §3.3 r4 주석 참조.)
 *
 * ── 온기/냉담 구분이 이 설계의 핵심이다 (r3 교정) ──────────────────────
 * r2는 시드 5계정을 전부 창업자가 소유하고 매번 여는 구성으로 뒀다. 그러면
 * 인게이지먼트 신호(열람·회신·이동)가 누적되어 **placement를 체계적으로 과대평가한다.**
 *   온기(warm) 3 — Gmail / Google Workspace / Outlook.com. 창업자가 평소처럼 연다.
 *   냉담(cold) 2 — Naver / Daum. **사람이 절대 열지 않는다.** 인게이지먼트 0인
 *                  신규 수신자의 대리. 이 스크립트는 냉담 계정의 상태를 절대 바꾸지 않는다
 *                  (모든 메일박스를 read-only로 연다 — \Seen 플래그가 붙는 순간 그 계정은
 *                   더 이상 냉담 계정이 아니다).
 *
 * AC-2 통과 조건: 5/5 받은편지함 계열이 2주 연속, 그리고 **냉담 2계정이 2주 모두 pass**.
 * 온기 계정만 통과하는 상태는 통과가 아니다.
 * Gmail Promotions 탭은 pass로 친다(받은편지함 계열이며 스팸함이 아니다). 단
 * promotions_rate를 별도로 기록하고 30%를 넘으면 경고한다.
 *
 * 사용: pnpm placement:collect [--subject "..."]
 * 설정: 저장소 루트 .env (형식은 .env.example 참조)
 */

import { readFileSync } from 'node:fs';
import { ImapFlow } from 'imapflow';

type AccountKind = 'warm' | 'cold';
type Placement = 'inbox' | 'promotions' | 'spam' | 'not_found' | 'error';

interface MailboxTarget {
  /** 분류 라벨. inbox / promotions / spam 중 하나. */
  readonly label: Exclude<Placement, 'not_found' | 'error'>;
  /** 실제 IMAP 메일박스 경로. */
  readonly path: string;
}

interface AccountConfig {
  readonly id: string;
  readonly kind: AccountKind;
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly pass: string;
  readonly mailboxes: readonly MailboxTarget[];
  /** Gmail 전용. X-GM-RAW 검색으로 INBOX 안의 Promotions 탭을 분리한다. */
  readonly promoQuery: string | null;
}

interface CollectResult {
  readonly account: AccountConfig;
  readonly placement: Placement;
  readonly mailbox: string;
  readonly detail: string;
}

const PROMOTIONS_WARN_RATE = 0.3;

// ── .env 로더 (외부 패키지 없이) ─────────────────────────────────────────

function loadEnvFile(path: string): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

// ── 설정 파싱 ────────────────────────────────────────────────────────────

function required(env: Record<string, string>, key: string): string {
  const value = env[key] ?? process.env[key];
  if (value === undefined || value === '') throw new Error(`.env 에 ${key} 가 없다`);
  return value;
}

function optional(env: Record<string, string>, key: string): string | null {
  const value = env[key] ?? process.env[key];
  return value === undefined || value === '' ? null : value;
}

function parseMailboxes(spec: string): MailboxTarget[] {
  const out: MailboxTarget[] = [];
  for (const entry of spec.split(',')) {
    const trimmed = entry.trim();
    if (trimmed === '') continue;
    const sep = trimmed.indexOf(':');
    if (sep < 0) throw new Error(`메일박스 설정 형식 오류: "${trimmed}" (label:path 형태여야 한다)`);
    const label = trimmed.slice(0, sep).trim();
    const path = trimmed.slice(sep + 1).trim();
    if (label !== 'inbox' && label !== 'promotions' && label !== 'spam') {
      throw new Error(`알 수 없는 라벨 "${label}" — inbox / promotions / spam 중 하나여야 한다`);
    }
    out.push({ label, path });
  }
  if (out.length === 0) throw new Error('메일박스가 하나도 지정되지 않았다');
  return out;
}

function loadAccounts(env: Record<string, string>): AccountConfig[] {
  const ids = required(env, 'PLACEMENT_ACCOUNTS')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');

  return ids.map((id) => {
    const prefix = `PLACEMENT_${id.toUpperCase()}`;
    const kindRaw = required(env, `${prefix}_KIND`);
    if (kindRaw !== 'warm' && kindRaw !== 'cold') {
      throw new Error(`${prefix}_KIND 는 warm 또는 cold 여야 한다 (현재: ${kindRaw})`);
    }
    const portRaw = optional(env, `${prefix}_PORT`) ?? '993';
    const port = Number.parseInt(portRaw, 10);
    if (!Number.isFinite(port)) throw new Error(`${prefix}_PORT 가 숫자가 아니다`);

    return {
      id,
      kind: kindRaw,
      host: required(env, `${prefix}_HOST`),
      port,
      user: required(env, `${prefix}_USER`),
      pass: required(env, `${prefix}_PASS`),
      mailboxes: parseMailboxes(required(env, `${prefix}_MAILBOXES`)),
      promoQuery: optional(env, `${prefix}_PROMO_QUERY`),
    };
  });
}

// ── 수집 ─────────────────────────────────────────────────────────────────

async function collectOne(account: AccountConfig, subject: string): Promise<CollectResult> {
  const client = new ImapFlow({
    host: account.host,
    port: account.port,
    secure: true,
    auth: { user: account.user, pass: account.pass },
    logger: false,
  });

  try {
    await client.connect();

    for (const mailbox of account.mailboxes) {
      // read-only로만 연다. 냉담 계정에 \Seen이 붙으면 그 계정은 더 이상
      // "인게이지먼트 0인 신규 수신자"의 대리가 아니게 되고, 측정 자체가 오염된다.
      let lock: { release: () => void } | null = null;
      try {
        lock = await client.getMailboxLock(mailbox.path, { readOnly: true });
      } catch {
        continue; // 해당 계정에 없는 폴더는 건너뛴다 (제공자마다 이름이 다르다)
      }

      try {
        const hits = await client.search({ subject }, { uid: true });
        const uids: number[] = Array.isArray(hits) ? hits : [];
        if (uids.length === 0) continue;

        // Gmail: Promotions는 별도 폴더가 아니라 INBOX 안의 탭이므로 X-GM-RAW로 분리한다.
        if (mailbox.label === 'inbox' && account.promoQuery !== null) {
          const promoHits = await client.search(
            { gmraw: `${account.promoQuery} subject:"${subject}"` },
            { uid: true },
          );
          const promoUids: number[] = Array.isArray(promoHits) ? promoHits : [];
          if (promoUids.some((uid) => uids.includes(uid))) {
            return { account, placement: 'promotions', mailbox: mailbox.path, detail: `${promoUids.length}통` };
          }
        }

        return { account, placement: mailbox.label, mailbox: mailbox.path, detail: `${uids.length}통` };
      } finally {
        lock.release();
      }
    }

    return { account, placement: 'not_found', mailbox: '—', detail: '지정 제목의 메일 없음' };
  } catch (err: unknown) {
    return {
      account,
      placement: 'error',
      mailbox: '—',
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await client.logout().catch(() => undefined);
  }
}

function isPass(placement: Placement): boolean {
  // Promotions는 받은편지함 계열이므로 pass. 스팸함·미발견·오류는 fail.
  return placement === 'inbox' || placement === 'promotions';
}

function placementLabel(placement: Placement): string {
  switch (placement) {
    case 'inbox':
      return '받은편지함';
    case 'promotions':
      return '프로모션';
    case 'spam':
      return '스팸함';
    case 'not_found':
      return '미발견';
    case 'error':
      return '오류';
  }
}

/**
 * 한글은 터미널 표시 폭이 2다. padEnd는 코드 단위로 세므로 한글이 섞인 표가 어긋난다.
 * 표시 폭 기준으로 채운다.
 */
function padDisplay(text: string, width: number): string {
  let w = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6);
    w += wide ? 2 : 1;
  }
  return text + ' '.repeat(Math.max(0, width - w));
}

async function main(): Promise<void> {
  console.log('\nplacement 수집 — IMAP 전용 (AC-c5). 이 스크립트는 메일을 발송하지 않는다.\n');

  const env = loadEnvFile('.env');
  const args = process.argv.slice(2);
  const subjectIdx = args.indexOf('--subject');
  let subject: string;
  let accounts: AccountConfig[];
  try {
    subject = subjectIdx >= 0 ? (args[subjectIdx + 1] ?? '') : required(env, 'PLACEMENT_SUBJECT');
    if (subject === '') throw new Error('--subject 값이 비어 있다');
    accounts = loadAccounts(env);
  } catch (err: unknown) {
    console.error(`설정 오류: ${err instanceof Error ? err.message : String(err)}`);
    console.error('.env.example 을 복사해 .env 를 만들고 값을 채울 것.\n');
    process.exitCode = 1;
    return;
  }

  console.log(`제목: ${subject}`);
  console.log(`계정: ${accounts.length}개 (온기 ${accounts.filter((a) => a.kind === 'warm').length} / 냉담 ${accounts.filter((a) => a.kind === 'cold').length})\n`);

  const results: CollectResult[] = [];
  for (const account of accounts) {
    results.push(await collectOne(account, subject));
  }

  console.log(
    `${padDisplay('계정', 14)}${padDisplay('구분', 6)}${padDisplay('위치', 14)}${padDisplay('결과', 6)}비고`,
  );
  console.log('─'.repeat(30));
  for (const r of results) {
    const id = padDisplay(r.account.id, 14);
    const kind = padDisplay(r.account.kind === 'warm' ? '온기' : '냉담', 6);
    const where = padDisplay(placementLabel(r.placement), 14);
    const verdict = padDisplay(isPass(r.placement) ? 'pass' : 'FAIL', 6);
    console.log(`${id}${kind}${where}${verdict}${r.detail}`);
  }
  console.log('');

  const passCount = results.filter((r) => isPass(r.placement)).length;
  const coldResults = results.filter((r) => r.account.kind === 'cold');
  const coldPass = coldResults.filter((r) => isPass(r.placement)).length;
  const promoCount = results.filter((r) => r.placement === 'promotions').length;
  const promoRate = results.length > 0 ? promoCount / results.length : 0;

  console.log(`받은편지함 계열: ${passCount}/${results.length}`);
  console.log(`냉담 계정: ${coldPass}/${coldResults.length}`);
  console.log(`promotions_rate: ${(promoRate * 100).toFixed(0)}%${promoRate > PROMOTIONS_WARN_RATE ? '  ← 경고: 30% 초과' : ''}`);
  console.log('');

  const weekPass = passCount === results.length && coldPass === coldResults.length;
  if (weekPass) {
    console.log('이번 주 판정: pass (전 계정 받은편지함 계열 + 냉담 전원 통과).');
  } else {
    console.log('이번 주 판정: FAIL.');
    if (coldPass < coldResults.length) {
      console.log('  냉담 계정만 실패 → 평판 문제 / 전 계정 실패 → 인증·정렬 문제 (진단 분기는 remediation 런북 3단계).');
    }
    console.log('  → docs/runbooks/deliverability-remediation.md 를 따른다.');
  }
  console.log('AC-2는 이 판정이 2주 연속 pass여야 성립한다. 결과를 docs/runbooks/placement-log.md 에 기록할 것.\n');

  process.exitCode = weekPass ? 0 : 1;
}

await main();
