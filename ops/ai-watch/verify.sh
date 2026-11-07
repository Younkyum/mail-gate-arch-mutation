#!/bin/bash
# 설치 · 격리 확인. 하나라도 어긋나면 종료 코드 1. setup.sh 가 마지막에 부르고, 손으로도 돌린다. 런북: docs/runbooks/ai-watch.md §2-4
#
#   sudo bash ops/ai-watch/verify.sh            # 설치된 데몬 전체(사용자 · 권한 · 프로세스 · 샌드박스 · 하트비트 · 키체인)
#   bash ops/ai-watch/verify.sh --sandbox-only  # 샌드박스 프로필만(설치 없이 — 리포 사본 · 임시 디렉터리로). root 아니어도 된다.
#
# 샌드박스 시험은 **같은 프로필 · 같은 node** 로 일회용 프로세스를 띄워 막혀야 할 것이 막히는지 본다(ops/runner/verify-isolation.sh 와 같은 생각).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"

fail=0
ok() { echo "  ok   $*"; }
bad() { echo "  FAIL $*"; fail=1; }

sandbox_only=0
[ "${1:-}" = "--sandbox-only" ] && sandbox_only=1

# 샌드박스 시험의 node — 설치본은 고정 런타임(데몬과 같은 바이너리). --sandbox-only(설치 전)는 Homebrew node 22 를 임시 디렉터리로
#   vendor-node.sh 해서 쓴다 — 샌드박스가 /opt/homebrew 읽기를 막으므로 Homebrew node 를 그대로는 띄울 수 없다(그것이 시험하려는 성질이다).
scratch_rt=""
if [ -x "$RUNTIME_NODE" ] && [ "${1:-}" != "--sandbox-only" ]; then
  NODE="$RUNTIME_NODE"
else
  src_node="$(node_bin)" || { echo "Node 22 가 없다"; exit 1; }
  scratch_rt="$(mktemp -d /private/tmp/aiwatch-rt.XXXXXX)"
  bash "$HERE/vendor-node.sh" "$src_node" "$scratch_rt/runtime" > /dev/null || { echo "런타임 복사 실패"; exit 1; }
  NODE="$scratch_rt/runtime/bin/node"
fi
cleanup_rt() { [ -n "$scratch_rt" ] && rm -rf "$scratch_rt"; return 0; }
trap cleanup_rt EXIT

sandbox_probe() { # <profile> <tmp dir>
  local profile="$1" tmp="$2" probe out
  probe="$tmp/probe.mjs"
  cat > "$probe" << 'EOF'
import fs from 'node:fs'; import net from 'node:net'; import cp from 'node:child_process'; import crypto from 'node:crypto'; import tls from 'node:tls';
const require_crypto = () => { crypto.createHash('sha256').update('x').digest(); crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }); };
const tmp = process.argv[2]; const out = {};
const t = (k, f) => { try { f(); out[k] = 'allowed'; } catch { out[k] = 'denied'; } };
t('write_own_tmp', () => fs.writeFileSync(tmp + '/w', '1'));
t('write_private_tmp', () => fs.writeFileSync('/private/tmp/aiwatch-sandbox-probe', '1'));
t('write_app', () => fs.writeFileSync('/Library/Application Support/AtmarkAiWatch/app/x', '1'));
t('read_users', () => fs.readdirSync('/Users'));
t('read_keychains', () => fs.readdirSync('/Library/Keychains'));
t('spawn', () => cp.execFileSync('/usr/bin/true'));
t('read_homebrew', () => fs.readdirSync('/opt/homebrew'));
t('read_homebrew_openssl_cnf', () => fs.readFileSync('/opt/homebrew/etc/openssl@3/openssl.cnf'));
t('crypto', () => { require_crypto(); });
const conn = (host, port) => new Promise((r) => { const s = net.connect({ host, port, timeout: 5000 }); s.on('connect', () => { s.destroy(); r('allowed'); }); s.on('error', () => r('denied')); s.on('timeout', () => { s.destroy(); r('denied'); }); });
out.connect_sqs_443 = await conn('sqs.ap-northeast-2.amazonaws.com', 443);
out.connect_sqs_80 = await conn('sqs.ap-northeast-2.amazonaws.com', 80);
out.connect_localhost_22 = await conn('127.0.0.1', 22);
out.tls_sqs = await new Promise((r) => { const s = tls.connect({ host: 'sqs.ap-northeast-2.amazonaws.com', port: 443, servername: 'sqs.ap-northeast-2.amazonaws.com', timeout: 8000 }, () => { r(s.authorized ? 'allowed' : 'denied'); s.destroy(); }); s.on('error', () => r('denied')); s.on('timeout', () => { s.destroy(); r('denied'); }); });
out.listen = await new Promise((r) => { const s = net.createServer(); s.on('error', () => r('denied')); s.listen(0, '127.0.0.1', () => { s.close(); r('allowed'); }); });
console.log(JSON.stringify(out));
EOF
  # run.sh 와 같은 모양 — 빈 환경 + 고정 OpenSSL 자리(설치 전엔 임시 빈 파일·디렉터리) + --openssl-config.
  local conf="$OPENSSL_CONF_FILE" empty="$OPENSSL_EMPTY_DIR"
  if [ ! -f "$conf" ] || [ "$NODE" != "$RUNTIME_NODE" ]; then conf="$tmp/openssl.cnf"; empty="$tmp/empty"; : > "$conf"; mkdir -p "$empty"; fi
  out="$(cd "$tmp" && /usr/bin/env -i PATH=/usr/bin:/bin HOME=/var/empty TMPDIR="$tmp" LANG=C \
    OPENSSL_CONF="$conf" OPENSSL_MODULES="$empty" OPENSSL_ENGINES="$empty" \
    /usr/bin/sandbox-exec -f "$profile" -D "NODE=$NODE" -D "TMP_DIR=$tmp" "$NODE" --use-bundled-ca --openssl-config="$conf" "$probe" "$tmp" 2>&1)"
  expect() { # <key> <allowed|denied> <설명>
    if printf '%s' "$out" | grep -q "\"$1\":\"$2\""; then ok "$3"; else bad "$3 ($1 ≠ $2)"; fi
  }
  expect write_own_tmp allowed "전용 tmp 쓰기 됨"
  expect write_private_tmp denied "/private/tmp 쓰기 막힘"
  expect write_app denied "앱 디렉터리 쓰기 막힘"
  expect read_users denied "/Users 읽기 막힘"
  expect read_keychains denied "키체인 파일 읽기 막힘"
  expect spawn denied "프로세스 생성 막힘"
  expect connect_sqs_443 allowed "SQS 443 연결 됨"
  expect connect_sqs_80 denied "443 밖 연결 막힘"
  expect connect_localhost_22 denied "localhost 연결 막힘"
  expect listen denied "리슨 막힘"
  expect read_homebrew denied "/opt/homebrew 읽기 막힘"
  expect read_homebrew_openssl_cnf denied "Homebrew openssl.cnf 읽기 막힘"
  expect crypto allowed "고정 OpenSSL 자리로 crypto 동작"
  expect tls_sqs allowed "SQS TLS 핸드셰이크 · 인증서 검증 통과(번들 CA)"
}

if [ "$sandbox_only" = 1 ]; then
  tmp="$(mktemp -d /private/tmp/aiwatch-verify.XXXXXX)"
  echo "[샌드박스] $HERE/sandbox.sb · node $NODE"
  sandbox_probe "$HERE/sandbox.sb" "$tmp"
  rm -rf "$tmp" /private/tmp/aiwatch-sandbox-probe
  [ "$fail" = 0 ] && echo "샌드박스 확인: 통과" || echo "샌드박스 확인: 실패"
  exit "$fail"
fi

need_root

echo "[사용자] $SVC_USER"
[ "$(id -u "$SVC_USER" 2> /dev/null)" = "$SVC_ID" ] && ok "uid $SVC_ID" || bad "uid 가 $SVC_ID 가 아니다"
[ "$(dscl . -read "/Users/$SVC_USER" UserShell 2> /dev/null | awk '{print $2}')" = "/usr/bin/false" ] && ok "셸 /usr/bin/false" || bad "로그인 셸이 있다"
[ "$(dscl . -read "/Users/$SVC_USER" IsHidden 2> /dev/null | awk '{print $2}')" = "1" ] && ok "숨김" || bad "숨김 아님"
id -Gn "$SVC_USER" 2> /dev/null | grep -qw -e admin -e staff -e wheel && bad "admin/staff/wheel 그룹에 있다" || ok "admin·staff·wheel 아님"

echo "[파일]"
for path in "$AW_HOME" "$APP_DIR" "$MODELS_DIR" "$APP_DIR/worker.mjs" "$APP_DIR/run.sh" "$APP_DIR/sandbox.sb" "$APP_DIR/models.lock" "$PLIST"; do
  owner="$(stat -f '%Su' "$path" 2> /dev/null)"
  mode="$(stat -f '%Lp' "$path" 2> /dev/null)"
  [ "$owner" = root ] && [ $((0$mode & 022)) = 0 ] && ok "$path root · go-w" || bad "$path 소유 $owner 권한 $mode"
done
[ "$(stat -f '%Su %Lp' "$TMP_DIR" 2> /dev/null)" = "$SVC_USER 700" ] && ok "tmp $SVC_USER 700" || bad "tmp 권한"
find "$APP_DIR" -perm -o+w 2> /dev/null | grep -q . && bad "앱 아래 누구나 쓸 수 있는 파일이 있다" || ok "앱 아래 o+w 없음"
[ -L "$MODELS_DIR/current" ] && ok "models/current → $(readlink "$MODELS_DIR/current")" || bad "models/current 없음"

echo "[실행 파일 신뢰 — 보안 리뷰 HIGH-2]"
[ -x "$RUNTIME_NODE" ] && ok "Node 런타임 $RUNTIME_NODE" || bad "Node 런타임 없음 — setup.sh --install"
model_dir="$(cd "$MODELS_DIR/current" 2> /dev/null && pwd -P || echo "$MODELS_DIR/current")"
if bad_path="$(root_owned_check "$RUNTIME_DIR" "$APP_DIR/worker.mjs" "$APP_DIR/node_modules" "$APP_DIR/sandbox.sb" "$APP_DIR/models.lock" \
  "$APP_DIR/lib.sh" "$APP_DIR/run.sh" "$OPENSSL_DIR" "$MODELS_DIR/current" "$model_dir")"; then
  ok "런타임 · 번들 · 네이티브 모듈 · 모델 · 상위 디렉터리 전부 root 소유 · 그룹/기타 쓰기 없음"
else
  bad "root 소유가 아니거나 쓰기 비트가 남았다: $bad_path (run.sh 가 실행을 거부한다)"
fi
leak="$(for f in "$RUNTIME_NODE" "$RUNTIME_DIR"/lib/*.dylib; do otool -L "$f" 2> /dev/null | tail -n +2 | awk '{print $1}'; done | grep -v -e '^@rpath/' -e '^/usr/lib/' -e '^/System/' || true)"
[ -z "$leak" ] && ok "런타임 dylib 참조가 런타임 안 · 시스템뿐(Homebrew 0 — brew upgrade 무관)" || bad "런타임이 밖을 가리킨다: $(printf '%s' "$leak" | head -n 1)"
# 빌드 때 박힌 Homebrew 경로(OPENSSLDIR 등)는 문자열로 남는다 — 그 자체는 위험이 아니다(run.sh 가 OPENSSL_* 를 고정, 샌드박스가 /opt/homebrew 읽기를 막는다).
#   경고로만 보여 준다. 실제로 열지 않는다는 것은 아래 데몬 매핑 검사와 위 샌드박스 시험(read_homebrew denied 에서도 crypto · TLS 동작)이 본다.
embedded="$(for f in "$RUNTIME_NODE" "$RUNTIME_DIR"/lib/*.dylib; do strings "$f" 2> /dev/null | grep -o '/opt/homebrew[^" ]*'; done | sort -u | head -n 3 | tr '\n' ' ')"
[ -z "$embedded" ] && ok "런타임 문자열에 /opt/homebrew 없음" || echo "  warn 런타임 문자열에 빌드 경로가 남아 있다(무력화됨 — OPENSSL_* 고정 · 샌드박스 deny): $embedded"
pid_now="$(daemon_pid)"
if [ -n "$pid_now" ]; then
  exe="$(ps -o comm= -p "$pid_now")"
  [ "$exe" = "$RUNTIME_NODE" ] && ok "데몬이 고정 런타임을 실행 중" || bad "데몬 실행 파일: $exe"
  vmmap "$pid_now" 2> /dev/null | grep -q '/opt/homebrew/' && bad "데몬이 Homebrew 의 파일을 매핑했다" || ok "데몬 매핑에 Homebrew 경로 없음"
  denv="$(ps -E -o command= -p "$pid_now" 2> /dev/null || true)"
  printf '%s' "$denv" | grep -q -e 'NODE_OPTIONS=' -e 'DYLD_' -e 'NODE_PATH=' && bad "데몬 환경에 로드 경로 변수가 있다" || ok "데몬 환경에 NODE_OPTIONS · NODE_PATH · DYLD_* 없음"
  printf '%s' "$denv" | grep -q "OPENSSL_CONF=$OPENSSL_CONF_FILE" && ok "OPENSSL_CONF 고정" || bad "OPENSSL_CONF 가 고정 자리가 아니다"
  ps -o command= -p "$pid_now" | grep -q -- '--use-bundled-ca' && ok "내장 CA 만(--use-bundled-ca)" || bad "--use-bundled-ca 가 없다"
fi

echo "[키체인]"
key_present && ok "$KC_SERVICE/$KC_ACCOUNT 있음(값은 보지 않는다)" || bad "키체인 항목 없음 — store-key.sh"

echo "[프로세스] $LABEL"
pid="$(daemon_pid)"
if [ -n "$pid" ]; then
  ok "pid $pid"
  [ "$(ps -o user= -p "$pid" | tr -d ' ')" = "$SVC_USER" ] && ok "$SVC_USER 로 돈다(root 아님)" || bad "사용자: $(ps -o user= -p "$pid")"
  lsof -nP -a -p "$pid" -iTCP -sTCP:LISTEN 2> /dev/null | grep -q LISTEN && bad "리슨 소켓이 있다" || ok "리슨 소켓 없음"
  lsof -nP -a -p "$pid" -iTCP -sTCP:ESTABLISHED 2> /dev/null | awk 'NR>1{print $9}' | grep -v ':443$' | grep -q . && bad "443 밖 연결이 있다" || ok "연결은 443 뿐"
  rss=$(($(ps -o rss= -p "$pid") / 1024))
  ok "RSS ${rss}MiB"
else
  bad "데몬이 돌고 있지 않다(launchctl print system/$LABEL)"
fi

echo "[로그] $LOG_DIR/worker.log"
if [ -f "$LOG_DIR/worker.log" ]; then
  last_hb="$(grep '"event":"heartbeat"' "$LOG_DIR/worker.log" | tail -n 1)"
  [ -n "$last_hb" ] && ok "마지막 하트비트: $(printf '%s' "$last_hb" | cut -c1-160)" || bad "하트비트 로그 없음"
  printf '%s' "$last_hb" | grep -q '"self_test":"pass"' && ok "self_test pass" || bad "self_test 가 pass 가 아니다"
  grep -q '"event":"fatal"' <(tail -n 50 "$LOG_DIR/worker.log") && bad "최근 fatal: $(grep '"event":"fatal"' "$LOG_DIR/worker.log" | tail -n 1 | cut -c1-160)" || ok "최근 fatal 없음"
  grep -v '^{' "$LOG_DIR/worker.log" | grep -q . && bad "JSON 이 아닌 줄이 있다(라이브러리 출력 — 본문이 섞이지 않았는지 본다)" || ok "모든 줄이 구조화 로그"
else
  bad "로그 파일 없음"
fi

echo "[샌드박스] 설치된 프로필 $APP_DIR/sandbox.sb"
probe_tmp="$(mktemp -d "$TMP_DIR/verify.XXXXXX")"
chown "$SVC_USER" "$probe_tmp"
sandbox_probe "$APP_DIR/sandbox.sb" "$probe_tmp"
rm -rf "$probe_tmp" /private/tmp/aiwatch-sandbox-probe

[ "$fail" = 0 ] && echo "ai-watch 확인: 통과" || echo "ai-watch 확인: 실패"
exit "$fail"
