// Desktop test loader: tsx, with its transpile cache kept between test processes
// and runs.
//
// tsx caches every transpiled module in os.tmpdir()/tsx-<uid>, but the test
// runner points TEMP/TMP/TMPDIR at a scratch root it removes when the run ends
// (testIsolationEnv in scripts/lib/run-node-tests.mjs). Every run, and in the
// local gate every shard, therefore transpiled each TypeScript module again.
// tsx fixes its cache directory when it loads, so the temp variables point at a
// directory under this package's node_modules only while tsx loads; test code
// never sees them. tsx keys an entry by the source text, the transform options
// and the esbuild version but not its own package version, so the directory is
// per tsx version: an upgrade never reuses an older transpile. tsx expires
// unused entries itself.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const TEMP_VARIABLES = ['TEMP', 'TMP', 'TMPDIR'];
const { version: tsxVersion } = createRequire(import.meta.url)('tsx/package.json');
const cacheRoot = fileURLToPath(new URL(`../node_modules/.cache/mixdog-tests/tsx-${tsxVersion}`, import.meta.url));
const saved = TEMP_VARIABLES.map((name) => [name, process.env[name]]);
for (const name of TEMP_VARIABLES) process.env[name] = cacheRoot;
try {
  await import('tsx');
} finally {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
