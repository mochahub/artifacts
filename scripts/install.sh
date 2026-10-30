#!/bin/sh
# Installs the Artifacts CLI to ~/.artifacts/bin. Pass a version with ARTIFACTS_VERSION.
# No pipefail: this runs under whatever /bin/sh is (dash has none), so each download is checked on its own.
set -eu

REPO="mochahub/artifacts"
BASE="${ARTIFACTS_RELEASES_URL:-https://github.com/$REPO/releases/download}"
DEST="$HOME/.artifacts/bin"

# A binary comes only over https. Plain http is for a test server on this machine.
case "$BASE" in
  https://* | http://127.0.0.1 | http://127.0.0.1[:/]* | http://localhost | http://localhost[:/]*) ;;
  *) echo "$BASE isn't https, so nothing was downloaded." >&2; exit 1 ;;
esac

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) echo "This installer supports macOS and Linux. On Windows, download the binary from the release." >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) echo "No build for $(uname -m)." >&2; exit 1 ;;
esac

fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1"; else wget -qO- "$1"; fi
}

version="${ARTIFACTS_VERSION:-}"
if [ -z "$version" ]; then
  version=$(fetch "https://api.github.com/repos/$REPO/releases/latest" | sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p')
fi
[ -n "$version" ] || { echo "Couldn't find the latest version." >&2; exit 1; }
# The version goes into a URL, so only a plain number such as 0.2.0 is accepted.
case "$version" in
  *[!0-9A-Za-z.-]* | -* | .* | *..*) echo "\"$version\" isn't a version number." >&2; exit 1 ;;
esac

name="artifacts-$os-$arch"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fetch "$BASE/v$version/$name" >"$tmp/$name"
fetch "$BASE/v$version/SHA256SUMS" >"$tmp/SHA256SUMS"

# The line for this file, matched whole: "foo-$name" is a different file.
expected=$(grep " \*\{0,1\}$name\$" "$tmp/SHA256SUMS" | head -n 1 | cut -d' ' -f1 || true)
[ -n "$expected" ] || { echo "The release has no checksum for $name." >&2; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$tmp/$name" | cut -d' ' -f1)
elif command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$tmp/$name" | cut -d' ' -f1)
else
  echo "Neither sha256sum nor shasum is here, so the download can't be checked." >&2; exit 1
fi
[ "$expected" = "$actual" ] || { echo "The download doesn't match its checksum." >&2; exit 1; }

# Copied beside its final name first: a move across disks isn't atomic, and a crash would leave half a file.
mkdir -p "$DEST"
cp "$tmp/$name" "$DEST/.artifacts.$$"
chmod 755 "$DEST/.artifacts.$$"
mv -f "$DEST/.artifacts.$$" "$DEST/artifacts"
echo "Installed artifacts $version to $DEST/artifacts"

line="export PATH=\"$DEST:\$PATH\""
case ":$PATH:" in
  *":$DEST:"*) ;;
  *)
    for profile in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.profile"; do
      if [ -f "$profile" ]; then
        # Once only: running the installer again in a shell that lacks the path mustn't stack up lines.
        grep -qxF "$line" "$profile" || echo "$line" >>"$profile"
        echo "Added it to PATH in $profile. Open a new terminal, then run: artifacts setup"
        exit 0
      fi
    done
    echo "Add this to your shell profile: $line"
    ;;
esac
