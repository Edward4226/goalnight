/**
 * MCP protocol integration smoke.
 *
 * Spawns server/index.js as an MCP stdio server, drives it with line-delimited
 * JSON-RPC the way Codex would, and asserts: initialize → serverInfo.name,
 * tools/list → exactly our 5 tools, tools/call gn_plan_night → session_id +
 * 3 milestones, tools/call unknown → isError.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { withTimeoutKill, pickFreePort } from '../_helpers/spawn.mjs';
import { cleanupFixtureDir } from '../_helpers/fixture-db.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..', '..');
const SERVER_ENTRY = join(PLUGIN_ROOT, 'server', 'index.js');

class JsonRpcClient {
  constructor(proc) {
    this.proc = proc;
    this.nextId = 1;
    this.pending = new Map();
    this.buf = '';
    proc.stdout.on('data', (chunk) => this._onData(chunk));
    proc.stdout.on('error', () => {});
  }
  _onData(chunk) {
    this.buf += chunk.toString();
    let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id == null) continue; // notification — not awaited
      const entry = this.pending.get(msg.id);
      if (!entry) continue;
      this.pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(`JSON-RPC error: ${JSON.stringify(msg.error)}`));
      else entry.resolve(msg.result);
    }
  }
  async request(method, params, { timeoutMs = 4000 } = {}) {
    const id = this.nextId++;
    const wait = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const t = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`JSON-RPC timeout: ${method} (${timeoutMs}ms)`));
      }, timeoutMs);
      t.unref?.();
    });
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return wait;
  }
  notify(method, params) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }
}

let proc, client, dataDir;

before(async () => {
  dataDir = `/tmp/goalnight-it-mcp-${Date.now()}-${process.pid}`;
  const dashPort = await pickFreePort();
  proc = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: PLUGIN_ROOT,
    env: {
      ...process.env,
      GOALNIGHT_DATA: dataDir,
      // server/index.js boots the dashboard in-process — give it a free port
      // so concurrent test runs and the dev's 8888 don't collide.
      GOALNIGHT_PORT: String(dashPort),
      HOME: dataDir,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', () => {});
  client = new JsonRpcClient(proc);
});

after(async () => {
  if (proc) await withTimeoutKill(proc, 1500);
  cleanupFixtureDir(dataDir);
});

test('initialize returns serverInfo.name === "goalnight"', async () => {
  const result = await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'goalnight-it-mcp', version: '0.0.0' },
  });
  assert.ok(result, 'initialize result missing');
  assert.equal(result.serverInfo?.name, 'goalnight');
  assert.ok(result.serverInfo?.version, 'serverInfo.version missing');
  assert.ok(result.capabilities?.tools, 'tools capability missing');
  client.notify('notifications/initialized', {});
});

test('tools/list returns exactly the 5 goalnight tools', async () => {
  const result = await client.request('tools/list', {});
  const names = (result.tools ?? []).map(t => t.name).sort();
  assert.deepEqual(names, [
    'gn_log_decision',
    'gn_log_finding',
    'gn_morning_brief',
    'gn_plan_night',
    'gn_status',
  ]);
  for (const t of result.tools) {
    assert.ok(t.description?.length > 0, `${t.name} missing description`);
    assert.equal(t.inputSchema?.type, 'object', `${t.name} bad input schema`);
  }
});

test('tools/call gn_plan_night persists a session + 3 milestones', async () => {
  const result = await client.request('tools/call', {
    name: 'gn_plan_night',
    arguments: {
      objective: 'integration test objective',
      hours: 6,
      milestones: ['design', 'build', 'verify'],
    },
  });
  assert.ok(!result.isError, `tool returned error: ${JSON.stringify(result)}`);
  assert.equal(result.content?.[0]?.type, 'text');
  const payload = JSON.parse(result.content[0].text);
  assert.ok(payload.session_id, 'session_id missing');
  assert.equal(payload.objective, 'integration test objective');
  assert.equal(payload.milestones.length, 3);
  assert.deepEqual(payload.milestones.map(m => m.ordinal), [1, 2, 3]);
  assert.match(payload.codex_goal_command, /^\/goal set integration test objective/);
});

test('tools/call on an unknown tool name returns isError', async () => {
  const result = await client.request('tools/call', { name: 'gn_does_not_exist', arguments: {} });
  assert.equal(result.isError, true);
  assert.match(result.content?.[0]?.text ?? '', /Unknown tool/);
});
