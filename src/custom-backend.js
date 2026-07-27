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

const { z, BrowserBackend, filteredTools } = require('./pw');

const contextRegistry = require('./context-registry');
const snapshotCache = require('./snapshot-cache');
const recordingManager = require('./recording-manager');
const { createRecordingTools } = require('./recording-tools');
const outputCache = require('./output-cache');
const { createTabAwareTools, createEnhancedTabsTool, getTabRegistry, SESSION_ID } = require('./tab-isolation');

// Apply the snapshot/output caching logic to one text content item. This is
// the same logic that used to live inside PatchedResponse.serialize() on
// playwright 1.58 (which subclassed the internal Response class). 1.62's
// BrowserBackend.callTool() builds and serializes its Response internally and
// there is no Response class left to subclass, so instead we post-process the
// already-serialized text ourselves, from CustomBrowserBackend.callTool().
// Returns the (possibly rewritten) text.
function applyCaching(text, toolName) {
  // FIRST: Check if ENTIRE output is too large (regardless of content type)
  // This catches cases where console messages + snapshot together are huge
  if (outputCache.needsCaching(text)) {
    const { cacheId, totalLines, preview } = outputCache.cacheOutput(text, toolName);
    return outputCache.formatCacheMessage(cacheId, totalLines, toolName, preview);
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

    return text.replace(
      /- Page Snapshot:\n```yaml\n[\s\S]*?\n```/,
      paginationMsg
    );
  }

  return text;
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
    response.addTextResult(text);
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
    response.addTextResult(text);
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
    response.addTextResult(text);
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
    response.addTextResult(text);
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
        response.addTextResult(`Already on ${prev}. No change.`);
        return;
      }
      engineState.engine = params.engine;
      // 1.62's Context no longer has a lazy browserContextFactory to re-invoke -
      // it holds a fixed _rawBrowserContext set at construction time. So switching
      // engines means fetching the new engine's pooled context ourselves and
      // swapping it in directly, then dropping this session's cached tab state
      // so the next browser action rebuilds against it.
      try {
        if (typeof engineState.resolveContext === 'function') {
          const newContext = await engineState.resolveContext(params.engine);
          if (newContext) context._rawBrowserContext = newContext;
        }
        // ensureBrowserContext() memoises the old engine's context; drop the
        // memo so the next action re-initialises against the new engine.
        context._browserContextPromise = undefined;
        if (Array.isArray(context._tabs)) context._tabs.length = 0;
        context._currentTab = undefined;
      } catch (e) { /* best effort - fields are internal to Playwright's Context */ }
      response.addTextResult(
        `Browser engine switched: ${prev} -> ${params.engine}. ` +
        `The next browser action will open in ${params.engine}. ` +
        `(Chromium stays available — switch back any time with engine="chromium".)`
      );
    }
  };
}

// Build the full tool list: filteredTools(config), tab-isolation-wrapped, plus
// all of this fork's custom tools. Built BEFORE the backend is constructed
// because BrowserBackend's constructor takes the tool list as a plain array
// (super(config, browserContext, toolList)) rather than building it itself.
// Tools that block waiting for a human and would therefore hang an agent.
// browser_annotate opens the Playwright Dashboard in annotation mode and does
// not return until someone draws on the page. It ships in the same 'devtools'
// capability as tracing and video recording, which are genuinely useful here,
// so the capability stays enabled and this one tool is dropped instead.
const BLOCKING_TOOLS = new Set(['browser_annotate']);

function buildToolList(config, engineState = null) {
  const recordingTools = createRecordingTools();

  // Use tab-aware tools instead of original filteredTools
  const tabAwareTools = createTabAwareTools(config);
  const enhancedTabsTool = createEnhancedTabsTool();

  // Override browser_take_screenshot: abort fonts before capture so the tool
  // never hangs waiting for woff/woff2 files that Chrome treats as downloads.
  const screenshotTool = tabAwareTools.find(t => t.schema.name === 'browser_take_screenshot');
  if (screenshotTool) {
    const _origScreenshot = screenshotTool.handle;
    screenshotTool.handle = async (context, params, response, signal) => {
      const entry = getTabRegistry().get(params.tabId);
      const page = entry?.page;
      const FONT_GLOB = '**/*.{woff,woff2,ttf,otf,eot}';
      if (page) await page.route(FONT_GLOB, r => r.abort()).catch(() => {});
      try {
        return await _origScreenshot(context, params, response, signal);
      } finally {
        if (page) await page.unroute(FONT_GLOB).catch(() => {});
      }
    };
  }

  const toolList = [
    ...tabAwareTools.filter(t => !BLOCKING_TOOLS.has(t.schema.name)),
    enhancedTabsTool,
    getCachedSnapshotTool,
    searchCachedSnapshotTool,
    getCachedOutputTool,
    searchCachedOutputTool,
    ...recordingTools
  ];

  // Expose the engine selector only when a session engineState is wired in.
  if (engineState) {
    toolList.push(createSetEngineTool(engineState));
  }

  return toolList;
}

class CustomBrowserBackend extends BrowserBackend {
  constructor(config, browserContext, toolList, engineState = null, sessionId = null) {
    super(config, browserContext, toolList);
    this._engineState = engineState;
    this._sessionId = sessionId;
  }

  async initialize(clientInfo) {
    await super.initialize(clientInfo);

    // Stamp the SSE session id on the Context so tab-isolation can record and
    // enforce tab ownership. It used to read response._sessionId, but nothing
    // ever set that - on 1.58 too - so every tab was recorded with a null
    // owner and the "belongs to another session" guard never actually fired.
    // The Context is the right carrier: it is per-session and every tool
    // handler receives it as its first argument.
    if (this._context) this._context[SESSION_ID] = this._sessionId;

    contextRegistry.register(this._context, this);
  }

  /**
   * Re-point this session at a live browser context after its previous one
   * died (Chrome closed, engine window closed). 1.62 holds the context by
   * value rather than behind a lazy promise, so recovery means swapping the
   * reference on both the backend and its Context, and re-arming the
   * disconnect watch that BrowserBackend's constructor set up once.
   *
   * Called lazily from callTool(), so a dead browser is only relaunched when
   * a tool actually needs it.
   */
  async _refreshBrowserContext() {
    const engine = this._engineState?.engine || 'chromium';
    if (typeof this._engineState?.resolveContext !== 'function') return;

    const fresh = await this._engineState.resolveContext(engine);
    if (!fresh) return;

    this.browserContext = fresh;
    if (this._context) {
      this._context._rawBrowserContext = fresh;
      // ensureBrowserContext() memoises into _browserContextPromise, and that
      // memo still points at the dead browser. Drop it so the next call
      // re-initialises (request interception, init scripts, page listeners)
      // against the fresh context.
      this._context._browserContextPromise = undefined;
    }

    // BrowserBackend latches _disconnected via once() listeners bound to the
    // OLD context, so both the flag and the listeners have to be renewed -
    // otherwise every later response carries isClose and the client hangs up.
    this._disconnected = false;
    const markDisconnected = () => { this._disconnected = true; };
    fresh.once('close', markDisconnected);
    fresh.browser()?.once('disconnected', markDisconnected);

    contextRegistry.clearStale(this._context);
  }

  async dispose() {
    contextRegistry.unregister(this._context);
    await super.dispose();
  }

  // Mirrors the 1.58 backend's serverClosed(): clean up recordings, then
  // dispose the context. mcp-server.js calls backend.serverClosed?.() when
  // the MCP server connection closes.
  async serverClosed() {
    recordingManager.cleanupAll();
    await this.dispose();
  }

  async callTool(name, rawArguments, signal) {
    // Recover from a browser that died since the last call, before the tool
    // runs against a dead reference.
    if (contextRegistry.isStale(this._context)) {
      try {
        await this._refreshBrowserContext();
      } catch (e) {
        console.error('[Playwright MCP] Failed to refresh browser context:', e.message);
      }
    }

    const result = await super.callTool(name, rawArguments, signal);

    if (Array.isArray(result?.content)) {
      for (const part of result.content) {
        if (part?.type === 'text' && typeof part.text === 'string') {
          part.text = applyCaching(part.text, name);
        }
      }
    }

    return result;
  }
}

module.exports = { CustomBrowserBackend, buildToolList };
