FROM debian:bookworm-slim
RUN apt-get update -qq && apt-get install -y -qq ca-certificates >/dev/null && useradd -m u
COPY dist/s5-bun-linux-arm64 /home/u/artifacts
RUN chown u /home/u/artifacts && mkdir /tmp/d && cd /tmp/d && echo '{"private":true}' > package.json \
 && BUN_BE_BUN=1 /home/u/artifacts add playwright-core@1.64.1 >/dev/null 2>&1 \
 && BUN_BE_BUN=1 /home/u/artifacts node_modules/playwright-core/cli.js install-deps webkit >/tmp/deps.log 2>&1 && echo deps-ok && rm -rf /tmp/d
USER u
