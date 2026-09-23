import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computerSourceEsbuildPlugin } from './computer-source-assets.mjs';
import { optionValue } from './cli-args.mjs';
import { bundleElectronEntry, electronProcessEnv, spawnElectron, waitForChildExit } from './electron-harness.mjs';

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const output = join(root, 'artifacts', 'computer-use');
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(output, 'reliability-'));
const entry = join(directory, 'harness.mjs');
await bundleElectronEntry({
  entry: new URL('../src/main/computer/harness/reliability.ts', import.meta.url),
  outfile: entry,
  plugins: [computerSourceEsbuildPlugin()],
});
const env = electronProcessEnv({
  MIXDOG_RELIABILITY_DIRECTORY: directory,
  MIXDOG_DATA_DIR: join(directory, 'data'),
  MIXDOG_BRIDGE_DISCOVERY_DIR: join(directory, 'data'),
});
const only = optionValue('only');
if (only) env.MIXDOG_RELIABILITY_ONLY = only;
delete env.MIXDOG_COMPUTER_POLICY_FILE;
const child = spawnElectron(entry, { env });
const code = await waitForChildExit(child, { rejectOnSignal: false });
const report = JSON.parse(await readFile(join(directory, 'report.json'), 'utf8'));
// Keep the report and progress log; the Electron profile, bundle and fixtures
// are rebuilt every run and would otherwise pile up tens of megabytes each.
for (const entry of await readdir(directory)) {
  if (entry === 'report.json' || entry === 'progress.log') continue;
  await rm(join(directory, entry), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(JSON.stringify({ report: join(directory, 'report.json'), ...report }, null, 2));
if (code !== 0 || report.results.some((result) => result.status === 'failed')) process.exitCode = 1;
