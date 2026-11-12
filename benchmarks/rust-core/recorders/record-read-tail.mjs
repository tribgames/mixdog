#!/usr/bin/env node
// The `read` tool's `tail: N` (the last N lines of a file), as the patched Node answers it: every accepted and every refused
// argument shape, on one workspace the recording lists as recipes (`text` and `repeat`, so a port rebuilds the same bytes).
// Each case is the arguments handed to `executeBuiltinTool('read', args, <workspace>)` and the text it returned, with the
// workspace's path written `<WS>` and whether Node's caller takes the text for a failed call (`classifyResultKind`).
//
//   node benchmarks/rust-core/recorders/record-read-tail.mjs --tree <b6f10295a export with the patch> \
//     --patch benchmarks/rust-core/recorders/node-patches/node-change-shell-cover-tools.patch
//
// Output: native/core/fixtures/read-tail/cases.json
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
// Import-time sweeps delete real user data: every user dir is a fresh temp dir first.
const sandbox = mkdtempSync(join(tmpdir(), 'read-tail-'));
for (const key of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) process.env[key] = sandbox;
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
process.env.TZ = 'UTC';
const { FIXTURES_ROOT, commitStage, nodeTreeIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');
const { recorderProvenance } = await import('./lib/provenance.mjs');

const BASE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const args = parseArgs();
const tree = resolveTree(args);
if (!args.get('patch')) throw new Error('record from the tree with the shell-cover-tools patch (--patch)');
const identity = nodeTreeIdentity(args, tree, BASE_COMMIT);
const importFrom = (rel) => import(pathToFileURL(join(tree, rel)).href);
const { executeBuiltinTool } = await importFrom('src/runtime/agent/orchestrator/tools/builtin.mjs');
const { classifyResultKind } = await importFrom('src/runtime/agent/orchestrator/session/result-classification.mjs');

const rows = (count, prefix = 'row') => Array.from({ length: count }, (_, i) => `${prefix}${i + 1}`).join('\n') + '\n';
const files = {
  'a.log': { text: rows(10) },
  'b.log': { text: rows(6, 'b') },
  'big.log': { text: rows(700, 'big') },
  'crlf.txt': { text: 'a\r\nb\r\nc\r\n' },
  'nonl.txt': { text: 'a\nb\nc' },
  'empty.txt': { text: '' },
  'bom.txt': { text: '\ufeffone\ntwo\nthree\n' },
  'bin.dat': { hex: '4100420043000a44' },
  'utf16.txt': { text: 'one\ntwo\nthree\n', enc: 'utf16le' },
  'sub/inner.txt': { text: 'inner\n' },
  'logs/one.log': { text: rows(4, 'one') },
  'logs/two.log': { text: rows(5, 'two') },
  // Past the 10 MiB the in-memory reader serves: tail reads from the end.
  'huge.log': { text: 'entry\n', repeat: 2_000_000 },
};
for (let i = 1; i <= 11; i += 1) files[`m${i}.txt`] = { text: rows(3, `m${i}-`) };

const read = (name, input) => ({ name, input });
const cases = [
  read('single tail 3', { file_path: 'a.log', tail: 3 }),
  read('single tail 1', { file_path: 'a.log', tail: 1 }),
  read('single tail the whole file', { file_path: 'a.log', tail: 10 }),
  read('single tail past the end', { file_path: 'a.log', tail: 50 }),
  read('single tail 600 of 700', { file_path: 'big.log', tail: 600 }),
  read('single tail 5 of 700', { file_path: 'big.log', tail: 5 }),
  read('crlf tail 2', { file_path: 'crlf.txt', tail: 2 }),
  read('no final newline tail 2', { file_path: 'nonl.txt', tail: 2 }),
  read('crlf tail past the end', { file_path: 'crlf.txt', tail: 1000 }),
  read('no final newline tail past the end', { file_path: 'nonl.txt', tail: 1000 }),
  read('empty file', { file_path: 'empty.txt', tail: 3 }),
  read('byte order mark', { file_path: 'bom.txt', tail: 2 }),
  read('binary file', { file_path: 'bin.dat', tail: 2 }),
  read('utf-16 file', { file_path: 'utf16.txt', tail: 2 }),
  read('missing file', { file_path: 'nope.log', tail: 2 }),
  read('a directory', { file_path: 'sub', tail: 2 }),
  read('a url', { file_path: 'https://example.com/a', tail: 2 }),
  read('a line coordinate', { file_path: 'a.log:3', tail: 2 }),
  read('a blank path', { file_path: ' ', tail: 2 }),
  read('a glob', { file_path: 'logs/*.log', tail: 2 }),
  read('a glob that names one file', { file_path: 'logs/t*.log', tail: 2 }),
  read('a one-element batch', { file_path: ['a.log'], tail: 2 }),
  read('with a limit', { file_path: 'a.log', tail: 3, limit: 2 }),
  read('with limit 0', { file_path: 'a.log', tail: 3, limit: 0 }),
  read('with a limit past the schema', { file_path: 'a.log', tail: 3, limit: 100001 }),
  read('with mode head', { file_path: 'a.log', tail: 2, mode: 'head' }),
  read('with mode summary', { file_path: 'a.log', tail: 2, mode: 'summary' }),
  read('with pages', { file_path: 'a.log', tail: 2, pages: '1' }),
  read('integral float', { file_path: 'a.log', tail: 2.0 }),
  read('legacy path', { path: 'a.log', tail: 2 }),
  read('legacy path array', { path: ['a.log', 'b.log'], tail: 2 }),
  read('batch default', { file_path: ['a.log', 'b.log'], tail: 2 }),
  read('batch per target', { file_path: ['a.log', { file_path: 'b.log', tail: 2 }] }),
  read('batch per target over the default', { file_path: ['a.log', { file_path: 'b.log', tail: 2 }], tail: 1 }),
  read('batch tail beside a window', { file_path: [{ file_path: 'a.log', tail: 2 }, { file_path: 'b.log', offset: 2, limit: 2 }] }),
  read('batch of one file twice', { file_path: [{ file_path: 'a.log', tail: 2 }, { file_path: 'a.log', tail: 4 }] }),
  read('batch of one file, tail and head', { file_path: [{ file_path: 'a.log', tail: 3 }, { file_path: 'a.log', limit: 3 }] }),
  read('batch with a missing file', { file_path: ['a.log', { file_path: 'nope.log', tail: 2 }], tail: 2 }),
  read('batch with a directory', { file_path: ['a.log', { file_path: 'sub', tail: 2 }] }),
  read('batch with a glob', { file_path: ['a.log', { file_path: 'logs/*.log', tail: 2 }] }),
  read('batch over the file cap', { file_path: Array.from({ length: 11 }, (_, i) => `m${i + 1}.txt`), tail: 1 }),
  read('huge file tail 3', { file_path: 'huge.log', tail: 3 }),
  read('huge file tail 5000', { file_path: 'huge.log', tail: 5000 }),
  read('huge file in a batch', { file_path: ['huge.log', { file_path: 'a.log', tail: 1 }], tail: 2 }),
  read('huge file with a limit', { file_path: 'huge.log', tail: 3, limit: 5 }),
  read('refused: tail with offset', { file_path: 'a.log', tail: 3, offset: 2 }),
  read('refused: tail with offset 1', { file_path: 'a.log', tail: 3, offset: 1 }),
  read('refused: tail with offset 0', { file_path: 'a.log', tail: 3, offset: 0 }),
  read('refused: target tail with offset', { file_path: ['a.log', { file_path: 'b.log', tail: 2, offset: 1 }] }),
  read('refused: target offset under a default tail', { file_path: ['a.log', { file_path: 'b.log', offset: 1 }], tail: 2 }),
  read('refused: batch default tail with default offset', { file_path: ['a.log', 'b.log'], tail: 2, offset: 2 }),
  read('refused: tail 0', { file_path: 'a.log', tail: 0 }),
  read('refused: tail -1', { file_path: 'a.log', tail: -1 }),
  read('refused: tail 100001', { file_path: 'a.log', tail: 100001 }),
  read('refused: tail 1.5', { file_path: 'a.log', tail: 1.5 }),
  read('refused: tail as text', { file_path: 'a.log', tail: '3' }),
  read('refused: tail null', { file_path: 'a.log', tail: null }),
  read('refused: tail true', { file_path: 'a.log', tail: true }),
  read('refused: tail a list', { file_path: 'a.log', tail: [3] }),
  read('refused: target tail 0', { file_path: ['a.log', { file_path: 'b.log', tail: 0 }] }),
  read('refused: target tail as text', { file_path: [{ file_path: 'b.log', tail: '2' }] }),
  read('refused: target tail null', { file_path: [{ file_path: 'b.log', tail: null }] }),
  read('refused: target with an unknown key', { file_path: [{ file_path: 'b.log', tail: 2, last: 2 }] }),
  read('refused: offset 0 beside a valid tail', { file_path: 'a.log', offset: 0, tail: 2 }),
  read('refused: limit text beside a valid tail', { file_path: 'a.log', limit: 'x', tail: 2 }),
];

const work = mkdtempSync(join(tmpdir(), 'read-tail-ws-'));
const root = join(work, 'ws');
const results = [];
try {
  // Every file is stamped by its place in the recipe list, so a newest-first glob answers the same order wherever it is replayed.
  for (const [n, [rel, f]] of Object.entries(files).entries()) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    let bytes;
    if (f.hex) bytes = Buffer.from(f.hex, 'hex');
    else {
      const text = f.repeat ? f.text.repeat(f.repeat) : f.text;
      bytes = f.enc === 'utf16le' ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]) : Buffer.from(text);
    }
    writeFileSync(join(root, rel), bytes);
    const at = (1_700_000_000_000 + n * 1000) / 1000;
    utimesSync(join(root, rel), at, at);
  }
  const fix = (text) => text.split(root).join('<WS>').split(root.replaceAll('\\', '/')).join('<WS>');
  for (const c of cases) {
    const result = await executeBuiltinTool('read', structuredClone(c.input), root);
    if (typeof result !== 'string') throw new Error(`${c.name}: a structured result was not expected`);
    results.push({ ...c, result: { text: fix(result), isError: classifyResultKind(result, false, 'read') === 'error' } });
  }
} finally {
  rmSync(work, { recursive: true, force: true });
  rmSync(sandbox, { recursive: true, force: true });
}

const finalDir = join(FIXTURES_ROOT, 'read-tail');
const stage = stageSet(finalDir);
writeJson(join(stage, 'cases.json'), {
  note: "Node's read with tail:N on the patched tree: arguments as handed to executeBuiltinTool('read', args, <ws>), the text it returned (workspace path written <WS>) and whether the caller takes it for a failed call.",
  files,
  cases: results,
});
writeSetManifest(stage, {
  set: 'read-tail',
  recorder: 'benchmarks/rust-core/recorders/record-read-tail.mjs',
  command: `node benchmarks/rust-core/recorders/record-read-tail.mjs --tree <tree> --patch ${identity.patch.file}`,
  identity,
  extra: recorderProvenance(import.meta.url),
});
commitStage(stage, finalDir);
console.log(`read-tail: ${results.length} cases, ${results.filter((c) => c.result.isError).length} refused`);
