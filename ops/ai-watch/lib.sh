# shellcheck shell=bash disable=SC2034
# AI 의심 메일 감시 워커 공용 설정 — setup.sh · teardown.sh · verify.sh · store-key.sh · rotate-key.sh 가 source 한다.
# 런북: docs/runbooks/ai-watch.md. macOS 기본 bash(3.2)에서 돈다. **자격 증명을 출력하지 않는다.**
#
# CI 실행기(ops/runner — 로그인 사용자의 LaunchAgent + colima VM)와 **아무것도 공유하지 않는다**: 사용자 · 디렉터리 · 키체인 항목 · launchd 도메인이 다르다.

export PATH="/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin"

LABEL="ai.atmark.aiwatch"
SVC_USER="_atmarkaiwatch"
# 전용 사용자 · 그룹 id(숨김 범위 < 500). 이미 다른 것이 쓰고 있으면 setup.sh 가 멈춘다 — 환경 변수로 바꾼다.
SVC_ID="${ATMARK_AIWATCH_UID:-487}"

AW_HOME="/Library/Application Support/AtmarkAiWatch"   # root 소유 — 워커는 읽기만
APP_DIR="$AW_HOME/app"                                  # worker.mjs · models.lock · run.sh · sandbox.sb · node_modules
MODELS_DIR="$AW_HOME/models"                            # <version>/ · current → <version>
TMP_DIR="$AW_HOME/tmp"                                  # 워커가 쓸 수 있는 유일한 디렉터리(로그는 launchd 가 연 FD)
LOG_DIR="/Library/Logs/atmark-ai-watch"
PLIST="/Library/LaunchDaemons/$LABEL.plist"
NEWSYSLOG_CONF="/etc/newsyslog.d/$LABEL.conf"

KEYCHAIN="/Library/Keychains/System.keychain"
KC_SERVICE="ai.atmark.aiwatch"
KC_ACCOUNT="aws"

IAM_USER="atmark-ai-watch"
AWS_PROFILE_NAME="${ATMARK_AWS_PROFILE:-atmark}"

# 워커 id(하트비트 · 로그). 소문자 영숫자·`._-`(계약 AI_WATCH_WORKER_ID_PATTERN).
WORKER_ID="${ATMARK_AIWATCH_WORKER_ID:-macstudio-1}"
# 남겨 둘 모델 버전 수(현재 포함) — 되돌리기 대비(설계 §5.3).
KEEP_MODELS=3

# 워커 전용 Node 런타임(보안 리뷰 HIGH-2) — setup.sh 의 root 단계가 Homebrew node 와 dylib 폐포를 여기로 복사해 root 소유로 고정한다.
# 데몬은 이 경로만 실행한다(sandbox.sb 의 exec 허용도 이 경로 하나). `brew upgrade` 는 이 사본에 영향이 없다.
RUNTIME_DIR="$APP_DIR/runtime"
RUNTIME_NODE="$RUNTIME_DIR/bin/node"
# OpenSSL 설정·모듈의 고정 자리(재검증 HIGH) — 복사한 libcrypto 는 빌드 때 박힌 OPENSSLDIR(/opt/homebrew/etc/openssl@3 — 로그인 사용자 쓰기 가능)의
# openssl.cnf 와 MODULESDIR·ENGINESDIR 를 읽어 provider/engine dylib 을 로드할 수 있다. run.sh 가 OPENSSL_CONF·OPENSSL_MODULES·OPENSSL_ENGINES 를
# 아래 root 소유 빈 파일·빈 디렉터리로 고정하고, sandbox.sb 는 /opt/homebrew · /usr/local 읽기를 막는다(두 겹).
OPENSSL_DIR="$APP_DIR/openssl"
OPENSSL_CONF_FILE="$OPENSSL_DIR/openssl.cnf"
OPENSSL_EMPTY_DIR="$OPENSSL_DIR/empty"

# root 소유 · 그룹/기타 쓰기 없음인가 — 하위 전부. 어긋난 첫 경로를 찍고 1. run.sh 와 verify.sh 가 같은 검사를 쓴다.
# 상위 디렉터리(/Library … AtmarkAiWatch)도 본다 — 상위를 바꿀 수 있으면 하위를 통째로 바꿔치기할 수 있다.
# **하위의 심볼릭 링크는 거부한다**(재검증 LOW-4 — 링크 대상의 소유권은 find 가 보지 않는다). 인자 자체가 링크(models/current)면 링크의 소유자를
# 보고, 대상은 호출하는 쪽이 따로 인자로 넘긴다(run.sh · verify.sh 의 model_dir).
root_owned_check() { # <경로>…
  local path parent bad
  for path in "$@"; do
    [ -e "$path" ] || [ -L "$path" ] || { echo "$path (없음)"; return 1; }
    if [ -L "$path" ]; then
      [ "$(stat -f '%Su' "$path")" = root ] || { echo "$path (링크 소유자)"; return 1; }
    else
      # 하위 심볼릭 링크는 거부한다 — 단 모델 디렉터리의 `current`(현재 버전을 가리키는 설계상 링크) 하나만 예외: 그 링크는 아래에서 소유자(root)와
      #   대상(같은 디렉터리 안의 버전 이름 하나)을 따로 본다. 대상 디렉터리 자체는 이 find 가 이미 훑는다(2026-10-06 설치 실측 — 이 예외가 없어 설치가 멈췄다).
      bad="$(find "$path" \( -path "$path/current" -type l \) -prune -o \( ! -user root -o -type l -o -perm -g+w -o -perm -o+w \) -print 2> /dev/null | head -n 1)"
      [ -z "$bad" ] || { echo "$bad"; return 1; }
      if [ -L "$path/current" ]; then
        [ "$(stat -f '%Su' "$path/current")" = root ] || { echo "$path/current (링크 소유자)"; return 1; }
        case "$(readlink "$path/current")" in
          */* | .* | "") echo "$path/current (대상이 같은 디렉터리의 버전 이름이 아니다)"; return 1 ;;
        esac
        [ -d "$path/$(readlink "$path/current")" ] || { echo "$path/current (대상 없음)"; return 1; }
      fi
    fi
    parent="$(dirname "$path")"
    while [ "$parent" != "/" ]; do
      if [ "$(stat -f '%Su' "$parent")" != root ] || [ $((0$(stat -f '%Lp' "$parent") & 022)) != 0 ]; then echo "$parent"; return 1; fi
      parent="$(dirname "$parent")"
    done
  done
  return 0
}

# Node 22 실행 파일의 **실제 경로**(sandbox 의 process-exec 허용은 심볼릭 링크를 따라가지 않는다).
node_bin() {
  local candidate
  for candidate in "${ATMARK_AIWATCH_NODE:-}" /opt/homebrew/opt/node@22/bin/node; do
    [ -n "$candidate" ] && [ -x "$candidate" ] || continue
    # 버전 검사 — root(설치 단계)라면 사용자 권한으로 내려서, 어느 쪽이든 빈 환경 · 빈 OpenSSL 설정으로 돌린다
    #   (Homebrew openssl.cnf 는 사용자 쓰기 가능 — root 로 읽으면 provider dylib 를 root 로 로드할 수 있다. 보안 재검증 LOW).
    if [ "$(id -u)" = 0 ] && [ -n "${SUDO_USER:-}" ]; then
      sudo -u "$SUDO_USER" env -i OPENSSL_CONF=/dev/null "$candidate" -e 'process.exit(process.versions.node.split(".")[0] === "22" ? 0 : 1)' 2> /dev/null || continue
    else
      env -i OPENSSL_CONF=/dev/null "$candidate" -e 'process.exit(process.versions.node.split(".")[0] === "22" ? 0 : 1)' 2> /dev/null || continue
    fi
    # macOS realpath(13+) — 없으면 python 없이 cd/pwd 로.
    if command -v realpath > /dev/null; then realpath "$candidate"; else (cd "$(dirname "$candidate")" && echo "$(pwd -P)/$(basename "$candidate")"); fi
    return 0
  done
  return 1
}

log() { printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"; }
need_root() { [ "$(id -u)" = 0 ] || { echo "root 로 돌린다: sudo bash $0 $*"; exit 1; }; }
daemon_loaded() { launchctl print "system/$LABEL" > /dev/null 2>&1; }
daemon_pid() { launchctl print "system/$LABEL" 2> /dev/null | awk '/^\tpid = /{print $3; exit}'; }
key_present() { security find-generic-password -s "$KC_SERVICE" -a "$KC_ACCOUNT" "$KEYCHAIN" > /dev/null 2>&1; }

# sandbox-exec 매개변수(설치 경로 기준). verify.sh 가 같은 값으로 샌드박스를 시험한다.
sandbox_args() {
  local node="$1" tmp="${2:-$TMP_DIR}"
  printf '%s\n' -D "NODE=$node" -D "TMP_DIR=$tmp"
}
