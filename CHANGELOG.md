# Changelog

All notable changes to **goalnight** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

In flight for v0.3.0:

- `gn_settings_get` / `gn_settings_set` — persisted user defaults (presets, branch / scope / halt policies, wake triggers, quiet-hours default). New `/settings` page surfaces them.
- Pre-flight Plan Preview — `gn_plan_night` `preview: true` mode + `gn_plan_finalize` + `gn_plan_discard`. New `/new` composer + `/new/preview` review pages. Breaks the "no rehearsal before commitment" UX gap.
- Halted flow — `gn_halt` MCP tool + 5 morning pages (`/s/:id/halt` + walk / resume / discard / log). stop-hook halt detection. Watcher skips halted sessions.
- CLI boot banner — 5-line ASCII owl (C.2 mini) on bare `gn` invocation.

---

## [0.1.2] — 2026-05-24

**Design system merge + Token Waste Receipt.**

GitHub release: <https://github.com/Edward4226/goalnight/releases/tag/v0.1.2>

### Added
- **🦉 Hoot mascot** — round glasses + code reflections in the lenses ("the eyes are the brand"). 4 SVG sizes: 16px favicon, 24-64px general, ≥128px hero, sleeping owl for empty-state.
- **📜 Token Waste Receipt** — `GET /api/receipt/:session_id` renders a shareable HTML page with real session data (tokens_reclaimed, cost_estimate_usd at Pro/Plus/Team plan rates, milestone / decision / finding line items). Designed to screenshot at 1200×675.
- `gn_morning_brief.receipt_data` field — `headline.{tokens_reclaimed, cost_estimate_usd, plan_used, quota_windows_relit}` + `lines.*` + `foot.{session_short, brand_url}`.
- `templates/receipt-rates.json` — Pro $150/Mtok baseline, Plus $200/Mtok, Team $130/Mtok. `GOALNIGHT_PLAN` env overridable.
- `GET /api/brief?format=html` — morning brief rendered as styled HTML, sibling of the existing markdown / JSON formats.
- 5 SSE fields: `started_at`, `wake_time`, `quota_windows_relit`, `target_paths`, `burn_series` (in-memory 13-sample ring buffer for the sparkline).
- 5 README screenshots: dashboard, morning-brief, og-card, close-decisions, close-quota.

### Changed
- **Palette** shifted cool-blue moonlight (`#011627` / `#FFEB95`) → **warm desk-lamp amber** (`#0d0c0a` / `#F5B23E`). Better at-night eye comfort; better brand fit ("cozy 1am desk" vs "tech-noir moonlight"). CSS var names (`--moon-yellow`, `--bg-base`) kept for backward compat.
- Dashboard `index.html` + `dashboard.js` rewritten against Claude Design's locked frames (≈430 lines of JS, vanilla, SSE contract unchanged).
- Brief and dashboard switched to G5 owl mascot from `🌙` emoji placeholder.

### Fixed
- Receipt URL accepts both full UUID **and** 8+ char prefix (the receipt footer's 8-char `session_short` is now round-trippable as a URL; ambiguous prefixes → 404).
- 0-relit fallback on the receipt: renders `tokens used` (current spend) with `clean run` sub instead of a misleading `tokens reclaimed: 0`.

### Internal
- 101 unit + integration tests (was 87 in v0.1.1, +10 from Worker Hoot + 4 from Worker Vesper). `npm test` still under 3.1s.

---

## [0.1.1] — 2026-05-24

**Overnight context preservation, quiet hours, and an honest brief.**

GitHub release: <https://github.com/Edward4226/goalnight/releases/tag/v0.1.1>

### Added
- **🔄 Context Preservation Across Resume** — `hooks/session_start.js` emits a structured recap (goal, milestones done / current / pending, unresolved decisions, recent findings) on `codex exec resume`. The resumed model picks up where it left off instead of re-exploring. `server/recap/builder.js` is a pure function with explicit `__test__` exports; soft 3000-char budget; sanitizes backticks + collapses newlines (injection-safe).
- **🌙 Quiet Hours** — `gn_plan_night` accepts `quiet_hours: "HH:MM-HH:MM"`. Inside the window non-critical notifications are suppressed and queued into the morning brief. Critical types (system errors, destructive approvals) always fire. Overnight wrap supported (e.g. `22:00-07:00`).
- **🤔 Uncertain Decisions** — `gn_log_decision` accepts `uncertain: true`. Surfaced as a new "Decisions you might want to review" section in the morning brief, distinct from blocking decisions. `blocking` and `uncertain` both true → blocking wins (more urgent).
- `test/install/clean-install.sh` — backup → wipe → install → 8 assertions → restore. Idempotent + safe on dev machines.
- `docs/RELEASE_CHECKLIST.md` — 9-step pre-release hand-walk (private repo).
- README "Limitations (v0.1)" section documenting hooks limitation, dry-run-by-default watcher, single-session model, payload field uncertainty.

### Fixed
- **rowid tiebreaker** — 6 SQL `ORDER BY updated_at DESC LIMIT 1` queries (`status`, `morning_brief`, `log_decision`, `log_finding`, `stop` hook, `post_tool_use` hook) had undefined ordering when two sessions shared `updated_at` ms. Now `ORDER BY updated_at DESC, rowid DESC`.
- **`stop` hook turn_log off-by-one** — state transition is now computed BEFORE the `turn_log` INSERT, so `goal_state_after` reflects the real transition in the same row.
- **`stop` hook payload field name fallback** — `extractNewState()` tries 8 candidate field shapes (`goal_state`, `goalState`, `session_state`, `sessionState`, `thread_state`, `threadState`, bare `state`, plus nested under `thread` / `session` / `goal`). Graceful null fallback.
- `install.sh` — for GitHub-source marketplaces, codex 0.130.0 clones to `~/.codex/.tmp/marketplaces/…/`, not `~/.codex/plugins/cache/…/`. Installer now stages the plugin into the cache after marketplace add.
- `install.sh` — `plugin_hooks = true` now correctly inserted INSIDE the `[features]` block via `awk`, rather than appended to file-end (where it landed under whatever was the active TOML table — usually `[plugins."goalnight@goalnight"]`).
- `install.sh` — removed broken call to `codex plugin add` (subcommand doesn't exist in codex 0.130.0); the marketplace-add + cache-stage flow does the work.
- `gn_plan_night` response: renamed `codex_goal_command` → `codex_goal_command_informational` and rewrote `next_action` to explicitly tell the model NOT to invoke codex's native `/goal` mode (which is broken on codex 0.130.0 — `create_goal` fails with `no such table: thread_goals`).

### Internal
- 71 unit + integration tests via `npm test` (was 38 in v0.1.0). Runtime ~3.1s.

---

## [0.1.0] — 2026-05-23

**Initial release.**

GitHub release: <https://github.com/Edward4226/goalnight/releases/tag/v0.1.0>

### Added
- AGPL-3.0 licensed Codex CLI plugin.
- 5 MCP tools: `gn_plan_night`, `gn_status`, `gn_log_finding`, `gn_log_decision`, `gn_morning_brief`.
- 3 hooks: `session_start`, `post_tool_use`, `stop`.
- macOS `launchd` watcher daemon for cross-quota auto-resume (dry-run by default — opt in via `GOALNIGHT_WATCHER_RESUME=1`).
- macOS desktop notification adapter via `osascript`.
- localhost dashboard with live SSE updates (Night-Owl-derived dark theme).
- SQLite persistence at `~/.goalnight/goalnight.db`.
- `install.sh` one-liner installer (`curl … | sh`).
- 38 unit + integration tests via `npm test`.
- `SKILL.md` for the model to learn the goalnight tool surface.

---

[Unreleased]: https://github.com/Edward4226/goalnight/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/Edward4226/goalnight/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Edward4226/goalnight/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Edward4226/goalnight/releases/tag/v0.1.0
