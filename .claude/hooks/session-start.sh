#!/bin/bash
# SessionStart hook for Claude Code cloud sessions.
# The project has no npm dependencies today (Node built-ins only), so this
# mainly verifies the Node version and installs deps if any get added later.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}"

node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$node_major" -lt 20 ]; then
  echo "agent-annotator requires Node >= 20 (found $(node -v))" >&2
  exit 1
fi

if node -e 'const p=require("./package.json");process.exit(Object.keys({...p.dependencies,...p.devDependencies}).length?0:1)'; then
  npm install --no-audit --no-fund
fi

echo "agent-annotator ready: Node $(node -v). Run tests with: npm test"
