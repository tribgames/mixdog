// #261: the sign-in URL printed under a panel must keep every row, and the hint
// row must sit on its own row below it. In a height-constrained panel box
// (fillHeight, as the app renders it) the wrapped URL Text used to be shrunk by
// the flex layout, so the hint overwrote the URL's last row.
import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PassThrough } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { build } from 'esbuild';
import React from 'react';
import { Box, render } from 'ink';

let directory;
let Picker;
let TextEntryPanel;

before(async () => {
  directory = mkdtempSync(resolve('.tmp-sign-in-url-panels-test-'));
  const outfile = join(directory, 'panels.mjs');
  await build({
    stdin: {
      contents: "export { Picker } from './Picker.jsx'; export { TextEntryPanel } from './TextEntryPanel.jsx';",
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
  ({ Picker, TextEntryPanel } = await import(pathToFileURL(outfile).href));
});
after(() => rmSync(directory, { recursive: true, force: true }));

const settle = (ms = 80) => new Promise((done) => setTimeout(done, ms));
const HINT = 'Ctrl+Y copies the full URL';

const ANTHROPIC_URL = `https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference&code_challenge=${'a'.repeat(43)}&code_challenge_method=S256&state=${'z'.repeat(43)}`;
const DEVICE_URL = 'https://github.com/login/device';

async function renderFrame(context, columns, element) {
  const stdout = new PassThrough();
  stdout.columns = columns;
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
  const view = render(element, { stdout, stdin, stderr: stdout, debug: true, exitOnCtrlC: false, patchConsole: false });
  context.after(() => {
    view.unmount();
    stdin.end();
    stdout.end();
  });
  await settle();
  // OSC 8 link targets carry the URL itself; drop them before the SGR strip.
  return stripVTControlCharacters(frame.replace(/\x1b\]8;;[^\x07]*\x07/g, ''))
    .split('\n')
    .map((line) => line.trimEnd());
}

// The rows under the panel border: the URL rows, then the hint row.
function belowBorder(rows) {
  const border = rows.findLastIndex((line) => line.startsWith('╰'));
  assert.ok(border >= 0, rows.join('\n'));
  return rows.slice(border + 1).filter((line) => line !== '');
}

function assertWholeUrlAndHint(rows, url) {
  const below = belowBorder(rows);
  const message = rows.join('\n');
  assert.equal(below.at(-1), HINT, message);
  assert.equal(below.slice(0, -1).join(''), url, message);
}

for (const columns of [40, 100, 200]) {
  for (const [name, url] of [
    ['anthropic oauth', ANTHROPIC_URL],
    ['device code', DEVICE_URL],
  ]) {
    test(`Picker keeps the whole ${name} URL and the hint on screen at ${columns} columns`, async (context) => {
      const items = Array.from({ length: 12 }, (_, index) => ({ value: `v${index}`, label: `Item ${index}` }));
      // A narrow panel wraps the URL over many rows; give the box room for all of them.
      const height = columns < 60 ? 30 : 17;
      const rows = await renderFrame(
        context,
        columns,
        React.createElement(
          Box,
          { flexDirection: 'column', flexShrink: 0, height, overflow: 'hidden', justifyContent: 'flex-end' },
          React.createElement(Picker, {
            items,
            title: 'Sign in',
            columns,
            detail: url,
            visibleCount: height - 6,
            fillHeight: true,
            onSelect() {},
            onCancel() {},
          })
        )
      );
      assertWholeUrlAndHint(rows, url);
    });

    test(`TextEntryPanel keeps the whole ${name} URL and the hint on screen at ${columns} columns`, async (context) => {
      const rows = await renderFrame(
        context,
        columns,
        React.createElement(TextEntryPanel, {
          title: 'Sign in',
          columns,
          detail: url,
          hint: 'Open the URL below to sign in.',
          onSubmit() {},
        })
      );
      assertWholeUrlAndHint(rows, url);
    });
  }
}
