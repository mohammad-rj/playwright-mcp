/**
 * Tab Isolation Module
 * 
 * Provides tab-aware tool wrappers that allow multi-agent browser access.
 * Each agent can work on its own tab without interfering with others.
 * 
 * SECURITY: tabId (6-char string) is REQUIRED for all tab-aware tools.
 * This prevents agents from accidentally modifying other agents' tabs.
 * Agents must first call browser_tabs(action="new") to get their tabId.
 * 
 * @module tab-isolation
 */

const path = require('path');
const { z } = require('playwright-core/lib/mcpBundle');

// Playwright internals
const playwrightPath = path.dirname(require.resolve('playwright/package.json'));
const mcpPath = path.join(playwrightPath, 'lib', 'mcp');
const { filteredTools } = require(path.join(mcpPath, 'browser', 'tools'));

/**
 * Tab registry - maps string IDs to actual tab references
 * Key: 6-char string ID
 * Value: { page: Page, createdAt: Date, title: string }
 */
const tabRegistry = new Map();

/**
 * Generate a random 6-character alphanumeric ID
 * @returns {string} Random ID like "a3x9k2"
 */
function generateTabId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 6; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  // Ensure uniqueness
  if (tabRegistry.has(id)) {
    return generateTabId();
  }
  return id;
}

/**
 * Schema for tabId parameter - REQUIRED for all tab-aware tools
 */
const tabIdSchema = z.string().length(6).describe(
  'Tab ID (6-char string) to operate on. REQUIRED. Get this from browser_tabs(action="new").'
);

/**
 * Get tab page by string ID
 * @param {Context} context - Browser context
 * @param {string} tabId - 6-char tab ID
 * @returns {Page} Playwright page
 */
function getTabByStringId(context, tabId) {
  const entry = tabRegistry.get(tabId);
  if (!entry) {
    throw new Error(`Tab "${tabId}" not found. It may have been closed or never existed.`);
  }
  
  // Verify the page still exists in context
  const tabs = context.tabs();
  const pageIndex = tabs.findIndex(t => t === entry.page);
  if (pageIndex === -1) {
    // Page was closed externally, clean up registry
    tabRegistry.delete(tabId);
    throw new Error(`Tab "${tabId}" was closed.`);
  }
  
  return entry.page;
}

/**
 * Create a proxy context that returns a specific tab by string ID
 * @param {Context} context - Original context
 * @param {string} tabId - 6-char tab ID (REQUIRED)
 * @returns {Object} Proxy context
 */
function createTabProxyContext(context, tabId) {
  if (!tabId || typeof tabId !== 'string') {
    throw new Error('tabId is required. First call browser_tabs(action="new") to get your tab ID.');
  }
  
  return new Proxy(context, {
    get(target, prop) {
      if (prop === 'currentTab') {
        return () => getTabByStringId(target, tabId);
      }
      
      if (prop === 'currentTabOrDie') {
        return () => getTabByStringId(target, tabId);
      }
      
      if (prop === 'ensureTab') {
        return async () => getTabByStringId(target, tabId);
      }
      
      const value = target[prop];
      if (typeof value === 'function') {
        return value.bind(target);
      }
      return value;
    }
  });
}

/**
 * Wrap a tool to REQUIRE tabId parameter (string)
 * @param {Object} tool - Original tool definition
 * @returns {Object} Wrapped tool with required tabId
 */
function wrapToolWithTabId(tool) {
  const originalSchema = tool.schema;
  const originalHandle = tool.handle;
  
  const newInputSchema = originalSchema.inputSchema.extend({
    tabId: tabIdSchema
  });
  
  return {
    ...tool,
    schema: {
      ...originalSchema,
      inputSchema: newInputSchema
    },
    handle: async (context, params, response) => {
      const { tabId, ...restParams } = params;
      
      if (!tabId || typeof tabId !== 'string' || tabId.length !== 6) {
        throw new Error(
          'tabId (6-char string) is REQUIRED. First call browser_tabs(action="new") to create a tab and get your tabId.'
        );
      }
      
      const proxyContext = createTabProxyContext(context, tabId);
      response._context = proxyContext;
      
      return await originalHandle(proxyContext, restParams, response);
    }
  };
}

/**
 * Tools that work with tabs and should get tabId parameter
 */
const TAB_AWARE_TOOLS = new Set([
  'browser_snapshot',
  'browser_click',
  'browser_drag', 
  'browser_hover',
  'browser_select_option',
  'browser_generate_locator',
  'browser_navigate',
  'browser_navigate_back',
  'browser_press_key',
  'browser_type',
  'browser_fill_form',
  'browser_take_screenshot',
  'browser_wait_for',
  'browser_evaluate',
  'browser_console_messages',
  'browser_network_requests',
  'browser_handle_dialog',
  'browser_file_upload',
  'browser_run_code',
  'browser_mouse_move_xy',
  'browser_mouse_click_xy',
  'browser_mouse_drag_xy',
  'browser_resize'
]);

/**
 * Process all tools and add tabId support where applicable
 * @param {Object} config - MCP config
 * @returns {Array} Tools with tabId support
 */
function createTabAwareTools(config) {
  const originalTools = filteredTools(config);
  
  return originalTools.map(tool => {
    // Skip browser_tabs - we replace it with enhanced version
    if (tool.schema.name === 'browser_tabs') {
      return null;
    }
    
    if (TAB_AWARE_TOOLS.has(tool.schema.name)) {
      return wrapToolWithTabId(tool);
    }
    return tool;
  }).filter(Boolean);
}

/**
 * Enhanced browser_tabs tool
 * - 'new': Creates tab and returns 6-char string tabId
 * - 'close': Requires tabId to close
 * - 'list': Returns all tabs with their IDs and titles
 * @returns {Object} Enhanced tabs tool
 */
function createEnhancedTabsTool() {
  return {
    schema: {
      name: 'browser_tabs',
      title: 'Manage tabs',
      description: 'Create, close, or list browser tabs. Use action="new" to create a tab and get your tabId (6-char string). Use action="close" with your tabId to close it. Use action="list" to see all tabs with their IDs and titles.',
      inputSchema: z.object({
        action: z.enum(['new', 'close', 'list']).describe('Operation: "new" to create tab, "close" to close tab, "list" to see all tabs'),
        tabId: z.string().length(6).optional().describe('Tab ID (6-char string) to close (required for close action)')
      }),
      type: 'action'
    },
    capability: 'core-tabs',
    handle: async (context, params, response) => {
      switch (params.action) {
        case 'new': {
          const page = await context.newTab();
          const tabId = generateTabId();
          
          // Register the tab
          tabRegistry.set(tabId, {
            page: page,
            createdAt: new Date(),
            title: 'New Tab'
          });
          
          // Update title when page loads
          page.on('load', async () => {
            const entry = tabRegistry.get(tabId);
            if (entry) {
              try {
                entry.title = await page.title() || 'Untitled';
              } catch (e) {
                // Page might be closed
              }
            }
          });
          
          response.addResult(
            `## Tab Created\n\n` +
            `**Your tabId: \`${tabId}\`**\n\n` +
            `Use this tabId with ALL browser tools:\n` +
            `- \`browser_navigate(tabId="${tabId}", url="...")\`\n` +
            `- \`browser_snapshot(tabId="${tabId}")\`\n` +
            `- \`browser_click(tabId="${tabId}", ref="...", element="...")\`\n` +
            `- \`browser_tabs(action="close", tabId="${tabId}")\` when done\n\n` +
            `⚠️ tabId is REQUIRED for all browser operations.`
          );
          return;
        }
        
        case 'close': {
          if (!params.tabId || params.tabId.length !== 6) {
            throw new Error('tabId (6-char string) is required for close action.');
          }
          
          const entry = tabRegistry.get(params.tabId);
          if (!entry) {
            throw new Error(`Tab "${params.tabId}" not found. It may have already been closed.`);
          }
          
          // Find the tab index
          const tabs = context.tabs();
          const tabIndex = tabs.findIndex(t => t === entry.page);
          
          if (tabIndex === -1) {
            tabRegistry.delete(params.tabId);
            throw new Error(`Tab "${params.tabId}" was already closed.`);
          }
          
          await context.closeTab(tabIndex);
          tabRegistry.delete(params.tabId);
          
          response.addResult(`Tab \`${params.tabId}\` closed.`);
          return;
        }
        
        case 'list': {
          const tabs = context.tabs();
          const tabList = [];
          
          // Clean up registry and build list
          for (const [id, entry] of tabRegistry.entries()) {
            const tabIndex = tabs.findIndex(t => t === entry.page);
            if (tabIndex === -1) {
              // Tab was closed externally
              tabRegistry.delete(id);
              continue;
            }
            
            // Get the Tab object from context.tabs()
            const tab = tabs[tabIndex];
            
            // Get current title and URL
            // Tab has .page (Playwright Page) and .lastTitle() method
            let title = 'Untitled';
            let url = 'about:blank';
            
            try {
              // Use Tab's page property to get URL and title
              if (tab.page) {
                url = tab.page.url() || 'about:blank';
                title = await tab.page.title() || tab.lastTitle?.() || 'Untitled';
              } else if (typeof tab.lastTitle === 'function') {
                title = tab.lastTitle();
              }
            } catch (e) {
              // Keep defaults
            }
            
            tabList.push({
              id,
              title,
              url,
              createdAt: entry.createdAt.toISOString()
            });
          }
          
          if (tabList.length === 0) {
            response.addResult(
              `## No Tabs\n\n` +
              `No tabs are currently open.\n` +
              `Use \`browser_tabs(action="new")\` to create one.`
            );
            return;
          }
          
          let result = `## Open Tabs (${tabList.length})\n\n`;
          result += `| ID | Title | URL |\n`;
          result += `|----|-------|-----|\n`;
          
          for (const tab of tabList) {
            const shortUrl = tab.url.length > 50 ? tab.url.substring(0, 47) + '...' : tab.url;
            const shortTitle = tab.title.length > 30 ? tab.title.substring(0, 27) + '...' : tab.title;
            result += `| \`${tab.id}\` | ${shortTitle} | ${shortUrl} |\n`;
          }
          
          response.addResult(result);
          return;
        }
        
        default:
          throw new Error(`Unknown action: ${params.action}. Use "new", "close", or "list".`);
      }
    }
  };
}

/**
 * Get tab registry (for debugging/testing)
 * @returns {Map} Tab registry
 */
function getTabRegistry() {
  return tabRegistry;
}

module.exports = {
  tabIdSchema,
  generateTabId,
  getTabByStringId,
  createTabProxyContext,
  wrapToolWithTabId,
  createTabAwareTools,
  createEnhancedTabsTool,
  getTabRegistry,
  TAB_AWARE_TOOLS
};
