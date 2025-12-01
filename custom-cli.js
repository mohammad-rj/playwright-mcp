#!/usr/bin/env node
/**
 * Custom Playwright MCP CLI with snapshot caching
 */

const path = require('path');

// Direct paths to playwright internals
const playwrightCorePath = path.dirname(require.resolve('playwright-core/package.json'));
const playwrightPath = path.dirname(require.resolve('playwright/package.json'));
const mcpPath = path.join(playwrightPath, 'lib', 'mcp');

const { program } = require(path.join(playwrightCorePath, 'lib', 'utilsBundle'));
const { resolveConfig } = require(path.join(mcpPath, 'browser', 'config'));
const { contextFactory } = require(path.join(mcpPath, 'browser', 'browserContextFactory'));
const mcpServer = require(path.join(mcpPath, 'sdk', 'server'));
const { CustomBrowserServerBackend } = require('./src/custom-backend');

const packageJSON = require('./package.json');

async function createCustomConnection(userConfig = {}) {
  const config = await resolveConfig(userConfig);
  const factory = contextFactory(config);
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
  .action(async (options) => {
    // Update cache config if provided
    if (options.maxSnapshotLines) {
      const cache = require('./src/snapshot-cache');
      cache.CONFIG.maxLines = parseInt(options.maxSnapshotLines, 10);
    }

    const config = {};
    if (options.browser) config.browser = { browserName: options.browser };
    if (options.headless) config.browser = { ...config.browser, headless: true };
    if (options.vision) config.vision = true;

    const connection = await createCustomConnection(config);
    
    // Stdio transport (default for MCP) - from bundle
    const mcpBundle = require(path.join(mcpPath, 'sdk', 'bundle'));
    const transport = new mcpBundle.StdioServerTransport();
    await connection.connect(transport);
  });

program.parse(process.argv);
