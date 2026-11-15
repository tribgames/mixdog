// scripts/test-tsx.mjs: tsx keeps its transpile cache in a folder that outlives
// a test run, while every test still sees the run's own temp directory.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const loaderUrl = new URL('./test-tsx.mjs', import.meta.url).href;
// The cache is per installed tsx version, so an upgrade never reuses an older transpile.
const { version: tsxVersion } = createRequire(import.meta.url)('tsx/package.json');
const cacheRoot = process.env.MIXDOG_TEST_TSX_CACHE_DIR
  ? join(resolve(process.env.MIXDOG_TEST_TSX_CACHE_DIR), `tsx-${tsxVersion}`)
  : fileURLToPath(new URL(`../node_modules/.cache/mixdog-tests/tsx-${tsxVersion}`, import.meta.url));

// Records the temp variables at the moment the loader asks for tsx.
const observer = `
  import { registerHooks } from 'node:module';
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'tsx' && context.parentURL === ${JSON.stringify(loaderUrl)}) {
        globalThis.whileTsxLoads = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
      }
      return nextResolve(specifier, context);
    },
  });
`;

// Imports a TypeScript module with never-seen source, then waits for tsx's
// cache entry of it to appear, so the cache location is observed, not assumed.
const probe = (token, selectedCache = cacheRoot) => `
  import { readdirSync, readFileSync } from 'node:fs';
  import { tmpdir } from 'node:os';
  import { join, resolve } from 'node:path';
  const cacheRoot = ${JSON.stringify(selectedCache)};
  const entries = () =>
    readdirSync(cacheRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('tsx-'))
      .flatMap((entry) => readdirSync(join(cacheRoot, entry.name)).map((name) => join(cacheRoot, entry.name, name)));
  let before = new Set();
  try { before = new Set(entries()); } catch {}
  const { value } = await import('./typed.ts');
  let cached = false;
  for (const deadline = Date.now() + 10_000; !cached && Date.now() < deadline; ) {
    try {
      cached = entries().some((path) => !before.has(path) && readFileSync(path, 'utf8').includes(${JSON.stringify(token)}));
    } catch {}
    if (!cached) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  console.log(JSON.stringify({
    whileTsxLoads: globalThis.whileTsxLoads,
    after: { TEMP: process.env.TEMP, TMP: process.env.TMP, hasTMPDIR: 'TMPDIR' in process.env, TMPDIR: process.env.TMPDIR },
    tmpdir: tmpdir(),
    value,
    cached,
  }));
`;

async function runProbe(t, { withTmpdir, cacheOverride }) {
  const scratch = await mkdtemp(join(tmpdir(), 'mixdog-test-tsx-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const token = `cache-probe-${randomUUID()}`;
  await writeFile(join(scratch, 'observer.mjs'), observer);
  const selectedCache = cacheOverride ? join(resolve(cacheOverride), `tsx-${tsxVersion}`) : cacheRoot;
  await writeFile(join(scratch, 'probe.mjs'), probe(token, selectedCache));
  await writeFile(join(scratch, 'typed.ts'), `export const value: string = ${JSON.stringify(token)};\n`);
  const env = { ...process.env, TEMP: scratch, TMP: scratch, TMPDIR: scratch };
  if (cacheOverride) env.MIXDOG_TEST_TSX_CACHE_DIR = cacheOverride;
  if (!withTmpdir) delete env.TMPDIR;
  delete env.NODE_TEST_CONTEXT;
  delete env.TSX_DISABLE_CACHE;
  const result = spawnSync(
    process.execPath,
    ['--import', pathToFileURL(join(scratch, 'observer.mjs')).href, '--import', loaderUrl, join(scratch, 'probe.mjs')],
    { cwd: scratch, env, encoding: 'utf8', windowsHide: true, timeout: 60_000 }
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return { scratch, token, report: JSON.parse(result.stdout.trim().split('\n').at(-1)) };
}

test('tsx loads with its cache in the persistent folder, and tests see the run temp directory again', async (t) => {
  const { scratch, token, report } = await runProbe(t, { withTmpdir: true });
  assert.deepEqual(report.whileTsxLoads, { TEMP: cacheRoot, TMP: cacheRoot, TMPDIR: cacheRoot });
  assert.deepEqual(report.after, { TEMP: scratch, TMP: scratch, hasTMPDIR: true, TMPDIR: scratch });
  assert.equal(report.tmpdir, scratch);
  // TypeScript still runs, and its transpiled output lands in the cache folder,
  // never in the run's temp directory.
  assert.equal(report.value, token);
  assert.equal(report.cached, true);
  assert.deepEqual(
    (await readdir(scratch)).filter((name) => name.startsWith('tsx')),
    []
  );
});

test('a temp variable that was unset before tsx loaded stays unset', async (t) => {
  const { report } = await runProbe(t, { withTmpdir: false });
  assert.equal(report.whileTsxLoads.TMPDIR, cacheRoot);
  assert.equal(report.after.hasTMPDIR, false);
});


test('an explicit external cache keeps dependency junctions read-only while preserving the test temp directory', async (t) => {
  const external = await mkdtemp(join(tmpdir(), 'mixdog-tsx-external-cache-'));
  t.after(() => rm(external, { recursive: true, force: true }));
  const { scratch, report } = await runProbe(t, { withTmpdir: true, cacheOverride: external });
  const expected = join(external, `tsx-${tsxVersion}`);
  assert.deepEqual(report.whileTsxLoads, { TEMP: expected, TMP: expected, TMPDIR: expected });
  assert.equal(report.after.TEMP, scratch);
  assert.equal(report.cached, true);
  assert.ok((await readdir(external)).includes(`tsx-${tsxVersion}`));
});
