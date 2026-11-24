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

const {
  FullToolOutputButton,
  heldToolOutputReads,
  prefetchToolOutputs,
  releaseToolOutputPrefetch,
  resetFullToolOutputs,
  useFullToolOutput,
} = await import(
  './tool-full-output.tsx'
);

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
    React.createElement('pre', { 'data-result': true }, String(output.item.result)),
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
    result: () => host.querySelector('[data-result]').textContent,
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

  // A remounted row (the virtual list) holds nothing of it: it can read it again.
  const again = await mount(CUT);
  assert.match(again.result(), /omitted/u);
  assert.equal(again.button().textContent, 'Show full output');
  assert.equal(reads.length, 2, 'no read until asked');
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

test('a prefetch holds its read while its group stays mounted; the read goes with the group and can be read again', async (t) => {
  resetFullToolOutputs();
  const originalApi = window.mixdogDesktop;
  t.after(() => {
    resetFullToolOutputs();
    window.mixdogDesktop = originalApi;
  });
  const asked = [];
  window.mixdogDesktop = {
    readTranscriptItem: async (sessionId, id) => {
      asked.push([sessionId, id]);
      return { id, result: FULL };
    },
  };
  const group = {};
  await act(async () => prefetchToolOutputs('session-1', [CUT], group));
  assert.equal(heldToolOutputReads(), 1, 'held for the group that asked');
  const row = await mount(CUT, { wanted: true });
  assert.equal(row.result(), FULL, 'the expanded row shows it at once');
  assert.equal(asked.length, 1);
  await row.unmount();
  assert.equal(heldToolOutputReads(), 1, 'the group still holds it');
  releaseToolOutputPrefetch(group);
  assert.equal(heldToolOutputReads(), 0, 'nothing observes it any more');
  const reopened = await mount(CUT, { wanted: true });
  assert.equal(reopened.result(), FULL);
  assert.equal(asked.length, 2, 'a dropped read is read again on expansion');
  await reopened.unmount();
});
test('a loaded output is released once its row unmounts and read again on reopening', async (t) => {
  resetFullToolOutputs();
  const originalApi = window.mixdogDesktop;
  t.after(() => {
    resetFullToolOutputs();
    window.mixdogDesktop = originalApi;
  });
  let reads = 0;
  window.mixdogDesktop = {
    readTranscriptItem: async (_sessionId, id) => ({ id, result: ++reads === 1 ? FULL : 'newer revision' }),
  };
  const first = await mount(CUT);
  try {
    await first.click();
    assert.equal(first.result(), FULL);
  } finally {
    await first.unmount();
  }
  assert.equal(heldToolOutputReads(), 0, 'nothing observes the output, so it is not held');
  const reopened = await mount(CUT, { wanted: true });
  try {
    assert.equal(reads, 2, 'the released output is read again');
  } finally {
    await reopened.unmount();
  }
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
  // Back to v1: v2's entry left with its row, and v1's text is never v2's.
  await view.render({ item: v1 });
  assert.match(view.result(), /omitted/u);
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

test('two revisions that differ only in the omitted middle do not share a read', async () => {
  resetFullToolOutputs();
  const WHOLE_1 = `a${'1'.repeat(5_000)}z`;
  const WHOLE_2 = `a${'2'.repeat(5_000)}z`;
  const v1 = { ...CUT, remoteOutputRevision: 'rev-1' };
  const v2 = { ...CUT, remoteOutputRevision: 'rev-2' };
  window.mixdogDesktop = { readTranscriptItem: async () => ({ id: 'call-1', result: WHOLE_1, rawResult: WHOLE_1 }) };
  const view = await mount(v1);
  await view.click();
  assert.equal(view.result(), WHOLE_1);
  await view.render({ item: v2 });
  assert.equal(view.result(), CUT.result, 'the older middle is not shown for the newer revision');
  assert.equal(view.button().textContent, 'Show full output');
  window.mixdogDesktop = { readTranscriptItem: async () => ({ id: 'call-1', result: WHOLE_2, rawResult: WHOLE_2 }) };
  await view.click();
  assert.equal(view.result(), WHOLE_2);
  await view.unmount();
});

test('a grouped card reads its diff by the member the digest belongs to, and keeps its own output', async () => {
  resetFullToolOutputs();
  const digest = {
    sections: [
      {
        names: ['b.ts', 'b.ts'],
        counts: { additions: 1, deletions: 0 },
        statuses: ['M'],
        targetPath: 'b.ts',
        files: [],
      },
    ],
  };
  const card = {
    id: 'first-call',
    kind: 'tool',
    name: '__aggregate__',
    aggregate: true,
    result: 'two edits',
    uiDiffSummary: digest,
    uiDiffMemberId: 'second-call',
  };
  const reads = [];
  window.mixdogDesktop = {
    readTranscriptItem: async (_sessionId, itemId) => {
      reads.push(itemId);
      return { id: itemId, result: 'ok: b.ts', uiDiff: 'diff --git a/b.ts b/b.ts\n' };
    },
  };
  const view = await mount(card, { wanted: true });
  assert.deepEqual(reads, ['second-call']);
  assert.equal(view.result(), 'two edits');
  await view.unmount();
});

test('Copy on a cut row asks for the whole output and copies that, never the preview', async () => {
  resetFullToolOutputs();
  const { ToolPanel, ToolCopyGateContext } = await import('./transcript-tool-panel.tsx');
  const written = [];
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (text) => void written.push(text) },
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let loads = 0;
  const panel = (gate, value) =>
    React.createElement(
      ToolCopyGateContext.Provider,
      { value: gate },
      React.createElement(ToolPanel, { copyValue: value }, 'body')
    );
  await act(async () =>
    root.render(
      panel(
        {
          load: () => {
            loads += 1;
          },
          failed: false,
        },
        'preview'
      )
    )
  );
  await act(async () => host.querySelector('button').dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
  assert.equal(loads, 1, 'the click asks for the whole output');
  assert.deepEqual(written, [], 'the preview was not copied');
  await act(async () => root.render(panel(null, 'the whole output')));
  assert.deepEqual(written, ['the whole output']);
  await act(async () => root.unmount());
  host.remove();
});

test('a row the core sent cut is read when the person asks, never ahead of that', async (t) => {
  resetFullToolOutputs();
  const originalApi = window.mixdogDesktop;
  const reads = [];
  t.after(() => {
    resetFullToolOutputs();
    window.mixdogDesktop = originalApi;
  });
  window.mixdogDesktop = {
    readTranscriptItem: (sessionId, id) => {
      reads.push([sessionId, id]);
      return Promise.resolve({ id, result: FULL });
    },
  };
  const onRequest = { ...CUT, id: 'core-cut', remoteOutputOnRequest: true };
  await act(async () => prefetchToolOutputs('session-1', [onRequest, { ...CUT, id: 'phone-cut' }], {}));
  assert.deepEqual(reads, [['session-1', 'phone-cut']], 'the phone-cut row is prefetched from its own state, the core-cut one is not');
  const view = await mount(onRequest);
  await view.click();
  assert.deepEqual(reads.at(-1), ['session-1', 'core-cut'], 'pressing "Show full output" reads it');
  await view.unmount();
});
