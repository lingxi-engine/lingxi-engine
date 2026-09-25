#!/usr/bin/env bash
# ============================================================
#  抽取式测试：install.sh 的「站点索引版本兜底」
#
#  背景（2026-09-25）：
#    site/install.sh 在 --dry-run 下不真下载解压，于是读不到包内 version.txt，
#    banner 与「下载灵犀引擎 vX」都显示 vunknown —— 一个专门用来做验证的模式，
#    却给出误导性的版本号。
#
#  修复：包内读不到版本时回退站点索引 version.txt（与 tar 包同批次发布）。
#        站点也不可达时必须如实输出 unknown，绝不编造版本号。
#
#  本测试直接从真实 site/install.sh 抽取 fetch_site_version() 与两处调用点，
#  实现被改坏时测试不会「假装还绿」。不依赖网络（curl 用桩替代）。
# ============================================================
set -uo pipefail

SRC="site/install.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAILED=0
ok()   { echo "  [OK]   $*"; PASS=$((PASS + 1)); }
bad()  { echo "  [FAIL] $*"; FAILED=$((FAILED + 1)); }

[ -f "$SRC" ] || { echo "[FATAL] $SRC not found"; exit 1; }

echo "== 1. 静态断言：调用点存在（防回退逻辑被删/被绕过） =="

if grep -q '^fetch_site_version() {' "$SRC"; then
    ok "fetch_site_version() 定义存在"
else
    bad "fetch_site_version() 定义缺失"
fi

# dry-run 分支：必须在 banner 之前取值
if grep -A3 'dry-run 场景' "$SRC" | grep -q 'fetch_site_version'; then
    ok "dry-run 分支调用 fetch_site_version"
else
    bad "dry-run 分支未调用 fetch_site_version（banner 会再次显示 vunknown）"
fi

# 部署后读版本的 else 兜底
if grep -B6 '部署包内无 version.txt' "$SRC" | grep -q 'fetch_site_version'; then
    ok "部署后 else 分支调用 fetch_site_version"
else
    bad "部署后 else 分支缺少兜底"
fi

# 调用次数：1 处定义 + 2 处调用
N=$(grep -c 'fetch_site_version' "$SRC")
if [ "$N" = "3" ]; then
    ok "fetch_site_version 出现 3 次（1 定义 + 2 调用）"
else
    bad "fetch_site_version 出现 $N 次，期望 3"
fi

echo "== 2. 静态断言：无硬编码版本号 / 换行与 BOM 干净 =="

if grep -qE '^VERSION="[0-9]+\.[0-9]+\.[0-9]+"' "$SRC"; then
    bad "install.sh 又出现硬编码 VERSION=\"x.y.z\"（版本漂移复发）"
else
    ok "无硬编码版本号"
fi

if LC_ALL=C grep -qU $'\r' "$SRC"; then
    bad "$SRC 含 CRLF（会造成 bad interpreter）"
else
    ok "LF-only"
fi

if [ "$(head -c 3 "$SRC" | od -An -tx1 | tr -d ' \n')" = "efbbbf" ]; then
    bad "$SRC 含 UTF-8 BOM"
else
    ok "无 BOM"
fi

echo "== 3. 行为测试：抽取真实函数，用桩 curl 驱动 =="

awk '/^fetch_site_version\(\) \{/{f=1} f{print} f&&/^\}/{exit}' "$SRC" > "$TMP/fn.sh"
if grep -q 'printf' "$TMP/fn.sh" && [ "$(wc -l < "$TMP/fn.sh")" -ge 8 ]; then
    ok "函数抽取成功（$(wc -l < "$TMP/fn.sh") 行）"
else
    bad "函数抽取失败"
    echo "--- 抽取结果 ---"; cat "$TMP/fn.sh"
    echo "抽取式测试 FAILED ($FAILED 项)"; exit 1
fi

{
    echo 'BASE_URL="http://example.invalid:9"'
    cat "$TMP/fn.sh"
    echo 'fetch_site_version'
} > "$TMP/runner.sh"

mkdir -p "$TMP/bin" "$TMP/empty"
cat > "$TMP/bin/curl" <<'STUB'
#!/bin/sh
# 桩 curl：STUB_FAIL=1 时模拟站点不可达
[ "${STUB_FAIL:-0}" = "1" ] && exit 22
cat "${STUB_OUT:-/dev/null}"
STUB
chmod +x "$TMP/bin/curl"

run_case() { PATH="$TMP/bin:$PATH" STUB_OUT="$1" STUB_FAIL="${3:-0}" bash "$TMP/runner.sh" 2>/dev/null; }

printf '2.0.26\n' > "$TMP/plain"
printf '\357\273\2772.0.27\r\n' > "$TMP/bomcrlf"
printf '2.0.28' > "$TMP/nonewline"

R=$(run_case "$TMP/plain")
[ "$R" = "2.0.26" ] && ok "纯 LF -> 2.0.26" || bad "纯 LF 得到 '$R'"

R=$(run_case "$TMP/bomcrlf")
[ "$R" = "2.0.27" ] && ok "BOM+CRLF -> 2.0.27（BOM/CR 已剥离）" || bad "BOM+CRLF 得到 '$R'"

R=$(run_case "$TMP/nonewline")
[ "$R" = "2.0.28" ] && ok "无尾换行 -> 2.0.28" || bad "无尾换行得到 '$R'"

# 关键：站点不可达时必须空输出，绝不能编造
R=$(PATH="$TMP/bin:$PATH" STUB_FAIL=1 bash "$TMP/runner.sh" 2>/dev/null)
[ -z "$R" ] && ok "站点不可达 -> 空输出（不编造版本号）" || bad "站点不可达却输出 '$R'（编造版本号！）"

# 无 curl 且无 wget
R=$(PATH="$TMP/empty" bash "$TMP/runner.sh" 2>/dev/null)
[ -z "$R" ] && ok "无 curl/wget -> 空输出" || bad "无 curl/wget 却输出 '$R'"

echo
if [ "$FAILED" = "0" ]; then
    echo "ALL VERSION-FALLBACK CASES PASS ($PASS 项)"
    exit 0
fi
echo "抽取式测试 FAILED ($FAILED 项失败)"; exit 1
