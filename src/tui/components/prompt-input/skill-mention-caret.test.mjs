// Caret-aware `$name` completion through the real PromptInput: the input
// reports its caret, the palette accept/complete receives it, and a
// { value, cursor } result replaces the draft with the caret after `$name `.
import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PassThrough } from 'node:stream';
import { build } from 'esbuild';
import React from 'react';
import { render } from 'ink';
import { completeSkillMention, skillMentionQuery } from '../../app/skill-mention-palette.mjs';

let directory;
let PromptInput;

before(async () => {
  directory = mkdtempSync(resolve('.tmp-prompt-skill-caret-test-'));
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
const LEFT = '\x1b[D';
const ESC = '\x1b';

// Mounts PromptInput the way App wires the skill palette: the palette is
// active while a mention precedes the reported caret.
function mountPrompt(context, initialValue) {
  const stdout = new PassThrough();
  stdout.columns = 80;
  stdout.rows = 20;
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
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
  const state = { value: initialValue, caret: null, accepts: [], cancels: [], submits: [] };
  const valueRef = { current: '' };
  const show = () => {
    const active = skillMentionQuery(state.value, state.caret ?? undefined) !== null;
    view.rerender(
      React.createElement(PromptInput, {
        valueRef,
        initialValue,
        onSubmit: (value) => state.submits.push(value),
        onDraftChange: (value) => {
          state.value = value;
        },
        onCaretChange: (caret) => {
          state.caret = caret;
        },
        commandPaletteActive: active,
        commandPaletteOptionCount: active ? 1 : 0,
        commandPaletteMovesCaret: true,
        onCommandPaletteAccept: (value, caret) => {
          state.accepts.push({ value, caret });
          return completeSkillMention(value, 'pdf-tools', caret) ?? false;
        },
        onCommandPaletteComplete: (value, caret) => completeSkillMention(value, 'pdf-tools', caret),
        onCommandPaletteCancel: (value) => state.cancels.push(value),
      })
    );
  };
  return {
    state,
    valueRef,
    type: async (input) => {
      for (const chunk of Array.isArray(input) ? input : [input]) {
        stdin.write(chunk);
        await settle();
        show();
        await settle();
      }
    },
    show: async () => {
      show();
      await settle();
    },
  };
}

test('Enter inserts the skill at a mid-text caret, keeps the suffix, and leaves the caret after it', async (context) => {
  const view = mountPrompt(context, 'fix  then ship');
  await view.show();
  assert.equal(view.state.caret, 14, 'mount reports the caret at the end');
  await view.type([...Array(10).fill(LEFT)]);
  assert.equal(view.state.caret, 4);
  await view.type(['$', 'p', 'd']);
  assert.equal(view.state.value, 'fix $pd then ship');
  assert.equal(view.state.caret, 7);
  await view.type('\r');
  assert.deepEqual(view.state.accepts, [{ value: 'fix $pd then ship', caret: 7 }]);
  assert.equal(view.valueRef.current, 'fix $pdf-tools  then ship');
  assert.equal(view.state.caret, 15);
  // Typing continues at the caret, right after the inserted `$pdf-tools `.
  await view.type('x');
  assert.equal(view.valueRef.current, 'fix $pdf-tools x then ship');
});

test('Tab completes at the caret on a later line of a multi-line draft', async (context) => {
  const view = mountPrompt(context, 'first line\n\nlast line');
  await view.show();
  await view.type([...Array(10).fill(LEFT)]);
  assert.equal(view.state.caret, 11);
  await view.type(['$', 'p']);
  await view.type('\t');
  assert.equal(view.valueRef.current, 'first line\n$pdf-tools \nlast line');
  assert.equal(view.state.caret, 22);
});

test('Left/Right move the caret while the skill palette is open; Esc cancels without editing', async (context) => {
  const view = mountPrompt(context, '');
  await view.show();
  await view.type(['$', 'p', 'd']);
  await view.type(LEFT);
  assert.equal(view.state.caret, 2, 'the caret moved instead of the palette selection');
  await view.type(ESC);
  assert.deepEqual(view.state.cancels, ['$pd']);
  assert.equal(view.valueRef.current, '$pd');
});

test('$HOME mid-text never activates the palette, so Enter submits as usual', async (context) => {
  const view = mountPrompt(context, 'echo $HOME please');
  await view.show();
  await view.type([...Array(7).fill(LEFT)]);
  assert.equal(view.state.caret, 10);
  assert.equal(skillMentionQuery(view.state.value, view.state.caret), null);
  await view.type('\r');
  assert.deepEqual(view.state.accepts, []);
  assert.deepEqual(view.state.submits, ['echo $HOME please']);
});
