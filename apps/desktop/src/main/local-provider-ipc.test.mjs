import assert from 'node:assert/strict';
import test from 'node:test';
import { requiredDesktopCapabilityRequest } from './ipc-validation.ts';

test('local operation capabilities validate targets and idle limits before dispatch', () => {
  for (const request of [
    { capability: 'startLocalProviderInstallation', args: ['runtime'] },
    { capability: 'startLocalProviderInstallation', args: ['model', 'catalog-model'] },
    { capability: 'cancelLocalProviderInstallation', args: ['job-id'] },
    { capability: 'setLocalProviderIdleTtl', args: [0] },
    { capability: 'setLocalProviderIdleTtl', args: [86400] },
    { capability: 'getLocalProviderModelDetails', args: ['catalog-model'] },
    { capability: 'startLocalProviderModelMaintenance', args: ['catalog-model', 'verify'] },
    { capability: 'deleteLocalProviderModel', args: ['confirmation-token'] },
  ]) {
    assert.equal(requiredDesktopCapabilityRequest(request).capability, request.capability);
  }
  for (const request of [
    { capability: 'startLocalProviderInstallation', args: ['shell'] },
    { capability: 'startLocalProviderInstallation', args: ['model'] },
    { capability: 'startLocalProviderInstallation', args: ['runtime', 'model'] },
    { capability: 'cancelLocalProviderInstallation', args: [''] },
    { capability: 'setLocalProviderIdleTtl', args: [-1] },
    { capability: 'setLocalProviderIdleTtl', args: [86401] },
    { capability: 'setLocalProviderIdleTtl', args: ['0'] },
    { capability: 'startLocalProviderModelMaintenance', args: ['catalog-model', 'execute'] },
    { capability: 'deleteLocalProviderModel', args: [''] },
  ]) {
    assert.throws(() => requiredDesktopCapabilityRequest(request));
  }
});
