import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, parse } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { findCachedGraphBinary } from '../src/runtime/agent/orchestrator/tools/graph-binary-fetcher.mjs';

const home = await mkdtemp(join(tmpdir(), 'mixdog-federation-home-'));
const data = join(home, 'data');
const ambientGraphBin = findCachedGraphBinary(join(process.env.MIXDOG_HOME || join(homedir(), '.mixdog'), 'data'));
process.env.MIXDOG_HOME = home;
process.env.MIXDOG_DATA_DIR = data;
delete process.env.MIXDOG_SESSION_CWD;
if (!process.env.MIXDOG_GRAPH_BIN && ambientGraphBin) process.env.MIXDOG_GRAPH_BIN = ambientGraphBin;

const {
  _isFilesystemRootPath,
  collectTrustedCodeGraphRoots,
} = await import('../src/runtime/agent/orchestrator/tools/code-graph/trusted-roots.mjs');
const {
  _codeGraphInflightKey,
  _runGraphFilesChunked,
  _scopeCodeGraphManifest,
} = await import('../src/runtime/agent/orchestrator/tools/code-graph/build.mjs');

test.after(() => rm(home, { recursive: true, force: true }));

test('filesystem-root semantics recognize Unix and Windows roots only', () => {
  assert.equal(_isFilesystemRootPath('/'), true);
  assert.equal(_isFilesystemRootPath('C:\\'), true);
  assert.equal(_isFilesystemRootPath('d:/'), true);
  assert.equal(_isFilesystemRootPath('C:'), false);
  assert.equal(_isFilesystemRootPath('/tmp'), false);
  assert.equal(_isFilesystemRootPath('C:\\repo'), false);
});

test('trusted sources are unioned, normalized, deduped, and filtered', async () => {
  const project = await mkdtemp(join(tmpdir(), 'mixdog-trusted-project-'));
  const nested = join(project, 'nested');
  await mkdir(nested);
  await writeFile(join(nested, 'package.json'), '{}');
  const missing = join(project, 'missing');
  try {
    const roots = collectTrustedCodeGraphRoots(parse(project).root, {
      registered: () => [project, `${project}/`],
      selected: () => [nested, parse(project).root],
      cached: () => [project, missing],
    });
    assert.deepEqual(new Set(roots), new Set([project, nested]));
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('nested project exclusion precedes cap selection and scoped truncation metadata', () => {
  const parent = join(parse(process.cwd()).root, 'parent-scope');
  const child = join(parent, 'child');
  const manifest = [
    { rel: 'child/a.mjs', fp: 'a' },
    { rel: 'child/b.mjs', fp: 'b' },
    { rel: 'child/c.mjs', fp: 'c' },
    { rel: 'parent-one.mjs', fp: '1' },
    { rel: 'parent-two.mjs', fp: '2' },
  ];
  const scoped = _scopeCodeGraphManifest(manifest, parent, {
    excludedProjectRoots: [child],
    maxFiles: 2,
  });
  assert.deepEqual(scoped.indexed.map((row) => row.rel), ['parent-one.mjs', 'parent-two.mjs']);
  assert.equal(scoped.manifest.length, 2);
  assert.equal(scoped.truncated, false);

  const truncated = _scopeCodeGraphManifest(
    [...manifest, { rel: 'parent-three.mjs', fp: '3' }],
    parent,
    { excludedProjectRoots: [child], maxFiles: 2 },
  );
  assert.equal(truncated.manifest.length, 3);
  assert.equal(truncated.indexed.length, 2);
  assert.equal(truncated.truncated, true);
});

test('nested Windows project exclusion is case-insensitive and containment-aware', () => {
  const scoped = _scopeCodeGraphManifest([
    { rel: 'Child/inside.mjs', fp: 'inside' },
    { rel: 'childish/outside.mjs', fp: 'outside' },
    { rel: 'parent.mjs', fp: 'parent' },
  ], 'C:\\Repo', {
    excludedProjectRoots: ['c:\\repo\\CHILD'],
  });
  assert.deepEqual(scoped.manifest.map((row) => row.rel), [
    'childish/outside.mjs',
    'parent.mjs',
  ]);
  assert.deepEqual(scoped.prefixes, ['child']);
});

test('scoped in-flight keys cannot collide through delimiters', () => {
  const onePrefix = _codeGraphInflightKey('/repo', {
    scoped: true,
    maxFiles: 100,
    prefixes: ['child|vendor'],
  });
  const twoPrefixes = _codeGraphInflightKey('/repo', {
    scoped: true,
    maxFiles: 100,
    prefixes: ['child', 'vendor'],
  });
  assert.notEqual(onePrefix, twoPrefixes);
  assert.notEqual(onePrefix, _codeGraphInflightKey('/repo'));
});

test('scoped --files builds use bounded chunks and merge relationship records', async () => {
  const rels = Array.from({ length: 10_000 }, (_, index) => `src/file-${index}.mjs`);
  const calls = [];
  const records = await _runGraphFilesChunked('/repo', rels, [{ rel: 'reused.mjs' }], {
    maxArgChars: 1_024,
    runGraphFiles: async (_root, rels) => {
      calls.push(rels);
      return [
        ...rels.map((rel) => ({ rel, fp: rel, resolvedImports: ['reused.mjs'] })),
        { rel: 'reused.mjs', importedBy: [rels[0]] },
      ];
    },
  });
  assert.ok(calls.length > 1);
  for (const rels of calls) {
    assert.ok(rels.reduce((sum, rel) => sum + rel.length + 3, 0) <= 1_024);
  }
  assert.equal(records.filter((row) => row.rel !== 'reused.mjs').length, 10_000);
  assert.deepEqual(new Set(records.map((row) => row.rel)), new Set([...rels, 'reused.mjs']));
  assert.deepEqual(
    new Set(records.find((row) => row.rel === 'reused.mjs').importedBy),
    new Set(calls.map((rels) => rels[0])),
  );
});

test('default trusted sources include actual registration, selected nested project, and cache manifest', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'mixdog-source-parent-'));
  const child = join(parent, 'child');
  const cached = await mkdtemp(join(tmpdir(), 'mixdog-source-cache-'));
  await mkdir(child);
  await writeFile(join(parent, 'package.json'), '{}');
  await writeFile(join(child, 'package.json'), '{}');
  await mkdir(join(data, 'code-graph-cache'), { recursive: true });
  await writeFile(join(home, 'projects.json'), JSON.stringify({
    projects: [{ name: 'parent', path: parent, addedAt: 1 }],
  }));
  await writeFile(join(data, 'code-graph-cache', 'manifest.json'), JSON.stringify({
    [cached]: { hash: '12345678', builtAt: 1 },
  }));
  process.env.MIXDOG_SESSION_CWD = child;
  try {
    const roots = collectTrustedCodeGraphRoots(parse(parent).root);
    assert.deepEqual(new Set(roots), new Set([parent, child, cached]));
  } finally {
    delete process.env.MIXDOG_SESSION_CWD;
    await Promise.all([
      rm(parent, { recursive: true, force: true }),
      rm(cached, { recursive: true, force: true }),
    ]);
  }
});

test('root federation labels repositories, includes registered non-Git projects, and isolates failures', async () => {
  const good = await mkdtemp(join(tmpdir(), 'mixdog-federated-good-'));
  const bad = await mkdtemp(join(tmpdir(), 'mixdog-federated-bad-'));
  await mkdir(join(good, 'src'));
  await writeFile(join(good, 'package.json'), '{}');
  await writeFile(join(good, 'src', 'good.mjs'), 'export function federatedNeedle() { return 1; }\n');
  await writeFile(join(home, 'projects.json'), JSON.stringify({
    projects: [
      { name: 'good', path: good, addedAt: 2 },
      { name: 'bad', path: bad, addedAt: 1 },
    ],
  }));
  await writeFile(join(bad, 'package.json'), '{}');
  const { executeCodeGraphTool } = await import('../src/runtime/agent/orchestrator/tools/code-graph/dispatch.mjs');
  const result = await executeCodeGraphTool(
    'code_graph',
    { mode: 'symbol_search', symbol: 'federatedNeedle' },
    parse(good).root,
  );
  assert.match(result, new RegExp(`# project .+ \\[${good.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`));
  assert.match(result, /federatedNeedle/);
  assert.match(result, new RegExp(`# project .+ \\[${bad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`));
  assert.match(result, /contains zero eligible files/);

  await Promise.all([
    rm(good, { recursive: true, force: true }),
    rm(bad, { recursive: true, force: true }),
  ]);
});

test('broad cwd files dot federates registered child projects', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'mixdog-federated-parent-'));
  const first = join(parent, 'first');
  const second = join(parent, 'second');
  await Promise.all([mkdir(first), mkdir(second)]);
  await writeFile(join(first, 'package.json'), '{}');
  await writeFile(join(second, 'package.json'), '{}');
  await writeFile(join(first, 'first.mjs'), 'export function parentFederationNeedle() { return 1; }\n');
  await writeFile(join(second, 'second.mjs'), 'export const secondProject = true;\n');
  await writeFile(join(home, 'projects.json'), JSON.stringify({
    projects: [
      { name: 'first', path: first, addedAt: 2 },
      { name: 'second', path: second, addedAt: 1 },
    ],
  }));
  const { executeCodeGraphTool } = await import('../src/runtime/agent/orchestrator/tools/code-graph/dispatch.mjs');
  const result = await executeCodeGraphTool('code_graph', {
    mode: 'symbol_search',
    files: ['.'],
    symbols: ['parentFederationNeedle'],
  }, parse(parent).root);
  assert.match(result, new RegExp(`# project .+ \\[${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`));
  assert.match(result, /parentFederationNeedle/);
  assert.match(result, new RegExp(`# project .+ \\[${second.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`));
  await rm(parent, { recursive: true, force: true });
});

test('trusted file and relationship anchors route to owners; missing and untrusted anchors stop at root', async () => {
  const project = await mkdtemp(join(tmpdir(), 'mixdog-file-route-'));
  const untrusted = await mkdtemp(join(tmpdir(), 'mixdog-untrusted-route-'));
  await writeFile(join(project, 'package.json'), '{}');
  await writeFile(join(project, 'one.mjs'), 'export function routedNeedle() { return 1; }\n');
  await writeFile(join(project, 'two.mjs'), "import { routedNeedle } from './one.mjs';\nexport const routedUse = routedNeedle();\n");
  await writeFile(join(untrusted, 'package.json'), '{}');
  await writeFile(join(untrusted, 'hidden.mjs'), 'export const hidden = 1;\n');
  await writeFile(join(home, 'projects.json'), JSON.stringify({
    projects: [{ name: 'route', path: project, addedAt: 1 }],
  }));
  const { executeCodeGraphTool } = await import('../src/runtime/agent/orchestrator/tools/code-graph/dispatch.mjs');
  const root = parse(project).root;
  const overview = await executeCodeGraphTool('code_graph', { mode: 'overview' }, root);
  assert.match(overview, /# project .+\[/);
  assert.match(overview, /files\t2/);
  const imports = await executeCodeGraphTool('code_graph', { mode: 'imports', file: join(project, 'two.mjs') }, root);
  assert.match(imports, /# project .+\[/);
  assert.match(imports, /one\.mjs/);
  const dependents = await executeCodeGraphTool('code_graph', {
    mode: 'dependents',
    file: join(project, 'one.mjs'),
  }, root);
  assert.match(dependents, /# project .+\[/);
  assert.match(dependents, /two\.mjs/);
  const missing = await executeCodeGraphTool('code_graph', {
    mode: 'overview',
    file: join(project, 'definitely-missing.mjs'),
  }, root);
  assert.match(missing, /^Error: code_graph: file not found:/);
  assert.doesNotMatch(missing, /Same filename exists/);
  const rejected = await executeCodeGraphTool('code_graph', {
    mode: 'overview',
    file: join(untrusted, 'hidden.mjs'),
  }, root);
  assert.match(rejected, /^Error: code_graph: file anchor is not owned by a trusted project:/);
  await Promise.all([
    rm(project, { recursive: true, force: true }),
    rm(untrusted, { recursive: true, force: true }),
  ]);
});

test('overlapping trusted roots keep nested symbols and edges out of the parent graph', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'mixdog-overlap-parent-'));
  const child = join(parent, 'child');
  await mkdir(child);
  await writeFile(join(parent, 'package.json'), '{}');
  await writeFile(join(parent, 'parent.mjs'), "import { childNeedle } from './child/child.mjs';\nexport const parentUse = childNeedle();\n");
  await writeFile(join(child, 'package.json'), '{}');
  await writeFile(join(child, 'child.mjs'), 'export function childNeedle() { return 1; }\n');
  await writeFile(join(home, 'projects.json'), JSON.stringify({
    projects: [
      { name: 'parent', path: parent, addedAt: 2 },
      { name: 'child', path: child, addedAt: 1 },
    ],
  }));
  const { executeCodeGraphTool } = await import('../src/runtime/agent/orchestrator/tools/code-graph/dispatch.mjs');
  const result = await executeCodeGraphTool('code_graph', {
    mode: 'symbol_search',
    symbol: 'childNeedle',
  }, parse(parent).root);
  const parentLabel = `# project ${parent.split(/[\\/]/).pop().toLowerCase()} [${parent.toLowerCase()}]`;
  const childLabel = `# project ${child.split(/[\\/]/).pop().toLowerCase()} [${child.toLowerCase()}]`;
  const normalized = result.toLowerCase();
  const parentSection = normalized.slice(
    normalized.indexOf(parentLabel),
    normalized.indexOf(childLabel) > normalized.indexOf(parentLabel)
      ? normalized.indexOf(childLabel)
      : normalized.length,
  );
  assert.doesNotMatch(parentSection, /child\/child\.mjs|childneedle\s+\(/);
  assert.match(normalized.slice(normalized.indexOf(childLabel)), /childneedle/);
  const imports = await executeCodeGraphTool('code_graph', {
    mode: 'imports',
    file: join(parent, 'parent.mjs'),
  }, parse(parent).root);
  assert.doesNotMatch(imports.split('# raw')[0], /child\/child\.mjs/);
  await rm(parent, { recursive: true, force: true });
});
