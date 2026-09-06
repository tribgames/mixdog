import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { build } from 'esbuild';
import { computerSourceEsbuildPlugin } from './computer-source-assets.mjs';

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const output = join(root, 'artifacts', 'computer-use');
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(output, 'reliability-'));
const entry = join(directory, 'harness.mjs');
await build({
  entryPoints: [fileURLToPath(new URL('../src/main/computer/harness/reliability.ts', import.meta.url))],
  outfile: entry, bundle: true, platform: 'node', format: 'esm', target: 'node22',
  external: ['electron'], logLevel: 'warning',
  plugins: [computerSourceEsbuildPlugin()],
});
const env = { ...process.env, MIXDOG_RELIABILITY_DIRECTORY: directory,
  MIXDOG_DATA_DIR: join(directory, 'data'), MIXDOG_BRIDGE_DISCOVERY_DIR: join(directory, 'data') };
const only = process.argv.find((argument) => argument.startsWith('--only='))?.slice(7);
if (only) env.MIXDOG_RELIABILITY_ONLY = only;
delete env.ELECTRON_RUN_AS_NODE;
delete env.MIXDOG_COMPUTER_POLICY_FILE;
const child = spawn(electron, [entry], { env, windowsHide: true, stdio: 'inherit' });
const code = await new Promise((resolveExit, reject) => {
  child.once('error', reject);
  child.once('exit', (code) => resolveExit(code ?? 1));
});
const report = JSON.parse(await readFile(join(directory, 'report.json'), 'utf8'));
console.log(JSON.stringify({ report: join(directory, 'report.json'), ...report }, null, 2));
if (code !== 0 || report.results.some((result) => result.status === 'failed')) process.exitCode = 1;
