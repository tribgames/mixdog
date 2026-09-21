import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PassThrough } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { build } from 'esbuild';
import React from 'react';
import stringWidth from 'string-width';

let directory;
let surfaces;
let render;
let initialTheme;
const previousForceColor = process.env.FORCE_COLOR;

before(async () => {
  process.env.FORCE_COLOR = '3';
  ({ render } = await import('ink'));
  directory = mkdtempSync(resolve('.tmp-transcript-rendering-test-'));
  const output = join(directory, 'transcript.mjs');
  await build({
    stdin: {
      contents: `
        export { AnsiText } from './AnsiText.jsx';
        export { Markdown, StreamingMarkdown } from './Markdown.jsx';
        export { AssistantMessage, UserMessage, NoticeMessage } from './Message.jsx';
        export { MarkdownTable } from './MarkdownTable.jsx';
        export { Item, ToolHookDenialCard } from './TranscriptItem.jsx';
        export { TurnDone, StatusDone } from './TurnDone.jsx';
        export { theme, getThemeVersion, getThemeSetting, setThemeSetting } from '../theme.mjs';
      `,
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
  surfaces = await import(pathToFileURL(output).href);
  initialTheme = surfaces.getThemeSetting();
});

after(() => {
  surfaces.setThemeSetting(initialTheme, { persist: false });
  rmSync(directory, { recursive: true, force: true });
  if (previousForceColor === undefined) delete process.env.FORCE_COLOR;
  else process.env.FORCE_COLOR = previousForceColor;
});

function mountSurface(context, columns = 80) {
  const stdout = new PassThrough();
  stdout.columns = columns;
  stdout.rows = 30;
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  let frame = '';
  const write = stdout.write.bind(stdout);
  // Ink debug writes empty frames too; PassThrough emits no data event for them.
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
  return async (Component, props) => {
    view.rerender(React.createElement(Component, props));
    await new Promise((resolve) => setTimeout(resolve, 80));
    return { frame, text: stripVTControlCharacters(frame).trimEnd() };
  };
}

function foreground(color) {
  return `\x1b[38;2;${color.slice(4, -1).replaceAll(',', ';')}m`;
}

test('ANSI spans preserve style resets, RGB colors, Unicode and repeated parsing', async (context) => {
  const show = mountSurface(context);
  const bold = await show(surfaces.AnsiText, { children: '\x1b[1mBold\x1b[22m plain' });
  assert.equal(bold.text, 'Bold plain');
  assert.ok(bold.frame.includes('\x1b[1mBold\x1b[22m'));

  const props = {
    children: '\x1b[38;2;1;2;3m界👩‍💻\x1b[39m plain',
    defaultColor: 'rgb(4,5,6)',
  };
  const colored = await show(surfaces.AnsiText, props);
  assert.equal(colored.text, '界👩‍💻 plain');
  assert.ok(colored.frame.includes('\x1b[38;2;1;2;3m'));
  assert.ok(colored.frame.includes('\x1b[38;2;4;5;6m'));
  const background = await show(surfaces.AnsiText, { children: '\x1b[48;2;7;8;9mBG\x1b[49m plain' });
  assert.equal(background.text, 'BG plain');
  assert.ok(background.frame.includes('\x1b[48;2;7;8;9m'));
  assert.equal((await show(surfaces.AnsiText, { children: '\x1b[999mplain' })).text, 'plain');
  assert.equal((await show(surfaces.AnsiText, { children: '\x1b[31m' })).text, '');
  assert.equal((await show(surfaces.AnsiText, props)).frame, colored.frame);
});

test('256-color SGR sequences keep their color instead of being dropped', async (context) => {
  const show = mountSurface(context);
  // 196 = cube index (5,0,0); 21 = cube index (0,0,5).
  const cube = await show(surfaces.AnsiText, { children: '\x1b[38;5;196mred\x1b[39m plain' });
  assert.equal(cube.text, 'red plain');
  assert.ok(cube.frame.includes('\x1b[38;2;255;0;0m'));
  const background = await show(surfaces.AnsiText, { children: '\x1b[48;5;21mBG\x1b[49m plain' });
  assert.equal(background.text, 'BG plain');
  assert.ok(background.frame.includes('\x1b[48;2;0;0;255m'));
});

test('theme versions and memo-busting props repaint unchanged ANSI, markdown and user text', async (context) => {
  const show = mountSurface(context);
  context.after(() => surfaces.setThemeSetting(initialTheme, { persist: false }));
  surfaces.theme.error = 'rgb(1,2,3)';
  const ansiProps = { children: '\x1b[31mtheme\x1b[39m' };
  assert.ok((await show(surfaces.AnsiText, ansiProps)).frame.includes(foreground('rgb(1,2,3)')));
  surfaces.setThemeSetting(initialTheme, { persist: false });
  assert.ok((await show(surfaces.AnsiText, ansiProps)).frame.includes(foreground(surfaces.theme.error)));

  surfaces.theme.mdHeading = 'rgb(11,22,33)';
  const markdownProps = { children: '# Heading', columns: 80, themeEpoch: surfaces.getThemeVersion() };
  assert.ok((await show(surfaces.Markdown, markdownProps)).frame.includes(foreground('rgb(11,22,33)')));
  surfaces.setThemeSetting(initialTheme, { persist: false });
  const markdown = await show(surfaces.Markdown, { ...markdownProps, themeEpoch: surfaces.getThemeVersion() });
  assert.ok(markdown.frame.includes(foreground(surfaces.theme.mdHeading)));

  surfaces.theme.userMessageBackground = 'rgb(10,20,30)';
  const userProps = { text: 'same user text', columns: 40, themeEpoch: 0 };
  assert.ok((await show(surfaces.UserMessage, userProps)).frame.includes('\x1b[48;2;10;20;30m'));
  surfaces.theme.userMessageBackground = 'rgb(30,20,10)';
  const user = await show(surfaces.UserMessage, { ...userProps, themeEpoch: 1 });
  assert.ok(user.frame.includes('\x1b[48;2;30;20;10m'));
  assert.match(user.text, /same user text/);
});

test('streaming chunks, assistant windows and forced-width tables keep visible text through rerenders', async (context) => {
  const show = mountSurface(context, 40);
  const prefix = '**stable**\n\n```txt\nlive';
  const props = { children: prefix, columns: 37, streamKey: 'component-round' };
  const first = await show(surfaces.StreamingMarkdown, props);
  assert.equal(first.text.split('stable').length - 1, 1);
  const grown = await show(surfaces.StreamingMarkdown, { ...props, children: `${prefix}\nmore` });
  assert.equal(grown.text.split('stable').length - 1, 1);
  assert.match(grown.text, /live/);
  assert.match(grown.text, /more/);
  assert.match((await show(surfaces.StreamingMarkdown, { ...props, children: '**tail**' })).text, /tail/);

  const assistant = {
    text: 'line one\nline two\nline three',
    columns: 40,
    assistantId: 'window',
    streamingWindowRows: 2,
  };
  const windowed = await show(surfaces.AssistantMessage, { ...assistant, streaming: true });
  assert.doesNotMatch(windowed.text, /line one/);
  assert.match(windowed.text, /line two/);
  assert.match((await show(surfaces.AssistantMessage, { ...assistant, streaming: false })).text, /line one/);

  const cell = (text) => ({ tokens: [{ type: 'text', text }] });
  const table = await show(surfaces.MarkdownTable, {
    token: { header: [cell('A'), cell('B')], rows: [[cell(''), cell('ok')]], align: [] },
    forceWidth: 10,
  });
  assert.equal(table.text, 'A:\nB: ok');
});

test('notice tones preserve prefixes and warning colors', async (context) => {
  const show = mountSurface(context);
  for (const [tone, expected] of [
    ['error', 'hello'],
    ['plain', 'hello'],
    ['warn', '· hello'],
    ['info', '· hello'],
    ['other', '· hello'],
  ]) {
    const result = await show(surfaces.NoticeMessage, { text: 'hello', tone, columns: 80 });
    assert.equal(result.text.trim(), expected);
    if (tone === 'warn') assert.ok(result.frame.includes(foreground(surfaces.theme.warning)));
  }
});

test('hook-denial headers and details sanitize ANSI and controls without adding rows', async (context) => {
  const show = mountSurface(context);
  const result = await show(surfaces.ToolHookDenialCard, {
    item: {
      name: 'read',
      args: { file_path: '\x1b[31mpath\x1b[0m\x00part\tfile.txt' },
      result: 'Error: tool "read" denied\r\nreason\twith\x00controls\x7f',
    },
    columns: 80,
  });
  assert.match(result.text, /path part file\.txt/);
  assert.match(result.text, /Denied/);
  assert.match(result.text, /denied reason with controls/);
  assert.equal(result.text.split('\n').filter((line) => line.trim()).length, 2);
});

test('completion rows preserve copy and right-slot layout across updates', async (context) => {
  const show = mountSurface(context, 60);
  for (const [props, expected] of [
    [{}, 'Thought'],
    [{ elapsedMs: 5000 }, 'Response complete'],
    [{ elapsedMs: 12000 }, 'Thought for 12s'],
    [{ elapsedMs: 12000, toolCount: 2 }, 'Work complete in 12s'],
    [{ toolCount: 2 }, 'Work complete'],
    [{ status: 'cancelled', elapsedMs: 12000 }, 'Cancelled after 12s'],
    [{ status: 'cancelled' }, 'Cancelled'],
  ]) {
    const result = await show(surfaces.TurnDone, {
      ...props,
      rightMessage: ' ready\n now ',
      rightMessageWidth: 12,
      marginTop: 0,
    });
    assert.ok(result.text.includes(expected));
    assert.ok(result.text.endsWith('ready now'));
    assert.equal(result.text.split('\n').length, 1);
    assert.ok(stringWidth(result.text) <= 60);
  }
  const props = { label: 'Done', detail: '2 tasks', rightMessage: 'next step', rightMessageWidth: 12, marginTop: 0 };
  const first = await show(surfaces.StatusDone, props);
  assert.match(first.text, /Done · 2 tasks/);
  assert.ok(first.text.endsWith('next step'));
  const withoutHint = await show(surfaces.StatusDone, { ...props, rightMessage: '' });
  assert.doesNotMatch(withoutHint.text, /next step/);
  assert.equal((await show(surfaces.StatusDone, props)).frame, first.frame);
});
