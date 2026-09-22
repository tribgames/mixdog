// Draft-override application (PromptInput.jsx:319-340).
//
// An override is a { id, value, cursor, selectionAnchor } publication; the
// publishers stamp it with Date.now() (app/use-prompt-queue-history.mjs:84,
// app/message-selector.mjs:67, app/prompt-handlers/use-prompt-interrupt.mjs:44)
// and a queued restore publishes twice in one flow — the optimistic local
// projection, then the daemon-authoritative reconciliation a microtask later.
// Two publications inside one millisecond therefore carry the SAME id, so the
// effect cannot key on id alone; and a re-publication of the same text under a
// new id must still re-apply. Both halves are pinned below.
import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PassThrough } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { build } from 'esbuild';
import React from 'react';
import { render } from 'ink';

let directory;
let PromptInput;

before(async () => {
  directory = mkdtempSync(resolve('.tmp-prompt-input-test-'));
  const outfile = join(directory, 'prompt-input.mjs');
  await build({
    stdin: {
      contents: "export { PromptInput } from './PromptInput.jsx';",
      resolveDir: resolve('src/tui/components'),
      loader: 'jsx',
    },
    outfile,
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    jsx: 'automatic',
  });
  ({ PromptInput } = await import(pathToFileURL(outfile).href));
});
after(() => rmSync(directory, { recursive: true, force: true }));

const settle = (ms = 60) => new Promise((done) => setTimeout(done, ms));

function mountPrompt(context) {
  const stdout = new PassThrough();
  stdout.columns = 80;
  stdout.rows = 20;
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  let frame = '';
  const write = stdout.write.bind(stdout);
  stdout.write = (chunk, ...args) => {
    frame = String(chunk);
    return write(chunk, ...args);
  };
  const view = render(React.createElement(React.Fragment), {
    stdout,
    stdin,
    stderr: stdout,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  context.after(() => {
    view.unmount();
    stdin.end();
    stdout.end();
  });
  const valueRef = { current: '' };
  return {
    valueRef,
    text: () => stripVTControlCharacters(frame).trim(),
    show: async (props) => {
      view.rerender(React.createElement(PromptInput, { valueRef, ...props }));
      await settle();
    },
    type: async (input) => {
      stdin.write(input);
      await settle();
    },
  };
}

test('a draft override applies on every published field, not on its id alone', async (context) => {
  const view = mountPrompt(context);

  await view.show({ draftOverride: { id: 7, value: 'optimistic queued text' } });
  assert.equal(view.valueRef.current, 'optimistic queued text');

  // The reconciliation of the same restore: a different draft under the id its
  // publisher already used this millisecond.
  await view.show({ draftOverride: { id: 7, value: 'authoritative queued text', cursor: 4 } });
  assert.equal(view.valueRef.current, 'authoritative queued text');
  assert.match(view.text(), /authoritative queued text/);

  // A new id republishing text the editor already holds still re-applies, so
  // picking the same message again after editing the draft restores it.
  await view.type('!');
  assert.equal(view.valueRef.current, 'auth!oritative queued text');
  await view.show({ draftOverride: { id: 8, value: 'authoritative queued text', cursor: 4 } });
  assert.equal(view.valueRef.current, 'authoritative queued text');
});
