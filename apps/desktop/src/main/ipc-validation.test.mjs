import assert from 'node:assert/strict';
import test from 'node:test';

import { requiredDesktopCapabilityRequest } from './ipc-validation.ts';

test('Local Provider and Code Tidy lifecycle requests pass the desktop IPC boundary', () => {
  assert.deepEqual(requiredDesktopCapabilityRequest({
    capability: 'installBuiltinFeature',
    args: ['localProvider'],
  }), {
    capability: 'installBuiltinFeature',
    args: ['localProvider'],
  });
  assert.deepEqual(requiredDesktopCapabilityRequest({
    capability: 'setBuiltinToolEnabled',
    args: ['localProvider', false],
  }), {
    capability: 'setBuiltinToolEnabled',
    args: ['localProvider', false],
  });
  assert.deepEqual(requiredDesktopCapabilityRequest({
    capability: 'installBuiltinFeature',
    args: ['tidy'],
  }), {
    capability: 'installBuiltinFeature',
    args: ['tidy'],
  });
  assert.deepEqual(requiredDesktopCapabilityRequest({
    capability: 'setBuiltinToolEnabled',
    args: ['tidy', false],
  }), {
    capability: 'setBuiltinToolEnabled',
    args: ['tidy', false],
  });
});

test('desktop IPC still rejects unknown built-in lifecycle names', () => {
  assert.throws(() => requiredDesktopCapabilityRequest({
    capability: 'installBuiltinFeature',
    args: ['thirdPartyRuntime'],
  }), /git, memory, office, localProvider, or tidy/);
  assert.throws(() => requiredDesktopCapabilityRequest({
    capability: 'setBuiltinToolEnabled',
    args: ['thirdPartyRuntime', true],
  }), /git, office, localProvider, or tidy/);
});
