/**
 * Snapshot Recording Manager
 * 
 * Records browser state changes over time after actions.
 * Enables debugging dynamic UI by capturing snapshots at intervals
 * and providing diff/search capabilities.
 * 
 * @module recording-manager
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/** @typedef {'idle'|'timeout'|'manual'|'error'|'max_snapshots'} StopReason */
/** @typedef {'loading_started'|'loading_ended'|'dialog_appeared'|'dialog_closed'|'error_appeared'|'content_changed'} EventType */

/**
 * @typedef {Object} SignificantEvent
 * @property {number} timeMs - Relative time from recording start
 * @property {EventType} type - Event type
 * @property {string} [details] - Optional details
 */

/**
 * @typedef {Object} Recording
 * @property {string} id - Unique recording ID
 * @property {string} actionType - Action that triggered recording
 * @property {Object} actionParams - Parameters of the action
 * @property {number} startedAt - Unix timestamp
 * @property {number|null} endedAt - Unix timestamp or null if active
 * @property {StopReason|null} stoppedReason
 * @property {number} totalSnapshots
 * @property {string[]} snapshotHashes - MD5 hashes for change detection
 * @property {SignificantEvent[]} significantEvents
 * @property {string} dir - Directory path
 * @property {boolean} isRecording
 * @property {number} lastChangeAt - Last content change timestamp
 */

// Configuration
const CONFIG = {
  maxRecordings: 5,
  maxSnapshots: 200,
  defaultDurationMs: 10000,
  defaultIntervalMs: 100,
  idleStopMs: 2000,
  recordingsDir: path.join(__dirname, '..', 'recordings'),
  maxLineLength: 200
};

/** @type {Map<string, Recording>} */
const recordings = new Map();

/**
 * Ensure recordings directory exists
 */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Generate unique recording ID
 * @returns {string}
 */
function generateId() {
  return 'rec_' + crypto.randomBytes(6).toString('hex');
}

/**
 * Calculate MD5 hash of content
 * @param {string} content
 * @returns {string}
 */
function hash(content) {
  return crypto.createHash('md5').update(content).digest('hex').substring(0, 8);
}

/**
 * Truncate string to max length
 * @param {string} str
 * @param {number} maxLen
 * @returns {string}
 */
function truncate(str, maxLen = CONFIG.maxLineLength) {
  return str.length <= maxLen ? str : str.substring(0, maxLen) + '...';
}

/**
 * Save recording metadata to disk
 * @param {Recording} recording
 */
function saveMetadata(recording) {
  const metadataPath = path.join(recording.dir, 'metadata.json');
  fs.writeFileSync(metadataPath, JSON.stringify({
    id: recording.id,
    actionType: recording.actionType,
    actionParams: recording.actionParams,
    startedAt: recording.startedAt,
    endedAt: recording.endedAt,
    stoppedReason: recording.stoppedReason,
    totalSnapshots: recording.totalSnapshots,
    significantEvents: recording.significantEvents
  }, null, 2));
}

/**
 * Detect significant events between two snapshots
 * @param {string} prev - Previous snapshot content
 * @param {string} curr - Current snapshot content
 * @param {number} timeMs - Relative time
 * @returns {SignificantEvent[]}
 */
function detectEvents(prev, curr, timeMs) {
  const events = [];
  const prevLower = prev.toLowerCase();
  const currLower = curr.toLowerCase();
  
  // Loading state changes
  const loadingPatterns = ['loading', 'spinner', 'skeleton', 'progressbar'];
  for (const pattern of loadingPatterns) {
    if (!prevLower.includes(pattern) && currLower.includes(pattern)) {
      events.push({ timeMs, type: 'loading_started', details: pattern });
      break;
    }
    if (prevLower.includes(pattern) && !currLower.includes(pattern)) {
      events.push({ timeMs, type: 'loading_ended', details: pattern });
      break;
    }
  }
  
  // Dialog/Modal changes
  const dialogPatterns = ['dialog', 'modal', 'alertdialog', 'popup'];
  for (const pattern of dialogPatterns) {
    if (!prevLower.includes(pattern) && currLower.includes(pattern)) {
      events.push({ timeMs, type: 'dialog_appeared', details: pattern });
      break;
    }
    if (prevLower.includes(pattern) && !currLower.includes(pattern)) {
      events.push({ timeMs, type: 'dialog_closed', details: pattern });
      break;
    }
  }
  
  // Error detection
  if (!prevLower.includes('error') && currLower.includes('error')) {
    events.push({ timeMs, type: 'error_appeared' });
  }
  
  return events;
}

/**
 * Extract element refs from snapshot lines
 * @param {string[]} lines
 * @returns {Map<string, string>}
 */
function extractRefs(lines) {
  const refs = new Map();
  for (const line of lines) {
    const match = line.match(/\[ref=([a-z0-9]+)\]/i);
    if (match) {
      refs.set(match[1], line.trim());
    }
  }
  return refs;
}

// ============ Public API ============

/**
 * Create a new recording session
 * @param {string} actionType - Type of action (click, type, navigate, etc.)
 * @param {Object} actionParams - Action parameters
 * @returns {string} Recording ID
 */
function createRecording(actionType, actionParams) {
  ensureDir(CONFIG.recordingsDir);
  
  // LRU eviction
  if (recordings.size >= CONFIG.maxRecordings) {
    const oldestId = recordings.keys().next().value;
    deleteRecording(oldestId);
  }
  
  const id = generateId();
  const dir = path.join(CONFIG.recordingsDir, id);
  ensureDir(dir);
  ensureDir(path.join(dir, 'snapshots'));
  
  /** @type {Recording} */
  const recording = {
    id,
    actionType,
    actionParams,
    startedAt: Date.now(),
    endedAt: null,
    stoppedReason: null,
    totalSnapshots: 0,
    snapshotHashes: [],
    significantEvents: [],
    dir,
    isRecording: true,
    lastChangeAt: Date.now()
  };
  
  recordings.set(id, recording);
  saveMetadata(recording);
  
  return id;
}

/**
 * Add a snapshot to an active recording
 * @param {string} recordingId
 * @param {string} content - Snapshot content
 * @returns {{index: number, hasChanged: boolean, hash: string}|null}
 */
function addSnapshot(recordingId, content) {
  const rec = recordings.get(recordingId);
  if (!rec || !rec.isRecording) return null;
  
  // Check max snapshots
  if (rec.totalSnapshots >= CONFIG.maxSnapshots) {
    stopRecording(recordingId, 'max_snapshots');
    return null;
  }
  
  const index = rec.totalSnapshots;
  const contentHash = hash(content);
  const hasChanged = rec.snapshotHashes.length === 0 || 
                     rec.snapshotHashes[rec.snapshotHashes.length - 1] !== contentHash;
  
  if (hasChanged) {
    rec.lastChangeAt = Date.now();
    
    // Detect events
    if (index > 0) {
      const prevContent = readSnapshot(recordingId, index - 1);
      if (prevContent) {
        const timeMs = Date.now() - rec.startedAt;
        const events = detectEvents(prevContent, content, timeMs);
        rec.significantEvents.push(...events);
      }
    }
  }
  
  // Save snapshot
  const snapshotPath = path.join(rec.dir, 'snapshots', `${String(index).padStart(4, '0')}.txt`);
  fs.writeFileSync(snapshotPath, content, 'utf8');
  
  rec.snapshotHashes.push(contentHash);
  rec.totalSnapshots++;
  saveMetadata(rec);
  
  return { index, hasChanged, hash: contentHash };
}

/**
 * Stop a recording
 * @param {string} recordingId
 * @param {StopReason} reason
 * @returns {Object|null} Recording info
 */
function stopRecording(recordingId, reason = 'manual') {
  const rec = recordings.get(recordingId);
  if (!rec) return null;
  
  rec.isRecording = false;
  rec.endedAt = Date.now();
  rec.stoppedReason = reason;
  saveMetadata(rec);
  
  return getRecordingInfo(recordingId);
}

/**
 * Check if recording should auto-stop due to idle
 * @param {string} recordingId
 * @param {number} idleMs
 * @returns {boolean}
 */
function shouldAutoStop(recordingId, idleMs = CONFIG.idleStopMs) {
  const rec = recordings.get(recordingId);
  if (!rec || !rec.isRecording) return false;
  return Date.now() - rec.lastChangeAt >= idleMs;
}

/**
 * Read a snapshot from disk
 * @param {string} recordingId
 * @param {number} index
 * @returns {string|null}
 */
function readSnapshot(recordingId, index) {
  const rec = recordings.get(recordingId);
  if (!rec) return null;
  
  const snapshotPath = path.join(rec.dir, 'snapshots', `${String(index).padStart(4, '0')}.txt`);
  if (!fs.existsSync(snapshotPath)) return null;
  
  return fs.readFileSync(snapshotPath, 'utf8');
}

/**
 * Get paginated snapshot content
 * @param {string} recordingId
 * @param {number} index
 * @param {number} startLine
 * @param {number|null} endLine
 */
function getSnapshotPaginated(recordingId, index, startLine = 1, endLine = null) {
  const content = readSnapshot(recordingId, index);
  if (!content) {
    return { error: `Snapshot ${index} not found in recording ${recordingId}` };
  }
  
  const lines = content.split('\n');
  const totalLines = lines.length;
  const start = Math.max(1, startLine) - 1;
  const end = endLine ? Math.min(endLine, totalLines) : Math.min(start + 100, totalLines);
  
  return {
    content: lines.slice(start, end).join('\n'),
    startLine: start + 1,
    endLine: end,
    totalLines,
    hasMore: end < totalLines
  };
}

/**
 * Calculate diff between two snapshots
 * @param {string} recordingId
 * @param {number} fromIndex
 * @param {number|null} toIndex - If null, diffs with fromIndex-1
 */
function calculateDiff(recordingId, fromIndex, toIndex = null) {
  const rec = recordings.get(recordingId);
  if (!rec) {
    return { error: `Recording ${recordingId} not found` };
  }
  
  if (toIndex === null) {
    toIndex = fromIndex;
    fromIndex = Math.max(0, fromIndex - 1);
  }
  
  const fromContent = readSnapshot(recordingId, fromIndex);
  const toContent = readSnapshot(recordingId, toIndex);
  
  if (!fromContent || !toContent) {
    return { error: 'Snapshot not found' };
  }
  
  const fromLines = fromContent.split('\n');
  const toLines = toContent.split('\n');
  const fromSet = new Set(fromLines);
  const toSet = new Set(toLines);
  
  const added = [];
  const removed = [];
  const changed = [];
  
  // Find added lines
  toLines.forEach((line, i) => {
    if (!fromSet.has(line)) {
      added.push({ line: i + 1, content: truncate(line) });
    }
  });
  
  // Find removed lines
  fromLines.forEach((line, i) => {
    if (!toSet.has(line)) {
      removed.push({ line: i + 1, content: truncate(line) });
    }
  });
  
  // Find changed elements (same ref, different content)
  const fromRefs = extractRefs(fromLines);
  const toRefs = extractRefs(toLines);
  
  for (const [ref, fromLine] of fromRefs) {
    if (toRefs.has(ref) && toRefs.get(ref) !== fromLine) {
      changed.push({
        ref,
        from: truncate(fromLine, 80),
        to: truncate(toRefs.get(ref), 80)
      });
    }
  }
  
  return {
    fromIndex,
    toIndex,
    summary: {
      addedCount: added.length,
      removedCount: removed.length,
      changedCount: changed.length
    },
    added: added.slice(0, 30),
    removed: removed.slice(0, 30),
    changed: changed.slice(0, 30)
  };
}

/**
 * Search across all snapshots in a recording
 * @param {string} recordingId
 * @param {string} query
 * @param {number} maxResults
 */
function searchRecording(recordingId, query, maxResults = 20) {
  const rec = recordings.get(recordingId);
  if (!rec) {
    return { error: `Recording ${recordingId} not found` };
  }
  
  const results = [];
  const queryLower = query.toLowerCase();
  
  for (let i = 0; i < rec.totalSnapshots && results.length < maxResults; i++) {
    const content = readSnapshot(recordingId, i);
    if (!content) continue;
    
    const lines = content.split('\n');
    for (let j = 0; j < lines.length && results.length < maxResults; j++) {
      if (lines[j].toLowerCase().includes(queryLower)) {
        results.push({
          snapshotIndex: i,
          line: j + 1,
          content: truncate(lines[j])
        });
      }
    }
  }
  
  return { query, totalResults: results.length, results };
}

/**
 * Get recording metadata
 * @param {string} recordingId
 */
function getRecordingInfo(recordingId) {
  const rec = recordings.get(recordingId);
  if (!rec) {
    return { error: `Recording ${recordingId} not found` };
  }
  
  return {
    id: rec.id,
    actionType: rec.actionType,
    actionParams: rec.actionParams,
    startedAt: rec.startedAt,
    endedAt: rec.endedAt,
    durationMs: rec.endedAt ? rec.endedAt - rec.startedAt : Date.now() - rec.startedAt,
    stoppedReason: rec.stoppedReason,
    totalSnapshots: rec.totalSnapshots,
    isRecording: rec.isRecording,
    significantEvents: rec.significantEvents.slice(0, 20)
  };
}

/**
 * List all recordings
 * @returns {Array}
 */
function listRecordings() {
  return Array.from(recordings.values()).map(rec => ({
    id: rec.id,
    actionType: rec.actionType,
    totalSnapshots: rec.totalSnapshots,
    isRecording: rec.isRecording,
    durationMs: rec.endedAt ? rec.endedAt - rec.startedAt : Date.now() - rec.startedAt
  }));
}

/**
 * Delete a recording
 * @param {string} recordingId
 * @returns {boolean}
 */
function deleteRecording(recordingId) {
  const rec = recordings.get(recordingId);
  if (!rec) return false;
  
  try {
    fs.rmSync(rec.dir, { recursive: true, force: true });
  } catch (e) {
    // Ignore cleanup errors
  }
  
  recordings.delete(recordingId);
  return true;
}

/**
 * Cleanup all recordings
 */
function cleanupAll() {
  for (const id of recordings.keys()) {
    deleteRecording(id);
  }
}

module.exports = {
  CONFIG,
  createRecording,
  addSnapshot,
  stopRecording,
  shouldAutoStop,
  readSnapshot,
  getSnapshotPaginated,
  calculateDiff,
  searchRecording,
  getRecordingInfo,
  listRecordings,
  deleteRecording,
  cleanupAll
};
