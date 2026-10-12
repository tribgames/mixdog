import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createMediaApi } from './media-api.mjs';

test('voice status is read-only: an in-flight staging install and older versions survive', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-voice-status-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  const manifestPath = new URL('../runtime/channels/data/voice-runtime-manifest.json', import.meta.url);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const key = `${process.platform}-${process.arch}`;
  const variant = manifest.platforms[key].variants[0];
  const active = `whisper-${manifest.version}-${variant.id}`;
  const whisperRoot = join(root, 'voice-runtime');
  const staging = join(whisperRoot, `staging-${process.pid}-1`);
  await mkdir(join(whisperRoot, active), { recursive: true });
  await mkdir(join(whisperRoot, 'whisper-old'), { recursive: true });
  await mkdir(staging, { recursive: true });
  await writeFile(join(staging, 'partial.bin'), 'downloading');
  await writeFile(join(whisperRoot, 'active-version'), active);
  await writeFile(join(whisperRoot, active, variant.executable), 'binary');
  await writeFile(join(root, 'mixdog-config.json'), JSON.stringify({ voice: { enabled: true } }));

  const status = await createMediaApi().getVoiceStatus();

  assert.equal(status.enabled, true);
  assert.equal(status.installed, false);
  assert.equal(status.components.model, false);
  await access(join(staging, 'partial.bin'));
  await access(join(whisperRoot, 'whisper-old'));
});
