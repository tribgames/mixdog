import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createBrowserVisualPrivacy } from './visual-privacy.ts';
import { observationActions } from './actions/observe.ts';

function fixture() {
  const state = { sensitiveValues: new Set() };
  let text = '';
  let values = [];
  let revision = '1:0:800:600:0:0:0:0:0';
  let reads = 0;
  let expression = '';
  let focused = false;
  const guard = createBrowserVisualPrivacy({
    state: { peek: () => state },
    documents: {
      pageText: async () => {
        reads++;
        return text;
      },
      collect: async (_guest, script) => {
        if (script.includes('activeElement')) return [focused];
        expression = script;
        return [values];
      },
      revision: async () => revision,
    },
  });
  return {
    state,
    guard,
    text: (value) => {
      text = value;
    },
    values: (value) => {
      values = value;
    },
    revision: (value) => {
      revision = value;
    },
    reads: () => reads,
    expression: () => expression,
    focus: (value) => {
      focused = value;
    },
  };
}

test('a focused unregistered password field withholds visual output before and after capture', async () => {
  const f = fixture();
  f.focus(true);
  await assert.rejects(f.guard({}), /Visual output withheld/);
  f.focus(false);
  const finish = await f.guard({});
  f.focus(true);
  await assert.rejects(finish(), /Visual output withheld/);
  f.focus(false);
  await (await f.guard({}))();
  assert.equal(f.reads(), 0, 'no registered secret: no page-text read');
});

test('registered secrets echoed in text or plain controls prevent new visual output', async () => {
  for (const place of ['text', 'values']) {
    const f = fixture();
    f.state.sensitiveValues.add('synthetic-private-value');
    f[place](place === 'text' ? 'prefix synthetic-private-value' : ['synthetic-private-value']);
    await assert.rejects(f.guard({}), /Visual output withheld/);
  }
});

test('a protected capture is discarded if a secret appears, registration changes or the page changes during capture', async () => {
  for (const change of ['text', 'registration', 'document']) {
    const f = fixture();
    f.state.sensitiveValues.add('synthetic-private-value');
    const finish = await f.guard({});
    if (change === 'text') f.text('synthetic-private-value');
    if (change === 'registration') f.state.sensitiveValues.add('another-private-value');
    if (change === 'document') f.revision('1:1:800:600:0:0:1:0:0');
    await assert.rejects(finish(), /Visual output withheld/);
  }
});

test('pages without registered secrets need no extra document reads, but mid-capture registration is refused', async () => {
  const f = fixture();
  await (await f.guard({}))();
  assert.equal(f.reads(), 0);
  const finish = await f.guard({});
  f.state.sensitiveValues.add('new-private-value');
  await assert.rejects(finish(), /Visual output withheld/);
});

test('masked password fields are not mistaken for visible plaintext values', async () => {
  const f = fixture();
  f.state.sensitiveValues.add('synthetic-private-value');
  await (await f.guard({}))();
  const dom = new JSDOM('<input type="password" value="synthetic-private-value"><input value="public">', {
    runScripts: 'outside-only',
  });
  try {
    for (const input of dom.window.document.querySelectorAll('input')) input.getClientRects = () => [{}];
    assert.deepEqual(Array.from(dom.window.eval(f.expression())), ['public']);
  } finally {
    dom.window.close();
  }
});

test('PDF output passes the same guard before printing or persisting anything', async () => {
  let printed = false;
  await assert.rejects(
    observationActions.snapshot({
      guest: {
        printToPDF: async () => {
          printed = true;
          return Buffer.from('private');
        },
      },
      command: { mode: 'visual', format: 'pdf' },
      services: {
        screenshots: {
          prepareVisualOutput: async () => {
            throw new Error('Visual output withheld');
          },
        },
      },
    }),
    /Visual output withheld/
  );
  assert.equal(printed, false);
});
