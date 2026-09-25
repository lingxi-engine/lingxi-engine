#!/usr/bin/env bash
# scripts/test-install-linger.sh
#
# 验证 site/install.sh 里的 loginctl enable-linger 补丁块：
#   1) 从真实 install.sh 中"抽取"补丁块（不是复制粘贴副本，避免测试与实现漂移）；
#   2) 三条件分支各测一次：loginctl 成功 / 失败 / 不存在。
#
# 用法: bash scripts/test-install-linger.sh [install.sh 路径]
# 退出码: 0 全部通过, 1 有用例失败, 2 抽取失败

set -u
FAIL=0

ok()   { echo "  OK  $*"; }
warn() { echo "  WARN $*"; }
export -f ok warn

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${1:-$SCRIPT_DIR/../site/install.sh}"

if [ ! -f "$SRC" ]; then echo "FATAL: 找不到 $SRC"; exit 2; fi
echo "被测文件: $SRC"

# 抽取补丁块：从中文注释首行起，到块内最后一个 '        fi' 止
BLOCK=$(awk '/# 关键修复: 用户级 systemd 服务默认绑在登录会话上/,/^        fi$/' "$SRC")
if [ -z "$BLOCK" ]; then
  echo "FATAL: 未能在 $SRC 中定位补丁块（注释锚点或缩进变了？）"
  exit 2
fi
echo "补丁块行数: $(printf '%s\n' "$BLOCK" | wc -l | tr -d ' ')"

run_case() {
  local name="$1" mode="$2" expect="$3"
  local TMPD OUT RC
  TMPD=$(mktemp -d)
  case "$mode" in
    ok)   printf '#!/bin/sh\necho "MOCK enable-linger $2"\nexit 0\n' > "$TMPD/loginctl"; chmod +x "$TMPD/loginctl" ;;
    bad)  printf '#!/bin/sh\nexit 1\n' > "$TMPD/loginctl"; chmod +x "$TMPD/loginctl" ;;
    none) : ;;   # 不提供 loginctl
  esac

  OUT=$(PATH="$TMPD:$PATH" bash --norc -c "$BLOCK
exit 0" 2>&1); RC=$?
  echo "--- case=$name (loginctl=$mode) rc=$RC ---"
  echo "$OUT"

  if [ $RC -ne 0 ]; then echo "  => FAIL: 补丁块执行返回 rc=$RC"; FAIL=1; rm -rf "$TMPD"; return; fi
  if echo "$OUT" | grep -q "command not found"; then
    echo "  => FAIL: 出现 command not found"; FAIL=1; rm -rf "$TMPD"; return
  fi

  case "$expect" in
    linger_ok)   echo "$OUT" | grep -q "已开启 linger"     && echo "  => PASS" || { echo "  => FAIL: 未见成功提示"; FAIL=1; } ;;
    linger_fail) echo "$OUT" | grep -q "开启 linger 失败"  && echo "  => PASS" || { echo "  => FAIL: 未见失败提示"; FAIL=1; } ;;
    nologin)     echo "$OUT" | grep -q "未找到 loginctl"   && echo "  => PASS" || { echo "  => FAIL: 未见缺失 loginctl 提示"; FAIL=1; } ;;
    *)           echo "  => FAIL: 未知期望 $expect"; FAIL=1 ;;
  esac
  rm -rf "$TMPD"
}

run_case "loginctl 成功"  ok   linger_ok
run_case "loginctl 失败"  bad  linger_fail
run_case "无 loginctl"    none nologin

echo
if [ $FAIL -eq 0 ]; then echo "ALL CASES PASS"; else echo "SOME CASES FAILED"; fi
exit $FAIL
