import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

import { desktopToolComputerReadinessNotice } from './transcript-tool-core.ts';
import { ToolActivityGroup } from './TranscriptView.tsx';

const REFUSAL = (capabilities) =>
  `Error: computer_capability_unavailable: Computer Use cannot run this action on this Linux session (${capabilities}) — nothing was executed.\nwayland_window_control_unavailable: the window helper is not on yet.`;

const call = (id, args, extra = {}) => ({
  kind: 'tool',
  id,
  name: 'computer',
  args,
  result: 'ok',
  completedAt: 1,
  ...extra,
});
const refused = (id, capabilities = 'windows', args = { action: 'list_windows' }, completedAt = 1) =>
  call(id, args, {
    result: REFUSAL(capabilities),
    isError: true,
    completedAt,
    toolMeta: { code: 'computer_capability_unavailable', missing: capabilities.split(', ') },
  });

test('a refusal naming windows opens the notice; a later window call that worked makes it ready', () => {
  assert.equal(desktopToolComputerReadinessNotice([call('a', { action: 'list_windows' })]), null);
  assert.equal(desktopToolComputerReadinessNotice([refused('a', 'pointer', { action: 'click' })]), null);
  assert.deepEqual(desktopToolComputerReadinessNotice([refused('a', 'windows, pointer')]), {
    refusalId: 'a',
    refusalAt: 1,
    ready: false,
  });
  // The card reads the structured meta, never the message text.
  assert.equal(
    desktopToolComputerReadinessNotice([
      call('a', { action: 'list_windows' }, { result: REFUSAL('windows'), isError: true }),
    ]),
    null
  );
  // A vision capture that worked says nothing about the window helper.
  assert.equal(desktopToolComputerReadinessNotice([refused('a'), call('b', { action: 'screenshot' })]).ready, false);
  assert.equal(
    desktopToolComputerReadinessNotice([refused('a'), call('b', { action: 'focus_window', window_id: 'w1' })]).ready,
    true
  );
  assert.equal(
    desktopToolComputerReadinessNotice([refused('a'), call('b', JSON.stringify({ action: 'capture', app: 'Files' }))])
      .ready,
    true
  );
  // Still refused afterwards: not ready.
  assert.equal(desktopToolComputerReadinessNotice([refused('a'), refused('b')]).ready, false);
});

test('the chat card is the sign-in notice once per task, dismisses with OK, and flips to ready', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' });
  const previous = new Map(
    ['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT'].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ])
  );
  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(dom.window.document.getElementById('root'));
  const render = (...groups) =>
    act(async () =>
      root.render(
        React.createElement(
          React.Fragment,
          null,
          ...groups.map(({ items, turnKey }, index) =>
            React.createElement(ToolActivityGroup, { key: index, items, disclosureScope: 'sess-1', turnKey })
          )
        )
      )
    );
  const cards = () => [...dom.window.document.querySelectorAll('[data-computer-readiness-card]')];
  try {
    await render({ items: [refused('r1')], turnKey: 'turn:1' }, { items: [refused('r2')], turnKey: 'turn:1' });
    assert.equal(cards().length, 1, 'only the first refusal of a task asks');
    const [card] = cards();
    assert.equal(card.getAttribute('data-computer-readiness-card'), 'relogin');
    assert.match(card.textContent, /Sign in again to turn on the window helper/);
    assert.match(card.textContent, /Computer Use/);
    assert.match(card.textContent, /Sign out and back in to turn it on\./);
    assert.deepEqual(
      [...card.querySelectorAll('button')].map((button) => button.textContent),
      ['OK'],
      'no Install button, one dismiss'
    );

    await act(async () => card.querySelector('button').click());
    assert.equal(cards().length, 0, 'OK silences the rest of the task');

    // A new task asks again.
    await render({ items: [refused('r3')], turnKey: 'turn:2' });
    assert.equal(cards().length, 1);

    // A window call that worked later in the group flips the card to ready, without a button.
    await render({
      items: [refused('r4'), call('w1', { action: 'list_windows' })],
      turnKey: 'turn:3',
    });
    const ready = cards()[0];
    assert.equal(ready.getAttribute('data-computer-readiness-card'), 'ready');
    assert.match(ready.textContent, /Ready\. Continuing\./);
    assert.match(ready.textContent, /The window helper is on\. It will not ask again\./);
    assert.equal(ready.querySelector('button'), null);

    // A window call that worked in a LATER tool group of the same turn flips it too.
    await render(
      { items: [refused('r5', 'windows', { action: 'list_windows' })], turnKey: 'turn:5' },
      { items: [call('w2', { action: 'focus_window', window_id: 'w1' }, { completedAt: 2 })], turnKey: 'turn:5' }
    );
    assert.equal(cards().length, 1);
    assert.equal(cards()[0].getAttribute('data-computer-readiness-card'), 'ready');

    // A window call that worked BEFORE the refusal does not.
    await render(
      { items: [call('w3', { action: 'list_windows' }, { completedAt: 1 })], turnKey: 'turn:6' },
      { items: [refused('r6', 'windows', { action: 'list_windows' }, 5)], turnKey: 'turn:6' }
    );
    assert.equal(cards()[0].getAttribute('data-computer-readiness-card'), 'relogin');

    // A refusal for something else leaves no card.
    await render({ items: [refused('p1', 'pointer', { action: 'click' })], turnKey: 'turn:4' });
    assert.equal(cards().length, 0);
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    dom.window.close();
  }
});
