// End-to-end check of the ported 1.62 playwright-mcp fork.
// Connects a real MCP client over SSE and exercises the custom layer:
// tool listing, tabId isolation, navigation, snapshot, caching, recording.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

const URL_BASE = process.env.MCP_URL || 'http://127.0.0.1:9299';
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  :: ' + detail : ''}`);
}

const client = new Client({ name: 'e2e', version: '1.0.0' }, { capabilities: {} });
await client.connect(new SSEClientTransport(new URL(`${URL_BASE}/sse`)));

// 1. tools/list
const { tools } = await client.listTools();
const names = tools.map(t => t.name);
check('tools/list returns tools', tools.length > 0, `${tools.length} tools`);

for (const custom of ['browser_set_engine', 'browser_action_record', 'get_cached_snapshot',
                      'search_cached_snapshot', 'get_cached_output', 'search_cached_output',
                      'browser_recording_list', 'browser_tabs']) {
  check(`custom tool present: ${custom}`, names.includes(custom));
}
// features gained from 1.62
for (const gained of ['browser_find', 'browser_cookie_list', 'browser_verify_text_visible',
                      'browser_start_tracing', 'browser_localstorage_list']) {
  check(`1.62 tool present: ${gained}`, names.includes(gained));
}

// every tool must carry a tabId param (the fork's isolation contract)
const navTool = tools.find(t => t.name === 'browser_navigate');
check('browser_navigate has tabId param',
  !!navTool?.inputSchema?.properties?.tabId,
  Object.keys(navTool?.inputSchema?.properties || {}).join(','));

async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content || []).map(c => c.text).join('\n');
  return { r, text };
}

// 2. create an isolated tab
const { text: tabsText } = await call('browser_tabs', { action: 'new' });
const tabId = (tabsText.match(/tabId:\s*`([a-z0-9]{6})`/i) || [])[1];
check('browser_tabs(new) returns a 6-char tabId', !!tabId, tabId || tabsText.slice(0, 160));

if (tabId) {
  // 3. navigate in that tab
  const { text: navText } = await call('browser_navigate', { tabId, url: 'https://example.com' });
  check('browser_navigate works', /example/i.test(navText), navText.slice(0, 120));

  // 4. snapshot
  const { text: snapText } = await call('browser_snapshot', { tabId });
  check('browser_snapshot returns aria content',
    /Example Domain|generic|heading/i.test(snapText), snapText.slice(0, 120));

  // 5. 1.62-gained tool actually works
  const { text: findText } = await call('browser_find', { tabId, text: 'Example' });
  check('browser_find (new in 1.62) works', findText.length > 0, findText.slice(0, 120));

  // 6. rejecting an unknown tabId proves isolation is enforced
  const { text: badText } = await call('browser_snapshot', { tabId: 'zzzzzz' });
  check('unknown tabId is rejected', /not found|invalid|belongs|no tab/i.test(badText),
    badText.slice(0, 120));

  // 7. recording system (the fork's signature feature)
  const { text: recText } = await call('browser_action_record', {
    tabId, action: 'wait', durationMs: 1200, intervalMs: 200,
  });
  check('browser_action_record captures snapshots',
    /recording|snapshot|rec_/i.test(recText), recText.slice(0, 160));

  const { text: listText } = await call('browser_recording_list', {});
  check('browser_recording_list works', /rec_|recording|no recording/i.test(listText),
    listText.slice(0, 120));

  // 8. engine switch (chromium -> webkit -> back). Exercises the _rawBrowserContext swap.
  const { text: eng1 } = await call('browser_set_engine', { engine: 'webkit' });
  check('browser_set_engine -> webkit', /webkit/i.test(eng1), eng1.slice(0, 140));
  const { text: wkNav } = await call('browser_navigate', { tabId, url: 'https://example.com' });
  check('navigate after engine switch', !/error|closed|failed/i.test(wkNav), wkNav.slice(0, 140));
  const { text: eng2 } = await call('browser_set_engine', { engine: 'chromium' });
  check('browser_set_engine -> back to chromium', /chromium/i.test(eng2), eng2.slice(0, 140));

  await call('browser_tabs', { action: 'close', tabId });
}

await client.close();

const failed = results.filter(r => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
if (failed.length) {
  console.log('FAILURES:');
  for (const f of failed) console.log(` - ${f.name} :: ${f.detail}`);
  process.exit(1);
}
