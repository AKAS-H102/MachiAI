#!/usr/bin/env bash
# Tests the microphone speech detector (SpeechCapture.java) on synthetic soft / loud / noisy audio.
set -euo pipefail
cd "$(dirname "$0")"
rm -rf out && mkdir out
if command -v javac >/dev/null 2>&1; then JAVAC=javac; else JAVAC="java -m jdk.compiler/com.sun.tools.javac.Main"; fi
$JAVAC -d out ../../staging-android/src/ai/machi/assistant/SpeechCapture.java VadTest.java
java -cp out VadTest
