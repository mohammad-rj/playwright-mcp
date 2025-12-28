# Playwright MCP (Custom Fork)

A Model Context Protocol (MCP) server that provides browser automation capabilities using [Playwright](https://playwright.dev). This server enables LLMs to interact with web pages through structured accessibility snapshots.

**This is a custom fork** with enhanced features for multi-agent support, large output handling, and UI debugging.

## 🆕 Custom Features

| Feature | Description |
|---------|-------------|
| **Tab Isolation** | Multi-agent browser access - each agent works on its own tab |
| **Snapshot Caching** | Auto-cache large snapshots (>300 lines) to prevent token overflow |
| **Output Caching** | Auto-cache any large output (console, network, etc. >100 lines) |
| **Recording System** | Record and analyze UI state changes over time for debugging |

---

## 🗂️ Tab Isolation (Multi-Agent Support)

Enables multiple agents to work on the same browser simultaneously, each on their own tab.

### ⚠️ IMPORTANT: tabId is REQUIRED

All browser tools **require** a `tabId` parameter. This prevents agents from accidentally modifying other agents' tabs.

### Workflow

1. **Create tab:** `browser_tabs(action="new")` → Returns your `tabId`
2. **Use tab:** Pass `tabId` to ALL browser tools
3. **Close tab:** `browser_tabs(action="close", tabId=X)` when done

### Available Actions

| Action | Description |
|--------|-------------|
| `new` | Create a new tab, returns `tabId` |
| `close` | Close a tab (requires `tabId`) |

Note: `list` and `select` actions are disabled to prevent interference between agents.

### Tools Requiring tabId

All these tools **require** `tabId`:

```
browser_snapshot, browser_click, browser_drag, browser_hover,
browser_select_option, browser_navigate, browser_navigate_back,
browser_press_key, browser_type, browser_fill_form, browser_take_screenshot,
browser_wait_for, browser_evaluate, browser_console_messages,
browser_network_requests, browser_handle_dialog, browser_file_upload,
browser_run_code, browser_resize, browser_mouse_*
```

### Example: Agent Workflow

```
// 1. Create your tab (REQUIRED first step)
browser_tabs(action="new")
// Response: "Your tabId: 2"

// 2. Use your tab with ALL operations
browser_navigate(tabId=2, url="https://example.com")
browser_snapshot(tabId=2)
browser_click(tabId=2, ref="abc", element="Submit button")

// 3. Close when done
browser_tabs(action="close", tabId=2)
```

### Error Messages

If you forget `tabId`:
```
Error: tabId is REQUIRED. First call browser_tabs(action="new") to create a tab and get your tabId.
```

### Multi-Agent Example

```
Agent 1:                                Agent 2:
─────────────────────────────────────   ─────────────────────────────────────
browser_tabs(action="new") → tabId: 1   browser_tabs(action="new") → tabId: 2
browser_navigate(tabId=1, url="...")    browser_navigate(tabId=2, url="...")
browser_snapshot(tabId=1)               browser_snapshot(tabId=2)
browser_click(tabId=1, ref="...", ...)  browser_click(tabId=2, ref="...", ...)
browser_tabs(action="close", tabId=1)   browser_tabs(action="close", tabId=2)
```

Each agent only knows its own `tabId`, so they can't interfere with each other.

---

## 📦 Snapshot Caching

When `browser_snapshot` returns more than **300 lines**, instead of consuming excessive tokens:

1. The snapshot is cached with a unique ID
2. A summary is returned with:
   - Page URL & title
   - Total lines count
   - Cache ID for retrieval
   - Structure hints (main elements, interactive refs)

### Cache Navigation Tools

| Tool | Description |
|------|-------------|
| `get_cached_snapshot` | Get specific lines from cached snapshot |
| `search_cached_snapshot` | Search text within cached snapshot |

### Example

```json
// Response when snapshot is too large:
{
  "cacheId": "abc123",
  "totalLines": 850,
  "structureHints": [
    {"line": 15, "element": "- main"},
    {"line": 42, "ref": "e5f2", "element": "- button \"Submit\""}
  ]
}

// Get specific lines:
get_cached_snapshot { "cacheId": "abc123", "startLine": 1, "endLine": 100 }

// Search in snapshot:
search_cached_snapshot { "cacheId": "abc123", "query": "button", "maxResults": 10 }
```

### Settings

| Setting | Value |
|---------|-------|
| Threshold | 300 lines |
| Max cache size | 50 snapshots |
| Cache expiry | 30 minutes |
| Default page size | 100 lines |

---

## 📄 Universal Output Caching

Any tool output exceeding **100 lines** is automatically cached. This applies to:

- `browser_console_messages` - Console logs
- `browser_network_requests` - Network activity
- Any other large text output

### Cache Navigation Tools

| Tool | Description |
|------|-------------|
| `get_cached_output` | Get specific lines from cached output |
| `search_cached_output` | Search text within cached output |

### Example

```json
// When console output is too large:
{
  "cacheId": "out_def456",
  "totalLines": 250,
  "toolName": "browser_console_messages",
  "preview": "... first 20 lines ..."
}

// Get specific lines:
get_cached_output { "cacheId": "out_def456", "startLine": 50, "endLine": 100 }

// Search in output:
search_cached_output { "cacheId": "out_def456", "query": "error" }
```

### Settings

| Setting | Value |
|---------|-------|
| Threshold | 100 lines |
| Max cache size | 30 outputs |
| Cache expiry | 30 minutes |
| Default page size | 50 lines |

---

## 🎬 Recording System

Record browser state changes after actions to debug dynamic UI, loading states, animations, and async updates.

### How It Works

1. Execute an action (click, type, navigate, press_key, wait)
2. Automatically capture snapshots at intervals (default: 100ms)
3. Detect significant events (loading, dialogs, errors)
4. Analyze changes with diff and search tools

### Recording Tools

| Tool | Description |
|------|-------------|
| `browser_action_record` | Execute action and record snapshots |
| `browser_recording_diff` | Calculate diff between two snapshots |
| `browser_recording_snapshot` | Read a specific snapshot with pagination |
| `browser_recording_search` | Search text across all snapshots |
| `browser_recording_info` | Get recording metadata and events |
| `browser_recording_list` | List all active recordings |
| `browser_recording_delete` | Delete a recording |

### browser_action_record Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `tabId` | number | **YES** | Tab ID from browser_tabs(action="new") |
| `action` | string | YES | `click`, `type`, `navigate`, `press_key`, `wait` |
| `ref` | string | for click/type | Element ref |
| `element` | string | no | Element description |
| `text` | string | for type | Text to type |
| `url` | string | for navigate | URL to navigate |
| `key` | string | for press_key | Key (e.g., "Enter", "Tab") |
| `durationMs` | number | no | Recording duration (default: 10000, max: 30000) |
| `intervalMs` | number | no | Snapshot interval (default: 100, min: 50) |
| `stopOnIdleMs` | number | no | Stop if no changes (default: 2000) |

### Auto-Detected Events

- `loading_started` / `loading_ended` - Loading indicators appear/disappear
- `dialog_appeared` / `dialog_closed` - Modal/dialog changes
- `error_appeared` - Error messages detected

### Example Workflow

```json
// 1. Record a click action
browser_action_record {
  "tabId": 1,
  "action": "click",
  "ref": "abc123",
  "element": "Submit button",
  "durationMs": 5000
}
// Returns: recordingId, totalSnapshots, significantEvents

// 2. View what changed between snapshots
browser_recording_diff {
  "recordingId": "rec_xxx",
  "index": 5
}
// Returns: added, removed, changed elements

// 3. Search for specific content
browser_recording_search {
  "recordingId": "rec_xxx",
  "query": "error"
}
// Returns: matches with snapshot index and line number

// 4. Read a specific snapshot
browser_recording_snapshot {
  "recordingId": "rec_xxx",
  "index": 3,
  "startLine": 1,
  "endLine": 100
}
```

### Recording Settings

| Setting | Value |
|---------|-------|
| Max concurrent recordings | 5 (LRU eviction) |
| Max snapshots per recording | 200 |
| Default duration | 10 seconds |
| Default interval | 100ms |
| Idle stop threshold | 2 seconds |

---

## Installation

### Using Custom CLI

```json
{
  "mcpServers": {
    "playwright": {
      "command": "node",
      "args": [
        "/path/to/playwright-mcp-custom/custom-cli.js"
      ]
    }
  }
}
```

### With Options

```json
{
  "mcpServers": {
    "playwright": {
      "command": "node",
      "args": [
        "/path/to/playwright-mcp-custom/custom-cli.js",
        "--browser", "chrome",
        "--viewport-size", "1920x1080"
      ]
    }
  }
}
```

---

## All Tools Reference

### Tools Requiring tabId (REQUIRED)

| Tool | Description |
|------|-------------|
| `browser_navigate` | Navigate to URL |
| `browser_navigate_back` | Go back |
| `browser_snapshot` | Get page accessibility snapshot |
| `browser_take_screenshot` | Take screenshot |
| `browser_click` | Click element |
| `browser_drag` | Drag and drop |
| `browser_hover` | Hover over element |
| `browser_select_option` | Select dropdown option |
| `browser_type` | Type text |
| `browser_fill_form` | Fill multiple form fields |
| `browser_press_key` | Press keyboard key |
| `browser_file_upload` | Upload files |
| `browser_handle_dialog` | Handle alert/confirm/prompt |
| `browser_evaluate` | Run JavaScript |
| `browser_run_code` | Run Playwright code |
| `browser_console_messages` | Get console logs |
| `browser_network_requests` | Get network requests |
| `browser_wait_for` | Wait for text/time |
| `browser_resize` | Resize viewport |
| `browser_generate_locator` | Generate test locator |
| `browser_mouse_move_xy` | Move mouse (vision) |
| `browser_mouse_click_xy` | Click at coordinates (vision) |
| `browser_mouse_drag_xy` | Drag at coordinates (vision) |
| `browser_action_record` | Record UI changes |

### Tab Management

| Tool | tabId | Description |
|------|-------|-------------|
| `browser_tabs(action="new")` | Returns tabId | Create new tab |
| `browser_tabs(action="close")` | Required | Close tab |

### Recording Tools (use recordingId)

| Tool | Description |
|------|-------------|
| `browser_recording_diff` | Diff between snapshots |
| `browser_recording_snapshot` | Read snapshot |
| `browser_recording_search` | Search in recording |
| `browser_recording_info` | Get metadata |
| `browser_recording_list` | List all recordings |
| `browser_recording_delete` | Delete recording |

### Cache Tools (use cacheId)

| Tool | Description |
|------|-------------|
| `get_cached_snapshot` | Get lines from cached snapshot |
| `search_cached_snapshot` | Search in cached snapshot |
| `get_cached_output` | Get lines from cached output |
| `search_cached_output` | Search in cached output |

### Other Tools (no tabId needed)

| Tool | Description |
|------|-------------|
| `browser_install` | Install browser |
| `browser_close` | Close entire browser |

---

## Architecture

```
custom-cli.js
    │
    ▼
custom-backend.js ─────────────────────────────────────────┐
    │                                                      │
    ├── tab-isolation.js      (tabId support for tools)    │
    │       └── createTabProxyContext()                    │
    │       └── wrapToolWithTabId()                        │
    │                                                      │
    ├── snapshot-cache.js     (page snapshot caching)      │
    │       └── cacheSnapshot()                            │
    │       └── getPaginatedContent()                      │
    │       └── searchInCache()                            │
    │                                                      │
    ├── output-cache.js       (universal output caching)   │
    │       └── cacheOutput()                              │
    │       └── getPaginatedContent()                      │
    │       └── searchInCache()                            │
    │                                                      │
    ├── recording-manager.js  (recording state management) │
    │       └── createRecording()                          │
    │       └── addSnapshot()                              │
    │       └── calculateDiff()                            │
    │       └── searchRecording()                          │
    │                                                      │
    └── recording-tools.js    (MCP tool definitions)       │
            └── browser_action_record                      │
            └── browser_recording_*                        │
                                                           │
    PatchedResponse ◄──────────────────────────────────────┘
        └── Auto-caches large snapshots (>300 lines)
        └── Auto-caches large outputs (>100 lines)
```

---

## Original Playwright MCP

This fork is based on [@playwright/mcp](https://github.com/microsoft/playwright-mcp). All original features and tools are preserved. See the original documentation for:

- Browser configuration options
- User profile management
- Storage state
- All standard browser tools

---

## Requirements

- Node.js 18+
- Playwright (installed automatically)
