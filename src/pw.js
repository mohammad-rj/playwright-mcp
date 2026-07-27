/**
 * Playwright internals seam
 *
 * Targets playwright / playwright-core 1.62.0-alpha (bundled coreBundle API).
 * This is the ONLY file in this fork allowed to reach into playwright-core's
 * internal lib/ files (coreBundle, utilsBundle). Every other module in this
 * fork must require('./pw') instead of touching playwright-core internals
 * directly, so a future version bump only means editing this one file.
 *
 * @module pw
 */

const { z, zodToJsonSchema, program } = require('playwright-core/lib/utilsBundle');
const tools = require('playwright-core/lib/coreBundle').tools;

const {
  BrowserBackend,
  Tab,
  browserTools,
  createConnection,
  decorateMCPCommand,
  filteredTools,
  resolveCLIConfigForMCP,
  resolveCLIConfigForCLI,
  parseResponse,
  start,
  outputDir,
  setupExitWatchdog,
} = tools;

module.exports = {
  z,
  zodToJsonSchema,
  program,
  BrowserBackend,
  Tab,
  browserTools,
  createConnection,
  decorateMCPCommand,
  filteredTools,
  resolveCLIConfigForMCP,
  resolveCLIConfigForCLI,
  parseResponse,
  start,
  outputDir,
  setupExitWatchdog,
  // Raw bundle, for anything not individually re-exported above.
  tools,
};
