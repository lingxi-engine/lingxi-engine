#!/usr/bin/env bash
# 无 Gradle 构建（1GB 内存的构建机也能跑）：aapt2 → javac → d8 → zipalign → apksigner
set -euo pipefail

SDK=/opt/android-sdk
BT=$SDK/build-tools/34.0.0
AJ=$SDK/platforms/android-34/android.jar
SRC=/tmp/apk-src/app/src/main
OUT=/tmp/apkbuild
KS=/opt/android-sdk/lingxi-release.jks
KS_PASS=lingxi2026

rm -rf "$OUT"
mkdir -p "$OUT/gen" "$OUT/classes" "$OUT/dex"

echo "== 1/7 compile resources =="
"$BT/aapt2" compile --dir "$SRC/res" -o "$OUT/res.zip"

echo "== 2/7 link resources + R.java =="
"$BT/aapt2" link -o "$OUT/base.apk" \
  -I "$AJ" \
  --manifest "$SRC/AndroidManifest.xml" \
  --java "$OUT/gen" \
  --min-sdk-version 24 --target-sdk-version 34 \
  --version-code 7 --version-name 1.5.0 \
  -R "$OUT/res.zip" --auto-add-overlay

echo "== 3/7 javac =="
find "$SRC/java" "$OUT/gen" -name '*.java' > "$OUT/sources.txt"
javac -encoding UTF-8 -source 17 -target 17 -classpath "$AJ" -d "$OUT/classes" @"$OUT/sources.txt"

echo "== 4/7 d8 =="
find "$OUT/classes" -name '*.class' > "$OUT/classes.txt"
"$BT/d8" --release --lib "$AJ" --min-api 24 --output "$OUT/dex" @"$OUT/classes.txt"

echo "== 5/7 package =="
cp "$OUT/base.apk" "$OUT/unsigned.apk"
cd "$OUT/dex" && zip -q -j "$OUT/unsigned.apk" classes.dex

echo "== 6/7 zipalign =="
"$BT/zipalign" -f 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

echo "== 7/7 sign =="
if [ ! -f "$KS" ]; then
  keytool -genkeypair -keystore "$KS" -alias lingxi -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass "$KS_PASS" -keypass "$KS_PASS" \
    -dname "CN=LingXi Engine, O=LingXi, C=CN" >/dev/null 2>&1
fi
"$BT/apksigner" sign --ks "$KS" --ks-key-alias lingxi \
  --ks-pass "pass:$KS_PASS" --key-pass "pass:$KS_PASS" \
  --out /tmp/lingxi-app.apk "$OUT/aligned.apk"
"$BT/apksigner" verify --print-certs /tmp/lingxi-app.apk | head -5

ls -lh /tmp/lingxi-app.apk
echo "BUILD_OK"
