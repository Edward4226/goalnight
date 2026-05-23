# clean-install.sh — install-path validator

Wipes goalnight off your machine, runs the in-tree `install.sh` from a clean
slate, asserts every post-install invariant, then puts your previous state
back. The release manager runs this before every release; you should run it
locally any time you touch `install.sh`.

## When to run

- Before cutting a release.
- After any change to `prototype/install.sh`.
- After any change to the plugin layout (`.codex-plugin/`, `package.json`,
  `server/watcher/launchd.plist`, `.mcp.json`) — those things change the
  invariants this script checks.

## Prerequisites

- macOS (v0.1 only — Linux is untested).
- The codex CLI on `PATH` (`npm install -g @openai/codex`).
- `node` and `npm` on `PATH` (Node 18+).
- `python3` on `PATH` (used for TOML surgery — sed multi-line block deletion
  differs between BSD and GNU).
- `launchctl` (built into macOS).
- No `sudo` / root required.

## How to run

```sh
sh prototype/test/install/clean-install.sh
```

The script tests `install.sh` from your **local checkout**, not from
GitHub — that's the whole point. It will not `curl | sh`.

## What it checks

The script asserts eight post-install invariants. Each maps to a distinct
non-zero exit code so failures are easy to triage:

| Exit | Assertion                                                                                 |
|------|-------------------------------------------------------------------------------------------|
| 1    | `[marketplaces.goalnight]` present in `~/.codex/config.toml`                              |
| 2    | `[plugins."goalnight@goalnight"]` block exists with `enabled = true` inside it            |
| 3    | `plugin_hooks = true` exists somewhere in `config.toml`                                   |
| 4    | `plugin_hooks = true` sits **inside `[features]`** (not under any later table)            |
| 5    | Plugin staged into `~/.codex/plugins/cache/goalnight/` (`.codex-plugin/` marker present)  |
| 6    | `better-sqlite3` present under the staged plugin's `node_modules/` (npm install worked)   |
| 7    | `codex mcp list` shows a `goalnight` row                                                  |
| 8    | launchd watcher loaded (`dev.goalnight.watcher` in `launchctl list`)                      |
| 9    | `~/.goalnight/watcher.log` exists (watcher actually started)                              |
| 10   | `~/.goalnight/watcher.log` contains the `starting watcher` line                           |

(Exit codes 100–102 are precheck failures: not on macOS, missing dependency,
missing `install.sh`. They mean the script never got far enough to test
anything.)

Exit `0` means every assertion passed and your install path is healthy.

## The three install.sh bugs this guards against

These three bugs all shipped in `install.sh` during internal testing. Each
assertion above exists to catch a regression of one of them:

1. **Non-existent `codex plugin add` subcommand.** install.sh used to call
   `codex plugin add` after `marketplace add`. That subcommand doesn't exist
   in codex 0.130.0 — the install would fail loudly. The current script
   stages the plugin manually. Assertions 4 (cache exists) and 7 (mcp list)
   catch a regression of this.
2. **Wrong stage path.** install.sh assumed `marketplace add` placed the
   plugin somewhere other than `~/.codex/.tmp/marketplaces/goalnight/plugins/goalnight/`.
   Wrong path = silent no-op = nothing actually installed. Assertion 4
   catches this.
3. **`plugin_hooks = true` under the wrong TOML table.** A naive
   `printf >> config.toml` lands at file end and attaches to whatever
   `[section]` happened to be open there. We watched this land under
   `[plugins."goalnight@goalnight"]` (where it does nothing) instead of
   `[features]` (where it gates hooks). Assertion 4 catches this — it walks
   the file and verifies the *current table* when it sees the line.

## Backup / restore guarantee

The script snapshots your existing state **before** the wipe and restores it
**after** the assertions (on success **or** failure — via an `EXIT`/`INT`/`TERM`
trap). The snapshot directory is:

```
${TMPDIR:-/tmp}/goalnight-clean-install-backup-<timestamp>/
```

It contains whichever of these existed pre-test:

- `config.toml`
- `cache-goalnight/`           ← copy of `~/.codex/plugins/cache/goalnight/`
- `tmp-marketplace-goalnight/` ← copy of `~/.codex/.tmp/marketplaces/goalnight/`
- `dot-goalnight/`             ← copy of `~/.goalnight/`
- `dev.goalnight.watcher.plist`
- `watcher_was_loaded`         ← `0` or `1` (drives whether restore re-loads launchctl)

Restore is idempotent — safe to run twice — and uses the same wipe-then-put-back
shape on every code path.

The backup directory is **not** auto-deleted. Once you've confirmed your
install still works, `rm -rf` the backup yourself.

## What to do on failure

**An assertion failed (exit 1–10).** The error line tells you which one. Read
the relevant section of `install.sh` (or the plugin file it depends on) and
fix the root cause. Don't paper over it in the test — the test is the contract.

**A precheck failed (exit 100–102).** Install the missing dependency and re-run.

**The script crashed mid-run.** The trap still ran restore — your previous
state should be back. If you're not sure, check `~/.codex/config.toml` and
`launchctl list | grep goalnight` against what you expect.

**Restore itself failed.** The script prints
`Restore reported errors. Backup kept at: <path>` and exits. Manual recovery:

```sh
BACKUP=/tmp/goalnight-clean-install-backup-<timestamp>

# config.toml
cp "$BACKUP/config.toml" ~/.codex/config.toml

# plugin cache
rm -rf ~/.codex/plugins/cache/goalnight
cp -R "$BACKUP/cache-goalnight" ~/.codex/plugins/cache/goalnight

# marketplace clone
rm -rf ~/.codex/.tmp/marketplaces/goalnight
cp -R "$BACKUP/tmp-marketplace-goalnight" ~/.codex/.tmp/marketplaces/goalnight

# ~/.goalnight (db + logs)
rm -rf ~/.goalnight
cp -R "$BACKUP/dot-goalnight" ~/.goalnight

# launchd plist (only re-load if watcher_was_loaded == 1)
launchctl unload ~/Library/LaunchAgents/dev.goalnight.watcher.plist 2>/dev/null
cp "$BACKUP/dev.goalnight.watcher.plist" \
   ~/Library/LaunchAgents/dev.goalnight.watcher.plist
[ "$(cat $BACKUP/watcher_was_loaded)" = "1" ] \
  && launchctl load ~/Library/LaunchAgents/dev.goalnight.watcher.plist
```

## Known limitations

- macOS only. Assertion 7 (`launchctl list`) and assertion 8 (watcher.log)
  are inherently macOS — Linux would need systemd equivalents and is out of
  scope for v0.1.
- Does not exercise the `curl … | sh` GitHub path — that's a separate concern
  (network reachability, raw.githubusercontent.com TLS, etc.) and would test
  the wrong artifact for development.
- Assertion 6 grep against `codex mcp list` is loose (`^goalnight\s`) because
  column widths shift between codex versions; it does not verify the `Status`
  column says `enabled`.
