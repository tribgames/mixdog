import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { notificationSoundPath, scaledNotificationSound } from './notification-sound.ts';

test('scaled notification sound multiplies PCM samples, clamps, and caches per volume', async () => {
  const source = fileURLToPath(new URL('../renderer/public/notification-sounds/soft-rise.wav', import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-notification-volume-'));
  try {
    assert.equal(scaledNotificationSound(source, 100, directory), source);
    const original = await readFile(source);
    for (const volume of [0, 250, 400]) {
      const target = scaledNotificationSound(source, volume, directory);
      assert.equal(target, join(directory, `soft-rise-${volume}.wav`));
      assert.equal(scaledNotificationSound(source, volume, directory), target);
      const scaled = await readFile(target);
      assert.equal(scaled.length, original.length);
      assert.deepEqual(scaled.subarray(0, 44), original.subarray(0, 44));
      for (let index = 44; index < original.length; index += 2) {
        const expected = Math.max(-32768, Math.min(32767, Math.round((original.readInt16LE(index) * volume) / 100)));
        assert.equal(scaled.readInt16LE(index), expected + 0);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Windows sound paths resolve to unpacked WAV assets, never inside an ASAR', () => {
  const root = resolve('notification-sound-fixture');
  assert.equal(
    notificationSoundPath({ packaged: true, resourcesPath: root, appPath: 'unused' }),
    resolve(root, 'app.asar.unpacked/out/renderer/notification-sounds/soft-rise.wav')
  );
  assert.equal(
    notificationSoundPath({ packaged: false, resourcesPath: 'unused', appPath: root }),
    resolve(root, 'src/renderer/public/notification-sounds/soft-rise.wav')
  );
});

for (const [name, duration] of [
  ['soft-rise', 0.68],
  ['warm-fall', 0.56],
  ['wood-tap', 0.45],
  ['air-chime', 0.8],
  ['round-pop', 0.48],
  ['tiny-pluck', 0.36],
  ['soft-bloom', 0.94],
  ['felt-pulse', 0.5],
  ['soft-rise-low', 0.68],
  ['soft-rise-light', 0.6],
  ['soft-rise-close', 0.66],
  ['soft-rise-relaxed', 0.82],
]) {
  test(`${name} is a short, nonclipping PCM WAV with silent boundaries`, async () => {
    const wav = await readFile(new URL(`../renderer/public/notification-sounds/${name}.wav`, import.meta.url));
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
    assert.equal(wav.readUInt16LE(20), 1);
    assert.equal(wav.readUInt16LE(22), 1);
    assert.equal(wav.readUInt32LE(24), 44100);
    assert.equal(wav.readUInt16LE(34), 16);
    assert.equal(wav.readUInt32LE(40), Math.round(duration * 44100) * 2);
    assert.equal(wav.length, 44 + Math.round(duration * 44100) * 2);
    const samples = [];
    for (let i = 44; i < wav.length; i += 2) samples.push(wav.readInt16LE(i));
    assert.equal(samples[0], 0);
    assert.equal(samples.at(-1), 0);
    assert.ok(Math.max(...samples.map(Math.abs)) <= 0.24 * 32767);
    const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length) / 32767;
    assert.ok(rms > 0.01 && rms < 0.15);
    assert.ok(Math.abs(samples.reduce((sum, value) => sum + value, 0) / samples.length) < 30);
  });
}
