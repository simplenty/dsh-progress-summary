#!/usr/bin/env bash
# Apply the "summary" work-details mode to the installed @deepseek-ai/dsh-client-ui-chat build.
# Usage: bash apply.sh [path-to-dsh-install]
# Default target: the global dsh package's bundled ui-chat.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${1:-$(npm root -g)/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-chat}"
[ -f "$ROOT/lib/client.js" ] || { echo "not a ui-chat build: $ROOT" >&2; exit 1; }
STAMP="$(date +%Y%m%d-%H%M%S)"
for f in index.js client.js; do
  cp "$ROOT/lib/$f" "$ROOT/lib/$f.bak-$STAMP"
done
patch -p1 -d "$ROOT" < "$HERE/ui-chat-host.patch"
patch -p1 -d "$ROOT" < "$HERE/ui-chat-client.patch"
echo "patched $ROOT (backups: *.bak-$STAMP); restart dsh web to load the host schema"
