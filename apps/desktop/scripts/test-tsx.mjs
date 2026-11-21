// tsx fixes its transpile-cache directory (os.tmpdir()/tsx-<uid>) when it loads, so TEMP/TMP/TMPDIR point under
// this package's node_modules only while tsx loads. tsx keys cache entries without its own package version, so
// the directory is per tsx version.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const TEMP_VARIABLES = ['TEMP', 'TMP', 'TMPDIR'];
const { version: tsxVersion } = createRequire(import.meta.url)('tsx/package.json');
// A shared/read-only dependency junction can use a checkout-owned persistent cache.
const cacheRoot = process.env.MIXDOG_TEST_TSX_CACHE_DIR
  ? join(resolve(process.env.MIXDOG_TEST_TSX_CACHE_DIR), `tsx-${tsxVersion}`)
  : fileURLToPath(new URL(`../node_modules/.cache/mixdog-tests/tsx-${tsxVersion}`, import.meta.url));
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
