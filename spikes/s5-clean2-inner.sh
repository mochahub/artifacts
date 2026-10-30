#!/bin/sh
CLI=/home/u/artifacts; export PLAYWRIGHT_BROWSERS_PATH=/home/u/.artifacts/playwright/browsers
echo "bun: $(command -v bun || echo none); node: $(command -v node || echo none); user: $(id -un)"
mkdir -p /home/u/.artifacts/playwright && cd /home/u/.artifacts/playwright && echo '{"private":true}' > package.json
BUN_BE_BUN=1 $CLI add playwright-core@1.64.1 sharp@0.35.5 >/dev/null 2>&1
BUN_BE_BUN=1 $CLI node_modules/playwright-core/cli.js install webkit 2>&1 | grep -v "■" | tail -5
cp /s/.pw/rt/helper.mjs ./render.mjs
echo "== helper"; BUN_BE_BUN=1 $CLI ./render.mjs 2>&1 | grep -v "^ *at " | tail -12
