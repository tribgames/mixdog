import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { spawnSync } from 'node:child_process';
import { extractZip, resolveVoiceRuntime, selectVoiceModelId, voiceRuntimeInfo } from './voice-runtime-fetcher.mjs';

test('zip extraction on Windows does not expand $ in paths', {
  skip: process.platform !== 'win32' && 'Windows only',
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-zip-'));
  try {
    await writeFile(join(root, 'a.txt'), 'hello');
    const zip = join(root, 'a$HOME.zip');
    const made = spawnSync('tar', ['-a', '-cf', zip, '-C', root, 'a.txt']);
    assert.equal(made.status, 0);
    const dest = join(root, 'out$HOME');
    await mkdir(dest);
    extractZip(zip, dest);
    assert.equal(await readFile(join(dest, 'a.txt'), 'utf8'), 'hello');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('managed voice always uses the standard multilingual model', () => {
  assert.equal(selectVoiceModelId(), 'standard');
  assert.equal(selectVoiceModelId({ model: 'korean', language: 'ko' }), 'standard');
});

test('voice info reports resolved runtime versions and model bytes, not the newer bundled runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-voice-info-'));
  try {
    const modelPath = join(root, 'custom-model.bin');
    await writeFile(modelPath, 'weights');
    const info = voiceRuntimeInfo({
      modelId: 'standard',
      modelName: 'custom-model.bin',
      modelPath,
      whisperCmd: join(root, 'voice-runtime', 'whisper-1.7.6-cublas-11.8', 'Release', 'whisper-cli.exe'),
      ffmpegPath: join(root, 'ffmpeg-runtime', 'ffmpeg-6.0-custom', 'ffmpeg.exe'),
    });
    assert.deepEqual(info, {
      engine: 'whisper.cpp',
      runtimeVersion: '1.7.6',
      acceleration: 'cublas-11.8',
      model: 'custom-model.bin',
      modelBytes: 7,
      ffmpegVersion: '6.0-custom',
    });
    const absent = voiceRuntimeInfo({ modelId: 'standard' });
    assert.equal(absent.runtimeVersion, '');
    assert.equal(absent.acceleration, '');
    assert.equal(absent.ffmpegVersion, '');
    assert.ok(absent.model);
    assert.ok(absent.modelBytes > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('voice manifest contains no language-specific model', async () => {
  const manifestPath = new URL('../data/voice-runtime-manifest.json', import.meta.url);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.deepEqual(Object.keys(manifest.models), ['standard']);
  assert.equal(manifest.models.standard.id, 'large-v3-turbo-q8_0');
});

test('voice runtime resolution removes superseded published versions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-voice-runtime-gc-'));
  try {
    const manifestPath = new URL('../data/voice-runtime-manifest.json', import.meta.url);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const key = `${process.platform}-${process.arch}`;
    const variant = manifest.platforms[key].variants[0];
    const activeWhisper = `whisper-${manifest.version}-${variant.id}`;
    const activeFfmpeg = `ffmpeg-${manifest.ffmpeg.version}`;
    const whisperRoot = join(root, 'voice-runtime');
    const ffmpegRoot = join(root, 'ffmpeg-runtime');
    await mkdir(join(whisperRoot, activeWhisper), { recursive: true });
    await mkdir(join(whisperRoot, 'whisper-old'), { recursive: true });
    await mkdir(join(ffmpegRoot, activeFfmpeg), { recursive: true });
    await mkdir(join(ffmpegRoot, 'ffmpeg-old'), { recursive: true });
    await writeFile(join(whisperRoot, 'active-version'), activeWhisper);
    await writeFile(join(ffmpegRoot, 'active-version'), activeFfmpeg);
    await writeFile(join(whisperRoot, activeWhisper, variant.executable), 'binary');
    await writeFile(join(ffmpegRoot, activeFfmpeg, manifest.ffmpeg.platforms[key].executable), 'binary');

    await mkdir(join(whisperRoot, 'staging-1-1'), { recursive: true });
    resolveVoiceRuntime(root, { cleanup: false });
    await access(join(whisperRoot, 'whisper-old'));
    await access(join(whisperRoot, 'staging-1-1'));

    resolveVoiceRuntime(root);

    await assert.rejects(access(join(whisperRoot, 'staging-1-1')));
    await assert.rejects(access(join(whisperRoot, 'whisper-old')));
    await assert.rejects(access(join(ffmpegRoot, 'ffmpeg-old')));
    await access(join(whisperRoot, activeWhisper, variant.executable));
    await access(join(ffmpegRoot, activeFfmpeg, manifest.ffmpeg.platforms[key].executable));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('NUL-filled voice binaries and model are not treated as installed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-voice-nul-'));
  try {
    const manifest = JSON.parse(
      await readFile(new URL('../data/voice-runtime-manifest.json', import.meta.url), 'utf8')
    );
    const key = `${process.platform}-${process.arch}`;
    const variant = manifest.platforms[key].variants[0];
    const activeWhisper = `whisper-${manifest.version}-${variant.id}`;
    const activeFfmpeg = `ffmpeg-${manifest.ffmpeg.version}`;
    const nul = Buffer.alloc(64);
    await mkdir(join(root, 'voice-runtime', activeWhisper, ...variant.executable.split('/').slice(0, -1)), {
      recursive: true,
    });
    await mkdir(join(root, 'ffmpeg-runtime', activeFfmpeg), { recursive: true });
    await mkdir(join(root, 'voice', 'models'), { recursive: true });
    await writeFile(join(root, 'voice-runtime', 'active-version'), activeWhisper);
    await writeFile(join(root, 'ffmpeg-runtime', 'active-version'), activeFfmpeg);
    await writeFile(join(root, 'voice-runtime', activeWhisper, variant.executable), nul);
    await writeFile(join(root, 'ffmpeg-runtime', activeFfmpeg, manifest.ffmpeg.platforms[key].executable), nul);
    await writeFile(join(root, 'voice', 'models', manifest.models.standard.filename), nul);
    const runtime = resolveVoiceRuntime(root, { cleanup: false });
    assert.equal(runtime.binary, false);
    assert.equal(runtime.ffmpeg, false);
    assert.equal(runtime.model, false);
    assert.equal(runtime.installed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
