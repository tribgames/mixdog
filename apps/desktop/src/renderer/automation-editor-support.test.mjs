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

test("only the host's exact task workspace reads as no project", () => {
  const internal = 'C:\\Users\\tempe\\AppData\\Roaming\\mixdog-desktop\\workspace\\unclassified';
  for (const path of [internal, 'c:/users/tempe/appdata/roaming/mixdog-desktop/workspace/Unclassified/']) {
    assert.equal(automationDraftCwd(path, internal), '');
  }
  // A real project that merely ends the same way is a project.
  assert.equal(
    automationDraftCwd('/repos/customer/workspace/unclassified', internal),
    '/repos/customer/workspace/unclassified'
  );
  // The host has not said (yet): nothing is guessed.
  assert.equal(automationDraftCwd(internal, ''), internal);
  assert.equal(automationDraftCwd(undefined, internal), '');
  assert.deepEqual(automationProjectOptions([], automationDraftCwd(internal, internal)), [
    { value: '__none__', label: 'No project' },
  ]);
  assert.deepEqual(automationProjectOptions([], '/repos/customer/workspace/unclassified').at(-1), {
    value: '/repos/customer/workspace/unclassified',
    label: '/repos/customer/workspace/unclassified',
  });
});
