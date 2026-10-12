import assert from 'node:assert/strict';
import { hostname } from 'node:os';
import test from 'node:test';

import { hostDeviceName, submitOptionsWithDevice } from './session-device.ts';

test('a local submit is attributed to this machine and the option leaves the runtime options', () => {
  const options = submitOptionsWithDevice({ displayText: 'hi' }, 'sub-1');
  assert.equal(options.id, 'sub-1');
  assert.equal(options.displayText, 'hi');
  assert.equal('device' in options, false);
  assert.deepEqual(options.transcriptMeta, { device: hostDeviceName() });
  assert.equal(hostDeviceName(), hostname().trim() || 'Main PC');
});

test('a host-stamped remote device name wins over the local default', () => {
  assert.deepEqual(submitOptionsWithDevice({ device: 'Pixel 9' }, 's').transcriptMeta, { device: 'Pixel 9' });
});
