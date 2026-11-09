// Records, from Node at b6f10295a, the quiet states of a turn's liveness (`turnQuietState`) and the byline the shared
// spinner meta (`buildSpinnerMeta`) reads from them, into node-quiet.golden.json.
//   node record.mjs <node-repo> [out.json]
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportNodeTree } from '../components/status-line/footer-golden/node-tree.mjs';
import { CASES, NOW, WARN_MS } from './cases.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = process.argv[2];
const out = process.argv[3] || join(here, 'node-quiet.golden.json');
if (!repo) throw new Error('usage: node record.mjs <node-repo> [out.json]');
const { tree, commit } = exportNodeTree(repo);

const child = `
import { pathToFileURL } from 'node:url';
const url = (p) => pathToFileURL(process.env.NODE_TREE + '/' + p).href;
const { turnQuietState } = await import(url('src/tui/session/turn-quiet.mjs'));
const { buildSpinnerMeta } = await import(url('src/tui/spinner-meta.mjs'));
const { cases, now, warnMs } = JSON.parse(process.env.CASES);
const result = cases.map(({ liveness }) => {
  const quiet = turnQuietState(liveness, now, warnMs);
  const meta = buildSpinnerMeta({ quiet, now });
  return { quiet, quietText: meta.quietText, quietParts: meta.quietParts ?? null };
});
process.stdout.write(JSON.stringify(result));
process.exit(0);
`;
const run = spawnSync(process.execPath, ['--input-type=module', '-e', child], {
  cwd: tree,
  encoding: 'utf8',
  env: { ...process.env, NODE_TREE: tree, CASES: JSON.stringify({ cases: CASES, now: NOW, warnMs: WARN_MS }) },
});
if (run.status !== 0) throw new Error(run.stderr);
const results = JSON.parse(run.stdout);
writeFileSync(
  out,
  `${JSON.stringify({ recordedFrom: commit, cases: CASES.map((c, i) => ({ name: c.name, ...results[i] })) }, null, 1)}\n`
);
