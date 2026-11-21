// Run from apps/desktop: node scripts/notification-probe.mjs
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { bundleElectronEntry, spawnElectron, waitForChildExit, withTempWorkspace } from './electron-harness.mjs';

// No identity override: Electron can persist its shortcut under a supplied
// AUMID. A temp profile alone does not protect the installed sender identity.
parseArgs({ options: {}, allowPositionals: false });

await withTempWorkspace('mixdog-notification-probe-', async (directory) => {
  const entry = join(directory, 'probe.mjs');
  await bundleElectronEntry({
    entry: new URL('./probes/native-notification.ts', import.meta.url),
    outfile: entry,
  });
  const child = spawnElectron(entry, {
    args: [
      `--user-data-dir=${join(directory, 'profile')}`,
      `--probe-preload=${fileURLToPath(new URL('./probes/notification-preload.cjs', import.meta.url))}`,
      `--probe-icon=${fileURLToPath(new URL('../build/mixdog.ico', import.meta.url))}`,
    ],
  });
  process.exitCode = await waitForChildExit(child, { timeoutMs: 120_000 });
});
