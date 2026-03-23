/**
 * Universal Output Cache
 *
 * Caches any large text output and provides pagination/search.
 * Used by PatchedResponse to handle all large outputs.
 *
 * @module output-cache
 */

const crypto = require('crypto');

const CONFIG = {
  maxLines: 100,
  maxCacheSize: 30,
  cacheExpiry: 30 * 60000, // 30 minutes (sliding window)
  defaultPageSize: 50
};

/** @type {Map<string, {lines: string[], totalLines: number, createdAt: number, lastAccessedAt: number, toolName: string}>} */
const cache = new Map();

function generateId() {
  return 'out_' + crypto.randomBytes(4).toString('hex');
}

function needsCaching(text) {
  if (!text) return false;
  return text.split('\n').length > CONFIG.maxLines;
}

/**
 * True LRU eviction — removes the least-recently-accessed entry.
 */
function _evictLRU() {
  let oldestKey = null;
  let oldestAccess = Infinity;
  for (const [key, entry] of cache) {
    if (entry.lastAccessedAt < oldestAccess) {
      oldestAccess = entry.lastAccessedAt;
      oldestKey = key;
    }
  }
  if (oldestKey) cache.delete(oldestKey);
}

/**
 * Sliding-window TTL: only delete if not accessed recently.
 */
function _scheduleExpiry(cacheId) {
  setTimeout(() => {
    const entry = cache.get(cacheId);
    if (!entry) return;
    if (Date.now() - entry.lastAccessedAt >= CONFIG.cacheExpiry) {
      cache.delete(cacheId);
    } else {
      _scheduleExpiry(cacheId);
    }
  }, CONFIG.cacheExpiry);
}

/**
 * Cache large output.
 * Stores lines[] only — content string is never duplicated.
 */
function cacheOutput(content, toolName) {
  if (cache.size >= CONFIG.maxCacheSize) _evictLRU();

  const cacheId = generateId();
  const lines = content.split('\n'); // only lines stored, no duplicate content string
  const totalLines = lines.length;
  const preview = lines.slice(0, 20).join('\n');
  const now = Date.now();

  cache.set(cacheId, {
    lines,
    totalLines,
    createdAt: now,
    lastAccessedAt: now,
    toolName
  });

  _scheduleExpiry(cacheId);

  return { cacheId, totalLines, preview };
}

function getPaginatedContent(cacheId, startLine = 1, endLine = null) {
  const cached = cache.get(cacheId);
  if (!cached) return { error: `Cache ID '${cacheId}' not found or expired` };

  cached.lastAccessedAt = Date.now();
  const start = Math.max(1, startLine) - 1;
  const end = endLine
    ? Math.min(endLine, cached.totalLines)
    : Math.min(start + CONFIG.defaultPageSize, cached.totalLines);

  return {
    content: cached.lines.slice(start, end).join('\n'),
    startLine: start + 1,
    endLine: end,
    totalLines: cached.totalLines,
    hasMore: end < cached.totalLines,
    toolName: cached.toolName
  };
}

function searchInCache(cacheId, query, maxResults = 20) {
  const cached = cache.get(cacheId);
  if (!cached) return { error: `Cache ID '${cacheId}' not found or expired` };

  cached.lastAccessedAt = Date.now();
  const results = [];
  const queryLower = query.toLowerCase();

  for (let i = 0; i < cached.lines.length && results.length < maxResults; i++) {
    if (cached.lines[i].toLowerCase().includes(queryLower)) {
      results.push({
        line: i + 1,
        content: cached.lines[i].substring(0, 150) + (cached.lines[i].length > 150 ? '...' : '')
      });
    }
  }

  return { query, totalMatches: results.length, results };
}

function clearAll() {
  cache.clear();
}

function formatCacheMessage(cacheId, totalLines, toolName, preview) {
  let msg = `## Output Too Large - Cached\n\n`;
  msg += `**Tool:** ${toolName}\n`;
  msg += `**Total Lines:** ${totalLines}\n`;
  msg += `**Cache ID:** \`${cacheId}\`\n\n`;
  msg += `### Preview (first 20 lines)\n`;
  msg += '```\n' + preview + '\n```\n\n';
  msg += `### Commands\n`;
  msg += `- **Get lines:** \`get_cached_output\` cacheId="${cacheId}" startLine=1 endLine=50\n`;
  msg += `- **Search:** \`search_cached_output\` cacheId="${cacheId}" query="..."\n`;
  return msg;
}

module.exports = {
  CONFIG,
  needsCaching,
  cacheOutput,
  getPaginatedContent,
  searchInCache,
  formatCacheMessage,
  clearAll
};
