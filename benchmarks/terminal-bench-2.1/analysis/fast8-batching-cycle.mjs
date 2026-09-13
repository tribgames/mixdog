// Run the existing strict trace checker and display a bounded two-layer
// dashboard. Full per-call evidence remains in its immutable analysis JSON.
// Usage: node analysis/fast8-batching-cycle.mjs <jobs-dir> <baseline-dir> <workspace> <label>
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const [jobs, baseline, workspace, label] = process.argv.slice(2);
if (!jobs || !baseline || !workspace || !label) throw new Error('Expected jobs, baseline, workspace, label.');
const child = spawnSync(process.execPath, [
  join(import.meta.dirname, 'fast8-ten-analysis.mjs'), 'analyze', jobs, baseline, workspace,
], { encoding: 'utf8' });
if (child.stderr) process.stderr.write(child.stderr);
if (child.error) throw child.error;
if (child.signal || child.status !== 0) {
  process.stdout.write(child.stdout || '');
  if (child.signal) process.stderr.write(`Trace analysis terminated by ${child.signal}\n`);
  process.exit(child.status ?? 1);
}
const analysis = JSON.parse(child.stdout);
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const source = json(join(workspace, `${label}-source.json`));
const manifest = json(join(jobs, 'runtime-manifest.json'));
const reference = json(join(baseline, 'runtime-manifest.json'));
const current = new Map(manifest.files.map(file => [file.path, file]));
const prior = new Map(reference.files.map(file => [file.path, file]));
for (const [path, text] of Object.entries(source.files)) {
  assert.equal(current.get(path)?.sha256, createHash('sha256').update(text).digest('hex'), `source ${path}`);
}
const changed = [...new Set([...current.keys(), ...prior.keys()])].filter(path =>
  current.get(path)?.sha256 !== prior.get(path)?.sha256 || current.get(path)?.mode !== prior.get(path)?.mode);
const provenance = { trackedMatches: Object.keys(source.files).length, changed,
  outsideTracked: changed.filter(path => !(path in source.files)) };
writeFileSync(join(resolve(workspace), `${label}-provenance.json`), JSON.stringify(provenance, null, 2), { flag: 'wx' });
const rows = analysis.rows.map(row => ({
  task: row.task, output: row.output, seconds: row.agent, requests: row.requests, calls: row.calls,
  internal: row.batching.internal_arrays,
  parallel: row.batching.inter_tool,
}));
const { rows: fullRows, ...dashboard } = analysis;
console.log(JSON.stringify({ ...dashboard, provenance, rows }));
