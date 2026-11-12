// Records every case's state history (remote-protocol-chat-history.record.mjs) twice, the cases side by side (each its own process and
// world), and reports, per case, whether the two runs are byte-identical. A case whose runs differ names the first differing line.
//
//   node --import ./scripts/test-env.mjs --import ./scripts/test-tsx.mjs src/renderer/remote-protocol-chat-history-run.mjs <export dir> <real-turn-harness dir> <out dir> [case,case,...]
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ABORT_CASES } from './remote-protocol-chat-abort-cases.mjs';

const [exportDir, harness, outDir, only] = process.argv.slice(2);
if (!outDir) throw new Error('usage: <export dir> <real-turn-harness dir> <out dir> [case,case,...]');
const names = only ? only.split(',') : ABORT_CASES.map((c) => c.name);
const PARALLEL = 6;
mkdirSync(outDir, { recursive: true });
const recorder = fileURLToPath(new URL('./remote-protocol-chat-history.record.mjs', import.meta.url));
const cwd = fileURLToPath(new URL('../..', import.meta.url));

/** One recording in its own process; resolves with its exit code (the recorder ends itself within its own five-minute deadline). */
const record = (name, run) =>
  new Promise((resolve) => {
    const out = join(outDir, `${name}.${run}.json`);
    // The recorder's own loader, not tsx: see remote-protocol-chat-history-loader.mjs.
    const child = spawn(process.execPath, ['--import', './scripts/test-env.mjs', '--import', './src/renderer/remote-protocol-chat-history-loader.mjs', recorder, exportDir, harness, out, name], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });
    child.on('exit', (code) => { writeFileSync(`${out}.log`, log); resolve({ name, run, out, code, log }); });
  });

// A case's two runs share its world's folder (its paths are in what is recorded), so they run one after the other.
const jobs = [...names];
const results = [];
const workers = Array.from({ length: PARALLEL }, async () => {
  for (let name = jobs.shift(); name; name = jobs.shift()) {
    for (const run of [1, 2]) {
      const r = await record(name, run);
      results.push(r);
      process.stdout.write(`${r.name} run ${r.run}: exit ${r.code}${r.code ? `\n${r.log.split('\n').slice(-6).join('\n')}` : ''}\n`);
    }
  }
});
await Promise.all(workers);
let failed = 0;
for (const name of names) {
  const [a, b] = [1, 2].map((run) => results.find((r) => r.name === name && r.run === run));
  if (a.code || b.code) { failed += 1; console.log(`${name}: NOT RECORDED`); continue; }
  const [x, y] = [a.out, b.out].map((f) => readFileSync(f, 'utf8').split('\n'));
  const at = x.findIndex((line, i) => line !== y[i]);
  if (at < 0 && x.length === y.length) console.log(`${name}: identical (${x.length} lines)`);
  else { failed += 1; console.log(`${name}: DIFFER at line ${at + 1}\n  1: ${x[at]?.slice(0, 300)}\n  2: ${y[at]?.slice(0, 300)}`); }
}
process.exit(failed ? 1 : 0);
