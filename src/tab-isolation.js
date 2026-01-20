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

const fs = require('fs');

// Path for persistent registry
const STORAGE_PATH = path.join(__dirname, '..', '.mcp', 'tabs.json');
const MARKER_NAME = '__KIRO_MANAGED_TAB_ID__';
const HEARTBEAT_TIMEOUT = 5 * 60 * 1000; // 5 minutes inactivity = zombie

/**
 * Update the heartbeat marker in the browser window
 * @param {Page} page - Playwright page
 * @param {string} id - Tab ID
 */
async function updateHeartbeat(page, id) {
  try {
    const now = Date.now();
    await page.evaluate((m, id, time) => {
      window[m] = { id, lastActivity: time };
    }, MARKER_NAME, id, now).catch(() => { });

    // Also update and persist in registry for other sessions to see
    const entry = tabRegistry.get(id);
    if (entry) {
      entry.lastActivity = new Date(now);
      saveRegistry();
    }
  } catch (e) { /* Ignore errors if page is closing */ }
}

/**
 * Tab registry - maps string IDs to actual tab references
 * Key: 6-char string ID
 * Value: { page: Page, createdAt: Date, title: string }
 */
let tabRegistry = new Map();

/**
 * Load registry from disk and map to existing browser tabs
 * @param {Context} context - Playwright context
 */
async function syncRegistryWithBrowser(context) {
  try {
    if (!fs.existsSync(STORAGE_PATH)) return;
    const data = JSON.parse(fs.readFileSync(STORAGE_PATH, 'utf8'));
    const tabs = context.tabs();

    for (const [id, info] of Object.entries(data)) {
      // Find a tab that has this ID in its window metadata
      let found = false;
      for (const tab of tabs) {
        try {
          const page = tab.page || tab;
          const marker = await page.evaluate(m => window[m], MARKER_NAME).catch(() => null);
          const remoteId = (typeof marker === 'object' && marker !== null) ? marker.id : marker;

          if (remoteId === id) {
            tabRegistry.set(id, {
              page: page,
              tab: tab,
              createdAt: new Date(info.createdAt),
              lastActivity: info.lastActivity ? new Date(info.lastActivity) : new Date(info.createdAt),
              title: info.title
            });
            found = true;
            break;
          }
        } catch (e) { /* Tab might be unreachable */ }
      }

      // If NOT found in physical tabs, it might belong to another session
      if (!found) {
        tabRegistry.set(id, {
          createdAt: new Date(info.createdAt),
          lastActivity: info.lastActivity ? new Date(info.lastActivity) : new Date(info.createdAt),
          title: info.title,
          isRemote: true // Flag to indicate it's in another process
        });
      }
    }
  } catch (e) {
    console.error('Failed to sync tab registry:', e);
  }
}

/**
 * Save active registry to disk
 */
function saveRegistry() {
  try {
    const data = {};
    for (const [id, entry] of tabRegistry.entries()) {
      data[id] = {
        createdAt: entry.createdAt,
        title: entry.title,
        lastActivity: entry.lastActivity
      };
    }
    const dir = path.dirname(STORAGE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STORAGE_PATH, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Failed to save tab registry:', e);
  }
}

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
 * Get tab by string ID
 * @param {Context} context - Browser context
 * @param {string} tabId - 6-char tab ID
 * @returns {Tab} Playwright Tab object
 */
function getTabByStringId(context, tabId) {
  const entry = tabRegistry.get(tabId);
  if (!entry) {
    throw new Error(`Tab "${tabId}" not found. It may have been closed or never existed. Use browser_tabs(action="new") to create a new tab.`);
  }

  // Check if page is still valid by trying to access it
  const page = entry.page;
  try {
    // Try to check if page is closed - this works for Playwright Page objects
    if (typeof page.isClosed === 'function' && page.isClosed()) {
      tabRegistry.delete(tabId);
      saveRegistry();
      throw new Error(`Tab "${tabId}" was closed. Use browser_tabs(action="new") to create a new tab.`);
    }

    // Try to access URL as another validity check
    page.url();
  } catch (e) {
    if (e.message && e.message.includes('was closed')) {
      throw e;
    }
    // Page object is invalid (browser closed or page destroyed)
    tabRegistry.delete(tabId);
    saveRegistry();
    throw new Error(`Tab "${tabId}" is no longer valid (browser may have been closed). Use browser_tabs(action="new") to create a new tab.`);
  }

  // Return the tab object for Playwright MCP compatibility
  return entry.tab || entry.page;
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
        const tab = getTabByStringId(target, tabId);
        if (tab && tab.page) updateHeartbeat(tab.page, tabId);
        return () => tab;
      }

      if (prop === 'currentTabOrDie') {
        const tab = getTabByStringId(target, tabId);
        if (tab && tab.page) updateHeartbeat(tab.page, tabId);
        return () => tab;
      }

      if (prop === 'ensureTab') {
        return async () => {
          const tab = getTabByStringId(target, tabId);
          if (tab && tab.page) await updateHeartbeat(tab.page, tabId);
          return tab;
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

      // Update heartbeat before execution
      const entry = tabRegistry.get(tabId);
      if (entry && entry.page) await updateHeartbeat(entry.page, tabId);

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
 * @returns {Object} Enhanced tabs tool
 */
function createEnhancedTabsTool() {
  return {
    schema: {
      name: 'browser_tabs',
      title: 'Manage tabs',
      description: 'Tab management. Use "new" to create, "list" to see status, "close" to terminate, "reclaim" to take over an orphan AI tab, or "purge_zombies" to close all abandoned AI tabs.',
      inputSchema: z.object({
        action: z.enum(['new', 'close', 'list', 'reclaim', 'purge_zombies']).describe('Operation: "new", "close", "list", "reclaim", or "purge_zombies"'),
        tabId: z.string().length(6).optional().describe('Tab ID (6-char string) to close/reclaim'),
        tabIndex: z.number().optional().describe('Tab index for reclaim action')
      }),
      type: 'action'
    },
    capability: 'core-tabs',
    handle: async (context, params, response) => {
      // Ensure current process state matches browser state
      if (tabRegistry.size === 0) {
        await syncRegistryWithBrowser(context);
      }

      switch (params.action) {
        case 'new': {
          let tabs = context.tabs();
          let debugMsg = `Total visible tabs initially: ${tabs.length}`;
          if (tabs.length === 0) {
            await new Promise(r => setTimeout(r, 300));
            tabs = context.tabs();
            debugMsg += ` -> after wait: ${tabs.length}`;
          }
          let tab;
          let isReclaimed = false;

          // Optimization: Search for any existing blank, unmanaged tab to reuse
          for (const candidate of tabs) {
            const page = candidate.page || candidate;
            const marker = await page.evaluate(m => window[m], MARKER_NAME).catch(() => null);
            const url = page.url();

            const isBlank = (
              url === 'about:blank' ||
              url === '' ||
              url.startsWith('chrome://newtab') ||
              url.startsWith('chrome://new-tab-page')
            );

            if (!marker && isBlank) {
              tab = candidate;
              break;
            }
          }

          if (!tab) {
            tab = await context.newTab();
          }

          const tabId = generateTabId();
          const page = tab.page || tab;

          // Aggressive Cleanup: If we now have multiple tabs and some are still blank/unmanaged, close them
          // to prevent that annoying "extra blank tab" from staying open.
          const finalTabs = context.tabs();
          if (finalTabs.length > 1) {
            for (let i = 0; i < finalTabs.length; i++) {
              const t = finalTabs[i];
              if (t === tab) continue; // Keep our new tab

              const p = t.page || t;
              const marker = await p.evaluate(m => window[m], MARKER_NAME).catch(() => null);
              const url = p.url();

              if (!marker && (url === 'about:blank' || url === '')) {
                await context.closeTab(i).catch(() => { });
                debugMsg += ` (Auto-closed blank ghost tab at index ${i})`;
              }
            }
          }

          // Inject persistent marker that survives navigation
          if (typeof page.addInitScript === 'function') {
            await page.addInitScript((m, id, time) => {
              window[m] = { id, lastActivity: time };
            }, MARKER_NAME, tabId, Date.now());
            // Also set it immediately for current page
            await page.evaluate((m, id, time) => {
              window[m] = { id, lastActivity: time };
            }, MARKER_NAME, tabId, Date.now()).catch(() => { });
          }

          tabRegistry.set(tabId, {
            page: page,
            tab: tab,
            createdAt: new Date(),
            lastActivity: new Date(),
            title: 'New Tab'
          });

          saveRegistry();

          page.on('close', () => {
            tabRegistry.delete(tabId);
            saveRegistry();
          });

          page.on('load', async () => {
            const entry = tabRegistry.get(tabId);
            if (entry) {
              entry.title = await page.title().catch(() => 'Untitled');
              saveRegistry();
              await updateHeartbeat(page, tabId);
            }
          });

          let resultMsg = `## Tab Created\n**tabId: \`${tabId}\`**`;
          if (debugMsg) resultMsg += `\n\n_${debugMsg}_`;
          response.addResult(resultMsg);
          return;
        }

        case 'reclaim': {
          const tabs = context.tabs();
          const index = params.tabIndex;
          if (index === undefined) throw new Error('tabIndex is required for reclaim.');
          const tab = tabs[index];
          if (!tab) throw new Error(`Tab index ${index} not found.`);

          const page = tab.page || tab;
          const marker = await page.evaluate(m => window[m], MARKER_NAME).catch(() => null);
          const orphanId = (typeof marker === 'object' && marker !== null) ? marker.id : marker;

          if (!orphanId) {
            throw new Error('This is a USER PRIVILEGED tab and cannot be reclaimed. Hands off.');
          }

          const lastActivity = (marker && marker.lastActivity) || 0;
          if (Date.now() - lastActivity < HEARTBEAT_TIMEOUT) {
            throw new Error('This tab is currently ACTIVE (Managed by another model). Cannot reclaim.');
          }

          // Generate new ID or keep old one
          const newId = generateTabId();
          await page.evaluate((m, id, time) => {
            window[m] = { id, lastActivity: time };
          }, MARKER_NAME, newId, Date.now());

          tabRegistry.set(newId, {
            page: page,
            tab: tab,
            createdAt: new Date(),
            lastActivity: new Date(),
            title: await page.title().catch(() => 'Reclaimed Tab')
          });
          saveRegistry();

          response.addResult(`## Tab Reclaimed\nNew ID: \`${newId}\``);
          return;
        }

        case 'purge_zombies': {
          const tabs = context.tabs();
          let count = 0;
          const toClose = [];
          const now = Date.now();

          for (let i = 0; i < tabs.length; i++) {
            const tab = tabs[i];
            const page = tab.page || tab;
            const marker = await page.evaluate(m => window[m], MARKER_NAME).catch(() => null);

            if (!marker) continue;

            const lastActivity = (marker && marker.lastActivity) || 0;
            const isManagedLocally = [...tabRegistry.values()].some(e => e.page === page);

            // Zombie: Has marker, Not managed locally, AND last activity > 5 mins ago
            if (!isManagedLocally && (now - lastActivity > HEARTBEAT_TIMEOUT)) {
              toClose.push(i);
            }
          }

          // Close from highest index down to avoid index shifts
          for (const idx of toClose.sort((a, b) => b - a)) {
            await context.closeTab(idx);
            count++;
          }

          response.addResult(`Purged ${count} abandoned AI tabs. Active AI tabs and User tabs were protected.`);
          return;
        }

        case 'close': {
          if (!params.tabId) throw new Error('tabId required.');
          const entry = tabRegistry.get(params.tabId);
          if (!entry) throw new Error('Tab not found.');

          const tabs = context.tabs();
          const idx = tabs.findIndex(t => t === entry.tab || t === entry.page || t.page === entry.page);
          if (idx !== -1) await context.closeTab(idx);

          tabRegistry.delete(params.tabId);
          saveRegistry();
          response.addResult(`Closed \`${params.tabId}\`.`);
          return;
        }

        case 'list': {
          const tabs = context.tabs();
          let output = `## Tab Report\n\n`;
          const rows = [];

          // Part 1: Physical Tabs in THIS context
          const identifiedPhysicalPageIds = new Set();
          for (let i = 0; i < tabs.length; i++) {
            const tab = tabs[i];
            const page = tab.page || tab;
            const marker = await page.evaluate(m => window[m], MARKER_NAME).catch(() => null);
            const managedId = [...tabRegistry.entries()].find(([_, e]) => e.page === page)?.[0];

            let status = 'User (Secure)';
            let idDisp = '-';

            if (managedId) {
              status = '**Managed (Active)**';
              idDisp = `\`${managedId}\``;
              identifiedPhysicalPageIds.add(managedId);
            } else if (marker) {
              const lastActivity = marker.lastActivity || 0;
              const id = marker.id || 'unknown';
              if (Date.now() - lastActivity < HEARTBEAT_TIMEOUT) {
                status = '**Active (Other Model)**';
              } else {
                status = '_Orphan (Zombie)_';
              }
              idDisp = `\`${id}\``;
              identifiedPhysicalPageIds.add(id);
            }

            const title = tab.lastTitle?.() || await page.title().catch(() => 'Untitled');
            const url = page.url();
            rows.push(`| ${i} | ${idDisp} | ${status} | ${title} | \`${url}\` |`);
          }

          // Part 2: Ghost Tabs (Managed by other parallel MCP processes)
          // We know about these from the shared registry file
          for (const [id, entry] of tabRegistry.entries()) {
            if (identifiedPhysicalPageIds.has(id)) continue;

            const now = Date.now();
            const lastActivity = entry.lastActivity ? new Date(entry.lastActivity).getTime() : 0;

            let status = '';
            if (now - lastActivity < HEARTBEAT_TIMEOUT) {
              status = '**Active (Other Session)**';
            } else {
              status = '_Orphan (Zombie)_';
            }

            rows.push(`| - | \`${id}\` | ${status} | ${entry.title || 'Unknown'} (Remote Window) | - |`);
          }

          output += `| Index | Tab ID | Status | Title | URL |\n|---|---|---|---|---|\n` + rows.join('\n');
          output += `\n\n**Guidelines:**\n- **User (Secure):** Private user tabs. DO NOT TOUCH.\n- **Active (Other Model/Session):** AI tabs in use by another session. DO NOT TOUCH.\n- **Orphan (Zombie):** Abandoned AI tabs. Clean with \`purge_zombies\`.`;

          response.addResult(output);
          return;
        }

        default:
          throw new Error('Invalid action.');
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
