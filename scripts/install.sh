#!/bin/sh
# Installs the Artifacts CLI to ~/.artifacts/bin. Pass a version with ARTIFACTS_VERSION.
set -eu

REPO="mochahub/artifacts"
BASE="${ARTIFACTS_RELEASES_URL:-https://github.com/$REPO/releases/download}"
DEST="$HOME/.artifacts/bin"

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

name="artifacts-$os-$arch"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fetch "$BASE/v$version/$name" >"$tmp/$name"
fetch "$BASE/v$version/SHA256SUMS" >"$tmp/SHA256SUMS"

expected=$(grep " $name\$" "$tmp/SHA256SUMS" | cut -d' ' -f1)
if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$tmp/$name" | cut -d' ' -f1); else actual=$(shasum -a 256 "$tmp/$name" | cut -d' ' -f1); fi
[ "$expected" = "$actual" ] || { echo "The download doesn't match its checksum." >&2; exit 1; }

mkdir -p "$DEST"
chmod +x "$tmp/$name"
mv "$tmp/$name" "$DEST/artifacts"
echo "Installed artifacts $version to $DEST/artifacts"

case ":$PATH:" in
  *":$DEST:"*) ;;
  *)
    for profile in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.profile"; do
      if [ -f "$profile" ]; then
        echo "export PATH=\"$DEST:\$PATH\"" >>"$profile"
        echo "Added it to PATH in $profile. Open a new terminal, then run: artifacts setup"
        exit 0
      fi
    done
    echo "Add this to your shell profile: export PATH=\"$DEST:\$PATH\""
    ;;
esac
