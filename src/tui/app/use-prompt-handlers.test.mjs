import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import React, { useState } from 'react';
import { Text, render } from 'ink';
import { usePromptHandlers } from './use-prompt-handlers.mjs';
import { shouldFoldPastedText } from '../paste-text-policy.mjs';

// The four PromptInput handlers, mounted through the real hook: what each
// paste shape turns into, how history navigation walks and resets, which Esc
// phase does what, and how an interrupt restores the draft (sync and async).

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

function Harness({ control, deps }) {
  const [busy, setBusy] = useState(false);
  control.setBusy = setBusy;
  control.busy = busy;
  control.api = usePromptHandlers({ ...deps, state: { ...deps.state, busy } });
  return React.createElement(Text, null, busy ? 'busy' : 'idle');
}

function mount(
  context,
  { history = [], abort = () => ({ aborted: true }), usagePanel = null, contextPanel = null } = {}
) {
  const calls = {
    hints: [],
    hintClears: 0,
    registeredImages: [],
    registeredTexts: [],
    installedImages: [],
    installedTexts: [],
    clearedImages: [],
    clearedTexts: [],
    layoutRows: [],
    draftOverrides: [],
    navResets: 0,
    restoreQueued: [],
    contexts: [],
    usageClosed: 0,
    remembered: [],
    notices: [],
    selectorOpened: 0,
  };
  const control = { busy: false };
  const refs = {
    promptValueRef: { current: '' },
    promptHistoryNavRef: { current: { active: false, index: -1, seed: '', lastValue: '' } },
    promptHistoryDraftChangeRef: { current: false },
  };
  const deps = {
    store: {
      rememberPromptHistory: (text) => calls.remembered.push(text),
      getState: () => ({ busy: control.busy }),
      abortAsync: abort,
      pushNotice: (message, tone) => calls.notices.push([message, tone]),
    },
    state: { cwd: process.cwd(), provider: 'openai' },
    ...refs,
    setPromptDraftOverride: (value) => calls.draftOverrides.push(value),
    surface: { claim: () => ({ context: (value) => calls.contexts.push(value) }) },
    syncPromptLayoutRows: (text) => calls.layoutRows.push(text),
    showPromptHint: (...args) => calls.hints.push(args),
    clearPromptHint: () => {
      calls.hintClears += 1;
    },
    recentPromptHistory: history,
    resetPromptHistoryNav: () => {
      calls.navResets += 1;
      refs.promptHistoryNavRef.current = { active: false, index: -1, seed: '', lastValue: '' };
    },
    restoreQueuedToPrompt: (options) => {
      calls.restoreQueued.push(options);
      return false;
    },
    openMessageSelector: () => {
      calls.selectorOpened += 1;
      return true;
    },
    usagePanel,
    closeUsagePanel: () => {
      calls.usageClosed += 1;
    },
    contextPanel,
    installPastedImages: (images, options) => calls.installedImages.push([images, options]),
    clearPastedImagesSnapshot: (...args) => calls.clearedImages.push(args),
    registerPastedImage: (image) => {
      calls.registeredImages.push(image);
      return `[img:${calls.registeredImages.length}]`;
    },
    installPastedTexts: (texts, options) => calls.installedTexts.push([texts, options]),
    clearPastedTextsSnapshot: (...args) => calls.clearedTexts.push(args),
    registerPastedText: (text) => {
      calls.registeredTexts.push(text);
      return `[paste:${calls.registeredTexts.length}]`;
    },
  };
  const stdout = new PassThrough();
  stdout.columns = 40;
  stdout.rows = 10;
  stdout.on('data', () => {});
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  const view = render(React.createElement(Harness, { control, deps }), {
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
  const settle = (ms = 40) => delay(ms);
  return { control, calls, refs, settle };
}

test('paste inserts short text raw, folds large text, and resolves image paths into attachment refs', async (context) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-prompt-paste-'));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  const imagePath = join(dir, 'tiny.png');
  writeFileSync(imagePath, TINY_PNG);
  const { control, calls, settle } = mount(context);
  await settle();
  const paste = control.api.handlePromptPaste;

  assert.equal(paste('short text'), undefined);
  assert.deepEqual(calls.registeredTexts, []);

  const big = Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n');
  assert.equal(shouldFoldPastedText(big), true);
  assert.equal(paste(big), '[paste:1]');
  assert.deepEqual(calls.registeredTexts, [big]);

  const mixed = await paste(`before\n${imagePath}\nafter`);
  assert.equal(mixed, 'before\n[img:1]\nafter');
  assert.equal(calls.registeredImages[0].filename, 'tiny.png');
  assert.equal(calls.registeredImages[0].type, 'image');
  assert.deepEqual(calls.hints.at(-1), ['attached tiny.png', 'plain']);

  const missing = await paste(`${join(dir, 'missing.png')}`);
  assert.equal(missing, join(dir, 'missing.png'), 'an unreadable image path stays plain text');
  assert.equal(calls.registeredImages.length, 1);
});

test('history navigation walks recent prompts, skips duplicates of the current text, and restores the seed', async (context) => {
  const { control, calls, refs, settle } = mount(context, { history: ['third', 'second', 'first'] });
  await settle();
  const navigate = control.api.handlePromptHistoryNavigate;

  assert.equal(navigate('down', 'draft'), undefined, 'down while inactive does nothing');
  assert.equal(navigate('up', 'draft'), 'third');
  assert.deepEqual(refs.promptHistoryNavRef.current, { active: true, index: 0, seed: 'draft', lastValue: 'third' });
  assert.equal(refs.promptHistoryDraftChangeRef.current, true);
  assert.equal(navigate('up', 'third'), 'second');
  assert.equal(navigate('up', 'second'), 'first');
  assert.equal(navigate('up', 'first'), undefined, 'past the oldest entry stays put');
  assert.equal(navigate('down', 'first'), 'second');
  assert.equal(navigate('down', 'second'), 'third');
  assert.equal(navigate('down', 'third'), 'draft', 'below the newest entry the seed comes back');
  assert.equal(calls.navResets, 1);
  assert.equal(refs.promptHistoryNavRef.current.active, false);

  assert.equal(navigate('up', 'third'), 'second', 'an entry equal to the current text is skipped');
  assert.equal(navigate('down', 'anything', { emptyDraft: true }), undefined);
  assert.equal(calls.navResets, 2);
  assert.ok(calls.hintClears >= 10, 'every navigation clears the prompt hint');
});

test('Escape closes overlays first, then arms and executes clear/select phases, and restores queued input when empty', async (context) => {
  const withUsage = mount(context, { usagePanel: { open: true } });
  await withUsage.settle();
  assert.equal(withUsage.control.api.handlePromptEscape('', {}), true);
  assert.equal(withUsage.calls.usageClosed, 1);

  const withContext = mount(context, { contextPanel: { id: 'ctx' } });
  await withContext.settle();
  assert.equal(withContext.control.api.handlePromptEscape('', {}), true);
  assert.deepEqual(withContext.calls.contexts, [null]);

  const { control, calls, settle } = mount(context);
  await settle();
  const esc = control.api.handlePromptEscape;
  assert.equal(esc('text', { phase: 'clear-arm' }), true);
  assert.equal(calls.hints.at(-1)[0], 'Esc again to clear');
  assert.equal(esc('', { phase: 'select-arm' }), true);
  assert.equal(calls.hints.at(-1)[0], 'Esc again to pick a message');
  assert.equal(esc('', { phase: 'select' }), true);
  assert.deepEqual(calls.restoreQueued.at(-1), { restoreDraft: true, showHint: false, currentText: '' });
  assert.equal(calls.selectorOpened, 1);
  assert.equal(esc('typed', { phase: 'clear' }), false);
  assert.deepEqual(calls.remembered, ['typed']);
  assert.deepEqual(calls.clearedImages, [[]]);
  assert.deepEqual(calls.clearedTexts, [[]]);
  assert.equal(esc('', { phase: 'empty' }), false);
  assert.equal(calls.restoreQueued.length, 2);
  assert.equal(esc('', { phase: 'other' }), false);
});

test('a synchronous interrupt restores the submitted prompt and its attachments only into an empty draft', async (context) => {
  let outcome = { aborted: true, restoreText: ' again ', pastedImages: [{ id: 1 }], discardPastedImages: [1] };
  const { control, calls, settle } = mount(context, { abort: () => outcome });
  await settle();
  const interrupt = control.api.handlePromptInterrupt;

  assert.equal(interrupt(''), 'again');
  assert.deepEqual(calls.clearedImages, [[[1]]]);
  assert.deepEqual(calls.installedImages, [[[{ id: 1 }], { merge: true }]]);
  assert.equal(calls.hintClears, 1);

  assert.equal(interrupt('typing'), undefined, 'a replacement draft is never overwritten');
  outcome = { aborted: false, restoreText: 'never', discardPastedImages: [2] };
  assert.equal(interrupt(''), undefined);
  assert.equal(calls.clearedImages.length, 2, 'a non-aborted result discards nothing more');

  outcome = null;
  assert.equal(interrupt(''), undefined);
  const {
    control: failing,
    calls: failingCalls,
    settle: settleFailing,
  } = mount(context, {
    abort: () => {
      throw new Error('boom');
    },
  });
  await settleFailing();
  assert.equal(failing.api.handlePromptInterrupt(''), undefined);
  assert.deepEqual(failingCalls.notices, [['interrupt failed: boom', 'error']]);
});

test('an asynchronous interrupt waits for the turn to go idle before restoring the draft', async (context) => {
  let resolveAbort;
  const { control, calls, settle } = mount(context, {
    abort: () =>
      new Promise((resolve) => {
        resolveAbort = resolve;
      }),
  });
  await settle();
  control.setBusy(true);
  await settle();
  assert.equal(control.api.handlePromptInterrupt(''), undefined);
  resolveAbort({ aborted: true, restoreText: 'later', pastedTexts: [{ id: 7 }] });
  await settle();
  assert.deepEqual(calls.draftOverrides, [], 'still busy: the restore is parked');

  control.setBusy(false);
  await settle();
  assert.equal(calls.draftOverrides.length, 1);
  assert.equal(calls.draftOverrides[0].value, 'later');
  assert.deepEqual(calls.layoutRows, ['later']);
  assert.deepEqual(calls.installedTexts, [[[{ id: 7 }], { merge: true }]]);
});
