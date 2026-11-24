import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { installTestDom, toolModulesSource } from './test-support/test-dom.mjs';

// After the update from 1.4.5 the conversation list filled behind the serving core with no signal (3 of 597 conversations four
// seconds in), and what the migration set aside vanished without a word.
test('while the earlier conversations convert the list says how many have settled; afterwards what was set aside is told once, with where it is', async (t) => {
  const { root, document } = installTestDom(t, { rootId: 'root' });
  const source = toolModulesSource();
  window.mixdogDesktop = { sections: source.sections };
  const { MigrationProgress, MigrationSetAsideNotice, SET_ASIDE_TOLD_KEY } = await import('./migration-progress.tsx');
  const render = () =>
    act(async () =>
      root.render(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(MigrationProgress),
          React.createElement(MigrationSetAsideNotice)
        )
      )
    );
  const converting = () => document.querySelector('.session-panel-indexing')?.textContent ?? null;
  const notice = () => document.querySelector('.session-migration-notice');
  await render();
  assert.equal(converting(), null, 'nothing is said before the core says it');

  await act(async () => source.publishSection('migration', { converting: true, done: 3, total: 597, setAside: null }));
  assert.equal(converting(), 'Converting earlier conversations… 3 of 597');
  assert.equal(notice(), null);

  const dir = 'C:\\Users\\me\\.mixdog\\data\\quarantine';
  await act(async () =>
    source.publishSection('migration', {
      converting: false,
      done: 0,
      total: 0,
      setAside: { id: 'abc', count: 6, unexpected: 5, dir },
    })
  );
  assert.equal(converting(), null, 'the list is whole');
  assert.equal(
    notice()?.querySelector('p').textContent,
    `Updating from the earlier version set aside 6 items it could not convert. They are kept in ${dir}.`
  );
  await act(async () => notice().querySelector('button').click());
  assert.equal(notice(), null);
  assert.equal(window.localStorage.getItem(SET_ASIDE_TOLD_KEY), 'abc');

  await act(async () => root.render(null));
  await render();
  assert.equal(notice(), null, 'the next start publishes the same record: it is not told again');
  await act(async () =>
    source.publishSection('migration', { converting: false, setAside: { id: 'def', count: 1, dir } })
  );
  assert.ok(notice(), 'another migration is');
});
