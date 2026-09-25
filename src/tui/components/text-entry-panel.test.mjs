// TextEntryPanel shares the prompt's modified-Enter newline rule
// (prompt-input/edit-helpers.mjs isModifiedEnterSequence): Shift, Alt/Meta and
// Ctrl + Enter insert a newline in a multiline panel instead of submitting.
import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PassThrough } from 'node:stream';
import { build } from 'esbuild';
import React from 'react';
import { render } from 'ink';

let directory;
let TextEntryPanel;

before(async () => {
  directory = mkdtempSync(resolve('.tmp-text-entry-panel-test-'));
  const outfile = join(directory, 'text-entry-panel.mjs');
  await build({
    stdin: {
      contents: "export { TextEntryPanel } from './TextEntryPanel.jsx';",
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
  ({ TextEntryPanel } = await import(pathToFileURL(outfile).href));
});
after(() => rmSync(directory, { recursive: true, force: true }));

const settle = (ms = 60) => new Promise((done) => setTimeout(done, ms));

function mountPanel(context, props) {
  const stdout = new PassThrough();
  stdout.columns = 80;
  stdout.rows = 20;
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  const submitted = [];
  const view = render(
    React.createElement(TextEntryPanel, {
      title: 'Edit',
      columns: 80,
      onSubmit: (value) => {
        submitted.push(value);
      },
      ...props,
    }),
    { stdout, stdin, stderr: stdout, debug: true, exitOnCtrlC: false, patchConsole: false }
  );
  context.after(() => {
    view.unmount();
    stdin.end();
    stdout.end();
  });
  return {
    submitted,
    type: async (input) => {
      stdin.write(input);
      await settle();
    },
  };
}

for (const [label, sequence] of [
  ['Shift+Enter, kitty', '\x1b[13;2u'],
  ['Alt+Enter, kitty', '\x1b[13;3u'],
  ['Alt+Enter, modifyOtherKeys', '\x1b[27;3;13~'],
]) {
  test(`${label} inserts a newline in a multiline text entry, like the prompt`, async (context) => {
    const panel = mountPanel(context, { multiline: true, initialValue: 'ab' });
    await settle();
    await panel.type(sequence);
    await panel.type('c');
    await panel.type('\r');
    assert.deepEqual(panel.submitted, ['ab\nc']);
  });
}
