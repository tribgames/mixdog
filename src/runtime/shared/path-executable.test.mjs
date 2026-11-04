import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { findPathExecutable, findPathExecutablesAsync } from './path-executable.mjs';

// Refuse listing `dir` to this user while its files stay reachable by name.
function denyListing(dir) {
  if (process.platform === 'win32') {
    execFileSync('icacls', [dir, '/deny', `${userInfo().username}:(RD)`], { windowsHide: true, stdio: 'ignore' });
    return () => execFileSync('icacls', [dir, '/remove:d', userInfo().username], { windowsHide: true, stdio: 'ignore' });
  }
  chmodSync(dir, 0o311);
  return () => chmodSync(dir, 0o755);
}

test('a PATH directory that refuses listing still yields the executable inside it', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-path-unlisted-'));
  const unlisted = join(root, 'unlisted');
  const listed = join(root, 'listed');
  mkdirSync(unlisted);
  mkdirSync(listed);
  const exe = process.platform === 'win32' ? 'hidden-tool.exe' : 'hidden-tool';
  writeFileSync(join(unlisted, exe), '');
  writeFileSync(join(listed, process.platform === 'win32' ? 'plain-tool.exe' : 'plain-tool'), '');
  if (process.platform !== 'win32') {
    chmodSync(join(unlisted, exe), 0o755);
    chmodSync(join(listed, 'plain-tool'), 0o755);
  }
  const allow = denyListing(unlisted);
  t.after(() => {
    allow();
    rmSync(root, { recursive: true, force: true });
  });
  try {
    readdirSync(unlisted);
    t.skip('this user can list the directory anyway (elevated)');
    return;
  } catch {}
  const options = { pathValue: [unlisted, listed].join(delimiter) };
  const hits = await findPathExecutablesAsync(['hidden-tool', 'plain-tool', 'absent-tool'], options);
  assert.equal(hits.get('hidden-tool'), findPathExecutable('hidden-tool', options));
  assert.ok(hits.get('hidden-tool'), 'the unlisted directory lost its executable');
  assert.equal(hits.get('plain-tool'), findPathExecutable('plain-tool', options));
  assert.equal(hits.get('absent-tool'), null);
});
