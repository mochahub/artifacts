#!/bin/sh
# A machine with only the compiled CLI: no bun, no node. Runs as a non-root user.
set -u
CLI=/home/u/artifacts
echo "bun on PATH: $(command -v bun || echo none); node on PATH: $(command -v node || echo none)"
mkdir -p /home/u/.artifacts/playwright && cd /home/u/.artifacts/playwright && echo '{"private":true}' > package.json
echo "== BUN_BE_BUN=1 artifacts add playwright-core sharp"
BUN_BE_BUN=1 $CLI add playwright-core@1.64.1 sharp@0.35.5 2>&1 | tail -3
ls node_modules/@img 2>&1
echo "== BUN_BE_BUN=1 artifacts x playwright-core install webkit (no system deps, non-root)"
export PLAYWRIGHT_BROWSERS_PATH=/home/u/.artifacts/playwright/browsers
BUN_BE_BUN=1 $CLI x playwright-core install webkit 2>&1 | grep -v '■' | tail -4
cp /s/.pw/rt/helper.mjs ./render.mjs
echo "== helper before system libraries"
BUN_BE_BUN=1 $CLI ./render.mjs 2>&1 | tail -4
echo "== missing system libraries, as playwright reports them"
BUN_BE_BUN=1 $CLI x playwright-core install-deps --dry-run webkit 2>&1 | tail -3 | cut -c1-400
