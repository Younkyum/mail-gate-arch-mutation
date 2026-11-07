#!/bin/bash
# AI 의심 메일 감시 워커 설치 · 갱신 · 모델 교체 — 몇 번 돌려도 같은 상태가 된다(멱등). 런북: docs/runbooks/ai-watch.md §2 · §6
#
# **두 단계다.** 앞 단계는 로그인 사용자로(리포에서 빌드 — root 가 리포에 파일을 만들지 않게), 뒤 단계만 sudo 로:
#
#   bash ops/ai-watch/setup.sh [--model <version> [--from <release dir>]]           # ① 사용자: 의존성 · 번들 · 골든 24 확인 → ② 명령을 찍는다
#   sudo bash ops/ai-watch/setup.sh --install [--model <version> [--from <dir>]]    # ② root: 사용자·디렉터리·앱·모델·LaunchDaemon
#
#   --model <v> --from <dir>  릴리스 디렉터리(laya_mail_int8.onnx · tokenizer/ · release_config.json · fixtures.json)를 models.lock 의 sha256 과
#                             대조해 models/<v>/ 로 복사하고 current 를 옮긴다. 하나라도 다르면 아무것도 바꾸지 않는다.
#   --model <v>               이미 설치된 버전으로 current 만 옮긴다(되돌리기). 최근 3개 버전을 남긴다.
#
# root 단계가 하는 일:
#   1) 전용 사용자·그룹 _atmarkaiwatch(id 487 — 숨김 · 셸 /usr/bin/false · 홈 /var/empty · 비밀번호 없음)
#   2) /Library/Application Support/AtmarkAiWatch/{app,models,tmp} · /Library/Logs/atmark-ai-watch(로그 회전 newsyslog)
#   3) 앱(worker.mjs · models.lock · run.sh · sandbox.sb · node_modules) 복사 — root 소유, 워커는 읽기만
#   4) 모델(위 옵션) · LaunchDaemon /Library/LaunchDaemons/ai.atmark.aiwatch.plist 설치·재시작
#   5) verify.sh
# 키는 이 스크립트가 다루지 않는다 — store-key.sh(런북 §3). 키가 없으면 데몬을 올리지 않고 안내만 한다.
# 시스템 설정(pmset 잠자기 등)은 바꾸지 않는다 — 진윤겸 몫(런북 §1).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"

[ "$(uname -s)/$(uname -m)" = "Darwin/arm64" ] || { echo "Apple Silicon macOS 에서만 쓴다"; exit 1; }

install_phase=0
model=""
from=""
while [ $# -gt 0 ]; do
  case "$1" in
    --install) install_phase=1 ;;
    --model) model="${2:?--model 에 버전이 필요하다}"; shift ;;
    --from) from="${2:?--from 에 디렉터리가 필요하다}"; shift ;;
    *) echo "모르는 인자: $1"; exit 64 ;;
  esac
  shift
done
[ -z "$from" ] || [ -n "$model" ] || { echo "--from 은 --model 과 함께"; exit 64; }
if [ -n "$from" ]; then from="$(cd "$from" && pwd)"; fi

NODE="$(node_bin)" || { echo "Node 22 가 필요하다(brew install node@22)"; exit 1; }

# ── ① 사용자 단계 ────────────────────────────────────────────────────────────
if [ "$install_phase" = 0 ]; then
  [ "$(id -u)" != 0 ] || { echo "첫 단계는 sudo 없이 돌린다(리포에 root 소유 파일을 만들지 않게)"; exit 1; }
  PATH="$(dirname "$NODE"):/opt/homebrew/bin:$PATH"
  export PATH
  log "1/3 네이티브 의존성(onnxruntime-node · tokenizers — ops/ai-watch/pnpm-lock.yaml 고정)"
  pnpm --dir "$HERE" install --frozen-lockfile --ignore-scripts
  log "2/3 워커 번들"
  (cd "$REPO" && pnpm -s ai-watch:bundle)
  log "3/3 골든 24(전처리 · 토크나이저 · 추론)"
  if [ -n "$from" ]; then
    (cd "$REPO" && AIWATCH_MODEL_DIR="$from" AIWATCH_MODEL_VERSION="$model" pnpm -s ai-watch:selftest --require)
  else
    (cd "$REPO" && pnpm -s ai-watch:selftest)
  fi
  args="--install"
  [ -n "$model" ] && args="$args --model $model"
  [ -n "$from" ] && args="$args --from \"$from\""
  echo
  log "다음 — root 단계(진윤겸이 직접):"
  echo "    sudo bash \"$HERE/setup.sh\" $args"
  exit 0
fi

# ── ② root 단계 ──────────────────────────────────────────────────────────────
need_root
[ -f "$HERE/dist/worker.mjs" ] && [ -d "$HERE/node_modules/onnxruntime-node" ] \
  || { echo "번들·의존성이 없다 — 먼저 sudo 없이: bash ops/ai-watch/setup.sh"; exit 1; }

log "1/5 사용자·그룹 $SVC_USER ($SVC_ID)"
if ! dscl . -read "/Groups/$SVC_USER" > /dev/null 2>&1; then
  [ -z "$(dscl . -search /Groups PrimaryGroupID "$SVC_ID" 2> /dev/null)" ] || { echo "gid $SVC_ID 를 다른 그룹이 쓴다 — ATMARK_AIWATCH_UID 로 바꾼다"; exit 1; }
  dscl . -create "/Groups/$SVC_USER"
  dscl . -create "/Groups/$SVC_USER" PrimaryGroupID "$SVC_ID"
  dscl . -create "/Groups/$SVC_USER" RealName "Atmark AI mail watch"
  dscl . -create "/Groups/$SVC_USER" Password '*'
fi
if ! dscl . -read "/Users/$SVC_USER" > /dev/null 2>&1; then
  [ -z "$(dscl . -search /Users UniqueID "$SVC_ID" 2> /dev/null)" ] || { echo "uid $SVC_ID 를 다른 사용자가 쓴다 — ATMARK_AIWATCH_UID 로 바꾼다"; exit 1; }
  dscl . -create "/Users/$SVC_USER"
  dscl . -create "/Users/$SVC_USER" UniqueID "$SVC_ID"
  dscl . -create "/Users/$SVC_USER" PrimaryGroupID "$SVC_ID"
  dscl . -create "/Users/$SVC_USER" UserShell /usr/bin/false
  dscl . -create "/Users/$SVC_USER" NFSHomeDirectory /var/empty
  dscl . -create "/Users/$SVC_USER" RealName "Atmark AI mail watch"
  dscl . -create "/Users/$SVC_USER" Password '*'
  dscl . -create "/Users/$SVC_USER" IsHidden 1
fi
[ "$(id -u "$SVC_USER")" = "$SVC_ID" ] && [ "$(id -g "$SVC_USER")" = "$SVC_ID" ] || { echo "$SVC_USER 의 uid/gid 가 $SVC_ID 가 아니다"; exit 1; }

log "2/5 디렉터리"
install -d -o root -g wheel -m 0755 "$AW_HOME" "$APP_DIR" "$MODELS_DIR"
install -d -o "$SVC_USER" -g "$SVC_USER" -m 0700 "$TMP_DIR"
install -d -o root -g "$SVC_USER" -m 0750 "$LOG_DIR"
cat > "$NEWSYSLOG_CONF.tmp" << EOF
# ai.atmark.aiwatch — 10 MiB 마다 회전, 7개 보관(bzip2). setup.sh 가 쓴다.
$LOG_DIR/worker.log  root:$SVC_USER  640  7  10240  *  J
EOF
install -o root -g wheel -m 0644 "$NEWSYSLOG_CONF.tmp" "$NEWSYSLOG_CONF"
rm -f "$NEWSYSLOG_CONF.tmp"

log "3/5 앱 → $APP_DIR"
install -o root -g wheel -m 0644 "$HERE/dist/worker.mjs" "$APP_DIR/worker.mjs"
install -o root -g wheel -m 0644 "$HERE/models.lock" "$APP_DIR/models.lock"
install -o root -g wheel -m 0644 "$HERE/package.json" "$APP_DIR/package.json"
install -o root -g wheel -m 0644 "$HERE/sandbox.sb" "$APP_DIR/sandbox.sb"
install -o root -g wheel -m 0755 "$HERE/run.sh" "$APP_DIR/run.sh"
install -o root -g wheel -m 0644 "$HERE/lib.sh" "$APP_DIR/lib.sh"
rm -f "$APP_DIR/node-path"   # 예전 판(Homebrew 경로를 가리키던 파일) — 이제 쓰지 않는다
# 심볼릭 링크는 따라가 실제 파일로 복사하고(--copy-links), .bin(실행 링크 — 쓰지 않는다)은 싣지 않는다. 남은 링크가 있으면 아래 검사가 멈춘다.
rsync -a --delete --copy-links --exclude '.bin/' "$HERE/node_modules/" "$APP_DIR/node_modules/"
chown -R root:wheel "$APP_DIR/node_modules"
chmod -R go-w "$APP_DIR/node_modules"
# OpenSSL 고정 자리(lib.sh 머리말) — 빈 설정 파일 · 빈 디렉터리(provider·engine 을 아무것도 싣지 않는다).
install -d -o root -g wheel -m 0755 "$OPENSSL_DIR" "$OPENSSL_EMPTY_DIR"
printf '# ai.atmark.aiwatch — 빈 OpenSSL 설정(Homebrew openssl.cnf 를 읽지 않게). setup.sh 가 쓴다.\n' > "$OPENSSL_CONF_FILE"
chown root:wheel "$OPENSSL_CONF_FILE"
chmod 0644 "$OPENSSL_CONF_FILE"
find "$OPENSSL_EMPTY_DIR" -mindepth 1 -delete
# Node 런타임 고정(보안 리뷰 HIGH-2) — Homebrew node(로그인 사용자 소유)를 root 데몬이 실행하지 않는다. node + 비시스템 dylib 폐포를
#   $RUNTIME_DIR 로 복사 · 참조를 @rpath 로 · ad-hoc 재서명(vendor-node.sh). 이 뒤로 brew upgrade 는 데몬에 영향이 없다 — 런타임을 올리려면 이 단계를 다시.
log "  Node 런타임 → $RUNTIME_DIR (원본 $NODE)"
bash "$HERE/vendor-node.sh" "$NODE" "$RUNTIME_DIR"
chown -R root:wheel "$RUNTIME_DIR"
chmod -R go-w,a+rX "$RUNTIME_DIR"

# 잠금의 한 버전 → "상대경로 sha256" 줄(번들과 같은 node 로 읽는다 — jq 없이).
lock_lines() {
  "$RUNTIME_NODE" -e '
    const lock = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const entry = lock.models && lock.models[process.argv[2]];
    if (!entry) process.exit(3);
    for (const [p, h] of Object.entries(entry.files)) console.log(p + " " + h);
  ' "$APP_DIR/models.lock" "$1"
}
verify_dir() { # <dir> <version> — 전부 같으면 0
  local dir="$1" version="$2" path sum bad=0
  lines="$(lock_lines "$version")" || { echo "models.lock 에 $version 이 없다"; return 1; }
  while read -r path sum; do
    [ -f "$dir/$path" ] || { echo "  없음: $path"; bad=1; continue; }
    [ "$(shasum -a 256 "$dir/$path" | awk '{print $1}')" = "$sum" ] || { echo "  sha256 불일치: $path"; bad=1; }
  done <<< "$lines"
  return "$bad"
}

if [ -n "$model" ]; then
  log "4/5 모델 $model"
  case "$model" in *[!a-z0-9._-]* | "" | .* ) echo "버전 이름 모양이 아니다: $model"; exit 1 ;; esac
  target="$MODELS_DIR/$model"
  if [ -n "$from" ]; then
    verify_dir "$from" "$model" || { echo "릴리스가 잠금과 다르다 — 아무것도 바꾸지 않았다"; exit 1; }
    staging="$MODELS_DIR/.$model.staging"
    rm -rf "$staging"
    install -d -o root -g wheel -m 0755 "$staging"
    while read -r path _; do
      install -d -o root -g wheel -m 0755 "$staging/$(dirname "$path")"
      install -o root -g wheel -m 0644 "$from/$path" "$staging/$path"
    done <<< "$(lock_lines "$model")"
    verify_dir "$staging" "$model" || { rm -rf "$staging"; echo "복사본이 잠금과 다르다"; exit 1; }
    rm -rf "$target"
    mv "$staging" "$target"
  fi
  [ -d "$target" ] || { echo "$target 이 없다 — --from 으로 먼저 설치한다"; exit 1; }
  verify_dir "$target" "$model" || { echo "설치된 $model 이 잠금과 다르다 — --from 으로 다시 설치한다"; exit 1; }
  ln -sfn "$model" "$MODELS_DIR/current.tmp"
  mv -fh "$MODELS_DIR/current.tmp" "$MODELS_DIR/current"
  # 최근 KEEP_MODELS 개만(현재 포함) — 나머지 버전 디렉터리를 지운다(모델 바이트는 릴리스 원본에서 다시 설치할 수 있다).
  # shellcheck disable=SC2010
  ls -1t "$MODELS_DIR" | grep -v -e '^current$' -e '^\.' | tail -n +"$((KEEP_MODELS + 1))" | while read -r old; do
    [ "$old" = "$model" ] || { log "  오래된 모델 정리: $old"; rm -rf "${MODELS_DIR:?}/$old"; }
  done
else
  log "4/5 모델 — 그대로($(readlink "$MODELS_DIR/current" 2> /dev/null || echo '없음'))"
fi
if bad="$(root_owned_check "$APP_DIR" "$MODELS_DIR")"; then :; else echo "root 소유가 아니거나 쓰기 비트가 남은 경로: $bad — 데몬이 실행을 거부한다"; exit 1; fi
[ -L "$MODELS_DIR/current" ] || echo "  경고: models/current 가 없다 — 워커는 self_test:fail 로 하트비트만 보낸다(--model 로 설치)"

log "5/5 LaunchDaemon $LABEL"
sed -e "s|__SVC_ID__|$SVC_ID|g" -e "s|__WORKER_ID__|$WORKER_ID|g" "$HERE/$LABEL.plist.template" > "$PLIST.tmp"
plutil -lint "$PLIST.tmp" > /dev/null
chown root:wheel "$PLIST.tmp"
chmod 0644 "$PLIST.tmp"
mv -f "$PLIST.tmp" "$PLIST"
if ! key_present; then
  log "키체인에 키가 없다 — 데몬을 올리지 않는다. 런북 §3: aws iam create-access-key … | sudo bash ops/ai-watch/store-key.sh → 이 단계를 다시"
  exit 0
fi
launchctl bootout "system/$LABEL" 2> /dev/null || true
for _ in $(seq 1 15); do daemon_loaded || break; sleep 2; done
launchctl bootstrap system "$PLIST"
launchctl enable "system/$LABEL"
sleep 15
bash "$HERE/verify.sh"
log "끝 — 로그: $LOG_DIR/worker.log · 일시 정지: sudo bash ops/ai-watch/teardown.sh --pause · 걷어 내기: sudo bash ops/ai-watch/teardown.sh"
