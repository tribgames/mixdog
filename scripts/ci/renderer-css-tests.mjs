// CSS-only desktop PRs check renderer tests whose source references the changed styles.
// Read NUL-separated paths relative to apps/desktop; print matching fast and slow files.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { selectChangedTests } from '../lib/changed-tests.mjs';
import { discoverTestFiles, selectTestFiles } from '../test.mjs';

export async function rendererCssTests(paths, cwd = process.cwd()) {
  const changed = paths.filter((file) => /^src\/renderer\/.*\.css$/.test(file));
  const candidates = selectTestFiles(await discoverTestFiles(cwd), {
    lane: 'all',
    excludeLanes: ['live', 'electron'],
    filters: [],
  });
  return selectChangedTests(candidates, changed, cwd).selected;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const paths = readFileSync(0, 'utf8').split('\0');
  for (const file of await rendererCssTests(paths)) console.log(file);
}
