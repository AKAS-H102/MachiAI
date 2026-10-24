#!/usr/bin/env bash
# Needs Node 22.6+ (for --experimental-strip-types) and a JDK. No network or API key needed.
cd "$(dirname "$0")"
fail=0
for t in unit/*.test.ts; do
  echo "== $t"
  out=$(node --experimental-strip-types "$t" 2>&1 | grep -v -i "ExperimentalWarning\|trace-warnings"); rc=${PIPESTATUS[0]}
  echo "$out" | tail -1
  if [ "$rc" != "0" ] || echo "$out" | grep -q "^FAIL"; then echo "  ^^ FAILED"; echo "$out" | grep "^FAIL"; fail=1; fi
done
for s in server-sim android; do
  echo "== $s"
  out=$(bash $s/run.sh 2>&1); rc=$?
  echo "$out" | tail -1
  if [ "$rc" != "0" ] || echo "$out" | grep -q "^FAIL"; then echo "  ^^ FAILED"; echo "$out" | grep "^FAIL"; fail=1; fi
done
[ $fail = 0 ] && echo "ALL TEST SUITES PASSED" || echo "SOME TESTS FAILED"
exit $fail
