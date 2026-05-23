/**
 * gn_plan_night — entry tool for an overnight goal session.
 *
 * Called once by the model when the user kicks off an overnight run.
 * Persists session + milestones to SQLite and returns the codex /goal
 * command the agent should execute next.
 *
 * v0.1 budget algorithm (deliberately simple):
 *   token_budget = (hours / 5) * QUOTA_PER_PERIOD * target_quota_pct
 *
 * QUOTA_PER_PERIOD defaults to 200_000 (rough GPT-5.5 5h quota estimate).
 * Override via env: GOALNIGHT_QUOTA_PER_PERIOD=300000
 *
 * Milestone titles come from the model — the SKILL instructs the model to
 * plan them BEFORE calling this tool. We just persist them in order.
 */

import { getDb, uuid, now } from '../db/client.js';

const DEFAULT_QUOTA = parseInt(process.env.GOALNIGHT_QUOTA_PER_PERIOD || '200000', 10);

const QUIET_HOURS_RE = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/;

function validateQuietHours(raw) {
  const m = QUIET_HOURS_RE.exec(raw);
  if (!m) throw new Error('quiet_hours must match "HH:MM-HH:MM" (24h)');
  const [, sh, sm, eh, em] = m.map(Number);
  for (const [h, mm] of [[sh, sm], [eh, em]]) {
    if (h < 0 || h > 23 || mm < 0 || mm > 59) {
      throw new Error('quiet_hours endpoints must be in 00:00–23:59');
    }
  }
}

export const planNightSchema = {
  description: `Plan an overnight goal session and persist it.

Call this exactly ONCE when the user wants to run a goal overnight
(e.g. "8 hours to implement X", "set up a goalnight run for ...").

REQUIREMENT: BEFORE calling this tool, you must already have
broken the goal down into 3-8 ordered milestones in your head and
pass them via the 'milestones' argument. We persist them so they
survive context compaction.`,
  inputSchema: {
    type: 'object',
    properties: {
      objective: {
        type: 'string',
        description: 'The user-supplied goal objective verbatim.',
      },
      hours: {
        type: 'number',
        description: 'Expected runtime in hours (default 8).',
      },
      target_quota_pct: {
        type: 'number',
        description: 'Fraction of available quota to spend (0–1, default 0.8).',
      },
      milestones: {
        type: 'array',
        items: { type: 'string' },
        description: 'Ordered list of milestone titles (3-8 recommended).',
      },
      quiet_hours: {
        type: 'string',
        description: 'Optional local-time window during which non-critical notifications are suppressed. Format: "HH:MM-HH:MM" (24h). Examples: "22:00-07:00" (overnight), "13:00-14:00" (lunch). Notifications outside the window fire normally. Critical notifications (system failures, destructive-action approvals) ALWAYS fire regardless of window.',
      },
    },
    required: ['objective', 'milestones'],
  },
};

export async function planNight(args) {
  const objective = args.objective?.trim();
  const hours = args.hours ?? 8;
  const targetPct = args.target_quota_pct ?? 0.8;
  const milestones = args.milestones ?? [];
  const quietHours = args.quiet_hours ?? null;

  if (!objective) throw new Error('objective is required');
  if (!Array.isArray(milestones) || milestones.length === 0) {
    throw new Error('milestones must contain at least 1 item');
  }
  if (targetPct <= 0 || targetPct > 1) {
    throw new Error('target_quota_pct must be in (0, 1]');
  }
  if (quietHours !== null && quietHours !== undefined) {
    validateQuietHours(quietHours);
  }

  const tokenBudget = Math.round((hours / 5) * DEFAULT_QUOTA * targetPct);
  const tokensPerMilestone = Math.round(tokenBudget / milestones.length);

  const db = getDb();
  // Backward-compat: existing DBs may lack the quiet_hours column. ALTER is
  // idempotent — sqlite throws on duplicate add, which the catch swallows.
  try { db.exec('ALTER TABLE sessions ADD COLUMN quiet_hours TEXT'); } catch {}

  const sessionId = uuid();
  const ts = now();

  const insertSession = db.prepare(`
    INSERT INTO sessions
      (id, objective, hours, target_quota_pct, quiet_hours, token_budget, state, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'planned', ?, ?)
  `);
  insertSession.run(sessionId, objective, hours, targetPct, quietHours, tokenBudget, ts, ts);

  const insertMilestone = db.prepare(`
    INSERT INTO milestones (id, session_id, title, estimated_tokens, ordinal, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertMany = db.transaction(items => {
    items.forEach((title, idx) => {
      insertMilestone.run(uuid(), sessionId, title, tokensPerMilestone, idx + 1, ts);
    });
  });
  insertMany(milestones);

  return {
    session_id: sessionId,
    objective,
    estimated_token_budget: tokenBudget,
    milestones: milestones.map((title, idx) => ({
      ordinal: idx + 1,
      title,
      estimated_tokens: tokensPerMilestone,
    })),
    quota_periods_covered: +(hours / 5).toFixed(2),
    codex_goal_command: `/goal set ${objective} --budget ${tokenBudget}`,
    dashboard_url: `http://localhost:${process.env.GOALNIGHT_PORT || 8888}`,
    next_action:
      'Execute the codex_goal_command above to hand the objective to codex /goal. ' +
      'You can then close your laptop. Open the dashboard URL anytime to peek progress.',
  };
}
