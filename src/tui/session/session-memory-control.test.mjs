import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionApiA } from './session-api.mjs';

function harness(commandBusy = false) {
  const state = { commandBusy };
  const calls = [];
  const notices = [];
  const patches = [];
  const api = createSessionApiA({
    runtime: {
      memoryControl: (args) => new Promise((resolve, reject) => calls.push({ args, resolve, reject })),
    },
    getState: () => state,
    set: (patch) => { patches.push(patch); Object.assign(state, patch); },
    pushNotice: (...args) => notices.push(args),
  });
  return { api, state, calls, notices, patches };
}

test('parallel project memory lists finish independently without owning the command lock', async () => {
  const h = harness();
  const first = h.api.memoryControl({ action: 'core', op: 'list', cwd: 'project-a' }, { silent: true });
  const second = h.api.memoryControl({ op: 'list', project_id: 'common' }, { silent: true });
  assert.equal(h.calls.length, 2);
  h.calls[1].resolve('memory: empty');
  assert.equal(await second, 'memory: empty');
  h.calls[0].resolve('id=1 Preference');
  assert.equal(await first, 'id=1 Preference');
  assert.deepEqual(h.patches, []);
  assert.deepEqual(h.notices, []);
});

test('list success and failure preserve an existing command lock', async () => {
  const h = harness(true);
  const success = h.api.memoryControl({ action: 'core', op: 'list' }, { silent: true });
  const failure = h.api.memoryControl({ action: 'core', op: 'list' }, { silent: true });
  const rejected = assert.rejects(failure, /backend unavailable/);
  assert.equal(h.calls.length, 2);
  h.calls[0].resolve('memory: empty');
  h.calls[1].reject(new Error('backend unavailable'));
  assert.equal(await success, 'memory: empty');
  await rejected;
  assert.equal(h.state.commandBusy, true);
  assert.deepEqual(h.patches, []);
});

test('memory mutations retain command exclusion and release their own lock', async () => {
  const h = harness();
  const mutation = h.api.memoryControl({ action: 'core', op: 'delete', id: 1 });
  assert.equal(h.state.commandBusy, true);
  assert.equal(await h.api.memoryControl({ action: 'core', op: 'add', summary: 'Preference' }), null);
  assert.equal(h.calls.length, 1);
  h.calls[0].resolve('core deleted');
  assert.equal(await mutation, 'core deleted');
  assert.equal(h.state.commandBusy, false);
  assert.deepEqual(h.notices, [['core deleted', 'info']]);
});
