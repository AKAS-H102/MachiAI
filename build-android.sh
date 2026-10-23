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
rm -rf $S/bin && mkdir -p $S/bin/classes
javac -Xlint:-options -source 8 -target 8 -cp "$ANDROID_JAR" -d $S/bin/classes $S/src/ai/machi/assistant/MainActivity.java
d8 --min-api 21 --lib "$ANDROID_JAR" --output $S/bin $(find $S/bin/classes -name '*.class')
aapt2 compile --dir $S/res -o $S/bin/res.zip
aapt2 link -o $S/bin/unaligned.apk -I "$ANDROID_JAR" --manifest $S/AndroidManifest.xml -A $S/assets $S/bin/res.zip
( cd $S/bin && zip -q -u unaligned.apk classes.dex )
zipalign -f 4 $S/bin/unaligned.apk $S/bin/aligned.apk
# Signing key is NOT shipped in the repo. Use your own (KEYSTORE=/path KS_ALIAS=name) or a throwaway debug key.
if [ -z "${KEYSTORE:-}" ]; then
  KEYSTORE=$S/bin/debug.keystore; KS_ALIAS=machi-debug
  [ -f "$KEYSTORE" ] || keytool -genkeypair -keystore "$KEYSTORE" -alias $KS_ALIAS -keyalg RSA -keysize 2048 -validity 10000 -storepass android -keypass android -dname "CN=Machi Debug"
  apksigner sign --ks "$KEYSTORE" --ks-key-alias $KS_ALIAS --ks-pass pass:android --out release/Machi.apk $S/bin/aligned.apk
else
  apksigner sign --ks "$KEYSTORE" --ks-key-alias "${KS_ALIAS:?set KS_ALIAS}" --out release/Machi.apk $S/bin/aligned.apk
fi
apksigner verify -v release/Machi.apk
echo "Built release/Machi.apk"
