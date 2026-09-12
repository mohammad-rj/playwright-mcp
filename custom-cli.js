#!/usr/bin/env node
/**
 * Custom Playwright MCP CLI with snapshot caching and recording
 */

const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const { program, resolveCLIConfigForMCP } = require('./src/pw');
const { createServer } = require('./src/mcp-server');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CustomBrowserBackend, buildToolList } = require('./src/custom-backend');
const contextRegistry = require('./src/context-registry');

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
//   firefox / webkit → launches its own browser directly (playwright[engine].launch)
//
// All sessions that select the same engine share that engine's single raw
// BrowserContext (mirroring the original "everyone shares one Chrome" behaviour)
// — but keyed by engine, so Chrome and Firefox can be live at the same time. A
// session picks its engine via the browser_set_engine tool; the default is chromium.
//
// Unlike 1.58's browserContextFactory, playwright 1.62's Context class takes a
// raw BrowserContext at construction time (no lazy factory), so the pool now
// resolves directly to a raw BrowserContext rather than a {browserContext, close}
// wrapper.
const enginePool = new Map(); // engine → Promise<BrowserContext>

// Reset every active Playwright Context's cached browser context. Used when a
// pooled browser dies, so sessions don't keep a dead reference and fail with
// "Target page, context or browser has been closed".
function resetActiveContexts(reason) {
  try {
    contextRegistry.resetAll();
    console.error(`[Playwright MCP] ${reason} — reset ${contextRegistry.size()} active context(s).`);
  } catch (e) {
    console.error('[Playwright MCP] Failed to reset active contexts:', e.message);
  }
  try {
    const { clearAll } = require('./src/tab-isolation');
    if (typeof clearAll === 'function') clearAll();
  } catch { /* tab-isolation not loaded */ }
}

// Build the chromium context: attach to the real system Chrome over CDP.
// Returns a raw BrowserContext.
async function buildChromiumContext(rawCliOptions, sharedCdpMode) {
  const config = await resolveCLIConfigForMCP(rawCliOptions, process.env);

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
        return browserContext;
      }
      console.error('[Playwright MCP] contexts() empty after retries — falling back.');
    } catch (e) {
      console.error('[Playwright MCP] CDP attach failed:', e.message, '— falling back.');
    }
  }

  // Fallback: launch our own chromium instance (may open a new window, but at
  // least it works). Reuses the same launch path as firefox/webkit.
  return buildLaunchedContext(rawCliOptions, 'chromium');
}

// Build a launched-browser context (chromium fallback / firefox / webkit).
// Unlike chromium's normal path these have no CDP-attach - Playwright owns the
// browser process directly (playwright[engine].launch() + browser.newContext()).
// We strip any chromium-only options (cdpEndpoint / userDataDir) before
// resolving, since a launched context is always isolated, never persistent.
async function buildLaunchedContext(rawCliOptions, engine) {
  console.error(`[Playwright MCP] Launching ${engine}...`);
  const opts = { ...rawCliOptions };
  delete opts.cdpEndpoint;
  delete opts.userDataDir;
  opts.browser = engine;

  const config = await resolveCLIConfigForMCP(opts, process.env);
  const browserName = config.browser?.browserName || (engine === 'chrome' ? 'chromium' : engine);
  const launchOptions = { ...(config.browser?.launchOptions || {}) };
  if (process.getuid && process.getuid() === 0) {
    launchOptions.chromiumSandbox = false;
  }
  const browser = await require('playwright')[browserName].launch(launchOptions);
  const browserContext = await browser.newContext(config.browser?.contextOptions || {});

  // Reset the pool if the user closes the browser window manually.
  try {
    const reset = () => {
      console.error(`[Playwright MCP] ${engine} disconnected — resetting pool.`);
      enginePool.delete(engine);
      resetActiveContexts(`${engine} disconnected`);
    };
    browserContext.on('close', reset);
    browser.on('disconnected', reset);
  } catch { /* best effort */ }

  return browserContext;
}

// Get (or lazily create) the shared context for an engine.
function getEngineContext(engine, rawCliOptions, sharedCdpMode) {
  if (enginePool.has(engine)) return enginePool.get(engine);
  const attempt = (engine === 'chromium')
    ? buildChromiumContext(rawCliOptions, sharedCdpMode)
    : buildLaunchedContext(rawCliOptions, engine);
  enginePool.set(engine, attempt);
  // Reset on failure so the next call retries (prevents permanently broken state)
  attempt.catch(() => { if (enginePool.get(engine) === attempt) enginePool.delete(engine); });
  return enginePool.get(engine);
}

async function createCustomConnection(cliOptions = {}, sharedCdpMode = false, sessionId = null) {
  const config = await resolveCLIConfigForMCP(cliOptions, process.env);

  // Per-session engine selection. Default to whatever browser was configured at
  // startup (chromium unless --browser overrode it). browser_set_engine mutates
  // engineState.engine and (since 1.62's Context takes a raw BrowserContext
  // rather than a lazy factory) also swaps the session's Context._rawBrowserContext
  // directly via engineState.resolveContext, which resolves the pooled context
  // for whichever engine is requested.
  const engineState = {
    engine: config.browser?.browserName || cliOptions.browser || 'chromium',
    resolveContext: (engine) => getEngineContext(engine, cliOptions, sharedCdpMode),
  };

  const browserContext = await getEngineContext(engineState.engine, cliOptions, sharedCdpMode);

  const toolList = buildToolList(config, engineState);
  const backend = new CustomBrowserBackend(config, browserContext, toolList, engineState, sessionId);

  return createServer('Playwright-Custom', packageJSON.version, backend, false);
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
  .option('--caps <list>',
    'Comma-separated optional tool capabilities to enable on top of the always-on core set. ' +
    'Available: storage, testing, network, pdf, vision, devtools, config. ' +
    'All are enabled by default; browser_annotate is dropped separately because it blocks ' +
    'waiting for a human.',
    'storage,testing,network,pdf,vision,devtools,config')
  .option('--shared-cdp', 'Use shared Chrome instance with CDP (default: true)', true)
  .option('--no-shared-cdp', 'Disable shared CDP mode')
  .action(async (options) => {
    // Update cache config if provided
    if (options.maxSnapshotLines) {
      const cache = require('./src/snapshot-cache');
      cache.CONFIG.maxLines = parseInt(options.maxSnapshotLines, 10);
    }

    // cliOptions is CLI-shaped (per resolveCLIConfigForMCP), not the old nested
    // { browser: { browserName, ... } } shape.
    const cliOptions = {};
    if (options.browser) cliOptions.browser = options.browser;

    // Determine if we're in shared CDP mode (Chrome will be started lazily on first use)
    const sharedCdpMode = options.sharedCdp !== false
      && options.browser !== 'firefox'
      && options.browser !== 'webkit'
      && !process.env.PLAYWRIGHT_MCP_CDP_ENDPOINT;

    // Priority: explicit CDP env > shared CDP mode (lazy) > userDataDir env > isolated
    if (process.env.PLAYWRIGHT_MCP_CDP_ENDPOINT) {
      cliOptions.cdpEndpoint = process.env.PLAYWRIGHT_MCP_CDP_ENDPOINT;
      console.error(`[Playwright MCP] Using explicit CDP endpoint: ${process.env.PLAYWRIGHT_MCP_CDP_ENDPOINT}`);
    } else if (sharedCdpMode) {
      // CDP mode: Chrome starts lazily when first browser context is created
      if (process.env.PLAYWRIGHT_MCP_USER_DATA_DIR) {
        cliOptions.userDataDir = process.env.PLAYWRIGHT_MCP_USER_DATA_DIR;
      }
      console.error('[Playwright MCP] Shared CDP mode — Chrome will start on first browser use');
    } else if (process.env.PLAYWRIGHT_MCP_USER_DATA_DIR) {
      cliOptions.userDataDir = process.env.PLAYWRIGHT_MCP_USER_DATA_DIR;
    }

    if (options.headless) cliOptions.headless = true;
    if (options.vision) cliOptions.vision = true;

    // Optional capabilities. filteredTools() always keeps the core* tools and
    // admits the rest only when their capability is listed here, so without
    // this the cookie/storage/network/assertion tools stay invisible.
    if (options.caps) {
      cliOptions.caps = String(options.caps)
        .split(',')
        .map(c => c.trim())
        .filter(Boolean);
    }

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
            const connection = await createCustomConnection(cliOptions, sharedCdpMode, sessionId);
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

      httpServer.listen(port, host, async () => {
        console.error(`[Playwright MCP] SSE server on  http://${host}:${port}/sse`);
        console.error(`[Playwright MCP] Health check:  http://${host}:${port}/health`);

        try {
          const defaultEngine = cliOptions.browser || 'chromium';
          console.error(`[Playwright MCP] Pre-warming default session (${defaultEngine})...`);
          await getEngineContext(defaultEngine, cliOptions, sharedCdpMode);
          console.error(`[Playwright MCP] Default session ready.`);
        } catch (e) {
          console.error(`[Playwright MCP] Pre-warm warning:`, e.message);
        }
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
      const connection = await createCustomConnection(cliOptions, sharedCdpMode);
      const transport = new StdioServerTransport();
      await connection.connect(transport);
    }
  });

program.parse(process.argv);
