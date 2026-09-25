import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import React from 'react';
import { Text, render } from 'ink';
import { usePromptDraftFlow } from './use-prompt-draft-flow.mjs';

// The prompt cancel paths and the slash-palette accept, mounted through the
// real hook. App re-creates the pickers, setters and the slash dispatcher every
// render, so each callback must call the CURRENT ones, not the ones from the
// render that last changed the prompt or palette.

function Harness({ control, deps }) {
  control.api = usePromptDraftFlow(deps);
  return React.createElement(Text, null, 'draft');
}

const SLASH_COMMANDS = [{ name: 'compact' }, { name: 'model' }];

function callbacks(tag, calls) {
  return {
    setProviderPrompt: (value) => calls.push([tag, 'setProviderPrompt', value]),
    setSettingsPrompt: (value) => calls.push([tag, 'setSettingsPrompt', value]),
    openProjectPicker: () => calls.push([tag, 'openProjectPicker']),
    openMemoryCorePicker: () => calls.push([tag, 'openMemoryCorePicker']),
    openAutoClearPicker: (options) => calls.push([tag, 'openAutoClearPicker', options]),
    runSlashCommand: (cmd, arg) => {
      calls.push([tag, 'runSlashCommand', cmd, arg]);
      return true;
    },
  };
}

function mount(context, { providerPrompt, settingsPrompt }) {
  const calls = [];
  const refs = {
    oauthSubmitRef: { current: true },
    pickerOpenedFromEnterRef: { current: false },
    pickerOpenedFromEnterTimerRef: { current: null },
  };
  const noop = () => {};
  const base = {
    dismissWelcomePromptHint: noop,
    syncPromptLayoutRows: noop,
    promptHistoryDraftChangeRef: { current: false },
    promptHistoryNavRef: { current: { active: false, index: -1, seed: '', lastValue: '' } },
    resetPromptHistoryNav: noop,
    setPromptDraft: noop,
    setPromptDraftOverride: noop,
    showPromptHint: noop,
    clearPromptHint: noop,
    promptHintActiveRef: { current: false },
    promptHintTimerRef: { current: null },
    slashDismissedFor: '',
    setSlashDismissedFor: noop,
    providerPrompt,
    settingsPrompt,
    slashCommands: SLASH_COMMANDS,
    slashIndex: 0,
    ...refs,
  };
  const control = {};
  const stdout = new PassThrough();
  stdout.columns = 40;
  stdout.rows = 10;
  stdout.on('data', () => {});
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = noop;
  stdin.ref = noop;
  stdin.unref = noop;
  const element = (tag) => React.createElement(Harness, { control, deps: { ...base, ...callbacks(tag, calls) } });
  const view = render(element('first'), {
    stdout,
    stdin,
    stderr: stdout,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  context.after(() => {
    clearTimeout(refs.pickerOpenedFromEnterTimerRef.current);
    view.unmount();
    stdin.end();
    stdout.end();
  });
  const rerender = async (tag) => {
    view.rerender(element(tag));
    await delay(30);
  };
  return { control, calls, refs, rerender, settle: () => delay(30) };
}

test('cancel paths and palette accept reach the prompt setters, pickers and dispatcher', async (context) => {
  const cancelled = [];
  const { control, calls, refs, settle } = mount(context, {
    providerPrompt: { kind: 'oauth-code', cancelReturn: () => cancelled.push('provider') },
    settingsPrompt: { kind: 'project-new' },
  });
  await settle();
  control.api.cancelProviderPrompt();
  assert.equal(refs.oauthSubmitRef.current, false);
  assert.deepEqual(cancelled, ['provider']);
  control.api.cancelSettingsPrompt();
  assert.equal(control.api.acceptSlashPalette('/compact'), true);
  assert.equal(refs.pickerOpenedFromEnterRef.current, true);
  assert.deepEqual(calls, [
    ['first', 'setProviderPrompt', null],
    ['first', 'setSettingsPrompt', null],
    ['first', 'openProjectPicker'],
    ['first', 'runSlashCommand', 'compact', ''],
  ]);
});

test('after a re-render with new callbacks, every path calls the current ones', async (context) => {
  const { control, calls, rerender, settle } = mount(context, {
    providerPrompt: { kind: 'oauth-code' },
    settingsPrompt: { kind: 'autoclear-provider', returnTo: null },
  });
  await settle();
  await rerender('second');
  control.api.cancelProviderPrompt();
  control.api.cancelSettingsPrompt();
  control.api.acceptSlashPalette('/compact');
  assert.deepEqual(calls, [
    ['second', 'setProviderPrompt', null],
    ['second', 'setSettingsPrompt', null],
    ['second', 'openAutoClearPicker', { advanced: true, returnTo: null }],
    ['second', 'runSlashCommand', 'compact', ''],
  ]);
});
