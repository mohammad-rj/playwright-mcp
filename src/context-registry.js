/**
 * Context registry
 *
 * Playwright 1.62's internal Context class no longer keeps the static
 * all-contexts set that 1.58 exposed (used back then to reset every live
 * session's cached browser context when the pooled browser died). This
 * module is a fork-owned replacement: CustomBrowserBackend registers its
 * Context on initialize() and unregisters it on dispose(); custom-cli.js's
 * resetActiveContexts() walks this registry instead of the removed set.
 *
 * 1.62 also changed HOW a Context holds its browser, and it takes BOTH of
 * the following to recover from a dead one:
 *   _rawBrowserContext     the context handed in at construction. Fixed in
 *                          1.62 (1.58 built it from a factory), so a dead one
 *                          has to be SWAPPED for a live context, not cleared.
 *   _browserContextPromise the memoised result of ensureBrowserContext(),
 *                          which is what newTab()/tabs() actually use. It
 *                          survives from the previous browser and must be
 *                          dropped, or every later call still resolves to the
 *                          dead context and fails with "Target page, context
 *                          or browser has been closed".
 *
 * Swapping eagerly at disconnect time would relaunch the browser immediately,
 * which defeats the lazy-start behaviour. So resetAll() drops the memoised
 * promise and marks each context stale; CustomBrowserBackend.callTool() does
 * the actual re-resolve on the next tool call, when a browser is genuinely
 * needed again.
 *
 * @module context-registry
 */

// ctx -> the backend that owns it, so a refresh can find the engine to
// re-resolve. Weak so a forgotten unregister cannot leak a Context.
const registry = new Map();

// Marker for "this context's browser died; re-resolve before next use".
const STALE = Symbol.for('ep.playwright-mcp.contextStale');

function register(ctx, backend) {
  if (ctx) registry.set(ctx, backend || null);
}

function unregister(ctx) {
  if (ctx) registry.delete(ctx);
}

/**
 * Mark every registered context stale and drop its tab list. The tabs are
 * gone with the browser, so clearing them now keeps browser_tabs("list")
 * honest even before the next action triggers the re-resolve.
 */
function resetAll() {
  for (const ctx of registry.keys()) {
    ctx[STALE] = true;
    ctx._browserContextPromise = undefined;
    if (Array.isArray(ctx._tabs)) ctx._tabs.length = 0;
    ctx._currentTab = undefined;
  }
}

function isStale(ctx) {
  return !!(ctx && ctx[STALE]);
}

function clearStale(ctx) {
  if (ctx) delete ctx[STALE];
}

function size() {
  return registry.size;
}

module.exports = { register, unregister, resetAll, isStale, clearStale, size, STALE };
