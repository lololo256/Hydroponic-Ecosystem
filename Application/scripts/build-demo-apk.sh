#!/usr/bin/env bash
# Builds the instructor demo APK (virtual board, no hardware / no ThingsBoard account needed)
# and then puts the REAL app's web assets back into the Android project.
#
#   bash scripts/build-demo-apk.sh            -> ../Hydroponic-Demo.apk (next to Hydroponic.apk)
#
# The demo uses the Android "demo" flavor (id com.hydroponic.ecosystem.demo, name "Hydroponic Demo"),
# so it installs next to the real app. The real app is the "full" flavor.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="../Hydroponic-Demo.apk"

restore_real_assets() {
  echo "==> Restoring the real app web assets (npm run build + cap copy)"
  npm run build
  npx cap copy android
}
trap restore_real_assets EXIT

echo "==> Building demo web assets"
npm run build:demo
npx cap copy android

echo "==> Building demo APK (assembleDemoDebug)"
(cd android && ./gradlew assembleDemoDebug)

cp android/app/build/outputs/apk/demo/debug/app-demo-debug.apk "$OUT"
echo "==> Demo APK: $(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")"
