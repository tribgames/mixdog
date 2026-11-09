// Records the footer scenarios from the Node tree (b6f10295a) into node-footer.golden.json:
//   node record.mjs <node-tree-root> [out.json]
// Each scenario runs in its own process (the footer keeps module-level caches), with a fixed clock, UTC,
// forced colour and the scenario's files as the data dir.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SCENARIOS, T0 } from './scenarios.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const tree = process.argv[2];
const out = process.argv[3] || join(here, 'node-footer.golden.json');
if (!tree) throw new Error('usage: node record.mjs <node-tree-root> [out.json]');

const recorded = [];
for (const scenario of SCENARIOS) {
  const dir = mkdtempSync(join(tmpdir(), 'footer-record-'));
  try {
    for (const [name, content] of Object.entries(scenario.files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), content);
    }
    const run = spawnSync(
      process.execPath,
      ['--import', pathToFileURL(join(here, 'date-shim.mjs')).href, join(here, 'record-child.mjs')],
      {
        cwd: tree,
        encoding: 'utf8',
        env: {
          ...process.env,
          TZ: 'UTC',
          FORCE_COLOR: '1',
          COLORTERM: 'truecolor',
          NO_COLOR: '',
          MIXDOG_DATA_DIR: dir,
          MIXDOG_HOME: join(dir, 'home'),
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
writeFileSync(out, `${JSON.stringify({ recordedFrom: 'b6f10295a', T0, scenarios: recorded }, null, 1)}\n`);
