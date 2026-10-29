// scripts/test-tsx.mjs: tsx keeps its transpile cache in a folder that outlives
// a test run, while every test still sees the run's own temp directory.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const loaderUrl = new URL('./test-tsx.mjs', import.meta.url).href;
// The cache is per installed tsx version, so an upgrade never reuses an older transpile.
const { version: tsxVersion } = createRequire(import.meta.url)('tsx/package.json');
const cacheRoot = fileURLToPath(new URL(`../node_modules/.cache/mixdog-tests/tsx-${tsxVersion}`, import.meta.url));

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
const probe = (token) => `
  import { readdirSync, readFileSync } from 'node:fs';
  import { tmpdir } from 'node:os';
  import { join } from 'node:path';
  const cacheRoot = ${JSON.stringify(cacheRoot)};
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

async function runProbe(t, { withTmpdir }) {
  const scratch = await mkdtemp(join(tmpdir(), 'mixdog-test-tsx-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const token = `cache-probe-${randomUUID()}`;
  await writeFile(join(scratch, 'observer.mjs'), observer);
  await writeFile(join(scratch, 'probe.mjs'), probe(token));
  await writeFile(join(scratch, 'typed.ts'), `export const value: string = ${JSON.stringify(token)};\n`);
  const env = { ...process.env, TEMP: scratch, TMP: scratch, TMPDIR: scratch };
  if (!withTmpdir) delete env.TMPDIR;
  delete env.NODE_TEST_CONTEXT;
  delete env.TSX_DISABLE_CACHE;
  const result = spawnSync(
    process.execPath,
    ['--import', pathToFileURL(join(scratch, 'observer.mjs')).href, '--import', loaderUrl, join(scratch, 'probe.mjs')],
    { cwd: scratch, env, encoding: 'utf8', timeout: 60_000 }
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
