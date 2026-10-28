import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PassThrough } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { build } from 'esbuild';
import React from 'react';
import { render, Text } from 'ink';

let directory;
let panels;
before(async () => {
  directory = mkdtempSync(resolve('.tmp-selection-panels-'));
  const outfile = join(directory, 'panels.mjs');
  await build({
    stdin: {
      contents: `
        export { ConfirmBar, clampConfirmFocus } from './ConfirmBar.jsx';
        export { ItemRightHintOverprint } from './ItemRightHintOverprint.jsx';
        export { Picker } from './Picker.jsx';
        export { QueuedCommands } from './QueuedCommands.jsx';
        export { SlashCommandPalette } from './SlashCommandPalette.jsx';
      `,
      resolveDir: resolve('src/tui/components'),
      loader: 'jsx',
    },
    outfile,
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    jsx: 'automatic',
    plugins: [
      {
        name: 'isolated-theme',
        setup(build) {
          build.onResolve({ filter: /\/theme\.mjs$/ }, () => ({ path: 'theme', namespace: 'fixture' }));
          build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
            contents: `export const theme = {
            text: 'white', subtle: 'gray', inactive: 'gray', error: 'red',
            warning: 'yellow', success: 'green', panelTitle: 'cyan',
            promptBorder: 'blue', selectionText: 'black', selectionBackground: 'white',
            userMessageBackground: 'black', mixdogIvory: 'white'
          };`,
          }));
        },
      },
    ],
  });
  panels = await import(pathToFileURL(outfile).href);
});
after(() => rmSync(directory, { recursive: true, force: true }));

function mount(context, columns = 100) {
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
  const settle = async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return stripVTControlCharacters(frame).trimEnd();
  };
  return {
    async show(Component, props) {
      view.rerender(React.createElement(Component, props));
      return settle();
    },
    raw: () => frame,
    async key(input) {
      stdin.write(input);
      return settle();
    },
  };
}

test('confirmation and overprint preserve empty, clamped and normalized content', async (context) => {
  assert.equal(panels.clampConfirmFocus(3, 2), 1);
  assert.equal(panels.clampConfirmFocus(-1, 2), -1);
  assert.equal(panels.clampConfirmFocus(NaN, 2), -1);
  assert.equal(panels.clampConfirmFocus(0, 0), -1);
  const view = mount(context);
  assert.equal(await view.show(panels.ConfirmBar, { buttons: [] }), '');
  assert.match(
    await view.show(panels.ConfirmBar, {
      buttons: [{ value: 'back', label: 'Back' }, null, { value: 'next', label: 'Next' }],
      focusedIndex: 1,
    }),
    /\[ Back \]\s+\[ Next \]/
  );
  assert.equal(
    await view.show(panels.ItemRightHintOverprint, {
      rightMessage: ' \n ',
      children: React.createElement(Text, null, 'body'),
    }),
    'body'
  );
  assert.match(
    await view.show(panels.ItemRightHintOverprint, {
      rightMessage: 'two\n words',
      children: React.createElement(Text, null, 'body'),
    }),
    /two words/
  );
});

test('picker preserves clipping, markers, metadata, selection and confirm navigation', async (context) => {
  const view = mount(context);
  const selected = [];
  const confirmed = [];
  const items = [
    { value: 'a', label: '界界abc', checked: true, metaParts: [{ text: 'abcdef', width: 3 }], description: 'first' },
    { value: 'b', label: 'Beta', checked: false, labelSuffix: 'S', description: 'second' },
  ];
  const props = {
    items,
    title: 'Choose',
    columns: 100,
    labelWidth: 4,
    metaWidth: 6,
    onSelect: (value) => selected.push(value),
    onCancel() {},
    footer: [{ glyph: '!', text: 'footer' }],
    confirmBar: { buttons: [{ value: 'ok', label: 'OK' }], onConfirm: (button) => confirmed.push(button.value) },
  };
  const initial = await view.show(panels.Picker, props);
  assert.match(initial, /✓ 界…/);
  assert.match(initial, /ab…/);
  assert.match(initial, /footer/);
  await view.key('\x1b[B');
  await view.key('\r');
  assert.deepEqual(selected, ['b']);
  await view.key('\x1b[C');
  await view.key('\r');
  assert.deepEqual(confirmed, ['ok']);
  await view.key('\x1b[D');
  const repeated = await view.show(panels.Picker, { ...props, items: [...items], themeEpoch: 1 });
  assert.match(repeated, /Beta|B…/);
  await view.key('\r');
  assert.deepEqual(selected, ['b', 'b']);
  assert.match(await view.show(panels.Picker, { ...props, items: [], loading: false }), /\(empty\)/);
  assert.doesNotMatch(await view.show(panels.Picker, { ...props, items: [], loading: true }), /\(empty\)/);
});

test('slash palette keeps aliases, acronym labels and fixed no-match height', async (context) => {
  const view = mount(context);
  const commands = [
    { name: 'mcp', description: 'servers' },
    { name: 'settings', aliases: ['config'], aliasUsage: ['/config'], description: 'options' },
  ];
  const normal = await view.show(panels.SlashCommandPalette, { commands, columns: 100, query: 'con' });
  assert.match(normal, /MCP/);
  assert.match(normal, /Settings \(\/config\)/);
  const empty = await view.show(panels.SlashCommandPalette, { commands: [], columns: 100 });
  assert.match(empty, /No matching commands/);
  assert.equal(empty.split('\n').length, normal.split('\n').length);
});

test('queued commands preserve compact UTF-16 slicing and full multiline output', async (context) => {
  const view = mount(context, 30);
  assert.equal(await view.show(panels.QueuedCommands, { queued: [], columns: 30 }), '');
  const queued = [{ id: 'q', text: 'abcdef\nghi' }];
  assert.match(await view.show(panels.QueuedCommands, { queued, columns: 9, compact: true }), /abcd…/);
  assert.match(await view.show(panels.QueuedCommands, { queued, columns: 5, compact: true }), /…/);
  const expanded = await view.show(panels.QueuedCommands, { queued, columns: 30 });
  assert.match(expanded, /abcdef\n\s+ghi/);
  assert.match(
    await view.show(panels.QueuedCommands, {
      queued: [{ id: 'q', text: 'ignored', displayText: 'ok' }],
      columns: 9,
      compact: true,
    }),
    /ok/
  );
});

test('picker draws a long sign-in URL borderless with the full link and a copy key', async (context) => {
  const url =
    'https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&state=zzzzzzzzzzzzzzzzzzzz';
  const copied = [];
  const view = mount(context, 40);
  const frame = await view.show(panels.Picker, {
    title: 'Provider',
    columns: 40,
    description: 'Open this URL to sign in:',
    detail: url,
    copyText: (text) => copied.push(text),
    items: [{ value: 'waiting', label: 'Waiting' }],
    onSelect() {},
    onCancel() {},
  });
  assert.doesNotMatch(frame, /…/);
  // The complete URL is one contiguous OSC 8 link target, and the rows that show it carry no border.
  assert.ok(view.raw().includes(`\x1b]8;;${url}\x07`));
  const rows = frame.split('\n').filter((line) => !/[│╭╰]/.test(line));
  assert.equal(rows.join(''), url + 'Ctrl+Y copies the full URL');
  assert.match(frame, /Waiting/);
  await view.key('c');
  assert.deepEqual(copied, [], 'a bare c is not the copy key');
  await view.key('\x19');
  assert.deepEqual(copied, [url]);
  assert.match(await view.key(''), /URL copied/);
});

const longUrl = `https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference&code_challenge=${'a'.repeat(120)}&code_challenge_method=S256&state=${'z'.repeat(120)}`;

test('picker URL block fits every panel budget and always keeps the full link and copy', async (context) => {
  assert.ok(longUrl.length > 433);
  // visibleCount 8 is the 14-row panel; smaller values are shorter terminals.
  for (const visibleCount of [8, 6, 4, 3, 2, 1]) {
    const copied = [];
    const view = mount(context, 40);
    const frame = await view.show(panels.Picker, {
      title: 'Provider',
      columns: 40,
      visibleCount,
      help: 'Esc Back',
      description: 'Open this URL to sign in:',
      detail: longUrl,
      copyText: (text) => copied.push(text),
      items: [
        { value: 'waiting', label: 'Waiting' },
        { value: 'back', label: 'Back' },
      ],
      onSelect() {},
      onCancel() {},
    });
    const message = `visibleCount ${visibleCount}\n${frame}`;
    assert.ok(frame.split('\n').length <= 6 + visibleCount, message);
    assert.match(frame, /Waiting|Back/, message);
    if (visibleCount === 1) assert.match(frame, /Ctrl\+Y copies the full URL/, message);
    else assert.match(frame, /https:\/\/claude\.ai\//, message);
    if (visibleCount > 1) assert.ok(view.raw().includes(`\x1b]8;;${longUrl}\x07`), message);
    await view.key('\x19');
    assert.deepEqual(copied, [longUrl], message);
  }
});
test('a device-code panel with a one-row warning footer keeps the code line at visibleCount 6', async (context) => {
  const view = mount(context, 80);
  const frame = await view.show(panels.Picker, {
    title: 'Provider',
    columns: 80,
    visibleCount: 6,
    description: 'Enter code ABCD-1234 at:',
    detail: 'https://example.test/device',
    footer: () => [{ glyph: '!', text: 'Continue only if you started this. Never enter a code someone sent you.' }],
    items: [
      { value: 'waiting', label: 'Waiting' },
      { value: 'back', label: 'Back' },
    ],
    onSelect() {},
    onCancel() {},
  });
  assert.match(frame, /Enter code ABCD-1234 at:/);
  assert.match(frame, /Never enter a code someone sent you\./);
  assert.match(frame, /Ctrl\+Y copies the full URL/);
});

test('picker reports what the copy actually did', async (context) => {
  const url = 'https://example.test/auth';
  for (const [result, expected] of [
    [() => 'copied', /URL copied/],
    [() => 'terminal', /Sent to terminal clipboard \(not confirmed\)/],
    [() => Promise.reject(new Error('no clipboard')), /Copy failed.*use the link above/],
  ]) {
    const view = mount(context, 80);
    await view.show(panels.Picker, {
      title: 'Provider',
      columns: 80,
      detail: url,
      copyText: result,
      items: [{ value: 'waiting', label: 'Waiting' }],
      onSelect() {},
      onCancel() {},
    });
    assert.match(await view.key('\x19'), expected);
  }
});

test('picker one-row URL mode still shows the copy note and every copy result', async (context) => {
  for (const [result, expected] of [
    [null, /Ctrl\+Y copies the full URL/],
    [() => 'copied', /URL copied/],
    [() => 'terminal', /Sent to terminal clipboard \(not confirmed\)/],
    [() => Promise.reject(new Error('none')), /Copy failed.*use the link above/],
  ]) {
    const view = mount(context, 80);
    const props = {
      title: 'Provider',
      columns: 80,
      visibleCount: 2, // 2 list items leave exactly one row for the URL
      help: 'Esc Back',
      description: 'Open this URL to sign in:',
      detail: longUrl,
      copyText: result,
      items: [
        { value: 'waiting', label: 'Waiting' },
        { value: 'back', label: 'Back' },
      ],
      onSelect() {},
      onCancel() {},
    };
    let frame = await view.show(panels.Picker, props);
    assert.ok(view.raw().includes(`\x1b]8;;${longUrl}\x07`));
    if (result) frame = await view.key('\x19');
    assert.match(frame, expected);
    assert.ok(frame.split('\n').length <= 8, frame);
  }
});