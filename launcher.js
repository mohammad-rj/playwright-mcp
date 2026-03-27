#!/usr/bin/env node
/**
 * Playwright MCP Custom — Auto-start Launcher
 *
 * Used by .mcp.json (command mode). Each Claude tab runs this process.
 * It ensures the SSE HTTP server is running, then bridges:
 *
 *   stdin  (JSON-RPC from Claude)  →  POST /message
 *   SSE stream (from server)       →  stdout (JSON-RPC to Claude)
 *
 * Race condition protection: an atomic O_EXCL lock file ensures that when
 * multiple tabs open at the same time, only ONE of them starts the server.
 * The rest wait up to 10 s for it to become available.
 */

'use strict';

const http     = require('http');
const fs       = require('fs');
const path     = require('path');
const readline = require('readline');
const { spawn }  = require('child_process');

// ── Configuration ──────────────────────────────────────────────────────────

const SERVER_HOST = '127.0.0.1';
const SERVER_PORT = 9224;
const SERVER_BASE = `http://${SERVER_HOST}:${SERVER_PORT}`;
const SERVER_JS   = path.join(__dirname, 'custom-cli.js');
const LOCK_FILE   = path.join(__dirname, '.mcp', 'start.lock');

// ── Utilities ──────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function log(...args) {
  process.stderr.write('[playwright-launcher] ' + args.join(' ') + '\n');
}

function checkHealth() {
  return new Promise((resolve) => {
    const req = http.get(`${SERVER_BASE}/health`, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1000, () => { req.destroy(); resolve(false); });
  });
}

// ── Lock file (atomic O_EXCL — only one process wins) ─────────────────────

function tryAcquireLock() {
  try {
    const dir = path.dirname(LOCK_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // 'wx' = O_WRONLY | O_CREAT | O_EXCL — atomic, fails if file exists
    fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx' });
    return true;
  } catch {
    return false; // another process holds the lock
  }
}

function releaseLock() {
  try { fs.unlinkSync(LOCK_FILE); } catch { /* already gone */ }
}

// Remove a lock whose holder process is no longer running (crash recovery)
function clearStaleLock() {
  try {
    const raw = fs.readFileSync(LOCK_FILE, 'utf8').trim();
    const pid = parseInt(raw, 10);
    if (Number.isNaN(pid)) { fs.unlinkSync(LOCK_FILE); return; }
    try {
      process.kill(pid, 0); // throws ESRCH if PID doesn't exist
    } catch {
      log(`Removing stale lock (dead PID ${pid})`);
      fs.unlinkSync(LOCK_FILE);
    }
  } catch { /* lock file doesn't exist or unreadable — fine */ }
}

// ── Server lifecycle ───────────────────────────────────────────────────────

async function ensureServerRunning() {
  // Fast path — already up
  if (await checkHealth()) {
    log('Server already running.');
    return;
  }

  // Clean up any stale lock before racing
  clearStaleLock();

  if (tryAcquireLock()) {
    // ── We won the race — our job is to start the server ──────────────────
    //
    // Double-check: another process may have just finished starting the server
    // between our health check above and acquiring the lock.
    if (await checkHealth()) {
      releaseLock();
      log('Server came up while acquiring lock.');
      return;
    }

    try {
      log(`Starting SSE server on port ${SERVER_PORT}...`);

      const LOG_FILE = path.join(__dirname, '.mcp', 'server.log');
      const logFd = (() => {
        try {
          const dir = path.dirname(LOG_FILE);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          return fs.openSync(LOG_FILE, 'a');
        } catch { return 'ignore'; }
      })();

      const proc = spawn(
        'node',
        [SERVER_JS, '--port', String(SERVER_PORT), '--host', SERVER_HOST],
        {
          detached: true,
          stdio:    ['ignore', logFd, logFd],
          env:      process.env,
        }
      );
      proc.unref(); // let this process die independently of us

      // Wait up to 6 s for the server to become healthy
      for (let i = 0; i < 30; i++) {
        await sleep(200);
        if (await checkHealth()) {
          log('Server is ready.');
          return;
        }
      }
      throw new Error('Server did not become ready within 6 s');

    } finally {
      releaseLock(); // always release — even on error
    }

  } else {
    // ── Another launcher won the race — just wait ──────────────────────────
    log('Another process is starting the server, waiting...');

    for (let i = 0; i < 50; i++) {  // up to 10 s
      await sleep(200);
      if (await checkHealth()) {
        log('Server is ready (started by peer).');
        return;
      }
    }
    throw new Error('Server did not start within 10 s');
  }
}

// ── stdio ↔ SSE proxy ──────────────────────────────────────────────────────
//
// Each line on stdin is a JSON-RPC message from Claude Code.
// We POST it to the server's /message endpoint.
//
// The server pushes JSON-RPC responses over the SSE stream.
// We parse those SSE events and write each data payload as a line to stdout.

async function runProxy() {
  return new Promise((resolve, reject) => {
    // ── Open SSE connection → server to Claude ─────────────────────────────
    const sseReq = http.get(`${SERVER_BASE}/sse`, (sseRes) => {
      if (sseRes.statusCode !== 200) {
        reject(new Error(`SSE connect failed with status ${sseRes.statusCode}`));
        return;
      }

      let messageEndpoint = null; // set on first 'endpoint' SSE event
      const pendingLines  = [];   // buffer lines that arrive before endpoint is ready
      let eventType  = '';
      let dataLines  = [];
      let buf        = '';

      function sendLine(line) {
        const endpointUrl = new URL(messageEndpoint, SERVER_BASE);
        const body = Buffer.from(line, 'utf8');
        const postReq = http.request(
          {
            hostname: SERVER_HOST,
            port:     SERVER_PORT,
            path:     endpointUrl.pathname + endpointUrl.search,
            method:   'POST',
            headers: {
              'Content-Type':   'application/json',
              'Content-Length': body.length,
            },
          },
          (res) => {
            res.resume();
            if (res.statusCode >= 400) log(`POST ${endpointUrl.pathname} returned ${res.statusCode}`);
          }
        );
        postReq.on('error', (e) => log('POST error:', e.message));
        postReq.write(body);
        postReq.end();
      }

      sseRes.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        const parts = buf.split('\n');
        buf = parts.pop(); // keep the last (potentially incomplete) line

        for (const line of parts) {
          if (line === '') {
            // ── End of one SSE event block ──────────────────────────────────
            const data = dataLines.join('\n');

            if (eventType === 'endpoint') {
              // Server tells us where to POST our messages
              messageEndpoint = data.trim();
              log(`Session endpoint: ${messageEndpoint}`);
              // flush buffered stdin lines now that endpoint is ready
              for (const buffered of pendingLines) sendLine(buffered);
              pendingLines.length = 0;
            } else if (data) {
              // A JSON-RPC response/notification → Claude Code
              process.stdout.write(data + '\n');
            }

            eventType = '';
            dataLines = [];

          } else if (line.startsWith('event: ')) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            dataLines.push(line.slice(6));
          }
          // Lines starting with ':' are SSE keep-alive pings — ignore.
        }
      });

      sseRes.on('end',   () => { log('SSE stream closed.'); resolve(); });
      sseRes.on('error', reject);

      // ── stdin → POST /message → server ────────────────────────────────────
      const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

      rl.on('line', (line) => {
        if (!line.trim()) return;

        if (!messageEndpoint) {
          pendingLines.push(line);
          return;
        }

        sendLine(line);
      });

      rl.on('close', () => resolve());
    });

    sseReq.on('error', reject);
  });
}

// ── Entry point ────────────────────────────────────────────────────────────

(async () => {
  try {
    await ensureServerRunning();
    await runProxy();
  } catch (err) {
    log('Fatal:', err.message);
    process.exit(1);
  }
})();
