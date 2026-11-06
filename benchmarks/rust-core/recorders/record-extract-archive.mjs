#!/usr/bin/env node
// Golden twin of the runtime archive extraction (`local-provider/asset-installer.mjs`
// `extractCommand` + `extractArchive`): the program, arguments and the environment keys Node
// hands the child for a .zip and a .tar.gz, and the failure text for each way the child can end.
// Neither function is exported, so the recorder cuts Node's own source text and runs it with
// `spawn` scripted; nothing is re-typed here. Rust `local_provider::assets::extract_archive`
// must ask for the same and fail with the same text.
//
//   node benchmarks/rust-core/recorders/record-extract-archive.mjs --tree <dir>
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES_ROOT, parseArgs, resolveTree, writeJson } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const source = readFileSync(join(tree, 'src/runtime/local-provider/asset-installer.mjs'), 'utf8');
const from = source.indexOf('function extractCommand(');
const to = source.indexOf('async function installRuntimeInternal');
if (from < 0 || to < from) throw new Error('extractCommand/extractArchive not found in asset-installer.mjs');
const body = source.slice(from, to);

let current = null;
const spawn = (command, args, options) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  current.call = {
    command,
    args,
    archiveEnv: options.env.MIXDOG_LOCAL_ARCHIVE ?? null,
    destinationEnv: options.env.MIXDOG_LOCAL_DESTINATION ?? null,
    windowsHide: options.windowsHide,
    stdio: options.stdio,
    signal: Boolean(options.signal),
  };
  setImmediate(() => {
    for (const [stream, text] of current.script.output) child[stream].emit('data', Buffer.from(text));
    if (current.script.error) child.emit('error', new Error(current.script.error));
    child.emit('close', current.script.code);
  });
  return child;
};
const extractArchive = new Function('spawn', 'process', `${body}; return extractArchive;`)(spawn, process);

const long = (n) => 'x'.repeat(n);
const cases = [
  { name: 'zip ok', archive: 'C:\\data\\runtime\\.downloads\\a b.zip', destination: 'C:\\data\\runtime\\.staging-1', code: 0 },
  { name: 'tar ok', archive: '/data/runtime/.downloads/llama.tar.gz', destination: '/data/runtime/.staging-1', code: 0 },
  { name: 'zip uppercase extension is a tarball', archive: 'C:\\data\\A.ZIP', destination: 'C:\\data\\s', code: 0 },
  { name: 'failure with stdout and stderr', archive: '/a.tar.gz', destination: '/s', code: 2, output: [['stdout', 'out '], ['stderr', 'bad archive']] },
  { name: 'failure without output', archive: '/a.tar.gz', destination: '/s', code: 3 },
  { name: 'failure with a long log', archive: '/a.tar.gz', destination: '/s', code: 1, output: [['stderr', `${long(20000)}END`]] },
  { name: 'failure with a long log ending in an emoji', archive: '/a.tar.gz', destination: '/s', code: 1, output: [['stderr', `${long(20000)}\u{1F600}`]] },
  { name: 'failure with multi-chunk log', archive: '/a.tar.gz', destination: '/s', code: 1, output: [['stderr', 'one,'], ['stdout', 'two,'], ['stderr', 'three']] },
];

const recorded = [];
for (const c of cases) {
  current = { call: null, script: { code: c.code, output: c.output ?? [], error: null } };
  let outcome = { ok: true };
  try {
    await extractArchive(c.archive, c.destination, undefined);
  } catch (e) {
    outcome = { ok: false, message: e.message };
  }
  recorded.push({ name: c.name, archive: c.archive, destination: c.destination, code: c.code, output: c.output ?? [], call: current.call, outcome });
}

// A pre-aborted signal throws before anything is spawned.
const controller = new AbortController();
controller.abort();
current = { call: null, script: { code: 0, output: [], error: null } };
let aborted;
try {
  await extractArchive('/a.tar.gz', '/s', controller.signal);
} catch (e) {
  aborted = { name: e.name, spawned: current.call !== null };
}

writeJson(join(FIXTURES_ROOT, 'services', 'extract-archive-twin.json'), {
  domain: 'extract-archive-twin',
  recorder: 'benchmarks/rust-core/recorders/record-extract-archive.mjs',
  cases: recorded,
  aborted,
});
console.log(`recorded ${recorded.length} extractions`);
