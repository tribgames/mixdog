import assert from 'node:assert/strict';
import test from 'node:test';

import { formatPairCode, remainingFraction, remainingLabel } from './pair-code-format.ts';
import { readSavedPcs, rememberPc } from '../remote-saved-pcs.ts';
import { remoteClientKind } from '../../shared/remote-trust.ts';

test('a code reads as two groups of three with an m:ss countdown', () => {
  assert.equal(formatPairCode('482917'), '482·917');
  assert.equal(remainingLabel(186_000, 0), '3:06');
  assert.equal(remainingLabel(0, 5_000), '0:00');
  assert.equal(remainingFraction(150_000, 0), 0.5);
  assert.equal(remainingFraction(900_000, 0), 1);
});

test('paired clients are classified by what they reported', () => {
  assert.equal(remoteClientKind('Mixdog App'), 'app');
  assert.equal(remoteClientKind('Mixdog Desktop'), 'pc');
  assert.equal(remoteClientKind('Chrome'), 'browser');
});

test('saved PCs keep the newest first, drop junk, and keep a known name', () => {
  const id = '0123456789abcdef0123456789abcdef';
  const other = 'f'.repeat(32);
  assert.deepEqual(
    readSavedPcs(
      JSON.stringify([
        { deviceId: 'nope', name: 'x' },
        { deviceId: id, name: 'Home' },
      ])
    ),
    [{ deviceId: id, name: 'Home', lastConnectedAt: 0 }]
  );
  const list = rememberPc([{ deviceId: id, name: 'Home', lastConnectedAt: 1 }], {
    deviceId: other,
    name: '',
    lastConnectedAt: 2,
  });
  assert.deepEqual(
    list.map((pc) => pc.deviceId),
    [other, id]
  );
  assert.equal(rememberPc(list, { deviceId: id, name: '', lastConnectedAt: 3 })[0].name, 'Home');
});
