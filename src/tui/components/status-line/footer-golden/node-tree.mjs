// Exports the sources of Node at b6f10295a from a repository to a scratch folder (with the repository's node_modules),
// so a recording reads exactly that commit whatever the repository has checked out or modified.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const REVISION = 'b6f10295a';

/** `{ tree, commit }`; the folder is removed when the process exits. */
export function exportNodeTree(repo) {
  const git = (...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  const resolved = git('rev-parse', '--verify', `${REVISION}^{commit}`);
  if (resolved.status !== 0) throw new Error(`${repo} has no commit ${REVISION}: ${resolved.stderr.trim()}`);
  const commit = resolved.stdout.trim();
  if (!commit.startsWith(REVISION)) throw new Error(`${REVISION} resolved to ${commit}`);
  const tree = mkdtempSync(join(tmpdir(), 'node-tree-'));
  process.on('exit', () => rmSync(tree, { recursive: true, force: true }));
  const archive = spawnSync('git', ['-C', repo, 'archive', '--format=tar', commit, 'src', 'package.json', ':(exclude)*.test.mjs'], {
    maxBuffer: 1 << 30,
  });
  if (archive.status !== 0) throw new Error(`git archive failed: ${archive.stderr}`);
  const extract = spawnSync('tar', ['-x', '-C', tree], { input: archive.stdout });
  if (extract.status !== 0) throw new Error(`tar failed: ${extract.stderr}`);
  symlinkSync(join(repo, 'node_modules'), join(tree, 'node_modules'), 'junction');
  return { tree, commit };
}
