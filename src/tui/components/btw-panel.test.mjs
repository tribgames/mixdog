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
let BtwPanel;
before(async () => {
  directory = mkdtempSync(resolve('.tmp-btw-panel-test-'));
  const output = join(directory, 'btw-panel.mjs');
  await build({
    stdin: {
      contents: `export { BtwPanel } from './BtwPanel.jsx';`,
      resolveDir: resolve('src/tui/components'),
      loader: 'jsx',
    },
    outfile: output,
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    jsx: 'automatic',
  });
  ({ BtwPanel } = await import(pathToFileURL(output).href));
});
after(() => rmSync(directory, { recursive: true, force: true }));

const settle = (ms = 80) => new Promise((done) => setTimeout(done, ms));

function mount(context, props) {
  const stdout = new PassThrough();
  stdout.columns = 80;
  stdout.rows = 40;
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
  const view = render(React.createElement(BtwPanel, props), {
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
  return {
    text: () => stripVTControlCharacters(frame),
    key: async (input) => {
      stdin.write(input);
      await settle();
    },
  };
}

const longAnswer = Array.from({ length: 12 }, (_, i) => `entry-${i}`).join('\n');
const panel = { question: 'why?', status: 'done', text: longAnswer };

test('a long answer scrolls with PageDown/PageUp and shows a position hint', async (context) => {
  const view = mount(context, { panel, columns: 80, panelRows: 4 + 5 });
  await settle();
  assert.match(view.text(), /btw · why\?/);
  assert.match(view.text(), /entry-0/);
  assert.doesNotMatch(view.text(), /entry-11/);
  assert.match(view.text(), /PgUp\/PgDn scroll \(1-5\/\d+\)/);
  assert.match(view.text(), /Esc to close · not saved to the conversation/);

  for (let i = 0; i < 4; i += 1) await view.key('\u001b[6~');
  assert.match(view.text(), /entry-11/, 'the end of the answer is reachable');
  assert.doesNotMatch(view.text(), /entry-0\b/);

  for (let i = 0; i < 4; i += 1) await view.key('\u001b[5~');
  assert.match(view.text(), /entry-0\b/);
});

test('a short answer shows no scroll hint', async (context) => {
  const view = mount(context, { panel: { ...panel, text: 'short' }, columns: 80, panelRows: 4 + 5 });
  await settle();
  assert.match(view.text(), /short/);
  assert.doesNotMatch(view.text(), /PgUp/);
});
