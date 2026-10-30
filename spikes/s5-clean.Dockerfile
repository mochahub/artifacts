FROM debian:bookworm-slim
RUN apt-get update -qq && apt-get install -y -qq ca-certificates >/dev/null && useradd -m u
COPY dist/s5-bun-linux-arm64 /home/u/artifacts
RUN chown u /home/u/artifacts
USER u
