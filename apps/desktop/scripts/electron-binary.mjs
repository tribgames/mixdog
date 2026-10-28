// Electron 42+ has no install script: on first use the electron package
// downloads its binary and prints progress to stdout, which would corrupt a
// caller's captured path or JSON output. The download runs here as its own
// step with stdout discarded, so the path is all a caller ever sees.
//
//   node scripts/electron-binary.mjs   → prints only the binary's path
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

/** The Electron binary of the package in `packageDir`, downloaded if missing. */
export function electronBinary(packageDir = dirname(require.resolve('electron/package.json'))) {
  // An override dist is never downloaded into; the package only joins its path.
  if (!process.env.ELECTRON_OVERRIDE_DIST_PATH) {
    const install = spawnSync(process.execPath, [join(packageDir, 'install.js')], {
      stdio: ['ignore', 'ignore', 'inherit'],
      windowsHide: true,
    });
    if (install.error) throw install.error;
    if (install.status !== 0) throw new Error(`Electron binary download failed (exit ${install.status}).`);
  }
  return require(packageDir);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(electronBinary());
}
