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

await withTempWorkspace('mixdog-browser-host-integration-', async (staging) => {
  const output = join(staging, 'browser-host-integration.mjs');
  const progressPath = join(staging, 'progress.log');
  let progressPrinted = false;
  try {
    await bundleElectronEntry({
      entry: new URL(
        process.argv.includes('--cdp-lifecycle')
          ? '../src/main/browser/cdp-lifecycle.integration.ts'
          : '../src/main/browser/host.integration.ts',
        import.meta.url
      ),
      outfile: output,
      plugins: [computerSourceEsbuildPlugin()],
      external: ['electron', 'ws'],
      sourcemap: 'inline',
    });

    const env = electronProcessEnv({
      MIXDOG_BROWSER_INTEGRATION_LOG: progressPath,
      MIXDOG_BROWSER_CONTINUATION_ONLY: process.argv.includes('--action-continuation') ? '1' : '0',
    });
    const child = spawnElectron(output, { env });
    const exitCode = await waitForChildExit(child, {
      timeoutMs: 90_000,
      timeoutMessage: 'browser host integration exceeded 90 seconds',
      signalMessage: (signal) => `browser host integration was terminated by ${signal}`,
    });
    const progress = await readFile(progressPath, 'utf8').catch(() => '');
    if (progress) {
      process.stdout.write(progress);
      progressPrinted = true;
    }
    const successMarker =
      env.MIXDOG_BROWSER_MOUSE_PROBE_ONLY === '1' ? 'mouse dispatch probe passed' : 'integration passed';
    if (exitCode !== 0 || !progress.includes(successMarker)) {
      throw new Error(`browser host integration failed before its success marker (exit ${exitCode})`);
    }
  } finally {
    const progress = await readFile(progressPath, 'utf8').catch(() => '');
    if (progress && !progressPrinted) {
      process.stderr.write(progress);
    }
  }
});
