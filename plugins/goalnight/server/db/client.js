/**
 * SQLite client for goalnight.
 *
 * Stores DB at ~/.goalnight/goalnight.db (or $GOALNIGHT_DATA/goalnight.db if set
 * by the codex plugin runtime via PLUGIN_DATA → GOALNIGHT_DATA).
 *
 * Uses better-sqlite3 (synchronous) — fits our low-concurrency use case
 * and keeps the code simple. No async/await for DB ops.
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function resolveDataDir() {
  if (process.env.GOALNIGHT_DATA) return process.env.GOALNIGHT_DATA;
  return join(homedir(), '.goalnight');
}

function resolveDbPath() {
  return join(resolveDataDir(), 'goalnight.db');
}

let _db = null;

export function getDb() {
  if (_db) return _db;

  const dataDir = resolveDataDir();
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  const dbPath = resolveDbPath();
  const firstTime = !existsSync(dbPath);

  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  if (firstTime) {
    const schemaPath = join(__dirname, 'schema.sql');
    const schema = readFileSync(schemaPath, 'utf8');
    _db.exec(schema);
  }

  return _db;
}

export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// Tiny helpers used by tools.
export function now() {
  return Date.now();
}

export function uuid() {
  // RFC 4122 v4-ish, plenty for local IDs.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
