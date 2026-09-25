#!/usr/bin/env bash
# 功能验证：install.sh 的版本号提取表达式能否正确剥离 CR 与 UTF-8 BOM。
# 直接复用 install.sh 里的表达式，避免测试与实现漂移。
set -u
FAIL=0

EXPR() { head -n1 "$1" | tr -d '\r\357\273\277'; }

check() {
  local name="$1" file="$2" expect="$3"
  local got
  got="$(EXPR "$file")"
  if [ "$got" = "$expect" ]; then
    echo "  [OK]   $name -> '$got'"
  else
    echo "  [FAIL] $name -> 得到 '$got'，期望 '$expect'"
    printf '         原始字节: '; od -An -tx1 "$file" | head -2
    FAIL=1
  fi
}

TMP=$(mktemp -d)

# 1. 纯 LF（仓库/包内的正常形态）
printf '2.0.26\nbuilt: 2026-09-25\n' > "$TMP/plain.txt"
check "纯 LF" "$TMP/plain.txt" "2.0.26"

# 2. BOM + LF（线上 publish-site.ps1 旧逻辑生成的就是这种）
printf '\xef\xbb\xbf2.0.26\nbuilt: x\n' > "$TMP/bom.txt"
check "BOM + LF" "$TMP/bom.txt" "2.0.26"

# 3. BOM + CRLF（最恶劣组合）
printf '\xef\xbb\xbf2.0.26\r\nbuilt: x\r\n' > "$TMP/bomcrlf.txt"
check "BOM + CRLF" "$TMP/bomcrlf.txt" "2.0.26"

# 4. CRLF（无 BOM）
printf '2.0.26\r\nbuilt: x\r\n' > "$TMP/crlf.txt"
check "CRLF（无 BOM）" "$TMP/crlf.txt" "2.0.26"

# 5. 只有一行、无换行符
printf '2.0.26' > "$TMP/nonl.txt"
check "无尾换行" "$TMP/nonl.txt" "2.0.26"

rm -rf "$TMP"
echo
if [ $FAIL -eq 0 ]; then echo "ALL VERSION-PARSE CASES PASS"; else echo "SOME CASES FAILED"; fi
exit $FAIL
