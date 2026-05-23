/**
 * Watcher daemon integration smoke.
 *
 * Two checks:
 *   1. Boot the watcher in dry-run with no session: confirm it logs the
 *      startup banner, runs at least one tick, and exits cleanly on SIGTERM.
 *   2. Drive server/codex/state_parser.js directly with HOME pointed at an
 *      empty dir — confirm both exported readers degrade to null instead of
 *      throwing, which is what keeps the watcher alive on a fresh install.
 *
 * Note: the daemon's log() helper writes to stdout (console.log), not stderr,
 * so we match against the merged stream rather than `proc.stderr`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { withTimeoutKill } from '../_helpers/spawn.mjs';
import { cleanupFixtureDir } from '../_helpers/fixture-db.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..', '..');
const DAEMON_ENTRY = join(PLUGIN_ROOT, 'server', 'watcher', 'daemon.js');
const STATE_PARSER_ENTRY = join(PLUGIN_ROOT, 'server', 'codex', 'state_parser.js');

test('watcher dry-run boots, ticks at least once, and exits cleanly', async () => {
  const dataDir = `/tmp/goalnight-it-watcher-${Date.now()}-${process.pid}`;
  mkdirSync(dataDir, { recursive: true });
  try {
    const proc = spawn(process.execPath, [DAEMON_ENTRY], {
      cwd: PLUGIN_ROOT,
      env: {
        ...process.env,
        GOALNIGHT_DATA: dataDir,
        // Shrink the poll interval so we observe at least 2 ticks in our short
        // window — default is 60s.
        GOALNIGHT_WATCHER_POLL_MS: '200',
        // Force dry-run + isolate from any real ~/.codex on this machine.
        HOME: dataDir,
        delete: undefined,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Explicitly do NOT set GOALNIGHT_WATCHER_RESUME → dry-run default applies.
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    await delay(1500);
    await withTimeoutKill(proc, 1500);

    const combined = stdout + stderr;
    assert.match(combined, /starting watcher/, 'expected startup banner');
    assert.match(combined, /dry_run=true/, 'expected dry-run flag in banner');
    assert.match(combined, /tick session=none/, 'expected at least one empty-session tick');
    // SIGTERM should make the process exit, not a non-zero crash on its own
    // logic. We accept null (signal exit) or 0.
    const exited = proc.exitCode === 0 || proc.exitCode === null;
    assert.ok(exited, `daemon exited with code ${proc.exitCode}`);
  } finally {
    cleanupFixtureDir(dataDir);
  }
});

test('state_parser returns null when no codex DB is available', async () => {
  // Run the assertions in a child process whose HOME points at an empty dir
  // so CODEX_DIR resolves to a non-existent path. This stays hermetic even
  // when the developer running the tests has a real ~/.codex.
  const isolatedHome = `/tmp/goalnight-it-statep-${Date.now()}-${process.pid}`;
  mkdirSync(isolatedHome, { recursive: true });
  try {
    const script = `
      import { findActiveCodexThread, readCodexThreadState } from ${JSON.stringify(STATE_PARSER_ENTRY)};
      const a = findActiveCodexThread();
      const b = readCodexThreadState('nonexistent-thread');
      const c = readCodexThreadState(null);
      process.stdout.write(JSON.stringify({ a, b, c }));
    `;
    const proc = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: PLUGIN_ROOT,
      env: { ...process.env, HOME: isolatedHome },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { err += d.toString(); });
    const exit = await new Promise((resolve) => proc.on('exit', resolve));
    assert.equal(exit, 0, `state_parser child failed: ${err}`);
    const parsed = JSON.parse(out);
    assert.equal(parsed.a, null, 'findActiveCodexThread should return null');
    assert.equal(parsed.b, null, 'readCodexThreadState(unknown) should return null');
    assert.equal(parsed.c, null, 'readCodexThreadState(null) should return null');
  } finally {
    cleanupFixtureDir(isolatedHome);
  }
});
