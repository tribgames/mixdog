import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { computerSourceEsbuildPlugin } from './computer-source-assets.mjs';
import {
  bundleElectronEntry,
  electronProcessEnv,
  spawnElectron,
  waitForChildExit,
  withTempWorkspace,
} from './electron-harness.mjs';

await withTempWorkspace('mixdog-computer-host-integration-', async (staging) => {
  const output = join(staging, 'computer-host-integration.mjs');
  const progressPath = join(staging, 'progress.log');
  await bundleElectronEntry({
    entry: new URL('../src/main/computer/harness/integration.ts', import.meta.url),
    outfile: output,
    plugins: [computerSourceEsbuildPlugin()],
    sourcemap: 'inline',
  });

  const env = electronProcessEnv({ MIXDOG_COMPUTER_INTEGRATION_LOG: progressPath });
  const child = spawnElectron(output, { env });
  const exitCode = await waitForChildExit(child, {
    timeoutMs: 120_000,
    timeoutMessage: 'computer host integration exceeded 120 seconds',
    signalMessage: (signal) => `computer host integration was terminated by ${signal}`,
  });
  const progress = await readFile(progressPath, 'utf8').catch(() => '');
  if (progress) process.stdout.write(progress);
  if (exitCode !== 0 || !progress.includes('integration passed')) {
    throw new Error(`computer host integration failed before its success marker (exit ${exitCode})`);
  }
});
