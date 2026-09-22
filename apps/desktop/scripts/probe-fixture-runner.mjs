// Shared harness for the isolated renderer fixture probes: bundle the probe's
// entry.tsx, write its fixture document, then render it in a hidden Electron
// window. No installed app, daemon, user profile or visible window is touched.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { build } from 'esbuild';

import { spawnElectron } from './electron-harness.mjs';

/**
 * @param {object} options
 * @param {string} options.probeDir directory holding the probe's entry.tsx and main.cjs.
 * @param {string} options.artifactsDir parent directory that receives this run's `run-*` output.
 * @param {string} [options.documentLang] document `lang`; omitted writes no `lang` attribute at all.
 * @param {string[]} [options.forwardArgs] argv passed through to the probe's main.cjs after the output path.
 */
export async function runProbeFixture({ probeDir, artifactsDir, documentLang = '', forwardArgs = [] }) {
  await mkdir(artifactsDir, { recursive: true });
  const output = await mkdtemp(join(artifactsDir, 'run-'));
  await build({
    entryPoints: [join(probeDir, 'entry.tsx')],
    outfile: join(output, 'fixture.js'),
    bundle: true,
    format: 'iife',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file', '.svg': 'file', '.png': 'file' },
    logLevel: 'warning',
  });
  const lang = documentLang ? ` lang="${documentLang}"` : '';
  await writeFile(
    join(output, 'index.html'),
    `<!doctype html><html${lang}><head><meta charset="utf-8"><link rel="stylesheet" href="./fixture.css"></head><body><div id="root"></div><script src="./fixture.js"></script></body></html>`
  );
  const child = spawnElectron(join(probeDir, 'main.cjs'), { args: [output, ...forwardArgs] });
  child.on('error', (error) => {
    console.error(error);
    process.exitCode = 1;
  });
  child.on('exit', (code) => {
    process.exitCode = code ?? 1;
  });
}
