#!/usr/bin/env node
// Golden twin of the voice runtime installer: Node's real `ensureWhisperRuntime`,
// `ensureWhisperModel` and `ensureFfmpegRuntime` (voice-runtime-fetcher.mjs) against a local
// release server, on a scratch folder. Records the exact
// error text the user sees, the requests made, and the tree each install leaves. Rust
// `voice::installer` must answer the same.
//
// The fetcher reads its manifest from `../data/` beside itself, so it runs from a copy in a
// scratch tree whose imports point back at the product tree.
//
//   node benchmarks/rust-core/recorders/record-voice-installer.mjs --tree <dir>
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync, crc32 } from 'node:zlib';
import { FIXTURES_ROOT, parseArgs, resolveTree, writeJson } from './lib/common.mjs';

// A scratch root per run: the fetcher, the data folders and the CUDA/driver stand-ins live under it. The recording holds {root} and {base} where it was and where the release server listened.
const PIN = mkdtempSync(join(tmpdir(), 'mixdog-voice-installer-'));
let base = '';

// Nothing of the host's CUDA/NVIDIA setup may leak into a scenario.
for (const key of Object.keys(process.env)) if (key === 'CUDA_PATH' || /^CUDA_PATH_V\d+_\d+$/i.test(key)) delete process.env[key];
const NO_ROOT = join(PIN, 'none');
process.env.ProgramW6432 = NO_ROOT;
process.env.ProgramFiles = NO_ROOT;
process.env['ProgramFiles(x86)'] = NO_ROOT;
process.env.LOCALAPPDATA = NO_ROOT;

const tree = resolveTree(parseArgs());
mkdirSync(join(PIN, 'x', 'lib'), { recursive: true });
mkdirSync(join(PIN, 'x', 'data'), { recursive: true });

// A stored (uncompressed) zip: no zip library in Node, and the bytes are the same on both sides.
function zip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBytes = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(33, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(33, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

const ext = process.platform === 'win32' ? '.exe' : '';
const SERVER = `whisper-server${ext}`;
const HOST_KEY = `${process.platform}-${process.arch}`;
const sha = (data) => createHash('sha256').update(data).digest('hex');
const buf = (text) => Buffer.from(text);

const ASSETS = {
  '/whisper.zip': zip([
    { name: `Release/${SERVER}`, data: buf('server bytes') },
    { name: `Release/whisper-cli${ext}`, data: buf('cli bytes') },
    { name: 'Release/docs/readme.txt', data: buf('read me') },
    { name: 'LICENSE', data: buf('license text') },
  ]),
  '/whisper-noexec.zip': zip([{ name: 'LICENSE', data: buf('license text') }]),
  '/not-a-zip.zip': buf('this is not a zip archive at all'),
  '/model.bin': buf('model weights'),
  '/ffmpeg.gz': gzipSync(buf('ffmpeg bytes'), { level: 6 }),
  '/ffmpeg.zip': zip([{ name: `ffmpeg${ext}`, data: buf('ffmpeg zip bytes') }]),
  '/ffmpeg-noexec.zip': zip([{ name: 'other.txt', data: buf('x') }]),
  '/variant-base.zip': zip([{ name: `Release/${SERVER}`, data: buf('base') }]),
};

const requests = [];
const server = createServer((req, res) => {
  requests.push(req.url);
  const body = ASSETS[req.url];
  if (!body) {
    res.writeHead(404, 'Not Found', { 'content-length': 9 });
    res.end('not found');
    return;
  }
  res.writeHead(200, 'OK', { 'content-length': body.length });
  res.end(body);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
base = `http://127.0.0.1:${server.address().port}`;

// An asset the server does not hold answers 404 whatever its digest says.
const entry = (asset, extra = {}) => ({ url: `${base}${asset}`, sha256: sha(ASSETS[asset] ?? ''), size: ASSETS[asset]?.length ?? 1, ...extra });
const modelEntry = () => ({ id: 'm', filename: 'm.bin', ...entry('/model.bin') });
function manifestFor(patch = {}) {
  const variant = { id: 'cpu', requires: null, format: 'zip', executable: `Release/${SERVER}`, ...entry('/whisper.zip') };
  const manifest = {
    version: '1.0.0',
    model: modelEntry(),
    models: { standard: modelEntry() },
    ffmpeg: { version: '2.0', platforms: { [HOST_KEY]: { format: 'gz', executable: `ffmpeg${ext}`, ...entry('/ffmpeg.gz') } } },
    platforms: { [HOST_KEY]: { variants: [variant] } },
  };
  return patch.apply ? patch.apply(manifest) || manifest : manifest;
}

// The fetcher, from a copy that finds its manifest beside it and its imports in the product tree.
const fetcherSource = readFileSync(join(tree, 'src/runtime/channels/lib/voice-runtime-fetcher.mjs'), 'utf8').replace(
  /from '\.\.\/\.\.\//g,
  `from '${pathToFileURL(join(tree, 'src/runtime')).href}/`
);
const fetcherPath = join(PIN, 'x', 'lib', 'voice-runtime-fetcher.mjs');
writeFileSync(fetcherPath, fetcherSource);
const fetcher = await import(pathToFileURL(fetcherPath).href);

function listing(root) {
  const out = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const rel = relative(root, path).replaceAll('\\', '/');
      if (statSync(path).isDirectory()) {
        out[`${rel}/`] = null;
        walk(path);
      } else {
        const data = readFileSync(path);
        out[rel] = { size: data.length, sha256: sha(data) };
      }
    }
  };
  try {
    walk(root);
  } catch {}
  return out;
}

const OPS = {
  whisper: (data) => fetcher.ensureWhisperRuntime(data),
  model: (data) => fetcher.ensureWhisperModel(data),
  ffmpeg: (data) => fetcher.ensureFfmpegRuntime(data),
};

const variants = (list) => ({ apply: (m) => ((m.platforms[HOST_KEY].variants = list), m) });
const pick = (id, requires, asset) => ({ id, requires, format: 'zip', executable: `Release/${SERVER}`, ...entry(asset) });
const spread = [pick('cpu', null, '/gone-base.zip'), pick('driver', { nvidiaDriver: true }, '/gone-driver.zip'), pick('cuda11', { cudaMajor: 11 }, '/gone-cuda11.zip'), pick('cuda12', { cudaMajor: 12 }, '/gone-cuda12.zip')];
const EMPTY_ROOT = join(PIN, 'empty-sysroot');
// Files a scenario's environment points at; recorded so the replay can lay the same ones down.
const touched = [];
const dll = (root, sub, name) => {
  mkdirSync(join(PIN, root, sub), { recursive: true });
  writeFileSync(join(PIN, root, sub, name), 'x');
  touched.push(join(PIN, root, sub, name));
};

const scenarios = [
  { name: 'whisper-ok', op: 'whisper' },
  { name: 'whisper-http-404', op: 'whisper', manifest: { apply: (m) => ((m.platforms[HOST_KEY].variants[0].url = `${base}/gone.zip`), m) } },
  { name: 'whisper-sha-mismatch', op: 'whisper', manifest: { apply: (m) => ((m.platforms[HOST_KEY].variants[0].sha256 = '0'.repeat(64)), m) } },
  { name: 'whisper-size-advertised', op: 'whisper', manifest: { apply: (m) => (m.platforms[HOST_KEY].variants[0].size++, m) } },
  { name: 'whisper-no-sha256', op: 'whisper', manifest: { apply: (m) => (delete m.platforms[HOST_KEY].variants[0].sha256, m) } },
  { name: 'whisper-no-executable', op: 'whisper', manifest: { apply: (m) => (Object.assign(m.platforms[HOST_KEY].variants[0], entry('/whisper-noexec.zip')), m) } },
  { name: 'whisper-corrupt-zip', op: 'whisper', manifest: { apply: (m) => (Object.assign(m.platforms[HOST_KEY].variants[0], entry('/not-a-zip.zip')), m) } },
  { name: 'whisper-unsupported-platform', op: 'whisper', manifest: { apply: (m) => ((m.platforms = { 'nope-x1': m.platforms[HOST_KEY] }), m) } },
  { name: 'whisper-no-variants', op: 'whisper', manifest: { apply: (m) => ((m.platforms[HOST_KEY].variants = []), m) } },
  { name: 'whisper-no-variant-matches', op: 'whisper', manifest: variants([pick('cuda12', { cudaMajor: 12 }, '/gone-cuda12.zip')]), env: () => ({ SystemRoot: EMPTY_ROOT }) },
  // The variant scenarios stop at the download (every variant asset is a 404): the request
  // path is the pick. The host's own driver must not show, so SystemRoot is a folder of ours.
  { name: 'variant-cuda-highest', op: 'whisper', manifest: variants(spread), env: () => { dll('cuda12', 'bin', 'cublas64_12.dll'); dll('cuda11', 'bin', 'cublas64_11.dll'); return { SystemRoot: EMPTY_ROOT, CUDA_PATH: join(PIN, 'cuda12'), CUDA_PATH_V11_8: join(PIN, 'cuda11') }; } },
  { name: 'variant-cuda-standard-dir', op: 'whisper', manifest: variants(spread), env: () => { dll('pf', 'NVIDIA GPU Computing Toolkit/CUDA/v11.8/bin', 'cublas64_11.dll'); return { SystemRoot: EMPTY_ROOT, ProgramFiles: join(PIN, 'pf') }; } },
  { name: 'variant-driver', op: 'whisper', manifest: variants(spread), env: () => { dll('sysroot', 'System32', 'nvml.dll'); return { SystemRoot: join(PIN, 'sysroot') }; } },
  { name: 'variant-catch-all', op: 'whisper', manifest: variants(spread), env: () => ({ SystemRoot: EMPTY_ROOT }) },
  { name: 'variant-cuda-13-only-falls-back', op: 'whisper', manifest: variants(spread), env: () => { dll('cuda13', 'bin', 'cublas64_13.dll'); return { SystemRoot: EMPTY_ROOT, CUDA_PATH: join(PIN, 'cuda13') }; } },
  { name: 'model-ok', op: 'model', seed: { 'voice/models/old.bin': 'old', 'voice/models/notes.txt': 'keep', 'voice/models/.staging-1-2-m.bin': 'partial' } },
  { name: 'model-wrong-file-refetched', op: 'model', seed: { 'voice/models/m.bin': 'damaged' } },
  { name: 'model-http-404', op: 'model', manifest: { apply: (m) => ((m.models.standard.url = `${base}/gone.bin`), m) } },
  { name: 'model-sha-mismatch', op: 'model', manifest: { apply: (m) => ((m.models.standard.sha256 = '1'.repeat(64)), m) } },
  { name: 'model-size-advertised', op: 'model', manifest: { apply: (m) => (m.models.standard.size++, m) } },
  { name: 'model-missing-section', op: 'model', manifest: { apply: (m) => (delete m.models, delete m.model, m) } },
  { name: 'ffmpeg-ok-gz', op: 'ffmpeg', seed: { 'ffmpeg-runtime/ffmpeg-1.0/ffmpeg': 'old' } },
  { name: 'ffmpeg-ok-zip', op: 'ffmpeg', manifest: { apply: (m) => (Object.assign(m.ffmpeg.platforms[HOST_KEY], { format: 'zip' }, entry('/ffmpeg.zip')), m) } },
  { name: 'ffmpeg-http-404', op: 'ffmpeg', manifest: { apply: (m) => ((m.ffmpeg.platforms[HOST_KEY].url = `${base}/gone.gz`), m) } },
  { name: 'ffmpeg-sha-mismatch', op: 'ffmpeg', manifest: { apply: (m) => ((m.ffmpeg.platforms[HOST_KEY].sha256 = '2'.repeat(64)), m) } },
  { name: 'ffmpeg-no-sha256', op: 'ffmpeg', manifest: { apply: (m) => (delete m.ffmpeg.platforms[HOST_KEY].sha256, m) } },
  { name: 'ffmpeg-bad-format', op: 'ffmpeg', manifest: { apply: (m) => ((m.ffmpeg.platforms[HOST_KEY].format = 'xz'), m) } },
  { name: 'ffmpeg-no-executable', op: 'ffmpeg', manifest: { apply: (m) => (Object.assign(m.ffmpeg.platforms[HOST_KEY], { format: 'zip' }, entry('/ffmpeg-noexec.zip')), m) } },
  { name: 'ffmpeg-missing-section', op: 'ffmpeg', manifest: { apply: (m) => (delete m.ffmpeg, m) } },
  { name: 'ffmpeg-unsupported-platform', op: 'ffmpeg', manifest: { apply: (m) => ((m.ffmpeg.platforms = { 'nope-x1': m.ffmpeg.platforms[HOST_KEY] }), m) } },
];

const results = [];
for (const scenario of scenarios) {
  const data = join(PIN, 'data', scenario.name);
  rmSync(data, { recursive: true, force: true });
  mkdirSync(data, { recursive: true });
  for (const [rel, text] of Object.entries(scenario.seed ?? {})) {
    mkdirSync(join(data, rel, '..'), { recursive: true });
    writeFileSync(join(data, rel), text);
  }
  const manifest = manifestFor(scenario.manifest);
  writeFileSync(join(PIN, 'x', 'data', 'voice-runtime-manifest.json'), JSON.stringify(manifest, null, 2));
  touched.length = 0;
  const env = scenario.env?.() ?? {};
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  requests.length = 0;
  let outcome;
  try {
    outcome = { result: await OPS[scenario.op](data) };
  } catch (error) {
    outcome = { error: error.message };
  }
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  results.push({ name: scenario.name, op: scenario.op, seed: scenario.seed ?? {}, env, files: [...touched], manifest, ...outcome, requests: [...requests], tree: listing(data) });
}
server.close();

// Where the run happened is not part of the recording: the scratch root, the server's address and
// the staging folder's `<pid>-<ms>` become placeholders, in the strings Node produced and in the
// folders the replay must lay down. The replay applies the inverse (and the same masking to its own text).
const slash = (path) => path.replaceAll('\\', '/');
const norm = (text) =>
  text
    .replaceAll(slash(PIN), '{root}')
    .replaceAll(PIN, '{root}')
    .replaceAll(base, '{base}')
    .replace(/staging-\d+-\d+/g, 'staging-{tag}');
const normalize = (value) =>
  typeof value === 'string' ? norm(value) : Array.isArray(value) ? value.map(normalize) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v)])) : value;

const assets = Object.fromEntries(Object.entries(ASSETS).map(([path, data]) => [path, data.toString('base64')]));
writeJson(join(FIXTURES_ROOT, 'services', 'voice-installer-twin.json'), {
  domain: 'voice-installer-twin',
  recorder: 'benchmarks/rust-core/recorders/record-voice-installer.mjs',
  hostKey: HOST_KEY,
  assets,
  scenarios: normalize(results),
});
rmSync(PIN, { recursive: true, force: true });
console.log(`recorded ${results.length} scenarios`);
process.exit(0);
