#!/usr/bin/env node
// `code_graph` routing goldens (T §8.2): federation over trusted and discovered roots, the
// symbol-mode cwd-anchor drop, and the dependency roots each call records for the tool-result
// cache. Recorded from the Node tool into native/core/fixtures/tools/code_graph_routing/.
//
//   node benchmarks/rust-core/recorders/record-tools-code-graph.mjs --tree <dir> --graph-bin <mixdog-graph exe>
//
// Every case runs in a fresh child process with its own data directory, so the registry, the
// graph disk cache (whose manifest is a trust source) and the session cwd start empty and one
// case cannot leak a trusted root into the next. A case is
//   { cwd, session?, registered?, input, text | thrown, dependencyRoots, complete }
// over the shared workspace.json. Placeholders in inputs and cwd: <ROOT> = the workspace,
// <FSROOT> = the filesystem root holding it. `registered` and `session` are workspace-relative.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, parse } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, refreshSetManifest, resolveTree, writeJson } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const graphBin = args.get('graph-bin');
if (!graphBin) throw new Error('--graph-bin <mixdog-graph executable> is required');

const pkg = '{"name":"p"}\n';
const fn = (name, ret = 1) => `export function ${name}() {\n  return ${ret};\n}\n`;
const WORKSPACE = {
  // A sentinel-free parent holding two projects (and a plain folder that is not one).
  'multi/alpha/package.json': pkg,
  'multi/alpha/src/a.mjs': `${fn('shared', 1)}\n${fn('onlyAlpha', 2)}`,
  'multi/beta/package.json': pkg,
  'multi/beta/lib/b.mjs': `${fn('shared', 2)}\n${fn('onlyBeta', 3)}`,
  'multi/plain/c.mjs': fn('plainFn'),
  // A parent with exactly one project.
  'one/solo/package.json': pkg,
  'one/solo/s.mjs': fn('soloFn'),
  // A project to run symbol modes in.
  'proj/package.json': pkg,
  'proj/src/a.mjs': fn('alpha'),
  'proj/src/b.mjs': "import { alpha } from './a.mjs';\n\nexport function beta() {\n  return alpha();\n}\n",
  // Registered roots for filesystem-root federation: outer holds inner.
  'reg/outer/package.json': pkg,
  'reg/outer/src/o.mjs': fn('outerFn'),
  'reg/outer/inner/package.json': pkg,
  'reg/outer/inner/i.mjs': fn('innerFn'),
  'reg/other/package.json': pkg,
  'reg/other/x.mjs': fn('otherFn'),
};
// Ten projects under one parent: discovery stops at the fan-out cap.
for (let n = 1; n <= 10; n += 1) {
  const id = String(n).padStart(2, '0');
  WORKSPACE[`many/p${id}/package.json`] = pkg;
  WORKSPACE[`many/p${id}/x.mjs`] = fn(`fn${id}`);
}

const REG = ['reg/outer', 'reg/outer/inner', 'reg/other'];
const FS = { cwd: '<FSROOT>', registered: REG };
const cases = {
  // ---- federation over discovered children of a sentinel-free parent ----
  'fed-parent-overview': { cwd: 'multi', input: { mode: 'overview' } },
  'fed-parent-symbol-search': { cwd: 'multi', input: { mode: 'symbol_search', symbol: 'shared' } },
  'fed-parent-find-symbol': { cwd: 'multi', input: { mode: 'find_symbol', symbol: 'onlyBeta' } },
  'fed-parent-dot-overview': { cwd: 'multi', input: { mode: 'overview', files: ['.'] } },
  'fed-parent-dot-symbols': { cwd: 'multi', input: { mode: 'symbols', files: ['.'] } },
  'fed-parent-imports-refused': { cwd: 'multi', input: { mode: 'imports' } },
  'fed-parent-file-anchor': { cwd: 'multi', input: { mode: 'overview', file: 'alpha/src/a.mjs' } },
  'fed-parent-files-two-projects': { cwd: 'multi', input: { mode: 'overview', files: ['alpha/src/a.mjs', 'beta/lib/b.mjs'] } },
  // A sentinel-free tree with no child project is indexed as itself.
  'plain-tree-overview': { cwd: 'multi/plain', input: { mode: 'overview' } },
  'plain-tree-find-symbol': { cwd: 'multi/plain', input: { mode: 'find_symbol', symbol: 'plainFn' } },
  'fed-single-child': { cwd: 'one', input: { mode: 'overview' } },
  'fed-child-cap': { cwd: 'many', input: { mode: 'overview' } },
  // ---- federation at a filesystem root over registered and selected roots ----
  'fed-root-overview': { ...FS, input: { mode: 'overview' } },
  'fed-root-find-symbol': { ...FS, input: { mode: 'find_symbol', symbol: 'innerFn' } },
  'fed-root-files': { ...FS, input: { mode: 'overview', files: ['<ROOT>/reg/outer/src/o.mjs', '<ROOT>/reg/outer/inner/i.mjs'] } },
  'fed-root-symbols-files': { ...FS, input: { mode: 'symbols', files: ['<ROOT>/reg/other/x.mjs'] } },
  'fed-root-wildcard': { ...FS, input: { mode: 'overview', files: ['<ROOT>/reg/other/*.mjs'] } },
  'fed-root-missing-file': { ...FS, input: { mode: 'overview', files: ['<ROOT>/reg/other/none.mjs'] } },
  'fed-root-untrusted-file': { ...FS, input: { mode: 'overview', files: ['<ROOT>/proj/src/a.mjs'] } },
  'fed-root-selected-only': { cwd: '<FSROOT>', session: 'reg/other/x.mjs', input: { mode: 'overview' } },
  'fed-root-selected-subfolder': { cwd: '<FSROOT>', session: 'reg/outer/inner', input: { mode: 'overview' } },
  'fed-root-nothing-trusted': { cwd: '<FSROOT>', input: { mode: 'overview' } },
  'fed-root-imports': { ...FS, input: { mode: 'imports' } },
  // ---- the symbol-mode cwd anchor drop ----
  'anchor-find-symbol-dot': { cwd: 'proj', input: { mode: 'find_symbol', symbol: 'alpha', file: '.' } },
  'anchor-find-symbol-abs-cwd': { cwd: 'proj', input: { mode: 'find_symbol', symbol: 'alpha', file: '<ROOT>/proj' } },
  'anchor-symbols-files-dot': { cwd: 'proj', input: { mode: 'symbols', files: ['.'] } },
  'anchor-symbols-files-dots': { cwd: 'proj', input: { mode: 'symbols', files: ['.', './'] } },
  'anchor-search-dot': { cwd: 'proj', input: { mode: 'search', symbol: 'alpha', file: '.' } },
  'anchor-references-dot': { cwd: 'proj', input: { mode: 'references', symbol: 'alpha', file: '.' } },
  'anchor-callers-dot': { cwd: 'proj', input: { mode: 'callers', symbol: 'alpha', file: '.' } },
  'anchor-callees-dot': { cwd: 'proj', input: { mode: 'callees', symbol: 'beta', file: '.' } },
  'anchor-subfolder-cwd': { cwd: 'proj/src', input: { mode: 'references', symbol: 'alpha', file: '.' } },
  'anchor-mixed-files-kept': { cwd: 'proj', input: { mode: 'symbol_search', symbol: 'alpha', files: ['.', 'src/a.mjs'] } },
  'anchor-overview-dot-kept': { cwd: 'proj', input: { mode: 'overview', file: '.' } },
  'anchor-imports-dot-kept': { cwd: 'proj', input: { mode: 'imports', file: '.' } },
};

async function runWorker(name) {
  const def = cases[name];
  const work = mkdtempSync(join(tmpdir(), 'mixdog-cg-route-'));
  const ws = join(work, 'ws');
  const fwd = ws.replace(/\\/g, '/');
  const fsRoot = parse(ws).root;
  process.env.MIXDOG_DATA_DIR = join(work, 'data');
  // The project registry lives under the user's home unless redirected: never register into it.
  process.env.MIXDOG_HOME = join(work, 'home');
  process.env.MIXDOG_PROJECTS_FILE = join(work, 'home', 'projects.json');
  process.env.MIXDOG_TOOL_FAILURE_LOG_PATH = join(work, 'failures.jsonl');
  process.env.MIXDOG_GRAPH_BIN = graphBin;
  for (const [rel, text] of Object.entries(WORKSPACE)) {
    const target = join(ws, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
  const fill = (value) => JSON.parse(JSON.stringify(value).replaceAll('<ROOT>', fwd).replaceAll('<FSROOT>', fsRoot.replace(/\\/g, '/')));
  const resolveCwd = (rel) => (rel === '<FSROOT>' ? fsRoot : join(ws, rel));
  const cwd = resolveCwd(def.cwd);
  const session = def.session ? join(ws, def.session) : cwd;
  // A session cwd must name a directory; a file selects its folder.
  process.env.MIXDOG_SESSION_CWD = /\.[a-z]+$/.test(session) ? dirname(session) : session;
  const { addProject } = await importFrom(tree, 'src/runtime/shared/projects.mjs');
  for (const rel of def.registered ?? []) addProject(join(ws, rel));
  const { executeCodeGraphTool } = await importFrom(tree, 'src/runtime/agent/orchestrator/tools/code-graph.mjs');
  const { createScopedCacheOutcome } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/cache/scoped-cache-outcome.mjs');
  const outcome = createScopedCacheOutcome();
  const scrub = (text) =>
    String(text)
      .replaceAll(ws, '<ROOT>')
      .replaceAll(fwd, '<ROOT>')
      .replaceAll(`'${fsRoot}'`, "'<FSROOT>'")
      .replace(/<ROOT>([^\s\]"',)]*)/g, (_m, rest) => `<ROOT>${rest.replace(/\\/g, '/')}`);
  const out = { tool: 'code_graph', cwd: def.cwd, ...(def.session ? { session: def.session } : {}), ...(def.registered ? { registered: def.registered } : {}), input: def.input };
  try {
    const text = await executeCodeGraphTool('code_graph', fill(def.input), cwd, null, { scopedCacheOutcome: outcome });
    out.text = scrub(text);
    out.isError = /^Error[\s:[]/.test(out.text);
  } catch (error) {
    out.thrown = scrub(error?.message ?? error);
  }
  out.dependencyRoots = [...new Set([...(outcome.dependencyRoots ?? [])].map((root) => (root === fsRoot ? '<FSROOT>' : scrub(root))))].sort();
  out.complete = outcome.complete;
  rmSync(work, { recursive: true, force: true });
  process.stdout.write(`\nRESULT ${JSON.stringify(out)}\n`);
}

if (args.has('worker')) {
  await runWorker(args.get('worker'));
  process.exit(0);
}

const outDir = join(FIXTURES_ROOT, 'tools', 'code_graph_routing');
rmSync(outDir, { recursive: true, force: true });
writeJson(join(outDir, 'workspace.json'), { files: WORKSPACE });
for (const name of Object.keys(cases)) {
  const run = spawnSync(process.execPath, [process.argv[1], '--tree', tree, '--graph-bin', graphBin, '--worker', name], { encoding: 'utf8' });
  const line = /\nRESULT (.*)\n/.exec(run.stdout ?? '')?.[1];
  if (!line) throw new Error(`case ${name} produced no result:\n${run.stdout}\n${run.stderr}`);
  writeJson(join(outDir, `${name}.json`), JSON.parse(line));
}
refreshSetManifest(join(FIXTURES_ROOT, 'tools'), tree);
console.log(`recorded ${Object.keys(cases).length} code_graph routing goldens into ${outDir}`);
