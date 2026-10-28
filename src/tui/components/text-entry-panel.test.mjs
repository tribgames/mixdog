// TextEntryPanel shares the prompt's modified-Enter newline rule
// (prompt-input/edit-helpers.mjs isModifiedEnterSequence): Shift, Alt/Meta and
// Ctrl + Enter insert a newline in a multiline panel instead of submitting.
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
  let frame = '';
  const write = stdout.write.bind(stdout);
  stdout.write = (chunk, ...args) => {
    frame = String(chunk);
    return write(chunk, ...args);
  };
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
    frame: () => frame,
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

test('a sign-in URL is drawn borderless with the full link, and Ctrl+Y copies it', async (context) => {
  const url =
    'https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&state=zzzzzzzzzzzzzzzzzzzz';
  const copied = [];
  const panel = mountPanel(context, { columns: 40, detail: url, copyText: (text) => copied.push(text) });
  await settle();
  const rows = stripVTControlCharacters(panel.frame())
    .split('\n')
    .filter((line) => !/[│╭╰]/.test(line))
    .map((line) => line.trimEnd());
  assert.equal(rows.join(''), `${url}Ctrl+Y copies the full URL`);
  assert.ok(panel.frame().includes(`\x1b]8;;${url}\x07`));
  await panel.type('\x19');
  assert.deepEqual(copied, [url]);
  assert.deepEqual(panel.submitted, []);
});
test('the URL block fits every panel budget and always keeps the full link and copy', async (context) => {
  const url = `https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference&code_challenge=${'a'.repeat(120)}&code_challenge_method=S256&state=${'z'.repeat(120)}`;
  assert.ok(url.length > 433);
  // urlMaxRows is what the panel can give the block; 6 chrome + 1 input row come first.
  for (const urlMaxRows of [7, 4, 2, 1, 0]) {
    const copied = [];
    const panel = mountPanel(context, {
      columns: 40,
      detail: url,
      urlMaxRows,
      hint: 'Open the URL below to sign in.',
      copyText: (text) => copied.push(text),
    });
    await settle();
    const frame = stripVTControlCharacters(panel.frame()).trimEnd();
    const message = `urlMaxRows ${urlMaxRows}\n${frame}`;
    assert.ok(frame.split('\n').length <= 7 + urlMaxRows, message);
    if (urlMaxRows === 0) assert.match(frame, /Ctrl\+Y copies the full URL/, message);
    else assert.match(frame, /https:\/\/claude\.ai\//, message);
    if (urlMaxRows > 0) assert.ok(panel.frame().includes(`\x1b]8;;${url}\x07`), message);
    await panel.type('\x19');
    assert.deepEqual(copied, [url], message);
  }
});
test('a terminal-only copy does not claim success and a failed copy points to the link', async (context) => {
  const url = 'https://example.test/auth';
  const sent = mountPanel(context, { columns: 80, detail: url, copyText: () => 'terminal' });
  await settle();
  await sent.type('\x19');
  assert.match(stripVTControlCharacters(sent.frame()), /Sent to terminal clipboard \(not confirmed\)/);
  const failed = mountPanel(context, { columns: 80, detail: url, copyText: () => Promise.reject(new Error('none')) });
  await settle();
  await failed.type('\x19');
  assert.match(stripVTControlCharacters(failed.frame()), /Copy failed.*use the link above/);
});
test('one-row URL mode still shows the copy note and every copy result', async (context) => {
  const url = `https://claude.ai/oauth/authorize?${'q'.repeat(433)}`;
  for (const [result, expected] of [
    [null, /Ctrl\+Y copies the full URL/],
    [() => 'copied', /URL copied/],
    [() => 'terminal', /Sent to terminal clipboard \(not confirmed\)/],
    [() => Promise.reject(new Error('none')), /Copy failed.*use the link above/],
  ]) {
    const panel = mountPanel(context, {
      columns: 80,
      detail: url,
      urlMaxRows: 1,
      hint: 'Open the URL below.',
      copyText: result,
    });
    await settle();
    assert.ok(panel.frame().includes(`\x1b]8;;${url}\x07`));
    if (result) await panel.type('\x19');
    const frame = stripVTControlCharacters(panel.frame()).trimEnd();
    assert.match(frame, expected, frame);
    assert.ok(frame.split('\n').length <= 8, frame);
  }
});
