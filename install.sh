#!/bin/sh
# goalnight installer — equivalent to two codex commands + plugin_hooks enable.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Edward4226/goalnight/main/install.sh | sh
#
# Or read it first (recommended for any | sh script):
#   curl -fsSL https://raw.githubusercontent.com/Edward4226/goalnight/main/install.sh
set -e

GOALNIGHT_REPO="${GOALNIGHT_REPO:-Edward4226/goalnight}"
GOALNIGHT_REF="${GOALNIGHT_REF:-main}"

say()  { printf '\033[1;33m▶\033[0m %s\n' "$1"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$1"; }
err()  { printf '\033[1;31m✗\033[0m %s\n' "$1" >&2; }

# 1. Check codex CLI
say "Checking codex CLI..."
if ! command -v codex >/dev/null 2>&1; then
  err "Codex CLI not found. Install it first: npm install -g @openai/codex"
  exit 1
fi
ok "Codex CLI found ($(codex --version 2>/dev/null || echo 'unknown version'))"

# 2. Add marketplace
say "Adding goalnight marketplace ($GOALNIGHT_REPO@$GOALNIGHT_REF)..."
codex plugin marketplace add "$GOALNIGHT_REPO" --ref "$GOALNIGHT_REF"
ok "Marketplace added"

# 3. Stage the plugin from .tmp/marketplaces into plugins/cache and npm install.
#    codex 0.130.0 `marketplace add` git-clones into ~/.codex/.tmp/marketplaces/<name>/
#    but doesn't activate plugins — no `codex plugin add` subcommand exists in this
#    release. We bridge that gap manually: copy the plugin source into the runtime
#    cache layout codex expects, then write an explicit [plugins."<name>@<mkt>"]
#    enable block to config.toml.
say "Staging goalnight plugin into runtime cache..."
PLUGIN_SOURCE="$HOME/.codex/.tmp/marketplaces/goalnight/plugins/goalnight"
if [ ! -d "$PLUGIN_SOURCE" ]; then
  err "Marketplace add succeeded but plugin source missing at $PLUGIN_SOURCE"
  err "Re-run install.sh; if it persists, file an issue."
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  err "node not found in PATH. Install Node.js >= 18 and re-run."
  exit 1
fi
PLUGIN_VERSION=$(node -p "require('$PLUGIN_SOURCE/.codex-plugin/plugin.json').version")
PLUGIN_ROOT="$HOME/.codex/plugins/cache/goalnight/goalnight/$PLUGIN_VERSION"
mkdir -p "$PLUGIN_ROOT"
# Idempotent: cp overwrites; if a stale older version dir lingers, leave it for now
# (codex picks the registered version via [plugins.X@Y] block, not by scanning).
cp -R "$PLUGIN_SOURCE/." "$PLUGIN_ROOT/"
ok "Plugin staged at $PLUGIN_ROOT"

say "Installing goalnight plugin runtime deps (npm install)..."
(cd "$PLUGIN_ROOT" && npm install --no-audit --no-fund --silent)
ok "Plugin deps installed"

# 4. Enable plugin_hooks + register [plugins."goalnight@goalnight"] enabled = true.
CONFIG="$HOME/.codex/config.toml"
say "Updating $CONFIG..."
[ -f "$CONFIG" ] || touch "$CONFIG"
cp "$CONFIG" "$CONFIG.bak.$(date +%s)" 2>/dev/null || true
if grep -qE "^(features\.)?plugin_hooks[[:space:]]*=[[:space:]]*true" "$CONFIG" 2>/dev/null; then
  ok "plugin_hooks already enabled"
elif grep -q "^\[features\]" "$CONFIG" 2>/dev/null; then
  # [features] exists somewhere — insert plugin_hooks RIGHT AFTER it so it lands
  # inside the table. A naive `printf >> file` lands at file-end and would attach
  # to whatever table happens to be open there (we saw this land under
  # [plugins."goalnight@goalnight"] in practice).
  awk 'BEGIN{done=0} /^\[features\]/ && !done {print; print "plugin_hooks = true"; done=1; next} {print}' "$CONFIG" > "$CONFIG.tmp" \
    && mv "$CONFIG.tmp" "$CONFIG"
  ok "plugin_hooks = true inserted under [features]"
else
  # No [features] table — safe to append a fresh block at file end.
  printf '\n[features]\nplugin_hooks = true\n' >> "$CONFIG"
  ok "[features] block + plugin_hooks = true appended"
fi
if grep -q '^\[plugins."goalnight@goalnight"\]' "$CONFIG" 2>/dev/null; then
  ok "[plugins.\"goalnight@goalnight\"] already registered"
else
  printf '\n[plugins."goalnight@goalnight"]\nenabled = true\n' >> "$CONFIG"
  ok "[plugins.\"goalnight@goalnight\"] enabled = true added"
fi
ok "Config backup at $CONFIG.bak.*"

cat <<'EOF'

🌙 goalnight installed.

Try it inside a codex session:

  @goalnight plan 8h to <your goal>
  @goalnight brief

Dashboard (after a session starts): http://localhost:8888

EOF

# 6. macOS auto-resume watcher via launchd (v0.1 final — appended by Worker B)
if [ "$(uname)" = "Darwin" ]; then
  say "Installing auto-resume watcher..."

  # PLUGIN_ROOT was set in step 3 above (cache dir where codex staged the plugin).
  PLIST_SRC="$PLUGIN_ROOT/server/watcher/launchd.plist"

  if [ ! -f "$PLIST_SRC" ]; then
    err "Could not find $PLIST_SRC."
    err "Skipping watcher install."
  else
    NODE_PATH=$(command -v node)
    PLIST_DST="$HOME/Library/LaunchAgents/dev.goalnight.watcher.plist"

    if [ -z "$NODE_PATH" ]; then
      err "node not found in PATH. Install Node.js >=18 and re-run."
    else
      mkdir -p "$HOME/.goalnight" "$HOME/Library/LaunchAgents"

      # Substitute ${PLUGIN_ROOT} / ${HOME} / node path into the template.
      sed \
        -e "s|/usr/local/bin/node|$NODE_PATH|g" \
        -e "s|\${PLUGIN_ROOT}|$PLUGIN_ROOT|g" \
        -e "s|\${HOME}|$HOME|g" \
        "$PLIST_SRC" > "$PLIST_DST"

      # Reload (no-op-friendly: unload before load handles re-install).
      launchctl unload "$PLIST_DST" 2>/dev/null || true
      launchctl load "$PLIST_DST"

      ok "Watcher installed (logs: ~/.goalnight/watcher.log)"
      ok "Dry-run is on by default. To enable real auto-resume, edit"
      ok "  $PLIST_DST"
      ok "and set GOALNIGHT_WATCHER_RESUME to \"1\", then:"
      ok "  launchctl unload \"$PLIST_DST\" && launchctl load \"$PLIST_DST\""
    fi
  fi
fi
