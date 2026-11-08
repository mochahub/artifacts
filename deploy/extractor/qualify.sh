#!/bin/sh
# Private local qualification only. No application stack or hosted configuration is touched.
set -eu
cd "$(dirname "$0")/../.."
tag="librarian-qualification-$(date +%s)-$$:local"
cleanup() { docker image rm "$tag" >/dev/null 2>&1 || true; }
trap cleanup EXIT HUP INT TERM
docker build -t "$tag" deploy/extractor
image=$(docker image inspect --format='{{.Id}}' "$tag")
printf 'Qualification image: %s\n' "$image"
TEST_LIBRARIAN_EXTRACTOR_IMAGE="$image" bun test \
  apps/server/src/librarian/ingestion/container-extractor.test.ts \
  apps/server/src/librarian/ingestion/extractor-qualification.test.ts \
  apps/server/src/librarian/ingestion/transport-qualification.test.ts
