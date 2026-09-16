import assert from 'node:assert/strict';
import test from 'node:test';

import { requiredDesktopCapabilityReadRequests, requiredDesktopCapabilityRequest, requiredNewTaskDraft } from './ipc-validation.ts';

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
      workflowId: 'default', orchestrationMode,
    });
  }
  assert.throws(() => requiredNewTaskDraft({ orchestrationMode: 'invalid' }), /orchestrationMode is invalid/);
});
