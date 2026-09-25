#!/usr/bin/env bash
# 功能验证：install.sh 收尾处的「浏览器打开 / 无头提示」块 + 版本提示块
# 用法: bash workspace/scripts/manual-verify-install-autooepn.sh   (在仓库根目录执行)
# 说明: xdg-open 被真正调用时其 stdout 会被 2>&1 重定向到 /dev/null，
#       因此用「桩脚本写调用记录文件」来判定是否被调用，而不是看 stdout。
set -u
SRC="${SRC:-site/install.sh}"
[ -f "$SRC" ] || { echo "SKIP: $SRC not found (run from repo root)"; exit 2; }

B_START=$(grep -n 'elif \[ "\$PLATFORM" = "Linux" \]; then' "$SRC" | tail -1 | cut -d: -f1)
B_END=$(awk -v s="$B_START" 'NR>s && /^    fi$/ {print NR; exit}' "$SRC")
N_START=$(grep -n 'DEPLOY_NOTE=""' "$SRC" | head -1 | cut -d: -f1 || true)
N_END=$(awk -v s="$N_START" 'NR>=s && /ok "部署版本/ {print NR; exit}' "$SRC")

echo "锚点: open-block=${B_START}-${B_END}  version-note=${N_START}-${N_END}"
[ -n "${B_START:-}" ] && [ -n "${B_END:-}" ] && [ -n "${N_START:-}" ] && [ -n "${N_END:-}" ] || { echo ANCHOR_FAIL; exit 1; }

B_OPEN=$(sed -n "${B_START},${B_END}p" "$SRC")
B_NOTE=$(sed -n "${N_START},${N_END}p" "$SRC")

echo "===== 浏览器打开 / 无头提示块 ====="
echo "$B_OPEN"
echo
echo "===== 版本提示块 ====="
echo "$B_NOTE"
echo

PASS=0; FAIL=0
chk() { if [ "$2" = "$3" ]; then echo "  PASS: $1"; PASS=$((PASS+1)); else echo "  FAIL: $1 (期望 $2 实得 $3)"; FAIL=$((FAIL+1)); fi; }

TMPD=$(mktemp -d)
MARKER="$TMPD/calls.log"
: > "$MARKER"
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" >> "'"$MARKER"'"\n' > "$TMPD/xdg-open"
chmod +x "$TMPD/xdg-open"
RUN_OPEN() { eval "if false; then :; $B_OPEN" 2>&1; }
calls() { cat "$MARKER"; }

echo "--- 1) 无图形会话（云服务器典型场景）---"
: > "$MARKER"
OUT=$( set +u; export PATH="$TMPD:$PATH"; PLATFORM=Linux; PORT=3456; DRY_RUN=0
       unset DISPLAY WAYLAND_DISPLAY; USER=root; RUN_OPEN ); RC=$?
echo "$OUT" | sed 's/^/    | /'
[ "$RC" = "0" ] && a=1 || a=0; chk "退出码 0（不因无图形而失败）" 1 "$a"
echo "$OUT" | grep -q 'ssh -N -L 3456:127.0.0.1:3456' && b=1 || b=0; chk "给出可复制的 SSH 隧道命令" 1 "$b"
[ -z "$(calls)" ] && c=1 || c=0; chk "无头时未调用 xdg-open" 1 "$c"

echo "--- 2) 有图形会话（DISPLAY=:0）---"
: > "$MARKER"
OUT=$( export PATH="$TMPD:$PATH"; PLATFORM=Linux; PORT=3456; DRY_RUN=0; DISPLAY=:0; RUN_OPEN ); RC=$?
echo "$OUT" | sed 's/^/    | /'
echo "    桩记录: $(calls | tr '\n' ' ')"
[ "$RC" = "0" ] && a=1 || a=0; chk "退出码 0" 1 "$a"
calls | grep -q 'http://localhost:3456' && b=1 || b=0; chk "有图形时确实调用 xdg-open 打开 3456" 1 "$b"

echo "--- 3) dry-run（DRY_RUN=1）不应真去开浏览器 ---"
: > "$MARKER"
OUT=$( export PATH="$TMPD:$PATH"; PLATFORM=Linux; PORT=3456; DRY_RUN=1; DISPLAY=:0; RUN_OPEN ); RC=$?
echo "$OUT" | head -3 | sed 's/^/    | /'
[ "$RC" = "0" ] && a=1 || a=0; chk "退出码 0" 1 "$a"
[ -z "$(calls)" ] && c=1 || c=0; chk "dry-run 未调用 xdg-open" 1 "$c"
rm -rf "$TMPD"

echo "--- 4) 版本提示 ---"
UP=$( VERSION_BEFORE=2.0.25; VERSION=2.0.27; ok(){ echo "$*"; }; eval "$B_NOTE" )
FR=$( set +u; unset VERSION_BEFORE; VERSION=2.0.27; ok(){ echo "$*"; }; eval "$B_NOTE" )
SM=$( VERSION_BEFORE=2.0.27; VERSION=2.0.27; ok(){ echo "$*"; }; eval "$B_NOTE" )
echo "    升级 2.0.25->2.0.27 : $UP"
echo "    全新安装            : $FR"
echo "    同版本重装          : $SM"
echo "$UP" | grep -q 'v2.0.27 (升级自 v2.0.25)' && a=1 || a=0; chk "升级时显示 (升级自 vX)" 1 "$a"
echo "$FR" | grep -q '升级自' && a=0 || a=1; chk "全新安装不显示升级字样" 1 "$a"
echo "$SM" | grep -q '升级自' && a=0 || a=1; chk "同版本重装不显示升级字样" 1 "$a"

echo
echo "RESULT: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = "0" ] && echo HARNESS_ALL_GREEN || echo HARNESS_HAS_FAILURES
exit "$FAIL"
