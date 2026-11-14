/**
 * An agent drives Browser Use while a pane shows the session, and the page it
 * works in opens a new window (`target=_blank`, `window.open`). The pane must
 * end with the opened page selected and no about:blank tab nobody asked for.
 * Runs on the core harness: the agent's commands reach the browser host as the
 * core forwards them (`browser/command`), and the pane's tab facts are read
 * from the host the core claimed.
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';

import { createPolling } from '../host-harness-poll';
import { type CoreHarness, type CoreHarnessSuite, progress } from './test-support/core-harness';

const { eventually } = createPolling({ timeoutMs: 8_000, intervalMs: 50 });

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

async function scenario(harness: CoreHarness, origin: string, native: boolean): Promise<void> {
  const mode = native ? 'native view' : 'pixel surface';
  const browser = harness.browserHost;
  let turn = 0;
  const driver = (sessionId: string) => ({
    command: async (input: Record<string, unknown>) => {
      const value = (await harness.uiCommand(String(input.action), {
        ...input,
        session_id: sessionId,
        turn_id: ++turn,
      })) as { text?: string } | null;
      return String(value?.text || '');
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
}

const suite: CoreHarnessSuite = async (harness) => {
  const server = pageServer();
  try {
    const origin = `http://127.0.0.1:${await listen(server)}`;
    await scenario(harness, origin, process.env.MIXDOG_BROWSER_NATIVE_VIEW === '1');
    progress('popup blank integration passed');
  } finally {
    server.close();
  }
};

export default suite;
