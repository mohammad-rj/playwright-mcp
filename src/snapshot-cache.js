/**
 * Snapshot Cache & Pagination System
 *
 * When snapshot output is too large, cache it and allow:
 * - Paginated reading (get_cached_snapshot with line ranges)
 * - Search within cached snapshot
 * - Summary with navigation hints
 */

const crypto = require('crypto');

// In-memory cache for snapshots
const snapshotCache = new Map();

// Configuration
const CONFIG = {
  maxLines: 300,           // Max lines before triggering pagination
  maxCacheSize: 50,        // Max cached snapshots
  cacheExpiry: 30 * 60000, // 30 minutes (sliding window)
  defaultPageSize: 100     // Default lines per page
};

function generateCacheId() {
  return crypto.randomBytes(4).toString('hex');
}

function countLines(text) {
  return text.split('\n').length;
}

function needsPagination(snapshotText) {
  return countLines(snapshotText) > CONFIG.maxLines;
}

/**
 * True LRU eviction — removes the least-recently-accessed entry.
 */
function _evictLRU() {
  let oldestKey = null;
  let oldestAccess = Infinity;
  for (const [key, entry] of snapshotCache) {
    if (entry.lastAccessedAt < oldestAccess) {
      oldestAccess = entry.lastAccessedAt;
      oldestKey = key;
    }
  }
  if (oldestKey) snapshotCache.delete(oldestKey);
}

/**
 * Sliding-window TTL: only delete if not accessed recently.
 * Re-schedules itself while the entry stays hot.
 */
function _scheduleExpiry(cacheId) {
  setTimeout(() => {
    const entry = snapshotCache.get(cacheId);
    if (!entry) return;
    if (Date.now() - entry.lastAccessedAt >= CONFIG.cacheExpiry) {
      snapshotCache.delete(cacheId);
    } else {
      _scheduleExpiry(cacheId); // still in use — reschedule
    }
  }, CONFIG.cacheExpiry);
}

/**
 * Cache a large snapshot and return metadata.
 * Stores lines[] only — content string is never duplicated.
 */
function cacheSnapshot(snapshotText, url, title) {
  if (snapshotCache.size >= CONFIG.maxCacheSize) _evictLRU();

  const cacheId = generateCacheId();
  const lines = snapshotText.split('\n'); // only lines stored, no duplicate content string
  const totalLines = lines.length;
  const structureHints = extractStructureHints(lines);
  const now = Date.now();

  snapshotCache.set(cacheId, {
    lines,
    url,
    title,
    totalLines,
    createdAt: now,
    lastAccessedAt: now,
    structureHints
  });

  _scheduleExpiry(cacheId);

  return { cacheId, totalLines, structureHints };
}

/**
 * Extract structure hints from snapshot
 */
function extractStructureHints(lines) {
  const hints = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.match(/^- (main|nav|header|footer|aside|article|section|iframe|dialog|form)/i)) {
      hints.push({
        line: i + 1,
        element: line.trim().substring(2, 50) + (line.length > 52 ? '...' : '')
      });
    }

    const refMatch = line.match(/\[ref=([a-z0-9]+)\]/);
    if (refMatch && hints.length < 20 && line.match(/(button|link|textbox|checkbox|combobox|table|grid)/i)) {
      hints.push({
        line: i + 1,
        ref: refMatch[1],
        element: line.trim().substring(0, 60) + (line.length > 60 ? '...' : '')
      });
    }
  }

  return hints.slice(0, 15);
}

function getCachedSnapshot(cacheId) {
  const entry = snapshotCache.get(cacheId);
  if (entry) entry.lastAccessedAt = Date.now();
  return entry;
}

function getPaginatedContent(cacheId, startLine = 1, endLine = null) {
  const cached = snapshotCache.get(cacheId);
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
    hasMore: end < cached.totalLines
  };
}

function searchInCache(cacheId, query, maxResults = 10) {
  const cached = snapshotCache.get(cacheId);
  if (!cached) return { error: `Cache ID '${cacheId}' not found or expired` };

  cached.lastAccessedAt = Date.now();
  const results = [];
  const queryLower = query.toLowerCase();

  for (let i = 0; i < cached.lines.length && results.length < maxResults; i++) {
    if (cached.lines[i].toLowerCase().includes(queryLower)) {
      results.push({
        line: i + 1,
        content: cached.lines[i].substring(0, 100) + (cached.lines[i].length > 100 ? '...' : '')
      });
    }
  }

  return { query, totalMatches: results.length, results };
}

function clearAll() {
  snapshotCache.clear();
}

function formatPaginationMessage(cacheId, totalLines, url, title, structureHints) {
  let message = `### Snapshot Too Large - Cached for Navigation\n\n`;
  message += `**Page:** ${title}\n`;
  message += `**URL:** ${url}\n`;
  message += `**Total Lines:** ${totalLines}\n`;
  message += `**Cache ID:** \`${cacheId}\`\n\n`;
  message += `The snapshot is ${totalLines} lines which would consume too many tokens.\n`;
  message += `Use these tools to navigate:\n\n`;
  message += `1. **Get specific lines:**\n`;
  message += `   \`get_cached_snapshot\` with cacheId="${cacheId}", startLine=1, endLine=100\n\n`;
  message += `2. **Search in snapshot:**\n`;
  message += `   \`search_cached_snapshot\` with cacheId="${cacheId}", query="button"\n\n`;

  if (structureHints.length > 0) {
    message += `### Structure Overview (key elements):\n`;
    for (const hint of structureHints) {
      if (hint.ref) {
        message += `- Line ${hint.line}: ${hint.element} [ref=${hint.ref}]\n`;
      } else {
        message += `- Line ${hint.line}: ${hint.element}\n`;
      }
    }
  }

  return message;
}

module.exports = {
  CONFIG,
  needsPagination,
  cacheSnapshot,
  getCachedSnapshot,
  getPaginatedContent,
  searchInCache,
  formatPaginationMessage,
  countLines,
  clearAll
};
