/**
 * Patch the original response.js to use snapshot caching
 * This script modifies the playwright module at runtime
 */

const path = require('path');
const snapshotCache = require('./snapshot-cache');

// Get the original response module
const originalResponsePath = require.resolve('playwright/lib/mcp/browser/response');
const originalResponse = require(originalResponsePath);

// Store original renderTabSnapshot (it's not exported, so we need to patch serialize)
const OriginalResponse = originalResponse.Response;

// Create patched Response class
class PatchedResponse extends OriginalResponse {
  serialize(options = {}) {
    // Call original serialize
    const result = super.serialize(options);
    
    // Check if we have a large snapshot in the response
    if (result.content && result.content[0] && result.content[0].type === 'text') {
      const text = result.content[0].text;
      
      // Find the yaml code block (snapshot)
      const yamlMatch = text.match(/```yaml\n([\s\S]*?)\n```/);
      if (yamlMatch && yamlMatch[1]) {
        const snapshotContent = yamlMatch[1];
        
        // Check if it needs pagination
        if (snapshotCache.needsPagination(snapshotContent)) {
          // Extract page info from the text
          const urlMatch = text.match(/- Page URL: (.+)/);
          const titleMatch = text.match(/- Page Title: (.+)/);
          const url = urlMatch ? urlMatch[1] : 'unknown';
          const title = titleMatch ? titleMatch[1] : 'unknown';
          
          // Cache the snapshot
          const { cacheId, totalLines, structureHints } = snapshotCache.cacheSnapshot(
            snapshotContent,
            url,
            title
          );
          
          // Replace the large snapshot with pagination message
          const paginationMsg = snapshotCache.formatPaginationMessage(
            cacheId, totalLines, url, title, structureHints
          );
          
          // Replace the yaml block with pagination message
          result.content[0].text = text.replace(
            /- Page Snapshot:\n```yaml\n[\s\S]*?\n```/,
            paginationMsg
          );
        }
      }
    }
    
    return result;
  }
}

// Export patched Response
module.exports = {
  Response: PatchedResponse,
  parseResponse: originalResponse.parseResponse,
  requestDebug: originalResponse.requestDebug
};
