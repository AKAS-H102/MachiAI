#!/usr/bin/env bash
# Runs the REAL server.ts against SIMULATED Google / Edge / express packages (no network, no API key).
set -euo pipefail
cd "$(dirname "$0")"
rm -rf work && mkdir -p work/node_modules
cp -r fakes/* work/node_modules/
cp ../../server.ts work/ && cp -r ../../lib work/lib && cp package.json test.mjs work/
cd work && node --experimental-strip-types test.mjs 2>&1 | grep -v -i "ExperimentalWarning\|trace-warnings\|^\[Machi"
