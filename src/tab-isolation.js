/**
 * Tab Isolation Module
 * 
 * Provides tab-aware tool wrappers that allow multi-agent browser access.
 * Each agent can work on its own tab without interfering with others.
 * 
 * SECURITY: tabId is REQUIRED for all tab-aware tools.
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
 * Schema for tabId parameter - REQUIRED for all tab-aware tools
 */
const tabIdSchema = z.number().describe(
  'Tab ID to operate on. REQUIRED. Get this from browser_tabs(action="new").'
);

/**
 * Create a proxy context that returns a specific tab
 * @param {Context} context - Original context
 * @param {number} tabId - Tab index to use (REQUIRED)
 * @returns {Object} Proxy context
 */
function createTabProxyContext(context, tabId) {
  // tabId is now required, no fallback to current tab
  if (tabId === undefined || tabId === null) {
    throw new Error('tabId is required. First call browser_tabs(action="new") to get your tab ID.');
  }
  
  return new Proxy(context, {
    get(target, prop) {
      if (prop === 'currentTab') {
        return () => {
          const tabs = target.tabs();
          if (tabId >= 0 && tabId < tabs.length) {
            return tabs[tabId];
          }
          throw new Error(`Tab ${tabId} not found. It may have been closed.`);
        };
      }
      
      if (prop === 'currentTabOrDie') {
        return () => {
          const tabs = target.tabs();
          if (tabId >= 0 && tabId < tabs.length) {
            return tabs[tabId];
          }
          throw new Error(`Tab ${tabId} not found. It may have been closed.`);
        };
      }
      
      if (prop === 'ensureTab') {
        return async () => {
          const tabs = target.tabs();
          if (tabId >= 0 && tabId < tabs.length) {
            return tabs[tabId];
          }
          throw new Error(`Tab ${tabId} not found. It may have been closed.`);
        };
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
 * Wrap a tool to REQUIRE tabId parameter
 * @param {Object} tool - Original tool definition
 * @returns {Object} Wrapped tool with required tabId
 */
function wrapToolWithTabId(tool) {
  const originalSchema = tool.schema;
  const originalHandle = tool.handle;
  
  const newInputSchema = originalSchema.inputSchema.extend({
    tabId: tabIdSchema  // Now required (not optional)
  });
  
  return {
    ...tool,
    schema: {
      ...originalSchema,
      inputSchema: newInputSchema
    },
    handle: async (context, params, response) => {
      const { tabId, ...restParams } = params;
      
      // Validate tabId is provided (zod should catch this, but double-check)
      if (tabId === undefined || tabId === null) {
        throw new Error(
          'tabId is REQUIRED. First call browser_tabs(action="new") to create a tab and get your tabId.'
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
 * - 'new': Creates tab and returns tabId (only way to get a tabId)
 * - 'close': Requires tabId to close (can only close your own tab)
 * - 'list' and 'select' are REMOVED to prevent interference
 * @returns {Object} Enhanced tabs tool
 */
function createEnhancedTabsTool() {
  return {
    schema: {
      name: 'browser_tabs',
      title: 'Manage tabs',
      description: 'Create or close browser tabs. Use action="new" to create a tab and get your tabId. Use action="close" with your tabId to close it. You can only operate on tabs you created.',
      inputSchema: z.object({
        action: z.enum(['new', 'close']).describe('Operation: "new" to create tab, "close" to close your tab'),
        tabId: z.number().optional().describe('Tab ID to close (required for close action)')
      }),
      type: 'action'
    },
    capability: 'core-tabs',
    handle: async (context, params, response) => {
      switch (params.action) {
        case 'new': {
          await context.newTab();
          const newTabId = context.tabs().length - 1;
          
          response.addResult(
            `## Tab Created\n\n` +
            `**Your tabId: ${newTabId}**\n\n` +
            `Use this tabId with ALL browser tools:\n` +
            `- \`browser_navigate(tabId=${newTabId}, url="...")\`\n` +
            `- \`browser_snapshot(tabId=${newTabId})\`\n` +
            `- \`browser_click(tabId=${newTabId}, ref="...", element="...")\`\n` +
            `- \`browser_tabs(action="close", tabId=${newTabId})\` when done\n\n` +
            `⚠️ tabId is REQUIRED for all browser operations.`
          );
          return;
        }
        
        case 'close': {
          if (params.tabId === undefined) {
            throw new Error('tabId is required for close action. Provide the tabId you received when creating the tab.');
          }
          
          const tabs = context.tabs();
          if (params.tabId < 0 || params.tabId >= tabs.length) {
            throw new Error(`Tab ${params.tabId} not found. It may have already been closed.`);
          }
          
          await context.closeTab(params.tabId);
          response.addResult(`Tab ${params.tabId} closed.`);
          return;
        }
        
        default:
          throw new Error(`Unknown action: ${params.action}. Use "new" or "close".`);
      }
    }
  };
}

module.exports = {
  tabIdSchema,
  createTabProxyContext,
  wrapToolWithTabId,
  createTabAwareTools,
  createEnhancedTabsTool,
  TAB_AWARE_TOOLS
};
