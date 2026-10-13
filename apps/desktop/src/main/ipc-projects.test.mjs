import assert from 'node:assert/strict';
import test from 'node:test';
import { DESKTOP_IPC } from '../shared/contract.ts';
import { registerProjectIpc } from './ipc-projects.ts';

test('project add/rename/remove announce the existing settings-changed event so phones refresh', async () => {
  const handlers = new Map();
  const operations = [];
  registerProjectIpc({
    handle: (channel, fn) => handlers.set(channel, fn),
    host: {
      addProject: async () => {},
      renameProject: async () => {},
      removeProject: async () => {},
    },
    shell: {},
    invokeDesktopOperation: async (method, args) => {
      operations.push([method, args]);
    },
    operations: {},
  });
  await handlers.get(DESKTOP_IPC.addProject)({}, '/p');
  await handlers.get(DESKTOP_IPC.renameProject)({}, '/p', 'alias');
  await handlers.get(DESKTOP_IPC.removeProject)({}, '/p');
  assert.deepEqual(operations, Array(3).fill(['notifySettingsChanged', ['desktop']]));
});
