#!/usr/bin/env node
/**
 * Custom Playwright MCP CLI with snapshot caching and recording
 */

const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

// Direct paths to playwright internals
const playwrightCorePath = path.dirname(require.resolve('playwright-core/package.json'));
const playwrightPath = path.dirname(require.resolve('playwright/package.json'));
const mcpPath = path.join(playwrightPath, 'lib', 'mcp');

const { program } = require(path.join(playwrightCorePath, 'lib', 'utilsBundle'));
const { resolveConfig } = require(path.join(mcpPath, 'browser', 'config'));
const { contextFactory } = require(path.join(mcpPath, 'browser', 'browserContextFactory'));
const mcpServer = require(path.join(mcpPath, 'sdk', 'server'));
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CustomBrowserServerBackend } = require('./src/custom-backend');

const packageJSON = require('./package.json');

// Shared CDP configuration
const CDP_PORT = 9222;
const CDP_USER_DATA_DIR = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'mcp-chrome');

/**
 * Check if CDP endpoint is available
 */
async function isCdpAvailable() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${CDP_PORT}/json/version`, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1000, () => { req.destroy(); resolve(false); });
  });
}

/**
 * Launch Chrome with remote debugging if not already running
 */
async function ensureChromeWithCDP() {
  if (await isCdpAvailable()) {
    console.error(`[Playwright MCP] CDP already available on port ${CDP_PORT}`);
    return `http://127.0.0.1:${CDP_PORT}`;
  }

  console.error(`[Playwright MCP] Starting Chrome with CDP on port ${CDP_PORT}...`);
  
  // Find Chrome / Chromium executable.
  // Priority: user-set CHROME_PATH → system Chrome → Playwright's bundled Chromium
  const playwrightChromiumDir = path.join(
    process.env.LOCALAPPDATA || '',
    'ms-playwright'
  );
  let playwrightChromiumExe = null;
  try {
    const fs = require('fs');
    const dirs = fs.readdirSync(playwrightChromiumDir)
      .filter(d => d.startsWith('chromium-'))
      .sort()
      .reverse(); // newest first
    for (const d of dirs) {
      const candidate = path.join(playwrightChromiumDir, d, 'chrome-win64', 'chrome.exe');
      if (fs.existsSync(candidate)) { playwrightChromiumExe = candidate; break; }
    }
  } catch (_) { /* LOCALAPPDATA not accessible */ }

  const chromePaths = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    playwrightChromiumExe, // fallback: Playwright's bundled Chromium
  ].filter(Boolean);

  let chromePath = null;
  const fs = require('fs');
  for (const p of chromePaths) {
    if (fs.existsSync(p)) {
      chromePath = p;
      break;
    }
  }

  if (!chromePath) {
    console.error('[Playwright MCP] Chrome not found, falling back to userDataDir mode');
    return null;
  }

  // Unpacked Chrome extensions to load, as an OS-path-separator-delimited list
  // (PLAYWRIGHT_MCP_LOAD_EXTENSIONS). Kept out of the source so this fork carries
  // no machine-specific paths.
  const extensions = (process.env.PLAYWRIGHT_MCP_LOAD_EXTENSIONS || '')
    .split(path.delimiter)
    .map(p => p.trim())
    .filter(Boolean);

  // Launch Chrome detached
  const chromeProcess = spawn(chromePath, [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${CDP_USER_DATA_DIR}`,
    ...(extensions.length ? [`--load-extension=${extensions.join(',')}`] : []),
    '--allow-insecure-localhost',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-infobars',
    '--exclude-switches=enable-automation',
    '--disable-features=ChromeWhatsNewUI',
    '--hide-crash-restore-bubble',
    '--suppress-message-center-popups',
    '--disable-client-side-phishing-detection',
    '--no-service-autorun',
    '--password-store=basic',
    '--use-mock-keychain',
    '--disable-restore-session-state',  // skip crash-recovery delay when profile has exit_type=Crashed
  ], {
    detached: true,
    stdio: 'ignore'
  });
  chromeProcess.unref();

  // Wait for CDP to be available (up to 15s — crash-recovery profiles need more time)
  for (let i = 0; i < 75; i++) {
    await new Promise(r => setTimeout(r, 200));
    if (await isCdpAvailable()) {
      console.error(`[Playwright MCP] Chrome started successfully`);
      return `http://127.0.0.1:${CDP_PORT}`;
    }
  }

  console.error('[Playwright MCP] Failed to start Chrome with CDP, falling back to userDataDir mode');
  return null;
}

// ── Engine pool: one shared browser context PER engine ───────────────────────
//
//   chromium → attaches to the real system Chrome over CDP (shared login/cookies)
//   firefox / webkit → launches its own browser via Playwright's contextFactory
//
// All sessions that select the same engine share that engine's single context
// (mirroring the original "everyone shares one Chrome" behaviour) — but keyed by
// engine, so Chrome and Firefox can be live at the same time. A session picks its
// engine via the browser_set_engine tool; the default is chromium.
const enginePool = new Map(); // engine → Promise<{ browserContext, close }>

// Reset every active Playwright Context's cached browser context. Used when a
// pooled browser dies, so sessions don't keep a dead reference and fail with
// "Target page, context or browser has been closed".
function resetActiveContexts(reason) {
  try {
    const { Context } = require(path.join(mcpPath, 'browser', 'context'));
    if (Context._allContexts) {
      for (const ctx of Context._allContexts) {
        ctx._browserContextPromise = void 0;
        if (Array.isArray(ctx._tabs)) ctx._tabs.length = 0;
        ctx._currentTab = null;
      }
      console.error(`[Playwright MCP] ${reason} — reset ${Context._allContexts.size} active context(s).`);
    }
  } catch (e) {
    console.error('[Playwright MCP] Failed to reset active contexts:', e.message);
  }
  try {
    const { clearAll } = require('./src/tab-isolation');
    if (typeof clearAll === 'function') clearAll();
  } catch { /* tab-isolation not loaded */ }
}

// Build the chromium context: attach to the real system Chrome over CDP.
async function buildChromiumContext(rawConfig, sharedCdpMode) {
  const config = await resolveConfig(rawConfig);

  let cdpEndpoint = config.browser?.cdpEndpoint;
  if (!cdpEndpoint && sharedCdpMode) {
    if (!(await isCdpAvailable())) {
      console.error('[Playwright MCP] Chrome not running — starting...');
      const ep = await ensureChromeWithCDP();
      if (ep) cdpEndpoint = ep;
    } else {
      cdpEndpoint = `http://127.0.0.1:${CDP_PORT}`;
    }
  }

  if (cdpEndpoint) {
    try {
      const { chromium } = require('playwright');
      const browser = await chromium.connectOverCDP(cdpEndpoint);

      // Retry: Chrome may take a moment to expose the default context
      let browserContext;
      for (let i = 0; i < 15; i++) {
        const ctxs = browser.contexts();
        if (ctxs.length > 0) { browserContext = ctxs[0]; break; }
        await new Promise(r => setTimeout(r, 200));
      }

      if (browserContext) {
        console.error('[Playwright MCP] Attached to Chrome default context — no new window will open.');
        const resetOnClose = () => {
          console.error('[Playwright MCP] Chrome disconnected — resetting chromium pool.');
          enginePool.delete('chromium');
          resetActiveContexts('Chrome disconnected');
        };
        browser.on('disconnected', resetOnClose);
        browserContext.on('close', resetOnClose);
        return { browserContext, close: async () => {} };
      }
      console.error('[Playwright MCP] contexts() empty after retries — falling back.');
    } catch (e) {
      console.error('[Playwright MCP] CDP attach failed:', e.message, '— falling back.');
    }
  }

  // Fallback: contextFactory (may open a new window, but at least it works)
  if (cdpEndpoint) config.browser = { ...config.browser, cdpEndpoint };
  try {
    return await contextFactory(config).createContext({ roots: [] });
  } catch (e) {
    if (e.message.includes('already in use') && config.browser?.userDataDir) {
      const isolated = { ...config, browser: { ...config.browser } };
      delete isolated.browser.userDataDir;
      return await contextFactory(isolated).createContext({ roots: [] });
    }
    throw e;
  }
}

// Build a launched-browser context (firefox / webkit). Unlike chromium these
// have no CDP-attach path — Playwright owns the browser process. We strip any
// chromium-only options (cdpEndpoint / userDataDir) before launching.
async function buildLaunchedContext(rawConfig, engine) {
  console.error(`[Playwright MCP] Launching ${engine}...`);
  const browserOpts = { ...(rawConfig.browser || {}) };
  delete browserOpts.cdpEndpoint;
  delete browserOpts.userDataDir;
  browserOpts.browserName = engine;

  const cfg = await resolveConfig({ ...rawConfig, browser: browserOpts });
  const result = await contextFactory(cfg).createContext({ roots: [] });

  // Reset the pool if the user closes the browser window manually.
  try {
    const reset = () => {
      console.error(`[Playwright MCP] ${engine} disconnected — resetting pool.`);
      enginePool.delete(engine);
      resetActiveContexts(`${engine} disconnected`);
    };
    result.browserContext?.on?.('close', reset);
    result.browserContext?.browser?.()?.on?.('disconnected', reset);
  } catch { /* best effort */ }

  return result;
}

// Get (or lazily create) the shared context for an engine.
function getEngineContext(engine, rawConfig, sharedCdpMode) {
  if (enginePool.has(engine)) return enginePool.get(engine);
  const attempt = (engine === 'chromium')
    ? buildChromiumContext(rawConfig, sharedCdpMode)
    : buildLaunchedContext(rawConfig, engine);
  enginePool.set(engine, attempt);
  // Reset on failure so the next call retries (prevents permanently broken state)
  attempt.catch(() => { if (enginePool.get(engine) === attempt) enginePool.delete(engine); });
  return enginePool.get(engine);
}

/**
 * Per-session factory: resolves the browser context for whatever engine the
 * session currently has selected. The engine is read fresh on each createContext
 * call (via the shared engineState object), so switching engines mid-session
 * just needs the session's Context to drop its cached _browserContextPromise.
 *
 * @param {{ engine: string }} engineState  - mutable, shared with browser_set_engine
 * @param {object} rawConfig
 * @param {boolean} sharedCdpMode
 */
function createEngineAwareFactory(engineState, rawConfig, sharedCdpMode) {
  return {
    createContext: async () => {
      const engine = engineState.engine || 'chromium';
      const { browserContext } = await getEngineContext(engine, rawConfig, sharedCdpMode);
      // Never close the shared pool context when a single session ends.
      return { browserContext, close: async () => {} };
    }
  };
}

async function createCustomConnection(userConfig = {}, sharedCdpMode = false, sessionId = null) {
  const config = await resolveConfig(userConfig);

  // Per-session engine selection. Default to whatever browser was configured at
  // startup (chromium unless --browser overrode it). browser_set_engine mutates
  // engineState.engine; the engine-aware factory reads it on each createContext.
  const engineState = { engine: config.browser?.browserName || userConfig.browser?.browserName || 'chromium' };

  // The engine pool (module-level) provides cross-session sharing per engine, so
  // every session uses its own factory wrapper over the same shared pool.
  const factory = createEngineAwareFactory(engineState, userConfig, sharedCdpMode);

  return mcpServer.createServer(
    'Playwright-Custom',
    packageJSON.version,
    new CustomBrowserServerBackend(config, factory, engineState),
    false
  );
}

// CLI setup
program
  .version('Version ' + packageJSON.version)
  .name('Playwright MCP Custom')
  .option('--browser <browser>', 'Browser type: chromium, firefox, webkit', 'chromium')
  .option('--headless', 'Run in headless mode')
  .option('--port <port>', 'Port for SSE transport')
  .option('--host <host>', 'Host for SSE transport')
  .option('--vision', 'Enable vision mode (screenshots instead of snapshots)')
  .option('--config <path>', 'Path to config file')
  .option('--max-snapshot-lines <lines>', 'Max lines before caching (default: 300)', '300')
  .option('--shared-cdp', 'Use shared Chrome instance with CDP (default: true)', true)
  .option('--no-shared-cdp', 'Disable shared CDP mode')
  .action(async (options) => {
    // Update cache config if provided
    if (options.maxSnapshotLines) {
      const cache = require('./src/snapshot-cache');
      cache.CONFIG.maxLines = parseInt(options.maxSnapshotLines, 10);
    }

    const config = {};
    if (options.browser) config.browser = { browserName: options.browser };

    // Determine if we're in shared CDP mode (Chrome will be started lazily on first use)
    const sharedCdpMode = options.sharedCdp !== false
      && options.browser !== 'firefox'
      && options.browser !== 'webkit'
      && !process.env.PLAYWRIGHT_MCP_CDP_ENDPOINT;

    // Priority: explicit CDP env > shared CDP mode (lazy) > userDataDir env > isolated
    if (process.env.PLAYWRIGHT_MCP_CDP_ENDPOINT) {
      config.browser = { ...config.browser, cdpEndpoint: process.env.PLAYWRIGHT_MCP_CDP_ENDPOINT };
      console.error(`[Playwright MCP] Using explicit CDP endpoint: ${process.env.PLAYWRIGHT_MCP_CDP_ENDPOINT}`);
    } else if (sharedCdpMode) {
      // CDP mode: Chrome starts lazily when first browser context is created
      if (process.env.PLAYWRIGHT_MCP_USER_DATA_DIR) {
        config.browser = { ...config.browser, userDataDir: process.env.PLAYWRIGHT_MCP_USER_DATA_DIR };
      }
      console.error('[Playwright MCP] Shared CDP mode — Chrome will start on first browser use');
    } else if (process.env.PLAYWRIGHT_MCP_USER_DATA_DIR) {
      config.browser = { ...config.browser, userDataDir: process.env.PLAYWRIGHT_MCP_USER_DATA_DIR };
    }
    
    if (options.headless) config.browser = { ...config.browser, headless: true };
    if (options.vision) config.vision = true;

    if (options.port) {
      // ── SSE / HTTP server mode ─────────────────────────────────────────────
      // One Node.js process handles all Claude tabs.
      // Each GET /sse creates a new MCP connection (own Context → own CDP session),
      // but Chrome, tabRegistry, snapshotCache and recordingManager are all shared
      // in-process, so memory stays flat regardless of how many tabs are open.
      const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
      const port = parseInt(options.port, 10);
      const host = options.host || '127.0.0.1';

      // sessionId → SSEServerTransport
      const transports = new Map();

      // Sharing now happens in the module-level engine pool (one context per
      // engine), so each session gets its own engine-aware factory built inside
      // createCustomConnection — no single shared factory needed here.

      const httpServer = http.createServer(async (req, res) => {
        try {
          const reqUrl = new URL(req.url, 'http://localhost');

          // CORS preflight
          if (req.method === 'OPTIONS') {
            res.writeHead(204, {
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Headers': 'Content-Type',
            });
            res.end();
            return;
          }

          // ── New client connects ──────────────────────────────────────────
          if (req.method === 'GET' && reqUrl.pathname === '/sse') {
            const transport = new SSEServerTransport('/message', res);
            const sessionId = transport.sessionId;
            transports.set(sessionId, transport);

            transport.onclose = () => {
              transports.delete(sessionId);
              // Free all resources owned by this session
              const { cleanupBySession } = require('./src/tab-isolation');
              const recordingManager = require('./src/recording-manager');
              recordingManager.cleanupBySession(sessionId);
              const cleaned = cleanupBySession(sessionId);
              console.error(
                `[Playwright MCP] Session ${sessionId.slice(0, 8)} disconnected` +
                (cleaned ? ` (freed ${cleaned} tab(s))` : '') +
                `. Active: ${transports.size}`
              );
            };

            // Each session gets its own MCP connection + Context wrapper,
            // but all share ONE browser context (same Chrome window, same cookies).
            // Tab ownership (ownerSessionId) prevents sessions from touching each other's tabs.
            const connection = await createCustomConnection(config, sharedCdpMode, sessionId);
            await connection.connect(transport);

            console.error(
              `[Playwright MCP] Session ${sessionId.slice(0, 8)} connected.` +
              ` Active: ${transports.size}`
            );

          // ── Client sends a JSON-RPC message ─────────────────────────────
          } else if (req.method === 'POST' && reqUrl.pathname === '/message') {
            const sessionId = reqUrl.searchParams.get('sessionId');
            const transport = transports.get(sessionId);

            if (!transport) {
              res.writeHead(404).end('Session not found');
              return;
            }

            // SSEServerTransport reads the body from req itself (raw-body)
            await transport.handlePostMessage(req, res);

          // ── Health check ─────────────────────────────────────────────────
          } else if (req.method === 'GET' && reqUrl.pathname === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              status: 'ok',
              sessions: transports.size,
              pid: process.pid,
            }));

          } else {
            res.writeHead(404).end('Not found');
          }
        } catch (err) {
          console.error('[Playwright MCP] Request error:', err);
          if (!res.headersSent) res.writeHead(500).end('Internal error');
        }
      });

      httpServer.listen(port, host, () => {
        console.error(`[Playwright MCP] SSE server on  http://${host}:${port}/sse`);
        console.error(`[Playwright MCP] Health check:  http://${host}:${port}/health`);
      });

      const shutdown = async (signal) => {
        console.error(`[Playwright MCP] ${signal} — shutting down...`);
        for (const transport of transports.values()) {
          await transport.close().catch(() => {});
        }
        httpServer.close(() => process.exit(0));
      };

      process.on('SIGINT',  () => shutdown('SIGINT'));
      process.on('SIGTERM', () => shutdown('SIGTERM'));

    } else {
      // ── Stdio mode (original) ──────────────────────────────────────────────
      // One process per Claude tab — kept intact as fallback.
      const connection = await createCustomConnection(config, sharedCdpMode);
      const transport = new StdioServerTransport();
      await connection.connect(transport);
    }
  });

program.parse(process.argv);
