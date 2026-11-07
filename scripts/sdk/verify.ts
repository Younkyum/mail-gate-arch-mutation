/**
 * `pnpm sdk:verify` — `pnpm sdk:build` 가 만든 `sdk/dist/` 산출물을 게시 전에 확인한다(게시는 하지 않는다).
 *
 *   ① npm: `npm pack --dry-run` 목록 = 허용 목록(package.json · README.md · LICENSE · dist/*.js · dist/*.d.ts) = 실제 tarball 목록.
 *      `src/` · 테스트 · 설정 · 비밀처럼 보이는 내용이 없다.
 *   ② npm: tarball 을 임시 폴더에 설치하고 Node(22 + 있으면 20 · 24, `ATMARK_SDK_VERIFY_NODES`)로 import → 가짜 fetch 스모크. 타입도 tsc 로 확인.
 *   ③ Python: 새 venv 에 wheel 을 설치하고 `import atmark; print(atmark.__version__)` + 가짜 transport 스모크 · `py.typed` 동봉.
 *   ④ `twine check`(README 렌더 · 메타데이터).
 *   ⑤ 메타데이터: 이름(`atmark-sdk` · `atmark-sdk`) · 라이선스 MIT · 버전이 둘 다 같다.
 */

import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { artifactNames, basePython, capture, OUT_DIR, pyField, ROOT, run, step, TOOLS_PYTHON, TS_DIR, tsPackage } from './common';

const names = artifactNames();
const tarball = join(OUT_DIR, names.tarball);
const wheel = join(OUT_DIR, names.wheel);
const sdist = join(OUT_DIR, names.sdist);
for (const file of [tarball, wheel, sdist]) if (!existsSync(file)) throw new Error(`${file} 이 없다 — 먼저 pnpm sdk:build`);

const failures: string[] = [];
const check = (ok: boolean, message: string): void => {
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${message}\n`);
  if (!ok) failures.push(message);
};

/** 비밀처럼 보이는 내용 — 토큰 · 키 · 개인 키 · 사업자등록번호 꼴. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /atk_(?:agent|org)_[A-Za-z0-9]{16,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /npm_[A-Za-z0-9]{36}/,
  /pypi-[A-Za-z0-9_-]{40,}/,
  /\b\d{3}-\d{2}-\d{5}\b/,
];
const scanSecrets = (label: string, text: string): void => {
  const hit = SECRET_PATTERNS.find((pattern) => pattern.test(text));
  check(hit === undefined, `${label}: 비밀처럼 보이는 내용 없음${hit === undefined ? '' : ` — ${String(hit)}`}`);
};

const ts = tsPackage();
const version = ts.version;

// ① npm 파일 목록
step('① npm 파일 목록');
const ALLOWED = (file: string): boolean => ['package.json', 'README.md', 'LICENSE'].includes(file) || /^dist\/[a-z-]+\.(?:js|d\.ts)$/.test(file);
const dryRun = JSON.parse(capture('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: TS_DIR })) as { files: { path: string }[] }[];
const dryFiles = (dryRun[0]?.files ?? []).map((f) => f.path).sort();
const tarFiles = capture('tar', ['-tzf', tarball]).split('\n').filter((l) => l !== '' && !l.endsWith('/')).map((l) => l.replace(/^package\//, '')).sort();
check(dryFiles.length > 3, `npm pack --dry-run: ${dryFiles.length}개`);
check(dryFiles.every(ALLOWED), `허용 목록 밖 파일 없음${dryFiles.filter((f) => !ALLOWED(f)).map((f) => ` · ${f}`).join('')}`);
check(JSON.stringify(dryFiles) === JSON.stringify(tarFiles), 'dry-run 목록 = sdk/dist tarball 목록');
for (const required of ['package.json', 'README.md', 'LICENSE', 'dist/index.js', 'dist/index.d.ts']) check(tarFiles.includes(required), `포함: ${required}`);
check(!tarFiles.some((f) => /(^|\/)(src|test|tests)\//.test(f) || /\.test\.|tsconfig|\.env/.test(f)), 'src · 테스트 · 설정 · .env 없음');
scanSecrets('tarball', capture('tar', ['-xzOf', tarball]));

// ② 설치 · import · 스모크
step('② npm 설치 · Node import · 가짜 fetch 스모크');
const work = mkdtempSync(join(tmpdir(), 'atmark-sdk-verify-'));
try {
  const app = join(work, 'node-app');
  run('mkdir', ['-p', app]);
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'atmark-sdk-smoke', private: true, type: 'module' }));
  run('npm', ['install', '--silent', '--no-audit', '--no-fund', '--ignore-scripts', tarball], { cwd: app });
  writeFileSync(
    join(app, 'smoke.mjs'),
    `import { Atmark, VERSION, isHostile, verifyWebhookSignature } from 'atmark-sdk';
import pkg from 'atmark-sdk/package.json' with { type: 'json' };
const calls = [];
const fetch = async (url, init) => {
  calls.push({ url: String(url), method: init?.method ?? 'GET', headers: init?.headers });
  return new Response(JSON.stringify({ status: 'sent', message_id: 'm1' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
const atmark = new Atmark({ token: 'atk_agent_smoke', agentId: 'a'.repeat(32), fetch });
const sent = await atmark.messages.send({ from: 'scout@atmark.ai', to: ['partner@example.com'], subject: 'Hi', text: 'Hello' });
const headers = new Headers(calls[0].headers);
if (sent.status !== 'sent') throw new Error('send status ' + sent.status);
if (!calls[0].url.startsWith('https://api.atmark.ai/v1/')) throw new Error('url ' + calls[0].url);
if (headers.get('authorization') !== 'Bearer atk_agent_smoke') throw new Error('auth header');
if (!headers.get('idempotency-key')) throw new Error('no Idempotency-Key');
if (VERSION !== pkg.version) throw new Error('VERSION ' + VERSION + ' != ' + pkg.version);
if (isHostile({ risk: { level: 'none' } }) !== false || isHostile({ risk: { level: 'risk' } }) !== true) throw new Error('isHostile');
if (typeof verifyWebhookSignature !== 'function') throw new Error('verifyWebhookSignature');
console.log(process.version, 'ok', VERSION, calls[0].method, new URL(calls[0].url).pathname);
`,
  );
  const nodes = new Set<string>([realpathSync(process.execPath)]);
  for (const candidate of [...(process.env['ATMARK_SDK_VERIFY_NODES'] ?? '').split(':'), '/opt/homebrew/opt/node@20/bin/node', '/opt/homebrew/opt/node@22/bin/node']) {
    if (candidate !== '' && existsSync(candidate)) nodes.add(realpathSync(candidate));
  }
  const majors: string[] = [];
  for (const node of nodes) {
    const out = capture(node, ['smoke.mjs'], { cwd: app }).trim();
    majors.push(out.split('.')[0] ?? '');
    check(/ ok /.test(out), `${node}: ${out}`);
  }
  if (!majors.includes('v20')) process.stdout.write('  ! Node 20 이 이 기기에 없어 건너뜀(있으면 ATMARK_SDK_VERIFY_NODES=/경로/node). 런타임은 표준 fetch 만 쓴다.\n');

  writeFileSync(
    join(app, 'types.ts'),
    `import { Atmark, VERSION, type AtmarkOptions, type InboundMessage } from 'atmark-sdk';
const options: AtmarkOptions = { token: 't' };
const client: Atmark = new Atmark(options);
const v: string = VERSION;
export type Check = [typeof client, typeof v, InboundMessage];
`,
  );
  writeFileSync(
    join(app, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { module: 'nodenext', moduleResolution: 'nodenext', target: 'es2022', strict: true, noEmit: true, lib: ['es2023', 'dom'], types: [] }, files: ['types.ts'] }),
  );
  run(join(ROOT, 'node_modules', '.bin', 'tsc'), ['-p', join(app, 'tsconfig.json')]);
  check(true, 'tsc(nodenext): exports.types 로 타입이 풀린다');

  // ③ Python wheel
  step('③ Python wheel — 새 venv 설치 · import');
  const venv = join(work, 'venv');
  run(basePython(), ['-m', 'venv', venv]);
  const py = join(venv, 'bin', 'python');
  run(py, ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', '--no-index', '--no-deps', wheel]);
  const printed = capture(py, ['-I', '-c', 'import atmark; print(atmark.__version__)'], { cwd: work }).trim();
  check(printed === version, `python -c "import atmark; print(atmark.__version__)" → ${printed}`);
  const smoke = capture(
    py,
    [
      '-I',
      '-c',
      `import json, pathlib, atmark
from atmark import Atmark, HttpResponse
seen = []
def transport(request):
    seen.append(request)
    return HttpResponse(200, {"Content-Type": "application/json"}, json.dumps({"status": "sent", "message_id": "m1"}).encode())
client = Atmark(token="atk_agent_smoke", agent_id="a" * 32, transport=transport)
sent = client.messages.send({"from": "scout@atmark.ai", "to": ["partner@example.com"], "subject": "Hi", "text": "Hello"})
headers = {k.lower(): v for k, v in seen[0].headers.items()}
assert sent["status"] == "sent", sent
assert seen[0].url.startswith("https://api.atmark.ai/v1/"), seen[0].url
assert headers["authorization"] == "Bearer atk_agent_smoke"
assert headers.get("idempotency-key")
assert atmark.is_hostile({"risk": {"level": "risk"}}) and not atmark.is_hostile({"risk": {"level": "none"}})
assert (pathlib.Path(atmark.__file__).parent / "py.typed").is_file(), "py.typed"
print("ok", seen[0].method, seen[0].url.split("?")[0])
`,
    ],
    { cwd: work },
  ).trim();
  check(smoke.startsWith('ok '), `가짜 transport 스모크 · py.typed: ${smoke}`);
  const record = capture('unzip', ['-Z1', wheel]).split('\n').filter((l) => l !== '');
  check(record.every((f) => f.startsWith('atmark/') || f.startsWith('atmark_sdk-')), `wheel 안 파일 ${record.length}개 — atmark/ · 메타데이터만`);
  check(record.some((f) => /^atmark_sdk-[^/]+\.dist-info\/licenses\/LICENSE$/.test(f)), 'wheel 에 LICENSE');
  scanSecrets('wheel', capture('unzip', ['-p', wheel]));
  scanSecrets('sdist', capture('tar', ['-xzOf', sdist]));

  // ④ twine check
  step('④ twine check');
  run(TOOLS_PYTHON, ['-m', 'twine', 'check', '--strict', wheel, sdist]);
  check(true, 'twine check --strict 통과');

  // ⑤ 메타데이터
  step('⑤ 메타데이터');
  const metadata = capture('unzip', ['-p', wheel, `${names.wheel.split('-py3')[0]}.dist-info/METADATA`]);
  const header = (key: string): string | undefined => new RegExp(`^${key}: (.+)$`, 'm').exec(metadata)?.[1]?.trim();
  const tarPkg = JSON.parse(capture('tar', ['-xzOf', tarball, 'package/package.json'])) as Record<string, unknown>;
  check(tarPkg['name'] === 'atmark-sdk' && tarPkg['license'] === 'MIT' && tarPkg['private'] === false, `npm: ${String(tarPkg['name'])} · ${String(tarPkg['license'])} · private=${String(tarPkg['private'])}`);
  check(tarPkg['repository'] === undefined, 'npm: repository 없음(비공개 리포)');
  check(header('Name') === 'atmark-sdk' && header('License-Expression') === 'MIT', `PyPI: ${header('Name') ?? '?'} · ${header('License-Expression') ?? '?'}`);
  check(header('Requires-Python') === '>=3.9', `PyPI: Requires-Python ${header('Requires-Python') ?? '?'}`);
  check(/^Provides-Extra: realtime$/m.test(metadata) && /^Requires-Dist: websockets>=12; extra == "realtime"$/m.test(metadata), 'PyPI: realtime 추가 패키지(websockets>=12)');
  check(tarPkg['version'] === version && header('Version') === version && pyField('version') === version, `버전 둘 다 ${version}`);
  check(!/\b\d{3}-\d{2}-\d{5}\b/.test(readFileSync(join(TS_DIR, 'LICENSE'), 'utf8')), 'LICENSE 에 등록번호 없음');
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failures.length > 0) {
  process.stdout.write(`\n✗ 실패 ${failures.length}건\n`);
  process.exit(1);
}
process.stdout.write(`\n✓ sdk:verify 통과 — ${names.tarball} · ${names.wheel} · ${names.sdist}\n  게시는 런북 docs/runbooks/sdk-publish.md 대로 진윤겸이 한다.\n`);
