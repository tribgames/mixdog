// Records the boot-theme states from Node at b6f10295a into node-theme.golden.json:
//   node record.mjs <node-repo> [out.json]
// Each state is built in fresh data and backup dirs and read with Node's own `readConfig()` in a process of its own.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { exportNodeTree } from '../components/status-line/footer-golden/node-tree.mjs';
import { SCENARIOS } from './scenarios.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = process.argv[2];
const out = process.argv[3] || join(here, 'node-theme.golden.json');
if (!repo) throw new Error('usage: node record.mjs <node-repo> [out.json]');
const { tree, commit } = exportNodeTree(repo);

const child = `
import { pathToFileURL } from 'node:url';
const { readConfig } = await import(pathToFileURL(process.env.NODE_TREE + '/src/runtime/shared/config.mjs').href);
let theme;
try { theme = readConfig()?.ui?.theme ?? null; } catch { theme = 'THROW'; }
process.stdout.write(JSON.stringify(theme));
process.exit(0);
`;

const recorded = [];
for (const scenario of SCENARIOS) {
  const root = mkdtempSync(join(tmpdir(), 'theme-record-'));
  try {
    const dataDir = join(root, 'data');
    const backupRoot = join(root, 'backups');
    scenario.setup({ dataDir, backupRoot });
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', child], {
      cwd: tree,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_TREE: tree,
        MIXDOG_DATA_DIR: dataDir,
        MIXDOG_HOME: join(root, 'home'),
        MIXDOG_CONFIG_DIR: join(root, 'home'),
        MIXDOG_USER_DATA_BACKUP_ROOT: backupRoot,
      },
    });
    if (run.status !== 0) throw new Error(`${scenario.name}: ${run.stderr}`);
    recorded.push({ name: scenario.name, theme: JSON.parse(run.stdout) });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
writeFileSync(out, `${JSON.stringify({ recordedFrom: commit, scenarios: recorded }, null, 1)}\n`);
void pathToFileURL;
