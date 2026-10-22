import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), '..');

// The release gate's own "Build desktop" step is skipped on a cached bundle
// key that does not cover every runtime module the service reaches, so this
// lane builds it on every change: a module that pulls a native binding (.node)
// into the plain-Node service bundle fails the build, and with it this test.
test('the desktop service bundle builds and loads under plain Node', (t) => {
  const outDir = mkdtempSync(join(tmpdir(), 'mixdog-build-daemon-'));
  t.after(() => rmSync(outDir, { recursive: true, force: true }));
  const result = spawnSync(
    process.execPath,
    [join(desktopDir, 'scripts', 'build-daemon.mjs'), `--outfile=${join(outDir, 'main', 'daemon.cjs')}`],
    { cwd: desktopDir, encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Built plain-Node desktop service/);
});
