/**
 * Dashboard HTTP server.
 *
 * Routes:
 *   GET /                    → public/index.html
 *   GET /styles.css          → public/styles.css
 *   GET /dashboard.js        → public/dashboard.js
 *   GET /health              → { ok: true, port }
 *   GET /api/status          → one-shot status snapshot
 *   GET /api/brief           → morning brief snapshot
 *   GET /events              → SSE stream, pushes status every 2s
 *
 * Design notes:
 *   - Vanilla `node:http` only (no Express).
 *   - Static files served from ./public, never touch paths outside it.
 *   - SSE: heartbeat comment every tick keeps the connection alive even
 *     when there's no session yet.
 *   - Status and brief calls reuse the MCP tool implementations directly —
 *     single source of truth, no duplicated query logic.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { status } from '../tools/status.js';
import { morningBrief } from '../tools/morning_brief.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');

const PREFERRED_PORT = parseInt(process.env.GOALNIGHT_PORT || '8888', 10);
const MAX_PORT_TRIES = 10;
const SSE_INTERVAL_MS = 2000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

const STATIC_ROUTES = {
  '/':              { file: 'index.html' },
  '/index.html':    { file: 'index.html' },
  '/styles.css':    { file: 'styles.css' },
  '/dashboard.js':  { file: 'dashboard.js' },
};

async function serveStatic(res, filename) {
  // Normalize and re-join under PUBLIC_DIR. Reject anything that escapes.
  const safe = normalize(filename).replace(/^(\.\.[/\\])+/, '');
  const full = join(PUBLIC_DIR, safe);
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  try {
    const buf = await readFile(full);
    const type = MIME[extname(full).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  } catch (err) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end(`Not found: ${filename}`);
  }
}

function sendJson(res, code, payload) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

async function handleApiStatus(res) {
  try {
    const snapshot = await status({});
    sendJson(res, 200, snapshot);
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

async function handleApiBrief(res) {
  try {
    const brief = await morningBrief({});
    sendJson(res, 200, brief);
  } catch (err) {
    // Most common case: no session yet — return a soft 200 so the client
    // can show an empty state instead of an error banner.
    sendJson(res, 200, { empty: true, message: err.message });
  }
}

function handleEvents(req, res) {
  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection':    'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': goalnight sse stream\n\n');

  let closed = false;
  const tick = async () => {
    if (closed) return;
    try {
      const snapshot = await status({});
      res.write(`event: status\ndata: ${JSON.stringify(snapshot)}\n\n`);
    } catch (err) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`);
    }
  };

  // First frame immediately so the client doesn't wait 2s for content.
  tick();
  const timer = setInterval(tick, SSE_INTERVAL_MS);

  req.on('close', () => {
    closed = true;
    clearInterval(timer);
    try { res.end(); } catch { /* already closed */ }
  });
}

function makeHandler(port) {
  return async function handle(req, res) {
    // Strip query string for route matching.
    const url = (req.url || '/').split('?')[0];

    if (url === '/health') {
      return sendJson(res, 200, { ok: true, port });
    }
    if (url === '/events') {
      return handleEvents(req, res);
    }
    if (url === '/api/status') {
      return handleApiStatus(res);
    }
    if (url === '/api/brief') {
      return handleApiBrief(res);
    }

    const route = STATIC_ROUTES[url];
    if (route) {
      return serveStatic(res, route.file);
    }

    // Fallback 404 — keep it small.
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  };
}

export async function startDashboard() {
  return new Promise((resolve, reject) => {
    let port = PREFERRED_PORT;
    let attempt = 0;

    function tryListen() {
      const server = createServer(makeHandler(port));

      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && attempt < MAX_PORT_TRIES) {
          attempt++;
          port++;
          tryListen();
        } else {
          reject(err);
        }
      });

      server.listen(port, '127.0.0.1', () => {
        console.error(`[goalnight] dashboard listening at http://localhost:${port}`);
        resolve({ server, port });
      });
    }

    tryListen();
  });
}

// Allow `node server/dashboard/server.js` for local iteration.
if (import.meta.url === `file://${process.argv[1]}`) {
  startDashboard().catch(err => {
    console.error('[goalnight] dashboard failed:', err);
    process.exit(1);
  });
}
