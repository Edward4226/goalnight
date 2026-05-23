#!/bin/sh
# clean-install.sh — wipe goalnight state, run the local install.sh from a
# clean slate, assert every post-install invariant, then restore the user's
# previous state. Run this before every release and any time install.sh
# changes.
#
# Exit codes:
#   0   all assertions passed
#   1   assertion 1: [marketplaces.goalnight] missing from config.toml
#   2   assertion 2: [plugins."goalnight@goalnight"] missing or not enabled
#   3   assertion 3: plugin_hooks = true missing from config.toml
#   4   assertion 3: plugin_hooks = true sitting under the wrong table
#   5   assertion 4: plugin not staged into ~/.codex/plugins/cache/goalnight
#   6   assertion 5: better-sqlite3 missing (npm install never ran or failed)
#   7   assertion 6: `codex mcp list` does not show goalnight
#   8   assertion 7: launchd watcher not loaded
#   9   assertion 8: watcher.log missing (watcher never started)
#  10   assertion 8: watcher.log lacks 'starting watcher' line
# 100   precheck: not macOS (v0.1 limitation)
# 101   precheck: missing dependency
# 102   precheck: install.sh not found
#
# The restore step ALWAYS runs (EXIT/INT/TERM trap). If it ever fails the
# script prints the backup directory so you can recover manually.

set -e

# --- config -----------------------------------------------------------------
REPO_ROOT=$(cd "$(dirname "$0")/../.." && pwd)
INSTALL_SH="$REPO_ROOT/install.sh"
TS=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="${TMPDIR:-/tmp}/goalnight-clean-install-backup-$TS"
WATCHER_WAS_LOADED=0
RESTORE_FAILED=0

# --- output helpers ---------------------------------------------------------
say()  { printf '\033[1;33m▶\033[0m %s\n' "$1"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$1"; }
err()  { printf '\033[1;31m✗\033[0m %s\n' "$1" >&2; }
fail() { err "$2"; exit "$1"; }

# --- precheck ---------------------------------------------------------------
say "Pre-flight checks"
[ "$(uname)" = "Darwin" ] || fail 100 "macOS only (v0.1 — Linux untested)"
for bin in codex node npm grep awk launchctl find shasum python3; do
  command -v "$bin" >/dev/null 2>&1 || fail 101 "Missing dependency: $bin"
done
[ -f "$INSTALL_SH" ] || fail 102 "install.sh not found at $INSTALL_SH"
ok "deps present"
ok "INSTALL_SH=$INSTALL_SH"

# --- snapshot pre-state -----------------------------------------------------
say "Snapshotting current goalnight state -> $BACKUP_DIR"
mkdir -p "$BACKUP_DIR"

if launchctl list 2>/dev/null | grep -q 'dev\.goalnight\.watcher'; then
  WATCHER_WAS_LOADED=1
fi
echo "$WATCHER_WAS_LOADED" > "$BACKUP_DIR/watcher_was_loaded"

[ -f "$HOME/.codex/config.toml" ] \
  && cp "$HOME/.codex/config.toml" "$BACKUP_DIR/config.toml"
[ -d "$HOME/.codex/plugins/cache/goalnight" ] \
  && cp -R "$HOME/.codex/plugins/cache/goalnight" "$BACKUP_DIR/cache-goalnight"
[ -d "$HOME/.codex/.tmp/marketplaces/goalnight" ] \
  && cp -R "$HOME/.codex/.tmp/marketplaces/goalnight" "$BACKUP_DIR/tmp-marketplace-goalnight"
[ -d "$HOME/.goalnight" ] \
  && cp -R "$HOME/.goalnight" "$BACKUP_DIR/dot-goalnight"
[ -f "$HOME/Library/LaunchAgents/dev.goalnight.watcher.plist" ] \
  && cp "$HOME/Library/LaunchAgents/dev.goalnight.watcher.plist" \
        "$BACKUP_DIR/dev.goalnight.watcher.plist"

ok "snapshot complete (watcher_was_loaded=$WATCHER_WAS_LOADED)"

# --- restore (EXIT trap) ----------------------------------------------------
restore() {
  RC=$?
  printf '\n'
  say "Restoring pre-test state from $BACKUP_DIR"

  # Unload whatever watcher our install left running so we can swap the plist.
  launchctl unload "$HOME/Library/LaunchAgents/dev.goalnight.watcher.plist" \
    2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/dev.goalnight.watcher.plist" \
    2>/dev/null || true

  # Wipe artifacts the test run created.
  rm -rf "$HOME/.codex/plugins/cache/goalnight"     2>/dev/null || true
  rm -rf "$HOME/.codex/.tmp/marketplaces/goalnight" 2>/dev/null || true
  rm -rf "$HOME/.goalnight"                          2>/dev/null || true

  # Put backups back. Each step is idempotent + best-effort.
  if [ -f "$BACKUP_DIR/config.toml" ]; then
    cp "$BACKUP_DIR/config.toml" "$HOME/.codex/config.toml" \
      || RESTORE_FAILED=1
  fi
  if [ -d "$BACKUP_DIR/cache-goalnight" ]; then
    mkdir -p "$HOME/.codex/plugins/cache"
    cp -R "$BACKUP_DIR/cache-goalnight" "$HOME/.codex/plugins/cache/goalnight" \
      || RESTORE_FAILED=1
  fi
  if [ -d "$BACKUP_DIR/tmp-marketplace-goalnight" ]; then
    mkdir -p "$HOME/.codex/.tmp/marketplaces"
    cp -R "$BACKUP_DIR/tmp-marketplace-goalnight" \
          "$HOME/.codex/.tmp/marketplaces/goalnight" \
      || RESTORE_FAILED=1
  fi
  if [ -d "$BACKUP_DIR/dot-goalnight" ]; then
    cp -R "$BACKUP_DIR/dot-goalnight" "$HOME/.goalnight" \
      || RESTORE_FAILED=1
  fi
  if [ -f "$BACKUP_DIR/dev.goalnight.watcher.plist" ]; then
    cp "$BACKUP_DIR/dev.goalnight.watcher.plist" \
       "$HOME/Library/LaunchAgents/dev.goalnight.watcher.plist" \
      || RESTORE_FAILED=1
    if [ "$WATCHER_WAS_LOADED" = "1" ]; then
      launchctl load \
        "$HOME/Library/LaunchAgents/dev.goalnight.watcher.plist" \
        2>/dev/null || RESTORE_FAILED=1
    fi
  fi

  if [ "$RESTORE_FAILED" = "1" ]; then
    err "Restore reported errors. Backup kept at:"
    err "  $BACKUP_DIR"
    err "Inspect and recover manually (see README)."
  else
    ok "Restore complete. Backup kept at $BACKUP_DIR"
    ok "(safe to 'rm -rf' once you've verified your setup still works)"
  fi

  exit "$RC"
}
trap restore EXIT INT TERM

# --- wipe -------------------------------------------------------------------
say "Wiping goalnight state for a clean install"

codex plugin marketplace remove goalnight 2>/dev/null || true
launchctl unload "$HOME/Library/LaunchAgents/dev.goalnight.watcher.plist" \
  2>/dev/null || true
rm -f  "$HOME/Library/LaunchAgents/dev.goalnight.watcher.plist"
rm -rf "$HOME/.codex/plugins/cache/goalnight"
rm -rf "$HOME/.codex/.tmp/marketplaces/goalnight"
rm -rf "$HOME/.goalnight"

# Strip the goalnight blocks AND features.plugin_hooks from config.toml so
# install.sh has to re-add them. We use python3 because BSD vs GNU sed
# multi-line block deletion is fragile and we need to preserve unrelated
# tables (everything that isn't ours).
if [ -f "$HOME/.codex/config.toml" ]; then
  CFG="$HOME/.codex/config.toml" python3 - <<'PYEOF'
import os
path = os.environ['CFG']
with open(path) as f:
    lines = f.readlines()

out = []
skip = False
current = ''
for line in lines:
    s = line.strip()
    if s.startswith('['):
        current = s
        skip = (
            s.startswith('[marketplaces.goalnight]')
            or s.startswith('[plugins."goalnight@goalnight"]')
            or s.startswith('[hooks.state."goalnight@goalnight:')
        )
        if skip:
            continue
        out.append(line)
        continue
    if skip:
        continue
    # Drop `plugin_hooks = true` only when it lives under [features]. Leaving
    # the [features] header in place exercises install.sh's "insert into
    # existing [features]" branch.
    if current == '[features]':
        stripped = line.lstrip()
        if (stripped.startswith('plugin_hooks')
                and '=' in stripped
                and 'true' in stripped.split('=', 1)[1]):
            continue
    out.append(line)

with open(path, 'w') as f:
    f.writelines(out)
PYEOF
fi

ok "Wipe complete"

# --- run install ------------------------------------------------------------
say "Running install.sh from $INSTALL_SH"
sh "$INSTALL_SH"
ok "install.sh exited 0"

# --- assertions -------------------------------------------------------------
say "Running post-install assertions"

CFG="$HOME/.codex/config.toml"

# 1. marketplace registered
grep -q '^\[marketplaces\.goalnight\]' "$CFG" \
  || fail 1 "assertion 1: [marketplaces.goalnight] missing from $CFG"
ok "1/8 marketplace registered"

# 2. plugin block exists AND enabled = true sits inside it
awk '
  /^\[plugins\."goalnight@goalnight"\]/ { in_block = 1; seen = 1; next }
  /^\[/                                  { in_block = 0 }
  in_block && /^[[:space:]]*enabled[[:space:]]*=[[:space:]]*true/ { ok = 1 }
  END { exit !(seen && ok) }
' "$CFG" \
  || fail 2 "assertion 2: [plugins.\"goalnight@goalnight\"] missing or enabled != true"
ok "2/8 [plugins.\"goalnight@goalnight\"] enabled = true"

# 3. plugin_hooks = true is inside [features] (not under any later table — this
#    is the bug that bit us during internal testing)
CFG="$CFG" python3 - <<'PYEOF'
import os, sys
path = os.environ['CFG']
current = ''
found = False
under_features = False
wrong = None
for line in open(path):
    s = line.strip()
    if s.startswith('['):
        current = s
        continue
    stripped = line.lstrip()
    if (stripped.startswith('plugin_hooks')
            and '=' in stripped
            and 'true' in stripped.split('=', 1)[1]):
        found = True
        if current == '[features]':
            under_features = True
        else:
            wrong = current
        break
if not found:
    sys.stderr.write("assertion 3: plugin_hooks = true not found\n")
    sys.exit(3)
if not under_features:
    sys.stderr.write(
        f"assertion 3: plugin_hooks = true is under {wrong!r}, not [features]\n"
    )
    sys.exit(4)
PYEOF
ok "3/8 plugin_hooks = true sits inside [features]"

# 4. plugin staged to cache (look for the .codex-plugin marker)
find "$HOME/.codex/plugins/cache/goalnight" -name '.codex-plugin' -type d \
    2>/dev/null | grep -q . \
  || fail 5 "assertion 4: plugin not staged (no .codex-plugin/ under ~/.codex/plugins/cache/goalnight)"
ok "4/8 plugin staged in cache"

# 5. better-sqlite3 native module installed (proxy for `npm install` success)
find "$HOME/.codex/plugins/cache/goalnight" \
     -path '*/node_modules/better-sqlite3' -type d 2>/dev/null | grep -q . \
  || fail 6 "assertion 5: better-sqlite3 missing — npm install probably failed"
ok "5/8 better-sqlite3 installed (npm install worked)"

# 6. codex mcp list shows goalnight as enabled
codex mcp list 2>&1 | grep -qE '^goalnight[[:space:]]' \
  || fail 7 "assertion 6: 'codex mcp list' does not show goalnight"
ok "6/8 codex mcp list shows goalnight"

# 7. launchd watcher loaded
launchctl list 2>&1 | grep -q 'dev\.goalnight\.watcher' \
  || fail 8 "assertion 7: launchd watcher not loaded"
ok "7/8 launchd watcher loaded"

# 8. watcher actually started and wrote its first log line. Give it a moment —
#    daemon.js prints 'starting watcher' as its first action in main(), so a
#    3s sleep is comfortably enough on a developer machine.
sleep 3
[ -f "$HOME/.goalnight/watcher.log" ] \
  || fail 9 "assertion 8: ~/.goalnight/watcher.log missing — watcher never started"
grep -q 'starting watcher' "$HOME/.goalnight/watcher.log" \
  || fail 10 "assertion 8: watcher.log lacks 'starting watcher' line"
ok "8/8 watcher running, log shows 'starting watcher'"

printf '\n'
ok "ALL 8 INSTALL ASSERTIONS PASSED"
ok "(restore will run on EXIT — your previous state will be put back)"

exit 0
