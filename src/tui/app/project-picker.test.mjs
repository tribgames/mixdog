import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as settle } from 'node:timers/promises';
import { createPanelSurface } from './panel-surface.mjs';
import { createProjectPicker } from './project-picker.mjs';

function harness({ pickFolder, listProjects } = {}) {
  const calls = [];
  const notices = [];
  const prompts = [];
  let picker = null;
  const factory = createProjectPicker({
    state: { cwd: 'C:\\current' },
    store: {
      listProjects: listProjects || (async () => [{ name: 'One', path: 'C:\\one' }]),
      setCwd: async (path) => {
        calls.push(`cwd:${path}`);
        return path;
      },
      addProject: async (path) => {
        calls.push(`add:${path}`);
        return { name: 'Added', path };
      },
      pushNotice: (message, tone) => notices.push([tone, message]),
    },
    surface: createPanelSurface({
      setPicker: (next) => {
        picker = typeof next === 'function' ? next(picker) : next;
      },
      setContextPanel: () => {},
      setUsagePanel: () => {},
    }),
    setProviderPrompt: () => {},
    setSettingsPrompt: (prompt) => {
      // Opening the list clears the prompt with null; only real prompts matter here.
      if (prompt) prompts.push(prompt);
    },
    closeUsagePanel: () => {},
    projectNameFromPath: (value) => value,
    pickFolder: pickFolder || (async () => ({ available: true, path: null })),
  });
  return { factory, calls, notices, prompts, picker: () => picker };
}

test('the picker lists registered projects then the current-path shortcut, with loading state first', async () => {
  const h = harness();
  const pending = h.factory.openProjectPicker({ initialEntry: true });
  assert.equal(h.picker()._projectInitialPending, true);
  assert.deepEqual(h.picker().items, []);
  assert.match(h.picker().help, /Waiting for the project service/);
  await pending;
  assert.deepEqual(
    h.picker().items.map((item) => [item.value, item.label]),
    [
      ['C:\\one', 'One'],
      ['__use_current__', 'Current Path'],
    ]
  );
  assert.equal(h.picker().help, '↑/↓ Select · Enter Open · c Create · r Rename');
  h.picker().onSelect('__use_current__', h.picker().items[1]);
  await settle();
  assert.deepEqual(h.calls, ['cwd:C:\\current'], 'the current-path shortcut is never registered');
  assert.equal(h.picker(), null, 'entering a project closes the surface');
});

test('a failed project list still opens an empty picker and reports the error', async () => {
  const h = harness({
    listProjects: async () => {
      throw new Error('service down');
    },
  });
  assert.deepEqual(await h.factory.openProjectPicker(), []);
  assert.deepEqual(
    h.picker().items.map((item) => item.value),
    ['__use_current__']
  );
  assert.match(h.picker().help, /Esc Back/);
  assert.deepEqual(h.notices, [['error', 'project list failed: service down']]);
});

test('c opens the native folder dialog; a chosen folder is registered and the list reopens', async () => {
  const h = harness({ pickFolder: async () => ({ available: true, path: 'C:\\chosen' }) });
  await h.factory.openProjectPicker();
  h.picker().onKey('c', {}, null);
  assert.equal(h.picker().loading, true);
  assert.match(h.picker().description, /Opening folder picker/);
  await settle();
  assert.deepEqual(h.calls, ['add:C:\\chosen']);
  assert.deepEqual(h.notices, [['info', 'project added: Added']]);
  assert.equal(h.picker().loading, undefined);
  assert.equal(h.picker().items[0].value, 'C:\\one');
});

test('a cancelled dialog returns to the list; a missing dialog falls back to manual path entry', async () => {
  const cancelled = harness();
  await cancelled.factory.openProjectPicker();
  cancelled.factory.beginNewProject();
  await settle();
  assert.equal(cancelled.picker().items.length, 2);
  assert.deepEqual(cancelled.prompts, []);

  const manual = harness({ pickFolder: async () => ({ available: false }) });
  await manual.factory.openProjectPicker();
  manual.factory.beginNewProject();
  await settle();
  assert.equal(manual.picker(), null);
  assert.deepEqual(
    manual.prompts.map((prompt) => prompt.kind),
    ['project-new']
  );
});

test('r renames the highlighted registered project through a seeded text prompt', async () => {
  const h = harness();
  await h.factory.openProjectPicker();
  h.picker().onKey('r', {}, h.picker().items[1]);
  assert.deepEqual(h.prompts, [], 'the current-path shortcut cannot be renamed');
  h.picker().onKey('r', {}, h.picker().items[0]);
  assert.deepEqual(h.prompts, [
    {
      kind: 'project-rename',
      label: 'Rename project',
      hint: 'Set a display name. Leave blank to reset to the folder name.',
      projectPath: 'C:\\one',
      initialValue: 'One',
    },
  ]);
  assert.equal(h.picker(), null);
});

test('registerProject and enterProject refuse blank paths with a warning', async () => {
  const h = harness();
  assert.equal(await h.factory.registerProject('  '), false);
  assert.equal(await h.factory.enterProject(''), false);
  assert.deepEqual(h.notices, [
    ['warn', 'project path is required'],
    ['warn', 'project path is required'],
  ]);
  assert.deepEqual(h.calls, []);
});
