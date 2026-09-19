import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { COMPUTER_CORE_ACTION_SCHEMA } from '../../../../../../src/runtime/computer-bridge/core-actions.mjs';

// Pointer actions are enumerated again in every layer that has to recognise them.
// A tool-surface action missing from one of those lists does not fail loudly: the
// host dies mid-command and the run ends without a verdict.
const HOST_ACTION_LISTS = [
  'host/command-router.ts',
  'host/sequence-runner.ts',
  'host/input-resolution.ts',
  'session/state.ts',
  'backend/worker-pool.ts',
  'backend/sources/runtime.ps1',
  'backend/sources/sequence.ps1',
  'harness/scenarios.ts',
];

test('every held-key action reaches each host list that dispatches keys', async () => {
  // A held key is foreground-only, so the background sequence list is not one of
  // its layers; every other list must still recognise it.
  for (const file of HOST_ACTION_LISTS.filter((name) => name !== 'backend/sources/sequence.ps1')) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const action of ['key_down', 'key_up']) {
      assert.ok(source.includes(`'${action}'`), `${file} enumerates key actions but is missing ${action}`);
    }
  }
});

test('a held key in the background lane is refused as unsupported, not as bad grammar', async () => {
  // Grammar refusals read as a malformed call; this one has to name the route,
  // so the caller switches to foreground instead of re-sending the same step.
  const source = await readFile(new URL('../backend/sources/sequence.ps1', import.meta.url), 'utf8');
  const guard = source.slice(0, source.indexOf('sequence_step_invalid: expected one exact-window background input'));
  assert.match(guard, /@\('key_down', 'key_up'\) -contains/);
  assert.match(guard, /background_unsupported\|a held key requires the real keyboard/);
});

test('every exposed pointer action reaches each host action list', async () => {
  const exposed = COMPUTER_CORE_ACTION_SCHEMA.properties.type.enum.filter(
    (type) => !['type', 'key', 'key_down', 'key_up', 'wait'].includes(type)
  );
  // Changing this list means a new pointer action exists; add it to the lists below.
  assert.deepEqual(exposed, [
    'click',
    'double_click',
    'triple_click',
    'mouse_down',
    'mouse_up',
    'move',
    'drag',
    'scroll',
  ]);

  for (const file of HOST_ACTION_LISTS) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const action of ['triple_click', 'mouse_down', 'mouse_up']) {
      assert.ok(source.includes(`'${action}'`), `${file} enumerates pointer actions but is missing ${action}`);
    }
  }
});
