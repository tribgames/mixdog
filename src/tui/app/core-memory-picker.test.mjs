import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as flush } from 'node:timers/promises';
import { createCoreMemoryPicker } from './core-memory-picker.mjs';
import { parseMemoryCoreRows } from './input-parsers.mjs';
import { createPanelSurface } from './panel-surface.mjs';
import { shouldSupersedePanelEpoch, supersedePanelEpoch } from './panel-epoch.mjs';

function harness(read = async () => '') {
  supersedePanelEpoch();
  let picker = null;
  const calls = [];
  const notices = [];
  const prompts = [];
  const surface = createPanelSurface({
    setPicker: (next) => {
      if (shouldSupersedePanelEpoch(picker, next)) supersedePanelEpoch();
      picker = next;
    },
  });
  const factory = createCoreMemoryPicker({
    store: {
      memoryControl: (args, options) => {
        assert.deepEqual(args, { action: 'core', op: 'list', project_id: '*' });
        assert.deepEqual(options, { silent: true });
        calls.push(args);
        return read();
      },
      pushNotice: (message, tone) => notices.push([message, tone]),
    },
    surface,
    setSettingsPrompt: (prompt) => prompts.push(prompt),
    parseMemoryCoreRows,
  });
  return {
    ...factory,
    current: () => picker,
    select: (value) =>
      picker.onSelect(
        value,
        picker.items.find((item) => item.value === value)
      ),
    calls,
    notices,
    prompts,
  };
}

test('an empty memory response still offers Add and List; only the list has an empty placeholder', async () => {
  const h = harness();
  h.openMemoryCorePicker();
  assert.equal(h.current().loading, true);
  assert.deepEqual(h.current().items, []);
  await flush();
  assert.deepEqual(
    h.current().items.map((item) => [item.value, item.label]),
    [
      ['core-add', 'Add Memory'],
      ['core-list', 'Memory List'],
    ]
  );
  h.select('core-list');
  assert.equal(h.current().title, 'Memory · List');
  assert.equal(h.current().description, 'No stored memories yet.');
  assert.deepEqual(h.current().items, [{ value: 'empty', label: 'Memory', description: 'empty' }]);
  assert.equal(h.calls.length, 1, 'the nested list reuses the rows already read');
});

test('memory reads cannot repaint after Esc and rejected reads retain their error notice', async () => {
  const gate = Promise.withResolvers();
  const h = harness(() => gate.promise);
  h.openMemoryCorePicker({ returnTo: null });
  h.current().onCancel();
  gate.resolve('COMMON:\nid=7 preference — preference');
  await flush();
  assert.equal(h.current(), null);
  assert.deepEqual(h.notices, []);

  const failing = harness(async () => {
    throw new Error('offline');
  });
  failing.openMemoryCorePicker();
  await flush();
  assert.equal(failing.current(), null);
  assert.deepEqual(failing.notices, [['core memory failed: offline', 'error']]);
});

test('entry editing preserves legacy elements and nested reopens retain the original Esc target', async () => {
  const h = harness(async () => 'COMMON:\nid=7 preference — preference\nid=8 legacy label — visible summary');
  const returns = [];
  h.openMemoryCorePicker({ returnTo: () => returns.push('settings') });
  await flush();
  h.select('core-list');
  h.select('core-common-7');
  h.select('edit');
  assert.equal(h.current(), null);
  assert.equal(h.prompts.at(-1)._singleSentence, true);
  assert.equal(h.prompts.at(-1).initialValue, 'preference');

  h.openMemoryCorePicker();
  await flush();
  h.select('core-list');
  h.select('core-common-8');
  h.current().onCancel();
  assert.equal(h.current().loading, true, 'entry cancellation rereads the list');
  await flush();
  h.select('core-common-8');
  h.select('edit');
  assert.equal(h.prompts.at(-1)._singleSentence, false);
  assert.equal(h.prompts.at(-1).initialValue, 'visible summary');
  assert.equal(h.prompts.at(-1)._id, 8);
  assert.equal(h.prompts.at(-1)._projectId, null);

  h.openMemoryCorePicker();
  await flush();
  h.current().onCancel();
  assert.deepEqual(returns, ['settings']);
  h.openMemoryCorePicker({ returnTo: null });
  await flush();
  h.current().onCancel();
  assert.equal(h.current(), null);
  assert.deepEqual(returns, ['settings']);
});
