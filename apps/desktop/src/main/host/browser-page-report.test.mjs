import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createBrowserPageReporter } from './browser-page-report.ts';

const geometry = (generation) => ({
  generation,
  cssWidth: 390,
  cssHeight: 800,
  deviceScaleFactor: 2,
  pixelWidth: 780,
  pixelHeight: 1600,
});

function setup() {
  const sent = [];
  const connection = { notify: (method, params) => sent.push([method, params]) };
  const pages = new Map();
  const reporter = createBrowserPageReporter(connection, (id) => pages.get(id) ?? null);
  return { sent, pages, reporter };
}

test('a locked geometry is sent once per (document, generation)', () => {
  const { sent, pages, reporter } = setup();
  pages.set('s1', { documentId: 'd1', geometry: geometry(1) });
  reporter.changed('s1');
  reporter.changed('s1');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], ['host/browser/page', { tabId: 's1', documentId: 'd1', geometry: geometry(1) }]);
  pages.set('s1', { documentId: 'd1', geometry: geometry(2) });
  reporter.changed('s1');
  pages.set('s1', { documentId: 'd2', geometry: geometry(2) });
  reporter.changed('s1');
  assert.equal(sent.length, 3);
});

test('nothing is sent before the first lock', () => {
  const { sent, pages, reporter } = setup();
  pages.set('s1', { documentId: 'd1', geometry: null });
  reporter.changed('s1');
  assert.equal(sent.length, 0);
});

test('a page without a document omits documentId', () => {
  const { sent, pages, reporter } = setup();
  pages.set('s1', { documentId: null, geometry: geometry(1) });
  reporter.changed('s1');
  assert.equal('documentId' in sent[0][1], false);
});

test('a stream end sends geometry null once, and a new stream is sent again', () => {
  const { sent, pages, reporter } = setup();
  pages.set('s1', { documentId: 'd1', geometry: geometry(1) });
  reporter.changed('s1');
  pages.delete('s1');
  reporter.changed('s1');
  reporter.changed('s1');
  assert.deepEqual(sent[1], ['host/browser/page', { tabId: 's1', geometry: null }]);
  assert.equal(sent.length, 2);
  pages.set('s1', { documentId: 'd1', geometry: geometry(1) });
  reporter.changed('s1');
  assert.equal(sent.length, 3);
});

test('an end for a session never reported sends nothing; sessions are independent', () => {
  const { sent, pages, reporter } = setup();
  reporter.changed('ghost');
  pages.set('a', { documentId: 'd', geometry: geometry(1) });
  pages.set('b', { documentId: 'd', geometry: geometry(1) });
  reporter.changed('a');
  reporter.changed('b');
  assert.equal(sent.length, 2);
});

test('stop clears what was sent', () => {
  const { sent, pages, reporter } = setup();
  pages.set('s1', { documentId: 'd1', geometry: geometry(1) });
  reporter.changed('s1');
  reporter.stop();
  reporter.changed('s1');
  assert.equal(sent.length, 2);
});

test('a throwing connection does not escape', () => {
  const reporter = createBrowserPageReporter(
    {
      notify: () => {
        throw new Error('closed');
      },
    },
    () => ({ documentId: 'd', geometry: geometry(1) })
  );
  reporter.changed('s1');
});
