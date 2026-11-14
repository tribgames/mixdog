#!/usr/bin/env node
// Builds the Node-API module the desktop's browser modules call (native/mixdog-main-native: the Browser Use URL policy
// and redaction rules) before a test run, so a test that imports those modules finds it where native-module.ts looks in a
// checkout. The package's `pretest` scripts run it; no test starts cargo itself.
//
// The build is skipped when the library is newer than every source file the module is built from. CARGO_TARGET_DIR is
// honoured exactly as native-module.ts honours it.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const crate = join(root, 'native', 'mixdog-main-native');
// The crate and what it links by path: the sources prepare-runtime hashes for the packaged copy.
const sourceRoots = [
  crate,
  join(root, 'native', 'core', 'crates', 'mixdog-browser-rules'),
  join(root, 'native', 'core', 'crates', 'mixdog-js'),
];
const sourceFiles = [join(root, 'native', 'core', 'Cargo.toml')];
const libraryFile = { win32: 'mixdog_main_native.dll', darwin: 'libmixdog_main_native.dylib' }[process.platform] ?? 'libmixdog_main_native.so';
const library = join(process.env.CARGO_TARGET_DIR ?? join(crate, 'target'), 'release', libraryFile);

/** The newest modification time under `directory`, build output and dependencies left out. */
function newestSource(directory) {
  let newest = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (['dist', 'target', 'node_modules'].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestSource(path) : statSync(path).mtimeMs);
  }
  return newest;
}

const newest = Math.max(...sourceRoots.map(newestSource), ...sourceFiles.map((file) => statSync(file).mtimeMs));
if (existsSync(library) && statSync(library).mtimeMs >= newest) process.exit(0);

console.log(`[build-test-native] building ${libraryFile} (cargo build --release in native/mixdog-main-native)`);
// The crate's own folder is the working directory: its .cargo/config.toml sets the Windows linker and static CRT.
const built = spawnSync('cargo', ['build', '--locked', '--release'], { cwd: crate, stdio: 'inherit' });
if (built.error || built.status !== 0) {
  console.error(`[build-test-native] The native module could not be built: ${built.error?.message ?? `cargo exited ${built.status}`}.`);
  process.exit(1);
}
