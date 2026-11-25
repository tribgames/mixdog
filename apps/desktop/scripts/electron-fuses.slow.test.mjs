import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { electronBinary } from './electron-binary.mjs';

const require = createRequire(import.meta.url);
const { FuseV1Options, flipFuses, getCurrentFuseWire } = require('@electron/fuses');
const { FuseState, SENTINEL } = require('@electron/fuses/dist/constants');
const { getConfig, validateConfiguration } = require('app-builder-lib/out/util/config/config');
const { PlatformPackager } = require('app-builder-lib');
const { DebugLogger } = require('builder-util');

const desktopDir = fileURLToPath(new URL('..', import.meta.url));

/** The fuse wire of the packaged executable: electron-builder's reading of electron-builder.yml, flipped by the
 *  builder's own mapping on the wire this Electron ships. Returns that wire before and after the flip. */
async function packagedFuses(t) {
  const config = await getConfig(desktopDir, null, null);
  await validateConfiguration(config, new DebugLogger(false));
  const fuses = await PlatformPackager.prototype.generateFuseConfig.call(null, config.electronFuses);
  const binary = await readFile(electronBinary());
  const start = binary.indexOf(SENTINEL);
  assert.ok(start >= 0, 'the Electron binary carries a fuse wire');
  const wireLength = binary[start + SENTINEL.length + 1];
  const dir = await mkdtemp(join(tmpdir(), 'mixdog-fuses-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const wire = join(dir, 'fuse-wire.bin');
  await writeFile(wire, binary.subarray(start, start + SENTINEL.length + 2 + wireLength));
  const shipped = await getCurrentFuseWire(wire);
  await flipFuses(wire, fuses);
  return { shipped, packaged: await getCurrentFuseWire(wire), wireLength };
}

test('the packaged executable keeps every fuse the product needs', async (t) => {
  const { shipped, packaged, wireLength } = await packagedFuses(t);
  const needed = [
    // The core starts the executable with ELECTRON_RUN_AS_NODE=1 (mixdog-mcp launcher.rs, office script_runtime.rs).
    [FuseV1Options.RunAsNode, FuseState.ENABLE],
    // The packaged renderer is loaded with loadFile, and its module scripts are file:// fetches.
    [FuseV1Options.GrantFileProtocolExtraPrivileges, FuseState.ENABLE],
    // Off, Electron removes NODE_EXTRA_CA_CERTS from the environment the core and its children inherit.
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable, FuseState.ENABLE],
    // Once cookies are written encrypted, turning encryption off loses every stored sign-in.
    [FuseV1Options.EnableCookieEncryption, FuseState.ENABLE],
    // The package ships no browser_v8_context_snapshot.bin.
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot, FuseState.DISABLE],
  ];
  for (const [fuse, state] of needed) assert.equal(packaged[fuse], state, FuseV1Options[fuse]);
  const configurable = Object.values(FuseV1Options).filter((value) => typeof value === 'number');
  for (let fuse = configurable.length; fuse < wireLength; fuse += 1) {
    assert.equal(packaged[fuse], shipped[fuse], `fuse ${fuse} keeps Electron's own state`);
  }
});
