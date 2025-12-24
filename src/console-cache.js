/**
 * Console Message Cache System
 * 
 * Caches large console outputs and provides:
 * - Paginated reading
 * - Search by text
 * - Filter by type (error, warning, log, info)
 * - Statistics summary
 * 
 * @module console-cache
 */

const crypto = require('crypto');

/** @typedef {'error'|'warning'|'log'|'info'|'debug'} MessageType */

/**
 * @typedef {Object} CachedMessage
 * @property {number} index - Original index
 * @property {MessageType} type - Message type
 * @property {string} text - Message text
 * @property {string} [location] - Source location
 * @property {number} timestamp - Capture time
 */

/**
 * @typedef {Object} ConsoleCache
 * @property {CachedMessage[]} messages
 * @property {Object} stats
 * @property {number} createdAt
 */

// Configuration
const CONFIG = {
  maxCacheSize: 20,
  cacheExpiry: 30 * 60000, // 30 minutes
  defaultPageSize: 50,
  maxLineLength: 500
};

/** @type {Map<string, ConsoleCache>} */
const cache = new Map();

/**
 * Generate cache ID
 * @returns {string}
 */
function generateId() {
  return 'con_' + crypto.randomBytes(4).toString('hex');
}

/**
 * Truncate string
 * @param {string} str
 * @param {number} maxLen
 * @returns {string}
 */
function truncate(str, maxLen = CONFIG.maxLineLength) {
  if (!str) return '';
  return str.length <= maxLen ? str : str.substring(0, maxLen) + '...';
}

/**
 * Normalize message type
 * @param {string} type
 * @returns {MessageType}
 */
function normalizeType(type) {
  const t = (type || 'log').toLowerCase();
  if (t === 'error' || t === 'assert') return 'error';
  if (t === 'warning' || t === 'warn') return 'warning';
  if (t === 'info') return 'info';
  if (t === 'debug' || t === 'trace') return 'debug';
  return 'log';
}

/**
 * Cache console messages
 * @param {Array} messages - Raw console messages from Playwright
 * @returns {{cacheId: string, stats: Object}}
 */
function cacheConsoleMessages(messages) {
  // LRU eviction
  if (cache.size >= CONFIG.maxCacheSize) {
    const oldestId = cache.keys().next().value;
    cache.delete(oldestId);
  }
  
  const cacheId = generateId();
  const stats = { total: 0, errors: 0, warnings: 0, logs: 0, info: 0, debug: 0 };
  
  /** @type {CachedMessage[]} */
  const cached = [];
  
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const type = normalizeType(msg.type?.() || msg.type || 'log');
    const text = typeof msg.text === 'function' ? msg.text() : (msg.text || String(msg));
    const location = msg.location?.() || msg.location;
    
    cached.push({
      index: i,
      type,
      text,
      location: location ? `${location.url}:${location.lineNumber}` : undefined,
      timestamp: Date.now()
    });
    
    stats.total++;
    if (type === 'error') stats.errors++;
    else if (type === 'warning') stats.warnings++;
    else if (type === 'info') stats.info++;
    else if (type === 'debug') stats.debug++;
    else stats.logs++;
  }
  
  cache.set(cacheId, {
    messages: cached,
    stats,
    createdAt: Date.now()
  });
  
  // Set expiry
  setTimeout(() => cache.delete(cacheId), CONFIG.cacheExpiry);
  
  return { cacheId, stats };
}

/**
 * Get paginated messages
 * @param {string} cacheId
 * @param {number} startLine
 * @param {number|null} endLine
 */
function getPaginatedMessages(cacheId, startLine = 1, endLine = null) {
  const cached = cache.get(cacheId);
  if (!cached) {
    return { error: `Cache ID '${cacheId}' not found or expired` };
  }
  
  const start = Math.max(1, startLine) - 1;
  const end = endLine ? Math.min(endLine, cached.messages.length) : Math.min(start + CONFIG.defaultPageSize, cached.messages.length);
  
  return {
    messages: cached.messages.slice(start, end),
    startLine: start + 1,
    endLine: end,
    totalLines: cached.messages.length,
    hasMore: end < cached.messages.length,
    stats: cached.stats
  };
}

/**
 * Get messages by type
 * @param {string} cacheId
 * @param {MessageType} type
 * @param {number} maxResults
 */
function getMessagesByType(cacheId, type, maxResults = 50) {
  const cached = cache.get(cacheId);
  if (!cached) {
    return { error: `Cache ID '${cacheId}' not found or expired` };
  }
  
  const filtered = cached.messages.filter(m => m.type === type);
  
  return {
    results: filtered.slice(0, maxResults),
    totalMatches: filtered.length,
    returned: Math.min(filtered.length, maxResults)
  };
}

/**
 * Search in console messages
 * @param {string} cacheId
 * @param {string} query
 * @param {Object} options
 */
function searchInConsole(cacheId, query, options = {}) {
  const cached = cache.get(cacheId);
  if (!cached) {
    return { error: `Cache ID '${cacheId}' not found or expired` };
  }
  
  const { maxResults = 30, type = null, caseSensitive = false } = options;
  const results = [];
  const searchQuery = caseSensitive ? query : query.toLowerCase();
  
  for (const msg of cached.messages) {
    if (results.length >= maxResults) break;
    if (type && msg.type !== type) continue;
    
    const text = caseSensitive ? msg.text : msg.text.toLowerCase();
    if (text.includes(searchQuery)) {
      results.push({
        line: msg.index + 1,
        type: msg.type,
        text: truncate(msg.text, 200),
        location: msg.location
      });
    }
  }
  
  return {
    query,
    totalMatches: results.length,
    results
  };
}

/**
 * Get cache stats
 * @param {string} cacheId
 */
function getCacheStats(cacheId) {
  const cached = cache.get(cacheId);
  if (!cached) {
    return { error: `Cache ID '${cacheId}' not found or expired` };
  }
  return cached.stats;
}

/**
 * Check if messages need caching (too many)
 * @param {number} count
 * @returns {boolean}
 */
function needsCaching(count) {
  return count > 50;
}

module.exports = {
  CONFIG,
  cacheConsoleMessages,
  getPaginatedMessages,
  getMessagesByType,
  searchInConsole,
  getCacheStats,
  needsCaching
};
