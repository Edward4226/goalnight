/**
 * gn_log_decision — record a decision the model is making on the user's behalf.
 *
 * This is the killer feature: instead of asking the (sleeping) user, the model
 * records the question, the options, its recommendation, and its reasoning —
 * then proceeds with the recommended choice. The user reviews these in the
 * morning brief and can override later.
 */

import { getDb, uuid, now } from '../db/client.js';
import { notify } from '../notifications/index.js';

export const logDecisionSchema = {
  description: `Log a decision point that normally would require the user's call.

When you would otherwise ask the user "should I do A or B?", but the user is asleep:
  1. Pick the better option (use 'recommendation')
  2. Note why ('reasoning', 1-3 sentences)
  3. Call this tool to record it
  4. Continue with your recommendation

Good moments to call:
  - Picking between two valid library/API choices with real tradeoffs
  - Schema design choices affecting rollout strategy
  - Whether to skip a flaky test or spend time fixing
  - Whether to add a feature flag

Do NOT use for trivial choices or things you can decide with high confidence.
Aim for 1-3 decisions per overnight goal — anything more means you're overusing it.`,
  inputSchema: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: 'The decision as a single clear question. Phrase as the user would ask it.',
      },
      options: {
        type: 'array',
        items: { type: 'string' },
        description: 'The choices considered (typically 2-3).',
      },
      recommendation: {
        type: 'string',
        description: 'Your recommended choice (which you will proceed with).',
      },
      reasoning: {
        type: 'string',
        description: 'Why you recommend this (1-3 sentences).',
      },
      blocking: {
        type: 'boolean',
        description: 'If true, this blocks further progress until user resolves it.',
        default: false,
      },
    },
    required: ['question'],
  },
};

export async function logDecision(args) {
  if (!args.question) throw new Error('question is required');

  const db = getDb();
  const session = db
    .prepare('SELECT id FROM sessions ORDER BY updated_at DESC LIMIT 1')
    .get();
  if (!session) {
    throw new Error('No active session. Call gn_plan_night first.');
  }

  const id = uuid();
  const ts = now();
  db.prepare(
    `INSERT INTO decisions
       (id, session_id, question, options, recommendation, reasoning, blocking, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    session.id,
    args.question,
    args.options ? JSON.stringify(args.options) : null,
    args.recommendation ?? null,
    args.reasoning ?? null,
    args.blocking ? 1 : 0,
    ts
  );

  if (args.blocking) {
    notify({
      type: 'blocking-decision',
      title: 'Decision needs your call',
      body: args.question.slice(0, 120),
      sound: true,
    });
  }

  return {
    id,
    session_id: session.id,
    resolved: false,
    will_appear_in_brief: true,
    note: 'Proceed with your recommendation. The user will see this in the morning brief.',
  };
}
