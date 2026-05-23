/**
 * gn_log_finding — record an observation worth surfacing in the morning brief.
 *
 * Reserve for things the user would actually want to know about.
 * Routine progress goes into turn_log via hooks, not here.
 */

import { getDb, uuid, now } from '../db/client.js';

export const logFindingSchema = {
  description: `Log a meaningful observation made during goal execution.

Use for things the user would want to know about in the morning:
  - 'insight': an existing implementation you discovered (e.g. legacy User model already exists)
  - 'warning': risk worth noting (e.g. migration will lock table 3s on prod)
  - 'bug': existing bug uncovered during the work
  - 'note': context that affects later decisions

Do NOT use for routine progress, status changes, or normal step completion.
Aim for 0-5 findings per goal session.`,
  inputSchema: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['insight', 'warning', 'bug', 'note'] },
      content: {
        type: 'string',
        description: 'One-sentence description of the finding.',
      },
      context_files: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional file paths the finding relates to.',
      },
      severity: {
        type: 'string',
        enum: ['low', 'medium', 'high'],
        description: 'Optional severity. Default low.',
      },
    },
    required: ['type', 'content'],
  },
};

export async function logFinding(args) {
  if (!args.type || !args.content) {
    throw new Error('type and content are required');
  }

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
    `INSERT INTO findings (id, session_id, type, severity, content, context_files, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    session.id,
    args.type,
    args.severity ?? 'low',
    args.content,
    args.context_files ? JSON.stringify(args.context_files) : null,
    ts
  );

  return { id, logged_at: ts, session_id: session.id };
}
