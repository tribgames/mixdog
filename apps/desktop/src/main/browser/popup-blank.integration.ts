/**
 * An agent drives Browser Use while a pane shows the session, and the page it
 * works in opens a new window (`target=_blank`, `window.open`). The pane must
 * end with the opened page selected and no about:blank tab nobody asked for.
 */
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { app, BrowserWindow } from 'electron';
import { createPolling } from '../host-harness-poll';
import { createBrowserHost } from './host';

const progressPath = process.env.MIXDOG_BROWSER_INTEGRATION_LOG || '';
function progress(message: string): void {
  if (progressPath) appendFileSync(progressPath, `${message}\n`);
}

const profile = mkdtempSync(join(tmpdir(), 'mixdog-browser-popup-blank-'));
process.env.MIXDOG_DATA_DIR = join(profile, 'data');
app.setPath('userData', join(profile, 'user-data'));
app.disableHardwareAcceleration();

const { eventually, readDiscovery } = createPolling({ timeoutMs: 8_000, intervalMs: 50 });

function pageServer(): Server {
  return createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://page');
    response.setHeader('content-type', 'text/html; charset=utf-8');
    if (url.pathname === '/start') {
      response.end(`<!doctype html><title>Start</title>
        <a id="blank-link" href="/ads" target="_blank">Open ads link</a>
        <button id="open-ads" onclick="window.open('/ads')">Open ads</button>`);
      return;
    }
    if (url.pathname === '/ads') {
      response.end('<!doctype html><title>Ads</title><p>Ads body</p>');
      return;
    }
    response.statusCode = 404;
    response.end('missing');
  });
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return address.port;
}

async function scenario(origin: string, native: boolean): Promise<void> {
  const mode = native ? 'native view' : 'pixel surface';
  const parent = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true } });
  const browser = createBrowserHost(parent, { remoteSession: false, requestApproval: async () => true });
  try {
    await parent.loadURL('data:text/html,<p>shell</p>');
    browser.setBridgeEnabled(true);
    const discovery = await readDiscovery(join(process.env.MIXDOG_DATA_DIR!, 'browser-bridge.json'));
    let turn = 0;
    const driver = (sessionId: string) => ({
      command: async (input: Record<string, unknown>) => {
        const response = await fetch(`http://127.0.0.1:${discovery.port}/command`, {
          method: 'POST',
          headers: { authorization: `Bearer ${discovery.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ session_id: sessionId, turn_id: ++turn, ...input }),
        });
        const payload = (await response.json()) as { ok: boolean; value?: { text?: string }; error?: string };
        if (!payload.ok) throw new Error(payload.error || 'browser command failed');
        return String(payload.value?.text || '');
      },
      strip: async () => {
        // Tab facts without pixels: a capture can lose its race with a tab change.
        const frame = await browser.browserPageMetadata(sessionId);
        return (frame.tabs ?? []).map((tab) => `${tab.active ? '*' : ' '}${tab.kind}:${tab.url || '(blank)'}`);
      },
    });
    const refOf = (snapshot: string, name: string) =>
      snapshot
        .split('\n')
        .find((line) => line.includes(`"${name}"`))
        ?.match(/\[(p\d+-s\d+-e\d+)\]/)?.[1];

    // The agent made a hidden page before any pane asked for one; opening the
    // panel later shows that page and makes no blank.
    {
      const { command, strip } = driver('late-pane');
      await command({ action: 'navigate', url: `${origin}/ads`, background: true, tab: 'ads' });
      assert.deepEqual(await strip(), [`*background:${origin}/ads`], `${mode}: late pane`);
      progress(`${mode}: a panel opened after the agent's page shows it, with no blank`);
    }
    // The pane holds only its blank: the agent's hidden page replaces it.
    {
      const { command, strip } = driver('empty-pane');
      assert.deepEqual(await strip(), ['*page:about:blank']);
      await command({ action: 'navigate', url: `${origin}/ads`, background: true, tab: 'ads' });
      assert.deepEqual(await strip(), [`*background:${origin}/ads`], `${mode}: empty pane`);
      progress(`${mode}: the agent's hidden page took the empty pane's place`);
    }
    // A real page the person is on keeps the selection against a hidden helper.
    {
      const { command, strip } = driver('real-page');
      await command({ action: 'navigate', url: `${origin}/ads` });
      await command({ action: 'navigate', url: `${origin}/start`, background: true, tab: 'helper' });
      assert.deepEqual(await strip(), [`*page:${origin}/ads`, ` background:${origin}/start`], `${mode}: real page`);
      progress(`${mode}: a hidden helper left the real page selected`);
    }
    const session = 'popup-blank-session';
    const { command, strip } = driver(session);

    // The pane is open first, so it holds a blank page of its own. The agent
    // works in a hidden page, its page opens a window, and then the agent
    // brings its page to the panel with `open`.
    assert.deepEqual(await strip(), ['*page:about:blank']);
    await command({ action: 'navigate', url: `${origin}/start`, background: true, tab: 'ads' });
    const ref = refOf(await command({ action: 'snapshot', tab: 'ads' }), 'Open ads');
    assert.ok(ref);
    assert.match(await command({ action: 'click', ref, tab: 'ads' }), /popup-1/);
    await eventually(strip, (tabs) => tabs.some((tab) => tab.startsWith(' popup:')));
    await command({ action: 'open', tab: 'ads' });
    const finalTabs = [`*background:${origin}/start`, ` popup:${origin}/ads`];
    const tabs = await eventually(strip, (list) => JSON.stringify(list) === JSON.stringify(finalTabs));
    assert.deepEqual(tabs, [`*background:${origin}/start`, ` popup:${origin}/ads`], `${mode}: ${JSON.stringify(tabs)}`);
    progress(`${mode}: the revealed page is the selected tab and the pane's blank is gone`);
  } finally {
    await browser.dispose().catch(() => undefined);
    parent.destroy();
  }
}

async function run(): Promise<void> {
  const server = pageServer();
  try {
    const origin = `http://127.0.0.1:${await listen(server)}`;
    await scenario(origin, process.env.MIXDOG_BROWSER_NATIVE_VIEW === '1');
    progress('popup blank integration passed');
  } finally {
    server.close();
  }
}

void app
  .whenReady()
  .then(async () => {
    await run();
    app.exit(0);
  })
  .catch((error) => {
    progress(`FAILED: ${(error as Error).stack || error}`);
    app.exit(1);
  });
