/**
 * Universal Output Cache
 * 
 * Caches any large text output and provides pagination/search.
 * Used by PatchedResponse to handle all large outputs.
 * 
 * @module output-cache
 */

const crypto = require('crypto');

// Configuration
const CONFIG = {
  maxLines: 100,           // Max lines before caching
  maxCacheSize: 30,
  cacheExpiry: 30 * 60000, // 30 minutes
  defaultPageSize: 50
};

/** @type {Map<string, {content: string, lines: string[], totalLines: number, createdAt: number, toolName: string}>} */
const cache = new Map();

/**
 * Generate cache ID
 */
function generateId() {
  return 'out_' + crypto.randomBytes(4).toString('hex');
}

/**
 * Check if output needs caching
 * @param {string} text
 * @returns {boolean}
 */
function needsCaching(text) {
  if (!text) return false;
  const lineCount = text.split('\n').length;
  return lineCount > CONFIG.maxLines;
}

/**
 * Cache large output
 * @param {string} content
 * @param {string} toolName
 * @returns {{cacheId: string, totalLines: number, preview: string}}
 */
function cacheOutput(content, toolName) {
  // LRU eviction
  if (cache.size >= CONFIG.maxCacheSize) {
    const oldestId = cache.keys().next().value;
    cache.delete(oldestId);
  }
  
  const cacheId = generateId();
  const lines = content.split('\n');
  const totalLines = lines.length;
  
  // Create preview (first 20 lines)
  const preview = lines.slice(0, 20).join('\n');
  
  cache.set(cacheId, {
    content,
    lines,
    totalLines,
    createdAt: Date.now(),
    toolName
  });
  
  // Set expiry
  setTimeout(() => cache.delete(cacheId), CONFIG.cacheExpiry);
  
  return { cacheId, totalLines, preview };
}

/**
 * Get paginated content
 * @param {string} cacheId
 * @param {number} startLine
 * @param {number|null} endLine
 */
function getPaginatedContent(cacheId, startLine = 1, endLine = null) {
  const cached = cache.get(cacheId);
  if (!cached) {
    return { error: `Cache ID '${cacheId}' not found or expired` };
  }
  
  const start = Math.max(1, startLine) - 1;
  const end = endLine ? Math.min(endLine, cached.totalLines) : Math.min(start + CONFIG.defaultPageSize, cached.totalLines);
  
  return {
    content: cached.lines.slice(start, end).join('\n'),
    startLine: start + 1,
    endLine: end,
    totalLines: cached.totalLines,
    hasMore: end < cached.totalLines,
    toolName: cached.toolName
  };
}

/**
 * Search in cached output
 * @param {string} cacheId
 * @param {string} query
 * @param {number} maxResults
 */
function searchInCache(cacheId, query, maxResults = 20) {
  const cached = cache.get(cacheId);
  if (!cached) {
    return { error: `Cache ID '${cacheId}' not found or expired` };
  }
  
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

/**
 * Format cache message for response
 * @param {string} cacheId
 * @param {number} totalLines
 * @param {string} toolName
 * @param {string} preview
 */
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
  formatCacheMessage
};
