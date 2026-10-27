/**
 * The live-view sender window against a real Electron and a real display
 * (scripts/run-remote-webrtc-sender-integration.mjs): the real sender page and
 * preload open a real desktop video capture (`chromeMediaSource: 'desktop'`)
 * for the first screen, with a handler on the default session that refuses
 * every permission (the app's policy for non-app windows). The page is the
 * Vite-built document loaded from file://, and its meta CSP (the only policy
 * the built page gets) is shown to be enforced. Needs an interactive desktop
 * session; the permission denials are covered by sender-session.test.mjs.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join } from 'node:path';

import { app, desktopCapturer, session, webContents } from 'electron';

import type { RemoteWebrtcSenderEvent } from '../../shared/remote-webrtc-sender';
import { createRemoteWebrtcSenderWindow } from './sender-window';
import { REMOTE_WEBRTC_SENDER_PARTITION } from './sender-session';

const directory = process.env.MIXDOG_SENDER_ROOT || '';
if (!directory) throw new Error('The sender window fixture requires an isolated directory.');
app.setPath('userData', join(directory, 'profile'));

async function run() {
  await app.whenReady();
  // What a non-app window gets from the default session: nothing.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

  const [screen] = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  assert.ok(screen, 'a display is required');

  const bridge = createRemoteWebrtcSenderWindow({ file: join(directory, 'renderer', 'remote-webrtc-sender.html') });
  const events: RemoteWebrtcSenderEvent[] = [];
  bridge.onEvent((event) => {
    if (event) events.push(event);
  });
  bridge.send({
    type: 'source-capture',
    sourceKey: 'screen:test',
    plan: { sourceId: screen.id, width: 640, height: 360, maxFrameRate: 10 },
  });
  const deadline = Date.now() + 20_000;
  while (!events.some((event) => event.type === 'source-captured')) {
    if (Date.now() > deadline) throw new Error(`No capture result; events: ${JSON.stringify(events)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.deepEqual(
    events.find((event) => event.type === 'source-captured'),
    { type: 'source-captured', sourceKey: 'screen:test', ok: true }
  );

  const sender = webContents
    .getAllWebContents()
    .find((contents) => contents.session === session.fromPartition(REMOTE_WEBRTC_SENDER_PARTITION));
  assert.ok(sender, 'the sender page runs on its own partition');
  assert.notEqual(sender.session, session.defaultSession);
  await assertPolicyEnforced(sender);
  bridge.dispose();
}

/** The built (file://) page's CSP is in the document and the browser enforces
 *  it: an inline script, eval and a connection to another origin are all
 *  refused, each reported as a violation. */
async function assertPolicyEnforced(sender: Electron.WebContents) {
  const policy = process.env.MIXDOG_SENDER_CSP || '';
  assert.ok(policy, 'the expected policy comes from the runner');
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.end('reached');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  try {
    const result = await sender.executeJavaScript(`(async () => {
      const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
      const violations = [];
      document.addEventListener('securitypolicyviolation', (event) => violations.push(event.effectiveDirective));
      const inline = document.createElement('script');
      inline.textContent = 'window.__inlineRan = true';
      document.head.append(inline);
      let evalError = null;
      try { (0, eval)('window.__evalRan = true'); } catch (error) { evalError = error.name; }
      let fetched = 'fetched';
      try { await fetch('http://127.0.0.1:${port}/'); } catch (error) { fetched = error.name; }
      await new Promise((resolve) => setTimeout(resolve, 200));
      return {
        meta: meta && meta.content,
        metaBeforeScripts: Boolean(meta) && Boolean(meta.compareDocumentPosition(document.querySelector('script[src]')) & Node.DOCUMENT_POSITION_FOLLOWING),
        inlineRan: window.__inlineRan === true,
        evalRan: window.__evalRan === true,
        evalError,
        fetched,
        violations,
      };
    })()`);
    assert.equal(result.meta, policy, 'the built document carries the policy');
    assert.equal(result.metaBeforeScripts, true, 'the policy precedes the page script');
    assert.equal(result.inlineRan, false, 'an inline script is refused');
    assert.equal(result.evalRan, false, 'eval is refused');
    assert.equal(result.evalError, 'EvalError');
    assert.equal(result.fetched, 'TypeError', 'a connection to another origin is refused');
    assert.equal(requests, 0, 'the other origin never saw a request');
    for (const directive of ['script-src-elem', 'script-src', 'connect-src']) {
      assert.ok(result.violations.includes(directive), `${directive} violation reported: ${result.violations}`);
    }
  } finally {
    server.close();
  }
}

run().then(
  () => app.exit(0),
  (error) => {
    console.error(error);
    app.exit(1);
  }
);
