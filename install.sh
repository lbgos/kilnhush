#!/bin/sh
# Installs the latest kilnhush release on a GPU host:
#   curl -fsSL https://raw.githubusercontent.com/lbgos/kilnhush/main/install.sh | sudo sh
set -eu

if ! command -v node >/dev/null 2>&1 || ! node -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  process.exit(major > 22 || (major === 22 && minor >= 18) ? 0 : 1);
'; then
  echo "kilnhush needs Node.js 22.18 or newer: https://nodejs.org/en/download" >&2
  exit 1
fi

npm install --global --no-fund --no-audit https://github.com/lbgos/kilnhush/releases/latest/download/kilnhush.tgz
echo
echo "Installed. Next: sudo kilnhush setup"
