import assert from 'node:assert/strict';
import test from 'node:test';

import { requiredDesktopCapabilityRequest } from './ipc-validation.ts';

test('Local Provider lifecycle requests pass the desktop IPC boundary', () => {
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
});

test('desktop IPC still rejects unknown built-in lifecycle names', () => {
  assert.throws(() => requiredDesktopCapabilityRequest({
    capability: 'installBuiltinFeature',
    args: ['thirdPartyRuntime'],
  }), /git, memory, office, or localProvider/);
  assert.throws(() => requiredDesktopCapabilityRequest({
    capability: 'setBuiltinToolEnabled',
    args: ['thirdPartyRuntime', true],
  }), /git, office, or localProvider/);
});
