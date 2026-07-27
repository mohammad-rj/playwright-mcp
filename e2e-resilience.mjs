// Resilience checks for the ported fork: concurrent-session isolation and
// recovery after the shared browser dies. The browser-death path is the one
// the 1.62 migration changed most - BrowserBackend now latches a _disconnected
// flag and stamps isClose on every later response, so a session that survived
// a Chrome restart on 1.58 would go permanently dead here without the
// context-registry + _refreshBrowserContext handling.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { spawn, execSync } from 'node:child_process';

const URL_BASE = process.env.MCP_URL || 'http://127.0.0.1:9299';
const CHROME = 'C:/Users/Epid/AppData/Local/Google/Chrome/Application/chrome.exe';
const PROFILE = process.env.TEST_PROFILE;
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  :: ' + detail : ''}`);
};

async function connect(label) {
  const c = new Client({ name: label, version: '1.0.0' }, { capabilities: {} });
  await c.connect(new SSEClientTransport(new URL(`${URL_BASE}/sse`)));
  c.call = async (name, args) => {
    const r = await c.callTool({ name, arguments: args });
    return { text: (r.content || []).map(x => x.text).join('\n'), isClose: r.isClose };
  };
  c.newTab = async () => {
    const { text } = await c.call('browser_tabs', { action: 'new' });
    return (text.match(/tabId:\s*`([a-z0-9]{6})`/i) || [])[1];
  };
  return c;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- 1. Two concurrent sessions must not share or steal each other's tab ----
const a = await connect('sess-a');
const b = await connect('sess-b');
const tabA = await a.newTab();
await a.call('browser_navigate', { tabId: tabA, url: 'https://example.com' });
const tabB = await b.newTab();
await b.call('browser_navigate', { tabId: tabB, url: 'https://example.net' });
check('two sessions each get a tabId', !!tabA && !!tabB, `${tabA} / ${tabB}`);
check('the two tabIds differ', tabA !== tabB, `${tabA} vs ${tabB}`);

const { text: snapA } = await a.call('browser_snapshot', { tabId: tabA });
const { text: snapB } = await b.call('browser_snapshot', { tabId: tabB });
check('session A still on its own page', /example\.com/.test(snapA), (snapA.match(/Page URL: \S+/) || [''])[0]);
check('session B still on its own page', /example\.net/.test(snapB), (snapB.match(/Page URL: \S+/) || [''])[0]);

// Ownership is enforced: B must not be able to close A's tab.
const { text: steal } = await b.call('browser_tabs', { action: 'close', tabId: tabA });
check('session B cannot close session A\'s tab',
  /another session|cannot close|belongs/i.test(steal), steal.slice(0, 110));

// ---- 2. Kill the browser, bring it back, confirm the session recovers ----
console.log('\n-- killing the test Chrome --');
try {
  execSync(`powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='chrome.exe'\\" | Where-Object { $_.CommandLine -like '*9333*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"`,
    { stdio: 'ignore' });
} catch { /* some children exit on their own */ }
await sleep(3000);

console.log('-- restarting Chrome on the same CDP port --');
spawn(CHROME, [
  '--remote-debugging-port=9333', `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--no-default-browser-check', '--disable-restore-session-state',
  'about:blank',
], { detached: true, stdio: 'ignore' }).unref();
await sleep(6000);

// The session that was live through the crash must recover rather than stay dead.
let recovered = false, detail = '';
for (let i = 0; i < 3 && !recovered; i++) {
  const newTab = await a.newTab().catch(e => { detail = String(e); return null; });
  if (newTab) {
    const { text } = await a.call('browser_navigate', { tabId: newTab, url: 'https://example.com' });
    detail = (text.match(/Page URL: \S+/) || [text.slice(0, 90)])[0];
    recovered = /example\.com/.test(text);
  }
  if (!recovered) await sleep(2000);
}
check('a live session recovers after the browser died and came back', recovered, detail);

await a.close().catch(() => {});
await b.close().catch(() => {});

const failed = results.filter(r => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
if (failed.length) {
  for (const f of failed) console.log(` - ${f.name} :: ${f.detail}`);
  process.exit(1);
}
