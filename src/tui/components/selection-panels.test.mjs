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
    plugins: [{
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
    }],
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
    stdout, stdin, stderr: stdout, debug: true, exitOnCtrlC: false, patchConsole: false,
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
  assert.match(await view.show(panels.ConfirmBar, {
    buttons: [{ value: 'back', label: 'Back' }, null, { value: 'next', label: 'Next' }],
    focusedIndex: 1,
  }), /\[ Back \]\s+\[ Next \]/);
  assert.equal(await view.show(panels.ItemRightHintOverprint, {
    rightMessage: ' \n ', children: React.createElement(Text, null, 'body'),
  }), 'body');
  assert.match(await view.show(panels.ItemRightHintOverprint, {
    rightMessage: 'two\n words', children: React.createElement(Text, null, 'body'),
  }), /two words/);
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
    items, title: 'Choose', columns: 100, labelWidth: 4, metaWidth: 6,
    onSelect: (value) => selected.push(value), onCancel() {},
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
  assert.match(await view.show(panels.QueuedCommands, {
    queued: [{ id: 'q', text: 'ignored', displayText: 'ok' }], columns: 9, compact: true,
  }), /ok/);
});
