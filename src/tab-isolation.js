/**
 * Tab Isolation Module
 * 
 * Provides tab-aware tool wrappers that allow multi-agent browser access.
 * Each agent can work on its own tab without interfering with others.
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
 * Schema for tabId parameter - added to all tab-aware tools
 */
const tabIdSchema = z.number().optional().describe(
  'Tab index to operate on. If not provided, uses current tab.'
);

/**
 * Create a proxy context that returns a specific tab
 * @param {Context} context - Original context
 * @param {number|undefined} tabId - Tab index to use
 * @returns {Object} Proxy context
 */
function createTabProxyContext(context, tabId) {
  if (tabId === undefined) {
    return context;
  }
  
  return new Proxy(context, {
    get(target, prop) {
      if (prop === 'currentTab') {
        return () => {
          const tabs = target.tabs();
          if (tabId >= 0 && tabId < tabs.length) {
            return tabs[tabId];
          }
          return target.currentTab();
        };
      }
      
      if (prop === 'currentTabOrDie') {
        return () => {
          const tabs = target.tabs();
          if (tabId >= 0 && tabId < tabs.length) {
            return tabs[tabId];
          }
          throw new Error(`Tab ${tabId} not found`);
        };
      }
      
      if (prop === 'ensureTab') {
        return async () => {
          const tabs = target.tabs();
          if (tabId >= 0 && tabId < tabs.length) {
            return tabs[tabId];
          }
          return await target.ensureTab();
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
 * Wrap a tool to support tabId parameter
 * @param {Object} tool - Original tool definition
 * @returns {Object} Wrapped tool with tabId support
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
      const proxyContext = createTabProxyContext(context, tabId);
      
      // Also patch the response's _context to use proxy
      if (tabId !== undefined) {
        response._context = proxyContext;
      }
      
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
 * Enhanced browser_tabs tool that returns tabId on new tab creation
 * @returns {Object} Enhanced tabs tool
 */
function createEnhancedTabsTool() {
  return {
    schema: {
      name: 'browser_tabs',
      title: 'Manage tabs',
      description: 'List, create, close, or select a browser tab. When creating a new tab, returns the tabId for use with other tools.',
      inputSchema: z.object({
        action: z.enum(['list', 'new', 'close', 'select']).describe('Operation to perform'),
        index: z.number().optional().describe('Tab index for close/select. If omitted for close, closes current tab.')
      }),
      type: 'action'
    },
    capability: 'core-tabs',
    handle: async (context, params, response) => {
      switch (params.action) {
        case 'list': {
          await context.ensureTab();
          response.setIncludeTabs();
          return;
        }
        
        case 'new': {
          await context.newTab();
          const newTabId = context.tabs().length - 1;
          
          response.setIncludeTabs();
          response.addResult(`\n**tabId: ${newTabId}** - Use this with other browser tools.`);
          return;
        }
        
        case 'close': {
          await context.closeTab(params.index);
          response.setIncludeFullSnapshot();
          return;
        }
        
        case 'select': {
          if (params.index === undefined)
            throw new Error('Tab index is required');
          await context.selectTab(params.index);
          response.setIncludeFullSnapshot();
          return;
        }
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
