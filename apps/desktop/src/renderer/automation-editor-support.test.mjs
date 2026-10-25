import assert from 'node:assert/strict';
import test from 'node:test';

import { automationDraftCwd, automationProjectOptions } from './automation-editor-support.ts';

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

test('the internal task workspace reads as no project and never becomes an option or a saved cwd', () => {
  for (const path of [
    'C:\\Users\\tempe\\AppData\\Roaming\\mixdog-desktop\\workspace\\unclassified',
    'c:/users/tempe/appdata/roaming/mixdog-desktop/workspace/Unclassified/',
    '/home/u/.config/mixdog-desktop/workspace/unclassified',
  ]) {
    assert.equal(automationDraftCwd(path), '');
    assert.deepEqual(automationProjectOptions([], path), [{ value: '__none__', label: 'No project' }]);
  }
  assert.equal(automationDraftCwd(undefined), '');
  assert.equal(automationDraftCwd('/work/repo'), '/work/repo');
  assert.equal(automationDraftCwd('/work/unclassified'), '/work/unclassified');
});
