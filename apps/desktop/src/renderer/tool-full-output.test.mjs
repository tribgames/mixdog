import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['Element', 'HTMLElement', 'MouseEvent', 'Event'],
});

const { FullToolOutputButton, resetFullToolOutputs, useFullToolOutput } = await import('./tool-full-output.tsx');

const FULL = 'full output '.repeat(2_000);
const CUT = {
  id: 'call-1',
  kind: 'tool',
  name: 'shell',
  result: 'head\n[… 1 characters omitted …]\ntail',
  remoteOutputTruncated: FULL.length,
};

function Harness({ item, wanted = false }) {
  const output = useFullToolOutput('session-1', item, wanted);
  return React.createElement(
    'div',
    null,
    React.createElement('pre', { id: 'result' }, String(output.item.result)),
    React.createElement(FullToolOutputButton, { output })
  );
}

async function mount(item, props = {}) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(React.createElement(Harness, { item, ...props })));
  return {
    render: (next) => act(async () => root.render(React.createElement(Harness, next))),
    button: () => host.querySelector('button'),
    result: () => host.querySelector('#result').textContent,
    async click() {
      await act(async () =>
        host.querySelector('button').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      );
    },
    async unmount() {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test('Show full output: loading, retry after a failure, then the full text replaces the cut one', async () => {
  resetFullToolOutputs();
  const reads = [];
  const pending = [deferred(), deferred()];
  window.mixdogDesktop = {
    readTranscriptItem: (sessionId, itemId) => {
      reads.push([sessionId, itemId]);
      return pending[reads.length - 1].promise;
    },
  };
  const view = await mount(CUT);
  assert.equal(view.button().textContent, 'Show full output');
  assert.equal(view.button().disabled, false);
  assert.match(view.result(), /omitted/u);

  // Loading: the button is disabled and says so while the host reads.
  await view.click();
  assert.deepEqual(reads, [['session-1', 'call-1']]);
  assert.equal(view.button().textContent, 'Loading…');
  assert.equal(view.button().disabled, true);

  // Retry: a failed read offers the button again and keeps the cut text.
  await act(async () => pending[0].reject(new Error('relay dropped')));
  assert.equal(view.button().textContent, 'Retry');
  assert.equal(view.button().disabled, false);
  assert.match(view.result(), /omitted/u);

  // Success: the uncut result is shown and the button is gone.
  await view.click();
  assert.equal(reads.length, 2);
  assert.equal(view.button().textContent, 'Loading…');
  await act(async () => pending[1].resolve({ id: 'call-1', result: FULL, rawResult: FULL }));
  assert.equal(view.result(), FULL);
  assert.equal(view.button(), null);
  await view.unmount();

  // A remounted row (the virtual list) keeps what it fetched.
  const again = await mount(CUT);
  assert.equal(again.result(), FULL);
  assert.equal(again.button(), null);
  assert.equal(reads.length, 2, 'no second read');
  await again.unmount();
});

test('a host that no longer has the row reads as a failure to retry', async () => {
  resetFullToolOutputs();
  window.mixdogDesktop = { readTranscriptItem: async () => null };
  const view = await mount({ ...CUT, id: 'call-gone' });
  await view.click();
  assert.equal(view.button().textContent, 'Retry');
  await view.unmount();
});

test('an edit digest loads its diff by itself once the row opens, with no button unless it fails', async () => {
  resetFullToolOutputs();
  const digest = {
    sections: [
      {
        names: ['a.ts', 'a.ts'],
        counts: { additions: 1, deletions: 0 },
        statuses: ['M'],
        targetPath: 'a.ts',
        files: [],
      },
    ],
  };
  const item = { id: 'edit-1', kind: 'tool', name: 'edit', result: 'ok', uiDiffSummary: digest };
  const reads = [];
  window.mixdogDesktop = {
    readTranscriptItem: async (_sessionId, itemId) => {
      reads.push(itemId);
      return { id: itemId, result: 'ok', uiDiff: 'diff --git a/a.ts b/a.ts\n' };
    },
  };
  const closed = await mount(item, { wanted: false });
  assert.deepEqual(reads, []);
  assert.equal(closed.button(), null);
  await closed.unmount();
  const open = await mount(item, { wanted: true });
  assert.deepEqual(reads, ['edit-1']);
  assert.equal(open.button(), null);
  await open.unmount();
});

test('a row that changed is never shown a text fetched for its earlier revision', async () => {
  resetFullToolOutputs();
  const v1 = { ...CUT, remoteOutputTruncated: FULL.length, completedAt: 1 };
  const v2 = {
    ...CUT,
    result: 'head2\n[… 9 characters omitted …]\ntail2',
    remoteOutputTruncated: FULL.length + 500,
    completedAt: 2,
  };
  const grown = FULL + 'x'.repeat(500);
  window.mixdogDesktop = { readTranscriptItem: async () => ({ id: 'call-1', result: FULL, rawResult: FULL }) };
  const view = await mount(v1);
  await view.click();
  assert.equal(view.result(), FULL);
  // The same row id, longer output and a newer completion: the cache entry is for v1 only.
  window.mixdogDesktop = { readTranscriptItem: async () => ({ id: 'call-1', result: grown, rawResult: grown }) };
  await view.render({ item: v2 });
  assert.match(view.result(), /head2/u);
  assert.equal(view.button().textContent, 'Show full output');
  await view.click();
  assert.equal(view.result(), grown);
  // Back to v1 (a remount of an old snapshot): its own entry, not v2's.
  await view.render({ item: v1 });
  assert.equal(view.result(), FULL);
  await view.unmount();
});

test('an answer that arrives after the row changed is dropped', async () => {
  resetFullToolOutputs();
  const v1 = { ...CUT, completedAt: 1 };
  const v2 = {
    ...CUT,
    result: 'head2\n[… 9 characters omitted …]\ntail2',
    remoteOutputTruncated: FULL.length + 1,
    completedAt: 2,
  };
  const late = deferred();
  window.mixdogDesktop = { readTranscriptItem: () => late.promise };
  const view = await mount(v1);
  await view.click();
  assert.equal(view.button().textContent, 'Loading…');
  await view.render({ item: v2 });
  assert.equal(view.button().textContent, 'Show full output', 'the new revision starts idle');
  await act(async () => late.resolve({ id: 'call-1', result: FULL, rawResult: FULL }));
  assert.match(view.result(), /head2/u, 'the old answer does not replace the new row');
  assert.equal(view.button().textContent, 'Show full output');
  await view.unmount();
});

test('a withheld row offers Retry and shows nothing more than the copy the phone has', async () => {
  resetFullToolOutputs();
  window.mixdogDesktop = { readTranscriptItem: async () => ({ id: 'call-1', withheld: true }) };
  const view = await mount(CUT);
  await view.click();
  assert.equal(view.button().textContent, 'Retry');
  assert.match(view.result(), /omitted/u);
  await view.unmount();
});
