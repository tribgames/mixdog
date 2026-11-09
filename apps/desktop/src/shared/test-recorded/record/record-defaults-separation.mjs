// Records the line Node's app-ready catch wrote for a failed defaults separation, from b6f10295a's own createDesktopDiagnostics
// (read from the commit's object, never a working tree):
//
//   node record-defaults-separation.mjs --node-repo <repository that has the Node commit>
//
// Writes ../defaults-separation.node-line.json: the message Node's catch received, the call it made
// (`write('defaults-separation-failed', { message })`, apps/desktop/src/main/index.ts of that commit) and the line it appended.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { NODE_COMMIT, NODE_TREE } from './node-source.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(here, '../../../..');
const flag = process.argv.indexOf('--node-repo');
if (flag < 0 || !process.argv[flag + 1]) throw new Error('usage: node record-defaults-separation.mjs --node-repo <repository with ' + NODE_COMMIT + '>');
const nodeRepo = resolve(process.argv[flag + 1]);

const commit = NODE_COMMIT;
if (commit !== NODE_COMMIT) throw new Error(`the Node export is ${commit}, the recordings are pinned to ${NODE_COMMIT}`);
const treeId = spawnSync('git', ['-C', nodeRepo, 'rev-parse', `${commit}^{tree}`], { encoding: 'utf8' }).stdout.trim();
if (treeId !== NODE_TREE) throw new Error(`${commit} has tree ${treeId}, expected ${NODE_TREE}`);

export const CONTEXT = { appVersion: '1.2.3', packaged: true, bootId: 'boot-1', pid: 4242, platform: 'win32', arch: 'x64' };
export const AT = '2026-01-02T03:04:05.000Z';
const message = 'EACCES: permission denied, open \'mixdog-config.json\'';

const work = mkdtempSync(join(tmpdir(), 'record-defaults-'));
try {
  const module = 'apps/desktop/src/main/desktop-diagnostics.ts';
  // The archive export holds only src/; this module is apps/desktop's, with imports of node: builtins alone.
  const shown = spawnSync('git', ['-C', nodeRepo, 'show', `:${module}`], { encoding: 'buffer', maxBuffer: 1 << 24 });
  if (shown.status !== 0) throw new Error(`git show ${module}: ${shown.stderr}`);
  const copy = join(work, 'desktop-diagnostics.ts');
  writeFileSync(copy, shown.stdout);
  const script = join(work, 'run.mjs');
  const file = join(work, 'diagnostics.jsonl');
  writeFileSync(
    script,
    `import { readFileSync } from 'node:fs';
import { createDesktopDiagnostics } from ${JSON.stringify(pathToFileURL(copy).href)};
const diagnostics = createDesktopDiagnostics(${JSON.stringify(file)}, ${JSON.stringify(CONTEXT)}, { now: () => new Date(${JSON.stringify(AT)}) });
// Node's catch: diagnostics?.write('defaults-separation-failed', { message: error instanceof Error ? error.message : String(error) })
const error = new Error(${JSON.stringify(message)});
diagnostics.write('defaults-separation-failed', { message: error instanceof Error ? error.message : String(error) });
await diagnostics.flush();
process.stdout.write(readFileSync(${JSON.stringify(file)}, 'utf8'));
`
  );
  const run = spawnSync(process.execPath, ['--import', './scripts/test-tsx.mjs', script], { cwd: desktopDir, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`Node's createDesktopDiagnostics failed: ${run.stderr}`);
  writeFileSync(
    join(here, '..', 'defaults-separation.node-line.json'),
    JSON.stringify({ source: { commit, tree: treeId, module }, context: CONTEXT, at: AT, message, line: run.stdout }, null, 2) + '\n'
  );
  console.log('recorded defaults-separation');
} finally {
  rmSync(work, { recursive: true, force: true });
}
