import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { rustRelayBinary } from './relay-process.ts';

function writeAt(file: string, content: string, epochSeconds: number): string {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  utimesSync(file, epochSeconds, epochSeconds);
  return file;
}

function makeFixture(): { dir: string; repoRoot: string; gatePoolRoot: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-relay-bin-test-'));
  const repoRoot = join(dir, 'mixdog');
  const gatePoolRoot = join(dir, 'pool');
  writeAt(join(repoRoot, 'native', 'core', 'Cargo.toml'), '[workspace]\n', 1_700_000_000);
  writeAt(join(repoRoot, 'native', 'core', 'crates', 'mixdog-relay', 'src', 'main.rs'), 'fn main() {}\n', 1_700_000_100);
  return {
    dir,
    repoRoot,
    gatePoolRoot,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('rustRelayBinary rejects a stale release binary when sources are newer', () => {
  const fx = makeFixture();
  try {
    writeAt(join(fx.repoRoot, 'native', 'core', 'target', 'release', 'mixdog-relay.exe'), 'old', 1_700_000_050);
    assert.throws(
      () => rustRelayBinary({ repoRoot: fx.repoRoot, env: {}, platform: 'win32', gatePoolRoot: fx.gatePoolRoot }),
      /older than the sources/
    );
  } finally {
    fx.cleanup();
  }
});

test('rustRelayBinary prefers a fresh dev build over a release build and finds the Windows cargo-gate pools', () => {
  const fx = makeFixture();
  try {
    writeAt(join(fx.repoRoot, 'native', 'core', 'target', 'release', 'mixdog-relay.exe'), 'old-rel', 1_700_000_050);
    const gateDebug = writeAt(
      join(fx.gatePoolRoot, 'mixdog-light-target', 'debug', 'mixdog-relay.exe'),
      'fresh-dev',
      1_700_000_200
    );
    assert.equal(
      rustRelayBinary({ repoRoot: fx.repoRoot, env: {}, platform: 'win32', gatePoolRoot: fx.gatePoolRoot }),
      gateDebug
    );

    // Even when a release binary is fresh and newer, a fresh dev build still wins.
    writeAt(join(fx.repoRoot, 'native', 'core', 'target', 'release', 'mixdog-relay.exe'), 'fresh-rel', 1_700_000_300);
    assert.equal(
      rustRelayBinary({ repoRoot: fx.repoRoot, env: {}, platform: 'win32', gatePoolRoot: fx.gatePoolRoot }),
      gateDebug
    );
  } finally {
    fx.cleanup();
  }
});

test('rustRelayBinary rejects a stale dev build and ignores Rust integration test files', () => {
  const fx = makeFixture();
  try {
    const debugBin = writeAt(
      join(fx.repoRoot, 'native', 'core', 'target', 'debug', 'mixdog-relay'),
      'dev',
      1_700_000_200
    );
    // Editing an integration test file under tests/ does not invalidate the relay binary.
    writeAt(join(fx.repoRoot, 'native', 'core', 'crates', 'mixdog-relay', 'tests', 'legs_phone.rs'), '// test\n', 1_700_000_500);
    assert.equal(
      rustRelayBinary({ repoRoot: fx.repoRoot, env: {}, platform: 'linux', gatePoolRoot: fx.gatePoolRoot }),
      debugBin
    );

    // Editing a crate asset or dependency source marks the binary stale.
    writeAt(join(fx.repoRoot, 'native', 'core', 'crates', 'mixdog-relay', 'assets', 'pages', 'app.html'), '<html/>\n', 1_700_000_600);
    assert.throws(
      () => rustRelayBinary({ repoRoot: fx.repoRoot, env: {}, platform: 'linux', gatePoolRoot: fx.gatePoolRoot }),
      /older than the sources.*assets\/pages\/app\.html/
    );
  } finally {
    fx.cleanup();
  }
});

test('rustRelayBinary accepts a fresh release binary when no dev build exists and rejects foreign-checkout dep-info', () => {
  const fx = makeFixture();
  try {
    const releaseBin = writeAt(
      join(fx.repoRoot, 'native', 'core', 'target', 'release', 'mixdog-relay'),
      'fresh-rel',
      1_700_000_200
    );
    assert.equal(
      rustRelayBinary({ repoRoot: fx.repoRoot, env: {}, platform: 'linux', gatePoolRoot: fx.gatePoolRoot }),
      releaseBin
    );

    // A binary whose dep-info points at another checkout is refused.
    writeAt(
      join(fx.repoRoot, 'native', 'core', 'target', 'release', 'mixdog-relay.d'),
      `${releaseBin}: /other/checkout/native/core/crates/mixdog-relay/src/main.rs\n`,
      1_700_000_200
    );
    assert.throws(
      () => rustRelayBinary({ repoRoot: fx.repoRoot, env: {}, platform: 'linux', gatePoolRoot: fx.gatePoolRoot }),
      /another checkout/
    );
  } finally {
    fx.cleanup();
  }
});
