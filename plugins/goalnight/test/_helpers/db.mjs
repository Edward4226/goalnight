/**
 * Per-test isolated DB factory.
 *
 * Each call to freshDb() creates a unique tmp dir, points GOALNIGHT_DATA at it,
 * and resets the db/client.js singleton so the next getDb() call materializes a
 * brand-new SQLite file with a fresh schema. cleanupDb() closes the handle and
 * removes the dir.
 *
 * Tests should also point GOALNIGHT_NOTIFY_LOG at a tmp file to suppress real
 * macOS notifications — see notifyLogPath() below.
 */

import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb } from '../../server/db/client.js';

export function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'goalnight-test-'));
  closeDb();
  process.env.GOALNIGHT_DATA = dir;
  return dir;
}

export function cleanupDb(dir) {
  closeDb();
  delete process.env.GOALNIGHT_DATA;
  if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

export function notifyLogPath(dir) {
  const p = join(dir, 'notify.log');
  process.env.GOALNIGHT_NOTIFY_LOG = p;
  return p;
}

export function readNotifyLog(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

export function clearNotifyLog() {
  delete process.env.GOALNIGHT_NOTIFY_LOG;
}
