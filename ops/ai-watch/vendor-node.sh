#!/bin/bash
# Node 22 런타임을 워커 전용 디렉터리로 **복사해 고정**한다 — 보안 리뷰 HIGH-2(2026-10-06). 런북: docs/runbooks/ai-watch.md §2-1
#
#   bash ops/ai-watch/vendor-node.sh <원본 node> <대상 runtime 디렉터리>
#
# 왜: LaunchDaemon 은 root 로 뜬다. Homebrew 의 node·dylib 은 로그인 사용자(boni:admin) 소유라, 사용자 권한 프로세스가 바꿔치기하면
# 다음 재시작에 root + FD 3 의 AWS 키를 가진다. 또 `brew upgrade` 가 경로를 지우면 데몬이 조용히 죽는다.
# 그래서 node 와 그 **비시스템 dylib 폐포 전부**(otool -L 를 재귀로)를 <대상>/bin · <대상>/lib 으로 복사하고, 참조를 전부
# @rpath/<이름> 으로 바꾼 뒤(rpath = @loader_path/../lib · @loader_path) ad-hoc 재서명한다. /usr/lib · /System 만 밖을 가리킨다.
# setup.sh 의 root 단계가 부르고, 끝나면 root:wheel 0755/0644 로 바꾼다. 몇 번 돌려도 같은 결과(대상은 새로 만든다).
set -euo pipefail
src="${1:?원본 node 경로}"
dst="${2:?대상 runtime 디렉터리}"
[ -x "$src" ] || { echo "node 가 아니다: $src"; exit 1; }

is_system() { case "$1" in /usr/lib/* | /System/*) return 0 ;; *) return 1 ;; esac; }
deps_of() { otool -L "$1" | tail -n +2 | awk '{print $1}'; }
rpaths_of() { otool -l "$1" | awk '/cmd LC_RPATH/{getline; getline; print $2}'; }

# 참조 하나를 실제 파일로 — 절대 경로 · @loader_path · @rpath(그 파일의 rpath 들) · @executable_path(원본 node 기준).
resolve_ref() { # <참조> <참조하는 파일>
  local ref="$1" from="$2" dir rp cand
  dir="$(dirname "$from")"
  case "$ref" in
    @loader_path/*) cand="$dir/${ref#@loader_path/}" ;;
    @executable_path/*) cand="$(dirname "$src")/${ref#@executable_path/}" ;;
    @rpath/*)
      while read -r rp; do
        [ -n "$rp" ] || continue
        rp="${rp/@loader_path/$dir}"
        rp="${rp/@executable_path/$(dirname "$src")}"
        if [ -f "$rp/${ref#@rpath/}" ]; then cand="$rp/${ref#@rpath/}"; break; fi
      done <<< "$(rpaths_of "$from")"
      ;;
    *) cand="$ref" ;;
  esac
  [ -n "${cand:-}" ] && [ -f "$cand" ] || { echo "참조를 찾지 못했다: $ref (from $from)" >&2; return 1; }
  (cd "$(dirname "$cand")" && echo "$(pwd -P)/$(basename "$cand")")
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/lib"
cp "$src" "$work/bin/node"

# 폐포: 대기열(원본 경로) → 복사(이름 = basename). 같은 basename 이 다른 파일이면 멈춘다.
queue="$src"
seen=" "
while [ -n "$queue" ]; do
  file="${queue%%$'\n'*}"
  [ "$file" = "$queue" ] && queue="" || queue="${queue#*$'\n'}"
  while read -r ref; do
    [ -n "$ref" ] || continue
    is_system "$ref" && continue
    real="$(resolve_ref "$ref" "$file")"
    name="$(basename "$real")"
    [ "$name" = "$(basename "$file")" ] && continue   # 자기 id 줄
    case "$seen" in *" $name "*) continue ;; esac
    if [ -e "$work/lib/$name" ] && ! cmp -s "$real" "$work/lib/$name"; then echo "이름 충돌: $name"; exit 1; fi
    cp "$real" "$work/lib/$name"
    seen="$seen$name "
    queue="${queue:+$queue$'\n'}$real"
  done <<< "$(deps_of "$file")"
done

# 참조 고치기 — 모든 비시스템 참조를 @rpath/<basename> 으로, rpath 를 하나로.
relink() { # <파일> <rpath>
  local f="$1" want="$2" ref rp
  chmod u+w "$f"
  while read -r ref; do
    [ -n "$ref" ] || continue
    is_system "$ref" && continue
    [ "$ref" = "@rpath/$(basename "$ref")" ] && continue
    install_name_tool -change "$ref" "@rpath/$(basename "$ref")" "$f" 2> /dev/null
  done <<< "$(deps_of "$f")"
  while read -r rp; do
    [ -n "$rp" ] && install_name_tool -delete_rpath "$rp" "$f" 2> /dev/null
  done <<< "$(rpaths_of "$f")"
  install_name_tool -add_rpath "$want" "$f" 2> /dev/null
}
relink "$work/bin/node" "@loader_path/../lib"
for lib in "$work"/lib/*.dylib; do
  install_name_tool -id "@rpath/$(basename "$lib")" "$lib" 2> /dev/null || { chmod u+w "$lib"; install_name_tool -id "@rpath/$(basename "$lib")" "$lib"; }
  relink "$lib" "@loader_path"
done
for f in "$work"/lib/*.dylib "$work/bin/node"; do codesign --force --sign - "$f" 2> /dev/null; done

# 밖을 가리키는 참조가 남지 않았는가.
leak="$(for f in "$work/bin/node" "$work"/lib/*.dylib; do deps_of "$f"; rpaths_of "$f"; done | grep -v -e '^@rpath/' -e '^@loader_path' -e '^/usr/lib/' -e '^/System/' || true)"
[ -z "$leak" ] || { echo "밖을 가리키는 참조가 남았다:"; echo "$leak"; exit 1; }
# 시험 실행은 빈 환경 · 빈 OpenSSL 설정(복사 원본이 가리키는 Homebrew openssl.cnf 를 root 로 읽지 않게 — 보안 재검증 LOW).
env -i OPENSSL_CONF=/dev/null OPENSSL_MODULES=/var/empty "$work/bin/node" --openssl-config=/dev/null -e 'if (process.versions.node.split(".")[0] !== "22") process.exit(1)' || { echo "복사한 node 가 22 가 아니거나 뜨지 않는다"; exit 1; }

rm -rf "$dst.new"
mkdir -p "$(dirname "$dst")"
mv "$work" "$dst.new"
trap - EXIT
rm -rf "$dst"
mv "$dst.new" "$dst"
echo "runtime: $dst (node $("$dst/bin/node" -v) · dylib $(find "$dst/lib" -name '*.dylib' | wc -l | tr -d ' ')개)"
