# 🌙 goalnight

> **set a goal, go to bed, wake up to a PR.**

*(dashboard screenshot — coming with v0.1)*

Codex `/goal` is great. But when it hits your 5h token quota, it just stops.
You sleep 8h. Your tokens refresh at hour 5. They sit there. They expire.

**goalnight** is an open-source Codex plugin that:

- 🌙 calculates how much token budget your sleep can afford
- 🔄 auto-resumes when quota refreshes (across multiple 5h periods)
- 📢 wakes you with a notification only when something actually needs you
- ☀️ shows you a morning brief: what shipped, what's blocked, what needs your call
- 📊 displays a cozy localhost dashboard so you can peek any time

---

## Why this exists

OpenAI sells subscriptions. Their incentive isn't to help you drain them. Like a gym: the less you show up, the better the unit economics.

So official `/goal` doesn't go out of its way to squeeze your quota dry. The engineering is solid, but a few things they *structurally* won't do:

- they won't compute how much token budget your sleep window can afford
- they won't relight the task the second your quota refreshes at 3am
- they won't hand you a morning brief that's actually three seconds to read

You already paid for the tokens. There's no good reason 3 of your 8 sleeping hours should be quota evaporating into the dark.

That's the gap goalnight fills.

---

## Install

```bash
codex plugin marketplace add Edward4226/goalnight
codex plugin add goalnight@goalnight
```

Or, one-liner:

```bash
curl -fsSL https://raw.githubusercontent.com/Edward4226/goalnight/main/install.sh | sh
```

The one-liner also enables `plugin_hooks` in `~/.codex/config.toml` and installs the macOS launchd watcher.

---

## Use

Before bed:

```bash
@goalnight plan 8h to implement user-profile feature with tests
```

In the morning:

```bash
@goalnight brief
```

Peek any time at `http://localhost:8888`.

---

## What it does (under the hood)

**🌙 Sleep Budget Algorithm.** Converts your sleep window into a token budget and a milestone count — so the model knows when to push and when to wrap up.

**🔄 Cross-Period Auto-Resume.** A small launchd watcher polls Codex's usage state. The instant your 5h quota refreshes, it calls `codex resume` and re-injects context. No 3am intervention.

**📢 Pause / Approval Notifications.** macOS desktop notifications fire only on the things that actually need you — blocking decisions, quota hits, approval waits, goal complete. Throttled so a chatty session doesn't spam you.

**☀️ Morning Brief.** `@goalnight brief` (or `gn brief`) renders a one-page summary: what shipped, token spend, decisions waiting, suggested next steps. Designed to read in 30 seconds.

**🤝 Decisions Awaiting.** When the model would normally ask "should I do A or B?", it instead records the question, its recommendation, and its reasoning — then proceeds. You review in the morning brief, override if you disagree.

---

## Requirements

- Codex CLI installed (`npm install -g @openai/codex`)
- Node.js ≥ 18
- macOS (v0.1; Linux/Windows in v0.2)

---

## Status

**v0.1**: pre-alpha. macOS only. Read-only dashboard.

See the roadmap in [docs/ROADMAP.md](docs/ROADMAP.md) for v0.2 (cross-platform notifications, Linux/Windows watchers, dashboard interactions).

---

## Contributing

Bug reports welcome. Feature requests — please skim [docs/positioning.md](docs/positioning.md) first so we can stay aligned on what goalnight is and isn't.

---

## License

License: TBD — pending v0.1 final release.

---

🦉 *Built by someone tired of watching token quotas evaporate overnight.*
