/**
 * Recording Tools for MCP
 * 
 * Provides tools for recording and analyzing browser state changes.
 * 
 * @module recording-tools
 */

const recordingManager = require('./recording-manager');
const { getTabByStringId } = require('./tab-isolation');

// Use zod from playwright-core bundle (compatible with zodToJsonSchema)
const { z } = require('playwright-core/lib/mcpBundle');

/**
 * Create recording tools
 */
function createRecordingTools() {
  
  /**
   * Helper to get snapshot from page
   * Uses Playwright's internal snapshot method or falls back to accessibility API
   */
  async function getPageSnapshot(page) {
    try {
      // Try Playwright MCP's internal method first
      if (typeof page._snapshotForAI === 'function') {
        const snapshot = await page._snapshotForAI({ track: 'response' });
        return snapshot.full || '';
      }
      
      // Fallback to accessibility snapshot
      const snapshot = await page.accessibility.snapshot({ interestingOnly: false });
      if (snapshot) {
        return formatAccessibilityTree(snapshot);
      }
    } catch (e) {
      // Ignore errors
    }
    return '';
  }
  
  /**
   * Format accessibility tree as text
   */
  function formatAccessibilityTree(node, indent = 0) {
    if (!node) return '';
    
    const prefix = '  '.repeat(indent) + '- ';
    let result = prefix + (node.role || 'generic');
    
    if (node.name) result += ` "${node.name}"`;
    if (node.pressed) result += ' [pressed]';
    if (node.disabled) result += ' [disabled]';
    if (node.checked) result += ' [checked]';
    
    result += '\n';
    
    if (node.children) {
      for (const child of node.children) {
        result += formatAccessibilityTree(child, indent + 1);
      }
    }
    
    return result;
  }

  // ============ Tools ============

  const browserActionRecordTool = {
    schema: {
      name: 'browser_action_record',
      title: 'Record browser action',
      description: 'Execute an action and record snapshots over time to capture UI state changes. Use for debugging dynamic content, animations, loading states, or async updates.',
      inputSchema: z.object({
        tabId: z.string().length(6).describe('Tab ID (6-char string) to operate on. REQUIRED. Get this from browser_tabs(action="new").'),
        action: z.enum(['click', 'type', 'navigate', 'press_key', 'wait']).describe('Action to perform'),
        ref: z.string().optional().describe('Element ref for click/type actions'),
        element: z.string().optional().describe('Element description for logging'),
        text: z.string().optional().describe('Text for type action'),
        url: z.string().optional().describe('URL for navigate action'),
        key: z.string().optional().describe('Key for press_key action (e.g., "Enter", "Tab")'),
        durationMs: z.number().optional().describe('Recording duration in ms (default: 10000, max: 30000)'),
        intervalMs: z.number().optional().describe('Snapshot interval in ms (default: 100, min: 50)'),
        stopOnIdleMs: z.number().optional().describe('Stop if no changes for N ms (default: 2000)')
      }),
      type: 'destructive'
    },
    capability: 'core',
    handle: async (context, params, response) => {
      // Validate tabId is provided
      if (!params.tabId || typeof params.tabId !== 'string' || params.tabId.length !== 6) {
        response.addError('tabId (6-char string) is REQUIRED. First call browser_tabs(action="new") to create a tab and get your tabId.');
        return;
      }
      
      // Validate and clamp parameters
      const durationMs = Math.min(params.durationMs || 10000, 30000);
      const intervalMs = Math.max(params.intervalMs || 100, 50);
      const stopOnIdleMs = params.stopOnIdleMs || 2000;
      
      // Create recording
      const recordingId = recordingManager.createRecording(params.action, {
        tabId: params.tabId,
        action: params.action,
        ref: params.ref,
        element: params.element,
        text: params.text ? '[REDACTED]' : undefined,
        url: params.url,
        key: params.key
      });
      
      // Get page from specified tab using string ID
      let page = null;
      try {
        const tab = getTabByStringId(context, params.tabId);
        if (tab?.page) {
          page = tab.page;
        } else {
          page = tab; // tab might be the page directly
        }
      } catch (e) {
        recordingManager.stopRecording(recordingId, 'error');
        response.addError(e.message);
        return;
      }
      
      if (!page) {
        recordingManager.stopRecording(recordingId, 'error');
        response.addError(`Tab "${params.tabId}" not found or has no page.`);
        return;
      }
      
      // Execute action
      try {
        switch (params.action) {
          case 'click':
            if (!params.ref) throw new Error('ref required for click');
            await page.locator(`aria-ref=${params.ref}`).click({ timeout: 5000 });
            break;
            
          case 'type':
            if (!params.ref || !params.text) throw new Error('ref and text required for type');
            await page.locator(`aria-ref=${params.ref}`).fill(params.text);
            break;
            
          case 'navigate':
            if (!params.url) throw new Error('url required for navigate');
            await page.goto(params.url, { waitUntil: 'domcontentloaded' });
            break;
            
          case 'press_key':
            if (!params.key) throw new Error('key required for press_key');
            await page.keyboard.press(params.key);
            break;
            
          case 'wait':
            // No action, just record
            break;
        }
      } catch (e) {
        recordingManager.stopRecording(recordingId, 'error');
        response.addError(`Action failed: ${e.message}`);
        return;
      }
      
      // Record snapshots
      const startTime = Date.now();
      let snapshotCount = 0;
      
      while (Date.now() - startTime < durationMs) {
        try {
          const snapshotText = await getPageSnapshot(page);
          if (snapshotText) {
            const result = recordingManager.addSnapshot(recordingId, snapshotText);
            if (result) snapshotCount++;
          }
          
          // Check idle stop
          if (recordingManager.shouldAutoStop(recordingId, stopOnIdleMs)) {
            recordingManager.stopRecording(recordingId, 'idle');
            break;
          }
        } catch (e) {
          // Continue on snapshot errors
        }
        
        await new Promise(r => setTimeout(r, intervalMs));
      }
      
      // Stop if still recording
      const info = recordingManager.getRecordingInfo(recordingId);
      if (info.isRecording) {
        recordingManager.stopRecording(recordingId, 'timeout');
      }
      
      // Format response
      const finalInfo = recordingManager.getRecordingInfo(recordingId);
      
      let text = `## Recording Complete\n\n`;
      text += `| Property | Value |\n`;
      text += `|----------|-------|\n`;
      text += `| Recording ID | \`${recordingId}\` |\n`;
      text += `| Action | ${params.action} |\n`;
      text += `| Duration | ${finalInfo.durationMs}ms |\n`;
      text += `| Snapshots | ${finalInfo.totalSnapshots} |\n`;
      text += `| Stopped | ${finalInfo.stoppedReason} |\n\n`;
      
      if (finalInfo.significantEvents.length > 0) {
        text += `### Detected Events\n`;
        for (const event of finalInfo.significantEvents) {
          text += `- **${event.timeMs}ms**: ${event.type}${event.details ? ` (${event.details})` : ''}\n`;
        }
        text += '\n';
      }
      
      text += `### Next Steps\n`;
      text += `- View changes: \`browser_recording_diff\` recordingId="${recordingId}" index=1\n`;
      text += `- View snapshot: \`browser_recording_snapshot\` recordingId="${recordingId}" index=0\n`;
      text += `- Search: \`browser_recording_search\` recordingId="${recordingId}" query="..."\n`;
      
      response.addResult(text);
    }
  };

  const browserRecordingDiffTool = {
    schema: {
      name: 'browser_recording_diff',
      title: 'Get recording diff',
      description: 'Calculate diff between two snapshots in a recording. Shows added, removed, and changed elements.',
      inputSchema: z.object({
        recordingId: z.string().describe('Recording ID'),
        index: z.number().describe('Snapshot index to diff (diffs with previous snapshot)'),
        fromIndex: z.number().optional().describe('Explicit from index (overrides default)'),
        toIndex: z.number().optional().describe('Explicit to index (overrides default)')
      }),
      type: 'readOnly'
    },
    capability: 'core',
    handle: async (context, params, response) => {
      let fromIdx = params.fromIndex;
      let toIdx = params.toIndex;
      
      if (fromIdx === undefined && toIdx === undefined) {
        toIdx = params.index;
        fromIdx = Math.max(0, params.index - 1);
      }
      
      const diff = recordingManager.calculateDiff(params.recordingId, fromIdx, toIdx);
      
      if (diff.error) {
        response.addError(diff.error);
        return;
      }
      
      let text = `## Diff: Snapshot ${diff.fromIndex} → ${diff.toIndex}\n\n`;
      text += `**Summary:** +${diff.summary.addedCount} added, -${diff.summary.removedCount} removed, ~${diff.summary.changedCount} changed\n\n`;
      
      if (diff.summary.addedCount + diff.summary.removedCount + diff.summary.changedCount === 0) {
        text += '_No changes detected._\n';
      } else {
        if (diff.added.length > 0) {
          text += `### Added\n`;
          for (const item of diff.added) {
            text += `+ L${item.line}: ${item.content}\n`;
          }
          text += '\n';
        }
        
        if (diff.removed.length > 0) {
          text += `### Removed\n`;
          for (const item of diff.removed) {
            text += `- L${item.line}: ${item.content}\n`;
          }
          text += '\n';
        }
        
        if (diff.changed.length > 0) {
          text += `### Changed Elements\n`;
          for (const item of diff.changed) {
            text += `~ [ref=${item.ref}]\n`;
            text += `  Before: ${item.from}\n`;
            text += `  After: ${item.to}\n`;
          }
        }
      }
      
      response.addResult(text);
    }
  };

  const browserRecordingSnapshotTool = {
    schema: {
      name: 'browser_recording_snapshot',
      title: 'Get recording snapshot',
      description: 'Read a specific snapshot from a recording with optional line range.',
      inputSchema: z.object({
        recordingId: z.string().describe('Recording ID'),
        index: z.number().describe('Snapshot index (0-based)'),
        startLine: z.number().optional().describe('Starting line (1-indexed, default: 1)'),
        endLine: z.number().optional().describe('Ending line (inclusive)')
      }),
      type: 'readOnly'
    },
    capability: 'core',
    handle: async (context, params, response) => {
      const result = recordingManager.getSnapshotPaginated(
        params.recordingId,
        params.index,
        params.startLine || 1,
        params.endLine
      );
      
      if (result.error) {
        response.addError(result.error);
        return;
      }
      
      let text = `## Snapshot ${params.index}\n`;
      text += `Lines ${result.startLine}-${result.endLine} of ${result.totalLines}\n\n`;
      text += '```yaml\n' + result.content + '\n```';
      
      if (result.hasMore) {
        text += `\n\n_More available. Next: startLine=${result.endLine + 1}_`;
      }
      
      response.addResult(text);
    }
  };

  const browserRecordingSearchTool = {
    schema: {
      name: 'browser_recording_search',
      title: 'Search recording',
      description: 'Search for text across all snapshots in a recording.',
      inputSchema: z.object({
        recordingId: z.string().describe('Recording ID'),
        query: z.string().describe('Text to search for'),
        maxResults: z.number().optional().describe('Max results (default: 20)')
      }),
      type: 'readOnly'
    },
    capability: 'core',
    handle: async (context, params, response) => {
      const result = recordingManager.searchRecording(
        params.recordingId,
        params.query,
        params.maxResults || 20
      );
      
      if (result.error) {
        response.addError(result.error);
        return;
      }
      
      let text = `## Search: "${result.query}"\n`;
      text += `Found ${result.totalResults} results\n\n`;
      
      if (result.results.length === 0) {
        text += '_No matches found._\n';
      } else {
        for (const match of result.results) {
          text += `**[${match.snapshotIndex}:${match.line}]** ${match.content}\n`;
        }
      }
      
      response.addResult(text);
    }
  };

  const browserRecordingInfoTool = {
    schema: {
      name: 'browser_recording_info',
      title: 'Get recording info',
      description: 'Get metadata and summary of a recording.',
      inputSchema: z.object({
        recordingId: z.string().describe('Recording ID')
      }),
      type: 'readOnly'
    },
    capability: 'core',
    handle: async (context, params, response) => {
      const info = recordingManager.getRecordingInfo(params.recordingId);
      
      if (info.error) {
        response.addError(info.error);
        return;
      }
      
      let text = `## Recording: ${info.id}\n\n`;
      text += `| Property | Value |\n`;
      text += `|----------|-------|\n`;
      text += `| Action | ${info.actionType} |\n`;
      text += `| Duration | ${info.durationMs}ms |\n`;
      text += `| Snapshots | ${info.totalSnapshots} |\n`;
      text += `| Status | ${info.isRecording ? '🔴 Recording' : `✅ ${info.stoppedReason}`} |\n\n`;
      
      if (info.significantEvents.length > 0) {
        text += `### Events\n`;
        for (const event of info.significantEvents) {
          text += `- ${event.timeMs}ms: ${event.type}\n`;
        }
      }
      
      response.addResult(text);
    }
  };

  const browserRecordingListTool = {
    schema: {
      name: 'browser_recording_list',
      title: 'List recordings',
      description: 'List all active recordings.',
      inputSchema: z.object({}),
      type: 'readOnly'
    },
    capability: 'core',
    handle: async (context, params, response) => {
      const list = recordingManager.listRecordings();
      
      if (list.length === 0) {
        response.addResult('No recordings available.');
        return;
      }
      
      let text = `## Recordings (${list.length})\n\n`;
      text += `| ID | Action | Snapshots | Duration | Status |\n`;
      text += `|----|--------|-----------|----------|--------|\n`;
      
      for (const rec of list) {
        const status = rec.isRecording ? '🔴' : '✅';
        text += `| \`${rec.id}\` | ${rec.actionType} | ${rec.totalSnapshots} | ${rec.durationMs}ms | ${status} |\n`;
      }
      
      response.addResult(text);
    }
  };

  const browserRecordingDeleteTool = {
    schema: {
      name: 'browser_recording_delete',
      title: 'Delete recording',
      description: 'Delete a recording and its snapshots.',
      inputSchema: z.object({
        recordingId: z.string().describe('Recording ID to delete')
      }),
      type: 'destructive'
    },
    capability: 'core',
    handle: async (context, params, response) => {
      const deleted = recordingManager.deleteRecording(params.recordingId);
      
      if (deleted) {
        response.addResult(`Recording ${params.recordingId} deleted.`);
      } else {
        response.addError(`Recording ${params.recordingId} not found.`);
      }
    }
  };

  return [
    browserActionRecordTool,
    browserRecordingDiffTool,
    browserRecordingSnapshotTool,
    browserRecordingSearchTool,
    browserRecordingInfoTool,
    browserRecordingListTool,
    browserRecordingDeleteTool
  ];
}

module.exports = { createRecordingTools };
