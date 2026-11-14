import assert from 'node:assert/strict';
import { test } from 'node:test';

import { registerBrowserSurfaceReport } from './browser-surface-report.ts';

function pair() {
  const sent = [];
  const listeners = new Set();
  const connection = { notify: (method, params) => sent.push([method, params]) };
  const source = {
    onSurfaceChanged(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { sent, listeners, connection, source, emit: (change) => listeners.forEach((l) => l(change)) };
}

test('a reveal, a hide and a handoff are sent as host/browser/surface', () => {
  const { sent, connection, source, emit } = pair();
  registerBrowserSurfaceReport(connection, source);
  emit({ sessionId: 's1', surface: { sessionId: 's1', reveal: true, tabId: 'p1', title: 'T' } });
  emit({ sessionId: 's1', surface: { sessionId: 's1', hide: true } });
  emit({ sessionId: 's1', tabId: 'p2', surface: { sessionId: 's1', reveal: true, handoff: true } });
  assert.deepEqual(sent, [
    ['host/browser/surface', { sessionId: 's1', reveal: true, tabId: 'p1', title: 'T' }],
    ['host/browser/surface', { sessionId: 's1', hide: true }],
    ['host/browser/surface', { sessionId: 's1', reveal: true, handoff: true, tabId: 'p2' }],
  ]);
});

test('the returned function stops the reports', () => {
  const { sent, listeners, connection, source, emit } = pair();
  const stop = registerBrowserSurfaceReport(connection, source);
  stop();
  emit({ sessionId: 's1', surface: { sessionId: 's1', hide: true } });
  assert.equal(listeners.size, 0);
  assert.deepEqual(sent, []);
});
