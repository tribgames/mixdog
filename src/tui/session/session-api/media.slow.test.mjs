import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const manifestUrl = new URL('../../../runtime/channels/data/voice-runtime-manifest.json', import.meta.url);
const fixture = fileURLToPath(
  new URL('../../../runtime/channels/lib/fixtures/whisper-server-fixture.mjs', import.meta.url)
);

// Lay out a published managed voice runtime (whisper + server, model, ffmpeg)
// exactly where resolveVoiceRuntime looks for it.
async function installVoiceRuntime(root) {
  const manifest = JSON.parse(await fs.readFile(manifestUrl, 'utf8'));
  const key = `${process.platform}-${process.arch}`;
  const variant = manifest.platforms[key].variants[0];
  const activeWhisper = `whisper-${manifest.version}-${variant.id}`;
  const activeFfmpeg = `ffmpeg-${manifest.ffmpeg.version}`;
  const whisperCmd = path.join(root, 'voice-runtime', activeWhisper, variant.executable);
  const serverCmd = path.join(
    path.dirname(whisperCmd),
    `whisper-server${process.platform === 'win32' ? '.exe' : ''}`
  );
  const ffmpegPath = path.join(root, 'ffmpeg-runtime', activeFfmpeg, manifest.ffmpeg.platforms[key].executable);
  const modelPath = path.join(root, 'voice', 'models', manifest.models.standard.filename);
  for (const file of [whisperCmd, serverCmd, ffmpegPath, modelPath]) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'stub');
  }
  await fs.writeFile(path.join(root, 'voice-runtime', 'active-version'), activeWhisper);
  await fs.writeFile(path.join(root, 'ffmpeg-runtime', 'active-version'), activeFfmpeg);
  return { serverCmd, ffmpegPath };
}

test('prepareTranscription reports a missing runtime, then warms the server the dictation reuses', {
  timeout: 60_000,
}, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mixdog-dictation-warm-'));
  const previous = {
    MIXDOG_DATA_DIR: process.env.MIXDOG_DATA_DIR,
    MIXDOG_WHISPER_IDLE_TIMEOUT_MS: process.env.MIXDOG_WHISPER_IDLE_TIMEOUT_MS,
  };
  process.env.MIXDOG_DATA_DIR = root;
  process.env.MIXDOG_WHISPER_IDLE_TIMEOUT_MS = '0';
  const servers = [];
  const ffmpegRuns = [];
  let layout = null;
  const spawn = childProcess.spawn;
  t.mock.method(childProcess, 'spawn', (command, args, options) => {
    if (command === layout?.ffmpegPath) {
      ffmpegRuns.push(args);
      const script = `require('fs').writeFileSync(${JSON.stringify(args.at(-1))}, 'first audio')`;
      return spawn(process.execPath, ['-e', script], options);
    }
    assert.equal(command, layout?.serverCmd);
    const child = spawn(process.execPath, [fixture, ...args], options);
    servers.push(child);
    return child;
  });
  syncBuiltinESMExports();
  const { createSessionMediaApi } = await import('./media.mjs');
  const { stopVoiceWhisperServer } = await import('../../../runtime/channels/lib/whisper-server.mjs');
  const api = createSessionMediaApi({});
  try {
    const missing = await api.prepareTranscription();
    assert.equal(missing.ready, false);
    assert.match(missing.reason, /voice runtime not installed/);
    assert.equal(servers.length, 0);

    layout = await installVoiceRuntime(root);
    assert.deepEqual(await api.prepareTranscription(), { ready: true });
    assert.equal(servers.length, 1, 'warm-up started the managed server');
    assert.equal(servers[0].exitCode, null);

    const text = await api.transcribeAudio({ data: Buffer.from('recording').toString('base64') });
    assert.equal(text, 'first words');
    assert.equal(servers.length, 1, 'the dictation reused the warmed server');
    assert.equal(ffmpegRuns.length, 1);
    const args = ffmpegRuns[0];
    const filter = args.indexOf('-af');
    assert.equal(filter, args.indexOf('-i') + 2, 'the onset filter follows the input');
    assert.equal(args[filter + 1], 'adelay=300:all=1');
  } finally {
    await stopVoiceWhisperServer();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    for (const child of servers) {
      if (child.exitCode === null) child.kill();
    }
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});
