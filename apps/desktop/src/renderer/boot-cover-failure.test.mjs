import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

// Every start ends in the workspace or in a card that says what is wrong and offers a way out. A window whose first open gave up kept
// the mark forever; a start blocked on the earlier version's daemon showed raw JSON and a "Try again" that led back to it; the
// conversion of the earlier version's data and an update's quit were a mark with no words.
test('the boot cover says what the start waits on, and a start that ended or is blocked is a card with a way out', async (t) => {
  const { root, document } = installTestDom(t, { rootId: 'root', globals: {} });
  let report;
  const retries = [];
  window.mixdogCorePort = {
    open: async () => ({ generation: 1 }),
    onBootReport: (listener) => {
      report = listener;
      return () => {};
    },
    retry: async () => {
      retries.push('retry');
    },
  };
  window.__mixdogWindowShown = true;
  const { DesktopBootGate } = await import('./PaneSurfaceGate.tsx');
  const { watchLocalCoreLink } = await import('./local-core-link.ts');
  const cover = () => document.querySelector('.desktop-boot-cover');
  const caption = () => document.querySelector('.desktop-boot-cover .desktop-loading-caption')?.textContent ?? null;
  const card = () => document.querySelector('.desktop-boot-cover .desktop-boot-failure');
  await act(async () =>
    root.render(
      React.createElement(DesktopBootGate, { ready: true, enabled: true }, React.createElement('main', null, 'app'))
    )
  );

  await act(async () =>
    report({ progress: { stage: 'migration', done: 0, total: 0, boot: 7 }, failure: null, updating: false })
  );
  assert.equal(caption(), 'Updating your data from the earlier version of Mixdog…');
  assert.equal(document.querySelector('.desktop-loading-progress'), null, 'no bar while it counts nothing');
  await act(async () =>
    report({ progress: { stage: 'migration', done: 120, total: 600, boot: 7 }, failure: null, updating: false })
  );
  const bar = document.querySelector('.desktop-loading-progress');
  assert.equal(bar?.getAttribute('aria-valuenow'), '120');
  assert.equal(bar?.getAttribute('aria-label'), 'Updating your data from the earlier version of Mixdog…');

  await act(async () => report({ progress: null, failure: null, updating: true }));
  assert.equal(caption(), 'Installing the update…');
  assert.equal(card(), null, 'an update is not a failure');
  await act(async () => report({ progress: null, failure: null, updating: false }));

  // The window's own first open gives up before the link was ever open: a card, not the mark forever.
  const listeners = new Set();
  const connection = {
    status: 'reconnecting',
    onState: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    link: () => ({ closed: connection.status === 'closed' ? { message: 'connect ECONNREFUSED 127.0.0.1:6060' } : null }),
  };
  watchLocalCoreLink(connection);
  await act(async () => {
    connection.status = 'closed';
    for (const listener of [...listeners]) listener();
  });
  assert.ok(card(), 'a first open that gave up is a failure card');
  assert.match(card().querySelector('pre').textContent, /ECONNREFUSED/);
  assert.equal(card().querySelector('button').textContent, 'Try again');
  assert.ok(cover(), 'on the cover: the app is not open');

  // A start blocked on the earlier version's daemon: which process, in words, and the action past it.
  await act(async () =>
    report({
      progress: null,
      updating: false,
      failure: {
        message: 'core is not ready: the data directory is held by an earlier process (pid 41)',
        exitCode: null,
        stderrPath: null,
        blocked: {
          pid: 41,
          image: 'C:\\old\\node.exe',
          commandLine: 'node daemon.mjs',
          releasable: false,
          legacy: true,
          retireError: 'a turn is running',
          resolving: false,
          resolveError: null,
        },
      },
    })
  );
  assert.equal(card().querySelector('h2').textContent, 'An earlier Mixdog is still running');
  assert.ok(
    [...card().querySelectorAll('p')].some((p) => p.textContent === 'C:\\old\\node.exe · process 41'),
    'the process is named'
  );
  assert.doesNotMatch(card().textContent, /\{"/, 'no raw JSON');
  const action = card().querySelector('button');
  assert.equal(action.textContent, 'Stop it and continue');
  await act(async () => action.click());
  assert.deepEqual(retries, ['retry'], "the action is main's, and the window waits for the core it unblocks");

  // An owner the core could not prove is released, not stopped: the card says that while it runs.
  const undecided = (resolving) => ({
    progress: null,
    updating: false,
    failure: {
      message: 'core is not ready: the data directory is held by an earlier process (pid 4321)',
      exitCode: null,
      stderrPath: null,
      blocked: {
        pid: 4321,
        image: 'C:\\tools\\node.exe',
        commandLine: 'node x.js',
        releasable: true,
        legacy: false,
        retireError: null,
        resolving,
        resolveError: null,
      },
    },
  });
  await act(async () => report(undecided(false)));
  assert.equal(card().querySelector('h2').textContent, 'Another program holds your Mixdog data');
  assert.equal(card().querySelector('button').textContent, 'It is not Mixdog: continue');
  await act(async () => report(undecided(true)));
  assert.equal(card().querySelector('button').textContent, 'Releasing…');
  assert.equal(card().querySelector('button').disabled, true);
});
