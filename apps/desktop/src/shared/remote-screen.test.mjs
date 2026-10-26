import assert from 'node:assert/strict';
import test from 'node:test';

import { openRemoteScreenCaptureTrack, remoteScreenKeyForCode } from './remote-screen.ts';

test('key table maps physical codes, marks extended keys and skips text-only ones', () => {
  assert.deepEqual(remoteScreenKeyForCode('KeyA'), { vk: 0x41, scan: 0x1e, extended: false });
  assert.deepEqual(remoteScreenKeyForCode('Digit1'), { vk: 0x31, scan: 0x02, extended: false });
  assert.deepEqual(remoteScreenKeyForCode('ArrowUp'), { vk: 0x26, scan: 0x48, extended: true });
  assert.deepEqual(remoteScreenKeyForCode('NumpadEnter'), { vk: 0x0d, scan: 0x1c, extended: true });
  assert.deepEqual(remoteScreenKeyForCode('ControlRight'), { vk: 0xa3, scan: 0x1d, extended: true });
  assert.equal(remoteScreenKeyForCode('Unidentified'), null);
  // A returned key is a copy: mutating it never corrupts the table.
  const copy = remoteScreenKeyForCode('KeyA');
  copy.vk = 0;
  assert.equal(remoteScreenKeyForCode('KeyA').vk, 0x41);
});

test('the capture track opens from the plan with sharp-text hinting', async () => {
  const track = { contentHint: '' };
  let asked = null;
  const opened = await openRemoteScreenCaptureTrack(
    {
      getUserMedia: async (constraints) => {
        asked = constraints;
        return { getVideoTracks: () => [track] };
      },
    },
    { sourceId: 'screen:7:0', width: 1920, height: 1080, maxFrameRate: 30 }
  );
  assert.equal(opened, track);
  assert.equal(track.contentHint, 'detail');
  assert.equal(asked.video.mandatory.chromeMediaSourceId, 'screen:7:0');
  assert.equal(asked.video.mandatory.maxWidth, 1920);
  await assert.rejects(
    openRemoteScreenCaptureTrack({ getUserMedia: async () => ({ getVideoTracks: () => [] }) }, {
      sourceId: 'screen:7:0',
      width: 64,
      height: 64,
      maxFrameRate: 30,
    })
  );
});
