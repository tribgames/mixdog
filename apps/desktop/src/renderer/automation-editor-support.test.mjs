import assert from 'node:assert/strict';
import test from 'node:test';

import { automationProjectOptions } from './automation-editor-support.ts';

test('project options lead with none, prefer alias over name, and keep an unlisted cwd selectable', () => {
  const projects = [
    { path: '/a', name: 'alpha', alias: ' Alias ' },
    { path: '/b', name: ' beta ', alias: '' },
    { path: '/c', name: '', alias: '' },
  ];
  assert.deepEqual(automationProjectOptions(projects, '/b'), [
    { value: '__none__', label: 'No project' },
    { value: '/a', label: 'Alias' },
    { value: '/b', label: 'beta' },
    { value: '/c', label: '/c' },
  ]);
  assert.deepEqual(automationProjectOptions([], '/gone').at(-1), { value: '/gone', label: '/gone' });
  assert.equal(automationProjectOptions([], '').length, 1);
});
