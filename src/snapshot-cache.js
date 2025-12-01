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
  cacheExpiry: 30 * 60000, // 30 minutes
  defaultPageSize: 100     // Default lines per page
};

/**
 * Generate short cache ID
 */
function generateCacheId() {
  return crypto.randomBytes(4).toString('hex');
}

/**
 * Count lines in text
 */
function countLines(text) {
  return text.split('\n').length;
}

/**
 * Check if snapshot needs pagination
 */
function needsPagination(snapshotText) {
  return countLines(snapshotText) > CONFIG.maxLines;
}

/**
 * Cache a large snapshot and return metadata
 */
function cacheSnapshot(snapshotText, url, title) {
  // Cleanup old entries if cache is full
  if (snapshotCache.size >= CONFIG.maxCacheSize) {
    const oldestKey = snapshotCache.keys().next().value;
    snapshotCache.delete(oldestKey);
  }

  const cacheId = generateCacheId();
  const lines = snapshotText.split('\n');
  const totalLines = lines.length;
  
  // Extract structure hints (elements with refs)
  const structureHints = extractStructureHints(lines);
  
  snapshotCache.set(cacheId, {
    content: snapshotText,
    lines: lines,
    url: url,
    title: title,
    totalLines: totalLines,
    createdAt: Date.now(),
    structureHints: structureHints
  });

  // Set expiry
  setTimeout(() => {
    snapshotCache.delete(cacheId);
  }, CONFIG.cacheExpiry);

  return {
    cacheId,
    totalLines,
    structureHints
  };
}

/**
 * Extract structure hints from snapshot
 * Finds main sections, iframes, important elements
 */
function extractStructureHints(lines) {
  const hints = [];
  let currentIndent = 0;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Find main structural elements
    if (line.match(/^- (main|nav|header|footer|aside|article|section|iframe|dialog|form)/i)) {
      hints.push({
        line: i + 1,
        element: line.trim().substring(2, 50) + (line.length > 52 ? '...' : '')
      });
    }
    
    // Find elements with refs (interactive elements)
    const refMatch = line.match(/\[ref=([a-z0-9]+)\]/);
    if (refMatch && hints.length < 20) {
      // Only add if it's a significant element
      if (line.match(/(button|link|textbox|checkbox|combobox|table|grid)/i)) {
        hints.push({
          line: i + 1,
          ref: refMatch[1],
          element: line.trim().substring(0, 60) + (line.length > 60 ? '...' : '')
        });
      }
    }
  }
  
  return hints.slice(0, 15); // Limit hints
}

/**
 * Get cached snapshot by ID
 */
function getCachedSnapshot(cacheId) {
  return snapshotCache.get(cacheId);
}

/**
 * Get paginated content from cache
 */
function getPaginatedContent(cacheId, startLine = 1, endLine = null) {
  const cached = snapshotCache.get(cacheId);
  if (!cached) {
    return { error: `Cache ID '${cacheId}' not found or expired` };
  }

  const start = Math.max(1, startLine) - 1; // Convert to 0-indexed
  const end = endLine ? Math.min(endLine, cached.totalLines) : Math.min(start + CONFIG.defaultPageSize, cached.totalLines);
  
  const content = cached.lines.slice(start, end).join('\n');
  
  return {
    content,
    startLine: start + 1,
    endLine: end,
    totalLines: cached.totalLines,
    hasMore: end < cached.totalLines
  };
}

/**
 * Search within cached snapshot
 */
function searchInCache(cacheId, query, maxResults = 10) {
  const cached = snapshotCache.get(cacheId);
  if (!cached) {
    return { error: `Cache ID '${cacheId}' not found or expired` };
  }

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

  return {
    query,
    totalMatches: results.length,
    results
  };
}

/**
 * Format pagination message for LLM
 */
function formatPaginationMessage(cacheId, totalLines, url, title, structureHints) {
  let message = `### Snapshot Too Large - Cached for Navigation

**Page:** ${title}
**URL:** ${url}
**Total Lines:** ${totalLines}
**Cache ID:** \`${cacheId}\`

The snapshot is ${totalLines} lines which would consume too many tokens.
Use these tools to navigate:

1. **Get specific lines:**
   \`get_cached_snapshot\` with cacheId="${cacheId}", startLine=1, endLine=100

2. **Search in snapshot:**
   \`search_cached_snapshot\` with cacheId="${cacheId}", query="button"

`;

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
  countLines
};
