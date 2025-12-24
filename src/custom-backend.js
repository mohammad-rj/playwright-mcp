/**
 * Custom Browser Server Backend
 * 
 * Extends Playwright MCP with:
 * - Snapshot caching for large pages
 * - Recording system for debugging dynamic UI
 * 
 * @module custom-backend
 */

const path = require('path');
const z = require('zod');

// Direct paths to playwright internals (bypass exports restriction)
const playwrightPath = path.dirname(require.resolve('playwright/package.json'));
const mcpPath = path.join(playwrightPath, 'lib', 'mcp');

const { Context } = require(path.join(mcpPath, 'browser', 'context'));
const { logUnhandledError } = require(path.join(mcpPath, 'log'));
const { SessionLog } = require(path.join(mcpPath, 'browser', 'sessionLog'));
const { filteredTools } = require(path.join(mcpPath, 'browser', 'tools'));
const { toMcpTool } = require(path.join(mcpPath, 'sdk', 'tool'));
const { Response: OriginalResponse } = require(path.join(mcpPath, 'browser', 'response'));

const snapshotCache = require('./snapshot-cache');
const recordingManager = require('./recording-manager');
const { createRecordingTools } = require('./recording-tools');

// Patched Response class
class PatchedResponse extends OriginalResponse {
  serialize(options = {}) {
    const result = super.serialize(options);
    
    if (result.content?.[0]?.type === 'text') {
      const text = result.content[0].text;
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
        
        result.content[0].text = text.replace(
          /- Page Snapshot:\n```yaml\n[\s\S]*?\n```/,
          paginationMsg
        );
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

class CustomBrowserServerBackend {
  constructor(config, factory) {
    this._config = config;
    this._browserContextFactory = factory;
    
    // Get recording tools
    const recordingTools = createRecordingTools(mcpPath, z);
    
    this._tools = [
      ...filteredTools(config),
      getCachedSnapshotTool,
      searchCachedSnapshotTool,
      ...recordingTools
    ];
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
