#!/usr/bin/env node
// Records what Node's file tools answer for the cases of the Node tests whose behaviour the Rust `fs` module (list, read,
// read_legacy, patch_parse, common) has but no Rust test proved (k1 gaps-tools.md section 3, `mixdog-tools/src/fs`). Each case
// runs the Node tool the tested function serves (`executeListTool`, `executeBuiltinTool('read')`, `executePatchTool`) at
// b6f10295a on the test's input; the marker cases call Node's marker functions, whose Rust counterparts are the module's own.
//
//   node benchmarks/rust-core/recorders/record-fs-other-cases.mjs --tree <exact export of b6f10295a with node_modules> --work <temp dir>
//
// Writes native/core/fixtures/fs-other-cases/{golden.json,MANIFEST.json}. Tool cases: the Node test and test name, the Rust tool
// and its arguments (`<ROOT>` the workspace), the workspace files (`files` as UTF-8 text or `bytes` as byte arrays), each call's
// whole result and, for apply_patch, the files after it. Marker cases: each call's arguments and Node's string.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const RECORDER = 'benchmarks/rust-core/recorders/record-fs-other-cases.mjs';
const B = 'src/runtime/agent/orchestrator/tools/builtin';

const args = parseArgs();
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, NODE_COMMIT);
const workRoot = resolve(args.get('work') ?? (() => { throw new Error('--work <temp dir> is required'); })());
mkdirSync(workRoot, { recursive: true });
process.env.MIXDOG_DATA_DIR = join(workRoot, 'data');

const { executeListTool } = await importFrom(tree, `${B}/list-tool.mjs`);
const { executeBuiltinTool } = await importFrom(tree, 'src/runtime/agent/orchestrator/tools/builtin.mjs');
const { executePatchTool } = await importFrom(tree, 'src/runtime/agent/orchestrator/tools/patch.mjs');
const { normalizeToolEnvelope } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/tool-envelope.mjs');
const { SMART_BASH_MAX_BYTES } = await importFrom(tree, `${B}/shell-output.mjs`);
const { capMarker, formatCapSize, windowMarker } = await importFrom(tree, 'src/runtime/shared/tool-output-marker.mjs');

function workspace(name, { files = {}, bytes = {} }) {
  const root = mkdtempSync(join(workRoot, `${name}-`));
  for (const [rel, text] of Object.entries(files)) writeFileSync(join(root, rel), text);
  for (const [rel, list] of Object.entries(bytes)) writeFileSync(join(root, rel), Buffer.from(list));
  return root;
}
const scrub = (root, text) => [root, root.replace(/\\/g, '/'), root.replace(/\\/g, '\\\\')].reduce((s, f) => s.replaceAll(f, '<ROOT>'), String(text));
const textOf = (raw) => {
  const env = normalizeToolEnvelope(raw);
  return typeof env.result === 'string' ? env.result : JSON.stringify(env.result ?? '');
};

const cases = [];
async function record(c, root, calls, after = []) {
  const out = [];
  for (const [rustArgs, run] of calls) out.push({ args: rustArgs, result: scrub(root, await run()) });
  const filesAfter = Object.fromEntries(after.map((rel) => [rel, readFileSync(join(root, rel), 'utf8')]));
  cases.push({ ...c, calls: out, ...(after.length ? { filesAfter } : {}) });
}

// ---- list-tool-integrity.test.mjs 'list defaults to a 100-entry page with an offset continuation' -------------------------------
{
  const files = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`entry-${String(i).padStart(3, '0')}.txt`, 'ok']));
  const root = workspace('list-page', { files });
  await record({ name: 'list-default-page', test: `${B}/list-tool-integrity.test.mjs`, case: 'list defaults to a 100-entry page with an offset continuation', tool: 'list', files }, root, [
    [{ path: '<ROOT>', hidden: true }, () => executeListTool({ path: root, hidden: true }, process.cwd())],
    [{ path: '<ROOT>', hidden: true, limit: 200 }, () => executeListTool({ path: root, hidden: true, head_limit: 200 }, process.cwd())],
  ]);
}

// ---- v4a-blank-context.test.mjs: each patch applied by the apply_patch tool to the file its hunk matches -------------------------
const PATCHES = [
  ['v4a-blank-inside-hunk', 'a blank line inside an open update hunk becomes a context line', 'anchor\nfirst\n\nsecond\ndrop me\n',
    ['*** Begin Patch', '*** Update File: a.txt', '@@ anchor', ' first', '', ' second', '-drop me', '+keep me', '*** End Patch', ''].join('\n')],
  ['v4a-blank-before-hunk', 'a blank line before any hunk opens no hunk', 'anchor\nfirst\ndrop me\n',
    ['*** Begin Patch', '*** Update File: a.txt', '', '@@ anchor', ' first', '-drop me', '+keep me', '*** End Patch', ''].join('\n')],
];
for (const [name, testName, text, patch] of PATCHES) {
  const files = { 'a.txt': text };
  const root = workspace(name, { files });
  await record({ name, test: 'src/runtime/agent/orchestrator/tools/patch/v4a-blank-context.test.mjs', case: testName, tool: 'apply_patch', files }, root, [
    [{ base_path: '<ROOT>', patch }, async () => textOf(await executePatchTool('apply_patch', { base_path: root, patch }, root))],
  ], ['a.txt']);
}

// ---- text-stats.test.mjs: the two files read by the read tool -------------------------------------------------------------
{
  const bytes = { 'ascii.txt': [0x61, 0x0a, 0x62, 0x00], 'utf8.txt': [...Buffer.from('a\né\0', 'utf-8')] };
  const root = workspace('text-stats', { bytes });
  await record({ name: 'text-stats-final-nul', test: `${B}/text-stats.test.mjs`, case: 'a final NUL byte still terminates the last line on both scan paths', tool: 'read', bytes }, root,
    Object.keys(bytes).map((rel) => [{ file_path: rel }, async () => textOf(await executeBuiltinTool('read', { path: rel }, root))]));
}

// ---- shell-output-bytes.test.mjs: the over-budget CJK line and the short output, each a file read by the read tool ----------------
{
  const files = { 'cjk.txt': '가'.repeat(Math.floor(SMART_BASH_MAX_BYTES / 2)), 'short.txt': 'short output' };
  const root = workspace('shell-output-bytes', { files });
  const read = (rel) => [{ file_path: rel }, async () => textOf(await executeBuiltinTool('read', { path: rel }, root))];
  await record({ name: 'cap-multibyte-line', test: `${B}/shell-output-bytes.test.mjs`, case: 'smartMiddleTruncate measures the byte budget, not the string length', tool: 'read', files: { 'cjk.txt': files['cjk.txt'] } }, root, [read('cjk.txt')]);
  await record({ name: 'cap-short-and-long', test: `${B}/shell-output-bytes.test.mjs`, case: 'capShellOutput truncates multi-byte output that exceeds the byte budget', tool: 'read', files }, root, [read('cjk.txt'), read('short.txt')]);
}

// ---- tool-output-marker.test.mjs: each call with a Rust form --------------------------------------------------------------
const markers = [];
const M = 'src/runtime/shared/tool-output-marker.test.mjs';
for (const input of [{ from: 5, to: 27, total: 90, nextOffset: 28 }, { from: 5, to: 90, total: 90 }, { from: 1, to: 5, total: 20, nextOffset: 6, capBytes: 512 }]) {
  markers.push({ case: 'window markers say which slice was requested and where it continues', fn: 'windowMarker', input, result: windowMarker(input) });
}
for (const bytes of [5 * 1024, 1536]) markers.push({ case: 'cap markers always carry a continuation and name the full output path when one exists', fn: 'formatCapSize', input: bytes, result: formatCapSize(bytes) });
for (const input of [{ limit: 5 * 1024, shown: '63 match row(s) shown', nextOffset: 63 }, { limit: 1024 }]) {
  markers.push({ case: 'cap markers always carry a continuation and name the full output path when one exists', fn: 'capMarker', input, result: capMarker(input) });
}

const EXCLUDED = {
  [`${B}/list-tool-integrity.test.mjs`]: {
    'aborted list work cannot poison the result cache': 'gone: the list result cache',
    'root readdir failures are errors and stay uncached': 'gone: injected readdirImpl and the list result cache',
    'list and tree surface skipped subdirectories and never cache partial walks': 'gone: the tree tool and the list result cache',
    'a successful empty walk is explicitly traceable as integrity-checked': 'gone: list telemetry hooks',
    'a paginated complete find page stays complete and is reused': 'gone: find-files page cache',
    'concurrent list subscribers all see the shared incomplete outcome': 'gone: shared list flights',
    'a list walk truncated by the walk deadline is incomplete and never cached': 'gone: the list result cache',
    'native deep list rows that are not cache-safe are marked unsafe and not cached': 'gone: the list result cache',
    'a paged tree is a complete page and is reused': 'gone: the tree tool',
    'a paged list cache hit retains completeness': 'gone: the list result cache',
    'a byte-truncated tree render is incomplete, not persisted, and re-walks': 'gone: the tree tool',
    'glob-shaped list forwards the caller outcome to the find flow': 'difference (gaps-tools row 37): `list path:"src/*.ts"` gives glob results in Node, a not-found error in Rust',
    '<label>: failed metadata is incomplete, uncached, and the next call re-reads (each label)': 'gone: injected list metadata and the list result cache',
    'concurrent subscribers share a metadata-incomplete outcome': 'gone: shared list flights',
  },
  [M]: {
    "window markers … (the `unit: 'chars'` / `offsetKey: 'startIndex'` call)": 'no Rust form: the Rust window marker has no offset key argument (no Rust caller uses another key)',
    'cap markers … (the `cursor` call and the `fullPath` call)': 'no Rust form: the Rust cap marker has no cursor or full-path argument (no Rust caller)',
  },
};

const finalDir = join(FIXTURES_ROOT, 'fs-other-cases');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), { note: `Node's file tools at ${NODE_COMMIT}, per case of ${RECORDER}`, platform: process.platform, cases, markers: { test: M, calls: markers } });
writeSetManifest(stage, {
  set: 'fs-other-cases',
  recorder: RECORDER,
  command: `node ${RECORDER} --tree <exact export of ${NODE_COMMIT}> --work <temp dir>`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    compared: "each call's whole result text in order through the Rust tool the case names (schema argument names: `limit` for head_limit, `file_path` for read's path), and for apply_patch the patched file whole; markers: each recorded call's string through the Rust marker function of the same name. text-stats and shell-output-bytes test functions below the read tool (countTextStatsStreaming, capShellOutput/smartMiddleTruncate); their files are read by relative path through the read tool, the production entry point. text-stats: both tools answer a file holding NUL as binary before any line count, so the read tool's whole binary answer is what is compared.",
    excluded: EXCLUDED,
  },
});
commitStage(stage, finalDir);
console.log(`fs-other-cases: ${cases.length} case(s), ${markers.length} marker call(s)`);
