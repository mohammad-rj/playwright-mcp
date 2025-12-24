/**
 * Console Cache Tools for MCP
 * 
 * Provides tools for caching and searching console messages.
 * 
 * @module console-tools
 */

const consoleCache = require('./console-cache');

// Use zod from playwright-core bundle
const { z } = require('playwright-core/lib/mcpBundle');

/**
 * Create console tools
 */
function createConsoleTools() {

  // Override browser_console_messages - returns stats + cache ID
  const browserConsoleMessagesTool = {
    schema: {
      name: 'browser_console_messages',
      title: 'Get console messages',
      description: 'Returns console message statistics and cache ID. Use browser_console_search or browser_console_by_type to get actual messages.',
      inputSchema: z.object({
        level: z.enum(['error', 'warning', 'info', 'debug']).optional().describe('Minimum level to include (default: info)')
      }),
      type: 'readOnly'
    },
    capability: 'core',
    handle: async (context, params, response) => {
      let tab;
      try {
        tab = await context.ensureTab();
      } catch (e) {
        response.addError(`Failed to get tab: ${e.message}`);
        return;
      }
      
      let messages;
      try {
        messages = tab.consoleMessages ? tab.consoleMessages() : [];
        if (messages && typeof messages.then === 'function') {
          messages = await Promise.race([
            messages,
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
          ]);
        }
      } catch (e) {
        response.addError(`Failed to fetch messages: ${e.message}`);
        return;
      }
      
      if (!messages || messages.length === 0) {
        response.addResult('No console messages captured.');
        return;
      }
      
      // Cache messages
      const { cacheId, stats } = consoleCache.cacheConsoleMessages(messages);
      
      let text = `## Console Messages\n\n`;
      text += `| Stat | Count |\n`;
      text += `|------|-------|\n`;
      text += `| Total | ${stats.total} |\n`;
      text += `| ❌ Errors | ${stats.errors} |\n`;
      text += `| ⚠️ Warnings | ${stats.warnings} |\n`;
      text += `| 📝 Logs | ${stats.logs} |\n`;
      text += `| ℹ️ Info | ${stats.info} |\n\n`;
      text += `**Cache ID:** \`${cacheId}\`\n\n`;
      
      // Show error preview if any
      if (stats.errors > 0) {
        const errorResult = consoleCache.getMessagesByType(cacheId, 'error', 3);
        if (errorResult.results?.length > 0) {
          text += `### Error Preview\n`;
          for (const err of errorResult.results) {
            text += `- ${err.text.substring(0, 100)}${err.text.length > 100 ? '...' : ''}\n`;
          }
          text += '\n';
        }
      }
      
      text += `### Commands\n`;
      text += `- **Errors:** \`browser_console_by_type\` type="error"\n`;
      text += `- **Search:** \`browser_console_search\` query="..."\n`;
      text += `- **Paginate:** \`get_cached_console\` cacheId="${cacheId}"\n`;
      
      response.addResult(text);
    }
  };

  const browserConsoleSearchTool = {
    schema: {
      name: 'browser_console_search',
      title: 'Search console messages',
      description: 'Search for text within console messages.',
      inputSchema: z.object({
        query: z.string().describe('Text to search for'),
        type: z.enum(['all', 'error', 'warning', 'log', 'info']).optional().describe('Filter by type (default: all)'),
        maxResults: z.number().optional().describe('Max results (default: 30)'),
        cacheId: z.string().optional().describe('Use existing cache ID instead of fetching new messages')
      }),
      type: 'readOnly'
    },
    capability: 'core',
    handle: async (context, params, response) => {
      let cacheId = params.cacheId;
      let stats;
      
      // Get or create cache
      if (!cacheId) {
        const tab = await context.ensureTab();
        let messages;
        try {
          messages = tab.consoleMessages ? tab.consoleMessages() : [];
          if (messages && typeof messages.then === 'function') {
            messages = await Promise.race([
              messages,
              new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
            ]);
          }
        } catch (e) {
          response.addError(`Failed to fetch messages: ${e.message}`);
          return;
        }
        
        if (!messages || messages.length === 0) {
          response.addResult('No console messages captured.');
          return;
        }
        
        const cached = consoleCache.cacheConsoleMessages(messages);
        cacheId = cached.cacheId;
        stats = cached.stats;
      }
      
      // Search
      const result = consoleCache.searchInConsole(cacheId, params.query, {
        maxResults: params.maxResults || 30,
        type: params.type === 'all' ? null : params.type
      });
      
      if (result.error) {
        response.addError(result.error);
        return;
      }
      
      let text = `## Search: "${params.query}"\n`;
      text += `Found ${result.totalMatches} matches\n`;
      text += `**Cache ID:** \`${cacheId}\`\n\n`;
      
      if (result.results.length === 0) {
        text += '_No matches found._\n';
      } else {
        for (const match of result.results) {
          const icon = match.type === 'error' ? '❌' : 
                      match.type === 'warning' ? '⚠️' : 
                      match.type === 'info' ? 'ℹ️' : '📝';
          text += `${icon} **L${match.line}** [${match.type}]: ${match.text}\n`;
        }
      }
      
      response.addResult(text);
    }
  };

  const browserConsoleByTypeTool = {
    schema: {
      name: 'browser_console_by_type',
      title: 'Get console by type',
      description: 'Get console messages filtered by type.',
      inputSchema: z.object({
        type: z.enum(['error', 'warning', 'log', 'info']).describe('Message type'),
        maxResults: z.number().optional().describe('Max results (default: 50)'),
        cacheId: z.string().optional().describe('Use existing cache ID')
      }),
      type: 'readOnly'
    },
    capability: 'core',
    handle: async (context, params, response) => {
      let cacheId = params.cacheId;
      
      // Get or create cache
      if (!cacheId) {
        const tab = await context.ensureTab();
        let messages;
        try {
          messages = tab.consoleMessages ? tab.consoleMessages() : [];
          if (messages && typeof messages.then === 'function') {
            messages = await Promise.race([
              messages,
              new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
            ]);
          }
        } catch (e) {
          response.addError(`Failed to fetch messages: ${e.message}`);
          return;
        }
        
        if (!messages || messages.length === 0) {
          response.addResult(`No console messages captured.`);
          return;
        }
        
        const cached = consoleCache.cacheConsoleMessages(messages);
        cacheId = cached.cacheId;
      }
      
      const result = consoleCache.getMessagesByType(cacheId, params.type, params.maxResults || 50);
      
      if (result.error) {
        response.addError(result.error);
        return;
      }
      
      const icon = params.type === 'error' ? '❌' : 
                  params.type === 'warning' ? '⚠️' : 
                  params.type === 'info' ? 'ℹ️' : '📝';
      
      let text = `## ${icon} ${params.type.charAt(0).toUpperCase() + params.type.slice(1)}s\n`;
      text += `Showing ${result.returned} of ${result.totalMatches}\n`;
      text += `**Cache ID:** \`${cacheId}\`\n\n`;
      
      if (result.results.length === 0) {
        text += `_No ${params.type} messages._\n`;
      } else {
        for (const msg of result.results) {
          text += `**L${msg.index + 1}:** ${msg.text.substring(0, 200)}${msg.text.length > 200 ? '...' : ''}\n`;
          if (msg.location) {
            text += `  _at ${msg.location}_\n`;
          }
        }
      }
      
      response.addResult(text);
    }
  };

  const getCachedConsoleTool = {
    schema: {
      name: 'get_cached_console',
      title: 'Get cached console',
      description: 'Get paginated console messages from cache.',
      inputSchema: z.object({
        cacheId: z.string().describe('Cache ID from browser_console_messages'),
        startLine: z.number().optional().describe('Starting line (default: 1)'),
        endLine: z.number().optional().describe('Ending line')
      }),
      type: 'readOnly'
    },
    capability: 'core',
    handle: async (context, params, response) => {
      const result = consoleCache.getPaginatedMessages(
        params.cacheId,
        params.startLine || 1,
        params.endLine
      );
      
      if (result.error) {
        response.addError(result.error);
        return;
      }
      
      let text = `## Console (${result.startLine}-${result.endLine} of ${result.totalLines})\n\n`;
      
      for (const msg of result.messages) {
        const icon = msg.type === 'error' ? '❌' : 
                    msg.type === 'warning' ? '⚠️' : 
                    msg.type === 'info' ? 'ℹ️' : '📝';
        text += `${icon} **${msg.index + 1}** [${msg.type}]: ${msg.text.substring(0, 150)}${msg.text.length > 150 ? '...' : ''}\n`;
      }
      
      if (result.hasMore) {
        text += `\n_More available. Next: startLine=${result.endLine + 1}_`;
      }
      
      response.addResult(text);
    }
  };

  return [
    browserConsoleMessagesTool,
    browserConsoleSearchTool,
    browserConsoleByTypeTool,
    getCachedConsoleTool
  ];
}

module.exports = { createConsoleTools };
