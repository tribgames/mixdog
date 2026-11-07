#!/usr/bin/env node
// `code_graph` refusal text over a directory tree whose ancestors the recorder controls: with a project
// sentinel above the temp boundary (the refusal names it, `root-resolution.mjs:138`) and with none anywhere
// above (it names nothing). A stray `package.json` in the host's home or drive root would leak into either, so the
// layout is mounted as its own drive (`subst`, Windows) and the tool's home and temp boundaries are redirected
// into it. Written beside the routing goldens as `ancestor-sentinel-{present,absent}.json`; the Rust replay
// (`routing_tests.rs`) builds the same layout and cuts its ancestor walk at the layout's root.
//
//   node benchmarks/rust-core/recorders/record-tools-code-graph-ancestors.mjs --tree <dir with node_modules>
//
// Layout (R: is the mounted drive):   R:\above[\package.json]   R:\above\temp (the temp boundary)
//                                     R:\above\temp\ws\multi\{alpha,beta}\package.json
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, sha256, writeJson } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const pkg = '{"name":"p"}\n';
const WORKSPACE = { 'multi/alpha/package.json': pkg, 'multi/beta/package.json': pkg };
const CASES = { 'ancestor-sentinel-present': true, 'ancestor-sentinel-absent': false };

async function runWorker(name, drive) {
  const mount = `${drive}:\\`;
  const above = join(mount, 'above');
  const temp = join(above, 'temp');
  const ws = join(temp, 'ws');
  // Redirected before any product module loads: the boundaries are the layout's, not the host's.
  process.env.TEMP = temp;
  process.env.TMP = temp;
  process.env.USERPROFILE = join(above, 'home');
  process.env.HOME = join(above, 'home');
  process.env.MIXDOG_DATA_DIR = join(above, 'data');
  process.env.MIXDOG_HOME = join(above, 'home');
  process.env.MIXDOG_PROJECTS_FILE = join(above, 'home', 'projects.json');
  process.env.MIXDOG_TOOL_FAILURE_LOG_PATH = join(above, 'failures.jsonl');
  for (const [rel, text] of Object.entries(WORKSPACE)) {
    const target = join(ws, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
  mkdirSync(join(above, 'home'), { recursive: true });
  if (CASES[name]) writeFileSync(join(above, 'package.json'), pkg);
  const cwd = join(ws, 'multi');
  process.env.MIXDOG_SESSION_CWD = cwd;
  const { executeCodeGraphTool } = await importFrom(tree, 'src/runtime/agent/orchestrator/tools/code-graph.mjs');
  const { createScopedCacheOutcome } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/cache/scoped-cache-outcome.mjs');
  const outcome = createScopedCacheOutcome();
  const scrub = (text) =>
    String(text)
      .replaceAll(ws, '<ROOT>')
      .replaceAll(ws.replace(/\\/g, '/'), '<ROOT>')
      .replaceAll(`'${above}'`, "'<ABOVE>'")
      .replace(/<ROOT>([^\s\]"',)]*)/g, (_m, rest) => `<ROOT>${rest.replace(/\\/g, '/')}`);
  const out = { tool: 'code_graph', ancestors: CASES[name] ? 'sentinel' : 'none', cwd: 'multi', input: { mode: 'imports' } };
  try {
    out.text = scrub(await executeCodeGraphTool('code_graph', out.input, cwd, null, { scopedCacheOutcome: outcome }));
    out.isError = /^Error[\s:[]/.test(out.text);
  } catch (error) {
    out.thrown = scrub(error?.message ?? error);
  }
  out.dependencyRoots = [];
  out.complete = outcome.complete;
  process.stdout.write(`\nRESULT ${JSON.stringify(out)}\n`);
}

if (args.has('worker')) {
  await runWorker(args.get('worker'), args.get('drive'));
  process.exit(0);
}

if (process.platform !== 'win32') throw new Error('the layout is mounted with `subst`: record on Windows');
const drive = [...'RSTUVWXYZ'].find((letter) => !existsSync(`${letter}:\\`));
if (!drive) throw new Error('no free drive letter');
const work = mkdtempSync(join(tmpdir(), 'mixdog-cg-ancestors-'));
const run = (cmd, argv) => {
  const done = spawnSync(cmd, argv, { encoding: 'utf8' });
  if (done.status !== 0) throw new Error(`${cmd} ${argv.join(' ')}: ${done.stdout}${done.stderr}`);
  return done;
};
const outDir = join(FIXTURES_ROOT, 'tools', 'code_graph_routing');
try {
  for (const name of Object.keys(CASES)) {
    // A fresh mount per case: nothing one case wrote is visible to the next.
    const tree1 = join(work, name);
    mkdirSync(tree1, { recursive: true });
    run('subst', [`${drive}:`, tree1]);
    try {
      const done = spawnSync(process.execPath, [process.argv[1], '--tree', tree, '--worker', name, '--drive', drive], { encoding: 'utf8' });
      const line = /\nRESULT (.*)\n/.exec(done.stdout ?? '')?.[1];
      if (!line) throw new Error(`case ${name} produced no result:\n${done.stdout}\n${done.stderr}`);
      writeJson(join(outDir, `${name}.json`), JSON.parse(line));
    } finally {
      run('subst', [`${drive}:`, '/d']);
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
// Both goldens join the set's manifest (`refreshSetManifest` would also re-stamp the product identity of every file).
const manifestPath = join(FIXTURES_ROOT, 'tools', 'MANIFEST.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
for (const name of Object.keys(CASES)) {
  const path = `code_graph_routing/${name}.json`;
  const data = readFileSync(join(outDir, `${name}.json`));
  manifest.files = manifest.files.filter((f) => f.path !== path);
  manifest.files.push({ bytes: data.length, path, sha256: sha256(data) });
}
manifest.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
manifest.fileCount = manifest.files.length;
manifest.totalBytes = manifest.files.reduce((sum, f) => sum + f.bytes, 0);
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`recorded ${Object.keys(CASES).length} ancestor goldens into ${outDir}`);
