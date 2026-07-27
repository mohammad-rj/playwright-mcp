/**
 * Custom Browser Server Backend
 * 
 * Extends Playwright MCP with:
 * - Snapshot caching for large pages
 * - Recording system for debugging dynamic UI
 * - Tab isolation for multi-agent support
 * 
 * @module custom-backend
 */

const path = require('path');

// Direct paths to playwright internals
const playwrightPath = path.dirname(require.resolve('playwright/package.json'));
const mcpPath = path.join(playwrightPath, 'lib', 'mcp');

// Use zod from playwright-core bundle (compatible with zodToJsonSchema)
const { z } = require('playwright-core/lib/mcpBundle');

const { Context } = require(path.join(mcpPath, 'browser', 'context'));
const { logUnhandledError } = require(path.join(mcpPath, 'log'));
const { SessionLog } = require(path.join(mcpPath, 'browser', 'sessionLog'));
const { toMcpTool } = require(path.join(mcpPath, 'sdk', 'tool'));
const { Response: OriginalResponse } = require(path.join(mcpPath, 'browser', 'response'));

const snapshotCache = require('./snapshot-cache');
const recordingManager = require('./recording-manager');
const { createRecordingTools } = require('./recording-tools');
const outputCache = require('./output-cache');
const { createTabAwareTools, createEnhancedTabsTool } = require('./tab-isolation');

// Patched Response class - handles all large outputs
class PatchedResponse extends OriginalResponse {
  serialize(options = {}) {
    const result = super.serialize(options);
    
    if (result.content?.[0]?.type === 'text') {
      let text = result.content[0].text;
      
      // FIRST: Check if ENTIRE output is too large (regardless of content type)
      // This catches cases where console messages + snapshot together are huge
      if (outputCache.needsCaching(text)) {
        const toolName = this._name || 'unknown';
        const { cacheId, totalLines, preview } = outputCache.cacheOutput(text, toolName);
        result.content[0].text = outputCache.formatCacheMessage(cacheId, totalLines, toolName, preview);
        return result;
      }
      
      // SECOND: Handle snapshot-specific caching (YAML blocks only)
      // This is for when snapshot alone is large but total output is manageable
      const yamlMatch = text.match(/```yaml\n([\s\S]*?)\n```/);
      if (yamlMatch?.[1] && snapshotCache.needsPagination(yamlMatch[1])) {
        const snapshotContent = yamlMatch[1];
        const urlMatch = text.match(/- Page URL: (.+)/);
        const titleMatch = text.match(/- Page Title: (.+)/);
        const url = urlMatch?.[1] || 'unknown';
        const title = titleMatch?.[1] || 'unknown';
        
        const { cacheId, totalLines, structureHints } = snapshotCache.cacheSnapshot(
          snapshotContent, url, title
        );
        
        const paginationMsg = snapshotCache.formatPaginationMessage(
          cacheId, totalLines, url, title, structureHints
        );
        
        text = text.replace(
          /- Page Snapshot:\n```yaml\n[\s\S]*?\n```/,
          paginationMsg
        );
        result.content[0].text = text;
      }
    }
    
    return result;
  }
}

// Custom tools for cache navigation - using real zod schemas
const getCachedSnapshotTool = {
  schema: {
    name: 'get_cached_snapshot',
    title: 'Get cached snapshot',
    description: 'Get specific lines from a cached page snapshot. Use when snapshot was too large.',
    inputSchema: z.object({
      cacheId: z.string().describe('Cache ID from browser_snapshot'),
      startLine: z.number().optional().describe('Starting line (1-indexed)'),
      endLine: z.number().optional().describe('Ending line (inclusive)')
    }),
    type: 'readOnly'
  },
  capability: 'core',
  handle: async (context, params, response) => {
    const result = snapshotCache.getPaginatedContent(
      params.cacheId,
      params.startLine || 1,
      params.endLine
    );

    if (result.error) {
      response.addError(result.error);
      return;
    }

    let text = `Lines ${result.startLine}-${result.endLine} of ${result.totalLines}:\n`;
    text += '```yaml\n' + result.content + '\n```';
    if (result.hasMore) {
      text += `\n\n_More available. Next: startLine=${result.endLine + 1}_`;
    }
    response.addResult(text);
  }
};

const searchCachedSnapshotTool = {
  schema: {
    name: 'search_cached_snapshot',
    title: 'Search cached snapshot',
    description: 'Search for text within a cached page snapshot.',
    inputSchema: z.object({
      cacheId: z.string().describe('Cache ID from browser_snapshot'),
      query: z.string().describe('Text to search for'),
      maxResults: z.number().optional().describe('Max results (default: 10)')
    }),
    type: 'readOnly'
  },
  capability: 'core',
  handle: async (context, params, response) => {
    const result = snapshotCache.searchInCache(
      params.cacheId,
      params.query,
      params.maxResults || 10
    );

    if (result.error) {
      response.addError(result.error);
      return;
    }

    let text = `Search "${result.query}" - ${result.totalMatches} matches:\n\n`;
    for (const match of result.results) {
      text += `Line ${match.line}: ${match.content}\n`;
    }
    response.addResult(text);
  }
};

// Universal output cache tools
const getCachedOutputTool = {
  schema: {
    name: 'get_cached_output',
    title: 'Get cached output',
    description: 'Get specific lines from any cached large output.',
    inputSchema: z.object({
      cacheId: z.string().describe('Cache ID from large output'),
      startLine: z.number().optional().describe('Starting line (1-indexed)'),
      endLine: z.number().optional().describe('Ending line (inclusive)')
    }),
    type: 'readOnly'
  },
  capability: 'core',
  handle: async (context, params, response) => {
    const result = outputCache.getPaginatedContent(
      params.cacheId,
      params.startLine || 1,
      params.endLine
    );

    if (result.error) {
      response.addError(result.error);
      return;
    }

    let text = `## Output (${result.startLine}-${result.endLine} of ${result.totalLines})\n\n`;
    text += '```\n' + result.content + '\n```';
    if (result.hasMore) {
      text += `\n\n_More available. Next: startLine=${result.endLine + 1}_`;
    }
    response.addResult(text);
  }
};

const searchCachedOutputTool = {
  schema: {
    name: 'search_cached_output',
    title: 'Search cached output',
    description: 'Search for text within any cached large output.',
    inputSchema: z.object({
      cacheId: z.string().describe('Cache ID from large output'),
      query: z.string().describe('Text to search for'),
      maxResults: z.number().optional().describe('Max results (default: 20)')
    }),
    type: 'readOnly'
  },
  capability: 'core',
  handle: async (context, params, response) => {
    const result = outputCache.searchInCache(
      params.cacheId,
      params.query,
      params.maxResults || 20
    );

    if (result.error) {
      response.addError(result.error);
      return;
    }

    let text = `## Search "${result.query}" - ${result.totalMatches} matches\n\n`;
    for (const match of result.results) {
      text += `**L${match.line}:** ${match.content}\n`;
    }
    response.addResult(text);
  }
};

// Per-session engine selector. `engineState` is shared with the engine-aware
// factory in custom-cli.js, so setting it here changes which browser the next
// browser action opens in. Switching drops this session's cached browser context
// (and its tab list) so the next action rebuilds against the new engine.
function createSetEngineTool(engineState) {
  return {
    schema: {
      name: 'browser_set_engine',
      title: 'Select browser engine',
      description:
        'Choose the browser engine for the CURRENT session: "chromium" (default; attaches to the shared system Chrome with its real profile and logins), "firefox", or "webkit". ' +
        'Switching resets this session\'s open tabs; the next browser_navigate opens in the chosen engine. Chromium and a launched engine (firefox/webkit) can be live at the same time across sessions. ' +
        'Only call this when you need a non-Chrome browser (e.g. cross-browser testing) — the default is already chromium.',
      inputSchema: z.object({
        engine: z.enum(['chromium', 'firefox', 'webkit']).describe('Browser engine to drive for this session')
      }),
      type: 'readOnly'
    },
    capability: 'core',
    handle: async (context, params, response) => {
      const prev = engineState.engine || 'chromium';
      if (params.engine === prev) {
        response.addResult(`Already on ${prev}. No change.`);
        return;
      }
      engineState.engine = params.engine;
      // Drop this session's view of the old engine so the next browser action
      // rebuilds against the newly-selected engine's pooled context.
      try {
        context._browserContextPromise = void 0;
        if (Array.isArray(context._tabs)) context._tabs.length = 0;
        context._currentTab = null;
      } catch (e) { /* best effort — fields are internal to Playwright's Context */ }
      response.addResult(
        `Browser engine switched: ${prev} -> ${params.engine}. ` +
        `The next browser action will open in ${params.engine}. ` +
        `(Chromium stays available — switch back any time with engine="chromium".)`
      );
    }
  };
}

class CustomBrowserServerBackend {
  constructor(config, factory, engineState = null) {
    this._config = config;
    this._browserContextFactory = factory;
    this._engineState = engineState;
    
    // Get custom tools
    const recordingTools = createRecordingTools();
    
    // Use tab-aware tools instead of original filteredTools
    const tabAwareTools = createTabAwareTools(config);
    const enhancedTabsTool = createEnhancedTabsTool();

    // Override browser_take_screenshot: abort fonts before capture so the tool
    // never hangs waiting for woff/woff2 files that Chrome treats as downloads.
    const screenshotTool = tabAwareTools.find(t => t.schema.name === 'browser_take_screenshot');
    if (screenshotTool) {
      const _origScreenshot = screenshotTool.handle;
      screenshotTool.handle = async (context, params, response) => {
        const { getTabRegistry } = require('./tab-isolation');
        const entry = getTabRegistry().get(params.tabId);
        const page = entry?.page;
        const FONT_GLOB = '**/*.{woff,woff2,ttf,otf,eot}';
        if (page) await page.route(FONT_GLOB, r => r.abort()).catch(() => {});
        try {
          return await _origScreenshot(context, params, response);
        } finally {
          if (page) await page.unroute(FONT_GLOB).catch(() => {});
        }
      };
    }

    this._tools = [
      ...tabAwareTools,
      enhancedTabsTool,
      getCachedSnapshotTool,
      searchCachedSnapshotTool,
      getCachedOutputTool,
      searchCachedOutputTool,
      ...recordingTools
    ];

    // Expose the engine selector only when a session engineState is wired in.
    if (engineState) {
      this._tools.push(createSetEngineTool(engineState));
    }
  }

  async initialize(clientInfo) {
    this._sessionLog = this._config.saveSession 
      ? await SessionLog.create(this._config, clientInfo) 
      : undefined;
    this._context = new Context({
      config: this._config,
      browserContextFactory: this._browserContextFactory,
      sessionLog: this._sessionLog,
      clientInfo
    });
  }

  async listTools() {
    return this._tools.map(tool => toMcpTool(tool.schema));
  }

  async callTool(name, rawArguments) {
    const tool = this._tools.find(t => t.schema.name === name);
    if (!tool) throw new Error(`Tool "${name}" not found`);

    const parsedArguments = tool.schema.inputSchema.parse(rawArguments || {});
    const response = new PatchedResponse(this._context, name, parsedArguments);
    
    response.logBegin();
    this._context.setRunningTool(name);
    
    try {
      await tool.handle(this._context, parsedArguments, response);
      await response.finish();
      this._sessionLog?.logResponse(response);
    } catch (error) {
      response.addError(String(error));
    } finally {
      this._context.setRunningTool(undefined);
    }
    
    response.logEnd();
    return response.serialize();
  }

  serverClosed() {
    // Cleanup recordings on browser close
    recordingManager.cleanupAll();
    this._context?.dispose().catch(logUnhandledError);
  }
}

module.exports = { CustomBrowserServerBackend };
