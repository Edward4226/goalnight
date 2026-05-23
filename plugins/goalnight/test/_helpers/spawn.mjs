/**
 * Spawn / network helpers shared by integration tests. Dependency-free —
 * Node 18+ has node:child_process, node:net, and a global fetch.
 */

import { spawn } from 'node:child_process';
import { connect, createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

/** Spawn a child + accumulate stdout/stderr; returns proc + live getters + exit promise. */
export function spawnAsync(cmd, args, opts = {}) {
  const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  const buf = { stdout: '', stderr: '' };
  proc.stdout.on('data', (d) => { buf.stdout += d.toString(); });
  proc.stderr.on('data', (d) => { buf.stderr += d.toString(); });
  const exit = new Promise((resolve) => proc.on('exit', (code, signal) => resolve({ code, signal })));
  return {
    proc,
    get stdout() { return buf.stdout; },
    get stderr() { return buf.stderr; },
    exit,
  };
}

/** SIGTERM, escalate to SIGKILL after ms; resolves once the process has exited. */
export async function withTimeoutKill(proc, ms = 1500) {
  if (proc.exitCode != null || proc.signalCode != null) return;
  proc.kill('SIGTERM');
  let exited = false;
  const onExit = new Promise((resolve) => proc.once('exit', () => { exited = true; resolve(); }));
  await Promise.race([onExit, delay(ms)]);
  if (!exited) {
    try { proc.kill('SIGKILL'); } catch { /* already gone */ }
    await onExit;
  }
}

/** Poll a TCP port until it accepts a connection, or throw on timeout. */
export async function waitForPort(port, hostname = '127.0.0.1', timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await tryConnect(port, hostname)) return true;
    await delay(50);
  }
  throw new Error(`waitForPort: ${hostname}:${port} not listening after ${timeoutMs}ms`);
}

function tryConnect(port, hostname) {
  return new Promise((resolve) => {
    const sock = connect({ port, host: hostname });
    let done = false;
    const finish = (ok) => { if (done) return; done = true; sock.destroy(); resolve(ok); };
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
    sock.setTimeout(500, () => finish(false));
  });
}

/** fetch + JSON + timeout. Throws on non-2xx so callers can assert positively. */
export async function fetchJson(url, opts = {}) {
  const { timeoutMs = 3000, ...rest } = opts;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, ...rest });
    if (!res.ok) throw new Error(`fetchJson ${url} → ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/** Bind a random ephemeral port, close, return the number — avoids "in use" flakes. */
export async function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}
