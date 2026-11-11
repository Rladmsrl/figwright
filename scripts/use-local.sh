#!/usr/bin/env bash
# Build this checkout and put it to use on this machine: the MCP server runs from
# packages/mcp/dist (point the client at packages/mcp/dist/index.mjs), and the Figma plugin
# is the folder it was imported from, which gets this build's manifest.json and dist.
#
#   scripts/use-local.sh [plugin folder]     default: ~/figma-plugins/figwright
#
# To take upstream's changes first:  git fetch upstream && git merge upstream/main
# Afterwards restart the MCP connection, and reopen the plugin in Figma if it did not reload.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_DIR="${1:-$HOME/figma-plugins/figwright}"
PNPM_VERSION="$(node -p "require('$ROOT/package.json').packageManager.split('@')[1]")"

cd "$ROOT"
npx -y "pnpm@$PNPM_VERSION" install
npx -y "pnpm@$PNPM_VERSION" build

mkdir -p "$PLUGIN_DIR/dist"
cp packages/plugin/manifest.json "$PLUGIN_DIR/manifest.json"
cp packages/plugin/dist/code.js packages/plugin/dist/index.html "$PLUGIN_DIR/dist/"
echo "server: $ROOT/packages/mcp/dist/index.mjs"
echo "plugin: $PLUGIN_DIR"
