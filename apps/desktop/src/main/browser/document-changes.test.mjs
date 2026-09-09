import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { JSDOM } from 'jsdom';
import { createBrowserChangeLatch, observeBrowserDocumentChanges } from './document-changes.ts';
import { BROWSER_DOCUMENT_ROOTS } from './documents.ts';

test('change wakeups are latched across reads, cancellable, and bounded without events', async () => {
  const latch = createBrowserChangeLatch();
  const before = latch.version;
  latch.notify();
  await latch.wait(before, 30_000);
  const pending = latch.wait(latch.version, 30_000);
  latch.notify();
  await pending;
  const controller = new AbortController();
  const cancelled = latch.wait(latch.version, 30_000, controller.signal);
  controller.abort(new Error('cancel fixture'));
  await assert.rejects(cancelled, /cancel fixture/);
  await latch.wait(latch.version, 1);
});

test('document and open-shadow mutations wake a wait and cleanup disconnects observers', async () => {
  const dom = new JSDOM('<div id="host"></div>', { runScripts: 'outside-only' });
  const port = new EventEmitter();
  const root = dom.window.document.querySelector('#host').attachShadow({ mode: 'open' });
  const host = {
    sessions: () => new Map(),
    cdp: {
      guestDebugger: async () => port,
      call: async (_guest, _method, args) => {
        dom.window[args.name] = payload => port.emit('message', {}, 'Runtime.bindingCalled', { name: args.name, payload });
      },
    },
  };
  const collect = async (_guest, expression) => [dom.window.eval(expression)];
  const changes = await observeBrowserDocumentChanges(host, collect, BROWSER_DOCUMENT_ROOTS, {});
  try {
    for (const target of [dom.window.document.body, root]) {
      const before = changes.latch.version;
      const pending = changes.latch.wait(before, 1000);
      target.append(dom.window.document.createElement('span'));
      await pending;
      assert.ok(changes.latch.version > before);
    }
    await changes.close();
    const after = changes.latch.version;
    root.append(dom.window.document.createElement('span'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(changes.latch.version, after);
    assert.equal(port.listenerCount('message'), 0);
    assert.equal(dom.window.__mixdogWaitObserver, undefined);
  } finally { dom.window.close(); }
});
