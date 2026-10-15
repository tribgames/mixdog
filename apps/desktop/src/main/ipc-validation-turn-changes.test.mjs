import assert from 'node:assert/strict';
import test from 'node:test';

import { DESKTOP_READ_CAPABILITIES } from '../shared/contract.ts';
import { requiredDesktopCapabilityReadRequests, requiredDesktopCapabilityRequest } from './ipc-validation.ts';

test('turn changes capabilities accept exactly the transcript card contract', () => {
  for (const args of [
    [{ checkpointId: 'cp' }],
    [{ checkpointId: 'cp', patch: true }],
    [{ checkpointId: 'cp', patch: false, file: 'src/a b.ts' }],
  ]) {
    assert.doesNotThrow(() => requiredDesktopCapabilityRequest({ capability: 'getTurnChanges', args, sessionId: 's' }));
  }
  assert.equal(DESKTOP_READ_CAPABILITIES.includes('getTurnChanges'), true);
  assert.doesNotThrow(() =>
    requiredDesktopCapabilityReadRequests([{ capability: 'getTurnChanges', args: [{ checkpointId: 'cp' }] }])
  );
  for (const args of [
    [],
    [{}],
    [{ checkpointId: '' }],
    [{ checkpointId: 'cp', patch: 'yes' }],
    [{ checkpointId: 'cp', file: 3 }],
    [{ checkpointId: 'cp', extra: true }],
    ['cp'],
  ]) {
    assert.throws(() => requiredDesktopCapabilityRequest({ capability: 'getTurnChanges', args }), TypeError);
  }
  for (const capability of ['revertTurnChanges', 'reapplyTurnChanges']) {
    assert.doesNotThrow(() => requiredDesktopCapabilityRequest({ capability, args: ['cp', null, 1] }));
    assert.doesNotThrow(() => requiredDesktopCapabilityRequest({ capability, args: ['cp', 'a.txt', 0] }));
    assert.throws(
      () => requiredDesktopCapabilityReadRequests([{ capability, args: ['cp', null, 1] }]),
      /not read-only/
    );
    for (const args of [
      ['cp', null],
      ['', null, 1],
      ['cp', 3, 1],
      ['cp', null, -1],
      ['cp', null, 1.5],
      ['cp', null, '1'],
    ]) {
      assert.throws(() => requiredDesktopCapabilityRequest({ capability, args }), TypeError);
    }
  }
  // Delete history: a session mutation with no arguments, never a read.
  assert.doesNotThrow(() =>
    requiredDesktopCapabilityRequest({ capability: 'clearSessionChangeHistory', args: [], sessionId: 's' })
  );
  assert.throws(
    () => requiredDesktopCapabilityRequest({ capability: 'clearSessionChangeHistory', args: ['cp'] }),
    TypeError
  );
  assert.throws(
    () => requiredDesktopCapabilityReadRequests([{ capability: 'clearSessionChangeHistory', args: [] }]),
    /not read-only/
  );
});
