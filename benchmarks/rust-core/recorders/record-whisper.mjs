#!/usr/bin/env node
// Golden twin of the managed whisper pipeline (`channels/lib/voice-transcription.mjs`,
// `whisper-server.mjs`, `whisper-port.mjs`): what Node asks the OS to run for one transcription
// (ffprobe, ffmpeg, whisper-server, the listener-ownership query), what it POSTs to the server,
// and the Windows tree-kill command. Node's real modules run with `child_process` scripted by
// fakes that record every call. Rust `voice::whisper_server`/`whisper_owner` must ask the same,
// in the same order.
//
//   node benchmarks/rust-core/recorders/record-whisper.mjs --tree <dir>
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const cp = createRequire(import.meta.url)('node:child_process');
const HOST_PLATFORM = process.platform;
// A pid no process holds: Node's tree kill runs in a worker thread this recorder cannot script,
// so the real PowerShell pass that ends the fake server must find nothing to end.
const WHISPER_PID = 2_147_480_001;

// ---- scripted child_process ------------------------------------------------------------------
const calls = [];
const requests = [];
let whisper = null; // { child, server }
let nextPid = 5000;
let listenerPlatform = HOST_PLATFORM;
let listenerPort = 0;
const stem = (file) => basename(String(file)).replace(/\.exe$/i, '');

const wavBytes = () => {
  const data = Buffer.alloc(32, 1);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVEfmt ', 8, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24);
  h.writeUInt32LE(32000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
};

const stopWhisper = () => {
  if (!whisper) return;
  const { child, server } = whisper;
  whisper = null;
  server.close();
  server.closeAllConnections?.();
  child.exitCode = 0;
  child.emit('exit', 0, null);
};

cp.spawn = (file, args, options = {}) => {
  const name = stem(file);
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.kill = () => {};
  child.unref = () => {};
  if (name === 'powershell' && args.includes('-EncodedCommand')) {
    const source = Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
    calls.push({ kind: 'treeKill', file: String(file), args: args.slice(0, args.indexOf('-EncodedCommand') + 1), script: source.replace(/-AliveAt \d+/, '-AliveAt {T}') });
    child.pid = nextPid++;
    setImmediate(() => {
      stopWhisper();
      child.emit('exit', 0, null);
      child.emit('close', 0);
    });
    return child;
  }
  const portAt = args.indexOf('--port');
  calls.push({
    kind: 'spawn',
    file: name,
    args: args.map((a, i) => (portAt >= 0 && i === portAt + 1 ? '{PORT}' : a)),
    cwd: options.cwd ?? null,
    stdio: options.stdio ?? null,
    windowsHide: Boolean(options.windowsHide),
    detached: Boolean(options.detached),
  });
  if (name === 'whisper-server') {
    child.pid = WHISPER_PID;
    const port = Number(args[portAt + 1]);
    listenerPort = port;
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('latin1');
        const fields = [...body.matchAll(/name="([^"]+)"(?:; filename="([^"]*)")?\r\n(?:Content-Type: ([^\r]+)\r\n)?\r\n([^\r]*)/g)].map((m) => ({ name: m[1], filename: m[2] ?? null, type: m[3] ?? null, value: m[2] ? null : m[4] }));
        requests.push({ method: req.method, url: req.url, multipart: /^multipart\/form-data; boundary=/.test(req.headers['content-type'] ?? ''), fields });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ text: ' hello world ' }));
      });
    });
    server.listen(port, args[args.indexOf('--host') + 1]);
    whisper = { child, server };
    return child;
  }
  child.pid = nextPid++;
  if (name === 'ffmpeg') {
    setImmediate(() => {
      writeFileSync(args.at(-1), wavBytes());
      child.emit('close', 0);
    });
  } else if (name.startsWith('ffprobe')) {
    setImmediate(() => {
      child.stdout.emit('data', '12.5\n');
      child.emit('close', 0);
    });
  } else {
    setImmediate(() => child.emit('close', 1));
  }
  return child;
};

const listenerAnswer = (platform, pid, port) =>
  platform === 'win32' ? `${pid}\r\n` : platform === 'linux' ? `LISTEN 0 4096 127.0.0.1:${port} 0.0.0.0:* users:(("whisper-server",pid=${pid},fd=3))\n` : `p${pid}\n`;
let listenerPid = WHISPER_PID;
let listenerFailure = false;
cp.execFile = (file, args, options, callback) => {
  const portToken = (a) => a.replace(String(listenerPort), '{PORT}');
  calls.push({ kind: 'listener', file: String(file), args: args.map(portToken), windowsHide: Boolean(options.windowsHide), hasSignal: Boolean(options.signal), maxBuffer: options.maxBuffer ?? null });
  if (listenerFailure) callback(new Error('failed'));
  else callback(null, listenerAnswer(listenerPlatform, listenerPid, listenerPort));
};
syncBuiltinESMExports();

const { createVoiceTranscription } = await importFrom(tree, 'src/runtime/channels/lib/voice-transcription.mjs');
const { stopVoiceWhisperServer } = await importFrom(tree, 'src/runtime/channels/lib/whisper-server.mjs');
const { whisperListenerOwned, listenerPidsInclude } = await importFrom(tree, 'src/runtime/channels/lib/whisper-port.mjs');
const { treeKillCommand } = await importFrom(tree, 'src/runtime/agent/orchestrator/mcp/child-tree.mjs');
const manifest = JSON.parse(readFileSync(join(tree, 'src/runtime/channels/data/voice-runtime-manifest.json'), 'utf8'));
const modelFilename = (manifest.models?.standard ?? manifest.model).filename;
const ext = HOST_PLATFORM === 'win32' ? '.exe' : '';

// ---- the pipeline: one transcription per scenario --------------------------------------------
const scenarios = [
  { name: 'korean with a duration gate', voice: { language: 'ko', transcription: { maxDurationSec: 60, threadCount: 3 } } },
  { name: 'english, custom audio format, no gate', voice: { language: 'en', transcription: { threadCount: 2, sampleRate: 8000, channels: 2 } } },
];
const pipeline = [];
for (const scenario of scenarios) {
  const dataDir = mkdtempSync(join(tmpdir(), 'whisper-rec-'));
  const put = (rel, bytes) => {
    mkdirSync(join(dataDir, rel, '..'), { recursive: true });
    writeFileSync(join(dataDir, rel), bytes);
  };
  put('voice-runtime/active-version', `whisper-${manifest.version}-vulkan`);
  put(`voice-runtime/whisper-${manifest.version}-vulkan/Release/whisper-cli${ext}`, 'x');
  put(`voice-runtime/whisper-${manifest.version}-vulkan/Release/whisper-server${ext}`, 'x');
  put(`voice/models/${modelFilename}`, 'model');
  put('ffmpeg-runtime/active-version', 'ffmpeg-6');
  put(`ffmpeg-runtime/ffmpeg-6/ffmpeg${ext}`, 'x');
  const audio = join(dataDir, 'in', 'clip.ogg');
  put('in/clip.ogg', 'ogg');
  calls.length = 0;
  requests.length = 0;
  const voice = createVoiceTranscription({ getConfig: () => ({ voice: scenario.voice }), dataDir });
  const text = await voice.transcribeVoice(audio, { attachmentId: 'att-1' });
  const record = calls.filter((c) => c.kind !== 'treeKill');
  const scrub = (v) => JSON.parse(JSON.stringify(v).replaceAll(dataDir.replaceAll('\\', '\\\\'), '{DATA}'));
  const snapshot = { name: scenario.name, voice: scenario.voice, text, calls: scrub(record), requests: scrub(requests), version: manifest.version, modelFilename };
  // The stop's tree kill is not scripted (see WHISPER_PID): the fake server exits on a timer.
  setTimeout(stopWhisper, 300);
  await stopVoiceWhisperServer();
  pipeline.push(snapshot);
  rmSync(dataDir, { recursive: true, force: true });
}

// ---- the listener-ownership query on every platform ------------------------------------------
const listener = [];
const platformOf = (p) => Object.defineProperty(process, 'platform', { value: p, configurable: true });
for (const platform of ['win32', 'linux', 'darwin']) {
  for (const outcome of ['owned', 'other pid', 'query fails', 'bad host']) {
    platformOf(platform);
    listenerPlatform = platform;
    listenerPort = 18771;
    listenerPid = outcome === 'other pid' ? 7 : WHISPER_PID;
    listenerFailure = outcome === 'query fails';
    calls.length = 0;
    const host = outcome === 'bad host' ? "127.0.0.1'; calc" : '127.0.0.1';
    const owned = await whisperListenerOwned(host, 18771, WHISPER_PID, new AbortController().signal);
    listener.push({ platform, outcome, host, owned, calls: calls.filter((c) => c.kind === 'listener') });
  }
}
platformOf(HOST_PLATFORM);
const pidLines = [`${WHISPER_PID}\r\n`, `12\n${WHISPER_PID}\n`, ` ${WHISPER_PID} \n`, `${WHISPER_PID}0\n`, '', '\n'].map((stdout) => ({ stdout, includes: listenerPidsInclude(stdout, WHISPER_PID) }));

// ---- the Windows tree kill -------------------------------------------------------------------
const treeKill = [[WHISPER_PID, 1_000], [7, 1_700_000_000_000]].map(([pid, aliveAt]) => {
  const { command, args } = treeKillCommand([pid], { aliveAt });
  const at = args.indexOf('-EncodedCommand');
  return { pid, aliveAt, command, flags: args.slice(0, at + 1), script: Buffer.from(args[at + 1], 'base64').toString('utf16le') };
});

writeJson(join(FIXTURES_ROOT, 'services', 'whisper-twin.json'), {
  domain: 'whisper-twin',
  recorder: 'benchmarks/rust-core/recorders/record-whisper.mjs',
  platform: HOST_PLATFORM,
  systemRoot: process.env.SystemRoot ?? null,
  pipeline,
  listener,
  pidLines,
  treeKill,
});
console.log(`recorded ${pipeline.length} transcriptions, ${listener.length} listener queries, ${treeKill.length} tree kills (${HOST_PLATFORM})`);
process.exit(0);
