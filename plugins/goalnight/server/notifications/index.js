/**
 * Notification module entry point.
 *
 * v0.1: macOS only — wraps macos.js with a per-session quiet-hours gate.
 * v0.2: will branch on process.platform to dispatch to macos / linux / windows.
 *
 * Quiet hours (Feature K):
 *   When the most-recent active session has a quiet_hours window set and the
 *   current local time falls inside it, non-critical notifications are
 *   suppressed. Critical notifications (system failures, destructive-action
 *   approvals — anything where waiting until morning would be wrong) ALWAYS
 *   fire. Suppressed events are not lost: their underlying rows live in the
 *   decisions / findings tables and surface in the morning brief.
 */

import { notify as platformNotify } from './macos.js';
import { getDb } from '../db/client.js';

const CRITICAL_TYPES = new Set([
  'critical',
  // Future expansion: 'destructive-pending', 'system-error' — add here.
]);

export function inQuietHours(window, now = new Date()) {
  const m = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(window ?? '');
  if (!m) return false;
  const [, sh, sm, eh, em] = m.map(Number);
  if (sh > 23 || sm > 59 || eh > 23 || em > 59) return false;
  const startMin = sh * 60 + sm;
  const endMin   = eh * 60 + em;
  const nowMin   = now.getHours() * 60 + now.getMinutes();
  return startMin <= endMin
    ? (nowMin >= startMin && nowMin < endMin)   // same-day window
    : (nowMin >= startMin || nowMin < endMin);  // overnight wrap
}

function currentQuietHoursWindow() {
  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT quiet_hours FROM sessions
      WHERE state IN ('active', 'paused', 'usage_limited', 'planned')
      ORDER BY updated_at DESC, rowid DESC LIMIT 1
    `).get();
    return row?.quiet_hours ?? null;
  } catch {
    return null; // fail-open: DB error must not block notifications
  }
}

export function notify(opts) {
  if (CRITICAL_TYPES.has(opts?.type)) {
    return platformNotify(opts);
  }
  const window = currentQuietHoursWindow();
  if (window && inQuietHours(window)) {
    return; // suppressed — event already lives in its respective table
  }
  return platformNotify(opts);
}
