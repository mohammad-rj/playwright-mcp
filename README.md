# Playwright MCP — Custom Server

Extended Playwright MCP with shared Chrome context, tab isolation, snapshot caching, browser recordings, and screenshot fixes.

## Architecture

```
Claude Agent 1 ──┐
Claude Agent 2 ──┼──► SSE Server (:9224) ──► Shared Chrome (:9222 CDP)
Claude Agent 3 ──┘         │                       │
                            │                  One browser window
                     Tab Registry              Multiple tabs (tabId)
                     Session ownership
```

One Node.js process handles all agents. All agents share one Chrome window — no new windows opened per session.

---

## Features

### 1. Shared Chrome Context

All MCP sessions connect to the **same Chrome instance** via CDP (port 9222). Login state, cookies, and storage are shared across all agents.

- Chrome is launched automatically on first use (`--remote-debugging-port=9222`)
- Connects via `chromium.connectOverCDP()` → `browser.contexts()[0]` (default context)
- If CDP fails, falls back to `contextFactory` (new isolated window)
- Environment override: `PLAYWRIGHT_MCP_CDP_ENDPOINT=http://host:port`

### 2. Tab Isolation

Each agent uses a `tabId` to identify and own its tabs. Agents can see all open tabs but cannot interfere with tabs owned by other sessions.

**Workflow:**
```
1. browser_navigate(url, tabId?)    → creates new tab if tabId not provided
2. browser_snapshot(tabId)          → reads DOM of that specific tab
3. browser_click(tabId, ref)        → acts only on that tab
4. browser_tabs()                   → lists all open tabs with owners
```

- `tabId` is a 6-character string (e.g. `"abc123"`)
- Each tab is associated with `ownerSessionId` — only the owning session can control it
- On session disconnect: owned tabs are automatically cleaned up from the registry

### 3. Screenshot Without Render Wait

`browser_take_screenshot` takes the screenshot immediately — it does **not** wait for network idle or font rendering.

- Font requests (`woff`, `woff2`, `ttf`, `otf`, `eot`) are aborted before capture
- Routes are restored after capture
- Prevents hanging when Chrome treats font downloads as file downloads

### 4. Snapshot Caching & Pagination

When a page snapshot exceeds **300 lines**, it is automatically cached instead of sent inline.

Response format when cached:
```
### Snapshot Too Large - Cached for Navigation
Cache ID: `a1b2c3d4`
Total Lines: 1240

### Structure Overview (key elements):
- Line 12: nav [ref=abc]
- Line 45: main
...
```

Navigate the cached snapshot:
```
get_cached_snapshot    cacheId="a1b2c3d4" startLine=1 endLine=100
search_cached_snapshot cacheId="a1b2c3d4" query="submit button"
```

- Cache expires after 30 minutes (sliding window — resets on each access)
- LRU eviction when cache is full (max 50 entries)
- Structure hints extracted automatically (nav, main, form, dialogs, interactive refs)

### 5. Output Caching & Pagination

When **any** tool output exceeds **100 lines** (e.g. large console logs, network requests), it is cached:

```
## Output Too Large - Cached
Tool: browser_console_messages
Total Lines: 480
Cache ID: `out_1234abcd`

### Preview (first 20 lines)
...

### Commands
- Get lines: get_cached_output cacheId="out_1234abcd" startLine=1 endLine=50
- Search: search_cached_output cacheId="out_1234abcd" query="error"
```

- Max 30 cached outputs at a time (LRU eviction)
- Same 30-minute sliding TTL

### 6. Browser Recording System

Record page state changes over time after an action for debugging dynamic UI.

```
browser_action_record  action="click" tabId="abc123" selector="button#submit"
```

This starts a recording loop that:
- Takes snapshots every 100ms (default)
- Stops automatically after 2s of no changes (idle stop)
- Detects significant events: loading spinners, modals, errors
- Saves to disk with metadata

**Inspect recordings:**
```
browser_recording_list              → list all recordings
browser_recording_info  id="rec_xx" → metadata, events, duration
browser_recording_snapshot id="rec_xx" index=5      → specific snapshot
browser_recording_diff  id="rec_xx" fromIndex=0 toIndex=5  → diff between snapshots
browser_recording_search id="rec_xx" query="error"  → search across all snapshots
browser_recording_delete id="rec_xx"
```

Configuration defaults:
| Setting | Default |
|---|---|
| Max duration | 10 seconds |
| Interval | 100ms |
| Idle stop | 2 seconds |
| Max snapshots | 200 |
| Max recordings kept | 5 (LRU eviction) |

Recordings are cleaned up on session disconnect and on process exit.

---

## Quick Start

```bash
# SSE server mode (recommended — one process for all agents)
node custom-cli.js --port 9224

# Health check
curl http://127.0.0.1:9224/health

# Stdio mode (one process per agent, legacy)
node custom-cli.js
```

**Options:**
```
--port <port>              SSE server port
--host <host>              SSE server host (default: 127.0.0.1)
--headless                 Run Chrome headless
--no-shared-cdp            Disable shared Chrome (each session gets own browser)
--max-snapshot-lines <n>   Snapshot cache threshold (default: 300)
--vision                   Use screenshots instead of snapshots
```

---

## Memory Management

| Component | Max Size | Eviction | Cleanup |
|---|---|---|---|
| Snapshot cache | 50 entries | True LRU | 30min sliding TTL |
| Output cache | 30 entries | True LRU | 30min sliding TTL |
| Recordings | 5 entries | FIFO | Session disconnect + process exit |
| Tab registry | Unbounded | Manual | Session disconnect |

---

## File Structure

```
playwright-mcp/
├── custom-cli.js              # Entry point: SSE server + Chrome launcher
├── src/
│   ├── custom-backend.js      # MCP backend: wraps tools, screenshot fix
│   ├── tab-isolation.js       # Tab registry, session ownership
│   ├── snapshot-cache.js      # Snapshot pagination & search
│   ├── output-cache.js        # Universal output cache
│   ├── recording-manager.js   # Recording lifecycle & storage
│   └── recording-tools.js     # MCP tool definitions for recordings
└── recordings/                # Temp recording files (auto-cleaned)
```
