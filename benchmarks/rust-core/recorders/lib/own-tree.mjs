// A patched recording never touches the tree it is given: the Node changes are applied to a fresh `git archive` export of the commit
// that this run makes (and removes on exit), so a shared reference tree stays the exact export of its commit.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { GIT_TIMEOUT_MS, REPO_ROOT } from './common.mjs';

/** With `--apply-patch`, replaces `--tree` in `args` by this run's own patched export (node_modules linked from the given tree). */
export function useOwnPatchedTree(args) {
  const patches = (args.get('apply-patch') ?? '').split(',').filter(Boolean).map((file) => resolve(file));
  if (!patches.length) return;
  const commit = args.get('commit');
  if (!/^[0-9a-f]{40}$/.test(commit ?? '')) throw new Error('--apply-patch needs --commit <40 hex>');
  const given = resolve(args.get('tree') ?? process.env.MIXDOG_BENCH_TREE ?? REPO_ROOT);
  const own = mkdtempSync(join(tmpdir(), 'patched-tree-'));
  const run = (cmd, argv, cwd) => execFileSync(cmd, argv, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const archive = join(own, '.export.tar');
  run('git', ['archive', '--format=tar', '-o', archive, commit], REPO_ROOT);
  const tree = join(own, 'tree');
  mkdirSync(tree);
  run('tar', ['-xf', archive, '-C', tree], own);
  for (const file of patches) run('git', ['apply', file], tree);
  symlinkSync(join(given, 'node_modules'), join(tree, 'node_modules'), 'junction');
  process.on('exit', () => {
    unlinkSync(join(tree, 'node_modules'));
    rmSync(own, { recursive: true, force: true });
  });
  args.set('tree', tree);
}
