import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { build } from 'vite';
import electron from 'electron';
import { findTranscriptAlignment } from '../../src/renderer/transcript-alignment.ts';
import { legacyAlignment } from '../../../../scripts/perf/transcript-baseline.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'mixdog-transcript-screen-'));
const previous = Array.from({ length: 2000 }, (_, id) => ({ kind: 'statusdone', id: `old-${id}`, status: 'done' }));
const incoming = previous.slice(-500).map((item, id) => ({ ...item, id: `disk-${id}` }));
const alignment = {};
for (const [name, find] of process.argv.includes('--screen-only') ? []
  : [['before', legacyAlignment], ['after', findTranscriptAlignment]]) {
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    const result = find(previous, incoming);
    if (result?.offset !== 1500) throw new Error('Wrong tail alignment');
    samples.push(performance.now() - start);
  }
  alignment[name] = samples;
}
await build({
  configFile: false, root: here, base: './', logLevel: 'warn',
  define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}', 'process.platform': JSON.stringify(process.platform) },
  build: { outDir: directory, emptyOutDir: false, minify: true },
});
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const code = await new Promise((resolve, reject) => {
  const child = spawn(electron, [join(here, 'main.cjs'), directory], { env, stdio: 'inherit' });
  child.on('error', reject);
  child.on('exit', resolve);
});
const screen = JSON.parse(await readFile(join(directory, 'screen-report.json'), 'utf8'));
const report = { directory, alignment, screen };
await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (code !== 0 || !Array.isArray(screen.failures) || screen.failures.length > 0) process.exitCode = 1;
