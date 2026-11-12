#!/usr/bin/env node
// Recording of shared/file-has-data.test.mjs (b6f10295a), the two cases that run on real files: fileHasData is false for
// absent, empty and NUL-filled files only (with exactLocalProviderFile on top), and fileHasDataAsync gives fileHasData's
// verdict. (The third case patches fs.openSync to throw errno codes: no shipped client can make that happen, not recorded.)
// Each step writes the file as recorded (`content`: parts of text and runs of NUL bytes; null leaves the file as it is) and
// the recording holds every verdict.
//
//   node benchmarks/rust-core/recorders/record-file-has-data-cases.mjs --tree <export of b6f10295a with node_modules>
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSet } from './lib/case-set.mjs';

const set = openSet('file-has-data-cases', import.meta.url);
const { fileHasData, fileHasDataAsync } = await set.load('src/runtime/shared/file-has-data.mjs');
const { exactLocalProviderFile } = await set.load('src/runtime/local-provider/catalog.mjs');

const bytes = (parts) => Buffer.concat(parts.map((p) => (p.nul !== undefined ? Buffer.alloc(p.nul) : Buffer.from(p.text, 'latin1'))));
const roots = [];
const inDir = async (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-file-has-data-'));
  roots.push(dir);
  return fn(dir);
};

const exactSteps = [
  { path: 'weights.bin', content: null },
  { path: 'weights.bin', content: [] },
  { path: 'weights.bin', content: [{ nul: 10_000 }] },
  { path: 'weights.bin', content: [{ text: 'GGUF' }, { nul: 10_000 }], exactSize: 10_004 },
  { path: 'weights.bin', content: [{ nul: 10_004 }], exactSize: 10_004 },
];
await set.run('fileHasData is false for absent, empty and NUL-filled files only', () => inDir((dir) => ({
  verdicts: exactSteps.map((step) => {
    if (step.content) writeFileSync(join(dir, step.path), bytes(step.content));
    const file = join(dir, step.path);
    return { fileHasData: fileHasData(file), ...(step.exactSize ? { exact: exactLocalProviderFile(file, step.exactSize) } : {}) };
  }),
})), { steps: exactSteps });

const asyncSteps = [
  { path: 'engine.bin', content: null },
  { path: 'engine.bin', content: [] },
  { path: 'engine.bin', content: [{ nul: 10_000 }] },
  { path: 'engine.bin', content: [{ text: 'MZ\x90' }] },
  { path: 'engine.bin', content: [{ text: 'x'.repeat(9000) }] },
  { path: 'missing', content: null },
  { path: 'engine.bin/child', content: null },
];
await set.run('fileHasDataAsync gives the same verdict as fileHasData', () => inDir(async (dir) => {
  const verdicts = [];
  for (const step of asyncSteps) {
    if (step.content && step.path === 'engine.bin') writeFileSync(join(dir, step.path), bytes(step.content));
    const file = join(dir, step.path);
    verdicts.push({ sync: fileHasData(file), async: await fileHasDataAsync(file) });
  }
  return { verdicts };
}), { steps: asyncSteps });

await set.finish({
  entry: { runs: 'shared/file-has-data.mjs fileHasData / fileHasDataAsync and local-provider/catalog.mjs exactLocalProviderFile on real files in a temp dir', notRun: 'the errno-injection case (fs.openSync patched to throw): not reachable by a shipped client' },
  replay: { entry: 'mixdog-services local_provider/catalog.rs file_has_data and exact_file: write each recorded step into a temp dir, compare every verdict', normalised: {} },
});
for (const r of roots) rmSync(r, { recursive: true, force: true });
process.exit(0);
