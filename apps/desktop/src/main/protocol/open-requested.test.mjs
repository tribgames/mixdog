import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createDesktopVisualize } from '../visualize/host.ts';
import { createOpenRequestedHandler } from './open-requested.ts';

const open = (params) => ({ type: 'notification', notification: { method: 'ui/openRequested', params } });
const visualize = (params) => open({ kind: 'visualize', ...params });
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Targets that record every call; `pages` maps a request id to the page id its watch resolves with. */
function targets(pages = {}) {
  const calls = { browser: [], terminal: [], visualize: [], watched: [], notified: [] };
  return {
    calls,
    value: {
      browser: (request) => calls.browser.push(request),
      terminal: (request) => calls.terminal.push(request),
      visualize: (request) => calls.visualize.push(request),
      watchNewTab(sessionId, requestId) {
        calls.watched.push([sessionId, requestId, calls.visualize.length]);
        return { page: Promise.resolve(pages[requestId] ?? null) };
      },
      notify: (method, params) => calls.notified.push([method, params]),
    },
  };
}

test('each kind goes to its own target, without the kind tag', () => {
  const t = targets();
  const handle = createOpenRequestedHandler(t.value);
  handle(open({ kind: 'browser', sessionId: 's1', reveal: true, handoff: true, tabId: 'p1', title: 'Login' }));
  handle(open({ kind: 'terminal', sessionId: 's1', terminalId: 'term1', requestId: 'q1', tabs: [] }));
  handle(visualize({ sessionId: 's1', tab: 'v1', reveal: true }));
  assert.deepEqual(t.calls.browser, [{ sessionId: 's1', reveal: true, handoff: true, tabId: 'p1', title: 'Login' }]);
  assert.deepEqual(t.calls.terminal, [{ sessionId: 's1', terminalId: 'term1', requestId: 'q1', tabs: [] }]);
  assert.deepEqual(t.calls.visualize, [{ sessionId: 's1', tab: 'v1', reveal: true }]);
  assert.deepEqual(t.calls.watched, [], 'no web URL, nothing to wait for');
});

test('a visualize open is delivered once per openRequestId; requests without an id always are', () => {
  const t = targets();
  const handle = createOpenRequestedHandler(t.value);
  handle(visualize({ sessionId: 's1', openUrl: 'https://a.test/', openRequestId: 'r1' }));
  handle(visualize({ sessionId: 's1', openUrl: 'https://a.test/', openRequestId: 'r1' }));
  handle(visualize({ sessionId: 's1', openUrl: 'https://b.test/', openRequestId: 'r2' }));
  handle(visualize({ sessionId: 's1', openUrl: 'https://c.test/' }));
  handle(visualize({ sessionId: 's1', openUrl: 'https://c.test/' }));
  assert.deepEqual(
    t.calls.visualize.map((request) => request.openUrl),
    ['https://a.test/', 'https://b.test/', 'https://c.test/', 'https://c.test/']
  );
  assert.deepEqual(
    t.calls.watched.map(([, id]) => id),
    ['r1', 'r2']
  );
});

test('the tab report goes out once, after the watch was set, and only when the tab arrived', async () => {
  const t = targets({ r1: 'p7' });
  const handle = createOpenRequestedHandler(t.value);
  handle(visualize({ sessionId: 's1', openUrl: 'https://a.test/', openRequestId: 'r1' }));
  handle(visualize({ sessionId: 's1', openUrl: 'https://a.test/', openRequestId: 'r1' }));
  handle(visualize({ sessionId: 's1', openUrl: 'https://b.test/', openRequestId: 'r2' }));
  await tick();
  assert.deepEqual(t.calls.watched[0], ['s1', 'r1', 0], 'the watch precedes the delivery to the pane');
  assert.deepEqual(t.calls.notified, [['ui/newTab/created', { sessionId: 's1', openRequestId: 'r1', pageId: 'p7' }]]);
});

test('other notifications and malformed open requests are ignored', () => {
  const t = targets();
  const handle = createOpenRequestedHandler(t.value);
  handle({ type: 'status', status: { state: 'ready' } });
  handle({ type: 'notification', notification: { method: 'warning', params: { kind: 'browser', sessionId: 's1' } } });
  handle(open({ kind: 'browser' }));
  handle(open({ kind: 'bogus', sessionId: 's1' }));
  handle(open({ sessionId: 's1', openUrl: 'https://a.test/' }));
  handle({ type: 'notification', notification: { method: 'ui/openRequested' } });
  assert.deepEqual([t.calls.browser, t.calls.terminal, t.calls.visualize], [[], [], []]);
});

test('the main window receives the request as the visualize open event, and no window drops it', () => {
  const sent = [];
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    send: (channel, event) => sent.push([channel, event]),
  });
  let window = { isDestroyed: () => false, webContents: contents };
  const service = createDesktopVisualize({
    window: () => window,
    invokeDesktopOperation: async () => null,
    browserAvailable: () => true,
  });
  const handle = createOpenRequestedHandler({
    ...targets().value,
    visualize: (request) => service.openRequested(request),
  });
  handle(visualize({ sessionId: 's1', openUrl: 'https://a.test/', openRequestId: 'r1' }));
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0][1], { sessionId: 's1', openUrl: 'https://a.test/', openRequestId: 'r1' });

  window = null;
  handle(visualize({ sessionId: 's1', openUrl: 'https://b.test/', openRequestId: 'r2' }));
  assert.equal(sent.length, 1);
});
