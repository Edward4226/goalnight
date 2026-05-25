# goalnight — Roadmap

> Living document. Reorders happen as alpha feedback comes in. Dates omitted on purpose — this is a side project, and we'd rather under-promise than miss.

---

## Where we are

**v0.1.2** is the current public release (2026-05-24). See [CHANGELOG.md](../CHANGELOG.md) for the full per-version history.

Today's product surface:
- 5 MCP tools (`gn_plan_night`, `gn_status`, `gn_log_finding`, `gn_log_decision`, `gn_morning_brief`)
- 3 hooks (session start / post tool use / stop) with state-transition detection + transitions notifications
- macOS launchd watcher daemon for cross-quota auto-resume (dry-run default — opt in via `GOALNIGHT_WATCHER_RESUME=1`)
- localhost dashboard with live SSE
- Token Waste Receipt (shareable morning artifact)
- Morning brief — markdown + styled HTML + receipt
- Quiet hours, uncertain decisions in brief, context preservation across resume
- 101 automated tests + install path validator + release checklist

## v0.3 — in flight

Three parallel workers are building this batch (branches `feat/settings`, `feat/preflight-composer`, `feat/halted-flow`):

- **Settings page** (`/settings`) — persisted user defaults: presets (`short` / `long_night` / `open_ended`), branch strategy, ambiguous-decision policy, scope policy, halt policy, wake triggers, quiet hours. Backed by `gn_settings_get` / `gn_settings_set` MCP tools. New defaults reflect P95 real usage (Long Night = 7h / 350k tokens).
- **Pre-flight Plan Preview** — `gn_plan_night({preview: true})` returns a structured plan without burning model tokens. New `/new` composer + `/new/preview` review page; user edits milestones inline, then clicks **Start the overnight run →** to commit.
- **Halted flow** — when the agent halts overnight, user wakes to `/s/:id/halt` summary + 4 forked sub-pages: **walk** (conversation + failing test pane), **resume** (single hint textarea), **discard** (typed confirmation), **log** (filterable timeline). `gn_halt` MCP tool; `stop` hook reads `settings.halt_policy` to detect halt automatically.
- CLI banner — 5-line ASCII owl on bare `gn` invocation.

## v0.4 — candidate features

Ordered by likely sequence. Will reshuffle based on alpha feedback.

- **Stuck Decision page** — Claude Design's v5 `stuck.html`: focused single-decision page that interrupts the dashboard. Detects stuck loops (same milestone, no token reduction for >30m) and fires a critical notification.
- **Cross-Session Memory** — `gn_log_learning(key, value, scope)` MCP tool + `learnings` table. The `session_start` recap extends to inject relevant learnings into the next session. Surfaces in Settings page as editable list.
- **Repo hygiene** — GitHub Actions CI, CONTRIBUTING.md, SECURITY.md, issue / PR templates, README badges. Pre-alpha must-have.
- **`gn` CLI session controls** — `gn run`, `gn pause`, `gn resume`, `gn brief --tail` for terminal-only users.

## v0.5 — candidate, scope-dependent

- **Mid-flight Steering** — pause / inject prompt / skip milestone, surfaced in the dashboard. Currently the halt flow covers ~70% of this use case; we'll see what alpha tells us.
- **Audit Timeline tab** — reverse-chronological event stream on the dashboard. Halt's `log` sub-page already implements a session-scoped version; this generalizes it.
- **PR-Draft Generator** — produces a `pr-draft.md` alongside the morning brief: TL;DR + bullet changes + risk notes + suggested reviewer focus.
- **Token Waste Receipt v2** — receipt rates pulled from `gn_settings`, not hard-coded.

## v1.0 — direction, not commitment

- **Cross-platform watcher** — Linux `systemd` user unit + Windows scheduled task. Currently macOS-only.
- **Codex marketplace listing** — official plugin marketplace submission, once codex has stable public submission paths.
- **`npm` registry publish** — alternative install distribution beyond `curl | sh`.
- **API stability commitment** — SemVer guarantees on the MCP tool surface + the dashboard `/api/*` routes.

## Out of scope (for now)

- Web app / hosted SaaS version. goalnight is intentionally local-first.
- Multi-user / team workspaces.
- Mobile app distribution. Lock-screen notifications are interesting but app-store friction is too high right now.
- Integration with non-codex coding agents. We may revisit when codex's MCP spec stabilizes and the architecture is portable.
- Telemetry / usage analytics. We'd need a clear opt-in story before any data leaves the user's machine.

---

## How priorities move

This roadmap reorders when:
- Alpha users surface a real frustration we hadn't planned for
- A v0.3 feature ships and reveals it solves more than we thought (deprioritizing a follow-up)
- A codex CLI update changes what's necessary (e.g. fixes the v0.130 `thread_goals` issue, retires the `plugin_hooks` flag, etc.)

If a feature listed here matters to you, file an issue with your use case — it directly informs ordering.
