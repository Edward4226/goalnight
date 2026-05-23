/**
 * macOS desktop notification via `osascript`.
 *
 * v0.1: macOS only. Linux (`notify-send`) and Windows (`BurntToast`) land in v0.2.
 *
 * Design notes:
 *   - Fire-and-forget: detached + unref so callers (MCP tools, hooks) never block.
 *   - Throttled per `type`: same type fires at most once per 10 minutes. Prevents
 *     a flurry of identical popups when the model logs several decisions in a row.
 *   - Never throws. Notification failure must not break the caller's flow.
 *   - JSON.stringify on body/title to escape quotes that would otherwise break the
 *     AppleScript literal.
 */

import { spawn } from 'node:child_process';

const THROTTLE_MS = 10 * 60_000;
const _lastSent = new Map();

export function notify({ title, body, sound = false, type = 'default' }) {
  const now = Date.now();
  const last = _lastSent.get(type);
  if (last && now - last < THROTTLE_MS) return;
  _lastSent.set(type, now);

  if (process.platform !== 'darwin') return;

  const safeBody = JSON.stringify(body ?? '');
  const safeTitle = JSON.stringify(title ?? '');
  const soundClause = sound ? ' sound name "Glass"' : '';
  const script = `display notification ${safeBody} with title "🌙 goalnight" subtitle ${safeTitle}${soundClause}`;

  try {
    spawn('osascript', ['-e', script], {
      detached: true,
      stdio: 'ignore',
    }).unref();
  } catch {
    // swallow — caller's flow must continue
  }
}

// Test hook: reset throttle state (used by manual tests, not production code).
export function _resetThrottle() {
  _lastSent.clear();
}
