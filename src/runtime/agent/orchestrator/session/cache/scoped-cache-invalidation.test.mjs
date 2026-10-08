import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { executeCodeGraphTool } from '../../tools/code-graph/dispatch.mjs';
import { planFederation, runFederation } from '../../tools/code-graph/dispatch/federation.mjs';
import { createScopedCacheOutcome } from './scoped-cache-outcome.mjs';
import { join, resolve } from 'node:path';
import { invalidateBuiltinResultCache } from '../../tools/builtin/cache-layers.mjs';
import {
  clearScopedToolsForSessionPaths,
  scopedCacheGeneration,
  setScopedToolCached,
  tryScopedToolCached,
} from './scoped-cache.mjs';

const root = resolve('virtual-scoped-invalidation');
const req = (sessionId, path, pattern = 'needle') => ({
  sessionId,
  toolName: 'grep',
  cwd: root,
  args: { path, pattern },
});
const put = (spec, content = 'v') => setScopedToolCached({ ...spec, content });
const hit = (spec) => tryScopedToolCached(spec)?.content ?? null;

test.afterEach(() => invalidateBuiltinResultCache());

test('many sessions with duplicate path aliases evict only covering roots', () => {
  const ids = Array.from({ length: 40 }, (_, i) => `s${i}`);
  for (const id of ids) {
    put(req(id, 'src'));
    put(req(id, 'docs'));
  }
  const file = resolve(root, 'src/a.ts');
  invalidateBuiltinResultCache([file, file, resolve(root, 'src/../src/a.ts'), `${root}/src/a.ts`]);
  for (const id of ids) {
    assert.equal(hit(req(id, 'src')), null);
    assert.equal(hit(req(id, 'docs')), 'v');
  }
});

test('sibling with shared prefix is retained; ancestor and descendant boundaries hold', () => {
  const src = req('b', 'src');
  const srcExtra = req('b', 'src-extra');
  const deep = req('b', 'src/deep/inner');
  for (const s of [src, srcExtra, deep]) put(s);
  invalidateBuiltinResultCache([resolve(root, 'src/deep')]);
  assert.equal(hit(src), null);
  assert.equal(hit(deep), null);
  assert.equal(hit(srcExtra), 'v');
});

test('root invalidation evicts everything beneath; rename invalidates both paths', () => {
  const a = req('c', 'old');
  const b = req('c', 'new');
  const c = req('c', 'keep');
  for (const s of [a, b, c]) put(s);
  invalidateBuiltinResultCache([resolve(root, 'old/x.ts'), resolve(root, 'new/x.ts')]);
  assert.equal(hit(a), null);
  assert.equal(hit(b), null);
  assert.equal(hit(c), 'v');
  invalidateBuiltinResultCache([root]);
  assert.equal(hit(c), null);
});

test('repeated invalidation drops results inserted between events', () => {
  const spec = req('d', 'src');
  const other = req('d', 'other');
  put(other);
  for (let i = 0; i < 3; i++) {
    put(spec, `r${i}`);
    assert.equal(hit(spec), `r${i}`);
    invalidateBuiltinResultCache([resolve(root, 'src/f.ts')]);
    assert.equal(hit(spec), null);
  }
  assert.equal(hit(other), 'v');
});

test('targeted clear API is per-session and advances generation synchronously', () => {
  const a = req('e1', 'src');
  const b = req('e2', 'src');
  put(a);
  put(b);
  const before = scopedCacheGeneration();
  clearScopedToolsForSessionPaths('e1', ['src/x.ts'], root);
  assert.ok(scopedCacheGeneration() > before);
  assert.equal(hit(a), null);
  assert.equal(hit(b), 'v');
});

test('unresolvable paths fall back to a full clear', () => {
  const a = req('f', 'src');
  const b = req('f', 'docs');
  put(a);
  put(b);
  clearScopedToolsForSessionPaths('f', ['', 42], root);
  assert.equal(hit(a), null);
  assert.equal(hit(b), null);
});

test('replacement and LRU eviction keep later invalidation correct', () => {
  const spec = req('g', 'src');
  put(spec, 'one');
  put(spec, 'two');
  assert.equal(hit(spec), 'two');
  invalidateBuiltinResultCache([resolve(root, 'src/a.ts')]);
  assert.equal(hit(spec), null);
  // LRU overflow must not break later insertions or invalidations.
  for (let i = 0; i < 120; i++) put(req('g', `dir${i}`, `p${i}`));
  assert.equal(hit(req('g', 'dir0', 'p0')), null);
  assert.equal(hit(req('g', 'dir119', 'p119')), 'v');
  invalidateBuiltinResultCache([resolve(root, 'dir119/x')]);
  assert.equal(hit(req('g', 'dir119', 'p119')), null);
  assert.equal(hit(req('g', 'dir118', 'p118')), 'v');
  put(spec, 'fresh');
  assert.equal(hit(spec), 'fresh');
});

test('stale completion started before invalidation is rejected', () => {
  const spec = req('h', 'src');
  const generation = scopedCacheGeneration();
  invalidateBuiltinResultCache([resolve(root, 'src/a.ts')]);
  setScopedToolCached({ ...spec, content: 'stale', generation });
  assert.equal(hit(spec), null);
  setScopedToolCached({ ...spec, content: 'fresh', generation: scopedCacheGeneration() });
  assert.equal(hit(spec), 'fresh');
});

// Runs the real dispatcher with a scoped-cache outcome and caches the way
// finalize.writeCaches does: result plus the outcome's recorded dependencies.
async function runGraph(sessionId, args, cwd) {
  const outcome = createScopedCacheOutcome();
  const content = await executeCodeGraphTool('code_graph', args, cwd, null, { scopedCacheOutcome: outcome });
  const spec = { sessionId, toolName: 'code_graph', cwd, args };
  setScopedToolCached({
    ...spec,
    content,
    complete: outcome.complete,
    cacheSafe: outcome.cacheSafe,
    dependencyRoots: outcome.dependencyRoots,
  });
  return spec;
}

function makeProjects(prefix, names) {
  const base = mkdtempSync(join(tmpdir(), prefix));
  const dirs = names.map((name) => {
    mkdirSync(join(base, name, 'src'), { recursive: true });
    writeFileSync(join(base, name, 'package.json'), '{"name":"' + name + '"}');
    writeFileSync(join(base, name, 'src', 'target.mjs'), 'export function target() { return 1; }\n');
    return join(base, name);
  });
  return { base, dirs };
}

const touch = (id, project, cwd) => clearScopedToolsForSessionPaths(id, [join(project, 'src', 'target.mjs')], cwd);

test('dispatcher records explicit cwd; edits there evict, other projects do not', async () => {
  const { base, dirs } = makeProjects('scoped-cg-', ['cur', 'other', 'third']);
  const [cur, other, third] = dirs;
  try {
    const explicit = await runGraph('cg1', { mode: 'symbol_search', symbols: 'target', cwd: other }, cur);
    const local = await runGraph('cg1', { mode: 'symbol_search', symbols: 'target' }, cur);
    assert.ok(hit(explicit) && hit(local), 'dispatcher results are cached with recorded dependencies');
    touch('cg1', third, cur);
    assert.ok(hit(explicit) && hit(local), 'unrelated project leaves both entries');
    touch('cg1', other, cur);
    assert.equal(hit(explicit), null);
    assert.ok(hit(local));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('dispatcher records an external file anchor root', async () => {
  const { base, dirs } = makeProjects('scoped-cga-', ['cur', 'ext', 'third']);
  const [cur, ext, third] = dirs;
  try {
    const anchored = await runGraph('cg2', { mode: 'symbols', file: join(ext, 'src', 'target.mjs') }, cur);
    assert.ok(hit(anchored));
    touch('cg2', third, cur);
    assert.ok(hit(anchored));
    touch('cg2', ext, cur);
    assert.equal(hit(anchored), null);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('dispatcher federates an implicit parent cwd and records parent scope plus child roots', async () => {
  const { base, dirs } = makeProjects('scoped-cgf-', ['a', 'b', 'c']);
  const parent = join(base, 'fed');
  mkdirSync(parent);
  const [a, b, c] = dirs;
  renameSync(a, join(parent, 'a'));
  renameSync(b, join(parent, 'b'));
  try {
    const args = { mode: 'symbol_search', symbols: 'target' };
    const outcome = createScopedCacheOutcome();
    const content = await executeCodeGraphTool('code_graph', args, parent, null, { scopedCacheOutcome: outcome });
    assert.match(content, /# project .*\ba\b/);
    assert.match(content, /# project .*\bb\b/);
    const recorded = [...outcome.dependencyRoots];
    for (const expected of [parent, join(parent, 'a'), join(parent, 'b')]) {
      assert.ok(recorded.includes(expected), `recorded ${expected}`);
    }
    assert.ok(!recorded.includes(c), 'sibling outside the federation is not recorded');
    const fed = await runGraph('cg3', args, parent);
    assert.ok(hit(fed));
    touch('cg3', c, parent);
    assert.ok(hit(fed), 'project outside the federation scope leaves the entry');
    touch('cg3', join(parent, 'b'), parent);
    assert.equal(hit(fed), null, 'a child execution root evicts the federated entry');
    const again = await runGraph('cg3', args, parent);
    clearScopedToolsForSessionPaths('cg3', [join(parent, 'newchild', 'x.mjs')], parent);
    assert.equal(hit(again), null, 'the parent scope covers new federation members');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('an absolute external anchor does not depend on the unrelated session project', async () => {
  const { base, dirs } = makeProjects('scoped-cgn-', ['cur', 'ext']);
  const [cur, ext] = dirs;
  try {
    const anchored = await runGraph('cg5', { mode: 'symbols', file: join(ext, 'src', 'target.mjs') }, cur);
    const refs = await runGraph('cg5', { mode: 'references', symbol: 'target', file: join(ext, 'src', 'target.mjs') }, cur);
    assert.ok(hit(anchored) && hit(refs));
    touch('cg5', cur, cur);
    assert.ok(hit(anchored), 'session-project edit keeps the external-anchor entry');
    assert.ok(hit(refs), 'session-project edit keeps the external-anchor relation entry');
    writeFileSync(join(ext, 'src', 'other.mjs'), 'export const z = 1;\n');
    clearScopedToolsForSessionPaths('cg5', [join(ext, 'src', 'other.mjs')], cur);
    assert.equal(hit(anchored), null, 'the real graph root still invalidates graph-wide queries');
    assert.equal(hit(refs), null);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a failed fanout child marks the outcome incomplete so the result is not cached', async () => {
  const { base, dirs } = makeProjects('scoped-cgx-', ['cur']);
  const [cur] = dirs;
  try {
    const good = join(cur, 'src', 'target.mjs');
    const args = { mode: 'symbols', files: [good, join(cur, 'src', 'missing.mjs')] };
    const outcome = createScopedCacheOutcome();
    const content = await executeCodeGraphTool('code_graph', args, cur, null, { scopedCacheOutcome: outcome });
    assert.match(content, /target/);
    assert.match(content, /Error/);
    assert.equal(outcome.complete, false);
    const spec = await runGraph('cg6', args, cur);
    assert.equal(hit(spec), null);
    const ok = await runGraph('cg6', { mode: 'symbols', files: [good] }, cur);
    assert.ok(hit(ok), 'a fully successful call is still cached');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

for (const [label, failure] of [
  ['thrown', () => Promise.reject(new Error('boom'))],
  ['error-valued', () => Promise.resolve('Error: child failed')],
]) {
  test(`federation child ${label} failure marks project and anchor federation incomplete`, async () => {
    const { base, dirs } = makeProjects('scoped-cgy-', ['a', 'b']);
    const parent = join(base, 'fed');
    mkdirSync(parent);
    renameSync(dirs[0], join(parent, 'a'));
    renameSync(dirs[1], join(parent, 'b'));
    try {
      const failRoot = join(parent, 'b');
      const execute = (name, args, childRoot) =>
        childRoot === failRoot ? failure() : Promise.resolve(`ok ${childRoot}`);
      for (const args of [
        { mode: 'symbol_search', symbols: 'target' },
        { mode: 'symbols', files: [join(parent, 'a', 'src', 'target.mjs'), join(failRoot, 'src', 'target.mjs')] },
      ]) {
        const plan = planFederation(args, parent, { baseProjectRoot: null, fileArg: '', hasAggregateFileArgs: false });
        assert.ok(plan.active);
        const outcome = createScopedCacheOutcome();
        const body = await runFederation('code_graph', args, plan, parent, null, { scopedCacheOutcome: outcome }, execute);
        assert.match(body, /ok /, 'successful children stay visible');
        assert.equal(outcome.complete, false, JSON.stringify(args));
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
}
test('a real empty federation child leaves successful sections visible but cannot populate the cache', async () => {
  const { base, dirs: [good, empty] } = makeProjects('scoped-cge-', ['good', 'empty']);
  try {
    rmSync(join(empty, 'src', 'target.mjs'));
    const args = { mode: 'symbol_search', symbols: 'target' };
    const outcome = createScopedCacheOutcome();
    const content = await executeCodeGraphTool('code_graph', args, base, null, { scopedCacheOutcome: outcome });
    assert.match(content, /^# project /m, 'the actual dispatcher must enter federation');
    assert.match(content, /Error:/, 'the empty project fails through the real graph builder');
    assert.match(content, /function target/);
    assert.equal(outcome.complete, false);
    assert.ok(outcome.dependencyRoots.has(good));
    assert.ok(outcome.dependencyRoots.has(empty));
    const spec = { sessionId: 'cg-real-partial', toolName: 'code_graph', cwd: base, args };
    setScopedToolCached({ ...spec, content, ...outcome });
    assert.equal(hit(spec), null);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('code_graph results without recorded dependency evidence are not cached', () => {
  const spec = { sessionId: 'cg4', toolName: 'code_graph', cwd: root, args: { mode: 'symbol_search', symbols: 'x' } };
  put(spec);
  assert.equal(hit(spec), null);
  put({ ...spec, dependencyRoots: [] });
  assert.equal(hit(spec), null);
});