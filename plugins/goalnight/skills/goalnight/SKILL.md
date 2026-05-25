---
name: goalnight
description: Plan and run an overnight goal session — calculate sleep-aware token budget, persist milestones to survive context compaction, log decisions/findings, and produce a morning brief. Use when the user mentions "goalnight", "overnight", "let it run while I sleep", "N hours to <goal>", or runs the `gn` / `@goalnight` commands.
---

# goalnight Skill

You have access to the **goalnight** plugin: a thin layer that makes Codex `/goal` mode usable across an overnight run. It persists progress in its own SQLite database, immune to codex context compaction.

## When to activate this skill

- User mentions: "goalnight", "overnight goal", "set a goal for N hours", "let it run while I sleep", "gn brief", "gn status"
- User explicitly wants a long unattended task
- A previous goalnight session is active (calling `gn_status` returns `state` other than `'none'`)

## Your 5 tools

| Tool | When to call |
|---|---|
| `gn_plan_night` | Exactly ONCE at the start of an overnight goal |
| `gn_status` | Whenever you need to re-orient (post-compaction, post-resume, after long gap) |
| `gn_log_finding` | When you discover something the user would want to know |
| `gn_log_decision` | When you would normally ask the user but they're asleep |
| `gn_morning_brief` | When the user asks "what happened overnight" / runs `gn brief` |

## The overnight flow

### Phase 1: User goes to bed

User says something like `goalnight 8h, implement user-profile feature` or `@goalnight plan 8h to <goal>`.

1. **First, break the goal into 3-8 ordered milestones in your head.** Plan thoughtfully — these get persisted and will guide your work all night.
2. **For each milestone, decide if it's externally checkable.** A milestone is checkable when "is it done?" can be answered by a short shell command — file exists, test passes, commit landed, build green. If yes, attach a `verify` command (see below). If the milestone is research-y / abstract ("understand the X module"), leave verify off.
3. **If the user mentions wanting quiet hours, a do-not-disturb window, or "don't wake me up"** (e.g. "quiet hours 22:00-07:00", "don't ping me overnight"), extract a `quiet_hours` argument in `"HH:MM-HH:MM"` 24-hour format. Omit if not stated. Non-critical notifications inside the window are suppressed and surface in the morning brief instead.
4. Call `gn_plan_night({ objective, hours, milestones: [...], quiet_hours? })`.
5. The response has a `codex_goal_command` field. **Execute it** — this hands the objective to codex's native `/goal` system.
6. Reply to the user in ONE LINE: `Planned. {N} milestones. Budget: {tokens} tokens. Dashboard: {url}. Good night.`
7. Stop. The user closes the laptop.

#### Milestone shape — strings or `{title, verify}` objects

Each milestone in the array is either a plain string (legacy, no verification) or `{ title: "...", verify: "..." }`. Mix freely. Example:

```json
{
  "milestones": [
    "research the existing auth module",
    { "title": "scaffold the new login route", "verify": "test -f src/routes/login.ts" },
    { "title": "tests pass", "verify": "npm test" },
    { "title": "commit landed", "verify": "git log -1 --grep=feat/login" }
  ]
}
```

**Verify command rules** — failing fast at plan time, so get them right:

- Must start with one of: `gh `, `git `, `test `, `npm ` (trailing space matters)
- No shell metacharacters: `|`, `&`, `;`, `<`, `>`, `$`, backtick, parens, newlines — pipes/redirects are not supported
- Exit 0 = verified · non-zero = failed · timeout / spawn-error = unknown
- 10s timeout, no shell expansion (so no `$HOME`, `~`, or globs — use literal paths)

The morning brief will surface any "claimed done but verify failed" milestones at the top — these are the model's false-positive completions. Skip verify for fuzzy/research milestones where no command can adjudicate.

### Phase 2: During execution (every continuation turn)

Codex auto-continues the goal turn by turn. On each turn:

1. **If this turn follows a long gap, context compaction, or a resume:** call `gn_status()` first. The DB is your ground truth, not your conversation memory.
2. Work on the current milestone (the first one with `state != 'done'`).
3. When you finish a real milestone (not a sub-step), the post_tool_use hook will eventually mark it done. You don't need to explicitly mark it — but you can if you're confident.
4. **When you discover something noteworthy** (existing implementation in repo, hidden bug, prod risk, weird convention): call `gn_log_finding({ type, content, severity })`. Aim for 0-5 findings per session.
5. **When you would otherwise ask the user but they're asleep**: call `gn_log_decision({ question, options, recommendation, reasoning })` then proceed with your recommendation. Aim for 1-3 decisions per session.

#### `gn_log_decision` urgency flags

- **`blocking=true`** — you would REFUSE to proceed without an answer. Surfaces in the brief's "Decisions waiting" section and fires a sound notification. Use sparingly: schema/destructive-data calls, irreversible architectural forks.
- **`uncertain=true`** — you DID proceed, but flag the call for human review. Surfaces in the brief's separate "Decisions you might want to review" section. No notification (quiet by design). Use whenever you make a judgment call you can imagine the user disagreeing with: library choice, naming, file placement, minor architectural fork.
- **Neither flag** — confident, routine choice. Still logged for audit but de-emphasized.
- **Don't set both** — `blocking` implies more urgency and wins; the row will be persisted as blocking only.

### Phase 3: User wakes up

User says `gn brief` / "what happened?" / "@goalnight brief":

1. Call `gn_morning_brief()`.
2. Return the `markdown` field verbatim. It's already structured for low-judgement-load reading.
3. If `decisions_awaiting` is non-empty, gently emphasize those — they're what the user actually needs to act on.

## Critical rules

- **DO NOT** call `gn_plan_night` more than once per session.
- **DO NOT** log routine progress as findings. Reserve findings for things the user would actually want to know.
- **DO NOT** log trivial choices as decisions. Reserve for real tradeoffs.
- **DO NOT** stop progress when you hit a decision. Log it, recommend, proceed.
- **DO** call `gn_status` after any context compaction or long gap, BEFORE continuing work.
- **DO** trust the SQLite state over your memory of progress.

## Mental model

```
codex /goal     ← does continuation, budget accounting, audit (you don't replace this)
   ↑
goalnight       ← adds: sleep budget · decision queue · morning brief · dashboard
```

You wrap codex `/goal`; you don't replace it. The tools above are your only interface to goalnight state. The dashboard at `http://localhost:8888` is for the user, not you.

When in doubt: log liberally, decide confidently, keep moving toward the requested end state.
