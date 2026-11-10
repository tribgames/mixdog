import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import React from 'react';
import { Text, render } from 'ink';
import { useWelcomePromptHint } from './use-welcome-prompt-hint.mjs';
import { CONDITIONAL_WELCOME_PROMPT_HINTS } from './app-format.mjs';

// Dismissal only counts while the hint row is on screen, and it never comes
// back once taken.
function Harness({ control, deps }) {
  control.api = useWelcomePromptHint(deps);
  return React.createElement(Text, null, 'ready');
}

function mount(context, deps) {
  const control = {};
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
  return { control, settle: (ms = 30) => delay(ms) };
}

const READY_STORE = {
  getProviderSetup: () => ({ api: [{ id: 'p1', usable: true }], oauth: [] }),
  listProviderModels: () => [{ provider: 'p1', id: 'm1', supportsWebSearch: true }],
  getWebSearchRoute: () => ({ provider: 'p1', model: 'm1' }),
};

test('the hint is dismissed only while its row is visible, and stays dismissed', async (context) => {
  const { control, settle } = mount(context, {
    store: READY_STORE,
    state: { provider: 'p1', model: 'm1', workflow: { id: 'team' } },
    toastErrorSignature: '',
  });
  await settle();

  assert.equal(control.api.welcomePromptHintDismissed, false);
  assert.equal(typeof control.api.welcomePromptHintRef.current, 'string');
  assert.ok(control.api.welcomePromptHintRef.current.length > 0, 'a starter tip is pinned for the process');

  control.api.dismissWelcomePromptHint();
  await settle();
  assert.equal(control.api.welcomePromptHintDismissed, false, 'an off-screen hint is not dismissed');

  control.api.welcomePromptHintVisibleRef.current = true;
  control.api.dismissWelcomePromptHint();
  await settle();
  assert.equal(control.api.welcomePromptHintDismissed, true);

  control.api.dismissWelcomePromptHint();
  await settle();
  assert.equal(control.api.welcomePromptHintDismissed, true, 'dismissal never flips back');
});

test('a toast error overrides the starter tip with the conditional error hint', async (context) => {
  const { control, settle } = mount(context, {
    store: READY_STORE,
    state: { provider: 'p1', model: 'm1', workflow: { id: 'team' } },
    toastErrorSignature: 'boom',
  });
  await settle();
  assert.equal(control.api.conditionalWelcomePromptHint, CONDITIONAL_WELCOME_PROMPT_HINTS.error);
});

test('a default web-search route on a model without native search reads the model list once', async (context) => {
  let modelListCalls = 0;
  const { control, settle } = mount(context, {
    store: {
      ...READY_STORE,
      listProviderModels: () => {
        modelListCalls += 1;
        return [{ provider: 'p1', id: 'm1', supportsWebSearch: false }];
      },
      getWebSearchRoute: () => ({ provider: 'default', model: 'default' }),
    },
    state: { provider: 'p1', model: 'm1', workflow: { id: 'team' } },
    toastErrorSignature: '',
  });
  await settle();
  assert.equal(control.api.conditionalWelcomePromptHint, CONDITIONAL_WELCOME_PROMPT_HINTS.webSearchDefaultUnsupported);
  assert.equal(modelListCalls, 1);
});

test('a store with no usable provider wins over every other conditional hint', async (context) => {
  const { control, settle } = mount(context, {
    store: { ...READY_STORE, getProviderSetup: () => ({ api: [], oauth: [] }) },
    state: { provider: '', model: '', workflow: { id: 'solo' } },
    toastErrorSignature: 'boom',
  });
  await settle();
  assert.equal(control.api.conditionalWelcomePromptHint, CONDITIONAL_WELCOME_PROMPT_HINTS.noProvider);
});
