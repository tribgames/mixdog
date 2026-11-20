import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';

const action = new URL('../../.github/actions/install-nextest/action.yml', import.meta.url);
const [{ run }] = parse(readFileSync(action, 'utf8')).runs.steps;
const bash =
  process.platform === 'win32' ? `${process.env.ProgramFiles || 'C:/Program Files'}/Git/bin/bash.exe` : 'bash';

test('install-nextest creates a fresh Cargo bin on macOS and only extracts a verified download', (t) => {
  const install = (download) => {
    const cwd = mkdtempSync(join(tmpdir(), 'mixdog-nextest-'));
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    const result = spawnSync(bash, ['--noprofile', '--norc', '-eo', 'pipefail'], {
      cwd,
      env: { ...process.env, RUNNER_OS: 'macOS', RUNNER_ARCH: 'ARM64', NEXTEST_FIXTURE: download },
      encoding: 'utf8',
      input: `
        export CARGO_HOME="$PWD/cargo home" GITHUB_PATH="$PWD/github-path" TMPDIR="$PWD"
        mkdir fixture
        printf 'verified\\n' > fixture/cargo-nextest
        tar -czf "$PWD/verified.tar.gz" -C fixture cargo-nextest
        printf 'tampered\\n' > fixture/cargo-nextest
        tar -czf "$PWD/tampered.tar.gz" -C fixture cargo-nextest
        curl() {
          while (( $# )); do
            if [[ $1 == --output ]]; then
              cp "$PWD/$NEXTEST_FIXTURE.tar.gz" "$2"
              return
            fi
            shift
          done
          cat "$PWD/$NEXTEST_FIXTURE.tar.gz"
        }
        shasum() {
          read -r checksum archive
          [[ $checksum =~ ^[0-9a-f]{64}$ ]] && cmp -s "$TMPDIR/verified.tar.gz" "$archive"
        }
        ${run}`,
    });
    assert.ifError(result.error);
    return { cwd, ...result };
  };

  const good = install('verified');
  assert.equal(good.status, 0, good.stderr);
  assert.equal(readFileSync(join(good.cwd, 'cargo home', 'bin', 'cargo-nextest'), 'utf8'), 'verified\n');
  assert.match(readFileSync(join(good.cwd, 'github-path'), 'utf8').trim(), /\/cargo home\/bin$/);

  const bad = install('tampered');
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /checksum/i);
  assert.equal(existsSync(join(bad.cwd, 'cargo home', 'bin', 'cargo-nextest')), false);
  assert.equal(existsSync(join(bad.cwd, 'github-path')), false);
});
