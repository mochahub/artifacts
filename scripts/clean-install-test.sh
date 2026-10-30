#!/bin/sh
# The M8 agent check: a clean Debian machine with only install.sh, then `artifacts setup --docker`.
# Run from the repo root after building artifacts:dev and a linux binary into dist/release.
# Inside a privileged container with its own Docker daemon, so nothing touches the host's Docker.
set -eu
arch=$(docker info --format '{{.Architecture}}')
case "$arch" in aarch64|arm64) target=linux-arm64 ;; *) target=linux-x64 ;; esac
rel=$(mktemp -d)
mkdir -p "$rel/v0.1.0"
cp dist/release/artifacts-"$target" dist/release/SHA256SUMS "$rel/v0.1.0/"
cp scripts/install.sh "$rel/"
docker save artifacts:dev -o "$rel/image.tar"
docker run --rm --privileged -v "$rel:/rel:ro" debian:trixie-slim sh -euc '
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq >/dev/null
  apt-get install -y -qq --no-install-recommends docker.io docker-cli docker-compose iptables python3 ca-certificates curl procps >/dev/null 2>&1
  mkdir -p /usr/libexec/docker/cli-plugins
  dockerd >/var/log/dockerd.log 2>&1 &
  for i in $(seq 1 60); do docker info >/dev/null 2>&1 && break; sleep 1; done
  docker load -i /rel/image.tar >/dev/null
  (cd /rel && python3 -m http.server 9199 >/dev/null 2>&1 &)
  sleep 1
  adduser --disabled-password --gecos "" sam >/dev/null
  usermod -aG docker sam
  su sam -c "
    set -eu
    export ARTIFACTS_RELEASES_URL=http://127.0.0.1:9199 ARTIFACTS_VERSION=0.1.0
    curl -fsSL http://127.0.0.1:9199/install.sh | sh
    export PATH=\$HOME/.artifacts/bin:\$PATH
    artifacts --version
    ARTIFACTS_PASSWORD=\"correct horse battery\" ARTIFACTS_IMAGE=artifacts:dev artifacts setup --docker --dir \$HOME/srv --org Mochahub --name Sam --email sam@example.com --no-skill </dev/null
    artifacts whoami
    artifacts doctor || true
  "
'
rm -rf "$rel"
