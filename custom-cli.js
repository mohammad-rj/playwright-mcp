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

  // Launch Chrome detached
  const chromeProcess = spawn(chromePath, [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${CDP_USER_DATA_DIR}`,
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
  ], {
    detached: true,
    stdio: 'ignore'
  });
  chromeProcess.unref();

  // Wait for CDP to be available
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 200));
    if (await isCdpAvailable()) {
      console.error(`[Playwright MCP] Chrome started successfully`);
      return `http://127.0.0.1:${CDP_PORT}`;
    }
  }

  console.error('[Playwright MCP] Failed to start Chrome with CDP, falling back to userDataDir mode');
  return null;
}

/**
 * Create a shared browser factory — the underlying browser context is created
 * once and reused by all SSE sessions. This ensures all agents share the same
 * Chrome window (and therefore the same login state / cookies).
 *
 * @param {object} rawConfig  - Raw user config (browser options, etc.)
 * @param {boolean} sharedCdpMode
 * @returns {{ createContext: Function }}
 */
function createSharedFactory(rawConfig, sharedCdpMode) {
  // Promise singleton — one context for all sessions, created lazily on first use.
  let _contextPromise = null;

  return {
    createContext: async (clientInfo) => {
      if (_contextPromise) return _contextPromise;

      const attempt = (async () => {
        const config = await resolveConfig(rawConfig);

        // Ensure Chrome is running, get cdpEndpoint
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
              // When Chrome closes or CDP disconnects, reset the singleton so the
              // next browser tool call starts a fresh Chrome instead of returning
              // a dead context ("Target page, context or browser has been closed").
              const resetOnClose = () => {
                console.error('[Playwright MCP] Chrome disconnected — resetting shared context.');
                _contextPromise = null;
                // Clear zombie tabs from the registry
                const { clearAll } = require('./src/tab-isolation');
                if (typeof clearAll === 'function') clearAll();
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
          return await contextFactory(config).createContext(clientInfo);
        } catch (e) {
          if (e.message.includes('already in use') && config.browser?.userDataDir) {
            const isolated = { ...config, browser: { ...config.browser } };
            delete isolated.browser.userDataDir;
            return await contextFactory(isolated).createContext(clientInfo);
          }
          throw e;
        }
      })();

      // Reset on failure so the next call retries (prevents permanently broken state)
      _contextPromise = attempt;
      attempt.catch(() => { _contextPromise = null; });

      return _contextPromise;
    }
  };
}

async function createCustomConnection(userConfig = {}, sharedCdpMode = false, sessionId = null, prebuiltFactory = null) {
  const config = await resolveConfig(userConfig);

  // If a shared factory is provided (SSE mode), use it — all sessions share one Chrome context.
  // Otherwise build a per-session factory with lazy Chrome start + isolated fallback.
  const factory = prebuiltFactory || {
    createContext: async (options) => {
      // Lazy Chrome start: only when a browser context is actually needed
      if (sharedCdpMode && !(await isCdpAvailable())) {
        console.error('[Playwright MCP] Chrome not running — starting...');
        const newEndpoint = await ensureChromeWithCDP();
        if (newEndpoint) {
          config.browser = { ...config.browser, cdpEndpoint: newEndpoint };
        } else if (config.browser) {
          delete config.browser.cdpEndpoint;
        }
      }

      try {
        return await contextFactory(config).createContext(options);
      } catch (e) {
        if (e.message.includes('already in use') && config.browser?.userDataDir) {
          console.error(`\n[WARNING] User Data Directory is locked by another session: ${config.browser.userDataDir}`);
          console.error(`[WARNING] Falling back to isolated temporary directory to prevent crash.\n`);

          const isolatedConfig = { ...config, browser: { ...config.browser } };
          delete isolatedConfig.browser.userDataDir;

          return await contextFactory(isolatedConfig).createContext(options);
        }
        throw e;
      }
    }
  };

  return mcpServer.createServer(
    'Playwright-Custom',
    packageJSON.version,
    new CustomBrowserServerBackend(config, factory),
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

      // One shared factory for ALL sessions — ensures all agents share one Chrome window.
      const sharedFactory = createSharedFactory(config, sharedCdpMode);

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
            const connection = await createCustomConnection(config, sharedCdpMode, sessionId, sharedFactory);
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
