import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { installTestDom, toolModulesSource } from './test-support/test-dom.mjs';

// After the update from 1.4.5 the conversation list filled behind the serving core with no signal (3 of 597 conversations four
// seconds in).
test('while the earlier conversations convert the list says how many have settled, and nothing once they have', async (t) => {
  const { root, document } = installTestDom(t, { rootId: 'root' });
  const source = toolModulesSource();
  window.mixdogDesktop = { sections: source.sections };
  const { MigrationProgress } = await import('./migration-progress.tsx');
  const converting = () => document.querySelector('.session-panel-indexing')?.textContent ?? null;
  await act(async () => root.render(React.createElement(MigrationProgress)));
  assert.equal(converting(), null, 'nothing is said before the core says it');

  await act(async () => source.publishSection('migration', { converting: true, done: 3, total: 597, setAside: null }));
  assert.equal(converting(), 'Converting earlier conversations… 3 of 597');

  await act(async () =>
    source.publishSection('migration', {
      converting: false,
      done: 0,
      total: 0,
      setAside: { id: 'abc', count: 6, dir: 'C:\\Users\\me\\.mixdog\\data\\quarantine' },
    })
  );
  assert.equal(converting(), null, 'the list is whole');
  assert.equal(document.body.textContent.includes('set aside'), false, 'what the migration set aside is not announced');
});
