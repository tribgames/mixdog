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

test("a room member turn's bot-to-bot hop travels as transcript metadata, never as a runtime option", () => {
  const options = submitOptionsWithDevice({ hop: 3 }, 's');
  assert.deepEqual(options.transcriptMeta, { device: hostDeviceName(), hop: 3 });
  assert.equal('hop' in options, false);
  assert.deepEqual(submitOptionsWithDevice({ hop: 0 }, 's').transcriptMeta, { device: hostDeviceName() });
});

test('a host-stamped remote device name wins over the local default', () => {
  assert.deepEqual(submitOptionsWithDevice({ device: 'Pixel 9' }, 's').transcriptMeta, { device: 'Pixel 9' });
});
