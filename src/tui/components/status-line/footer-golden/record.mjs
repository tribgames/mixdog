// Records the footer scenarios from Node at b6f10295a into node-footer.golden.json:
//   node record.mjs <node-repo> [out.json]
// Each scenario runs in its own process (the footer keeps module-level caches), with a fixed clock, UTC,
// forced colour and the scenario's files as the data dir.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { exportNodeTree } from './node-tree.mjs';
import { SCENARIOS, T0 } from './scenarios.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = process.argv[2];
const out = process.argv[3] || join(here, 'node-footer.golden.json');
if (!repo) throw new Error('usage: node record.mjs <node-repo> [out.json]');

// The recording is of exactly b6f10295a (node-tree.mjs exports that commit's sources).
const { tree, commit } = exportNodeTree(repo);
const head = { stdout: commit };

const recorded = [];
for (const scenario of SCENARIOS) {
  const dir = mkdtempSync(join(tmpdir(), 'footer-record-'));
  try {
    for (const [name, content] of Object.entries(scenario.files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), content);
    }
    // The config dir (settings.json of the Claude-current route) is a folder of its own.
    for (const [name, content] of Object.entries(scenario.configFiles || {})) {
      mkdirSync(dirname(join(dir, 'config', name)), { recursive: true });
      writeFileSync(join(dir, 'config', name), content);
    }
    const env = { ...process.env };
    for (const name of Object.keys(env)) if (name.startsWith('ANTHROPIC_DEFAULT_')) delete env[name];
    const run = spawnSync(
      process.execPath,
      ['--import', pathToFileURL(join(here, 'date-shim.mjs')).href, join(here, 'record-child.mjs')],
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
          ...(scenario.steps ? { FOOTER_STEPS: JSON.stringify(scenario.steps) } : {}),
        },
      }
    );
    if (run.status !== 0) throw new Error(`${scenario.name}: ${run.stderr}`);
    const result = JSON.parse(run.stdout);
    recorded.push(scenario.steps ? { name: scenario.name, steps: scenario.steps, expected: result } : { name: scenario.name, expected: result });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
writeFileSync(out, `${JSON.stringify({ recordedFrom: head.stdout.trim(), T0, scenarios: recorded }, null, 1)}\n`);
