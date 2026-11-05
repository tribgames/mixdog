#!/usr/bin/env node
// Golden twin of the process-bound paths of the Local Provider (`local-provider/hardware.mjs`,
// `server.mjs`, `server-process.mjs`): what Node asks the OS to run, and what it makes of the
// answer. Node's real modules run with `child_process.execFile`/`spawn` and `fetch` replaced by
// scripted fakes that record each call, so the fixture holds the exact program, arguments,
// working directory and environment of every child. Rust `local_provider::hardware`,
// `provider::ensure_server` and `server_process::SystemLauncher` must ask the same.
//
//   node benchmarks/rust-core/recorders/record-local-process.mjs --tree <dir>
import { EventEmitter } from 'node:events';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const cp = createRequire(import.meta.url)('node:child_process');

// ---- scripted child_process ------------------------------------------------------------------
const calls = [];
let smiOutput = '';
let smiFailure = null;
cp.execFile = (file, args, options, callback) => {
  calls.push({ kind: 'execFile', file, args, timeoutMs: options.timeout ?? null, windowsHide: Boolean(options.windowsHide) });
  if (smiFailure) callback(new Error(smiFailure));
  else callback(null, { stdout: smiOutput, stderr: '' });
};
const children = [];
cp.spawn = (file, args, options) => {
  const env = options.env ?? {};
  calls.push({
    kind: 'spawn', file, args, cwd: options.cwd,
    env: { CUDA_VISIBLE_DEVICES: env.CUDA_VISIBLE_DEVICES ?? null },
    stdio: options.stdio, windowsHide: Boolean(options.windowsHide),
  });
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => queueMicrotask(() => child.emit('exit', null, 'SIGTERM'));
  children.push(child);
  return child;
};
syncBuiltinESMExports();
const realFetch = globalThis.fetch;
const fetched = [];
globalThis.fetch = async (url, options = {}) => {
  fetched.push({ url: String(url), authorized: /^Bearer \S+$/.test(options.headers?.Authorization ?? '') });
  return new Response(String(url).endsWith('/props') ? '{}' : 'ok', { status: 200 });
};

const { parseNvidiaGpus, createHardwareProbe, selectLocalProviderGpu } = await importFrom(tree, 'src/runtime/local-provider/hardware.mjs');
const { registerLocalModel } = await importFrom(tree, 'src/runtime/local-provider/registered-models.mjs');
const { ensureLocalProviderServer, stopLocalProviderServer } = await importFrom(tree, 'src/runtime/local-provider/server.mjs');
const { localProviderRuntimeExecutable, localProviderRuntimeDirectory, localProviderModelPath } = await importFrom(tree, 'src/runtime/local-provider/catalog.mjs');

// ---- hardware: parsing, probing, selecting ---------------------------------------------------
const GOOD = '0, GPU-aaaa-1111, NVIDIA RTX 4090, 24564, 20000';
const nvidiaOutputs = [
  `${GOOD}\n1, GPU-bbbb-2222, NVIDIA RTX 3060, 12288, 12000\n`,
  `${GOOD}\r\n1, GPU-bbbb-2222, NVIDIA RTX 3060, 12288, 12000\r\n`,
  `${GOOD}\nbroken line\n2, not-a-uuid, X, 100, 50\n`,
  '', '\n\n', 'no commas at all', '0, GPU-a, n, 100',
  '0, GPU-aa, NVIDIA, Corp, Ti, 100, 50',
  '0, GPU-aa, n, 100, 200', '0, GPU-aa, n, 100, 100', '0, GPU-aa, n, 100, 0', '0, GPU-aa, n, 100, -1', '0, GPU-aa, n, 0, 0', '0, GPU-aa, n, -5, 0',
  '0, GPU-, n, 100, 50', '0, gpu-AB-cd, n, 100, 50', '0, GPU-xyz, n, 100, 50', '0, GPU-ab_cd, n, 100, 50', '0, GPU-ab cd, n, 100, 50',
  ' 0 , GPU-aa , n , 100 , 50 ',
  ', GPU-aa, n, 100, 50', '1e1, GPU-aa, n, 100, 50', '0x2, GPU-aa, n, 100, 50', '-0, GPU-aa, n, 100, 50', '1.5, GPU-aa, n, 100, 50', '-1, GPU-aa, n, 100, 50', 'NaN, GPU-aa, n, 100, 50', 'x, GPU-aa, n, 100, 50',
  '0, GPU-aa, n, 1e4, 5e3', '0, GPU-aa, n, 0x10, 0x8', '0, GPU-aa, n, 100.5, 50', '0, GPU-aa, n, 100.0001, 50', '0, GPU-aa, n, NaN, 5', '0, GPU-aa, n, Infinity, 5', '0, GPU-aa, n, , ',
  '0, GPU-aa, n, 9007199254740991, 1', '0, GPU-aa, n, 8589934592, 1', '0, GPU-aa, n, 8589934591, 1',
  '3, GPU-cc, C, 8000, 100\n1, GPU-aa, A, 8000, 500\n2, GPU-bb, B, 16000, 100\n0, GPU-dd, D, 8000, 500\n',
  '0, GPU-aa, Name, With, Commas, 100, 50',
  '0,GPU-aa,n,100,50',
  '\u00a00, GPU-aa, n, 100, 50',
  '0, GPU-aa, ünï, 100, 50',
];
const parseCases = nvidiaOutputs.map((output) => ({ output, gpus: parseNvidiaGpus(output) }));

const probeStatus = (v) => {
  const { checkedAt: _c, ...rest } = v;
  return rest;
};
const probeCases = [];
// `query` is what the scripted probe command answers: `{ nvidia }` text, `{ apple }` facts or `{ error }`.
const addProbe = async (name, platform, arch, query, forceArgs = { force: true }) => {
  const never = async () => {
    throw new Error('never');
  };
  const answer = async () => {
    if (!query) throw new Error('never');
    if (query.error) throw new Error(query.error);
    return query.nvidia ?? query.apple;
  };
  const apple = platform === 'darwin';
  const probe = createHardwareProbe({ now: () => 1000, platform, arch, queryFn: apple ? never : answer, appleQueryFn: apple ? answer : never });
  const initial = probeStatus(probe.status());
  const status = probeStatus(await probe.refresh(forceArgs));
  probeCases.push({ name, platform, arch, query: query ?? null, initial, status });
};
const nvidia = (output) => ({ nvidia: output });
await addProbe('two gpus sorted by memory', 'win32', 'x64', nvidia('0, GPU-aa, A, 8000, 5000\n1, GPU-bb, B, 24000, 1000\n2, GPU-cc, C, 24000, 2000\n3, GPU-dd, D, 24000, 2000\n'));
await addProbe('no compatible gpu', 'win32', 'x64', nvidia(''));
await addProbe('only garbage', 'win32', 'x64', nvidia('error: driver\n'));
await addProbe('query fails', 'win32', 'x64', { error: 'boom' });
await addProbe('unsupported platform', 'linux', 'x64', null);
await addProbe('unsupported arch', 'win32', 'arm64', null);
await addProbe('mac on intel', 'darwin', 'x64', null);
for (const [name, query] of [
  ['apple default two thirds', { name: 'Apple M4', totalBytes: 16 * 1024 ** 3, wiredLimitMb: 0 }],
  ['apple wired limit', { name: 'Apple M2 Max', totalBytes: 64 * 1024 ** 3, wiredLimitMb: 49152 }],
  ['apple odd memory', { name: 'Apple M1', totalBytes: 8 * 1024 ** 3 + 1, wiredLimitMb: 0 }],
  ['apple negative limit', { name: 'Apple M1', totalBytes: 8 * 1024 ** 3, wiredLimitMb: -4 }],
  ['apple no name', { name: 'Apple Silicon', totalBytes: 24 * 1024 ** 3, wiredLimitMb: 0 }],
]) {
  await addProbe(name, 'darwin', 'arm64', { apple: query });
}
await addProbe('apple query fails', 'darwin', 'arm64', { error: 'sysctl failed' });
await addProbe('first unforced refresh queries', 'win32', 'x64', nvidia(GOOD), {});

const selectModels = [
  { estimatedVramBytes: 1024 ** 3, minimumVramBytes: 1024 ** 3 },
  { estimatedVramBytes: 10 * 1024 ** 3, minimumVramBytes: 1024 ** 3 },
  { estimatedVramBytes: 21 * 1024 ** 3, minimumVramBytes: 1 },
  { estimatedVramBytes: 30 * 1024 ** 3, minimumVramBytes: 1 },
  { estimatedVramBytes: 100, minimumVramBytes: 20 * 1024 ** 3 },
  { estimatedVramBytes: 100, minimumVramBytes: 40 * 1024 ** 3 },
  { estimatedVramBytes: 0, minimumVramBytes: 0 },
  { estimatedVramBytes: -5, minimumVramBytes: 0 },
  { estimatedVramBytes: 1, minimumVramBytes: 0 },
  { estimatedVramBytes: 12000 * 1024 ** 2, minimumVramBytes: 12000 * 1024 ** 2 },
  { estimatedVramBytes: 12000 * 1024 ** 2 + 1, minimumVramBytes: 0 },
];
const selectHardware = [
  ['two gpus', '0, GPU-aa, A, 24564, 20000\n1, GPU-bb, B, 12288, 12000\n'],
  ['equal free memory picks the lower index', '1, GPU-bb, B, 12288, 12000\n0, GPU-aa, A, 12288, 12000\n'],
  ['one small gpu', '0, GPU-aa, A, 12288, 12000\n'],
  ['no gpu', ''],
];
const selectCases = [];
for (const [label, output] of selectHardware) {
  const probe = createHardwareProbe({ platform: 'win32', arch: 'x64', queryFn: async () => output });
  const hardware = await probe.refresh({ force: true });
  for (const model of selectModels) {
    let outcome;
    try {
      outcome = { gpu: selectLocalProviderGpu(hardware, model) };
    } catch (error) {
      outcome = { error: error.message };
    }
    selectCases.push({ hardware: label, output, model, ...outcome });
  }
}
{
  const unsupported = await createHardwareProbe({ platform: 'linux', arch: 'x64' }).refresh({ force: true });
  const failed = await createHardwareProbe({ platform: 'win32', arch: 'x64', queryFn: async () => { throw new Error('boom'); } }).refresh({ force: true });
  for (const [label, hardware] of [['unsupported platform', unsupported], ['probe failed', failed]]) {
    let outcome;
    try {
      outcome = { gpu: selectLocalProviderGpu(hardware, selectModels[0]) };
    } catch (error) {
      outcome = { error: error.message };
    }
    selectCases.push({ hardware: label, output: null, model: selectModels[0], ...outcome });
  }
}

// ---- ensureLocalProviderServer: what is run, in what directory, with what environment --------
const platform = `${process.platform}-${process.arch}`;
if (!['win32-x64', 'darwin-arm64'].includes(platform)) throw new Error(`record on win32-x64 or darwin-arm64, not ${platform}`);
const SMI = '0, GPU-aaaa-1111, NVIDIA RTX 4090, 24564, 20000\n1, GPU-bbbb-2222, NVIDIA RTX 3060, 12288, 12000\n';
const baseModel = (over = {}) => {
  const id = `hf-${'0'.repeat(23)}7`;
  const revision = 'a'.repeat(40);
  return {
    id, name: 'owner/name · dir/m q.gguf', filename: `${id}.gguf`, remoteFilename: 'dir/m q.gguf', repository: 'owner/name', revision,
    url: `https://huggingface.co/owner/name/resolve/${revision}/dir/m%20q.gguf`, size: 100, sha256: 'b'.repeat(64),
    contextWindow: 16384, estimatedVramBytes: 200, minimumVramBytes: 200, ...over,
  };
};
const serverScenarios = [
  { name: 'nvidia host, default context', model: baseModel() },
  { name: 'larger context window', model: baseModel({ contextWindow: 32768 }) },
  { name: 'model needs more free memory than any gpu has', model: baseModel({ estimatedVramBytes: 21 * 1024 ** 3, minimumVramBytes: 21 * 1024 ** 3 }) },
  { name: 'model needs a bigger gpu than any present', model: baseModel({ estimatedVramBytes: 40 * 1024 ** 3, minimumVramBytes: 40 * 1024 ** 3 }) },
  { name: 'no gpu found', model: baseModel(), smi: '' },
  { name: 'nvidia-smi fails', model: baseModel(), smiFailure: 'spawn nvidia-smi ENOENT' },
  { name: 'runtime not installed', model: baseModel(), runtime: false },
  { name: 'model file missing', model: baseModel(), weights: false },
  { name: 'model file of another size', model: baseModel(), weightsBytes: 99 },
  { name: 'unknown model', model: baseModel(), requestId: 'hf-unknown' },
];
const serverCases = [];
for (const s of serverScenarios) {
  const dataDir = mkdtempSync(join(tmpdir(), 'local-process-'));
  const model = s.model;
  registerLocalModel(model, dataDir);
  if (s.runtime !== false) {
    const exe = localProviderRuntimeExecutable(dataDir);
    mkdirSync(localProviderRuntimeDirectory(dataDir), { recursive: true });
    writeFileSync(exe, 'x');
  }
  if (s.weights !== false) {
    const path = localProviderModelPath(model, dataDir);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, Buffer.alloc(s.weightsBytes ?? model.size, 1));
  }
  calls.length = 0;
  fetched.length = 0;
  smiOutput = s.smi ?? SMI;
  smiFailure = s.smiFailure ?? null;
  let outcome;
  try {
    await ensureLocalProviderServer(s.requestId ?? model.id, { dataDir });
    outcome = { ok: true };
  } catch (error) {
    outcome = { error: error.message };
  }
  const norm = (value) => JSON.parse(JSON.stringify(value).replaceAll(dataDir.replaceAll('\\', '\\\\'), '{DATA}'));
  const spawns = norm(calls).map((c) => {
    if (c.kind !== 'spawn') return c;
    const args = [...c.args];
    for (const [flag, token] of [['--port', '{PORT}'], ['--api-key', '{KEY}']]) args[args.indexOf(flag) + 1] = token;
    return { ...c, args };
  });
  const health = fetched.map((f) => ({ ...f, url: f.url.replace(/:\d+\//, ':{PORT}/') }));
  await stopLocalProviderServer();
  serverCases.push({ ...s, smiOutput, platform, outcome, spawns, health });
  rmSync(dataDir, { recursive: true, force: true });
}
globalThis.fetch = realFetch;

writeJson(join(FIXTURES_ROOT, 'services', 'local-process-twin.json'), {
  domain: 'local-process-twin',
  recorder: 'benchmarks/rust-core/recorders/record-local-process.mjs',
  parse: parseCases,
  probe: probeCases,
  select: selectCases,
  server: serverCases,
});
console.log(`recorded ${parseCases.length} parses, ${probeCases.length} probes, ${selectCases.length} selections, ${serverCases.length} server launches`);
process.exit(0);
