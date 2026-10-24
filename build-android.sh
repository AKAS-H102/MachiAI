#!/usr/bin/env bash
# Needs: Node 20+, JDK 17+,
# Android SDK build-tools (aapt2, d8, zipalign, apksigner) on PATH, ANDROID_JAR pointing at android.jar.
# Usage: BACKEND_URL=https://your-server.example.com ./build-android.sh
set -euo pipefail
: "${BACKEND_URL:?Set BACKEND_URL to your deployed Machi server (https://...)}"
: "${ANDROID_JAR:=staging-android/tools/android.jar}"
npm install
VITE_BACKEND_URL="$BACKEND_URL" npm run build          # -> dist/
S=staging-android
# The WebView loads the page via loadDataWithBaseURL("https://machi.ai/"), so it must be ONE self-contained html file
node scripts/inline-html.mjs dist dist/index.single.html
rm -rf $S/assets/www && mkdir -p $S/assets/www && cp dist/index.single.html $S/assets/www/index.html
printf '%s' "$BACKEND_URL" > $S/assets/backend_url.txt
[ -n "${VERSION_CODE:-}" ] && sed -i "s/android:versionCode=\"[0-9]*\"/android:versionCode=\"$VERSION_CODE\"/" $S/AndroidManifest.xml
rm -rf $S/bin && mkdir -p $S/bin/classes
javac -Xlint:-options -source 8 -target 8 -cp "$ANDROID_JAR" -d $S/bin/classes $(find $S/src -name '*.java')
d8 --min-api 21 --lib "$ANDROID_JAR" --output $S/bin $(find $S/bin/classes -name '*.class')
aapt2 compile --dir $S/res -o $S/bin/res.zip
aapt2 link -o $S/bin/unaligned.apk -I "$ANDROID_JAR" --manifest $S/AndroidManifest.xml -A $S/assets $S/bin/res.zip
( cd $S/bin && zip -q -u unaligned.apk classes.dex )
zipalign -f 4 $S/bin/unaligned.apk $S/bin/aligned.apk
# Signing: ALWAYS the same key, otherwise Android says "package conflicts with an existing package" on update.
# Priority: KEYSTORE env (+KS_ALIAS, KS_PASS) -> committed signing/machi-release.jks. Never a random per-build key.
KEYSTORE="${KEYSTORE:-signing/machi-release.jks}"; KS_ALIAS="${KS_ALIAS:-machi}"; KS_PASS="${KS_PASS:-machi-pass}"
[ -f "$KEYSTORE" ] || { echo "Keystore $KEYSTORE not found - refusing to build with a random key"; exit 1; }
mkdir -p release
apksigner sign --ks "$KEYSTORE" --ks-key-alias "$KS_ALIAS" --ks-pass "pass:$KS_PASS" --key-pass "pass:$KS_PASS" --out release/Machi.apk $S/bin/aligned.apk
apksigner verify -v release/Machi.apk
echo "Built release/Machi.apk"
