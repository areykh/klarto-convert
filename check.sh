#!/usr/bin/env bash
# Runs every check: build in check mode, unit and round-trip tests (including
# the large-file tests; LARGE=0 skips them), the HTML link and asset checker,
# and the headless-Chrome smoke test (SMOKE=0 skips it; --large adds the
# 50 MB / 20 MB browser runs).
set -uo pipefail
cd "$(dirname "$0")"
fail=0
step() { printf '\n== %s\n' "$1"; }

step 'build.py --check'
python3 build.py --check || fail=1

step 'node --test tests/'
node --test tests/ || fail=1

step 'tools/check_site.py'
python3 tools/check_site.py || fail=1

if [ "${SMOKE:-1}" != 0 ]; then
  step 'tests/smoke.mjs (headless Chrome)'
  node tests/smoke.mjs "$@" | grep -v '^ok '
  rc=${PIPESTATUS[0]}
  if [ "$rc" = 2 ]; then echo 'SKIPPED: no Chrome found (not counted as passed)'; fail=1
  elif [ "$rc" != 0 ]; then fail=1; fi
else
  echo; echo '== smoke test skipped (SMOKE=0)'
fi

echo
if [ "$fail" = 0 ]; then echo 'ALL CHECKS PASSED'; else echo 'SOME CHECKS FAILED'; fi
exit "$fail"
