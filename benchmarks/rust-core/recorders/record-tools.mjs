#!/usr/bin/env node
// Tool golden outputs (T §8.2): the real Node tools run over a deterministic
// fixture workspace; each case stores its args and the normalized envelope
// text. Paths are rewritten to <ROOT>; file mtimes are pinned.
//
//   node benchmarks/rust-core/recorders/record-tools.mjs --tree <dir> \
//        [--native-root <dir containing mixdog-{spawn,patch,graph}/target/release>]
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const work = mkdtempSync(join(tmpdir(), 'mixdog-tool-golden-'));
process.env.MIXDOG_DATA_DIR = join(work, 'data');
process.env.MIXDOG_TOOL_FAILURE_LOG_PATH = join(work, 'failures.jsonl');
process.env.MIXDOG_PATCH_REPLAY_CAPTURE = '0';
const nativeRoot = args.get('native-root') ?? join(tree, 'native');
const exe = process.platform === 'win32' ? '.exe' : '';
const bin = (crate) => join(nativeRoot, crate, 'target', 'release', crate + exe);
const natives = { spawn: bin('mixdog-spawn'), patch: bin('mixdog-patch'), graph: bin('mixdog-graph') };
const missing = Object.entries(natives).filter(([, p]) => !existsSync(p)).map(([k]) => k);
if (existsSync(natives.graph)) process.env.MIXDOG_GRAPH_BIN = natives.graph;
if (existsSync(natives.patch)) process.env.MIXDOG_PATCH_NATIVE_BIN = natives.patch;
if (existsSync(natives.spawn)) {
  const { _setNativeSpawnBinaryForTest } = await importFrom(tree, 'src/runtime/agent/orchestrator/tools/lib/native-spawn-client.mjs');
  _setNativeSpawnBinaryForTest(natives.spawn);
}

const ws = join(work, 'ws');
const files = {
  'README.md': '# Fixture\n\nalpha beta\ngamma\n',
  'src/main.mjs': "import { add } from './lib/math.mjs';\n\nexport function main() {\n  return add(1, 2);\n}\n",
  'src/lib/math.mjs': 'export function add(a, b) {\n  return a + b;\n}\n\nexport function sub(a, b) {\n  return a - b;\n}\n',
  'src/lib/notes.txt': 'TODO: first\nplain\nTODO: second\n',
  'docs/guide.md': '# Guide\n\n- item one\n- item two\n',
  '.hidden': 'secret-free\n',
  'data/bin.dat': Buffer.from([0x41, 0x00, 0x42, 0x43]),
  'lines.txt': Array.from({ length: 120 }, (_, i) => `line-${i + 1}`).join('\n') + '\n',
};
const FIXED = new Date('2026-01-02T03:04:05Z');
for (const [rel, data] of Object.entries(files)) {
  const p = join(ws, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, data);
  utimesSync(p, FIXED, FIXED);
}

// Directory mtimes appear in `list meta`; pin them too (deepest first).
for (const dir of ['src/lib', 'src', 'docs', 'data', '.']) utimesSync(join(ws, dir), FIXED, FIXED);

const { executeBuiltinTool } = await importFrom(tree, 'src/runtime/agent/orchestrator/tools/builtin.mjs');
const { executePatchTool } = await importFrom(tree, 'src/runtime/agent/orchestrator/tools/patch.mjs');
const { normalizeToolEnvelope } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/tool-envelope.mjs');

const fwd = ws.replace(/\\/g, '/');
const scrub = (text) => String(text).replaceAll(ws, '<ROOT>').replaceAll(fwd, '<ROOT>');

const cases = [
  ['read', 'read-file', 'builtin', 'read', { path: 'src/lib/math.mjs' }],
  ['read', 'read-range', 'builtin', 'read', { path: 'lines.txt', offset: 10, limit: 5 }],
  ['read', 'read-binary', 'builtin', 'read', { path: 'data/bin.dat' }],
  ['read', 'read-missing', 'builtin', 'read', { path: 'nope.txt' }],
  ['list', 'list-root', 'builtin', 'list', { path: '.' }],
  ['list', 'list-hidden', 'builtin', 'list', { path: '.', hidden: true }],
  ['list', 'list-meta', 'builtin', 'list', { path: 'src', meta: true, head_limit: 0 }],
  ['list', 'list-paged', 'builtin', 'list', { path: '.', head_limit: 2, offset: 1 }],
  ['glob', 'glob-mjs', 'builtin', 'glob', { pattern: '**/*.mjs' }],
  ['find', 'find-math', 'builtin', 'find', { query: 'math' }],
  ['grep', 'grep-files', 'builtin', 'grep', { pattern: 'TODO', output_mode: 'files_with_matches' }],
  ['grep', 'grep-content-context', 'builtin', 'grep', { pattern: 'TODO', output_mode: 'content', context: 1 }],
  ['grep', 'grep-count', 'builtin', 'grep', { pattern: 'function', output_mode: 'count' }],
  ['edit', 'edit-replace', 'builtin', 'edit', { path: 'README.md', old_string: 'alpha beta', new_string: 'ALPHA BETA' }],
  ['edit', 'edit-no-match', 'builtin', 'edit', { path: 'README.md', old_string: 'does not exist', new_string: 'x' }],
  ['apply_patch', 'patch-update', 'patch', 'apply_patch', {
    base_path: ws,
    patch: '*** Begin Patch\n*** Update File: src/lib/notes.txt\n@@\n-plain\n+PLAIN\n*** End Patch\n',
  }],
  ['apply_patch', 'patch-stale-dry-run', 'patch', 'apply_patch', {
    base_path: ws,
    dry_run: true,
    fuzzy: false,
    patch: '*** Begin Patch\n*** Update File: src/lib/notes.txt\n@@\n-absent line\n+x\n*** End Patch\n',
  }],
  ['shell', 'shell-echo', 'builtin', 'shell', { command: 'echo golden-out' }],
  ['code_graph', 'graph-symbols', 'graph', 'code_graph', { mode: 'symbols', file: 'src/lib/math.mjs' }],
];

const outDir = join(FIXTURES_ROOT, 'tools');
rmSync(outDir, { recursive: true, force: true });
const recorded = [];
for (const [tool, name, kind, toolName, input] of cases) {
  let outcome;
  try {
    let raw;
    if (kind === 'patch') raw = await executePatchTool(toolName, input, ws);
    else if (kind === 'graph') raw = await (await importFrom(tree, 'src/runtime/agent/orchestrator/tools/code-graph.mjs')).executeCodeGraphTool(toolName, input, ws);
    else raw = await executeBuiltinTool(toolName, input, ws);
    const env = normalizeToolEnvelope(raw);
    outcome = { text: scrub(env.result ?? ''), isError: env.isError === true || /^Error[\s:[]/.test(String(env.result ?? '')) };
  } catch (e) {
    outcome = { thrown: scrub(String(e?.message ?? e)) };
  }
  writeJson(join(outDir, tool, `${name}.json`), { tool: toolName, input: { ...input, ...(input.base_path ? { base_path: '<ROOT>' } : {}) }, ...outcome });
  recorded.push(`${tool}/${name}`);
}

// Text-only goldens that already exist in the product, copied by value.
const { cpSync } = await import('node:fs');
for (const rel of ['src/runtime/shared/tool-card-model.golden.json', 'src/runtime/agent/orchestrator/tools/code-graph/text-mask.golden.json']) {
  cpSync(join(tree, rel), join(outDir, 'existing', rel.split('/').pop()));
}

writeSetManifest(outDir, {
  set: 'tools',
  recorder: 'benchmarks/rust-core/recorders/record-tools.mjs',
  command: 'node benchmarks/rust-core/recorders/record-tools.mjs --tree <tree> --native-root <dir with native/*/target/release>',
  extra: { cases: recorded, workspaceFiles: Object.keys(files), missingNativeBinaries: missing },
});
rmSync(work, { recursive: true, force: true });
console.log(`recorded ${recorded.length} cases; missing natives: ${missing.join(',') || 'none'}`);
