#!/usr/bin/env bash
# Copies the mod into Herdr's home. A symlinked mod folder loads its JavaScript
# but not its icons, so this copies instead; run it again after pulling.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
dest=${HERDR_APP_HOME:-$HOME/.config/herdr-app}/mods/claude-usage
mkdir -p "$dest"
cp "$here"/mods/claude-usage/*.js "$here"/mods/claude-usage/*.svg "$here"/mods/claude-usage/scan.sh "$here"/mods/claude-usage/scan.awk "$here"/mods/claude-usage/mod.json "$dest"/
chmod +x "$dest"/scan.sh
herdr-app check "$dest"
