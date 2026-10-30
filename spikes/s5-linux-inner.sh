#!/bin/sh
# Runs inside a Linux container. /s holds the spike folder (read-only); /work is scratch.
set -e
ARCH=$(uname -m); BIN=/s/dist/s5-bun-linux-x64; [ "$ARCH" = "aarch64" ] && BIN=/s/dist/s5-bun-linux-arm64
mkdir -p /work/rt && cd /work/rt && echo '{"private":true}' > package.json
bun add playwright-core@1.64.1 sharp@0.35.5 >/dev/null 2>&1
export PLAYWRIGHT_BROWSERS_PATH=/work/browsers
bunx playwright-core install --with-deps webkit >/tmp/pw-install.log 2>&1 || { echo "webkit install failed"; tail -5 /tmp/pw-install.log; }
cp /s/.pw/rt/helper.mjs /work/rt/helper.mjs
cd /tmp
echo "== compiled binary ($ARCH): playwright + secrets + bundled sharp"
PW_DIR=/work/rt $BIN all
echo "== compiled binary as bun (BUN_BE_BUN=1) running the render helper"
BUN_BE_BUN=1 $BIN /work/rt/helper.mjs || echo "helper failed"
