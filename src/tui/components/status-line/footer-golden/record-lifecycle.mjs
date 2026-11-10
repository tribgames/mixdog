// Records the warm lifecycle of the footer from Node at b6f10295a (lifecycle-child.mjs) into node-lifecycle.golden.json:
//   node record-lifecycle.mjs <node-repo> [out.json]
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { exportNodeTree } from './node-tree.mjs';
import { LIFECYCLE, T0 } from './scenarios.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = process.argv[2];
const out = process.argv[3] || join(here, 'node-lifecycle.golden.json');
if (!repo) throw new Error('usage: node record-lifecycle.mjs <node-repo> [out.json]');
const { tree, commit } = exportNodeTree(repo);

const recorded = [];
for (const scenario of LIFECYCLE) {
  const dir = mkdtempSync(join(tmpdir(), 'footer-lifecycle-'));
  try {
    for (const [name, content] of Object.entries(scenario.files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), content);
    }
    const env = { ...process.env };
    for (const name of Object.keys(env)) if (name.startsWith('ANTHROPIC_DEFAULT_')) delete env[name];
    const run = spawnSync(
      process.execPath,
      ['--import', pathToFileURL(join(here, 'date-shim.mjs')).href, join(here, 'lifecycle-child.mjs')],
      {
        cwd: tree,
        encoding: 'utf8',
        env: {
          ...env,
          TZ: 'UTC',
          FORCE_COLOR: '1',
          COLORTERM: 'truecolor',
          NO_COLOR: '',
          MIXDOG_DATA_DIR: dir,
          MIXDOG_HOME: join(dir, 'home'),
          MIXDOG_CONFIG_DIR: join(dir, 'config'),
          FOOTER_T0: String(T0),
          FOOTER_TREE: tree,
          FOOTER_COLS: String(scenario.cols),
          FOOTER_ARGS: JSON.stringify(scenario.args),
        },
      }
    );
    if (run.status !== 0) throw new Error(`${scenario.name}: ${run.stderr}`);
    recorded.push({ name: scenario.name, expected: JSON.parse(run.stdout) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
writeFileSync(out, `${JSON.stringify({ recordedFrom: commit, T0, scenarios: recorded }, null, 1)}\n`);
