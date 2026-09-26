import assert from 'node:assert/strict';
import test from 'node:test';

import {
  requiredDesktopCapabilityReadRequests,
  requiredDesktopCapabilityRequest,
  requiredGitBranchName,
  requiredNewTaskDraft,
} from './ipc-validation.ts';

test('the turn review bar reaches its diff with only a boolean refresh option', () => {
  for (const args of [[], [{}], [{ refresh: true }], [{ refresh: false }]]) {
    assert.doesNotThrow(() => requiredDesktopCapabilityRequest({ capability: 'getTurnReviewDiff', args }));
  }
  for (const args of [[{ refresh: 'yes' }], [{ cwd: 'C:/' }], [null], [[]], [{ refresh: true }, {}]]) {
    assert.throws(() => requiredDesktopCapabilityRequest({ capability: 'getTurnReviewDiff', args }), TypeError);
  }
});

test('Local Provider and Code Tidy lifecycle requests pass the desktop IPC boundary', () => {
  assert.deepEqual(
    requiredDesktopCapabilityRequest({
      capability: 'installBuiltinFeature',
      args: ['localProvider'],
    }),
    {
      capability: 'installBuiltinFeature',
      args: ['localProvider'],
    }
  );
  assert.deepEqual(
    requiredDesktopCapabilityRequest({
      capability: 'setBuiltinToolEnabled',
      args: ['localProvider', false],
    }),
    {
      capability: 'setBuiltinToolEnabled',
      args: ['localProvider', false],
    }
  );
  assert.deepEqual(
    requiredDesktopCapabilityRequest({
      capability: 'installBuiltinFeature',
      args: ['tidy'],
    }),
    {
      capability: 'installBuiltinFeature',
      args: ['tidy'],
    }
  );
  assert.deepEqual(
    requiredDesktopCapabilityRequest({
      capability: 'setBuiltinToolEnabled',
      args: ['tidy', false],
    }),
    {
      capability: 'setBuiltinToolEnabled',
      args: ['tidy', false],
    }
  );
});

test('Code Tidy status reads travel the read lane with no arguments', () => {
  for (const capability of ['getTidyEngineStatus', 'getTidyInstallStatus']) {
    assert.deepEqual(requiredDesktopCapabilityRequest({ capability }), { capability, args: [] });
    assert.deepEqual(requiredDesktopCapabilityReadRequests([{ capability, args: [] }]), [{ capability, args: [] }]);
    assert.throws(
      () => requiredDesktopCapabilityRequest({ capability, args: ['tidy'] }),
      /invalid number of arguments/
    );
  }
});

test('desktop IPC still rejects unknown built-in lifecycle names', () => {
  assert.throws(
    () =>
      requiredDesktopCapabilityRequest({
        capability: 'installBuiltinFeature',
        args: ['thirdPartyRuntime'],
      }),
    /git, memory, office, localProvider, or tidy/
  );
  assert.throws(
    () =>
      requiredDesktopCapabilityRequest({
        capability: 'setBuiltinToolEnabled',
        args: ['thirdPartyRuntime', true],
      }),
    /git, office, localProvider, or tidy/
  );
});

test('developer settings travel the read lane and option writes require an id and boolean', () => {
  assert.deepEqual(requiredDesktopCapabilityReadRequests([{ capability: 'getDeveloperSettings' }]), [
    { capability: 'getDeveloperSettings', args: [] },
  ]);
  assert.throws(
    () => requiredDesktopCapabilityRequest({ capability: 'getDeveloperSettings', args: ['x'] }),
    /invalid number of arguments/
  );
  assert.deepEqual(requiredDesktopCapabilityRequest({ capability: 'setDeveloperOption', args: ['devProviders', true] }), {
    capability: 'setDeveloperOption',
    args: ['devProviders', true],
  });
  assert.throws(
    () => requiredDesktopCapabilityRequest({ capability: 'setDeveloperOption', args: ['devProviders', 'on'] }),
    /requires a boolean value/
  );
  assert.throws(
    () => requiredDesktopCapabilityRequest({ capability: 'setDeveloperOption', args: ['  ', false] }),
    /developer option id is invalid/
  );
  assert.throws(
    () => requiredDesktopCapabilityRequest({ capability: 'setDeveloperOption', args: [7, false] }),
    /developer option id must be a string/
  );
  assert.throws(
    () => requiredDesktopCapabilityRequest({ capability: 'setDeveloperOption', args: ['devProviders'] }),
    /invalid number of arguments/
  );
});

test('orchestration modes cross the read/configure and new-task IPC boundaries', () => {
  assert.deepEqual(requiredDesktopCapabilityReadRequests([{ capability: 'getOrchestrationMode' }]), [
    { capability: 'getOrchestrationMode', args: [] },
  ]);
  for (const orchestrationMode of ['none', 'focused', 'balanced', 'swarm']) {
    assert.deepEqual(
      requiredDesktopCapabilityRequest({ capability: 'setOrchestrationMode', args: [orchestrationMode] }),
      { capability: 'setOrchestrationMode', args: [orchestrationMode] }
    );
    assert.deepEqual(requiredNewTaskDraft({ workflowId: 'default', orchestrationMode }), {
      workflowId: 'default',
      orchestrationMode,
    });
  }
  assert.throws(() => requiredNewTaskDraft({ orchestrationMode: 'invalid' }), /orchestrationMode is invalid/);
});

test('git branch validation trims surrounding whitespace without weakening rejection rules', () => {
  assert.equal(requiredGitBranchName('\t feature/topic \n'), 'feature/topic');
  assert.equal(requiredGitBranchName(` ${'x'.repeat(512)} `), 'x'.repeat(512));
  assert.throws(() => requiredGitBranchName(null), { name: 'TypeError', message: 'git branch must be a string.' });
  for (const value of [' \t\n', 'x'.repeat(513), ' -main ', 'fea\0ture', 'fea\nture', 'fea\rture']) {
    assert.throws(() => requiredGitBranchName(value), { name: 'TypeError', message: 'git branch is invalid.' });
  }
});
