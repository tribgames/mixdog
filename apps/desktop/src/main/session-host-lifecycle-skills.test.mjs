import assert from 'node:assert/strict';
import test from 'node:test';

import { requiredDesktopCapabilityReadRequests, requiredDesktopCapabilityRequest } from './ipc-validation.ts';
import { SessionHostLifecycle } from './session-host-lifecycle.ts';

const PROJECT = process.platform === 'win32' ? 'C:\\Projects\\app' : '/projects/app';
const WORKTREE = process.platform === 'win32' ? 'C:\\Worktrees\\app-feature' : '/worktrees/app-feature';

test('skillsStatus accepts only an absolute projectPath option at the IPC boundary', () => {
  assert.doesNotThrow(() => requiredDesktopCapabilityReadRequests([{ capability: 'skillsStatus' }]));
  assert.doesNotThrow(() =>
    requiredDesktopCapabilityReadRequests([{ capability: 'skillsStatus', args: [{ projectPath: PROJECT }] }])
  );
  for (const args of [
    [{}],
    [{ projectPath: '' }],
    [{ projectPath: 'relative/app' }],
    [{ projectPath: `${PROJECT}\0` }],
    [{ projectPath: PROJECT, cwd: PROJECT }],
    [{ cwd: PROJECT }],
    [PROJECT],
    [null],
    [{ projectPath: PROJECT }, {}],
  ]) {
    assert.throws(() => requiredDesktopCapabilityRequest({ capability: 'skillsStatus', args }), TypeError);
  }
});

function lifecycle(projects) {
  const forwarded = [];
  const owner = {
    async resolveSessionWorkspace(projectPath) {
      if (!projects.has(projectPath)) throw new Error('Project is not registered.');
      return { registeredProject: projectPath, cwd: projects.get(projectPath), desktopSession: {} };
    },
    async invokeControl(capability, args) {
      forwarded.push([capability, args]);
      return { skills: [] };
    },
  };
  return { host: new SessionHostLifecycle(owner), forwarded };
}

test("a draft's skillsStatus is answered for its registered Project's folder; other paths are refused", async () => {
  const { host, forwarded } = lifecycle(new Map([[PROJECT, WORKTREE]]));
  const results = await host.readCapabilities([
    { capability: 'skillsStatus' },
    { capability: 'skillsStatus', args: [{ projectPath: PROJECT }] },
    { capability: 'skillsStatus', args: [{ projectPath: '/elsewhere' }] },
  ]);
  assert.deepEqual(
    results.map((result) => result.ok),
    [true, true, false]
  );
  // The daemon never sees the renderer's path: only the host-resolved folder.
  assert.deepEqual(forwarded, [
    ['skillsStatus', []],
    ['skillsStatus', [{ cwd: WORKTREE }]],
  ]);
});
