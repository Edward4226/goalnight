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

# 3. Install npm deps inside the cached plugin (codex caches the marketplace tree
#    under ~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/ on `marketplace add`).
say "Installing goalnight plugin runtime deps..."
PLUGIN_CACHE=$(find "$HOME/.codex/plugins/cache" -type f \
  -path "*/goalnight/*/package.json" 2>/dev/null | head -1)
if [ -z "$PLUGIN_CACHE" ]; then
  err "Could not locate goalnight plugin under ~/.codex/plugins/cache."
  err "Marketplace add did not stage the plugin — re-run install.sh in a minute."
  exit 1
fi
PLUGIN_ROOT=$(dirname "$PLUGIN_CACHE")
(cd "$PLUGIN_ROOT" && npm install --no-audit --no-fund --silent)
ok "Plugin deps installed in $PLUGIN_ROOT"

# 4. Enable plugin_hooks
CONFIG="$HOME/.codex/config.toml"
say "Enabling plugin_hooks in $CONFIG..."
[ -f "$CONFIG" ] || touch "$CONFIG"
if grep -q "^plugin_hooks[[:space:]]*=[[:space:]]*true" "$CONFIG" 2>/dev/null; then
  ok "plugin_hooks already enabled"
else
  cp "$CONFIG" "$CONFIG.bak.$(date +%s)" 2>/dev/null || true
  if ! grep -q "^\[features\]" "$CONFIG"; then
    printf '\n[features]\n' >> "$CONFIG"
  fi
  printf 'plugin_hooks = true\n' >> "$CONFIG"
  ok "plugin_hooks enabled (backup at $CONFIG.bak.*)"
fi

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
